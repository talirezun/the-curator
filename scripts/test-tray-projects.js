#!/usr/bin/env node
/**
 * test-tray-projects.js — OFFLINE guard for the menubar widget's half of
 * v3.48.0: PROJECTS INSIDE A DOMAIN.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHAT CHANGED, AND WHY IT NEEDS A SUITE OF ITS OWN                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Up to v3.47.0 the working-state store held ONE state tree per domain, and
 * every reader called that tree "the project", because there was exactly one.
 * `getTraySummary()` walked `listDomains()` and named each result `project`;
 * the tray rendered a flat list with a project token on each row. One word was
 * doing two jobs and nothing downstream could tell them apart.
 *
 * v3.48.0 splits them: a DOMAIN is where knowledge lives, a PROJECT is a thing
 * you build, and one domain holds many projects. For this widget that is four
 * separate contracts, each of which can be wrong on its own:
 *
 *   1. THE ROWS CARRY BOTH IDENTITIES and are GROUPED under a project header.
 *      A row that knows its project but not its domain cannot be routed, and
 *      two domains may each hold a `main`.
 *   2. THE CAPS SHARE FIVE ROWS BETWEEN GROUPS without wasting any. A hard
 *      per-group ceiling would show two rows on a five-row menu for every
 *      single-project store — which is every pre-v3.48.0 install.
 *   3. THE RESUME PROMPT AND THE FINDER PATH agree, across TWO on-disk
 *      layouts that are live at the same time (a project segment, or a legacy
 *      tree with none, arriving over sync from a Mac still on v3.47.0).
 *   4. NOTHING GETS WIDER. The menu was measured at 363.5 points and every
 *      label is budgeted against it; a header is a NEW line and had to be
 *      budgeted too.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * Everything here is EXECUTED. The data layer is driven through an injected
 * fake store implementing the project-aware API, its real output is fed into
 * the real `buildTrayModel`, and that model's real rows go into the real
 * `buildTrayMenuTemplate` and the real `composeResumePrompt`. That end-to-end
 * path is the point: v3.45.0 records a route and a view built against one
 * written contract that disagreed on a field's TYPE, with the defect invisible
 * to both sides' own tests. A fixture hand-written in the shape the consumer
 * expects cannot find that; the producer's own bytes can.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  positive control on the imports and on the fake store itself
 *   §1  the four fixtures, driven through the REAL data layer
 *   §2  grouping: which rows, under which header, in which order
 *   §3  the caps, the arithmetic, and the top-up that stops rows being wasted
 *   §4  what a header says, and what its tooltip keeps
 *   §5  the routing string the shell emits
 *   §6  the resume prompt and the Finder path, over both on-disk layouts
 *   §7  the width budget, over every label the four fixtures emit
 *   §8  state-watch reaches one level deeper, and it always did
 *   §9  cross-file pins: two constants and one expression, duplicated on
 *       purpose and asserted against their originals
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - NOTHING HAS BEEN RENDERED. Electron is not an offline dependency, no
 *    `Tray` was created and no menu was built by AppKit. Whether three headers
 *    plus five rows LOOK like a widget, and whether macOS draws a `header` item
 *    with a tooltip at all, are unanswered here.
 *  - THE PROJECT-AWARE STORE IS A FAKE. `src/brain/working-state.js` on this
 *    branch still has one state tree per domain; the real project-aware store
 *    lands separately. What is proven is that the widget consumes the API AS
 *    SPECIFIED and degrades correctly when it is absent — not that the real
 *    store returns those shapes.
 *  - No real `.curator-project` file is read by anything. The marker is a
 *    skill-level convention; the widget only ever PRINTS the line.
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-tray-projects-'));
const DOMAINS = path.join(TMP, 'domains');
const USER_DATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
// BOTH seams, before any app module is imported. CURATOR_TEST_DOMAINS_DIR alone
// leaves the developer's real .sync-config.json — and its GitHub PAT — in reach.
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete process.env[k];
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      └─ ${detail}`}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const section = (t) => console.log(`\n${t}`);

const TS = await import(path.join(ROOT, 'src', 'brain', 'tray-summary.js'));
const M = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
const MENU = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
const RP = await import(path.join(DESKTOP, 'lib', 'resume-prompt.js'));
const WATCH = await import(path.join(DESKTOP, 'lib', 'state-watch.js'));

const NOOPS = {
  onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {}, onRowAction() {},
};
const NOW_MS = Date.parse('2026-09-07T14:32:00.000Z');
const NOW = new Date(NOW_MS);
const ago = (sec) => new Date(NOW_MS - sec * 1000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control — the modules, and the fake store itself');
// ═══════════════════════════════════════════════════════════════════════════

ok(typeof TS.getTraySummary === 'function', 'the data layer is loaded');
ok(typeof TS.storeAdapter === 'function', 'and exposes the store adapter as a seam');
ok(typeof M.buildTrayModel === 'function', 'the model is loaded');
ok(typeof MENU.buildTrayMenuTemplate === 'function', 'the menu builder is loaded');
ok(typeof RP.composeResumePrompt === 'function', 'the resume-prompt composer is loaded');

/**
 * A working-state store, implementing the v3.48.0 API.
 *
 * ── WHY A FAKE, AND WHAT IT IS ALLOWED TO BE ──────────────────────────────
 *
 * This file's subject is everything ABOVE the store: the grouping, the caps,
 * the labels and the prompts. So the seam is injected — the same test-only
 * pattern, and the same rationale, as `compile.js`'s `opts.generateText`, which
 * is null in production. `scripts/test-tray-summary.js` drives the SAME data
 * layer against the real store on a real temp tree, so the two together cover
 * both sides of the adapter.
 *
 * It is deliberately DUMB: it holds the rows it was handed and returns them.
 * A fake that reimplemented the store's ranking would be a second opinion about
 * the store, and a suite comparing two of its own opinions proves nothing.
 * Every ordering and capping assertion below is therefore about the DATA LAYER
 * and the MODEL, which are the real code.
 */
function fakeStore(spec) {
  const projects = spec.projects;
  return {
    async listAllProjects() {
      return {
        projects: projects.map((p) => ({
          domain: p.domain,
          project: p.project,
          isDefaultProject: p.isDefaultProject === true,
          hasBrief: p.brief !== undefined,
          briefUpdatedAt: p.brief ? p.brief.updatedAt : null,
          briefAuthoredBy: p.brief ? p.brief.authoredBy : null,
        })),
        truncated: spec.truncated === true,
        total: Number.isInteger(spec.total) ? spec.total : projects.length,
      };
    },
    // THE STORE'S REAL SIGNATURE: the DOMAIN positionally, the project on the
    // options object. A fake that took the project positionally would accept a
    // call the real store silently misreads as "the default project", which is
    // exactly the defect this shape exists to make impossible.
    async listWorkingScopes(domain, opts = {}) {
      const project = opts && opts.project !== undefined ? opts.project : domain;
      const p = projects.find((x) => x.domain === domain && x.project === project);
      if (!p) return { ok: true, project, scopes: [], total: 0, unlistedEntries: 0 };
      // The store's own contract: newest first, and every row carries BOTH
      // clocks with `ageSeconds` measured against the store's own `Date.now()`.
      const scopes = p.scopes.map((sc) => ({
        scope: sc.scope,
        machine: sc.machine,
        lastWriteAt: ago(sc.age),
        ageSeconds: sc.age,
        writtenAt: ago(sc.age),
        writtenAgeSeconds: sc.age,
        harness: sc.harness || null,
        model: sc.model || null,
        headline: sc.headline || null,
        harnessShared: sc.harnessShared === true,
        harnesses: sc.harnesses || [],
        bytes: 100,
        saveTimes: [NOW_MS - sc.age * 1000],
        saveHarnesses: [sc.harness || null],
        journalTailTruncated: false,
      }));
      return {
        ok: true, project, scopes, total: scopes.length,
        distinctScopeCount: new Set(scopes.map((s) => s.scope)).size,
        truncated: false, unlistedEntries: 0,
      };
    },
    async readWorkingState() { return { ok: true }; },
  };
}

{
  // CONTROL ON THE SEAM ITSELF. Without this, every §1 assertion could be
  // passing over a fake nothing ever called.
  const a = TS.storeAdapter(fakeStore({ projects: [] }));
  ok(typeof a.listProjects === 'function' && typeof a.listScopes === 'function'
    && typeof a.read === 'function',
    'CONTROL — the adapter exposes the three calls the data layer makes');
  ok(!('projectAware' in a),
    '…and no layout predicate: there is ONE store, in this same checkout, so an arm for a store without projects would be an arm nothing can reach');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the four fixtures, driven through the REAL data layer');
// ═══════════════════════════════════════════════════════════════════════════
//
// The four shapes a user can actually be in on the day v3.48.0 lands.

/** One domain, TWO projects. The case the release exists for. */
const TWO_IN_ONE = {
  projects: [
    { domain: 'workshop', project: 'lumina',
      brief: { updatedAt: ago(3 * 86400), authoredBy: 'agent' },
      scopes: [
        { scope: 'session-2026-09-07-widget', machine: 'mac-a1b2c3', age: 720,
          harness: 'claude-code', model: 'opus-4-6', headline: 'grouped the tray rows by project' },
        { scope: 'session-2026-09-06-router', machine: 'mac-a1b2c3', age: 9000,
          harness: 'claude-code', model: 'opus-4-6', headline: 'the router audit landed' },
        { scope: 'session-2026-09-05-notes', machine: 'mac-a1b2c3', age: 90000,
          harness: 'claude-code', model: 'opus-4-6', headline: 'older still' },
      ] },
    { domain: 'workshop', project: 'atlas',
      scopes: [
        { scope: 'main', machine: 'mac-a1b2c3', age: 4200,
          harness: 'opencode', model: 'other-3-pro', headline: 'redrew the map' },
      ] },
  ],
};

/** TWO domains, one project each. The domain must NOT appear on either header:
 *  each domain holds exactly one project, so the token distinguishes nothing. */
const ONE_EACH = {
  projects: [
    { domain: 'workshop', project: 'lumina',
      scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 300, harness: 'claude-code', headline: 'a' }] },
    { domain: 'articles', project: 'field-notes',
      scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 3600, harness: 'claude-code', headline: 'b' }] },
  ],
};

/** A LEGACY-ONLY store: one domain, whose single project's slug IS the domain
 *  name and whose state still lives in the pre-v3.48.0 layout. */
const LEGACY_ONLY = {
  projects: [
    { domain: 'articles', project: 'articles', isDefaultProject: true,
      brief: { updatedAt: ago(20 * 86400), authoredBy: null },
      scopes: [
        { scope: 'session-2026-09-07-a', machine: 'mac-a1b2c3', age: 120, harness: 'claude-code', headline: 'one' },
        { scope: 'session-2026-09-06-b', machine: 'mac-a1b2c3', age: 7200, harness: 'claude-code', headline: 'two' },
        { scope: 'session-2026-09-05-c', machine: 'mac-a1b2c3', age: 20000, harness: 'claude-code', headline: 'three' },
        { scope: 'session-2026-09-04-d', machine: 'mac-a1b2c3', age: 90000, harness: 'claude-code', headline: 'four' },
        { scope: 'session-2026-09-03-e', machine: 'mac-a1b2c3', age: 200000, harness: 'claude-code', headline: 'five' },
        { scope: 'session-2026-09-02-f', machine: 'mac-a1b2c3', age: 300000, harness: 'claude-code', headline: 'six' },
      ] },
  ],
};

/** A BUSY project that would monopolise the list, beside two quiet ones. Every
 *  one of the busy project's twelve saves is newer than either neighbour's, so
 *  a flat newest-first list would be twelve rows of one project. */
const MONOPOLY = {
  projects: [
    { domain: 'workshop', project: 'lumina',
      scopes: Array.from({ length: 12 }, (_, i) => ({
        scope: 'session-2026-09-07-stream-' + i, machine: 'mac-a1b2c3', age: 60 + i * 30,
        harness: 'claude-code', model: 'opus-4-6', headline: 'busy work ' + i,
      })) },
    { domain: 'workshop', project: 'atlas',
      scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 50000, harness: 'opencode', headline: 'quiet' }] },
    { domain: 'articles', project: 'field-notes',
      scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 60000, harness: 'opencode', headline: 'quieter' }] },
    { domain: 'articles', project: 'archive',
      scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 90000, harness: 'opencode', headline: 'quietest' }] },
  ],
};

/** Data layer -> model, both real, over one fixture. */
async function drive(spec, opts = {}) {
  const summary = await TS.getTraySummary({
    store: fakeStore(spec), limit: M.TRAY_FETCH_ROWS, now: NOW_MS,
  });
  return { summary, model: M.buildTrayModel(summary, { now: NOW, ...opts }) };
}

const twoInOne = await drive(TWO_IN_ONE);
const oneEach = await drive(ONE_EACH);
const legacyOnly = await drive(LEGACY_ONLY);
const monopoly = await drive(MONOPOLY);

ok(twoInOne.summary.ok === true, 'the data layer answers ok on the project-aware store');
eq(twoInOne.summary.scopes.length, 4, 'CONTROL — all four of that fixture\'s pairs came back');
// ── THE FIELD-DROP GUARD, WHICH IS THE ONE THIS REPO KEEPS RE-COMMITTING ──
//
// A consumer silently dropping a field the producer honestly computed is the
// dominant defect class in this whole feature (working-state.js's own docblock
// names four instances). Both identities are asserted on the producer's OWN
// output, before anything renders them.
for (const f of ['domain', 'project', 'projectLabel', 'projectsInDomain', 'isDefaultProject']) {
  ok(twoInOne.summary.scopes.every((r) => f in r), `every summary row carries \`${f}\``);
}
ok(twoInOne.summary.lastSave && twoInOne.summary.lastSave.domain === 'workshop'
  && twoInOne.summary.lastSave.project === 'lumina',
  'and `lastSave` names BOTH — it is a re-projection of scopes[0], so a drop there would be silent');

// ═══════════════════════════════════════════════════════════════════════════
section('§2 grouping — which rows, under which header, in which order');
// ═══════════════════════════════════════════════════════════════════════════

eq(twoInOne.model.groups.map((g) => g.projectLabel), ['workshop / lumina', 'workshop / atlas'],
  'one domain with two projects: two groups, and BOTH headers qualify with the domain');
eq(twoInOne.model.groups.map((g) => g.rows.length), [3, 1],
  '…newest project first, and the rows are shared out between them');
ok(twoInOne.model.groups[0].rows.every((r) => r.project === 'lumina'),
  '…every row under a header belongs to that header\'s project');
eq(twoInOne.model.groups[0].rows.map((r) => r.scope),
  ['session-2026-09-07-widget', 'session-2026-09-06-router', 'session-2026-09-05-notes'],
  '…and inside a group the newest scope comes first');

eq(oneEach.model.groups.map((g) => g.projectLabel), ['lumina', 'field-notes'],
  'two domains with one project each: NEITHER header names its domain, because neither domain has a second project to be told apart from');
eq(oneEach.model.rows.map((r) => r.showsDomain), [false, false],
  '…and the rows say so, rather than leaving it to be inferred from the string');
eq(oneEach.model.rows.map((r) => r.domain), ['workshop', 'articles'],
  '…while the domain is still CARRIED on every row, because the route needs it');

eq(legacyOnly.model.groups.length, 1, 'a legacy-only store draws exactly one group…');
eq(legacyOnly.model.groups[0].projectLabel, 'articles', '…named for the domain, which IS the default project\'s slug');
ok(legacyOnly.model.rows.every((r) => r.isDefaultProject === true),
  '…and every row is marked as the domain\'s own project, which is what decides its on-disk path');

// ── THE GROUPS AND THE ROWS ARE THE SAME OBJECTS ────────────────────────
//
// Not equal — IDENTICAL. A header and the rows under it describing different
// saves is the failure this binding exists to make inexpressible, and it is the
// same argument `lastSave` and `scopes[0]` already share in the data layer.
ok(monopoly.model.groups.flatMap((g) => g.rows).every((r) => monopoly.model.rows.includes(r)),
  'every row in a group is the SAME OBJECT as the row in the flat list — not a copy that could drift');
eq(monopoly.model.groups.flatMap((g) => g.rows).length, monopoly.model.rows.length,
  '…and between them the groups hold every row, so nothing is rendered outside a header');

// TWO DOMAINS HOLDING A PROJECT OF THE SAME NAME must not become one group,
// and must not draw two identical headers.
{
  const clash = await drive({
    projects: [
      { domain: 'workshop', project: 'main',
        scopes: [{ scope: 's', machine: 'mac-a1b2c3', age: 100, harness: 'claude-code', headline: 'w' }] },
      { domain: 'articles', project: 'main',
        scopes: [{ scope: 's', machine: 'mac-a1b2c3', age: 200, harness: 'claude-code', headline: 'a' }] },
    ],
  });
  eq(clash.model.groups.length, 2,
    'two domains each holding a project called `main` are TWO groups — grouping on the project alone would file one project\'s saves under another\'s header');
  eq(new Set(clash.model.groups.map((g) => g.projectLabel)).size, 2,
    '…and their headers are told apart');
  eq(clash.model.groups.map((g) => g.projectLabel), ['workshop / main', 'articles / main'],
    '…by the domain, restored on BOTH of them even though neither domain holds a second project');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 the caps, the arithmetic, and the top-up');
// ═══════════════════════════════════════════════════════════════════════════

eq(M.MAX_ROWS, 5, 'five rows in total');
eq(M.MAX_GROUPS, 3, 'at most three groups');
eq(M.MAX_ROWS_PER_GROUP, 2, 'at most two rows per group in the first allocation');
ok(M.MAX_GROUPS * M.MAX_ROWS_PER_GROUP > M.MAX_ROWS,
  `THE ARITHMETIC: ${M.MAX_GROUPS} x ${M.MAX_ROWS_PER_GROUP} = ${M.MAX_GROUPS * M.MAX_ROWS_PER_GROUP} exceeds ${M.MAX_ROWS}, so on a busy store the ROW budget binds and the per-group quota cannot decide the total`);

// THE MONOPOLY CASE — the one the quota exists for.
eq(monopoly.model.rows.length, 5, 'a store with a busy project still fills exactly five rows');
eq(monopoly.model.groups.map((g) => [g.projectLabel, g.rows.length]),
  [['workshop / lumina', 3], ['workshop / atlas', 1], ['articles / field-notes', 1]],
  'the busy project takes THREE of the five, not twelve — its two neighbours have one row each to give, and rows the quota freed but nobody can use go back to the newest project rather than staying blank');
ok(monopoly.model.groups[0].rows.length < 12,
  'CONTROL — without the quota it had twelve rows to give and would have taken all five');
eq(monopoly.model.groupsOnDisk, 4, 'the TRUE number of projects with state is reported…');
eq(monopoly.model.groupsHidden, 1, '…and so is how many did not fit, taken before the cut');
eq(monopoly.model.hiddenRows, 10, 'and the rows the caps hid are counted against the store\'s true total');
ok(monopoly.model.truncatedNote && /\(10\)/.test(monopoly.model.truncatedNote),
  `the overflow names that true remainder — ${monopoly.model.truncatedNote}`);

// ── AND THE 2 + 2 + 1 SHAPE, WHICH NEEDS THREE PROJECTS THAT CAN ALL FILL ──
{
  const threeBusy = await drive({
    projects: ['a', 'b', 'c'].map((n, gi) => ({
      domain: 'w', project: n,
      scopes: Array.from({ length: 4 }, (_, i) => ({
        scope: n + '-' + i, machine: 'm-a1b2c3', age: 100 + gi * 1000 + i * 10,
        harness: 'h', headline: 'x',
      })),
    })),
  });
  eq(threeBusy.model.groups.map((g) => g.rows.length), [2, 2, 1],
    'THE SHIPPED SHAPE on a store where three projects could each fill the list: 2 + 2 + 1');
  eq(threeBusy.model.rows.length, M.MAX_ROWS, '…which is exactly the row budget, with none wasted');
  eq(threeBusy.model.groups.length, M.MAX_GROUPS, '…and exactly the group cap');
}

// THE TOP-UP — and it is the case almost every user is in today.
eq(legacyOnly.model.rows.length, 5,
  'a store with ONE project still fills all five rows: the quota is a floor for the OTHER groups, never a ceiling on the only one');
ok(legacyOnly.model.groups[0].rows.length === 5,
  '…all five under its single header');
eq(legacyOnly.model.hiddenRows, 1, '…with the sixth disclosed rather than dropped silently');

// Two groups, five rows: the leftover goes to the newest, and it is round-robin
// rather than "the first takes everything left".
{
  const twoBusy = await drive({
    projects: [
      { domain: 'w', project: 'a',
        scopes: Array.from({ length: 6 }, (_, i) => ({ scope: 'a' + i, machine: 'm-a1b2c3', age: 60 + i, harness: 'h', headline: 'x' })) },
      { domain: 'w', project: 'b',
        scopes: Array.from({ length: 6 }, (_, i) => ({ scope: 'b' + i, machine: 'm-a1b2c3', age: 5000 + i, harness: 'h', headline: 'y' })) },
    ],
  });
  eq(twoBusy.model.groups.map((g) => g.rows.length), [3, 2],
    'with two busy projects and five rows the newest gets the odd one — 3 + 2, never 5 + 0');
}

// A smaller budget still honours the group cap before the row cap.
{
  const tight = M.buildTrayModel(monopoly.summary, { now: NOW, maxRows: 2 });
  eq(tight.rows.length, 2, 'a tighter row budget is honoured…');
  eq(tight.groups.length, 1, '…and it is spent on the newest project rather than sprinkled one row each');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 what a header says, and what its tooltip keeps');
// ═══════════════════════════════════════════════════════════════════════════

{
  const g = twoInOne.model.groups[0];
  eq(g.toolTip, 'workshop / lumina · 12 min ago · claude-code',
    'the header reads `<project> · <age> · <harness>` — the identity, when it was last touched, and by what');
  eq(g.ageText, '12 min ago', '…and the age is the group\'s NEWEST save, which is the one the reader is asking about');
  eq(g.harness, 'claude-code', '…and the harness is that save\'s');
  // ── A MEASURED COST, RECORDED RATHER THAN HIDDEN ─────────────────────
  //
  // That reading is 44 characters and the plain-item budget is 42, so on THIS
  // fixture the harness clause is the one that gives way — clause by clause,
  // never mid-token, so the reader never sees `claude-c…` and wonders whether
  // that is what the field said. The identity and the age, which are the two
  // things a header exists for, always survive.
  eq(g.label, 'workshop / lumina · 12 min ago…',
    'and where it will not fit, the HARNESS clause goes whole — the identity and the age are never the ones cut');
  ok(g.label.length <= M.PLAIN_LABEL_CHARS && g.toolTip.length > M.PLAIN_LABEL_CHARS,
    `CONTROL — the reading really is over the ${M.PLAIN_LABEL_CHARS}-character budget (${g.toolTip.length}), so the clip above is doing work`);
  // AND WHERE IT FITS, IT IS THERE. Otherwise the assertion above would be
  // indistinguishable from a header that never carries a harness at all.
  {
    const short = await drive({
      projects: [{ domain: 'w', project: 'app',
        scopes: [{ scope: 'main', machine: 'm-a1b2c3', age: 720, harness: 'zed', headline: 'h' }] }],
    });
    eq(short.model.groups[0].label, 'app · 12 min ago · zed',
      'a header that fits carries all three clauses on the label itself');
  }
  eq(g.projectFull, 'workshop / lumina', 'the fully-qualified identity is carried beside the label');

  // The menu renders it as a section header: inert, no click, and its tooltip
  // only when it adds something.
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(twoInOne.model, NOOPS));
  const headers = flat.filter((i) => i.id && String(i.id).startsWith('tray-group-'));
  eq(headers.length, 2, 'both group headers reach the menu');
  ok(headers.every((h) => h.type === MENU.MENU_HEADER_TYPE),
    '…as header items, which is what makes them read as sections rather than as entries');
  ok(headers.every((h) => h.enabled === false && !h.click),
    '…inert and with no click handler, so on macOS below 14 the worst case is a dimmed caption rather than a live item that does nothing');
  const ids = flat.filter((i) => i.type !== 'separator').map((i) => i.id);
  ok(ids.indexOf('tray-group-0') < ids.indexOf('tray-row-0'),
    'the header comes BEFORE the rows it heads');
  ok(ids.indexOf('tray-row-2') < ids.indexOf('tray-group-1'),
    '…and a group\'s rows all come before the next header');
  ok(!flat.some((i) => i.id === MENU.ID_HEADER_ROWS),
    'the generic "Recent scopes" caption is NOT also drawn — a caption above a caption is a line spent twice');

  // ── AND IT IS BACK IN THE EMPTY STATE ────────────────────────────────
  const emptyFlat = MENU.flattenTrayMenu(
    MENU.buildTrayMenuTemplate(M.buildTrayModel({ ok: true, scopes: [] }, { now: NOW }), NOOPS));
  ok(emptyFlat.some((i) => i.id === MENU.ID_HEADER_ROWS),
    '…and it IS drawn in the empty state, where there is no project to name and the section still has to exist');
}

// A header that a budget clipped keeps its whole reading on its tooltip.
{
  const long = await drive({
    projects: [
      { domain: 'a-deliberately-long-domain-name', project: 'a-deliberately-long-project-name',
        scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 300,
          harness: 'a-long-harness-name', headline: 'h' }] },
      { domain: 'a-deliberately-long-domain-name', project: 'second-project-here',
        scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 900, harness: 'h2', headline: 'h' }] },
    ],
  });
  const g = long.model.groups[0];
  ok(g.label.length <= M.PLAIN_LABEL_CHARS,
    `a long header is inside the ${M.PLAIN_LABEL_CHARS}-character budget — got ${g.label.length}`);
  ok(g.label.length < g.toolTip.length,
    'CONTROL — it really was shortened, so the tooltip assertion below is not vacuous');
  ok(g.toolTip.includes('a-deliberately-long-project-name') && g.toolTip.includes('a-long-harness-name'),
    'NOTHING A BUDGET REMOVED BECOMES UNREACHABLE — the tooltip carries the identity and the dropped harness in full');
  ok(g.label.includes('a-deliberately-long-project-name') || g.label.endsWith('…'),
    'and what survives on the label is the identity, never an ellipsis in place of it');
  const item = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(long.model, NOOPS))
    .find((i) => i.id === 'tray-group-0');
  eq(item.toolTip, g.toolTip, '…and the menu item carries that tooltip');
}

// ── THE MENU'S FIRST LINE NAMES THE MOST RECENT PROJECT ────────────────────
eq(twoInOne.model.headline.text, 'Working on: workshop / lumina · 12 min ago',
  'the headline names the MOST RECENT project and its age');
eq(twoInOne.model.headline.project, 'lumina', '…and carries the project as a field, not only inside a sentence');
eq(twoInOne.model.headline.domain, 'workshop', '…and the domain beside it');
eq(twoInOne.model.headline.who, 'claude-code · opus-4',
  'provenance stays on the SECOND line, exactly as it was');
eq(twoInOne.model.headline.where, 'widget',
  '…and the "where" line is the SCOPE now, because line one already carries the project');
eq(twoInOne.model.headline.whereFull, 'workshop / lumina · session-2026-09-07-widget',
  '…with the fully-qualified pair kept beside it for the tooltip');
{
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(twoInOne.model, NOOPS));
  const first = flat.filter((i) => i.type !== 'separator')[0];
  eq(first.id, MENU.ID_HEADLINE, 'and it is still the first item in the menu');
  eq(first.label, 'Working on: workshop / lumina · 12 min ago', '…rendered verbatim');
}

// ── THE BRIEF CLAUSE IS PER PROJECT, AND NAMES AN AGENT AUTHOR ────────────
eq(twoInOne.model.brief.project, 'lumina',
  'the brief reported is the one belonging to the project at the top of the menu');
eq(twoInOne.model.brief.domain, 'workshop', '…qualified by its domain');
eq(twoInOne.model.brief.authoredBy, 'agent', '…and it records who wrote it');
eq(twoInOne.model.brief.text, 'Brief updated 3 days ago by an agent',
  '…which the clause says out loud: the brief is the tier a model FOLLOWS, so who wrote it decides how much authority it carries');
ok(MENU.trayToolTip(twoInOne.model).includes('Brief updated 3 days ago by an agent'),
  '…and the icon\'s tooltip carries that clause');
eq(legacyOnly.model.brief.authoredBy, null,
  'a pre-v3.48.0 brief has no recorded author…');
eq(legacyOnly.model.brief.text, 'Brief updated 2 weeks ago',
  '…and its clause says nothing about one, rather than guessing "you wrote it"');

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the routing string the shell emits');
// ═══════════════════════════════════════════════════════════════════════════
//
// `openScopeInApp` hands `row.route` to `openMemoryView`, which compares it
// against the memory view's own `data-mem-project` attribute. It is the one
// string in this feature that crosses into another agent's file, so it is
// asserted as a literal rather than described.

eq(twoInOne.model.rows[0].route, 'workshop/lumina',
  'THE ROUTING STRING IS `<domain>/<project>` — a project name alone stopped identifying a row the moment one domain could hold two');
eq(twoInOne.model.rows.map((r) => r.route),
  ['workshop/lumina', 'workshop/lumina', 'workshop/lumina', 'workshop/atlas'],
  '…on every row, taken from that row\'s own pair');
eq(legacyOnly.model.rows[0].route, 'articles/articles',
  'a legacy default project routes as `<domain>/<domain>`, because its project slug IS the domain — the route is machine-read and does not collapse');
eq(twoInOne.model.headline.route, 'workshop/lumina',
  'and the headline carries one too, for the item that opens the app on the newest project');

// THE MARKER, which is the same pair written for a HUMAN to type.
eq(twoInOne.model.rows[0].marker, 'workshop/lumina', 'the `.curator-project` marker line is the same pair…');
eq(legacyOnly.model.rows[0].marker, 'articles',
  '…except on a legacy default project, where it COLLAPSES: a marker reading `articles/articles` is correct and reads like a mistake');

{
  // The shell hands the WHOLE ROW to `onOpenScope`, and takes `route` off it —
  // asserted by driving the real submenu item's click.
  let got = null;
  const t = MENU.buildTrayMenuTemplate(twoInOne.model, { ...NOOPS, onOpenScope: (r) => { got = r; } });
  MENU.flattenTrayMenu(t).find((i) => i.id === MENU.rowActionId('tray-row-3', MENU.ID_ROW_OPEN)).click();
  ok(got && got.route === 'workshop/atlas',
    'clicking `Open in The Curator` on the fourth row hands the shell THAT row\'s route, not the first one\'s');

  // AND THE SHELL REALLY READS IT. main.js cannot be imported by `npm test`, so
  // this is a SOURCE SCAN and is weak by construction — it proves the line was
  // written, never that it runs. It is here because the alternative is no
  // guard at all on the one string that crosses into another file.
  const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  ok(/openScopeInApp[\s\S]{0,400}row\.route/.test(src),
    'SOURCE SCAN (weak): the shell reads `row.route` when opening a row');
  ok(/JSON\.stringify\(route\)/.test(src) && /JSON\.stringify\(bare\)/.test(src),
    'SOURCE SCAN (weak): both routing strings are JSON-serialised into the injected script, never interpolated into a selector');
  ok(/dataset\.memProject === want/.test(src) && /dataset\.memProject === alt/.test(src),
    'SOURCE SCAN (weak): the exact pair is compared first and the bare project name second');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the resume prompt and the Finder path, over both layouts');
// ═══════════════════════════════════════════════════════════════════════════
//
// Composed from the REAL model's rows, not from a hand-written row: what the
// clipboard gets is what `buildTrayModel` emitted, and a field the model stops
// carrying must red here rather than quietly disappear from a paste.

{
  const newest = twoInOne.model.rows[0];
  const p = RP.composeResumePrompt(newest, { domainsDir: '/knowledge' });
  eq(p.split('\n')[0], 'Resume project "lumina" (domain "workshop"), latest scope.',
    'the first line names the project, qualifies it with the domain, and claims the latest scope');
  ok(p.includes('project "lumina", domain "workshop" and scope "latest"'),
    '…and the MCP call passes all three');
  ok(p.includes('/knowledge/workshop/state/lumina/session-2026-09-07-widget/mac-a1b2c3/current.md'),
    '…while the file arm names the v3.48.0 path, with the project segment');
  ok(p.includes('workshop/lumina') && /\.curator-project/.test(p),
    '…and the marker line, so a session started in the wrong repo can be pointed at the right project');

  // THE SECOND ROW OF A GROUP IS NOT "latest", and the prompt must not say so.
  const second = twoInOne.model.rows[1];
  eq(second.latest, false, 'CONTROL — the second row of a group is not its project\'s newest');
  const p2 = RP.composeResumePrompt(second, { domainsDir: '/knowledge' });
  ok(p2.includes('scope "session-2026-09-06-router"') && !p2.includes('"latest"'),
    'so its prompt names that scope and never `latest` — "latest" there would resume a DIFFERENT work-stream than the row the user clicked');
  eq(p2.split('\n')[0], 'Resume project "lumina" (domain "workshop"), scope "session-2026-09-06-router".',
    '…and its first line says the same thing the call does');

  // THE LEGACY LAYOUT.
  const legacyRow = legacyOnly.model.rows[0];
  const lp = RP.composeResumePrompt(legacyRow, { domainsDir: '/knowledge' });
  ok(lp.includes('/knowledge/articles/state/session-2026-09-07-a/mac-a1b2c3/current.md'),
    'a legacy default project keeps the pre-v3.48.0 path — readers never move files, so both layouts are live at once');
  ok(!lp.includes('/articles/state/articles/'),
    '…and no project segment is invented, which would name a directory that does not exist');

  // ── THE PROMPT AND THE FINDER PATH ARE ONE FUNCTION ──────────────────
  //
  // The menu PRINTS a path and `Reveal current.md in Finder` OPENS one. Two
  // compositions would be two answers, and the wrong one is only discovered
  // when a user pastes a path that does not exist.
  for (const r of [...twoInOne.model.rows, ...legacyOnly.model.rows]) {
    const rel = RP.stateRelPath(r);
    ok(RP.composeResumePrompt(r, { domainsDir: '/knowledge' }).includes('/knowledge/' + rel),
      `the printed path IS stateRelPath(row) for ${r.project} · ${r.scope}`);
  }
  const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  ok(/ID_ROW_REVEAL[\s\S]{0,600}stateRelPath\(row\)/.test(src),
    'SOURCE SCAN (weak): and Reveal in Finder opens the path that SAME function returns');
  ok(!/path\.join\(root, row\.project, 'state'/.test(src),
    'SOURCE SCAN (weak): the old hand-built path is gone, so the shell has no second opinion about the layout');
}

// The handoff document names both identities too.
{
  const md = RP.composeHandoffMarkdown({
    domain: 'workshop', project: 'lumina', scope: 'main', current: 'body',
  });
  ok(md.startsWith('# Working state — workshop / lumina · main'),
    'the pasteable handoff is headed with the fully-qualified pair — the model reading it has no menu to look at');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the width budget, over every label the four fixtures emit');
// ═══════════════════════════════════════════════════════════════════════════
//
// The menu was MEASURED at 363.5 points from a 2x capture (v3.42.0), and every
// label is budgeted against it. A group header is a NEW line on that menu, so
// it is measured with the rest rather than assumed to fit.

{
  let lines = 0, widest = 0, widestText = '';
  const over = [];
  for (const [name, built] of [['two-in-one', twoInOne], ['one-each', oneEach],
    ['legacy-only', legacyOnly], ['monopoly', monopoly]]) {
    const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(built.model, {
      ...NOOPS, makeIcon: () => ({ fake: 'image' }),
    }));
    for (const it of flat) {
      if (it.type === 'separator') continue;
      for (const key of ['label', 'sublabel']) {
        if (!it[key]) continue;
        lines++;
        if (it[key].length > widest) { widest = it[key].length; widestText = `${name}: ${it[key]}`; }
        const cap = key === 'sublabel' ? M.MAX_HEADLINE_CHARS : M.PLAIN_LABEL_CHARS;
        if (it[key].length > cap) over.push(`${name} ${key} (${it[key].length} > ${cap}): ${it[key]}`);
      }
    }
  }
  ok(lines >= 60, `CONTROL: ${lines} rendered lines were measured across four fixtures, so the sweep is not looking at an empty menu`);
  ok(widest > 24, `CONTROL: the widest of them is ${widest} characters, a real line rather than a stub`);
  eq(over, [], 'every label and sublabel the four fixtures emit is inside its budget');
  console.log(`    widest rendered line: ${widest} characters — "${widestText}"`);
  console.log(`    ≈${(M.MENU_CHROME_POINTS + widest * M.MENU_CHAR_POINTS).toFixed(0)}pt against the measured ${M.MENU_WIDTH_POINTS}pt menu`);
  // The header is a PLAIN item — no icon gutter — so it is charged at the plain
  // rate. Asserted as arithmetic rather than trusted: an icon on a header would
  // silently make every one of them over budget.
  ok(M.PLAIN_LABEL_CHARS * M.MENU_CHAR_POINTS + M.MENU_CHROME_POINTS <= M.MENU_WIDTH_POINTS,
    `a full-width plain item fits the measured menu: ${M.PLAIN_LABEL_CHARS} x ${M.MENU_CHAR_POINTS} + ${M.MENU_CHROME_POINTS} <= ${M.MENU_WIDTH_POINTS}`);
  const headerItems = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(monopoly.model, {
    ...NOOPS, makeIcon: () => ({ fake: 'image' }),
  })).filter((i) => i.id && String(i.id).startsWith('tray-group-'));
  ok(headerItems.length > 0 && headerItems.every((h) => !h.icon),
    'CONTROL — and no header carries an icon, so charging it at the plain rate is right');
}

// ── AND THE HEIGHT, STATED AS ARITHMETIC ────────────────────────────────
{
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(monopoly.model, NOOPS))
    .filter((i) => i.type !== 'separator' && !String(i.path || '').includes(' › '));
  const rowsSection = flat.filter((i) => String(i.id || '').startsWith('tray-group-')
    || String(i.id || '').startsWith('tray-row-'));
  eq(rowsSection.length, M.MAX_ROWS + monopoly.model.groups.length,
    `the rows section is ${monopoly.model.groups.length} headers plus ${M.MAX_ROWS} rows — two items taller than the single caption it replaced, which is what the grouping costs`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 state-watch reaches one level deeper, and it always did');
// ═══════════════════════════════════════════════════════════════════════════
//
// The new layout puts `current.md` one directory further down and adds a
// `project.md` at a depth that did not exist. The filter is depth-agnostic by
// construction — it asks whether a `state` segment is present — so this is a
// VERIFICATION rather than a change, and it is asserted because "it already
// works" is exactly the claim that goes untested until it stops being true.

const W = WATCH.isWorkingStateEvent;
ok(W('workshop/state/lumina/session-a/mac-a1b2c3/current.md'),
  'the v3.48.0 handoff path matches — one level deeper than the filter was written for');
ok(W('workshop/state/lumina/session-a/mac-a1b2c3/journal.jsonl'),
  '…and so does its journal');
ok(W('workshop/state/lumina/project.md'),
  '…and a per-project standing brief, at a depth that did not exist before');
ok(W('articles/state/main/mac-a1b2c3/current.md'),
  'the LEGACY path still matches, because a mixed fleet writes both');
ok(W('articles/state/project.md'), '…and so does the legacy brief');
ok(!W('workshop/wiki/entities/thing.md'), 'a wiki write still does not — an ingest writes hundreds of files');
ok(!W('workshop/state/lumina/session-a/mac-a1b2c3/.tmp-abc'),
  '…and neither does the atomic write\'s own temp file, at the new depth');
ok(!W('workshop/.state/lumina/session-a/mac/current.md'),
  '…nor a dot-prefixed segment anywhere on the path');
ok(!W(''), 'an empty filename is REFUSED rather than treated as "something changed"');
ok(!W(null), '…and so is a null one, which fs.watch can deliver');
{
  // The watch is RECURSIVE, which is what makes a project created after the
  // watch was established visible at all. Driven, not scanned.
  const events = [];
  const w = WATCH.createStateWatcher({
    roots: ['/fake'],
    watch: (root, opts, listener) => { events.push(opts); return { on() {}, close() {} }; },
    onRefresh: () => {},
    fallbackMs: 0,
  });
  w.start();
  eq(events.map((e) => e.recursive), [true],
    'the watch is established recursively, which is what catches a PROJECT created after it started');
  w.stop();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 cross-file pins — duplicated on purpose, asserted against the original');
// ═══════════════════════════════════════════════════════════════════════════
//
// `desktop/` may not import from `src/` (see tray-model.js's header), so three
// things are duplicated. Each is pinned against its original here rather than
// trusted to a comment.

{
  // 1. The fetch limit MUST equal the data layer's own ceiling, or the model is
  //    grouping a window the producer already cut.
  const tsSrc = readFileSync(path.join(ROOT, 'src', 'brain', 'tray-summary.js'), 'utf8');
  const m = tsSrc.match(/export const TRAY_MAX_LIMIT\s*=\s*(\d+)/);
  ok(m !== null, 'CONTROL — TRAY_MAX_LIMIT is still declared in the pinned shape in tray-summary.js');
  eq(M.TRAY_FETCH_ROWS, Number(m[1]),
    'TRAY_FETCH_ROWS equals the data layer\'s TRAY_MAX_LIMIT — the shell asks for everything that module will rank, so a busy project cannot hide every other one from the model');
  ok(M.TRAY_FETCH_ROWS > M.MAX_ROWS,
    'and it is LARGER than what is displayed, which is the whole reason it stopped being MAX_ROWS');

  // 2. The project-label rule. Both copies are RUN over the same rows.
  const cases = [
    { domain: 'workshop', project: 'lumina', projectsInDomain: 2 },
    { domain: 'workshop', project: 'lumina', projectsInDomain: 1 },
    { domain: 'articles', project: 'articles', projectsInDomain: 1 },
    { domain: null, project: 'orphan', projectsInDomain: 3 },
    { domain: 'd', project: null, projectsInDomain: 2 },
  ];
  for (const c of cases) {
    const producer = TS.projectLabel(c.domain, c.project, c.projectsInDomain);
    const consumer = M.projectLabelOf(c);
    eq(consumer, producer,
      `the model's fallback label agrees with the producer's for ${JSON.stringify(c)}`);
  }
  ok(TS.projectLabel('workshop', 'lumina', 2) === 'workshop / lumina'
    && TS.projectLabel('workshop', 'lumina', 1) === 'lumina',
    'CONTROL — the rule really does branch, so the agreement above is not two constants matching');

  // 3. And the SUPPLIED label wins over the fallback, so the producer stays the
  //    authority on a fact only it can see (how many projects a domain holds).
  eq(M.projectLabelOf({ domain: 'd', project: 'p', projectsInDomain: 1, projectLabel: 'd / p' }), 'd / p',
    'a label the producer supplied is used verbatim — the count it depends on is a fact about the STORE, not about the rows that survived a cap');
}

// ── THE ADAPTER SPEAKS THE STORE'S ACTUAL SIGNATURE ──────────────────────
{
  // This module thinks in (domain, project) PAIRS; `src/brain/working-state.js`
  // takes the DOMAIN positionally and the project on its options object, so
  // that every pre-v3.48.0 call site kept reading the paths it always did.
  // `storeAdapter` is the single place those two shapes meet.
  //
  // ── THE FAKE MUST BE ABLE TO SEE THE ARITY, OR THIS PROVES NOTHING ────
  //
  // FOUND BY MUTATION on the branch this replaces. A fake that declared only
  // the arguments it used ran GREEN against a THREE-argument call: a JavaScript
  // function cannot tell that it was handed an argument it never named. It now
  // RECORDS what it was called with, and the assertion is about that record.
  //
  // WHY THIS MATTERS MORE THAN ARGUMENT ORDER USUALLY DOES: passing the project
  // positionally where the store expects options is not a crash. The store
  // reads `opts.project` off a STRING, gets `undefined`, and answers — happily,
  // and about the DEFAULT project. Every project in every domain would render
  // the domain's own state under someone else's name.
  const calls = [];
  const recordingStore = {
    async listAllProjects() {
      return { ok: true, projects: [{ domain: 'articles', project: 'lumina', isDefaultProject: false }], total: 1, truncated: false };
    },
    async listWorkingScopes(domain, opts) {
      calls.push({ fn: 'listWorkingScopes', argc: arguments.length, domain, opts });
      return { ok: true, project: (opts && opts.project) || domain, total: 0, unlistedEntries: 0, scopes: [] };
    },
    async readWorkingState(domain, opts) {
      calls.push({ fn: 'readWorkingState', argc: arguments.length, domain, opts });
      return { ok: true, project: (opts && opts.project) || domain };
    },
  };
  const a = TS.storeAdapter(recordingStore);
  await a.listScopes('articles', 'lumina', { withSaveTimes: true });
  await a.read('articles', 'lumina', { scope: 'main', journalLimit: 1 });
  eq(calls.length, 2, 'CONTROL — the store really was called, twice');
  for (const c of calls) {
    eq(c.argc, 2, `${c.fn}: exactly two arguments — the store's own arity`);
    eq(c.domain, 'articles', `${c.fn}: the DOMAIN first`);
    eq(c.opts.project, 'lumina',
      `${c.fn}: and the project on the OPTIONS object, where the store reads it — passed positionally it would be read as {} and answered about the default project`);
  }
  eq(calls[0].opts.withSaveTimes, true,
    'the caller\'s own options survive the merge — dropping withSaveTimes would silently cost the pulse strip its input');
  eq(calls[1].opts.scope, 'main', '…on the read side too');
  eq(calls[1].opts.journalLimit, 1, '…including the journal cap the handoff copy depends on');

  // And the row normalisation: a store row that does not say gets the answer
  // derived once, here, rather than by three downstream readers.
  const enumerated = await a.listProjects();
  eq(enumerated.projects[0].isDefaultProject, false,
    'a named project is not the default one');
  const bare = TS.storeAdapter({
    async listAllProjects() { return { projects: [{ domain: 'articles', project: 'articles' }] }; },
  });
  eq((await bare.listProjects()).projects[0].isDefaultProject, true,
    '…and a row that omits the field has it derived from the slug, so downstream always reads a boolean');
  eq((await bare.listProjects()).total, null,
    'a store that does not report a total says so with null — "the store did not say" is a different fact from a number');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} test-tray-projects: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
