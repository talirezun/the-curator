/**
 * test-tray-shell.js — OFFLINE guard for the macOS menubar widget (Phase 1).
 *
 * Covers `desktop/lib/tray-model.js`, `tray-menu.js`, `tray-icon.js`,
 * `background-mode.js` and `state-watch.js`, plus a labelled-weak source scan
 * of the wiring in `desktop/main.js`.
 *
 * ── METHOD, AND WHY IT IS NOT A GREP ────────────────────────────────────────
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js` cannot
 * be imported, evaluated or run here — and no tray icon may be created on the
 * maintainer's own machine while he is sitting at it. That is exactly why the
 * widget was built as PLAIN DATA and PURE FUNCTIONS: the row model, the menu
 * template, the glyph's actual pixels, the mode transitions and every timing
 * decision are ordinary values this file computes and inspects for real. Only
 * §11 is a scan, and it says so in its own heading.
 *
 * Same precedent, and the same split, as `scripts/test-desktop-menu.js`.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0   positive control on the imports themselves
 *   §1   formatAge PARITY with src/public/next/views/memory.js — executed
 *   §2   the row model: order, the two-meaning slot, and null is never zero
 *   §3   machine names, shortened and disambiguated only where needed
 *   §4   caps, notices, and "did not check" versus "nothing waiting"
 *   §5   the glyph, and why its corrector is not a poll
 *   §6   the menu template: order, the always-present items, and Quit
 *   §7   the icon: decoded back out of its own PNG bytes
 *   §8   backgroundMode: the fail-safe default and the 3x3 transition matrix
 *   §9   the watch: filter, debounce, fallback — driven with a fake clock
 *   §10  cross-file couplings, read-only
 *   §11  main.js source scan, and what is NOT enforced
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - NO TRAY ICON HAS EVER BEEN RENDERED, on this machine or any other.
 *    Electron is not installed, no app was launched, and `Menu.buildFromTemplate`
 *    and `new Tray()` have never seen any of this. A `role` Electron rejects, a
 *    `sublabel` it ignores, or a template image macOS declines to tint would
 *    pass every assertion below and still be wrong on screen.
 *  - The PNG bytes are proven to decode back to the matrix that produced them,
 *    and were additionally opened by macOS's own `sips` during development
 *    (36x36, hasAlpha: yes). That proves they are a VALID PNG. It does not
 *    prove macOS tints them as a template image, which needs `setTemplateImage`
 *    at runtime and is scanned for in §11 only.
 *  - `tray.on('mouse-enter')` is documented as macOS-supported and is NOT
 *    verified here. If it never fires, the design still holds — the menu is
 *    rebuilt on every save and on the fallback tick, and carries an absolute
 *    "Updated HH:MM" stamp — but the ages will be as old as the last rebuild.
 *  - §10's tripwires prove `data-view="memory"` and `data-mem-project` are
 *    still EMITTED by the app's own source. They cannot prove the elements
 *    render, are visible, or that clicking them navigates. main.js checks the
 *    injected script's return value at runtime for exactly that reason.
 *  - The `tray-only` mode's Dock transition is not implemented and therefore
 *    not tested. §8 asserts that it is HELD BACK rather than silently ignored.
 *  - Nothing here proves the data layer's `getTraySummary` exists or returns
 *    the documented shape. The model is asserted to survive it not doing so.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
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
 * LINE COMMENTS FIRST. The order is load-bearing and this repo has the scar: a
 * `//` comment naming a glob path contains `/*`, so a block-comment pass run
 * first opens a comment there and eats hundreds of lines — turning every
 * `.test()` into a scan over an empty string, which passes everything.
 * Copied deliberately rather than imported from another suite: a shared helper
 * is a shared blast radius.
 */
function stripJsComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

let model, menu, icon, mode, watchMod;
try {
  model = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  menu = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
  icon = await import(path.join(DESKTOP, 'lib', 'tray-icon.js'));
  mode = await import(path.join(DESKTOP, 'lib', 'background-mode.js'));
  watchMod = await import(path.join(DESKTOP, 'lib', 'state-watch.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the tray modules: ${err.message}`);
  process.exit(1);
}

const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {} };
const NOW = new Date('2026-08-31T14:32:00');

/** One realistic summary. Every name here is INVENTED — this is a public
 *  repository and no real machine, project or host name may appear in it. */
function summary(over = {}) {
  return {
    ok: true,
    lastSave: { project: 'alpha', scope: 'main', writtenAgeSeconds: 30, ageSource: 'agent' },
    scopes: [
      { project: 'alpha', scope: 'main', machine: 'laptop-a1b2c3', harness: 'harness-one',
        writtenAgeSeconds: 30, ageSource: 'agent', headline: 'wired the tray bounds',
        isThisMachine: true, harnessShared: false },
      { project: 'alpha', scope: 'research', machine: 'laptop-a1b2c3', harness: 'harness-two',
        writtenAgeSeconds: 1080, ageSource: 'agent', headline: 'redid the section',
        isThisMachine: true, harnessShared: true },
      { project: 'beta', scope: 'main', machine: 'studio-9f8e7d', harness: 'harness-two',
        writtenAgeSeconds: 10800, ageSource: 'file', headline: 'rewrote the serialiser',
        isThisMachine: false, harnessShared: false },
    ],
    brief: null,
    remote: null,
    warnings: [],
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control — the modules really loaded');
ok(typeof model.buildTrayModel === 'function', 'buildTrayModel is a function');
ok(typeof menu.buildTrayMenuTemplate === 'function', 'buildTrayMenuTemplate is a function');
ok(typeof icon.trayIconPngs === 'function', 'trayIconPngs is a function');
ok(typeof mode.resolveTrayPlan === 'function', 'resolveTrayPlan is a function');
ok(typeof watchMod.createStateWatcher === 'function', 'createStateWatcher is a function');

{
  const m = model.buildTrayModel(summary(), { now: NOW });
  const t = menu.buildTrayMenuTemplate(m, NOOPS);
  const flat = menu.flattenTrayMenu(t);
  ok(flat.length > 12, `CONTROL — the flattened template has real content (${flat.length} nodes)`);
  // Deliberately NOT an item any later assertion is about: a control that reds
  // when its own subject is deleted is not independent of it.
  ok(flat.some((i) => i.type === 'separator'),
    'CONTROL — flattenTrayMenu yields separators as well as items');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 formatAge PARITY with the app — extracted and EXECUTED, not diffed');
//
// `tray-model.js` cannot import `src/public/next/views/memory.js`: that module
// registers a view and reaches for a DOM at import time. So the function is
// duplicated, and the duplication is only safe if it is PINNED. A string
// comparison would pass on two functions that had both been edited the same
// wrong way; this pulls the REAL one out of the app's source, evaluates it, and
// runs both over a matrix that crosses every boundary in the ladder.
{
  const src = read(path.join(ROOT, 'src', 'public', 'next', 'views', 'memory.js'));
  const start = src.indexOf('export function formatAge(');
  ok(start > 0, 'the app still exports formatAge (if this reds, the pin is gone — do not delete the assertion)');
  let appFormatAge = null;
  if (start > 0) {
    // Read to the first line that is a bare `}` at column 0 after the start.
    const rest = src.slice(start);
    const end = rest.search(/\n\}\n/);
    const body = rest.slice(0, end + 2).replace(/^export\s+/, '');
    // eslint-disable-next-line no-new-func
    appFormatAge = new Function(`${body}\nreturn formatAge;`)();
  }
  ok(typeof appFormatAge === 'function', 'CONTROL — the extracted formatAge really evaluated');

  const matrix = [
    -1, 0, 1, 59, 60, 61, 119, 120, 3599, 3600, 3601, 86399, 86400,
    2 * 86400, 6 * 86400, 7 * 86400, 34 * 86400, 35 * 86400,
    30 * 86400, 364 * 86400, 365 * 86400, 800 * 86400,
    null, undefined, NaN, Infinity, '60', {},
  ];
  let agree = 0, disagree = [];
  for (const v of matrix) {
    const a = appFormatAge(v);
    const b = model.formatAge(v);
    if (a === b) agree++; else disagree.push([v, a, b]);
  }
  eq(disagree, [], `both copies of formatAge agree on all ${matrix.length} inputs`);
  ok(agree === matrix.length, `CONTROL — ${agree} comparisons actually ran (a zero here would pass vacuously)`);
  // The one assertion that makes the whole section non-vacuous: the two
  // functions must be capable of DISAGREEING. A stubbed extraction returning
  // undefined for everything would agree with nothing.
  ok(appFormatAge(60) === '1 min ago' && appFormatAge(30) === 'just now',
    'CONTROL — the extracted function returns real answers, so agreement means something');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the row model: order, the two-meaning slot, and null is never zero');
{
  const m = model.buildTrayModel(summary(), { now: NOW });
  eq(m.rows.map((r) => r.scope), ['main', 'research', 'main'], 'rows are newest-first by the AGENT clock');

  // THE SLOT WITH TWO MEANINGS. On a local row it holds the harness; on a
  // remote row it holds the machine.
  ok(m.rows[0].label.includes('harness-one'), 'a LOCAL row shows the harness');
  ok(!m.rows[0].label.includes('laptop'), 'a LOCAL row does NOT show the machine — it is constant, and therefore noise');
  ok(m.rows[2].label.includes('studio'), 'a REMOTE row shows the machine');
  ok(!m.rows[2].label.includes('harness-two'), 'a REMOTE row does NOT show the harness — that is the other computer\'s business');

  // ageSource: a filesystem timestamp is never dressed as the agent's clock.
  ok(m.rows[0].label.includes('just now') && !m.rows[0].label.includes('changed'),
    'an ageSource:agent row reads as a plain relative age');
  ok(m.rows[2].label.includes('changed 3 hr ago'),
    'an ageSource:file row says CHANGED — git rewrites mtime, so it is this disk\'s clock, not the agent\'s');
  ok(/git rewrites/i.test(m.rows[2].toolTip),
    'and the tooltip explains why that row\'s number is weaker');

  // NULL IS NEVER ZERO AND NEVER A FAKE STRING.
  const withNull = model.buildTrayModel(summary({
    lastSave: null,
    scopes: [{ project: 'gamma', scope: 'main', machine: 'laptop-a1b2c3', harness: null,
      writtenAgeSeconds: null, ageSource: null, headline: null, isThisMachine: true }],
  }), { now: NOW });
  ok(withNull.rows[0].label.includes('time unknown'), 'an unknown age renders as "time unknown"');
  ok(!/just now/.test(withNull.rows[0].label), 'an unknown age is NEVER "just now"');
  ok(!/0 /.test(withNull.rows[0].label), 'an unknown age is NEVER a zero');
  eq(withNull.headline.known, false, 'and the headline reports that it does not know');
  eq(withNull.headline.text, 'Last save · time unknown', 'in words, not as a blank');

  // A row with no age sorts LAST rather than being asserted to be the newest.
  const mixed = model.buildTrayModel(summary({
    scopes: [
      { project: 'a', scope: 'unknown', machine: 'laptop-a1b2c3', writtenAgeSeconds: null, isThisMachine: true },
      { project: 'a', scope: 'known', machine: 'laptop-a1b2c3', writtenAgeSeconds: 900, ageSource: 'agent', isThisMachine: true },
    ],
  }), { now: NOW });
  eq(mixed.rows.map((r) => r.scope), ['known', 'unknown'], 'a row with no age sorts LAST, never first');

  // Garbage in must not throw. A menubar that throws is a menubar that is
  // simply absent, with no error anywhere a user will look.
  for (const junk of [null, undefined, 0, 'x', [], { scopes: 'no' }, { scopes: [null, 1, 'x'] }]) {
    let threw = false;
    try { model.buildTrayModel(junk, { now: NOW }); } catch { threw = true; }
    ok(!threw, `buildTrayModel survives ${JSON.stringify(junk) ?? String(junk)}`);
  }
  eq(model.buildTrayModel(null, { now: NOW }).empty, true, 'and garbage produces the EMPTY state');
  eq(model.buildTrayModel({ ok: false, scopes: [] }, { now: NOW }).headline.text,
    'Agent memory could not be read',
    'a FAILED READ is a different sentence from "nothing has been saved"');

  // Headlines are clipped visibly, and newlines never reach a menu label.
  const long = model.buildTrayModel(summary({
    scopes: [{ project: 'a', scope: 'b', machine: 'laptop-a1b2c3', isThisMachine: true,
      writtenAgeSeconds: 10, ageSource: 'agent', headline: 'x'.repeat(400) + '\nsecond line' }],
  }), { now: NOW });
  ok(long.rows[0].sublabel.length <= model.MAX_HEADLINE_CHARS, 'a long headline is clipped to the cap');
  ok(long.rows[0].sublabel.endsWith('…'), 'and the clip is VISIBLE, not silent');
  ok(!/\n/.test(long.rows[0].label + long.rows[0].sublabel), 'no newline reaches a menu label');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 machine names, shortened and disambiguated only where needed');
{
  eq(model.hostPart('laptop-a1b2c3'), 'laptop', 'the install id is stripped');
  eq(model.hostPart('build-box'), 'build-box', 'a non-hex trailing word is NOT stripped — "box" is not an install id');
  eq(model.hostPart('solo'), 'solo', 'a name with no hyphen survives');
  eq(model.hostPart(''), null, 'an empty machine name is null, not an empty label');

  const one = model.shortMachineNames(['laptop-a1b2c3', 'laptop-a1b2c3', 'studio-9f8e7d']);
  eq(one.get('laptop-a1b2c3'), 'laptop', 'the same machine on three rows does not disambiguate against itself');
  eq(one.get('studio-9f8e7d'), 'studio', 'two different hosts need no suffix');

  const split = model.shortMachineNames(['laptop-a1b2c3', 'laptop-ddddee']);
  eq(split.get('laptop-a1b2c3'), 'laptop·a1b2', 'TWO installs sharing a host part get a disambiguator');
  eq(split.get('laptop-ddddee'), 'laptop·dddd', 'and so does the other one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 caps, notices, and "did not check" versus "nothing waiting"');
{
  // A CAP IS DISCLOSED, NEVER PRESENTED AS A MEASUREMENT.
  const many = model.buildTrayModel(summary({
    total: 40,
    scopes: Array.from({ length: 20 }, (_, i) => ({
      project: 'p', scope: 's' + i, machine: 'laptop-a1b2c3', harness: 'h',
      writtenAgeSeconds: i * 60, ageSource: 'agent', isThisMachine: true,
    })),
  }), { now: NOW });
  eq(many.rows.length, model.MAX_ROWS, 'the row list is capped');
  ok(many.truncatedNote && many.truncatedNote.includes('32'),
    'and the TRUE remainder is disclosed against the supplied total, not against what was visible');

  const noTotal = model.buildTrayModel(summary({
    scopes: Array.from({ length: 12 }, (_, i) => ({
      project: 'p', scope: 's' + i, machine: 'laptop-a1b2c3', writtenAgeSeconds: i, ageSource: 'agent', isThisMachine: true,
    })),
  }), { now: NOW });
  ok(noTotal.truncatedNote && noTotal.truncatedNote.includes('4'),
    'with no supplied total the remainder falls back to what was handed over');

  // THE FACT AND ITS ABSENCE.
  eq(model.remoteNotice(null), null, 'remote:null renders NOTHING — "we did not check" is not "you are up to date"');
  eq(model.remoteNotice({ ok: true, behindFiles: 0 }), null, 'zero waiting renders nothing');
  eq(model.remoteNotice({ ok: true, behindFiles: 2 }).text, '2 handoffs waiting on GitHub', 'a real count is a count');
  eq(model.remoteNotice({ ok: true, behindFiles: 1 }).text, '1 handoff waiting on GitHub', 'and it is singular when it is one');
  eq(model.remoteNotice({ ok: false, message: 'network is down' }).text, 'network is down',
    'a FAILED check says so — a third state, not folded into either of the others');

  // Collisions.
  const coll = model.buildTrayModel(summary(), { now: NOW });
  ok(coll.notices.some((n) => n.kind === 'collision' && n.text.includes('alpha · research')),
    'harnessShared produces a collision line naming the scope');
  ok(coll.notices.every((n) => !/rename|split|should/i.test(n.text)),
    'and it proposes NO remedy — the fix is the user\'s and does not fit in six words');

  const collSuppressed = model.buildTrayModel(summary({
    warnings: ['Two harnesses are writing into alpha / research — give them separate scopes'],
  }), { now: NOW });
  eq(collSuppressed.notices.filter((n) => /harness/i.test(n.text)).length, 1,
    'a supplied warning naming the same scope SUPPRESSES the derived one — two sources never both speak about one scope');

  const noisy = model.buildTrayModel(summary({
    warnings: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
  }), { now: NOW });
  eq(noisy.notices.length, model.MAX_NOTICES, 'notices are capped');
  ok(noisy.noticesHidden > 0, 'and the overflow is counted rather than dropped silently');

  // The absolute stamp.
  eq(model.buildTrayModel(summary(), { now: NOW }).renderedAtText, '14:32',
    'the model carries an ABSOLUTE freshness stamp, distinct from the rows\' relative ages');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the glyph, and why its corrector is not a poll');
{
  const live = model.buildTrayModel(summary(), { now: NOW });
  eq(live.glyph, 'live', 'a local save inside the live window lights the glyph');

  const remoteOnly = model.buildTrayModel(summary({
    lastSave: null,
    scopes: [{ project: 'b', scope: 'main', machine: 'studio-9f8e7d', harness: 'h',
      writtenAgeSeconds: 5, ageSource: 'agent', isThisMachine: false }],
  }), { now: NOW });
  eq(remoteOnly.glyph, 'idle',
    'a REMOTE save does NOT light it — the glyph is a local instrument, and a pulled handoff is not an agent at work here');

  const filePulled = model.buildTrayModel(summary({
    lastSave: null,
    scopes: [{ project: 'b', scope: 'main', machine: 'laptop-a1b2c3', harness: 'h',
      writtenAgeSeconds: 5, ageSource: 'file', isThisMachine: true }],
  }), { now: NOW });
  ok(filePulled.rows[0].label.includes('changed'),
    'a freshly-PULLED file still says "changed", so a git checkout cannot masquerade as an agent at work');

  eq(model.ageBucket(0), 'live', 'bucket: 0s is live');
  eq(model.ageBucket(119), 'live', 'bucket: just inside the window');
  eq(model.ageBucket(120), 'warm', 'bucket: the boundary is exclusive');
  eq(model.ageBucket(29 * 60), 'warm', 'bucket: warm');
  eq(model.ageBucket(31 * 60), 'today', 'bucket: today');
  eq(model.ageBucket(13 * 3600), 'cool', 'bucket: cool');
  eq(model.ageBucket(8 * 86400), 'cold', 'bucket: cold');
  eq(model.ageBucket(null), 'unknown', 'bucket: unknown is its own value, not "cold"');

  eq(model.liveExpiresInMs(remoteOnly), null, 'an IDLE glyph arms NOTHING — no timer exists in the state the app is in almost always');
  const ms = model.liveExpiresInMs(live);
  ok(ms > 0 && ms <= model.LIVE_WINDOW_SECONDS * 1000 + 1000,
    `a LIVE glyph arms exactly one timeout at the boundary (${ms} ms)`);
  ok(ms > 60000, 'and it is a single correction, not a per-second or per-minute tick');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the menu template: order, the always-present items, and Quit');
{
  const m = model.buildTrayModel(summary(), { now: NOW });
  const t = menu.buildTrayMenuTemplate(m, NOOPS);
  const flat = menu.flattenTrayMenu(t);
  const items = flat.filter((i) => i.type !== 'separator');

  // THE HEADLINE ANSWER IS FIRST. This is the maintainer's stated need — "am I
  // approaching the end of the context window, and did we update the scope?" —
  // and it must be answerable without reading past the first line.
  eq(items[0].id, menu.ID_HEADLINE, 'the first item is the headline answer');
  ok(/^Last save · /.test(items[0].label), `and it reads "${items[0].label}"`);
  eq(items[0].enabled, true,
    'the headline is ENABLED, so it is drawn at full contrast — the one line the widget exists for is not put in the dimmest style available');
  eq(items[1].id, menu.ID_HEADLINE_WHERE, 'the scope it happened in is the second line');
  eq(items[1].enabled, false, 'and that line is a statement about the one above it, not a second action');

  // Always present, whatever the data does.
  for (const state of [summary(), null, { ok: false, scopes: [] }, summary({ scopes: [] })]) {
    const tt = menu.buildTrayMenuTemplate(model.buildTrayModel(state, { now: NOW }), NOOPS);
    const ff = menu.flattenTrayMenu(tt).filter((i) => i.type !== 'separator');
    ok(ff.some((i) => i.id === menu.ID_OPEN_APP), 'Open The Curator is present in every state');
    ok(ff[ff.length - 1].id === menu.ID_QUIT, 'and Quit is ALWAYS the last item');
  }

  // ── QUIT MUST NOT BE ABLE TO BYPASS THE WRITE GUARD ──────────────────────
  const quit = items[items.length - 1];
  eq(quit.role, 'quit',
    'Quit is role:quit — the path that fires before-quit, where main.js runs lib/quit-decision.js over GET /api/write-status');
  eq(typeof quit.click, 'undefined',
    'and it carries NO click handler, so there is structurally no code path that could call app.exit() and walk past the guard');
  // COMMENTS STRIPPED FIRST. The docblock of tray-menu.js EXPLAINS that a
  // hand-rolled handler "could call app.exit() and walk past the guard" — so a
  // raw scan matches the prose that argues against the thing and reports the
  // defect it was written to prevent. Caught on this suite's first run.
  const menuCode = stripJsComments(read(path.join(DESKTOP, 'lib', 'tray-menu.js')));
  // The control anchor is deliberately NOT `role: 'quit'` — that is the very
  // thing the two assertions below are about, so a control keyed on it would
  // red whenever its own subject was deleted and would therefore not be
  // independent of it. Caught by mutation M9.
  ok(/export function flattenTrayMenu/.test(menuCode),
    'CONTROL — the stripper leaves real code behind (a scan over an empty string passes everything)');
  ok(!/app\.exit|process\.exit/.test(menuCode),
    'the tray menu module contains no exit call at all');

  // Every handler is required at BUILD time, not at click time.
  for (const missing of ['onOpenScope', 'onOpenMemory', 'onOpenApp', 'onOpenSettings']) {
    const partial = { ...NOOPS };
    delete partial[missing];
    let threw = false;
    try { menu.buildTrayMenuTemplate(m, partial); } catch (e) { threw = /must be a function/.test(e.message); }
    ok(threw, `a missing ${missing} is refused at build time, not weeks later in front of the user`);
  }

  // Rows are actionable and carry the click.
  const rowItems = items.filter((i) => typeof i.id === 'string' && i.id.startsWith('tray-row-'));
  eq(rowItems.length, 3, 'every row is a menu item');
  ok(rowItems.every((i) => typeof i.click === 'function'), 'and every one of them is clickable');
  {
    let got = null;
    const t2 = menu.buildTrayMenuTemplate(m, { ...NOOPS, onOpenScope: (r) => { got = r; } });
    menu.flattenTrayMenu(t2).find((i) => i.id === 'tray-row-2').click();
    eq(got && [got.project, got.scope], ['beta', 'main'],
      'clicking a row hands the shell THAT row — the third one, not the first');
  }

  // The empty state.
  const empty = menu.flattenTrayMenu(
    menu.buildTrayMenuTemplate(model.buildTrayModel(summary({ lastSave: null, scopes: [] }), { now: NOW }), NOOPS));
  ok(empty.some((i) => i.label === menu.EMPTY_LABEL), 'the empty state names itself');
  ok(empty.some((i) => i.label === menu.EMPTY_HINT), 'and says how something gets into it');
  ok(!empty.some((i) => /error|failed|problem/i.test(String(i.label))),
    'and it does NOT read like an error — this is the first thing every new user sees');
  const broken = menu.flattenTrayMenu(
    menu.buildTrayMenuTemplate(model.buildTrayModel({ ok: false, scopes: [] }, { now: NOW }), NOOPS));
  ok(broken.some((i) => i.label === menu.UNREADABLE_HINT),
    'a failed READ gets a different hint from an empty store — collapsing the two would tell a user with a full store that it is empty');

  // The freshness stamp is in the menu, and it is absolute.
  ok(items.some((i) => i.id === menu.ID_UPDATED_STAMP && i.label === 'Updated 14:32'),
    'the menu carries its own "Updated HH:MM" stamp, so a stale reading is visible AS stale');

  // The tooltip carries the headline, so a hover answers without a click.
  ok(/Last save/.test(menu.trayToolTip(m)), 'the icon tooltip carries the headline answer');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the icon: decoded back out of its own PNG bytes');
//
// Not "a file exists". The encoder's output is inflated and walked here, so the
// assertions are about actual pixels.
{
  function decodeGrayAlpha(buf) {
    for (let i = 0; i < icon.PNG_SIGNATURE.length; i++) {
      if (buf[i] !== icon.PNG_SIGNATURE[i]) throw new Error('bad signature');
    }
    let p = 8;
    let width = 0, height = 0, depth = 0, colorType = -1;
    const idat = [];
    while (p < buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString('ascii', p + 4, p + 8);
      const data = buf.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; colorType = data[9];
      } else if (type === 'IDAT') idat.push(data);
      p += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const grey = [], alpha = [];
    let q = 0;
    for (let y = 0; y < height; y++) {
      if (raw[q++] !== 0) throw new Error('unexpected filter byte');
      const gr = [], al = [];
      for (let x = 0; x < width; x++) { gr.push(raw[q++]); al.push(raw[q++]); }
      grey.push(gr); alpha.push(al);
    }
    return { width, height, depth, colorType, grey, alpha };
  }

  const idle = icon.trayIconPngs('idle');
  const live = icon.trayIconPngs('live');
  const d1 = decodeGrayAlpha(idle.scale1);
  const d2 = decodeGrayAlpha(idle.scale2);
  const l1 = decodeGrayAlpha(live.scale1);

  eq([d1.width, d1.height], [18, 18], '1x is 18x18 points — the conventional menu bar extra size');
  eq([d2.width, d2.height], [36, 36], 'a 2x representation exists and is exactly double');
  eq([d1.depth, d1.colorType], [8, 4], 'colour type 4 = greyscale + alpha, 8 bits each');
  ok(d1.grey.every((row) => row.every((v) => v === 0)),
    'EVERY grey value is 0 — a template image carries all its information in alpha, and macOS tints it for the current menu bar');

  // The mark is actually a ring: transparent at the very centre when idle.
  eq(d1.alpha[9][9], 0, 'the idle glyph is HOLLOW at its centre');
  ok(l1.alpha[9][9] > 200, 'the live glyph is FILLED at its centre');
  ok(d1.alpha[9][2] > 200, 'and both have ink on the ring itself');
  eq(d1.alpha[0][0], 0, 'the corners are transparent — the mark is a circle, not a square');

  // The two states must differ ONLY in the middle: a live glyph that also
  // changed the ring would read as a different icon rather than a state.
  let ringDiff = 0, centreDiff = 0;
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 18; x++) {
      if (d1.alpha[y][x] === l1.alpha[y][x]) continue;
      const dx = x + 0.5 - 9, dy = y + 0.5 - 9;
      if (Math.hypot(dx, dy) < 5) centreDiff++; else ringDiff++;
    }
  }
  ok(centreDiff > 20, `the two states differ in the centre (${centreDiff} pixels)`);
  eq(ringDiff, 0, 'and NOWHERE else — live is a state of one icon, not a second icon');

  // Both scale representations must be the same drawing.
  eq(decodeGrayAlpha(live.scale2).alpha[18][18] > 200, true, 'the 2x live glyph is filled at its own centre too');

  ok(idle.scale1.length < 1024 && idle.scale2.length < 2048,
    `the generated images are tiny (${idle.scale1.length} / ${idle.scale2.length} bytes) — nothing is being shipped or cached`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 backgroundMode: the fail-safe default and the 3x3 transition matrix');
{
  eq(mode.DEFAULT_BACKGROUND_MODE, 'window', 'the default is window — no menu bar icon');
  for (const junk of [undefined, null, '', 'TRAY-ONLY?', 'on', true, 0, {}, [], 'menubar']) {
    eq(mode.resolveBackgroundMode(junk), 'window',
      `an unrecognised value (${JSON.stringify(junk) ?? String(junk)}) resolves to window, never to tray`);
  }
  eq(mode.resolveBackgroundMode('  Tray  '), 'tray', 'a recognised value survives trimming and case');
  eq(mode.resolveBackgroundMode({ backgroundMode: 'tray-only' }), 'tray-only',
    'a whole config object is accepted, so the caller cannot mis-shape it');

  eq(mode.resolveTrayPlan('window').tray, false, 'window mode creates no tray');
  eq(mode.resolveTrayPlan('tray').tray, true, 'tray mode creates one');
  const only = mode.resolveTrayPlan('tray-only');
  eq(only.tray, true, 'tray-only creates one too');
  eq(only.hideDock, false, 'but it does NOT hide the Dock icon');
  eq(only.hedged, true, 'and it says so — HELD BACK, not silently ignored');
  ok(/not implemented/i.test(only.reason), 'with a reason a caller can show');
  eq(mode.DOCK_HIDING_IMPLEMENTED, false,
    'the untested accessory->regular transition is not shipped, and the flag says which half was done');

  // THE 3x3 MATRIX, and idempotence is the property that matters: an atomic
  // config write is a create plus a rename, so the watch fires more than once
  // per save. A same-mode "transition" must do NOTHING, or one Settings click
  // destroys and recreates the icon — which on macOS moves it in the bar.
  for (const m of mode.BACKGROUND_MODES) {
    const p = mode.planModeTransition(m, m);
    eq([p.changed, p.createTray, p.destroyTray, p.startWatch, p.stopWatch], [false, false, false, false, false],
      `${m} -> ${m} is a no-op`);
  }
  const on = mode.planModeTransition('window', 'tray');
  eq([on.createTray, on.startWatch, on.destroyTray], [true, true, false], 'window -> tray creates the tray AND starts the watch');
  const off = mode.planModeTransition('tray', 'window');
  eq([off.destroyTray, off.stopWatch, off.revealWindow], [true, true, true],
    'tray -> window destroys it, STOPS PAYING for the watch, and reveals the window so nobody is left with no visible app');
  const across = mode.planModeTransition('tray', 'tray-only');
  eq([across.createTray, across.destroyTray], [false, false],
    'tray -> tray-only does NOT churn the icon — both want a tray, and destroying it would move it in the menu bar for nothing');
  eq(across.changed, true, 'though the mode itself did change');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 the watch: filter, debounce, fallback — driven with a fake clock');
{
  const W = watchMod;
  // The filter. Three events per save, and only one of them may count.
  ok(W.isWorkingStateEvent('proj/state/main/laptop-a1b2c3/current.md'), 'current.md counts');
  ok(W.isWorkingStateEvent('proj/state/main/laptop-a1b2c3/journal.jsonl'), 'journal.jsonl counts');
  ok(!W.isWorkingStateEvent('proj/state/main/laptop-a1b2c3/.tmp-abc123'),
    'the atomic write\'s temp file does NOT — otherwise the index is read while the rename is still in flight');
  ok(!W.isWorkingStateEvent('proj/wiki/entities/thing.md'), 'a wiki write does not — an ingest writes hundreds of these');
  ok(!W.isWorkingStateEvent('proj/raw/source.pdf'), 'nor a raw source');
  ok(!W.isWorkingStateEvent('.git/objects/ab/cdef'), 'nor anything inside .git');
  ok(!W.isWorkingStateEvent('proj/state/main/.DS_Store'), 'nor .DS_Store');
  ok(!W.isWorkingStateEvent(null) && !W.isWorkingStateEvent(''),
    'a null filename is REFUSED, not treated as "something changed" — that would be the poll this design exists to avoid, arrived at by accident');

  ok(W.isConfigEvent('.curator-config.json', '.curator-config.json'), 'the config basename matches exactly');
  ok(!W.isConfigEvent('.curator-config.json.tmp-9', '.curator-config.json'),
    'and its temp file does not — the file must not be read while it is being written');
  ok(!W.isConfigEvent('other.json', '.curator-config.json'), 'nothing else in that directory triggers a read');

  // The debounce, with a fake clock.
  {
    const clock = [];
    const setT = (fn, ms) => { clock.push({ fn, ms }); return clock.length; };
    const clearT = (h) => { if (clock[h - 1]) clock[h - 1].cancelled = true; };
    let fired = 0, coalesced = 0;
    const d = W.createDebouncer({
      delayMs: 150, setTimeout: setT, clearTimeout: clearT,
      onFire: (n) => { fired++; coalesced = n; },
    });
    // One save = three events in the same millisecond.
    d.ping(); d.ping(); d.ping();
    eq(fired, 0, 'nothing fires while the burst is arriving');
    const live = clock.filter((c) => !c.cancelled);
    eq(live.length, 1, 'only ONE timer survives the burst — the earlier two are cancelled');
    live[0].fn();
    eq(fired, 1, 'one save produces exactly ONE refresh, not three');
    eq(coalesced, 3, 'and it reports how many events it absorbed');
    eq(clock[0].ms, 150, 'at the documented 150 ms');
  }

  // The whole watcher, with fake fs.watch and fake timers.
  {
    const timers = [];
    const intervals = [];
    const setT = (fn) => { timers.push({ fn }); return timers.length; };
    const clearT = () => {};
    const setI = (fn, ms) => { intervals.push({ fn, ms }); return { ms, unref() {} }; };
    const clearI = () => {};
    const listeners = [];
    const closed = [];
    const fakeWatch = (root, opts, cb) => {
      listeners.push({ root, opts, cb });
      return { on() {}, close() { closed.push(root); } };
    };
    const reasons = [];
    const w = W.createStateWatcher({
      roots: ['/fake/domains'], watch: fakeWatch,
      onRefresh: (why) => reasons.push(why),
      setTimeout: setT, clearTimeout: clearT, setInterval: setI, clearInterval: clearI,
    });
    w.start();
    eq(listeners.length, 1, 'one watch, on one root');
    eq(listeners[0].opts.recursive, true,
      'and it is RECURSIVE — the decisive property: it catches scopes and whole projects created AFTER the watch started');
    eq(intervals.length, 1, 'exactly one fallback timer exists');
    eq(intervals[0].ms, W.FALLBACK_POLL_MS, 'at 5 minutes');
    eq(W.FALLBACK_POLL_MS, 300000, 'which is 300 s — measured at 0.02% of a core, versus 0.31% for a 20 s poll');

    // Nothing branches on the event type: `rename` is all macOS ever sends.
    listeners[0].cb('rename', 'p/state/s/laptop-a1b2c3/current.md');
    listeners[0].cb('rename', 'p/state/s/laptop-a1b2c3/journal.jsonl');
    listeners[0].cb('rename', 'p/state/s/laptop-a1b2c3/.tmp-x');
    listeners[0].cb('rename', 'p/wiki/a.md');
    eq(w.stats.events, 4, 'all four events arrived');
    eq(w.stats.matched, 2, 'two of them were about working state');
    eq(reasons.length, 0, 'and NONE of them refreshed yet — the debounce is holding');
    timers[timers.length - 1].fn();
    eq(reasons, ['watch'], 'one refresh, after the debounce, and it names why it ran');

    intervals[0].fn();
    eq(reasons, ['watch', 'fallback'], 'the fallback names itself differently, so the two are distinguishable');

    w.stop();
    eq(closed, ['/fake/domains'], 'stop() closes the watch — turning the feature off must stop paying for it');
    eq(w.isRunning(), false, 'and says so');
  }

  // The expiry timer arms nothing when there is nothing to correct.
  {
    let armed = 0, fired = 0;
    const t = W.createExpiryTimer({
      onExpire: () => { fired++; },
      setTimeout: (fn) => { armed++; return { fn, unref() {} }; },
      clearTimeout: () => {},
    });
    eq(t.arm(null), false, 'arm(null) arms nothing');
    eq(t.arm(0), false, 'arm(0) arms nothing');
    eq(armed, 0, 'so an IDLE glyph costs literally no timer');
    eq(t.arm(5000), true, 'a live glyph arms one');
    eq(armed, 1, 'exactly one');
    t.arm(9000);
    eq(armed, 2, 're-arming replaces rather than stacks — a second save inside the window does not leave two timers');
    eq(fired, 0, 'and nothing has fired on its own');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 cross-file couplings, read-only');
{
  const appJs = read(path.join(ROOT, 'src', 'public', 'next', 'app.js'));
  ok(/data-view="'\s*\+\s*id/.test(appJs) || /data-view="/.test(appJs),
    'the rail still emits data-view — the attribute the shell clicks to reach a view');
  ok(/'memory'/.test(appJs) && /NAV_VIEWS/.test(appJs),
    'and "memory" is still one of the rail views');

  const memJs = read(path.join(ROOT, 'src', 'public', 'next', 'views', 'memory.js'));
  ok(/data-mem-project="/.test(memJs),
    'the memory view still emits data-mem-project — the attribute the shell matches a project row on');
  ok(/\.mem-row\[data-mem-project\]/.test(memJs),
    'and its own click handler still selects rows the same way, so the shell is using the app\'s routing primitive and not a styling hook');

  // The shell must never write working state.
  //
  // COMMENTS STRIPPED FIRST, and for the same reason as §6: state-watch.js's
  // docblock explains that `writeFileAtomic` is a temp file plus a rename, so a
  // raw scan matches the sentence describing somebody ELSE's write and reports
  // a violation that does not exist. Also caught on this suite's first run.
  const shellFiles = ['tray-model.js', 'tray-menu.js', 'tray-icon.js', 'background-mode.js', 'state-watch.js'];
  const shellSrc = shellFiles.map((f) => stripJsComments(read(path.join(DESKTOP, 'lib', f)))).join('\n');
  ok(/export function buildTrayModel/.test(shellSrc) && /export function createStateWatcher/.test(shellSrc),
    'CONTROL — the stripped bundle still contains real code from more than one file');
  ok(!/writeFile|saveWorkingState|appendFile|rmSync|unlink/.test(shellSrc),
    'NO tray module writes anything — the widget is an OBSERVER, and the store\'s single-writer property is what makes its sync layout safe');
  ok(!/from ['"].*\/src\//.test(shellSrc) && !/require\(['"].*src\//.test(shellSrc),
    'and no tray module imports from src/, so the offline suite can execute all of them');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 main.js source scan — WEAK BY CONSTRUCTION, and labelled as such');
//
// Everything above executes real code. This section cannot: Electron is not
// installed, so `main.js` can only be read as text. It proves a line was
// WRITTEN and nothing about what it does.
{
  const src = stripJsComments(read(path.join(DESKTOP, 'main.js')));
  ok(/new Tray\(/.test(src),
    'the Tray is constructed in main.js — Apple documents status items owned by a SECOND executable failing to appear at all, and not even reaching the "Allow in the Menu Bar" list');
  ok(/setTemplateImage\(true\)/.test(src),
    'setTemplateImage(true) is called — correct pixels are necessary and not sufficient');
  ok(!/tray\.setTitle/.test(src),
    'the tray carries NO TITLE: a relative age in the bar either goes stale or needs a wake-up every minute forever, and menu bar width is the resource that makes an icon vanish behind the notch');
  ok(/mouse-enter/.test(src), 'hover re-renders, so the ages are exact at the moment the menu is about to open');
  ok(/tray\.on\('mouse-enter', renderTrayFromSnapshot\)/.test(src),
    'and hover calls the SNAPSHOT renderer — no index read and no network on a gesture the user did not commit to');
  ok(/tray\.on\('click'[\s\S]{0,80}refreshTraySummary/.test(src),
    'a click, which IS a deliberate act, is where the index read happens');
  ok(!/setInterval\(/.test(src),
    'main.js starts no interval of its own — the only periodic thing in the design is the 5-minute fallback inside lib/state-watch.js');
  ok(/applyBackgroundMode\(await readBackgroundMode\(\)\)/.test(src),
    'the mode is read and applied before the window is created, and never waited on from the renderer');
  ok(/startConfigWatch\(/.test(src),
    'the config file is watched so a Settings flip takes effect without a restart');
  ok(/stopTray[\s\S]{0,400}stateWatcher\.stop\(\)/.test(src),
    'turning the tray off stops the watch — the feature must not keep costing after it is switched off');
  ok(!/registerDesktopHost\([\s\S]{0,400}backgroundMode/.test(src),
    'no attempt is made to register a backgroundMode hook: registerDesktopHost THROWS on an unknown name, and its frozen list has four entries');
  ok(/JSON\.stringify\(project/.test(src),
    'the project name is JSON-serialised into the injected script, never interpolated into a CSS selector');
  ok(/dataset\.memProject === want/.test(src),
    'and it is compared as a STRING against the dataset, so a project name cannot become code in the app\'s own origin');

  // The quit guard must be untouched by this feature.
  const raw = read(path.join(DESKTOP, 'main.js'));
  ok(/app\.on\('before-quit'/.test(raw) && /decideQuit\(status\)/.test(raw),
    'the existing before-quit guard is still there and still runs decideQuit()');
  const quitDecision = read(path.join(DESKTOP, 'lib', 'quit-decision.js'));
  ok(/safeToQuit === null/.test(quitDecision),
    'and quit-decision.js still treats a null safeToQuit as its own case — this feature changed none of it');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failed === 0 ? '✓' : '✗'} test-tray-shell: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
