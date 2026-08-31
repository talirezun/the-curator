/**
 * test-desktop-menu.js — OFFLINE guard for the macOS application menu.
 *
 * Covers `desktop/lib/menu.js`, `desktop/lib/update-verdict.js` and
 * `desktop/lib/update-check.js`, plus a labelled-weak source scan of the
 * wiring in `desktop/main.js`.
 *
 * ── METHOD, AND WHY IT IS NOT A GREP ────────────────────────────────────────
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js`
 * cannot be imported, evaluated or run here. That is exactly why the menu was
 * built as PLAIN DATA: `Menu.buildFromTemplate` consumes ordinary objects, so
 * §1–§6 IMPORT the real builder and inspect the real template — every label,
 * accelerator, role, ordering and enabled-state decision is executed, not
 * asserted about. §7–§9 do the same for the update verdict and the fetcher.
 * Only §11 is a scan, and it says so in its own heading.
 *
 * This follows the precedent already set by `lib/quit-decision.js` and
 * `lib/app-version.js`: the provable part moves out of main.js, and what
 * remains in main.js is named rather than pretended about.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  positive control on the imports themselves
 *   §1  the macOS menu: what exists, and where
 *   §2  ACCELERATOR COLLISIONS — including the role-implied ones
 *   §3  the in-flight state drives the item's label and enabled flag
 *   §4  a missing handler is refused at BUILD time, not at click time
 *   §5  the non-macOS arm still has Quit, Settings and the update check
 *   §6  the Edit roles that make ⌘C/⌘V work at all
 *   §7  describeUpdate — six kinds, one per documented server state
 *   §8  THE SHELL DOES NOT COMPARE VERSIONS (behavioural + source)
 *   §9  fetchUpdateCheck — including a real-network tripwire
 *   §10 cross-file couplings, read-only
 *   §11 main.js source scan, and what is NOT enforced
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - NOTHING HERE PROVES THE MENU APPEARS. Electron is not installed, no app
 *    was launched, and `Menu.buildFromTemplate` has never seen this template.
 *    A role name that Electron rejects, or an accelerator string it cannot
 *    parse, would pass every assertion below and fail at runtime.
 *  - §2's role→accelerator table is TRANSCRIBED from Electron's documented
 *    macOS defaults, not measured from a running Electron. It is a guard
 *    against a collision this project has already written once (⌘0, caught
 *    before commit), not a claim about what Electron actually binds.
 *  - §10's tripwire proves `data-view="settings"` is still EMITTED by
 *    src/public/next/app.js. It cannot prove the element renders, is visible,
 *    or that clicking it navigates — only a real renderer can. main.js checks
 *    the click's return value at runtime for exactly that reason.
 *  - The Help URLs are asserted to be well-formed and to point at this
 *    repository. They are not fetched: an offline suite must not make a
 *    network call. Both were verified by hand once, at 200.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }
function read(p) { return readFileSync(p, 'utf8'); }

/**
 * LINE COMMENTS FIRST. The order is load-bearing and this repo has the scar:
 * a `//` comment naming a glob path contains `/*`, so a block-comment pass run
 * first opens a comment there and eats hundreds of lines — turning every
 * `!/.../.test()` into a scan over an empty string, which passes everything.
 * Copied deliberately rather than imported: test-desktop-packaging.js is
 * another agent's file this wave, and a shared helper is a shared blast radius.
 */
function stripJsComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const noop = () => {};
const HANDLERS = {
  onCheckForUpdates: noop,
  onOpenSettings: noop,
  onRevealWindow: noop,
  onOpenUrl: noop,
  onShowLogs: noop,
};

let menu, verdict, updateCheck;
try {
  menu = await import(path.join(DESKTOP, 'lib', 'menu.js'));
  verdict = await import(path.join(DESKTOP, 'lib', 'update-verdict.js'));
  updateCheck = await import(path.join(DESKTOP, 'lib', 'update-check.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the desktop menu modules: ${err.message}`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control — the modules really loaded');
// Without this, a botched export would make every later section compare
// against `undefined` and quietly agree with itself.
ok(typeof menu.buildMenuTemplate === 'function', 'buildMenuTemplate is a function');
ok(typeof menu.flattenMenu === 'function', 'flattenMenu is a function');
ok(typeof verdict.describeUpdate === 'function', 'describeUpdate is a function');
ok(typeof updateCheck.fetchUpdateCheck === 'function', 'fetchUpdateCheck is a function');

const mac = menu.buildMenuTemplate({ platform: 'darwin', ...HANDLERS });
const macFlat = menu.flattenMenu(mac);
const labels = macFlat.map((i) => i.label).filter(Boolean);
ok(macFlat.length > 25, `CONTROL — the flattened template has real content (${macFlat.length} nodes)`);
// Deliberately NOT 'Check for Updates…', which several later assertions are
// about: a control that reds when its own subject is deleted is not
// independent of it. 'Speech' is two levels deep and nothing else asserts on
// it, so it proves the walker recurses without being coupled to the feature.
ok(labels.includes('Speech'), 'CONTROL — flattenMenu recurses into a submenu nested inside a submenu');

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the macOS menu: what exists, and where');

eq(mac.map((m) => m.label), ['The Curator', 'Edit', 'View', 'Window', 'Help'],
   'five top-level menus, in the platform-conventional order');

ok(!mac.some((m) => m.label === 'File'),
   'there is NO File menu — the app has no documents, and a File menu whose only member closes a window is the empty shell the default menu already was');

{
  // THE THING THE MAINTAINER REPORTED AS MISSING. Its POSITION is the point:
  // directly under About is where every Mac app since Sparkle has put it, and
  // it is the first place a user looks.
  const appSub = mac[0].submenu.map((i) => i.label || i.role || i.type);
  const iAbout = appSub.indexOf('About The Curator');
  const iCheck = appSub.indexOf('Check for Updates…');
  const iSettings = appSub.indexOf('Settings…');
  const iQuit = appSub.indexOf('Quit The Curator');
  ok(iAbout === 0, 'About is the first item in the application menu');
  ok(iCheck > iAbout, 'Check for Updates… exists and sits below About');
  ok(iCheck - iAbout <= 2, 'Check for Updates… is directly under About (one separator between them), not buried');
  ok(iSettings > iCheck, 'Settings… sits below Check for Updates…');
  ok(iQuit === appSub.length - 1, 'Quit is the last item');
}

{
  const settings = macFlat.find((i) => i.id === menu.ID_SETTINGS);
  ok(!!settings, 'Settings… carries a stable id, so nothing has to match on its label');
  eq(settings.accelerator, 'Command+,', 'Settings… claims ⌘, — the shortcut a Mac user presses without looking');
  ok(typeof settings.click === 'function', 'Settings… has a click handler');
}

{
  // Not `app.exit()` by hand. The `quit` role goes through Electron's normal
  // shutdown, which is what fires `before-quit` — and before-quit is where
  // main.js asks whether a paid, multi-minute ingest is in flight.
  const quit = mac[0].submenu.find((i) => i.role === 'quit');
  ok(!!quit, 'Quit uses the `quit` ROLE, so it routes through before-quit and the write-status guard rather than around it');
  ok(!macFlat.some((i) => /exit|destroy/i.test(String(i.label || ''))),
     'nothing in the menu offers a hard exit that would skip the quit guard');
}

{
  // THE ITEM THE DEFAULT MENU DID NOT HAVE. macOS's window list cannot show a
  // HIDDEN window, and hidden is what ⌘W leaves behind (main.js's close
  // handler). Without this the only route back is an undiscoverable Dock click.
  const winSub = mac.find((m) => m.label === 'Window').submenu;
  const reveal = winSub.find((i) => i.id === menu.ID_REVEAL_WINDOW);
  ok(!!reveal, 'the Window menu has an explicit item that reveals the main window');
  ok(typeof reveal.click === 'function', 'and it is wired to a handler — the default menu had NOTHING that creates or reveals a window');
  ok(winSub.some((i) => i.role === 'close'), 'Close Window (⌘W) lives in the Window menu, since there is no File menu');
}

{
  const help = mac.find((m) => m.role === 'help');
  ok(!!help, 'the Help menu declares role:help, so macOS adds its search field');
  const urls = [menu.HELP_URL, menu.RELEASES_URL];
  for (const u of urls) {
    ok(/^https:\/\/github\.com\/talirezun\/the-curator(\/|$)/.test(u),
       `Help destination points at this repository and nowhere else: ${u}`);
  }
  ok(menu.HELP_URL.endsWith('/docs/user-guide.md'),
     'the user guide link names a file that exists in this repo (docs/user-guide.md)');
  ok(help.submenu.some((i) => i.id === menu.ID_SHOW_LOGS),
     'Help ▸ Show Logs exists — the app grew its own log file in v3.29.0 and until now nothing shipped could open it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 accelerator collisions, INCLUDING the ones a role implies');
// ═══════════════════════════════════════════════════════════════════════════
// THIS SECTION EXISTS BECAUSE THE FIRST DRAFT HAD A COLLISION. The Window
// menu's reveal item claimed `Command+0`, which `role: 'resetZoom'` in the
// View menu already owns. Two items on one accelerator is undefined behaviour
// wearing a feature's clothes, and no amount of reading the template shows it
// — the second accelerator is INVISIBLE, hidden inside a role name.
//
// The table is TRANSCRIBED from Electron's documented macOS defaults. It is a
// collision guard, not a claim about what Electron binds at runtime.
const MAC_ROLE_ACCELERATORS = {
  undo: 'Command+Z',
  redo: 'Shift+Command+Z',
  cut: 'Command+X',
  copy: 'Command+C',
  paste: 'Command+V',
  pasteAndMatchStyle: 'Command+Option+Shift+V',
  selectAll: 'Command+A',
  reload: 'Command+R',
  forceReload: 'Shift+Command+R',
  toggleDevTools: 'Option+Command+I',
  resetZoom: 'Command+0',
  zoomIn: 'Command+Plus',
  zoomOut: 'Command+-',
  togglefullscreen: 'Control+Command+F',
  minimize: 'Command+M',
  close: 'Command+W',
  quit: 'Command+Q',
  hide: 'Command+H',
  hideOthers: 'Command+Option+H',
};

{
  const claims = new Map(); // accelerator -> [labels]
  for (const item of macFlat) {
    if (item.type === 'separator') continue;
    const acc = item.accelerator || (item.role ? MAC_ROLE_ACCELERATORS[item.role] : null);
    if (!acc) continue;
    if (!claims.has(acc)) claims.set(acc, []);
    claims.get(acc).push(item.path);
  }
  const collisions = [...claims.entries()].filter(([, who]) => who.length > 1);
  ok(collisions.length === 0,
     `no accelerator is claimed twice across the whole menu (${claims.size} accelerators in use)` +
     (collisions.length ? ` — COLLIDING: ${collisions.map(([a, w]) => `${a} → ${w.join(' AND ')}`).join('; ')}` : ''));

  // ANTI-VACUITY. If the map above were empty the assertion would pass for the
  // wrong reason, and this is precisely the shape that goes green on a deleted
  // menu.
  ok(claims.size >= 15, `CONTROL — the collision check actually had accelerators to compare (${claims.size})`);
  ok(claims.has('Command+,') && claims.has('Command+W') && claims.has('Command+0'),
     'CONTROL — both explicit and role-implied accelerators reached the collision map');

  // POSITIVE CONTROL: plant the exact bug that was written and caught.
  const planted = [...macFlat, { path: 'planted', accelerator: 'Command+0' }];
  const pClaims = new Map();
  for (const item of planted) {
    if (item.type === 'separator') continue;
    const acc = item.accelerator || (item.role ? MAC_ROLE_ACCELERATORS[item.role] : null);
    if (!acc) continue;
    if (!pClaims.has(acc)) pClaims.set(acc, []);
    pClaims.get(acc).push(item.path);
  }
  ok([...pClaims.values()].some((w) => w.length > 1),
     'CONTROL — re-planting the ⌘0 collision that was actually written makes this detector FIRE');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 the in-flight state drives the item, so the menu IS the progress indicator');

{
  const idle = menu.flattenMenu(menu.buildMenuTemplate({ platform: 'darwin', checking: false, ...HANDLERS }))
    .find((i) => i.id === menu.ID_CHECK_FOR_UPDATES);
  const busy = menu.flattenMenu(menu.buildMenuTemplate({ platform: 'darwin', checking: true, ...HANDLERS }))
    .find((i) => i.id === menu.ID_CHECK_FOR_UPDATES);

  eq(idle.label, menu.CHECK_LABEL_IDLE, 'idle: the item reads "Check for Updates…"');
  eq(idle.enabled, true, 'idle: the item is enabled');
  eq(busy.label, menu.CHECK_LABEL_BUSY, 'in flight: the item reads "Checking for Updates…"');
  eq(busy.enabled, false, 'in flight: the item is DISABLED, so a second click cannot stack a second dialog');
  ok(menu.CHECK_LABEL_IDLE !== menu.CHECK_LABEL_BUSY,
     'the two labels genuinely differ — the check is a live network call with a 12s ceiling, and an item that looked unchanged for ten seconds is the defect being avoided');
  ok(menu.CHECK_LABEL_IDLE.endsWith('…'),
     'the idle label ends in an ellipsis — the macOS convention promising a dialog, which is what this item shows');

  const all = menu.flattenMenu(menu.buildMenuTemplate({ platform: 'darwin', ...HANDLERS }))
    .filter((i) => i.id === menu.ID_CHECK_FOR_UPDATES);
  ok(all.length === 1, 'exactly ONE item checks for updates — not one per menu');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 a missing handler is refused at BUILD time, not at click time');
// A menu item wired to `undefined` throws when the USER clicks it — in front
// of them, weeks later, in a packaged build with no console.
for (const missing of Object.keys(HANDLERS)) {
  const partial = { ...HANDLERS };
  delete partial[missing];
  let threw = false;
  try { menu.buildMenuTemplate({ platform: 'darwin', ...partial }); } catch { threw = true; }
  ok(threw, `omitting ${missing} is refused by the builder`);
}
{
  let threw = false;
  try { menu.buildMenuTemplate({ platform: 'darwin', ...HANDLERS, onShowLogs: 'not a function' }); } catch { threw = true; }
  ok(threw, 'a non-function handler is refused too, not silently installed');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the non-macOS arm still has Quit, Settings and the update check');
// The packaged app is macOS-only today, but this shell runs from a checkout
// anywhere, and a menu missing Quit would be worse than the default it replaced.
{
  const win = menu.buildMenuTemplate({ platform: 'win32', ...HANDLERS });
  const flat = menu.flattenMenu(win);
  ok(!win.some((m) => m.label === 'The Curator'), 'no macOS application menu on Windows');
  ok(flat.some((i) => i.role === 'quit'), 'Quit is reachable');
  ok(flat.some((i) => i.id === menu.ID_SETTINGS), 'Settings is reachable');
  ok(flat.some((i) => i.id === menu.ID_CHECK_FOR_UPDATES), 'Check for Updates is reachable');
  const settings = flat.find((i) => i.id === menu.ID_SETTINGS);
  ok(!settings.accelerator, '⌘, is NOT claimed off macOS — it is an Apple convention and means nothing there');
  ok(!flat.some((i) => i.role === 'pasteAndMatchStyle' || i.role === 'startSpeaking'),
     'macOS-only Edit roles are absent, so Electron is never handed a role it rejects on that platform');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the Edit roles that make ⌘C/⌘V work at all');
// This is FUNCTION, not decoration. Replacing the default menu without these
// roles removes the clipboard accelerators from the renderer — including the
// API-key fields, where pasting a key is the first thing anyone does.
for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
  ok(macFlat.some((i) => i.role === role), `Edit provides the \`${role}\` role`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 describeUpdate — six kinds, one per state the ROUTE documents');
// ═══════════════════════════════════════════════════════════════════════════
// The payload shapes below are transcribed from src/routes/config.js's
// installerUpdateCheck() and its git arm — the fields each one actually puts
// on the wire, not a shape invented here.
const D = verdict.describeUpdate;
{
  const cases = [
    ['error', { error: 'GitHub is rate-limiting update checks from this network.', reason: 'rate-limited', current: '3.30.0', updateStyle: 'download-installer' }],
    ['no-release', { current: '3.30.0', latest: null, noInstallableRelease: true, comparable: false, updateAvailable: false, localAhead: false, updateStyle: 'download-installer', releasesPageUrl: 'https://github.com/talirezun/the-curator/releases' }],
    ['unknown-version', { current: '3.30.0', latest: 'nightly', comparable: false, noInstallableRelease: false, updateAvailable: false, localAhead: false, updateStyle: 'download-installer', releaseName: 'Nightly', releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/nightly' }],
    ['local-ahead', { current: '3.31.0', latest: '3.30.0', comparable: true, updateAvailable: false, localAhead: true, noInstallableRelease: false, updateStyle: 'download-installer' }],
    ['available', { current: '3.29.0', latest: '3.30.0', comparable: true, updateAvailable: true, localAhead: false, noInstallableRelease: false, updateStyle: 'download-installer', prerelease: true, releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0', releasesPageUrl: 'https://github.com/talirezun/the-curator/releases' }],
    ['current', { current: '3.30.0', latest: '3.30.0', comparable: true, updateAvailable: false, localAhead: false, noInstallableRelease: false, updateStyle: 'download-installer' }],
  ];
  const seenMessages = new Set();
  for (const [expected, payload] of cases) {
    const v = D(payload);
    eq(v.kind, expected, `installer payload → kind "${expected}"`);
    ok(typeof v.message === 'string' && v.message.length > 0, `  ${expected}: has a headline`);
    ok(typeof v.detail === 'string' && v.detail.length > 0, `  ${expected}: has a detail body`);
    ok(Array.isArray(v.buttons) && v.buttons.length >= 1, `  ${expected}: has at least one button`);
    ok(v.cancelId === verdict.DISMISS_ID, `  ${expected}: button 0 is the dismissive one (same convention as the quit dialog)`);
    ok(v.defaultId < v.buttons.length, `  ${expected}: defaultId indexes a button that exists`);
    ok(!v.action || v.buttons.length > verdict.ACTION_ID,
       `  ${expected}: an action always has a button to trigger it`);
    seenMessages.add(v.message);
  }
  ok(seenMessages.size === cases.length,
     `all six headlines are DISTINCT — "up to date", "nothing published yet" and "cannot compare" are three different facts and never share wording (${seenMessages.size}/${cases.length})`);
}

{
  // The error sentence is the SERVER's, verbatim. Four failure sentences are
  // already authored in classifyReleaseFailure(); re-writing them here would be
  // four more strings to keep true, and they are the four that matter most.
  const sentence = 'GitHub answered 503 when asked for the release list. Try again later.';
  const v = D({ error: sentence, current: '3.30.0', updateStyle: 'download-installer' });
  ok(v.detail === sentence, "the route's own failure sentence is passed through verbatim, not re-authored");
  ok(v.type === 'error', 'a failed check renders as an error dialog, not an info one');
}

{
  // The update dialog is the ONE whose default is the action — the user asked
  // "is there an update", the answer is yes, and opening a page is not
  // destructive. Every other dialog defaults to dismiss.
  const availBase = { current: '3.29.0', latest: '3.30.0', comparable: true, updateAvailable: true, updateStyle: 'download-installer', releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0' };
  const avail = D({ ...availBase, prerelease: true });
  eq(avail.defaultId, verdict.ACTION_ID, 'available: the DEFAULT button is Download — one keystroke to the thing the user came for');
  eq(avail.action, { type: 'open-url', url: 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0' },
     'available: the action opens the RELEASE page the route chose, not a hardcoded listing');
  ok(/pre-release/i.test(avail.detail), 'available: a pre-release is disclosed rather than hidden — the Mac app is an unsigned preview today');
  // The other half, so the assertion above is not satisfiable by a sentence
  // that is always present regardless of what the payload said.
  ok(!/pre-release/i.test(D({ ...availBase, prerelease: false }).detail),
     'CONTROL — and a NON-pre-release update does not carry the pre-release sentence, so the disclosure tracks the payload');
  ok(/does not install updates by itself/i.test(avail.detail),
     'available: the dialog says plainly that this build does not auto-install — auto-update needs a signed, notarized app and is deferred');

  for (const [kind, payload] of [
    ['current', { current: '3.30.0', latest: '3.30.0', comparable: true, updateAvailable: false, updateStyle: 'download-installer' }],
    ['local-ahead', { current: '3.31.0', latest: '3.30.0', comparable: true, updateAvailable: false, localAhead: true, updateStyle: 'download-installer' }],
    ['error', { error: 'nope', updateStyle: 'download-installer' }],
  ]) {
    ok(D(payload).defaultId === verdict.DISMISS_ID, `${kind}: defaults to dismiss, never to opening something`);
  }
}

{
  // A URL that is not https never becomes an action. The route builds these,
  // but a payload is still remote input.
  const v = D({ current: '3.29.0', latest: '3.30.0', comparable: true, updateAvailable: true, updateStyle: 'download-installer', releaseUrl: 'javascript:alert(1)', releasesPageUrl: 'http://example.com' });
  ok(!v.action || /^https:\/\//.test(v.action.url),
     'a non-https URL in the payload never reaches shell.openExternal — it falls back to the https literal');
}

{
  // The git-pull arm — a source checkout, i.e. `npm start` or this shell run
  // from source. It must NOT offer to apply the update: POST /api/config/update
  // runs `git reset --hard` on the checkout, and settings.js already gates that
  // behind a confirm dialog explaining what it replaces.
  const g = D({ current: '3.29.0', latest: '3.30.0', updateAvailable: true, localAhead: false, localCommit: 'aaa', remoteCommit: 'bbb' });
  eq(g.style, 'git-pull', 'a payload with no updateStyle is treated as git-pull, exactly as settings.js decides it');
  eq(g.kind, 'available', 'git-pull: an available update is reported');
  eq(g.action, { type: 'open-settings' }, 'git-pull: the action opens Settings rather than applying anything');
  ok(!/Download/.test(g.buttons.join(' ')), 'git-pull: no Download button — there is no installer on that path');
  ok(/Settings/.test(g.detail), 'git-pull: the detail names where the destructive update actually lives');

  const gAhead = D({ current: '3.31.0', latest: '3.30.0', updateAvailable: false, localAhead: true });
  eq(gAhead.kind, 'local-ahead', 'git-pull: localAhead is read off the wire, where decideUpdateAvailable already computed it');

  const gCommits = D({ current: '3.30.0', latest: '3.30.0', updateAvailable: true, localCommit: 'aaa', remoteCommit: 'bbb' });
  eq(gCommits.kind, 'available', 'git-pull: a commit-only difference is still an available update');
  ok(/newer commits/i.test(gCommits.detail), 'git-pull: and it says "newer commits" rather than "v3.30.0 → v3.30.0"');
}

{
  // Degradation, not throwing. A payload is remote input and the route is
  // explicit that an unexpected response must degrade.
  for (const junk of [null, undefined, {}, { updateStyle: 'download-installer' }, { current: null, latest: null }]) {
    let v = null, threw = false;
    try { v = D(junk); } catch { threw = true; }
    ok(!threw && v && typeof v.kind === 'string', `a junk payload (${JSON.stringify(junk)}) degrades to a real verdict instead of throwing`);
  }
  ok(!/undefined|null|\bNaN\b|\bv\s*$/.test(D({}).detail),
     'a payload with no version number never renders "vundefined" or a bare "v"');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 THE SHELL DOES NOT COMPARE VERSIONS');
// ═══════════════════════════════════════════════════════════════════════════
// The single constraint this whole design had to satisfy. src/routes/config.js
// is the only side that read the release list, and it already decided. A
// second, independent verdict in the shell is how a native dialog and a
// settings panel come to disagree about whether you need to update — with no
// way for the user to tell which one lied.
{
  // BEHAVIOURAL, and this is the strong one: the payload's own numbers are
  // made to CONTRADICT its flags. A shell that compared versions would answer
  // "local-ahead" here. One that trusts the server answers "available".
  const contradictory = D({
    current: '9.9.9', latest: '1.0.0',
    comparable: true, updateAvailable: true, localAhead: false,
    updateStyle: 'download-installer',
    releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v1.0.0',
  });
  eq(contradictory.kind, 'available',
     'given current=9.9.9 latest=1.0.0 with updateAvailable:true, the shell reports AVAILABLE — it obeys the server rather than re-deciding');

  const reversed = D({
    current: '1.0.0', latest: '9.9.9',
    comparable: true, updateAvailable: false, localAhead: true,
    updateStyle: 'download-installer',
  });
  eq(reversed.kind, 'local-ahead',
     'and given current=1.0.0 latest=9.9.9 with localAhead:true, it reports LOCAL-AHEAD — the numbers are never consulted');

  // ANTI-VACUITY: both directions had to be tested, because a function that
  // ignored the flags entirely and always said "available" would pass the first.
  ok(contradictory.kind !== reversed.kind,
     'CONTROL — the two contradictory payloads reach DIFFERENT kinds, so the flags are genuinely being read');
}
{
  const src = stripJsComments(read(path.join(DESKTOP, 'lib', 'update-verdict.js')));
  ok(src.length > 500, `CONTROL — comment stripping left real code (${src.length} chars)`);
  ok(!/compareSemver|semver|localeCompare|parseInt|Number\(/.test(src),
     'no comparator, no version parser and no numeric coercion exists anywhere in the verdict module');
  ok(!/[<>]=?\s*0\b/.test(src),
     'no comparison against a comparator result survives — there is nothing to compare');
  const inequalities = src.match(/!==|===/g) || [];
  ok(src.includes('lat !== cur'),
     'the ONE string inequality present decides a LABEL ("v3.29.0 → v3.30.0" vs "newer commits"), inside a branch the server had already called available');
  ok((src.match(/\b(lat|cur|latest|current)\s*[<>]/g) || []).length === 0,
     'no relational operator is ever applied to a version value');
  ok(inequalities.length < 30, `CONTROL — the equality scan is over real code, not an empty string (${inequalities.length} occurrences)`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 fetchUpdateCheck — and a tripwire against reaching the real network');
// ═══════════════════════════════════════════════════════════════════════════
// v3.30.0 recorded an OFFLINE suite in this repo that made a REAL network call
// because its subject resolved `deps.fetchImpl || globalThis.fetch`, so an
// assertion passing `{fetchImpl: null}` fell straight through to the global and
// passed for a reason that had nothing to do with what it claimed.
{
  const realFetch = globalThis.fetch;
  let escaped = 0;
  globalThis.fetch = () => { escaped++; throw new Error('TRIPWIRE: a §9 assertion escaped to the real network'); };
  try {
    const res = (status, body) => ({
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    // The difference from fetchWriteStatus, and the reason this module exists:
    // update-check answers 502/500 with a body that carries the actionable
    // sentence. Discarding it on a non-2xx throws away the useful half.
    const rateLimited = await updateCheck.fetchUpdateCheck('http://127.0.0.1:1', {
      fetchImpl: async () => res(502, { error: 'GitHub is rate-limiting update checks from this network.', reason: 'rate-limited', current: '3.30.0' }),
    });
    eq(rateLimited.reason, 'rate-limited', "a 502 body is PARSED and returned — the route's actionable sentence survives the status code");

    const okBody = await updateCheck.fetchUpdateCheck('http://127.0.0.1:1', {
      fetchImpl: async () => res(200, { current: '3.30.0', latest: '3.31.0', updateAvailable: true }),
    });
    eq(okBody.latest, '3.31.0', 'a 200 body is returned unchanged');

    for (const [label, impl] of [
      ['a rejecting fetch', async () => { throw new Error('ECONNREFUSED'); }],
      ['a fetch returning nothing', async () => null],
      ['a body that is not JSON', async () => res(200, '<html>not json</html>')],
      ['a JSON array rather than an object', async () => res(200, [1, 2, 3])],
      ['an empty body', async () => res(200, '')],
      // VALID JSON, deliberately. The first draft used `'x'.repeat(N)`, which
      // is not JSON — so the assertion passed because JSON.parse threw, and a
      // mutation DELETING the size cap came back GREEN. Nothing but the cap
      // can reject this fixture.
      ['an oversized body', async () => res(200, JSON.stringify({ pad: 'x'.repeat(updateCheck.MAX_BODY_BYTES + 1) }))],
    ]) {
      const r = await updateCheck.fetchUpdateCheck('http://127.0.0.1:1', { fetchImpl: impl });
      eq(r.reason, 'shell-unreachable', `${label} → the locally-authored "no answer" body`);
      ok(typeof r.error === 'string' && r.error.length > 0, `  ${label}: and it carries a sentence a user can act on`);
    }

    // `reason: 'shell-unreachable'` is a code NO route emits, so it is
    // distinguishable from an upstream failure. A fact and its absence never
    // share a value.
    const routeSrc = read(path.join(ROOT, 'src', 'routes', 'config.js'));
    ok(!routeSrc.includes('shell-unreachable'),
       "the shell's own failure code is one no route uses, so it can never be mistaken for an upstream one");

    // THE TRIPWIRE ASSERTION ITSELF.
    const nulled = await updateCheck.fetchUpdateCheck('http://127.0.0.1:1', { fetchImpl: null });
    eq(nulled.reason, 'shell-unreachable',
       'naming the seam with an UNUSABLE value refuses — it does NOT fall through to globalThis.fetch behind the caller’s back');
    const noBase = await updateCheck.fetchUpdateCheck(null, { fetchImpl: async () => res(200, {}) });
    eq(noBase.reason, 'shell-unreachable', 'a null baseUrl (the app has not finished booting) refuses without throwing');

    ok(escaped === 0, `CONTROL — no assertion in §9 touched the real network (${escaped} escapes)`);
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  // Timeout budget. The route's own upstream ceiling is RELEASES_TIMEOUT_MS.
  const routeSrc = read(path.join(ROOT, 'src', 'routes', 'config.js'));
  const m = routeSrc.match(/RELEASES_TIMEOUT_MS\s*=\s*(\d+)/);
  ok(!!m, 'CONTROL — the route still declares RELEASES_TIMEOUT_MS');
  ok(updateCheck.UPDATE_CHECK_TIMEOUT_MS > Number(m[1]),
     `the shell waits LONGER (${updateCheck.UPDATE_CHECK_TIMEOUT_MS}ms) than the route's own upstream budget (${m[1]}ms) — a shorter one would abort a check that was about to succeed and report a failure the server never had`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 cross-file couplings, read-only');
// ═══════════════════════════════════════════════════════════════════════════
// Two facts live in files this change does not own. Both are pinned here
// rather than assumed, and both failure messages name what to do.
{
  const appJs = read(path.join(ROOT, 'src', 'public', 'next', 'app.js'));
  ok(appJs.includes('data-view="settings"'),
     'src/public/next/app.js still emits data-view="settings" — desktop/lib/menu.js\'s SETTINGS_NAV_SELECTOR targets it for ⌘,. If this fails, update SETTINGS_NAV_SELECTOR to whatever the rail button now carries.');
  ok(menu.SETTINGS_NAV_SELECTOR === '[data-view="settings"]',
     'and the selector the shell uses is the one asserted above');
  ok(/\[data-view\]/.test(appJs),
     'data-view is the app\'s own routing primitive (the rail dispatches on it), not a styling hook — which is why it is a defensible thing to couple to');
}
{
  const routeSrc = read(path.join(ROOT, 'src', 'routes', 'config.js'));
  const m = routeSrc.match(/RELEASES_PAGE_URL\s*=\s*'([^']+)'/);
  ok(!!m, 'CONTROL — src/routes/config.js still exports RELEASES_PAGE_URL');
  eq(menu.RELEASES_URL, m[1],
     'the Help ▸ Release Notes URL is byte-identical to the route\'s RELEASES_PAGE_URL — duplicated (every lib/ module is src-free so the suite can execute it) but pinned, so it cannot drift');
  eq(verdict.RELEASES_PAGE_FALLBACK, m[1],
     'and so is the verdict module\'s fallback page');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 main.js source scan — WEAK BY NATURE, and what is NOT enforced');
// ═══════════════════════════════════════════════════════════════════════════
// Electron is not installed, so main.js cannot be imported, evaluated or run.
// A scan proves a call was WRITTEN, never that it RUNS, never that it runs in
// the right order, and never that the resulting menu appears. Comments are
// stripped first so a line of prose about a rule cannot satisfy the rule.
{
  const raw = read(path.join(DESKTOP, 'main.js'));
  const main = stripJsComments(raw);

  ok(main.length < raw.length, 'CONTROL — comment stripping removed something');
  ok(main.length > raw.length * 0.15,
     `CONTROL — most of the code survived stripping (${main.length} of ${raw.length} chars, ${(main.length / raw.length * 100).toFixed(1)}%)`);
  ok(main.includes('createWindow') && main.includes('showErrorBox'),
     'CONTROL — identifiers from the middle and the end of the file survive, so no block match ran away');
  ok(!main.includes('the macOS idiom') && !main.includes('Sparkle'),
     'CONTROL — prose from the comments really is gone');

  ok(/import\s*\{[^}]*\bMenu\b[^}]*\}\s*from\s*'electron'/.test(main), 'main.js imports Menu from electron');
  ok(/Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(/.test(main),
     'main.js installs the template built by lib/menu.js — the structure is not typed here');
  ok(/buildMenuTemplate\(/.test(main), 'main.js calls buildMenuTemplate()');
  ok(!/label:\s*'Edit'|role:\s*'pasteAndMatchStyle'/.test(main),
     'no part of the menu structure is duplicated into main.js — one definition, in the module the suite can execute');

  // The busy state has to be re-installed at BOTH ends or the item stays
  // disabled forever after one check.
  const iFinally = main.indexOf('finally');
  ok(iFinally > 0 && main.slice(iFinally).includes('applyMenu()'),
     'the menu is rebuilt in a `finally`, so a failed check can never leave "Checking for Updates…" disabled forever');
  ok((main.match(/applyMenu\(\)/g) || []).length >= 3,
     'applyMenu() is called on boot, when the check starts, and when it ends');

  ok(/if\s*\(updateCheckInFlight\)\s*return;/.test(main),
     'a second click while a check is in flight is refused — one dialog, never two (same shape as quitCheckInFlight)');

  ok(/SETTINGS_NAV_SELECTOR/.test(main) && !/data-view="settings"/.test(main),
     'main.js uses the IMPORTED selector rather than re-typing it — two copies of a coupling is how they drift apart');
  ok(/JSON\.stringify\(SETTINGS_NAV_SELECTOR\)/.test(main),
     'the selector is serialised into the injected script rather than concatenated raw, so it cannot break out of its own string literal');
  ok(/executeJavaScript\([^)]*\)\s*===\s*true/.test(main),
     'the injected click\'s RETURN VALUE is checked — this is the property that makes the coupling acceptable where insertCSS was not, because a stylesheet cannot report whether its selector matched');
  ok(/isLoading\(\)\)\s*await waitForLoad\(/.test(main),
     'the injected click waits for the page when the window is still loading — revealWindow() legitimately CREATES a window and loadURL is async, so without this ⌘, on a destroyed window injects into a blank page and reports a failure for a window that was about to work');
  ok(!/insertCSS/.test(main), 'main.js still injects no CSS');
  ok(!/ipcMain|contextBridge|exposeInMainWorld/.test(main),
     'no IPC channel was opened for the menu — the preload stays empty, so there is no second way into the app\'s capabilities that bypasses the HTTP guards');

  ok(/isVisible\(\)\s*&&\s*!mainWindow\.isMinimized\(\)/.test(main),
     'the update dialog is only attached to the window when the window is actually ON SCREEN — a sheet on a hidden window (⌘W leaves one) is invisible, and the app would look frozen');

  ok(/getLogsDir/.test(main) && !/Library.{0,3}Logs/.test(main),
     'the log folder comes from the app\'s own getLogsDir(), not from a second copy of the path typed here');
  ok(/describeUpdate\(/.test(main) && /fetchUpdateCheck\(/.test(main),
     'the update dialog routes through the two modules the suite executes');
  ok(!/api\/config\/update-check/.test(main),
     'main.js does not build the update URL itself — lib/update-check.js owns the one call site');
  ok(!/POST|method:\s*'POST'/.test(main),
     'the menu never POSTs anything: it cannot apply an update, and auto-install stays deferred until the app is signed and notarized');
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
