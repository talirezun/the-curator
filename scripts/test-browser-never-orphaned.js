/**
 * test-browser-never-orphaned.js — LIVE_LOCAL (needs a Chromium-family browser;
 * self-skips at exit 0 without one). $0, no network.
 *
 * Headless Chromes launched by scripts/visual/browser.js were found alive 17-21
 * hours after their suites ended. Each case below launches a REAL browser from a
 * child node process, ends that process a different way WITHOUT calling close(),
 * and asserts the browser pid is gone. Only pids this test launched are ever
 * signalled (the final sweep kills a leftover by its exact pid, never a pattern).
 *
 *   A  the child returns normally without close()          (exit net)
 *   B  the child throws                                    (exit net)
 *   C  the child is sent SIGTERM                           (signal net)
 *   D  the child is SIGKILLed — nothing in-process can run (watchdog)
 *   E  MUTATION: with the watchdog disabled D leaves the browser running, so D
 *      is shown to be the watchdog's doing and not an accident of the browser.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findBrowser } from './visual/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (!findBrowser()) {
  console.log('⊘ SKIPPED — no Chromium-family browser found; there is nothing to orphan.');
  process.exit(0);
}

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const launched = [];

/** Run a child that launches a browser, prints its pid, then does `how`. */
async function scenario(how, { noWatchdog = false } = {}) {
  const code = `
    import { launchBrowser } from ${JSON.stringify(path.join(HERE, 'visual', 'browser.js'))};
    const b = await launchBrowser({ headless: true });
    console.log('PID ' + b.pid);
    const how = ${JSON.stringify(how)};
    if (how === 'return') process.exit(0);   // a suite ending by process.exit, close() never called
    else if (how === 'throw') throw new Error('boom');
    else await new Promise(() => setInterval(() => {}, 1000));   // wait to be signalled
  `;
  const env = { ...process.env, CURATOR_NO_OPEN: '1' };
  if (noWatchdog) env.CURATOR_TEST_NO_BROWSER_WATCHDOG = '1';
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  let pid = null;
  for (let i = 0; i < 150 && !pid; i++) { const m = /PID (\d+)/.exec(out); if (m) pid = Number(m[1]); else await delay(200); }
  if (pid) launched.push(pid);
  if (how === 'SIGTERM' || how === 'SIGKILL') { await delay(500); child.kill(how); }
  await new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(); else child.on('exit', r); });
  // The exit nets are synchronous; the watchdog polls every 2 s and waits 2 s.
  let gone = false;
  for (let i = 0; i < 40 && pid; i++) { if (!alive(pid)) { gone = true; break; } await delay(250); }
  return { pid, gone };
}

console.log('§1  The browser dies with its run, on every way the run can end');
for (const how of ['return', 'throw', 'SIGTERM', 'SIGKILL']) {
  const r = await scenario(how);
  ok(r.pid && r.gone, `${how}: the browser (pid ${r.pid}) is gone without close() having run`, r);
}

console.log('\n§2  Mutation: without the watchdog a SIGKILLed run leaves the browser behind');
{
  const r = await scenario('SIGKILL', { noWatchdog: true });
  ok(r.pid && !r.gone, 'SIGKILL with the watchdog disabled leaves the browser running (so §1 SIGKILL is the watchdog\'s doing)', r);
  if (r.pid && alive(r.pid)) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
}

for (const pid of launched) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
