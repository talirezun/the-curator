#!/usr/bin/env node
/**
 * test-onboarding-steps.js — v4.1.2 first-run guide fixes (audit O3, O6).
 *
 * O3: "Add an AI key → Open Settings" landed on Settings › General (the
 *     first section), where there is no key field. go('api-key') now also
 *     clicks Settings' own Providers & keys row once Settings has mounted.
 * O6: an agent user with every REQUIRED step done still saw the guide come
 *     back ("3 of 4 done"), because the OPTIONAL key step counted. An
 *     optional step left undone no longer keeps the guide showing, polling,
 *     or open; the knowledge set (no optional step) is unchanged.
 *
 * The REAL functions are extracted from src/public/next/views/onboarding.js
 * by brace matching and run standalone (the technique
 * scripts/test-next-onboarding.js uses). Offline: no server, no DOM, no
 * network. The two-door rule is re-checked here as a control.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ob = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.js'), 'utf8');
const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

function extractFunction(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start); let d = 0;
  for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) { p++; break; } } }
  let i = src.indexOf('{', p); d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced`);
  return out;
}
function extractConst(src, name) {
  const m = new RegExp(`(?:^|\\n)const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm').exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  return m[0].trim();
}

// ── O3 ───────────────────────────────────────────────────────────────────
console.log('\nO3. The key step lands on Providers & keys');
{
  // Settings really renders a row per SETTINGS_SECTIONS entry with data-section,
  // 'providers' is one of them, and it is NOT the first (which is where plain
  // navigation lands) — the reason the click is needed at all.
  const sec = /const SETTINGS_SECTIONS = \[([\s\S]*?)\n\];/.exec(settings);
  const ids = sec ? [...sec[1].matchAll(/^\s*\['([a-z]+)'/gm)].map((x) => x[1]) : [];
  ok(ids.includes('providers') && ids[0] !== 'providers', `Settings has a 'providers' section that is not its landing section (sections: ${ids.join(',')})`);
  // Rows are shared/sidebar.js rows (class settings-nav-row) carrying
  // `data: { section: id }`, which sidebar.js renders as data-section="<id>".
  ok(/data:\s*\{\s*section:\s*id\s*\}/.test(settings) && /settings-nav-row/.test(readFileSync(path.join(ROOT, 'src/public/next/shared/sidebar.js'), 'utf8')),
    'Settings renders its nav rows with data-section = the section id (the selector the click uses)');

  const src = ['go', 'goToDomainsCreate', 'goToMcpBridge', 'goToProvidersAndKeys', 'targetViewFor'].map((n) => extractFunction(ob, n)).join('\n');
  function run(stepId, deferMount) {
    const log = []; const queued = []; let mounted = false;
    const row = (sel) => ({ click: () => log.push('click:' + sel) });
    const doc = {
      getElementById: (id) => (mounted && id === 'dm-new-domain-btn' ? row('#' + id) : null),
      querySelector: (sel) => (mounted ? row(sel) : null),
    };
    const api = new Function('navigate', 'afterViewMount', 'document', 'refresh', 'panelGen', 'requestDomainFold', 'ADD_SOURCES_FOLD',
      src + '\nreturn { go };')(
      (v) => { log.push('navigate:' + v); if (!deferMount) mounted = true; },
      (cb) => { if (deferMount) { queued.push(cb); return; } cb(); },
      doc, () => log.push('refresh'), 0, (id) => log.push('fold:' + id), 'add-sources');
    let threw = null;
    try { api.go(stepId); } catch (e) { threw = e; }
    return { log, threw, flush() { mounted = true; queued.splice(0).forEach((c) => c()); } };
  }
  const PROV = 'click:.settings-nav-row[data-section="providers"]';
  const MCP = 'click:.settings-nav-row[data-section="mcp"]';
  {
    const r = run('api-key', true);
    ok(r.threw === null, 'go("api-key") does not throw while the mount is pending');
    ok(!r.log.includes(PROV), '…and clicks nothing before Settings has mounted');
    r.flush();
    ok(r.log.includes(PROV), '…and clicks the Providers & keys row once it has');
    ok(r.log.indexOf('navigate:settings') >= 0 && r.log.indexOf('navigate:settings') < r.log.indexOf(PROV), 'navigation to Settings first, then the section click');
    ok(r.log.filter((x) => x.startsWith('click:')).length === 1, 'exactly one click, and it is not the MCP row');
  }
  {
    const r = run('api-key', false);
    ok(r.threw === null && r.log.includes(PROV), 'with motion off the click happens inside go() itself');
  }
  {
    const r = run('bridge', false);
    ok(r.log.includes(MCP) && !r.log.includes(PROV), 'CONTROL: the bridge step still opens MCP bridge, never Providers');
    const d = run('domain', false);
    ok(!d.log.includes(PROV) && !d.log.includes(MCP), 'CONTROL: the domain step opens no Settings section');
  }
}

// ── O6 ───────────────────────────────────────────────────────────────────
console.log('\nO6. An optional step left undone does not keep the guide showing');
{
  const consts = ['STEP_ORDER', 'AGENT_STEP_ORDER', 'STEP_SETS', 'DOORS', 'STEP_COPY', 'AGENT_STEP_COPY', 'UNKNOWN_FACTS'];
  const fns = ['buildSteps', 'shouldShowPanel', 'shouldKeepPolling'];
  const box = new Function('root',
    consts.map((c) => extractConst(ob, c)).join('\n') + '\nlet steps = [];\n' + fns.map((n) => extractFunction(ob, n)).join('\n')
    + `\nreturn { ${fns.join(', ')}, DOORS, setSteps: (s) => { steps = s; } };`)({});
  const { buildSteps, shouldShowPanel, shouldKeepPolling, DOORS, setSteps } = box;

  ok(Array.isArray(DOORS) && DOORS.length === 2, 'CONTROL: exactly two doors');

  const agentDone = buildSteps({ hasKey: false, hasDomain: true, hasPages: false, hasProject: true, bridgeUsed: true }, 'agent');
  ok(agentDone.length === 4 && agentDone.filter((s) => !s.done).map((s) => s.id).join() === 'api-key' && agentDone.find((s) => s.id === 'api-key').optional === true,
    'fixture: agent set, three required steps done, the optional key not');
  ok(shouldShowPanel(agentDone, false) === false, 'THE FIX: the guide does not come back on its own for that user');
  setSteps(agentDone);
  ok(shouldKeepPolling() === false, '…and stops re-checking (nothing left to find out)');

  const agentPart = buildSteps({ hasKey: false, hasDomain: true, hasPages: false, hasProject: true, bridgeUsed: false }, 'agent');
  ok(shouldShowPanel(agentPart, false) === true, 'CONTROL: a REQUIRED agent step undone still shows the guide');
  setSteps(agentPart);
  ok(shouldKeepPolling() === true, '…and keeps polling');

  const knowNoKey = buildSteps({ hasKey: false, hasDomain: true, hasPages: true });
  ok(knowNoKey.every((s) => s.optional === false) && shouldShowPanel(knowNoKey, false) === true,
    'CONTROL: on the knowledge set the key is REQUIRED — still shown when missing (unchanged)');
  const knowAll = buildSteps({ hasKey: true, hasDomain: true, hasPages: true });
  ok(shouldShowPanel(knowAll, false) === false && shouldShowPanel(knowAll, true) === false, 'CONTROL: all done hides, as before');
  ok(shouldShowPanel(agentPart, true) === false, 'CONTROL: dismissed still hides');

  // The auto-close in refresh() reads the same rule.
  const refreshSrc = extractFunction(ob, 'refresh');
  ok(/autoCloseOnComplete && steps\.every\(\(s\) => s\.done \|\| s\.optional === true\)/.test(refreshSrc),
    'refresh() auto-closes on the same rule (an undone optional step does not hold it open)');
}

console.log(`\ntest-onboarding-steps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
