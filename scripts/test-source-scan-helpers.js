/**
 * Self-test for scripts/test-helpers/source-scan.js.
 *
 * The helpers exist because ~40 assertions across seven suites were found to be
 * unfalsifiable. A replacement nobody has ATTACKED is worth no more than what it
 * replaced, so every helper here is driven against source that carries the
 * exact defect it claims to catch — a POSITIVE CONTROL — and against clean
 * source, and both directions are asserted.
 */
import { stripComments, functionSource, callSiteCount, assertLiteral, checkLiteral } from './test-helpers/source-scan.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.log(`  ✗ ${msg}`); } };
const section = (t) => console.log(`\n${t}`);

section('§1 stripComments removes what a comment could hide');
ok(!stripComments('foo();\n// bar();').includes('bar'), 'a whole-line comment is removed');
ok(!stripComments('foo(); // bar();').includes('bar'), 'a TRAILING comment is removed — the case the old hand-rolled version missed');
ok(!stripComments('/* bar(); */ foo();').includes('bar'), 'a block comment is removed');
ok(stripComments('foo();\n// bar();').split('\n').length === 2, 'newlines are preserved so line numbers stay meaningful');

section('§2 stripComments does NOT eat code that merely looks like a comment');
ok(stripComments(`const u = 'https://x/y';`).includes('https://x/y'), 'a URL inside a single-quoted string survives');
ok(stripComments('const u = "a // b";').includes('a // b'), 'slashes inside a double-quoted string survive');
ok(stripComments('const u = `a // b`;').includes('a // b'), 'slashes inside a template literal survive');
ok(stripComments('const r = /a\\/\\/b/;').includes('a'), 'a regex literal containing slashes survives');

section('§3 functionSource is FUNCTION-scoped — root cause 2');
const twoFns = `
function open() { if (state.trigger.disabled) return; position(); }
function onKeyDown() { if (state.trigger.disabled) return; other(); }
`;
ok(/position\(\)/.test(functionSource(twoFns, 'open')), 'open() body is found');
ok(!/other\(\)/.test(functionSource(twoFns, 'open')), 'open() body does NOT leak in onKeyDown\'s contents');
const openGone = twoFns.replace('function open() { if (state.trigger.disabled) return; position(); }', 'function open() { position(); }');
ok(/disabled/.test(twoFns.match(/function onKeyDown[\s\S]*/)[0]), 'CONTROL: the identical line really does exist in the other function');
ok(!/disabled/.test(functionSource(openGone, 'open')), 'POSITIVE CONTROL: deleting the refusal from open() is DETECTED, even though onKeyDown still has it');

section('§4 functionSource recognises this codebase\'s declaration forms');
ok(functionSource('const f = (a) => { body(); };', 'f') !== null, 'arrow form');
ok(functionSource('const f = async (a) => { body(); };', 'f') !== null, 'async arrow form');
ok(functionSource('async function f(a) { body(); }', 'f') !== null, 'async function form');
ok(functionSource('const f = function (a) { body(); };', 'f') !== null, 'function-expression form');
ok(functionSource('function g() {}', 'nope') === null, 'a missing name returns null so a caller can fail LOUDLY rather than scan an empty string');

section('§5 callSiteCount counts CALLS, not declarations — root cause 3');
const wired = `function stopPoll() {} function onEnter() { schedulePoll(); return () => { stopPoll(); }; }`;
ok(callSiteCount(wired, 'stopPoll') === 1, 'one real call site is counted, the declaration is not');
const unwired = wired.replace('return () => { stopPoll(); };', 'return () => { };');
ok(callSiteCount(unwired, 'stopPoll') === 0, 'POSITIVE CONTROL: deleting the only call site is DETECTED');
const commented = wired.replace('stopPoll(); };', '// stopPoll();\n };');
ok(callSiteCount(commented, 'stopPoll') === 0, 'POSITIVE CONTROL: a call left behind as a COMMENT does not count — the exact mutation that kept suites green');

section('§6 callSiteCount scopes to the enclosing function');
const twoScopes = `function stopPoll(){} function a(){ stopPoll(); } function onEnter(){ return () => { stopPoll(); }; }`;
ok(callSiteCount(twoScopes, 'stopPoll', { within: 'onEnter' }) === 1, 'the call inside onEnter is counted');
const tornDown = twoScopes.replace('return () => { stopPoll(); };', 'return () => {};');
ok(callSiteCount(tornDown, 'stopPoll', { within: 'onEnter' }) === 0, 'POSITIVE CONTROL: the teardown call is DETECTED as missing while a call in another function remains');
ok(callSiteCount(tornDown, 'stopPoll') === 1, 'and the file-wide count still sees the OTHER call — which is why file-wide scans were vacuous');
let threw = false;
try { callSiteCount(twoScopes, 'stopPoll', { within: 'ghostFunction' }); } catch { threw = true; }
ok(threw, 'a missing enclosing function THROWS rather than passing vacuously over an empty scope');

section('§7 assertLiteral pins vocabulary to a hand-written literal — root cause 4');
const CHIPS = { curator: 'measured by The Curator', none: 'not measured' };
let localPass = 0, localFail = 0;
const probe = (c) => { c ? localPass++ : localFail++; };
assertLiteral(probe, 'measured by The Curator', CHIPS.curator, 'curator chip');
ok(localPass === 1 && localFail === 0, 'a correct label passes');
const SWAPPED = { curator: 'not measured', none: 'measured by The Curator' };
localPass = 0; localFail = 0;
assertLiteral(probe, 'measured by The Curator', SWAPPED.curator, 'curator chip');
ok(localFail === 1, 'POSITIVE CONTROL: SWAPPING the two chip labels is DETECTED — the mutation that stayed green across 1982 assertions');

section('§8 the SIGNATURE HAZARD is real, and checkLiteral is immune to it');
// Measured: this repo's suites disagree about ok()'s argument order. Handing
// assertLiteral an ok(label, cond) makes every call pass unconditionally,
// because a non-empty message is truthy. Prove BOTH halves.
let revPass = 0, revFail = 0;
const reversedOk = (label, cond) => { cond ? revPass++ : revFail++; };
assertLiteral(reversedOk, 'measured by The Curator', 'not measured', 'swapped chip');
ok(revFail === 0 && revPass === 1, 'POSITIVE CONTROL: a reversed-signature ok makes assertLiteral pass over a WRONG value — the hazard is real, not theoretical');
const v = checkLiteral('measured by The Curator', 'not measured', 'swapped chip');
ok(v.pass === false, 'checkLiteral returns a verdict instead of calling ok, so the argument order cannot defeat it');
ok(/expected the literal/.test(v.message) && /not measured/.test(v.message), 'and its message reports BOTH sides so a failure is diagnosable');
const good = checkLiteral('not measured', 'not measured', 'chip');
ok(good.pass === true, 'a correct value still passes');

section('§9 no tracked source may contain a RAW NUL byte');
// WHY THIS LIVES HERE. This file's whole subject is making our scanning tools
// actually detect things. A raw NUL defeats them at a lower level than any
// regex: `grep` classifies the file as binary and returns rc=1 with NO output
// and NO warning, so every sweep over it reports a clean, empty result while
// having read nothing. Five tracked files carried one on 2026-08-29 — including
// two SECURITY suites, whose audits were therefore silently vacuous.
// The behaviour is never lost by fixing this: an escape is the same character
// to the engine, so a fixture that tests NUL handling still tests it.
import { readdirSync as rd, statSync as st, readFileSync as rf } from 'node:fs';
import { join } from 'node:path';
const NUL = 0;
const SKIP = new Set(['node_modules', '.git', 'domains', 'old']);
function walkJs(dir, out = []) {
  for (const e of rd(dir)) {
    if (SKIP.has(e) || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (st(p).isDirectory()) walkJs(p, out);
    else if (e.endsWith('.js') || e.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const scanned = [...walkJs('scripts'), ...walkJs('src'), ...walkJs('mcp')];
ok(scanned.length > 50, `the walk found real files to check (${scanned.length}) — a walk that found none would pass vacuously`);
const withNul = scanned.filter((f) => rf(f).includes(NUL));
ok(withNul.length === 0, `no tracked .js/.mjs carries a raw NUL byte${withNul.length ? ` — found in ${withNul.join(', ')}; write it as an escape instead, which is the same character to the engine` : ''}`);
// POSITIVE CONTROL: the detector must actually fire on a file that has one.
ok(Buffer.from([65, 0, 66]).includes(NUL), 'POSITIVE CONTROL: the detector fires on bytes that do contain a NUL');
ok(!Buffer.from('AB').includes(NUL), 'and does not fire on bytes that do not');

console.log(`\n────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`────────────────────────────────────────`);
process.exit(failed === 0 ? 0 : 1);
