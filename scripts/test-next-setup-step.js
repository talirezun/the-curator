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
 *   v3.79.0 (the setup-understandable contract):
 *   §14 a to-fix note is TWO lines (text, then detail), never one glued run.
 *   §15 every fix button labelled with what it does, `fixes[]` in order; a
 *       wrong-scope that clears on its own has no button; only this app's own
 *       skill .zip is ever linked.
 *   §16 how each part travels: a greyscale pill per fold, one line per fold.
 *   §17 a Repository file in the reader: before · FRAMED block · after, the
 *       "‹tool› reads up to here" rule, a missing file, an old server, and
 *       the untrusted text never written raw.
 *   §18 a computer in the reader: installs, each tool's newest save and the
 *       name it saved under, sync — and the v3.78.0 fallback.
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
// v3.79.0: a fold's meta is its words, then the travels pill — the words alone.
const metaOf = (html, key) => {
  const m = new RegExp('id="mem-fold-' + key + '">[\\s\\S]*?<span class="mem-fold-meta">([^<]*)').exec(html);
  return m ? m[1] : null;
};

section('§1  to-fix lines are loud notes, never folded — and nothing shows when nothing is wrong');
{
  const html = S.renderSetupBody({ data: old() }, { openFolds: {} });
  const fixNotes = [...html.matchAll(/class="tx-note mem-ss-note mem-setup-note mem-setup-fix-note" data-setup-fix="(\d+)"/g)];
  ok(fixNotes.length === 3, 'one note per to-fix item', fixNotes.length);
  const n0 = notes(html)[0] || '';
  ok(textOf(n0).includes('AGENTS.md has no Curator block.') && textOf(n0).includes('not CLAUDE.md'), '…the sentence and its reason in one note (two lines since v3.79.0, §14)', textOf(n0));
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
  const rn = notes(html).find((n) => /mem-setup-repo-note/.test(html) && /code on this Mac/.test(n)) || '';
  // v3.79.0 (contract §A): a question, on two lines — where the code is, and
  // what setting it checks; then what was found here.
  ok(/<span class="mem-setup-note-l1">Where is curator’s code on this Mac\? Set its folder so Setup can check CLAUDE\.md, AGENTS\.md and \.curator-project\.<\/span>/.test(rn),
    'the note asks where the code is and names what setting it checks', textOf(rn));
  ok(/<span class="mem-setup-note-l2">Found on this Mac: <span class="mem-setup-inline-path">~\/second-brain<\/span><\/span>/.test(rn), '…line 2: what was found here', rn);
  ok(/data-setup-act="use-repo" data-path="\/Users\/t\/second-brain">Use ~\/second-brain</.test(rn), 'exactly one folder found → "Use ~/second-brain", one click', rn);
  ok(!/mem-setup-fix-note/.test(rn) && !/cur-setup-st-fix/.test(html), 'it is not a to-fix, and nothing on the page is inked to fix');
  const two = { ...maint(), repoCandidates: [...maint().repoCandidates, { path: '/Users/t/code/curator', display: '~/code/curator', why: 'foundations' }] };
  const rn2 = notes(S.renderSetupBody({ data: two }, {})).find((n) => /code on this Mac/.test(n)) || '';
  ok(/data-setup-act="choose-repo">Choose a folder</.test(rn2) && !/use-repo/.test(rn2) && /2 folders on this Mac look like it — choose one\./.test(textOf(rn2)),
    'several found → "Choose a folder", pointing at the Repository fold', textOf(rn2));
  const none = { ...maint(), repoCandidates: [] };
  ok(/data-setup-act="choose-repo">Set the folder</.test(S.renderSetupBody({ data: none }, {})), 'none found → "Set the folder"');
  ok(/<span class="mem-setup-note-l2">Not on this Mac yet\? Clone it first\.<\/span>/.test(S.renderSetupBody({ data: none }, {})), '…with "Not on this Mac yet? Clone it first."');
  const fold = foldNamed(html, 'setup-repo');
  ok(!!fold && metaOf(html, 'setup-repo') === 'not set · 1 folder found', 'fold meta: "not set · 1 folder found"', metaOf(html, 'setup-repo'));
  ok(/Found on this computer<\/th><th scope="col">Why<\/th>/.test(fold.body) && /Claude Code has opened it/.test(fold.body)
    && /data-setup-act="use-repo" data-path="\/Users\/t\/second-brain">Use this folder</.test(fold.body),
  'the fold: FOUND ON THIS COMPUTER · WHY · [Use this folder]');
  ok(/id="mem-setup-repo-input"/.test(fold.body) && /data-setup-act="save-repo">Use</.test(fold.body) && /data-setup-act="pick-repo">Choose…</.test(fold.body),
    '…then the typed field, Use and Choose…');
  ok(/The folder you set is kept on this computer only, never synced\./.test(fold.body), '…and "The folder you set is kept on this computer only, never synced."');
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
  ok(metaOf(html, 'setup-repo') === '~/code/ott · 3 files current', 'fold meta: "~/code/ott · 3 files current"', metaOf(html, 'setup-repo'));
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
  ok(/data-setup-act="copy-block"[^>]*>Copy instructions</.test(html), 'block missing (v3.78.0 `fix`) → "Copy instructions"');
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
  ok(metaOf(html, 'setup-tools') === '2 tools', 'fold meta with nothing to fix: "2 tools"', metaOf(html, 'setup-tools'));
  // Derived from a v3.77.0 row.
  const o = S.renderSetupBody({ data: old() }, { openFolds: ALL_OPEN });
  const ob = foldNamed(o, 'setup-tools').body;
  ok(/cur-setup-st-fix">1 to fix</.test(ob) && /cur-setup-st-q">partly checked</.test(ob), 'v3.77.0 shape: "1 to fix" for Antigravity, "partly checked" for Claude Code (skills can\'t check here)');
  ok(/cur-setup-st-fix">skills: my-curator outdated</.test(ob) && /cur-setup-st-fix">block: missing</.test(ob), 'a failing part shows its word');
  ok(metaOf(o, 'setup-tools') === '2 tools · 1 to fix', 'fold meta: "2 tools · 1 to fix"');
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
  ok(metaOf(html, 'setup-computers') === '1 computer · 2 installs', 'fold meta: "1 computer · 2 installs"', metaOf(html, 'setup-computers'));
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
  ok(/<pre class="mem-setup-snippet"><code>\{&quot;mcpServers&quot;/.test(c) && /data-setup-act="copy-snippet" data-tool="my-harness">Copy MCP entry</.test(c), 'a custom tool: its MCP entry, "Copy MCP entry"');
  ok(/reads AGENTS\.md/.test(c) && /data-setup-act="copy-block">Copy instructions</.test(c), '…the AGENTS.md hint with "Copy instructions"');
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
  // v3.79.0 (contract §B): the marks table became HOW EACH PART TRAVELS; what
  // each mark means moved to the user guide.
  ok(JSON.stringify(e.visual.rows.map((r) => r[0])) === JSON.stringify(['Computers', 'Repository on this computer', 'Tools']),
    'the table: Computers · Repository on this computer · Tools — the three folds', JSON.stringify(e.visual.rows));
  ok(e.visual.rows[0][2] === 'Sync now' && /handoffs, the brief/.test(e.visual.rows[0][1])
    && e.visual.rows[1][2] === 'your project’s own git' && /instruction files, the marker/.test(e.visual.rows[1][1])
    && e.visual.rows[2][2] === 'set up per computer' && /MCP, skills, hooks/.test(e.visual.rows[2][1]),
  '…handoffs and the brief by Sync now; instruction files and the marker by the project’s git; MCP, skills and hooks set up per computer');
  ok(!/ready|can’t check here/.test(JSON.stringify(e.visual)), '…and the marks table is gone from the ⓘ');
  const ov = EXPLAINERS['context.overview'];
  ok(/^Six readings/.test(ov.lead) && ov.visual.rows.some((r) => r[0] === 'SETUP'), 'the overview explainer counts SIX readings and names SETUP');
}


// ═══════════════════════════════════════════════════════════════════════════
// v3.79.0 — SETUP MADE UNDERSTANDABLE (contract §A–§D)
// ═══════════════════════════════════════════════════════════════════════════

// The v3.79.0 shape: the backend's `fixes[]` (amendment 1), `travels`, the
// computers' `saves[]`, written as the contract's own texts.
const v379 = () => {
  const d = old();
  d.checkedAt = iso(3000);
  d.toFix = [
    { tool: 'antigravity', kind: 'block-missing', file: 'AGENTS.md', machine: 'mac-a', thisMachine: true, repoDisplay: '~/code/ott',
      text: 'AGENTS.md in ~/code/ott has no Curator instructions, so Antigravity doesn’t know this project and may overwrite another tool’s handoff.',
      detail: 'Paste them at the very top (create the file if it isn’t there), then commit and push. That is why its 25 Sep save went under “main”.',
      fix: { kind: 'copy-block', label: 'Copy instructions', file: 'AGENTS.md' },
      fixes: [
        { kind: 'copy-block', label: 'Copy instructions', file: 'AGENTS.md' },
        { kind: 'reveal', path: '/Users/t/code/ott/AGENTS.md', label: 'Reveal AGENTS.md' },
        { kind: 'copy-command', label: 'Copy the git command that commits and pushes it', cwd: '/Users/t/code/ott', cwdDisplay: '~/code/ott',
          command: 'git add AGENTS.md && git commit -m "Add The Curator instructions" && git push' },
      ] },
    { tool: 'antigravity', kind: 'wrong-scope', at: iso(3 * 864e5), machine: 'mac-b', thisMachine: false,
      text: 'Antigravity’s last save (25 Sep, on mac-b) went under “main”, not its own name “antigravity”.',
      detail: 'Your instructions here are already current, so this clears the next time Antigravity saves after that computer runs git pull.',
      fix: null, fixes: [] },
    { tool: 'antigravity', kind: 'bridge-file',
      text: 'Antigravity’s MCP settings file (~/.gemini/antigravity/mcp_config.json) is empty, so Antigravity can’t reach The Curator on this Mac.',
      detail: 'Open Antigravity once (it fills the file), then Re-check.',
      fix: { kind: 'reveal', path: '/Users/t/.gemini/antigravity/mcp_config.json', label: 'Reveal file' },
      fixes: [{ kind: 'reveal', path: '/Users/t/.gemini/antigravity/mcp_config.json', label: 'Reveal file' },
        { kind: 'recheck', label: 'Re-check' }, { kind: 'settings', label: 'Open Tools on this Mac' }] },
    { tool: 'antigravity', kind: 'bridge', text: 'x', detail: 'y',
      fixes: [{ kind: 'copy-snippet', tool: 'antigravity', label: 'Copy MCP entry' }, { kind: 'reveal', path: '/Users/t/.gemini/config/mcp_config.json', label: 'Reveal file' }] },
    { tool: 'antigravity', kind: 'skills', text: 'The my-curator skill in ~/.gemini/config/plugins is older than this app’s.', detail: 'Download it and replace that folder.',
      fixes: [{ kind: 'download-skill', skill: 'my-curator', href: '/api/setup/skills/my-curator.zip', label: 'Download my-curator.zip' },
        { kind: 'reveal', path: '/Users/t/.gemini/config/plugins', label: 'Reveal folder' }] },
  ];
  d.physical = [
    { thisComputer: true, installs: [{ key: 'a', primary: 'mac-a', names: ['mac-a'], aliases: [], thisComputer: true, installKind: 'app',
      tools: ['Claude Code'], newestSaveAt: iso(40 * 60e3), curatorVersion: '3.79.0',
      saves: [{ tool: 'claude-code', label: 'Claude Code', scope: 'claude-code', at: iso(40 * 60e3), curator: '3.79.0', ownScope: true },
        { tool: 'claude-code', label: 'Claude Code', scope: 'claude-code', at: iso(9 * 864e5), curator: '3.78.0', ownScope: true }] }] },
    { thisComputer: false, installs: [{ key: 'b', primary: 'mac-b', names: ['mac-b'], aliases: [], thisComputer: false, installKind: 'app',
      tools: ['Antigravity'], newestSaveAt: iso(3 * 864e5), curatorVersion: '3.78.0', waiting: 1,
      saves: [{ tool: 'antigravity', label: 'Antigravity', scope: 'main', at: iso(3 * 864e5), curator: '3.78.0', ownScope: false }] }] },
  ];
  return d;
};

section('§14 a to-fix note is TWO lines — what is wrong, then why and what to do (contract §A)');
{
  const html = S.renderSetupBody({ data: v379() }, {});
  const n = notes(html);
  const lines = (x) => [/<span class="mem-setup-note-l1">([\s\S]*?)<\/span>(?=<span class="mem-setup-note-l2">|<\/span>)/.exec(x), /<span class="mem-setup-note-l2">([\s\S]*?)<\/span><\/span>/.exec(x)];
  const [l1, l2] = lines(n[0]);
  ok(!!l1 && /^AGENTS\.md in <span class="mem-setup-inline-path">~\/code\/ott<\/span> has no Curator instructions/.test(l1[1]),
    'line 1 is the text: what is wrong, naming the file and the folder', n[0]);
  ok(!!l2 && /^Paste them at the very top/.test(l2[1]) && !/has no Curator/.test(l2[1]), 'line 2 is the detail, never glued onto line 1', l2 && l2[1]);
  ok(n.every((x) => (x.match(/mem-setup-note-l1/g) || []).length === 1), 'every note has exactly one first line');
  const noDetail = S.toFixNotes({ toFix: [{ text: 'Only a text.' }] });
  ok(/mem-setup-note-l1">Only a text\.<\/span><\/span>/.test(noDetail) && !/mem-setup-note-l2/.test(noDetail), 'no detail: one line, no empty second line', noDetail);
  // The legacy glue, planted: the old one-span form would fail the shape above.
  ok(!/Curator instructions, so Antigravity[^<]*Paste them/.test(n[0]), 'CONTROL: the two sentences are not one run');
}

section('§15 every button is labelled with what it does — fixes[] in order (amendment 1)');
{
  const d = v379();
  const b0 = S.fixButtons(d.toFix[0], d.repo);
  const order = [...b0.matchAll(/data-setup-act="([a-z-]+)"/g)].map((m) => m[1]);
  ok(JSON.stringify(order) === '["copy-block","reveal","copy-command"]', 'block missing: Copy instructions · Reveal AGENTS.md · Copy the git command — in the payload\'s order', JSON.stringify(order));
  ok(/>Copy instructions</.test(b0) && />Reveal AGENTS\.md</.test(b0) && />Copy the git command that commits and pushes it</.test(b0), '…each with the payload\'s own label', b0);
  ok(/data-cmd="git add AGENTS\.md &amp;&amp; git commit -m &quot;Add The Curator instructions&quot; &amp;&amp; git push" data-cwd="~\/code\/ott"/.test(b0),
    'the git command rides escaped, with the folder to run it in (the toast names it)', b0);
  ok(/^<button type="button" class="btn btn-secondary btn-xs"/.test(b0) && (b0.match(/btn-ghost/g) || []).length === 2, 'the first button is the primary action; the rest are ghost');
  ok(S.fixButtons(d.toFix[1], d.repo) === '', 'wrong-scope with a current block: NO button at all (it clears on its own)');
  const n1 = notes(S.renderSetupBody({ data: d }, {}))[1];
  ok(!/mem-setup-note-acts/.test(n1) && /not its own name “antigravity”/.test(n1), '…its note is words only, and says “its own name”, never “scope”', n1);
  ok(!/\bscope\b/i.test(textOf(S.renderSetupBody({ data: d }, {})).replace(/data-[a-z-]+="[^"]*"/g, '')), 'no "scope" anywhere in the step\'s to-fix copy');
  const b2 = S.fixButtons(d.toFix[2], d.repo);
  ok(/data-setup-act="reveal" data-path="\/Users\/t\/\.gemini\/antigravity\/mcp_config\.json">Reveal file</.test(b2)
    && /data-setup-act="check">Re-check</.test(b2) && /data-setup-act="settings">Open Tools on this Mac</.test(b2),
  'bridge-file: Reveal file · Re-check · Open Tools on this Mac', b2);
  ok(/data-setup-act="copy-snippet" data-tool="antigravity">Copy MCP entry</.test(S.fixButtons(d.toFix[3], d.repo)), 'copy-snippet: "Copy MCP entry", naming its tool');
  const b4 = S.fixButtons(d.toFix[4], d.repo);
  ok(/<a class="btn btn-secondary btn-xs" href="\/api\/setup\/skills\/my-curator\.zip" download>Download my-curator\.zip<\/a>/.test(b4)
    && !/curator-continuity/.test(b4) && />Reveal folder</.test(b4), 'a stale skill: ONLY its own .zip, and Reveal folder', b4);
  const evilDl = S.fixButtons({ fixes: [{ kind: 'download-skill', skill: 'x', href: 'https://evil.test/x.zip' }] }, null);
  ok(!/evil/.test(evilDl) && /href="\/api\/setup\/skills\/x\.zip"/.test(evilDl),
    'a download href that is not this app\'s own is never linked (the skill name builds the app\'s own)', evilDl);
  ok(S.fixButtons({ fixes: [{ kind: 'download-skill', skill: '../x' }] }, null) === '', '…and a bad skill name gives no link at all');
  ok(/data-setup-act="choose-repo">Choose the folder</.test(S.fixButtons({ fixes: [{ kind: 'choose-folder' }] }, null)), 'choose-folder → Choose the folder');
  ok(S.fixButtons({ fixes: [{ kind: 'mystery', label: 'Do it' }] }, null) === '', 'an unknown kind draws nothing rather than a dead button');
  // A v3.78.0 item: `fix` only, no labels — still every action it carried.
  const legacy = S.fixButtons({ tool: 'antigravity', file: 'AGENTS.md', fix: { kind: 'copy-block', reveal: 'AGENTS.md' } }, { path: '/Users/t/code/ott' });
  ok(/>Copy instructions</.test(legacy) && /data-path="\/Users\/t\/code\/ott\/AGENTS\.md">Reveal AGENTS\.md</.test(legacy), 'v3.78.0 `fix`: Copy instructions and its Reveal', legacy);
  ok(S.fixListOf({ fix: { kind: 'sync' } }).length === 1 && S.fixListOf({ fixes: [] }).length === 0 && S.fixListOf(null).length === 0, 'fixListOf: fixes[] wins, even empty; `fix` is the fallback');
}

section('§16 how each part travels — a greyscale pill per fold, one line per fold (contract §B)');
{
  const html = S.renderSetupBody({ data: maint() }, { openFolds: ALL_OPEN });
  const pill = (key) => (new RegExp('id="mem-fold-' + key + '">[\\s\\S]*?<span class="mem-fold-meta">[^<]*(<span class="mem-ws-mine mem-setup-travels"[\\s\\S]*?</span></span>)').exec(html) || [])[1] || '';
  ok(/data-travels="this-computer"/.test(pill('setup-tools')) && /<span>set up on each computer<\/span>/.test(pill('setup-tools')), 'Tools: "set up on each computer"', pill('setup-tools'));
  ok(/data-travels="project-git"/.test(pill('setup-repo')) && /<span>project’s git<\/span>/.test(pill('setup-repo')), 'Repository: "project’s git"');
  ok(/data-travels="personal-sync"/.test(pill('setup-computers')) && /<span>Personal Sync<\/span>/.test(pill('setup-computers')), 'Computers: "Personal Sync"');
  ok([pill('setup-tools'), pill('setup-repo'), pill('setup-computers')].every((p) => /mem-ws-mine/.test(p) && /<svg /.test(p) && !/style=|cur-sb-dot|identity/.test(p)),
    'each is the .mem-ws-mine pill with a glyph — no colour, no identity dot');
  const count = (key) => textOf(foldNamed(html, key).body);
  ok(count('setup-tools').includes('MCP settings, skills and hooks are set up on each computer; nothing syncs them.'), 'Tools: nothing syncs them');
  ok(count('setup-computers').includes('Handoffs, the brief and Documents travel by Sync now — not by the project’s git.'), 'Computers: they travel by Sync now');
  const set = S.renderSetupBody({ data: { ...old(), toFix: [] } }, { openFolds: ALL_OPEN });
  ok(textOf(foldNamed(set, 'setup-repo').body).includes('These files reach your other computers only through this project’s git: commit and push here, pull there. Sync now does not carry them.'),
    'Repository (set): only through the project’s git; Sync now does not carry them');
  ok(count('setup-repo').includes('Sync now does not carry them.'), '…and said with the folder not set too');
  ok(S.travelsPill('bogus') === '' && S.TRAVELS_WORDS['this-computer'] === 'this computer only', 'an unknown channel draws nothing; the three words are the contract\'s');
}

// The file route's answers (contract §C, amendment 3).
const agentsText = '# Notes\n\nIntro.\n\n## Working state\n\nCall get_project_context.\n\n## Build\n\nnpm test\n';
const bStart = agentsText.indexOf('## Working state');
const bEnd = agentsText.indexOf('## Build');
const fileResp = (over = {}) => ({ ok: true, name: 'AGENTS.md', exists: true, text: agentsText, bytes: agentsText.length, mtime: iso(1000), truncated: false,
  block: { start: bStart, end: bEnd, state: 'current' }, cap: null, travels: 'project-git', ...over });
const setRepo = () => { const d = { ...old(), toFix: [] }; d.tools[1].block = { state: 'ok', word: 'current', files: [{ name: 'AGENTS.md', present: true, hasBlock: true, current: true }] }; return d; };
const md = (t) => '<div class="MD">' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';

section('§17 a Repository file, in the reader (contract §C)');
{
  const d = setRepo();
  const tbl = foldNamed(S.renderSetupBody({ data: d }, { openFolds: ALL_OPEN }), 'setup-repo').body;
  ok(/<button type="button" class="mem-ws-open" id="mem-setup-file-AGENTS_md" data-setup-act="file-open" data-name="AGENTS\.md"/.test(tbl)
    && /data-setup-act="file-open" data-name="\.curator-project"/.test(tbl), 'each file row is a button that opens the reader, with a stable id', tbl.slice(0, 600));
  const r = S.fileReaderContent(d, 'AGENTS.md', fileResp(), { md });
  ok(r && r.hideBacklinks === true && r.title === 'AGENTS.md' && r.returnFocusTo === 'mem-setup-file-AGENTS_md', 'the reader: titled by the file, no backlinks, focus returns to its row');
  ok(/cur-setup-st-ok">block current/.test(r.bodyHtml) && /data-travels="project-git"[\s\S]*?travels by project’s git/.test(r.bodyHtml), 'the head: the row\'s state and "travels by project’s git"');
  const frame = /<section class="mem-setup-frame"[\s\S]*?<\/section>/.exec(r.bodyHtml);
  ok(!!frame && /The Curator instructions<\/span><span class="cur-setup-st cur-setup-st-ok">current/.test(frame[0])
    && /data-setup-act="copy-block">Copy current instructions</.test(frame[0]), 'the block is FRAMED, with its state and "Copy current instructions"', frame && frame[0]);
  ok(!!frame && /## Working state/.test(frame[0]) && !/Intro\./.test(frame[0]) && !/npm test/.test(frame[0]), '…and the frame holds the block and nothing else');
  ok(r.bodyHtml.indexOf('Intro.') < r.bodyHtml.indexOf('mem-setup-frame') && r.bodyHtml.indexOf('npm test') > r.bodyHtml.lastIndexOf('</section>'), 'before · block · after, in order');
  ok((r.bodyHtml.match(/class="MD"/g) || []).length === 3, 'every piece goes through the renderer handed in (renderMarkdown in the app)');
  ok(/data-setup-act="reveal" data-path="\/Users\/t\/code\/ott\/AGENTS\.md">Reveal AGENTS\.md</.test(r.bodyHtml) && /data-setup-act="copy-block">Copy instructions</.test(r.bodyHtml), 'Reveal and Copy instructions at the top');
  // The cap rule.
  const capAt = agentsText.indexOf('Call get_project_context');
  const rc = S.fileReaderContent(d, 'AGENTS.md', fileResp({ cap: { bytes: 60, tool: 'antigravity', at: capAt } }), { md });
  const ruleAt = rc.bodyHtml.indexOf('mem-setup-cap-rule');
  ok(/<div class="mem-setup-cap-rule" role="separator"><span>Antigravity reads up to here<\/span><\/div>/.test(rc.bodyHtml), 'a cap: "Antigravity reads up to here", the tool named by its label', rc.bodyHtml);
  ok(ruleAt > rc.bodyHtml.indexOf('## Working state') && ruleAt < rc.bodyHtml.indexOf('Call get_project_context') && ruleAt < rc.bodyHtml.lastIndexOf('</section>'),
    '…drawn exactly where the byte count ends — here inside the frame, before the text it cannot reach');
  const short = S.fileReaderContent(d, 'AGENTS.md', fileResp({ cap: { bytes: 32768, tool: 'antigravity', at: null } }), { md });
  ok(!/mem-setup-cap-rule/.test(short.bodyHtml) && /Antigravity reads the first 32,768 bytes; this file is shorter\./.test(short.bodyHtml), 'a file shorter than the cap: no rule, said in words');
  // Offsets past a truncated text are clamped.
  const tr = S.fileReaderContent(d, 'AGENTS.md', fileResp({ truncated: true, text: 'abc', block: { start: 900000, end: 900500, state: 'current' } }), { md });
  ok(/Showing the first 256 KB of this file\./.test(tr.bodyHtml) && /The Curator instructions start past the part shown here\./.test(tr.bodyHtml) && !/mem-setup-frame"/.test(tr.bodyHtml),
    'truncated with the block past the cut: said, no empty frame', tr.bodyHtml);
  // No block.
  const nb = S.fileReaderContent(d, 'AGENTS.md', fileResp({ block: null }), { md });
  ok(/No Curator instructions in this file\./.test(nb.bodyHtml) && !/mem-setup-frame"/.test(nb.bodyHtml), 'no block: said, nothing framed');
  ok(/cur-setup-st-fix">outdated/.test(S.fileReaderContent(d, 'AGENTS.md', fileResp({ block: { start: bStart, end: bEnd, state: 'outdated' } }), { md }).bodyHtml), 'an outdated block: its frame says "outdated", inked to fix');
  // Missing file.
  const miss = S.fileReaderContent(d, 'AGENTS.md', { ok: true, name: 'AGENTS.md', exists: false, text: '', block: null }, { md });
  ok(/Not in this folder/.test(miss.bodyHtml) && /Antigravity reads AGENTS\.md at the start of every session\. Create it at the top of ~\/code\/ott, paste the Curator instructions at its very top, then commit and push\./.test(miss.bodyHtml)
    && /data-setup-act="copy-block">Copy instructions</.test(miss.bodyHtml), 'a missing file: what goes there, and Copy instructions', miss.bodyHtml);
  const mk = S.fileReaderContent(d, '.curator-project', { ok: true, name: '.curator-project', exists: false, text: '' }, { md });
  ok(/holds one line — projects\/ott — so agents and hooks/.test(mk.bodyHtml) && /data-setup-act="copy-marker">Copy marker line</.test(mk.bodyHtml)
    && /data-path="\/Users\/t\/code\/ott">Reveal the folder</.test(mk.bodyHtml), 'a missing marker: its one line, Copy marker line, Reveal the folder');
  const mkp = S.fileReaderContent(d, '.curator-project', { ok: true, name: '.curator-project', exists: true, text: 'projects/ott\n', marker: { committed: true, pushed: false } }, { md });
  ok(/<pre class="mem-setup-file-pre">projects\/ott\n<\/pre>/.test(mkp.bodyHtml) && /Committed, not pushed yet\./.test(mkp.bodyHtml) && !/class="MD"/.test(mkp.bodyHtml),
    'the marker: its line verbatim in a pre, and whether it is pushed');
  // Loading and an old server.
  ok(/aria-busy="true">Reading AGENTS\.md…/.test(S.fileReaderContent(d, 'AGENTS.md', undefined, { md }).bodyHtml), 'while the file is read: "Reading AGENTS.md…"');
  const oldSrv = S.fileReaderContent(d, 'AGENTS.md', { error: 'HTTP 404' }, { md });
  ok(/The file could not be shown here: HTTP 404\./.test(oldSrv.bodyHtml) && /cur-setup-st-ok">block current/.test(oldSrv.bodyHtml) && /Reveal AGENTS\.md</.test(oldSrv.bodyHtml),
    'an older server (no file route): the row\'s state, Reveal and Copy still there, and the reason said');
  ok(S.fileReaderContent(d, 'secrets.txt', fileResp(), { md }) === null, 'a name that is not a row of this folder: nothing opens');
  ok(S.fileReaderContent({ ...d, repo: null }, 'AGENTS.md', fileResp(), { md }) === null, 'no repository set: no file reader');
  // Escaping: the text is untrusted; with no renderer it is escaped into a <pre>.
  const evil = '<img src=x onerror=alert(1)>';
  const e1 = S.fileReaderContent(d, 'AGENTS.md', fileResp({ text: evil + '\n' + agentsText, block: null }));
  ok(!e1.bodyHtml.includes('<img') && e1.bodyHtml.includes('&lt;img src=x onerror=alert(1)&gt;') && /mem-setup-file-pre/.test(e1.bodyHtml), 'no renderer handed in: escaped into a <pre>, never raw');
  const e2 = S.fileReaderContent(d, 'AGENTS.md', fileResp({ block: { start: bStart, end: bEnd, state: evil }, cap: { bytes: 5, tool: evil, at: 3 } }), { md });
  ok(!e2.bodyHtml.includes('<img'), 'a hostile block state or cap tool is escaped too');
  // Amendment 4's exact shapes: the block's `pill` decides the ink; past-cap; `git` on the file.
  const pc = S.fileReaderContent(d, 'AGENTS.md', fileResp({ block: { start: bStart, end: bEnd, state: 'past-cap', pill: 'fix' },
    git: { committed: true, pushed: false, gitRepo: true } }), { md }).bodyHtml;
  ok(/cur-setup-st-fix">past what the tool reads/.test(pc) && /Committed, not pushed yet\./.test(pc), 'past-cap: inked to fix and said; the file\'s git state is said', pc.slice(0, 900));
  ok(/cur-setup-st-ok">current/.test(S.fileReaderContent(d, 'AGENTS.md', fileResp({ block: { start: bStart, end: bEnd, state: 'current', pill: 'ok' } }), { md }).bodyHtml),
    'the pill wins for the ink');
  ok(/Not committed to the project’s git yet\./.test(S.fileReaderContent(d, 'AGENTS.md', fileResp({ git: { committed: false } }), { md }).bodyHtml), 'an uncommitted file: said');
  const dp = setRepo();
  dp.tools[1].block.files[0].blockPastCap = true;
  ok(/cur-setup-st-fix">block past what it reads/.test(foldNamed(S.renderSetupBody({ data: dp }, { openFolds: ALL_OPEN }), 'setup-repo').body), 'a row whose block runs past the tool\'s cap: "block past what it reads"');
  ok(/The file could not be shown here: repo_not_set\./.test(S.fileReaderContent(d, 'AGENTS.md', { error: 'repo_not_set' }, { md }).bodyHtml), 'a refusal from the route is said, not swallowed');
  // One button per action: the file's own doors step aside for a to-fix line that carries them.
  const dup = v379();
  dup.tools[1].block = { state: 'fix', word: 'missing', files: [{ name: 'AGENTS.md', present: true, hasBlock: false }] };
  const dr = S.fileReaderContent(dup, 'AGENTS.md', fileResp({ block: null }), { md }).bodyHtml;
  ok((dr.match(/data-setup-act="copy-block"/g) || []).length === 1 && (dr.match(/data-path="\/Users\/t\/code\/ott\/AGENTS\.md"/g) || []).length === 1,
    'a to-fix line above carries Copy instructions and Reveal: they are not drawn twice', dr.slice(0, 1200));
  ok(S.fileBodyHtml('abc', null, { at: 3 }, 'X', md).endsWith('<div class="mem-setup-cap-rule" role="separator"><span>X reads up to here</span></div>'), 'a cap at the very end draws its rule last');
}

section('§18 a computer, in the reader (contract §C)');
{
  const d = v379();
  const body = foldNamed(S.renderSetupBody({ data: d }, { openFolds: ALL_OPEN }), 'setup-computers').body;
  ok(/<button type="button" class="mem-ws-open" id="mem-setup-comp-0" data-setup-act="computer-open" data-computer="0"/.test(body)
    && /id="mem-setup-comp-1" data-setup-act="computer-open" data-computer="1"/.test(body), 'each computer row is a button that opens the reader');
  const here = S.computerReaderContent(d, 0);
  ok(here.title === 'mac-a' && here.hideBacklinks === true && here.returnFocusTo === 'mem-setup-comp-0', 'titled by the computer, no backlinks, focus returns to its row');
  ok(/mem-setup-here">this computer/.test(here.bodyHtml) && /data-travels="personal-sync"[\s\S]*?travels by Personal Sync/.test(here.bodyHtml), 'the head: this computer, travels by Personal Sync');
  ok(/Mac app mac-a · <span class="cur-setup-mono">Curator 3\.79\.0<\/span>/.test(here.bodyHtml), 'installs, each with its Curator version', here.bodyHtml);
  const saves = /Each tool’s newest save<\/h3><ul class="mem-setup-ev-lines">([\s\S]*?)<\/ul>/.exec(here.bodyHtml);
  ok(!!saves && (saves[1].match(/<li>/g) || []).length === 1 && /Claude Code<\/span> · /.test(saves[1]) && /saved under “claude-code”/.test(saves[1]) && /Curator 3\.79\.0/.test(saves[1]) && !/3\.78\.0/.test(saves[1]),
    'each tool\'s NEWEST save only — with its date, the name it saved under and its Curator version', saves && saves[1]);
  ok(/Last synced/.test(here.bodyHtml) && /1 file here not on GitHub yet, across all domains\./.test(here.bodyHtml) && /1 file waiting on GitHub for this Mac\./.test(here.bodyHtml)
    && /Sync now pulls and pushes your whole knowledge folder — every domain\./.test(here.bodyHtml), 'this computer: last sync, what it has to send, what waits, and how far Sync now reaches');
  const there = S.computerReaderContent(d, 1);
  ok(/saved under “main”/.test(there.bodyHtml) && /cur-setup-st-fix">not its own name “antigravity”/.test(there.bodyHtml), 'another computer\'s tool that saved under another name: flagged, "not its own name"', there.bodyHtml);
  ok(/A newer handoff from it is waiting in your Personal Sync on GitHub\. Sync now before you start the agent\./.test(there.bodyHtml) && /data-setup-act="sync">Sync now</.test(there.bodyHtml),
    'a handoff from it waiting: said, with Sync now');
  ok(!/mem-setup-here/.test(there.bodyHtml), '…and it is not "this computer"');
  // A v3.78.0 server: no saves[].
  const o = S.computerReaderContent(maint(), 0);
  ok(!!o && /<h3 class="mem-setup-ev-h">Saves<\/h3>/.test(o.bodyHtml) && /Antigravity, Claude Code saved this project here; newest/.test(textOf(o.bodyHtml)) && /also saved as mac-17d23c/.test(o.bodyHtml),
    'v3.78.0 shape (no saves[]): the tools that saved and the newest save, from the row', o && textOf(o.bodyHtml));
  ok(S.computerReaderContent(d, 9) === null && S.computerReaderContent(null, 0) === null, 'no such row: nothing opens');
  const ev = v379();
  ev.physical[1].installs[0].saves[0].scope = '<img src=x onerror=alert(1)>';
  ev.physical[1].installs[0].primary = '<img src=x onerror=alert(1)>';
  ok(!S.computerReaderContent(ev, 1).bodyHtml.includes('<img'), 'escaped');
  const ws = v379();
  ws.physical[1].installs[0].saves[0] = { tool: 'antigravity', label: 'Antigravity', scope: 'main', at: iso(1000), wrongScope: true };
  ok(/not its own name/.test(S.computerReaderContent(ws, 1).bodyHtml), 'amendment 4: `wrongScope: true` (no ownScope) is flagged too');
  ok(S.newestSavesOf({ installs: [{ primary: 'a', saves: [{ tool: 'x', at: iso(5000) }] }, { primary: 'b', saves: [{ tool: 'x', at: iso(1000) }] }] })[0].install === 'b',
    'newestSavesOf: across installs, the newest wins');
}


section('§19 a file reads as a DOCUMENT: soft line breaks inside a paragraph (screen review)');
{
  // The REAL shared renderer, module body eval'd with `icon` stubbed (its only
  // import) — test-next-memory-view.js's own lift.
  const { readFileSync } = await import('fs');
  const mdSrc = readFileSync(new URL('../src/public/next/shared/markdown.js', import.meta.url), 'utf8')
    .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\.\/app\.js';\s*$/m, '')
    .replace(/^export\s+/gm, '');
  const renderMarkdown = new Function('icon', mdSrc + '\nreturn renderMarkdown;')(() => '<svg></svg>');
  const wrapped = 'This repository\'s working state lives in The Curator. At the START of every session call the\n'
    + 'my-curator MCP tool get_project_context with project "ott" and read the standing brief\n'
    + 'and latest handoff before acting.';
  const doc = wrapped + '\n\nSecond paragraph,\nwrapped too.\n\n```\nline one\nline two\n```\n\n- item one\n  continues here\n- item two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nHard break  \nkept.';
  const html = S.fileBodyHtml(doc, null, null, null, renderMarkdown);
  const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  ok(ps.some((p) => /Curator\. At the START[\s\S]*the my-curator MCP tool[\s\S]*brief and latest handoff before acting\./.test(p) && !/<br/.test(p)),
    'a hard-wrapped paragraph renders as ONE <p>, its source newlines soft (no <br>)', html.slice(0, 700));
  ok(ps.some((p) => /^Second paragraph, wrapped too\.$/.test(p.trim())), 'a blank line still separates paragraphs', JSON.stringify(ps));
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  ok(!!pre && /line one\nline two/.test(pre[1]), 'a fenced block keeps its newlines', pre && pre[1]);
  ok(/item one continues here/.test(html) && (html.match(/<li/g) || []).length === 2, 'a list item\'s wrapped continuation joins the item; the list keeps two items', html);
  ok(/<table/.test(html) || /\| 1 \| 2 \|/.test(html), 'table rows are never joined into one line');
  ok(S.softWrap('Hard break  \nkept.') === 'Hard break  \nkept.', 'a line ending in two spaces (a markdown hard break) is kept');
  ok(S.softWrap('# Heading\nText') === '# Heading\nText' && S.softWrap('a\n# H') === 'a\n# H', 'a heading is never joined to its neighbour');
  ok(S.softWrap('```\na\nb\n```') === '```\na\nb\n```' && S.softWrap('a\n\nb') === 'a\n\nb', 'a fence and a blank line are left exactly as written');
  const evil = S.fileBodyHtml('safe\n<img src=x onerror=alert(1)>\ntext', null, null, null, renderMarkdown);
  ok(!/<img/.test(evil) && /&lt;img/.test(evil), 'joining lines never un-escapes: the renderer still escapes first', evil);
  // The shared renderer is UNCHANGED for every other caller: chat still sees
  // a single newline as a line break.
  ok(renderMarkdown('one\ntwo') === renderMarkdown('one\ntwo') && /one[\s\S]*<br[\s\S]*two|<p>one<\/p>\s*<p>two<\/p>/.test(renderMarkdown('one\ntwo')),
    'CONTROL: renderMarkdown itself is untouched — a single newline still breaks for chat', renderMarkdown('one\ntwo'));
}

section('§20 a session-named save is NOT flagged — only a wrong name is (screen review)');
{
  const d = v379();
  d.physical[1].installs[0].saves = [
    { tool: 'claude-code', label: 'Claude Code', scope: 'session-2026-09-28-setup-polish', at: iso(1000), ownScope: false, wrongScope: false },
  ];
  ok(!/not its own name/.test(S.computerReaderContent(d, 1).bodyHtml), 'ownScope:false with wrongScope:false (a session name): NOT flagged');
  d.physical[1].installs[0].saves[0] = { tool: 'claude-code', label: 'Claude Code', scope: 'session-2026-09-28-setup-polish', at: iso(1000), ownScope: false };
  ok(!/not its own name/.test(S.computerReaderContent(d, 1).bodyHtml), 'no wrongScope field, a session name: NOT flagged');
  d.physical[1].installs[0].saves[0] = { tool: 'claude-code', label: 'Claude Code', scope: 'antigravity', at: iso(1000) };
  ok(/not its own name “claude-code”/.test(S.computerReaderContent(d, 1).bodyHtml), 'no wrongScope field, ANOTHER tool\'s id: flagged');
  d.physical[1].installs[0].saves[0] = { tool: 'claude-code', label: 'Claude Code', scope: 'main', at: iso(1000) };
  ok(/not its own name/.test(S.computerReaderContent(d, 1).bodyHtml), 'no wrongScope field, "main": flagged');
  ok(S.wrongSave({ scope: 'x', wrongScope: true }) === true && S.wrongSave({ scope: 'main', wrongScope: false }) === false, 'the backend\'s wrongScope, when sent, decides');
  ok(S.wrongSave({ tool: 'claude-code', scope: 'claude-code' }) === false, 'its own name: not flagged');
}

console.log(`\n${failed ? '✗' : '✓'} test-next-setup-step: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
