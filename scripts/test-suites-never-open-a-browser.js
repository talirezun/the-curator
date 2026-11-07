/**
 * test-suites-never-open-a-browser.js — OFFLINE guard for the harness itself.
 *
 * WHY. src/server.js opens the user's default browser when it starts, unless
 * CURATOR_NO_OPEN is set. A suite that spawns the real server without it opens
 * a tab in the maintainer's real Chrome on every run (hundreds, 2026-11-07).
 *
 * WHAT. Every file under scripts/ that (a) names src/server.js as a path in
 * CODE (comments stripped) and (b) calls spawn / fork / execFile must either
 * set CURATOR_NO_OPEN in code, or go through scripts/visual/server.js's
 * startIsolatedServer(), which sets it. And the runner passes it to every
 * suite, so a suite that forgets still cannot open a tab under `npm test`.
 *
 * Both halves are proved by MUTATION in-process: the same detector run on the
 * source of a real offender with the variable removed must go red, and the
 * runner's env check must go red on a runner with the line removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** A verdict for one file's source: { spawnsServer, safe }. A spawner is a
 *  spawn / spawnSync / fork call whose own argument list names src/server.js
 *  (a file that merely READS src/server.js as text is not one). */
export function judge(src) {
  const code = stripComments(src);
  const re = /\b(spawn|spawnSync|fork)\s*\([^;]{0,240}?['"`]src(?:\/|['"`]\s*,\s*['"`])server\.js['"`]/g;
  let spawnsServer = false;
  for (let m; (m = re.exec(code));) {
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    // A line that opens with a quote is a string being compared with
    // (test-install-mode.js pins the restart block as text), never a call.
    if (/^\s*['"`]/.test(code.slice(lineStart, m.index + 1))) continue;
    spawnsServer = true; break;
  }
  const safe = /CURATOR_NO_OPEN/.test(code) || /startIsolatedServer/.test(code);
  return { spawnsServer, safe };
}

function listScripts() {
  const out = [];
  for (const dir of [SCRIPTS, path.join(SCRIPTS, 'visual')]) {
    for (const f of fs.readdirSync(dir)) if (/\.(m?js)$/.test(f)) out.push(path.join(dir, f));
  }
  return out.filter((f) => f !== fileURLToPath(import.meta.url));
}

console.log('§1  Every suite that spawns src/server.js sets CURATOR_NO_OPEN');
const offenders = [];
let spawners = 0;
for (const f of listScripts()) {
  const v = judge(fs.readFileSync(f, 'utf8'));
  if (v.spawnsServer) { spawners++; if (!v.safe) offenders.push(path.relative(ROOT, f)); }
}
ok(spawners >= 8, `the detector sees the real spawners (${spawners} found; it is not matching nothing)`, spawners);
ok(offenders.length === 0, `no suite spawns the server without CURATOR_NO_OPEN (${offenders.length} offender(s))`, offenders);

console.log('\n§2  Mutation: the detector goes red on a real spawner with the variable removed');
{
  const real = fs.readFileSync(path.join(SCRIPTS, 'test-trash-restore.js'), 'utf8');
  ok(judge(real).spawnsServer && judge(real).safe, 'control: test-trash-restore.js is a spawner and is safe', judge(real));
  const mutated = real.replace(/CURATOR_NO_OPEN/g, 'CURATOR_SOMETHING_ELSE');
  const v = judge(mutated);
  ok(v.spawnsServer && !v.safe, 'with CURATOR_NO_OPEN removed the same file is reported as an offender', v);
  const viaHelper = fs.readFileSync(path.join(SCRIPTS, 'test-info-panel-reachability.js'), 'utf8');
  ok(judge(viaHelper).safe, 'a suite that uses startIsolatedServer is safe through the helper');
  const helper = fs.readFileSync(path.join(SCRIPTS, 'visual', 'server.js'), 'utf8');
  ok(/env\.CURATOR_NO_OPEN\s*=\s*'1'/.test(stripComments(helper)), 'the helper itself sets CURATOR_NO_OPEN=1');
}

console.log('\n§3  The runner hands CURATOR_NO_OPEN to every suite');
{
  const runner = stripComments(fs.readFileSync(path.join(SCRIPTS, 'run-tests.js'), 'utf8'));
  const sets = (src) => /CURATOR_NO_OPEN\s*:\s*'1'/.test(src) || /CURATOR_NO_OPEN\s*=\s*'1'/.test(src);
  ok(sets(runner), 'run-tests.js sets CURATOR_NO_OPEN=1 in the environment every suite runs in');
  ok(!sets(runner.replace(/CURATOR_NO_OPEN/g, 'X')), 'mutation: without the line the check goes red');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
