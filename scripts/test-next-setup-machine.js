#!/usr/bin/env node
/**
 * test-next-setup-machine.js — v3.77.0. Settings › MCP bridge › 5 "Tools on
 * this Mac", through the REAL DOM-free builders (views/setup-machine.js),
 * fed payloads of GET /api/setup/machine's shape.
 *
 * Exists to stop:
 *   §1 a running-old-bridge warning behind a chevron (it is a loud entry,
 *      outside every tool fold).
 *   §2 a tool's verdict disagreeing with its cells (N to fix = its fix cells).
 *   §3 the wrong action: Copy entry only where the bridge is not configured;
 *      Reveal only for a file that exists; the two skill zips only where the
 *      skills cannot be checked here and this app carries a copy.
 *   §4 an observation stated more strongly than it was made (Antigravity's
 *      user-level hook file: "not seen used", never "not loaded").
 *   §5 unescaped payload text; the privacy sentence missing.
 */
let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 500)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const M = await import('../src/public/next/views/setup-machine.js');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const payload = () => ({
  ok: true, checkedAt: iso(3000), version: '3.77.0', install: 'Mac app', skillsShipped: true,
  machine: { ids: ['mac-a-111', 'mac-a-222'], split: true },
  bridgeProcesses: { checked: true, running: 2, stale: [{ pid: 1, startedAt: 'x' }], remedy: 'Quit and reopen the app that launched it.' },
  copyEntries: { opencode: '{"mcp":{"my-curator":{}}}' },
  harnesses: [
    { id: 'claude-code', label: 'Claude Code',
      files: [{ file: '/h/.claude.json', display: '~/.claude.json', via: 'own', present: true, named: false },
        { file: '/h/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', via: 'readAlso', present: true, named: true }],
      bridge: { state: 'ok', word: 'configured', via: 'readAlso', note: 'Observed 2026-09-26: …' },
      skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account', installed: [] },
      hooks: { state: 'none', word: 'not wired (optional)', files: [] } },
    { id: 'antigravity', label: 'Antigravity',
      files: [{ file: '/h/.gemini/config/mcp_config.json', display: '~/.gemini/config/mcp_config.json', via: 'own', present: true, named: true },
        { file: '/h/.gemini/antigravity/mcp_config.json', display: '~/.gemini/antigravity/mcp_config.json', via: 'own', present: true, named: false }],
      bridge: { state: 'fix', word: 'not in 1 of 2 files' },
      skills: { state: 'fix', word: 'my-curator outdated', installed: [{ skill: 'my-curator', dir: '/h/.gemini/config/plugins/p/skills/my-curator', dirDisplay: '~/…/my-curator', match: false, differs: ['SKILL.md'], missing: [] }] },
      hooks: { state: 'unmeasured', word: 'wired in the user file only · not seen working',
        files: [{ file: '/h/.gemini/config/hooks.json', display: '~/.gemini/config/hooks.json', scope: 'user', present: true, ours: true,
          observation: 'ran once (2026-09-26) but its injection was not seen used; the project file\'s was' }],
        evidence: { start: { at: iso(3600e3) }, stop: { at: iso(3500e3), decision: 'none', why: 'rung 4, no bridge session for this project in this window' } } } },
    { id: 'opencode', label: 'OpenCode',
      files: [{ file: '/h/.config/opencode/opencode.jsonc', display: '~/.config/opencode/opencode.jsonc', via: 'own', present: true, named: false, jsonc: true },
        { file: '/h/.config/opencode/opencode.json', display: '~/.config/opencode/opencode.json', via: 'own', present: false, named: false }],
      bridge: { state: 'none', word: 'no entry found' },
      skills: { state: 'none', word: 'not installed', installed: [] },
      hooks: { state: 'none', word: 'hooks cannot carry the ask', files: [] } },
  ],
});
function folds(html) { return [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].map((m) => m[1]); }

section('§1  the old-bridge warning is loud, outside the folds');
{
  const html = M.renderToolsOnThisMacBody({ data: payload() }, {});
  ok(/class="cur-mon-loud[^"]*"[^>]*>1 bridge started before the code on disk is still running\. <strong>Quit and reopen/.test(html), 'loud entry with the remedy');
  ok(folds(html).every((f) => !f.includes('cur-mon-loud')), '…not inside any tool fold');
  ok(folds(html).length === 3, 'one fold per tool');
  ok(/two installs on this computer, so two names/.test(html), 'the identity split is said');
}

section('§2  verdicts');
{
  const [cc, ag, oc] = payload().harnesses;
  ok(M.toolVerdict(cc).word === 'configured', 'Claude Code configured via another app\'s file: configured');
  ok(M.toolVerdict(ag).word === '2 to fix' && M.toolVerdict(ag).state === 'fix', 'Antigravity: bridge + skills = 2 to fix (hooks never count)');
  ok(M.toolVerdict(oc).word === 'no entry found', 'OpenCode: its own words');
  const html = M.renderToolsOnThisMacBody({ data: payload() }, {});
  ok(/class="cur-mon-state[^"]*"><span class="cur-mon-state-dot" aria-hidden="true"><\/span>2 to fix</.test(html), 'the monitor head counts the fix cells: 2 to fix', html.slice(0, 400));
}

section('§3  actions');
{
  const html = M.renderToolsOnThisMacBody({ data: payload() }, { 'tool-opencode': true, 'tool-antigravity': true, 'tool-claude-code': true });
  const f = folds(html);
  ok(/data-setup-act="copy-entry" data-tool="opencode"/.test(f[2]), 'OpenCode (not configured): Copy entry');
  ok(!/copy-entry/.test(f[0]), 'Claude Code (configured): no Copy entry');
  ok(!/data-path="\/h\/\.config\/opencode\/opencode\.json"/.test(f[2]), 'no Reveal for a file that is absent');
  ok(/data-path="\/h\/\.config\/opencode\/opencode\.jsonc"/.test(f[2]) && /read with comments allowed/.test(f[2]), 'Reveal for the .jsonc, which was read with comments allowed');
  ok(/href="\/api\/setup\/skills\/my-curator\.zip" download/.test(f[0]) && /curator-continuity\.zip/.test(f[0]), 'Claude (can\'t check here, app carries a copy): the two zips');
  const noCopy = M.renderToolsOnThisMacBody({ data: { ...payload(), skillsShipped: false } }, { 'tool-claude-code': true });
  ok(!/\.zip/.test(noCopy), 'no zips when this app carries no copy');
  ok(/outdated — differs: SKILL\.md/.test(f[1]), 'a stale skill names the file that differs');
  ok(/cur-setup-st-none">present · no my-curator entry/.test(f[0]), 'Claude Code configured via another file: its own entry-less file is NOT inked to fix');
  ok(/cur-setup-st-fix">present · no my-curator entry/.test(f[1]), 'Antigravity "not in 1 of 2 files": the entry-less file IS inked to fix');
}

section('§4  observations, no stronger than made');
{
  const html = M.renderToolsOnThisMacBody({ data: payload() }, { 'tool-antigravity': true });
  ok(/ran once \(2026-09-26\) but its injection was not seen used/.test(html) && !/not loaded|ignored/i.test(html), 'the user hook file: "not seen used", never "not loaded"');
  ok(/stop hook observed firing .* — did not ask: rung 4/.test(html) && /start hook observed firing/.test(html), 'the hook activity log\'s evidence is shown');
}

section('§5  escaping and privacy');
{
  const d = payload();
  d.harnesses[0].label = '<img src=x onerror=1>';
  d.harnesses[1].files[0].display = '<script>x</script>';
  const html = M.renderToolsOnThisMacBody({ data: d }, { 'tool-antigravity': true });
  ok(!/<img|<script>/.test(html), 'no payload string becomes a tag');
  ok(/Only whether each file names my-curator is read — never its contents/.test(html), 'the privacy sentence is on the page');
  ok(/Checking this computer/.test(M.renderToolsOnThisMacBody(null)), 'loading state');
  ok(/role="alert">Could not check this computer: boom/.test(M.renderToolsOnThisMacBody({ error: 'boom' })), 'error state');
  ok(/data-setup-act="machine-check"/.test(M.toolsOnThisMacHead({ data: payload() })), 'Check again');
}

console.log(`\n${failed ? '✗' : '✓'} test-next-setup-machine: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
