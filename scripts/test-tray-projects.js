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
 *   §2  Layout A (v3.74.0): one row per (project × harness) saved in 24 h,
 *       everything else folded into Idle
 *   §3  the caps: five rows, whole projects, an overflow that names its unit
 *   §3b the shell asks for 40 and the face shows five
 *   §3c one stream per work-stream per computer; two tools, two rows
 *   §4  what a row says, what its submenu holds, the icon's tooltip
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
// The store's OWN provenance parser (v3.76.0, truth audit F3): the fake below
// hands the data layer `briefAuthoredBy` in the shape the real store returns —
// an object `{kind, harness, model, at, commissionedBy}` or null — derived by
// the real function from a real stamp line, never a hand-typed string. The
// string 'agent' this fake used to return is exactly why a data layer that
// compared the object to 'agent' passed here and never fired in production.
const { parseBriefProvenance } = await import(path.join(ROOT, 'src', 'brain', 'working-state.js'));
/** A brief's provenance, as the real store parses it from its stamp line. */
function briefProvenance(brief) {
  if (!brief || !brief.authoredBy) return parseBriefProvenance('# no stamp\n');
  return parseBriefProvenance('<!-- curator-brief: authored_by=' + brief.authoredBy
    + ' harness=claude-code model=opus-5 on=' + brief.updatedAt + ' commissioned=user -->\n# brief\n');
}

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
  const foundationsCalls = [];
  return {
    async listAllProjects() {
      return {
        projects: projects.map((p) => ({
          domain: p.domain,
          project: p.project,
          isDefaultProject: p.isDefaultProject === true,
          hasBrief: p.brief !== undefined,
          // The FILE's mtime — which a restore or sync rewrites — is
          // `fileAt` when the fixture gives one (F2), else the recorded time.
          briefUpdatedAt: p.brief ? (p.brief.fileAt || p.brief.updatedAt) : null,
          briefAuthoredBy: p.brief ? briefProvenance(p.brief) : null,
          // The store's true per-project totals (F5), when the fixture says.
          ...(Number.isInteger(p.scopeCount) ? { scopeCount: p.scopeCount } : {}),
          ...(Number.isInteger(p.savedCopies) ? { savedCopies: p.savedCopies } : {}),
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
    // ── TIER 0's INDEX — a fake, so it is DUMB by the same rule as the rest
    //    of this store: it holds `p.foundations` and returns it, or throws
    //    `p.foundationsThrows`, never computing a freshness answer of its own.
    //    Absent from `spec` entirely (every fixture above §11), it answers
    //    `present: false` with zeros — which is what a project with no tier 0
    //    tier gets from the real store too.
    async listFoundations(domain, project) {
      foundationsCalls.push(domain + '\u0000' + project);
      const p = projects.find((x) => x.domain === domain && x.project === project);
      if (p && p.foundationsThrows) {
        throw new Error(typeof p.foundationsThrows === 'string' ? p.foundationsThrows : 'synthetic foundations failure');
      }
      if (!p || !p.foundations) return { ok: true, present: false, staleCount: 0, unreachableCount: 0 };
      return {
        ok: true, present: true,
        staleCount: Number.isInteger(p.foundations.staleCount) ? p.foundations.staleCount : 0,
        unreachableCount: Number.isInteger(p.foundations.unreachableCount) ? p.foundations.unreachableCount : 0,
      };
    },
    // Test-only: not part of the store's real API, read back by §11 to prove
    // `listFoundations` was called once per project and never once per row.
    __foundationsCalls: foundationsCalls,
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
      // Recorded 3 days ago by an agent; the FILE was rewritten an hour ago by
      // a restore (F2) — the widget must say 3 days, not an hour.
      brief: { updatedAt: ago(3 * 86400), authoredBy: 'agent', fileAt: ago(3600) },
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
section('§2 Layout A — one row per (project × harness) saved in 24 h; the rest folds into Idle');
// ═══════════════════════════════════════════════════════════════════════════

eq(twoInOne.model.active.rows.map((r) => r.label),
  ['lumina · Claude Code · 12 min ago', 'atlas · OpenCode · 1 hr ago'],
  'two active projects: one row each, newest first — `project · harness · age`, where, who and when on line one');
eq(twoInOne.model.active.header, 'Active · last 24 h', 'under the header "Active · last 24 h"');
ok(twoInOne.model.active.rows.every((r, i, a) => i === 0 || r.ageSeconds >= a[i - 1].ageSeconds),
  '…strictly newest first');
eq(twoInOne.model.active.rows[0].streams.map((s) => s.scope),
  ['session-2026-09-06-router', 'session-2026-09-05-notes'],
  'lumina\'s OTHER scopes are not rows on the face — they are its row\'s "Other work-streams", newest first');
eq(twoInOne.model.idle, null, 'nothing is idle in that fixture, so there is no Idle row at all');

eq(oneEach.model.active.rows.map((r) => r.projectName), ['lumina', 'field-notes'],
  'two domains with one project each: the rows name the BARE project');
eq(oneEach.model.active.rows.map((r) => r.domain), ['workshop', 'articles'],
  '…while the domain is still CARRIED on every row, because the route needs it');

// THE DOMAIN PREFIX IS DROPPED EVEN WHERE THE PRODUCER QUALIFIES. The
// producer calls lumina `workshop / lumina` (its domain holds two projects);
// on a line that says `lumina · Claude Code · 12 min ago` the domain is the
// drop-constant rule again — it comes back only when two listed projects share
// a bare name. The submenu header and the tooltip always carry the pair.
eq(twoInOne.summary.scopes[0].projectLabel, 'workshop / lumina', 'CONTROL — the producer qualifies lumina with its domain');
eq(twoInOne.model.active.rows[0].projectName, 'lumina', '…and line one does not');
eq(twoInOne.model.active.rows[0].submenuHeader, 'lumina · session-2026-09-07-widget',
  '…the submenu header names the work-stream — here without the domain, because the qualified form is 45 characters and the plain budget is 42');
eq(oneEach.model.active.rows[0].submenuHeader, 'workshop / lumina · main', '…and WITH it wherever it fits');
ok(twoInOne.model.active.rows[0].toolTip.startsWith('workshop / lumina · session-2026-09-07-widget'),
  '…and so does the tooltip, first line');
{
  const clash = await drive({
    projects: [
      { domain: 'workshop', project: 'main',
        scopes: [{ scope: 's', machine: 'mac-a1b2c3', age: 100, harness: 'claude-code', headline: 'w' }] },
      { domain: 'articles', project: 'main',
        scopes: [{ scope: 's', machine: 'mac-a1b2c3', age: 200, harness: 'claude-code', headline: 'a' }] },
    ],
  });
  eq(clash.model.active.rows.map((r) => r.projectName), ['workshop / main', 'articles / main'],
    'two domains each holding a project called `main` are TWO rows, told apart by the domain — restored on both');
}

eq(legacyOnly.model.active.rows.length, 1, 'a legacy-only store: ONE active row — one project, one tool');
eq(legacyOnly.model.active.rows[0].label, 'articles · Claude Code · 2 min ago', '…named for the domain, which IS the default project\'s slug');
eq(legacyOnly.model.active.rows[0].streams.length, 5, '…and its five other scopes are its Other work-streams');
ok(legacyOnly.model.rows.every((r) => r.isDefaultProject === true),
  '…every row, streams included, marked as the domain\'s own project, which decides its on-disk path');

// ── IDLE: one row per project, folded ───────────────────────────────────
eq(monopoly.model.active.rows.map((r) => r.projectName), ['lumina', 'atlas', 'field-notes'],
  'the busy project takes ONE row, not twelve: a row is a (project × tool), and its eleven other scopes are streams');
eq(monopoly.model.idle.label, 'Idle · 1 project', 'the fourth project, saved a day ago, is folded into "Idle · 1 project"');
eq(monopoly.model.idle.sublabel, 'archive 1 d', '…whose second line names it with a compact age');
eq(monopoly.model.idle.rows.map((r) => r.label), ['archive · OpenCode · 1 day ago'],
  '…and whose submenu holds it in the SAME row shape as Active');
ok(monopoly.model.idle.toolTip.includes('articles / archive · 1 day ago'), 'the Idle tooltip lists every idle project, fully qualified, with its age');

// ═══════════════════════════════════════════════════════════════════════════
section('§3 the caps — five rows, WHOLE projects, and an overflow that names its unit');
// ═══════════════════════════════════════════════════════════════════════════

eq(M.MAX_ROWS, 5, 'five active rows on the face');
{
  // Six projects saved today, one of them by TWO tools — seven rows' worth.
  const six = await drive({
    projects: ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => ({
      domain: 'w', project: n,
      scopes: [{ scope: 'main', machine: 'm-a1b2c3', age: 100 + i * 600, harness: 'claude-code', headline: n },
        ...(n === 'b' ? [{ scope: 'side', machine: 'm-a1b2c3', age: 150, harness: 'antigravity', headline: 'b2' }] : [])],
    })),
  });
  eq(six.model.active.rows.map((r) => r.projectName + '/' + r.harness),
    ['a/Claude Code', 'b/Antigravity', 'b/Claude Code', 'c/Claude Code', 'd/Claude Code'],
    'five rows, spent a whole project at a time: b\'s two tools are adjacent, newest first');
  eq(six.model.overflow.label, '+2 more active projects',
    'the rest is ONE item that names its unit — projects (D8), never a bare "(46)" of (scope, machine) pairs');
  eq(six.model.overflow.rows.map((r) => r.projectName), ['e', 'f'], '…and holds those rows, same shape');
  const t = MENU.buildTrayMenuTemplate(six.model, NOOPS);
  const ov = t.find((i) => i.id === MENU.ID_OVERFLOW);
  ok(ov && Array.isArray(ov.submenu) && ov.submenu.length === 2 && !ov.click,
    'in the menu the overflow is a submenu parent holding exactly the hidden rows');
  // A project that does not fit whole is not split, and nothing older jumps ahead of it.
  const splitRisk = await drive({
    projects: [
      { domain: 'w', project: 'a', scopes: [{ scope: 'main', machine: 'm-a1b2c3', age: 100, harness: 'h1', headline: 'x' }] },
      { domain: 'w', project: 'b', scopes: [1, 2, 3, 4, 5].map((k) => ({ scope: 's' + k, machine: 'm-a1b2c3', age: 200 + k, harness: 'tool-' + k, headline: 'x' })) },
      { domain: 'w', project: 'c', scopes: [{ scope: 'main', machine: 'm-a1b2c3', age: 900, harness: 'h1', headline: 'x' }] },
    ],
  });
  eq(splitRisk.model.active.rows.map((r) => r.projectName), ['a'],
    'b\'s five tools do not fit beside a — b goes WHOLE to the overflow rather than being split …');
  eq(splitRisk.model.overflow.rows.map((r) => r.projectName), ['b', 'b', 'b', 'b', 'b', 'c'],
    '… and c, OLDER than b, does not jump ahead of it onto the face');
  eq(splitRisk.model.overflow.label, '+2 more active projects', '… and the overflow counts two projects, not six rows');
  // The pathological first project: more tools in a day than the whole cap.
  const oneHuge = await drive({
    projects: [{ domain: 'w', project: 'a', scopes: [1, 2, 3, 4, 5, 6, 7].map((k) => ({ scope: 's' + k, machine: 'm-a1b2c3', age: 100 + k, harness: 'tool-' + k, headline: 'x' })) }],
  });
  eq(oneHuge.model.active.rows.length, 5, 'one project with seven tools today shows five rows (the first project always shows) …');
  eq(oneHuge.model.overflow.label, '+2 more tools on a shown project',
    '… and the overflow says what the two rows ARE — not "2 more projects", which would be false');
}
{
  // A tighter budget is honoured, and the cap never rises.
  const tight = M.buildTrayModel(monopoly.summary, { now: NOW, maxRows: 2 });
  eq(tight.active.rows.length, 2, 'a tighter row budget is honoured …');
  eq(M.buildTrayModel(monopoly.summary, { now: NOW, maxRows: 40 }).active.rows.length, 3,
    '… and the FETCH limit handed in as `maxRows` cannot raise it (the v3.50.0 call; monopoly has three active rows)');
  eq(M.buildTrayModel(monopoly.summary, { now: NOW, maxRows: 0 }).active.rows.length, 3, 'a nonsense budget falls back to the cap');
}
{
  // THE IDLE CAP, named in PROJECTS.
  const many = await drive({
    projects: Array.from({ length: 15 }, (_, i) => ({ domain: 'w', project: 'p' + String(i).padStart(2, '0'),
      scopes: [{ scope: 'main', machine: 'm-a1b2c3', age: 2 * 86400 + i * 3600, harness: 'claude-code', headline: 'x' }] })),
  });
  eq(many.model.idle.label, 'Idle · 15 projects', 'fifteen idle projects → "Idle · 15 projects"');
  eq(many.model.idle.rows.length, M.MAX_IDLE_ROWS, `the submenu lists the ${M.MAX_IDLE_ROWS} most recent`);
  eq(many.model.idle.moreLabel, '3 more projects in Project Context…', '… and names the true remainder, in projects');
  eq(many.model.idle.sublabel, 'p00 2 d · p01 2 d · +13 more', 'the Idle row\'s second line: two names, compact ages, the rest counted');
  const t = MENU.buildTrayMenuTemplate(many.model, NOOPS);
  const idle = t.find((i) => i.id === MENU.ID_IDLE);
  const more = idle.submenu.find((i) => i.id === MENU.ID_IDLE_MORE);
  ok(more && typeof more.click === 'function' && more.enabled !== false, 'the remainder item is ENABLED and routed — the only way to the hidden projects');
  eq(many.model.active.rows.length, 0, 'CONTROL — nothing is active');
  const noActive = t.find((i) => i.id === MENU.ID_NO_ACTIVE);
  ok(noActive && noActive.label === 'No saves in the last 24 h' && noActive.enabled === false,
    'with projects but none active, the Active header is followed by a statement, not left empty over the Idle row');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3b the shell asks for 40 and the face shows five — v3.51.0, kept');
// ═══════════════════════════════════════════════════════════════════════════
{
  const BIG = {
    projects: [
      { domain: 'workshop', project: 'curator',
        scopes: Array.from({ length: 13 }, (_, i) => ({
          scope: 'session-2026-09-0' + (i % 10) + '-curator-' + i, machine: 'mac-a1b2c3',
          age: 600 + i * 900, harness: 'claude-code', model: 'opus-4-6', headline: 'c' + i,
        })) },
      { domain: 'workshop', project: 'lumina',
        scopes: Array.from({ length: 7 }, (_, i) => ({
          scope: 'session-2026-08-2' + (i % 10) + '-lumina-' + i, machine: 'mac-a1b2c3',
          age: 40000 + i * 900, harness: 'claude-code', model: 'opus-4-6', headline: 'l' + i,
        })) },
      { domain: 'articles', project: 'field-notes',
        scopes: Array.from({ length: 3 }, (_, i) => ({
          scope: 'session-2026-08-1' + (i % 10) + '-notes-' + i, machine: 'mac-a1b2c3',
          age: 90000 + i * 900, harness: 'opencode', headline: 'n' + i,
        })) },
    ],
  };
  const big = await drive(BIG);
  eq(big.summary.scopes.length, 23, 'CONTROL — the data layer handed over all 23 rows');
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(big.model, NOOPS));
  const topLevel = flat.filter((i) => !String(i.path || '').includes(' › '));
  ok(topLevel.filter((i) => String(i.id || '').startsWith('tray-row-')).length <= M.MAX_ROWS,
    `at most ${M.MAX_ROWS} rows on the face of the menu, from 23 work-streams`);
  const hiddenStreams = big.model.rows.reduce((a, r) => a + (r.streamsHidden || 0), 0);
  eq(big.model.rows.length + hiddenStreams, 23,
    `… while EVERY one of the 23 is a row somewhere in the menu (${big.model.rows.length}) or COUNTED in a row's "N more in Project Context…" (${hiddenStreams}) — nothing a cap removed is unreachable`);
  eq(new Set(big.model.rows.map((r) => r.id)).size, big.model.rows.length, '… each drawn row with its own id');
  const flatAll = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(big.model, NOOPS));
  eq(flatAll.filter((i) => /^\d+ more in Project Context…$/.test(i.label || '')).map((i) => i.label),
    big.model.rows.filter((r) => r.streamsHidden > 0).map((r) => r.streamsHidden + ' more in Project Context…'),
    '… and every hidden remainder is an item in the menu, with its true count');
  const mainSrc = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const call = mainSrc.slice(mainSrc.indexOf('buildTrayModel(traySnapshot'));
  ok(!/maxRows/.test(call.slice(0, 200)), 'SCAN ONLY: the shell hands the model no row budget');
  // The data package (v3.74.0, D7) adds `sessionStart: false` to this call;
  // either form is accepted so the two branches stay green together.
  ok(/getTraySummary\(\{\s*limit:\s*TRAY_ROW_LIMIT\s*(,\s*sessionStart:\s*false\s*)?\}\)/.test(mainSrc),
    'SCAN ONLY: the FETCH still asks for all 40 (optionally with sessionStart:false)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3c "N more in Project Context…" counts against the project\'s TRUE total — v3.76.0, truth audit F5');
// ═══════════════════════════════════════════════════════════════════════════
//
// The maintainer's own menu read "8 more" under curator: 22 work-streams, 6
// shown, but only the 14 pairs that fell inside the fetch's 40 were counted.
{
  const streams = (proj, n, base, harness = 'claude-code') => Array.from({ length: n }, (_, i) => ({
    scope: 'session-2026-09-' + proj + '-' + i, machine: 'mac-a1b2c3',
    age: base + i * 600, harness, model: 'opus-5', headline: proj + i,
  }));
  // The store says 22 work-streams; only 14 of them are in the fetched window.
  const TRUE_TOTAL = {
    projects: [{ domain: 'workshop', project: 'curator', scopeCount: 22, savedCopies: 25,
      scopes: streams('c', 14, 120) }],
  };
  const t = await drive(TRUE_TOTAL);
  eq(t.summary.projects[0].scopeCount, 22, '★ the data layer carries the store\'s true scopeCount per project');
  eq(t.summary.projects[0].savedCopies, 25, '…and savedCopies');
  const row = t.model.active.rows[0];
  eq(row.streams.length, M.MAX_OTHER_STREAMS, 'CONTROL — the row shows the capped five');
  eq(row.streamsHidden, 22 - 1 - M.MAX_OTHER_STREAMS,
    '★ 22 − 6 shown = 16 more, NOT 14 − 6 = 8 from the fetched rows [F5]');
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(t.model, NOOPS));
  ok(flat.some((i) => i.label === '16 more in Project Context…' && typeof i.click === 'function'),
    '…and the menu item says 16, and opens Project Context');

  // No total from the store AND the fetch was cut short: the remainder is a floor.
  const NO_TOTAL = { projects: [{ domain: 'workshop', project: 'curator', scopes: streams('c', 14, 120) }] };
  const cut = await TS.getTraySummary({ store: fakeStore(NO_TOTAL), limit: 8, now: NOW_MS });
  ok(cut.truncated === true, 'CONTROL — the fetch was truncated (8 of 14)');
  const cm = M.buildTrayModel(cut, { now: NOW });
  const crow = cm.active.rows.find((r) => r.project === 'curator');
  eq(crow.streamsMoreLabel, 'At least 2 more in Project Context…',
    '★ with no store total and a truncated fetch, the count is said as a floor — never as exact [F5]');
  const full = M.buildTrayModel(await TS.getTraySummary({ store: fakeStore(NO_TOTAL), limit: 40, now: NOW_MS }), { now: NOW });
  eq(full.active.rows.find((r) => r.project === 'curator').streamsMoreLabel, '8 more in Project Context…',
    'CONTROL — nothing fetched short and no total: the fetched remainder IS the count, said exactly');

  // Two tools in one project, each with a capped list: the remainder is said
  // ONCE, on the project's first row; the other row names no number.
  const TWO_TOOLS = {
    projects: [{ domain: 'workshop', project: 'curator', scopeCount: 20,
      scopes: streams('a', 8, 60, 'claude-code').concat(streams('b', 8, 90, 'opencode')) }],
  };
  const tt = await drive(TWO_TOOLS);
  const rowsC = tt.model.active.rows.filter((r) => r.project === 'curator');
  ok(rowsC.length === 2, 'CONTROL — two rows, one per tool', rowsC.length);
  const shownScopes = new Set(rowsC.flatMap((r) => [r.scope, ...r.streams.map((x) => x.scope)]));
  eq(rowsC[0].streamsHidden, 20 - shownScopes.size,
    '★ the first row carries the project\'s whole remainder against its true total');
  eq(rowsC[1].streamsHidden, 0, '…the second row counts nothing, so no stream is counted twice');
  eq(rowsC[1].streamsMoreLabel, 'More in Project Context…', '…but still offers the way in, with no number');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3c one stream per work-stream per COMPUTER; two tools on one project are two rows');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The maintainer's installed app and his repo checkout stamp ONE Mac with two
  // install ids (v3.48.1); a hostname that flapped does the same. One scope,
  // two folders, one computer: it is one work-stream.
  const twoCopies = await drive({
    projects: [
      { domain: 'workshop', project: 'curator',
        scopes: [
          { scope: 'session-2026-09-07-widget', machine: 'mac-a1b2c3', age: 720, harness: 'claude-code', headline: 'the newest copy' },
          { scope: 'session-2026-09-06-other', machine: 'mac-a1b2c3', age: 3000, harness: 'claude-code', headline: 'another' },
          { scope: 'session-2026-09-06-other', machine: 'alices-mbp-a1b2c3', age: 5400, harness: 'claude-code', headline: 'older copy, same Mac' },
        ] },
    ],
  });
  eq(twoCopies.summary.scopes.length, 3, 'CONTROL — the store holds THREE pairs');
  eq(twoCopies.model.rows.map((r) => r.headline), ['the newest copy', 'another'],
    'the two folders of `other` share an install id — ONE computer — so the newest copy is the one stream shown');
  const twoMacs = await drive({
    projects: [
      { domain: 'workshop', project: 'curator',
        scopes: [
          { scope: 'main', machine: 'mac-a1b2c3', age: 720, harness: 'claude-code', headline: 'here' },
          { scope: 'side', machine: 'mac-a1b2c3', age: 1000, harness: 'claude-code', headline: 'here too' },
          { scope: 'side', machine: 'studio-9f8e7d', age: 1500, harness: 'claude-code', headline: 'there' },
        ] },
    ],
  });
  eq(twoMacs.model.rows.map((r) => r.headline), ['here', 'here too', 'there'],
    'the same scope on ANOTHER computer is kept — that copy is the news');

  // TWO TOOLS ON ONE PROJECT — the case the maintainer is building toward.
  const twoTools = await drive({
    projects: [{ domain: 'projects', project: 'ott', scopes: [
      { scope: 'main', machine: 'mac-a1b2c3', age: 480, harness: 'Claude Code', model: 'claude-opus-5-5', headline: 'v1.3.0 shipped' },
      { scope: 'roadmap', machine: 'mac-a1b2c3', age: 3 * 3600, harness: 'Antigravity', model: 'gemini-3.7-flash', headline: 'Roadmap drafted' },
      { scope: 'older', machine: 'mac-a1b2c3', age: 5 * 3600, harness: 'Claude Code (desktop)', model: 'claude-opus-5-5', headline: 'older work' },
    ] }],
  });
  eq(twoTools.model.active.rows.map((r) => r.label),
    ['ott · Claude Code · 8 min ago', 'ott · Antigravity · 3 hr ago'],
    'two ADJACENT rows, newest first — the repeated project name IS the handover signal');
  eq(twoTools.model.active.rows[0].streams.map((s) => s.scope), ['older'],
    '`Claude Code (desktop)` is Claude Code (normalised): its save is a stream under the Claude Code row, not a third tool');
  eq(twoTools.model.active.rows.map((r) => r.latest), [true, false],
    'ONLY the project\'s newest save may claim `latest`; the second tool\'s row is NOT latest');
  const p2 = RP.composeResumePrompt(twoTools.model.active.rows[1], { domainsDir: '/k' });
  ok(p2.includes('scope "roadmap"') && !p2.includes('"latest"'),
    '… so its resume prompt names ITS scope — "latest" would resume the other tool\'s work-stream');
  eq(twoTools.model.active.rows.map((r) => r.modelFamily), ['opus-5.5', 'gemini-3.7-flash'], 'line two carries the model family (D2: the minor version survives)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 what a row says, what its submenu holds, and what the icon\'s tooltip keeps');
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = twoInOne.model.active.rows[0];
  eq(r.sublabel, 'opus-4.6 — grouped the tray rows by project', 'line two: the model family, then the agent\'s own sentence');
  eq(r.tier, 'recent', 'the dot is the app\'s tier for 12 minutes: recent');
  ok(/harness: Claude Code \(recorded as “claude-code”\)/.test(r.toolTip), 'the tooltip keeps the RAW harness string beside the normalised name');
  ok(r.toolTip.includes('model: opus-4-6'), '… and the exact model id');
  const opened = [];
  const t = MENU.buildTrayMenuTemplate(twoInOne.model, { ...NOOPS, onOpenScope: (x) => opened.push(x && x.route) });
  const item = t.find((i) => i.id === r.id);
  ok(item && !item.click && Array.isArray(item.submenu), 'a row is a submenu parent with no click of its own');
  eq(item.submenu[0].label, r.submenuHeader, 'its submenu opens on the work-stream\'s header');
  eq(item.submenu.slice(1, 5).map((i) => i.label), MENU.ROW_ACTIONS.map(([, l]) => l), '… then the four actions, in order');
  eq(item.submenu[6].label, 'Other work-streams', '… then, because there are some, an "Other work-streams" header');
  const streams = item.submenu.slice(7);
  eq(streams.map((s) => s.label), ['router · 2 hr ago', 'notes · 1 day ago'],
    'each stream is `scope · age` — the harness is omitted because it is the row\'s own tool');
  ok(streams.every((s) => Array.isArray(s.submenu) && s.submenu.length === 5 && !s.click),
    'and each stream is itself a submenu parent with the same four actions — a SECOND level, to be photographed');
  streams[0].submenu[1].click();
  item.submenu[1].click();
  eq(opened, ['workshop/lumina', 'workshop/lumina'], 'Open in The Curator on a stream or the row opens the project');
  const atlas = t.find((i) => i.id === twoInOne.model.active.rows[1].id);
  ok(!atlas.submenu.some((i) => i.label === 'Other work-streams'), 'a row with no other streams has no such header');
}
{
  // The icon's tooltip keeps the fast answer, worded as what it is.
  eq(twoInOne.model.headline.text, 'Last save: lumina · Claude Code · 12 min ago',
    'the headline is "Last save: …" — the past tense for a past event, and the menu itself no longer draws it');
  ok(MENU.trayToolTip(twoInOne.model).startsWith('The Curator — Last save: lumina · Claude Code · 12 min ago'),
    '… and the icon\'s hover says it before anything is clicked');
  ok(!MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(twoInOne.model, NOOPS)).some((i) => /^Working on/.test(i.label || '')),
    'no "Working on" line anywhere in the menu');
  eq(twoInOne.model.headline.route, 'workshop/lumina', 'it still carries the route of the newest project');
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
eq(legacyOnly.model.brief.text, 'Brief file changed 2 weeks ago',
  '…and its clause says nothing about one, rather than guessing "you wrote it" — and, with no recorded time, it is worded as the FILE\'s age (F2)');
// ── F2/F3 (v3.76.0): THE RECORDED TIME AND THE AUTHOR, THROUGH THE REAL SHAPE ──
eq(twoInOne.summary.brief.ageSource, 'recorded',
  '★ the brief\'s age is its own recorded write time (the stamp\'s `on=`), not the file\'s mtime [F2]');
ok(twoInOne.summary.brief.ageSeconds > 2.9 * 86400,
  '★ …so a file a restore rewrote an hour ago still reads 3 days [F2]', twoInOne.summary.brief.ageSeconds);
eq(twoInOne.summary.brief.authoredBy, 'agent',
  '★ the data layer reads `.kind` off the store\'s provenance OBJECT — "by an agent" can appear [F3]');
eq(legacyOnly.summary.brief.ageSource, 'file', '…a brief with no stamp falls back to the file time, and says so');


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
  ['workshop/lumina', 'workshop/atlas', 'workshop/lumina', 'workshop/lumina'],
  '…on every row — the face, then the streams — taken from that row\'s own pair');
eq(legacyOnly.model.rows[0].route, 'articles/articles',
  'a legacy default project routes as `<domain>/<domain>`, because its project slug IS the domain — the route is machine-read and does not collapse');

// THE MARKER, which is the same pair written for a HUMAN to type.
//
// IT DOES NOT COLLAPSE, and until v3.48.0 it did — dropping the domain for a
// domain's own project, so the widget emitted `articles` where the app's own
// `Copy marker line` emitted `articles/articles` for the very same project.
// Two lines for one project is one too many, and the bare form is the one the
// cross-domain project search can refuse: it answers `project_ambiguous` the
// moment any other domain holds a project of that name. `articles/articles`
// is the correct line and is asserted as a literal.
eq(twoInOne.model.rows[0].marker, 'workshop/lumina', 'the `.curator-project` marker line is the same pair…');
eq(legacyOnly.model.rows[0].marker, 'articles/articles',
  '…on a legacy default project too: the marker NEVER collapses to a bare domain, because the app\'s own Copy marker line does not and the bare form is the one that can be refused as ambiguous');
eq(twoInOne.model.rows.map((r) => r.marker),
  ['workshop/lumina', 'workshop/atlas', 'workshop/lumina', 'workshop/lumina'],
  '…on every row, from that row\'s own pair');
// AND THE TWO PRODUCERS AGREE. The app composes `state.activeSlug + '/' +
// project` in views/domains.js (copyProjectMarker) and the store returns
// `${domain}/${slug}` as `markerLine`; this is the widget's third copy of the
// same rule, so it is checked against the shape both of those emit rather
// than only against itself.
for (const r of [...twoInOne.model.rows, ...legacyOnly.model.rows]) {
  eq(r.marker, r.domain + '/' + r.project,
    `the marker for ${r.domain} · ${r.project} is exactly the pair the app and the store also write`);
}

{
  // The shell hands the WHOLE ROW to `onOpenScope`, and takes `route` off it —
  // asserted by driving the real submenu item's click.
  let got = null;
  const t = MENU.buildTrayMenuTemplate(twoInOne.model, { ...NOOPS, onOpenScope: (r) => { got = r; } });
  const atlasRow = twoInOne.model.rows.find((r) => r.project === 'atlas');
  MENU.flattenTrayMenu(t).find((i) => i.id === MENU.rowActionId(atlasRow.id, MENU.ID_ROW_OPEN)).click();
  ok(got && got.route === 'workshop/atlas',
    'clicking `Open in The Curator` on the atlas row hands the shell THAT row\'s route, not the first one\'s');

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

  // A STREAM IS NOT "latest", and the prompt must not say so.
  const second = twoInOne.model.rows.find((r) => r.scope === 'session-2026-09-06-router');
  eq(second.latest, false, 'CONTROL — an Other work-streams row is not its project\'s newest');
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
section('§7 the width budget, over every label the four fixtures emit — at every depth');
// ═══════════════════════════════════════════════════════════════════════════
//
// The menu was MEASURED at 363.5 points (v3.42.0) and every label is budgeted
// against it. Layout A moves the harness onto line one and nests two submenu
// levels; each line is measured where it is drawn.
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
        const isRow = /^tray-row-\d+$/.test(String(it.id || ''));
        const cap = key === 'sublabel' ? M.MAX_HEADLINE_CHARS : (isRow ? M.ROW_LABEL_CHARS : M.PLAIN_LABEL_CHARS);
        if (it[key].length > cap) over.push(`${name} ${key} (${it[key].length} > ${cap}): ${it[key]}`);
      }
    }
  }
  ok(lines >= 60, `CONTROL: ${lines} rendered lines were measured across four fixtures, so the sweep is not looking at an empty menu`);
  ok(widest > 24, `CONTROL: the widest of them is ${widest} characters, a real line rather than a stub`);
  eq(over, [], 'every label (a row\'s against its 13pt-dot budget) and every sublabel is inside its budget, submenus included');
  console.log(`    widest rendered line: ${widest} characters — "${widestText}"`);
}

// ── AND THE HEIGHT, STATED AS ARITHMETIC ────────────────────────────────
{
  const top = MENU.buildTrayMenuTemplate(monopoly.model, NOOPS).filter((i) => i.type !== 'separator');
  eq(top.map((i) => i.id), [MENU.ID_PULSE, MENU.ID_HEADER_ACTIVE, ...monopoly.model.active.rows.map((r) => r.id), MENU.ID_IDLE,
    MENU.ID_OPEN_MEMORY, MENU.ID_OPEN_APP, MENU.ID_SETTINGS, MENU.ID_UPDATED_STAMP, MENU.ID_QUIT],
    'the monopoly store\'s whole top level: the pulse, one header, three active rows, the Idle fold, the commands, the stamp and Quit — fifteen work-streams in six reading lines');
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

// ═══════════════════════════════════════════════════════════════════════════
section('§10 stale documents are a NOTICE now (v3.74.0) — only when true');
// ═══════════════════════════════════════════════════════════════════════════
//
// Until v3.72 the mark rode on the headline's grey second line — "three words
// on a line that already exists". Layout A removed that line, and the design
// turns the one part of the Documents reading worth an alert into a notice:
// `<project> · N docs stale`, for an ACTIVE project, only when true.
{
  const base = (foundations, age = 720) => ({
    ok: true,
    scopes: [{
      domain: 'workshop', project: 'lumina', projectLabel: 'lumina', projectsInDomain: 1,
      scope: 'session-2026-09-07-widget', machine: 'mac-a1b2c3',
      writtenAt: ago(age), ageSource: 'agent',
      harness: 'claude-code', model: 'opus-4-6', headline: 'grouped the tray rows by project',
      foundations,
    }],
  });
  const staleOf = (m) => m.notices.filter((n) => n.kind === 'docs-stale').map((n) => n.text);
  const fresh = M.buildTrayModel(base({ present: true, count: 4, staleCount: 0, unreachableCount: 0 }), { now: NOW });
  eq(staleOf(fresh), [], 'CONTROL: fresh foundations → no notice');
  const freshText = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(fresh, NOOPS))
    .map((i) => [i.label, i.sublabel, i.toolTip].filter(Boolean).join(' ')).join(' ');
  ok(!/stale/i.test(freshText), '…and the word "stale" appears on nothing a person reads');
  eq(staleOf(M.buildTrayModel(base({ present: true, count: 4, staleCount: 3, unreachableCount: 0 }), { now: NOW })),
    ['lumina · 3 docs stale'], 'three stale → one notice, naming the project');
  eq(staleOf(M.buildTrayModel(base({ present: true, count: 2, staleCount: 1, unreachableCount: 0 }), { now: NOW })),
    ['lumina · 1 doc stale'], 'one is singular');
  eq(staleOf(M.buildTrayModel(base({ present: true, count: 2, staleCount: 1, unreachableCount: 2 }), { now: NOW })),
    ['lumina · 1 doc stale · 2 not checked'],
    '★ stale and not-checked are TWO clauses, never summed under "stale" — "not checked" is no comparison at all [F6]');
  eq(staleOf(M.buildTrayModel(base({ present: true, count: 9, staleCount: 0, unreachableCount: 1 }), { now: NOW })),
    ['lumina · 1 doc not checked'],
    '★ the maintainer\'s own case: stale 0, unreachable 1 reads "1 doc not checked", never "1 doc stale" [F6]');
  eq(staleOf(M.buildTrayModel(base({ present: true, count: 9, staleCount: 0, unreachableCount: 2 }), { now: NOW })),
    ['lumina · 2 docs not checked'], '…plural');
  eq(staleOf(M.buildTrayModel(base(null), { now: NOW })), [], 'no foundations → silent');
  eq(staleOf(M.buildTrayModel(base(undefined), { now: NOW })), [], '…and so is a producer that does not report them');
  eq(staleOf(M.buildTrayModel(base({ staleCount: 3, unreachableCount: 0 }, 3 * 86400), { now: NOW })), [],
    'an IDLE project\'s stale documents are not a notice — nobody is working on it');
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(
    M.buildTrayModel(base({ present: true, count: 4, staleCount: 3, unreachableCount: 0 }), { now: NOW }), NOOPS));
  const n = flat.find((i) => i.label === 'lumina · 3 docs stale');
  ok(n && n.enabled === false && /differ from their sources/.test(n.toolTip || ''),
    'in the menu it is a disabled statement whose tooltip says what "stale" means');
  const flatU = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(
    M.buildTrayModel(base({ present: true, count: 4, staleCount: 0, unreachableCount: 1 }), { now: NOW }), NOOPS));
  const u = flatU.find((i) => i.label === 'lumina · 1 doc not checked');
  ok(u && /could not be checked from this Mac/.test(u.toolTip || '') && !/differ/.test(u.toolTip || ''),
    '…and a not-checked notice\'s tooltip says it could not be checked — never that it differs [F6]', u && u.toolTip);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 the PRODUCER, not just the consumer — real rows into the real composer');
// ═══════════════════════════════════════════════════════════════════════════
{
  const spec = {
    projects: [
      { domain: 'workshop', project: 'lumina',
        foundations: { staleCount: 1, unreachableCount: 0 },
        scopes: [
          { scope: 'session-2026-09-07-a', machine: 'mac-a1b2c3', age: 300, harness: 'claude-code', model: 'opus-4-6', headline: 'one' },
          { scope: 'session-2026-09-06-b', machine: 'mac-a1b2c3', age: 9000, harness: 'claude-code', model: 'opus-4-6', headline: 'two' },
          { scope: 'session-2026-09-05-c', machine: 'mac-a1b2c3', age: 90000, harness: 'claude-code', model: 'opus-4-6', headline: 'three' },
        ] },
      { domain: 'workshop', project: 'atlas',
        scopes: [{ scope: 'main', machine: 'mac-a1b2c3', age: 4200, harness: 'opencode', headline: 'quiet' }] },
    ],
  };
  const store = fakeStore(spec);
  const summary = await TS.getTraySummary({ store, limit: M.TRAY_FETCH_ROWS, now: NOW_MS });
  const luminaRows = summary.scopes.filter((r) => r.project === 'lumina');
  eq(luminaRows.length, 3, 'PRECONDITION: three lumina rows came back from the real producer');
  ok(luminaRows.every((r) => r.foundations && r.foundations.staleCount === 1 && r.foundations.unreachableCount === 0),
    'every lumina row carries the counts the store reported — PRODUCED, not hand-set');
  const atlasRow = summary.scopes.find((r) => r.project === 'atlas');
  ok(atlasRow && atlasRow.foundations && atlasRow.foundations.staleCount === 0,
    'the project with no foundations key still gets a zeroed object, from the producer itself');
  eq(store.__foundationsCalls.filter((k) => k === 'workshop\u0000lumina').length, 1,
    `the producer called listFoundations exactly once for lumina (log: ${JSON.stringify(store.__foundationsCalls)})`);
  const model = M.buildTrayModel(summary, { now: NOW });
  eq(model.notices.filter((n) => n.kind === 'docs-stale').map((n) => n.text), ['lumina · 1 doc stale'],
    'the notice is built from a REAL producer summary — lumina only, once');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} test-tray-projects: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
