#!/usr/bin/env node
/**
 * test-pro-guard.js — "Pro only REVEALS" (v4.2, build contract 2026-11-26).
 *
 * A warning, a cost line, a refusal, a confirm or an outcome is never behind
 * Pro. Two independent checks from scripts/test-helpers/pro-guard.js run over
 * RENDERED markup:
 *   rule 1 (structural): no `data-detail="pro"` element is or contains one;
 *   rule 2 (parity, the dumb cross-check): every protected text the Pro
 *           render shows is VISIBLE in the simple render.
 *
 *   §1  each check catches the real kit's own warning surfaces when they are
 *       put behind proAttr() — a monitor loud entry, a cost line from
 *       formatUsdHonest, the ai-run line, a refusal (renderStatus error), a
 *       Context to-fix note — and does NOT flag ordinary detail (an evidence
 *       line, a table column). Positive and negative controls, every run.
 *   §2  the pages the Pro test renders, starting with Context: step 5
 *       (views/setup-step.js renderSetupBody) over four payload arms × both
 *       modes, with the mode set the two ways a view may read it (the real
 *       pro.js state, and `ui.pro`). Rule 1 on each render; rule 2 between the
 *       Pro and the simple render of each arm.
 *   §3  Settings › General's Pro block, rendered from the real pro.js.
 *
 * Proven by mutation (see the release row): wrapping setup-step.js's to-fix
 * notes in data-detail="pro" turns §2 red by both rules.
 */
import { proGuardFaults, parityFaults, protectedTexts } from './test-helpers/pro-guard.js';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? `\n      ${String(detail).slice(0, 900)}` : '')); }
}
const section = (t) => console.log('\n' + t);

const P = await import('../src/public/next/shared/pro.js');
const { renderMonitor } = await import('../src/public/next/shared/monitor.js');
const { formatUsdHonest } = await import('../src/public/next/shared/format-usd.js');
const { renderRunsOn } = await import('../src/public/next/shared/ai-run.js');
const { renderStatus } = await import('../src/public/next/shared/text.js');
const S = await import('../src/public/next/views/setup-step.js');

const pro = (inner) => '<div' + P.proAttr() + '>' + inner + '</div>';

// ════════════════════════════════════════════════════════════════════════
section('§1 the checks catch the kit\'s real warning surfaces (controls)');
{
  const loud = renderMonitor({ id: 'm', label: 'Session start', lines: [{ key: 'reads', value: '12 KB' }],
    loud: [{ text: 'Over the reading budget by 4 KB.', tone: 'warn' }] });
  const cost = '<p class="ing-cost">This reading costs about ' + formatUsdHonest(0.042) + '.</p>';
  const runs = renderRunsOn({ model: 'gemini-x', modelLabel: 'Gemini X', provider: 'gemini' }) || '';
  const refusal = renderStatus ? renderStatus({ tone: 'error', title: 'Could not save', detail: 'The settings file could not be read.' }) : '';
  const toFix = S.toFixNotes({ toFix: [{ kind: 'marker-uncommitted', text: '.curator-project is not committed.', detail: 'A clone will not know it.' }] });
  const evidence = '<div class="mem-setup-ev"><p class="mem-setup-ev-p">~/.claude.json names my-curator</p></div>';
  const column = '<table><tr><th>LAST SAVED</th></tr><tr><td>2 min ago</td></tr></table>';

  ok(/cur-mon-loud/.test(loud) && proGuardFaults(pro(loud)).length > 0, 'rule 1 flags a monitor loud entry behind Pro', proGuardFaults(pro(loud)));
  ok(proGuardFaults(pro(cost)).length > 0, `rule 1 flags a cost line (${formatUsdHonest(0.042)}) behind Pro`);
  ok(runs && proGuardFaults(pro(runs)).length > 0, 'rule 1 flags the ai-run line behind Pro', runs);
  ok(refusal && proGuardFaults(pro(refusal)).length > 0, 'rule 1 flags a refusal (renderStatus) behind Pro', refusal);
  ok(/mem-setup-note/.test(toFix) && proGuardFaults(pro(toFix)).length > 0, 'rule 1 flags a Context to-fix note behind Pro');
  ok(proGuardFaults('<section' + P.proAttr() + '><div><div>' + toFix + '</div></div></section>').length > 0, '…and when it is nested three levels inside the Pro element');
  ok(proGuardFaults('<p class="mem-setup-note"' + P.proAttr() + '>x</p>').length > 0, '…and when the protected element itself carries the marker');
  ok(proGuardFaults(pro('<button class="btn cfd-confirm">Delete</button>')).length > 0, 'rule 1 flags a confirm control behind Pro');

  // v4.2.0 fix (audit M3): the surfaces the first list missed, by class and by meaning.
  ok(proGuardFaults(pro('<p class="cur-mon-note">The handoff was trimmed to fit.</p>')).length > 0, 'rule 1 flags the monitor\'s note (cur-mon-note) behind Pro');
  ok(proGuardFaults(pro('<p class="bk-note">Your harness’s share is not set.</p>')).length > 0, 'rule 1 flags a meter note (bk-note) behind Pro');
  ok(proGuardFaults(pro('<div class="mem-note"><span>The reading budget was not changed.</span></div>')).length > 0, 'rule 1 flags a step-4 notice or save error (mem-note) behind Pro');
  ok(proGuardFaults(pro('<span class="mem-hr-fix">AGENTS.md has no Curator block.</span>')).length > 0, 'rule 1 flags a harness row\'s to-fix line behind Pro');
  ok(proGuardFaults(pro('<p class="brand-new-warning">x</p>')).length > 0, 'rule 1 flags a NEW class whose last word says warning (by meaning, not by list)');
  ok(proGuardFaults(pro('<div id="mem-ss-budget-error">x</div>')).length > 0, 'rule 1 flags an element whose id names an error');
  ok(proGuardFaults(pro('<div data-never-pro><p class="tx-desc">could not be measured</p></div>')).length > 0, 'rule 1 flags a data-never-pro element (the failed measurement)');
  ok(proGuardFaults(pro('<p class="mem-setup-note-text">x</p>')).length === 0, 'NEGATIVE control: a class that only CONTAINS "note" mid-name is not protected by meaning');
  ok(parityFaults('<p class="cur-mon-note">Trimmed.</p><span class="cur-mon-warn">read first 14k · 58 KB</span>', '<span class="cur-mon-warn">read first 14k</span>').length === 1,
    'rule 2: the compact form may drop a byte size, never the note itself');
  ok(proGuardFaults(pro(evidence)).length === 0, 'NEGATIVE control: an evidence line behind Pro is fine (detail)');
  ok(proGuardFaults(pro(column)).length === 0, 'NEGATIVE control: a table column behind Pro is fine');
  ok(proGuardFaults(loud + cost + toFix + evidence).length === 0, 'NEGATIVE control: warnings NOT behind Pro are fine');
  ok(proGuardFaults(toFix + P.moreInProLine('every check per harness')).length === 0, 'NEGATIVE control: the "More in Pro" door is not itself a fault');

  // Rule 2, alone: a view that re-renders per mode and drops a warning in simple.
  ok(parityFaults(toFix + evidence, evidence).length === 1, 'rule 2 flags a to-fix shown in Pro but missing from the simple render');
  ok(parityFaults(toFix + evidence, toFix).length === 0, 'rule 2 passes when the simple render keeps it (and drops only detail)');
  ok(parityFaults(toFix, pro(toFix)).length === 1, 'rule 2 counts a warning the simple render has only behind data-detail="pro" as missing');
  ok(protectedTexts(loud + toFix).length >= 2, 'protectedTexts reads both the loud entry and the to-fix note (anti-vacuity)');
}

// ════════════════════════════════════════════════════════════════════════
section('§2 Context › step 5, rendered in both modes');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const tool = (id, label, extra = {}) => ({
  id, label, status: 'partly',
  saved: { state: 'ok', at: iso(2 * 60e3), scope: id, machine: 'mac-a', thisMachine: true },
  parts: { mcp: { state: 'ok', word: 'configured' }, skills: { state: 'cant-check', word: 'can’t check here' },
    block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'none', word: 'not wired, optional' } },
  evidence: [{ heading: 'MCP', lines: ['~/.claude.json names my-curator'] }], ...extra,
});
const base = () => ({
  ok: true, domain: 'projects', project: 'demo', checkedAt: iso(60e3),
  repo: null, repoCandidates: [], repoSuggestions: [],
  tools: [tool('claude-code', 'Claude Code')],
  computers: [{ key: 'a', names: ['mac-a'], primary: 'mac-a', aliases: [], thisComputer: true, installKind: 'app', tools: ['Claude Code'], newestSaveAt: iso(2 * 60e3), curatorVersion: '4.2.0' }],
  physical: [{ thisComputer: true, installs: [{ key: 'a', names: ['mac-a'], primary: 'mac-a', aliases: [], thisComputer: true, installKind: 'app', tools: ['Claude Code'], newestSaveAt: iso(2 * 60e3), curatorVersion: '4.2.0' }] }],
  counts: { toFix: 0, tools: 1, computers: 1, installs: 1, machineNames: 1 },
  sync: { configured: true, lastSync: iso(5 * 60e3), pending: 0, incoming: [] },
  toFix: [], addable: [], machine: { ids: ['mac-a'], split: false },
});
const ARMS = {
  'one ready harness': () => base(),
  'needs fixing + steps left': () => {
    const d = base();
    d.tools.push(tool('antigravity', 'Antigravity', { status: 'no-save', saved: { state: 'none', at: null } }));
    d.toFix = [
      { tool: 'antigravity', kind: 'block-missing', file: 'AGENTS.md', text: 'AGENTS.md has no Curator block.', detail: 'Antigravity reads AGENTS.md.', fix: { kind: 'copy-block', reveal: 'AGENTS.md' } },
      { kind: 'marker-uncommitted', text: '.curator-project is not committed.', detail: 'A clone elsewhere will not know it.', fix: { kind: 'copy-command', command: 'git add .curator-project' } },
    ];
    d.counts.toFix = 2;
    return d;
  },
  'a newer handoff waiting on GitHub': () => {
    const d = base();
    d.sync = { configured: true, lastSync: iso(38 * 60e3), pending: 3, incoming: ['projects/state/demo/codex/mac-b/current.md'] };
    d.toFix = [{ kind: 'sync-incoming', text: 'A newer handoff is waiting on GitHub.', detail: 'Sync first.', fix: { kind: 'sync' } }];
    return d;
  },
  'a re-check that failed': () => base(),
};
const MODE_ENV = (on) => ({
  fetch: async (u, i) => ({ ok: true, json: async () => ({ uiDetail: i && i.method === 'POST' ? JSON.parse(i.body).uiDetail : 'simple' }) }),
  localStorage: { getItem: () => null, setItem() {} },
});
async function renderIn(on, arm, name) {
  P.__resetPro();
  P.__setProEnv(MODE_ENV(on));
  if (on) await P.setPro(true);
  const s = { data: arm() };
  if (name === 'a re-check that failed') s.error = 'The re-check timed out';
  return S.renderSetupBody(s, { pro: on, openFolds: {} });
}
let rendered = 0;
for (const [name, arm] of Object.entries(ARMS)) {
  const simple = await renderIn(false, arm, name);
  const full = await renderIn(true, arm, name);
  rendered += 2;
  const f1 = proGuardFaults(simple), f2 = proGuardFaults(full);
  ok(!f1.length, `${name} — simple: nothing protected is behind data-detail="pro"`, f1.join('\n      '));
  ok(!f2.length, `${name} — Pro: nothing protected is behind data-detail="pro"`, f2.join('\n      '));
  const par = parityFaults(full, simple);
  ok(!par.length, `${name} — every warning the Pro render shows is visible in the simple render`, par.join('\n      '));
  if (name !== 'one ready harness') {
    ok(protectedTexts(full).length > 0, `${name} — anti-vacuity: the render really carries protected lines (${protectedTexts(full).length})`);
  }
}
ok(rendered === 8, `rendered ${rendered} Context renders (4 arms × 2 modes)`);

// ════════════════════════════════════════════════════════════════════════
section('§3 Settings › General: the Pro block');
{
  P.__resetPro(); P.__setProEnv(MODE_ENV(false));
  const sw = P.proSwitchHtml({ id: 'settings-pro-switch' });
  ok(proGuardFaults(sw).length === 0 && !/data-detail="pro"/.test(sw), 'the switch itself is never Pro-only (it is how you get to Pro)');
}

// ════════════════════════════════════════════════════════════════════════
section('§4 the "PRO" mark and hairline land only on Pro-only detail, so never on a warning');
{
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/public/next/shared/pro.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const marks = [...css.matchAll(/([^{}]+)\{[^{}]*content:\s*"PRO"[^{}]*\}/g)].map((m) => m[1]);
  const sels = marks.flatMap((s) => s.split(/,(?![^(]*\))/).map((x) => x.trim())).filter(Boolean);
  ok(sels.length >= 3, `the "PRO" micro-label has ${sels.length} header selectors (anti-vacuity)`);
  // v4.2.0 fix (e2e DEF-3): a part DRAWN only in Pro is marked by
  // `[data-pro-drawn]` — never hidden by CSS, so held by rule 2 (parity).
  const stray = sels.filter((s) => !s.startsWith('html[data-pro="on"] [data-detail="pro"] ') && !s.startsWith('html[data-pro="on"] [data-pro-drawn] '));
  ok(sels.some((s) => s.startsWith('html[data-pro="on"] [data-pro-drawn] ')) && P.proDrawnAttr() === ' data-pro-drawn', 'proDrawnAttr() emits the attribute pro.css marks (a Pro-drawn fold or label gets the "PRO" label)');
  ok(!/\[data-pro-drawn\][^{]*\{[^}]*display:\s*none/.test(css), 'nothing in pro.css HIDES [data-pro-drawn] (it is marking only)');
  // v4.2 integration: the label is placed by structure or by proMarkAttr()'s
  // attribute — never by an attribute match on a kit class name.
  ok(!sels.some((s) => /\[class[*^$~|]?=/.test(s)), 'no "PRO" selector matches on a class name ([class*=…])', sels.join(' | '));
  ok(sels.some((s) => /\[data-pro-mark\]::after$/.test(s)) && P.proMarkAttr() === ' data-pro-mark', 'proMarkAttr() emits the attribute pro.css labels');
  ok(!stray.length, 'every one sits INSIDE a data-detail="pro" element (rule 1 keeps warnings out of those)', stray.join(' | '));
  const hair = /(html\[data-pro="on"\] \[data-detail="pro"\][^{]*)\{[^}]*background-image:\s*var\(--pro-hair\)/.exec(css);
  ok(!!hair, 'the left hairline is drawn on data-detail="pro" elements only');
}

P.__resetPro();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
