#!/usr/bin/env node
/**
 * OFFLINE — the stale-bridge reading (v3.64.0): detection, the route field,
 * the two notes on the bridge page, and `doctor`'s section.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * On 2026-09-20 the maintainer's Mac was running a `my-curator` bridge that
 * Claude Desktop had spawned on 2026-09-18 and never restarted. It survived
 * five in-app updates and was still serving pre-v3.59.0 code — 22 tools, no
 * `get_project_context`, no `save_foundation` — while the files on disk were
 * v3.63.0. Every surface the app has said the install was healthy, correctly:
 * the pill reads the SAVED launch line, the self-test spawns a FRESH child.
 * Neither can see a long-lived process, and the process's parent is the
 * client, not The Curator, so the app can only report it.
 *
 * FOUR THINGS CAN GO WRONG, and three of them are silent:
 *
 *   1. A FALSE NEGATIVE THAT LOOKS LIKE A CLEAN BILL. `checked: false` means
 *      "we did not look". If anything downstream renders that as "no stale
 *      bridge", the app makes a claim it has no basis for — the same defect
 *      `mcp-usage.js` avoids with "not used since this log began". §1 and §3
 *      drive every refusal arm and require the consumers to stay silent.
 *   2. A FALSE POSITIVE. Telling a user to restart Claude Desktop for nothing
 *      costs the reading its credibility on the day it is right. §2 drives a
 *      bridge started one second AFTER the code changed and requires `fresh`.
 *   3. A PATH BECOMING A PROGRAM. This is the only place in the app that
 *      reads a process list. §5 proves the argv is a fixed array, that no
 *      shell is reachable, and that a directory whose name contains regex
 *      metacharacters still matches exactly.
 *   4. A REAL `ps` IN A TEST. The answer would depend on what the maintainer
 *      had open, so a guard's expected value would move — which is not a
 *      guard. Every arm here injects a FAKE `execFile` through the deps seam,
 *      and §6 proves the real one is never reached by failing the injected
 *      call outright.
 *
 * The one-shot check against the REAL process table was taken by hand during
 * development and is recorded in the release row, not here.
 *
 * SAFETY — reads nothing of the user's, spawns nothing, writes nothing. The
 * `doctor` arm redirects user data to a mkdtemp through
 * `CURATOR_TEST_USER_DATA_DIR`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) => ok(a === b, `${label}${a === b ? '' : `\n        expected: ${JSON.stringify(b)}\n        actual:   ${JSON.stringify(a)}`}`);
const section = (t) => console.log(`\n${t}`);

const t0 = Date.now();

const B = await import(path.join(ROOT, 'src/brain/mcp-bridge-status.js'));

// ── The fake process table ─────────────────────────────────────────────────
//
// Byte-shaped like real `ps -axo pid=,lstart=,command=` output on macOS,
// including the leading column padding and the five-token `lstart`. Taken
// from the real listing on 2026-09-20 rather than invented, so the parser is
// exercised against the thing it has to read.
const SERVER = '/Applications/The Curator.app/Contents/Resources/app/mcp/server.js';
const NODE = '/Applications/The Curator.app/Contents/MacOS/The Curator';
const psRow = (pid, when, command) => `${String(pid).padStart(6)} ${when} ${command}`;
const REAL_TABLE = [
  psRow(29123, 'Fri Sep 18 10:10:34 2026', `${NODE} ${SERVER}`),
  psRow(97330, 'Sun Sep 20 08:54:17 2026', `${NODE} ${SERVER}`),
  psRow(1, 'Mon Sep  1 09:00:00 2026', '/sbin/launchd'),
  psRow(4242, 'Sun Sep 20 08:00:00 2026', '/usr/bin/node /somewhere/else/mcp/server.js'),
].join('\n') + '\n';

/** A fake `execFile` that answers `ps` with `stdout`, or fails with `err`. */
function fakePs({ stdout, err, spy }) {
  return (file, args, opts, cb) => {
    if (spy) spy.push({ file, args, opts });
    setImmediate(() => (err ? cb(new Error(err), '') : cb(null, stdout)));
  };
}

const CODE_AT = Date.parse('Sat Sep 19 13:48:42 2026');   // the .app's mtime
const NOW = Date.parse('Sun Sep 20 09:20:00 2026');

const baseDeps = {
  platform: 'darwin',
  serverPath: SERVER,
  serverMtimeMs: CODE_AT,
  packageMtimeMs: CODE_AT - 1000,
  now: NOW,
};

// ─────────────────────────────────────────────────────────────────────────
section('§1  The real table — one stale, one fresh, two irrelevant');
// ─────────────────────────────────────────────────────────────────────────
{
  const spy = [];
  const r = await B.detectBridgeProcesses({ ...baseDeps, execFile: fakePs({ stdout: REAL_TABLE, spy }) });
  eq(r.checked, true, 'the reading was taken');
  eq(r.reason, null, '…with no reason, because nothing refused');
  eq(r.running, 2, 'both bridges launched from THIS install are counted');
  eq(r.stale.length, 1, 'exactly one of them predates the code on disk');
  eq(r.stale[0].pid, 29123, '…and it is the 2026-09-18 one, by pid');
  eq(r.stale[0].startedAt, new Date(Date.parse('Fri Sep 18 10:10:34 2026')).toISOString(),
    '…with its start time, read as LOCAL time exactly as ps prints it');
  ok(r.stale[0].ageMs > 0 && r.stale[0].ageMs === NOW - Date.parse('Fri Sep 18 10:10:34 2026'),
    '…and an age measured against the injected clock, not the wall clock');
  eq(r.codeChangedAt, new Date(CODE_AT).toISOString(), 'the comparison point is disclosed');
  eq(r.serverPath, SERVER, '…and so is what was matched, so a report can show its work');

  // The OTHER install's `mcp/server.js` must not be counted: two checkouts on
  // one machine is an ordinary setup and the app ships --domains-path for it.
  ok(!REAL_TABLE.includes(SERVER.replace('/Applications', '/nope')), 'fixture control');
  const other = await B.detectBridgeProcesses({
    ...baseDeps, serverPath: '/somewhere/else/mcp/server.js',
    execFile: fakePs({ stdout: REAL_TABLE }),
  });
  eq(other.running, 1, 'a different install sees only ITS own bridge');
  eq(other.stale.length, 0, '…which is newer than its code, so nothing is stale');

  eq(spy.length, 1, 'ps was run exactly once');
  eq(spy[0].file, 'ps', '…as the program `ps`');
  eq(JSON.stringify(spy[0].args), JSON.stringify(['-axo', 'pid=,lstart=,command=']),
    '…with the fixed argv ARRAY — no shell, nothing interpolated');
  ok(spy[0].opts && spy[0].opts.timeout > 0, '…under a timeout, so a wedged ps cannot hang a route');
}

// ─────────────────────────────────────────────────────────────────────────
section('§2  The boundary — a bridge started AFTER the code is not stale');
// ─────────────────────────────────────────────────────────────────────────
{
  const at = 'Sat Sep 19 13:48:43 2026';   // one second after the mtime
  const table = psRow(555, at, `${NODE} ${SERVER}`) + '\n';
  const r = await B.detectBridgeProcesses({ ...baseDeps, execFile: fakePs({ stdout: table }) });
  eq(r.running, 1, 'it is counted as running');
  eq(r.stale.length, 0, '…and one second on the right side of the boundary is FRESH');

  const before = psRow(556, 'Sat Sep 19 13:48:41 2026', `${NODE} ${SERVER}`) + '\n';
  const r2 = await B.detectBridgeProcesses({ ...baseDeps, execFile: fakePs({ stdout: before }) });
  eq(r2.stale.length, 1, 'one second on the wrong side of it is STALE');

  // `package.json` alone moving is enough: a release that changes no MCP
  // source still bumps the version, and a bridge from before it is old code.
  const r3 = await B.detectBridgeProcesses({
    ...baseDeps, serverMtimeMs: CODE_AT - 86400_000, packageMtimeMs: CODE_AT,
    execFile: fakePs({ stdout: before }),
  });
  eq(r3.stale.length, 1, 'the NEWER of server.js and package.json is what counts');
  eq(r3.codeChangedAt, new Date(CODE_AT).toISOString(), '…and it is the one disclosed');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3  Every refusal answers `checked: false` with an EMPTY stale list');
// ─────────────────────────────────────────────────────────────────────────
{
  const arms = [
    ['a platform whose ps spelling is unmeasured',
      { ...baseDeps, platform: 'linux', execFile: fakePs({ stdout: REAL_TABLE }) }, 'linux'],
    ['ps missing or refusing',
      { ...baseDeps, execFile: fakePs({ err: 'spawn ps ENOENT' }) }, 'ENOENT'],
    ['neither file readable, so there is nothing to compare against',
      { ...baseDeps, serverMtimeMs: null, packageMtimeMs: null, execFile: fakePs({ stdout: REAL_TABLE }) }, 'package.json'],
  ];
  for (const [label, deps, needle] of arms) {
    const r = await B.detectBridgeProcesses(deps);
    eq(r.checked, false, `${label} → checked false`);
    eq(r.running, 0, '…running 0');
    eq(r.stale.length, 0, '…stale empty');
    ok(typeof r.reason === 'string' && r.reason.includes(needle),
      `…and a reason naming ${needle} (${JSON.stringify(r.reason)})`);
  }

  // An execFile that THROWS synchronously (a stubbed-out child_process in a
  // locked-down environment) must also refuse rather than reject.
  const thrown = await B.detectBridgeProcesses({
    ...baseDeps, execFile: () => { throw new Error('spawning is not permitted here'); },
  });
  eq(thrown.checked, false, 'a synchronous throw from execFile refuses rather than rejecting');
  ok(thrown.reason.includes('not permitted'), '…naming what happened');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4  The parser — junk in, nothing out');
// ─────────────────────────────────────────────────────────────────────────
{
  ok(B.parsePsRow('') === null, 'an empty line is not a process');
  ok(B.parsePsRow('  PID STARTED COMMAND') === null, 'a header row is not a process');
  ok(B.parsePsRow('   123 not a date at all /bin/thing') === null,
    'a row whose start time cannot be read is DROPPED, never reported with a guessed time');
  ok(B.parsePsRow('     0 Fri Sep 18 10:10:34 2026 /bin/x') === null, 'pid 0 is refused');
  const good = B.parsePsRow(psRow(42, 'Fri Sep 18 10:10:34 2026', '/bin/x --with args'));
  eq(good.pid, 42, 'a good row yields its pid');
  eq(good.command, '/bin/x --with args', '…and the whole command, spaces and all');

  const garbage = await B.detectBridgeProcesses({
    ...baseDeps, execFile: fakePs({ stdout: 'not\na ps\ntable at all\n' }),
  });
  eq(garbage.checked, true, 'an unparseable table is still a reading that was TAKEN');
  eq(garbage.running, 0, '…answering zero, because no row parsed');
}

// ─────────────────────────────────────────────────────────────────────────
section('§5  Matching is argument-bounded, and a path is never a pattern');
// ─────────────────────────────────────────────────────────────────────────
{
  const p = '/w/curator/mcp/server.js';
  ok(B.commandMatches(`/usr/bin/node ${p}`, p), 'the plain case matches');
  ok(B.commandMatches(p, p), '…and a command that IS the path matches');
  ok(B.commandMatches(`/usr/bin/node ${p} --domains-path /d`, p), '…and one with arguments after it');
  ok(!B.commandMatches('/usr/bin/node /w/curator-old/mcp/server.js', p),
    'a SIBLING checkout whose path merely contains ours does not match');
  ok(!B.commandMatches(`/usr/bin/node ${p}.bak`, p),
    '…nor a longer path that starts with ours');

  // A path with regex metacharacters in it. Built as a pattern, `.` and `+`
  // would match characters they must not; this is why the match is indexOf.
  const meta = '/Users/a.b/My+Apps (2)/mcp/server.js';
  ok(B.commandMatches(`/usr/bin/node ${meta}`, meta), 'a path full of regex metacharacters matches itself');
  ok(!B.commandMatches('/usr/bin/node /Users/axb/MyXApps X2X/mcp/server.js', meta),
    '…and does NOT match the string a regex built from it would have');

  // The whole module, read as source: no shell, no signal, no write.
  const src = await import('node:fs').then((fs) => fs.readFileSync(path.join(ROOT, 'src/brain/mcp-bridge-status.js'), 'utf8'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(code.includes('execFile'), 'the module does spawn something (the scan\'s own control)');
  // Asserted on the IMPORT rather than on a call-shaped regex: `re.exec(line)`
  // is an ordinary RegExp method and a pattern loose enough to catch a bare
  // `exec(` catches that too — a guard that reds for the wrong reason teaches
  // the next reader to loosen it. What can reach a shell is what was imported.
  const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
  eq(imports.join(','), 'execFile', 'the ONLY thing taken from child_process is execFile');
  ok(!/require\(['"](node:)?child_process['"]\)/.test(code), '…and nothing is required at runtime either');
  ok(!/\bshell\s*:/.test(code), 'no `shell:` option is passed anywhere');
  ok(!/execSync|spawnSync|\bspawn\b/.test(code), 'no synchronous or spawn-shaped call at all');
  ok(!/process\.kill|\.kill\(|SIGTERM|SIGKILL/.test(code), 'it never signals a process');
  ok(!/writeFile|appendFile|rmSync|mkdirSync|unlink/.test(code), 'it never writes anything');
}

// ─────────────────────────────────────────────────────────────────────────
section('§6  The route field — GET /api/mcp/config carries it, and its remedy');
// ─────────────────────────────────────────────────────────────────────────
{
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-stale-bridge-'));
  process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
  const routes = await import(path.join(ROOT, 'src/routes/mcp.js'));
  const router = routes.default;
  const layer = router.stack.find((l) => l.route && l.route.path === '/config');
  ok(!!layer, 'the /config route is registered');
  const handler = layer.route.stack[0].handle;
  const body = await new Promise((resolve) => { handler({}, { json: resolve }); });

  ok(Object.hasOwn(body, 'bridge_processes'), 'the payload carries bridge_processes');
  ok(body.bridge_processes && typeof body.bridge_processes.checked === 'boolean',
    '…with a boolean `checked`, so a consumer can tell "did not look" from "found none"');
  ok(Array.isArray(body.bridge_processes.stale), '…and an array `stale`');
  // AND IT IS THE REAL DETECTOR'S ANSWER, not a canned one. `serverPath` is a
  // fact only `detectBridgeProcesses` supplies — it is what was MATCHED — so
  // a handler that short-circuits to a clean bill of health reds here. Checked
  // platform-independently: a refusal carries it too.
  eq(body.bridge_processes.serverPath, path.join(ROOT, 'mcp', 'server.js'),
    '…and it names THIS install\'s own mcp/server.js, so the answer came from the detector');
  ok(Object.hasOwn(body.bridge_processes, 'codeChangedAt'),
    '…and discloses the comparison point (or null when it could not be read)');
  eq(body.bridge_stale_remedy, B.STALE_REMEDY,
    'the remedy SENTENCE rides on the payload — the view never authors a second copy');
  ok(/Restart the app that launched it/.test(B.STALE_REMEDY) && /Claude Desktop/.test(B.STALE_REMEDY),
    '…and it names the act and the usual actor');
  ok(!/restart The Curator/i.test(B.STALE_REMEDY),
    '…and NOT The Curator, which is exactly what does not help');

  // Every other field this route has always answered is still there: the
  // handler became async for this and an await in the wrong place would have
  // dropped the tail of the payload.
  for (const k of ['ok', 'mcp_server_path', 'domains_dir', 'installed', 'stale', 'mcp_launch_style']) {
    ok(Object.hasOwn(body, k), `…and the pre-existing field ${k} survived the handler going async`);
  }
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
  rmSync(TMP, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────
section('§7  The two notes on the bridge page');
// ─────────────────────────────────────────────────────────────────────────
{
  // The view is browser ESM with no bundler, so the derivation is lifted out
  // of the source and executed — the same technique test-next-ui-polish.js
  // uses for deriveMcpStatus, and for the same reason.
  const fs = await import('node:fs');
  const viewSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
  const start = viewSrc.indexOf('function deriveStaleBridgeNote(');
  ok(start !== -1, 'deriveStaleBridgeNote was found in the view');
  const end = viewSrc.indexOf('\n}\n', start) + 3;
  const body = viewSrc.slice(start, end);
  const make = new Function('formatAge', 'ageSecondsOf', `${body}; return deriveStaleBridgeNote;`);
  const { formatAge } = await import(path.join(ROOT, 'src/public/next/shared/age.js'));
  const derive = make(formatAge, (iso, now) => {
    const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
  });

  const REMEDY = B.STALE_REMEDY;
  eq(derive({}), null, 'a payload with no bridge_processes says NOTHING');
  eq(derive({ bridge_processes: { checked: false, reason: 'no ps here', stale: [] }, bridge_stale_remedy: REMEDY }), null,
    '`checked: false` says nothing — "we did not look" is never rendered as "there is none"');
  // …AND NOT EVEN WHEN A LIST COMES WITH IT. The detector never sends a stale
  // list it did not check, but a consumer that reads only the list is a
  // consumer that trusts the producer to be careful on its behalf — and this
  // one's whole job is to keep "did not look" out of the user's face.
  eq(derive({
    bridge_processes: { checked: false, reason: 'no ps here', running: 0, stale: [{ pid: 7, startedAt: '2026-09-18T08:10:34.000Z', ageMs: 5 }] },
    bridge_stale_remedy: REMEDY,
  }), null, '…even when `checked: false` arrives WITH a non-empty stale list');
  eq(derive({ bridge_processes: { checked: true, running: 2, stale: [] }, bridge_stale_remedy: REMEDY }), null,
    'two healthy bridges say nothing either');

  const one = derive({
    bridge_processes: { checked: true, running: 2, stale: [{ pid: 29123, startedAt: '2026-09-18T08:10:34.000Z', ageMs: 169862095 }] },
    bridge_stale_remedy: REMEDY,
  });
  ok(one && one.count === 1, 'one stale bridge produces a note');
  ok(/^One bridge process/.test(one.text), '…in the singular');
  // `formatAge`'s shared ladder FLOORS: 1.97 days reads "1 day ago". Asserted
  // as the ladder's answer rather than as a rounded number, because the same
  // ladder paints every age in the app and a second rounding rule here would
  // be a second vocabulary.
  eq(one.ageWords, '1 day ago', '…naming the age in the app\'s own words (the shared ladder, floored)');
  ok(one.text.includes('1 day ago'), '…and putting it in the sentence');
  ok(one.text.includes('an update to The Curator does not reach it'),
    '…and WHY an update did not fix it, which is the part a user would not guess');
  eq(one.remedy, REMEDY, '…with the remedy taken from the payload, verbatim');

  const many = derive({
    bridge_processes: { checked: true, running: 3, stale: [
      { pid: 1, startedAt: '2026-09-18T08:10:34.000Z', ageMs: 169862095 },
      { pid: 2, startedAt: '2026-09-19T08:10:34.000Z', ageMs: 83462095 },
    ] },
    bridge_stale_remedy: REMEDY,
  });
  ok(many && many.count === 2 && /^2 bridge processes/.test(many.text), 'two produce a plural note');
  ok(/They were launched/.test(many.text) && /does not reach them/.test(many.text),
    '…agreeing in number all the way through — one sentence in two voices reads as a bug');
  ok(/It was launched/.test(one.text) && /does not reach it/.test(one.text),
    '…and the singular does too (found by LOOKING at it in the browser, not by a test)');
  eq(many.ageWords, '1 day ago', '…and the OLDEST (2026-09-18, not the 09-19 one) is the age named');

  // An older server that carries the facts but not the sentence still reports
  // the FACT; the remedy is the payload's to supply and is never invented.
  const noRemedy = derive({ bridge_processes: { checked: true, running: 1, stale: [{ pid: 9, startedAt: '2026-09-18T08:10:34.000Z', ageMs: 1 }] } });
  ok(noRemedy && noRemedy.remedy === null, 'with no remedy on the payload, the view withholds one rather than writing its own');

  // And the view renders both places from THAT function — not from a second
  // reading of the payload.
  const uses = viewSrc.split('deriveStaleBridgeNote(').length - 1;
  ok(uses >= 3, `deriveStaleBridgeNote is the only reading, used at ${uses - 1} call sites plus its definition`);
  // BOTH SURFACES, BY THE SHAPE THEY HAVE SINCE v3.65.0. The claim is
  // unchanged — the fact is told in two places and both read the same
  // derivation — but neither is a hand-built note any more: the bridge status
  // card and the self-test result are both `renderMonitor()` calls now (M7/M8
  // and M9), and the note is a `loud` entry inside each. A `loud` entry is
  // built from a different array into a different container than a reading,
  // which is the component's own structural guarantee that a warning cannot be
  // demoted to one more line — the property `check-row check-warn` was
  // standing in for. The SELECTOR moved; the claim did not.
  const loudUses = viewSrc.split('loud:').length - 1;
  ok(loudUses >= 2,
    `the fact reaches TWO surfaces — ${loudUses} monitors on this view carry a \`loud\` entry `
    + '(the bridge status card, and the self-test result that qualifies its own pass)');
  ok(/loud:\s*bridgeNote\s*\n?\s*\?/.test(viewSrc) || /loud:\s*bridgeNote/.test(viewSrc),
    '…the status card\u2019s comes straight from deriveStaleBridgeNote\u2019s return');
  ok(/bridgeLoud/.test(viewSrc) && /const bridgeLoud = bridge/.test(viewSrc),
    '…and so does the self-test\u2019s, from the same function on the same payload');
  // THE REMEDY IS NEVER AUTHORED IN THE VIEW, and this is what says so.
  // The two assertions above prove both surfaces READ deriveStaleBridgeNote;
  // neither can tell whether the sentence handed to `strongText` came from its
  // `.remedy` or from a literal typed beside it. Found by mutation: replacing
  // `bridgeNote.remedy` with an invented sentence left this whole section
  // green, which is exactly the defect §6 exists to prevent one file over.
  const strongs = [...viewSrc.matchAll(/strongText:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  ok(strongs.length >= 1, `CONTROL: ${strongs.length} \`strongText\` value(s) found in the view `
    + '— zero would make the check below vacuous');
  ok(strongs.every((v) => /\bremedy\b/.test(v)),
    `every \`strongText\` in the view reads a \`remedy\` off the derivation, never a literal `
    + `(found: ${strongs.join(' | ')})`);
  ok(!viewSrc.includes(B.STALE_REMEDY),
    'and the route\u2019s own sentence appears NOWHERE in the view\u2019s source — a second copy that '
    + 'happened to be correct today is a second copy that goes stale tomorrow');

  const handNotes = viewSrc.split('settings-mcp-stale-note').length - 1;
  ok(handNotes === 1,
    `CONTROL: exactly ${handNotes} hand-built stale NOTE is left in this view (was 2). The one that `
    + 'survives is the saved-config / self-test RECONCILIATION note, which is not about bridge '
    + 'processes at all; the bridge-process note stopped being a second card under the status card '
    + 'and became a `loud` entry inside it');
  ok(!/bridge_processes/.test(viewSrc.replace(/function deriveStaleBridgeNote[\s\S]*?\n}\n/, '')),
    'nothing outside the derivation reads bridge_processes directly');
}

// ─────────────────────────────────────────────────────────────────────────
section('§8  `my-curator doctor` reports it, and still exits 0');
// ─────────────────────────────────────────────────────────────────────────
{
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-stale-doctor-'));
  mkdirSync(path.join(TMP, 'home'), { recursive: true });
  mkdirSync(path.join(TMP, 'work'), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/curator.js'), 'doctor', '--json'], {
    cwd: path.join(TMP, 'work'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(TMP, 'home'),
      CURATOR_TEST_USER_DATA_DIR: TMP,
      CURATOR_TEST_DOMAINS_DIR: path.join(TMP, 'domains'),
    },
  });
  eq(r.status, 0, 'doctor exits 0');
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
  ok(!!j, 'its --json output parses');
  ok(j && Object.hasOwn(j, 'bridgeProcesses'), '…and carries bridgeProcesses');
  ok(j && j.bridgeProcesses && typeof j.bridgeProcesses.checked === 'boolean',
    '…with the same three-state shape the route uses');

  const text = spawnSync(process.execPath, [path.join(ROOT, 'bin/curator.js'), 'doctor'], {
    cwd: path.join(TMP, 'work'),
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(TMP, 'home'), CURATOR_TEST_USER_DATA_DIR: TMP, CURATOR_TEST_DOMAINS_DIR: path.join(TMP, 'domains') },
  });
  eq(text.status, 0, 'and the human rendering exits 0 too');
  ok(/BRIDGE PROCESSES/.test(text.stdout), '…with a BRIDGE PROCESSES section');
  ok(!/undefined|NaN|\[object Object\]/.test(text.stdout), '…and nothing unrendered in it');
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓' : '✗'} test-mcp-stale-bridge: ${passed} passed, ${failed} failed  (${Date.now() - t0} ms)`);
process.exit(failed === 0 ? 0 : 1);
