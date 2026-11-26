#!/usr/bin/env node
/**
 * test-machine-name.js — a computer is NAMED on Context, never shown by its
 * raw folder id (v4.2.0 fix, e2e A confusion 7: "saved on studio-mac-aa11bb").
 *
 *   §1 src/public/next/shared/machine-name.js against the menu-bar widget's
 *      own display (desktop/lib/tray-model.js `hostPart` / `shortMachineNames`)
 *      — the DUMB CROSS-CHECK: 4,000 generated names, every answer equal.
 *   §2 the rules, by example: the install id goes only when it looks like one;
 *      two computers sharing a host part get a short tag apart.
 *   §3 Context › Setup shows names: the harness row, its reader, the guide,
 *      the Pro table, the Computers fold and the backend's "saved a newer
 *      handoff" sentence — and keeps the raw id where it is an identity
 *      (data attributes, the payload's `machine`).
 */
let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? '\n      ' + String(detail).slice(0, 600) : '')); }
}
const section = (t) => console.log('\n' + t);

const M = await import('../src/public/next/shared/machine-name.js');
const T = await import('../desktop/lib/tray-model.js');
const S = await import('../src/public/next/views/setup-step.js');

section('§1 the same display as the menu-bar widget (cross-check)');
{
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const hosts = ['studio-mac', 'mac', 'talis-macbook-pro', 'build-box', 'a', 'x-y-z', 'DESKTOP-7QK2', 'ci', 'mac-mini', 'b'];
  const tails = ['aa11bb', '9f3c1a', 'acb035', '17d23c', 'box', 'ABCD', 'abc', '12', '', 'deadbeef', 'zz11'];
  const gen = () => { const h = pick(hosts); const t = pick(tails); return t ? h + '-' + t : h; };
  let same = 0, n = 0;
  for (let i = 0; i < 4000; i++) {
    const m = gen();
    n++;
    if (M.hostPart(m) === T.hostPart(m)) same++;
  }
  ok(same === n, `hostPart agrees with the tray's on ${same} of ${n} generated names`);
  let setsSame = 0, sets = 0;
  for (let i = 0; i < 400; i++) {
    const list = Array.from({ length: 1 + Math.floor(rnd() * 6) }, gen);
    sets++;
    const a = M.shortMachineNames(list), b = T.shortMachineNames(list);
    if (list.every((m) => a.get(m) === b.get(m))) setsSame++;
  }
  ok(setsSame === sets, `shortMachineNames agrees with the tray's on ${setsSame} of ${sets} sets`);
  ok(M.hostPart('') === T.hostPart('') && M.hostPart(null) === T.hostPart(null), '…and on empty input');
}

section('§2 the rules');
ok(M.hostPart('studio-mac-aa11bb') === 'studio-mac', 'studio-mac-aa11bb → studio-mac');
ok(M.hostPart('build-box') === 'build-box', 'build-box keeps both words (box is not hex)');
ok(M.hostPart('mac') === 'mac', 'a bare hostname is itself');
{
  const n = M.shortMachineNames(['mac-aa11bb', 'mac-cc22dd', 'studio-mac-9f3c1a']);
  ok(n.get('mac-aa11bb') === 'mac·aa11' && n.get('mac-cc22dd') === 'mac·cc22' && n.get('studio-mac-9f3c1a') === 'studio-mac',
    'two computers sharing a host part get a short tag apart; a unique one does not', JSON.stringify([...n]));
  ok(M.machineDisplayName('mac-aa11bb', ['mac-aa11bb']) === 'mac', 'the same machine twice never disambiguates against itself');
}

section('§3 Context › Setup shows the computer\'s NAME');
{
  const iso = (ago) => new Date(Date.now() - ago).toISOString();
  const d = {
    ok: true, domain: 'projects', project: 'p', checkedAt: iso(1e3), repo: null,
    tools: [{ id: 'opencode', label: 'OpenCode', status: 'no-save',
      saved: { state: 'ok', at: iso(3600e3), scope: 'opencode', machine: 'studio-mac-aa11bb', thisMachine: false },
      parts: { mcp: { state: 'none', word: 'not found' }, skills: { state: 'none', word: 'not installed' }, block: { state: 'not-checked', word: 'x' }, hooks: { state: 'none', word: '—' } } }],
    physical: [{ thisComputer: false, installs: [{ primary: 'studio-mac-aa11bb', names: ['studio-mac-aa11bb'], thisComputer: false, installKind: 'app', tools: ['OpenCode'], newestSaveAt: iso(3600e3) }] }],
    computers: [], sync: { configured: true, pending: 0, incoming: [] }, toFix: [], addable: [],
  };
  const text = (h) => String(h).replace(/<[^>]+>/g, ' ');
  const row = S.harnessRowModel(d.tools[0], d).lines.join(' ');
  ok(/on studio-mac\b/.test(text(row)) && !/aa11bb/.test(text(row)), 'the harness row: "saved … on studio-mac"', text(row));
  const reader = S.toolReaderContent(d, 'opencode', { pro: false }).bodyHtml;
  ok(!/studio-mac-aa11bb/.test(text(reader)) && /from studio-mac,/.test(text(reader)), 'its reader and the guide\'s step 4 name studio-mac', text(reader).slice(0, 400));
  const pro = S.renderSetupBody({ data: d }, { pro: true, openFolds: { 'setup-tools': true, 'setup-computers': true } });
  ok(!/studio-mac-aa11bb/.test(text(pro)) && /studio-mac/.test(text(pro)), 'the Pro table and the Computers fold name studio-mac');
  const comp = S.computerReaderContent(d, 0);
  ok(comp.title === 'studio-mac' && !/studio-mac-aa11bb/.test(text(comp.bodyHtml)), 'the computer\'s reader is titled studio-mac', comp.title);
  // The backend's "saved a newer handoff" sentence is asserted on its real
  // output in scripts/test-setup-check.js (g).
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
