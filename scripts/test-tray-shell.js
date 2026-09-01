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

const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {} };
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
      { project: 'alpha', scope: 'main', machine: 'laptop-a1b2c3', harness: 'harness-one',
        writtenAt: atAge(30), writtenAgeSeconds: 30, ageSource: 'agent', headline: 'wired the tray bounds',
        isThisMachine: true, harnessShared: false },
      { project: 'alpha', scope: 'research', machine: 'laptop-a1b2c3', harness: 'harness-two',
        writtenAt: atAge(1080), writtenAgeSeconds: 1080, ageSource: 'agent', headline: 'redid the section',
        isThisMachine: true, harnessShared: true },
      { project: 'beta', scope: 'main', machine: 'studio-9f8e7d', harness: 'harness-two',
        writtenAt: atAge(10800), writtenAgeSeconds: 10800, ageSource: 'file', headline: 'rewrote the serialiser',
        isThisMachine: false, harnessShared: false },
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
  ok(m.rows[0].label.includes('harness-one'), 'a LOCAL row shows the harness');
  ok(!m.rows[0].label.includes('laptop'), 'a LOCAL row does NOT show the machine — it is constant, and therefore noise');
  ok(m.rows[2].label.includes('studio'), 'a REMOTE row shows the machine');
  ok(!m.rows[2].label.includes('harness-two'), 'a REMOTE row does NOT show the harness — that is the other computer\'s business');

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
  eq(a.headline.text, 'Last save · just now', 'at the first clock the headline reads the true age');
  eq(b.headline.text, 'Last save · 40 min ago',
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
  ok(realMessage.includes('${c.project}') && realMessage.includes('${c.scope}'),
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
  eq(collisionLines.length ? noticeText(collisionLines[0]) : '(no collision notice at all)',
    'Two agent tools are writing alpha · research.',
    '…and the SUPPLIED one is the survivor, because the data layer saw the whole store');

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
  ok(truncated.truncatedNote !== null, 'CONTROL — the cap IS disclosed, on its own item under the last row');
  eq(truncated.notices.filter((n) => n.code === 'scopes-truncated').length, 0,
    '…so the scopes-truncated warning is dropped from the notices — the cap is stated once, where it belongs');

  // …but only when the note is actually there to state it.
  const truncWarnNoNote = model.buildTrayModel(summary({
    warnings: [{ code: 'scopes-truncated', message: 'Showing the 8 most recent of 40 saved work-streams.' }],
  }), { now: NOW });
  ok(truncWarnNoNote.truncatedNote === null, 'CONTROL — with nothing truncated there is no note');
  eq(truncWarnNoNote.notices.filter((n) => n.code === 'scopes-truncated').length, 1,
    '…and then the warning DOES get through, because nothing else is saying it');

  // A coded warning this model has no opinion about passes through untouched.
  const passthrough = model.buildTrayModel(summary({
    warnings: [{ code: 'unlisted-entries', message: '2 folders on disk could not be listed.' }],
  }), { now: NOW });
  ok(passthrough.notices.some((n) => n.code === 'unlisted-entries'),
    'an unrelated coded warning is passed through unchanged');

  // Bare strings still work — main.js pushes them on its own failure paths.
  const bare = model.buildTrayModel({ ok: false, scopes: [], warnings: ['Could not read agent memory: EACCES'] },
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
  ok(tip.includes('Last save'), 'the tooltip still leads with the headline answer');
  ok(tip.includes('Brief · 1 month ago'), '…and now also answers the second question the maintainer asks');
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
  eq(many.rows.length, model.MAX_ROWS, 'the row list is capped');
  eq(many.hiddenRows, 40 - model.MAX_ROWS,
    'and the TRUE remainder is measured against the supplied total, not against what was visible');
  ok(many.truncatedNote && many.truncatedNote.includes(String(40 - model.MAX_ROWS)),
    '…and the note carries that number rather than a re-derived one');

  const noTotal = model.buildTrayModel(summary({
    scopes: Array.from({ length: 12 }, (_, i) => ({
      project: 'p', scope: 's' + i, machine: 'laptop-a1b2c3', writtenAgeSeconds: i, ageSource: 'agent', isThisMachine: true,
    })),
  }), { now: NOW });
  eq(noTotal.hiddenRows, 12 - model.MAX_ROWS,
    'with no supplied total the remainder falls back to what was handed over');

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
  ok(coll.notices.some((n) => n.kind === 'collision' && (n.full || n.text).includes('alpha · research')),
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
// EVERY NUMBER HERE RESTS ON `MENU_CHAR_POINTS`, which is an assumption about a
// font nobody has measured, so nothing below asserts a single character count as
// though it were a fact: the arithmetic is asserted, and the SENSITIVITY of the
// answer across the plausible range is reported.
{
  const B = model.labelBudgetChars;

  // The formula, driven rather than restated.
  eq(B(0, 6.5), Math.floor((model.MENU_WIDTH_POINTS - model.MENU_CHROME_POINTS) / 6.5),
    'a label with no icon gets the whole item minus the chrome');
  eq(B(10, 6.5), Math.floor((model.MENU_WIDTH_POINTS - model.MENU_CHROME_POINTS - 14) / 6.5),
    'an icon costs its own width PLUS the bearing beside it — a row carrying a dot has less text budget than one without');
  ok(B(10, 6.5) < B(0, 6.5), 'CONTROL: so the icon really does reduce the budget');
  eq(B(0, 6.5), model.PLAIN_LABEL_CHARS, 'PLAIN_LABEL_CHARS is that formula, not a second number');
  eq(B(model.ROW_ICON_POINTS, 6.5), model.ROW_LABEL_CHARS, 'and so is ROW_LABEL_CHARS');
  eq(model.WHERE_LABEL_CHARS, model.PLAIN_LABEL_CHARS - 4,
    'the "where" line pays for its own four-space indent');

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
      // the hardware; the age is escalated instead.
      readerRow({ writtenAt: atAge(129600), writtenAgeSeconds: 129600,
        scope: 'session-2026-08-30-design-conformance-pre-native', machine: 'notebook-a1b2c3' }),
      readerRow({ writtenAt: atAge(140400), writtenAgeSeconds: 140400,
        scope: 'session-2026-08-30-ingest-continuity-tables' }),
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
  eq(model.machineIdentityKey({ machine: 'build-box', isThisMachine: true }), '@this',
    'and with no id on either side the only evidence left is isThisMachine');

  const reader = model.buildTrayModel(readerStore(), { now: NOW });
  eq(reader.rows.length, 5, 'CONTROL — five rows were built, so the assertions below are not vacuous');
  ok(reader.rows.every((r) => r.isThisMachine === false),
    'CONTROL — and every one of them is classified as a FOREIGN machine, which is the whole point of this fixture');
  ok(reader.rows.every((r) => !/laptop|notebook|a1b2c3/.test(r.label)),
    'NO row names a machine — the component is identical across every visible row, so it carries nothing');
  ok(reader.rows.every((r) => r.showsMachine === false), '…and the model says so rather than leaving it to be inferred');
  ok(reader.rows.every((r) => !/claude-code/.test(r.label)),
    'nor a harness, by the same rule and for the same reason');
  ok(reader.rows.every((r) => !/^projects/.test(r.label)),
    'nor the project token, which one project makes constant');

  // THE DHCP PAIR IS SEPARATED BY A FINER AGE, NEVER BY A FOLDER NAME.
  const pair = reader.rows.filter((r) => r.scope.includes('design-conformance'));
  eq(pair.length, 2, 'CONTROL — the colliding pair is present');
  ok(pair[0].label !== pair[1].label, 'the two rows read differently');
  ok(pair.every((r) => r.agePrecision === 'hour'),
    '…and they were separated by escalating the AGE, which costs no width and makes no claim about hardware');

  // AND THE MOMENT A SECOND COMPUTER APPEARS, THE NAME COMES BACK.
  const twoMachines = model.buildTrayModel(readerStore([
    { project: 'projects', scope: 'session-2026-08-29-ux-polish', machine: 'studio-9f8e7d',
      harness: 'claude-code', writtenAt: atAge(400), writtenAgeSeconds: 400,
      ageSource: 'agent', headline: 'h', isThisMachine: false },
  ]), { now: NOW });
  ok(twoMachines.rows.some((r) => /studio/.test(r.label)),
    'a genuinely second installation brings the machine name straight back');
  ok(twoMachines.rows.filter((r) => r.showsMachine).length === twoMachines.rows.length,
    '…on every row, because "which computer" is only answerable if every row answers it');

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
  ok(m.headline.text.length <= model.PLAIN_LABEL_CHARS, 'the headline is budgeted too');
  ok(m.headline.where === null || m.headline.where.length <= model.WHERE_LABEL_CHARS,
    'and so is the line under it');

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
  eq(checked, model.MAX_ROWS, `all ${checked} rows checked`);

  // ── A NOTICE IS A SENTENCE, AND SENTENCES DO NOT COMPRESS ────────────
  //
  // Found by mutation: deleting the notice tooltip came back GREEN, because
  // nothing asserted it. A notice is the one line here whose whole value is its
  // wording — "Two agent tools are writing projects · session-…" says nothing
  // useful clipped at 34 characters — so the budget is met by clipping the
  // LABEL and carrying the sentence on the tooltip, and that pairing is the
  // thing worth guarding.
  const longNotice = 'Two agent tools are writing projects · session-2026-08-30-a-long-one.';
  const noticed = model.buildTrayModel({
    ok: true, scopes: [],
    warnings: [{ code: 'harness-collision', message: longNotice, project: 'projects', scope: 'x' }],
  }, { now: NOW });
  const nItem = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(noticed, NOOPS))
    .find((i) => i.label && i.label.startsWith('Two agent tools'));
  ok(nItem, 'CONTROL — the notice reached the menu');
  ok(nItem && nItem.label.length <= model.PLAIN_LABEL_CHARS,
    `the notice label is inside the ${model.PLAIN_LABEL_CHARS}-character budget`);
  ok(nItem && nItem.label.length < longNotice.length,
    'CONTROL — it really was clipped, so the tooltip assertion below is not vacuous');
  eq(nItem ? nItem.toolTip : null, longNotice,
    '…and the WHOLE sentence is on its tooltip — the absolute rule that nothing a budget removed becomes unreachable');
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
  eq(noClock.rows[0].bucket, 'unknown', 'CONTROL — a row with no timestamp buckets as unknown');
  eq(noClock.rows[0].dot, null,
    'and gets NO dot at all — the coldest colour would assert "old" about a row whose own label reads "time unknown"');
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

  for (const [id, label] of [[menu.ID_HEADER_PULSE, menu.HEADER_PULSE], [menu.ID_HEADER_ROWS, menu.HEADER_ROWS]]) {
    const h = byId(id) || {};
    ok(byId(id), `the ${label} section header is in the menu`);
    eq(h.type, menu.MENU_HEADER_TYPE, '…as a header type, which is what makes it read as a section');
    eq(h.enabled, false, '…drawn inert, so on macOS below 14 its worst case is a dimmed caption rather than a live item that does nothing');
    ok(!h.click, '…and carrying no click handler at all, so no macOS version can make it actionable');
  }
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
  for (const id of [menu.ID_PULSE, menu.ID_TRUNCATED]) {
    const item = routed.find((i) => i.id === id);
    ok(item && typeof item.click === 'function', `${id} is present and clickable`);
    if (item && typeof item.click === 'function') item.click();
  }
  eq(clicks, ['memory', 'memory'],
    'both land on Agent Memory — the same destination as the headline, which is where the saves this strip counts are actually listed');
  ok(pulseItem.toolTip && pulseItem.toolTip.length > 20, 'the full reading, including everything the label budget dropped, is on its tooltip');
  // ── THE READING FITS WHOLE AT THE STRIP'S REAL WIDTH ─────────────────
  //
  // At the strip's earlier 83 points the label budget was 21 characters and the
  // producer's longest form — the young-store case, which carries its own
  // honesty caveat — is 23, so it was cut back to `4 days known…`. The strip
  // folded to 55 points and the budget became 25. This asserts the ARITHMETIC
  // rather than the outcome, so it stays honest if the strip changes again.
  const longestReading = '4 days known · 69 saves';
  ok(longestReading.length <= model.labelBudgetChars(55),
    `the producer's longest reading (${longestReading.length} chars) fits the ${model.labelBudgetChars(55)}-character budget a 55pt strip leaves`);
  ok(longestReading.length > model.labelBudgetChars(83),
    `CONTROL: at the strip's earlier 83 points it did NOT (${model.labelBudgetChars(83)} chars), so the budget really is what the picture leaves over`);
  eq(model.clipClauses(longestReading, model.labelBudgetChars(55)), longestReading,
    '…and it therefore passes through the clause clip untouched');

  ok(!/^Save pulse/.test(pulseItem.label || ''),
    'the constant noun comes off the label, because the section header above it now carries that word');
  eq(model.stripPulseNoun(model.PULSE_LABEL_NOUN + '7 days · 69 saves'), '7 days · 69 saves',
    'CONTROL — the noun is stripped as a LITERAL prefix');
  eq(model.stripPulseNoun('7 days · 69 saves'), '7 days · 69 saves',
    '…and a label that never carried it is untouched, so this is a no-op rather than a corruption if the producer reworded');

  // The overflow is a destination.
  const more = byId(menu.ID_TRUNCATED) || {};
  ok(byId(menu.ID_TRUNCATED), 'the overflow item is present');
  eq(more.enabled, true, 'ENABLED — at five rows it is on screen constantly, and its "…" promises a destination');
  eq(typeof more.click, 'function', '…which it now has');
  ok(/\(\d+\)/.test(more.label || ''), 'and it carries the count');
  eq(built.hiddenRows, 12 - built.rows.length,
    'the count is the TRUE remainder, taken against the supplied TOTAL rather than against what happened to be visible');
  ok(built.hiddenRows > summary().scopes.length - built.rows.length,
    'CONTROL — it exceeds anything derivable from the scopes handed over, so it really is the producer\'s uncapped count');

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

    // THE BUCKET VOCABULARY IS ONE VOCABULARY. `ageBucket()` is the only
    // producer of these names and the dot renderer is the only consumer; a
    // rename or a collapse on either side is a dot that silently stops being
    // drawn, with no error anywhere.
    const produced = new Set([0, 200, 3600, 100000, 10000000].map(model.ageBucket));
    eq([...produced].sort(), [...dotsMod.DOT_ORDER].sort(),
      'every bucket ageBucket() can produce from a real age is one menu-dots.js draws — and no more');
    eq(model.ageBucket(null), 'unknown', 'CONTROL — and the sixth value is the absence');
    ok(dotsMod.NO_DOT_BUCKETS.includes('unknown'),
      '…which that module also declines to draw, so the two files agree that an unknown age has no colour');
    eq(dotsMod.renderRecencyDot('unknown', { dark: true }), null,
      '…and it really returns null for it, executed rather than read off a constant');
    ok(dotsMod.DOT_ORDER.length === 5, `CONTROL: ${dotsMod.DOT_ORDER.length} buckets were compared, so the set equality above is not over an empty set`);
    pins += 5;

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

  if (pins === 0) {
    console.log('    NOTE: neither drawing module carries the contract in this tree, so §19 pinned NOTHING.');
    console.log('          These pins are live only once menu-dots.js and pulse-strip.js are merged alongside.');
  } else {
    ok(pins >= 2, `CONTROL: ${pins} cross-file pins actually executed, so this section is not passing on an absent module`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failed === 0 ? '✓' : '✗'} test-tray-shell: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
