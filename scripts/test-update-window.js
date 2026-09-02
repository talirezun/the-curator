/**
 * test-update-window.js — OFFLINE guard for the menu-bar updater window:
 * `desktop/lib/update-window.js` (the decisions) and
 * `src/public/next/views/update-window.js` (the page).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE REPORT THIS FEATURE ANSWERS, AND THE ONE THING THAT MUST NOT HAPPEN  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * v3.40.0 was the first update the maintainer installed in place. From the menu
 * bar: Check for Updates… → an update is available → Update → NOTHING VISIBLE
 * until the app restarted. From Settings, the same update draws a five-phase
 * ring. This release gives the menu path a small window that draws the SAME
 * ring, from the same job record.
 *
 * The failure this suite exists to prevent is the OPPOSITE one: a progress
 * window appearing for an update that is not happening. "You're up to date"
 * must not open a window; neither must "you're ahead", "we couldn't check",
 * "an update is already running", the no-engine build that opens a browser, or
 * the source checkout that is sent to Settings. §1 drives that from REAL
 * `describeUpdate()` payloads rather than from hand-written action objects,
 * because the actions are what `main.js` dispatches on and the payloads are
 * what really produce them.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  the modules load, and the names main.js will import are pinned
 *   §1  the window opens on Update and on NOTHING else
 *   §2  the window's geometry, its page, and the two titles agreeing
 *   §3  the Dock bar — 0..1, indeterminate, cleared, and throttled
 *   §4  the restart notification: once, at the swap, never on a failure
 *   §5  nothing here can break an update
 *   §6  ONE phase vocabulary, imported by both surfaces
 *   §7  the page renders only what the route sent
 *   §8  the page's traffic: one GET, no POST, no apply, no cancel
 *   §9  the progress sink survives a stream chopped one byte at a time
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - `desktop/main.js` IS NOT EXECUTED, here or anywhere: Electron is
 *    deliberately not an offline dependency. NO BrowserWindow HAS EVER BEEN
 *    CREATED FROM THIS SPEC, `setProgressBar` has never been called, and no
 *    Notification has ever been posted. Every Electron capability is injected
 *    and driven with a recording fake. §0 pins the export NAMES main.js will
 *    import — the v3.33.0 technique, after a hook rename silently did not land
 *    and nothing noticed — but a wiring line inside main.js can only ever be
 *    read, not run.
 *  - NO HTTP SERVER RUNS IN THIS SUITE. The route's response shape is
 *    transcribed from `src/routes/config.js` and §8 pins the URL to its
 *    `router.get()` registration; the HTML is read as text, never parsed by a
 *    browser. What HAS happened once, by hand and outside this file, is that
 *    the page was loaded in a real browser at 380x140 against a throwaway
 *    static server answering the one endpoint with a canned job — five states
 *    photographed in both themes, no console errors, and the real ring, the
 *    real byte line and the window-specific `installing` sentence all drawn.
 *    That was a person looking at it once; it is not a check, and nothing here
 *    re-runs it.
 *  - `Notification.isSupported()` is never consulted here. Whether macOS shows
 *    the banner, and whether the process survives long enough for it to be
 *    drawn, are both outside anything this suite can reach.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      expected ${b}\n      got      ${a}`); }
}
function section(t) { console.log(`\n${t}`); }
function read(rel) { return readFileSync(path.join(ROOT, rel), 'utf8'); }

/** Comments stripped so a line of PROSE about a rule can never satisfy the
 *  rule. Same helper, same reason, as test-desktop-menu-install.js. */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Visible text only — attributes stripped. The ring puts its label in BOTH a
 *  visible span and the svg's `aria-label`, so a raw substring count reports 2
 *  for a headline drawn once. What a person sees is the tags removed. */
function visibleText(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const win = await import(path.join(ROOT, 'desktop/lib/update-window.js'));
const client = await import(path.join(ROOT, 'desktop/lib/update-client.js'));
const verdict = await import(path.join(ROOT, 'desktop/lib/update-verdict.js'));
const page = await import(path.join(ROOT, 'src/public/next/views/update-window.js'));
const phases = await import(path.join(ROOT, 'src/public/next/shared/update-phases.js'));

// ═══════════════════════════════════════════════════════════════════════════
section('§0 the modules load, and the names main.js will import are pinned');
// ═══════════════════════════════════════════════════════════════════════════
// TRANSCRIBED AS LITERALS, never read back out of the module under test — a
// name read from the thing it names agrees with itself by construction. This
// is the v3.33.0 technique, and it caught a real one there: a rename from an
// earlier draft's hook names silently did not land, and the whole feature
// would have refused at runtime with nothing red.
//
// `desktop/main.js` is not owned by this change and cannot be executed anyway,
// so its wiring line is unguarded until it is applied. What CAN be guaranteed
// from here is that the names it will import exist and are callable.
for (const name of ['createUpdateWindow', 'shouldOpenUpdateWindow', 'updateWindowSpec',
  'dockProgressFor', 'restartNotice']) {
  ok(typeof win[name] === 'function', `desktop/lib/update-window.js exports ${name}()`);
}
for (const name of ['UPDATE_WINDOW_PATH', 'UPDATE_WINDOW_WIDTH', 'UPDATE_WINDOW_HEIGHT',
  'UPDATE_WINDOW_TITLE', 'DOCK_CLEAR', 'DOCK_INDETERMINATE']) {
  ok(win[name] !== undefined, `…and the constant ${name}`);
}
for (const name of ['nextUpdateView', 'updateWindowModel', 'renderUpdateWindow',
  'startUpdateWindow', 'mountUpdateWindow']) {
  ok(typeof page[name] === 'function', `views/update-window.js exports ${name}()`);
}
// The page module is browser ESM and this suite is Node: importing it at all
// proves it touches no DOM at module scope. A `document.getElementById` outside
// a function would have thrown above rather than reaching here.
ok(true, 'the page module imports in Node — nothing at module scope touches the DOM');

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the window opens on Update and on NOTHING else');
// ═══════════════════════════════════════════════════════════════════════════
// Driven from REAL describeUpdate() payloads. A hand-written `{type:'install'}`
// would prove the mapping and not the reachability — and the failure that
// matters is a window over an update that is not happening.

const INSTALLER = {
  current: '3.40.0', latest: '3.41.0', updateAvailable: true, updateStyle: 'download-installer',
  comparable: true, localAhead: false, noInstallableRelease: false, prerelease: true,
  releaseUrl: 'https://github.com/x/y/releases/tag/v3.41.0',
  releasesPageUrl: 'https://github.com/x/y/releases', releaseName: 'v3.41.0',
};
const CASES = [
  ['install         (an update, and this build can install it)', INSTALLER, { attached: true }, true],
  ['install-staged  (already downloaded; only the swap is left)', INSTALLER, { attached: true, jobState: 'staged', jobVersion: '3.41.0' }, true],
  ['install-running (somebody already started one)', INSTALLER, { attached: true, jobState: 'running' }, false],
  ['available       (no engine — the update happens in a browser)', INSTALLER, { attached: false }, false],
  ['available       (the probe did not answer at all)', INSTALLER, { attached: null }, false],
  ['current         ("You’re up to date")', { ...INSTALLER, updateAvailable: false }, { attached: true }, false],
  ['local-ahead     (newer than anything published)', { ...INSTALLER, updateAvailable: false, localAhead: true }, { attached: true }, false],
  ['no-release      (nothing installable published yet)', { ...INSTALLER, updateAvailable: false, noInstallableRelease: true }, { attached: true }, false],
  ['unknown-version (the versions cannot be compared)', { ...INSTALLER, comparable: false }, { attached: true }, false],
  ['error           (the check itself failed)', { error: 'GitHub could not be reached.' }, { attached: true }, false],
  ['git-pull        (a source checkout — sent to Settings)', { current: '3.40.0', latest: '3.41.0', updateAvailable: true }, { attached: true }, false],
];
const kinds = new Set();
for (const [label, payload, installer, expectWindow] of CASES) {
  const v = verdict.describeUpdate(payload, installer);
  kinds.add(v.kind);
  eq(win.shouldOpenUpdateWindow(v.action), expectWindow,
    `${label} → ${expectWindow ? 'OPENS' : 'opens NO'} window (kind "${v.kind}", action ${v.action ? v.action.type : 'none'})`);
}
// ANTI-VACUITY: if the cases above collapsed onto three kinds the sweep would
// look thorough and prove almost nothing.
ok(kinds.size >= 8, `the sweep really did reach ${kinds.size} distinct verdict kinds`);
ok(kinds.has('install') && kinds.has('current') && kinds.has('available'),
  'CONTROL: including the three that matter most — the one that opens it and two that must not');
// And the decision is on the ACTION, so garbage cannot open a window either.
for (const junk of [null, undefined, {}, { type: 'install ' }, { type: 'INSTALL' }, 'install', 42, []]) {
  ok(win.shouldOpenUpdateWindow(junk) === false,
    `a malformed action (${JSON.stringify(junk)}) opens no window — the fail-safe direction`);
}

// The controller is what main.js actually calls, so drive IT, not just the
// predicate. §13 of test-update-in-app.js records why: a function driven
// directly and never reached from its call site is this repo's own shape.
{
  const opened = [];
  const c = win.createUpdateWindow({ openWindow: (spec) => { opened.push(spec); return { id: 1 }; } });
  eq(c.open('http://127.0.0.1:3333', { type: 'open-url', url: 'https://x' }), false,
    'CALL SITE: the controller refuses to open for an open-url action');
  eq(opened.length, 0, '…and really created nothing');
  eq(c.open('http://127.0.0.1:3333', { type: 'install' }), true, 'CALL SITE: and opens for an install');
  eq(opened.length, 1, '…creating exactly one window');
  eq(c.open('http://127.0.0.1:3333', { type: 'install' }), true,
    'a SECOND open is idempotent — runMenuInstall is a loop, and two windows for one job is the defect');
  eq(opened.length, 1, '…still exactly one window');
}
{
  // A dep that hands back nothing is a capability that is not there.
  const c = win.createUpdateWindow({ openWindow: () => null });
  eq(c.open('http://127.0.0.1:3333', { type: 'install' }), false,
    'an openWindow that returns null leaves the controller with no window rather than a phantom handle');
  eq(c.state().open, false, '…and it says so');
}
{
  const c = win.createUpdateWindow({ openWindow: () => ({ id: 1 }) });
  eq(c.open('', { type: 'install' }), false, 'no base URL ⇒ no window, rather than one loading "undefined/…"');
  eq(c.open(null, { type: 'install' }), false, '…and the same for null');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the window\'s geometry, its page, and the two titles agreeing');
// ═══════════════════════════════════════════════════════════════════════════
const spec = win.updateWindowSpec('http://127.0.0.1:3333');
eq(spec.url, 'http://127.0.0.1:3333/next/update-window.html', 'the spec loads the page from this app\'s own server');
eq(spec.width, 380, 'the window is 380 points wide');
eq(spec.height, 140, '…and 140 tall');
eq(spec.resizable, false, 'it cannot be resized — there is nothing to reveal');
eq(spec.maximizable, false, '…nor maximised');
eq(spec.fullscreenable, false, '…nor made fullscreen');
eq(spec.show, false, 'and it opens hidden, so nobody sees an empty rectangle');
ok(!Object.hasOwn(spec, 'webPreferences'),
  'it declares NO webPreferences — the page needs nothing from the shell, so it gets Electron\'s safe defaults');
ok(!Object.hasOwn(spec, 'parent'),
  'and no parent window — the menu is reachable with no window at all, which is the case this exists for');
eq(win.updateWindowSpec(undefined), null, 'an unusable base URL yields NO spec rather than a broken one');

// THE PAGE REALLY EXISTS. `src/server.js`'s static mount answers any request
// that names a file; a path that did not exist would fall through to the SPA
// catch-all and load the whole application in a 380-point window.
const htmlPath = 'src/public/next' + win.UPDATE_WINDOW_PATH.replace(/^\/next/, '');
ok(existsSync(path.join(ROOT, htmlPath)), `UPDATE_WINDOW_PATH resolves to a real file on disk (${htmlPath})`);
const html = read(htmlPath);
const titleTag = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
eq(titleTag, win.UPDATE_WINDOW_TITLE,
  'the page\'s <title> is byte-identical to UPDATE_WINDOW_TITLE — the document title is what macOS shows once it loads, so a disagreement is a window that renames itself half a second in');
eq(win.UPDATE_WINDOW_TITLE, 'Software Update',
  'and it is the same title the two update DIALOGS carry — one operation, one name');
ok(read('desktop/main.js').includes("title: 'Software Update'"),
  'CROSS-FILE: main.js\'s showUpdateDialog really does use that same title');

// Every asset reference is root-absolute, the rule next/index.html follows.
{
  const refs = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  ok(refs.length >= 6, `the page references ${refs.length} local assets`);
  const bad = refs.filter((r) => !/^https?:\/\//.test(r) && !r.startsWith('/'));
  eq(bad, [], 'every one of them is root-absolute — a relative ref would 200 with the SPA shell rather than 404');
  for (const r of refs) {
    if (/^https?:\/\//.test(r)) continue;
    ok(existsSync(path.join(ROOT, 'src/public', r.replace(/^\//, ''))), `…and ${r} exists on disk`);
  }
  ok(refs.includes('/next/shared/progress-ring.css'),
    'REGRESSION GUARD: the ring\'s stylesheet is linked — v3.9.0 shipped the ring written, correct and never <link>ed, and it rendered as an invisible black dot for a whole release');
}
// The page adds NO new stylesheet file, deliberately: test-css-tokens.js §9
// walks the /next tree and reports any .css that next/index.html cannot reach,
// and a window-only stylesheet would be exactly that.
ok(!existsSync(path.join(ROOT, 'src/public/next/views/update-window.css')),
  'the window ships no stylesheet of its own — its twenty rules are inline, so test-css-tokens §9 has nothing to exempt');

// ═══════════════════════════════════════════════════════════════════════════
section('§3 the Dock bar — 0..1, indeterminate, cleared, and throttled');
// ═══════════════════════════════════════════════════════════════════════════
eq(win.dockProgressFor({ phase: 'downloading', percent: 0 }), 0, 'a download at 0% is 0, a real value');
eq(win.dockProgressFor({ phase: 'downloading', percent: 42.6 }), 0.43, '43% of the way down is 0.43');
eq(win.dockProgressFor({ phase: 'downloading', percent: 100 }), 1, 'and a finished download is 1');
eq(win.dockProgressFor({ phase: 'downloading', percent: 140 }), 1, 'an impossible percent is clamped, never passed through');
eq(win.dockProgressFor({ phase: 'downloading', percent: -5 }), 0, '…in both directions');
eq(win.dockProgressFor({ phase: 'downloading', percent: null, receivedBytes: 61000000 }), win.DOCK_INDETERMINATE,
  'an UNKNOWN total is INDETERMINATE, never a bar pinned at the far left — percent null is a different fact from 0, and the route sends null on purpose');
for (const phase of ['resolving', 'verifying', 'staging']) {
  eq(win.dockProgressFor({ phase }), win.DOCK_INDETERMINATE,
    `"${phase}" has no sub-progress to report, so the bar says "working" rather than inventing a proportion`);
}
eq(win.dockProgressFor({ phase: 'installing' }), win.DOCK_CLEAR,
  'INSTALLING CLEARS THE BAR — nothing measurable is left and this process is about to be replaced, and a bar frozen on the icon of an app that has gone is an artefact nobody can dismiss');
eq(win.dockProgressFor({ phase: 'who-knows' }), win.DOCK_CLEAR, 'an unrecognised phase clears it rather than drawing something it cannot describe');
eq(win.dockProgressFor(null), win.DOCK_CLEAR, 'and so does nothing at all');
ok(win.DOCK_CLEAR < 0, 'CONTROL: DOCK_CLEAR is below 0, which is what Electron reads as "remove the bar"');
ok(win.DOCK_INDETERMINATE > 1, 'CONTROL: DOCK_INDETERMINATE is above 1, which is what Electron reads as indeterminate');

// THE THROTTLE IS A MEASUREMENT. 550 records is what a 140 MB download really
// produces at the engine's 256 KB reporting interval.
{
  const writes = [];
  const c = win.createUpdateWindow({
    openWindow: () => ({ id: 1 }),
    setDockProgress: (_h, v) => writes.push(v),
  });
  c.open('http://127.0.0.1:3333', { type: 'install' });
  const total = 143165576;
  for (let i = 1; i <= 550; i++) {
    const received = Math.min(total, i * 262144);
    c.progress({ phase: 'downloading', receivedBytes: received, totalBytes: total, percent: (received / total) * 100 });
  }
  ok(writes.length <= 101 && writes.length >= 50,
    `550 real progress records produced ${writes.length} Dock writes, not 550 — whole-percent quantisation is what makes the throttle real`);
  ok(writes.every((v) => v >= 0 && v <= 1), 'every value written is inside Electron\'s valid 0..1 range');
  const sorted = writes.every((v, i) => i === 0 || v >= writes[i - 1]);
  ok(sorted, 'and they only ever go up — a bar that goes backwards is worse than no bar');
  eq(c.state().dockWrites, writes.length, 'the controller\'s own count agrees with what the fake recorded');

  // The same 550 records with NO total: one indeterminate write, not 550.
  const w2 = [];
  const c2 = win.createUpdateWindow({ openWindow: () => ({ id: 1 }), setDockProgress: (_h, v) => w2.push(v) });
  c2.open('http://127.0.0.1:3333', { type: 'install' });
  for (let i = 1; i <= 550; i++) c2.progress({ phase: 'downloading', receivedBytes: i * 262144, totalBytes: null, percent: null });
  eq(w2, [win.DOCK_INDETERMINATE], 'a download with no declared size writes the indeterminate value ONCE and then says nothing more');
}
{
  // No window ⇒ no Dock bar. The bar belongs to a BrowserWindow; without one
  // there is nothing to set it on, and setting it on a window we do not have
  // is how a crash gets into an update path.
  const writes = [];
  const c = win.createUpdateWindow({ openWindow: () => null, setDockProgress: (_h, v) => writes.push(v) });
  c.open('http://127.0.0.1:3333', { type: 'install' });
  c.progress({ phase: 'downloading', percent: 50 });
  eq(writes, [], 'with no window open, nothing is written to the Dock at all');
}
{
  // finish() clears, on both outcomes, and BYPASSES the throttle.
  const writes = [];
  const closed = [];
  const mk = () => {
    const c = win.createUpdateWindow({
      openWindow: () => ({ id: 1 }),
      setDockProgress: (_h, v) => writes.push(v),
      closeWindow: (h) => closed.push(h),
    });
    c.open('http://127.0.0.1:3333', { type: 'install' });
    return c;
  };
  const a = mk();
  a.progress({ phase: 'downloading', percent: 43 });
  a.finish({ ok: false, error: 'The download stopped.' });
  eq(writes, [0.43, win.DOCK_CLEAR], 'A FAILED DOWNLOAD CLEARS THE DOCK BAR — leaving it at 43% claims a transfer that has stopped is still going');
  eq(closed.length, 1, '…and closes the window, because the failure dialog is what speaks now');

  writes.length = 0; closed.length = 0;
  const b = mk();
  b.progress({ phase: 'installing' });
  b.finish({ ok: true, installing: true, version: '3.41.0' });
  eq(writes, [win.DOCK_CLEAR, win.DOCK_CLEAR],
    'on SUCCESS the bar is cleared twice — once by the installing phase and once by finish(), which bypasses the throttle so a clear can never be skipped as "already clear"');
  eq(closed.length, 0,
    'and the window is LEFT OPEN saying "Installing" — the process is being replaced anyway, and blanking the screen at the moment the user is watching for confirmation is worse than nothing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 the restart notification: once, at the swap, never on a failure');
// ═══════════════════════════════════════════════════════════════════════════
{
  const notes = [];
  const c = win.createUpdateWindow({ openWindow: () => ({ id: 1 }), notify: (n) => notes.push(n) });
  c.open('http://127.0.0.1:3333', { type: 'install' });
  c.progress({ phase: 'resolving' });
  for (let i = 0; i < 50; i++) c.progress({ phase: 'downloading', percent: i * 2 });
  c.progress({ phase: 'verifying' });
  c.progress({ phase: 'staging' });
  eq(notes.length, 0, 'nothing is announced while the update is merely running');
  c.progress({ phase: 'installing', version: '3.41.0' });
  eq(notes.length, 1, 'the notification fires at the swap — the last moment this process is reliably alive');
  ok(/3\.41\.0/.test(notes[0].body), `…and it names the version being installed (${JSON.stringify(notes[0].body)})`);
  ok(/restart/i.test(notes[0].title) || /restart/i.test(notes[0].body), '…and says the app is restarting');
  c.progress({ phase: 'installing', version: '3.41.0' });
  c.progress({ phase: 'installing', version: '3.41.0' });
  eq(notes.length, 1, 'and it fires ONCE, however many installing records arrive');
}
{
  const notes = [];
  const c = win.createUpdateWindow({ openWindow: () => ({ id: 1 }), notify: (n) => notes.push(n) });
  c.open('http://127.0.0.1:3333', { type: 'install' });
  c.progress({ phase: 'downloading', percent: 61 });
  c.finish({ ok: false, staged: false, error: 'The download did not match the published checksum.' });
  eq(notes, [], 'A FAILURE ANNOUNCES NOTHING — a banner saying "restarting" beside a dialog saying it did not install is the two-surfaces contradiction this whole area is a case study in');
}
{
  const notes = [];
  const c = win.createUpdateWindow({ openWindow: () => ({ id: 1 }), notify: (n) => notes.push(n) });
  c.open('http://127.0.0.1:3333', { type: 'install' });
  c.progress({ phase: 'installing' });
  eq(notes.length, 1, 'with no version known (an apply-only run saw no staged event) it still fires');
  ok(!/\bv?null\b|undefined|\bv\b/.test(notes[0].body),
    `…and never renders "v", "vnull" or "undefined" (${JSON.stringify(notes[0].body)})`);
}
{
  // CONTROL: the notice function itself, so the above is not the only thing
  // that could report a change here.
  const withV = win.restartNotice('3.41.0');
  const without = win.restartNotice(null);
  ok(withV.body !== without.body, 'CONTROL: restartNotice really says something different when it knows the version');
  eq(win.restartNotice('  ').body, without.body, 'a blank version is treated as no version, not as an empty one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 nothing here can break an update');
// ═══════════════════════════════════════════════════════════════════════════
// A cosmetic surface must never be able to fail an update. This is the rule
// `runInstall` already applies to its own label callback ("the menu is not
// load-bearing"), extended to four Electron calls.
{
  const boom = () => { throw new Error('Electron said no'); };
  const c = win.createUpdateWindow({ openWindow: boom, setDockProgress: boom, closeWindow: boom, notify: boom });
  let threw = null;
  try {
    c.open('http://127.0.0.1:3333', { type: 'install' });
    c.progress({ phase: 'downloading', percent: 12 });
    c.progress({ phase: 'installing', version: '3.41.0' });
    c.finish({ ok: false, error: 'x' });
  } catch (err) { threw = err; }
  ok(threw === null, 'every dep can throw and the controller still returns normally');
}
{
  const c = win.createUpdateWindow();
  let threw = null;
  try {
    c.open('http://127.0.0.1:3333', { type: 'install' });
    c.progress({ phase: 'downloading', percent: 12 });
    c.finish({ ok: true });
  } catch (err) { threw = err; }
  ok(threw === null, 'and with NO deps at all — a platform with no Dock and no Notification loses the display, not the update');
}
{
  const c = win.createUpdateWindow({ openWindow: () => ({ id: 1 }), setDockProgress: () => {}, notify: () => {} });
  c.open('http://127.0.0.1:3333', { type: 'install' });
  let threw = null;
  try { c.progress(null); c.progress('nonsense'); c.progress(42); c.finish(null); } catch (err) { threw = err; }
  ok(threw === null, 'and malformed records are absorbed rather than thrown');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 ONE phase vocabulary, imported by both surfaces');
// ═══════════════════════════════════════════════════════════════════════════
// SOURCE-LEVEL: both files import the module. BEHAVIOURAL: the strings the two
// surfaces actually render are the same object's. Neither alone is enough —
// an import can be present and unused, and identical output can come from two
// identical copies that are free to drift tomorrow.
{
  const settingsSrc = stripJsComments(read('src/public/next/views/settings.js'));
  const pageSrc = stripJsComments(read('src/public/next/views/update-window.js'));
  ok(/from\s*'\.\.\/shared\/update-phases\.js'/.test(settingsSrc),
    'SOURCE: views/settings.js imports shared/update-phases.js');
  ok(/from\s*'\.\.\/shared\/update-phases\.js'/.test(pageSrc),
    'SOURCE: and so does views/update-window.js');
  ok(!/UPDATE_PHASE_COPY\s*=/.test(settingsSrc), 'SOURCE: settings.js defines no phase table of its own');
  ok(!/UPDATE_PHASE_COPY\s*=/.test(pageSrc), 'SOURCE: nor does the window page');
  ok(!/UPDATE_RING_STAGES\s*=\s*\[/.test(pageSrc), 'SOURCE: nor its own ring segment names');
}
{
  // BEHAVIOURAL: every phase's headline reaches the window page's rendered
  // HTML, character for character as the shared table has it.
  for (const phase of phases.UPDATE_PHASE_ORDER) {
    const model = page.updateWindowModel({ kind: 'running', job: { phase, state: 'running' } });
    eq(model.headline, phases.UPDATE_PHASE_COPY[phase].headline,
      `BEHAVIOURAL: the window's "${phase}" headline IS the shared table's`);
    const text = visibleText(page.renderUpdateWindow(model, 0));
    ok(text.includes(phases.UPDATE_PHASE_COPY[phase].headline),
      `…and it reaches the rendered HTML (${JSON.stringify(text.slice(0, 60))}…)`);
  }
  // THE ONE OVERRIDE, and its boundary. Anything outside {installing} would be
  // an unmarked second copy of a sentence.
  eq(Object.keys(phases.UPDATE_WINDOW_BODY), ['installing'],
    'EXACTLY ONE phase\'s body differs by surface, and it is `installing`');
  for (const phase of phases.UPDATE_PHASE_ORDER) {
    if (phase === 'installing') continue;
    eq(phases.phaseCopy(phase, 'window').body, phases.phaseCopy(phase, 'panel').body,
      `"${phase}" reads identically on both surfaces`);
  }
  ok(/reloads itself/.test(phases.phaseCopy('installing', 'panel').body),
    'the PANEL\'s installing body promises the page reloads itself — which Settings really does');
  ok(!/reloads itself/.test(phases.phaseCopy('installing', 'window').body),
    'THE WINDOW\'S DOES NOT, and that is the whole reason the override exists: this window is a child of the process being replaced, so it disappears rather than reloading');
  ok(/restart/i.test(phases.phaseCopy('installing', 'window').body),
    '…while still saying the thing that IS true — the app restarts on its own');
  // TOTALITY, both surfaces.
  for (const surface of ['panel', 'window']) {
    for (const bad of [null, undefined, 'nonsense', 42]) {
      const c = phases.phaseCopy(bad, surface);
      ok(typeof c.headline === 'string' && c.headline.length > 0 && typeof c.body === 'string' && c.body.length > 0,
        `phaseCopy(${JSON.stringify(bad)}, '${surface}') falls back to a real sentence rather than undefined`);
    }
  }
  eq(phases.phaseCopy('resolving', 'window'), phases.phaseCopy(null, 'window'),
    'and the fallback is `resolving` — the first phase, not a blank');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the page renders only what the route sent');
// ═══════════════════════════════════════════════════════════════════════════
const FRESH = { kind: 'starting', job: null, failure: null, seenInstalling: false, misses: 0, done: false };
const answer = (job) => ({ ok: true, body: { ok: true, updaterAttached: true, job } });

{
  // THE TRANSITION, not just the model. A mutation making the no-job branch of
  // `nextUpdateView` return `{kind:'running', job:{phase:'resolving'}}` came
  // back GREEN against the model assertions below, because they were fed a
  // hand-built view and never went through the transition that produces one —
  // this repo's recorded "driven directly, call site never asserted" shape
  // (v3.26.0 M6). So the answer the route really sends before the shell's POST
  // has landed — `{ok:true, job:null}` — is fed in here, and the whole chain
  // is asserted through to the rendered text.
  const v = page.nextUpdateView(FRESH, answer(null));
  eq(v.kind, 'starting', 'a real answer carrying job:null keeps the page in "starting"');
  eq(v.job, null, '…with no job record invented for it');
  const text = visibleText(page.renderUpdateWindow(page.updateWindowModel(v), 0));
  ok(!text.includes(phases.UPDATE_PHASE_COPY.resolving.body),
    'and the RENDERED TEXT does not carry the `resolving` sentence — "finding the download for the new version" would be a claim about work the route has not reported');
  ok(text.includes('Waiting for The Curator to begin'),
    '…it says what is actually true: the window opened before the update did');
  // CONTROL: the same chain DOES reach the resolving sentence once the route
  // really reports that phase, so the assertion above is about the absence of
  // a claim rather than about the sentence being unreachable.
  const started = page.nextUpdateView(FRESH, answer({ state: 'running', phase: 'resolving' }));
  ok(visibleText(page.renderUpdateWindow(page.updateWindowModel(started), 0))
    .includes(phases.UPDATE_PHASE_COPY.resolving.body),
    'CONTROL: once the route DOES report resolving, that sentence is what the window draws');
}
{
  // The pre-job state is NOT `resolving`. The route has sent nothing yet, and
  // "we are finding the download" would be a claim about work nobody reported.
  const m = page.updateWindowModel(FRESH);
  eq(m.kind, 'starting', 'before the shell\'s POST has created a job record the page says "starting"');
  ok(!/Finding the download/.test(m.body),
    '…and NOT the `resolving` sentence, which would claim work the route has not reported');
  eq(m.ring.stageProgress, 0, 'its ring shows no fill at all — the first segment is the floor of the scale, not a claim');
  eq(m.ring.stage, 0, '…on the first segment');
}
{
  // The honesty rule, inherited: only `downloading` with a real percent fills.
  for (const phase of ['resolving', 'verifying', 'staging', 'installing']) {
    const m = page.updateWindowModel({ kind: 'running', job: { phase, percent: 87 } });
    eq(m.ring.stageProgress, 0,
      `"${phase}" reports no sub-progress, so its segment stays EMPTY even with a percent present`);
  }
  const dl = page.updateWindowModel({ kind: 'running', job: { phase: 'downloading', percent: 50, receivedBytes: 5, totalBytes: 10 } });
  eq(dl.ring.stageProgress, 0.5, 'CONTROL: a real download percent does fill its segment, so the rule above is not vacuous');
}
{
  // The byte line is the route's three cases, unchanged.
  const both = page.updateWindowModel({ kind: 'running', job: { phase: 'downloading', receivedBytes: 61000000, totalBytes: 143165576, percent: 42.6 } });
  eq(both.ring.sublabel, '58.2 MB of 137 MB · 43%', 'both byte counts known ⇒ the full line');
  const unknown = page.updateWindowModel({ kind: 'running', job: { phase: 'downloading', receivedBytes: 61000000, totalBytes: null, percent: null } });
  eq(unknown.ring.sublabel, '58.2 MB downloaded · total size unknown',
    'an unknown total says so, rather than showing a percentage it does not have');
  const none = page.updateWindowModel({ kind: 'running', job: { phase: 'downloading' } });
  eq(none.ring.sublabel, '', 'nothing reported ⇒ NO line, rather than a reassuring "0 MB of 0 MB"');
}
{
  // THE HEADLINE IS DRAWN EXACTLY ONCE, in every state. A 380-point window
  // that prints the phase twice is the shape this layout is one conditional
  // away from.
  const states = [
    ['starting', FRESH],
    ['running', page.nextUpdateView(FRESH, answer({ state: 'running', phase: 'downloading', receivedBytes: 1, totalBytes: 2, percent: 50 }))],
    ['failed', page.nextUpdateView(FRESH, answer({ state: 'failed', reason: 'digest-mismatch', error: 'The download did not match the published checksum.', hint: 'Try again.' }))],
  ];
  for (const [name, view] of states) {
    const m = page.updateWindowModel(view);
    const text = visibleText(page.renderUpdateWindow(m, 0));
    const n = text.split(m.headline).length - 1;
    eq(n, 1, `"${name}": the headline "${m.headline}" appears exactly once in the visible text`);
  }
}
{
  // ESCAPING. The failure sentence is written by the server and arrives over
  // HTTP; it is escaped exactly as settings.js escapes the same field.
  const hostile = '<img src=x onerror="alert(1)"> & "quoted" \'single\'';
  const v = page.nextUpdateView(FRESH, answer({ state: 'failed', error: hostile, hint: hostile }));
  const out = page.renderUpdateWindow(page.updateWindowModel(v), 0);
  ok(!out.includes('<img'), 'a hostile failure sentence cannot inject a tag');
  ok(!out.includes('onerror="'), '…nor an attribute');
  ok(out.includes('&lt;img'), '…it is escaped and shown as text');
  ok(out.includes('&amp;') && out.includes('&quot;') && out.includes('&#39;'),
    '…along with the ampersand and both quote forms');
}
{
  // THE REASON CODE IS NEVER RENDERED — a slug beside a sentence is an
  // internal identifier shown to a person, the v3.31.0 defect the whole in-app
  // updater exists to undo.
  const v = page.nextUpdateView(FRESH, answer({ state: 'failed', reason: 'digest-mismatch', error: 'The download did not match.', hint: null }));
  const out = page.renderUpdateWindow(page.updateWindowModel(v), 0);
  ok(!out.includes('digest-mismatch'), 'the failure REASON code never reaches the page');
  ok(out.includes('The download did not match'), 'CONTROL: the server\'s sentence does');
}
{
  // An unknown phase draws the fallback rather than a blank, and no number is
  // invented for it.
  const m = page.updateWindowModel({ kind: 'running', job: { phase: 'teleporting', percent: 99 } });
  ok(m.headline.length > 0 && m.body.length > 0, 'an unrecognised phase still produces a real sentence');
  eq(m.ring.stageProgress, 0, '…and claims no progress for it');
  eq(m.ring.sublabel, '', '…and no byte line');
}
{
  // THE TWO CONNECTION STATES. `lost` must not claim the update failed, and
  // the SUCCESS case must not be reported as `lost`.
  let v = FRESH;
  for (let i = 0; i < 2; i++) v = page.nextUpdateView(v, { ok: false, body: null });
  eq(v.kind, 'starting', 'one or two missed polls are ordinary and change nothing');
  ok(v.done !== true, '…and the polling carries on');
  v = page.nextUpdateView(v, { ok: false, body: null });
  eq(v.kind, 'lost', `after ${page.LOST_AFTER_MISSES} consecutive misses the page says it lost contact`);
  eq(v.done, true, '…and stops polling, because it has nothing further to learn');
  const lost = page.updateWindowModel(v);
  ok(!/failed|didn’t finish|did not finish/i.test(lost.body),
    'and it makes NO claim about the update — it lost sight of the job, which is not the same as the job failing');
  ok(/may still be running/i.test(lost.body), '…it says exactly that');

  // Once `installing` has been seen, a dead server IS the success case.
  let s = page.nextUpdateView(FRESH, answer({ state: 'applying', phase: 'installing' }));
  eq(s.seenInstalling, true, 'the page remembers having seen the swap begin');
  s = page.nextUpdateView(s, { ok: false, body: null });
  eq(s.kind, 'running', 'and a server that then stops answering is the app being REPLACED, not a failure');
  eq(s.done, true, '…so it stops polling there');
  ok(/restart/i.test(page.updateWindowModel(s).body), '…still showing the installing sentence');
  // ANTI-VACUITY: the same network event, without that memory, is `lost`.
  ok(page.nextUpdateView({ ...FRESH, misses: 2 }, { ok: false, body: null }).kind === 'lost',
    'CONTROL: the identical unanswered poll IS reported as lost when the swap had not begun — the two are told apart by the phase, and nothing else');
}
{
  // A terminal state is terminal.
  const done = { kind: 'failed', job: null, failure: { error: 'x' }, seenInstalling: false, misses: 0, done: true };
  eq(page.nextUpdateView(done, answer({ state: 'running', phase: 'downloading' })), done,
    'once failed, a later answer cannot walk the page back into a progress display');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 the page\'s traffic: one GET, no POST, no apply, no cancel');
// ═══════════════════════════════════════════════════════════════════════════
// THE HEADLINE ASSERTION OF THIS FILE, and it is traffic rather than text —
// the same instruction v3.36.0 recorded, because the defect it was fixing WAS
// a correct-looking string describing behaviour that did not exist.
{
  const requests = [];
  const jobs = [
    { state: 'running', phase: 'resolving' },
    { state: 'running', phase: 'downloading', receivedBytes: 1000, totalBytes: 2000, percent: 50 },
    { state: 'running', phase: 'verifying' },
    { state: 'staged', phase: 'staging', version: '3.41.0' },
    { state: 'applying', phase: 'installing', version: '3.41.0' },
  ];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    requests.push({ url, method: (opts && opts.method) || 'GET' });
    const job = jobs[Math.min(i++, jobs.length - 1)];
    return { json: async () => ({ ok: true, updaterAttached: true, job }) };
  };
  const drawn = [];
  // A synchronous scheduler: the loop runs to its terminal state in one tick
  // rather than over real seconds.
  const pending = [];
  const handle = page.startUpdateWindow({
    fetchImpl,
    setHtml: (h) => drawn.push(h),
    schedule: (fn) => { pending.push(fn); return pending.length; },
    cancel: () => {},
  });
  // Drain: let the in-flight poll settle, then release the next one it
  // scheduled. A fixed number of turns rather than a `while (pending.length)`
  // — the loop must survive the terminal state, where nothing further is ever
  // scheduled, without hanging the suite.
  for (let n = 0; n < 15; n++) {
    await new Promise((r) => setImmediate(r));
    const fn = pending.shift();
    if (fn) fn();
  }
  await new Promise((r) => setImmediate(r));
  handle.stop();

  ok(requests.length >= 5, `the page issued ${requests.length} requests`);
  eq([...new Set(requests.map((r) => r.method))], ['GET'], 'EVERY ONE OF THEM IS A GET');
  eq([...new Set(requests.map((r) => r.url))], [page.PROGRESS_URL],
    'and every one is the read-only progress endpoint — the page starts nothing and finishes nothing');
  ok(drawn.length >= 5, `and it repainted ${drawn.length} times`);
  ok(drawn.some((h) => /Downloading/.test(visibleText(h))), 'drawing the downloading phase along the way');
  ok(drawn.some((h) => /Installing/.test(visibleText(h))), '…and the installing one');
}
{
  // SOURCE SCAN, as the second half. The traffic assertion above proves what
  // the shipped code does on one path; this proves no other path exists.
  const src = stripJsComments(read('src/public/next/views/update-window.js'));
  ok(!/['"]POST['"]/.test(src), 'the page module contains no POST anywhere');
  ok(!/update\/apply/.test(src), '…no reference to the apply endpoint');
  ok(!/\/api\/config\/update['"`]/.test(src), '…and none to the staging endpoint that starts a download');
  ok(!/EventSource|text\/event-stream/.test(src), '…it does not open the SSE stream either — that would be a second download');
  const occurrences = (src.match(/\/api\/config\/update-progress/g) || []).length;
  eq(occurrences, 1, 'the one endpoint it does name appears exactly once, as a constant');
  const htmlSrc = read('src/public/next/update-window.html');
  ok(!/POST/.test(htmlSrc), 'and the page itself carries no POST in its bootstrap');
  ok(!/<button|<form/.test(htmlSrc), '…and no button and no form: there is nothing here to click');
}
{
  // CROSS-FILE: the URL is a route that really exists.
  const routeSrc = read('src/routes/config.js');
  const registered = page.PROGRESS_URL.replace('/api/config', '');
  ok(routeSrc.includes(`router.get('${registered}'`),
    `PROGRESS_URL resolves to a route REALLY REGISTERED in src/routes/config.js (router.get('${registered}'…))`);
  ok(client.UPDATE_PROGRESS_PATH === page.PROGRESS_URL,
    'and it is the same path the shell\'s own probe uses — one endpoint, three readers');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 the progress sink survives a stream chopped one byte at a time');
// ═══════════════════════════════════════════════════════════════════════════
// The v3.36.0 pattern. The interesting failure is a frame split across two
// network reads, which is invisible to a test that feeds one whole string —
// and the new `onProgress` sink rides the same path the menu label does.
{
  const frames = [
    'event: progress\ndata: {"type":"progress","phase":"resolving"}\n\n',
    'event: progress\ndata: {"type":"progress","phase":"downloading","receivedBytes":1048576,"totalBytes":143165576,"percent":0.73}\n\n',
    'event: progress\ndata: {"type":"progress","phase":"downloading","receivedBytes":71582788,"totalBytes":143165576,"percent":50}\n\n',
    'event: progress\ndata: {"type":"progress","phase":"verifying"}\n\n',
    'event: staged\ndata: {"type":"staged","version":"3.41.0","prerelease":false,"warning":null}\n\n',
  ].join('');

  const run = async (chunkSize) => {
    const seen = [];
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < frames.length; i += chunkSize) c.enqueue(enc.encode(frames.slice(i, i + chunkSize)));
        c.close();
      },
    });
    const fetchImpl = async (url, opts) => {
      if ((opts && opts.method) === 'POST' && url.endsWith('/api/config/update')) {
        return { ok: true, body, status: 200 };
      }
      // The apply. Rejecting IS the success signal — the process is going away.
      throw new Error('socket closed: the app is being replaced');
    };
    const out = await client.runInstall('http://127.0.0.1:3333', {
      onProgress: (job) => seen.push(job),
    }, { fetchImpl });
    return { seen, out };
  };

  const whole = await run(frames.length);
  const byByte = await run(1);
  ok(whole.out.ok === true, 'the whole-stream run installs');
  ok(byByte.out.ok === true, 'and so does the one-byte-at-a-time run');
  eq(JSON.stringify(byByte.seen), JSON.stringify(whole.seen),
    'THE SINK SEES AN IDENTICAL SEQUENCE either way — a frame split across reads changes nothing');
  eq(whole.seen.length, 6, 'six records: the resolving transition, four from the stream, and the installing transition');
  eq(whole.seen[0].phase, 'resolving', 'the first is the resolving transition the client pushes before it POSTs');
  eq(whole.seen[whole.seen.length - 1].phase, 'installing', 'and the last is the installing transition, pushed before the apply');
  eq(whole.seen[whole.seen.length - 1].version, '3.41.0',
    'THE VERSION RIDES ON THE INSTALLING RECORD — learnt from the stream\'s staged event, so the notification does not need a second copy of it');

  // AND THE SINK IS UNTHROTTLED WHILE THE LABEL IS NOT. Two policies, on
  // purpose: the label carries whole percent and rebuilds a menu; the sink is
  // a raw feed whose consumer decides what "changed" means.
  const labels = [];
  const records = [];
  const enc = new TextEncoder();
  let frames2 = '';
  for (let i = 0; i < 40; i++) {
    // Twenty distinct percents, each sent twice — the label must collapse the
    // repeats and the sink must not.
    const pct = Math.floor(i / 2) * 5;
    frames2 += `event: progress\ndata: {"type":"progress","phase":"downloading","receivedBytes":${pct * 100},"totalBytes":10000,"percent":${pct}}\n\n`;
  }
  frames2 += 'event: staged\ndata: {"type":"staged","version":"3.41.0"}\n\n';
  const body2 = new ReadableStream({ start(c) { c.enqueue(enc.encode(frames2)); c.close(); } });
  await client.runInstall('http://127.0.0.1:3333', {
    onLabel: (l) => labels.push(l),
    onProgress: (j) => records.push(j),
  }, {
    fetchImpl: async (url, opts) => {
      if ((opts && opts.method) === 'POST' && url.endsWith('/api/config/update')) return { ok: true, body: body2, status: 200 };
      throw new Error('replaced');
    },
  });
  eq(records.length, 42, 'the SINK received every record — 40 from the stream plus the two transitions');
  ok(labels.length <= 23 && labels.length >= 20,
    `the LABEL fired ${labels.length} times, collapsing the repeated percents — the two throttles are genuinely different`);
  ok(labels.length < records.length, 'CONTROL: and the label really is the quieter of the two');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ the updater window is not doing what it says');
  process.exit(1);
}
console.log('✅ the menu-bar update shows its work, and the window that shows it starts nothing');
