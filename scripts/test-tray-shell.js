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
 *   §2b  ages are RE-DERIVED at the render clock, not read out of the snapshot
 *   §2c  a collision is announced ONCE, and the match is STRUCTURAL
 *   §2d  the standing brief reaches a surface, and it is the tooltip
 *   §10  cross-file couplings, read-only
 *   §11  main.js source scan, and what is NOT enforced
 *   §12  the multi-machine signal fires — on a menu open, and nowhere else
 *   §13  main.js wiring for that check — source scan, weak like §11
 *   §14  the width budget: the arithmetic, and what the answer is sensitive to
 *   §15  the READER's view — the configuration the maintainer actually runs
 *   §16  every label fits its budget, and nothing it removed is unreachable
 *   §17  sections, the two pictures, and the items that are now reachable
 *   §18  main.js wiring for the theme and the images — source scan, weak
 *   §19  cross-file pins against the modules that DRAW the two pictures
 *   §20  the topic-first budget, over three fixtures including the READER'S
 *   §21  line two: whole-token dropping, and the two warnings that outrank prose
 *   §22  the per-row submenu, the headline's second line, and the new notice
 *   §23  main.js wiring for the submenu — source scan, weak like §11
 *   §24  the collision is decided over the WHOLE ROW, and the minute ceiling
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

let model, menu, icon, mode, watchMod, remote;
try {
  model = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  menu = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
  remote = await import(path.join(DESKTOP, 'lib', 'tray-remote.js'));
  icon = await import(path.join(DESKTOP, 'lib', 'tray-icon.js'));
  mode = await import(path.join(DESKTOP, 'lib', 'background-mode.js'));
  watchMod = await import(path.join(DESKTOP, 'lib', 'state-watch.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the tray modules: ${err.message}`);
  process.exit(1);
}

const NOOPS = {
  onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {},
  // Required since the per-row submenu landed: every handler is refused at
  // BUILD time rather than at click time, so a suite that omits one gets an
  // exception here instead of a menu that silently does nothing in front of a
  // user weeks later.
  onRowAction() {},
};
const NOW = new Date('2026-08-31T14:32:00');

/** The absolute timestamp a row of the given age carries, as the data layer
 *  emits it: `chooseClock()` puts the agent's `writtenAt` OR the file's mtime
 *  into one `writtenAt` field, and `ageSource` says which. Both are absolute,
 *  which is what lets the model re-derive an age at render time. */
function atAge(seconds, base = NOW) {
  return new Date(base.getTime() - seconds * 1000).toISOString();
}

/** One realistic summary. Every name here is INVENTED — this is a public
 *  repository and no real machine, project or host name may appear in it.
 *
 *  Every row carries BOTH `writtenAt` and `writtenAgeSeconds`, and that is the
 *  real contract rather than a convenience: the fixture used to carry only the
 *  age, which is a shape `getTraySummary()` cannot produce, and a model that
 *  read the age verbatim looked correct against it forever. §2b drives the
 *  same fixture at two different clocks, which is what the age alone made
 *  impossible to test. */
function summary(over = {}) {
  return {
    ok: true,
    lastSave: { project: 'alpha', scope: 'main', writtenAt: atAge(30), writtenAgeSeconds: 30, ageSource: 'agent' },
    scopes: [
      // `isThisHost` rides beside `isThisMachine` because the REAL producer
      // emits both on every row (`...ident` in tray-summary.js), and the two
      // answer different questions — which INSTALLATION, and which COMPUTER.
      // A fixture carrying only the first is the writer's view, which is the
      // one configuration in which the reader's-view defect is invisible.
      { project: 'alpha', scope: 'main', machine: 'laptop-a1b2c3', harness: 'harness-one',
        model: 'opus-4-6',
        writtenAt: atAge(30), writtenAgeSeconds: 30, ageSource: 'agent', headline: 'wired the tray bounds',
        isThisMachine: true, isThisHost: true, harnessShared: false },
      { project: 'alpha', scope: 'research', machine: 'laptop-a1b2c3', harness: 'harness-two',
        model: 'opus-4-6',
        writtenAt: atAge(1080), writtenAgeSeconds: 1080, ageSource: 'agent', headline: 'redid the section',
        isThisMachine: true, isThisHost: true, harnessShared: true },
      { project: 'beta', scope: 'main', machine: 'studio-9f8e7d', harness: 'harness-two',
        model: 'opus-4-6',
        writtenAt: atAge(10800), writtenAgeSeconds: 10800, ageSource: 'file', headline: 'rewrote the serialiser',
        isThisMachine: false, isThisHost: false, harnessShared: false },
    ],
    brief: null,
    remote: null,
    warnings: [],
    ...over,
  };
}

/** The REAL `harness-collision` warning, in the exact shape
 *  `src/brain/tray-summary.js` emits it. §2c pins the message against that
 *  file's own source, so this cannot quietly drift into a fiction the way the
 *  hand-written string it replaces did. */
function collisionWarning(project, scope) {
  return {
    code: 'harness-collision',
    message: `Two agent tools are writing ${project} · ${scope}.`,
    project, scope, machine: 'laptop-a1b2c3', harnesses: ['harness-one', 'harness-two'],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control — the modules really loaded');
ok(typeof model.buildTrayModel === 'function', 'buildTrayModel is a function');
ok(typeof menu.buildTrayMenuTemplate === 'function', 'buildTrayMenuTemplate is a function');
ok(typeof icon.trayIconPngs === 'function', 'trayIconPngs is a function');
ok(typeof mode.resolveTrayPlan === 'function', 'resolveTrayPlan is a function');
ok(typeof watchMod.createStateWatcher === 'function', 'createStateWatcher is a function');
ok(typeof remote.decideRemoteCheck === 'function', 'decideRemoteCheck is a function');

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
  // ── REVERSED: THE SLOT MOVED TO LINE TWO ─────────────────────────────
  //
  // WAS: these four read `m.rows[N].label`. Line one now carries the scope
  // topic and the age and NOTHING ELSE, because the photograph that produced
  // this release showed an identity clipped to `project…` beside an intact
  // 22-character machine name — the tail was composed at full length and the
  // identity got the remainder. The slot itself is unchanged in MEANING; it is
  // on the SUBLABEL, which macOS draws in a smaller face and which therefore
  // has the room the label did not.
  // ── LAYOUT A (v3.74.0): THE HARNESS IS ON LINE ONE, ALWAYS ────────────
  //
  // A row IS a (project × harness) now, so the harness is part of its identity
  // and is never dropped by a drop-constant rule: `alpha · harness-one · just
  // now`. Line two carries the model and the agent's sentence; a foreign
  // row's machine rides there, exactly as before.
  ok(m.rows[0].label === 'alpha · harness-one · just now', 'a row names project, harness and age on LINE ONE');
  ok(!m.rows[0].sublabel.includes('harness-one'), '…and does not repeat the harness on line two');
  ok(!m.rows[0].sublabel.includes('laptop'), 'a LOCAL row does NOT show the machine — it is constant, and therefore noise');
  ok(m.rows[2].sublabel.includes('studio'), 'a REMOTE row shows the machine');
  // ── REVERSED, AND THE ARGUMENT IS THE LAYOUT ─────────────────────────
  //
  // WAS: a remote row must NOT name a harness, because the slot held EITHER a
  // harness OR a machine, so a harness on a foreign row read as "that tool is
  // running HERE".
  //
  // Line two is not one slot; it is a list, and the machine is IN it. `opencode
  // · talis-mac-mini` cannot be misread as a local tool, because the computer
  // it ran on is the very next token. What the old rule protected against was
  // an AMBIGUITY that the layout has removed, and continuing to suppress the
  // harness would now drop a real fact for a reason that has stopped applying.
  //
  // The rule that survives verbatim: the machine on a foreign row is decided by
  // `isThisHost` and is never dropped while the rows disagree about it.
  ok(m.rows[2].label.startsWith('beta · harness-two · '),
    'a REMOTE row names its harness on line one too — the machine on line two removes the "that tool runs HERE" ambiguity');

  // THE PRECONDITION THE FOUR ASSERTIONS ABOVE NOW CARRY, made explicit so a
  // future fixture edit cannot make them vacuous in silence. Since the width
  // compaction, a harness is shown only while it DISTINGUISHES something: with
  // one harness across every local row it is dropped as noise, which is the
  // whole point of the lever and is asserted in test-tray-pulse-strip.js §8.
  // This fixture has two, so "a LOCAL row shows the harness" is a real test of
  // the slot rather than a test of a token that is always printed.
  ok(new Set(model.buildTrayModel(summary(), { now: NOW }).rows
    .filter((r) => r.isThisMachine).map((r) => r.harness)).size > 1,
    'CONTROL — this fixture really does carry more than one local harness, which is what makes the slot assertions above non-vacuous');

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
  // v3.48.0: the identity survives an unknown age. Which PROJECT is being built
  // is known even when when it was last saved is not, and reporting the absence
  // of one fact as the absence of both would be the honesty rule inverted.
  eq(withNull.headline.text, 'Last save: gamma · unknown tool · time unknown', 'in words, not as a blank — and a save that named no tool says so');

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
    'Project context could not be read',
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
section('§2b ages are RE-DERIVED at the render clock, not read out of the snapshot');
//
// THE DEFECT THIS SECTION EXISTS FOR, reproduced as the first assertion:
// `buildTrayModel` read `writtenAgeSeconds` straight out of the summary, so
// driving ONE snapshot at two clocks forty minutes apart produced the
// identical "Last save · 4 min ago" both times WHILE `renderedAtText` moved.
// `mouse-enter` re-renders from the in-memory snapshot precisely so a hover
// costs no I/O, so that is the ordinary path and not an edge case.
//
// It inverts the purpose of the absolute stamp, which tray-menu.js justifies
// as the thing that makes a dead watch visible: the stamp said "fresh" over an
// age that was not.
{
  const snap = summary();
  const later = new Date(NOW.getTime() + 40 * 60 * 1000);
  const a = model.buildTrayModel(snap, { now: NOW });
  const b = model.buildTrayModel(snap, { now: later });

  ok(a.renderedAtText !== b.renderedAtText,
    'CONTROL — the absolute stamp really does move between the two renders');
  eq(a.headline.text, 'Last save: alpha · harness-one · just now', 'at the first clock the headline reads the true age');
  eq(b.headline.text, 'Last save: alpha · harness-one · 40 min ago',
    'FORTY MINUTES LATER, from the SAME snapshot, the headline has moved — this is the defect');
  ok(a.headline.text !== b.headline.text,
    '…so the age under the stamp can no longer be stale while the stamp is fresh');

  // Rows move too, and the bucket and the glyph move with them.
  eq(a.rows[0].ageText, 'just now', 'a row reads its true age at the first clock');
  eq(b.rows[0].ageText, '40 min ago', '…and its true age at the second');
  eq(a.glyph, 'live', 'the glyph is live inside the window');
  eq(b.glyph, 'idle', '…and the SAME snapshot rendered later is idle — no new read required');

  // ageSource is untouched by re-deriving. Recomputing changes WHEN the age
  // was measured, never WHICH CLOCK it came from.
  ok(b.rows[2].ageText.startsWith('changed '),
    'an ageSource:file row is re-derived too, and KEEPS its "changed" wording');
  eq(b.rows[2].ageText, 'changed 3 hr ago', '…against the new clock, not the old one');

  // THE LIMIT, and it is the one the brief names: do not invent precision.
  const noStamp = model.buildTrayModel(summary({
    lastSave: null,
    scopes: [{ project: 'g', scope: 'main', machine: 'laptop-a1b2c3', isThisMachine: true,
      writtenAt: null, writtenAgeSeconds: null, ageSource: null }],
  }), { now: later });
  eq(noStamp.rows[0].ageText, 'time unknown',
    'a row with NO timestamp at all stays UNKNOWN — re-deriving is a way to be more accurate, never a way to manufacture a fact');

  // A snapshot age with no timestamp is the best available and is used as-is.
  const ageOnly = model.buildTrayModel(summary({
    lastSave: null,
    scopes: [{ project: 'g', scope: 'main', machine: 'laptop-a1b2c3', isThisMachine: true,
      writtenAgeSeconds: 600, ageSource: 'agent' }],
  }), { now: later });
  eq(ageOnly.rows[0].ageText, '10 min ago',
    'with an age but no timestamp the snapshot number is used unchanged — stale, but the best there is');

  // The pure helper, driven directly across its whole precedence ladder.
  const t = Date.parse('2026-08-31T14:32:00.000Z');
  eq(model.effectiveAgeSeconds('2026-08-31T14:22:00.000Z', null, t), 600, 'a timestamp wins');
  eq(model.effectiveAgeSeconds('2026-08-31T14:22:00.000Z', 5, t), 600, '…over a disagreeing snapshot age');
  eq(model.effectiveAgeSeconds(null, 5, t), 5, 'with no timestamp the snapshot age is the fallback');
  eq(model.effectiveAgeSeconds('not a date', 5, t), 5, '…and so it is for an unparseable one');
  eq(model.effectiveAgeSeconds(null, null, t), null, 'with neither, null — never 0');
  eq(model.effectiveAgeSeconds(null, -1, t), null, 'a negative snapshot age is refused, not clamped into a lie');
  // CLOCK SKEW. Two machines' clocks differ; a handoff written "in the future"
  // must not collapse to "time unknown".
  eq(model.effectiveAgeSeconds('2026-08-31T14:32:03.000Z', null, t), 0,
    'a timestamp a few seconds in the FUTURE clamps to 0, exactly as working-state.js does');
  eq(model.formatAge(model.effectiveAgeSeconds('2026-08-31T14:32:03.000Z', null, t)), 'just now',
    '…which renders as "just now" rather than as an absence');

  // The arithmetic is the STORE'S OWN, not a second opinion. Pinned against
  // working-state.js's source so a change there is visible here.
  const wsSrc = read(path.join(ROOT, 'src', 'brain', 'working-state.js'));
  ok(/Math\.max\(0,\s*Math\.round\(\(now - Date\.parse\(/.test(wsSrc),
    'the store still derives ages as Math.max(0, Math.round((now - Date.parse(at)) / 1000)) — the expression this model re-runs');
  const tmSrc = read(path.join(DESKTOP, 'lib', 'tray-model.js'));
  ok(/Math\.max\(0,\s*Math\.round\(\(nowMs - ms\)\s*\/\s*1000\)\)/.test(tmSrc),
    '…and the model re-runs that same expression rather than inventing its own');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2c a collision is announced ONCE, and the match is STRUCTURAL');
//
// THE DEFECT: `collisionNotices()` suppressed a supplied warning only when it
// matched `/harness/i`. The ONLY producer is tray-summary.js's
// `harness-collision`, whose message reads "Two agent tools are writing …" —
// the word "harness" appears nowhere in it. So the suppression was dead
// against the sole case it exists for, and every collision emitted BOTH lines,
// burning 2 of the 4 notice slots to say one thing twice.
//
// It passed its own test because the fixture was a hand-written string that
// happened to contain "harnesses". The fixture was the fiction.
{
  // THE PRODUCER'S REAL WORDING, read off disk. If this reds, the message was
  // reworded — which is exactly the event that silently broke the old regex.
  const tsSrc = read(path.join(ROOT, 'src', 'brain', 'tray-summary.js'));
  ok(tsSrc.includes("code: 'harness-collision'"),
    'the data layer still emits the code this model matches on');
  const msgMatch = tsSrc.match(/code: 'harness-collision',[\s\S]{0,400}?message: `([^`]+)`/);
  ok(msgMatch !== null, 'CONTROL — the real message was found in the producer');
  const realMessage = msgMatch ? msgMatch[1] : '';
  ok(/Two agent tools are writing/.test(realMessage),
    `CONTROL — and it is the sentence expected: "${realMessage}"`);

  // THE DEFECT, ASSERTED DIRECTLY: the old mechanism could not have worked.
  ok(!/harness/i.test(realMessage),
    'THE DEFECT — the real warning contains no "harness", so the old /harness/i suppression was DEAD against its only case');
  ok(realMessage.includes('${c.projectLabel}') && realMessage.includes('${c.scope}'),
    '…and it does name the scope, so the failure was the regex and not the data');

  // THE FIX: the real warning shape now suppresses the derived line.
  const withReal = model.buildTrayModel(summary({
    warnings: [collisionWarning('alpha', 'research')],
  }), { now: NOW });
  // MATCHED ON `full`, NOT ON `text`. `text` is the WIDTH-BUDGETED rendering
  // and is clipped at PLAIN_LABEL_CHARS; `full` is the sentence. A content
  // assertion against a budgeted string would start passing or failing with the
  // font assumption, which is not what any of these are about. §14 asserts the
  // budget itself, and that the full form reaches the item's tooltip.
  const noticeText = (n) => n.full || n.text;
  const collisionLines = withReal.notices.filter((n) =>
    /writing/.test(noticeText(n)) && /alpha/.test(noticeText(n)) && /research/.test(noticeText(n)));
  eq(collisionLines.length, 1, 'the REAL producer warning now suppresses the derived line — exactly ONE notice');
  eq(collisionLines.length ? collisionLines[0].text : '(no collision notice at all)',
    'Two tools are writing alpha / research',
    '…in the APP\'s words (v3.74.0) — composed from the fields, whichever source said it');

  // A collision warning about a DIFFERENT scope must not suppress anything.
  const other = model.buildTrayModel(summary({
    warnings: [collisionWarning('alpha', 'somewhere-else')],
  }), { now: NOW });
  eq(other.notices.filter((n) => /writing/.test(n.full || n.text)).length, 2,
    'a collision warning naming a DIFFERENT scope suppresses nothing — both facts are real');

  // With NO supplied warning the derived line still fires: that is what it is for.
  eq(model.buildTrayModel(summary(), { now: NOW })
    .notices.filter((n) => n.kind === 'collision').length, 1,
    'with no supplied warning the derived line is still emitted');

  // THE MILDER INSTANCE OF THE SAME SHAPE — a truncated list said so twice.
  const truncated = model.buildTrayModel(summary({
    total: 40,
    warnings: [{ code: 'scopes-truncated', message: 'Showing the 8 most recent of 40 saved work-streams.', shown: 8, total: 40 }],
    scopes: Array.from({ length: 20 }, (_, i) => ({
      project: 'p', scope: 's' + i, machine: 'laptop-a1b2c3', harness: 'h',
      writtenAt: atAge(i * 60), writtenAgeSeconds: i * 60, ageSource: 'agent', isThisMachine: true,
    })),
  }), { now: NOW });
  // v3.74.0: the rows come from `projects[].latest` when the producer
  // supplies it, and then the 40-pair window the warning is about is not what
  // the menu draws — so it is not said. Without `latest` the rows ARE that
  // window, and the warning stays.
  eq(truncated.notices.filter((n) => n.code === 'scopes-truncated').length, 1,
    'rows read from the truncated scopes[] window → the scopes-truncated warning IS said');
  const withLatest = model.buildTrayModel(summary({
    warnings: [{ code: 'scopes-truncated', message: 'Showing the 8 most recent of 40 saved work-streams.' }],
    projects: summary().scopes.map((sc) => ({ domain: null, project: sc.project, latest: [{ ...sc, harnessId: sc.harness, harnessRaw: sc.harness }] })),
  }), { now: NOW });
  eq(withLatest.notices.filter((n) => n.code === 'scopes-truncated').length, 0,
    '…and when every listed project came with `latest`, it is not — the truncation hides nothing the menu draws');

  // A coded warning this model has no opinion about passes through untouched.
  const passthrough = model.buildTrayModel(summary({
    warnings: [{ code: 'unlisted-entries', message: '2 folders on disk could not be listed.' }],
  }), { now: NOW });
  ok(passthrough.notices.some((n) => n.code === 'unlisted-entries'),
    'an unrelated coded warning is passed through unchanged');

  // Bare strings still work — main.js pushes them on its own failure paths.
  const bare = model.buildTrayModel({ ok: false, scopes: [], warnings: ['Could not read project context: EACCES'] },
    { now: NOW });
  ok(bare.notices.some((n) => (n.full || n.text).includes('EACCES')),
    'a bare STRING warning still renders — main.js emits those and they carry no code');

  // THE TEXT BACKSTOP'S OWN JOB, and it needed finding: mutating it away first
  // came back GREEN, because the structural path covers every CODED pair. What
  // it and only it covers is a repeated message with no code to match on —
  // which is the same "say one thing twice in a four-slot list" defect §2c is
  // about, one layer down. Left in place because it has a case, and asserted
  // so the next reader does not have to rediscover which.
  const dupes = model.buildTrayModel({
    ok: true, scopes: [], warnings: ['the same sentence twice', 'the same sentence twice'],
  }, { now: NOW });
  eq(dupes.notices.filter((n) => (n.full || n.text) === 'the same sentence twice').length, 1,
    'two IDENTICAL uncoded warnings collapse to one notice — the backstop\'s only reachable job');
  // And a bare string identical to the DERIVED collision line collapses too.
  const echo = model.buildTrayModel(summary({
    warnings: ['Two harnesses are writing alpha · research'],
  }), { now: NOW });
  eq(echo.notices.filter((n) => (n.full || n.text) === 'Two harnesses are writing alpha · research').length, 1,
    'an uncoded warning that happens to echo the derived line exactly is not printed beside it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2d the standing brief reaches a surface, and it is the tooltip');
//
// `getTraySummary()` pays a `stat` for the brief on every read and NOTHING
// rendered it — the unwired-field shape this project has an allergy to. The
// menu is not the answer (the brief is Tier C: it changes on the order of
// weeks and does not earn one of eight rows, and the rendered panel that would
// give it one is a later phase). The tooltip costs no row and no menu-bar
// width, and the value is already in the model.
{
  const withBrief = model.buildTrayModel(summary({
    brief: { project: 'alpha', updatedAt: atAge(45 * 86400), ageSeconds: 45 * 86400 },
  }), { now: NOW });
  // `!== null` WOULD HAVE PASSED ON `undefined`, and that is not a nitpick:
  // the first version of this assertion said so, and mutation M9 — deleting
  // `brief` from the returned model — went GREEN through it and then CRASHED
  // the suite two lines later on `.ageText` of undefined. A crash names no
  // expectation and, worse, leaves the tally unwritten, so a harness reading
  // the summary line sees nothing at all (the v3.24.1 shape). Every read below
  // is guarded for the same reason.
  const briefIsObject = !!withBrief.brief && typeof withBrief.brief === 'object';
  ok(briefIsObject, 'the model now carries the brief instead of discarding it');
  eq(briefIsObject ? withBrief.brief.ageText : '(no brief on the model)', '1 month ago', '…as an AGE');

  const tip = menu.trayToolTip(withBrief);
  // v3.48.0: the headline names the PROJECT, because "which thing am I
  // building" stopped having one answer per domain.
  ok(tip.startsWith('The Curator — Last save: alpha · harness-one'), 'the tooltip leads with the last save, worded as one');
  ok(tip.includes('Brief updated 1 month ago'), '…and now also answers the second question the maintainer asks');
  ok(!/by an agent/.test(tip),
    'a brief with no recorded author says nothing about one — an absent provenance is not "you wrote it"');

  // ── AND WHEN AN AGENT WROTE IT, THE CLAUSE SAYS SO ──────────────────
  //
  // From v3.48.0 an agent may write the standing brief, on the owner's explicit
  // instruction, and the store records that. The brief is the ONE tier a model
  // is told to follow rather than verify, so a clause that hid its authorship
  // would hide the fact that decides how much authority it carries.
  const agentBrief = model.buildTrayModel(summary({
    brief: { domain: 'alpha', project: 'alpha', updatedAt: atAge(3 * 86400),
      ageSeconds: 3 * 86400, authoredBy: 'agent' },
  }), { now: NOW });
  ok(menu.trayToolTip(agentBrief).includes('Brief updated 3 days ago by an agent'),
    'an agent-written brief is named as one, in the same clause as its age');
  const humanBrief = model.buildTrayModel(summary({
    brief: { domain: 'alpha', project: 'alpha', updatedAt: atAge(3 * 86400),
      ageSeconds: 3 * 86400, authoredBy: 'human' },
  }), { now: NOW });
  ok(!/by an agent/.test(menu.trayToolTip(humanBrief)),
    '…and a brief the OWNER wrote carries no such clause — the default needs no announcement');
  ok(!/stale|old|out of date|should/i.test(tip),
    'it states a MEASUREMENT and never a judgement about the user\'s own hand-authored document');

  // Re-derived like everything else.
  const later = new Date(NOW.getTime() + 40 * 86400 * 1000);
  const laterBrief = model.buildTrayModel(summary({
    brief: { project: 'alpha', updatedAt: atAge(45 * 86400), ageSeconds: 45 * 86400 },
  }), { now: later }).brief;
  eq(laterBrief ? laterBrief.ageText : '(no brief on the model)', '2 months ago',
    'the brief\'s age is re-derived at the render clock too');

  // ABSENCE IS ABSENCE. A project with no standing brief is the ordinary case.
  const noBrief = model.buildTrayModel(summary(), { now: NOW });
  eq(noBrief.brief, null, 'no brief on disk means no brief in the model');
  ok(!/Brief/.test(menu.trayToolTip(noBrief)),
    '…and the tooltip simply does not mention it — no "Brief · unknown"');

  const unknownAge = model.buildTrayModel(summary({
    brief: { project: 'alpha', updatedAt: null, ageSeconds: null },
  }), { now: NOW });
  ok(!/Brief/.test(menu.trayToolTip(unknownAge)),
    'a brief whose age cannot be derived contributes NOTHING rather than "time unknown"');

  // The menu is untouched: this is a tooltip decision, not a menu decision.
  const flat = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(withBrief, NOOPS));
  ok(flat.every((i) => !/Brief/.test(i.label || '')),
    'the brief does NOT take a menu row — Tier C is honoured, not overturned');
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
  // Twenty scopes of one project by one tool: ONE row on the face; five of
  // its other scopes are its streams, and the other fourteen are COUNTED on
  // the row's "N more in Project Context…" — never silently dropped.
  eq(many.active.rows.length, 1, 'one project × one tool is ONE row, however many scopes it has');
  eq([many.active.rows[0].streams.length, many.active.rows[0].streamsHidden], [model.MAX_OTHER_STREAMS, 20 - 1 - model.MAX_OTHER_STREAMS],
    'its other scopes: five shown as streams, the rest counted');
  ok(menu.flattenTrayMenu(menu.buildTrayMenuTemplate(many, NOOPS)).some((i) => i.label === (20 - 1 - model.MAX_OTHER_STREAMS) + ' more in Project Context…' && typeof i.click === 'function'),
    '…and the count is an enabled item routed to Project Context');

  // THE FACT AND ITS ABSENCE.
  eq(model.remoteNotice(null), null, 'remote:null renders NOTHING — "we did not check" is not "you are up to date"');
  eq(model.remoteNotice({ ok: true, behindFiles: 0 }), null, 'zero waiting renders nothing');
  eq(model.remoteNotice({ ok: true, behindFiles: 2 }).text, '2 handoffs waiting on GitHub', 'a real count is a count');
  eq(model.remoteNotice({ ok: true, behindFiles: 1 }).text, '1 handoff waiting on GitHub', 'and it is singular when it is one');
  eq(model.remoteNotice({ ok: false, message: 'network is down' }).text, 'network is down',
    'a FAILED check says so — a third state, not folded into either of the others');
  eq(model.remoteNotice({ ok: false }).text, model.REMOTE_CHECK_FAILED,
    '…and it says so even with no message, rather than falling silent');
  ok(model.REMOTE_CHECK_FAILED.length <= model.PLAIN_LABEL_CHARS,
    'that default is WRITTEN to fit the width budget rather than clipped into it — an ellipsis lands on "handoffs", the word that carries the meaning');
  ok(/handoffs/.test(model.REMOTE_CHECK_FAILED), 'CONTROL: and it still says what is waiting');

  // Collisions.
  const coll = model.buildTrayModel(summary(), { now: NOW });
  ok(coll.notices.some((n) => n.kind === 'collision' && n.text === 'Two tools are writing alpha / research'),
    'harnessShared produces a collision line naming the scope');
  ok(coll.notices.every((n) => !/rename|split|should/i.test(n.full || n.text)),
    'and it proposes NO remedy — the fix is the user\'s and does not fit in six words');

  // The suppression itself is §2c's subject, driven against the REAL producer
  // shape. What is asserted here is only that a warning which does NOT name a
  // collision cannot suppress one — the old prose-matching version could, on
  // any sentence that happened to contain the word.
  const collNotSuppressed = model.buildTrayModel(summary({
    warnings: ['A harness log rotated'],
  }), { now: NOW });
  eq(collNotSuppressed.notices.filter((n) => n.kind === 'collision').length, 1,
    'an unrelated warning that merely contains "harness" does NOT suppress a real collision');

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

  // THE GLYPH'S WINDOW IS ITS OWN (120 s), and deliberately not the app's
  // 60-second `live` tier: see glyphLiveAge. The ROW's dot is the app's scale.
  eq([0, 59, 60, 119].map(model.glyphLiveAge), [true, true, true, true], 'glyph: live through 119 s — past the dot\'s 60 s live tier');
  eq([120, 600, null, -1].map(model.glyphLiveAge), [false, false, false, false], 'glyph: the 120 s boundary is exclusive, and no age is never live');
  eq(model.freshnessTier(90), 'recent', 'CONTROL — at 90 s the DOT says recent while the glyph still says live: two questions, two numbers');

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

  // ── LAYOUT A (v3.74.0): THE NEWEST SAVE IS THE FIRST ROW, SAID ONCE ────
  //
  // The "Working on" headline and its grey harness · model line are gone:
  // they said the newest save a second and third time, in the present tense
  // for a past event. With no pulse in this fixture, the Active header is the
  // first item and the newest save is the line under it — where, who, when.
  ok(!flat.some((i) => i.id === 'tray-headline' || i.id === 'tray-headline-where' || /^Working on/.test(i.label || '')),
    'no headline and no grey who-line anywhere in the menu');
  eq([items[0].id, items[0].type, items[0].label], [menu.ID_HEADER_ACTIVE, menu.MENU_HEADER_TYPE, 'Active · last 24 h'],
    'the first item is the "Active · last 24 h" header (the pulse sits above it when there is one)');
  eq(items[1].id, m.rows[0].id, 'the second is the NEWEST save\'s row');
  ok(/ · (just now|\d+ (min|hr|day|days|week|weeks|month|months|year|years) ago|time unknown)$/.test(items[1].label),
    `…"${items[1].label}", ending in the age, which is the token a clip may never take`);
  ok(items[1].enabled !== false, '…drawn at full contrast (never disabled)');

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

  // ── REVERSED, and the reason is the per-row submenu ──────────────────
  //
  // WAS: `rowItems.length === 3` over the FLATTENED template, and
  // `every(i => typeof i.click === 'function')`. Both were correct before rows
  // grew submenus and both are wrong after.
  //
  //  - `flattenTrayMenu` RECURSES, so each row now contributes itself plus a
  //    header and four actions — 18 nodes whose ids start with `tray-row-`, not
  //    3. The count is taken over the TOP LEVEL of the template instead, which
  //    is the thing "every row is a menu item" was ever about.
  //  - A submenu PARENT deliberately carries no `click`: on macOS a click on it
  //    opens the submenu, and a handler beside that is one nobody can predict.
  //    `Open in The Curator` is the first submenu item and carries it.
  const rowItems = t.filter((i) => typeof i.id === 'string' && /^tray-row-\d+$/.test(i.id));
  eq(rowItems.length, 3, 'every row is a TOP-LEVEL menu item');
  ok(rowItems.every((i) => typeof i.click !== 'function'),
    'and NONE of them carries a click — a submenu parent opens its submenu, so a handler beside that would fire unpredictably');
  ok(rowItems.every((i) => Array.isArray(i.submenu) && i.submenu.length === menu.ROW_ACTIONS.length + 1),
    'each row carries a submenu of its four actions under a header naming the work-stream');
  {
    let got = null;
    const t2 = menu.buildTrayMenuTemplate(m, { ...NOOPS, onOpenScope: (r) => { got = r; } });
    menu.flattenTrayMenu(t2).find((i) => i.id === menu.rowActionId(m.rows[2].id, menu.ID_ROW_OPEN)).click();
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

  // The icon's tooltip keeps the fast answer, so a hover answers without a click.
  ok(menu.trayToolTip(m).includes(model.HEADLINE_PREFIX), 'the icon tooltip carries the last save');
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
  // v3.65.0 (the Context package): the row is the shared sidebar component's
  // now, so the literal attribute string `data-mem-project="` no longer sits
  // in this file's source — the kit builds it from a `data: {'mem-project':
  // …}` option handed to renderSidebarRow. The property the tray depends on
  // (a `data-mem-project` attribute really reaching the DOM) is unchanged;
  // only where it is typed moved, so the pin reads the source for the key
  // the kit is handed.
  ok(/'mem-project':\s*p\.project/.test(memJs),
    'the memory view still passes mem-project through the sidebar kit\'s data option — '
    + 'the source of the data-mem-project attribute the shell matches a project row on');
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
  ok(/JSON\.stringify\(route\)/.test(src) && /JSON\.stringify\(bare\)/.test(src),
    'BOTH routing strings are JSON-serialised into the injected script, never interpolated into a CSS selector');
  ok(/dataset\.memProject === want/.test(src),
    'and it is compared as a STRING against the dataset, so a project name cannot become code in the app\'s own origin');
  // v3.48.0: the route is `<domain>/<project>`, with the bare project name as a
  // SECOND comparison so a window that has not been reloaded since the update
  // still lands on the right row instead of on an unfiltered view.
  ok(/dataset\.memProject === alt/.test(src),
    'and the bare project name is tried as a fallback, in the same string comparison');
  ok(/const hit = rows\.find\(\(el\) => el\.dataset\.memProject === want\)/.test(src),
    'the exact domain/project match is tried FIRST, so the fallback can never select another domain\'s project while the right one is on screen');

  // v3.64.0 — THE RAIL SHRINKS TO THREE ENTRIES (chat/domains/memory), and the
  // Context button (`data-view="memory"`) is one of the survivors. Nothing in
  // this file changes because of that — no view id crosses the process
  // boundary except through this one selector (P2's finding) — but the
  // coupling is worth re-checking on its own terms now that two of its five
  // siblings (`ingest`, `shared`) have left the rail: this asserts the shell
  // still targets `[data-view="memory"]` specifically, and still has a named,
  // reported failure mode rather than a silent one when that element is gone.
  ok(/document\.querySelector\("\[data-view=\\+"memory\\+"\]"\)/.test(src),
    'the injected script still targets [data-view="memory"] — the one rail id this shell reaches by DOM query rather than by any view-id string of its own (main.js carries no view-id literals at all, only this selector and the settings one in lib/menu.js)');
  ok(/if \(!rail\) return "no-view";/.test(src),
    '...and reports "no-view" rather than throwing or clicking null when the selector finds nothing — this is the return value Risk 4 exists for: a rail button silently gone must not silently do nothing');
  ok(/if \(landed === 'project' \|\| landed === 'view'\) return;/.test(src),
    'only "project" or "view" count as success; "no-view" (and any other value, including a caught executeJavaScript error) falls through to the error dialog below — the coupling cannot rot silently');
  ok(/dialog\.showErrorBox\(\s*'Could not open Project Context'/.test(src),
    'a rotted coupling shows a named, actionable dialog...');
  ok(/Open it with the Context button in the left-hand rail\./.test(src),
    '...whose remedy text still names "the Context button" — the caption that survives D-A, not "Agent memory" or a view id');

  // The quit guard must be untouched by this feature.
  const raw = read(path.join(DESKTOP, 'main.js'));
  ok(/app\.on\('before-quit'/.test(raw) && /decideQuit\(status\)/.test(raw),
    'the existing before-quit guard is still there and still runs decideQuit()');
  const quitDecision = read(path.join(DESKTOP, 'lib', 'quit-decision.js'));
  ok(/safeToQuit === null/.test(quitDecision),
    'and quit-decision.js still treats a null safeToQuit as its own case — this feature changed none of it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12 the multi-machine signal fires — on a menu open, and nowhere else');
//
// THE DEFECT: the `remote` line had exactly one feed, `noteRemoteStatus()`,
// called from `GET /api/sync/remote-status`, which the frontend drives from
// `refreshSyncRemoteBadgeIfVisible()` — and that DECLINES to fetch while
// `document.hidden`. With the window closed, which is the tray's normal state
// and the only state it exists for, no observation ever arrived and any
// existing one expired after five minutes. Nothing rendered wrongly; the
// feature built for "another machine sent you something" simply never fired.
{
  const nowMs = Date.parse('2026-08-31T14:32:00.000Z');
  const MIN = remote.TRAY_REMOTE_MIN_INTERVAL_MS;

  // THE TRIGGER SET, and the exclusions are the design.
  eq([...remote.REMOTE_CHECK_TRIGGERS], ['click', 'right-click'],
    'a menu OPEN is the only trigger');
  ok(!remote.REMOTE_CHECK_TRIGGERS.includes('mouse-enter'),
    'HOVER IS NOT A TRIGGER — the pointer crosses the icon on the way elsewhere, and main.js re-renders on it precisely because that costs nothing');
  eq(remote.decideRemoteCheck({ trigger: 'mouse-enter', nowMs }).check, false, '…and the decision refuses it');
  eq(remote.decideRemoteCheck({ trigger: 'mouse-enter', nowMs }).reason, 'not-a-menu-open',
    '…naming itself, so a refusal can be told from a rate limit');
  eq(remote.decideRemoteCheck({ trigger: 'watch', nowMs }).check, false,
    'a filesystem watch is not a trigger either — a LOCAL save says nothing about the remote, and it fires unattended');

  // THE FIX: a click with no prior attempt checks.
  const first = remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: null, inFlight: false });
  eq(first.check, true, 'a click with nothing recorded runs the check — this is the defect closing');
  eq(first.reason, 'check', '…and says so');
  eq(remote.decideRemoteCheck({ trigger: 'right-click', nowMs }).check, true, 'so does a right-click');

  // BOUNDED. Never a timer, and never unbounded clicking.
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: nowMs - 1000 }).check, false,
    'a second click a second later is refused');
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: nowMs - 1000 }).reason, 'rate-limited', '…as rate-limited');
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: nowMs - MIN + 1 }).check, false,
    'refused right up to the floor');
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: nowMs - MIN }).check, true,
    'and allowed exactly AT it — the boundary is asserted from both sides');
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: null, inFlight: true }).check, false,
    'one already running refuses a second — getRemoteStatus() would COALESCE, which is right for a route and wrong here');
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: null, inFlight: true }).reason, 'in-flight', '…and says which');

  // A clock that went BACKWARDS must not open the floodgates.
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs, lastAttemptMs: nowMs + 3600_000 }).check, false,
    'a backwards clock jump is treated as rate-limited — the worst case is one check skipped, never a burst');
  eq(remote.decideRemoteCheck({ trigger: 'click', nowMs: NaN, lastAttemptMs: null }).check, false,
    'no usable clock means no check');

  // Renderability, which is what stops a pointless re-render.
  eq(remote.remoteAnswerIsRenderable({ configured: true, behindFiles: 0 }), true, 'a configured answer is renderable');
  eq(remote.remoteAnswerIsRenderable({ configured: false }), false,
    'an UNCONFIGURED install is not — there is no remote, and re-rendering the menu under an open one costs the user something even when the data costs nothing');
  for (const junk of [null, undefined, 'x', 0, []]) {
    eq(remote.remoteAnswerIsRenderable(junk), false, `garbage is not renderable (${JSON.stringify(junk) ?? String(junk)})`);
  }

  // ELECTRON-FREE AND src-FREE, like every module in this folder — which is
  // the property that let the suite EXECUTE all of the above.
  const remoteSrc = read(path.join(DESKTOP, 'lib', 'tray-remote.js'));
  ok(!/from ['"]electron['"]/.test(remoteSrc), 'tray-remote.js imports nothing from Electron');
  ok(!/from ['"].*\/src\//.test(remoteSrc), '…and nothing from src/');
  ok(!/child_process|require\(|\bfetch\(/.test(stripJsComments(remoteSrc)),
    '…and runs no subprocess and issues no request of its own — it decides, main.js does');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§13 main.js wiring for the remote check — SOURCE SCAN, weak like §11');
{
  const src = stripJsComments(read(path.join(DESKTOP, 'main.js')));

  ok(/tray\.on\('click'[\s\S]{0,120}maybeCheckRemote\('click'\)/.test(src),
    'a click asks about the other machines');
  ok(/tray\.on\('right-click'[\s\S]{0,120}maybeCheckRemote\('right-click'\)/.test(src),
    '…and so does a right-click');
  // HOVER DOES NOT. Asserted two ways, because a loose window regex here would
  // match the `click` line two lines below and prove nothing.
  ok(!/tray\.on\('mouse-enter',[^;]*maybeCheckRemote/.test(src),
    'the mouse-enter registration itself does not reach the remote check — asserted here as well as in §12, because this is the file that could reintroduce it');
  // Every trigger main.js actually passes, compared as a SET against the
  // module's own allow-list. A new call site with a new trigger string reds
  // this even if it is written somewhere the regexes above do not look.
  const passedTriggers = [...src.matchAll(/maybeCheckRemote\('([^']+)'\)/g)].map((m) => m[1]).sort();
  eq([...new Set(passedTriggers)], [...remote.REMOTE_CHECK_TRIGGERS].sort(),
    'the triggers main.js passes are EXACTLY the module\'s allow-list — no fourth call site, and no hover');
  ok(passedTriggers.length >= 2, `CONTROL — trigger call sites were really found (${passedTriggers.length})`);
  ok(!/setInterval\(/.test(src),
    'STILL no interval in main.js — the check must never fire on a timer while nothing is watching');
  ok(!/setTimeout\([\s\S]{0,80}maybeCheckRemote/.test(src),
    '…and it is not smuggled in behind a setTimeout either');

  // It goes through the EXISTING bounded path rather than issuing its own git.
  ok(/getRemoteStatus\s*=\s*sync\.getRemoteStatus/.test(src),
    'the check is brain/sync.js\'s own getRemoteStatus — so it inherits the TTL cache, the in-flight memo and gitFetch()\'s process-wide gate');
  ok(!/child_process|execFile|spawn\(/.test(src.replace(/[\s\S]*?function maybeCheckRemote/, '').slice(0, 2000)),
    '…and main.js runs no git of its own');
  ok(/remoteCheckLastAttemptMs = Date\.now\(\)[\s\S]{0,120}await getRemoteStatus\(\)/.test(src),
    'the attempt is stamped BEFORE the await — the floor bounds ATTEMPTS, so a slow failing check does not leave the window open');
  ok(/stopTray[\s\S]{0,600}remoteCheckLastAttemptMs = null/.test(src),
    'turning the tray off forgets the rate-limit state');
  ok(!/stopTray[\s\S]{0,600}remoteCheckInFlight = false/.test(src),
    '…but NOT the in-flight flag: a check still running owns that, and clearing it would let a second start alongside the first');

  // THE PROPERTY THE WHOLE DESIGN RESTS ON, pinned against sync.js's source.
  // Read-only; this suite must never edit that file.
  const syncSrc = read(path.join(ROOT, 'src', 'brain', 'sync.js'));
  const countRawFetches = (text) => (stripJsComments(text).match(/git\(`fetch /g) || []).length;
  // CONTROL. These four pins are over a file this change is forbidden to edit,
  // so they were never mutation-tested by breaking their subject. The counter
  // is instead proven capable of other answers against synthetic input — a
  // count that can only ever return 1 would assert nothing.
  eq(countRawFetches('nothing here'), 0, 'CONTROL — the raw-fetch counter can return 0');
  eq(countRawFetches('git(`fetch a`); git(`fetch b`);'), 2, 'CONTROL — …and 2, so counting 1 is a measurement');
  const rawFetches = countRawFetches(syncSrc);
  eq(rawFetches, 1,
    'brain/sync.js still has exactly ONE raw fetch invocation — the one inside gitFetch(), which is what makes the gate a CLASS invariant rather than a per-call-site one');
  ok(/_fetchGate\.then\(runOne, runOne\)/.test(syncSrc),
    'gitFetch() still chains on BOTH arms, so one failed fetch cannot wedge every later one');
  ok(/_remoteInFlight/.test(syncSrc) && /REMOTE_CHECK_TTL_MS/.test(syncSrc),
    'getRemoteStatus() still carries the in-flight memo and the TTL cache this trigger relies on for its bounds');
  ok(/remoteChecked: false/.test(syncSrc) && /behindFiles: null/.test(syncSrc),
    'and a failed check still degrades to "we could not tell" rather than to a reassuring zero');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§14 the width budget — arithmetic, and what it is sensitive to');
//
// v3.37.0 narrowed this menu by DROPPING tokens that carry no information, and
// on the maintainer's own machine it did not narrow: measured against his real
// store through the READER's view, the widest label was 74 characters. Dropping
// tokens is a lever with no FLOOR — when what is left is long, the menu is still
// wide. This section is the floor.
//
// EVERY NUMBER HERE RESTS ON `MENU_CHAR_POINTS`, which is one average standing
// in for a proportional font, so nothing below asserts a single character count
// as though it were a fact: the arithmetic is asserted, and the SENSITIVITY of
// the answer across the plausible range is reported.
//
// ── AND THE OTHER TERMS ARE NO LONGER ASSUMPTIONS ──────────────────────────
//
// The menu has been photographed. MEASURED FROM A 2x CAPTURE ON 2026-09-02:
// 727 device pixels of menu at scale 2 is 363.5 points, the leading inset is
// 14.5, and the widest text ink ends at 293.5 — so 84.5 points of every item is
// width the title never gets. The old model said 36, and said the sublabel face
// advanced 5.0 points per glyph when three rendered 46-character sublabels
// measured 5.54, 5.58 and 5.64.
//
// Both errors ran the same way — the arithmetic believed the menu was narrower
// than it is — which is why a budget computed from them still produced a menu
// the maintainer called well proportioned: the model was wrong about the width
// in a direction that happened to be safe. This section pins the corrected
// decomposition against the ONE number the photograph fixes independently: the
// sublabel cap that was actually rendered.
{
  const B = model.labelBudgetChars;

  // THE CHECK ON THE WHOLE DECOMPOSITION. Three separately measured terms —
  // 363.5 total, 84.5 chrome, 5.65 per sublabel glyph — must reproduce the cap
  // the photographed menu was already rendering at, 46 characters, or one of
  // them is wrong. Nothing here is free to be adjusted to make it pass: the
  // photograph fixes all four numbers.
  eq(model.MAX_HEADLINE_CHARS, 46,
    'the corrected constants reproduce the 46-character sublabel cap that was PHOTOGRAPHED — three measured terms landing on a fourth measured fact');
  ok(model.MENU_WIDTH_POINTS > 360 && model.MENU_WIDTH_POINTS < 367,
    `the target is the MEASURED width (${model.MENU_WIDTH_POINTS}pt), not a reference app's (~240–270) — this menu is what it is, and the model now says so`);
  ok(model.MENU_CHROME_POINTS > 80,
    `and the chrome is the measured ${model.MENU_CHROME_POINTS}pt of leading inset plus trailing accessory column, not the 36 that was assumed`);
  // NO ROW LOSES A CHARACTER. The correction is to the model, not to the menu.
  ok(model.ROW_LABEL_CHARS >= 35 && model.PLAIN_LABEL_CHARS >= 38 && model.MAX_HEADLINE_CHARS >= 46,
    `every budget is at or above what shipped before the correction (row ${model.ROW_LABEL_CHARS} ≥ 35, plain ${model.PLAIN_LABEL_CHARS} ≥ 38, sublabel ${model.MAX_HEADLINE_CHARS} ≥ 46) — the menu does not narrow`);
  ok(model.MENU_SUBLABEL_CHAR_POINTS > 5.5 && model.MENU_SUBLABEL_CHAR_POINTS < 5.7,
    `the sublabel advance is the measured ${model.MENU_SUBLABEL_CHAR_POINTS}pt/glyph — the widest of three rendered rows, because a budget that under-charges is the defect`);

  // The formula, driven rather than restated.
  eq(B(0, 6.5), Math.floor((model.MENU_WIDTH_POINTS - model.MENU_CHROME_POINTS) / 6.5),
    'a label with no icon gets the whole item minus the chrome');
  eq(B(10, 6.5), Math.floor((model.MENU_WIDTH_POINTS - model.MENU_CHROME_POINTS - 14) / 6.5),
    'an icon costs its own width PLUS the bearing beside it — a row carrying a dot has less text budget than one without');
  ok(B(10, 6.5) < B(0, 6.5), 'CONTROL: so the icon really does reduce the budget');
  eq(B(0, 6.5), model.PLAIN_LABEL_CHARS, 'PLAIN_LABEL_CHARS is that formula, not a second number');
  eq(B(model.ROW_ICON_POINTS, 6.5), model.ROW_LABEL_CHARS, 'and so is ROW_LABEL_CHARS');

  // The sublabel is drawn in a SMALLER face, so the same points buy MORE
  // characters — which is why the headline cap comes out LARGER than the row
  // label cap. That inversion is the easiest thing here to get backwards.
  ok(model.MENU_SUBLABEL_CHAR_POINTS < model.MENU_CHAR_POINTS,
    'the sublabel advance is smaller than the label advance');
  ok(model.MAX_HEADLINE_CHARS > model.ROW_LABEL_CHARS,
    '…so the sublabel budget is MORE characters than the label budget, in the same width');

  // A budget can never clip a label to nothing.
  ok(B(400, 6.5) >= 12, 'a pathological icon still leaves a readable floor rather than an empty label');
  ok(B(0, 0.0001) > 0 && Number.isFinite(B(0, 0.0001)), 'and a nonsense advance cannot produce an infinite budget');
  eq(B(0, 0), B(0, model.MENU_CHAR_POINTS), 'a zero advance falls back to the stated assumption rather than dividing by zero');

  // ── THE SENSITIVITY, WHICH IS THE HONEST PART ─────────────────────────
  //
  // 5–7 pt per character is the plausible range for a 14pt system font. The
  // budget is REPORTED across it rather than asserted at one value, because a
  // suite that pins 32 characters is pinning the assumption and not the design.
  const table = [];
  for (const cp of [5.0, 5.5, 6.0, 6.5, 7.0]) {
    table.push({ cp, plain: B(0, cp), row: B(model.ROW_ICON_POINTS, cp) });
  }
  console.log('    pt/char   plain   row      (target ' + model.MENU_WIDTH_POINTS + 'pt, chrome ' +
    model.MENU_CHROME_POINTS + 'pt, dot gutter ' + (model.ROW_ICON_POINTS + model.MENU_ICON_GAP_POINTS) + 'pt)');
  for (const t of table) {
    console.log('    ' + t.cp.toFixed(1).padStart(5) + '   ' + String(t.plain).padStart(5) + '   ' + String(t.row).padStart(3));
  }
  ok(table.every((t, i) => i === 0 || t.row <= table[i - 1].row),
    'the budget shrinks monotonically as the assumed glyph gets wider — no arm of the formula inverts');
  ok(table[0].row - table[table.length - 1].row >= 8,
    `CONTROL: the range genuinely moves the answer (${table[table.length - 1].row}–${table[0].row} characters), so quoting one number would be quoting an assumption`);
  ok(table.every((t) => t.row >= 24),
    'and even at the widest assumed glyph a row still holds a readable scope plus its age');

  // ── THE MODEL PREDICTS THE PHOTOGRAPH, WHICH IS THE POINT OF FIXING IT ─
  //
  // A budget is only worth having if the width it predicts is the width that
  // appears. Reconstructed forwards from the constants: chrome, the dot gutter
  // and its bearing, and a sublabel at the cap in its own face.
  const widestRow = model.MENU_CHROME_POINTS + model.ROW_ICON_POINTS + model.MENU_ICON_GAP_POINTS
    + model.MAX_HEADLINE_CHARS * model.MENU_SUBLABEL_CHAR_POINTS;
  console.log(`    predicted widest row ${widestRow.toFixed(1)}pt against a menu measured at 363.5pt`);
  ok(Math.abs(widestRow - 363.5) < 6,
    `the constants PREDICT the photographed menu to within ${Math.abs(widestRow - 363.5).toFixed(1)}pt — the old ones predicted 283 for a menu that measured 363.5`);

  // ── AND THE PULSE ROW, WHOSE BUDGET IS DELIBERATELY NOT A WIDTH ───────
  //
  // On the maintainer's own store the reading is 33 characters, and that row is
  // NARROWER than the menu around it — so the row that carries the picture is
  // not what makes the menu wide. In the worst case the producer can emit it
  // IS: 48 characters of every caveat at once puts the item past 450 points.
  // That is the accepted price of never cutting a caveat, and it is reported
  // here rather than discovered in a later photograph.
  const pulseRow = (chars) => model.MENU_CHROME_POINTS + 55 + model.MENU_ICON_GAP_POINTS
    + chars * model.MENU_CHAR_POINTS;
  ok(pulseRow(33) < 363.5,
    `the photographed pulse reading (33 chars) renders at about ${pulseRow(33).toFixed(0)}pt — inside the menu it sits in`);
  console.log(`    worst-case pulse reading (${model.pulseLabelBudget(55)} chars) would render at about ${pulseRow(model.pulseLabelBudget(55)).toFixed(0)}pt — wider than the menu, and accepted`);
  ok(pulseRow(model.pulseLabelBudget(55)) > 363.5,
    'CONTROL: and the worst case really is wider than the menu, so that disclosure is a measurement rather than a formality');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§15 the READER\'S view — the configuration the maintainer actually runs');
//
// ── THE DEFECT THIS FIXTURE EXISTS FOR ─────────────────────────────────────
//
// v3.37.0 dropped a machine name when `isThisMachine` was true. On his setup it
// is FALSE ON EVERY ROW: the installed .app and his repo checkout are two
// INSTALLATIONS on one computer, so the app reads state written under an id that
// is not its own. Every existing fixture took the WRITER's view — the one
// configuration in which this is invisible — and measured 54 characters where
// the reader saw 74.
//
// The rule is no longer "was this written here". It is "does this component VARY
// across the visible rows", which is what already governs the project token and
// the harness. Two folder names sharing a trailing installation id are ONE
// identity: his laptop owns `laptop-a1b2c3` and `notebook-a1b2c3` because a
// hostname flapped under DHCP, and a naive comparison over folder STRINGS would
// see two computers and reassert the phantom the identity work removed.
{
  const readerRow = (over) => ({
    project: 'projects', scope: 'session-2026-08-31-native-prep-and-release-process',
    machine: 'laptop-a1b2c3', harness: 'claude-code', ageSource: 'agent',
    headline: 'four releases shipped', isThisMachine: false, ...over,
  });
  const readerStore = (extra = []) => ({
    ok: true, total: 11,
    scopes: [
      readerRow({ writtenAt: atAge(1800), writtenAgeSeconds: 1800,
        scope: 'session-2026-09-01-menubar-widget-design' }),
      readerRow({ writtenAt: atAge(50400), writtenAgeSeconds: 50400 }),
      readerRow({ writtenAt: atAge(122400), writtenAgeSeconds: 122400,
        scope: 'session-2026-08-30-design-conformance-pre-native' }),
      // THE DHCP PAIR: same scope, same coarse age, a DIFFERENT folder, one
      // installation. Naming the machine here is the fix that is wrong about
      // the hardware. Since v3.51.0 it does not reach a label at all — a
      // group's slots go to DISTINCT SCOPES and the newest copy wins — so what
      // this pair proves now is the COLLAPSE; the escalation is driven below
      // on the shape where a collision is still reachable.
      readerRow({ writtenAt: atAge(129600), writtenAgeSeconds: 129600,
        scope: 'session-2026-08-30-design-conformance-pre-native', machine: 'notebook-a1b2c3' }),
      readerRow({ writtenAt: atAge(140400), writtenAgeSeconds: 140400,
        scope: 'session-2026-08-30-ingest-continuity-tables' }),
      // A sixth work-stream, added in v3.51.0 so the store still fills all five
      // rows once the pair above collapses to one. Without it every assertion
      // below would be running on a four-row menu and the row-cap controls
      // would be measuring the fixture rather than the cap.
      readerRow({ writtenAt: atAge(151200), writtenAgeSeconds: 151200,
        scope: 'session-2026-08-28-chat-streaming' }),
      ...extra,
    ],
  });

  // CONTROL FIRST: the naive test really would see two machines here.
  eq(new Set(['laptop-a1b2c3', 'notebook-a1b2c3']).size, 2,
    'CONTROL — as raw strings those two folder names are different, so the identity grouping below is doing real work');
  eq(model.machineIdentityKey({ machine: 'laptop-a1b2c3' }),
    model.machineIdentityKey({ machine: 'notebook-a1b2c3' }),
    '…and as IDENTITIES they are one computer, because they share an installation id');
  ok(model.machineIdentityKey({ machine: 'laptop-a1b2c3' })
    !== model.machineIdentityKey({ machine: 'studio-9f8e7d' }),
    'CONTROL — a genuinely different installation id is a different identity');
  eq(model.installIdPart('laptop-a1b2c3'), 'a1b2c3', 'the id is the WHOLE trailing segment, not a four-character display suffix');
  eq(model.installIdPart('build-box'), null, 'a hostname whose last word is not hex carries no id');
  eq(model.machineIdentityKey({ machine: 'build-box', isThisMachine: true }), model.THIS_MAC_KEY,
    'and with no id on either side the producer\'s two identity facts are the only evidence left');
  eq(model.machineIdentityKey({ machine: 'build-box', isThisHost: true }), model.THIS_MAC_KEY,
    '…either of them, because they fail in opposite directions and neither is sufficient alone');
  eq(model.machineIdentityKey({ machine: 'build-box' }), 'name:build-box',
    'CONTROL — with NEITHER fact it is a foreign folder, so the two assertions above are not vacuous');

  // ── LAYOUT A OVER THE READER'S VIEW ────────────────────────────────────
  //
  // One project, one tool: ONE row on the face, the other work-streams under
  // it. What this fixture exists to prove is unchanged: no row names a
  // machine, because every record is one computer.
  const reader = model.buildTrayModel(readerStore(), { now: NOW });
  eq(reader.active.rows.length, 1, 'one project × one tool is one face row');
  eq(reader.rows.length, 5, 'CONTROL — five rows were built (the face row and four streams: six pairs, one of them the DHCP duplicate), so the assertions below are not vacuous');
  ok(reader.rows.every((r) => r.isThisMachine === false),
    'CONTROL — and every one of them is classified as a FOREIGN machine, which is the whole point of this fixture');
  ok(reader.rows.every((r) => !/laptop|notebook|a1b2c3/.test(r.label + '\n' + (r.sublabel || ''))),
    'NO row names a machine on either line — one computer in the whole store, so the name carries nothing');
  ok(reader.rows.every((r) => r.showsMachine !== true), '…and the model says so rather than leaving it to be inferred');
  ok(reader.rows.filter((r) => r.place === 'stream').every((r) => !/Claude Code|claude-code/.test(r.label)),
    'a stream under the row does not repeat the row\'s own tool');

  // ── THE DHCP PAIR IS ONE STREAM ──────────────────────────────────────
  const pair = reader.rows.filter((r) => r.scope.includes('design-conformance'));
  eq(pair.length, 1, 'the DHCP pair is ONE stream — two folders of one laptop are one work-stream saved twice');
  eq(pair[0].machine, 'laptop-a1b2c3', '…and it is the NEWER copy that survived');
  eq(new Set(reader.rows.map((r) => r.scope)).size, reader.rows.length,
    'so every row on this menu is a different work-stream');
  ok(reader.rows.some((r) => r.scope.includes('chat-streaming')),
    'CONTROL — and the oldest work-stream is still listed');

  // ── ONE SCOPE NAME IN TWO PROJECTS IS TWO ROWS, BY PROJECT ─────────────
  // The collision resolver that escalated ages (`1271 min ago`) is gone: two
  // face rows are two (project × tool) pairs, so line one differs by the
  // project name, which is the fact that separates them.
  const collide = model.buildTrayModel({
    ok: true, total: 2,
    scopes: [
      readerRow({ writtenAt: atAge(122400), writtenAgeSeconds: 122400,
        scope: 'session-2026-08-30-design-conformance-pre-native' }),
      readerRow({ writtenAt: atAge(129600), writtenAgeSeconds: 129600, project: 'posts',
        scope: 'session-2026-08-30-design-conformance-pre-native', machine: 'notebook-a1b2c3' }),
    ],
  }, { now: NOW });
  eq(collide.idle.rows.map((r) => r.label), ['projects · Claude Code · 1 day ago', 'posts · Claude Code · 1 day ago'],
    'the two read differently by their PROJECT, with the ordinary age — no escalation, no machine');

  // AND THE MOMENT A SECOND COMPUTER APPEARS, THE NAME COMES BACK.
  const twoMachines = model.buildTrayModel(readerStore([
    { project: 'projects', scope: 'session-2026-08-29-ux-polish', machine: 'studio-9f8e7d',
      harness: 'claude-code', writtenAt: atAge(400), writtenAgeSeconds: 400,
      ageSource: 'agent', headline: 'h', isThisMachine: false },
  ]), { now: NOW });
  eq(twoMachines.active.rows[0].machine, 'studio-9f8e7d', 'CONTROL — the studio save is the newest, so it is the face row');
  ok(/^studio\b/.test(twoMachines.active.rows[0].sublabel),
    'a genuinely second computer brings the machine name straight back — on line two, even on a face whose only row is the studio\'s');
  ok(twoMachines.rows.every((r) => !/studio|laptop|notebook/.test(r.label)),
    '…and never onto line one, which is where, who and when');
  ok(twoMachines.rows.every((r) => r.showsMachine === true || r.sublabel.startsWith(r.machineShort)),
    '…on every row, because "which computer" is only answerable if every row answers it (none is this Mac here)');

  // NOTHING THE RULE REMOVED IS UNREACHABLE. Checked per row against the RAW
  // input, which is the absolute rule of every lever in this file.
  let checked = 0;
  for (const r of reader.rows) {
    const src = readerStore().scopes.find((x) => x.scope === r.scope && x.machine === r.machine);
    ok(r.toolTip.includes(src.machine), `row ${checked}: the full machine folder is in the tooltip`);
    ok(r.toolTip.includes(src.scope), `row ${checked}: the FULL scope is in the tooltip, date prefix and all`);
    ok(r.toolTip.includes(src.harness), `row ${checked}: the harness is in the tooltip`);
    ok(r.toolTip.includes(src.project), `row ${checked}: the project is in the tooltip`);
    checked++;
  }
  eq(checked, 5, `all ${checked} rows were checked, so the loop above is not vacuous`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§16 every label fits the budget, and nothing it removed is unreachable');
{
  // A realistic reader's-view summary with prose headlines of real length.
  const wide = {
    ok: true, total: 11,
    scopes: Array.from({ length: 8 }, (_, i) => ({
      project: 'projects',
      scope: 'session-2026-08-3' + (i % 10) + '-a-deliberately-long-work-stream-name-' + i,
      machine: 'laptop-a1b2c3', harness: 'claude-code',
      writtenAt: atAge(1800 + i * 7200), writtenAgeSeconds: 1800 + i * 7200,
      ageSource: 'agent', isThisMachine: false,
      headline: 'FOUR RELEASES SHIPPED (v3.31-v3.34). Mac app installs, updates itself, and the sync path was rebuilt end to end',
    })),
    pulse: null, brief: null, remote: null, warnings: [],
  };
  const m = model.buildTrayModel(wide, { now: NOW });

  // ANTI-VACUITY: without a budget these labels really would be over it.
  const unbudgeted = wide.scopes.map((s) => s.scope + ' — ' + s.machine + ' · 4 hr ago');
  ok(unbudgeted.every((l) => l.length > model.ROW_LABEL_CHARS * 1.5),
    `CONTROL: the un-budgeted composition runs ${Math.max(...unbudgeted.map((l) => l.length))} characters, well past the ${model.ROW_LABEL_CHARS}-character budget — so the clip below is doing work`);

  ok(m.rows.every((r) => r.label.length <= model.ROW_LABEL_CHARS),
    `every row label is inside the ${model.ROW_LABEL_CHARS}-character budget`);
  ok(m.rows.every((r) => r.sublabel === null || r.sublabel.length <= model.MAX_HEADLINE_CHARS),
    `every sublabel is inside the ${model.MAX_HEADLINE_CHARS}-character budget`);
  ok(m.rows.some((r) => r.label.endsWith(' ago') && /…/.test(r.label)),
    'a clipped row still ENDS in its age — the budget is spent on the scope, never on the one token the widget exists to show');
  ok(m.rows.every((r) => /ago|unknown/.test(r.label)), 'and no row lost its age to a clip at all');
  ok(m.headline.text.includes('projects'), 'the headline — the icon\'s TOOLTIP now, never a menu line — keeps the project whole');

  // The whole rendered menu, every line, against the budget it belongs to.
  const NOOPS2 = { ...NOOPS, makeIcon: () => ({ fake: 'image' }) };
  const flat = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(m, NOOPS2));
  let lines = 0, widest = 0;
  for (const it of flat) {
    if (it.type === 'separator') continue;
    for (const key of ['label', 'sublabel']) {
      if (!it[key]) continue;
      lines++;
      widest = Math.max(widest, it[key].length);
      const cap = key === 'sublabel' ? model.MAX_HEADLINE_CHARS : model.PLAIN_LABEL_CHARS;
      if (it[key].length > cap) ok(false, `"${it[key]}" (${it[key].length}) is over the ${cap}-character budget for a ${key}`);
    }
  }
  ok(lines >= 18, `CONTROL: ${lines} rendered lines were measured, so the sweep above is not looking at an empty menu`);
  ok(widest > model.ROW_LABEL_CHARS - 4, `CONTROL: and the widest of them is ${widest}, a real line rather than a stub`);
  console.log(`    widest rendered line: ${widest} characters over ${lines} lines ` +
    `(≈${(model.MENU_CHROME_POINTS + model.ROW_ICON_POINTS + model.MENU_ICON_GAP_POINTS + model.ROW_LABEL_CHARS * model.MENU_CHAR_POINTS).toFixed(0)}pt at the assumed advance)`);

  // NOTHING A BUDGET REMOVED BECOMES UNREACHABLE — per row, against the raw input.
  let checked = 0;
  for (const r of m.rows) {
    const src = wide.scopes.find((s) => s.scope === r.scope);
    ok(r.toolTip.includes(src.scope), `row ${checked}: the full scope survives the clip, in the tooltip`);
    ok(r.toolTip.includes(src.machine), `row ${checked}: and so does the machine`);
    checked++;
  }
  eq(checked, m.rows.length, `all ${checked} rows checked`);
  ok(checked === 1 + model.MAX_OTHER_STREAMS && m.active.rows[0].streamsHidden === 2,
    'CONTROL — one face row, five streams, and the other two COUNTED on the row');

  // ── A NOTICE IS A SENTENCE, AND SENTENCES DO NOT COMPRESS ────────────
  //
  // Found by mutation: deleting the notice tooltip came back GREEN, because
  // nothing asserted it. A notice is the one line here whose whole value is its
  // wording — "Two agent tools are writing projects · session-…" says nothing
  // useful clipped at 34 characters — so the budget is met by clipping the
  // LABEL and carrying the sentence on the tooltip, and that pairing is the
  // thing worth guarding.
  // A COLLISION LINE clips the SCOPE'S TAIL, never the verb or the project.
  const longScope = 'session-2026-08-30-a-deliberately-long-work-stream';
  const noticed = model.buildTrayModel({
    ok: true, scopes: [],
    warnings: [{ code: 'harness-collision', message: 'Two agent tools are writing projects / field-notes · ' + longScope + '.',
      domain: 'projects', project: 'field-notes', scope: longScope, harnesses: ['claude-code', 'Antigravity'] }],
  }, { now: NOW });
  let opened = null;
  const nItem = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(noticed, { ...NOOPS, onOpenScope: (r) => { opened = r.route; } }))
    .find((i) => i.label && i.label.startsWith('Two tools are writing'));
  ok(nItem, 'CONTROL — the notice reached the menu (an empty store still says its notices)');
  ok(nItem && nItem.label.length <= model.PLAIN_LABEL_CHARS,
    `the notice label is inside the ${model.PLAIN_LABEL_CHARS}-character budget: "${nItem && nItem.label}"`);
  ok(nItem && nItem.label.startsWith('Two tools are writing field-notes / a-del') && nItem.label.endsWith('…'),
    '…and what was clipped is the SCOPE\'s tail: the verb and the project are whole');
  ok(nItem && nItem.toolTip.includes(longScope) && nItem.toolTip.includes('Claude Code and Antigravity'),
    '…with the WHOLE work-stream and both tools named on its tooltip');
  ok(nItem && nItem.enabled === true && typeof nItem.click === 'function', 'a collision line is ENABLED — it names a project, so it can open it');
  if (nItem && nItem.click) nItem.click();
  eq(opened, 'projects/field-notes', '…and a click opens THAT project in Project Context');
  const shortNotice = model.buildTrayModel({
    ok: true, scopes: [], warnings: [{ code: 'x', message: 'short enough' }],
  }, { now: NOW });
  const sItem = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(shortNotice, NOOPS))
    .find((i) => i.label === 'short enough');
  ok(sItem && !('toolTip' in sItem),
    'a notice that FITS carries no tooltip at all — one repeating the label verbatim is noise');

  // The DATE PREFIX: gone by default, back when dropping it would collide.
  eq(model.shortScopeNames(['session-2026-08-30-chat-streaming']).get('session-2026-08-30-chat-streaming'),
    'chat-streaming', 'a leading YYYY-MM-DD- is dropped — the row already carries an age');
  const dateClash = model.shortScopeNames(['session-2026-08-30-x', 'session-2026-09-01-x']);
  eq(dateClash.get('session-2026-08-30-x'), '2026-08-30-x',
    'and it comes STRAIGHT back when dropping it would make two shown rows read the same');
  eq(dateClash.get('session-2026-09-01-x'), '2026-09-01-x', '…on both of them, so the list stays one list at one resolution');
  eq(model.shortScopeNames(['2026-08-30']).get('2026-08-30'), '2026-08-30',
    'a scope that IS a date keeps it — shortening to nothing is not a shortening');
  eq(model.scopeCandidates('session-2026-08-30-x').length, 3,
    'the ladder is three rungs: full, prefix-stripped, date-stripped');
  eq(model.scopeCandidates('session-2026-08-30-x')[0], 'x', 'most compact first');

  // clipClauses: the reason an ordinary clip is unsafe on a reading.
  eq(model.clipClauses('4 days known · 69 saves', 21), '4 days known…',
    'a reading is shortened by dropping a WHOLE clause');
  ok(!/69 s…/.test(model.clipClauses('4 days known · 69 saves', 21)),
    'THE DEFECT AVOIDED — an ordinary clip yields "69 s…", which a reader may take for "69 seconds": a clip that produces a DIFFERENT fact');
  eq(model.clipClauses('7 days · 69 saves', 21), '7 days · 69 saves',
    'CONTROL — a reading that fits is untouched, which is the ordinary steady-state case');
  eq(model.clipClauses('oneverylongsingleclause', 10), 'oneverylo…',
    'and with no clause boundary to use it falls back to the ordinary visible clip rather than overflowing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§17 sections, the two pictures, and the items that are now reachable');
{
  // HAND-BUILT SPECS at the REAL geometry: menu-dots.js draws 11x11 and
  // pulse-strip.js draws 55x14, both `template: false`. §19 pins those numbers
  // against those modules; here they are literals so this section runs whether
  // or not the drawing modules are present.
  const spec = (w, h) => ({
    buffer: Buffer.from([1]), buffer2x: Buffer.from([2]),
    widthPoints: w, heightPoints: h, template: false,
  });
  // HAND-BUILT SPECS matching the renderers' contract exactly, so this section
  // executes with or without the sibling modules that draw them. That is the
  // point of the injected seams — nothing here waits on another agent's file.
  const dots = [];
  const renderDot = (bucket, o) => { dots.push({ bucket, o }); return spec(11, 11); };
  // `template: true` on the strip ONLY so the seam assertion below can see both
  // values reach it. The real strip is `false`; §19 pins that.
  const renderStrip = (pulse, o) => (pulse ? { ...spec(55, 14), template: true } : null);

  const built = model.buildTrayModel(summary({
    total: 12,
    pulse: { clock: 'agent', events: 69, buckets: new Array(28).fill(0), bucketSeconds: 21600,
      windowSeconds: 604800, coversWholeWindow: true, firstKnownBucket: 0 },
  }), { now: NOW, dark: true, renderDot, renderStrip });

  // ── THE THEME IS PASSED, NEVER READ ────────────────────────────────────
  ok(dots.length > 0 && dots.every((d) => d.o && d.o.dark === true),
    'every dot is rendered with the theme the CALLER supplied — a pure module never reads nativeTheme');
  const light = model.buildTrayModel(summary(), { now: NOW, renderDot: (b, o) => { dots.push({ b, o }); return spec(11, 11); } });
  ok(light.rows.length > 0, 'CONTROL — the light build produced rows');
  ok(dots.slice(-light.rows.length).every((d) => d.o && d.o.dark === false),
    'and an absent `dark` is LIGHT, which is the safe direction: a light image on a dark menu is dim, a dark one on a light menu is gone');

  // ── `unknown` IS A CASE, NOT A FALLTHROUGH ────────────────────────────
  const noClock = model.buildTrayModel({
    ok: true, scopes: [{ project: 'p', scope: 's', machine: 'laptop-a1b2c3', isThisMachine: true }],
  }, { now: NOW, renderDot });
  eq(noClock.rows[0].tier, 'unknown', 'CONTROL — a row with no timestamp is in the tier `unknown`');
  eq(dots[dots.length - 1].bucket, 'unknown',
    'and the renderer is asked for the UNKNOWN mark (the app\'s dashed ring) — never the coldest tier, which would assert "old" about a row whose own label reads "time unknown"');
  ok(built.rows.every((r) => r.dot !== null), 'CONTROL — rows that DO have a clock all carry one');

  // A renderer that throws costs a picture and never the menu.
  const boom = model.buildTrayModel(summary(), { now: NOW, renderDot: () => { throw new Error('x'); } });
  ok(boom.rows.length > 0 && boom.rows.every((r) => r.dot === null),
    'a throwing renderer degrades to no picture rather than taking the model down');

  // ── THE MENU'S NEW SHAPE ──────────────────────────────────────────────
  const seen = [];
  const flat = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(built, {
    ...NOOPS, makeIcon: (sp) => { seen.push(sp); return { fake: 'image', from: sp }; },
  }));
  const byId = (id) => flat.find((i) => i.id === id);

  // ── ONE SECTION HEADER, AND NO PROJECT HEADERS (Layout A, v3.74.0) ───
  //
  // The v3.66 project header — an enabled item carrying a capture bar — is
  // gone: a row IS a (project × tool), so the project is on its own line one.
  // The one section header left on the face is "Active · last 24 h".
  {
    const h = byId(menu.ID_HEADER_ACTIVE) || {};
    ok(byId(menu.ID_HEADER_ACTIVE), 'the Active section header is in the menu');
    eq(h.type, menu.MENU_HEADER_TYPE, '…as a header type, which is what makes it read as a section');
    eq(h.enabled, false, '…drawn inert, so on macOS below 14 its worst case is a dimmed caption rather than a live item that does nothing');
    ok(!h.click, '…and carrying no click handler at all, so no macOS version can make it actionable');
  }
  ok(!flat.some((i) => /^tray-group-/.test(String(i.id || '')) || i.id === 'tray-header-pulse'),
    'no project header and no "Save pulse" header — the rows name their project, the pulse row reads as a sentence');
  eq(menu.MENU_HEADER_TYPE, 'header', 'the type is the one verified present in Electron 43.5.0\'s accepted union');

  // The pulse row is now an ACTION at full contrast.
  const pulseItem = byId(menu.ID_PULSE) || {};
  ok(byId(menu.ID_PULSE), 'the pulse item is present');
  eq(pulseItem.enabled, true,
    'ENABLED — a disabled item is drawn at reduced contrast, and the maintainer\'s verdict on the drawn strip was that it "is barely visible"');
  eq(typeof pulseItem.click, 'function', '…and enabled means it does something: an enabled item with no handler swallows a click');
  const clicks = [];
  const routed = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(built, {
    ...NOOPS, onOpenMemory: () => clicks.push('memory'), makeIcon: () => null,
  }));
  // Guarded rather than dereferenced: a mutation that makes one of these items
  // VANISH must red on a named assertion, not crash the suite two lines later —
  // the shape v3.24.1 recorded, and one this file has now reproduced once.
  for (const id of [menu.ID_PULSE]) {
    const item = routed.find((i) => i.id === id);
    ok(item && typeof item.click === 'function', `${id} is present and clickable`);
    if (item && typeof item.click === 'function') item.click();
  }
  eq(clicks, ['memory'],
    'with no per-tool lanes it lands on Project Context, which is where the saves this strip counts are actually listed');
  ok(pulseItem.toolTip && pulseItem.toolTip.length > 20, 'the full reading, including everything the label budget dropped, is on its tooltip');
  // ── THE READING IS NEVER THE THING THAT DOES NOT FIT ─────────────────
  //
  // ── REVISED, AND THIS ONE WAS A REAL DEFECT ON A REAL SCREEN ─────────
  //
  // WAS: `fits(ordinary)` against `!fits(youngest)`, with the young-store form
  // asserted NOT to fit and presented as proof that "the budget is a real
  // constraint and not decoration". It was a real constraint. It was
  // constraining the wrong thing.
  //
  // The first photograph of this menu — 2026-09-02 — shows the pulse row
  // reading `5 days known · 55 saves…`. The producer had emitted
  // `5 days known · 55 saves · 2 tools`, 33 characters, complete and true; the
  // width budget was 29; `clipClauses` dropped a whole clause. Two of that
  // sentence's three clauses ARE its honesty caveats, and it sits on the one
  // row whose entire job is saying what the picture beside it does and does not
  // cover. A budget that eats those has inverted the item.
  //
  // `pulseLabelBudget` is now the LARGER of the width allowance and the
  // producer's own longest reading, obtained by RUNNING `pulseLabel` rather
  // than composing the sentence a second time. So the assertions reverse: no
  // form the producer can emit is clipped, and the control moves to a string
  // the producer cannot emit, which is where a real backstop belongs.
  const ordinary = 'Save pulse · 7 days · 69 saves · 2 tools';
  const youngest = 'Save pulse · 4 days known · 69 saves · 2 tools';
  const stripBudget = model.pulseLabelBudget(55);
  const fits = (t) => model.stripPulseNoun(t).length <= stripBudget;
  ok(stripBudget > model.labelBudgetChars(55),
    `the pulse row's budget is ${stripBudget} characters, above the ${model.labelBudgetChars(55)} the width arithmetic alone allows — the width does not get to decide this one label`);
  ok(fits(ordinary),
    `the ordinary reading with a tools clause (${model.stripPulseNoun(ordinary).length} chars) fits`);
  ok(fits(youngest),
    `and so does the young-store form (${model.stripPulseNoun(youngest).length}), which is the one the photograph showed being cut`);
  // THE PHOTOGRAPHED STRING ITSELF, end to end through the real composition.
  const photographed = 'Save pulse · 5 days known · 55 saves · 2 tools';
  eq(model.clipClauses(model.stripPulseNoun(photographed), stripBudget),
    '5 days known · 55 saves · 2 tools',
    'THE DEFECT: the exact reading the photographed menu cut to `5 days known · 55 saves…` now renders WHOLE');
  // AND THE BUDGET IS DERIVED FROM THE PRODUCER, not from a number typed here.
  let pulseProducer = null;
  try { pulseProducer = await import(path.join(DESKTOP, 'lib', 'pulse-strip.js')); } catch { pulseProducer = null; }
  if (typeof pulseProducer?.longestPulseLabel === 'function') {
    const longest = pulseProducer.longestPulseLabel();
    eq(stripBudget, Math.max(model.labelBudgetChars(55), model.stripPulseNoun(longest).length),
      'and the budget IS that maximum, computed from the producer rather than pinned beside it');
    ok(fits(longest),
      `CONTROL: the longest reading the producer can emit at all (${model.stripPulseNoun(longest).length} chars) fits too, so nothing it can say is clippable`);
  }
  // ── AND END TO END, THROUGH THE REAL COMPOSITION ─────────────────────
  //
  // Everything above tests the budget and the clip as functions. The defect was
  // at the CALL SITE — one expression choosing which budget to spend — so it is
  // driven here through `buildTrayModel` with the photographed store's own
  // pulse, and the assertion is the string that appeared in the photograph.
  // Without this, swapping the call site back to `labelBudgetChars` would leave
  // every assertion above green.
  const photographedPulse = model.buildTrayModel(summary({
    pulse: {
      clock: 'agent', events: 55, harnessCount: 2, pairsTruncated: 0,
      buckets: (() => { const b = new Array(28).fill(0); b[27] = 55; return b; })(),
      bucketSeconds: 21600, windowSeconds: 604800,
      coversWholeWindow: false, firstKnownBucket: 8,
    },
  }), {
    now: NOW,
    renderStrip: () => ({
      buffer: Buffer.from([1]), buffer2x: Buffer.from([2]),
      widthPoints: 55, heightPoints: 15, template: false,
    }),
  });
  eq(photographedPulse.pulse && photographedPulse.pulse.label,
    '5 days known · 55 saves · 2 tools',
    'END TO END: the photographed store\'s reading reaches the model WHOLE');

  // ── AND A READING THE WIDTH FIX ALONE WOULD STILL CUT ────────────────
  //
  // THE MUTATION THAT FOUND THIS. Swapping the call site back to
  // `labelBudgetChars` came back GREEN against the fixture above, because the
  // corrected width arithmetic allows 33 characters and the photographed
  // reading is exactly 33 — it fits either way. So that fixture proves the
  // WIDTH fix and says nothing at all about which budget the call site spends.
  //
  // The store below adds the producer's other honesty caveat — `pairsTruncated`
  // > 0, meaning some (scope, machine) pairs were not read, so the count is a
  // FLOOR — which is nine more characters. 41 against a width allowance of 33:
  // the only fixture here that can tell the two budgets apart.
  const flooredPulse = model.buildTrayModel(summary({
    pulse: {
      clock: 'agent', events: 55, harnessCount: 2, pairsTruncated: 1,
      buckets: (() => { const b = new Array(28).fill(0); b[27] = 55; return b; })(),
      bucketSeconds: 21600, windowSeconds: 604800,
      coversWholeWindow: false, firstKnownBucket: 8,
    },
  }), {
    now: NOW,
    renderStrip: () => ({
      buffer: Buffer.from([1]), buffer2x: Buffer.from([2]),
      widthPoints: 55, heightPoints: 15, template: false,
    }),
  });
  eq(flooredPulse.pulse && flooredPulse.pulse.label,
    '5 days known · at least 55 saves · 2 tools',
    'END TO END: a reading carrying BOTH caveats (41 chars) also reaches the model whole — the call site spends the pulse budget, not the width budget');
  ok(41 > model.labelBudgetChars(55),
    `CONTROL: that reading is 41 characters against a ${model.labelBudgetChars(55)}-character width allowance, so the assertion above genuinely distinguishes the two budgets`);

  // ── THE BACKSTOP IS STILL THERE, AND STILL CLAUSE-SAFE ───────────────
  //
  // The control is now a string the producer CANNOT emit — six clauses — which
  // is the only honest way to show the clip is live once every real form fits.
  // `69 s…` would be a DIFFERENT FACT, plausibly `69 seconds`, which is worse
  // than less of one, so what goes is a whole clause.
  const oversized = 'Save pulse · 4 days known · at least 69 saves · 12 tools · 9 machines · 3 projects · and more';
  ok(!fits(oversized),
    `CONTROL: a ${model.stripPulseNoun(oversized).length}-character composition the producer has no branch for does NOT fit, so the clip below is doing work`);
  const clipped = model.clipClauses(model.stripPulseNoun(oversized), stripBudget);
  ok(clipped.endsWith('…') && !/\d+ s…/.test(clipped),
    `…and it is cut on a clause boundary: "${clipped}"`);
  ok(clipped.includes('4 days known') && clipped.includes('at least 69 saves'),
    '…keeping the honesty caveats, which are the clauses a reader most needs');
  eq(model.clipClauses(model.stripPulseNoun(ordinary), stripBudget), model.stripPulseNoun(ordinary),
    '…while a form that DOES fit passes through the clause clip untouched');

  ok(!/^Save pulse/.test(pulseItem.label || ''),
    'the constant noun stays off the label: "7 days · 69 saves" reads as a sentence about saves on the menu\'s first line');
  eq(model.stripPulseNoun(model.PULSE_LABEL_NOUN + '7 days · 69 saves'), '7 days · 69 saves',
    'CONTROL — the noun is stripped as a LITERAL prefix');
  eq(model.stripPulseNoun('7 days · 69 saves'), '7 days · 69 saves',
    '…and a label that never carried it is untouched, so this is a no-op rather than a corruption if the producer reworded');

  // No overflow when everything fits — and no "More in Project Context… (N)"
  // counting (scope, machine) pairs (D8): the retired item is gone.
  eq(built.overflow, null, 'three rows fit the five-row face, so there is no overflow item');
  ok(!flat.some((i) => /^More in Project Context/.test(i.label || '')), 'and the pair-counting "More in Project Context… (N)" is gone');
  ok(!['truncatedNote', 'hiddenRows', 'groups', 'groupsOnDisk'].some((k) => Object.prototype.hasOwnProperty.call(built, k)),
    'the model carries none of the retired cap fields');

  // Icons: one per row plus the strip, each handed the SPEC ITSELF.
  const rowItems = built.rows.map((r) => byId(r.id));
  ok(rowItems.every((i) => i && i.icon), 'every scope row carries its recency dot');
  eq(seen.length, built.rows.length + 1, 'makeIcon is called exactly once per row plus once for the strip');
  ok(seen.some((sp) => sp.template === true) && seen.some((sp) => sp.template === false),
    'the seam is handed the SPEC, template flag and all — main.js reads that field and never guesses, because a coloured dot marked as a template is flattened to a monochrome blob');
  ok(seen.every((sp) => sp.buffer && sp.buffer2x),
    'and both representations reach it, so a retina asset cannot be dropped on the way');

  // A throwing seam is survivable at the menu layer too.
  const survived = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(built, {
    ...NOOPS, makeIcon: () => { throw new Error('nativeImage exploded'); },
  }));
  ok(survived.length > 5, 'a makeIcon that throws still produces a whole menu');
  ok(survived.filter((i) => i.icon).length === 0, '…simply with no pictures in it');

  // Five rows, and the number is the maintainer's own ask.
  eq(model.MAX_ROWS, 5, 'five rows: "maybe just five of them, the latest five, and then people can click more"');
  eq(built.rows.length, Math.min(5, summary().scopes.length), 'CONTROL — the model really caps there');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§18 main.js wiring for the theme and the images — SOURCE SCAN, weak like §11');
{
  const src = stripJsComments(read(path.join(DESKTOP, 'main.js')));
  // The INTENT is unchanged — main.js reads the theme and hands it in, so no
  // pure module reaches for Electron. The SOURCE of the theme changed, and it
  // was settled by measurement rather than by reading documentation.
  //
  // boot() pins `nativeTheme.themeSource = 'dark'` for the window's title bar,
  // and that setter is exactly what `shouldUseDarkColors` reports. Measured by
  // running Electron 43.5.0 on a LIGHT-appearance Mac, before and after:
  //
  //     shouldUseDarkColors        false  ->  TRUE      (follows the override)
  //     getEffectiveAppearance()   light  ->  dark      (follows it too)
  //     getUserDefault('AppleInterfaceStyle')  light -> light   (immune)
  //
  // So `shouldUseDarkColors` would have painted the DARK palette onto a LIGHT
  // menu bar on every Mac. The menu is drawn by AppKit against the SYSTEM
  // appearance, which is a different question from what this app's own window
  // is themed as, and the two are allowed to disagree.
  ok(/dark:\s*menuAppearanceIsDark\(\)/.test(src),
    'main.js reads the theme and PASSES it into buildTrayModel rather than the model reaching for Electron');
  ok(/getUserDefault\('AppleInterfaceStyle',\s*'string'\)\s*===\s*'Dark'/.test(src),
    'and it reads the SYSTEM appearance, which themeSource cannot reach');
  ok(!/dark:\s*nativeTheme\.shouldUseDarkColors/.test(src),
    'and NOT shouldUseDarkColors, which this app pins to dark and which would invert the palette on every light Mac');
  ok(/AppleInterfaceThemeChangedNotification/.test(src),
    'the rebuild is driven by the system notification, because `updated` does not fire while themeSource is pinned');
  ok(/nativeTheme\.on\('updated', renderTrayFromSnapshot\)/.test(src),
    'and re-renders on a theme change — a pure module cannot notice one');
  ok(/nativeTheme\.removeListener\('updated', renderTrayFromSnapshot\)/.test(src),
    'the listener is removed when the tray goes away — nativeTheme is a process singleton and would otherwise accumulate one per toggle');
  ok(/img\.setTemplateImage\(spec\.template === true\)/.test(src),
    'and the image seam OBEYS spec.template rather than deciding it');
  ok(!/setTemplateImage\(true\)[\s\S]{0,200}makeIcon/.test(src),
    'CONTROL — no hardcoded template flag survives on the menu-image path');
  ok(/makeIcon: menuImage/.test(src), 'the seam is wired to that function');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§19 cross-file pins against the modules that DRAW the two pictures');
//
// `tray-model.js` reserves a gutter for a dot it never sees and names five
// recency buckets a different module colours. Both are numbers and names living
// in two files, which is the drift shape this project keeps recording — so they
// are pinned by EXECUTING the other module rather than by trusting a comment.
//
// CONDITIONAL BY CONSTRUCTION, and it says so out loud: `menu-dots.js` is built
// in parallel with this file, so when it is absent the pins cannot run. They are
// not silently skipped — the count of pins actually executed is asserted, so a
// module that vanished cannot leave this section passing on nothing.
{
  let dotsMod = null, stripMod = null;
  try { dotsMod = await import(path.join(DESKTOP, 'lib', 'menu-dots.js')); } catch { dotsMod = null; }
  try { stripMod = await import(path.join(DESKTOP, 'lib', 'pulse-strip.js')); } catch { stripMod = null; }

  let pins = 0;
  if (dotsMod) {
    // THE RESERVATION MUST COVER WHAT IS DRAWN. A gutter narrower than the dot
    // is a budget that is quietly wrong on every row, and nothing on screen
    // would say which of the two numbers was the mistake.
    ok(model.ROW_ICON_POINTS >= dotsMod.DOT_POINTS,
      `the reserved row gutter (${model.ROW_ICON_POINTS}pt) covers the dot menu-dots.js actually draws (${dotsMod.DOT_POINTS}pt)`);
    ok(model.ROW_ICON_POINTS <= dotsMod.DOT_POINTS + 2,
      '…and does not over-reserve, which would silently spend the label budget on empty space');
    pins += 2;

    // THE TIER VOCABULARY IS ONE VOCABULARY. `freshnessTier()` is the only
    // producer of these names and the dot renderer is the only consumer; a
    // rename or a collapse on either side is a dot that silently stops being
    // drawn, with no error anywhere.
    const produced = new Set([0, 200, 3600 * 2, 100000, 10000000, null].map(model.freshnessTier));
    eq([...produced].sort(), [...dotsMod.DOT_ORDER].sort(),
      'every tier freshnessTier() can produce — the absence included — is one menu-dots.js draws, and no more');
    ok(dotsMod.renderRecencyDot('unknown', { dark: true }) !== null,
      'and the absence IS drawn — the app\'s dashed ring, a different kind of mark, executed rather than read off a constant');
    ok(dotsMod.DOT_ORDER.length === 6, `CONTROL: ${dotsMod.DOT_ORDER.length} tiers were compared, so the set equality above is not over an empty set`);
    pins += 3;

    // The spec shape this model carries onto a row is the one that module emits.
    const real = dotsMod.renderRecencyDot('live', { dark: true });
    ok(real && real.buffer && real.buffer2x && real.template === false,
      'a real dot spec carries both representations and template:false — a coloured dot marked as a template is flattened to a monochrome blob');
    pins += 1;
  }
  const realStrip = stripMod ? stripMod.renderPulseStrip({
    clock: 'agent', events: 69, buckets: new Array(28).fill(2), bucketSeconds: 21600,
    windowSeconds: 604800, coversWholeWindow: false, firstKnownBucket: 12,
  }, { dark: true }) : null;
  // GATED ON THE CONTRACT, not merely on the file existing. A pre-contract
  // `renderPulseStrip` returns a spec with NO `template` field at all, and
  // pinning `=== false` against it would red this branch for the sibling
  // module's state rather than for anything in these files. `'template' in
  // spec` is the discriminator, and the NOTE below says when it did not hold.
  if (realStrip && typeof realStrip.template === 'boolean') {
    const real = realStrip;
    ok(real && real.template === false,
      'the strip is drawn in COLOUR — the template constraint is true of the TRAY GLYPH and false of a menu item icon, which is what made the shipped strip barely visible');
    ok(real && real.widthPoints > 0 && model.labelBudgetChars(real.widthPoints) >= 20,
      `the real strip (${real ? real.widthPoints : '?'}pt) leaves ${real ? model.labelBudgetChars(real.widthPoints) : '?'} characters for its reading — enough for the producer's longest form`);
    ok(stripMod.pulseLabel({ clock: 'agent', events: 69, buckets: new Array(28).fill(2),
      bucketSeconds: 21600, windowSeconds: 604800, coversWholeWindow: true, firstKnownBucket: 0 })
      .startsWith(model.PULSE_LABEL_NOUN),
      'the producer still opens its reading with the exact noun this model strips — a literal that stopped matching would be a silent no-op');
    pins += 3;
  } else if (stripMod) {
    console.log('    NOTE: pulse-strip.js is present but PRE-CONTRACT — its spec carries no `template`');
    console.log('          field, so the three strip pins did not run. They go live on merge.');
  }

  // ── THE APP'S FRESHNESS SCALE, EXECUTED (v3.74.0, D6) ───────────────────
  //
  // `freshnessStep` / `freshnessTier` are COPIED into tray-model.js (it may not
  // import src/). shared/age.js touches no DOM, so the REAL ones are imported
  // and both copies run over one matrix that crosses every boundary.
  {
    const age = await import(path.join(ROOT, 'src', 'public', 'next', 'shared', 'age.js'));
    const matrix = [-1, 0, 1, 59, 60, 61, 3599, 3600, 3601, 86399, 86400, 86401, 604799, 604800, 604801,
      30 * 86400, null, undefined, NaN, Infinity, '60', {}];
    const diff = matrix.filter((v) => age.freshnessTier(v) !== model.freshnessTier(v) || age.freshnessStep(v) !== model.freshnessStep(v));
    eq(diff.map(String), [], `the tray's freshnessTier/freshnessStep agree with the app's on all ${matrix.length} inputs`);
    ok(age.freshnessTier(30) === 'live' && age.freshnessTier(7200) === 'today' && age.freshnessTier(null) === 'unknown',
      'CONTROL — the app\'s function returns real, different answers, so agreement means something');
    eq(model.ACTIVE_TIERS, ['live', 'recent', 'today'], 'Active is exactly the app\'s tiers under 24 h — one cut, two surfaces');
    pins += 3;
  }

  // ── THE HARNESS NORMALISER, EXECUTED — once the data package is merged ──
  //
  // tray-model.js carries a copy of src/brain/harness-names.js's
  // `normaliseHarness` for the fallback path. When that module exists in this
  // tree the two run over one matrix; before the merge it cannot, and that is
  // SAID rather than passed silently.
  {
    let hn = null;
    try { hn = await import(path.join(ROOT, 'src', 'brain', 'harness-names.js')); } catch { hn = null; }
    if (hn && typeof hn.normaliseHarness === 'function') {
      const matrix = ['Claude Code', 'Claude Code (desktop)', 'Claude Code (desktop app)', 'Claude Code (worker agent)',
        'claude-code', 'claudecode', 'CLAUDE_CODE', 'claude-desktop', 'Claude Desktop', 'claude-ai', 'Antigravity',
        'google antigravity', 'OpenAI Codex CLI', 'codex', 'codex-cli', 'Windsurf / Devin Desktop', 'goose-desktop',
        'harness-two', 'Harness Two', '  spaced   name  ', 'x'.repeat(120), 'A (b) c', '(only parens)', '', '   ', null, 42];
      const diff = matrix.filter((v) => JSON.stringify(hn.normaliseHarness(v)) !== JSON.stringify(model.normaliseHarness(v)));
      eq(diff.map(String), [], `the tray's normaliseHarness agrees with src/brain/harness-names.js on all ${matrix.length} inputs`);
      ok(hn.normaliseHarness('claude-desktop').id !== hn.normaliseHarness('claude-code').id,
        'CONTROL — the real normaliser keeps Claude Desktop and Claude Code apart, so agreement is about a real distinction');
      pins += 2;
    } else {
      console.log('    NOTE: src/brain/harness-names.js is not in this tree — the normaliser pin goes live on merge.');
    }
  }

  if (pins === 0) {
    console.log('    NOTE: neither drawing module carries the contract in this tree, so §19 pinned NOTHING.');
    console.log('          These pins are live only once menu-dots.js and pulse-strip.js are merged alongside.');
  } else {
    ok(pins >= 2, `CONTROL: ${pins} cross-file pins actually executed, so this section is not passing on an absent module`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
section('§20 line one under Layout A — the budget over three fixtures, including the READER\'S and an ADVERSARIAL one');
//
// Layout A moves the HARNESS onto line one (`ott · Claude Code · 8 min ago`),
// which is up to 14 more characters on the line that sets the menu's width.
// The rule: the AGE and the harness token are never clipped; the PROJECT (or,
// in a submenu, the scope) is, down to PROJECT_MIN_CHARS. Measured here over
// the three row sets that found every earlier width defect: the real rows, an
// adversarial set (two projects × four tools × three machines, a file-clock
// age), and the READER'S view (isThisMachine false on every row — the
// configuration v3.38.0 was judged in and no fixture had taken).
{
  const at = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
  const R = (over) => ({
    project: 'projects', machine: 'alpha-macbook-pro-a1b2c3', harness: 'harness-one',
    model: 'demo-4-6', ageSource: 'agent', isThisMachine: true, isThisHost: true, ...over,
  });
  const build = (scopes) => model.buildTrayModel({ ok: true, scopes, total: scopes.length }, { now: NOW });
  const lineOne = (m) => m.rows.filter((r) => r.place !== 'stream');
  const widest = (rows) => Math.max(...rows.map((r) => r.label.length));

  // ── FIXTURE 1: the real rows, reconstructed from the photograph ────────
  const REAL = [
    R({ scope: 'session-2026-09-02-tray-widget-redesign', writtenAt: at(600),
      headline: 'Reworked the pulse strip geometry and the row budget' }),
    R({ scope: 'session-2026-09-01-save-kind-verdict', writtenAt: at(18 * 3600),
      harness: 'harness-two', previousHarness: 'harness-one', model: 'other-3-pro',
      machine: 'alpha-macbook-pro-9f3c1a', isThisMachine: false,
      headline: 'classifySaveNotes gained a fifth verdict' }),
    R({ scope: 'session-2026-08-30-design-conformance-pre-native', writtenAt: at(18.5 * 3600),
      machine: 'alpha-macbook-pro-9f3c1a', isThisMachine: false,
      headline: 'Design conformance pass before the native shell' }),
    R({ scope: 'session-2026-08-29-installer-gate', writtenAt: at(3 * 86400),
      machine: 'alpha-macbook-pro-9f3c1a', isThisMachine: false, kind: 'trimmed',
      headline: 'assertLoadable now names the failure mode' }),
    R({ scope: 'session-2026-08-28-product-overview', writtenAt: at(4 * 86400),
      machine: 'alpha-notebook-9f3c1a', isThisMachine: false,
      headline: 'Wrote docs/product-overview.md end to end' }),
  ];
  const real = build(REAL);
  eq(real.active.rows.map((r) => r.label), ['projects · harness-one · 10 min ago', 'projects · harness-two · 18 hr ago'],
    'one project, two tools today: two face rows, where · who · when');
  eq(real.rows.length, 5, 'CONTROL — and all five work-streams are rows (two on the face, three as streams)');
  ok(widest(real.rows) <= model.ROW_LABEL_CHARS,
    `real rows: the widest label is ${widest(real.rows)}, inside the ${model.ROW_LABEL_CHARS}-character budget`);
  ok(real.rows.every((r) => !/macbook|notebook|demo-4-6/.test(r.label)), 'no machine and no model on line one');
  ok(real.active.rows[1].sublabel.startsWith('harness-two ← harness-one'),
    `the handover is on line two, whole — a token that never drops (${real.active.rows[1].sublabel})`);

  // ── FIXTURE 2: adversarial ─────────────────────────────────────────────
  const ADV = [
    R({ project: 'alpha', scope: 'session-2026-09-02-tray-widget-redesign', writtenAt: at(120),
      headline: 'Row budget rewritten to lead with the topic' }),
    R({ project: 'alpha', scope: 'session-2026-09-02-mcp-resume-prompt', writtenAt: at(41 * 60),
      harness: 'harness-two', model: 'other-3-pro', headline: 'Drafted the resume-prompt copy' }),
    R({ project: 'beta', scope: 'session-2026-09-01-webhook-retries', writtenAt: at(6 * 3600),
      machine: 'buildbox-9f31aa', isThisMachine: false, isThisHost: false,
      harness: 'harness-three', model: 'third-4-6',
      headline: 'Retry budget lands; idempotency keys still open' }),
    R({ project: 'beta', scope: 'session-2026-08-31-settlement-reconciliation', writtenAt: at(20 * 3600),
      machine: 'studio-c40b17', isThisMachine: false, isThisHost: false, ageSource: 'file',
      harness: 'harness-four', model: 'other-3-flash', headline: 'Settlement reconciliation spike' }),
    R({ project: 'alpha', scope: 'session-2026-08-30-design-conformance-pre-native', writtenAt: at(3 * 86400),
      machine: 'alpha-macbook-pro-9f3c1a', isThisMachine: false, headline: 'Design conformance pass' }),
  ];
  const adv = build(ADV);
  eq(adv.active.rows.length, 4, 'CONTROL — four (project × tool) rows are active');
  ok(adv.rows.some((r) => r.ageText.startsWith('changed ')),
    'CONTROL — one row carries the long "changed N hr ago" form, the worst ordinary case for the budget');
  ok(widest(lineOne(adv)) <= model.ROW_LABEL_CHARS,
    `adversarial face rows: the widest label is ${widest(lineOne(adv))}, inside the budget`);
  ok(adv.rows.every((r) => r.label.endsWith(r.ageText)), 'the AGE is never clipped, on any row');
  ok(adv.rows.filter((r) => r.foreign && r.place !== 'stream').every((r) => r.showsMachine === true),
    'the two foreign rows name their machines — on line two');

  // ── THE PATHOLOGICAL LINE, BOUNDED AND MEASURED ────────────────────────
  //
  // A 40-character project, an unknown 40-character harness an agent typed,
  // and a file-clock age of months. The project clips to its floor, the
  // harness token to HARNESS_TOKEN_CHARS (a known product never clips: the
  // three long labels have short forms), and the age stays whole — so the line
  // runs over the budget by a BOUNDED amount, stated here in points.
  const worst = build([R({ project: 'p'.repeat(40), harness: 'h'.repeat(40), ageSource: 'file',
    scope: 'main', writtenAt: at(300 * 86400) })]);
  const w = worst.rows[0].label;
  const bound = model.PROJECT_MIN_CHARS + 3 + model.HARNESS_TOKEN_CHARS + 3 + 'changed 11 months ago'.length;
  ok(w.endsWith(' · ' + worst.rows[0].ageText) && /^p+…/.test(w) && w.length <= bound,
    `the worst line keeps its age and is ${w.length} characters, within the stated bound of ${bound}: "${w}"`);
  const pts = (n) => n * model.MENU_CHAR_POINTS + model.ROW_ICON_POINTS + model.MENU_ICON_GAP_POINTS + model.MENU_CHROME_POINTS;
  console.log(`    budget row ${model.ROW_LABEL_CHARS} chars ≈ ${pts(model.ROW_LABEL_CHARS).toFixed(0)}pt; worst bounded row ${bound} chars ≈ ${pts(bound).toFixed(0)}pt (the menu is ${model.MENU_WIDTH_POINTS}pt)`);
  eq(['codex', 'copilot-cli', 'dsh', 'windsurf'].map((id) => model.harnessToken(id, model.HARNESS_LABELS[id])),
    ['Codex CLI', 'Copilot CLI', 'DeepSeek', 'Windsurf'], 'the known products whose labels are long get SHORT forms, never an ellipsis');
  ok(Object.entries(model.HARNESS_LABELS).every(([id, l]) => model.harnessToken(id, l).length <= model.HARNESS_TOKEN_CHARS
    && !model.harnessToken(id, l).endsWith('…')), 'every known product fits the harness token whole');
  eq(model.harnessToken(null, null), model.UNKNOWN_HARNESS, 'a save that named no tool says "unknown tool" — absent is not blank');

  // ── FIXTURE 3: THE READER'S VIEW ───────────────────────────────────────
  const READER = REAL.map((r) => ({ ...r, isThisMachine: false }));
  const reader = build(READER);
  ok(reader.rows.every((r) => r.isThisMachine === false),
    'CONTROL — every row is a FOREIGN installation, the whole point of this fixture');
  ok(reader.rows.some((r) => r.isThisHost === true), 'CONTROL — while every one is this HOST');
  ok(reader.rows.every((r) => r.showsMachine !== true && !/macbook|notebook/.test(r.sublabel || '')),
    'NO row names a machine: one computer, two installations, and `isThisHost` is what says so');
  eq(reader.rows.map((r) => r.label), real.rows.map((r) => r.label),
    'and the two views render IDENTICALLY, which is the property v3.38.0 did not have');

  // ── TWO INSTALLATIONS, ONE MAC — what `localIds` is for ────────────────
  const twoInstalls = build([
    R({ scope: 'session-2026-08-30-shared', writtenAt: at(122400),
      machine: 'alpha-macbook-pro-acb035', isThisMachine: false, isThisHost: true, headline: 'h' }),
    R({ scope: 'session-2026-08-30-other', writtenAt: at(129600), harness: 'harness-two',
      machine: 'alpha-macbook-pro-9f3c1a', isThisMachine: true, isThisHost: true, headline: 'h' }),
    R({ scope: 'session-2026-08-30-remote', writtenAt: at(140000), harness: 'harness-two',
      machine: 'studio-c40b17', isThisMachine: false, isThisHost: false, headline: 'h' }),
  ]);
  eq(new Set(twoInstalls.rows.slice(0, 2).map((r) => model.installIdPart(r.machine))).size, 2,
    'CONTROL — the first two rows carry two DIFFERENT installation ids');
  ok(twoInstalls.rows.filter((r) => r.isThisHost).every((r) => r.showsMachine !== true),
    'both are this Mac, so NEITHER names a machine — while a genuinely remote row in the same store does…');
  ok(twoInstalls.rows.some((r) => r.machine === 'studio-c40b17' && r.showsMachine === true),
    '…the studio row names itself, so the store really is multi-computer and the rule above is doing work');

  // ── NOTHING A BUDGET REMOVED IS UNREACHABLE ────────────────────────────
  let checked = 0;
  for (const [raw, m] of [[REAL, real], [ADV, adv], [READER, reader]]) {
    for (const r of m.rows) {
      const src = raw.find((x) => x.scope === r.scope && x.machine === r.machine);
      ok(r.toolTip.includes(src.machine), `row ${checked}: the full machine folder is in the tooltip`);
      ok(r.toolTip.includes(src.scope), `row ${checked}: the FULL scope, date prefix and all`);
      ok(r.toolTip.includes(src.harness), `row ${checked}: the harness`);
      ok(r.toolTip.includes(src.project), `row ${checked}: the project`);
      ok(r.toolTip.includes('model: ' + src.model), `row ${checked}: and the EXACT model string, not the family token`);
      checked++;
    }
  }
  eq(checked, 15, `all ${checked} rows across three fixtures were checked, so the loop is not vacuous`);
}


// ═══════════════════════════════════════════════════════════════════════════
section('§21 line two: `[warnings ·][machine ·]model — headline`, whole-token dropping, and D1/D2');
{
  const at = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
  const R = (over) => ({
    project: 'projects', machine: 'laptop-a1b2c3', harness: 'harness-one',
    model: 'demo-4-6', ageSource: 'agent', isThisMachine: true, isThisHost: true,
    writtenAt: at(600), headline: 'a reasonably long agent sentence about the work', ...over,
  });
  const build = (scopes) => model.buildTrayModel({ ok: true, scopes, total: scopes.length }, { now: NOW });

  const mixed = build([
    R({ scope: 'a' }), R({ scope: 'b', harness: 'harness-two', model: 'other-3-pro' }),
    R({ scope: 'c', project: 'other', machine: 'studio-9f8e7d', isThisMachine: false, isThisHost: false }),
  ]);
  ok(mixed.rows.every((r) => r.sublabel.length <= model.MAX_HEADLINE_CHARS),
    `every sublabel fits the ${model.MAX_HEADLINE_CHARS}-character budget the smaller face buys`);
  eq(mixed.rows[0].sublabel, 'demo-4.6 — a reasonably long agent sentence a…', 'an ordinary line two: the model family, then the agent\'s sentence, visibly clipped');
  ok(mixed.rows.every((r) => !new RegExp('\\b' + r.harness + '\\b').test(r.sublabel)),
    'the harness is NOT repeated on line two — it is on line one, where the row\'s identity is');

  // ── TOKENS GO WHOLE, LOWEST PRIORITY FIRST ─────────────────────────────
  const crowded = build([
    R({ scope: 'a', project: 'payments-reconciliation', headline: 'x'.repeat(200) }),
    R({ scope: 'b', project: 'settlement-adapter', harness: 'harness-two', model: 'other-3-pro',
      machine: 'buildbox-9f8e7d', isThisMachine: false, isThisHost: false, headline: 'y'.repeat(200) }),
  ]);
  const pressured = crowded.rows.find((r) => r.showsMachine);
  const roomy = crowded.rows.find((r) => !r.showsMachine);
  ok(pressured && roomy, 'CONTROL — the fixture holds one row carrying a machine and one that does not');
  ok(pressured && pressured.showsModel === true && roomy.showsModel === true,
    'with room, both keep the model — the machine (8 chars) does not push the headline under its floor');
  const tight = build([
    R({ scope: 'b', harness: 'harness-two', model: 'some-vendor/an-extremely-long-model-name-4-turbo',
      machine: 'a-very-long-build-machine-9f8e7d', isThisMachine: false, isThisHost: false, headline: 'y'.repeat(200) }),
    R({ scope: 'a' }),
  ]).rows.find((r) => r.showsMachine);
  ok(tight && !tight.showsModel && tight.showsMachine,
    'under real pressure the MODEL goes first and the MACHINE, which outranks it, survives');
  ok(tight && !tight.sublabel.split(' — ')[0].includes('…'),
    'no token is left as a FRAGMENT — a dropped token leaves nothing behind');
  ok(tight && tight.toolTip.includes('model: some-vendor/an-extremely-long-model-name-4-turbo'),
    'and the tooltip still names the model in full, which is what makes dropping it safe');
  ok(crowded.rows.every((r) => !new RegExp('\\b' + r.project + '\\b').test(r.sublabel || '')),
    'no row repeats its project on line two — line one says it');

  // ── THE HANDOVER MARK, COMPARED BY TOOL (D1) ───────────────────────────
  const handover = build([
    R({ scope: 'b', previousHarness: 'harness-two', writtenAt: at(900) }),
  ]);
  ok(handover.rows[0].sublabel.startsWith('harness-one ← harness-two'),
    'a row that changed hands draws `now ← before` on line two — whole, and never dropped');
  ok(handover.rows[0].toolTip.includes('the save before it came from harness-two'), '…and says it in a sentence in the tooltip');
  const sameTool = build([R({ scope: 'b', harness: 'Claude Code (desktop)', previousHarness: 'Claude Code' })]);
  ok(!sameTool.rows[0].sublabel.includes('←') && sameTool.rows[0].previousHarness === null,
    'D1: `Claude Code (desktop)` after `Claude Code` is ONE tool typed two ways — no handover mark');
  ok(sameTool.rows[0].label.includes('Claude Code') && /recorded as “Claude Code \(desktop\)”/.test(sameTool.rows[0].toolTip),
    '…the row says `Claude Code`, and the agent\'s own spelling stays in the tooltip');
  const realHandover = build([R({ scope: 'b', harness: 'Claude Desktop', previousHarness: 'claude-code' })]);
  ok(realHandover.rows[0].sublabel.startsWith('Claude Desktop ← Claude Code'),
    'CONTROL — Claude Desktop after Claude Code IS a handover: two products, never merged');

  // ── `handoff trimmed`, AND ONLY FOR `trimmed` ──────────────────────────
  const kinds = build([
    R({ scope: 'a', kind: 'trimmed' }), R({ scope: 'b', kind: 'clipped', writtenAt: at(700) }),
    R({ scope: 'c', kind: 'complete', writtenAt: at(800) }),
    R({ scope: 'd', kind: null, writtenAt: at(900) }),
  ]);
  const byScope = (m, sc) => m.rows.find((r) => r.scope === sc);
  ok(byScope(kinds, 'a').sublabel.startsWith(model.SUBLABEL_TRIMMED), 'a TRIMMED save is badged, and the badge leads the line');
  ok(['b', 'c', 'd'].every((sc) => !byScope(kinds, sc).sublabel.includes(model.SUBLABEL_TRIMMED)),
    'and clipped, complete and unknown are all silent — a shortened summary is not lost content');
  ok(byScope(kinds, 'a').toolTip.includes('part of the handoff was not stored'), 'with the tooltip saying what it means');

  // ── THE FLOOR: warnings outrank the sentence ───────────────────────────
  const squeezed = build([
    R({ scope: 'a', kind: 'trimmed', previousHarness: 'harness-two', harness: 'harness-one', headline: 'z'.repeat(200) }),
  ]);
  ok(squeezed.rows[0].sublabel.includes(model.SUBLABEL_TRIMMED) && squeezed.rows[0].sublabel.includes('←'),
    'when the line will not hold everything, BOTH warnings stay and the HEADLINE gives way');
  ok(!squeezed.rows[0].sublabel.includes('zzz') && squeezed.rows[0].sublabel.length <= model.MAX_HEADLINE_CHARS,
    '…the agent\'s sentence is not on the row at all, and the line is still inside its budget');
  const absurd = build([R({ scope: 'a', kind: 'trimmed', harness: 'h'.repeat(40), previousHarness: 'g'.repeat(40) })]);
  ok(absurd.rows[0].sublabel.length <= model.MAX_HEADLINE_CHARS && absurd.rows[0].sublabel.endsWith('…')
    && absurd.rows[0].sublabel.startsWith(model.SUBLABEL_TRIMMED),
    'a pathological harness name never renders unbounded; the badge leads and the clip is visible');
  ok(absurd.rows[0].toolTip.includes('the save before it came from'), '…and the handover is still in the tooltip');

  // ── D2: THE MODEL FAMILY KEEPS THE MINOR VERSION ───────────────────────
  const fam = {
    'claude-opus-5-5': 'opus-5.5', 'claude-opus-4-8': 'opus-4.8', 'claude-opus-5[1m]': 'opus-5',
    'claude-fable-5-1': 'fable-5.1', 'claude-haiku-4-5': 'haiku-4.5', 'claude-haiku-4-5-20251001': 'haiku-4.5',
    'claude-3-5-sonnet-20241022': 'sonnet-3.5', 'opus-4-6': 'opus-4.6', 'anthropic/sonnet-4-6': 'sonnet-4.6',
    'gemini-3.7-flash': 'gemini-3.7-flash', 'gemini-2.5-flash-lite': 'gemini-2.5-flash', 'gemini-3-pro': 'gemini-3-pro',
    'gpt-4o': 'gpt-4o', 'gpt-5-codex': 'gpt-5-codex', 'claude-sonnet-4-5-thinking': 'sonnet-4.5', 'claude': 'claude',
    'gemini-3.7-pro-preview': 'gemini-3.7-pro',
  };
  for (const [id, want] of Object.entries(fam)) eq(model.familyOfModel(id), want, `${id} → ${want}`);
  ok(model.familyOfModel('claude-opus-5-5') !== model.familyOfModel('claude-opus-5-1'),
    'two Claude minor versions are two tokens — the drop that read both as opus-5 is fixed');
  ok(model.familyOfModel('gemini-3.7-flash') !== model.familyOfModel('gemini-3.7-pro'),
    'and a Gemini tier survives, because Flash and Pro are two different models');
  for (const junk of [undefined, null, 42, '', '   ', {}, '[1m]']) {
    eq(model.familyOfModel(junk), null, `and ${JSON.stringify(junk) ?? String(junk)} has no family`);
  }
  ok(model.familyOfModel('a'.repeat(80)).length <= model.MODEL_LABEL_CHARS,
    'a pathological model id is capped rather than becoming the whole line');
}


// ═══════════════════════════════════════════════════════════════════════════
section('§22 the per-row submenu, the headline\'s second line, and the new notice');
{
  const at = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
  const m = model.buildTrayModel({
    ok: true, total: 2,
    lastSave: { project: 'projects', scope: 'main', writtenAt: at(600), ageSource: 'agent',
      harness: 'harness-one', model: 'demo-4-6' },
    scopes: [
      { project: 'projects', scope: 'main', machine: 'laptop-a1b2c3', harness: 'harness-one',
        model: 'demo-4-6', writtenAt: at(600), ageSource: 'agent', headline: 'h',
        isThisMachine: true, isThisHost: true },
      { project: 'projects', scope: 'other', machine: 'studio-9f8e7d', harness: 'harness-two',
        model: 'demo-4-6', writtenAt: at(60), ageSource: 'agent', headline: 'h2',
        isThisMachine: false, isThisHost: false },
    ],
  }, { now: NOW });

  let lastAction = null;
  const t = menu.buildTrayMenuTemplate(m, {
    ...NOOPS, onRowAction: (row, action) => { lastAction = [row.scope, action]; },
  });
  const rowItem = t.find((i) => i.id === 'tray-row-0');
  ok(!!rowItem, 'CONTROL — a row item exists to inspect');

  // THE FOUR IDS ARE A CONTRACT, addressable without matching a label.
  const ids = rowItem.submenu.filter((i) => i.type !== menu.MENU_HEADER_TYPE).map((i) => i.id);
  eq(ids, menu.ROW_ACTIONS.map(([a]) => menu.rowActionId('tray-row-0', a)),
    'the submenu carries exactly the four action ids, in the declared order');
  eq(rowItem.submenu[0].type, menu.MENU_HEADER_TYPE,
    'under a HEADER naming the work-stream, because a submenu opens beside five near-identical rows');
  eq(rowItem.submenu[0].label, 'projects · other', '…and it names THIS row\'s work-stream, project and scope');
  ok(rowItem.submenu.every((i) => i.type === menu.MENU_HEADER_TYPE || typeof i.click === 'function'),
    'every action carries a click handler');
  ok(typeof rowItem.click !== 'function',
    'while the PARENT carries none — on macOS a click on it opens the submenu, and a handler beside that fires unpredictably');

  // OPEN keeps its own dedicated handler; the other three go through one seam.
  let opened = null;
  const t2 = menu.buildTrayMenuTemplate(m, {
    ...NOOPS, onOpenScope: (r) => { opened = r.scope; },
    onRowAction: (row, action) => { lastAction = [row.scope, action]; },
  });
  // Rows are NEWEST FIRST, so `other` (60s) is row 0 and `main` (600s) is row 1.
  // Driven on row 1 deliberately: a handler wired to the wrong row is invisible
  // when the row you test is the first one.
  eq(m.rows[1].scope, 'main', 'CONTROL — row 1 is the OLDER scope, so a first-row-only wiring bug would show');
  const sub2 = t2.find((i) => i.id === 'tray-row-1').submenu;
  sub2.find((i) => i.id === menu.rowActionId('tray-row-1', menu.ID_ROW_OPEN)).click();
  eq(opened, 'main', 'Open in The Curator reaches onOpenScope with the row it belongs to');
  for (const action of [menu.ID_ROW_RESUME, menu.ID_ROW_HANDOFF, menu.ID_ROW_REVEAL]) {
    lastAction = null;
    sub2.find((i) => i.id === menu.rowActionId('tray-row-1', action)).click();
    eq(lastAction, ['main', action], `${action} reaches onRowAction with the row AND the action`);
  }

  // A MISSING onRowAction is refused at BUILD time, like every other handler.
  {
    const partial = { ...NOOPS };
    delete partial.onRowAction;
    let threw = false;
    try { menu.buildTrayMenuTemplate(m, partial); } catch (e) { threw = /must be a function/.test(e.message); }
    ok(threw, 'a missing onRowAction is refused at build time — an optional one is a submenu that silently does nothing');
  }

  // QUIT IS STILL A ROLE, and the submenu did not open a second door to exit.
  const flat = menu.flattenTrayMenu(t);
  const quit = flat.find((i) => i.id === menu.ID_QUIT);
  eq(quit.role, 'quit', 'Quit is STILL role:quit after the submenu work');
  eq(typeof quit.click, 'undefined', 'and STILL carries no click handler');
  ok(flat.filter((i) => i.role).every((i) => typeof i.click !== 'function'),
    'and no item in the whole template — submenus included — pairs a role with a handler');

  // ── THE HEADLINE'S SECOND LINE IS GONE (Layout A) ────────────────────
  //
  // `harness · model` said, in grey and with no noun, what the first row now
  // says on line one (the harness) and line two (the model). The hover keeps
  // the fast answer: `Last save: <project> · <harness> · <age>`.
  ok(!flat.some((i) => i.id === 'tray-headline-where' || i.id === 'tray-headline'), 'no headline and no second line in the menu');
  eq(m.headline.text, 'Last save: projects · harness-two · 1 min ago', 'the icon\'s tooltip names the newest save: project, tool, age');
  const anon = model.buildTrayModel({
    ok: true, total: 1,
    scopes: [{ project: 'p', scope: 's', machine: 'm-a1b2c3', writtenAt: at(60), ageSource: 'agent' }],
  }, { now: NOW });
  eq(anon.headline.text, 'Last save: p · unknown tool · 1 min ago', 'a save naming no tool says so, rather than leaving a gap');

  // ── `<machine> saved after this Mac` ───────────────────────────────────
  const notice = m.notices.find((n) => n.kind === 'newer-elsewhere');
  ok(!!notice, 'a genuinely foreign row newer than every local one produces the notice');
  ok(notice.text.startsWith('studio') && /saved after this Mac/.test(notice.text),
    `and it names the machine: "${notice ? notice.text : ''}"`);
  ok(notice.full.includes('projects · other'),
    'with the work-stream on its tooltip, because "which computer" alone is not yet actionable');
  ok(notice.text.length <= model.PLAIN_LABEL_CHARS, 'and it fits the plain-item budget');

  // IT MUST NEVER FIRE OFF A FILE CLOCK. git rewrites mtime on checkout, so a
  // file-clock notice would announce "the other computer just saved" at the
  // moment YOU pulled, every time, forever.
  const fileClock = model.buildTrayModel({
    ok: true, total: 2,
    scopes: [
      { project: 'p', scope: 'remote', machine: 'studio-9f8e7d', writtenAt: at(60),
        ageSource: 'file', isThisMachine: false, isThisHost: false, headline: 'h' },
      { project: 'p', scope: 'local', machine: 'laptop-a1b2c3', writtenAt: at(9000),
        ageSource: 'agent', isThisMachine: true, isThisHost: true, headline: 'h' },
    ],
  }, { now: NOW });
  eq(fileClock.notices.filter((n) => n.kind === 'newer-elsewhere').length, 0,
    'a remote row on the FILE clock produces NOTHING — mtime is the moment of the pull, not of the save');

  // AND "AFTER THIS MAC" NEEDS A THIS-MAC TO BE AFTER.
  const noLocal = model.buildTrayModel({
    ok: true, total: 1,
    scopes: [{ project: 'p', scope: 'remote', machine: 'studio-9f8e7d', writtenAt: at(60),
      ageSource: 'agent', isThisMachine: false, isThisHost: false, headline: 'h' }],
  }, { now: NOW });
  eq(noLocal.notices.filter((n) => n.kind === 'newer-elsewhere').length, 0,
    'and a store with no local agent-clock row produces nothing either — there is no "after"');
  // ── A SECOND INSTALLATION COUNTS AS LOCAL WHEN DECIDING "AFTER" ──────
  //
  // CHASED FROM A MUTATION THAT CAME BACK GREEN. Swapping the local filter from
  // `isThisHost` to `isThisMachine` passed everything, because every fixture set
  // the two together. It is wrong on the maintainer's own store: his newest
  // saves come from an installation that is NOT the app's, so an
  // `isThisMachine` filter would ignore them and announce that another computer
  // had got ahead every time one had merely saved earlier.
  const secondInstall = model.buildTrayModel({
    ok: true, total: 3,
    scopes: [
      // The other computer, in the middle.
      { project: 'p', scope: 'remote', machine: 'studio-9f8e7d', writtenAt: at(3600),
        ageSource: 'agent', isThisMachine: false, isThisHost: false, headline: 'h' },
      // This Mac, but NOT this installation — and the NEWEST thing in the store.
      { project: 'p', scope: 'agents', machine: 'laptop-9f3c1a', writtenAt: at(600),
        ageSource: 'agent', isThisMachine: false, isThisHost: true, headline: 'h' },
      // This installation, and older than the remote row.
      { project: 'p', scope: 'app', machine: 'laptop-acb035', writtenAt: at(7200),
        ageSource: 'agent', isThisMachine: true, isThisHost: true, headline: 'h' },
    ],
  }, { now: NOW });
  eq(secondInstall.notices.filter((n) => n.kind === 'newer-elsewhere').length, 0,
    'a second INSTALLATION on this Mac counts as this Mac — its save is newer, so no other computer got ahead');
  ok(secondInstall.rows.some((r) => r.isThisHost && !r.isThisMachine),
    'CONTROL — the fixture really does carry a this-host, other-installation row');
  ok(secondInstall.rows.some((r) => !r.isThisHost),
    'CONTROL — and a genuinely foreign one, so the comparison had two sides to make');
  // The same store with that row REMOVED does produce the notice, which is what
  // proves the assertion above is about the row and not about the fixture.
  const withoutSecond = model.buildTrayModel({
    ok: true, total: 2,
    scopes: [
      { project: 'p', scope: 'remote', machine: 'studio-9f8e7d', writtenAt: at(3600),
        ageSource: 'agent', isThisMachine: false, isThisHost: false, headline: 'h' },
      { project: 'p', scope: 'app', machine: 'laptop-acb035', writtenAt: at(7200),
        ageSource: 'agent', isThisMachine: true, isThisHost: true, headline: 'h' },
    ],
  }, { now: NOW });
  eq(withoutSecond.notices.filter((n) => n.kind === 'newer-elsewhere').length, 1,
    'CONTROL — drop that row and the notice DOES fire, so the check above can fail');

  // A SECOND INSTALLATION ON THIS MAC IS NOT ANOTHER MAC.
  const sameMac = model.buildTrayModel({
    ok: true, total: 2,
    scopes: [
      { project: 'p', scope: 'app', machine: 'laptop-acb035', writtenAt: at(60),
        ageSource: 'agent', isThisMachine: false, isThisHost: true, headline: 'h' },
      { project: 'p', scope: 'repo', machine: 'laptop-a1b2c3', writtenAt: at(9000),
        ageSource: 'agent', isThisMachine: true, isThisHost: true, headline: 'h' },
    ],
  }, { now: NOW });
  eq(sameMac.notices.filter((n) => n.kind === 'newer-elsewhere').length, 0,
    'a second INSTALLATION on this Mac never triggers it — that is the phantom computer this release removes');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§23 main.js wiring for the submenu — source scan, WEAK like §11');
//
// `desktop/main.js` cannot be imported, evaluated or run by `npm test`:
// Electron is deliberately not an offline dependency. Everything below proves
// a line was WRITTEN and nothing about what it does. That is why the decisions
// are in `lib/resume-prompt.js` and `src/brain/tray-summary.js`, which the
// suite executes for real, and why main.js holds only the three Electron calls
// it cannot give away.
{
  const src = read(path.join(DESKTOP, 'main.js'));
  const code = stripJsComments(src);
  ok(/function runRowAction/.test(code),
    'CONTROL — the stripper leaves real code behind (a scan over an empty string passes everything)');

  ok(/onRowAction:\s*\(row, action\)/.test(code), 'the menu is given an onRowAction handler');
  for (const id of ['ID_ROW_RESUME', 'ID_ROW_HANDOFF', 'ID_ROW_REVEAL']) {
    ok(new RegExp(`action === ${id}`).test(code), `${id} is dispatched by its exported CONSTANT, not by a retyped string`);
  }
  ok(/import \{[^}]*ID_ROW_RESUME[^}]*\} from '\.\/lib\/tray-menu\.js'/.test(code.replace(/\n/g, ' ')),
    '…and those constants are IMPORTED from tray-menu.js, so a rename cannot leave the shell matching a dead value');
  ok(/composeResumePrompt|composeHandoffMarkdown/.test(code),
    'the two composers are imported rather than reimplemented here');
  ok(/clipboard\.writeText/.test(code), 'clipboard.writeText is the copy call');
  ok(/shell\.showItemInFolder/.test(code), 'and shell.showItemInFolder is the reveal call');
  // ── AND BOTH ARE IMPORTED, WHICH THE FIRST DRAFT WAS NOT ─────────────
  //
  // `clipboard` was USED and never imported. Node's ESM loader does not resolve
  // a bare identifier at parse time, so `node --check` passed, every offline
  // suite passed, and the failure would have been a `ReferenceError` at CLICK
  // time — in front of the user, in a handler whose catch would have swallowed
  // it into a Copy that silently did nothing. Found by reading the import line,
  // not by any assertion, which is why there is now an assertion.
  const electronImport = (code.match(/import \{([^}]*)\} from 'electron'/) || [])[1] || '';
  ok(/\bclipboard\b/.test(electronImport),
    'and `clipboard` is IMPORTED from electron — a used-but-unimported binding fails at click time, not at build time');
  ok(/\bshell\b/.test(electronImport) && /\bdialog\b/.test(electronImport),
    '…as are `shell` and `dialog`, the other two the submenu handler reaches for');
  ok(electronImport.length > 40, 'CONTROL — the import list was really found and is not an empty match');

  // NO SECOND READER. The whole argument for delegating to the store is that
  // this path ends at a clipboard, and a `readFile` on current.md would reach it
  // without the read-side sanitiser.
  // Narrowed to what the rule actually forbids. main.js legitimately reads its
  // own config and its own package.json; what it must never do is open a
  // WORKING-STATE file, because that path ends at a clipboard and would bypass
  // the store's read-side sanitiser.
  ok(!/current\.md/.test(code.replace(/path\.join\([^)]*'current\.md'\)/g, '')) || /showItemInFolder/.test(code),
    'CONTROL — the only mention of current.md is the Finder reveal, which opens nothing');
  ok(!/readFile\w*\([^)]*state[^)]*\)/.test(code),
    'and main.js READS no state file of its own — the handoff comes from the store\'s sanitised read');
  ok(/getHandoffMarkdown/.test(code),
    'CONTROL — it reaches the store\'s reader by name, so the assertion above is about a real alternative');

  // THE SAFETY PROPERTY, RE-ASSERTED AFTER THE CHANGE. A new code path that
  // could reach app.exit() would walk past the write guard `before-quit` runs.
  // Measured INSIDE the new function rather than over the whole file: main.js
  // has pre-existing, legitimate `app.exit()` call sites (the single-instance
  // guard and the fatal-boot path), and asserting a file-wide zero would be an
  // assertion about them rather than about the submenu.
  const fnStart = code.indexOf('async function runRowAction');
  ok(fnStart > 0, 'CONTROL — runRowAction is findable in the stripped source');
  const fnBody = code.slice(fnStart, code.indexOf('\n}', fnStart));
  ok(fnBody.length > 200, `CONTROL — and the extracted body is real (${fnBody.length} chars), not an empty slice`);
  ok(!/app\.exit|process\.exit|app\.quit/.test(fnBody),
    'the submenu handler reaches NO exit path — a hand-rolled quit would walk past the write guard before-quit runs');
  ok(!/role:\s*'quit'[^}]*click/.test(code), 'and no quit role anywhere is paired with a handler');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§24 the collision is decided over the WHOLE ROW, and no age reads in the hundreds');
//
// ── THE PHOTOGRAPH ────────────────────────────────────────────────────────
//
// The maintainer installed v3.42.0, opened his own menubar widget, and two
// rows read:
//
//   brand-buil… — Antigravity · 1271 min ago
//   brand-buil… — Antigravity · 1271 min ago
//
// Every part of that is wrong, and all of it came from ONE mistaken premise.
// The two rows are the same scope topic saved in two DIFFERENT PROJECTS —
// `posts` and `projects` — thirty seconds apart. Line TWO already said which
// was which. The resolver compared line ONE alone, declared a collision no
// reader could have seen, and then:
//
//   (a) escalated the age twice even though neither step separated anything —
//       violating this file's own "an escalation that buys nothing is handed
//       back" rule, which it applied only at the END of the ladder;
//   (b) printed `1271 min ago`, a number nobody writes and nobody reads;
//   (c) restored a provenance token INTO the tail, so the topic — the one
//       component the whole exercise was supposed to disambiguate — was
//       clipped to its ten-character floor, leaving both rows reading the
//       identical eleven characters they started with.
//
// The fixture below is those five rows, with the maintainer's hostname
// replaced (this is a public repository). It is the real store's shape: one
// machine, one harness on three rows and another on two, and a scope topic
// that genuinely appears twice.
{
  const PHOTO_NOW = new Date('2026-09-02T14:06:00');
  const ago = (s) => new Date(PHOTO_NOW.getTime() - s * 1000).toISOString();
  const P = (o) => ({ machine: 'alices-macbook-pro-9f3c1a', ageSource: 'agent',
    isThisMachine: false, isThisHost: true, ...o });
  // 76,260 and 76,290 seconds: twenty-one hours old, thirty seconds apart, and
  // both inside the SAME MINUTE — which is what made the old minute escalation
  // buy literally nothing and print 1271 on both rows.
  const TWIN_A = 76260, TWIN_B = 76290;
  const photoScopes = () => [
    P({ project: 'projects', scope: 'session-2026-09-02-audit-and-plan', harness: 'claude-code',
      writtenAt: ago(30), writtenAgeSeconds: 30,
      headline: 'Shared Brain e2e PASSED end to end on two machines' }),
    P({ project: 'posts', scope: 'session-2026-09-01-brand-building-social-engine', harness: 'Antigravity',
      writtenAt: ago(TWIN_A), writtenAgeSeconds: TWIN_A,
      headline: 'Brand-building and social engine drafted' }),
    P({ project: 'projects', scope: 'session-2026-09-01-brand-building-social-engine', harness: 'Antigravity',
      writtenAt: ago(TWIN_B), writtenAgeSeconds: TWIN_B,
      headline: 'Global Curator skill and the posting cadence' }),
    P({ project: 'projects', scope: 'session-2026-09-01-menubar-widget-design', harness: 'claude-code',
      model: 'opus-4-6', writtenAt: ago(75600), writtenAgeSeconds: 75600,
      headline: 'SESSION COMPLETE — widget shipped' }),
    P({ project: 'projects', scope: 'session-2026-08-31-native-prep-and-release-process', harness: 'claude-code',
      model: 'opus-4-6', writtenAt: ago(140400), writtenAgeSeconds: 140400,
      headline: 'FOUR RELEASES SHIPPED (v3.31-v3.34)' }),
  ];
  const photo = model.buildTrayModel(
    { ok: true, total: 5, scopes: photoScopes(), brief: null, remote: null, warnings: [], pulse: null },
    { now: PHOTO_NOW });

  // ── UNDER LAYOUT A THE COLLISION CANNOT HAPPEN ────────────────────────
  //
  // The two same-topic saves are two (project × tool) rows now — `projects ·
  // Antigravity` and `posts · Antigravity` — so line one differs by the fact
  // that separates them, the PROJECT, and no resolver runs at all.
  eq(photo.rows.length, 5, 'CONTROL — all five photographed saves are rows, so nothing below is vacuous');
  eq(photo.active.rows.map((r) => r.label),
    ['projects · Claude Code · just now', 'projects · Antigravity · 21 hr ago', 'posts · Antigravity · 21 hr ago'],
    'three face rows: the store\'s two tools on `projects`, adjacent and newest first, then `posts`');
  const twins = photo.rows.filter((r) => r.scope.includes('brand-building'));
  eq(twins.length, 2, 'CONTROL — the two same-topic saves are both rows');
  ok(twins[0].label !== twins[1].label, 'and they read differently on LINE ONE, by project — the photograph\'s pair is gone by construction');
  ok(twins.every((r) => / 21 hr ago$/.test(r.label)), '…each with the age a person reads');
  eq(photo.active.rows[0].streams.map((r) => r.label),
    ['menubar-widget-design · 21 hr ago', 'native-prep-and-release-pro… · 1 day ago'],
    'the Claude Code row\'s other work-streams, `scope · age`: the date prefix dropped because the age says it, and a long scope clipped so the AGE never is');

  // AND THE NUMBER FROM THE PHOTOGRAPH IS UNREACHABLE, ANYWHERE ON THE MENU.
  const everyLine = photo.rows.map((r) => r.label + ' ' + (r.sublabel || '')).join(' | ');
  ok(!/1271 min/.test(everyLine), 'the photographed `1271 min ago` appears on no line of this menu');
  ok(!/\b\d{3,} min ago\b/.test(everyLine),
    '…nor does any other three-digit minute count, which is the class the photograph belonged to');

  // ── THE CEILING ON THE MINUTE FLOOR, DRIVEN DIRECTLY ──────────────────
  eq(model.MINUTE_PRECISION_MAX_MINUTES, 120,
    'the minute floor stops at two hours — past that a minute count is arithmetic, not a time');
  eq(model.formatAge(7139, 'minute'), '118 min ago',
    'CONTROL — under the ceiling the minute floor still does its job, so the assertions below are not vacuous');
  eq(model.formatAge(7199, 'minute'), '119 min ago', '…right up to the last minute below it');
  eq(model.formatAge(7200, 'minute'), '2 hr ago', 'and at the ceiling it becomes hours');
  eq(model.formatAge(76260, 'minute'), '21 hr ago',
    'so the photograph\'s own age, asked for in minutes, answers in hours');
  // THE DEGRADATION IS TO THE HOUR FLOOR, NOT TO THE UNFLOORED LADDER — so a
  // finer precision can never produce a COARSER reading than the rung below it.
  eq(model.formatAge(200000, 'minute'), '55 hr ago',
    'a two-day-old row under a MINUTE floor still reads in hours, never `2 days ago` — the ladder stays monotonic');
  eq(model.formatAge(200000, 'hour'), '55 hr ago', '…identical to the hour floor, which is what "degrades to" means');
  eq(model.formatAge(200000), '2 days ago',
    'CONTROL — with no floor at all the ordinary ladder still says days, so the two above are a real difference');
  eq(model.formatAge(3000), '50 min ago', 'CONTROL — and the one-argument ladder is untouched by any of this');

  // ── TWO IDENTICAL SAVES IN TWO PROJECTS ───────────────────────────────
  // The resolver's last-resort case — the same topic, the same sentence, the
  // same tool, thirty seconds apart — is two rows that differ by project.
  const twinsOneProject = model.buildTrayModel({
    ok: true, total: 2, scopes: [
      P({ project: 'posts', scope: 'session-2026-09-01-brand-building-social-engine', harness: 'Antigravity',
        writtenAt: ago(TWIN_A), writtenAgeSeconds: TWIN_A, headline: 'same sentence on both rows' }),
      P({ project: 'projects', scope: 'session-2026-09-01-brand-building-social-engine', harness: 'Antigravity',
        writtenAt: ago(TWIN_B), writtenAgeSeconds: TWIN_B, headline: 'same sentence on both rows' }),
    ], brief: null, remote: null, warnings: [], pulse: null,
  }, { now: PHOTO_NOW });
  eq(twinsOneProject.rows.map((r) => r.label), ['posts · Antigravity · 21 hr ago', 'projects · Antigravity · 21 hr ago'],
    'identical sentences on both lines two, and still two readable rows — no escalation, no machine name, no clipped topic');
  ok(twinsOneProject.rows.every((r) => r.toolTip.includes('brand-building-social-engine') && r.toolTip.includes('Antigravity')),
    'and the full scope and tool are in every tooltip');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§25 projects[].latest — the data package\'s shape, its fallbacks, and the menu as TEXT');
//
// The data package (v3.74.0, D3) adds `projects[].latest`: the newest save per
// (project × tool) for EVERY project, whatever the 40-pair row window holds.
// Its entries spell the harness as `harness` (the LABEL) beside `harnessRaw`,
// while a scope row keeps `harness` (RAW) beside `harnessLabel`. Built here in
// exactly that shape, with the fallbacks the model must survive: `latest`
// null (a project whose index was not read), `latest` absent (an older
// producer), and a latest entry with no tool.
{
  const T = new Date('2026-09-25T14:27:00');
  const at = (s) => new Date(T.getTime() - s * 1000).toISOString();
  const host = { machine: 'mbp-9f3c1a', isThisHost: true, isThisMachine: false };
  const E = (harnessId, harness, raw, scope, age, over = {}) => ({ harnessId, harness, harnessRaw: raw, harnessVariant: null,
    model: 'claude-opus-5-5', scope, ...host, writtenAt: at(age), writtenAgeSeconds: age, ageSource: 'agent', headline: scope + ' work', kind: 'complete', ...over });
  const S = (project, scope, harness, harnessId, harnessLabel, age, over = {}) => ({ domain: 'projects', project, projectLabel: 'projects / ' + project, projectsInDomain: 5,
    scope, harness, harnessId, harnessLabel, model: 'claude-opus-5-5', ...host, writtenAt: at(age), writtenAgeSeconds: age, ageSource: 'agent', headline: scope + ' work', ...over });
  const summary = {
    ok: true, readAt: at(60),
    // The 40-pair window holds ott only …
    scopes: [
      S('ott', 'main', 'Claude Code (desktop)', 'claude-code', 'Claude Code', 480, { harnessShared: false }),
      S('ott', 'roadmap', 'antigravity', 'antigravity', 'Antigravity', 3 * 3600, { previousHarness: 'Claude Code' }),
    ],
    // … while `latest` knows every project, including an idle one the window never reached.
    projects: [
      { domain: 'projects', project: 'ott', projectLabel: 'projects / ott', latest: [
        E('claude-code', 'Claude Code', 'Claude Code (desktop)', 'main', 480),
        E('antigravity', 'Antigravity', 'antigravity', 'roadmap', 3 * 3600, { model: 'gemini-3.7-flash' }),
      ] },
      { domain: 'projects', project: 'field-notes', projectLabel: 'projects / field-notes', latest: [
        E('claude-code', 'Claude Code', 'claude-code', 'main', 9 * 86400, { model: 'claude-opus-5[1m]' }),
        E(null, null, null, 'untooled', 12 * 86400),
      ] },
      { domain: 'projects', project: 'unread', projectLabel: 'projects / unread', latest: null },
    ],
    warnings: [{ code: 'scopes-truncated', message: 'Showing the 40 most recent of 60 saved work-streams.' }],
  };
  const m = model.buildTrayModel(summary, { now: T });
  eq(m.active.rows.map((r) => r.label), ['ott · Claude Code · 8 min ago', 'ott · Antigravity · 3 hr ago'],
    'the face is built from `latest` — the scope row\'s raw `Claude Code (desktop)` reads as the LABEL, Claude Code');
  ok(/recorded as “Claude Code \(desktop\)”/.test(m.active.rows[0].toolTip), '…with the raw spelling kept in the tooltip');
  eq(m.active.rows[1].previousHarness, 'Claude Code', 'per-pair facts (the handover) are joined from the matching scope row');
  eq(m.active.rows.map((r) => r.modelFamily), ['opus-5.5', 'gemini-3.7-flash'], 'and the model families are D2\'s');
  eq(m.idle.rows.map((r) => r.label), ['field-notes · Claude Code · 1 week ago'],
    'field-notes has NO pair in the 40-row window and is still listed, idle, from `latest` — D3\'s whole point');
  eq(m.idle.rows[0].streams.map((r) => r.label), ['untooled · unknown tool · 1 week ago'],
    'a latest entry that named no tool is its own entry — a stream saying "unknown tool", never dropped and never merged');
  ok(!m.rows.some((r) => r.project === 'unread'), '`latest: null` with no rows → the project is not listed: not read is not "no saves"');
  eq(m.notices.filter((n) => n.code === 'scopes-truncated').length, 1,
    'CONTROL — one project\'s index was not read, so coverage is NOT complete and the truncation warning stays');
  const complete = model.buildTrayModel({ ...summary, projects: summary.projects.slice(0, 2) }, { now: T });
  eq(complete.notices.filter((n) => n.code === 'scopes-truncated').length, 0,
    '…and with `latest` for every listed project, the warning about a window the menu does not draw is not said');
  const noLatest = model.buildTrayModel({ ...summary, projects: summary.projects.map(({ latest, ...p }) => p) }, { now: T });
  eq(noLatest.active.rows.map((r) => r.label), m.active.rows.map((r) => r.label),
    'an OLDER producer (no `latest` at all) draws the same face from the scope rows');
  eq(noLatest.idle, null, '…and cannot list field-notes, whose saves it never saw — an absence, not a guessed age');

  // ── THE STATIC RENDER — the menu as text, for review without Electron ──
  const text = menu.renderTrayMenuText(menu.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (sp) => sp }));
  const lines = text.split('\n');
  eq(lines[0], '── Active · last 24 h ──', 'the text render opens on the Active header (no pulse in this fixture)');
  eq(lines[1], '●   ott · Claude Code · 8 min ago  ›   [recent]', 'a row: the dot and its tier, the label, the submenu mark');
  eq(lines[2], '    opus-5.5 — main work', '…and its sublabel on the next line');
  ok(lines.includes('      ── projects / ott · main ──') && lines.includes('          Copy resume prompt'),
    'submenus are indented under their parent, headers marked');
  ok(lines.includes('○   Idle · 1 project  ›   [dormant]') && lines.includes('    field-notes 1 wk'),
    'the Idle fold renders with its hollow dormant dot and its compact second line');
  ok(lines[lines.length - 1] === '    Quit The Curator   ⌘Q' && lines.includes('    (Updated 14:26)'),
    'disabled items in parentheses; Quit last with its key');
  ok(!/undefined|null|\[object/.test(text), 'and nothing in the render is an unrendered value');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§26 ONE collision notice per work-stream — the maintainer\'s real menu, reproduced');
//
// His v3.72 menu, one scope written A-B-A-B by claude-code and antigravity:
//   "Two harnesses are writing projects / fiel…"   (derived from harnessShared)
//   "Two agent tools are writing projects / fi…"   (the producer's warning)
// both greyed, both clipped before the scope, both below the domains. The
// derived line was keyed WITHOUT its domain and the warning WITH it, so the
// dedupe never matched. One line now, in the app's words, under the Active rows.
{
  const T = new Date('2026-09-25T14:27:00');
  const at = (s) => new Date(T.getTime() - s * 1000).toISOString();
  const collided = {
    domain: 'projects', project: 'field-notes', projectLabel: 'projects / field-notes', projectsInDomain: 5,
    scope: 's2-collision', machine: 'mbp-9f3c1a', harness: 'antigravity', writtenAt: at(300), ageSource: 'agent',
    headline: 'second tool took over', isThisHost: true, harnessShared: true,
    harnesses: ['claude-code', 'antigravity', 'Claude Code', 'antigravity'],
  };
  const summary = {
    ok: true,
    scopes: [collided,
      { ...collided, project: 'lumina', projectLabel: 'projects / lumina', scope: 'main', harness: 'claude-code', harnessShared: false, writtenAt: at(9 * 86400), harnesses: [] }],
    warnings: [{ code: 'harness-collision', message: 'Two agent tools are writing projects / field-notes · s2-collision.',
      domain: 'projects', project: 'field-notes', projectLabel: 'projects / field-notes', scope: 's2-collision',
      machine: 'mbp-9f3c1a', harnesses: ['claude-code', 'antigravity'] }],
    domains: [{ domain: 'projects', index: 0, pageCount: 767 }],
  };
  const m = model.buildTrayModel(summary, { now: T });
  const coll = m.notices.filter((n) => /writing/.test(n.full || n.text));
  eq(coll.length, 1, 'ONE notice for the collided work-stream — the derived line and the producer\'s warning are the same fact');
  eq(coll[0] && coll[0].text, 'Two tools are writing field-notes / s2-co…',
    '…in the app\'s words; at the 42-character plain budget the SCOPE\'s tail is what gives, never the verb or the project');
  ok(coll[0] && coll[0].full.includes('projects / field-notes / s2-collision'), '…with the whole work-stream on its tooltip');
  ok(coll[0] && /Claude Code and Antigravity/.test(coll[0].full), '…and the two tools named, normalised, in its tooltip');
  // Either source alone gives the same single line.
  const derivedOnly = model.buildTrayModel({ ...summary, warnings: [] }, { now: T }).notices.filter((n) => n.kind === 'collision');
  const suppliedOnly = model.buildTrayModel({ ...summary, scopes: summary.scopes.map((x) => ({ ...x, harnessShared: false })) }, { now: T })
    .notices.filter((n) => n.kind === 'collision');
  eq([derivedOnly.map((n) => n.text), suppliedOnly.map((n) => n.text)],
    [['Two tools are writing field-notes / s2-co…'], ['Two tools are writing field-notes / s2-co…']],
    'the row\'s own flag alone, or the producer\'s warning alone, draws the IDENTICAL line — so one source can supersede the other');
  // A DIFFERENT domain's `field-notes · s2-collision` is a different fact.
  const twoDomains = model.buildTrayModel({ ...summary, warnings: [{ ...summary.warnings[0], domain: 'articles' }] }, { now: T });
  eq(twoDomains.notices.filter((n) => n.kind === 'collision').length, 2,
    'CONTROL — the same project and scope in ANOTHER domain is a second notice, so the dedupe is on all three fields');

  // The producer emits one warning per (scope, MACHINE) pair: the same
  // collided work-stream seen from two machines is still ONE line.
  const twoMachines = model.buildTrayModel({ ...summary, warnings: [summary.warnings[0], { ...summary.warnings[0], machine: 'studio-c40b17' }] }, { now: T });
  eq(twoMachines.notices.filter((n) => n.kind === 'collision').length, 1,
    'two warnings for one work-stream from two machines are ONE notice');
  // A LONG project: the line may run past the budget rather than cut the
  // project or the verb — only the scope's tail gives.
  const longName = model.collisionLine('a-rather-long-project-name', 's2-collision');
  ok(longName.startsWith('Two tools are writing a-rather-long-project-name / s2') && longName.endsWith('…'),
    `a long project stays whole and the scope keeps its head: "${longName}"`);

  // PLACEMENT: directly under the Active rows, above Idle and Knowledge; actionable.
  let opened = null;
  const t = menu.buildTrayMenuTemplate(m, { ...NOOPS, onOpenScope: (r) => { opened = r.route; } });
  const ids = t.map((i) => i.id || i.type);
  const ni = t.findIndex((i) => i.label === 'Two tools are writing field-notes / s2-co…');
  const lastRow = Math.max(...m.active.rows.map((r) => ids.indexOf(r.id)));
  ok(ni > lastRow && ni < ids.indexOf(menu.ID_IDLE) && ni < ids.indexOf(menu.ID_KNOWLEDGE),
    'the notice sits under the Active rows — above the Idle fold and above Knowledge, not at the bottom');
  eq(t.filter((i) => /writing/.test(i.label || '')).length, 1, 'and the menu draws it exactly once');
  ok(t[ni].enabled === true && typeof t[ni].click === 'function', 'it is ENABLED (full contrast) and actionable');
  t[ni].click();
  eq(opened, 'projects/field-notes', '…opening that project in Project Context');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failed === 0 ? '✓' : '✗'} test-tray-shell: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
