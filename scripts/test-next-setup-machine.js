#!/usr/bin/env node
/**
 * test-next-setup-machine.js — v3.77.0, re-cut v3.88.0. The EVIDENCE under
 * each agent app's row in Settings › MCP bridge › 1 "Connect your agent apps"
 * (views/setup-machine.js renderAppDetail), fed payloads of GET
 * /api/setup/machine's shape. The row itself — its verdict and its unfolded
 * warnings — is scripts/test-next-mcp-install.js's.
 *
 * Exists to stop:
 *   §1 the disclosure naming the wrong contents ("Files, skills and hooks"
 *      when it holds no hooks), or a group shown for something the app lacks;
 *   §2 a verdict disagreeing with its cells (N to fix = its fix cells);
 *   §3 the wrong action: Reveal only for a file that exists (and only on
 *      macOS); the two skill zips only where skills cannot be checked here;
 *   §4 an observation stated more strongly than it was made;
 *   §5 unescaped payload text.
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
const D = (h, data = payload(), opts = {}) => M.renderAppDetail(h, data, opts);
const byId = (id, d = payload()) => d.harnesses.find((h) => h.id === id);

section('§1  what the disclosure holds, and says it holds');
{
  const cc = D(byId('claude-code'));
  ok(cc.label === 'Files, skills and hooks', 'Claude Code: files, skills (held by the account) and hooks', cc.label);
  const ag = D(byId('antigravity'));
  ok(ag.label === 'Files, skills and hooks' && /settings-setup-cap">MCP entry</.test(ag.html) && /settings-setup-cap">Skills</.test(ag.html) && /settings-setup-cap">Hooks</.test(ag.html),
    'Antigravity: the three groups, captioned MCP entry · Skills · Hooks');
  const desk = { id: 'claude-desktop', label: 'Claude Desktop', files: [], bridge: { state: 'ok' },
    skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account', installed: [] },
    hooks: { state: 'none', word: 'no hook mechanism', format: 'none', files: [] } };
  const dd = D(desk);
  ok(dd.label === 'Files and skills' && !/settings-setup-cap">Hooks</.test(dd.html), 'an app with no hook mechanism: "Files and skills", no Hooks group');
  const cline = { id: 'cline', label: 'Cline', files: [], bridge: { state: 'none' },
    skills: { state: 'cant-check', word: 'can’t check here', note: 'no known skill folder for this tool', installed: [] },
    hooks: { state: 'none', word: 'not wired (optional)', format: 'unverified', files: [] } };
  ok(D(cline).label === 'Files and hooks' && !/settings-setup-cap">Skills</.test(D(cline).html), 'an app with no known skill folder: no Skills group');
  ok(!/<details/.test(ag.html) && !/cur-mon-loud/.test(ag.html), 'the evidence holds no fold of its own and no warning — a warning is the row’s, unfolded');
}

section('§2  verdicts');
{
  const [cc, ag, oc] = payload().harnesses;
  ok(M.toolVerdict(cc).word === 'configured', 'Claude Code configured via another app\'s file: configured');
  ok(M.toolVerdict(ag).word === '2 to fix' && M.toolVerdict(ag).state === 'fix' && M.toolVerdict(ag).fixes === 2, 'Antigravity: bridge + skills = 2 to fix (hooks never count)');
  ok(M.toolVerdict(oc).word === 'no entry found', 'OpenCode: its own words');
}

section('§3  actions');
{
  const d = payload();
  const oc = D(byId('opencode', d), d).html;
  const cc = D(byId('claude-code', d), d).html;
  const ag = D(byId('antigravity', d), d).html;
  ok(!/data-path="\/h\/\.config\/opencode\/opencode\.json"/.test(oc), 'no Reveal for a file that is absent');
  ok(/data-path="\/h\/\.config\/opencode\/opencode\.jsonc"/.test(oc) && /read with comments allowed/.test(oc), 'Reveal for the .jsonc, which was read with comments allowed');
  ok(/href="\/api\/setup\/skills\/my-curator\.zip" download/.test(cc) && /curator-continuity\.zip/.test(cc), 'Claude (can\'t check here, app carries a copy): the two zips');
  ok(!/\.zip/.test(D(byId('claude-code'), { ...payload(), skillsShipped: false }).html), 'no zips when this app carries no copy');
  ok(/older — SKILL\.md differs/.test(ag), 'a stale skill names the file that differs ("older — SKILL.md differs")', ag.match(/older[^<]*/)?.[0]);
  ok(/cur-setup-st-none">present · no my-curator entry/.test(cc), 'Claude Code configured via another file: its own entry-less file is NOT inked to fix');
  ok(/cur-setup-st-fix">present · no my-curator entry/.test(ag), 'Antigravity "not in 1 of 2 files": the entry-less file IS inked to fix');
  ok(/another app’s file, read for this app/.test(cc), 'the readAlso file says whose file it is');
  ok(/data-setup-act="reveal"/.test(ag) && !/data-setup-act="reveal"/.test(D(byId('antigravity'), payload(), { platform: 'win32' }).html)
    && !/data-setup-act="reveal"/.test(D(byId('antigravity'), payload(), { platform: 'linux' }).html), 'Reveal (open -R) on macOS only — never a dead button on Windows or Linux');
}

section('§4  observations, no stronger than made');
{
  const html = D(byId('antigravity')).html;
  ok(/ran once \(2026-09-26\) but its injection was not seen used/.test(html) && !/not loaded|ignored/i.test(html), 'the user hook file: "not seen used", never "not loaded"');
  ok(/stop hook observed firing .* — did not ask: rung 4/.test(html) && /start hook observed firing/.test(html), 'the hook activity log\'s evidence is shown');
}

section('§4b v3.78.0 — each config file\'s own status, in words, beside its path');
{
  const d = payload();
  const ag = d.harnesses[1];
  ag.bridge = { state: 'ok', word: 'configured' };
  const words = {};
  for (const [status, want] of [['empty', 'empty'], ['invalid', 'not valid JSON'], ['unopenable', 'can’t open'], ['missing', 'missing']]) {
    ag.files[1] = { ...ag.files[1], status, present: status !== 'missing' && status !== 'unopenable', named: false };
    const f = D(ag, d).html;
    words[status] = f;
    ok(new RegExp('~/\\.gemini/antigravity/mcp_config\\.json</span><span><span class="cur-setup-st cur-setup-st-(q|none)">' + want + '<').test(f),
      status + ': the file\'s path, then "' + want + '", not inked to fix while another file names my-curator');
  }
  ok(/is empty — another file of this app names my-curator, so the app is not affected/.test(words.empty), 'the note says why it is not a to-fix, naming the file');
  ok(/data-path="\/h\/\.gemini\/antigravity\/mcp_config\.json"/.test(words.unopenable), 'a file that cannot be opened is still revealable');
  ag.bridge = { state: 'fix', word: 'can’t read its config' };
  ag.files[1] = { ...ag.files[1], status: 'unopenable', present: true };
  const f = D(ag, d).html;
  ok(/cur-setup-st-fix">can’t open</.test(f) && !/so the app is not affected/.test(f), 'when the app itself is to fix, the unopenable file is inked to fix');
  ok(M.FILE_STATUS_WORDS.invalid === 'not valid JSON' && Object.isFrozen(M.FILE_STATUS_WORDS), 'the four words, frozen');
}

section('§5  escaping, and the head');
{
  const d = payload();
  d.harnesses[1].files[0].display = '<script>x</script>';
  d.harnesses[1].skills.installed[0].dirDisplay = '<img src=x onerror=1>';
  const html = D(d.harnesses[1], d).html;
  ok(!/<img|<script>/.test(html) && /&lt;script&gt;/.test(html), 'no payload string becomes a tag; the text is still shown');
  ok(/data-setup-act="machine-check"/.test(M.checkHead({ data: payload() })) && /checked/.test(M.checkHead({ data: payload() })), 'the head: "checked … · Check again"');
  ok(/disabled/.test(M.checkHead({ data: payload(), loading: true })), 'Check again is disabled while a check runs');
}

console.log(`\n${failed ? '✗' : '✓'} test-next-setup-machine: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
