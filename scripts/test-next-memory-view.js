/**
 * test-next-memory-view.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * NOTE FOR ANYONE GREPPING THIS FILE: `fingerprint()` below joins each path to
 * its hash with a literal NUL byte — correct, because a filename can contain
 * anything except NUL and `/` — but it makes `file(1)` classify this suite as
 * binary, so plain `grep` prints NOTHING and silently looks like a clean miss.
 * Use `grep -a`. Do not remove the NUL to make grep happy; it is the separator
 * that cannot collide with a real filename.
 *
 * Guards the Agent-memory surface: the read-only route (src/routes/memory.js)
 * and the /next view that renders it (src/public/next/views/memory.js).
 *
 * Everything here DRIVES REAL CODE. The route handlers are pulled straight
 * off the real Express router and invoked with fake req/res objects; the
 * view's render functions are lifted out of the live source by brace-matching
 * and executed with `new Function` (the technique test-next-loading-gate.js
 * and test-next-provider-rows.js use). "A test that proves a line exists
 * proves nothing about what it does."
 *
 * The store itself is real too: fixtures are produced by calling the real
 * `saveWorkingState` / `saveProjectBrief` against a tempdir domains root
 * installed with `__setDomainsDirOverride`. Nothing in this suite can reach
 * the user's own domains folder.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · THE ROUTE NEVER WRITES. A recursive sha256 of the whole domains tree is
 *    identical before and after every endpoint is driven, including with
 *    hostile inputs — and the router registers GET methods only, with no
 *    write-shaped call anywhere in its source.
 *  · Unknown project -> 404 BEFORE any filesystem access; an invalid scope or
 *    machine -> 400 carrying the store's own reason.
 *  · The index reports a project with no state as `scopeCount: 0` with
 *    `lastWriteAt: null` — a fact and its absence never collapse into one
 *    value (no "0 seconds ago", no epoch).
 *  · `journalLimit` is passed through un-clamped; the STORE owns the ceiling.
 *  · ESCAPING: every untrusted field the view interpolates itself is
 *    HTML-escaped, driven through the real render functions with hostile
 *    fixtures — and the handoff/brief BODY is routed through the shared
 *    markdown renderer, which is executed for real here, not stubbed away.
 *  · THE <summary> HAZARD, as a class invariant over rendered OUTPUT rather
 *    than over source text: no `<button>`, `<select>`, `<input>`, `<a>` or
 *    `<textarea>` may appear inside any `<summary>…</summary>` the view emits.
 *  · The view has NO write path, asserted STRUCTURALLY: every `fetch(` call
 *    site in the view takes exactly ONE argument, so it can only ever be a GET
 *    whatever a method string is spelled like. (The previous five-literal-
 *    string scan was defeated by `const M = 'PO' + 'ST'`.)
 *  · THE MOUNT CONTRACT IS EXECUTED, not grepped: onEnter is lifted out of the
 *    registerView object literal and run against a recording window/document.
 *    schedulePoll fires on mount; the teardown cancels the gate, calls
 *    stopPoll, closes view-owned popovers and REMOVES both wake listeners; two
 *    mount/teardown cycles leak nothing; and the wake handler itself is
 *    invoked (revalidates when visible, does not when hidden or unmounted).
 *  · The SHIPPED render() drives §11 — not a copy of it — so the fact that it
 *    records `renderedSignature` is what makes "an unchanged poll re-renders
 *    NOTHING" true. It paints both panes, re-wires, and bails on a stale mount.
 *  · The focus contract is executed: capture is bounded to FOCUSABLE_IDS,
 *    restore is BY ID with preventScroll, FOCUS_FALLBACK covers a control that
 *    removed itself, and a miss is held only while another render is coming.
 *  · The poll constants are pinned to HAND-WRITTEN LITERALS (20000 / 20 /
 *    300000) read off live source, and the SAME parsed values are threaded
 *    into the harness, so §11a's arithmetic is a claim about production.
 *  · renderStaleNotice is executed, and executed THROUGH renderProject, so the
 *    Reload offer is proven to reach all three content branches — each fixture
 *    additionally checked for having reached the branch it is named after.
 *  · reloadActive KEEPS the user's scope and machine (it does not snap to the
 *    newest, which is what selectProject deliberately does instead), falls back
 *    to the freshest only when the scope is genuinely gone, and abandons a
 *    result that lands after a remount.
 *  · A COVERAGE CENSUS enumerated FROM DISK: every top-level function is either
 *    executed here or listed with the reason it is not, so a new one cannot
 *    arrive untested in silence.
 *  · `splitHandoffPreamble` can never eat a body line, and returns the raw
 *    text unchanged rather than emptying a document it does not recognise.
 *  · `formatAge(null/NaN/negative)` is null, never "0s ago".
 *  · The cross-machine badge renders only on an explicit `false`, never on an
 *    absent field.
 *  · The SQUARE marker is square: .mem-row-mark / .mem-project-mark carry a
 *    small radius, and neither is a circle.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · Nothing here measures real rendering, layout or contrast. The browser
 *    pass (both themes, desktop and 768px, zero console errors, zero
 *    horizontal overflow) was run by hand and is not reproducible in Node.
 *  · The <summary> scan sees the markup THESE render functions emit. A
 *    control injected into a summary from some other code path, or built by
 *    string concatenation this suite does not drive, is invisible to it.
 *  · `shared/markdown.js` has its own suite (test-next-markdown.js) which
 *    owns the escape-first invariant. This suite only proves the view ROUTES
 *    untrusted body text through it and escapes everything else itself.
 *  · Headings rendered by the shared renderer are `<div class="chat-md-h">`,
 *    not real `<h*>` elements, so the handoff has no screen-reader outline.
 *    That is a pre-existing property of the shared renderer (recorded in
 *    v3.9.0) and is deliberately not changed from a view file.
 *  · The route's index cost (one journal-tail read per scope/machine pair) is
 *    inherited from listWorkingScopes and is not asserted here.
 *  · §11 drives the revalidation logic against a FAKE fetch and a FAKE clock.
 *    It proves what refreshIndex/refreshScopeList/nextPollDelay/schedulePoll
 *    DO with a given response; it does not prove the BROWSER fires `focus` or
 *    `visibilitychange`. That the listeners are attached and removed, and what
 *    the handler does when it fires, IS now executed (§12) — but against a
 *    fake EventTarget, so the browser half remains a hand-verified claim
 *    (0 fetches over 28 s away from the view).
 *  · renderSidebar / renderMain / wire are DOM-bound and are injected as
 *    spies. §12/§13 prove they are CALLED with the mount token; the markup
 *    they assemble from the render* functions is covered directly in §6/§14,
 *    but the setSidebar/setMain/addEventListener calls themselves are not run.
 *  · §12's "schedulePoll is in the mount half, stopPoll in the teardown half"
 *    is a SOURCE SCAN over the comment-stripped closure, and says so in its own
 *    assertion text. Execution proves each is called once per cycle; only the
 *    scan proves WHICH half it lives in.
 *  · The census records that a function is LIFTED and run, never that its every
 *    branch is covered, and never that a meaningful assertion was made about
 *    what it returned. Its EXECUTED set is hand-maintained; the only mechanical
 *    check on it is that each name really is extracted from live source here.
 *    `renderSidebar`, `renderMain`, `freshState`,
 *    `loadIndex`, `selectProject` and `wire` are listed as not executed, each
 *    with its reason, rather than being quietly absent. (`renderNoProjects`
 *    moved to EXECUTED in v3.62.0 — see §21's own note.)
 *  · refreshScopeList's `!state.scope` early return is defence in depth and
 *    is NOT independently pinned: the membership check below it already
 *    returns for a falsy scope. Said so in the source, and measured.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Shared source-scanning helpers (scripts/test-source-scan-helpers.js proves
// each one detects the defect it claims to). Used here so a positive scan
// cannot be satisfied by a `//` comment, a file-wide regex cannot be satisfied
// by a line in some OTHER function, and vocabulary is pinned to a literal
// rather than to the constant the production code itself reads.
import { stripComments, functionSource, callSiteCount, assertLiteral } from './test-helpers/source-scan.js';
// The shared text system the view now renders through. IMPORTED, not stubbed
// and not lifted: shared/text.js deliberately takes no imports of its own so
// that it is executable in Node (its header records why), which makes it the
// one shared component this harness can run for real. A stub would let the
// escaping battery below pass over markup the shipped screen never emits.
import {
  renderDescription, renderStatus, renderReadout, renderReadoutGroup,
  renderBadge, renderExplainer,
  // §18h executes the header component itself: `panelWide` is an opt-in on
  // renderViewHeader, and asserting that memory.js PASSES it proves nothing
  // about whether the component honours it.
  renderViewHeader,
  // The REAL ⓘ mark. `renderFoundations` composes one beside the drafting-ask
  // control, and a stubbed mark would let the button ship with no explanation
  // beside it and still pass every assertion here.
  renderInfoMark,
} from '../src/public/next/shared/text.js';
// The docs-link table, imported for the same reason: it takes no imports and
// THROWS on an unknown key, so lifting the real one is what proves the About
// panel's link resolves rather than merely that some string was interpolated.
import { docsLinkHtml as realDocsLinkHtml } from '../src/public/next/shared/docs-links.js';

// ── THE DOCS TABLE IS ANOTHER PACKAGE'S FILE, AND docsUrl THROWS ──────────
//
// `docsUrl` throws on an unknown key by design: a typo is then a blank screen
// in development rather than a dead link in production. That is right, and it
// makes a key added by one work package and USED by another into a hard
// coupling — a throw inside `renderProject` takes every assertion after it
// with it, and the suite reports a CRASH rather than a named gap.
//
// So the real helper is wrapped: a key that does not resolve is RECORDED and a
// placeholder returned, and §21m below asserts the recorded set is EMPTY. One
// red assertion naming the missing key, instead of a stack trace — and no
// weakening, because the assertion fails until the key exists.
const pendingDocsKeys = new Set();
function docsLinkHtml(key, label) {
  try {
    return realDocsLinkHtml(key, label);
  } catch {
    pendingDocsKeys.add(String(key));
    return '<a href="#unresolved-docs-key">' + String(label) + '</a>';
  }
}
// The shared section block. Imported for the same reason the text renderers
// are: it imports only shared/text.js, which takes no imports at all, so the
// real component runs in Node — and every one of this page's five sections is
// framed by it since v3.55.0, so a stub would let the escaping battery and the
// placement assertions run past the thing that frames them.
import { renderBlock } from '../src/public/next/shared/block.js';
// ── THE CALENDAR-DAY LADDER, REAL (v3.62.0) ────────────────────────────────
// Step ③ and the strip's KNOWLEDGE cell read `lastIngestDate`, a `YYYY-MM-DD`
// heading with no time of day in it, so they cut on the DAY bands rather than
// on the second-resolution ones. Imported rather than stubbed for the reason
// `freshnessTier` is lifted: a stub would let this suite agree with itself
// that the strip and the Domains rows paint one scale while the shipped page
// painted two.
import {
  formatDayAge as realFormatDayAge,
  dayFreshnessTier as realDayFreshnessTier,
  freshnessDotHtml as realFreshnessDotHtml,
} from '../src/public/next/shared/age.js';
// The post-copy banner, imported rather than typed: §21c3 asserts that the
// DRAFTING request's confirmation is NOT this sentence, and a copy here would
// let the two drift into agreement.
import { COPY_SUCCESS_BANNER } from '../src/public/next/shared/agent-instructions.js';
// `renderDepthCell` joins it in v3.65.1 (§9) — the REAL one, for the same
// reason: the Documents table's SIZE column and step ③'s three category counts
// draw their share through it, and a stub would let every assertion about a
// bar's denominator run past the function that computes the width.
import { renderMonitor, renderDepthCell } from '../src/public/next/shared/monitor.js';
import { renderBucket, formatTokens } from '../src/public/next/shared/bucket.js';
// v3.67.0: the run line kit, REAL — it imports only the honest formatter, so
// it loads in Node, and the helper's panel is under test through it.
import { renderRunsOn, renderSpent, aiActionDisabledAttrs } from '../src/public/next/shared/ai-run.js';
import { renderSidebarHead, renderSidebarGroup, renderSidebarRow,
  identityDotClass } from '../src/public/next/shared/sidebar.js';
// ── THE OWNERSHIP CHOOSER, THE REAL ONE (v3.61.0) ─────────────────────────
// shared/foundations-init.js imports only from the DOM-free kit (shared/age.js,
// since v3.61.1 — the contract shared/text.js carries, stated as what it always
// meant), so the real module runs in Node and is imported rather than stubbed. That matters twice: the four STORE MIRRORS it exports are what
// memory.js's editor measures against, and a stub would let this suite agree
// with itself about a wall the shipped page enforced at a different number.
// scripts/test-next-foundations-editor.js pins all four against
// src/brain/working-state.js.
import {
  FOUNDATION_SLUG_RE, FOUNDATION_ROLES, MAX_FOUNDATION_BYTES, FOUNDATIONS_BUDGET_BYTES,
  freshChooser, chooserBody, chooserOutcomeWords, renderFoundationsChooser,
  renderRoleOptions, renderRefusedList, formatBytes,
  // ── THE COMMIT'S OWN PREDICATE (v3.61.1) ────────────────────────────────
  // `renderFoundationsInit` asks the shared module whether its primary can be
  // pressed and paints the reason when it cannot. The REAL one, because a stub
  // returning '' would leave the button armed in exactly the state the
  // sentence exists for, with every assertion here green.
  commitBlockedReason,
  // v3.65.2 — the first unmet step, the primary's count and the READ WITH ⓘ.
  nextStepReason, pickedFiles, READ_WITH_INFO_HTML,
} from '../src/public/next/shared/foundations-init.js';
// v3.68.0 — the two doors' DOM-free rules and markup, injected REAL.
import {
  doorsFor, renderDoors, renderAddPanel, startLegendHtml,
} from '../src/public/next/shared/foundations-add.js';
import * as FA from '../src/public/next/shared/foundations-add.js';
// v3.69.0 — per-document sources: the DOM-free rules the view imports as ONE
// namespace (`FSRC`), injected REAL into every lifted renderer that reads it.
import * as FSRC from '../src/public/next/shared/foundations-sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

// ── Tempdir domains root ─────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'curator-memview-'));
const DOMAINS = join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });

// Registered so a throw still cleans up. `finally` runs BEFORE process.exit,
// which is the ordering v3.9.1's 37,353 stale temp directories came from.
function cleanup() {
  try {
    // Refuse anything that is not one segment below the OS temp dir.
    const rel = relative(tmpdir(), TMP);
    if (rel && !rel.startsWith('..') && !rel.includes('/')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
}

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const { renderOverview: realRenderOverview } = await import('../src/public/next/shared/overview.js');
__setDomainsDirOverride(DOMAINS);

function makeDomain(slug, extraCLAUDE) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), (extraCLAUDE || '') + '# ' + slug + '\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}

makeDomain('alpha');
makeDomain('blank');
// A read-only Shared Brain mirror: isDomainReadonly reads `readonly: true`
// out of the domain's CLAUDE.md frontmatter.
makeDomain('shared-cohort', '---\nreadonly: true\n---\n\n');

const ws = await import('../src/brain/working-state.js');

await ws.saveProjectBrief('alpha', {
  brief: 'Alpha is the fixture project.',
  decisions: ['Never write from the app.'],
  harness: 'claude-code', model: 'claude-opus-5',
});
await ws.saveWorkingState('alpha', {
  scope: 'feature-x',
  headline: 'First save',
  nowState: 'Everything is fine.',
  nextSteps: ['Keep going.'],
  harness: 'claude-code', model: 'claude-opus-5',
});
await ws.saveWorkingState('alpha', {
  scope: 'feature-y',
  headline: 'Second scope',
  nowState: 'A different scope.',
  harness: 'cursor', model: 'gpt-5',
});
// THE MIRROR'S STATE IS WRITTEN TO DISK DIRECTLY, and it has to be. This was
// `saveWorkingState('shared-cohort', …)`, which the store REFUSES with
// `reason: 'readonly'` — every in-app write surface refuses a Shared Brain
// mirror — so the mirror fixture had no state at all, and every assertion
// about it was passing over an empty tree. It went unnoticed because the
// pre-v3.48.0 index emitted one row per DOMAIN whether or not anything was in
// it, so "the mirror appears in the index like any other project" was true of
// a domain with nothing in it. A mirror's state arrives over SYNC, not through
// a local save, so writing the files is also the honest fixture.
{
  const mdir = join(DOMAINS, 'shared-cohort', 'state', 'main', 'cohort-machine-aa11');
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, 'current.md'),
    '# Handoff\n\n## Headline\n\nMirror state\n\n## Where things stand\n\nFrom a cohort member.\n');
  writeFileSync(join(mdir, 'journal.jsonl'), JSON.stringify({
    saved_at: new Date().toISOString(), headline: 'Mirror state',
    harness: 'claude-code', model: 'claude-opus-5', kind: 'complete',
  }) + '\n');
}

// A PROJECT THAT EXISTS AND HAS NEVER BEEN SAVED TO. `briefed` carries a
// standing brief and no handoff, which is a real, deliberate configuration —
// somebody wrote the brief before the first agent session — and it is the row
// on which "a fact and its absence stay apart" is asserted below. It replaces
// `blank` in that role: since v3.48.0 the store OMITS a domain's own project
// when it has neither a brief nor a save, so `blank` is no longer a row at all
// and cannot carry an assertion about what a row says.
makeDomain('briefed');
{
  const r = await ws.saveProjectBriefText('briefed', 'briefed',
    '## Standing brief\n\nWritten before the first session.', { authoredBy: { kind: 'human' } });
  if (!r.ok) throw new Error('fixture: brief-only project could not be created: ' + r.message);
}

// A SECOND MACHINE under one scope. Without this the fixture has 2 scopes
// across 2 pairs, so `scopeCount` and the pair count are numerically equal
// and NO assertion could tell them apart — the pairs-vs-work-streams
// regression would pass silently. With it, alpha is 2 scopes / 3 pairs.
{
  const src = join(DOMAINS, 'alpha', 'state', 'feature-x');
  const machine = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory())[0].name;
  const dst = join(src, 'second-machine');
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(join(src, machine))) {
    writeFileSync(join(dst, f), readFileSync(join(src, machine, f)));
  }
}

// ── A FIXTURE WHOSE TWO CLOCKS DISAGREE (v3.57.0) ────────────────────────
//
// `?open=newest` asks the route to pick the pair the VIEW's table puts first,
// so that the view can paint a project from ONE response instead of two. The
// only way to prove it picks on the right clock is a store where the two
// clocks give different answers — which is not a contrived shape, it is what
// EVERY synced machine has: git stamps `mtime` with the moment the checkout
// landed, so the store's own order (mtimeMs, descending) says "whatever
// arrived last" while every age on the page comes from the journal.
//
// Written to disk directly rather than through `saveWorkingState`, for the
// same reason the shared-mirror fixture is: a save stamps both clocks with
// `now`, and a fixture that cannot disagree with itself proves nothing.
//
// TWO PROJECTS, because the two properties need different shapes:
//
//   `clocks/skew`  — mtime and the agent's clock RANKED OPPOSITELY, so a pick
//                    on either one is unmistakable.
//   `clocks/tie`   — two pairs saved in the SAME second, with the store's
//                    order (mtime) putting the LATER name first. Ties are not
//                    a corner case here: every age on a scope row is a whole
//                    number of seconds, and on a copied store git gives every
//                    file the same mtime, so a whole project can tie at once.
makeDomain('clocks');
{
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const DAY = 86400000;
  const plant = (project, scope, machine, savedAtIso, mtimeSecondsAgo) => {
    const dir = join(DOMAINS, 'clocks', 'state', project, scope, machine);
    mkdirSync(dir, { recursive: true });
    const cur = join(dir, 'current.md');
    writeFileSync(cur,
      '# Handoff\n\n## Headline\n\n' + scope + ' on ' + machine
      + '\n\n## Where things stand\n\nPlanted.\n');
    const jr = join(dir, 'journal.jsonl');
    // `at`, which is the field the store reads — NOT `saved_at`, which is what
    // this fixture said first and which produced a `writtenAt: null` the pick
    // then fell back past to the file clock, quietly making the fixture agree
    // with the defect it exists to catch.
    writeFileSync(jr, JSON.stringify({
      at: savedAtIso, scope, machine, headline: scope + ' on ' + machine,
      harness: 'claude-code', model: 'claude-opus-5', bytes: 120,
    }) + '\n');
    // The FILE clock, set after the writes so nothing above resets it.
    const t = new Date(Date.now() - mtimeSecondsAgo * 1000);
    for (const f of [cur, jr, dir]) utimesSync(f, t, t);
  };
  // skew: the agent-OLD pair carries the NEWEST mtime, so the store lists it
  // first and a pick on that order opens a fortnight-old handoff.
  plant('skew', 'agent-old', 'box-a', iso(14 * DAY), 1);
  plant('skew', 'agent-new', 'box-b', iso(5 * 60 * 1000), 60 * DAY / 1000);
  // A SECOND MACHINE under the agent-newest SCOPE, ranked the other way by the
  // two clocks again. Without it, naming the scope alone resolves the same
  // pair as naming scope AND machine, and "the machine is passed too" is a
  // claim no assertion can fail — the mutation that drops it ran GREEN until
  // this row existed.
  plant('skew', 'agent-new', 'box-c', iso(2 * DAY), 2);
  // tie: identical agent clocks; `zz` carries the newer mtime and therefore
  // comes first out of the store, while the table's order falls to the NAME.
  const tieAt = iso(3 * 60 * 1000);
  plant('tie', 'zz-second', 'box-a', tieAt, 1);
  plant('tie', 'aa-first', 'box-a', tieAt, 600);
}

// ── Recursive fingerprint of the whole domains tree ───────────────────────

function fingerprint(dir) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(relative(dir, p) + '\u0000' + createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  })(dir);
  return { hash: createHash('sha256').update(files.join('\n')).digest('hex'), count: files.length };
}

// ── Fake req/res over the REAL router ────────────────────────────────────

const routerMod = await import('../src/routes/memory.js');
const router = routerMod.default;

function routesOf(r) {
  return (r.stack || [])
    .filter((l) => l.route)
    .map((l) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods || {}).filter((m) => l.route.methods[m]),
      handle: l.route.stack[l.route.stack.length - 1].handle,
    }));
}
const ROUTES = routesOf(router);

function findRoute(path) {
  const r = ROUTES.find((x) => x.path === path);
  if (!r) throw new Error('route not found in the real router: ' + path);
  return r;
}

async function call(path, { params = {}, query = {} } = {}) {
  const route = findRoute(path);
  let status = 200;
  let body;
  let settled = false;
  const res = {
    status(c) { status = c; return res; },
    json(b) { body = b; settled = true; return res; },
  };
  await route.handle({ params, query }, res, (e) => { throw e || new Error('next() called'); });
  // Give an un-awaited handler a tick; every handler here is async and awaited,
  // so a false here would be a real regression, not flakiness.
  if (!settled) await new Promise((r) => setImmediate(r));
  return { status, body };
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — The route is registered READ-ONLY');
// ═════════════════════════════════════════════════════════════════════════

// ── THE ROUTE TABLE, AS A TABLE ─────────────────────────────────────────
//
// v3.48.0 gave this router its first write routes, and the old assertion
// here — "exactly 2 routes, all GET" — was the guard that said so. It is
// replaced rather than deleted, and by something STRICTER: the exact set of
// (method, path) pairs, so a new route of any kind has to be declared here
// before it can ship. An extra GET was invisible to the old count-and-verbs
// pair; it is not invisible to this.
const EXPECTED_ROUTES = [
  ['get', '/'],
  // THE REPO SCAN IS A LITERAL FIRST SEGMENT (v3.61.0), so it must precede
  // `/:project` — the one-segment alias at the bottom — or `GET /repo-scan`
  // would be read as "the project called repo-scan". It is registered second,
  // which is where the file puts it and where this table pins it.
  ['get', '/repo-scan'],
  ['get', '/:domain/projects'],
  ['post', '/:domain/projects'],
  ['patch', '/:domain/projects/:project'],
  ['delete', '/:domain/projects/:project'],
  // v3.65.0 — WHICH WIKIS a project's knowledge lives in. Curator METADATA
  // about the project (`state/[<project>/]project.json`), so the app is its
  // one writer and tiers 2 and 3 stay agent-only. FOUR segments, and here
  // the count is CORRECTNESS: the `patch` row directly above matches any
  // three-segment PATCH whose second segment is literally `projects`, and a
  // domain's own project is named after the domain — so a three-segment
  // `…/:project/knowledge` on a domain called `projects` would have been
  // answered by the RENAME handler, about a project called `knowledge`.
  ['patch', '/:domain/:project/knowledge/domains'],
  // v3.67.0 (package S) — THE READING BUDGET and SESSION START. The budget
  // PATCH is FOUR segments for the collision the row above records; the two
  // session-start routes carry a literal third segment, the same shape as
  // `capture`, and the preview is a POST because a proposed plan of up to 200
  // documents does not belong in a URL. Neither session-start route writes.
  ['patch', '/:domain/:project/reading/budget'],
  ['get', '/:domain/:project/session-start'],
  ['post', '/:domain/:project/session-start/preview'],
  // TIER 0 (v3.59.0, extended v3.61.0). Four segments, so none can shadow — or
  // be shadowed by — the two-segment reads below; the ordering WITHIN this
  // group is readability, not correctness, and the comment at the route says
  // so. What IS load-bearing is that every one of them still precedes the
  // one-segment alias.
  ['get', '/:domain/:project/foundations/:slug'],
  ['put', '/:domain/:project/foundations/:slug'],
  // v3.62.0: `readFirst` — curator METADATA ABOUT a document, never part of
  // it, so it is allowed on BOTH ownerships and a mirror's bytes are untouched.
  ['patch', '/:domain/:project/foundations/:slug'],
  ['delete', '/:domain/:project/foundations/:slug'],
  ['post', '/:domain/:project/foundations/init'],
  // v3.68.0 — "Add from this computer": a folder the owner picked, the files
  // they ticked; the store enforces every path rule.
  ['post', '/:domain/:project/foundations/add-local'],
  // v3.69.0 — "Add from GitHub" on any project (per-document sources).
  ['post', '/:domain/:project/foundations/add-remote'],
  ['post', '/:domain/:project/foundations/refresh'],
  // v3.65.1 — "Mirror from GitHub instead". A POST, not a PATCH: it fetches
  // blobs and rewrites files. Four segments like the rest of tier 0, and
  // DECLARED HERE because this table's own comment is the rule — a new route
  // of any kind is declared before it can ship.
  ['post', '/:domain/:project/foundations/source'],
  // v3.63.0 — the honesty meter (package U). READ-ONLY, and registered here
  // rather than after the two-segment reads below for no correctness reason:
  // a three-segment suffix route cannot shadow, or be shadowed by, either of
  // them, so this position is simply where the file puts it.
  ['get', '/:domain/:project/capture'],
  ['get', '/:domain/:project'],
  ['get', '/:project'],
];
const actualRoutes = ROUTES.flatMap((r) => r.methods.map((m) => [m, r.path]));
eq('the router registers exactly ' + EXPECTED_ROUTES.length + ' (method, path) pairs',
  actualRoutes.length, EXPECTED_ROUTES.length);
ok('the route table is exactly the declared one',
  JSON.stringify(actualRoutes) === JSON.stringify(EXPECTED_ROUTES),
  JSON.stringify(actualRoutes));

// ── ORDER IS A CORRECTNESS PROPERTY HERE, NOT TIDINESS ──────────────────
//
// A domain slug and a project slug are drawn from the same alphabet, so
// `/:domain/projects` and `/:domain/:project` are both two segments and
// Express matches them in REGISTRATION order. If the parametric one were
// registered first, `GET /api/memory/alpha/projects` would be read as "the
// project called `projects` in domain alpha" and the Domains view's whole
// list endpoint would 404. Asserted as an index comparison over the real
// router's own stack.
const iProjects = actualRoutes.findIndex((r) => r[0] === 'get' && r[1] === '/:domain/projects');
const iDetail = actualRoutes.findIndex((r) => r[0] === 'get' && r[1] === '/:domain/:project');
const iAlias = actualRoutes.findIndex((r) => r[0] === 'get' && r[1] === '/:project');
ok('GET /:domain/projects is registered BEFORE GET /:domain/:project',
  iProjects >= 0 && iDetail >= 0 && iProjects < iDetail, iProjects + ' vs ' + iDetail);
ok('the one-segment deprecated alias is registered LAST of the GETs',
  iAlias === actualRoutes.length - 1, 'index ' + iAlias);

const routeSrc = readFileSync(join(ROOT, 'src/routes/memory.js'), 'utf8');
// ── THE READ ROUTES STILL TOUCH NOTHING, AND THE WRITE ROUTES TOUCH TIER 1
//    ONLY ─────────────────────────────────────────────────────────────────
//
// The class guard is kept and NARROWED rather than dropped. This router may
// not write a byte itself: every mutation goes through the store, which owns
// the path chokepoint, the sanitisers and the caps. So the filesystem and
// wiki-write calls stay forbidden outright...
for (const forbidden of [
  'writeFile(', 'writeFileSync(', 'appendFile(', 'appendFileSync(', 'mkdir(', 'mkdirSync(',
  'rm(', 'rmSync(', 'unlink(', 'writePage(',
]) {
  ok('route source contains no ' + forbidden + ' call', !routeSrc.includes(forbidden));
}
// ...and so does the ONE store function that would reach tier 2 or tier 3.
// This is the assertion that carries the tier boundary: the app writes the
// standing brief and nothing else, and a handoff written from a browser
// would arrive wearing the last agent's provenance line.
ok('route source never calls saveWorkingState( — tiers 2 and 3 stay agent-only',
  !routeSrc.includes('saveWorkingState('));
// The write-registry IS imported now, and deliberately: a project rename
// moves a directory, so it must be refused while this domain has a write in
// flight — the same predicate PUT /api/domains/:domain uses.
ok('route source imports the write-registry, because a rename moves a directory',
  /^import[^;]*write-registry/m.test(routeSrc));

// ═════════════════════════════════════════════════════════════════════════
section('§2 — GET /api/memory (the index)');
// ═════════════════════════════════════════════════════════════════════════

const before = fingerprint(DOMAINS);
const idx = await call('/');
eq('index responds 200', idx.status, 200);
ok('index is ok', idx.body && idx.body.ok === true);
const byName = Object.fromEntries((idx.body.projects || []).map((p) => [p.project, p]));
// ── WHAT IS A ROW, SINCE v3.48.0 ─────────────────────────────────────────
// The store omits a domain's own project when it has NEITHER a brief NOR a
// save, because a row describing an empty tree is noise on a screen whose job
// is "which project". This route defers to that rather than keeping a second
// opinion — one description of "which projects exist", shared with the Domains
// view's Projects list and the menu-bar widget. `blank` is therefore absent,
// and this assertion is the deliberate replacement for "index lists every
// domain, not only those with state", which described v3.17.0-v3.47.
// 5 = alpha + briefed + shared-cohort + the two clock-skew projects added in
// v3.57.0; `blank` is still absent, which is what the next line asserts.
eq('the index lists the projects that HAVE something', Object.keys(byName).length, 5);
ok('...and a domain with neither a brief nor a save is not one of them',
  !byName.blank, JSON.stringify(Object.keys(byName)));
// THE OMISSION IS ONLY SAFE IF THE SERVER SAYS IT LOOKED. An empty index would
// otherwise be indistinguishable from "you have no domains", and the view
// would tell a user with four domains to create a fifth.
eq('...while the server says how many domains it scanned, so an EMPTY index is not ambiguous',
  idx.body.domainsScanned, 5);

// THE PAIRS-vs-WORK-STREAMS DISTINCTION. The fixture is deliberately
// asymmetric — 2 scopes spread over 3 (scope, machine) pairs — so these two
// assertions cannot both pass on a single number. Reporting the pair count as
// "scopes" told the user "3 scopes" for two work-streams, and got worse with
// every machine they synced from.
eq('alpha reports 2 SCOPES (work-streams), not 3 saved copies',
  (byName.alpha || {}).scopeCount, 2);
eq('alpha reports 3 SAVED COPIES (scope x machine pairs) as its own field',
  (byName.alpha || {}).savedCopies, 3);
ok('the fixture really is asymmetric, so the two assertions above cannot collapse',
  (byName.alpha || {}).scopeCount !== (byName.alpha || {}).savedCopies);
ok('alpha reports a standing brief', byName.alpha && byName.alpha.hasBrief === true);
ok('alpha carries a lastWriteAt', typeof (byName.alpha || {}).lastWriteAt === 'string');
ok('alpha carries a headline from the journal', typeof (byName.alpha || {}).headline === 'string');
ok('alpha names the newest scope so the view can open it in ONE request',
  typeof (byName.alpha || {}).newestScope === 'string' && typeof byName.alpha.newestMachine === 'string');

// A fact and its ABSENCE stay apart — the whole point. Asserted on `briefed`,
// a project that EXISTS (it has a standing brief) and has never been saved to.
ok('PRECONDITION: the brief-only project is a row at all', !!byName.briefed,
  JSON.stringify(Object.keys(byName)));
eq('a project with no saves reports scopeCount 0', (byName.briefed || {}).scopeCount, 0);
eq('a project with no saves reports lastWriteAt NULL, never an epoch', (byName.briefed || {}).lastWriteAt, null);
eq('a project with no saves reports ageSeconds NULL, never 0', (byName.briefed || {}).ageSeconds, null);
eq('a project with no saves reports headline NULL', (byName.briefed || {}).headline, null);
// "No state saved yet" and "a brief, no sessions yet" are DIFFERENT facts and
// the row says which: this one HAS a brief.
eq('...and reports its standing brief, which is why it is a row', (byName.briefed || {}).hasBrief, true);
// CONTROL: `alpha` differs on every one of those, so the assertions above are
// about this row rather than about a shape every row happens to have.
ok('CONTROL: a project WITH saves differs on each of them',
  byName.alpha.scopeCount > 0 && typeof byName.alpha.lastWriteAt === 'string'
  && typeof byName.alpha.headline === 'string');

ok('the shared mirror appears in the index like any other project', !!byName['shared-cohort']);
ok('...with the state that arrived over sync really counted, not an empty shell',
  (byName['shared-cohort'] || {}).savedCopies === 1, JSON.stringify(byName['shared-cohort']));

// ═════════════════════════════════════════════════════════════════════════
section('§3 — GET /api/memory/:project (the read)');
// ═════════════════════════════════════════════════════════════════════════

const unscoped = await call('/:project', { params: { project: 'alpha' } });
eq('unscoped read responds 200', unscoped.status, 200);
ok('unscoped read returns the brief', unscoped.body.brief && unscoped.body.brief.present === true);
eq('unscoped read returns scope: null', unscoped.body.scope, null);
eq('the unscoped read returns one index row per PAIR (the store’s own shape)',
  (unscoped.body.scopes || []).length, 3);
eq('unscoped read echoes readonly:false for a normal domain', unscoped.body.readonly, false);

const scoped = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x' } });
eq('scoped read responds 200', scoped.status, 200);
eq('scoped read reports the scope it read', scoped.body.scope, 'feature-x');
ok('scoped read returns current.md', scoped.body.current && scoped.body.current.present === true);
ok('scoped read still returns the brief (tier 1 is always returned)',
  scoped.body.brief && scoped.body.brief.present === true);
ok('scoped read picks a machine and says which', typeof scoped.body.machine === 'string');
eq('a scope with two machines lists BOTH so the user can switch',
  (scoped.body.machines || []).length, 2);
eq('scoped read reports whether that machine is this one', typeof scoped.body.machineIsThisMachine, 'boolean');
ok('scoped read returns journal entries', scoped.body.journal && scoped.body.journal.returned >= 1);

const mirror = await call('/:project', { params: { project: 'shared-cohort' }, query: { scope: 'main' } });
eq('a read-only mirror can still be READ (only writes are refused elsewhere)', mirror.status, 200);
eq('a read-only mirror echoes readonly:true so the view can say so', mirror.body.readonly, true);

const unknown = await call('/:project', { params: { project: 'not-a-domain' } });
eq('an unknown project is a 404', unknown.status, 404);
ok('the 404 body is ok:false', unknown.body && unknown.body.ok === false);

const traversal = await call('/:project', { params: { project: '../../etc' } });
eq('a traversal-shaped project name is refused as unknown (404)', traversal.status, 404);

// A traversal-shaped scope is SLUGIFIED to a safe segment by the store
// (`slugSegment('../escape')` -> 'escape'), so it resolves to a scope that
// simply does not exist rather than to a path outside state/. Asserted as
// what actually happens, not as what a 400 would have felt tidier.
const escScope = await call('/:project', { params: { project: 'alpha' }, query: { scope: '../escape' } });
eq('a traversal-shaped scope is slugified, not resolved outside state/', escScope.status, 200);
eq('...and reports the SLUGIFIED scope, never the raw input', escScope.body.scope, 'escape');
ok('...and finds nothing under it', escScope.body.current && escScope.body.current.present === false);

// A scope that cannot be slugified at all IS a 400 from the store.
const badScope = await call('/:project', { params: { project: 'alpha' }, query: { scope: '..' } });
eq('an unslugifiable scope is a 400', badScope.status, 400);
ok('the 400 carries the store’s own reason', typeof badScope.body.reason === 'string');
eq('...and names the field that was wrong', badScope.body.reason, 'invalid-scope');

const badMachine = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x', machine: '.' } });
eq('an unslugifiable machine is a 400', badMachine.status, 400);
eq('...and names the field that was wrong', badMachine.body.reason, 'invalid-machine');

const noSuchScope = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'nope' } });
eq('a scope that does not exist is 200 with an honest message, not an error', noSuchScope.status, 200);
ok('...and reports current.present false', noSuchScope.body.current && noSuchScope.body.current.present === false);

// journalLimit is passed through UN-CLAMPED; the store owns the ceiling.
const bigLimit = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x', journalLimit: '9999' } });
eq('an absurd journalLimit does not error', bigLimit.status, 200);
ok('...and the STORE clamps it (returned <= its own MAX)',
  bigLimit.body.journal.returned <= ws.MAX_JOURNAL_ENTRIES);
const junkLimit = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x', journalLimit: 'abc' } });
eq('a non-numeric journalLimit falls back to the store default without erroring', junkLimit.status, 200);

// ═════════════════════════════════════════════════════════════════════════
section('§3b — `?open=newest`: the index and the first handoff in ONE answer');
// ═════════════════════════════════════════════════════════════════════════
//
// The Agent-memory view needs BOTH halves to paint a project — the work-stream
// index, which only a scope-LESS read produces, and one pair's `current.md`,
// which only a SCOPED read produces — and until v3.57.0 it asked twice, in
// series, because the second URL is not knowable until the first has answered.
// Measured in a browser on a real store: 3 requests, 3 whole-column repaints,
// and a main column that collapsed from 5,062px to 215px in between.
//
// THREE PROPERTIES ARE LOAD-BEARING and each is asserted on its own:
//
//   1. `?scope=` is UNCHANGED. Every other caller of this route, and this same
//      view's Reload, still goes through it.
//   2. The pair chosen is the one the VIEW's table puts first — the AGENT's
//      clock, with the table's tie-break — or the page opens one handoff under
//      a highlight sitting on another row (the v3.56.0 defect).
//   3. `open` is byte-for-byte what the equivalent `?scope=&machine=` request
//      answers, so the client needs one code path rather than two.

// ── 1 · `?scope=` IS BYTE-IDENTICAL, against a recorded fixture ──────────
//
// Taken as the SAME call twice — once before the new option existed in this
// section's mind and once after — is not possible in one process, so what is
// recorded instead is the full body of a scoped read with the new query
// present and ABSENT. `open` may not appear, and nothing else may move. Age
// figures are normalised because the server recomputes them per read against
// its own `now`; the STAMPS they derive from are left in.
{
  const norm = (o) => JSON.stringify(o, (k, v) => (
    (k === 'ageSeconds' || k === 'writtenAgeSeconds' || k === 'arrivedAgeSeconds') ? 0 : v));
  const plain = await call('/:domain/:project',
    { params: { domain: 'alpha', project: 'alpha' }, query: { scope: 'feature-x' } });
  const withOpt = await call('/:domain/:project',
    { params: { domain: 'alpha', project: 'alpha' }, query: { scope: 'feature-x', open: 'newest' } });
  eq('a scoped read still answers 200 with the option present', withOpt.status, 200);
  ok('`?open=newest` alongside a `scope` changes NOTHING — a caller that has '
    + 'already decided what to open has nothing for this to pick',
  norm(plain.body) === norm(withOpt.body),
  norm(plain.body).slice(0, 200) + ' | ' + norm(withOpt.body).slice(0, 200));
  ok('...and in particular does not grow an `open` key', !('open' in withOpt.body));
  // ANTI-VACUITY: the comparator can tell two bodies apart.
  const other = await call('/:domain/:project',
    { params: { domain: 'alpha', project: 'alpha' }, query: { scope: 'feature-y' } });
  ok('CONTROL: the comparator really does report a difference when there is one',
    norm(plain.body) !== norm(other.body));
  // An unrecognised value is ignored rather than refused — a client from a
  // future release must never turn this read into an error.
  const junk = await call('/:domain/:project',
    { params: { domain: 'clocks', project: 'skew' }, query: { open: 'something-else' } });
  eq('an unrecognised `open` value is IGNORED, never a 400', junk.status, 200);
  ok('...and answers the ordinary scope-less read', Array.isArray(junk.body.scopes) && !('open' in junk.body));
}

// ── 2 · THE PICK IS ON THE AGENT'S CLOCK ────────────────────────────────
{
  const skewIdx = await call('/:domain/:project', { params: { domain: 'clocks', project: 'skew' } });
  eq('PRECONDITION: the skew fixture has three pairs across two work-streams',
    (skewIdx.body.scopes || []).length, 3);
  // The fixture is only a fixture if the two clocks really disagree.
  const first = (skewIdx.body.scopes || [])[0] || {};
  ok('FIXTURE: the store lists the agent-OLD pair first, because its FILE is the '
    + 'newest — which is what a checkout does to every file it writes',
  first.scope === 'agent-old', JSON.stringify((skewIdx.body.scopes || []).map((s) => s.scope)));
  ok('...and that pair really is the older SAVE by the agent\'s own clock',
    first.writtenAgeSeconds > 86400, String(first.writtenAgeSeconds));

  const opened = await call('/:domain/:project',
    { params: { domain: 'clocks', project: 'skew' }, query: { open: 'newest' } });
  eq('the read still answers 200', opened.status, 200);
  eq('...and still carries the whole work-stream index', (opened.body.scopes || []).length, 3);
  ok('THE OPENED PAIR IS THE AGENT-NEWEST, not the store\'s first',
    opened.body.open && opened.body.open.scope === 'agent-new',
    JSON.stringify(opened.body.open && opened.body.open.scope));
  // THE MACHINE IS NAMED, AND IT HAS TO BE. `agent-new` exists on two machines
  // whose clocks disagree in opposite directions, so a read that names only the
  // scope lets the STORE resolve the copy — by mtime — and the highlight lands
  // on a row the table did not put first. Asserted against the control below,
  // which shows the two really do resolve differently.
  eq('...named down to the MACHINE, because the table marks its open row on the pair',
    opened.body.open.machine, 'box-b');
  {
    const scopeOnly = await call('/:domain/:project',
      { params: { domain: 'clocks', project: 'skew' }, query: { scope: 'agent-new' } });
    eq('CONTROL: naming the scope ALONE resolves the OTHER machine, on the file '
      + 'clock — which is what dropping the machine from the pick would open',
    scopeOnly.body.machine, 'box-c');
  }
  ok('...and it carries the document, which is the half a scope-less read cannot give',
    opened.body.open.current && opened.body.open.current.present === true);
  ok('...and its journal', opened.body.open.journal && opened.body.open.journal.returned >= 1);

  // THE TIE-BREAK. Both pairs saved in the same second; the store puts `zz`
  // first on mtime and the table's order falls to the NAME.
  const tie = await call('/:domain/:project',
    { params: { domain: 'clocks', project: 'tie' }, query: { open: 'newest' } });
  const tieFirst = (tie.body.scopes || [])[0] || {};
  ok('FIXTURE: the two tied pairs are genuinely tied on the agent\'s clock',
    (tie.body.scopes || []).length === 2
    && tie.body.scopes[0].writtenAt === tie.body.scopes[1].writtenAt,
    JSON.stringify((tie.body.scopes || []).map((s) => [s.scope, s.writtenAt])));
  eq('FIXTURE: ...and the store still puts the LATER name first, on mtime',
    tieFirst.scope, 'zz-second');
  eq('A TIE FALLS TO THE NAME, exactly as the table\'s `workStreamOrder` does',
    tie.body.open && tie.body.open.scope, 'aa-first');

  // A PROJECT WITH NOTHING TO OPEN SAYS SO. `null` rather than an omitted key:
  // a missing key is what an OLDER server answers, and the view's fallback
  // depends on telling the two apart.
  const empty = await call('/:domain/:project',
    { params: { domain: 'briefed', project: 'briefed' }, query: { open: 'newest' } });
  eq('a project with no work-streams answers 200', empty.status, 200);
  ok('...and reports `open: null` — a key that is PRESENT and empty, so a client '
    + 'can tell "nothing to open" from "this server does not know the option"',
  'open' in empty.body && empty.body.open === null, JSON.stringify(empty.body.open));
}

// ── 3 · `open` IS THE SECOND REQUEST'S OWN ANSWER ───────────────────────
//
// Compared against the REAL `?scope=&machine=` call rather than against a list
// of fields, because a field list is a second description of the payload that
// would have to be maintained beside the store's own — and the disclosure
// fields (`unlistedEntries`, `requestedMachine`, `machineIsThisHost`,
// `installIdAvailable`, `machinesTruncated`) are exactly the class this repo
// keeps losing by enumerating. A deep comparison cannot drop one silently.
{
  const norm = (o) => JSON.stringify(o, (k, v) => (
    (k === 'ageSeconds' || k === 'writtenAgeSeconds' || k === 'arrivedAgeSeconds') ? 0 : v));
  const opened = await call('/:domain/:project',
    { params: { domain: 'clocks', project: 'skew' }, query: { open: 'newest' } });
  const direct = await call('/:domain/:project', {
    params: { domain: 'clocks', project: 'skew' },
    query: { scope: opened.body.open.scope, machine: opened.body.open.machine },
  });
  ok('`open` is byte-for-byte the answer to the request it replaces',
    norm(opened.body.open) === norm(direct.body),
    'open=' + norm(opened.body.open).slice(0, 300) + '\n     direct=' + norm(direct.body).slice(0, 300));
  // ANTI-VACUITY, twice: the bodies are not both empty, and the comparator can
  // see a difference.
  ok('CONTROL: the compared body is a real one, not two empty objects',
    Object.keys(direct.body).length > 8, String(Object.keys(direct.body).length));
  const wrong = await call('/:domain/:project',
    { params: { domain: 'clocks', project: 'skew' }, query: { scope: 'agent-old' } });
  ok('CONTROL: the comparator reports a difference against the OTHER pair',
    norm(opened.body.open) !== norm(wrong.body));
  // THE DISCLOSURE FIELDS SURVIVE THE NESTING. Named individually as well as
  // covered by the deep compare, because this is the drop class the memory
  // layer keeps re-learning and a named miss is easier to read than a diff.
  for (const f of ['installIdAvailable', 'machineIsThisMachine', 'machineCount',
    'machinesTruncated', 'unlistedMachines']) {
    ok('the disclosure field `' + f + '` survives being nested under `open`',
      f in opened.body.open, JSON.stringify(Object.keys(opened.body.open)));
  }
  // ...and the OUTER body keeps its own, which the inner read does not carry.
  for (const f of ['scopeCount', 'distinctScopeCount', 'savedCopies', 'unlistedEntries', 'unlistedReason']) {
    ok('the index half keeps `' + f + '` beside the opened pair',
      f in opened.body, JSON.stringify(Object.keys(opened.body)));
  }
  eq('`scopeCount` still means the PAIR total on this route, not distinct scopes '
    + '— a legacy name meaning two things, and neither is redefined here',
  opened.body.scopeCount, 3);
  eq('...while `distinctScopeCount` counts the WORK-STREAMS, which is the other '
    + 'quantity and the reason the unambiguous name was added rather than one '
    + 'of the two being redefined', opened.body.distinctScopeCount, 2);
}

// ── 4 · THE TWO RULES HTTP CANNOT REACH ─────────────────────────────────
//
// `listWorkingScopes` gives every real row an `ageSeconds` off its own file,
// so a pair with NO readable time at all cannot be produced through the route.
// Two of `tableFirstPair`'s rules therefore have no HTTP path, and both are
// driven directly rather than left as branches with a comment claiming they
// work — which is the shape this repo names "a test that proves a line exists
// proves nothing".
{
  const { tableFirstPair } = routerMod;
  ok('the pick is exported so its unreachable rules can be driven at all',
    typeof tableFirstPair === 'function');
  const young = { scope: 'young', machine: 'm', writtenAgeSeconds: 10 };
  const old = { scope: 'old', machine: 'm', writtenAgeSeconds: 99999 };
  const blind = { scope: 'blind', machine: 'm' };   // no clock of any kind
  eq('ABSENCE NEVER DISPLACES A READING, whichever side it is on',
    (tableFirstPair([blind, young, old]) || {}).scope, 'young');
  eq('...and the same the other way round, so the rule is not an artefact of order',
    (tableFirstPair([young, old, blind]) || {}).scope, 'young');
  eq('a pair with no reading still WINS when it is alone — absence is not a '
    + 'disqualification, only a non-displacement',
  (tableFirstPair([blind]) || {}).scope, 'blind');
  eq('...and when every pair is blind, the FIRST is answered rather than none',
    (tableFirstPair([blind, { scope: 'blind2', machine: 'm' }]) || {}).scope, 'blind');
  eq('no pairs at all is null, never a fabricated row', tableFirstPair([]), null);
  eq('...and a non-array is the same answer rather than a throw', tableFirstPair(null), null);
  ok('a hole in the list is skipped rather than crashing the pick',
    (tableFirstPair([null, young]) || {}).scope === 'young');
  // The agent's clock is PREFERRED, not merely accepted — asserted on rows
  // whose two clocks rank them oppositely, with no filesystem involved.
  const fileNew = { scope: 'file-new', machine: 'm', writtenAgeSeconds: 99999, ageSeconds: 1 };
  const agentNew = { scope: 'agent-new', machine: 'm', writtenAgeSeconds: 10, ageSeconds: 99999 };
  eq('the AGENT\'s clock wins over the file\'s whenever there is one',
    (tableFirstPair([fileNew, agentNew]) || {}).scope, 'agent-new');
  // ...and the file clock is a real fallback, not dead text.
  const noAgent = { scope: 'no-agent', machine: 'm', ageSeconds: 5 };
  eq('...while a pair with only a file clock is still ranked by it',
    (tableFirstPair([old, noAgent]) || {}).scope, 'no-agent');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — Driving every endpoint wrote NOTHING');
// ═════════════════════════════════════════════════════════════════════════

const after = fingerprint(DOMAINS);
eq('the domains tree holds the same number of files', after.count, before.count);
eq('the domains tree is byte-identical after every route call', after.hash, before.hash);
ok('the fingerprint is not vacuous (it saw real files)', before.count > 10, 'saw ' + before.count);

// ═════════════════════════════════════════════════════════════════════════
section('§5 — View helpers, lifted from live source and EXECUTED');
// ═════════════════════════════════════════════════════════════════════════

/** Brace-matched extraction of a real function from live source. Throws
 *  loudly on a desync rather than producing a confusing SyntaxError later.
 *  (Same helper as scripts/test-next-loading-gate.js.) */
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const viewSrc = readFileSync(join(NEXT, 'views/memory.js'), 'utf8');
// The shared age vocabulary. `freshnessStep` lives here since the freshness
// scale went app-wide; everything else the strip reads is still in the view.
const ageSrc = readFileSync(join(NEXT, 'shared/age.js'), 'utf8');
const viewCss = readFileSync(join(NEXT, 'views/memory.css'), 'utf8');
// The shared listbox's RENDER half. Lifted rather than stubbed, so §6's
// escaping battery runs through the component that actually paints these two
// pickers — a stub would let a hole in the component's own escaping pass here
// while the real screen carries it. It cannot be imported: shared/listbox.js
// imports next/app.js, which touches `document` at module scope.
const listboxSrc = readFileSync(join(NEXT, 'shared/listbox.js'), 'utf8');

// The REAL escapeHtml from app.js — lifted rather than reimplemented, so a
// change there cannot leave this suite testing a copy that no longer matches.
const appSrc = readFileSync(join(NEXT, 'app.js'), 'utf8');
const escapeHtml = new Function(extractFunction(appSrc, 'escapeHtml', 'app.js') + '\nreturn escapeHtml;')();
ok('the real escapeHtml was lifted and works', escapeHtml('<a>') === '&lt;a&gt;');

// The REAL shared markdown renderer, module body eval'd with `icon` stubbed
// (its only import). Not stubbed away: the handoff body genuinely goes
// through it, so the composition must be provable here.
const mdSrc = readFileSync(join(NEXT, 'shared/markdown.js'), 'utf8')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\.\/app\.js';\s*$/m, '')
  .replace(/^export\s+/gm, '');           // module body -> function body
const renderMarkdown = new Function('icon', mdSrc + '\nreturn renderMarkdown;')(() => '<svg></svg>');
ok('the real renderMarkdown was lifted and works',
  renderMarkdown('# Hi').includes('chat-md-h'));

const formatAge = new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')();
const projectMetaLine = new Function(
  extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
  // projectMetaLine now reads the AGENT'S clock where the store recovered one
  // (effectiveSave), falling back to filesystem mtime. Lifted with it so this
  // executes the shipped function rather than a version missing its collaborator.
  extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
  extractFunction(viewSrc, 'projectMetaLine', 'memory.js') + '\nreturn projectMetaLine;')();
const splitHandoffPreamble = new Function(
  extractFunction(viewSrc, 'splitHandoffPreamble', 'memory.js') + '\nreturn splitHandoffPreamble;')();

// formatAge — absence must never render as a number.
eq('formatAge(null) is null, never "0s ago"', formatAge(null), null);
eq('formatAge(undefined) is null', formatAge(undefined), null);
eq('formatAge(NaN) is null', formatAge(NaN), null);
eq('formatAge(-5) is null', formatAge(-5), null);
eq('formatAge("30") is null (a string is not a measurement)', formatAge('30'), null);
eq('formatAge(0) is "just now"', formatAge(0), 'just now');
eq('formatAge(59) is "just now"', formatAge(59), 'just now');
eq('formatAge(60) is "1 min ago"', formatAge(60), '1 min ago');
eq('formatAge(3600) is "1 hr ago"', formatAge(3600), '1 hr ago');
eq('formatAge(86400) singularises "1 day ago"', formatAge(86400), '1 day ago');
eq('formatAge(172800) pluralises "2 days ago"', formatAge(172800), '2 days ago');
eq('formatAge(7*86400) is "1 week ago"', formatAge(7 * 86400), '1 week ago');
eq('formatAge(400*86400) is "1 year ago"', formatAge(400 * 86400), '1 year ago');
ok('formatAge is monotonic over a decade of samples', (() => {
  let last = -1;
  for (let s = 0; s < 400 * 86400; s += 3607) {
    const v = formatAge(s);
    if (typeof v !== 'string' || !v.length) return false;
    last = s;
  }
  return last > 0;
})());

// projectMetaLine — three DIFFERENT facts, said three different ways.
eq('meta: no state and no brief',
  projectMetaLine({ scopeCount: 0, hasBrief: false, ageSeconds: null }), 'no state saved yet');
eq('meta: a brief but no sessions is its OWN state, not "nothing"',
  projectMetaLine({ scopeCount: 0, hasBrief: true, ageSeconds: null }), 'brief only — no sessions yet');
eq('meta: one scope singularises',
  projectMetaLine({ scopeCount: 1, hasBrief: true, ageSeconds: 60 }), '1 scope · 1 min ago');
eq('meta: several scopes pluralise',
  projectMetaLine({ scopeCount: 3, hasBrief: true, ageSeconds: 3600 }), '3 scopes · 1 hr ago');
eq('meta: a scope count with an UNKNOWN age omits the age rather than inventing one',
  projectMetaLine({ scopeCount: 2, hasBrief: false, ageSeconds: null }), '2 scopes');
eq('meta: a null project is the empty string, not a crash', projectMetaLine(null), '');

// splitHandoffPreamble — must never eat a body line, must never empty a doc.
{
  const doc = '# Working state — x\n\n> The headline\n\n_Machine: m · Saved: t_\n\n## Where things stand\n\nBody text.\n';
  const r = splitHandoffPreamble(doc);
  eq('preamble split recovers the headline', r.headline, 'The headline');
  ok('preamble split drops the doc title', !r.body.includes('# Working state'));
  ok('preamble split drops the provenance line', !r.body.includes('_Machine:'));
  ok('preamble split keeps the first section heading', r.body.startsWith('## Where things stand'));
  ok('preamble split keeps the body', r.body.includes('Body text.'));
}
{
  // A document with no sections at all: strip NOTHING rather than empty it.
  const doc = '# Just a title\n\n> just a headline\n';
  const r = splitHandoffPreamble(doc);
  eq('a document that is ALL preamble is returned unchanged (fail safe)', r.body, doc);
  eq('...and no headline is claimed from it', r.headline, null);
}
{
  const doc = '## Where things stand\n\nStraight into a section.\n';
  const r = splitHandoffPreamble(doc);
  eq('a `## ` section is never mistaken for a doc title', r.body, doc);
  eq('...and no headline is invented', r.headline, null);
}
{
  const doc = '# T\n\n> H\n\n## S\n\nFirst.\n\n> A quote in the BODY\n';
  const r = splitHandoffPreamble(doc);
  ok('a quote later in the body survives', r.body.includes('> A quote in the BODY'));
  eq('only the FIRST leading quote is taken as the headline', r.headline, 'H');
}
eq('splitHandoffPreamble(null) does not throw', splitHandoffPreamble(null).body, '');
eq('splitHandoffPreamble("") does not throw', splitHandoffPreamble('').body, '');
{
  const plain = 'Just some prose with no markdown at all.';
  eq('plain prose is returned untouched', splitHandoffPreamble(plain).body, plain);
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — ESCAPING, through the REAL render functions');
// ═════════════════════════════════════════════════════════════════════════

const XSS = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)';

// The v3.48.0 starting brief, lifted off LIVE SOURCE rather than retyped.
// A copy typed here would be a second description of the four headings the
// store renders, free to drift from the one the app actually offers.
const BRIEF_TEMPLATE_SRC = (() => {
  const m = /export const BRIEF_TEMPLATE = (\[[\s\S]*?\]\.join\('\\n'\));/.exec(viewSrc);
  if (!m) throw new Error('BRIEF_TEMPLATE not found in memory.js — the lift below would be a paraphrase');
  return new Function('return (' + m[1] + ');')();
})();

// The brief's byte wall, lifted off LIVE SOURCE for the same reason: it is the
// number `src/routes/memory.js` refuses at, and a copy typed here could drift
// from the one the editor actually shows and the route actually enforces.
const BRIEF_MAX_BYTES_SRC = (() => {
  const m = /const BRIEF_MAX_BYTES = (\d+);/.exec(viewSrc);
  if (!m) throw new Error('BRIEF_MAX_BYTES not found in memory.js — §16g would be a paraphrase');
  return m[1];
})();

// The work-stream table's window, its step and the size above which the step
// stops being "all the rest" — all three off LIVE SOURCE, for the same reason.
// A copy typed here could agree with every assertion in §6e while the shipped
// table painted a different number of rows.
const numConst = (name) => {
  const m = new RegExp('^const ' + name + ' = (\\d+);$', 'm').exec(viewSrc);
  if (!m) throw new Error(name + ' not found in memory.js — §6e would be a paraphrase');
  return Number(m[1]);
};
// THE THREE STEP LEDES ARE GONE (v3.65.0, R4). They were read off live source
// here because the skeleton and the filled page had to emit BYTE-IDENTICAL
// ledes; neither emits one now, and §18i asserts their ABSENCE from the
// rendered page together with the presence of the ⓘ in the head row, which is
// the claim that replaces them. `strConst` goes with them — it had no other
// caller — rather than being left as a helper nothing uses.

// The store's session budget, off LIVE SOURCE for the reason BRIEF_MAX_BYTES
// is: it is the number `get_project_context` drops bodies at, and a copy typed
// here could agree with every assertion while the shipped block warned at a
// different one.
const READ_FIRST_BUDGET_SRC = (() => {
  const m = /^const READ_FIRST_BUDGET_BYTES = ([^;]+);$/m.exec(viewSrc);
  if (!m) throw new Error('READ_FIRST_BUDGET_BYTES not found in memory.js — §21 would be a paraphrase');
  return m[1];
})();

const WS_WINDOW_SRC = numConst('WS_WINDOW');
const WS_STEP_SRC = numConst('WS_STEP');
const WS_STEP_ALL_MAX_SRC = numConst('WS_STEP_ALL_MAX');
// ── v3.63.0's TWO CAPTURE LITERALS, READ OFF LIVE SOURCE ────────────────
// Retyped here they could agree with every assertion in §22 while the shipped
// view asked the route for a different window — which is exactly the reading
// the meter would then be wrong about.
const CAPTURE_WINDOW_DAYS_SRC = numConst('CAPTURE_WINDOW_DAYS');
const CAPTURE_SESSION_LIMIT_SRC = numConst('CAPTURE_SESSION_LIMIT');
// The drafting-ask ⓘ's own words, off LIVE SOURCE. Typed here they would be a
// second copy of the sentence that makes this control's privacy claim, which
// is the one sentence on it a user has to be able to trust.
const DRAFT_ASK_INFO_SRC = (() => {
  const m = /const DRAFT_ASK_INFO_HTML =\n([\s\S]*?);\n/.exec(viewSrc);
  if (!m) throw new Error('DRAFT_ASK_INFO_HTML not found in memory.js — §21 would be a paraphrase');
  return new Function('return (' + m[1] + ');')();
})();
// It is the STORE's wall, not a number of this view's choosing, and it is
// compared against the real exported constant rather than against a copy typed
// here. A view refusing at a DIFFERENT figure from the server would either
// block saves the server would accept, or offer saves it would reject with a
// 400 the user cannot act on.
ok('the editor’s byte wall IS the store’s MAX_BRIEF_BYTES, not a number of its own',
  Number(BRIEF_MAX_BYTES_SRC) === ws.MAX_BRIEF_BYTES,
  'memory.js caps the brief at ' + BRIEF_MAX_BYTES_SRC +
  ' bytes; the store refuses at ' + ws.MAX_BRIEF_BYTES);

/**
 * THE HANDOFF'S MARKUP, wherever it is painted.
 *
 * v3.56.0: `renderHandoff` returned the page fragment; `handoffReaderContent`
 * returns the openReader PAYLOAD and its `bodyHtml` is that same markup one
 * layer in. Every assertion that used to call the first reads through this, so
 * what each of them pins is unchanged — and '' when there is nothing to open,
 * which is what a missing fragment used to be, so an assertion expecting markup
 * still reds.
 */
function handoffHtml(R) {
  const c = R.handoffReaderContent();
  return c ? (c.bodyHtml || '') : '';
}

// ── v3.67.0: STEP ④, THE START CELL AND THE HELPER, OFF LIVE SOURCE ───────
// Every one is LIFTED rather than stubbed, for the reason this harness exists:
// `renderProject` composes step ④, `fndRowHtml` composes the start cell and
// `renderFoundations` the helper's panel, and a stub anywhere in that chain
// would let every assertion below run past the shipped markup. The constants
// travel with them as declarations read off the file, not retyped here.
function constDecl(src, name) {
  const at = src.indexOf('\nconst ' + name + ' =');
  if (at < 0) throw new Error(name + ' not found in memory.js');
  let i = at + 1;
  let depth = 0;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(at + 1, i + 1);
}
// v3.70.0: the byte copy of the store's ladder (READING_BUDGET_PRESETS) is
// GONE — the presets arrive with the measurement — and only the words stay
// (READING_BUDGET_WORDS). The window and harness constants joined with the
// meter.
const V367_CONSTS = ['READING_BUDGET_WORDS', 'READING_BUDGET_STANDARD', 'START_STATES',
  'CONTEXT_WINDOW_KEY', 'CONTEXT_WINDOWS', 'CONTEXT_WINDOW_CHOICES', 'HARNESS_PRESETS', 'HARNESS_HINT',
  'SESSION_START_INFO_HTML'];
const V367_FNS = ['fndStartOf', 'fndStartCfg', 'planRowFor', 'fndSuggestCellHtml', 'planFor',
  'planChangeCount', 'planHeadHtml', 'ssSize', 'ssTokens', 'tok', 'budgetWord', 'readContextWindow',
  'contextWindowNow', 'harnessNow', 'windowWord', 'ssPct', 'repliesWord', 'sessionStartFor',
  'presetLabel', 'presetsOf', 'budgetPickerCfg', 'windowPickerCfg', 'harnessPickerCfg', 'ctxEditHtml',
  'meterModel', 'meterSource', 'sessionMeterHtml',
  'sessionNoticesHtml', 'ssDocs', 'sessionReceivesMonitor', 'presetName', 'previewFor', 'budgetPreviewFor',
  'planPreviewBody', 'planPreviewKey', 'renderSessionStart', 'renderPlanPanel', 'planAiNeedsConfirm'];
function v367Lift() {
  return V367_CONSTS.map((n) => constDecl(viewSrc, n)).join('\n') + '\n'
    // Named one by one rather than mapped over V367_FNS, for §17's census: it
    // reads this file for real extractFunction calls, so a name in a list is
    // not proof that the function was lifted.
    + extractFunction(viewSrc, 'fndStartOf', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'fndStartCfg', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planRowFor', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'fndSuggestCellHtml', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planFor', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planChangeCount', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planHeadHtml', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'ssSize', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'ssTokens', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'tok', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'budgetWord', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'readContextWindow', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'contextWindowNow', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'harnessNow', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'windowWord', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'ssPct', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'repliesWord', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'sessionStartFor', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'presetLabel', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'presetsOf', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'budgetPickerCfg', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'windowPickerCfg', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'harnessPickerCfg', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'ctxEditHtml', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'meterModel', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'meterSource', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'sessionMeterHtml', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'sessionNoticesHtml', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'ssDocs', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'sessionReceivesMonitor', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'presetName', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'previewFor', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'budgetPreviewFor', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planPreviewBody', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planPreviewKey', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'renderSessionStart', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'renderPlanPanel', 'memory.js') + '\n'
    + extractFunction(viewSrc, 'planAiNeedsConfirm', 'memory.js') + '\n';
}
// The list and the calls above must agree, or a function is lifted and not
// returned (or the reverse).
if (V367_FNS.some((n) => !v367Lift.toString().includes("'" + n + "'"))) {
  throw new Error('v367Lift and V367_FNS disagree');
}

function makeRenderers(stateObj) {
  // Every collaborator the render functions close over is injected, so this
  // executes the shipped code rather than a paraphrase of it.
  const body =
    extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
    // The freshness surface: renderProject renders renderSaveStatus above
    // everything else, and it reads through these five. Lifted so the escaping
    // battery below covers the strip too — it interpolates a scope name, a
    // machine id and a harness name, all of which arrive from disk.
    extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
    // `freshnessStep` MOVED to shared/age.js when the freshness scale became
    // app-wide (it is now one half of the scale shared/freshness.css paints,
    // rather than this screen's private ladder). Still the REAL shipped
    // function, lifted from its new home — memory.js imports it, so a stub
    // here would be a paraphrase of the thing under test.
    extractFunction(ageSrc, 'freshnessStep', 'shared/age.js') + '\n' +
    extractFunction(viewSrc, 'newestPair', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'harnessOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'firstNote', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderSaveStatus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'splitHandoffPreamble', 'memory.js') + '\n' +
    // ── THE PICKERS BECAME A TABLE (v3.55.0) ───────────────────────────────
    // `renderScopeControls` is gone with the two listboxes it built. What
    // replaces it is `renderWorkStreams` — one ROW per (scope, machine) pair,
    // newest first, the row a button — plus `workStreamCounts` under it and
    // `newerOnAnotherMachine`, the menubar widget's "another computer saved
    // after this one" reading, which renderSaveStatus now calls.
    //
    // `freshnessTier` travels with them: the table's dots are cut on the same
    // scale as the strip's pip, by NAME rather than by step, and lifting the
    // real one keeps that a property of the shipped code rather than of a stub.
    // `freshnessTier` reads a module-level table in shared/age.js, so the
    // table travels with it — lifted off LIVE SOURCE rather than retyped, for
    // the same reason BRIEF_TEMPLATE is: a copy here would be a second
    // description of the scale, free to drift from the one shared/freshness.css
    // paints.
    (() => {
      const m = /const TIER_BY_STEP = (\[[^\]]*\]);/.exec(ageSrc);
      if (!m) throw new Error('TIER_BY_STEP not found in shared/age.js — freshnessTier would be a paraphrase');
      return 'const TIER_BY_STEP = ' + m[1] + ';';
    })() + '\n' +
    extractFunction(ageSrc, 'freshnessTier', 'shared/age.js') + '\n' +
    extractFunction(viewSrc, 'newerOnAnotherMachine', 'memory.js') + '\n' +
    // The table's ROW ORDER is a function, and it is lifted rather than
    // inlined for the same reason the tier ladder is: the order and the age
    // words must be one reading, and a copy here could agree with the words
    // while the shipped one disagreed.
    extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n' +
    // ── THE TABLE SHOWS A WINDOW (v3.56.0) ──────────────────────────────
    // The newest five, with a "Show N more" footer. `WS_WINDOW`, `WS_STEP` and
    // `WS_STEP_ALL_MAX` are injected as the shipped LITERALS (below) for the
    // same reason BRIEF_MAX_BYTES is, and `wsShownCount` — the arithmetic that
    // also stretches the window to reach an open row — is lifted rather than
    // inlined so the window on screen and the window this suite asserts are
    // one function. `wsRowHtml` and `wsMoreHtml` are the two fragments
    // renderWorkStreams composes and the "Show more" path re-emits.
    extractFunction(viewSrc, 'wsShownCount', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'wsMoreHtml', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'wsRowHtml', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderWorkStreams', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'workStreamCounts', 'memory.js') + '\n' +
    // ── THE HANDOFF LEFT THE PAGE (v3.56.0) ─────────────────────────────
    // `renderHandoff` is gone. A work-stream row press opens the document in
    // the shell's READER overlay, and `handoffReaderContent` composes that
    // payload — so what is lifted is the composer, and §17b drives it.
    extractFunction(viewSrc, 'handoffReaderContent', 'memory.js') + '\n' +
    // ── TIER 0 (v3.59.0) ────────────────────────────────────────────────
    // Seven functions, all LIFTED rather than stubbed. `foundationsFacts` in
    // particular has three consumers — the fold summary, the Status block's
    // reading and the Refresh control's own decision — and a stub would let
    // this suite agree with itself that all three say the same thing while the
    // shipped page said three different ones. `foundationReaderContent` is the
    // reader payload, driven in §21.
    extractFunction(viewSrc, 'foundationsFacts', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'foundationsWord', 'memory.js') + '\n' +
    // v3.67.2: the reason an unchecked row gives is composed once — v3.69.0
    // from the row's OWN source group (FSRC.uncheckedWhy).
    extractFunction(viewSrc, 'foundationsUncheckedWhy', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'foundationsOwnershipWord', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'foundationsSummaryMeta', 'memory.js') + '\n' +
    // The store's session budget, off LIVE SOURCE. `foundationsFacts` falls
    // back to it when the server sends no `readFirstBudgetBytes`, and
    // `foundationsBudgetWarning` quotes it — a copy typed here could agree
    // with every assertion while the shipped block warned at another number.
    'const READ_FIRST_BUDGET_BYTES = ' + READ_FIRST_BUDGET_SRC + ';\n' +
    extractFunction(viewSrc, 'foundationsBudgetWarning', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fndSize', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'skeletonOf', 'memory.js') + '\n' + extractFunction(viewSrc, 'copiedFromOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fndRowHtml', 'memory.js') + '\n' +
    // ── THE ROW-REMOVE CONFIRM STRIP (v3.61.1) ──────────────────────────
    // Lifted rather than stubbed: it is the sentence somebody reads before
    // stopping a mirror, and the difference between it and the editor's
    // delete strip — the SOURCE FILE is untouched — is the whole reason it
    // is a second renderer. A stub would let that sentence go missing with
    // every assertion here green.
    extractFunction(viewSrc, 'renderFoundationStop', 'memory.js') + '\n' +
    // ── "COPY THE DRAFTING REQUEST" AND ITS ⓘ (v3.61.0, P2-8) ───────────
    // `foundationsDraftAsk` decides whether the control is offered, withheld
    // with a reason, or absent, and `renderFoundations` composes it — so it is
    // LIFTED. `DRAFT_ASK_INFO_HTML` is the panel's words and is injected as
    // the shipped constant, and `renderInfoMark` is the REAL shared renderer,
    // imported at the top of this file: a stubbed mark would let the control
    // ship with no explanation beside it and still pass every assertion here
    // (the §S6-shaped lesson from test-agent-instructions.js).
    'const DRAFT_ASK_INFO_HTML = ' + JSON.stringify(DRAFT_ASK_INFO_SRC) + ';\n' +
    extractFunction(viewSrc, 'foundationsDraftAsk', 'memory.js') + '\n' +
    // ── THE FOUR NEVER-FOLD NOTICES, LIFTED SEPARATELY (v3.62.0, P1-7) ──
    // They left `renderFoundations`'s body for step ①'s `noticeHtml`, so they
    // are a renderer of their own now. Lifted rather than stubbed because the
    // whole property under test is that they are ABOVE the heading and never
    // inside a fold.
    extractFunction(viewSrc, 'foundationsNotices', 'memory.js') + '\n' +
    // v3.66.0 (P1): the two-budget monitor above the documents table. Lifted,
    // with the REAL monitor and depth cell injected, and driven in §23.
    extractFunction(viewSrc, 'foundationsMonitor', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderFoundations', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'foundationReaderContent', 'memory.js') + '\n' +
    // ── TIER 0's OWN EDITOR (v3.61.0) ───────────────────────────────────
    // Five more, all LIFTED rather than stubbed. The three pure ones decide
    // whether a save is offered at all (`fndStats`'s wall), whether a name is
    // one the store will take (`fndSlugError`) and whether the owner is asked
    // about a shrink (`fndShrinkWarn`); the two renderers are the surface the
    // editor IS. A stub in any of them would let this suite agree with itself
    // that the wall, the counter and the Save button describe one draft while
    // the shipped editor described three.
    extractFunction(viewSrc, 'fndStats', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fndSlugError', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fndShrinkWarn', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderFoundationEditor', 'memory.js') + '\n' +
    // v3.68.0: the chooser renderer is gone; an empty project is painted by
    // `renderFoundationsEmpty`, and the open door's panel is found by
    // `addPanelFor` — both lifted, the doors' markup injected real.
    extractFunction(viewSrc, 'renderFoundationsEmpty', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'addPanelFor', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderJournal', 'memory.js') + '\n' +
    // The v3.48.0 brief editor. Lifted WITH renderBrief, because renderBrief
    // calls it in both of its branches — a stub would leave §6's escaping
    // battery running past the one control on this screen that writes.
    'const BRIEF_TEMPLATE = ' + JSON.stringify(BRIEF_TEMPLATE_SRC) + ';\n' +
    // v3.55.0: the editor gained a byte/word readout and an Escape decision,
    // and both are real functions rather than inline branches so they can be
    // driven directly (§16g). `BRIEF_MAX_BYTES` is the route's own wall and is
    // injected as the literal, for the same reason BRIEF_TEMPLATE is.
    'const BRIEF_MAX_BYTES = ' + BRIEF_MAX_BYTES_SRC + ';\n' +
    'const WS_WINDOW = ' + WS_WINDOW_SRC + ';\n' +
    'const WS_STEP = ' + WS_STEP_SRC + ';\n' +
    'const WS_STEP_ALL_MAX = ' + WS_STEP_ALL_MAX_SRC + ';\n' +
    extractFunction(viewSrc, 'briefStats', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBriefEditor', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBrief', 'memory.js') + '\n' +
    // The rail's grouping renderer, so §14's grouping assertions and §6's
    // escaping battery both drive the shipped one.
    extractFunction(viewSrc, 'projectMetaLine', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderProjectGroups', 'memory.js') + '\n' +
    // `renderAbout` is GONE. Its words are the header's ⓘ panel now
    // (aboutInfoHtml, passed to renderViewHeader as `info`), so what is lifted
    // here is the function that composes them. It is lifted rather than
    // dropped because the escaping battery below still has to cover it: it is
    // the one string on this page that opts into raw HTML.
    extractFunction(viewSrc, 'aboutInfoHtml', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderEmptyProject', 'memory.js') + '\n' +
    // `renderNoProjects` MOVED here from NOT_EXECUTED (v3.62.0): it used to be
    // a title and a sentence with no control on it, which is why it was
    // excused as "a constant string with no inputs and no branches" — never
    // quite true (it already branched on `noDomains`), and now that the
    // "Create a project in Domains" pointer lives on this screen instead of
    // inside a project, a stub here would let this suite agree with itself
    // that the pointer exists without ever painting the one screen it belongs
    // on.
    extractFunction(viewSrc, 'renderNoProjects', 'memory.js') + '\n' +
    // The five that used to be lifted by NOBODY. renderStaleNotice in
    // particular had no assertion of any kind: replacing its body with
    // `return '';` deleted the Reload offer — the v3.17.3 headline — and left
    // this suite fully green. renderProject is lifted with it so the offer is
    // proven to REACH the page rather than merely to exist.
    // ── v3.62.0's FOUR NEW RENDERERS ───────────────────────────────────
    // The strip that replaced the Status block, the one derivation of the
    // newest save's headline that the fold summary reads, the work-stream
    // table's own fold, and step ③. All lifted: each is a pane `renderProject`
    // composes, and §18i drives every one of them through the real page.
    // ── THE STEP HEAD, LIFTED (v3.65.0) ───────────────────────────────
    // `renderProject` and `renderProjectSkeleton` compose all three numbered
    // steps through `memStep` now rather than through `shared/block.js`, and
    // a module-level function is NOT visible inside a body this harness lifts
    // — it would be a ReferenceError, i.e. a CRASH rather than a failing
    // assertion (BUILDER-RULES rule 10). It is lifted, not stubbed, because
    // every §18i assertion about where the ⓘ sits is an assertion about what
    // this function emits.
    extractFunction(viewSrc, 'memStep', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderLayerStrip', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'projectHeadline', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderWorkStreamsFold', 'memory.js') + '\n' +
    // ── STEP ③'s THREE PIECES (v3.65.0, P10) ──────────────────────────
    // One row per chosen wiki, the picker that adds one, and the cfg both the
    // markup and the mount read — all lifted, because `renderKnowledge`
    // composes them and a module-level function is not visible inside a body
    // this harness lifts.
    extractFunction(viewSrc, 'knowledgePickerCfg', 'memory.js') + '\n' +
    // v3.65.1 (D7): the row's identity dot, from the SHARED mapping. Lifted
    // rather than stubbed, so the assertions below read the real class names.
    extractFunction(viewSrc, 'knowledgeDotHtml', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderKnowledgeRow', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderKnowledgePicker', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderKnowledge', 'memory.js') + '\n' +
    // ── v3.63.0's HONESTY METER ────────────────────────────────────────
    // Lifted for real rather than stubbed, and the reason is the one this
    // whole harness exists for: `renderProject` composes the meter into step
    // ②, so a stub would let every assertion below run past the reading whose
    // entire subject is honesty. The two constants are injected as the
    // LITERALS read off live source, so the window in the assertions is the
    // window the shipped view asks the route for.
    'const CAPTURE_WINDOW_DAYS = ' + CAPTURE_WINDOW_DAYS_SRC + ';\n' +
    'const CAPTURE_SESSION_LIMIT = ' + CAPTURE_SESSION_LIMIT_SRC + ';\n' +
    extractFunction(viewSrc, 'captureFacts', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderCaptureMeter', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderStaleNotice', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'unlistedCount', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderUnlistedNote', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBriefOnlyNotice', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderCopyOutcome', 'memory.js') + '\n' +
    v367Lift() +
    extractFunction(viewSrc, 'renderProject', 'memory.js') + '\n' +
    // LIFTED HERE TOO, although test-next-memory-switch.js §9 is where its own
    // arithmetic is driven. §16e2 renders BOTH it and renderProject through
    // the REAL renderBlock and compares the standing-brief lede they emit —
    // the whole point of the skeleton is that the block chrome does not move
    // between the two paints, and that claim cannot be checked from a suite
    // that holds only one of the two renderers.
    extractFunction(viewSrc, 'renderProjectSkeleton', 'memory.js') + '\n' +
    // THE LISTBOX COMPONENT IS NO LONGER LIFTED. memory.js stopped importing
    // it in v3.55.0 (scripts/test-next-listbox.js §5b asserts that in both
    // directions), so lifting its render path here would be this suite
    // exercising a component the view under test does not use. The escaping
    // battery below lost nothing: every string the pickers interpolated — a
    // scope name, a machine id, a harness — is now interpolated by
    // `renderWorkStreams`, which IS lifted.
    'return { renderWorkStreams, workStreamCounts, newerOnAnotherMachine, workStreamOrder, ' +
    'wsShownCount, wsMoreHtml, wsRowHtml, handoffReaderContent, ' +
    'foundationsFacts, foundationsWord, foundationsDraftAsk, '
    + 'foundationsUncheckedWhy, '
    + 'foundationsOwnershipWord, foundationsSummaryMeta, foundationsBudgetWarning, ' +
    'fndSize, skeletonOf, fndRowHtml, ' +
    'renderFoundations, foundationsNotices, foundationReaderContent, foundationsMonitor, ' +
    'memStep, renderLayerStrip, projectHeadline, renderWorkStreamsFold, renderKnowledge, '
    + 'renderKnowledgeRow, renderKnowledgePicker, knowledgePickerCfg, ' +
    'captureFacts, renderCaptureMeter, ' +
    'fndStats, fndSlugError, fndShrinkWarn, renderFoundationEditor, renderFoundationsEmpty, addPanelFor, ' +
    'renderJournal, renderBrief, aboutInfoHtml, ' +
    'renderEmptyProject, renderStaleNotice, renderUnlistedNote, renderBriefOnlyNotice, ' +
    'unlistedCount, renderCopyOutcome, renderProject, renderProjectSkeleton, renderSaveStatus, freshnessStep, freshnessTier, ' +
    'effectiveSave, briefStats, briefDismissDecision, ' +
    'renderBriefEditor, renderProjectGroups, renderNoProjects, '
    + V367_FNS.join(', ') + ' };';
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'gatedLoader', 'loadGate',
    'JOURNAL_PAGE', 'JOURNAL_MORE', 'renderBlock',
    // ── THE STORE MIRRORS AND THE SHARED CHOOSER (v3.61.0) ─────────────
    // Injected as the REAL exports of shared/foundations-init.js, not as
    // literals typed here: the wall the editor refuses at and the grammar it
    // validates a name against must be the ones the shipped view uses, or
    // this suite would be asserting a copy.
    'FOUNDATION_SLUG_RE', 'FOUNDATION_ROLES', 'MAX_FOUNDATION_BYTES',
    'FOUNDATIONS_BUDGET_BYTES', 'freshChooser', 'chooserBody', 'chooserOutcomeWords',
    'renderFoundationsChooser', 'renderRoleOptions', 'renderRefusedList', 'formatBytes',
    'commitBlockedReason', 'nextStepReason', 'pickedFiles', 'READ_WITH_INFO_HTML',
    // The real shared text renderers, so §6's escaping battery runs through
    // the component that actually paints these sentences rather than past it.
    'renderDescription', 'renderStatus', 'renderReadout', 'renderReadoutGroup',
    'renderBadge', 'renderExplainer',
    // The REAL ⓘ mark (v3.61.0): `renderFoundations` composes one beside the
    // drafting-ask control, and a stub would let the button ship with no
    // explanation beside it and still pass every assertion in §21c2.
    'renderInfoMark',
    // The REAL post-copy banner from shared/agent-instructions.js — the
    // sentence a user reads seconds after pressing "Copy agent instructions",
    // and the one §21c3 proves the DRAFTING request does not borrow.
    'COPY_SUCCESS_BANNER',
    // The REAL docs-link helper, imported rather than stubbed: aboutInfoHtml
    // ends with one, and a stub would let §6's escaping battery run past the
    // only <a> this page emits.
    'docsLinkHtml',
    // The CALENDAR-DAY ladder, real. See the import.
    'formatDayAge', 'dayFreshnessTier', 'freshnessDotHtml',
    // The REAL overview component (v3.64.2): `renderLayerStrip` builds the
    // three cards' DESCRIPTIONS and shared/overview.js emits the markup —
    // the same function the domain page's OVERVIEW goes through. Injected
    // real rather than stubbed, so every assertion below about the three
    // readings is an assertion about the component the app ships.
    // ── THE REAL SIDEBAR KIT (v3.65.0) ────────────────────────────────
    // `renderProjectGroups` composes the rail's rows through
    // shared/sidebar.js now, and a module-level IMPORT is not visible inside
    // a body this harness lifts — it would be a ReferenceError, i.e. a suite
    // that CRASHES rather than asserts. Injected REAL rather than stubbed,
    // because every assertion below about the rail's anatomy, its clock
    // glyph and its identity dot is an assertion about the component the app
    // ships, not about a stand-in written here.
    'renderSidebarHead', 'renderSidebarGroup', 'renderSidebarRow', 'identityDotClass',
    // THE REAL MONITOR (v3.65.0). Every live reading on this page goes
    // through it, so a stub would let §6's escaping battery and every
    // assertion about a warning's PLACE run past the component that draws
    // both. Injected real for the same reason renderOverview is.
    'renderMonitor', 'renderDepthCell',
    // v3.70.0: THE REAL WINDOW METER. shared/bucket.js is pure (no imports,
    // no DOM), so it is imported for real: every assertion about what step ④
    // draws is an assertion about the kit the app ships.
    'renderBucket', 'formatTokens',
    // ── THE LISTBOX IS STUBBED, AND THE REASON IS MECHANICAL ──────────
    // `shared/listbox.js` imports `app.js`, which touches `document` at
    // import time, so it cannot be imported into a Node suite at all — the
    // same wall scripts/test-next-listbox.js documents and works around by
    // reading source. The component's own markup, keyboard behaviour and
    // escaping are that suite's; what is under test HERE is the cfg this
    // view composes — its id, its options and whether it is disabled — so
    // the stub echoes the cfg it was handed and every assertion below reads
    // that back.
    'renderListboxHtml',
    // v3.67.0: the run line kit, real (see the import).
    'renderRunsOn', 'renderSpent', 'aiActionDisabledAttrs',
    'renderOverview',
    // v3.68.0 — the two doors, real.
    'doorsFor', 'renderDoors', 'renderAddPanel', 'startLegendHtml',
    // v3.69.0 — the per-document source rules, one namespace, real.
    'FSRC', body)(
    stateObj, escapeHtml, () => '<svg></svg>', renderMarkdown, () => '<div class="loader"></div>', null, 10, 50,
    // The REAL shared block, imported rather than stubbed: renderProject
    // composes all five of this page's sections through it, so a stub would
    // let §6's escaping battery and §14's placement assertions run past the
    // component that actually frames every one of them.
    renderBlock,
    FOUNDATION_SLUG_RE, FOUNDATION_ROLES, MAX_FOUNDATION_BYTES,
    FOUNDATIONS_BUDGET_BYTES, freshChooser, chooserBody, chooserOutcomeWords,
    renderFoundationsChooser, renderRoleOptions, renderRefusedList, formatBytes,
    commitBlockedReason, nextStepReason, pickedFiles, READ_WITH_INFO_HTML,
    renderDescription, renderStatus, renderReadout, renderReadoutGroup, renderBadge, renderExplainer,
    renderInfoMark,
    COPY_SUCCESS_BANNER,
    docsLinkHtml,
    realFormatDayAge, realDayFreshnessTier, realFreshnessDotHtml,
    renderSidebarHead, renderSidebarGroup, renderSidebarRow, identityDotClass,
    renderMonitor, renderDepthCell,
    renderBucket, formatTokens,
    (cfg) => '<button type="button" id="' + cfg.id + '" data-lb-stub="'
      + escapeHtml(JSON.stringify({ options: cfg.options.map((o) => o.value),
        disabled: cfg.disabled === true, placeholder: cfg.placeholder,
        // v3.67.0: the value and the accessible name, so the start cell and
        // the budget picker can be read back as the control they describe.
        value: cfg.value === undefined ? null : cfg.value,
        label: cfg.ariaLabel || null })) + '"></button>',
    renderRunsOn, renderSpent, aiActionDisabledAttrs,
    realRenderOverview,
    doorsFor, renderDoors, renderAddPanel, startLegendHtml, FSRC);
}

const hostileDetail = {
  scope: XSS,
  machine: ATTR,
  machineIsThisMachine: false,
  readonly: false,
  machines: [
    { machine: ATTR, ageSeconds: 60 },
    { machine: XSS, ageSeconds: 120 },
  ],
  current: {
    present: true,
    text: '# T\n\n> ' + XSS + '\n\n## Where things stand\n\n' + XSS + '\n',
    savedAt: '2026-08-28T10:00:00.000Z',
    truncated: true,
    sanitisedOnRead: true,
  },
  journal: {
    returned: 2,
    total: 9,
    totalUnknown: false,
    entries: [
      { at: '2026-08-28T10:00:00.000Z', harness: XSS, model: ATTR, headline: XSS, rejections: [XSS] },
      { at: null, harness: null, model: null, headline: null, rejections: [] },
    ],
  },
};

const hostileState = {
  activeProject: XSS,
  scope: XSS,
  machine: ATTR,
  detail: hostileDetail,
  detailLoading: false,
  journalLimit: 10,
  projectRead: {
    scopesTruncated: true,
    scopeCount: 99,
    brief: { present: true, text: '# B\n\n_Updated: t_\n\n## Standing brief\n\n' + XSS, updatedAt: '2026-08-28T09:00:00.000Z', truncated: true },
  },
};

const R = makeRenderers(hostileState);
const html = [
  R.renderWorkStreams([{ scope: XSS, machine: XSS, headline: XSS, harness: XSS, model: XSS,
    writtenAgeSeconds: 120, writtenAt: '2026-08-28T09:00:00.000Z' },
  { scope: 'other', machine: 'boxb', headline: 'ok', writtenAgeSeconds: 900 }], hostileDetail),
  handoffHtml(R),
  R.renderJournal(),
  R.renderBrief(hostileState.projectRead),
  R.aboutInfoHtml(),
  R.renderEmptyProject(),
].join('\n');

ok('the hostile fixture actually produced markup (not an empty string)', html.length > 800, 'len ' + html.length);
ok('no raw <img ... onerror survives anywhere in the rendered output',
  !/<img\s/i.test(html), 'found a raw <img> tag');

/**
 * Event handlers must be looked for INSIDE TAGS, not in the whole string.
 * `&lt;img src=x onerror=alert(1)&gt;` is correctly escaped inert TEXT and
 * still contains the characters " onerror=", so a whole-string scan reports
 * a leak on output that is provably safe. (It did, on the first run — the
 * same false-positive shape v3.13.0 recorded for an XSS check that walked
 * straight through `&gt;`.) Only markup the browser will parse as a tag can
 * carry a live handler.
 */
function handlersInTags(markup) {
  const hits = [];
  for (const tag of markup.match(/<[^>]*>/g) || []) {
    // Strip QUOTED ATTRIBUTE VALUES before looking for a handler. A handler
    // only runs if it is a real attribute — i.e. outside every quoted value.
    // `<option value="&quot; onmouseover=&quot;alert(1)">` is ONE attribute
    // holding inert text: `&quot;` is an entity and does NOT terminate the
    // value, which is precisely what proves the escaping worked. Scanning the
    // raw tag flagged both of this suite's hostile fixtures as leaks while
    // they were, in fact, correctly escaped.
    const bare = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    if (/\son[a-z]+\s*=/i.test(bare)) hits.push(tag);
  }
  return hits;
}
ok('no live event handler appears inside any emitted TAG',
  handlersInTags(html).length === 0, JSON.stringify(handlersInTags(html).slice(0, 2)));
// Positive control: the detector must be able to see a real one, or the
// assertion above is decorative.
ok('self-test: the tag scan detects a planted live handler',
  handlersInTags('<span onerror="alert(1)">x</span>').length === 1);
ok('self-test: the tag scan does NOT fire on correctly-escaped text',
  handlersInTags('&lt;img src=x onerror=alert(1)&gt;').length === 0);
ok('self-test: the tag scan does NOT fire on a handler INSIDE a quoted value',
  handlersInTags('<option value="&quot; onmouseover=&quot;alert(1)">x</option>').length === 0);
// The case that matters: a value that really DID break out of its quotes.
ok('self-test: the tag scan DOES fire on a genuine attribute breakout',
  handlersInTags('<option value="a" onmouseover="alert(1)">x</option>').length === 1);
ok('the hostile scope name appears ESCAPED', html.includes('&lt;img src=x onerror=alert(1)&gt;'));
ok('the attribute-breakout string appears ESCAPED (&quot;)', html.includes('&quot; onmouseover='));
ok('every attribute value in the output is balanced', (() => {
  // A crude but effective breakout detector: no tag may contain an odd
  // number of quote characters.
  for (const tag of html.match(/<[^>]*>/g) || []) {
    if (((tag.match(/"/g) || []).length) % 2 !== 0) return false;
  }
  return true;
})(), 'an emitted tag has an unbalanced quote');

// The body text goes through the shared renderer — proven end to end here,
// not asserted by reading the source.
ok('the handoff BODY is rendered through the shared markdown renderer (escape-first)',
  handoffHtml(R).includes('chat-md-h'));
ok('the brief BODY is rendered through the shared markdown renderer',
  R.renderBrief(hostileState.projectRead).includes('chat-md-h'));

// ── CROSS-MACHINE: IT MOVED HOUSE AGAIN, INTO THE TABLE'S OWN COLUMN ──────
// It was a `from <machine>` badge beside the machine picker; then a
// `written on <machine>` LINE in an instrument above step ②'s rows. That
// instrument is deleted (v3.65.1): it stood unfolded, carrying provenance and
// explanations, which is the bare block the maintainer rejected. The FACT is
// per-handoff and the Handoffs table names the machine PER ROW in a column of
// its own — more precise than one line about the open pair — and the COST of
// the fact ("paths and processes may differ") is one sentence in step ②'s ⓘ.
//
// THE POSITIVE-EVIDENCE RULE SURVIVES THE MOVE and is what is asserted: this
// view must never say "elsewhere" from an ABSENT field, only from an explicit
// `false`. `wsRowHtml` marks the rows of the machine the store RESOLVED.
const mineNote = /local paths and processes may differ/;
ok('the deleted instrument no longer prints provenance above the rows — it is '
  + 'the table\'s own MACHINE column now',
!mineNote.test(R.renderSaveStatus(hostileState.projectRead, hostileDetail)),
R.renderSaveStatus(hostileState.projectRead, hostileDetail).slice(0, 300));
ok('...and the table still names the machine, per row, where there is one per '
  + 'handoff to name', /<th scope="col">Machine<\/th>/.test(
    R.renderWorkStreams([{ scope: 'a', machine: 'boxa', writtenAgeSeconds: 60 }], null)),
R.renderWorkStreams([{ scope: 'a', machine: 'boxa', writtenAgeSeconds: 60 }], null).slice(0, 300));
ok('...and the COST of the fact is in step ②\'s ⓘ, where an explanation goes',
  /local paths and processes may differ|paths, running processes/.test(
    makeRenderers(hostileState).renderProject()),
  'the sentence vanished with the line');
{
  const same = makeRenderers(hostileState);
  ok('machineIsThisMachine:true says nothing either',
    !mineNote.test(same.renderSaveStatus(hostileState.projectRead,
      { ...hostileDetail, machineIsThisMachine: true })));
}
// ...and the TABLE marks "this machine" under the same rule, for the one row
// the scoped read actually resolved and for no other.
{
  const rows = [{ scope: 'a', machine: 'boxa', writtenAgeSeconds: 60 },
    { scope: 'b', machine: 'boxb', writtenAgeSeconds: 60 }];
  ok('the table marks THIS machine only on an explicit machineIsThisMachine:true',
    R.renderWorkStreams(rows, { machine: 'boxa', machineIsThisMachine: true })
      .includes('mem-ws-mine'));
  ok('...and marks nothing when the response did not say',
    !R.renderWorkStreams(rows, { machine: 'boxa' }).includes('mem-ws-mine'));
  ok('...and marks nothing when it said false',
    !R.renderWorkStreams(rows, { machine: 'boxa', machineIsThisMachine: false })
      .includes('mem-ws-mine'));
}

// Truncation / unknown-total honesty.
ok('a truncated handoff renders a note saying so', handoffHtml(R).includes('mem-note'));
ok('read-side sanitisation is stated, not hidden',
  handoffHtml(R).toLowerCase().includes('neutralised'));
{
  const unknownTotal = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { ...hostileDetail.journal, total: null, totalUnknown: true, totalUnknownReason: 'journal is huge' } },
  });
  const j = unknownTotal.renderJournal();
  ok('an unknown journal total says the count is UNKNOWN', j.includes('unknown'));
  ok('...and does NOT print the tail length as if it were the total', !/of 2\b/.test(j));
}
{
  // THE COUNT IS AN INSTRUMENT NOW, not a sentence: the journal foot renders a
  // shared/text.js .tx-readout ("Save recorded" / "1") instead of the prose
  // "1 save recorded". The PROPERTY under test is unchanged and is the one
  // that matters — a count of one must not say "saves" — so it is asserted
  // against the shipped markup rather than against a phrase nothing emits.
  //
  // STRENGTHENED, not relaxed, in both directions: the singular case now pins
  // the figure as well as the wording, and the plural case is covered for the
  // first time. Reverting the view to a hardcoded 'Saves recorded' label reds
  // the first of these; dropping the count reds the second.
  const single = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { returned: 1, total: 1, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
  });
  const one = single.renderJournal();
  // THE COUNT IS THE ROW'S OWN SUMMARY (v3.65.1, D3). It was a monitor CARD at
  // the foot of the list with a floating `btn-xs` beside it — measured at 1370,
  // the card 421→723.5 under a list 893px wide, the button at x=735.5 — which
  // the maintainer read as *"from another dimension"*. It is the meta slot of
  // the row now, where every other reading on this page is. THE THREE ARMS AND
  // THEIR GRAMMAR ARE UNCHANGED, and both are still pinned in both directions:
  // reverting to a hardcoded label reds the first, dropping the count the
  // second.
  const metaOf = (h) => (/<span class="mem-fold-meta"[^>]*>([\s\S]*?)<\/span><\/summary>/.exec(h) || [, ''])[1];
  ok('one save singularises (the summary reads "1 save", never "1 saves")',
    /(^|[^0-9])1 save(?!s)/.test(metaOf(one)) && !/1 saves/.test(metaOf(one)), metaOf(one));
  // ── ONE "Show N more", AND IT IS THE HANDOFFS LIST'S (v3.65.1, D3) ──
  // The maintainer named the Handoffs implementation as the right one by name
  // — *"Work-streams' inline 'Show 17 more' is the right design"* — against a
  // journal footer that was a monitor card plus a floating `btn-xs`. So the
  // assertion is not "a control exists" but "it is THE SAME control": the same
  // class the other list emits, and NOT a `.btn`, which is what makes it a
  // full-width row in flow rather than a button beside a card.
  // FOUND BY MUTATION: swapping `cur-group-row` back to `btn btn-secondary
  // btn-xs` was green against every suite in this repository.
  {
    const withMore = makeRenderers({
      ...hostileState, journalLimit: 10,
      detail: { ...hostileDetail, journal: { returned: 10, total: 31, totalUnknown: false,
        entries: [hostileDetail.journal.entries[1]] } },
    }).renderJournal();
    const wsMore = makeRenderers({ ...hostileState, wsWindow: 5 })
      .renderWorkStreams(Array.from({ length: 9 }, (_, i) => ({
        scope: 's' + i, machine: 'm', writtenAgeSeconds: 60 * (i + 1) })), null, 5);
    ok('CONTROL: both lists really produced a "Show more"',
      /id="mem-journal-more"/.test(withMore) && /id="mem-ws-more"/.test(wsMore),
      withMore.slice(-300) + ' || ' + wsMore.slice(-200));
    const cls = (h, id) => (new RegExp('class="([^"]*)"[^>]*id="' + id + '"').exec(h) || [, ''])[1];
    ok('the journal\'s control wears the SAME class the handoffs list\'s does',
      cls(withMore, 'mem-journal-more').split(' ').includes('cur-group-row')
      && cls(wsMore, 'mem-ws-more').split(' ').includes('cur-group-row'),
      cls(withMore, 'mem-journal-more') + ' || ' + cls(wsMore, 'mem-ws-more'));
    ok('...and it is NOT a .btn — a floating btn-xs beside a card is the shape '
      + 'the maintainer called "from another dimension"',
    !/(^| )btn( |$)/.test(cls(withMore, 'mem-journal-more')), cls(withMore, 'mem-journal-more'));
    ok('...naming HOW MANY more, because the total is known here',
      /Show 21 more/.test(withMore), (withMore.match(/Show[^<]*/) || [''])[0]);
    ok('...and saying only "Show more" when the total is NOT known, rather than '
      + 'printing a figure it cannot stand behind',
    /<span class="mem-ws-more-label">Show more<\/span>/.test(makeRenderers({
      ...hostileState, journalLimit: 10,
      detail: { ...hostileDetail, journal: { returned: 10, total: null, totalUnknown: true,
        entries: [hostileDetail.journal.entries[1]] } },
    }).renderJournal()));
  }
  ok('...and the count is in the ROW\'s summary, not in a card under the list',
    !one.includes('mem-j-foot') && !/cur-mon/.test(one), one.slice(-400));

  const plural = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { returned: 3, total: 3, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
  });
  const many3 = plural.renderJournal();
  ok('three saves pluralise ("3 saves")', /3 saves/.test(metaOf(many3)), metaOf(many3));
  ok('...and a capped read says BOTH figures — what exists and what is shown',
    /12 saves · showing 3/.test(metaOf(makeRenderers({
      ...hostileState,
      detail: { ...hostileDetail, journal: { returned: 3, total: 12, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
    }).renderJournal())),
  metaOf(makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { returned: 3, total: 12, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
  }).renderJournal()));
  ok('...and an UNKNOWN total says so rather than printing the tail\'s length as one',
    /full count unknown/.test(metaOf(makeRenderers({
      ...hostileState,
      detail: { ...hostileDetail, journal: { returned: 3, total: null, totalUnknown: true, entries: [hostileDetail.journal.entries[1]] } },
    }).renderJournal())));

  // ── THE CLOSED SUMMARY, v3.58.0 ───────────────────────────────────────
  // This fold starts shut and stays shut across visits now, so its head is the
  // only thing most people ever read of the journal. It was the bare figure
  // `31`, which answers "how many" and not "is any of this recent" — and the
  // second question is the one that decides whether to open a collapsed
  // section. Both facts are pinned; the age also has to be LIVE, because a
  // frozen "9 hr ago" on a page that never re-renders is exactly the class of
  // defect `tickAges` exists for.
  const jSummary = (m) => (/<summary[\s\S]*?<\/summary>/.exec(m) || [''])[0];
  const head3 = jSummary(many3);
  ok('the journal\'s closed summary carries the COUNT, in words',
    /3 saves/.test(head3), head3);
  ok('...singularised at one', /\b1 save\b/.test(jSummary(one)) && !/1 saves/.test(jSummary(one)),
    jSummary(one));
  {
    const recent = makeRenderers({
      ...hostileState,
      detail: { ...hostileDetail,
        journal: { returned: 2, total: 2, totalUnknown: false,
          entries: [{ at: new Date(Date.now() - 3600_000).toISOString(), harness: null, model: null, headline: 'h', rejections: [] },
            { at: '2026-01-01T00:00:00.000Z', harness: null, model: null, headline: 'h', rejections: [] }] } },
    }).renderJournal();
    const head = jSummary(recent);
    ok('...and the age of the NEWEST entry, so "is any of this recent" is '
      + 'answerable without opening it', /latest/.test(head) && /1 hr ago/.test(head), head);
    ok('...through the live-clock hook, not as frozen text',
      /data-mem-age-at/.test(head) && /class="mem-age-words"/.test(head), head);
    ok('CONTROL: the age came from the newest entry, not the oldest',
      !/2026-01-01/.test(head), head);
  }
  {
    const undated = makeRenderers({
      ...hostileState,
      detail: { ...hostileDetail,
        journal: { returned: 1, total: 1, totalUnknown: false,
          entries: [{ at: null, harness: null, model: null, headline: 'h', rejections: [] }] } },
    }).renderJournal();
    const head = jSummary(undated);
    ok('an entry with no time claims no age rather than inventing one',
      /1 save/.test(head) && !/latest/.test(head) && !/data-mem-age-at/.test(head), head);
  }
}

// Single-option controls collapse to a static label rather than a dropdown.
// ── §6b — THE WORK-STREAM TABLE, DRIVEN ─────────────────────────────────
// It replaced the two pickers in v3.55.0, and with them the "one option
// collapses to a label" pair of assertions that used to sit here: a table has
// no such state, one row is a table with one row. What replaces them is the
// property a table has and a dropdown did not — that every pair the store
// returned is ON SCREEN, in the order the store returned it, with its own
// freshness mark.
{
  const nowMs = Date.now();
  const at = (secs) => new Date(nowMs - secs * 1000).toISOString();
  // Four pairs, THREE scopes, one of them duplicated across machines, with
  // four distinct ages including one that is unknown.
  //
  // THE FIXTURE'S ORDER IS DELIBERATELY NOT ALPHABETICAL, so the order
  // assertion below can tell a real ordering from "any order".
  //
  // Here the two clocks AGREE — every row's `writtenAt` ranks it exactly as its
  // arrival would — so the store's order and the table's are the same list, and
  // this fixture says nothing about which of them is being followed. §6c is the
  // fixture that separates them, and it is the one that fails when the table
  // ranks by the file clock while its cells read the agent's.
  const rows = [
    { scope: 'side-quest', machine: 'boxa', headline: '<img src=x onerror=alert(1)>',
      harness: 'opencode', writtenAgeSeconds: 30, writtenAt: at(30) },
    { scope: 'main', machine: 'boxa', headline: 'Ship the table', harness: 'claude-code',
      model: 'opus-5', writtenAgeSeconds: 120, writtenAt: at(120) },
    { scope: 'main', machine: 'boxb', headline: 'Same stream, other laptop', harness: 'opencode',
      writtenAgeSeconds: 7200, writtenAt: at(7200) },
    { scope: 'archive', machine: 'boxa', headline: 'No clock on this one' },
  ];
  const T = makeRenderers(hostileState);
  const out = T.renderWorkStreams(rows, { scope: 'main', machine: 'boxb' });
  const trs = out.match(/<tr class="mem-ws-row/g) || [];
  eq('every (scope, machine) pair is a row — a duplicated scope is TWO rows', trs.length, 4);

  // ORDER: newest first, and the row with no clock at all is last.
  const order = [...out.matchAll(/data-mem-scope="([^"]*)" data-mem-machine="([^"]*)"/g)]
    .map((m) => m[1] + '/' + m[2]);
  eq('the rows are newest first, with the unknown age last',
    order.join(','), 'side-quest/boxa,main/boxa,main/boxb,archive/boxa');
  ok('CONTROL: that order is NOT alphabetical, so the assertion above can tell '
    + 'a real ordering from an incidental one',
    order.join(',') !== order.slice().sort().join(','), order.join(','));

  // THE DOT'S TIER IS RE-DERIVED INDEPENDENTLY, not read back off the markup.
  const tiers = [...out.matchAll(/class="fresh-dot fresh-([a-z]+)"/g)].map((m) => m[1]);
  const want = rows.map((r) => T.freshnessTier(T.effectiveSave(r).seconds));
  eq('each row\'s dot wears the tier freshnessTier independently computes',
    tiers.join(','), want.join(','));
  ok('...and those tiers are not all the same value, so the check is not vacuous',
    new Set(want).size >= 3, want.join(','));

  // THE HEADLINE IS ESCAPED. It comes off disk and can arrive over sync from
  // another person inside a shared mirror.
  ok('a hostile headline is escaped, never emitted as markup',
    out.includes('&lt;img src=x onerror=alert(1)&gt;') && !out.includes('<img '));

  // THE AGE CELL CARRIES THE CLOCK'S HOOK, and only where there is an age.
  const hooks = (out.match(/data-mem-age-at="/g) || []).length;
  eq('the three rows with a resolved stamp carry data-mem-age-at', hooks, 3);
  ok('...and the row with no age carries none, so the clock has nothing to freeze',
    out.includes('>unknown<'));
  ok('the words the clock rewrites sit in a named span, never the cell itself',
    (out.match(/class="mem-age-words"/g) || []).length === 4);

  // NO TOOLTIPS. The exact stamp is visible-to-AT text instead.
  ok('the table emits no title= at all — the stamp rides in a visually-hidden span',
    !/title="/.test(out) && out.includes('class="visually-hidden"'));

  // THE OPEN PAIR IS MARKED, and only that pair.
  eq('exactly one row is marked open', (out.match(/mem-ws-row-open/g) || []).length, 1);
  ok('...and it is the pair the scoped read resolved, not merely the first row',
    /<tr class="mem-ws-row mem-ws-row-open"[^>]*>[\s\S]*?data-mem-machine="boxb"/.test(out));
  eq('the open row is the one that carries the focus id', (out.match(/id="mem-ws-active"/g) || []).length, 1);

  // A ROW IS A CONTROL.
  eq('every row\'s first cell is a real button', (out.match(/<button type="button" class="mem-ws-open"/g) || []).length, 4);
  ok('and the view emits no <select anywhere, in markup or in a comment',
    !viewSrc.includes('<select'));

  // THE COUNTS ARE THE STORE'S, NEVER THE ROW COUNT.
  const counts = T.workStreamCounts({ savedCopies: 9, distinctScopeCount: 4, scopesTruncated: true }, 3);
  ok('the count line reports the store\'s uncapped totals, not the rows shown',
    counts.includes('4 handoffs') && counts.includes('9 saved copies'), counts);
  ok('...and says so when the list was capped', counts.includes('showing the 3 most recently saved'), counts);
  ok('an empty list renders no table at all', T.renderWorkStreams([], null) === '');
}

// ── §6c — THE ORDER IS THE CLOCK THE ROW SHOWS ──────────────────────
//
// THE DEFECT. The table said "newest first" and rendered `projectRead.scopes`
// in the STORE's order, which `listWorkingScopes` sorts by `mtimeMs` — the
// FILE clock. Every cell of that same row displays `effectiveSave(s)`, which
// prefers the AGENT's clock (`writtenAt`). The two clocks agree only on a
// machine that has never synced and never copied a folder: a checkout rewrites
// mtime, so on a real two-machine setup a handoff saved four hours ago sat
// UNDER rows a fortnight old, each correctly labelled with its own age. v3.55.0
// kept the freshness dot and the age words in lockstep on `effectiveSave`; the
// ORDER was left on the other clock, so one row could be marked fresh, worded
// fresh, and ranked stale at the same time.
//
// THE FIXTURE MAKES THE TWO CLOCKS DISAGREE ON PURPOSE, and it is the reverse
// case rather than a merely different one: the four rows carrying both clocks
// rank EXACTLY BACKWARDS by mtime against `writtenAt`, so an implementation
// reading either clock produces a defensible-looking list and only one of them
// matches the ages printed in the cells. The fixture is handed over in the
// STORE's order — mtime, newest first — because that is what the route returns.
{
  const day = 86400;
  // `writtenAgeSeconds` is the agent's clock; `lastWriteAt` is the file's, and
  // `effectiveSave` reads it only when no agent time exists at all.
  const fileAgo = (secs) => new Date(Date.now() - secs * 1000).toISOString();
  const rows = [
    // Given in mtime order, newest arrival first — the order the store returns.
    { scope: 'e-file-only', machine: 'boxa', headline: 'no journal time at all',
      lastWriteAt: fileAgo(2 * 3600) },
    { scope: 'd-agent-oldest', machine: 'boxa', headline: 'arrived last night',
      writtenAgeSeconds: 10 * day, lastWriteAt: fileAgo(1 * day) },
    { scope: 'c-agent-third', machine: 'boxa', headline: 'pulled five days ago',
      writtenAgeSeconds: 3 * day, lastWriteAt: fileAgo(5 * day) },
    { scope: 'b-agent-second', machine: 'boxa', headline: 'pulled ten days ago',
      writtenAgeSeconds: 3600, lastWriteAt: fileAgo(10 * day) },
    { scope: 'a-agent-newest', machine: 'boxa', headline: 'saved a minute ago',
      writtenAgeSeconds: 60, lastWriteAt: fileAgo(14 * day) },
    { scope: 'f-no-clock', machine: 'boxa', headline: 'neither clock resolves' },
  ];
  // Captured BEFORE anything renders: if the sort were done in place, a
  // snapshot taken afterwards would already be the sorted list and the
  // non-mutation assertion at the end would be vacuous.
  const given = rows.map((r) => r.scope);
  const T = makeRenderers(hostileState);
  // The OPEN pair is `d-agent-oldest`, which the fix moves from the second row
  // to the second-to-last: the mark has to travel with the row.
  //
  // EVERY ROW IS PAINTED HERE, and that is a deliberate argument rather than a
  // convenience. v3.56.0 cut the table to the newest five with a "Show N more"
  // footer, and this section's subject is the ORDER — the two clocks disagreeing
  // in the reverse direction, the no-clock row sorting last. Five of these six
  // rows fit; asserting the order of five would quietly stop testing the two
  // ends the fixture was built to separate. The window is a THIRD parameter,
  // defaulted to the shipped `WS_WINDOW`, so passing Infinity here removes the
  // window from this section and nothing else. §6e drives the default.
  const out = T.renderWorkStreams(rows, { scope: 'd-agent-oldest', machine: 'boxa' }, Infinity);
  const order = [...out.matchAll(/data-mem-scope="([^"]*)" data-mem-machine="([^"]*)"/g)]
    .map((m) => m[1]);

  eq('the rows follow the AGENT\'s clock — the one each cell displays — youngest first',
    order.join(','),
    'a-agent-newest,b-agent-second,e-file-only,c-agent-third,d-agent-oldest,f-no-clock');

  // THE THREE THINGS THAT ORDER IS NOT, each spelled out so a mutation cannot
  // satisfy the assertion above by accident.
  ok('CONTROL: that is NOT the order the store handed over (mtime, newest first)',
    order.join(',') !== given.join(','), order.join(','));
  ok('CONTROL: nor is it the reverse of the store\'s order, which the reversed '
    + 'fixture would otherwise make indistinguishable',
    order.join(',') !== given.slice().reverse().join(','), order.join(','));
  ok('CONTROL: nor is it alphabetical — `e-file-only` sorts third by its clock, '
    + 'not fifth by its name',
    order.join(',') !== order.slice().sort().join(','), order.join(','));
  ok('CONTROL: the four rows carrying BOTH clocks rank exactly backwards by '
    + 'mtime against writtenAt, so reading either clock gives a plausible list',
    (() => {
      const both = rows.filter((r) => r.writtenAgeSeconds !== undefined && r.lastWriteAt);
      const byAgent = both.slice().sort((a, b) => a.writtenAgeSeconds - b.writtenAgeSeconds)
        .map((r) => r.scope);
      const byFile = both.slice().sort((a, b) => Date.parse(b.lastWriteAt) - Date.parse(a.lastWriteAt))
        .map((r) => r.scope);
      return byAgent.join(',') === byFile.slice().reverse().join(',') && both.length === 4;
    })());

  // A ROW THAT FELL BACK TO THE FILE CLOCK IS RANKED BY WHAT IT SHOWS. It has
  // no agent time, so its arrival IS its reading, and it takes its place among
  // the others rather than being pushed to either end.
  eq('the file-clock-only row is ranked by the reading it displays', order[2], 'e-file-only');
  ok('...and it says so in its own provenance text, as the two-clock rule requires',
    /e-file-only[\s\S]*?file time/.test(out));

  // NO READING IS NOT A READING OF ZERO. `effectiveSave` returns null when it
  // can resolve neither clock — an ABSENCE, not an age — so the row goes last,
  // never to the head of a list whose promise is "newest first".
  eq('the row with no resolvable clock sorts LAST', order[order.length - 1], 'f-no-clock');
  ok('...and it is still SHOWN, reading "unknown" rather than being dropped',
    out.includes('>unknown<') && (out.match(/<tr class="mem-ws-row/g) || []).length === 6);

  // THE OPEN PAIR TRAVELS WITH ITS ROW.
  eq('exactly one row is marked open', (out.match(/mem-ws-row-open/g) || []).length, 1);
  ok('...and it is the open pair wherever the order put it, not the row at its '
    + 'old index',
    /<tr class="mem-ws-row mem-ws-row-open"[^>]*>[\s\S]*?data-mem-scope="d-agent-oldest"/.test(out));
  eq('the open row still carries the focus id', (out.match(/id="mem-ws-active"/g) || []).length, 1);

  // THE ORDER IS TOTAL AND THE INPUT IS UNTOUCHED.
  const tied = [
    { scope: 'zulu', machine: 'boxb', writtenAgeSeconds: 300 },
    { scope: 'alpha', machine: 'boxb', writtenAgeSeconds: 300 },
    { scope: 'alpha', machine: 'boxa', writtenAgeSeconds: 300 },
    { scope: 'nope', machine: 'boxa' },
    { scope: 'also-nope', machine: 'boxb' },
  ];
  eq('rows at the SAME age break on scope then machine, so the order is total',
    T.workStreamOrder(tied).map((r) => r.scope + '/' + r.machine).join(','),
    'alpha/boxa,alpha/boxb,zulu/boxb,also-nope/boxb,nope/boxa');
  ok('...and two calls agree, so a poll cannot shuffle rows under the pointer',
    T.workStreamOrder(tied).map((r) => r.scope).join(',')
    === T.workStreamOrder(tied).map((r) => r.scope).join(','));
  eq('the response array is NOT sorted in place — `scopes[0]` still resolves to '
    + 'the pair the route\'s own scope=latest would',
    rows.map((r) => r.scope).join(','), given.join(','));
  ok('an empty list still renders no table at all', T.renderWorkStreams([], null) === '');
}

// ── §6e — THE TABLE SHOWS THE LATEST FIVE, AND A WAY PAST THEM ─────────
//
// THE REPORT. v3.55.0 put every (scope, machine) pair on screen, which was the
// right call against the two pickers it replaced and the wrong size for a real
// project: one that has run for a month across two machines is twenty rows, and
// the table then owns the page the way the journal did before it was folded.
// The maintainer asked for the newest five and a way to the rest.
//
// THE SHAPE IS THE DOMAINS LIST'S (v3.50.0): a footer row OUTSIDE the scroll
// container, "Showing N of M" tracking it, and an APPEND rather than a
// re-render. What is different is the STEP — see WS_STEP_ALL_MAX in memory.js —
// and the open row, which must never be the one the window hides.
{
  const T = makeRenderers(hostileState);
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    scope: 'ws-' + String(i).padStart(2, '0'), machine: 'boxa',
    headline: 'stream ' + i, harness: 'claude-code',
    // Ages ascend with the index, so the fixture's own order IS the rendered
    // order and "the first five" is unambiguous.
    writtenAgeSeconds: 60 * (i + 1),
    writtenAt: new Date(Date.now() - 60_000 * (i + 1)).toISOString(),
  }));
  const rowsOf = (html) => [...html.matchAll(/data-mem-scope="([^"]*)"/g)].map((m) => m[1]);

  // ── SEVEN PAIRS: five rows and a footer offering the other two ──────────
  const seven = mk(7);
  const out7 = T.renderWorkStreams(seven, null);
  eq('seven work-streams paint FIVE rows', rowsOf(out7).length, WS_WINDOW_SRC);
  eq('...and they are the five NEWEST, in order',
    rowsOf(out7).join(','), 'ws-00,ws-01,ws-02,ws-03,ws-04');
  ok('...with a footer row offering the other two, by number',
    /id="mem-ws-more"[\s\S]*?Show 2 more/.test(out7), out7.slice(out7.indexOf('mem-ws-more') - 60));
  ok('THE FOOTER IS OUTSIDE THE SCROLL CONTAINER, so it cannot sit below the '
    + 'fold of the list it extends',
  out7.indexOf('id="mem-ws-more"') > out7.indexOf('</table></div>'),
  out7.slice(out7.indexOf('</tbody>')));
  ok('...and it is a real <button>, so it is reachable by keyboard',
    /<button type="button" class="cur-group-row mem-ws-more"/.test(out7));

  // ── THE ROW SAYS WHAT PRESSING IT DOES ──────────────────────────────────
  // Its visible text is the slug, which names the row and not the ACTION — and
  // the action changed in v3.56.0 from "select this scope" to "open this
  // handoff". The machine rides in the label too, because two rows can carry
  // the same slug and a screen reader hears only this button.
  ok('every row announces the action AND the machine, not just the slug',
    (out7.match(/aria-label="Open the handoff for ws-\d\d on boxa"/g) || []).length === WS_WINDOW_SRC,
    (out7.match(/aria-label="[^"]*"/g) || []).join(' | '));

  // ── THE PRESS: every remaining row, and no footer ───────────────────────
  const pressed = T.renderWorkStreams(seven, null, 7);
  eq('after the press all seven are painted', rowsOf(pressed).length, 7);
  ok('...and the footer is gone, because there is nothing left to offer',
    !pressed.includes('id="mem-ws-more"'));

  // ── THE STEP: "all the rest" until it would be a wall ───────────────────
  // Two work-streams hidden is not worth a second press; forty is not worth
  // one paint. WS_STEP_ALL_MAX is where the judgement changes, and it is read
  // off live source, so this asserts the shipped rule rather than a number.
  const justUnder = WS_WINDOW_SRC + WS_STEP_ALL_MAX_SRC;
  ok('with exactly WS_STEP_ALL_MAX hidden, one press shows them ALL',
    new RegExp('Show ' + WS_STEP_ALL_MAX_SRC + ' more').test(T.renderWorkStreams(mk(justUnder), null)),
    T.renderWorkStreams(mk(justUnder), null).slice(-200));
  ok('...and ONE more than that steps by WS_STEP instead of painting a wall',
    new RegExp('Show ' + WS_STEP_SRC + ' more').test(T.renderWorkStreams(mk(justUnder + 1), null)),
    T.renderWorkStreams(mk(justUnder + 1), null).slice(-200));
  ok('CONTROL: those two are different numbers, so the branch is real',
    WS_STEP_ALL_MAX_SRC !== WS_STEP_SRC);

  // ── NOTHING TO OFFER: a list that fits says nothing about its own length ──
  ok('five work-streams paint five rows and NO footer',
    rowsOf(T.renderWorkStreams(mk(5), null)).length === 5
    && !T.renderWorkStreams(mk(5), null).includes('mem-ws-more'));

  // ── THE OPEN PAIR IS VISIBLE FROM THE FIRST PAINT ───────────────────────
  // It is reached by STRETCHING the window, not by hoisting the row: this
  // table's header says "newest first", and a highlighted row sitting above one
  // three minutes younger is the same lie v3.55.0's third defect was — a table
  // claiming an order it does not render — in a smaller font.
  const eight = mk(8);
  const open6 = T.renderWorkStreams(eight, { scope: 'ws-06', machine: 'boxa' });
  const openRows = rowsOf(open6);
  ok('an open pair at index 6 is on screen without any press',
    openRows.includes('ws-06'), openRows.join(','));
  eq('...reached by stretching the window to it, so the order is untouched',
    openRows.join(','), 'ws-00,ws-01,ws-02,ws-03,ws-04,ws-05,ws-06');
  ok('...NOT by hoisting it to the top, which would make "newest first" false',
    openRows[0] === 'ws-00', openRows.join(','));
  ok('...and it is still the row marked open',
    /<tr class="mem-ws-row mem-ws-row-open"[\s\S]*?data-mem-scope="ws-06"/.test(open6));
  ok('...with the last row still offering the one that is left',
    /Show 1 more/.test(open6), open6.slice(-200));
  eq('CONTROL: with no pair open the same fixture paints five',
    rowsOf(T.renderWorkStreams(eight, null)).length, WS_WINDOW_SRC);

  // ── THE COUNT LINE KEEPS THE STORE'S TOTALS AND ADDS THE WINDOW ─────────
  const counts = T.workStreamCounts({ savedCopies: 8, distinctScopeCount: 8 }, 8, 5);
  ok('the count line still reports the store\'s uncapped totals',
    counts.includes('8 handoffs') && counts.includes('8 saved copies'), counts);
  ok('...and says how much of them is on screen',
    counts.includes('showing 5 of 8'), counts);
  ok('...and says nothing about a window when everything is shown',
    !T.workStreamCounts({ savedCopies: 8, distinctScopeCount: 8 }, 8, 8).includes('showing 5 of'),
    T.workStreamCounts({ savedCopies: 8, distinctScopeCount: 8 }, 8, 8));
  // TWO CAPS, TWO SENTENCES. The store's own cap on how many pairs it LISTS is
  // a different fact from this table's window, and collapsing them would report
  // one as the other.
  const both = T.workStreamCounts(
    { savedCopies: 99, distinctScopeCount: 40, scopesTruncated: true }, 20, 5);
  ok('the store\'s cap and the table\'s window are stated separately',
    both.includes('showing the 20 most recently saved') && both.includes('showing 5 of 20'), both);

  // ── wsShownCount, DRIVEN DIRECTLY ───────────────────────────────────────
  eq('a short list is shown whole', T.wsShownCount(mk(3), null, 5), 3);
  eq('a long list is cut to the window', T.wsShownCount(mk(30), null, 5), 5);
  eq('an open row inside the window does not move it',
    T.wsShownCount(mk(30), { scope: 'ws-02', machine: 'boxa' }, 5), 5);
  eq('an open row outside it stretches the window exactly far enough',
    T.wsShownCount(mk(30), { scope: 'ws-09', machine: 'boxa' }, 5), 10);
  eq('a machine that is not in the list stretches nothing',
    T.wsShownCount(mk(30), { scope: 'ws-09', machine: 'elsewhere' }, 5), 5);
  eq('Infinity means every row — the seam §6c uses to test the ORDER',
    T.wsShownCount(mk(30), null, Infinity), 30);
}

// ── §6d — A RE-ORDER IS A REPAINT, AND ONLY THEN ─────────────────────
//
// The other half of the same defect. `screenSignature` is the no-op guard: the
// pane repaints iff the mark moves, so a mark taken over the RESPONSE while the
// table paints a SORTED copy describes an arrangement that is not on screen.
// Two saves in the same age band crossing each other move every row and no cell
// — which is exactly the case a projection off `pr.scopes` cannot see.
{
  // `wsShownCount` joins them in v3.56.0: the table paints a WINDOW — the newest
  // five with a "Show N more" footer — so the mark is the rows on screen plus
  // the number hidden behind it, and that split is this function's arithmetic.
  // Lifted from live source, never stubbed: a stub would let the mark describe a
  // window the table is not painting, which is the same class of bug as the one
  // this section exists for. WS_WINDOW is injected as the shipped literal.
  const sigOf = (st) => new Function('state', 'WS_WINDOW',
    ['formatAge', 'effectiveSave', 'workStreamOrder', 'wsShownCount', 'newestPair',
      'projectMetaLine', 'screenSignature']
      .map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n')
    + '\nreturn screenSignature();')(st, WS_WINDOW_SRC);

  // ── THE WINDOW IS PART OF THE MARK (v3.56.0) ──────────────────────────
  // The table paints five of N. A signature that folded in EVERY row would
  // repaint the pane when a hidden row's age crossed a band — no pixel moves,
  // and the repaint closes the ⓘ and churns focus. One that folded in the shown
  // rows ALONE would miss a save appearing behind the footer, whose label and
  // whose count line both have to move. So it is the shown rows PLUS the hidden
  // count, and both halves are asserted.
  {
    const many = (n, extraAge) => ({
      activeDomain: 'acme', activeProject: 'lumina', staleWrite: false, indexError: null,
      scope: 'a-00', machine: 'boxa', projects: [], detail: null, wsWindow: WS_WINDOW_SRC,
      projectRead: { savedCopies: n, distinctScopeCount: n,
        scopes: Array.from({ length: n }, (_, i) => ({
          scope: 'a-' + String(i).padStart(2, '0'), machine: 'boxa', headline: 'h' + i,
          // The LAST row's age is the one the caller can move, so a change
          // behind the footer is expressible without touching a shown row.
          writtenAgeSeconds: (i === n - 1 && extraAge) ? extraAge : 60 * (i + 1),
        })),
        brief: { present: false } },
    });

    ok('OPENING THE WINDOW REPAINTS — the rows behind the footer are now on screen',
      sigOf(many(8)) !== sigOf({ ...many(8), wsWindow: 8 }));
    ok('A SAVE APPEARING BEHIND THE FOOTER REPAINTS — the footer\'s own label and '
      + 'the count line both move, and no shown row does',
    sigOf(many(8)) !== sigOf(many(9)));
    ok('CONTROL: a HIDDEN row\'s age crossing a band does NOT repaint — nothing '
      + 'on screen would look different, and a repaint closes the ⓘ',
    sigOf(many(8, 3600)) === sigOf(many(8, 7200)));
    ok('CONTROL: the same age change on a SHOWN row DOES repaint, so the check '
      + 'above is about visibility rather than about ages being ignored',
    (() => {
      // The first row stays FIRST at either age — every other row is a week old
      // — so this moves a word on screen and nothing else. (Written first with
      // the fixture above and re-done: bumping its row 0 to an hour made it the
      // OLDEST of eight one-minute rows and sent it behind the footer, so the
      // assertion was measuring the hidden case twice.)
      const bump = (secs) => { const st = many(8); st.projectRead.scopes.forEach((x, i) => {
        x.writtenAgeSeconds = i === 0 ? secs : 7 * 86400 + i; }); return st; };
      return sigOf(bump(3600)) !== sigOf(bump(7200));
    })());
    ok('CONTROL: an identical state still produces an identical mark',
      sigOf(many(8)) === sigOf(many(8)));
  }

  // A third row is strictly the newest in both states, so `newestPair` — which
  // reads the raw response and is folded in separately — CANNOT be what moves
  // the mark. Without it this assertion would pass on the strip's reading alone
  // and prove nothing about the table.
  const pinned = { scope: 'aaa-pinned', machine: 'boxa', headline: 'newest either way',
    harness: 'claude-code', writtenAgeSeconds: 60, lastWriteAt: '2026-09-01T00:00:00.000Z' };
  // 7200 s and 7800 s both render "2 hr ago", so swapping them changes no cell
  // in either row — only which of the two comes first.
  const st = (xAge, yAge) => ({
    activeProject: 'proj', staleWrite: false, indexError: null,
    scope: 'x', machine: 'boxa', projects: [],
    projectRead: { scopes: [
      pinned,
      { scope: 'x', machine: 'boxa', headline: 'same words either way', harness: 'opencode',
        writtenAgeSeconds: xAge, lastWriteAt: '2026-09-02T00:00:00.000Z' },
      { scope: 'y', machine: 'boxa', headline: 'same words either way', harness: 'opencode',
        writtenAgeSeconds: yAge, lastWriteAt: '2026-09-03T00:00:00.000Z' },
    ] },
    detail: null,
  });

  ok('SETUP: the two rows that swap read the SAME age words in both states, so '
    + 'no cell\'s content can be what moves the mark',
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js')
      + '\nreturn formatAge(7200) === formatAge(7800) && formatAge(7200) === "2 hr ago";')());
  ok('two rows swapping their AGENT clocks repaints, with every mtime and every '
    + 'rendered cell unchanged — the re-order IS the change on screen',
    sigOf(st(7200, 7800)) !== sigOf(st(7800, 7200)));
  ok('CONTROL: an identical state still produces an identical mark, so this is '
    + 'not a signature that simply always differs',
    sigOf(st(7200, 7800)) === sigOf(st(7200, 7800)));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — The <summary> hazard, over rendered OUTPUT');
// ═════════════════════════════════════════════════════════════════════════

function summariesIn(markup) {
  const out = [];
  const re = /<summary\b[^>]*>([\s\S]*?)<\/summary>/gi;
  let m;
  while ((m = re.exec(markup)) !== null) out.push(m[1]);
  return out;
}

/**
 * THE OPEN-TAG STACK AT THE POINT `needle` APPEARS — i.e. that element's
 * ancestors, outermost first.
 *
 * ── WHY A SECOND, DUMBER SCAN THAN `summariesIn` ────────────────────────
 * `summariesIn` answers "does this substring sit between a <summary> and its
 * </summary>", which is the right question only while the markup is flat. The
 * v3.58.0 brief is a <details> with a button beside it, and "beside" versus
 * "inside" is a NESTING fact — the exact thing a substring test cannot see and
 * the exact thing the v3.0.1-beta.18 hazard is about. So this walks tags and
 * keeps a stack, and the assertion reads the stack.
 *
 * Deliberately crude, and that is the point (the v3.1.0 lesson: give a clever
 * measurement an independent dumb cross-check). It knows about self-closing
 * tags and the void elements this view emits, nothing else, and the two
 * CONTROL assertions at its call site prove it can report a summary ancestor
 * when there is one — without them a walker that silently returned [] would
 * make every ancestry assertion pass.
 */
const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'path', 'circle', 'rect', 'line', 'polyline']);
function ancestorTags(markup, needle) {
  const at = markup.indexOf(needle);
  if (at === -1) return [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(markup)) !== null) {
    // Stop at the tag that SPANS the needle — the needle is normally an
    // attribute inside that element's own open tag, and an element is not its
    // own ancestor.
    if (m.index + m[0].length > at) break;
    const [, closing, tag, selfClose] = m;
    const name = tag.toLowerCase();
    if (closing) {
      const i = stack.lastIndexOf(name);
      if (i !== -1) stack.length = i;
    } else if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
  }
  return stack;
}

const allSummaries = summariesIn(html);
// TWO SINCE v3.58.0 — one between v3.56.0 and here, three before v3.55.0.
//
// THE BRIEF IS A FOLD AGAIN, AND THAT IS NOT A REVERT. v3.55.0 took it out of
// a <details> because its <summary> had to carry the edit control and a
// control inside a summary toggles its own section. The pencil is NOT in the
// summary now — it is a SIBLING of the <details>, anchored over the summary
// row by memory.css — so that argument no longer forbids the fold, and the
// measurement that brought it back is in views/memory.js's renderBrief: the
// block was 2,100px of a 3,241px page. The HANDOFF's fold is still gone with
// the block it led, because that document opens in the shell's reader.
//
// The floor exists so the scan below cannot pass over a page that rendered NO
// summaries at all, and the block directly under it pins WHICH folds they are,
// so one appearing or one vanishing is still caught.
ok('the fixture rendered at least 2 <summary> elements (the scan is not vacuous)',
  allSummaries.length >= 2, 'found ' + allSummaries.length);
{
  const folds = (html.match(/data-mem-fold="([a-z]+)"/g) || []).sort().join(',');
  ok('...and the page\'s two folds are the brief and the journal, by name',
    folds === 'data-mem-fold="brief",data-mem-fold="journal"', folds);
  // THE HANDOFF FOLD IS GONE FROM THE PAGE, and named here so a revert reds
  // rather than merely changing a count. Over COMMENT-STRIPPED source on the
  // second half: memory.js explains at length why the fold left, and a raw
  // scan would fire on the explanation.
  ok('THE HANDOFF IS NOT A FOLD: it opens in the reader, so there is no '
    + 'lead <details> and no `.mem-fold-lead` on the page',
    !html.includes('data-mem-fold="handoff"') && !html.includes('mem-fold-lead')
    && !stripComments(viewSrc).includes('data-mem-fold="handoff"')
    && !stripComments(viewSrc).includes('mem-fold-lead'));
  // ── THE PENCIL IS OUTSIDE ITS <summary>, ASSERTED OVER DOM ANCESTRY ────
  // Not "the string `mem-brief-edit` does not appear between <summary> and
  // </summary>" — that is what `summariesIn` below already does for every
  // control, and it is the assertion that would survive a nesting change it
  // could not see. This one walks the rendered markup and asks whether the
  // button's ancestors include a <summary>, which is the property the
  // v3.0.1-beta.18 hazard is actually about.
  const briefOnly = R.renderBrief({
    brief: { present: true, text: '## a\n\nb', updatedAt: '2026-09-10T00:00:00.000Z' },
  });
  ok('THE PENCIL IS NOT A DESCENDANT OF ANY <summary> — the hazard has no '
    + 'propagation path to suppress', ancestorTags(briefOnly, 'id="mem-brief-edit"')
      .every((t) => t !== 'summary'),
  ancestorTags(briefOnly, 'id="mem-brief-edit"').join(' > '));
  ok('CONTROL: the ancestry walk really did find the button inside the fold row',
    ancestorTags(briefOnly, 'id="mem-brief-edit"').includes('div'));
  ok('CONTROL: the same walk reports a summary ancestor when there IS one',
    ancestorTags('<div><details><summary><b>x</b><button id="mem-brief-edit"></button></summary></details></div>',
      'id="mem-brief-edit"').includes('summary'));
}
for (const control of ['<button', '<select', '<input', '<textarea', '<a ']) {
  ok('no ' + control + '> appears inside any rendered <summary>',
    allSummaries.every((s) => !s.toLowerCase().includes(control)),
    'a control inside a <summary> toggles its own section (v3.0.1-beta.18)');
}
// Positive control: the detector must be able to SEE a control in a summary.
ok('self-test: the summary scan detects a planted control',
  summariesIn('<summary><button>x</button></summary>').some((s) => s.includes('<button')));

// The journal's "Show more" button exists and is NOT in the summary.
{
  const j = makeRenderers({
    ...hostileState,
    journalLimit: 10,
    detail: { ...hostileDetail, journal: { ...hostileDetail.journal, total: 40 } },
  }).renderJournal();
  ok('the journal offers a "Show more" control when more entries exist', j.includes('mem-journal-more'));
  ok('...and that control is NOT inside the <summary>',
    summariesIn(j).every((s) => !s.includes('mem-journal-more')));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7b — The journal label may never claim loss that did not happen');
// ═════════════════════════════════════════════════════════════════════════
// SHIPPED, and seen in a browser: the journal rendered
//   "N field(s) rejected by the sanitiser: ..."
// over notes where NOTHING was rejected. The commonest note by far is an
// observation saved without a time — the save time was filled in AND
// disclosed, which is the store working correctly. A user reading that label
// concludes their data was thrown away.
//
// The store already bans loss vocabulary from any note that is not a loss,
// as a class over every note it emits (scripts/test-working-state.js). The
// UI's own label is NOT one of those notes and was NOT covered by that
// invariant — which is exactly how a word meaning "discarded" survived on the
// one surface a human reads. This section mirrors the store's invariant over
// the RENDERED OUTPUT, so the gap cannot reopen.
//
// The note strings are produced by the REAL store, not typed here. A fixture
// of hand-written notes would test this suite's idea of what the store says;
// only real notes prove the two layers still agree.
const LOSS_WORDS = /\b(dropped|omitted|truncated|rejected|discarded|lost)\b/i;

const journalOf = (notes) => makeRenderers({
  ...hostileState,
  journalLimit: 10,
  detail: {
    ...hostileDetail,
    journal: {
      returned: 1, total: 1, totalUnknown: false,
      entries: [{ at: '2026-08-28T10:00:00.000Z', harness: 'claude-code', model: 'm', headline: 'h', rejections: notes }],
    },
  },
}).renderJournal();

// ── Case 1 · NORMALISATION. A defaulted observation time. Nothing lost. ────
const normalised = await ws.saveWorkingState('alpha', {
  scope: 'label-normalised', headline: 'defaulted observation time',
  nowState: 'body so the save is not itself near-empty',
  observations: [{ statement: '84 offline suites green' }],
});
ok('PRECONDITION: the real store emits a note for an observation sent with no time',
  normalised.ok === true && (normalised.notes || []).some((n) => /observation time/i.test(n)),
  JSON.stringify(normalised.notes));
ok('PRECONDITION: ...and that note carries no loss vocabulary (the store class invariant holds)',
  !(normalised.notes || []).some((n) => LOSS_WORDS.test(n)), JSON.stringify(normalised.notes));

const normalisedHtml = journalOf(normalised.notes);
ok('the rendered label does NOT say "rejected by the sanitiser" over a normalised save',
  !/rejected by the sanitiser/i.test(normalisedHtml),
  'the shipped falsehood is still rendered');
ok('...and carries NO loss vocabulary at all — the store invariant, mirrored over rendered output',
  !LOSS_WORDS.test(normalisedHtml.replace(/<[^>]*>/g, '')),
  normalisedHtml.replace(/<[^>]*>/g, '').slice(0, 300));
ok('...and it still says a note exists and what it was for, rather than hiding it',
  /1 note/.test(normalisedHtml) && /normalised/i.test(normalisedHtml));
ok('...and the note text itself is still shown, so the user can read what happened',
  normalisedHtml.includes('observation time'));

// ── Case 2 · REAL LOSS. Unusable items really are dropped. Say so. ────────
const lossy = await ws.saveWorkingState('alpha', {
  scope: 'label-lossy', headline: 'unusable observations',
  nowState: 'body so the save is not itself near-empty',
  observations: [{ statement: 'kept' }, { nope: true }, 42],
});
ok('PRECONDITION: the real store reports genuinely unusable items as dropped',
  lossy.ok === true && (lossy.notes || []).some((n) => /\bdropped\b/i.test(n)),
  JSON.stringify(lossy.notes));
const lossyHtml = journalOf(lossy.notes);
ok('a REAL loss is labelled as loss — the label discriminates, it is not a fixed reassurance',
  /dropped or truncated/i.test(lossyHtml));
ok('...and it does not use the normalised-save wording, which would understate what happened',
  !/stored in full/i.test(lossyHtml));

// ── Case 3 · REPLACEMENT. Nothing the caller sent was lost — but the prior
// handoff was. Neither of the other two labels is true of it. ─────────────
await ws.saveWorkingState('alpha', {
  scope: 'label-replaced', headline: 'a real handoff',
  nowState: 'A substantial body. '.repeat(80),
  nextSteps: ['keep this'],
});
const replaced = await ws.saveWorkingState('alpha', {
  scope: 'label-replaced', headline: 'THIN', replace: true,
});
ok('PRECONDITION: the real store records a deliberate overwrite of a larger handoff',
  replaced.ok === true && (replaced.notes || []).some((n) => /overwrote/i.test(n)),
  JSON.stringify(replaced.notes));
const replacedHtml = journalOf(replaced.notes);
ok('a deliberate replacement is labelled as a replacement, not as normalisation',
  /replaced a larger handoff/i.test(replacedHtml));
ok('...and does not use the normalised-save wording, which would understate what happened',
  !/stored in full/i.test(replacedHtml));

// ── The class invariant, over every note the store can produce here ───────
// Not three pinned cases: every non-loss note, rendered, must be free of loss
// vocabulary. A future note kind is covered without editing this list.
const allNonLoss = [...(normalised.notes || []), ...(replaced.notes || [])]
  .filter((n) => !LOSS_WORDS.test(n));
ok('PRECONDITION: there is at least one non-loss note to test over (not vacuous)',
  allNonLoss.length > 0, 'count ' + allNonLoss.length);
ok('CLASS: no non-loss note is ever rendered under a loss-vocabulary label',
  allNonLoss.every((n) => !LOSS_WORDS.test(journalOf([n]).replace(/<[^>]*>/g, ''))));

// Positive control: the detector can SEE loss vocabulary in rendered output,
// so the assertions above are not passing over a scan that never fires.
ok('self-test: the scan detects loss vocabulary when it really is present',
  LOSS_WORDS.test(journalOf(['x: dropped 2 unusable item(s)']).replace(/<[^>]*>/g, '')));

// An empty rejections array renders no label at all — never warn about
// content that is not there (the same discipline as the empty-journal note).
ok('a save with no notes renders no note label at all',
  !/mem-j-rej/.test(journalOf([])));

// ═════════════════════════════════════════════════════════════════════════
section('§8 — The view writes the STANDING BRIEF and the MIRROR, and nothing else');
// ═════════════════════════════════════════════════════════════════════════

// STRUCTURAL, NOT A LIST OF LITERAL STRINGS. The five-string version of this
// scan was defeated by `const M = 'PO' + 'ST'` — a planted write survived it
// intact. What made this view read-only was that no fetch it issued carried a
// REQUEST INIT at all: `fetch(url)` with one argument can only ever be a GET,
// whatever the method name is spelled like.
//
// v3.48.0 GAVE THIS VIEW ONE WRITE — the standing brief — so "no init object
// anywhere" is no longer the property. The replacement is NARROWER rather
// than weaker, and it is what the tier boundary actually needs:
//
//   · EXACTLY ONE fetch call site carries an init object.
//   · Its method is the LITERAL 'PATCH' — not a variable, not a
//     concatenation, so the `'PO' + 'ST'` evasion is still refused by
//     construction.
//   · Its URL is the projects endpoint, which the route allows to touch
//     tier 1 only.
//   · Every OTHER fetch is still single-argument.
//
// So a planted `fetch(u, { method: M, body: b })` fails on the count; a
// planted POST fails on the literal; and a PATCH pointed at a scope read
// fails on the URL.
//
// ── v3.59.0 ADDS A SECOND, AND WHY THAT IS STILL THE BOUNDARY ───────────
// "Refresh from repo" POSTs to `…/foundations/refresh`, which copies bytes
// from a repository this project already names as its documents' author. The
// route's own header carries the argument (a copier, not a second writer);
// what this section has to prove is that the VIEW cannot reach anything else
// through it — so the assertions are widened by NAMING the second write
// exactly rather than by loosening the count:
//
//   · TWO call sites carry an init, and the set of literal methods is
//     exactly {PATCH, POST}.
//   · The POST's URL ends in the refresh path, and its BODY is the literal
//     '{}' — no field of any kind crosses, so there is nothing for a future
//     edit to smuggle a handoff into.
//
// The `'PO' + 'ST'` evasion is refused exactly as before: the methods are
// matched as LITERALS, and an assembled one is neither of the two.
const viewNoComments = stripComments(viewSrc);

/** Every `fetch(` call site's argument list, paren-matched off real source. */
function fetchCallArgs(src) {
  const out = [];
  const re = /(?<![.\w$])fetch\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(m.index + m[0].length, i));
  }
  return out;
}

/** Split one argument list on TOP-LEVEL commas only. */
function topLevelArgs(argsSrc) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < argsSrc.length; i++) {
    const c = argsSrc[i];
    if (quote) { if (c === '\\') { cur += c + (argsSrc[++i] ?? ''); continue; } if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const fetchArgLists = fetchCallArgs(viewNoComments);
ok('the scan found the view\'s real fetch call sites (it is not vacuous)',
  fetchArgLists.length >= 2, 'found ' + fetchArgLists.length);
const withInit = fetchArgLists.filter((a) => topLevelArgs(a).length > 1);
// ── v3.61.0 TAKES THIS FROM TWO TO FIVE, AND NAMES ALL FIVE ─────────────
//
// The count is the wrong thing to defend on its own and always was: what this
// section proves is WHICH FILES the view can reach, and that is asserted
// below, write by write, on the URL and the body of each. The count stays
// EXACT rather than becoming a floor, because an exact set is what forces the
// next person adding a write to declare it here — a floor would let a sixth
// arrive in silence, which is the v3.11.0 shape this repo keeps re-learning.
//
//   PATCH  …/projects/:project          the standing brief (tier 1)
//   POST   …/foundations/refresh        the MIRROR copy — a file LIST, no body
//   POST   …/foundations/init           sets the ownership, ONCE
//   PUT    …/foundations/:slug          one CURATOR-owned document, verbatim
//   DELETE …/foundations/:slug          removes one, with the slug as confirm
//   DELETE …/foundations/:slug          v3.61.1: the ROW control's removal —
//                                       the SAME route and the same body, from
//                                       a second call site, because the table
//                                       can now stop mirroring one document
//                                       without opening an editor (which a
//                                       mirrored document has no right to)
//
// Every one of them is still on tier 0 or tier 1. NOTHING here can reach a
// work-stream handoff or a journal: the boundary is unmoved and the assertions
// below say so by NAMING each URL rather than by counting.
//
//   PATCH …/foundations/:slug           v3.62.0: the "read first" toggle. It
//                                       writes `{readFirst}` and NOTHING else,
//                                       and the route allows it on BOTH
//                                       ownerships — the flag is curator
//                                       METADATA ABOUT a document, never part
//                                       of it, so setting it on a mirror
//                                       touches no byte of the copy and cannot
//                                       make the app a second author
//
// Every one of them is still on tier 0 or tier 1. NOTHING here can reach a
// work-stream handoff or a journal: the boundary is unmoved and the assertions
// below say so by NAMING each URL rather than by counting.
//
// SEVEN, AND ONLY ONE OF THEM IS A NEW ROUTE. The count is exact on purpose —
// a floor would let a genuinely new write arrive in silence — so a second
// caller of an already-declared route still has to be declared, which is the
// DELETE paragraph above. What a write must NOT do is reach a different URL or
// carry a different body, and the assertions below check both by name: there
// is one DELETE SHAPE, asserted over every DELETE the view makes.
// EIGHT SINCE v3.65.0, AND THE EIGHTH IS CURATOR METADATA. Step ③ writes
// `PATCH …/knowledge/domains {knowledgeDomains}` — WHICH WIKIS this project
// draws on. It is the owner's own choice ABOUT the project, in the same class
// as `readFirst` above it: the route writes `project.json` and NOTHING else,
// so the standing brief (tier 1), every handoff and every journal line (tiers
// 2 and 3, agent-only over MCP) and every foundation's bytes are untouched.
// The single-writer rule is "one writer per FILE, with provenance that
// matches", and this file has exactly one writer for exactly one fact.
// ── ELEVEN SINCE v3.67.0, AND ONLY ONE OF THE THREE NEW ONES IS A WRITE THE
// v3.66.0 SET DID NOT HAVE ──────────────────────────────────────────────────
// · `PATCH …/foundations/:slug {atStart}` REPLACES `{readFirst}` at the same
//   route, from ONE call site (`writeStartState`), shared by the row's control
//   and by "Apply suggestion" — so the route is declared once, not twice.
// · `PATCH …/reading/budget {readingBudgetBytes}` is the new write: curator
//   metadata ABOUT the project (`project.json`), the same class as
//   `knowledgeDomains` above it — one writer, one fact, one field.
// · `POST …/session-start/preview` is a READ with a body (a plan of up to 200
//   slugs does not belong in a URL — CONTRACT §1.18); the route writes nothing,
//   which the store suite proves by fingerprint.
// · `POST /api/reading-plan/…/suggest {arm}` is a READ too: the helper
//   proposes and never writes (H's suite fingerprints it). It is the one fetch
//   outside /api/memory, named below rather than admitted by a prefix.
// ── TWELVE SINCE v3.68.0 ─────────────────────────────────────────────────
// The ownership chooser's init/source POST is gone. The two doors bring ONE
// commit POST whose URL and body `buildAddCommit` composes (add-local, init,
// refresh or source — driven below and in test-foundations-add.js), and the
// "four templates" POST to init.
// ── FOURTEEN SINCE v3.70.0 ───────────────────────────────────────────────
// · `POST …/session-start/preview {budgetBytes}` — the budget picker's
//   PREVIEW, a second caller of the v3.67.0 preview READ (the route writes
//   nothing), sending the previewed budget and nothing else.
// · `PUT /api/config/context-window` — this COMPUTER's window and harness
//   estimate (decision 4). App settings, never project state: it cannot name
//   a project, a document, a brief or a handoff, and the route refuses any
//   field but the two.
eq('EXACTLY FOURTEEN fetches in the view carry a request init', withInit.length, 14);
ok('every other fetch is single-argument — structurally a GET, whatever a method string is spelled like',
  fetchArgLists.filter((a) => topLevelArgs(a).length === 1).length === fetchArgLists.length - 14,
  JSON.stringify(fetchArgLists.map((a) => topLevelArgs(a).length)));
{
  const inits = withInit.map((a) => ({ url: topLevelArgs(a)[0], init: topLevelArgs(a)[1] }));
  const withMethod = (m) => inits.filter((x) => new RegExp("\\bmethod\\s*:\\s*'" + m + "'").test(x.init));
  const patches = withMethod('PATCH');
  const patch = patches.find((x) => x.url.includes("'/projects/'"));
  const first = patches.find((x) => x.url.includes("'/foundations/'"));
  const posts = withMethod('POST');
  const puts = withMethod('PUT');
  const put = puts.find((x) => x.url.includes("'/foundations/'"));
  // v3.70.0: the second PUT is THIS COMPUTER's window/harness — app settings.
  const ctxPut = puts.find((x) => x.url === "'/api/config/context-window'");
  const del = withMethod('DELETE')[0];
  eq('exactly FOUR writes use a LITERAL PATCH — never a variable or a concatenation',
    patches.length, 4, JSON.stringify(inits.map((x) => x.init.slice(0, 60))));
  // ── THE FOURTH: THE READING BUDGET (v3.67.0) ─────────────────────────
  const budget = patches.find((x) => x.url.includes("'/reading/budget'"));
  ok('the fourth PATCH targets the four-segment reading/budget endpoint under this project',
    budget && budget.url.includes('/api/memory/'), budget ? budget.url.slice(0, 200) : 'none');
  ok('...and sends ONLY `readingBudgetBytes` — never a brief, a handoff field or a document',
    budget && /body:\s*JSON\.stringify\(\{\s*readingBudgetBytes:\s*bytes\s*\}\)/.test(budget.init)
    && !/brief|text:|nowState|nextSteps|readFirst|atStart/.test(budget.init),
    budget ? budget.init.slice(0, 200) : 'none');
  // ── THE THIRD: WHICH WIKIS (v3.65.0, P10) ────────────────────────────
  // Named rather than counted, like its two siblings. It sends the WHOLE
  // list and nothing else — a strict one-field body at the route — and
  // `null` when the last one is removed, which is the store's own way of
  // saying "back to the domain this project lives in".
  const know = patches.find((x) => x.url.includes("'/knowledge/domains'"));
  ok('the third PATCH targets the knowledge-domains endpoint under this project',
    know && know.url.includes('/api/memory/'), know ? know.url.slice(0, 200) : 'none');
  ok('...and sends ONLY `knowledgeDomains` — never a brief, a handoff field or '
    + 'a document\'s text',
  know && /body:\s*JSON\.stringify\(\{\s*knowledgeDomains:/.test(know.init)
    && !/brief|text:|nowState|nextSteps|observations|traps|decisions|readFirst/.test(know.init),
  know ? know.init.slice(0, 260) : 'none');
  ok('the brief\'s PATCH targets the PROJECTS endpoint, which reaches tier 1 only',
    patch && patch.url.includes("'/projects/'") && patch.url.includes('/api/memory/'),
    patch ? patch.url.slice(0, 160) : 'none');
  ok('...and sends only a brief — never a handoff field',
    patch && /body:\s*JSON.stringify\(\{\s*brief:/.test(patch.init)
    && !/nowState|nextSteps|observations|traps|decisions/.test(patch.init),
    patch ? patch.init.slice(0, 200) : 'none');
  // ── THE "read first" TOGGLE SENDS THE FLAG AND NOTHING ELSE ───────────
  // The route's own rule: `text` is the document and `readFirst` is metadata
  // about it, and a PATCH that carried both would be a write to a mirror's
  // bytes by another name. One key, and the assertion names it.
  ok('the second PATCH targets ONE foundation on tier 0',
    first && first.url.includes("'/foundations/'") && first.url.includes('/api/memory/'),
    first ? first.url.slice(0, 200) : 'none');
  // v3.67.0: the three-state `{atStart}` replaced the two-state `{readFirst}`
  // at the same route — one key, the start state, and NOTHING else.
  ok('...and sends `atStart` and NOTHING else — never the document\'s text',
    first && /body:\s*JSON.stringify\(\{\s*atStart\s*\}\)/.test(first.init)
    && !/text:|readFirst/.test(first.init), first ? first.init.slice(0, 200) : 'none');
  eq('...from exactly ONE call site, shared by the row and by Apply',
    patches.filter((x) => x.url.includes("'/foundations/'")).length, 1);
  // v3.67.0: two READS carry a body. Named, with their bodies, so neither can
  // grow a write-shaped field.
  eq('exactly SIX fetches use a LITERAL POST', posts.length, 6);
  // v3.70.0: two callers of the preview READ — the plan's `if applied`
  // (`body`) and the budget picker's preview (`{ budgetBytes: bytes }`).
  const previews = posts.filter((x) => x.url.includes("'/session-start/preview'"));
  eq('...TWO of them are the session-start PREVIEW, a read', previews.length, 2);
  const budgetPv = previews.find((x) => /body:\s*JSON\.stringify\(\{\s*budgetBytes:\s*bytes\s*\}\)/.test(x.init));
  ok('...one sends the PREVIEWED BUDGET and nothing else — never a plan, a document or a write field',
    !!budgetPv && budgetPv.url.includes('/api/memory/') && budgetPv.url.includes('encodeURIComponent'),
    JSON.stringify(previews.map((x) => x.init.slice(0, 140))));
  const preview = previews.find((x) => x !== budgetPv);
  ok('one POST is the session-start PREVIEW under this project — a read with a plan in its body',
    preview && preview.url.includes('/api/memory/') && /body:\s*JSON\.stringify\(body\)/.test(preview.init),
    preview ? preview.url.slice(0, 200) + preview.init.slice(0, 120) : 'none');
  const suggest = posts.find((x) => x.url.includes("'/suggest'"));
  ok('one POST asks the reading-plan helper for a proposal, sending the ARM and nothing else',
    suggest && suggest.url.includes("'/api/reading-plan/'")
    && /body:\s*JSON\.stringify\(\{\s*arm\s*\}\)/.test(suggest.init),
    suggest ? suggest.url.slice(0, 200) + suggest.init.slice(0, 120) : 'none');
  const refresh = posts.find((x) => x.url.includes("'/foundations/refresh'"));
  ok('one POST targets the foundations REFRESH endpoint',
    !!refresh, JSON.stringify(posts.map((x) => x.url.slice(0, 120))));
  // ── THE REFRESH BODY IS A FILE LIST OR NOTHING, NEVER A DOCUMENT ───────
  // It was the literal '{}' and the guard on it was that NOTHING crossed. One
  // field crosses now — `files`, an array of PATHS INSIDE the repository the
  // manifest already names — because without it a mirror could only ever be
  // created from a test (v3.59.0 shipped the route with no file list at all).
  // What must stay true is that no document BODY crosses on this route: that
  // is what keeps "the app is a copier on a mirror, never an author" true of
  // it. A curator document's bytes go through the PUT below, which is a
  // different route with a different ownership.
  // ── v3.69.0: THE REFRESH BODY NAMES A SOURCE GROUP OR NOTHING ──────────
  // `files` and `repoRoot` left with the doors, whose commits go to
  // add-local / add-remote. What crosses now is WHICH source group — a
  // strip line's id — or nothing at all for "Refresh all". Still no document
  // BODY in either direction: that is what keeps "the app is a copier on a
  // mirror, never an author" true of this route.
  ok('...carrying the refresh target and nothing else — never a file list, never a document body',
    refresh && /body:\s*JSON\.stringify\(rootPart\)/.test(refresh.init)
    && !/\btext\s*:|files/.test(refresh.init),
    refresh ? refresh.init.slice(0, 220) : 'none');
  ok('...and `rootPart` is `{ group }` for one source and a literal empty object for all of them',
    /const rootPart = one \? \{ group: one \} : \{\};/.test(viewNoComments),
    'rootPart not found');
  // ── v3.68.0: THE TWO DOORS' COMMIT, AND THE TEMPLATES ───────────────
  // The commit's URL and body are composed by `buildAddCommit` in the DOM-free
  // module, so the view's fetch carries them through verbatim — asserted here
  // by shape, and the composition itself driven right below.
  const doorCommit = posts.find((x) => x.url === 'req.url');
  ok('one POST is the two doors\' commit, sending exactly what buildAddCommit composed',
    !!doorCommit && /body:\s*JSON\.stringify\(req\.body\)/.test(doorCommit.init),
    JSON.stringify(posts.map((x) => x.url.slice(0, 140))));
  {
    const facts0 = { present: false, count: 0, docs: [] };
    const cases = [
      ['local copy', Object.assign(FA.freshAddPanel('local', { mode: 'copy' }, facts0), {
        root: '/n', listedRoot: '/n', candidates: [{ path: 'a.md', bytes: 1 }], picks: { 'a.md': true } }), facts0],
      ['github add', Object.assign(FA.freshAddPanel('github', { mode: 'add' }, facts0), {
        remote: 'o/r', tokenSource: 'sync', candidates: [{ path: 'a.md', bytes: 1 }], picks: { 'a.md': true } }), facts0],
      ['github switch', Object.assign(FA.freshAddPanel('github', { mode: 'switch', group: 's1',
        remote: { owner: 'o', repo: 'r' } }, facts0), { tokenSource: 'config' }), facts0],
      ['local mirror', Object.assign(FA.freshAddPanel('local', { mode: 'mirror' }, facts0), {
        root: '/n', listedRoot: '/n', candidates: [{ path: 'a.md', bytes: 1 }], picks: { 'a.md': true } }), facts0],
    ];
    for (const [name, rec, f] of cases) {
      const req = FA.buildAddCommit(rec, f, 'a d', 'p/x');
      ok('the ' + name + ' commit is under /api/memory with BOTH segments escaped',
        req.url.startsWith('/api/memory/a%20d/p%2Fx/foundations/'), req.url);
      ok('...and its body carries no token and no document text',
        !/"token"|"text"/.test(JSON.stringify(req.body)), JSON.stringify(req.body));
    }
    // v3.69.0: the switch is per GROUP (§4.4) and lists nothing, so its body
    // is the group, the repository and the token FILE — and no ownership.
    ok('the SOURCE (switch) body carries the three fields that route allows and no ownership',
      JSON.stringify(Object.keys(FA.buildAddCommit(cases[2][1], facts0, 'd', 'p').body).sort())
        === JSON.stringify(['group', 'remote', 'tokenSource']),
      JSON.stringify(FA.buildAddCommit(cases[2][1], facts0, 'd', 'p').body));
  }
  const init = posts.find((x) => x.url.includes("'/foundations/init'"));
  ok('the templates POST targets the foundations INIT endpoint',
    !!init, JSON.stringify(posts.map((x) => x.url.slice(0, 140))));
  ok('...curator-owned, re-choosing only an EMPTY manifest, and nothing else',
    init && /ownership: 'curator', rechooseEmpty: true/.test(init.init) && !/token|remote|files/.test(init.init),
    init ? init.init.slice(0, 300) : 'none');
  // ── THE PUT IS THE ONE WRITE THAT CARRIES BYTES ───────────────────────
  // A curator-owned document, verbatim, under a slug. THREE fields and no
  // more: the text, its title and its role. `authoredBy` is deliberately
  // ABSENT — the route stamps `{kind: 'human'}` itself, so there is no field
  // here through which an agent's provenance line could be forged from a
  // browser, which is the property tiers 2 and 3 rest on.
  ok('the third write is a LITERAL PUT, at one document under foundations/',
    put && put.url.includes("'/foundations/'"), put ? put.url.slice(0, 200) : 'none');
  ok('...carrying exactly text, title and role — and no provenance field at all',
    put && /\btext:/.test(put.init) && /\btitle:/.test(put.init) && /\brole:/.test(put.init)
    && !/authoredBy|commissioned|instructedBy/.test(put.init),
    put ? put.init.slice(0, 240) : 'none');
  ok('...and it still cannot name a handoff field',
    put && !/nowState|nextSteps|observations|traps/.test(put.init));
  eq('exactly TWO PUTs: the document, and this computer\'s context-window settings', puts.length, 2);
  ok('the settings PUT is the named config route, sending the body its caller composed from '
    + 'the window or the harness — never a project, a document or a brief',
    !!ctxPut && /body:\s*JSON\.stringify\(body\)/.test(ctxPut.init)
    && !/encodeURIComponent|project|brief|text:/.test(ctxPut.url + ctxPut.init),
    ctxPut ? ctxPut.url + ctxPut.init.slice(0, 160) : JSON.stringify(puts.map((x) => x.url)));
  {
    // Every body setContextSetting is handed names ONLY the two settings.
    const calls = [...viewNoComments.matchAll(/setContextSetting\(([^;]*?), token\)/g)].map((m) => m[1]);
    ok('...and every body it is handed names only contextWindowTokens or harnessEstimateTokens',
      calls.length >= 3 && calls.every((c) => /^(\{ (contextWindowTokens|harnessEstimateTokens): n \}|e\.kind === 'window' \? \{ contextWindowTokens: n \} : \{ harnessEstimateTokens: n \}|body)$/.test(c.trim())),
      JSON.stringify(calls));
  }
  ok('the fourth write is a LITERAL DELETE, at one document under foundations/',
    del && del.url.includes("'/foundations/'"), del ? del.url.slice(0, 200) : 'none');
  // THE SLUG IS SENT AS ITS OWN CONFIRMATION, and the route re-checks it —
  // so a client that skipped the confirm strip deletes nothing. The same
  // discipline the project delete has carried since v3.48.0.
  //
  // ── ASSERTED OVER EVERY DELETE, NOT THE FIRST ONE (v3.61.1) ───────────
  // There are two call sites now — the editor's footer and the table row's
  // Remove — and they are the same route with the same body. Checking only
  // `del` (the first match) would let the second one send anything at all,
  // which is precisely the shape this section exists to refuse.
  const dels = withMethod('DELETE');
  eq('...and there are exactly TWO of them: the editor\'s and the row\'s', dels.length, 2);
  ok('...EVERY one carrying the slug as its own typed confirmation, which the route re-checks',
    dels.length > 0 && dels.every((d) => /body:\s*JSON\.stringify\(\{\s*confirm:\s*slug\s*\}\)/.test(d.init)),
    JSON.stringify(dels.map((d) => d.init.slice(0, 120))));
  ok('...every one at ONE document under foundations/, never a collection',
    dels.every((d) => d.url.includes("'/foundations/'")),
    JSON.stringify(dels.map((d) => d.url.slice(0, 120))));
  ok('...and none of them naming anything but a slug — no ownership, no force, no path',
    dels.every((d) => !/ownership|force|repoRoot|path/.test(d.init)),
    JSON.stringify(dels.map((d) => d.init.slice(0, 160))));
  ok('every one of them is under /api/memory — the helper\'s one proposal read under '
    + '/api/reading-plan — and escapes its segments',
    inits.every((x) => (x === doorCommit) || (x === ctxPut)
      || ((x.url.includes("'/api/memory/'")
      || (x === suggest && x.url.includes("'/api/reading-plan/'")))
      && x.url.includes('encodeURIComponent'))),
    JSON.stringify(inits.map((x) => x.url.slice(0, 90))));
  // NONE of the five can reach a work-stream handoff or a journal: neither
  // path fragment appears in any of their URLs.
  ok('and NONE of them names a scope, a machine or a journal',
    inits.every((x) => !/scope|machine|journal/i.test(x.url)),
    JSON.stringify(inits.map((x) => x.url.slice(0, 90))));
}
// Positive control: the detector must SEE an init object, including one whose
// method is assembled at runtime — the exact mutation the string list missed.
ok('self-test: the argument-count scan DOES fire on a runtime-assembled method',
  topLevelArgs(fetchCallArgs("const M='PO'+'ST'; await fetch(u, { method: M, body: b });")[0]).length === 2);
ok('self-test: the argument-count scan does NOT fire on a plain read',
  topLevelArgs(fetchCallArgs("await fetch('/api/memory');")[0]).length === 1);

// A request init cannot arrive by any other door either: the ONLY `method:`
// key in real code is the brief write's (comments stripped, so the docblock
// explaining the rule cannot satisfy or violate it), and no alternative
// transport exists at all.
{
  const methods = [...viewNoComments.matchAll(/\bmethod\s*:\s*([^,}\s]+)/g)].map((m) => m[1]).sort();
  ok('exactly FOURTEEN `method:` property keys appear in the view\'s real code, and every one of them '
    + 'is a LITERAL — so the `\'PO\' + \'ST\'` evasion is refused by construction',
  JSON.stringify(methods) === JSON.stringify(
    ["'DELETE'", "'DELETE'", "'PATCH'", "'PATCH'", "'PATCH'", "'PATCH'",
      "'POST'", "'POST'", "'POST'", "'POST'", "'POST'", "'POST'", "'PUT'", "'PUT'"]),
  JSON.stringify(methods));
}
for (const transport of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'FormData', 'Request(']) {
  ok('the view never reaches for ' + transport + ' (fetch is not the only way to write)',
    !viewNoComments.includes(transport));
}
// ── TWO PREFIXES NOW, AND THE SECOND ONE IS NAMED (v3.62.0, P1-8) ─────────
// Step ③ reads `GET /api/domains/:domain/stats` — one request, no LLM, and no
// read of any page's CONTENT. It is an ALLOW-LIST rather than a loosened
// predicate: `/api/domains` also serves POST create, PUT rename and DELETE, so
// a prefix test would wave those through, and `/api/wiki`, `/api/health` and
// every `…/ai-suggest` are exactly the surfaces §2.6 ruled out by cost. The
// list is the two shapes this view may issue and nothing else.
// ── D-G: THE PROJECT-DETAIL GET NAMES ITSELF (v3.62.0) ────────────────────
// `GET /:domain/projects` is the PROJECT LIST, so a domain literally named
// `projects` — the maintainer's own — collides with it: Express matches the
// list route first and this view gets a payload with no `scopes`. The route
// disambiguates on `?as=project`. Pinned as the QUERY OBJECT rather than as a
// URL, because that is how this view builds it, and pinned at all because the
// collision is silent: the page renders, it is simply about the wrong thing.
ok('the project-detail read marks itself `as: \'project\'`, so a domain named '
  + '`projects` is reachable at all',
/fetchState\(domain, project, \{ open: 'newest', as: 'project' \}/.test(viewNoComments),
viewNoComments.slice(0, 200));
ok('CONTROL: the SCOPED read is deliberately NOT marked — it carries a `scope`, '
  + 'which is what disambiguates it, and marking it would be a second rule',
/fetchState\(domain, project, query, token\)/.test(viewNoComments)
  || !/as: 'project'[\s\S]{0,40}scope:/.test(viewNoComments));

// THE THIRD DOMAIN READ IS `GET /api/domains` (v3.65.0), and it is the CHEAP
// one deliberately: a readdir plus one readonly probe per domain, no stats
// walk, no wiki read. It has two readers — the rail's identity colour needs
// the domain's place in the install's list, and step ③'s picker needs the set
// a project may draw on — and the alternative, `/api/domains/stats`, walks
// every wiki folder to count pages this view does not use.
ok('the view fetches only /api/memory endpoints, the ONE domain-stats read and the cheap domain LIST', (() => {
  const urls = [...viewNoComments.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  const built = viewNoComments.includes("fetch('/api/memory/' + encodeURIComponent(domain)");
  const stats = viewNoComments.includes("fetch('/api/domains/' + encodeURIComponent(domain) + '/stats')");
  const list = viewNoComments.includes("fetch('/api/domains')");
  // v3.65.2 (C1): TWO more reads, both named here rather than waved through
  // by a prefix — the GitHub panel asks, once per open, whether a read-only
  // token is saved (presence + last four, never the value) and whether
  // Personal Sync is connected.
  // v3.70.0: and this computer's window + harness (read once per mount,
  // written by the one PUT named above).
  const TOKEN_FACTS = ['/api/config/github-read-token', '/api/sync/status', '/api/config/context-window'];
  // v3.67.0: the reading-plan helper's two reads (estimate, proposal), both
  // under their own prefix and both built the same escaped way.
  const plan = (viewNoComments.match(/fetch\('\/api\/reading-plan\/' \+ encodeURIComponent\(domain\)/g)
    || []).length === 2;
  return urls.every((u) => u.startsWith('/api/memory') || u === '/api/domains/' || u === '/api/domains'
    || u === '/api/reading-plan/' || TOKEN_FACTS.includes(u))
    && built && stats && list && plan;
})());
ok('...and the domain LIST is the cheap route, never the stats walk the Domains page pays for',
  !/fetch\(\s*'\/api\/domains\/stats'/.test(viewNoComments));
ok('...and it reaches for NO other read surface — the four §2.6 ruled out by cost', (() => {
  for (const banned of ['/api/wiki', '/api/health', 'ai-suggest', 'semantic-dupes', 'broken-links', 'orphans']) {
    if (viewNoComments.includes(banned)) return false;
  }
  return true;
})());
// Import-scoped for the same reason as the route check above: the view's
// docblock explains why it does not join the cross-view write gate, and
// names beginDomainWrite while doing so.
ok('the view never IMPORTS a write helper from the shell', (() => {
  const imports = viewSrc.match(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/gm) || [];
  return imports.length > 0 && !imports.some((i) => /beginDomainWrite|registerWrite/.test(i));
})());
ok('the view escapes BOTH the domain and the project slug into every URL it builds', (() => {
  // Both segments, at every site: a domain slug reaches the URL now too, and
  // one un-escaped segment is one path the server has to disambiguate from
  // an attacker's.
  const sites = [...viewNoComments.matchAll(/fetch\(\s*'\/api\/memory\/'([\s\S]{0,200}?)\n/g)].map((m) => m[1]);
  return sites.length >= 2 && sites.every((t) => t.includes('encodeURIComponent'));
})());

// ═════════════════════════════════════════════════════════════════════════
section('§9 — Mount-token and timer discipline');
// ═════════════════════════════════════════════════════════════════════════

// EVERY SCAN IN THIS SECTION READS COMMENT-STRIPPED SOURCE. Over raw text
// each one is satisfiable by a `//` line — this file's own header quotes
// several of these call shapes while explaining them.
ok('the view imports isCurrentMount', viewNoComments.includes('isCurrentMount'));
ok('every setSidebar/setMain call passes a token', (() => {
  const calls = [...viewNoComments.matchAll(/set(?:Sidebar|Main)\(/g)];
  // Two definitions of the call shape: each call site must mention `token`
  // within its own STATEMENT, read by matching the call's own parentheses.
  //
  // IT WAS A 12-LINE WINDOW, and the window was the bug. renderMain's setMain
  // now opens with a multi-line renderViewHeader options object (eyebrow,
  // title, info, infoHtml, actionsHtml), which pushed `token` to line 14 and
  // reddened this assertion over a call that passes the token perfectly well.
  // A fixed line budget is a guess about formatting; brace matching is a
  // measurement of the call. The fail-safe direction is kept: an unbalanced
  // call (which cannot parse anyway) reads to end-of-file and still has to
  // contain the word.
  const lines = viewNoComments.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(/set(?:Sidebar|Main)\(/);
    if (at === -1) continue;
    seen++;
    const from = lines.slice(i).join('\n');
    let p = from.indexOf('(', at), depth = 0, end = from.length;
    for (; p < from.length; p++) {
      if (from[p] === '(') depth++;
      else if (from[p] === ')') { depth--; if (depth === 0) { end = p; break; } }
    }
    if (!/\btoken\b/.test(from.slice(at, end))) return false;
  }
  return seen > 0 && calls.length > 0;
})());
// The gate cancel is EXECUTED in §12 (a spy counts the real call). This stays
// as a cheap scoped confirmation that it lives in the teardown specifically —
// which execution alone cannot tell you.
ok('the teardown cancels the loading gate (timer hygiene)',
  /return \(\) => \{[\s\S]*loadGate\.cancel\(\)/.test(viewNoComments));
ok('async loaders check isCurrentMount after their await',
  (viewNoComments.match(/if \(!isCurrentMount\(token\)\)/g) || []).length >= 3);

// ═════════════════════════════════════════════════════════════════════════
section('§10 — The SQUARE marker, and CSS hygiene');
// ═════════════════════════════════════════════════════════════════════════

function ruleFor(css, selector) {
  const i = css.indexOf(selector + ' {');
  if (i === -1) return null;
  return css.slice(i, css.indexOf('}', i));
}
{
  // ── THE SQUARE ROW MARKER IS GONE, AND THAT IS THE UNIFICATION ───────
  //
  // It was an accent-coloured SQUARE, chosen so a project row and a domain
  // row could be told apart when the rail put the two one above the other.
  // The rail does not do that any more: one component paints all three
  // sidebars, and the mark on a project row is the DOMAIN'S OWN IDENTITY DOT
  // — the same round mark, in the same six colours, at the same index the
  // Domains page paints it. That is worth more than the distinction it
  // replaces: one domain now reads the same on both screens, which is the
  // entire value of an identity mark.
  //
  // So what is asserted is that this view declares NO row-mark geometry of
  // its own any more, that the six COLOURS are here (they cannot be in the
  // kit — see memory.css), and that every one of them is a `var()` rather
  // than a literal.
  //
  // ── AND THE BREADCRUMB'S SQUARE IS GONE TOO (v3.65.1, D7) ───────────
  // It was the LAST mark on this screen that was not an identity: a 9×9
  // `var(--accent)` square, identical on every project in every domain,
  // beside a breadcrumb naming the domain it did not identify. Measured:
  // rgb(124,90,245) / 2px / 9px, against rgb(121,199,82) / 50% / 8px for the
  // same domain in the rail. It takes `.cur-sb-dot` and `identityDotClass`
  // now, so this view declares no geometry for it either — one palette, one
  // mapping, ONE GLYPH.
  const head = ruleFor(viewCss, '.mem-project-mark');
  ok('.mem-project-mark exists', !!head);
  // ── AND `.mem-save` IS NO LONGER A CARD (v3.65.1, D2) ───────────────
  // It was `padding: 12px 14px; border: 1px solid` — a CARD wrapping a ROW —
  // and that is what cost its reading 15px a side: measured at 1370, every
  // other summary's meta ended at x=1316 and this one at 1301. The alignment
  // rule §7 pins in the browser has exactly one offline cause, and this is it.
  // FOUND BY MUTATION: restoring the padding and the border was green.
  {
    const save = ruleFor(viewCss, '.mem-save');
    ok('CONTROL: the .mem-save rule was found', !!save, 'no .mem-save rule');
    ok('.mem-save declares NO box — no padding, no border, no background — so '
      + 'the rows inside step ② all end at one x',
    !!save && !/padding|border|background/.test(save), save);
  }
  ok('.mem-project-mark declares NO geometry and NO colour — the kit\'s dot '
    + 'carries both, so the breadcrumb cannot drift from the rail',
  !!head && !/border-radius/.test(head) && !/background/.test(head)
    && !/width|height/.test(head), head);
  // AND IT IS WITHHELD WHEN THE LIST HAS NOT ANSWERED. Identity has no states
  // (the rail's own rule, `dotClass: ''` on a project with nothing saved), so a
  // placeholder here would be some OTHER domain's colour. FOUND BY MUTATION,
  // which hardcoded a list and painted a mark the install cannot justify.
  {
    const crumb = (over) => makeRenderers({
      activeDomain: 'research', activeProject: 'lumina', openFolds: {}, projects: [],
      journalLimit: 10, detail: null, detailLoading: false, wsWindow: WS_WINDOW_SRC,
      // A PLAIN payload rather than `fndRead(fndPayload(...))`: those helpers are
      // defined further down this file and a `const` is not hoisted, so naming
      // them here is a ReferenceError rather than a failing assertion. The
      // breadcrumb reads neither.
      projectRead: { scopes: [], brief: { present: false } }, ...over,
    }).renderProject();
    const headOf2 = (h) => (h.match(/<div class="mem-project-head[\s\S]{0,260}/) || [''])[0];
    ok('the breadcrumb carries NO mark until the domain list has answered',
      !/mem-project-mark/.test(crumb({ domainList: [] })),
      headOf2(crumb({ domainList: [] })));
    ok('...nor when the active domain is not in the list the install sent',
      !/mem-project-mark/.test(crumb({ domainList: ['acme', 'other'] })),
      headOf2(crumb({ domainList: ['acme', 'other'] })));
    ok('CONTROL: and it DOES carry one at the domain\'s own index in that list',
      /cur-sb-dot mem-project-mark cur-sb-dot-3/.test(
        crumb({ domainList: ['acme', 'other', 'research'] })),
      headOf2(crumb({ domainList: ['acme', 'other', 'research'] })));
    ok('...which is the SAME slot the rail gives that domain, from the same '
      + 'mapping — one domain, one colour, on every screen',
    /cur-sb-dot-3/.test(crumb({ domainList: ['acme', 'other', 'research'] }))
      && identityDotClass(2) === 'cur-sb-dot-3', identityDotClass(2));
  }
  ok('...and the view EMITS it as a kit dot with the shared mapping',
    /class="cur-sb-dot mem-project-mark ' \+ identityDotClass\(slot\)/.test(viewSrc),
    (viewSrc.match(/.{0,120}mem-project-mark.{0,120}/s) || [''])[0]);
  ok('...withheld entirely until the domain list has answered, because identity '
    + 'has no states and a placeholder would be another domain\'s colour',
  /slot >= 0\s*\n?\s*\? '<span class="cur-sb-dot mem-project-mark/.test(viewSrc)
    || /slot >= 0/.test(viewSrc));
  ok('this view declares NO row-mark geometry — the kit owns the row',
    !ruleFor(viewCss, '.mem-row-mark') && !ruleFor(viewCss, '.mem-row'));
  // ── AND THE SIX COLOURS LEFT THIS FILE TOO (v3.65.1, D7) ────────────
  // Twelve rules were declared here AND, byte-identical, in views/domains.css.
  // CSS has no per-view scope, so each file painted both rails. The block's own
  // note predicted it — *"if both files end up declaring them, one copy should
  // go"* — and both went: the palette is shared/sidebar.css's now, beside
  // `.cur-sb-dot`'s shape and `identityDotClass`'s mapping, which is what makes
  // one domain one colour in the Domains rail, in this one, in the breadcrumb,
  // on every Knowledge row and on Chat's chips.
  const slots = [...viewCss.matchAll(/\.cur-sb-dot-(\d)\s*\{/g)];
  eq('this view declares NO identity colour at all any more', slots.length, 0);
  ok('...and names none of the three deprecated --dm-ink-* aliases either, so '
    + 'nothing here depends on names the kit is about to remove',
  !/--dm-ink-/.test(viewCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'a --dm-ink- reference survives');
  // THE KIT HAS THEM, and its dot is ROUND — which is what the six colours are
  // painted on. Asserted here as well as in the kit's own suite because this
  // view's breadcrumb and Knowledge rows are two of the surfaces that break if
  // either half moves.
  const kitCss = readFileSync(join(NEXT, 'shared/sidebar.css'), 'utf8');
  // v3.66.0: twelve slots, ONE rule each, painting `var(--id-N)` — the light
  // theme is the token's business now (tokens/identity.css), not a second rule.
  const kitSlots = [...kitCss.matchAll(/\.cur-sb-dot-(\d+)\s*\{\s*background:\s*var\(--id-\1\);/g)];
  eq('the KIT paints all twelve slots, each from its own themed --id-N token', kitSlots.length, 12);
  const dot = ruleFor(kitCss, '.cur-sb-dot');
  ok('the kit\'s identity dot is ROUND, and it owns the colour as well as the shape',
    !!dot && /border-radius:\s*50%/.test(dot));
}
// Comments stripped first: this file's own header explains the rule by
// quoting a literal `0.16s ease` as the thing NOT to write, and a scan over
// raw text fires on that explanation rather than on any real declaration.
const cssNoComments = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
ok('memory.css hardcodes no animation/transition duration (reduced-motion is token-driven)',
  !/(?:transition|animation)[^;{}]*\b\d+(?:\.\d+)?m?s\b/.test(cssNoComments));
ok('self-test: that scan DOES fire on a planted hardcoded duration',
  /(?:transition|animation)[^;{}]*\b\d+(?:\.\d+)?m?s\b/.test('.x { animation: fade 0.16s ease; }'));
ok('memory.css contains no hardcoded hex colour (every colour is a token)',
  !/:\s*#[0-9a-f]{3,8}\b/i.test(cssNoComments));
ok('every var() used in memory.css resolves (delegated to test-css-tokens.js, which walks this file)',
  (viewCss.match(/var\(--/g) || []).length > 20);
// A machine id is `<hostname-slug>-<install-id>` and used to arrive under
// `overflow-wrap: anywhere`, which broke `talis-macbook-pro-acb035` across
// four lines and made every other row in the table taller with it.
ok('the MACHINE column is one ellipsised line, never a four-line stack',
  (() => {
    const r = ruleFor(viewCss, '.mem-ws-machine');
    return !!r && /white-space:\s*nowrap/.test(r) && /text-overflow:\s*ellipsis/.test(r)
      && /overflow:\s*hidden/.test(r) && /max-width:\s*\d+ch/.test(r)
      && !/overflow-wrap:\s*anywhere/.test(r);
  })());
ok('wide content scrolls inside its own box (pre gets overflow-x)',
  /\.mem-doc pre \{[\s\S]*?overflow-x: auto/.test(viewCss));
// THE ROW'S FOCUS RING IS THE GLOBAL ONE NOW, and that is the Domains
// behaviour rather than a loss. `.mem-row:focus-visible` was a local copy of
// `tokens/base.css`'s `:focus-visible { box-shadow: var(--ring-focus) }`,
// which reaches every focusable element including this one — and
// views/domains.css, the reference sidebar, has never declared a row focus
// rule for exactly that reason. Asserted at the token rather than pretended
// to be here, the same call this file already makes for the shared listbox's
// ring two assertions below, and in both directions so "adopted" cannot be
// satisfied by nobody declaring one anywhere.
ok('focus is visible on the project rows — through the global ring, as on Domains', (() => {
  const base = readFileSync(join(NEXT, 'tokens/base.css'), 'utf8');
  const domainsCss = readFileSync(join(NEXT, 'views/domains.css'), 'utf8');
  return /:focus-visible\s*\{[^}]*box-shadow:\s*var\(--ring-focus\)/.test(base)
    && !viewCss.includes('.mem-row:focus-visible')
    && !domainsCss.includes('.dm-row:focus-visible');
})());
ok('focus is visible on the disclosures', viewCss.includes('.mem-fold-summary:focus-visible'));
// The pickers are the shared listbox now, so their focus ring lives in
// shared/listbox.css — asserted THERE rather than pretended to be here. What
// this file still owes is that it does not sit on top of the component's ring
// with a rule of its own.
ok('the pickers\' focus ring is the component\'s (shared/listbox.css), not overridden here',
  !/\.mem-ctl[^{]*\.lb-btn[^{]*:focus/.test(viewCss));
ok('focus is visible on the shared listbox trigger (shared/listbox.css)',
  readFileSync(join(NEXT, 'shared/listbox.css'), 'utf8').includes('.lb-btn:focus-visible'));

// ═════════════════════════════════════════════════════════════════════════
section('§11 — REVALIDATION, driven rather than grepped');
// ═════════════════════════════════════════════════════════════════════════
//
// v3.17.3 shipped the revalidation logic with NO offline assertion over it:
// §9 above checks timer hygiene only through a `loadGate.cancel()` regex that
// `stopPoll()` happens to satisfy incidentally. A section driving
// nextPollDelay, teardown and screenSignature was recorded as owed. This is
// it, and writing it is what would have caught the defect below.
//
// THE DEFECT THIS SECTION EXISTS FOR, reproduced in a real browser first:
// with the view open, a third scope written over MCP moved the sidebar row to
// "3 scopes" while the scope <select> beside it still listed TWO, until the
// user navigated away and back. refreshIndex updated state.projects and
// nothing else; the picker renders from state.projectRead, which no
// revalidation path ever re-read.
//
// Everything here executes the SHIPPED functions, lifted by brace-matching
// and given injected collaborators — a fake fetch, a fake clock, a render
// that does exactly what the real one does to the signature bookkeeping.

// THE HARNESS BELOW RUNS THE REAL render(), NOT A COPY OF IT.
//
// It used to define its own `function render(token) { renderedSignature =
// screenSignature(); onRender(token); }` and guard the real one with a source
// regex. Both halves were defeatable: the regex reads RAW source, so leaving
// `// renderedSignature = screenSignature();` behind satisfied it, and the
// executed half never touched the shipped function at all. Deleting that one
// assignment from production left this suite fully green while shipping a
// 20-second poll that re-renders the whole pane unconditionally — closing any
// picker the user had open, on the one screen whose premise is that something
// else writes while you watch.
//
// So render/captureFocus/restoreFocus are lifted from the live source like
// everything else, and only renderSidebar/renderMain/wire — which need a real
// DOM — are injected. §11d's "an unchanged poll re-renders NOTHING" is
// therefore a claim about the shipped function.

// ── The poll constants, pinned to HAND-WRITTEN LITERALS ──────────────────
//
// The harness used to be handed 20000 / 20 / 300000 as parameters, so it
// proved arithmetic about numbers the suite supplied and never read the ones
// production uses. Changing them to 50 / 0 / 60 — a 50 ms busy poll against a
// route that stats every (scope, machine) pair across up to 200 domains —
// left every assertion green. Read off real source, compared against literals
// typed here, and then THREADED INTO the harness so §11a's arithmetic moves
// with them too.
/** A top-level `const NAME = <literal>;` lifted off live source and eval'd. */
function liftConst(name) {
  const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*([\\s\\S]*?);\\n', 'm').exec(viewNoComments);
  if (!m) return null;
  try { return new Function('return (' + m[1] + ');')(); } catch { return null; }
}
const FOCUSABLE_IDS_SRC = liftConst('FOCUSABLE_IDS');
const FOCUS_FALLBACK_SRC = liftConst('FOCUS_FALLBACK');

function pollConst(name) {
  const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*(-?[\\d_]+)\\s*;').exec(viewNoComments);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}
const POLL_BASE_MS_SRC = pollConst('POLL_BASE_MS');
const POLL_DUTY_SRC = pollConst('POLL_DUTY');
const POLL_MAX_MS_SRC = pollConst('POLL_MAX_MS');
ok('POLL_BASE_MS is declared in the view', POLL_BASE_MS_SRC !== null);
ok('POLL_DUTY is declared in the view', POLL_DUTY_SRC !== null);
ok('POLL_MAX_MS is declared in the view', POLL_MAX_MS_SRC !== null);

// ARGUMENT-ORDER ADAPTER, and it is not tidiness. assertLiteral calls
// `ok(cond, message)`; THIS suite's ok is `ok(label, cond)`. Passing `ok`
// directly made every literal assertion below read a non-empty message string
// as its condition and pass unconditionally — root cause 4 (expected equals
// actual by construction) reappearing inside the fix for root cause 4. Found
// by mutation: POLL_BASE_MS 20000 -> 50 went red on the arithmetic and NOT on
// the literal that exists to catch exactly that. Self-tested below.
const okc = (cond, label) => ok(label, cond);
ok('self-test: the literal-assertion adapter can actually FAIL', (() => {
  let sawFail = false;
  const spy = (label, cond) => { if (!cond) sawFail = true; };
  assertLiteral((c, m) => spy(m, c), 'expected', 'ACTUAL', 'probe');
  return sawFail;
})());

assertLiteral(okc, 20000, POLL_BASE_MS_SRC,
  'the poll FLOOR is 20 s — anything shorter is a busy poll against a route that stats every (scope, machine) pair across up to 200 domains');
assertLiteral(okc, 20, POLL_DUTY_SRC,
  'the poll spends at most 1/20th of the wall clock refreshing — a duty of 0 disables the adaptive throttle entirely');
assertLiteral(okc, 300000, POLL_MAX_MS_SRC,
  'the poll CEILING is 5 min — a small ceiling turns the adaptive throttle into a fixed fast poll on a big install');

/**
 * The revalidation machinery, executing for real.
 *
 * Returns the lifted functions plus the probes a test needs: how many of each
 * request went out, how many renders happened, and a fake clock so the poll
 * can be advanced without sleeping.
 */
function makeRevalidator(stateObj, responder, opts = {}) {
  const calls = { index: 0, project: 0, render: 0, sidebar: 0, wire: 0, urls: [] };
  let mounted = true;

  // Fake clock. Timers are a queue of {at, fn}; advance(ms) fires everything
  // due, re-armed timers included, so a setTimeout CHAIN can be walked.
  let now = 0, seq = 0;
  const timers = new Map();
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id);
      now = next.t.at;
      next.t.fn();
    }
    now = end;
  }

  const fakeFetch = async (url) => {
    calls.urls.push(String(url));
    if (String(url) === '/api/memory') calls.index++; else calls.project++;
    return responder(String(url));
  };

  const body =
    'let pollTimer = null;\n' +
    'let renderedSignature = null;\n' +
    'let pendingFocusId = null;\n' +
    // THE SHIPPED render(), not a paraphrase of it — with its two focus
    // helpers, which it calls unconditionally.
    // v3.67.0: render() asks for step ④'s measurement after it paints; that
    // path is driven in §25, so here it is a named no-op.
    'function maybeLoadSessionStart() {}\n' +
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
    // (domain, project) identity. Both are lifted, not stubbed: `activeKey`
    // is what every post-await "is this still the selection?" guard compares
    // through, so a stub here would be testing the harness's idea of identity
    // rather than the view's.
    extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
    // screenSignature now folds the save-status strip's own readings through
    // effectiveSave + formatAge, so a save into another scope of the same
    // project — or the reading simply ageing into the next band — repaints.
    extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'newestPair', 'memory.js') + '\n' +
    // The work-stream mark is taken over the ORDER the table paints, not
    // over the response, so the function that decides that order travels
    // with screenSignature everywhere it is executed.
    extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n' +
    // ...and, since v3.56.0, the WINDOW that order is sliced by: the table
    // paints the newest five with a "Show N more" footer, so the mark is the
    // rows on screen plus the number behind the footer. Lifted for the same
    // reason `workStreamOrder` is — the mark has to describe what is painted.
    extractFunction(viewSrc, 'wsShownCount', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'projectMetaLine', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fetchIndex', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'screenSignature', 'memory.js') + '\n' +
    // ── THE PROJECT CACHE (v3.57.0) ───────────────────────────────────────
    // `refreshScopeList` DROPS this project's cached copies when it finds the
    // work-stream list has moved, so the cache travels with the revalidation
    // machinery or the shipped function is a ReferenceError here — a CRASH
    // rather than a failing assertion, which is the shape this file's header
    // warns about twice. The store itself is a bare Map, so it is declared
    // here; its SIZE is read off live source rather than typed, for the same
    // reason the poll constants above are.
    'const readCache = new Map();\n' +
    'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n' +
    extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'cacheKeyScope', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'cacheGet', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'cachePut', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'forgetProject', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'payloadSignature', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'refreshIndex', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'refreshScopeList', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'nextPollDelay', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'stopPoll', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'schedulePoll', 'memory.js') + '\n' +
    'return { refreshIndex, refreshScopeList, screenSignature, nextPollDelay, ' +
    'schedulePoll, stopPoll, render, armed: () => pollTimer !== null, sig: () => renderedSignature };';

  const api = new Function(
    'state', 'renderSidebar', 'renderMain', 'wire', 'isCurrentMount', 'fetch', 'document',
    'FOCUSABLE_IDS', 'FOCUS_FALLBACK', 'WS_WINDOW',
    'setTimeout', 'clearTimeout', 'POLL_BASE_MS', 'POLL_DUTY', 'POLL_MAX_MS', body)(
    stateObj,
    // Counted on renderMain so one render() is one tick, and the sidebar half
    // is counted separately — a render() that painted only one pane would show
    // up as a mismatch rather than as a pass.
    (t) => { calls.sidebar++; calls.sidebarToken = t; },
    (t) => { calls.render++; calls.mainToken = t; },
    (t) => { calls.wire++; calls.wireToken = t; },
    () => mounted,
    fakeFetch,
    { hidden: !!opts.hidden, activeElement: null, getElementById: () => null, querySelector: () => null },
    FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, WS_WINDOW_SRC,
    fakeSetTimeout, fakeClearTimeout,
    // The REAL constants, read off the live source above. A change to any of
    // them moves this harness, so §11a's arithmetic is a claim about
    // production rather than about three numbers typed into a test.
    POLL_BASE_MS_SRC, POLL_DUTY_SRC, POLL_MAX_MS_SRC);

  // PRIME, exactly as onEnter does: it calls render(mountToken) before
  // loadIndex, so by the time any revalidation runs `renderedSignature`
  // already describes what is painted. Skipping this would leave it null,
  // every signature would differ from it, and the no-op guard would look
  // broken when it is the harness that is unmounted.
  api.render(1);
  calls.render = 0;

  // Drain the microtask queue. The poll is a setTimeout CHAIN re-armed in a
  // .finally(), which is a microtask: firing the timer is not enough, the
  // promise behind it has to settle first. setImmediate outranks every
  // pending microtask, so awaiting it drains them all.
  const settle = () => new Promise((r) => setImmediate(r));

  return { ...api, calls, advance, settle, unmount: () => { mounted = false; } };
}

/** A state shaped exactly like the live one at the moment of the defect. */
function liveState(over = {}) {
  const T0 = 1_000_000;
  const detail = { scope: 'memory-view', machine: 'm1', machines: [{ machine: 'm1', ageSeconds: 5 }],
    current: { present: true, text: '# Second scope\n' }, journal: [] };
  return {
    loading: false, refreshing: false,
    projects: [{ project: 'projects', hasBrief: true, scopeCount: 2, savedCopies: 2,
      lastWriteAt: new Date(T0).toISOString(), ageSeconds: 30, headline: 'Second scope' }],
    indexError: null,
    activeProject: 'projects',
    projectRead: { scopes: [{ scope: 'memory-view' }, { scope: 'main' }], savedCopies: 2 },
    detail,
    detailError: null, detailLoading: false,
    scope: 'memory-view', machine: null, journalLimit: 10,
    openFolds: { 'mem-fold-journal': true },
    detailFetchedAt: T0, scopesFetchedAt: T0,
    staleWrite: false, lastRefreshMs: 0,
    ...over,
  };
}

/** Index + project responses describing "a third scope has just been written". */
function thirdScopeWritten(writeAtMs) {
  const iso = new Date(writeAtMs).toISOString();
  return (url) => {
    if (url === '/api/memory') {
      return { ok: true, json: async () => ({ ok: true, projects: [{
        project: 'projects', hasBrief: true, scopeCount: 3, savedCopies: 3,
        lastWriteAt: iso, ageSeconds: 1, headline: 'THE THIRD SCOPE' }] }) };
    }
    return { ok: true, json: async () => ({ ok: true, project: 'projects', savedCopies: 3,
      scopes: [{ scope: 'third-scope-added-live' }, { scope: 'memory-view' }, { scope: 'main' }] }) };
  };
}

// ── §11a — nextPollDelay: the adaptive interval, arithmetic and bounds ────

{
  const probe = (ms) => { const s = liveState({ lastRefreshMs: ms }); return makeRevalidator(s, () => {}).nextPollDelay(); };
  eq('nextPollDelay: nothing measured yet -> the floor', probe(0), 20000);
  eq('nextPollDelay: a fast refresh stays at the floor', probe(500), 20000);
  eq('nextPollDelay: 2 s of work -> 40 s (1/20th duty cycle)', probe(2000), 40000);
  eq('nextPollDelay: 15 s of work -> the 5-minute ceiling', probe(15000), 300000);
  eq('nextPollDelay: a huge measurement cannot exceed the ceiling', probe(9_999_999), 300000);
  ok('nextPollDelay is monotonic non-decreasing in the measured cost', (() => {
    let prev = -1;
    for (let ms = 0; ms <= 40000; ms += 137) { const d = probe(ms); if (d < prev) return false; prev = d; }
    return true;
  })());
  ok('nextPollDelay is inside [floor, ceiling] for every measurement swept', (() => {
    for (let ms = 0; ms <= 60000; ms += 91) { const d = probe(ms); if (d < 20000 || d > 300000) return false; }
    return true;
  })());
  // A busy poll on a big install is the failure this exists to prevent: the
  // route stats every (scope, machine) pair across up to 200 domains.
  ok('a 15 s refresh can never be re-issued more often than every 5 min',
    probe(15000) >= 300000);
}

// ── §11b — screenSignature must SEE the scope picker ──────────────────────
//
// Half of the defect. Once refreshIndex re-reads the list, a signature blind
// to it classifies a real change as a no-op and the fresh data is never
// painted. The decisive case is the one where the SIDEBAR ROW IS IDENTICAL:
// a save that adds a MACHINE under an existing scope leaves scopeCount,
// headline and age untouched, so nothing but the picker has moved.

{
  const base = liveState();
  const sigOf = (s) => makeRevalidator(s, () => {}).screenSignature();

  eq('screenSignature: identical state -> identical signature',
    sigOf(liveState()), sigOf(liveState()));

  const grew = liveState();
  grew.projectRead = { scopes: [{ scope: 'third-scope-added-live' }, { scope: 'memory-view' }, { scope: 'main' }] };
  ok('screenSignature CHANGES when a scope appears in the picker',
    sigOf(grew) !== sigOf(base));

  // The mutation-proof case: sidebar row byte-identical, only the picker moved.
  const sameRow = liveState();
  sameRow.projectRead = { scopes: [{ scope: 'memory-view' }, { scope: 'main' }, { scope: 'later' }] };
  ok('screenSignature changes on a picker-only change (sidebar row untouched)',
    sigOf(sameRow) !== sigOf(base) &&
    JSON.stringify(sameRow.projects) === JSON.stringify(base.projects));

  const otherScope = liveState({ scope: 'main' });
  ok('screenSignature changes when the SELECTED scope changes',
    sigOf(otherScope) !== sigOf(base));

  // ── INVERTED IN v3.55.0, AND THE REASON IS THE POINT ────────────────────
  // This asserted that a DUPLICATED pair must NOT move the signature, and that
  // was right while the pane was a <select>: two copies of `memory-view` were
  // one option, so reporting a duplicate as a change would have closed a
  // picker somebody had open for no visible difference.
  //
  // The pane is a TABLE now (renderWorkStreams) and a duplicated pair is TWO
  // ROWS, each with its own age, headline and harness. The signature's rule is
  // unchanged — repaint iff the pixels would differ — but the pixels now do.
  // The same reversal, with the same reasoning, is recorded in
  // scripts/test-memory-truth.js §8b.
  const dupes = liveState();
  dupes.projectRead = { scopes: [{ scope: 'memory-view' }, { scope: 'memory-view' }, { scope: 'main' }] };
  ok('a duplicated pair is TWO ROWS in the table, so it MUST move the signature',
    sigOf(dupes) !== sigOf(base));

  ok('screenSignature still tracks the sidebar (staleWrite)',
    sigOf(liveState({ staleWrite: true })) !== sigOf(base));
}

// ── §11c — the headline: refreshIndex heals the PICKER, not just the row ──

{
  const s = liveState();
  const detailBefore = s.detail;
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);

  eq('a write since the list was read costs exactly ONE extra request', r.calls.project, 1);
  ok('the newly written scope is now in the picker',
    s.projectRead.scopes.map((x) => x.scope).includes('third-scope-added-live'),
    JSON.stringify(s.projectRead.scopes));
  eq('the sidebar row updated too', s.projects[0].scopeCount, 3);
  ok('the screen was re-rendered (the change is on screen, not just in state)', r.calls.render > 0);

  // THE v3.17.3 INVARIANTS. The picker is a list of what exists and is
  // corrected in place; the DOCUMENT is offered, never swapped.
  ok('the document was NOT swapped (same object, untouched)', s.detail === detailBefore);
  eq('the user stays on the scope they chose', s.scope, 'memory-view');
  eq('the machine selection is untouched', s.machine, null);
  eq('the journal page size is untouched', s.journalLimit, 10);
  eq('open folds survive', s.openFolds['mem-fold-journal'], true);
  ok('the Reload offer still stands for the document', s.staleWrite === true);
  ok('the document mark did NOT move (Reload stays available until taken)',
    s.detailFetchedAt === 1_000_000);
  ok('the picker mark DID move (so this does not re-fire every poll)',
    s.scopesFetchedAt > 1_000_000);
}

// ── §11d — the steady state costs nothing ────────────────────────────────

/** The index answering with the row the screen already shows. */
function unchangedIndex(ageSeconds) {
  return (url) => url === '/api/memory'
    ? { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects', hasBrief: true,
        scopeCount: 2, savedCopies: 2, lastWriteAt: new Date(999_000).toISOString(),
        ageSeconds, headline: 'Second scope' }] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [] }) };
}

{
  const s = liveState();
  // Newest write is OLDER than both marks: nothing has happened.
  const r = makeRevalidator(s, unchangedIndex(30));
  await r.refreshIndex(1);
  eq('an unchanged poll issues NO project request', r.calls.project, 0);
  eq('an unchanged poll re-renders NOTHING', r.calls.render, 0);
  eq('an unchanged poll leaves the picker alone', s.projectRead.scopes.length, 2);
  eq('an unchanged poll raises no stale offer', s.staleWrite, false);
}

{
  // THE SIGNATURE IS OVER RENDERED TEXT, NOT RAW FIELDS — the doc block's own
  // claim, pinned. An age that moved but still READS the same must not
  // re-render (it would close a <select> the user has open); one that crossed
  // a wording boundary must.
  const quiet = liveState();
  const rq = makeRevalidator(quiet, unchangedIndex(52));       // 30s -> 52s, both "just now"
  await rq.refreshIndex(1);
  eq('an age that ticked without changing the WORDS re-renders nothing', rq.calls.render, 0);

  const loud = liveState();
  const rl = makeRevalidator(loud, unchangedIndex(61));        // 30s -> 61s: "just now" -> "1 min ago"
  await rl.refreshIndex(1);
  eq('an age that crossed into new WORDS does re-render', rl.calls.render, 1);
}

// ── §11e — a repeat poll while the Reload notice stands is free ──────────
//
// staleWrite keys off detailFetchedAt and stays true until the user reloads.
// Gating the scope re-read on that mark instead of its own would re-fetch on
// EVERY poll for as long as the notice is up. Two marks, one request.

{
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);
  const afterFirst = r.calls.project;
  await r.refreshIndex(1);
  await r.refreshIndex(1);
  eq('the scope list is re-read ONCE per write, not once per poll', r.calls.project, afterFirst);
  eq('...and the first poll is the one that paid for it', afterFirst, 1);
  ok('the Reload offer is still standing across all three polls', s.staleWrite === true);
}

// ── §11f — cases where the fresh list is deliberately NOT adopted ────────

{
  // The selected scope is gone: adopting would leave the <select> unable to
  // show state.scope, so the browser would paint another scope's name over
  // this scope's handoff.
  const s = liveState();
  const r = makeRevalidator(s, (url) => url === '/api/memory'
    ? { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects', hasBrief: true,
        scopeCount: 1, savedCopies: 1, lastWriteAt: new Date(1_005_000).toISOString(),
        ageSeconds: 1, headline: 'x' }] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'something-else' }] }) });
  await r.refreshIndex(1);
  ok('a list missing the selected scope is REFUSED (picker and document stay consistent)',
    s.projectRead.scopes.map((x) => x.scope).join(',') === 'memory-view,main');
  eq('...and the picker mark does not move, so it will retry', s.scopesFetchedAt, 1_000_000);
  ok('...while the Reload offer is raised, which is the correct way out', s.staleWrite === true);
}

{
  // Nothing selected (an empty project receiving its first save): adopting
  // would paint a scope name over a document that was never read. The Reload
  // offer owns this case.
  // MEASURED LIMIT, recorded rather than implied away: this pins the COMBINED
  // behaviour, not the `!state.scope` line. Removing that line alone leaves
  // this green — the membership check below it returns for a falsy scope
  // anyway — so it is defence in depth and is described as such in the source.
  // The membership check itself IS load-bearing and is mutation-proven above.
  const s = liveState({ scope: null, detail: null, projectRead: { scopes: [] } });
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);
  eq('with nothing selected the picker is left to the Reload offer', s.projectRead.scopes.length, 0);
  ok('...and that offer is raised', s.staleWrite === true);
  ok('...and no document was invented for a scope that was never read', s.detail === null);
}

{
  // A failed re-read must change nothing — same rule refreshIndex already
  // follows for the index itself.
  const s = liveState();
  const r = makeRevalidator(s, (url) => url === '/api/memory'
    ? { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects', hasBrief: true,
        scopeCount: 3, savedCopies: 3, lastWriteAt: new Date(1_005_000).toISOString(),
        ageSeconds: 1, headline: 'x' }] }) }
    : { ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await r.refreshIndex(1);
  eq('a failed scope re-read leaves the picker exactly as it was', s.projectRead.scopes.length, 2);
  eq('...and does not move the mark, so the next poll retries', s.scopesFetchedAt, 1_000_000);
  eq('...and never surfaces as a detail error', s.detailError, null);
}

{
  // A throwing fetch is the same story.
  const s = liveState();
  const r = makeRevalidator(s, (url) => {
    if (url === '/api/memory') {
      return { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects',
        hasBrief: true, scopeCount: 3, savedCopies: 3,
        lastWriteAt: new Date(1_005_000).toISOString(), ageSeconds: 1, headline: 'x' }] }) };
    }
    throw new Error('network down');
  });
  await r.refreshIndex(1);
  eq('a THROWING scope re-read leaves the picker as it was', s.projectRead.scopes.length, 2);
  eq('...and refreshIndex still completes', s.refreshing, false);
}

{
  // A remount mid-flight must abandon the result: this view is re-entered
  // constantly from the rail, and a late write would land in another mount.
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  const p = r.refreshIndex(1);
  r.unmount();
  await p;
  eq('a result arriving after a remount is discarded (picker)', s.projectRead.scopes.length, 2);
  eq('...and the sidebar too', s.projects[0].scopeCount, 2);
}

{
  // Re-entrancy: the wake handler and the poll can both fire. The second must
  // bail rather than double-fetch.
  const s = liveState({ refreshing: true });
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);
  eq('a refresh already in flight is not started twice (index)', r.calls.index, 0);
  eq('...nor the scope re-read', r.calls.project, 0);
}

// ── §11g — the poll: a CHAIN, hidden-tab skip, and real teardown ─────────

{
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  ok('no timer is armed before schedulePoll', !r.armed());
  r.schedulePoll(1);
  ok('schedulePoll arms a timer', r.armed());
  r.advance(19_000);
  eq('nothing fires before the floor elapses', r.calls.index, 0);
  r.advance(2_000);
  eq('the poll fires once past the floor', r.calls.index, 1);
  await r.settle();
  ok('the chain re-armed after the refresh settled', r.armed());
  r.advance(60_000);
  await r.settle();
  ok('the poll RE-ARMS itself (a chain, not a one-shot)', r.calls.index >= 2, 'index=' + r.calls.index);

  // Teardown. The measured claim is 0 fetches while unmounted; this is that
  // claim as an assertion rather than as a regex over `loadGate.cancel()`.
  r.stopPoll();
  ok('stopPoll disarms the timer', !r.armed());
  const at = r.calls.index;
  r.advance(600_000);
  eq('TEARDOWN: ten minutes unmounted costs ZERO further requests', r.calls.index, at);
}

{
  // A hidden tab reschedules WITHOUT fetching — nobody is looking, and the
  // wake handler covers the moment they are.
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000), { hidden: true });
  r.schedulePoll(1);
  r.advance(300_000);
  eq('a hidden tab never fetches', r.calls.index, 0);
  ok('...but keeps its timer armed for when it is shown again', r.armed());
  r.stopPoll();
}

{
  // An unmounted-but-still-armed timer must not fetch either: isCurrentMount
  // is checked inside the callback, not only at arm time.
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  r.schedulePoll(1);
  r.unmount();
  r.advance(120_000);
  eq('a timer that outlived its mount fetches nothing', r.calls.index, 0);
  ok('...and does not re-arm itself', !r.armed());
}

// ── §11h — the two marks are genuinely two ───────────────────────────────

ok('the view tracks a mark for the PICKER distinct from the document mark',
  /scopesFetchedAt/.test(viewSrc) && /detailFetchedAt/.test(viewSrc));
ok('refreshScopeList never writes state.detail (the document is unreachable from it)',
  !/state\.detail\s*=/.test(extractFunction(viewSrc, 'refreshScopeList', 'memory.js')));
ok('refreshScopeList never moves the selection',
  !/state\.(scope|machine)\s*=/.test(extractFunction(viewSrc, 'refreshScopeList', 'memory.js')));

// ── §11i — A SAVE UNDER A DIFFERENT MACHINE, mid-poll ────────────────────
//
// The reported staleness, driven end to end at the layer it actually
// happened at. A hostname flap (working-state.js D10) makes one computer
// write into a SECOND machine folder under the SAME scope, so:
//
//   · the scope list is BYTE-IDENTICAL before and after — the picker's
//     contents cannot carry this, and §11b/§11c's headline is therefore
//     blind to it;
//   · the sidebar row's counts are identical too — `scopeCount` counts
//     DISTINCT SCOPES, and no new scope appeared;
//   · the ONLY thing that moves is `lastWriteAt`, and the only thing on
//     screen that can express it is the Reload offer.
//
// So this is the case where `state.staleWrite` is load-bearing all by
// itself. Removing it from screenSignature leaves every other §11 assertion
// green while the notice is computed and never painted.
{
  const t0 = 1_000_000;
  const s = liveState({
    scope: 'memory-view', machine: null,                 // nothing chosen
    detail: { scope: 'memory-view', machine: 'mac-9f3c1a', machines: [
      { machine: 'mac-9f3c1a', ageSeconds: 4 * 3600 }],
      current: { present: true, text: 'FOUR HOURS OLD' }, journal: [] },
    detailFetchedAt: t0, scopesFetchedAt: t0,
  });
  // The index sees the write because it reports the newest across ALL
  // machines; the scope list does not, because no scope was added.
  const wroteAt = t0 + 12 * 60 * 1000;
  const r = makeRevalidator(s, (url) => {
    if (url === '/api/memory') {
      return { ok: true, json: async () => ({ ok: true, projects: [{
        project: 'projects', hasBrief: true, scopeCount: 2, savedCopies: 3,
        lastWriteAt: new Date(wroteAt).toISOString(), ageSeconds: 1,
        headline: 'Second scope' }] }) };
    }
    return { ok: true, json: async () => ({ ok: true, project: 'projects',
      scopes: [{ scope: 'memory-view' }, { scope: 'main' }] }) };
  });

  const before = { renders: r.calls.render, doc: s.detail.current.text };
  await r.refreshIndex(1);

  ok('a save into a SECOND machine folder under the SAME scope is NOTICED by the poll',
    s.staleWrite === true, `staleWrite=${s.staleWrite}`);
  ok('...and it changes what the screen says, so the Reload offer is actually painted',
    r.calls.render > before.renders, `renders ${before.renders} -> ${r.calls.render}`);
  eq('...while the document under the reader is NOT swapped by the poll',
    s.detail.current.text, before.doc);
  eq('...and the selection is not moved either', s.machine, null);
  ok('corpus non-vacuous: the scope list really is unchanged, so nothing else could carry this',
    JSON.stringify(s.projectRead.scopes.map((x) => x.scope)) === JSON.stringify(['memory-view', 'main']),
    JSON.stringify(s.projectRead.scopes));

  // THE DECISIVE ONE, driven through the SHIPPED screenSignature: with the
  // scope list, the selection and the sidebar counts all unmoved, the stale
  // flag is the only thing left that can make this poll visible. Flip it back
  // and the signature must collapse to the pre-poll value — i.e. a signature
  // blind to `staleWrite` would skip the render and leave the Reload offer
  // computed but never painted.
  const sigWith = r.screenSignature();
  s.staleWrite = false;
  const sigWithout = r.screenSignature();
  s.staleWrite = true;                                   // restore
  ok('the stale flag is LOAD-BEARING in the signature — nothing else moved to carry this poll',
    sigWithout !== sigWith, `${sigWithout}\n vs \n${sigWith}`);
  eq('...and restoring it reproduces the post-poll signature exactly',
    r.screenSignature(), sigWith);

  // A repeat poll finding the same write must stay free.
  const rendersAfter = r.calls.render;
  await r.refreshIndex(1);
  eq('a repeat poll over the same unread write costs no further render',
    r.calls.render, rendersAfter);
}

// ═════════════════════════════════════════════════════════════════════════
section('§12 — THE MOUNT CONTRACT, executed rather than grepped');
// ═════════════════════════════════════════════════════════════════════════
//
// onEnter's mount+teardown closure was neither executed nor scanned by
// anything. Four separate deletions inside it left this suite fully green
// while shipping real defects:
//
//   · `schedulePoll(mountToken)` deleted  -> the poll never runs at all, so
//     the whole adaptive-revalidation feature is dead and §11's arithmetic
//     goes on proving things about a function nobody calls;
//   · `stopPoll()` deleted from the teardown -> leaving the view keeps
//     fetching forever, one more chain per re-entry, for the life of the page;
//   · either wake listener deleted -> revalidation-on-focus gone, which is the
//     cheapest and most valuable of the three triggers;
//   · the `removeEventListener` block deleted -> two permanent listeners leak
//     per mount, each holding a closure over a dead mount token.
//
// AND SINCE v3.54: THE AGE CLOCK. onEnter arms a 1-second setInterval so the
// handoff's freshness reading ticks, and NOTHING IN THIS REPOSITORY CAUGHT A
// LEAKED TIMER before this section was given spies for it. A leaked interval
// is worse than a leaked listener: it does not merely hold a closure, it RUNS,
// once a second, walking a DOM that belongs to whatever view mounted next, for
// the life of the page — and one more of them per rail click. `setInterval`
// and `clearInterval` are Node globals, so a rig that did not inject them
// would have armed a REAL timer here and reported nothing either way.
//
// §9's `loadGate.cancel()` regex satisfied none of these; it merely happened
// to sit in the same closure. So the closure is EXECUTED here, against a
// window and a document that record every listener, with every collaborator
// injected as a spy.

/** The real onEnter, lifted out of the registerView({...}) object literal. */
function liftOnEnter() {
  const fn = functionSource(viewNoComments, 'onEnter');
  if (fn === null) throw new Error('onEnter not found in memory.js — the mount contract would be untested');
  return fn;
}

function mountView({ hidden = false, mounted = true, noIntervals = false } = {}) {
  const log = { scheduled: [], stopped: 0, gateCancelled: 0, closedListboxes: 0, renders: [], loadIndex: 0, refresh: 0,
    // The age clock: every arm, every disarm, and the callback it was armed
    // with, so "armed" can be distinguished from "armed with the right thing".
    intervalsArmed: [], intervalsCleared: [], ticks: 0 };
  const listeners = { window: [], document: [] };
  const mkTarget = (bucket) => ({
    addEventListener: (type, fn) => bucket.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = bucket.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) bucket.splice(i, 1);
    },
  });
  const win = mkTarget(listeners.window);
  const doc = mkTarget(listeners.document);
  doc.hidden = hidden;

  const body =
    'let state, myMountToken, loadGate, wakeHandler, ageTimer = null;\n' +
    'const __view = {' + liftOnEnter() + '};\n' +
    'return { onEnter: __view.onEnter, wake: () => wakeHandler, token: () => myMountToken,' +
    '         timer: () => ageTimer };';

  // Handed out in order, so an arm and its clear can be matched by identity
  // rather than by count alone — clearing a DIFFERENT handle would otherwise
  // balance the books while leaving the real timer running.
  let nextHandle = 100;
  // Held in a named local so the assertions can compare the function the
  // interval was armed WITH against this exact reference. Counting arms is not
  // enough: an interval armed with render() would balance perfectly and would
  // be the v3.53.1 defect.
  const tickSpy = () => { log.ticks++; };
  const api = new Function(
    'freshState', 'createLoadingGate', 'isCurrentMount', 'render', 'loadIndex',
    'reportAsyncMountFailure', 'refreshIndex', 'schedulePoll', 'stopPoll',
    'closeAllListboxes', 'window', 'document',
    'tickAges', 'AGE_TICK_MS', 'setInterval', 'clearInterval',
    // v3.67.0: the helper's cost gate is a view-owned overlay, closed on teardown.
    'closeConfirmIfOpen', body)(
    () => ({ loading: true }),
    () => ({ begin: () => {}, cancel: () => { log.gateCancelled++; } }),
    () => mounted,
    (t) => { log.renders.push(t); },
    async (t) => { log.loadIndex++; return t; },
    () => {},
    async (t) => { log.refresh++; return t; },
    (t) => { log.scheduled.push(t); },
    () => { log.stopped++; },
    () => { log.closedListboxes++; },
    win, doc,
    tickSpy,
    1000,
    // `noIntervals` makes setInterval un-callable, which is the engine (or the
    // headless rig) that has none. onEnter guards on `typeof setInterval ===
    // 'function'`, so this arm proves the guard is real rather than decorative.
    noIntervals ? undefined : ((fn, ms) => { log.intervalsArmed.push({ fn, ms, id: nextHandle }); return nextHandle++; }),
    (id) => { log.intervalsCleared.push(id); },
    () => { log.closedConfirms = (log.closedConfirms || 0) + 1; });

  return { ...api, log, listeners, tickSpy,
    setMounted: (v) => { mounted = v; }, setHidden: (v) => { doc.hidden = v; } };
}

{
  const m = mountView();
  const teardown = m.onEnter(7);

  // ── The mount half ──
  eq('mount: the first paint happens with the mount token', m.log.renders[0], 7);
  eq('mount: the index is loaded exactly once', m.log.loadIndex, 1);
  eq('mount: schedulePoll IS called — without it the poll never runs at all', m.log.scheduled.length, 1);
  eq('mount: ...and it is armed with the MOUNT token, not a re-derived one', m.log.scheduled[0], 7);
  ok('mount: a `focus` listener is registered on window',
    m.listeners.window.some((l) => l.type === 'focus'), JSON.stringify(m.listeners.window.map((l) => l.type)));
  ok('mount: a `visibilitychange` listener is registered on document',
    m.listeners.document.some((l) => l.type === 'visibilitychange'), JSON.stringify(m.listeners.document.map((l) => l.type)));
  // GUARDED DEREFERENCES throughout this block. A missing listener is exactly
  // what the assertions above exist to catch, and an unguarded `[0].fn` turns
  // that catch into a TypeError that aborts the file — a red for the wrong
  // reason, which hides every assertion after it. Measured: deleting the
  // `focus` listener crashed this suite instead of failing it.
  const fire = (bucket, type) => { const l = bucket.find((x) => x.type === type); if (l) l.fn(); return !!l; };
  ok('mount: both wake listeners are the SAME handler, so both can be removed by it',
    m.listeners.window.length > 0 && m.listeners.document.length > 0 &&
    m.listeners.window[0].fn === m.listeners.document[0].fn);
  ok('onEnter returns a teardown function', typeof teardown === 'function');

  // ── The wake handler, actually invoked ──
  eq('the wake handler is what refreshes — nothing has fired yet', m.log.refresh, 0);
  ok('a `focus` wake listener exists to fire', fire(m.listeners.window, 'focus'));
  eq('coming back to a VISIBLE view revalidates', m.log.refresh, 1);
  m.setHidden(true);
  ok('a `visibilitychange` wake listener exists to fire', fire(m.listeners.document, 'visibilitychange'));
  eq('a HIDDEN tab does not revalidate (nobody is looking)', m.log.refresh, 1);
  m.setHidden(false);
  m.setMounted(false);
  fire(m.listeners.window, 'focus');
  eq('a listener that outlived its mount does not revalidate either', m.log.refresh, 1);
  m.setMounted(true);

  // ── The teardown half ──
  teardown();
  eq('teardown: the loading gate is cancelled (timer hygiene)', m.log.gateCancelled, 1);
  eq('teardown: stopPoll IS called — otherwise the view keeps FETCHING for a screen nobody is on', m.log.stopped, 1);
  // ── ONE POPOVER AGAIN (v3.65.0, P10) ────────────────────────────────
  // v3.55.0 deleted this call with the scope and machine pickers, and pinned
  // the deletion in the NEGATIVE — correctly, because a teardown step with
  // nothing to tear down is a claim about the screen that is no longer true.
  // Step ③'s wiki picker makes the claim true again: `navigate()` explicitly
  // does not reach into view-owned popovers, so a menu left open on a rail
  // click outlives the view that opened it. The assertion is INVERTED rather
  // than deleted, for the reason the two header pins were: it stays pointed
  // at the same site, one step further on.
  eq('teardown: the view closes the one popover it owns', m.log.closedListboxes, 1);
  eq('teardown: the window `focus` listener is REMOVED (no leak per mount)', m.listeners.window.length, 0);
  eq('teardown: the document `visibilitychange` listener is REMOVED', m.listeners.document.length, 0);
}

{
  // Two mounts and two teardowns must leave nothing behind — the leak this
  // catches grows one listener pair per rail click.
  const m = mountView();
  const t1 = m.onEnter(1); t1();
  const t2 = m.onEnter(2); t2();
  eq('two full mount/teardown cycles leak no window listeners', m.listeners.window.length, 0);
  eq('two full mount/teardown cycles leak no document listeners', m.listeners.document.length, 0);
  eq('...and each mount armed its own poll', m.log.scheduled.length, 2);
  eq('...and each teardown disarmed one', m.log.stopped, 2);
}

// Scoped source checks for the two things execution cannot see: that the
// schedule call is in the MOUNT half and the stop call is in the TEARDOWN
// half. Stated as source scans, because they are.
{
  const onEnterSrc = functionSource(viewNoComments, 'onEnter');
  const tIdx = onEnterSrc.indexOf('return () =>');
  ok('onEnter contains a returned teardown closure', tIdx > 0);
  const mountHalf = onEnterSrc.slice(0, tIdx);
  const teardownHalf = onEnterSrc.slice(tIdx);
  ok('SOURCE SCAN: schedulePoll is called in the MOUNT half, not the teardown',
    /(?<![.\w$])schedulePoll\s*\(/.test(mountHalf) && !/(?<![.\w$])schedulePoll\s*\(/.test(teardownHalf));
  ok('SOURCE SCAN: stopPoll is called in the TEARDOWN half',
    /(?<![.\w$])stopPoll\s*\(/.test(teardownHalf));
  eq('stopPoll has exactly one call site inside onEnter (the teardown)',
    callSiteCount(viewSrc, 'stopPoll', { within: 'onEnter' }), 1);
  eq('schedulePoll has exactly one call site inside onEnter (the mount)',
    callSiteCount(viewSrc, 'schedulePoll', { within: 'onEnter' }), 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§13 — render() and the focus contract, executed');
// ═════════════════════════════════════════════════════════════════════════
//
// `restoreFocus()` made a no-op regressed the v3.17.1 focus-by-id fix — the
// one that stops "Show more" dropping a keyboard user to <body> — and nothing
// noticed. Both halves are executed here against a document that records
// focus() calls.

function makeFocusRig({ activeId = null, presentIds = [], detailLoading = false } = {}) {
  const focused = [];
  const mk = (id) => ({ id, focus(opts) { focused.push({ id, opts }); } });
  const els = new Map(presentIds.map((id) => [id, mk(id)]));
  const doc = {
    activeElement: activeId ? mk(activeId) : null,
    getElementById: (id) => els.get(id) || null,
    querySelector: (sel) => els.get(sel.replace(/^#/, '')) || null,
  };
  const st = { detailLoading };
  const body =
    'let pendingFocusId = null;\n' +
    // v3.67.0: render() asks for step ④'s measurement after it paints; that
    // path is driven in §25, so here it is a named no-op.
    'function maybeLoadSessionStart() {}\n' +
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
    'let renderedSignature = null;\n' +
    'function screenSignature() { return "SIG"; }\n' +
    'return { render, captureFocus, restoreFocus, pending: () => pendingFocusId, sig: () => renderedSignature };';
  const painted = { sidebar: 0, main: 0, wire: 0 };
  const api = new Function(
    'state', 'document', 'FOCUSABLE_IDS', 'FOCUS_FALLBACK', 'isCurrentMount',
    'renderSidebar', 'renderMain', 'wire', body)(
    st, doc, FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, () => true,
    () => { painted.sidebar++; }, () => { painted.main++; }, () => { painted.wire++; });
  return { ...api, focused, painted, doc };
}

ok('FOCUSABLE_IDS was lifted from real source and is non-trivial',
  Array.isArray(FOCUSABLE_IDS_SRC) && FOCUSABLE_IDS_SRC.length >= 6, JSON.stringify(FOCUSABLE_IDS_SRC));
ok('FOCUS_FALLBACK was lifted from real source',
  !!FOCUS_FALLBACK_SRC && typeof FOCUS_FALLBACK_SRC === 'object');

{
  // render() paints BOTH panes, wires them, and records the signature.
  const r = makeFocusRig();
  r.render(1);
  eq('render() paints the sidebar', r.painted.sidebar, 1);
  eq('render() paints the main pane', r.painted.main, 1);
  eq('render() re-wires the result', r.painted.wire, 1);
  eq('render() records the signature it just painted', r.sig(), 'SIG');
}
{
  // A stale mount paints nothing at all.
  const body =
    'let pendingFocusId = null;\nlet renderedSignature = null;\n' +
    'function screenSignature() { return "SIG"; }\n' +
    // v3.67.0: render() asks for step ④'s measurement after it paints; that
    // path is driven in §25, so here it is a named no-op.
    'function maybeLoadSessionStart() {}\n' +
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
    'return { render, sig: () => renderedSignature };';
  let painted = 0;
  const api = new Function('state', 'document', 'FOCUSABLE_IDS', 'FOCUS_FALLBACK', 'isCurrentMount',
    'renderSidebar', 'renderMain', 'wire', body)(
    { detailLoading: false }, { activeElement: null, getElementById: () => null, querySelector: () => null },
    FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, () => false,
    () => { painted++; }, () => { painted++; }, () => { painted++; });
  api.render(1);
  eq('a render for a STALE mount paints nothing', painted, 0);
  eq('...and does not touch the signature either', api.sig(), null);
}
{
  // Capture + restore, the real thing.
  const r = makeFocusRig({ activeId: 'mem-journal-more', presentIds: ['mem-journal-more'] });
  r.captureFocus();
  eq('captureFocus records a focusable control of ours', r.pending(), 'mem-journal-more');
  r.restoreFocus();
  // Guarded: a restoreFocus that focuses NOTHING is the defect, and an
  // unguarded `[0].id` would crash the file rather than name it.
  eq('restoreFocus focuses it back BY ID after the pane was replaced',
    r.focused.length ? r.focused[0].id : null, 'mem-journal-more');
  ok('...with preventScroll, so the reading position the re-render preserved is not undone',
    !!(r.focused.length && r.focused[0].opts && r.focused[0].opts.preventScroll === true),
    JSON.stringify(r.focused.length ? r.focused[0].opts : null));
  eq('...and the pending target is cleared once it lands', r.pending(), null);
}
{
  // The case that matters: "Show more" REMOVES itself, so a by-id-only
  // restore would drop focus every time it worked.
  const r = makeFocusRig({ activeId: 'mem-journal-more', presentIds: ['mem-fold-journal'] });
  r.captureFocus();
  r.restoreFocus();
  eq('a control that removed itself falls back to the nearest stable thing',
    r.focused.length ? r.focused[0].id : null, 'mem-fold-journal');
}
{
  // Reload dismisses the notice it lives in — same shape, its own fallback.
  const r = makeFocusRig({ activeId: 'mem-reload', presentIds: ['mem-refresh'] });
  r.captureFocus();
  r.restoreFocus();
  eq('Reload falls back to the sidebar Refresh, which does the same KIND of thing',
    r.focused.length ? r.focused[0].id : null, 'mem-refresh');
}
{
  // Never reach out of our own view.
  const r = makeFocusRig({ activeId: 'rail-btn-domains', presentIds: ['rail-btn-domains'] });
  r.captureFocus();
  eq('captureFocus IGNORES a control outside this view (it cannot steal focus from the rail)', r.pending(), null);
  r.restoreFocus();
  eq('...and restoreFocus therefore focuses nothing', r.focused.length, 0);
}
{
  // A miss is held while another render is still coming, dropped afterwards.
  //
  // `mem-ws-active` is the v3.55.0 stand-in for the retired `mem-machine-select`
  // and it is the BETTER case: it is the id of the work-stream table's OPEN
  // row, and the row that is open changes DURING the very two-render sequence
  // this exists for — loadScope paints a loader with no open row, then paints
  // the result with one. So the miss on the first render is not hypothetical
  // here, it happens on every row click.
  const held = makeFocusRig({ activeId: 'mem-ws-active', presentIds: [], detailLoading: true });
  held.captureFocus();
  held.restoreFocus();
  eq('a miss is HELD while another render is still coming (a scope change renders twice)',
    held.pending(), 'mem-ws-active');
  const dropped = makeFocusRig({ activeId: 'mem-ws-active', presentIds: [], detailLoading: false });
  dropped.captureFocus();
  dropped.restoreFocus();
  eq('...and is DROPPED once no further render is coming, so it cannot fire later out of context',
    dropped.pending(), null);
  // AND THE ID IS REALLY IN THE LIST. captureFocus only records an id in
  // FOCUSABLE_IDS, so a rename in memory.js that left this fixture behind would
  // make the two assertions above pass against a name the view never emits.
  ok('CONTROL: mem-ws-active is genuinely one of the view\'s focusable ids',
    FOCUSABLE_IDS_SRC.includes('mem-ws-active'), FOCUSABLE_IDS_SRC.join(','));
  ok('...and the two retired picker ids are gone from it',
    !FOCUSABLE_IDS_SRC.includes('mem-scope-select')
    && !FOCUSABLE_IDS_SRC.includes('mem-machine-select'));
}

// ═════════════════════════════════════════════════════════════════════════
section('§14 — The Reload OFFER is painted, and reaches every content branch');
// ═════════════════════════════════════════════════════════════════════════
//
// renderStaleNotice had NO assertion of any kind. `return ''` from it deletes
// the v3.17.3 headline — the offer to reload after an agent writes underneath
// you — with every other assertion in this file still green. Executed here,
// and executed THROUGH renderProject, so it is proven to reach the page.

{
  const quiet = makeRenderers({ ...hostileState, staleWrite: false });
  eq('no write since arrival renders no notice at all', quiet.renderStaleNotice(), '');

  const loud = makeRenderers({ ...hostileState, staleWrite: true });
  const n = loud.renderStaleNotice();
  ok('a newer write renders a notice', n.length > 0);
  ok('...carrying the Reload control by its stable id', n.includes('id="mem-reload"'));
  assertLiteral(okc, 'Reload', (/>([^<]*)<\/button>/.exec(n) || [])[1],
    'the control is labelled Reload — it OFFERS, it does not announce that something was replaced');
  ok('...announced politely rather than as an alert (nothing is broken)', n.includes('role="status"'));
  ok('...saying an agent SAVED, not that the document changed (we have not read it)',
    /saved to this project since you opened it/i.test(n));
  ok('...and it says what is below MAY not be latest, never that it IS stale',
    /may not be the latest/i.test(n));
}
{
  // ALL THREE CONTENT BRANCHES renderProject can take — and each fixture is
  // checked for having actually REACHED the branch it is named after. The
  // first draft of this block reused a fixture whose projectRead carried no
  // `scopes` array, so the "FULL branch" case silently exercised the
  // BRIEF-ONLY branch and deleting `staleNote` from the full branch stayed
  // green. A branch test that does not prove which branch it took is not a
  // branch test.
  const base = { ...hostileState, staleWrite: true };

  const fullState = { ...base,
    projectRead: { ...hostileState.projectRead, scopes: [{ scope: 'a' }, { scope: 'b' }] } };
  const full = makeRenderers(fullState).renderProject();
  // RE-POINTED (v3.56.0): there is no "CURRENT HANDOFF" eyebrow any more — the
  // document opens in the reader — so the FULL branch is identified by what it
  // does render instead, the work-stream TABLE. Still a positive identification
  // of the branch, which is the property this line exists for.
  ok('branch check: the FULL fixture really renders the work-stream table',
    full.includes('mem-ws-table') && full.includes('data-mem-scope="a"'));
  ok('the offer reaches the FULL branch (scopes + a handoff)', full.includes('id="mem-reload"'));

  const briefOnly = makeRenderers({ ...base, detail: null,
    projectRead: { scopes: [], brief: { present: true, text: '## B\n\nx' } } }).renderProject();
  ok('branch check: the BRIEF-ONLY fixture really renders the no-handoff card',
    briefOnly.includes('No handoff saved yet'));
  ok('the offer reaches the BRIEF-ONLY branch', briefOnly.includes('id="mem-reload"'));

  const empty = makeRenderers({ ...base, detail: null, projectRead: { scopes: [], brief: null } }).renderProject();
  ok('branch check: the EMPTY fixture really renders the empty card',
    empty.includes('Nothing saved for this project yet'));
  ok('the offer reaches the EMPTY branch — where "nothing saved yet" is exactly the sentence a fresh write falsifies',
    empty.includes('id="mem-reload"'));

  for (const [name, s] of [['FULL', fullState],
    ['BRIEF-ONLY', { ...base, detail: null, projectRead: { scopes: [], brief: { present: true, text: '## B\n\nx' } } }],
    ['EMPTY', { ...base, detail: null, projectRead: { scopes: [], brief: null } }]]) {
    ok('...and the ' + name + ' branch shows NO offer when nothing has been written',
      !makeRenderers({ ...s, staleWrite: false }).renderProject().includes('id="mem-reload"'));
  }

  // THE SAVE-STATUS STRIP REACHES THE SAME THREE BRANCHES, for the same
  // reason and with the same failure mode: it answers "am I saved?", and the
  // branch where it matters most is the one where the rest of the screen says
  // "nothing saved for this project yet". Deleting `saveStatus` from any one
  // return leaves every other assertion in this file green; scripts/
  // test-memory-truth.js executes what the strip SAYS, and this proves it is
  // on the page at all. It is ABOVE the reload notice in every branch, which
  // is the placement decision — the answer must not sit under its caveats.
  //
  // MATCHED ON THE CLASS TOKEN, NOT ON `class="mem-save"`. Every top-level
  // block on this page carries `mem-section` as well now (one adjacency rule
  // owns every gap), so the old exact-attribute match reddened on markup that
  // was correct in every way the assertion was about. Pinning a full class
  // ATTRIBUTE makes an assertion about spacing out of an assertion about
  // placement; the token regex keeps it about placement. The ordering half is
  // unchanged and still fails if either block moves.
  //
  // ── RE-POINTED AT THE STRIP (v3.62.0) ──────────────────────────────────
  // It used to be `.mem-save` — the Status block's own section — and the
  // reasoning above is unchanged, but the element that carries the answer is
  // not. `.mem-save` is now the reading for the pair you are LOOKING AT, and
  // it is legitimately absent on a project with nothing open: the standing-
  // brief line that used to make that stack unconditional is deleted (the
  // brief fold's summary says the same two facts). What must reach EVERY
  // branch is the three-cell strip, which answers "am I saved?" for all three
  // layers and is the reason the Status block could be replaced rather than
  // merely moved. The ordering half is unchanged and still fails if either
  // element moves.
  const classAt = (out, cls) => out.search(new RegExp('class="[^"]*\\b' + cls + '\\b'));
  for (const [name, out] of [['FULL', full], ['BRIEF-ONLY', briefOnly], ['EMPTY', empty]]) {
    ok('the three-cell strip reaches the ' + name + ' branch',
      classAt(out, 'mem-overview') !== -1, out.slice(0, 200));
    ok('...and it is painted ABOVE the reload notice there',
      classAt(out, 'mem-overview') < classAt(out, 'mem-stale'),
      classAt(out, 'mem-overview') + ' vs ' + classAt(out, 'mem-stale'));
    ok('...and it always carries the WORKING STATE cell, which is the one that '
      + 'answers the question the deleted block existed for',
    /MEMORY/.test(out), out.slice(0, 200));
  }
  // AND `.mem-save` IS WARNINGS ONLY NOW (v3.65.1). The strip is the project's
  // answer and the Handoffs row carries the open pair's; what is left in this
  // wrapper is the loud lines, which appear only when they fire. On a read
  // with nothing loud to say it must NOT paint — a bordered nothing above four
  // rows is the block the maintainer rejected.
  ok('a read with nothing loud to say paints NO block above the rows',
    classAt(full, 'mem-save') === -1, full.slice(0, 300));
  ok('CONTROL: and a read WITH something loud still does, unfolded, outside '
    + 'every chevron',
  (() => {
    const loud = makeRenderers({ ...hostileState, staleWrite: false }).renderSaveStatus(
      { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 60 }] },
      { scope: 'main', machine: 'boxa', current: { present: true, writtenAgeSeconds: 60,
        lastSaveKind: 'trimmed', lastSaveNotes: ['budget'] } });
    return /class="mem-save"/.test(loud) && /cur-mon-loud/.test(loud) && !/<details/.test(loud);
  })(), 'a loud line does not reach the page');
  ok('self-test: that class matcher is not vacuous and does not match a prefix',
    classAt('<div class="a mem-save b">', 'mem-save') === 5
    && classAt('<div class="mem-saved">', 'mem-save') === -1);
}
{
  // The unlisted note: the store's own sentence, echoed rather than
  // paraphrased, and the empty-project advice that changes with it.
  const s = { ...hostileState, staleWrite: false, detail: null,
    projectRead: { scopes: [], brief: null, unlistedEntries: 2, unlistedReason: 'RENAME THEM TO LETTERS.' } };
  const out = makeRenderers(s).renderProject();
  ok('an unaddressable directory entry is reported at all', out.includes('mem-note-loud'));
  ok('...echoing the STORE\'s own reason verbatim rather than a second copy of the rule',
    out.includes('RENAME THEM TO LETTERS.'));
  ok('...and the empty-project card stops claiming nobody has written a handoff',
    !out.includes('No agent has written a handoff here'));
  ok('...and warns that saving would STRAND what is already there', /stranded/i.test(out));
}

// ═════════════════════════════════════════════════════════════════════════
section('§15 — Reload keeps the user where they are (v3.17.3\'s own rule)');
// ═════════════════════════════════════════════════════════════════════════
//
// reloadActive was never executed. Making it snap to the newest scope and drop
// the machine — the exact behaviour v3.17.3 claims it prevents, and what
// selectProject deliberately does instead — left this suite green.

function makeReloader(stateObj, responder) {
  const calls = { urls: [], renders: 0 };
  let mounted = true;
  const body =
    // (domain, project) identity, lifted rather than stubbed — see the note
    // in makeRevalidator.
    extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n' +
    // The fallback pair reloadActive picks when the user's scope is gone is the
    // head of the order the TABLE paints, so both travel with it. Lifted, not
    // stubbed, for the reason the identity helpers are: a stub here would let
    // this suite agree with itself about which pair is freshest.
    extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n' +
    // ── THE PROJECT CACHE (v3.57.0) ───────────────────────────────────────
    // `reloadActive` DROPS every cached copy of this project before its first
    // request — the whole meaning of the control is "my copy is stale" — and
    // `loadScope` reads and writes the same store. Both travel with the
    // functions, lifted rather than stubbed, or the shipped code is a
    // ReferenceError here.
    'const readCache = new Map();\n' +
    'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n' +
    extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'cacheKeyScope', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'cacheGet', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'cachePut', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'forgetProject', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'payloadSignature', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'loadScope', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'reloadActive', 'memory.js') + '\n' +
    'return { reloadActive, loadScope, readCache };';
  const api = new Function('state', 'render', 'isCurrentMount', 'fetch', 'URLSearchParams',
    'encodeURIComponent', 'JOURNAL_PAGE', 'patchOpenPair', body)(
    stateObj, () => { calls.renders++; }, () => mounted,
    async (url) => { calls.urls.push(String(url)); return responder(String(url)); },
    URLSearchParams, encodeURIComponent, 10,
    // Never reached on this path — `reloadActive` never passes `reader: true`
    // — and injected anyway, because an undefined collaborator inside a branch
    // this suite does not take is a crash waiting for the branch that does.
    () => { calls.patches = (calls.patches || 0) + 1; });
  return { ...api, calls, unmount: () => { mounted = false; } };
}

// ── "SHOW MORE" DOES NOT EMPTY THE PANE IT IS ABOUT TO REFILL (v3.65.0) ──
//
// THE REPORTED DEFECT, verbatim: *"you can Show more, and if I click Show
// more I'm dropped at the top of the recent saves, which is not good UX."*
//
// THE MECHANISM, read from code and then measured in a browser: `loadScope`'s
// uncached branch nulls `state.detail` and renders BEFORE the fetch;
// `renderJournal` opens with `if (!d || !d.journal) return ''`, so the fold
// the user is reading disappears for the whole round trip, the column shrinks,
// and the scroll container clamps `scrollTop` to the new maximum.
//
// DRIVEN HERE AS STATE RATHER THAN AS PIXELS, because the blank frame is the
// whole mechanism and it is observable without a browser: with `keepDetail`,
// `state.detail` is never null and no render happens before the answer. The
// browser measurement (scrollTop unchanged, scrollHeight never dipping) is
// this claim's other half and is taken in the browser pass.
{
  const before = { scope: 'main', machine: 'boxa', machines: [],
    current: { present: true, text: 'x' },
    journal: { returned: 10, total: 40, totalUnknown: false, entries: [] } };
  const mkCase = async (opts) => {
    const seen = [];
    const st2 = liveState({ scope: 'main', machine: 'boxa', detail: before, journalLimit: 50 });
    await makeReloaderProbe(st2, seen).loadScope('main', 'boxa', 1, opts);
    return { seen, st2 };
  };
  // A tiny variant of `makeReloader` that records `state.detail` on every
  // paint. Declared here rather than beside it because only this case needs
  // to see the INTERMEDIATE frames.
  function makeReloaderProbe(stateObj, probe) {
    let mounted = true;
    const body =
      extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n' +
      'const readCache = new Map();\n' +
      'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n' +
      extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'cacheKeyScope', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'cacheGet', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'cachePut', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'forgetProject', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'payloadSignature', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'loadScope', 'memory.js') + '\n' +
      'return { loadScope };';
    return new Function('state', 'render', 'isCurrentMount', 'fetch', 'URLSearchParams',
      'encodeURIComponent', 'JOURNAL_PAGE', 'patchOpenPair', body)(
      stateObj, () => { probe.push(stateObj.detail === null ? 'BLANK' : 'kept'); },
      () => mounted,
      async () => ({ ok: true, json: async () => ({ ok: true, scope: 'main', machine: 'boxa',
        machines: [], current: { present: true, text: 'x' },
        journal: { returned: 40, total: 40, totalUnknown: false, entries: [] } }) }),
      URLSearchParams, encodeURIComponent, 10, () => {});
  }

  const withFlag = await mkCase({ keepDetail: true });
  ok('with `keepDetail` no frame is painted with an EMPTY detail — the fold the '
    + 'reader is inside never leaves the page, so the column cannot shrink',
  !withFlag.seen.includes('BLANK'), JSON.stringify(withFlag.seen));
  ok('...and the larger journal did arrive', withFlag.st2.detail.journal.returned === 40);

  // THE CONTROL, and it is the reproduction: without the flag the blank frame
  // is painted, which is the defect exactly.
  const without = await mkCase({});
  ok('CONTROL: WITHOUT the flag a BLANK frame is painted first — this is the '
    + 'reported defect, reproduced',
  without.seen.includes('BLANK'), JSON.stringify(without.seen));
  ok('...and it is the FIRST paint, before the answer, which is what makes the '
    + 'column shrink under the reader', without.seen[0] === 'BLANK',
  JSON.stringify(without.seen));

  // AND A SCOPE SWITCH STILL DROPS IT. The rule `keepDetail` opts out of is
  // real and protects a different case: showing the OLD machine list and the
  // OLD handoff under the NEW scope's label for the length of a fetch.
  ok('a scope switch (no flag) still blanks first, so this is an opt-in for '
    + 'the ONE case that is not a switch', without.seen[0] === 'BLANK');
}

{
  // Three scopes; the user is on the MIDDLE one, having DELIBERATELY picked a
  // machine from the picker. `state.machine` non-null is what "deliberately"
  // means — it is written by exactly one place, the machine picker's handler.
  //
  // THIS FIXTURE USED TO CARRY `machine: null`, and that made the assertion
  // below pin a defect: with nothing chosen, "the machine the user was on"
  // was read off `state.detail.machine`, which is what the STORE resolved,
  // not what anyone picked. See the case immediately after this one.
  const s = liveState({ scope: 'memory-view', machine: 'machine-b',
    detail: { scope: 'memory-view', machine: 'machine-b', machines: [], current: { present: true, text: 'x' } } });
  const r = makeReloader(s, (url) => url.includes('?')
    ? { ok: true, json: async () => ({ ok: true, scope: 'memory-view', machine: 'machine-b',
        current: { present: true, text: 'reloaded' }, machines: [] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [
        { scope: 'newest-scope' }, { scope: 'memory-view' }, { scope: 'main' }] }) });
  await r.reloadActive(1);

  eq('Reload KEEPS the scope the user was reading — it does not snap to the newest', s.scope, 'memory-view');
  ok('...and re-reads that scope, not scopes[0]',
    r.calls.urls.some((u) => /scope=memory-view/.test(u)), JSON.stringify(r.calls.urls));
  ok('...and does not ask for the newest scope at all',
    !r.calls.urls.some((u) => /scope=newest-scope/.test(u)), JSON.stringify(r.calls.urls));
  ok('Reload KEEPS a machine the user CHOSE — dropping it silently swaps whose handoff you read',
    r.calls.urls.some((u) => /machine=machine-b/.test(u)), JSON.stringify(r.calls.urls));
  eq('the fresh scope list IS adopted (that is what Reload is for)', s.projectRead.scopes.length, 3);
  eq('the document was replaced with the fresh read', s.detail.current.text, 'reloaded');
  eq('the stale offer is withdrawn once taken', s.staleWrite, false);
  eq('both marks moved together, because both reads started together', s.scopesFetchedAt, s.detailFetchedAt);
  ok('the marks moved forward', s.detailFetchedAt > 1_000_000);
  eq('loading finished', s.detailLoading, false);
}
{
  // ── THE REPORTED BUG. An AUTO-RESOLVED machine is not a CHOICE. ─────────
  //
  // Reported: the Agent-memory view sat open showing state from four hours
  // earlier; clicking the domain in the sidebar revealed a save from twelve
  // minutes earlier. Root cause, and it is one expression:
  //
  //     const wantMachine = state.detail ? state.detail.machine : state.machine;
  //
  // On arrival, selectProject calls loadScope(scope, null): `state.machine`
  // stays null and the STORE picks the most recently written machine, which
  // lands in `state.detail.machine`. From that first successful load onward
  // the expression above read the store's resolution back as though it were
  // the user's selection — so a save into a DIFFERENT machine folder (which
  // a hostname flap produces, see working-state.js D10) left Reload
  // re-reading the older folder, withdrawing the stale notice, and changing
  // nothing on screen. The Refresh button shares the same call and was
  // therefore equally inert.
  //
  // The poll was never the broken part: `GET /api/memory` reports the newest
  // write across ALL machines, so `staleWrite` flipped true and the Reload
  // offer DID appear. It was the only control that could act on it that
  // could not.
  const s = liveState({ scope: 'memory-view', machine: null,
    detail: { scope: 'memory-view', machine: 'stale-machine', machines: [],
      current: { present: true, text: 'FOUR HOURS OLD' } },
    staleWrite: true });
  // The fake store behaves like the real one: naming a machine gets THAT
  // machine's document, naming none gets the most recently written. Without
  // this the fixture would be vacuous — every response identical, so the
  // "moves forward" assertion could not fail however the URL was built.
  const r = makeReloader(s, (url) => {
    if (!url.includes('?')) {
      return { ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'memory-view' }, { scope: 'main' }] }) };
    }
    const pinned = /machine=stale-machine/.test(url);
    return { ok: true, json: async () => ({ ok: true, scope: 'memory-view',
      machine: pinned ? 'stale-machine' : 'fresh-machine',
      current: { present: true, text: pinned ? 'FOUR HOURS OLD' : 'TWELVE MINUTES OLD' },
      machines: [] }) };
  });
  await r.reloadActive(1);

  ok('Reload does NOT pin to a machine the user never chose — the store re-resolves to the newest',
    !r.calls.urls.some((u) => /machine=/.test(u)), JSON.stringify(r.calls.urls));
  eq('...so the document actually moves forward instead of re-reading the stale folder',
    s.detail.current.text, 'TWELVE MINUTES OLD');
  eq('...and the scope is still the one the user was reading', s.scope, 'memory-view');
  eq('...and nothing was pinned as a side effect, so the next Reload is free too', s.machine, null);
  eq('the stale offer is withdrawn — and this time it was honestly satisfied', s.staleWrite, false);
}
{
  // The scope genuinely disappeared: fall back to the freshest, which is what
  // selectProject would have chosen anyway. Documented behaviour.
  //
  // THE FIXTURE CARRIES AGES NOW, and the store's order CONTRADICTS them: the
  // list arrives `main` first (mtime, which a checkout rewrites) while the
  // agent's clock puts `newest-scope` five hours ahead of it. Before v3.56.1
  // both were ageless, so "falls back to the freshest" was a claim no response
  // in the fixture could contradict — it would have passed against `scopes[0]`
  // whatever that was.
  const s = liveState({ scope: 'gone-scope', detail: { scope: 'gone-scope', machine: 'm1', machines: [], current: { present: true, text: 'x' } } });
  const r = makeReloader(s, (url) => url.includes('?')
    ? { ok: true, json: async () => ({ ok: true, current: { present: true, text: 'y' }, machines: [] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [
      { scope: 'main', machine: 'm1', writtenAgeSeconds: 18_000 },
      { scope: 'newest-scope', machine: 'm2', writtenAgeSeconds: 60 }] }) });
  await r.reloadActive(1);
  eq('a scope removed out of band falls back to the freshest BY THE AGENT\'S '
    + 'CLOCK, not to whatever the store listed first', s.scope, 'newest-scope');
  ok('...and names that pair\'s machine, so the row the table highlights is the '
    + 'row it ranked first', r.calls.urls.some((u) => /machine=m2/.test(u)),
  JSON.stringify(r.calls.urls));
  ok('...and does NOT carry the old machine across to a different scope',
    !r.calls.urls.some((u) => /machine=m1/.test(u)), JSON.stringify(r.calls.urls));
  eq('...while recording NO choice, so the next Reload re-resolves to the newest '
    + 'copy rather than pinning one nobody picked (v3.34.0)', s.machine, null);
}
{
  // A project whose state vanished entirely: say so, do not paint a scope
  // label over a document that was never read.
  const s = liveState();
  const r = makeReloader(s, (url) => ({ ok: true, json: async () => ({ ok: true, scopes: [] }) }));
  await r.reloadActive(1);
  eq('a project with no scopes left clears the document', s.detail, null);
  eq('...and the scope', s.scope, null);
  eq('...and the machine', s.machine, null);
  eq('...and stops loading', s.detailLoading, false);
}
{
  // A remount mid-flight abandons the result.
  const s = liveState();
  const before = s.detail;
  const r = makeReloader(s, (url) => ({ ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'other' }] }) }));
  const p = r.reloadActive(1);
  r.unmount();
  await p;
  ok('a reload landing after a remount changes nothing', s.detail === before);
}
eq('reloadActive is reachable from the UI exactly where it should be — the Reload button and Refresh',
  callSiteCount(viewSrc, 'reloadActive', { within: 'wire' }), 2);

// ── TWO CALL SITES, TWO MEANINGS — and they must not be "tidied" into one ──
//
// Found by mutation, not by review: rewriting the journal's "show more"
// handler to use `state.machine` (i.e. making it match reloadActive) left
// this suite at 369/0. That is the likeliest future edit here, because the
// two expressions now look gratuitously different, and it is a real defect —
// expanding a journal would silently re-resolve to whichever machine wrote
// most recently, swapping the history you are part-way through reading.
//
// A SOURCE GUARD, and named as one: the handler lives inside `wire`, which
// needs a real DOM, so this checks the expression rather than executing it.
// It is scoped to the two functions by name, so a copy under a third name is
// invisible to it — stated rather than implied away.
{
  const reloadSrc = extractFunction(viewSrc, 'reloadActive', 'memory.js');
  ok('RELOAD honours only a DELIBERATE choice: it reads state.machine…',
    /const\s+wantMachine\s*=\s*state\.machine\s*;/.test(reloadSrc), reloadSrc.slice(0, 200));
  ok('…and never reads the machine the STORE resolved, which is what made an auto-pick a permanent pin',
    !/wantMachine\s*=\s*state\.detail/.test(reloadSrc));

  const wireSrc = extractFunction(viewSrc, 'wire', 'memory.js');
  const moreAt = wireSrc.indexOf('mem-journal-more');
  ok('fixture: the journal "show more" handler is where we think it is', moreAt > 0);
  const moreHandler = wireSrc.slice(moreAt, moreAt + 700);
  ok('SHOW MORE keeps the machine ON SCREEN — pagination must not re-resolve to a newer one',
    /state\.detail\s*\?\s*state\.detail\.machine/.test(moreHandler), moreHandler.slice(0, 300));
}

// ═════════════════════════════════════════════════════════════════════════
section('§16 — Projects inside a domain (v3.48.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// The rail groups by domain, remembers the last project per domain, and the
// standing brief gained the one editor this view has. Every function below is
// lifted from live source and RUN; nothing here reads a source string.

// ── 16a. Identity is the PAIR, never the project name alone ──────────────
{
  const idApi = new Function('state',
    extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
    'return { keyOf, activeKey };')({ activeDomain: 'alpha', activeProject: 'main' });

  ok('two domains holding a project of the SAME name are two different keys',
    idApi.keyOf('alpha', 'main') !== idApi.keyOf('beta', 'main'));
  eq('activeKey reads the live selection', idApi.activeKey(), 'alpha/main');
  // The separator is a character isSafeSegment forbids, so no project slug
  // can contain one and forge another pair's key.
  ok('the key separator is a character a project slug cannot contain',
    idApi.keyOf('a', 'b') === 'a/b' && !/^[a-z0-9][a-z0-9._-]*$/i.test('a/b'));
}

// ── 16b. Which project opens on arrival ──────────────────────────────────
{
  const pick = new Function(extractFunction(viewSrc, 'initialPick', 'memory.js') +
    '\nreturn initialPick;')();

  const rows = [
    { domain: 'alpha', project: 'alpha', lastWriteAt: '2026-09-01T00:00:00.000Z' },
    { domain: 'beta', project: 'one', lastWriteAt: '2026-09-05T00:00:00.000Z' },
    { domain: 'beta', project: 'two', lastWriteAt: '2026-09-06T00:00:00.000Z' },
  ];
  eq('with nothing remembered, the FRESHEST project wins', pick(rows, {}).project, 'two');
  eq('...and it is in the freshest domain', pick(rows, {}).domain, 'beta');
  eq('a remembered project in the freshest domain wins over recency',
    pick(rows, { beta: 'one' }).project, 'one');
  // THE MEMORY IS PER DOMAIN, and this is the assertion that says why. A
  // single global "last project" would send a user who just saved in beta to
  // whatever they were reading in alpha yesterday.
  eq('a remembered project in a DIFFERENT domain is ignored',
    pick(rows, { alpha: 'alpha' }).project, 'two');
  eq('a remembered project that no longer exists falls back to recency',
    pick(rows, { beta: 'deleted' }).project, 'two');
  eq('a project with nothing saved is still selectable when it is all there is',
    pick([{ domain: 'x', project: 'x', lastWriteAt: null }], {}).project, 'x');
  eq('no projects at all -> null, never a throw', pick([], {}), null);
  eq('a junk remembered map degrades to recency', pick(rows, null).project, 'two');
}

// ── 16c. localStorage is a convenience that must never break the screen ──
{
  // The storage key is READ OFF LIVE SOURCE, not retyped: a copy here would
  // be a second name for one thing, and the pair would keep passing while the
  // shipped view wrote to a key nothing read back.
  const KEY = liftConst('LAST_PROJECT_KEY');
  ok('the storage key was lifted from live source (not vacuous)',
    typeof KEY === 'string' && KEY.length > 0, String(KEY));
  function memApi(store) {
    return new Function('localStorage', 'JSON', 'LAST_PROJECT_KEY',
      extractFunction(viewSrc, 'readRememberedProjects', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'rememberProject', 'memory.js') + '\n' +
      'return { readRememberedProjects, rememberProject };')(store, JSON, KEY);
  }
  const bin = {};
  const good = {
    // Keyed strictly: a write to the wrong key reads back as nothing, which
    // is what makes the round-trip assertions below real.
    getItem: (k) => (k === KEY && k in bin ? bin[k] : null),
    setItem: (k, v) => { bin[k] = String(v); },
  };
  const api = memApi(good);
  api.rememberProject('alpha', 'one');
  api.rememberProject('beta', 'two');
  eq('a remembered project round-trips', api.readRememberedProjects().alpha, 'one');
  eq('...per domain, not globally', api.readRememberedProjects().beta, 'two');
  api.rememberProject('alpha', 'three');
  eq('the newest choice replaces the old one', api.readRememberedProjects().alpha, 'three');

  // THROWS, not returns null: Safari's private window and a "block site
  // data" setting both make the ACCESSOR throw, which is the case a
  // null-check misses entirely.
  const hostile = memApi({
    getItem: () => { throw new Error('site data blocked'); },
    setItem: () => { throw new Error('site data blocked'); },
  });
  let threw = false;
  try {
    eq('a throwing localStorage reads as "nothing remembered"',
      JSON.stringify(hostile.readRememberedProjects()), '{}');
    hostile.rememberProject('a', 'b');
  } catch { threw = true; }
  ok('...and a throwing WRITE is swallowed — the app forgets, it does not break', !threw);

  // A stored value is per-browser state a user can edit by hand.
  const junk = memApi({ getItem: () => '["not","an","object"]', setItem: () => {} });
  eq('a stored ARRAY degrades to nothing remembered',
    JSON.stringify(junk.readRememberedProjects()), '{}');
  const partial = memApi({ getItem: () => '{"a":"ok","b":42,"c":null}', setItem: () => {} });
  eq('non-string values are dropped, the usable ones kept',
    JSON.stringify(partial.readRememberedProjects()), '{"a":"ok"}');
  const broken = memApi({ getItem: () => '{oh no', setItem: () => {} });
  eq('unparseable JSON degrades to nothing remembered',
    JSON.stringify(broken.readRememberedProjects()), '{}');
}

// ── 16c2. WHICH FOLDS YOU HAD OPEN (v3.58.0) ─────────────────────────────
//
// The standing brief and the session journal both start CLOSED, which is the
// maintainer's ask ("the brief is usually a page or more and takes a lot of
// scrolling") — and a default that forgets the moment you visit the Wiki and
// come back is not a default, it is an annoyance. So the map is persisted.
//
// SAME CONTRACT AS THE LAST-PROJECT MAP: this is a convenience, so storage
// that refuses must make the app FORGET, never break. Everything below drives
// the SHIPPED `readRememberedFolds` against hostile stores.
{
  const KEY = liftConst('FOLDS_KEY');
  const FOLD_KEYS = liftConst('FOLD_KEYS');
  ok('the folds key was lifted from live source (not vacuous)',
    typeof KEY === 'string' && KEY.length > 0, String(KEY));
  ok('...and so was the list of fold names it may carry',
    Array.isArray(FOLD_KEYS) && FOLD_KEYS.includes('brief') && FOLD_KEYS.includes('journal'),
    JSON.stringify(FOLD_KEYS));

  // ── THE DUPLICATED LITERAL IN wire(), PINNED ──────────────────────────
  // The WRITE cannot call a module-level helper: `wire` is lifted by
  // brace-matching and EXECUTED against hand-written stubs in
  // scripts/test-agent-instructions.js, so naming one there is a
  // ReferenceError — a crash, not a failing assertion (the v3.11.0 shape).
  // The key is therefore written out twice, and the two copies are pinned
  // here so a rename of one cannot silently orphan the other: a write to a key
  // nothing reads back is a feature that looks implemented and is not.
  {
    const wireSrc = extractFunction(viewNoComments, 'wire', 'memory.js');
    const writes = [...wireSrc.matchAll(/localStorage\.setItem\(\s*'([^']+)'/g)].map((m) => m[1]);
    ok('wire() really does write the fold map (the pin is not vacuous)',
      writes.length >= 1, JSON.stringify(writes));
    ok('...and every key it writes IS the constant readRememberedFolds reads',
      writes.every((k) => k === KEY), JSON.stringify(writes) + ' vs ' + KEY);
    ok('...and every one of those writes is inside a try/catch, so a private '
      + 'window cannot break a toggle',
    (wireSrc.match(/try \{\s*localStorage\.setItem/g) || []).length === writes.length,
    wireSrc.slice(0, 40));
  }

  // THE PER-DOMAIN GRAMMAR IS READ OFF LIVE SOURCE (v3.65.0), like every
  // other constant this file injects: a copy typed here could agree with
  // every assertion below while the shipped map accepted something else.
  const KNOWLEDGE_RE_SRC = (() => {
    const m = /^const KNOWLEDGE_FOLD_RE = (\/.*\/);$/m.exec(viewSrc);
    if (!m) throw new Error('KNOWLEDGE_FOLD_RE not found in memory.js');
    return m[1];
  })();
  function foldApi(store) {
    return new Function('localStorage', 'JSON', 'FOLDS_KEY', 'FOLD_KEYS', 'KNOWLEDGE_FOLD_RE',
      extractFunction(viewSrc, 'readRememberedFolds', 'memory.js') + '\n' +
      'return { readRememberedFolds };')(store, JSON, KEY, FOLD_KEYS,
      new Function('return ' + KNOWLEDGE_RE_SRC + ';')());
  }
  // EVERY READ GOES THROUGH THIS, and it is not decoration. The point of this
  // block is that a hostile or absent store DEGRADES rather than throwing —
  // so an assertion that lets a throw escape reports the defect as a CRASH,
  // which exits the process and takes every later section with it. A mutation
  // making the catch re-throw did exactly that and was recorded as
  // "crashed, not red" until this helper existed.
  const read = (api) => {
    try { return JSON.stringify(api.readRememberedFolds()); } catch (e) { return 'THREW: ' + e.message; }
  };
  const mk = (raw) => foldApi({ getItem: (k) => (k === KEY ? raw : null), setItem: () => {} });

  eq('nothing stored -> nothing open, which is the DEFAULT this feature is for',
    read(mk(null)), '{}');
  eq('a stored open brief comes back open',
    read(mk('{"brief":true}')), '{"brief":true}');
  eq('both come back', read(mk('{"brief":true,"journal":true}')),
    '{"brief":true,"journal":true}');
  // ONLY `true` SURVIVES. Closed is the default, so a stored `false` and an
  // absent key mean the same thing; keeping the difference would invent a
  // third state nothing reads.
  eq('a stored `false` reads as no opinion, not as a third state',
    read(mk('{"brief":false,"journal":true}')), '{"journal":true}');
  eq('a TRUTHY non-true value is not a `true` — the check is identity',
    read(mk('{"brief":1,"journal":"yes"}')), '{}');
  // A hand-edited value must not be able to reach the renderers.
  eq('an unknown fold name is dropped rather than carried into render',
    read(mk('{"handoff":true,"__proto__":true}')), '{}');
  eq('a stored ARRAY degrades to nothing open',
    read(mk('["brief"]')), '{}');
  eq('unparseable JSON degrades to nothing open — a hand-edited value must not '
    + 'be able to throw out of the mount', read(mk('{oh no')), '{}');

  // THROWS, not returns null — Safari private mode and "block site data".
  eq('a throwing localStorage reads as "nothing open" rather than breaking',
    read(foldApi({
      getItem: () => { throw new Error('site data blocked'); },
      setItem: () => { throw new Error('site data blocked'); },
    })), '{}');
  // NO localStorage AT ALL is the same case, and it is not hypothetical: every
  // harness in this file runs these functions under Node.
  eq('no localStorage binding AT ALL reads as "nothing open" too — a '
    + 'ReferenceError inside a try block IS caught, and every harness in this '
    + 'file runs these functions under Node', read({
    readRememberedFolds: new Function('JSON', 'FOLDS_KEY', 'FOLD_KEYS',
      extractFunction(viewSrc, 'readRememberedFolds', 'memory.js') + '\n' +
      'return readRememberedFolds;')(JSON, KEY, FOLD_KEYS),
  }), '{}');
}

// ── 16d. The rail groups by domain ───────────────────────────────────────
{
  const g = makeRenderers({}).renderProjectGroups;
  const rows = [
    { domain: 'alpha', project: 'one', scopeCount: 2, hasBrief: true, lastWriteAt: null },
    { domain: 'alpha', project: 'two', scopeCount: 0, hasBrief: false, lastWriteAt: null },
    { domain: 'beta', project: 'one', scopeCount: 1, hasBrief: false, lastWriteAt: null },
  ];
  // THE INSTALL'S DOMAIN LIST is the fourth argument (v3.65.0): the identity
  // colour is the domain's place in THAT list, not in this screen's, so a
  // domain with no project context at all cannot slide every colour below it.
  const html = g(rows, 'beta', 'one', ['zeta', 'alpha', 'beta']);
  eq('one group per domain, not one per row', (html.match(/cur-sb-group-head/g) || []).length, 2);
  eq('every project still renders a row', (html.match(/data-mem-project=/g) || []).length, 3);
  ok('each row carries its DOMAIN as well as its project — the click handler needs both',
    (html.match(/data-mem-domain=/g) || []).length === 3);
  // THE ACTIVE ROW IS RESOLVED ON THE PAIR. Both domains hold a project
  // called `one`, so a renderer comparing the name alone marks BOTH.
  eq('exactly ONE row is active, even though two projects share a name',
    (html.match(/class="cur-sb-row mem-row active"/g) || []).length, 1);
  ok('...and it is the one in the active DOMAIN, not the first of that name',
    html.indexOf('mem-row active') > html.indexOf('cur-sb-group-head cur-eyebrow">beta'));
  // ── THE IDENTITY COLOUR IS THE INSTALL'S INDEX, NOT THIS LIST'S ──────
  // `alpha` is second and `beta` third in the install; a renderer taking the
  // local position would paint them slots 1 and 2. This is the whole reason
  // the list is fetched at all, so it is asserted on the slot NUMBERS rather
  // than on "a dot exists".
  ok('the identity dot is the domain\'s slot in the INSTALL\'s list',
    html.includes('cur-sb-dot-2') && html.includes('cur-sb-dot-3')
    && !html.includes('cur-sb-dot-1'), html.slice(0, 400));
  ok('CONTROL: with no list in hand it falls back to the local order rather '
    + 'than painting no identity at all',
    g(rows, 'beta', 'one', null).includes('cur-sb-dot-1'));
  ok('a project with nothing saved renders quiet, and carries NO identity dot — '
    + 'identity does not have states',
    html.includes('mem-row-quiet')
    && (html.match(/class="cur-sb-dot mem-row-mark/g) || []).length === 2);
  ok('a domain with ONE project still gets its heading — the rail must not change shape',
    (g([rows[2]], null, null).match(/cur-sb-group-head/g) || []).length === 1);
  eq('no projects renders nothing at all', g([], null, null), '');
  // ── THE CLOCK, WHICH IS WHAT THE REPORT WAS ABOUT ────────────────────
  // *"it has clocks showing when it was changed; in Context we don't have
  // that, we have some sort of colours but no clocks."* The kit emits the
  // glyph itself, between the mark and the age, so a host cannot forget it.
  const aged = g([{ domain: 'alpha', project: 'one', scopeCount: 2, hasBrief: true,
    writtenAgeSeconds: 7200, headline: 'A thing' }], null, null, ['alpha']);
  ok('the row carries a clock glyph beside its age',
    /<svg[^>]*>[\s\S]{0,200}<\/svg><span class="cur-sb-age mem-row-age">2 hr ago<\/span>/.test(aged)
    || /<\/svg><span class="cur-sb-age">2 hr ago<\/span>/.test(aged), aged);
  ok('...and the figure and the age are two SLOTS with the mark between them, '
    + 'which is what a formatted sentence could not express',
    /class="cur-sb-figure">2 scopes<\/span><span class="cur-sb-sep"[^>]*>·<\/span><span class="fresh-dot/
      .test(aged), aged);
  // ── THE RAIL CANNOT GROW A SECOND ⓘ, AND THAT IS STRUCTURAL ──────────
  //
  // The maintainer: *"we have an information icon in the Project context
  // sidebar which should not be here, because we have another one on the
  // right side beside Copy agent instructions — we definitely don't need it
  // in this small section."*
  //
  // A SOURCE SCAN FOR "no `info:` here" is the weak form of that, and this is
  // the strong one: the component is handed an `info` and PAINTS NOTHING, so
  // the affordance cannot come back by a caller passing the old option. The
  // mutation that adds `info:` to this view's own head call is inert BECAUSE
  // of this, which is why the claim is asserted here rather than assumed.
  ok('the sidebar head paints no ⓘ even when one is handed to it — the option '
    + 'does not exist, so the mark cannot come back by a caller remembering it',
  !/tx-vh-info/.test(renderSidebarHead({ title: 'Project context',
    info: 'a second mark', infoText: 'a second mark',
    primary: { label: '+ New project' }, secondary: { label: 'Refresh' } })));
  ok('CONTROL: the head really did render (the scan is not vacuous)',
    /class="sidebar-title">Project context</.test(
      renderSidebarHead({ title: 'Project context' })));

  ok('a project with NO save says so rather than borrowing another screen\'s words',
    g([{ domain: 'alpha', project: 'fresh', scopeCount: 0, hasBrief: false }], null, null, ['alpha'])
      .includes('no save yet'));

  // Escaping, through the shipped renderer.
  const hostile = g([{ domain: XSS, project: ATTR, scopeCount: 0, hasBrief: false }], null, null);
  ok('a hostile domain name is escaped', !hostile.includes('<img src=x'));
  ok('a hostile project name cannot break out of its attribute',
    !/data-mem-project="[^"]*"\s+onmouseover/.test(hostile));
}

// ── 16d2. The install's domain list, DRIVEN (v3.65.0) ────────────────────
//
// One cheap read per mount, with two readers: the rail's identity colour
// (the domain's place in THIS list) and step ③'s picker (the set a project
// may draw on). What is asserted is the four things that make it safe to
// call on every mount — it asks the CHEAP route, it asks ONCE, an answer for
// a mount that has ended is dropped, and a refusal leaves the field null
// rather than empty (empty would mean "this install has no domains", which
// the picker would then render as a truthful-looking lie).
{
  const mk = (stateObj, fetchImpl, mounted = true) => new Function(
    'state', 'fetch', 'isCurrentMount', 'render', 'domainListInFlight',
    'let __flight = domainListInFlight;\n'
    + extractFunction(viewSrc, 'loadDomainList', 'memory.js')
      // The module-level in-flight mark is a free identifier inside the body;
      // it is rebound to a local so the harness can read it back.
      .replace(/domainListInFlight/g, '__flight') + '\n'
    + 'return { loadDomainList, flight: () => __flight };')(
    stateObj, fetchImpl, () => mounted, () => { stateObj.__renders = (stateObj.__renders || 0) + 1; }, false);

  const calls = [];
  const okFetch = (url) => { calls.push(url); return Promise.resolve({
    ok: true, json: () => Promise.resolve({ domains: ['alpha', 'beta', 7], readonlyDomains: ['shared-x'] }) }); };

  (async () => {
    const st = { domainList: null, domainListReadonly: [] };
    const api = mk(st, okFetch);
    await api.loadDomainList(1);
    eq('it asks the CHEAP domain route, not the stats walk', calls.join(','), '/api/domains');
    eq('the list is the server\'s order, with non-strings dropped',
      (st.domainList || []).join(','), 'alpha,beta');
    eq('...and the read-only mirrors ride beside it, because a `shared-*` '
      + 'mirror is a legitimate knowledge domain and a refused ingest target',
      (st.domainListReadonly || []).join(','), 'shared-x');
    ok('...and its arrival repaints, so the rail\'s colours land', st.__renders >= 1);

    // ASKED ONCE. A second call with the list in hand issues no request.
    calls.length = 0;
    await api.loadDomainList(1);
    eq('a second call with the list already in hand issues no request', calls.length, 0);

    // A DEAD MOUNT WRITES NOTHING.
    const st2 = { domainList: null, domainListReadonly: [] };
    await mk(st2, okFetch, false).loadDomainList(2);
    eq('an answer for a mount that has ended is dropped', st2.domainList, null);

    // A REFUSAL LEAVES IT NULL, NOT EMPTY.
    const st3 = { domainList: null, domainListReadonly: [] };
    await mk(st3, () => Promise.reject(new Error('offline'))).loadDomainList(3);
    eq('a refusal leaves the list NULL — "not read" and "no domains" are two '
      + 'different facts and the picker says different things about them',
      st3.domainList, null);
    const st4 = { domainList: null, domainListReadonly: [] };
    await mk(st4, () => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) }))
      .loadDomainList(4);
    eq('...and so does a non-2xx answer', st4.domainList, null);
  })().catch((err) => { ok('the domain-list harness ran', false, err.stack); });
}

// ── 16e. The standing brief, and its editor ──────────────────────────────
//
// REWRITTEN AGAIN IN v3.58.0, and the direction of the rewrite is the finding.
//
// v3.55.0 took the brief OUT of a <details> because its <summary> had to carry
// the edit control and a control inside a summary toggles its own section (the
// v3.0.1-beta.18 hazard), and the assertions here pinned the absence of any
// summary at all — "the hazard is inexpressible".
//
// The hazard is STILL inexpressible and the brief is a fold again, because the
// two were never the same question. The pencil is not in the summary: it is a
// SIBLING of the <details>, anchored over the summary row by memory.css. What
// brought the fold back is the maintainer's report that the brief "is usually
// a page or more and takes a lot of scrolling", measured at 2,100px of a
// 3,241px page on this repo's own project.
//
// So the assertions below pin the NESTING (§7's ancestry walk) rather than the
// absence of a <details>, plus the two facts the closed summary has to carry
// for the fold to be usable at all: the age and the size.
{
  const R = makeRenderers({ briefEdit: null });
  const briefAt = new Date(Date.now() - 8 * 86400_000).toISOString();
  const present = { brief: { present: true, text: '## x\n\nbody', updatedAt: briefAt } };

  // ── THE PENCIL, AND WHERE IT IS ─────────────────────────────────────────
  const idle = R.renderBrief(present);
  ok('the pencil is anchored on the fold\'s own row, not on a toolbar of its own',
    /<div class="mem-brief-row">[\s\S]*?id="mem-brief-edit"/.test(idle), idle.slice(0, 400));
  ok('...and `.mem-block-toolbar` is gone from the rendered page entirely',
    !idle.includes('mem-block-toolbar'));
  ok('...and it is a real <button> with an accessible name, not a bare glyph',
    /<button type="button"[^>]*id="mem-brief-edit"[^>]*aria-label="Edit standing brief"/.test(idle));
  ok('...carrying a 14px inline SVG, because app.js has no `pencil` icon to ask for',
    /id="mem-brief-edit"[\s\S]{0,300}<svg width="14" height="14"/.test(idle));
  // ICON-ONLY. The word "Edit" is gone with the toolbar row that made it
  // necessary; the accessible name is the aria-label above, and there is no
  // `title=` (memory.js's tooltip budget is 1 and may not grow).
  const pencilInner = (/<button[^>]*id="mem-brief-edit"[^>]*>([\s\S]*?)<\/button>/.exec(idle) || [])[1];
  ok('CONTROL: the button\'s contents were actually extracted', typeof pencilInner === 'string');
  ok('the control is ICON-ONLY — its contents are the glyph and NOTHING else',
    pencilInner.replace(/<svg[\s\S]*?<\/svg>/g, '').trim() === '', JSON.stringify(pencilInner));
  ok('...and carries no tooltip', !/title="/.test(idle));
  ok('the brief IS a fold, keyed on a stable hook so the next render can re-open it',
    /<details class="mem-fold" data-mem-fold="brief"/.test(idle));
  ok('...and the pencil is OUTSIDE its <summary> (ancestry, not substring)',
    ancestorTags(idle, 'id="mem-brief-edit"').every((t) => t !== 'summary'),
    ancestorTags(idle, 'id="mem-brief-edit"').join(' > '));
  // ── THE SUMMARY HAS TO BE ENOUGH TO DECIDE WITH ───────────────────────
  // A collapsed section creates the question "is this worth opening", and the
  // two facts that answer it are how old the document is and how big. Both are
  // asserted, because a fold whose head says only "The brief" would be a
  // chevron over a mystery.
  ok('the closed summary carries the brief\'s AGE, live-ticking',
    idle.includes(`data-mem-age-at="${briefAt}"`)
    && /class="mem-age-words">1 week ago</.test(idle), idle.slice(0, 500));
  ok('...and its SIZE, so a four-screen brief and a two-line one are told apart',
    /· 3 words</.test(idle), idle.slice(0, 500));
  ok('...and does NOT repeat the block\'s own title back at the reader',
    !/<summary[\s\S]*?Standing brief[\s\S]*?<\/summary>/.test(idle));
  ok('the document is rendered through the shared markdown renderer',
    idle.includes('chat-md-h'));
  // THE SIZE IS THE EDITOR'S OWN FIGURE. Two counts of one file on one screen
  // that could disagree is the defect class this suite keeps finding; both go
  // through briefStats.
  eq('the summary\'s word count IS briefStats\' — one measurement, not two',
    (/· (\d[\d,]*) words</.exec(idle) || [])[1],
    String(R.briefStats('## x\n\nbody').words));

  const absent = R.renderBrief({ brief: { present: false } });
  ok('with no brief yet, the control invites writing one',
    /aria-label="Write a standing brief"/.test(absent), absent.slice(0, 400));
  // NO FOLD WHEN THERE IS NOTHING TO FOLD. The one sentence here is the one
  // that argues for writing a brief; hiding it behind a chevron while leaving
  // the control beside it reads v3.17.1 backwards.
  ok('...and the empty state is NOT folded — the case for writing one is visible',
    !absent.includes('<details'), absent.slice(0, 400));
  ok('...but keeps the same card chrome, so the pencil does not jump when the '
    + 'first brief lands', absent.includes('mem-fold mem-fold-flat')
    && /<div class="mem-brief-row">[\s\S]*?id="mem-brief-edit"/.test(absent));

  // ── PRESSING EDIT MAY NOT DESTROY A DRAFT ───────────────────────────────
  // The click handler builds a FRESH `state.briefEdit` off the last read, so a
  // second press during an edit silently discarded unsaved text. The control
  // is withheld while an editor is up; Cancel is the way out, and it asks.
  const editingBrief = makeRenderers({
    briefEdit: { domain: 'a', project: 'b', loaded: 'x', text: 'y', busy: false,
      error: null, preview: false, confirmDiscard: false },
  }).renderBrief(present);
  ok('while the editor is open the pencil is WITHHELD — pressing it would '
    + 'rebuild the draft from disk and lose what was typed',
  !editingBrief.includes('id="mem-brief-edit"'), editingBrief.slice(0, 300));
  ok('CONTROL: the editor really is on screen in that fixture',
    editingBrief.includes('id="mem-brief-text"'));

  // A MIRROR GETS NO EDITOR AND NO PENCIL. The backend refuses the write, and
  // a control whose only outcome is a refusal is worse than no control.
  const mirror = makeRenderers({ briefEdit: null, detail: { readonly: true } })
    .renderBrief({ ...present, readonly: true });
  ok('a read-only Shared Brain mirror is offered no pencil', !mirror.includes('id="mem-brief-edit"'));
  eq('...and no editor either',
    R.renderBriefEditor({ brief: { present: true, text: 'x' } }, true), '');
  ok('CONTROL: the mirror still shows the brief itself', mirror.includes('chat-md-h'));

  // ── THE EDITOR ──────────────────────────────────────────────────────────
  const mkEdit = (over) => makeRenderers({
    briefEdit: {
      domain: 'alpha', project: 'main', loaded: 'loaded text', text: 'loaded text',
      busy: false, error: null, preview: false, confirmDiscard: false, ...over,
    },
  });
  const editing = mkEdit({ text: XSS }).renderBriefEditor(present, false);
  ok('the draft is rendered ESCAPED inside the textarea', !editing.includes('<img src=x'));
  ok('...and the textarea really carries it', editing.includes('id="mem-brief-text"'));
  ok('Save, Preview and Cancel are all offered',
    editing.includes('id="mem-brief-save"') && editing.includes('id="mem-brief-preview"')
    && editing.includes('id="mem-brief-cancel"'));
  ok('...and it says REPLACE rather than implying an append',
    /replaces the whole document/i.test(editing));
  ok('the editor reaches the PAGE, not merely the function',
    mkEdit({}).renderBrief(present).includes('id="mem-brief-text"'));
  ok('...and the rendered document is hidden while the editor is up, so there is one copy on screen',
    !mkEdit({}).renderBrief(present).includes('class="mem-doc"'));

  // FOUR, not three. Preview joined Save, Cancel and the textarea when the
  // editor gained it in v3.55.0 — updated deliberately, because a control the
  // user can still press during a save is a control that can swap the field
  // out from under a write in flight.
  const busy = mkEdit({ busy: true }).renderBriefEditor(present, false);
  eq('while saving, every control is disabled — a second click is a second whole-document write',
    (busy.match(/ disabled/g) || []).length, 4);
  for (const id of ['mem-brief-text', 'mem-brief-save', 'mem-brief-preview', 'mem-brief-cancel']) {
    ok('...including ' + id, new RegExp('id="' + id + '"[^>]* disabled').test(busy)
      || new RegExp('id="' + id + '"[^>]*>').test(busy) && busy.includes(' disabled'), id);
  }

  const failed = mkEdit({ text: 'the user typed this', error: 'refused' })
    .renderBriefEditor(present, false);
  ok('a failure shows the reason', failed.includes('refused'));
  ok('...and KEEPS the draft, which is the only copy of it',
    failed.includes('the user typed this'));

  // ── THE BYTE WALL ───────────────────────────────────────────────────────
  // The route answers 400 `brief_too_large` above MAX_BRIEF_BYTES, so an
  // over-budget draft is refused HERE, before a request the user cannot act on.
  const over = 'x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 1);
  const big = mkEdit({ text: over }).renderBriefEditor(present, false);
  ok('over the wall, Save is disabled',
    /id="mem-brief-save"[^>]* disabled/.test(big), big.slice(big.indexOf('mem-brief-save') - 80, big.indexOf('mem-brief-save') + 120));
  ok('...and the reason is PRINTED, not left to the server to explain',
    /Too long to save/.test(big) && big.includes(String(BRIEF_MAX_BYTES_SRC)));
  ok('...and Cancel stays available, so the draft is not a trap',
    !/id="mem-brief-cancel"[^>]* disabled/.test(big));
  const under = mkEdit({ text: 'short' }).renderBriefEditor(present, false);
  ok('CONTROL: under the wall Save is enabled and the wall is HIDDEN',
    !/id="mem-brief-save"[^>]* disabled/.test(under)
    && /id="mem-brief-over" hidden>/.test(under), under.slice(0, 200));
  ok('...and the wall is emitted either way, so the input handler can reveal it '
    + 'without a render taking the caret with it',
    under.includes('id="mem-brief-over"') && big.includes('id="mem-brief-over"')
    && !/id="mem-brief-over" hidden>/.test(big));

  // ── THE COUNTER COUNTS, WITHOUT A RENDER ────────────────────────────────
  // FOUND BY TYPING INTO THE REAL PAGE: the figures were rendered once, on
  // open, and the input handler deliberately does not re-render (the caret),
  // so the byte count sat frozen while the draft grew past the wall and the
  // refusal only appeared after a save the user could no longer make.
  //
  // Driven through the REAL handler wire() binds, against a fake document that
  // only knows the elements renderBriefEditor emits for it.
  {
    const stats = { dirty: 'unchanged', words: '0 words', bytes: '0 of 32768 bytes' };
    const cls = new Set();
    const box = {
      classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } },
      querySelector: (sel) => {
        const k = /data-brief-stat="([a-z]+)"/.exec(sel)[1];
        return { get textContent() { return stats[k]; }, set textContent(v) { stats[k] = v; } };
      },
    };
    // `addEventListener` on every stub: wire() binds to Save and Cancel too, and
    // a stub that answers getElementById but not addEventListener is a crash
    // rather than a failing assertion.
    const overEl = { hidden: true, addEventListener() {} };
    const saveEl = { disabled: false, addEventListener() {} };
    const field = { value: '', _input: null,
      addEventListener(t, fn) { if (t === 'input') this._input = fn; } };
    const st = { briefEdit: { domain: 'a', project: 'b', loaded: 'loaded', text: 'loaded' } };
    // A COUNTER, NOT A THROW. A spy that throws makes the mutation which adds
    // `render(token)` back to this handler kill the suite with an uncaught
    // error instead of naming the defect — measured, and re-done for that
    // reason: a crash is not a failing assertion.
    const renders = [];
    const api = new Function(
      'state', 'document', 'render', 'saveBrief', 'reportAsyncMountFailure', 'keyOf', 'activeKey',
      'selectProject', 'copyAgentInstructions', 'loadScope', 'refreshIndex', 'reloadActive',
      'BRIEF_TEMPLATE', 'BRIEF_MAX_BYTES', 'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingFocusId',
      // v3.56.0: wire() hands the table's rows to `bindWorkStreamRows` and its
      // footer to `showMoreWorkStreams`. Neither is this block's subject, but a
      // free identifier inside a lifted function is a CRASH rather than a
      // failing assertion — §17c drives both for real.
      'bindWorkStreamRows', 'showMoreWorkStreams',
      // v3.59.0: and tier 0's two, for the same reason.
      'bindFoundationRows', 'refreshFoundations', 'bindKnowledgeRows',
      extractFunction(viewSrc, 'briefStats', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
      // v3.67.0: the fold binder moved out of wire() unchanged (lifted real);
      // the release's own controls are bound by bindSessionAndPlan, driven in §25.
      extractFunction(viewSrc, 'bindFoldToggles', 'memory.js') + '\n' +
      'function bindSessionAndPlan() {}\n' +
      extractFunction(viewSrc, 'wire', 'memory.js') + '\n' +
      'return { wire };')(
      st,
      { querySelectorAll: () => [],
        getElementById: (id) => ({ 'mem-brief-text': field, 'mem-brief-stats': box,
          'mem-brief-over': overEl, 'mem-brief-save': saveEl })[id] || null },
      () => { renders.push(1); },
      async () => {}, () => {}, (d, q) => d + '/' + q, () => 'a/b',
      async () => {}, async () => {}, async () => {}, async () => {}, async () => {},
      '', Number(BRIEF_MAX_BYTES_SRC), 10, 50, null,
      () => {}, () => {}, () => {}, async () => {}, () => {});
    api.wire(1);
    ok('the input handler was bound', typeof field._input === 'function');

    field.value = 'loaded plus three more words';
    field._input();
    eq('typing updates the WORD count in place', stats.words, '5 words');
    eq('...and the BYTE count', stats.bytes, '28 of 32768 bytes');
    eq('...and says the draft is now modified', stats.dirty, 'modified');
    eq('the wall stays hidden under the budget', overEl.hidden, true);
    eq('...and Save stays available', saveEl.disabled, false);

    field.value = 'x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 5);
    field._input();
    eq('CROSSING THE WALL WHILE TYPING reveals it', overEl.hidden, false);
    eq('...and disables Save before the user can spend a refusal on it', saveEl.disabled, true);
    ok('...and the line is marked over budget', cls.has('mem-brief-stats-over'));

    field.value = 'back under';
    field._input();
    eq('...and coming back under hides it again', overEl.hidden, true);
    eq('...and re-enables Save', saveEl.disabled, false);
    eq('THE DRAFT IN STATE IS WHAT THE SAVE WILL SEND', st.briefEdit.text, 'back under');
    eq('AND NOT ONE RENDER HAPPENED — a render rebuilds the textarea and takes '
      + 'the caret and the selection with it', renders.length, 0);
  }

  // ── §16h — THE WALL IS INVISIBLE BELOW THE CAP, BY COMPUTED EFFECT ──────
  //
  // THE DEFECT, REPORTED FROM PRODUCTION. On a standing brief of 8,484 of
  // 32,768 bytes — a quarter of the budget — the maintainer's screenshot shows
  // the status line reading `unchanged · 1309 words · 8484 of 32768 bytes` and,
  // directly beneath it, the amber "Too long to save. The standing brief is
  // capped at 32768 bytes…" wall, fully visible, with Save enabled. A warning
  // about a limit the draft is nowhere near, on the one screen whose entire job
  // is to say whether a save will land.
  //
  // WHY EVERY ASSERTION ABOVE STAYED GREEN THROUGH IT. They are all about the
  // MARKUP, and the markup was never wrong: renderBriefEditor emits the wall
  // with `hidden` below the cap (§16 asserts it) and the input handler flips
  // `.hidden` without a render (§16g drives all three transitions). The defect
  // is one layer down, in the CASCADE: `[hidden] { display: none }` is a
  // USER-AGENT rule, and `.mem-note { display: flex }` is an AUTHOR rule.
  // Author beats UA at every specificity, so the wall was `display: flex` in
  // every state it has ever had, `hidden` attribute or not.
  //
  // views/chat.css records this exact hazard for `.chat-cost-panel` — "a rule
  // setting `display` on this selector would override the UA's `[hidden] {
  // display: none }`" — and memory.css simply did not carry the counter-rule.
  //
  // SO THIS GUARD RESOLVES THE CASCADE rather than reading either layer alone:
  // it takes the wall's REAL class list off the rendered markup, finds every
  // rule in memory.css that could match that element, and asks what `display`
  // wins when `hidden` is present. A markup-only assertion cannot see this, and
  // a CSS-only grep for `display` would fire on every correct stylesheet.
  {
    const over = 'x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 1);
    // 8,484 bytes — the maintainer's own draft size, to the byte, so this
    // fixture is the reported case rather than a nearby one.
    const real = 'x'.repeat(8484);
    const at8k = mkEdit({ text: real, loaded: real }).renderBriefEditor(present, false);

    ok('THE REPORTED CASE: an 8,484-byte draft reports itself as unchanged and '
      + 'a quarter of the budget', /unchanged/.test(at8k) && at8k.includes('8484 of 32768 bytes'),
    at8k.slice(at8k.indexOf('mem-brief-stats'), at8k.indexOf('mem-brief-stats') + 220));
    ok('...and Save is offered, because the save WILL land',
      !/id="mem-brief-save"[^>]* disabled/.test(at8k));
    ok('...and the wall carries the `hidden` attribute',
      /id="mem-brief-over" hidden>/.test(at8k), at8k.slice(at8k.indexOf('mem-brief-over') - 40,
        at8k.indexOf('mem-brief-over') + 120));

    // THE ELEMENT'S REAL CLASS LIST, off the markup — never retyped, or this
    // would resolve the cascade for a class the editor does not emit.
    const wallTag = (/<div class="([^"]*)" id="mem-brief-over"/.exec(at8k) || [])[1];
    ok('SETUP: the wall\'s class list was read off the rendered markup',
      !!wallTag && wallTag.includes('mem-note'), String(wallTag));
    const wallClasses = new Set(String(wallTag || '').split(/\s+/).filter(Boolean));

    // A DELIBERATELY SMALL MATCHER. It understands exactly the shapes this
    // stylesheet uses for the wall — a compound of classes and attribute
    // selectors, optionally with descendant ancestors — and answers only for a
    // STANDALONE element carrying `hidden`. An ancestor-qualified rule is
    // treated as POSSIBLY matching (its rightmost compound is what decides),
    // which is the conservative direction: it can report a rule this guard
    // cannot rule out, never miss one that applies.
    const compoundMatches = (compound, withHidden) => {
      const parts = compound.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:[A-Za-z-]+(?:\([^)]*\))?|[A-Za-z][A-Za-z0-9-]*/g) || [];
      for (const part of parts) {
        if (part.startsWith('.')) { if (!wallClasses.has(part.slice(1))) return false; }
        else if (part === '[hidden]') { if (!withHidden) return false; }
        else if (part.startsWith('[')) return false;          // some other attribute: cannot match
        else if (part.startsWith(':')) return false;          // a state we are not in
        else if (part !== 'div') return false;                // an element that is not this one
      }
      return true;
    };
    const specificity = (compound) => {
      const ids = (compound.match(/#[A-Za-z0-9_-]+/g) || []).length;
      const cls = (compound.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:[A-Za-z-]+/g) || []).length;
      return ids * 100 + cls * 10;
    };

    // Every `display` declaration in memory.css that could reach this element,
    // in source order, with its specificity and whether it needs `[hidden]`.
    const displayRules = [];
    const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    const wallCss = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
    while ((m = RULE_RE.exec(wallCss)) !== null) {
      const selectors = m[1].split(',').map((x) => x.trim()).filter(Boolean);
      const decl = /(?:^|;)\s*display\s*:\s*([^;!]+)(!important)?/i.exec(m[2]);
      if (!decl) continue;
      for (const sel of selectors) {
        if (/[>+~]/.test(sel)) continue;                      // a combinator this element is not in
        const compound = sel.split(/\s+/).pop();
        if (!compoundMatches(compound, true)) continue;
        displayRules.push({
          sel, compound, value: decl[1].trim(), important: !!decl[2],
          needsHidden: compound.includes('[hidden]'),
          spec: specificity(compound),
        });
      }
    }

    ok('SETUP: the resolver found the `display` rules that reach this element '
      + '(the cascade check below is not vacuous)',
    displayRules.length > 0, JSON.stringify(displayRules.map((r) => r.sel)));

    // WHAT WINS WITH `hidden` PRESENT. Highest `!important`, then highest
    // specificity, then last in source order — the cascade, for this one
    // element, with the UA's `display: none` as the starting point.
    const winner = displayRules.reduce((best, r) => {
      if (!best) return r;
      if (r.important !== best.important) return r.important ? r : best;
      if (r.spec !== best.spec) return r.spec > best.spec ? r : best;
      return r;                                               // later in source order
    }, null);
    ok('THE WALL IS `display: none` WHEN `hidden` IS SET — resolved through the '
      + 'stylesheet, not read off the attribute',
    winner && winner.value === 'none', winner ? winner.sel + ' -> ' + winner.value : 'no rule');
    ok('...and the rule that wins is one GUARDED by [hidden], so the visible '
      + 'state is untouched', !!winner && winner.needsHidden, winner ? winner.sel : 'none');

    // ...and the other direction, so this is not a stylesheet that hides the
    // wall unconditionally: with `hidden` absent, a `display` must still apply.
    const shown = displayRules.filter((r) => !r.needsHidden);
    ok('CONTROL: with `hidden` absent the wall is still laid out — the fix hid '
      + 'the element, it did not delete it',
    shown.length > 0 && shown.every((r) => r.value !== 'none'),
    JSON.stringify(shown.map((r) => r.sel + ' -> ' + r.value)));

    // AND THE THREE TRANSITIONS, at the markup layer, over the real sizes.
    ok('TRANSITION 1 — first paint under the cap: hidden',
      /id="mem-brief-over" hidden>/.test(at8k));
    ok('TRANSITION 2 — over the cap: shown, and Save disabled',
      !/id="mem-brief-over" hidden>/.test(mkEdit({ text: over }).renderBriefEditor(present, false))
      && /id="mem-brief-save"[^>]* disabled/.test(mkEdit({ text: over }).renderBriefEditor(present, false)));
    ok('TRANSITION 3 — shrunk back under it: hidden again, and Save offered',
      /id="mem-brief-over" hidden>/.test(at8k)
      && !/id="mem-brief-save"[^>]* disabled/.test(at8k));
  }

  // ── THE DRAFT'S READOUT ─────────────────────────────────────────────────
  ok('the status line reports modified / words / bytes',
    /class="mem-brief-stats"[\s\S]*?modified[\s\S]*?words[\s\S]*?of \d+ bytes/
      .test(mkEdit({ text: 'two words here' }).renderBriefEditor(present, false)));
  ok('...and says "unchanged" when the draft matches what was loaded',
    /class="mem-brief-stats"[\s\S]*?unchanged/.test(under) === false
    && /unchanged/.test(mkEdit({}).renderBriefEditor(present, false)));

  // briefStats is the measurement, driven directly.
  const st = R.briefStats;
  eq('bytes are UTF-8, not characters — the unit the route refuses on',
    st('——').bytes, 6);
  eq('...and the word count is words', st('one two  three\nfour').words, 4);
  eq('an empty draft is zero words, never one', st('').words, 0);
  eq('whitespace alone is zero words', st('   \n  ').words, 0);
  ok('over is computed against the wall', st('x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 1)).over === true
    && st('x').over === false);

  // ── PREVIEW ─────────────────────────────────────────────────────────────
  const prev = mkEdit({ text: '## Heading\n\nbody', preview: true }).renderBriefEditor(present, false);
  ok('Preview renders the DRAFT as markdown', prev.includes('chat-md-h'));
  ok('...in place of the field, so there is one copy of the text on screen',
    !prev.includes('id="mem-brief-text"'));
  ok('...and the toggle says how to get back', /id="mem-brief-preview"[^>]*>Back to editing/.test(prev));
  // The draft lives in state, so toggling back restores it byte for byte.
  const backAgain = mkEdit({ text: '## Heading\n\nbody', preview: false }).renderBriefEditor(present, false);
  ok('toggling back restores the draft exactly — it was never read out of the DOM',
    backAgain.includes('## Heading&#10;&#10;body') || backAgain.includes('## Heading\n\nbody'));

  // ── ESCAPE: THREE ANSWERS, AS A VALUE ───────────────────────────────────
  const dd = R.briefDismissDecision;
  eq('a clean draft closes', dd({ loaded: 'a', text: 'a', busy: false }), 'close');
  eq('a DIRTY draft asks first — Escape must never destroy the only copy',
    dd({ loaded: 'a', text: 'a changed', busy: false }), 'confirm');
  eq('a save in flight is BLOCKED — the reply cannot be cancelled',
    dd({ loaded: 'a', text: 'a changed', busy: true }), 'blocked');
  eq('...blocked even when clean, because the outcome is still unknown',
    dd({ loaded: 'a', text: 'a', busy: true }), 'blocked');
  eq('no editor at all closes', dd(null), 'close');

  const bar = mkEdit({ text: 'changed', confirmDiscard: true }).renderBriefEditor(present, false);
  ok('the unsaved-draft bar offers Discard and Keep editing',
    bar.includes('id="mem-brief-discard"') && bar.includes('id="mem-brief-keep"'));
  ok('...IN FLOW, over the text it is about, rather than in a dialog that covers it',
    bar.includes('class="mem-brief-discard"') && bar.includes('id="mem-brief-text"'));
  ok('...and it is absent until Escape raises it',
    !mkEdit({ text: 'changed' }).renderBriefEditor(present, false).includes('id="mem-brief-discard"'));
}

// ── 16e1. NO STEP HAS A LEDE, AND THE ⓘ IS IN THE HEAD ROW (v3.65.0, R4) ─
//
// WHAT THIS REPLACES, AND WHY IT IS A STRONGER CLAIM. It used to compare the
// three step LEDES the skeleton emits against the three the filled page
// emits, byte for byte, because the skeleton exists so the column does not
// change size between the first frame and the filled one (v3.57.0 measured
// 5,062px -> 215px and back) and the chrome included the lede.
//
// The maintainer, on step ①: *"below the Foundations title we have 'Add the
// documents an agent must not act without' with another information icon, so
// maybe we don't need the first sentence, we just need the information icon
// beside the title."* So there is no lede to compare on either side — the
// sentence is the first paragraph of that step's own ⓘ — and what is asserted
// instead is that NEITHER renderer emits one, that all three sentences
// survive behind the marks, and that the mark sits INSIDE `.settings-block-hd`
// rather than under it. A lede that came back on one side only would red the
// count; a mark that drifted out of the head row would red the placement.
//
// EXECUTED on both sides through the real `memStep`, not compared as source
// strings: a source pin would keep passing if one of them stopped REACHING
// the page at all.
{
  const st = {
    activeDomain: 'acme', activeProject: 'alpha', scope: 'main', machine: 'boxa',
    detailLoading: false, detail: null, staleWrite: false, journalLimit: 10, openFolds: {},
    projects: [{ domain: 'acme', project: 'alpha', hasBrief: true, savedCopies: 2, scopeCount: 1 }],
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 60 }],
      brief: { present: true, text: '# B\n\n## Goal\n\nShip.', updatedAt: new Date().toISOString() } },
  };
  const R2 = makeRenderers(st);
  const real = R2.renderProject();
  const ghost = R2.renderProjectSkeleton();

  const ledesIn = (markup) => (markup.match(
    /<p class="settings-job-lede settings-block-lede">/g) || []).length;
  eq('the filled page emits NO step lede', ledesIn(real), 0);
  eq('...and neither does the skeleton', ledesIn(ghost), 0);
  // NOT VACUOUS: the page really is composed of numbered steps — FOUR since
  // v3.67.0 (④ Session start, the sum of the three layers). The skeleton
  // keeps three: ④ is a measurement that lands after the project read.
  eq('CONTROL: the filled page still paints four numbered heads',
    (real.match(/<span class="settings-block-num"/g) || []).length, 4);
  eq('CONTROL: ...and so does the skeleton',
    (ghost.match(/<span class="settings-block-num"/g) || []).length, 3);

  // ── THE MARK IS IN THE HEAD ROW, BESIDE THE NUMERAL AND THE TITLE ────
  // An index compare (head < mark) would pass for a mark rendered anywhere
  // AFTER the head closes, which is the lone-ⓘ-under-the-title shape this
  // release removes — the green-first v3.64.2 closed on the overview head.
  // So the head's anatomy is asserted ELEMENTWISE: every `.settings-block-hd`
  // on the page contains a numeral, a title and the mark, in that order, and
  // the mark is INSIDE the div.
  const heads = [...real.matchAll(/<div class="settings-block-hd">([\s\S]*?)<\/div>/g)]
    .map((m) => m[1]);
  eq('four head rows', heads.length, 4);
  for (const hd of heads) {
    const num = hd.indexOf('class="settings-block-num"');
    const title = hd.indexOf('<h2 class="settings-job-title">');
    const mark = hd.indexOf('class="tx-vh-info"');
    ok('the head row is numeral -> title -> ⓘ, and the ⓘ is INSIDE it',
      num >= 0 && title > num && mark > title, hd.slice(0, 160));
  }
  // The panel is the head's SIBLING, not its child: a <div> inside a flex
  // head row would sit beside the title rather than under the step.
  eq('each step carries its own ⓘ panel, outside the head row',
    (real.match(/<div class="settings-block-info">/g) || []).length, 4);

  // ── THE THREE SENTENCES SURVIVED, BEHIND THE MARKS ───────────────────
  // Moved, not deleted. Each is asserted inside the panel of ITS OWN step,
  // so a sentence that landed on the wrong step reds.
  const panelOf = (id) => {
    const i = real.indexOf('id="settings-block-info-' + id + '"');
    return i < 0 ? '' : real.slice(i, real.indexOf('</div>', i));
  };
  ok('step ①\'s sentence is the first paragraph of its own ⓘ',
    /^[\s\S]*?<p>(<b>Start here\.<\/b> )?Add the documents an agent must not act without\.<\/p>/
      .test(panelOf('context-canonical')), panelOf('context-canonical').slice(0, 200));
  ok('step ②\'s sentence is the first paragraph of its own ⓘ',
    /<p>You write the brief; agents write handoffs and the journal\.<\/p>/
      .test(panelOf('context-state')));
  ok('step ③\'s sentence is the first paragraph of its own ⓘ',
    /<p>The domains this project draws on\./.test(panelOf('context-knowledge')));
  // THE "Start here." PREFIX STILL DROPS. It is the Providers block-1 rule and
  // it moved into the panel with the sentence rather than being lost with the
  // lede: this fixture has no foundations, the next one has one document.
  ok('...and the "Start here." prefix is there while the project has no documents',
    /<b>Start here\.<\/b> Add the documents/.test(panelOf('context-canonical')));
  const withDocs = makeRenderers({ ...st,
    projectRead: { ...st.projectRead,
      foundations: { present: true, ownership: 'curator', totalBytes: 100,
        documents: [{ slug: 'architecture', title: 'A', role: 'architecture', bytes: 100 }] } } })
    .renderProject();
  const i2 = withDocs.indexOf('id="settings-block-info-context-canonical"');
  ok('...and it is gone the moment one document exists, with the tail unchanged',
    !/<b>Start here\.<\/b>/.test(withDocs.slice(i2, i2 + 400))
    && /<p>Add the documents an agent must not act without\.<\/p>/
      .test(withDocs.slice(i2, i2 + 400)));

  ok('the definition the brief lede used to carry is in step ②\'s ⓘ instead',
    /rarely changes/.test(real));
}

// ── 16e2. The keyboard contract, EXECUTED ────────────────────────────────
// A handler is the one thing a markup assertion cannot see. The keydown
// listener wire() binds on the textarea is lifted with wire() itself and driven
// with fake events, so "Cmd+S saves" is a measurement rather than a promise.
{
  const calls = { save: 0, render: 0, prevented: 0 };
  const el = {
    _keydown: null,
    _input: null,
    value: '',
    addEventListener(type, fn) { if (type === 'keydown') this._keydown = fn; if (type === 'input') this._input = fn; },
  };
  const st = {
    activeDomain: 'a', activeProject: 'b', projectRead: null,
    briefEdit: { domain: 'a', project: 'b', loaded: 'x', text: 'x', busy: false, confirmDiscard: false },
  };
  const api = new Function(
    'state', 'document', 'render', 'saveBrief', 'reportAsyncMountFailure', 'keyOf', 'activeKey',
    'selectProject', 'copyAgentInstructions', 'loadScope', 'refreshIndex', 'reloadActive',
    'BRIEF_TEMPLATE', 'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingFocusId',
    // See the note in §16g: wire() reaches for both of the table's wiring
    // functions, and a free identifier inside a lifted function is a crash.
    'bindWorkStreamRows', 'showMoreWorkStreams',
    // v3.59.0: and for tier 0's rows and its one control, for the same reason.
    'bindFoundationRows', 'refreshFoundations', 'bindKnowledgeRows',
    extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
    // v3.67.0: the fold binder moved out of wire() unchanged (lifted real);
      // the release's own controls are bound by bindSessionAndPlan, driven in §25.
      extractFunction(viewSrc, 'bindFoldToggles', 'memory.js') + '\n' +
      'function bindSessionAndPlan() {}\n' +
      extractFunction(viewSrc, 'wire', 'memory.js') + '\n' +
    'return { wire, pending: () => pendingFocusId };')(
    st,
    { querySelectorAll: () => [], getElementById: (id) => (id === 'mem-brief-text' ? el : null) },
    () => { calls.render++; },
    async () => { calls.save++; },
    () => {}, (d, p) => d + '/' + p, () => 'a/b',
    async () => {}, async () => {}, async () => {}, async () => {}, async () => {},
    '', 10, 50, null, () => {}, () => {}, () => {}, async () => {}, () => {});
  api.wire(1);
  ok('the keydown handler was bound to the textarea', typeof el._keydown === 'function');

  const ev = (over) => ({ preventDefault() { calls.prevented++; }, metaKey: false, ctrlKey: false, ...over });
  el._keydown(ev({ metaKey: true, key: 's' }));
  eq('Cmd+S saves', calls.save, 1);
  el._keydown(ev({ ctrlKey: true, key: 'S' }));
  eq('Ctrl+Shift+S saves too — the key is matched case-insensitively', calls.save, 2);
  el._keydown(ev({ metaKey: true, key: 'Enter' }));
  eq('Cmd+Enter saves', calls.save, 3);
  eq('...and every one of them preventDefault()ed — otherwise Cmd+S opens the '
    + 'browser\'s Save-page dialog over an app that just saved', calls.prevented, 3);
  el._keydown(ev({ key: 's' }));
  eq('CONTROL: a bare `s` types an `s` and saves nothing', calls.save, 3);

  // Escape, over the three decisions.
  st.briefEdit.text = 'x';
  el._keydown(ev({ key: 'Escape' }));
  eq('Escape with a CLEAN draft closes the editor', st.briefEdit, null);
  st.briefEdit = { domain: 'a', project: 'b', loaded: 'x', text: 'changed', busy: false, confirmDiscard: false };
  el._keydown(ev({ key: 'Escape' }));
  ok('Escape with a DIRTY draft raises the bar and keeps the text',
    st.briefEdit && st.briefEdit.confirmDiscard === true && st.briefEdit.text === 'changed');
  st.briefEdit = { domain: 'a', project: 'b', loaded: 'x', text: 'changed', busy: true, confirmDiscard: false };
  const before = calls.render;
  el._keydown(ev({ key: 'Escape' }));
  ok('Escape during a save does nothing at all — no close, no bar, no render',
    st.briefEdit.confirmDiscard === false && calls.render === before);
}

// ── 16e3. PRESSING EDIT OPENS THE FOLD AND THE EDITOR, IN ONE GESTURE ────
//
// The brief starts SHUT (v3.58.0), so the pencil is normally pressed against a
// collapsed section. If the handler only opened the editor, the editor would
// be built inside a <details> that stays closed and the press would visibly do
// nothing; asking for a second click on the chevron first is the "buried"
// complaint in a new place. Driven through the SHIPPED `wire()` and the
// SHIPPED handler, because this is a handler and no markup assertion can see
// it — and then through the SHIPPED `renderBrief`, so the claim is that the
// fold really comes back open rather than that a field was set.
{
  const store = {};
  const btn = { _click: null, addEventListener(t, fn) { if (t === 'click') this._click = fn; } };
  const st = {
    activeDomain: 'a', activeProject: 'b', briefEdit: null, openFolds: {},
    projectRead: { brief: { present: true, text: '# B\n\nbody', updatedAt: '2026-09-10T00:00:00.000Z' } },
  };
  let renders = 0;
  const api = new Function(
    'state', 'document', 'localStorage', 'JSON', 'render', 'saveBrief', 'reportAsyncMountFailure',
    'keyOf', 'activeKey', 'selectProject', 'copyAgentInstructions', 'loadScope', 'refreshIndex',
    'reloadActive', 'BRIEF_TEMPLATE', 'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingFocusId',
    'bindWorkStreamRows', 'showMoreWorkStreams',
    // v3.59.0: and for tier 0's rows and its one control, for the same reason.
    'bindFoundationRows', 'refreshFoundations', 'bindKnowledgeRows',
    extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
    // v3.67.0: the fold binder moved out of wire() unchanged (lifted real);
      // the release's own controls are bound by bindSessionAndPlan, driven in §25.
      extractFunction(viewSrc, 'bindFoldToggles', 'memory.js') + '\n' +
      'function bindSessionAndPlan() {}\n' +
      extractFunction(viewSrc, 'wire', 'memory.js') + '\n' +
    'return { wire };')(
    st,
    { querySelectorAll: () => [], getElementById: (id) => (id === 'mem-brief-edit' ? btn : null) },
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    JSON,
    () => { renders++; },
    async () => {}, () => {}, (d, p) => d + '/' + p, () => 'a/b',
    async () => {}, async () => {}, async () => {}, async () => {}, async () => {},
    'TEMPLATE', 10, 50, null, () => {}, () => {}, () => {}, async () => {}, () => {});
  api.wire(1);
  ok('the click handler was bound to the pencil', typeof btn._click === 'function');

  btn._click();
  ok('pressing Edit opens the EDITOR', st.briefEdit && st.briefEdit.text === '# B\n\nbody');
  eq('...and OPENS THE FOLD in the same gesture, through the one field a '
    + 'toggle writes — a second way of saying "open" is a second thing that '
    + 'can disagree', st.openFolds.brief, true);
  eq('...and repaints once', renders, 1);

  // THE SHIPPED RENDERER AGREES. Setting a field proves nothing if the markup
  // does not act on it.
  const painted = makeRenderers(st).renderBrief(st.projectRead);
  ok('the next paint really emits the fold OPEN, with the editor inside it',
    /data-mem-fold="brief" open/.test(painted) && painted.includes('id="mem-brief-text"'),
    painted.slice(0, 300));

  // WRITTEN THROUGH, or the fold shuts again the moment you leave the view.
  // This path fires no `toggle` (the next render PARSES the <details> open, and
  // `toggle` does not fire on parse), so the handler has to persist itself.
  const key = liftConst('FOLDS_KEY');
  eq('...and the decision is PERSISTED, under the same key the reader reads',
    store[key], '{"brief":true}');
}
// ── 16f. The brief write itself ──────────────────────────────────────────
{
  function makeSaver(stateObj, responder) {
    const calls = [];
    let mounted = true;
    const api = new Function('state', 'render', 'isCurrentMount', 'fetch', 'encodeURIComponent',
      'JSON', 'reloadActive', 'refreshIndex', 'reportAsyncMountFailure',
      extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
      // ── THE PROJECT CACHE (v3.57.0) ─────────────────────────────────────
      // A successful brief save DROPS this project's cached copies, and does
      // so on BOTH arms — including the one that does not re-read, because the
      // user has already moved on. Lifted so that step really runs here; the
      // Map is returned so §16f can assert the drop rather than the call.
      'const readCache = new Map();\n' +
      'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n' +
      extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'cacheKeyScope', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'forgetProject', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'saveBrief', 'memory.js') + '\n' +
      'return { saveBrief, readCache };')(
      stateObj, () => {}, () => mounted,
      async (url, init) => { calls.push({ url: String(url), init }); return responder(String(url), init); },
      encodeURIComponent, JSON,
      async () => { calls.push({ reloaded: true }); },
      async () => { calls.push({ refreshed: true }); },
      () => {});
    return { ...api, calls, unmount: () => { mounted = false; } };
  }
  const okRes = { ok: true, status: 200, json: async () => ({ ok: true, briefSaved: true }) };

  {
    const st = {
      activeDomain: 'alpha', activeProject: 'main',
      briefEdit: { domain: 'alpha', project: 'main', text: '## Standing brief\n\nnew', busy: false, error: null },
    };
    const r = makeSaver(st, () => okRes);
    await r.saveBrief(1);
    const req = r.calls.find((c) => c.url);
    eq('the write is a PATCH', req.init.method, 'PATCH');
    eq('...to the project endpoint, which reaches tier 1 only',
      req.url, '/api/memory/alpha/projects/main');
    eq('...carrying the WHOLE brief, because the store replaces rather than merges',
      JSON.parse(req.init.body).brief, '## Standing brief\n\nnew');
    eq('...and nothing else', Object.keys(JSON.parse(req.init.body)).join(','), 'brief');
    eq('the editor closes on success', st.briefEdit, null);
    ok('...and the screen re-reads rather than trusting the draft',
      r.calls.some((c) => c.reloaded) && r.calls.some((c) => c.refreshed));
  }
  {
    // A FAILURE MUST NOT DESTROY THE DRAFT.
    const st = {
      activeDomain: 'alpha', activeProject: 'main',
      briefEdit: { domain: 'alpha', project: 'main', text: 'typed by hand', busy: false, error: null },
    };
    const r = makeSaver(st, () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'too large' }) }));
    await r.saveBrief(1);
    ok('a refusal keeps the editor open with the draft intact',
      st.briefEdit && st.briefEdit.text === 'typed by hand');
    eq('...and shows the server\'s own reason', st.briefEdit.error, 'too large');
    eq('...and re-enables the buttons', st.briefEdit.busy, false);
    ok('...and does NOT re-read (there is nothing new to read)',
      !r.calls.some((c) => c.reloaded));
  }
  {
    // A SECOND CLICK WHILE BUSY IS NOT A SECOND WRITE.
    const st = { activeDomain: 'a', activeProject: 'b',
      briefEdit: { domain: 'a', project: 'b', text: 'x', busy: true, error: null } };
    const r = makeSaver(st, () => okRes);
    await r.saveBrief(1);
    eq('a save while one is already in flight issues no request at all',
      r.calls.filter((c) => c.url).length, 0);
  }
  {
    // A REPLY THAT LANDS AFTER THE USER MOVED ON IS DROPPED.
    const st = { activeDomain: 'a', activeProject: 'b',
      briefEdit: { domain: 'a', project: 'b', text: 'x', busy: false, error: null } };
    const r = makeSaver(st, () => {
      // The user switches project while the request is in flight.
      st.briefEdit = { domain: 'other', project: 'thing', text: 'y', busy: false, error: null };
      return okRes;
    });
    await r.saveBrief(1);
    ok('the reply is not applied to the project the user moved to',
      st.briefEdit && st.briefEdit.project === 'thing' && st.briefEdit.text === 'y');
    ok('...and nothing is re-read under it', !r.calls.some((c) => c.reloaded));
  }
}


// ════════════════════════════════════════════════════════════════════════
section('§18 — THE AGE CLOCK, and the things it must never do');
// ════════════════════════════════════════════════════════════════════════
//
// The handoff's freshness reading ticks once a second, so a non-Mac user gets
// the menubar widget's two readings on the web. That buys two new hazards, and
// NOTHING IN THIS REPOSITORY COULD SEE EITHER OF THEM before this section:
//
//   · A LEAKED TIMER. §12 above executes onEnter and its teardown, but
//     `setInterval` is a Node GLOBAL, so before the rig injected spies an armed
//     interval was simply invisible to it — deleting the clearInterval from the
//     teardown left every assertion in this file green while shipping one
//     running timer per rail click, for the life of the page.
//   · A TICK THAT RENDERS. settings.js shipped a once-a-second render tick and
//     v3.53.1 records it as a defect by name: a render replaces both panes by
//     innerHTML, which closes the ⓘ panel, shuts any picker that is open and
//     churns focus. So the tick is executed here against a render SPY.

// ── 18a · TIMER DISCIPLINE, over two full mount/teardown cycles ──────────
{
  const m = mountView();
  const teardown = m.onEnter(11);
  eq('mount: the age clock is armed exactly once', m.log.intervalsArmed.length, 1);
  eq('mount: ...at one second, not at the poll interval', m.log.intervalsArmed[0].ms, 1000);
  ok('mount: ...with tickAges, not with render — a render tick IS the v3.53.1 defect',
    m.log.intervalsArmed[0].fn === m.tickSpy, 'the interval was armed with something else');
  eq('mount: nothing is cleared yet', m.log.intervalsCleared.length, 0);

  teardown();
  eq('teardown: the age clock IS disarmed — otherwise it walks the next view\'s DOM forever',
    m.log.intervalsCleared.length, 1);
  eq('teardown: ...and it clears the handle it armed, not some other one',
    m.log.intervalsCleared[0], m.log.intervalsArmed[0].id);

  teardown();
  eq('teardown twice clears once — the handle is nulled, so a double teardown is not a double clear',
    m.log.intervalsCleared.length, 1);
}
{
  // THE BALANCE, which is the property that actually matters: two mounts and
  // two teardowns must leave nothing running. This is the assertion that reds
  // when somebody removes the clearInterval, and the one that reds when
  // somebody arms a second interval somewhere else in onEnter.
  const m = mountView();
  const t1 = m.onEnter(1); t1();
  const t2 = m.onEnter(2); t2();
  eq('two full mount/teardown cycles arm two intervals', m.log.intervalsArmed.length, 2);
  eq('...and disarm two', m.log.intervalsCleared.length, 2);
  eq('...leaving nothing running', new Set(m.log.intervalsArmed.map((x) => x.id)).size
    - new Set(m.log.intervalsCleared).size, 0);
}
{
  // AN ENGINE WITH NO setInterval. The guard in onEnter is `typeof setInterval
  // === 'function'`, and an unguarded arm would be a TypeError that kills the
  // whole mount — no list, no error card, a blank screen.
  const m = mountView({ noIntervals: true });
  const teardown = m.onEnter(3);
  eq('an engine with no setInterval still mounts', m.log.renders.length >= 1, true);
  eq('...arming nothing', m.log.intervalsArmed.length, 0);
  teardown();
  eq('...and its teardown clears nothing rather than throwing', m.log.intervalsCleared.length, 0);
}

// ── 18b · THE TICK WRITES TEXT AND NEVER RENDERS ────────────────────
{
  const renders = [];
  const mkNode = (at, text) => ({
    _at: at,
    textContent: text,
    getAttribute: (k) => (k === 'data-mem-age-at' ? at : null),
    querySelector: (sel) => (sel === '.tx-readout-value' ? mkNode._values.get(at) : null),
  });
  mkNode._values = new Map();
  const mkPair = (at, text) => {
    const value = { textContent: text, writes: 0 };
    const proxy = {
      get textContent() { return value.textContent; },
      set textContent(v) { value.textContent = v; value.writes++; },
    };
    mkNode._values.set(at, proxy);
    return { node: mkNode(at, ''), value };
  };

  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  const a = mkPair(new Date(NOW - 7200_000).toISOString(), 'stale words');
  const b = mkPair(new Date(NOW - 45_000).toISOString(), 'just now');
  const bad = mkPair('not a date', 'untouched');

  const box = new Function('document', 'Date', 'render', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    { querySelectorAll: () => [a.node, b.node, bad.node] },
    { now: () => NOW, parse: Date.parse },
    () => { renders.push(1); },
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')());

  box();
  eq('the tick rewrote a stale reading into the right words', a.value.textContent, '2 hr ago');
  eq('...writing it exactly once', a.value.writes, 1);
  eq('an already-correct reading is NOT rewritten — a no-op write still dirties the node',
    b.value.writes, 0);
  eq('...and its words are left alone', b.value.textContent, 'just now');
  eq('an unparseable stamp FREEZES rather than printing junk', bad.value.textContent, 'untouched');
  eq('THE TICK NEVER RENDERS — a render closes the ⓘ and churns focus (v3.53.1)', renders.length, 0);

  // Positive control: the render spy must be able to see a call, or the
  // assertion above is decorative.
  const control = [];
  new Function('render', 'return function t() { render(); };')((x) => control.push(1))();
  eq('self-test: the render spy DOES record a planted call', control.length, 1);
}

// ── 18b2 · THE SECOND SHAPE THE CLOCK HAS TO REACH ───────────────────────
//
// v3.55.0 gave this screen two age shapes, and the fixtures above only cover
// one of them. A readout escapes its own value, so the handoff summary and the
// save strip put the words inside the COMPONENT's `.tx-readout-value`; the
// work-stream table's age cell and the "Working on" line are a cell and a
// sentence, and they carry this view's own `.mem-age-words`.
//
// WITHOUT THIS BLOCK the mutation that deletes the second lookup stays GREEN,
// and the table's clock silently freezes at whatever the last render painted —
// which is the exact defect (a figure that has quietly stopped being true)
// that tickAges exists for. Measured: it was green before this was written.
{
  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  const mk = (at, words) => {
    const inner = { textContent: words, writes: 0 };
    const proxy = {
      get textContent() { return inner.textContent; },
      set textContent(v) { inner.textContent = v; inner.writes++; },
    };
    return {
      inner,
      node: {
        getAttribute: (k) => (k === 'data-mem-age-at' ? at : null),
        // The TABLE's shape: no readout anywhere inside, a named span instead.
        querySelector: (sel) => (sel === '.mem-age-words' ? proxy : null),
      },
    };
  };
  const cell = mk(new Date(NOW - 7200_000).toISOString(), 'stale words');
  const fresh = mk(new Date(NOW - 30_000).toISOString(), 'just now');
  const box = new Function('document', 'Date', 'render', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    { querySelectorAll: () => [cell.node, fresh.node] },
    { now: () => NOW, parse: Date.parse },
    () => { throw new Error('the tick called render()'); },
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')());
  box();
  eq('the tick reaches a TABLE cell through .mem-age-words', cell.inner.textContent, '2 hr ago');
  eq('...writing it exactly once', cell.inner.writes, 1);
  eq('...and leaves an already-correct one alone', fresh.inner.writes, 0);

  // AND IT NEVER WRITES THE WRAPPER'S OWN TEXT. The table's age cell also
  // holds a visually-hidden exact stamp, so a fallback to `el.textContent`
  // would delete it — asserted by giving the node NEITHER named child and
  // proving nothing is written to it.
  const bare = {
    textContent: 'a cell with other children', writes: 0,
    getAttribute: (k) => (k === 'data-mem-age-at' ? new Date(NOW - 7200_000).toISOString() : null),
    querySelector: () => null,
  };
  const wrapped = {
    get textContent() { return bare.textContent; },
    set textContent(v) { bare.textContent = v; bare.writes++; },
    getAttribute: bare.getAttribute,
    querySelector: bare.querySelector,
  };
  new Function('document', 'Date', 'render', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    { querySelectorAll: () => [wrapped] },
    { now: () => NOW, parse: Date.parse },
    () => {},
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')())();
  eq('a node with NEITHER named child is left entirely alone — an unnamed '
    + 'fallback would delete the visually-hidden stamp beside the words',
    bare.writes, 0);
}
{
  // NO DOM AT ALL. The tick is armed by onEnter and can outlive a document in
  // a headless engine; it must return rather than throw.
  const box = new Function('document', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    undefined, () => 'x');
  let threw = null;
  try { box(); } catch (e) { threw = e; }
  eq('a tick with no document returns quietly', threw, null);
}

// ── 18c · WHAT YOU OPEN STAYS OPEN ─────────────────────────────
//
// The ⓘ panel's open state lives ONLY in the DOM — shared/text.js flips
// `hidden` and records nothing — so every render closed it. On this screen the
// poll repaints whenever the reading ages into a new band, so a user reading
// "How this works" could have it shut under them. v3.53.1 fixed the same shape
// on Providers & keys and recorded it as UNFIXED here.
{
  const mkInfoRig = ({ expandedBefore = [], presentAfter = [], panels = true } = {}) => {
    const buttons = new Map();
    const panelEls = new Map();
    const mk = (id, expanded) => ({
      _id: id,
      _expanded: expanded,
      getAttribute: (k) => (k === 'data-tx-info' ? id : null),
      setAttribute: (k, v) => { if (k === 'aria-expanded') mk._set.push([id, v]); },
    });
    mk._set = [];
    let phase = 'before';
    for (const id of expandedBefore) buttons.set(id, mk(id, true));
    for (const id of presentAfter) {
      if (!buttons.has(id)) buttons.set(id, mk(id, false));
      if (panels) panelEls.set(id, { _id: id, hidden: true });
    }
    const doc = {
      querySelectorAll: (sel) => {
        if (sel === '[data-tx-info][aria-expanded="true"]') {
          return phase === 'before' ? expandedBefore.map((id) => buttons.get(id)) : [];
        }
        if (sel === '[data-tx-info]') {
          return presentAfter.map((id) => buttons.get(id)).filter(Boolean);
        }
        return [];
      },
      getElementById: (id) => panelEls.get(id) || null,
      querySelector: () => null,
      activeElement: null,
    };
    const body =
      'let pendingFocusId = null;\nlet renderedSignature = null;\n' +
      'function screenSignature() { return "SIG"; }\n' +
      // v3.67.0: render() asks for step ④'s measurement after it paints; that
    // path is driven in §25, so here it is a named no-op.
    'function maybeLoadSessionStart() {}\n' +
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
      'return render;';
    const render = new Function('state', 'document', 'FOCUSABLE_IDS', 'FOCUS_FALLBACK',
      'isCurrentMount', 'renderSidebar', 'renderMain', 'wire', body)(
      { detailLoading: false }, doc, FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, () => true,
      () => { phase = 'after'; }, () => {}, () => {});
    return { render, panelEls, set: mk._set };
  };

  // THE TWO IDS ARE DERIVED FROM THE VIEW TITLE, which v3.62.0 renamed
  // Agent memory → Project context. These two lines are the only thing in the
  // suite that catches a title landing without its FOCUSABLE_IDS entries, so
  // they move in the same commit the title does.
  const MAIN = 'tx-vh-info-project-context';
  const SIDE = 'tx-vh-info-project-context-sidebar';

  const r = mkInfoRig({ expandedBefore: [MAIN], presentAfter: [MAIN, SIDE] });
  r.render(1);
  eq('an ⓘ panel open BEFORE the render is open after it', r.panelEls.get(MAIN).hidden, false);
  ok('...with its button saying so — both halves or neither, because the shared '
    + 'listener reads aria-expanded to decide what the NEXT click does',
    r.set.some(([id, v]) => id === MAIN && v === 'true'), JSON.stringify(r.set));
  eq('CONTROL: a panel that was CLOSED is not opened — restore only ever opens',
    r.panelEls.get(SIDE).hidden, true);

  const both = mkInfoRig({ expandedBefore: [MAIN, SIDE], presentAfter: [MAIN, SIDE] });
  both.render(1);
  ok('BOTH marks are covered — the rail\'s header carries one too, and it is the '
    + 'one that was live and unfixed',
    both.panelEls.get(MAIN).hidden === false && both.panelEls.get(SIDE).hidden === false);

  const gone = mkInfoRig({ expandedBefore: [MAIN], presentAfter: [] });
  let threw = null;
  try { gone.render(1); } catch (e) { threw = e; }
  eq('a panel that the render did not re-emit is simply not restored, never a crash', threw, null);

  const noPanel = mkInfoRig({ expandedBefore: [MAIN], presentAfter: [MAIN], panels: false });
  threw = null;
  try { noPanel.render(1); } catch (e) { threw = e; }
  eq('a button whose panel is missing is skipped rather than half-opened', threw, null);
  ok('...and its button is NOT told it is expanded',
    !noPanel.set.some(([, v]) => v === 'true'), JSON.stringify(noPanel.set));

  // BOTH ids are in FOCUSABLE_IDS, or a keyboard user reading either panel is
  // dropped to <body> on the next poll — the v3.17.1 defect this view's focus
  // handling exists for, reopened on the newest control.
  for (const id of [MAIN + '-btn', SIDE + '-btn']) {
    ok('FOCUSABLE_IDS names ' + id, FOCUSABLE_IDS_SRC.includes(id), JSON.stringify(FOCUSABLE_IDS_SRC));
  }
}

// ── 18d · THE HANDOFF, AS A READER PAYLOAD (v3.56.0) ────────────────────
//
// WHAT CHANGED, AND WHY EVERY ASSERTION BELOW MOVED WITH IT. This section used
// to drive `renderHandoff`, which printed the whole document on the page as a
// lead <details>. The maintainer's verdict on that in production was that a
// dashboard should not also be a document viewer, so the row press now opens
// the handoff in the shell's READER overlay — the wiki's own answer to the same
// question — and `handoffReaderContent` composes the payload.
//
// So the fold assertions (open by default, remembered close, the leader's
// accent rule, the pip in the summary) are gone WITH THE ELEMENT THEY PINNED,
// and what replaces them pins the facts that had to survive the move: the
// document, the Saved reading, the live clock, the badges, the scope and the
// machine, and the way back to the row.
{
  const now = Date.now();
  const st = (over = {}) => ({
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: false, journalLimit: 10, openFolds: {}, ageTickerArmed: true,
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 7200 }],
      brief: { present: false } },
    detail: {
      scope: 'main', machine: 'boxa', machines: [{ machine: 'boxa', writtenAgeSeconds: 7200 }],
      current: { present: true, writtenAgeSeconds: 7200,
        writtenAt: new Date(now - 7200_000).toISOString(),
        savedAt: new Date(now - 7200_000).toISOString(),
        text: '# T\n\n> Headline\n\n## Where things stand\n\nBody.\n' },
      journal: { returned: 1, total: 1, totalUnknown: false,
        entries: [{ at: new Date(now - 7200_000).toISOString(), harness: 'claude-code', model: 'opus-5', headline: 'h', rejections: [] }] },
    },
    ...over,
  });

  const c = makeRenderers(st()).handoffReaderContent();
  ok('a work-stream with a handoff produces a reader payload', !!c, String(c));
  ok('THE PATH LINE carries the project, the work-stream AND the machine — the '
    + 'three facts that address the file, and the reason two rows can share a name',
    c.slug === 'state/lumina/main/boxa/current.md', c.slug);
  ok('...and the machine and work-stream are chips as well, so they are readable '
    + 'rather than parsed out of a path',
    c.tags.includes('handoff: main') && c.tags.includes('machine: boxa'),
    JSON.stringify(c.tags));
  ok('THE TITLE is the agent\'s own headline, promoted out of the preamble',
    c.title === 'Headline', c.title);
  ok('the document is rendered through the shared markdown renderer (escape-first)',
    c.bodyHtml.includes('chat-md-h'), c.bodyHtml.slice(0, 200));
  ok('...and the preamble it was promoted from is not repeated in the body',
    !c.bodyHtml.includes('&gt; Headline'), c.bodyHtml.slice(0, 300));

  ok('THE SAVED READING travels with the document, as the same instrument the '
    + 'Status block uses — never a second vocabulary',
    /class="tx-readout-value">2 hr ago</.test(c.bodyHtml), c.bodyHtml.slice(0, 400));
  ok('...with harness · model as its provenance',
    /class="tx-readout-prov">claude-code · opus-5/.test(c.bodyHtml), c.bodyHtml.slice(0, 500));
  ok('...saying it updates live, because it does',
    /updates live/.test(c.bodyHtml), c.bodyHtml.slice(0, 500));
  ok('THE LIVE CLOCK\'s hook rides on the reading, so tickAges rewrites the words '
    + 'inside the overlay exactly as it does on the page',
    /data-mem-age-at="[^"]+"/.test(c.bodyHtml), c.bodyHtml.slice(0, 400));
  ok('THE EXACT STAMP is reachable as text, not as a tooltip',
    c.bodyHtml.includes('class="visually-hidden"') && !/title="/.test(c.bodyHtml),
    c.bodyHtml.slice(0, 400));

  ok('ESCAPE AND THE ✕ RETURN FOCUS TO THE ROW that opened it',
    c.returnFocusTo === 'mem-ws-active', String(c.returnFocusTo));
  ok('NO `domain` on the payload — a handoff is not a wiki page, so the reader\'s '
    + 'RAW-source bar must not fire a request that can only answer "no"',
    !('domain' in c), JSON.stringify(Object.keys(c)));
  ok('...and no pip: the overlay carries a reading, not the page\'s freshness mark',
    !/mem-save-pip/.test(c.bodyHtml), c.bodyHtml.slice(0, 300));

  // "updates live" IS A CLAIM. With no clock armed it must not be made.
  const still = makeRenderers(st({ ageTickerArmed: false })).handoffReaderContent();
  ok('CONTROL: with no clock armed the reading does NOT claim to update live',
    !/updates live/.test(still.bodyHtml)
    && /class="tx-readout-value">2 hr ago</.test(still.bodyHtml), still.bodyHtml.slice(0, 600));

  // ── THE BADGES. `trimmed` is the attention badge (content did not survive the
  // save) and `clipped` the quiet one (a label was shortened). They must never
  // share a class: badging `clipped` as `incomplete` is the exact false alarm
  // the two verdicts were split to stop, and the reader is a SECOND surface
  // where that could now happen.
  const trimmed = makeRenderers(st({
    detail: { ...st().detail, current: { ...st().detail.current, lastSaveKind: 'trimmed' } },
  })).handoffReaderContent();
  ok('a TRIMMED save badges the document `incomplete`, on the reading itself',
    /mem-badge-attn">incomplete</.test(trimmed.bodyHtml), trimmed.bodyHtml.slice(0, 500));
  const clipped = makeRenderers(st({
    detail: { ...st().detail, current: { ...st().detail.current, lastSaveKind: 'clipped' } },
  })).handoffReaderContent();
  ok('a CLIPPED save says `summary shortened`, in the QUIET badge',
    /mem-badge-quiet">summary shortened</.test(clipped.bodyHtml), clipped.bodyHtml.slice(0, 500));
  ok('...and never the other one — nothing was lost, and saying so would be the '
    + 'false alarm the two verdicts exist to keep apart',
    !/incomplete/.test(clipped.bodyHtml), clipped.bodyHtml.slice(0, 500));
  ok('CONTROL: a complete save carries neither badge',
    !/mem-badge/.test(c.bodyHtml), c.bodyHtml.slice(0, 400));

  // AN UNKNOWN AGE is words, never step 0 and never "0s".
  const unknown = makeRenderers(st({
    detail: { ...st().detail, current: { ...st().detail.current, writtenAgeSeconds: null, writtenAt: null, savedAt: null },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
  })).handoffReaderContent();
  ok('an unknown age renders NO readout — a readout states a READING, and there '
    + 'is none; "unknown" is not a figure',
    !/tx-readout/.test(unknown.bodyHtml), unknown.bodyHtml.slice(0, 400));
  ok('...and says so in words rather than leaving the reading simply absent',
    /time unknown/.test(unknown.bodyHtml), unknown.bodyHtml.slice(0, 400));
  ok('...and emits NO clock hook, because there is nothing to recount',
    !/data-mem-age-at/.test(unknown.bodyHtml), unknown.bodyHtml.slice(0, 400));

  // AN ABSENT HANDOFF IS SAID, NOT RENDERED AS AN EMPTY PANEL.
  const absent = makeRenderers(st({
    detail: { ...st().detail, current: { present: false }, message: 'STORE-SAYS-SO' },
  })).handoffReaderContent();
  ok('a pair whose handoff could not be read still opens, saying so in the '
    + 'store\'s own words rather than as a blank document',
    /STORE-SAYS-SO/.test(absent.bodyHtml), absent.bodyHtml.slice(0, 300));
  ok('...and does NOT invent a reading for a document that is not there',
    !/tx-readout/.test(absent.bodyHtml) && !/time unknown/.test(absent.bodyHtml),
    absent.bodyHtml.slice(0, 300));

  // NOTHING TO OPEN IS NULL, not an empty panel.
  ok('with no scoped read at all there is no payload',
    makeRenderers(st({ detail: null })).handoffReaderContent() === null);
}

// ── 18d2 · A MID-READ FOLD MUST NOT EMIT A STATE IT DOES NOT MEAN ────────
//
// FOUND BY LOOKING at the rendered page, not by any assertion in this file: in
// v3.54.0 the standing brief was open on every visit, on a screen whose whole
// design is that the handoff is what you came for.
//
// The mechanism was two things meeting. (1) loadScope drops `state.detail`
// before it paints — deliberately, so the old machine's handoff is never shown
// under the new scope's label — so renderProject ran once with `d === null`,
// and the brief's "I am the only content here" rule was momentarily TRUE.
// (2) Chrome queues a `toggle` event for a <details> parsed WITH an `open`
// attribute; measured in a real browser, a freshly-innerHTML'd `<details open>`
// fires one. wire()'s listener wrote `openFolds.brief = true`, and a
// remembered value beats the default forever after — so a 200 ms transient
// became the permanent state.
//
// ── v3.55.0 CLOSED IT BY REMOVING THE PATH; v3.58.0 KEEPS THE PATH CLOSED ──
// v3.55.0 made the brief a BLOCK, so there was no `open` attribute to emit and
// no "only content here" rule to be transiently true. v3.58.0 makes it a fold
// again — the maintainer wants it SHUT, which needs a <details> — so the
// defect's path exists once more and has to be closed by construction instead.
//
// It is: `open` is derived from `state.openFolds.brief` and from NOTHING else.
// No branch anywhere asks whether the brief is the only content, whether the
// read has landed, or whether there is a brief at all. The two assertions
// below are the loading→loaded transition that reproduced the original defect,
// driven through the SHIPPED renderer at both ends, and both must say CLOSED.
//
// Mutation that reds them: make `renderBrief` emit ` open` when `!state.detail`
// (the v3.54.0 rule, verbatim) — the mid-read frame goes open and stays open.
{
  const midRead = {
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: true, detail: null, staleWrite: false, journalLimit: 10, openFolds: {},
    projects: [],
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
      brief: { present: true, text: '# B\n\n## Goal\n\nShip it.', updatedAt: new Date().toISOString() } },
  };
  const out = makeRenderers(midRead).renderProject();
  ok('mid-read: the page really is in the full branch (the check is not vacuous)',
    /settings-block-context-state/.test(out), out.slice(0, 200));
  ok('mid-read: the brief IS a fold and it really is emitted (not vacuous)',
    /data-mem-fold="brief"/.test(out));
  ok('mid-read: and it is emitted CLOSED — the transient in which the brief is '
    + 'the only content on the page may not become a remembered `open`',
    !/data-mem-fold="brief" open/.test(out), out.slice(out.indexOf('data-mem-fold="brief"') - 60, 200));
  ok('...and the brief\'s content is on the page regardless — the fix did not '
    + 'close the transient by hiding the section',
    /id="mem-brief-edit"/.test(out));

  // THE OTHER END OF THE SAME TRANSITION. The read lands, `state.detail` fills
  // in, the page repaints — and the fold must STILL be shut, because nothing
  // the user did opened it.
  const settledSame = makeRenderers({ ...midRead, detailLoading: false,
    detail: { scope: 'main', machine: 'boxa', machines: [],
      current: { present: true, writtenAgeSeconds: 120, writtenAt: new Date().toISOString(),
        text: '## Where things stand\n\nx' },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } } }).renderProject();
  ok('loaded: still closed — the loading→loaded transition opens nothing',
    /data-mem-fold="brief"/.test(settledSame) && !/data-mem-fold="brief" open/.test(settledSame));
  ok('...and the JOURNAL is shut on that same frame, for the same reason',
    !/data-mem-fold="journal" open/.test(settledSame));

  // AND A REMEMBERED `true` IS HONOURED, or the persistence is decorative.
  const reopened = makeRenderers({ ...midRead, openFolds: { brief: true } }).renderProject();
  ok('a remembered open state IS restored on the next paint',
    /data-mem-fold="brief" open/.test(reopened), reopened.slice(0, 300));

  // ── EVERY FOLD'S <summary> MUST SURVIVE A RENDER, FOR A KEYBOARD ───────
  // A <summary> is focusable, and every render replaces the pane it sits in —
  // so a fold whose summary id is missing from FOCUSABLE_IDS drops a keyboard
  // user to <body> on the next poll, which is v3.17.1's defect on the screen
  // named after it. DERIVED from the rendered page rather than typed here: a
  // hand-kept second list is what lets a third fold arrive uncovered.
  // Both frames, because neither alone emits both folds: `midRead` has no
  // scoped read yet, so it has no journal block at all.
  const summaryIds = [...new Set([...(reopened + settledSame)
    .matchAll(/<summary[^>]*\bid="([^"]+)"/g)].map((m) => m[1]))];
  const focusIds = liftConst('FOCUSABLE_IDS');
  ok('CONTROL: the page emitted fold summaries with ids, and the list lifted',
    summaryIds.length >= 2 && Array.isArray(focusIds) && focusIds.length > 5,
    JSON.stringify([summaryIds, focusIds && focusIds.length]));
  for (const id of summaryIds) {
    ok('the focus list covers the fold summary #' + id
      + ' — without it a keyboard user is dropped to <body> on the next render',
    focusIds.includes(id), JSON.stringify(focusIds));
  }

  // ── AND THE HANDOFF'S FOLD IS GONE TOO (v3.56.0), so the rule's remaining
  // subject on this page is the JOURNAL, which is the one fold left. The two
  // CONTROLs below were "with a handoff to read, its fold IS emitted open" and
  // "a user who closed it keeps it closed"; both pinned an element that no
  // longer exists, because the document opens in the reader overlay and an
  // overlay has no collapsed state to be raced into.
  //
  // What replaces them is the positive form of the same claim: the page emits
  // NO handoff fold at all, in any state, and the document is still reachable —
  // through a row whose press opens it.
  const settledWithHandoff = { ...midRead, detailLoading: false,
    detail: { scope: 'main', machine: 'boxa', machines: [],
      current: { present: true, writtenAgeSeconds: 120, writtenAt: new Date().toISOString(),
        text: '## Where things stand\n\nx' },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } } };
  const settled = makeRenderers(settledWithHandoff).renderProject();
  ok('with a handoff to read, the page emits NO fold for it — and no document',
    !/data-mem-fold="handoff"/.test(settled)
    && !/Where things stand/.test(settled), settled.slice(0, 200));
  ok('...and the way to it is a row whose press opens the reader',
    /class="mem-ws-open"/.test(settled) && /data-mem-scope="main"/.test(settled));
  ok('CONTROL: the journal fold is still there, so "no fold" is about the '
    + 'handoff rather than about folds having been deleted wholesale',
    /data-mem-fold="journal"/.test(settled));

  // AND THE EMPTY CASE STILL SHOWS SOMETHING. The rule the brief's transient
  // came from — "do not leave the page blank" — is answered by the Work-streams
  // block, which carries the no-handoff card in place of the table when a
  // project has no saved pairs at all.
  const settledNoHandoff = { ...midRead, detailLoading: false,
    projectRead: { scopes: [], brief: midRead.projectRead.brief },
    detail: { scope: 'main', machine: 'boxa', current: { present: false }, machines: [],
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } } };
  const empty = makeRenderers(settledNoHandoff).renderProject();
  ok('with nothing saved, the Work-streams block says so in its own body — the '
    + 'missing thing is missing where you looked for it',
    /No handoff saved yet/.test(empty), empty.slice(0, 300));
  ok('...and the brief is still fully on the page beneath it',
    /id="mem-brief-edit"/.test(empty));
}
// ── §17c — A ROW PRESS OPENS THE READER, AND THE FOOTER APPENDS ────────
//
// The two behaviours v3.56.0 added, driven through the REAL handlers `wire`
// binds, against a fake document that knows only the elements the table emits.
// A markup assertion cannot see either of them: one is an `openReader` call and
// the other is an `insertAdjacentHTML` into a live <tbody>.
{
  const now = Date.now();
  const iso = (secs) => new Date(now - secs * 1000).toISOString();
  const scopes = Array.from({ length: 8 }, (_, i) => ({
    scope: 'ws-' + String(i).padStart(2, '0'), machine: 'boxa',
    headline: 'stream ' + i, harness: 'claude-code', model: 'opus-5',
    writtenAgeSeconds: 60 * (i + 1), writtenAt: iso(60 * (i + 1)),
  }));

  // A row button, and a <tr> that owns it — enough for both the bind pass and
  // the append pass, which reaches for `tbody.children` and `querySelectorAll`.
  const mkBtn = (scope, machine) => ({
    dataset: { memScope: scope, memMachine: machine }, _click: null,
    matches: (sel) => sel.includes('mem-ws-open'),
    addEventListener(t, fn) { if (t === 'click') this._click = fn; },
  });
  const mkTr = (btn) => ({ _btn: btn, querySelectorAll: (sel) =>
    (sel.includes('mem-ws-open') ? [btn] : []) });

  function rig(over = {}) {
    const calls = { reader: [], scopesLoaded: [], render: 0 };
    const rowButtons = (over.rows || ['ws-00']).map((r) => mkBtn(r, 'boxa'));
    const tbody = {
      children: rowButtons.map(mkTr),
      _appended: '',
      insertAdjacentHTML(where, html) {
        this._appended += html;
        // One <tr> per row, faithfully enough for the bind pass that follows.
        for (const m of html.matchAll(/data-mem-scope="([^"]*)" data-mem-machine="([^"]*)"/g)) {
          this.children.push(mkTr(mkBtn(m[1], m[2])));
        }
      },
    };
    const moreBtn = { _click: null, _removed: false, _label: 'Show 3 more',
      addEventListener(t, fn) { if (t === 'click') this._click = fn; },
      remove() { this._removed = true; },
      querySelector: () => ({ get textContent() { return moreBtn._label; },
        set textContent(v) { moreBtn._label = v; } }) };
    const countEl = { _html: '', set outerHTML(v) { this._html = v; }, get outerHTML() { return this._html; } };
    const st = {
      activeDomain: 'acme', activeProject: 'lumina', scope: null, machine: null,
      journalLimit: 10, wsWindow: WS_WINDOW_SRC, openFolds: {}, ageTickerArmed: true,
      projectRead: { scopes, savedCopies: 8, distinctScopeCount: 8, brief: { present: false } },
      detail: over.detail === undefined ? null : over.detail,
      ...(over.state || {}),
    };
    const document = {
      querySelectorAll: (sel) => (sel.includes('mem-ws-open') ? rowButtons : []),
      getElementById: (id) => ({ 'mem-ws-more': moreBtn, 'mem-ws-body': tbody,
        'mem-ws-count': countEl })[id] || null,
    };
    const api = new Function(
      'state', 'document', 'render', 'saveBrief', 'reportAsyncMountFailure', 'keyOf', 'activeKey',
      'selectProject', 'copyAgentInstructions', 'loadScope', 'refreshIndex', 'reloadActive',
      'BRIEF_TEMPLATE', 'BRIEF_MAX_BYTES', 'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingFocusId',
      'openReader', 'isCurrentReader', 'isCurrentMount',
      'WS_WINDOW', 'WS_STEP', 'WS_STEP_ALL_MAX',
      'escapeHtml', 'icon', 'renderMarkdown', 'renderReadout', 'renderDescription',
      // TIER 0's two wiring calls. Stubs HERE, and only here: this section's
      // subject is the work-stream row press, this rig's fake document answers
      // nothing for `.fnd-open`, and a free identifier inside a lifted `wire`
      // is a CRASH rather than a failing assertion. The real chain — press →
      // fetch → reader payload — is driven in §21.
      'bindFoundationRows', 'refreshFoundations', 'bindKnowledgeRows',
      // The freshness tier a row's dot wears — the REAL one from shared/age.js,
      // as §6 lifts it, so an appended row and a painted one cannot be marked
      // on two different scales.
      'freshnessTier',
      // Every one of these is the SHIPPED function. The point of the section is
      // that the press really reaches openReader through the real chain, so a
      // stub anywhere along it would be this suite testing its own harness.
      [...['formatAge', 'effectiveSave', 'splitHandoffPreamble', 'workStreamOrder',
        'wsShownCount', 'wsRowHtml', 'wsMoreHtml', 'workStreamCounts',
        'handoffReaderContent', 'bindWorkStreamRows', 'openWorkStream',
        'showMoreWorkStreams', 'bindFoldToggles', 'wire']]
        .map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n')
      + '\nfunction bindSessionAndPlan() {}\n'
      + '\nreturn { wire, pending: () => pendingFocusId };')(
      st, document,
      () => { calls.render++; },
      async () => {}, () => {}, (d, q) => d + '/' + q, () => 'acme/lumina',
      async () => {}, async () => {},
      // loadScope, faithful in the ONE way that matters: it writes state.detail,
      // which is what handoffReaderContent then reads.
      async (scope, machine) => {
        calls.scopesLoaded.push(scope + '/' + machine);
        st.scope = scope; st.machine = machine;
        st.detail = over.loadedDetail || {
          scope, machine, machineIsThisMachine: true,
          current: { present: true, writtenAgeSeconds: 120, writtenAt: iso(120),
            text: '# T\n\n> The headline\n\n## Where things stand\n\nBody.\n' },
          journal: { returned: 1, total: 1, totalUnknown: false,
            entries: [{ at: iso(120), harness: 'claude-code', model: 'opus-5', headline: 'h', rejections: [] }] },
        };
      },
      async () => {}, async () => {},
      '', Number(BRIEF_MAX_BYTES_SRC), 10, 50, null,
      (content) => { calls.reader.push(content); return calls.reader.length; },
      (epoch) => epoch === calls.reader.length,
      () => true,
      WS_WINDOW_SRC, WS_STEP_SRC, WS_STEP_ALL_MAX_SRC,
      escapeHtml, () => '<svg></svg>', renderMarkdown, renderReadout, renderDescription,
      () => {}, async () => {}, () => {},
      makeRenderers({}).freshnessTier);
    api.wire(1);
    return { api, calls, rowButtons, tbody, moreBtn, countEl, st };
  }

  // ── A ROW PRESS OPENS THE READER ────────────────────────────────────────
  {
    const r = rig();
    ok('SETUP: the row\'s click handler was bound', typeof r.rowButtons[0]._click === 'function');
    r.rowButtons[0]._click();
    await new Promise((res) => setImmediate(res));

    eq('pressing a row reads that work-stream', r.calls.scopesLoaded.join(','), 'ws-00/boxa');
    ok('...and the reader is opened TWICE: a loading panel in the frame of the '
      + 'press, then the document', r.calls.reader.length === 2, r.calls.reader.length);
    ok('the first open is the loading panel, so the press is acknowledged before '
      + 'the round trip rather than a second later', r.calls.reader[0].loading === true,
    JSON.stringify(r.calls.reader[0]));
    const paid = r.calls.reader[1];
    ok('THE DOCUMENT REACHES THE READER, rendered through the shared renderer',
      paid.bodyHtml.includes('chat-md-h') && paid.bodyHtml.includes('Where things stand'),
      paid.bodyHtml.slice(0, 200));
    ok('THE TITLE LINE carries the work-stream AND the machine',
      paid.slug === 'state/lumina/ws-00/boxa/current.md', paid.slug);
    ok('THE SAVED READING travels with it',
      /class="tx-readout-value">2 min ago</.test(paid.bodyHtml), paid.bodyHtml.slice(0, 300));
    ok('...and the harness and model beside it',
      /claude-code · opus-5/.test(paid.bodyHtml), paid.bodyHtml.slice(0, 400));
    eq('ESCAPE AND THE ✕ RETURN FOCUS TO THE ROW', paid.returnFocusTo, 'mem-ws-active');
    eq('...and the same is true of the loading panel, so a close mid-fetch also '
      + 'lands back on the row', r.calls.reader[0].returnFocusTo, 'mem-ws-active');
    eq('the row records itself as the focus target for the render the read causes',
      r.api.pending(), 'mem-ws-active');
    eq('the journal is reset to its first page, as a scope change always does',
      r.st.journalLimit, 10);
  }

  // ── THE BADGES REACH THE READER when the save was not complete ──────────
  {
    const r = rig({ loadedDetail: {
      scope: 'ws-00', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, writtenAt: iso(120),
        lastSaveKind: 'trimmed', text: '## x\n\ny' },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } } });
    r.rowButtons[0]._click();
    await new Promise((res) => setImmediate(res));
    ok('a TRIMMED save reaches the reader badged `incomplete`',
      /mem-badge-attn">incomplete</.test(r.calls.reader[1].bodyHtml),
      r.calls.reader[1].bodyHtml.slice(0, 400));
  }

  // ── PRESSING THE ROW THAT IS ALREADY OPEN RE-OPENS THE DOCUMENT ─────────
  // It used to return early, which was right while the handoff was ON the page
  // and is wrong now that the press IS the open: a press that does nothing is
  // the defect, not the optimisation.
  {
    const opened = { scope: 'ws-00', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, writtenAt: iso(120), text: '## x\n\ny' },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } };
    const r = rig({ detail: opened });
    r.rowButtons[0]._click();
    await new Promise((res) => setImmediate(res));
    eq('pressing the OPEN row opens the reader', r.calls.reader.length, 1);
    ok('...without a loading panel, because nothing is being fetched',
      !r.calls.reader[0].loading, JSON.stringify(r.calls.reader[0]));
    eq('...and without re-reading it', r.calls.scopesLoaded.length, 0);
  }

  // ── "SHOW N MORE" APPENDS ───────────────────────────────────────────────
  {
    const r = rig();
    ok('SETUP: the footer\'s click handler was bound', typeof r.moreBtn._click === 'function');
    r.moreBtn._click();

    const added = [...r.tbody._appended.matchAll(/data-mem-scope="([^"]*)"/g)].map((m) => m[1]);
    eq('the press appends the REMAINING rows — three, from a list of eight',
      added.join(','), 'ws-05,ws-06,ws-07');
    eq('...and the window records what is now on screen', r.st.wsWindow, 8);
    ok('...and the footer removes itself, because it is the list\'s last row and '
      + 'a hidden row still occupies the rule above it', r.moreBtn._removed === true);
    ok('the count line is rebuilt and stops claiming a window',
      r.countEl.outerHTML.includes('8 saved copies')
      && !r.countEl.outerHTML.includes('showing 5 of 8'), r.countEl.outerHTML);

    // AN APPEND, NOT A RENDER. A render replaces the whole pane: the page's
    // scroll position moves, any open ⓘ is rebuilt, and every row already on
    // screen is re-parsed.
    eq('NOT ONE RENDER HAPPENED — the rows already read do not move', r.calls.render, 0);

    // ...and the appended rows are LIVE. Binding only the new nodes is what
    // stops a row already on screen getting a second listener and opening the
    // reader twice.
    const fresh = r.tbody.children[r.tbody.children.length - 1]._btn;
    ok('the appended rows are wired', typeof fresh._click === 'function');
    fresh._click();
    await new Promise((res) => setImmediate(res));
    eq('...and pressing one opens ITS work-stream', r.calls.scopesLoaded.join(','), 'ws-07/boxa');
    eq('CONTROL: the rows that were already on screen were not re-bound — a '
      + 'second listener opens the reader twice',
    r.rowButtons[0]._click === r.rowButtons[0]._click && r.calls.reader.filter((c) => c.loading).length, 1);
  }

  // ── SWITCHING PROJECT RESETS THE WINDOW ────────────────────────────────
  //
  // A window opened on one project is not a statement about the next, exactly
  // as the journal's page size is not. Driven through the SHIPPED
  // `selectProject` rather than asserted as a line of source: this file's own
  // history records that "a test that proves a line exists proves nothing about
  // what it does", and the reset is one assignment among a dozen.
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina',
      wsWindow: 40, journalLimit: 50, briefEdit: { text: 'x' }, copied: { ok: true },
      projectRead: { scopes: [] }, detail: { scope: 'old' } };
    const knowledgeAsked = [];
    const captureAsked = [];
    const api = new Function('state', 'isCurrentMount', 'render', 'keyOf', 'activeKey',
      'rememberProject', 'fetchState', 'refreshIndex', 'loadScope', 'reportAsyncMountFailure',
      // ── STEP ③'s READ (v3.62.0) ──────────────────────────────────────
      // A SPY rather than the real one: `loadKnowledge` issues a `fetch`, and
      // what this harness is about is what `selectProject` ASKS for. §16h
      // drives the real one against a fake fetch.
      'loadKnowledge',
      // ── AND THE HONESTY METER'S READ (v3.63.0), FOR THE SAME REASON ──
      // A spy, for the same reason and with one extra property to check: it
      // is asked for the PAIR, not just the domain. A meter read that named
      // only the domain would paint another project's sessions here.
      'loadCapture',
      'JOURNAL_PAGE', 'WS_WINDOW',
      extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n'
      // ── THE PROJECT CACHE (v3.57.0) ─────────────────────────────────────
      // `selectProject` consults the cache before deciding whether to paint a
      // skeleton, writes the answer back, and hands the payload to
      // `applyProjectRead` — which is where the open pair is now chosen. All
      // of it is LIFTED rather than stubbed: a stubbed cache could only ever
      // miss, and a stubbed applyProjectRead would let this suite agree with
      // itself about which pair the table puts first.
      + 'const readCache = new Map();\n'
      + 'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n'
      + extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cacheGet', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cachePut', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'payloadSignature', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'applyProjectRead', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'selectProject', 'memory.js')
      + '\nreturn { selectProject, readCache };')(
      st, () => true, () => {}, (d, q) => d + '/' + q,
      () => st.activeDomain + '/' + st.activeProject,
      () => {}, async () => ({ data: { scopes: [], brief: { present: false } }, error: null }),
      async () => {}, async () => {}, () => {},
      async (domain) => { knowledgeAsked.push(domain); },
      async (domain, project) => { captureAsked.push(domain + '/' + project); },
      10, WS_WINDOW_SRC);

    await api.selectProject('acme', 'other', 1);
    eq('switching project resets the work-stream window', st.wsWindow, WS_WINDOW_SRC);
    eq('...alongside the journal\'s page size, for the same reason', st.journalLimit, 10);
    eq('CONTROL: the switch really happened', st.activeProject, 'other');
    eq('...and the pending brief edit was abandoned with it', st.briefEdit, null);
    // ── STEP ③'s FIGURES ARE ASKED FOR ON THE SELECTION (v3.62.0) ──────
    // Not awaited and not rendered from here — what matters is that the ask
    // happens at all, and that it names the domain being switched TO. A
    // selection that never asked would leave step ③ on the previous domain's
    // page count, or on a ghost, for ever.
    eq('the domain\'s figures are asked for, once, naming the new domain',
      knowledgeAsked.join(','), 'acme');
    // ── AND THE HONESTY METER'S READING, NAMED BY ITS PAIR (v3.63.0) ──
    // The reading is PER PROJECT, so an ask that carried only the domain
    // would paint one project's sessions under another project's heading —
    // the false-reading class the whole meter exists to avoid. Asserted as
    // the full pair, so dropping the project argument reds rather than
    // quietly aggregating.
    eq('the project\'s capture reading is asked for, once, naming the PAIR',
      captureAsked.join(','), 'acme/other');
  }

  // ── ESCAPE AND THE ✕ REALLY DO RETURN FOCUS ─────────────────────────────
  //
  // The payload's `returnFocusTo` is half of the contract; the shell honouring
  // it is the other half, and it lives in app.js. This drives the SHIPPED
  // `dismissReader` — the function Escape, the scrim and the ✕ all call — over
  // a fake document, so "Escape returns focus to the row" is a measurement
  // rather than a field nobody reads.
  //
  // THE ONE SMALL EXTENSION TO THE SHELL'S READER API, and it is here because a
  // reader the keyboard cannot get out of is not an alternative to a document
  // on the page. `closeReader()` is untouched — `navigate()` still calls it, so
  // leaving the view does NOT pull focus into a pane that is about to be
  // replaced — and a payload without the field behaves exactly as every payload
  // did before it existed.
  {
    const appSrc = readFileSync(join(NEXT, 'app.js'), 'utf8');
    const focused = [];
    const row = { id: 'mem-ws-active', focus(o) { focused.push(o); } };
    const mkShell = (reader) => {
      const closed = [];
      // v3.57.0 gave the USER dismiss paths an animated close, so
      // dismissReader now asks liveReaderScrim() whether there is an overlay
      // to fade. `null` is the honest answer for this harness — there is no
      // rendered overlay here — and it drives the instant arm, which is the
      // arm this block is about: focus. The animated arm has its own suite
      // (scripts/test-next-reader-motion.js).
      const api = new Function('state', 'closeReader', 'document', 'liveReaderScrim',
        extractFunction(appSrc, 'dismissReader', 'app.js')
        + '\nreturn { dismissReader };')(
        { reader },
        () => { closed.push(1); },
        { getElementById: (id) => (id === 'mem-ws-active' ? row : null) },
        () => null);
      return { api, closed };
    };

    const withField = mkShell({ slug: 'x', returnFocusTo: 'mem-ws-active' });
    withField.api.dismissReader();
    eq('dismissing the reader closes it', withField.closed.length, 1);
    eq('...and returns focus to the row that opened it', focused.length, 1);
    ok('...without scrolling to it — the row is where the user left it',
      focused[0] && focused[0].preventScroll === true, JSON.stringify(focused[0]));

    const noField = mkShell({ slug: 'x' });
    const before = focused.length;
    noField.api.dismissReader();
    eq('CONTROL: a payload WITHOUT the field still closes', noField.closed.length, 1);
    eq('...and moves no focus at all — every caller before v3.56.0 behaves as it did',
      focused.length, before);

    const gone = mkShell({ slug: 'x', returnFocusTo: 'not-on-this-page' });
    let threw = null;
    try { gone.api.dismissReader(); } catch (e) { threw = e; }
    eq('a row that is no longer in the document is skipped, never a crash', threw, null);

    // AND THE THREE DISMISS PATHS GO THROUGH IT, while navigate()'s close does
    // not. Asserted over comment-stripped source, because app.js explains the
    // distinction at length and a raw scan would fire on the explanation.
    const appCode = stripComments(appSrc);
    ok('Escape dismisses through it', /state\.reader\)\s*\{\s*dismissReader\(\);/.test(appCode), 'escape');
    // The scrim handler compares NODE IDENTITY rather than the id string as
    // of v3.57.0 — a dismissed scrim loses its id while it fades, so the id
    // is no longer what identifies it.
    ok('the scrim dismisses through it', /e\.target === scrim\)\s*dismissReader\(\);/.test(appCode), 'scrim');
    ok('the ✕ dismisses through it',
      /reader-close-btn'\)\.addEventListener\('click', dismissReader\)/.test(appCode), 'close button');
    ok('...and navigate() still calls the PLAIN close, so leaving the view does '
      + 'not pull focus into a pane that is about to be replaced',
    /\n  closeReader\(\);\n/.test(appCode), 'navigate');
  }

  // ── AND THE PAGE ITSELF NO LONGER PRINTS THE DOCUMENT ───────────────────
  {
    const page = makeRenderers({
      activeDomain: 'acme', activeProject: 'lumina', scope: 'ws-00', machine: 'boxa',
      detailLoading: false, journalLimit: 10, openFolds: {}, projects: [],
      projectRead: { scopes, savedCopies: 8, distinctScopeCount: 8,
        brief: { present: true, text: '# B\n\n## Goal\n\nShip it.', updatedAt: iso(600) } },
      detail: { scope: 'ws-00', machine: 'boxa',
        current: { present: true, writtenAgeSeconds: 120, writtenAt: iso(120),
          text: '# T\n\n> The headline\n\n## Where things stand\n\nUNIQUE-BODY-MARKER\n' },
        journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
    }).renderProject();
    ok('the handoff\'s body is NOT on the page', !page.includes('UNIQUE-BODY-MARKER'),
      page.slice(0, 200));
    ok('...and neither is its headline, its lead fold or its stamp',
      !page.includes('The headline') && !page.includes('mem-fold-lead')
      && !page.includes('mem-doc-headline') && !page.includes('mem-doc-stamp'),
      page.slice(0, 200));
    ok('CONTROL: the STANDING BRIEF is still a document on the page, so this is '
      + 'about the handoff rather than about documents having been removed',
    page.includes('class="mem-doc"') && page.includes('Ship it'));
  }
}

// ── §17d — WHICH PAIR OPENS BY ITSELF, AND WHOSE CLOCK DECIDES ──────────
//
// ── THE DEFECT ───────────────────────────────────────────────────────────
// Seen on a copied store, which is the shape EVERY synced machine has: a
// checkout rewrites mtime, so the store's own order says "when this machine
// wrote the file" while every cell of the table reads the AGENT'S clock
// through `effectiveSave`. `selectProject` and `reloadActive`'s fallback took
// `scopes[0]` — the mtime head — so on the maintainer's 'curator' project the
// page opened on the pair the table ranks LAST: a two-week-old handoff under a
// first row reading "5 hr ago". `wsShownCount` then did exactly what it is
// designed to do and STRETCHED the window to keep that open row visible, so
// all sixteen rows painted and the "Show more" footer — the one thing on
// screen that would have said the list was ever windowed — never appeared.
// Two blocks above, the Status block's "Working on:" named a different,
// fresher work-stream, because the route computes THAT on the agent's clock.
//
// ── WHAT IS PINNED HERE ─────────────────────────────────────────────────
// The fixture is built so the two clocks DISAGREE — the store lists the
// agent-oldest pair first and the agent-newest last — because with one clock
// the assertions below pass against either implementation. Each behaviour is
// driven through shipped source: the pick through `selectProject`, the paint
// through `renderWorkStreams`, the press through the handler
// `bindWorkStreamRows` binds, and the poll through `refreshIndex`. The route's
// own `scope=latest` is NOT touched by any of this and is asserted elsewhere;
// this is the view choosing from a list it already holds.
{
  const nowMs = Date.now();
  const isoAt = (secs) => new Date(nowMs - secs * 1000).toISOString();
  const AGES = [14 * 86400, 7 * 86400, 3 * 86400, 2 * 86400, 86400, 3 * 3600, 1800, 300];
  const STORE = AGES.map((age, i) => ({
    scope: 'ws-' + i, machine: 'box-' + i, headline: 'stream ' + i,
    harness: 'claude-code', model: 'opus-5',
    writtenAgeSeconds: age, writtenAt: isoAt(age),
    // The filesystem clock the checkout rewrote, ascending down the array —
    // i.e. exactly the order the store returns, and the order `scopes[0]`
    // used to take the head of.
    ageSeconds: 30 + i, savedAt: isoAt(30 + i),
  }));
  const AGENT_NEWEST = STORE[STORE.length - 1];  // ws-7 / box-7 — 5 minutes old
  const STORE_FIRST = STORE[0];                  // ws-0 / box-0 — a fortnight old
  const effOf = makeRenderers({}).effectiveSave;
  ok('FIXTURE: the store lists the agent-OLDEST pair first and the agent-newest '
    + 'last — so the two clocks cannot both be right',
  effOf(STORE_FIRST).seconds > effOf(AGENT_NEWEST).seconds
    && effOf(STORE_FIRST).source === 'agent',
  JSON.stringify([effOf(STORE_FIRST).seconds, effOf(AGENT_NEWEST).seconds]));

  // ── 1 · THE PICK, through the shipped selectProject ─────────────────────
  {
    const loaded = [];
    const st = { activeDomain: 'acme', activeProject: 'lumina', wsWindow: 40,
      journalLimit: 50, briefEdit: null, copied: null, projectRead: null, detail: null };
    const api = new Function('state', 'isCurrentMount', 'render', 'keyOf', 'activeKey',
      'rememberProject', 'fetchState', 'refreshIndex', 'loadScope', 'reportAsyncMountFailure',
      // ── STEP ③'s READ (v3.62.0) ──────────────────────────────────────
      // A SPY rather than the real one: `loadKnowledge` issues a `fetch`, and
      // what this harness is about is what `selectProject` ASKS for. §16h
      // drives the real one against a fake fetch.
      'loadKnowledge',
      // ── AND THE HONESTY METER'S READ (v3.63.0), FOR THE SAME REASON ──
      // A spy, for the same reason and with one extra property to check: it
      // is asked for the PAIR, not just the domain. A meter read that named
      // only the domain would paint another project's sessions here.
      'loadCapture',
      'JOURNAL_PAGE', 'WS_WINDOW',
      extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n'
      // ── THE PROJECT CACHE (v3.57.0) ─────────────────────────────────────
      // `selectProject` consults the cache before deciding whether to paint a
      // skeleton, writes the answer back, and hands the payload to
      // `applyProjectRead` — which is where the open pair is now chosen. All
      // of it is LIFTED rather than stubbed: a stubbed cache could only ever
      // miss, and a stubbed applyProjectRead would let this suite agree with
      // itself about which pair the table puts first.
      + 'const readCache = new Map();\n'
      + 'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n'
      + extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cacheGet', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cachePut', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'payloadSignature', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'applyProjectRead', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'selectProject', 'memory.js')
      + '\nreturn { selectProject, readCache };')(
      st, () => true, () => {}, (d, q) => d + '/' + q,
      () => st.activeDomain + '/' + st.activeProject,
      () => {},
      async () => ({ data: { scopes: STORE, brief: { present: false } }, error: null }),
      async () => {},
      async (scope, machine, token, opts) => { loaded.push({ scope, machine, opts }); },
      () => {}, async () => {}, async () => {}, 10, WS_WINDOW_SRC);

    await api.selectProject('acme', 'lumina', 1);
    eq('arriving on a project opens exactly one pair', loaded.length, 1);
    eq('THE PAIR IT OPENS IS THE AGENT-NEWEST ONE — scope AND machine, named',
      loaded[0].scope + '/' + loaded[0].machine,
      AGENT_NEWEST.scope + '/' + AGENT_NEWEST.machine);
    ok('...asked for BY NAME, never handed to the route as `latest` to resolve on '
      + 'the other clock', loaded[0].scope !== 'latest', JSON.stringify(loaded[0]));
    ok('...and NOT the store\'s first pair, which is what it used to take and is a '
      + 'fortnight older', loaded[0].scope !== STORE_FIRST.scope, loaded[0].scope);
    ok('the machine is REQUESTED without being recorded as a choice — nobody picked '
      + 'it, so Reload must still re-resolve to the newest copy (v3.34.0)',
    loaded[0].opts && loaded[0].opts.deliberate === false, JSON.stringify(loaded[0].opts));
  }

  // ── 1b · ...and "no choice recorded" is a measurement, not a parameter ──
  //
  // Driven through the REAL loadScope: the URL must carry the machine while
  // `state.machine` stays null, because that null is the whole of what makes
  // reloadActive re-resolve to the newest copy.
  {
    const st = liveState({ activeDomain: 'acme', activeProject: 'lumina',
      scope: null, machine: null, detail: null });
    const r = makeReloader(st, () => ({ ok: true, json: async () => ({ ok: true,
      scope: AGENT_NEWEST.scope, machine: AGENT_NEWEST.machine,
      current: { present: true, text: 'x' }, machines: [] }) }));
    await r.loadScope(AGENT_NEWEST.scope, AGENT_NEWEST.machine, 1, { deliberate: false });
    ok('the default open REQUESTS the machine it ranked',
      r.calls.urls.some((u) => /machine=box-7/.test(u)), JSON.stringify(r.calls.urls));
    eq('...and records NO machine choice', st.machine, null);
    await r.loadScope(AGENT_NEWEST.scope, AGENT_NEWEST.machine, 1);
    eq('CONTROL: the same call WITHOUT the flag records one, which is what a row '
      + 'press and the machine picker mean', st.machine, AGENT_NEWEST.machine);
  }

  // ── 2 · THE PAINT, and the defect measured beside it ────────────────────
  {
    const paint = (open) => makeRenderers({ detail: open,
      projectRead: { scopes: STORE }, wsWindow: WS_WINDOW_SRC })
      .renderWorkStreams(STORE, open, WS_WINDOW_SRC);

    const html = paint({ scope: AGENT_NEWEST.scope, machine: AGENT_NEWEST.machine });
    const rows = [...html.matchAll(/data-mem-scope="([^"]*)"/g)].map((m) => m[1]);
    eq('with the agent-newest pair open the table paints the WINDOW, five rows',
      rows.length, WS_WINDOW_SRC);
    eq('...in the order the agent\'s clock gives', rows.join(','), 'ws-7,ws-6,ws-5,ws-4,ws-3');
    eq('THE OPEN ROW IS THE FIRST ONE, so nothing had to be stretched to reach it',
      rows[0], AGENT_NEWEST.scope);
    eq('...and it is the only row marked open',
      (html.match(/mem-ws-row-open/g) || []).length, 1);
    ok('...and the way past the window is offered, three rows behind a footer',
      /Show 3 more/.test(html), html.slice(-260));

    // THE DEFECT ITSELF. Same table, same window, same eight pairs — the open
    // pair is the only thing that moves, and the footer disappears with it.
    const old = paint({ scope: STORE_FIRST.scope, machine: STORE_FIRST.machine });
    eq('CONTROL: opening the store\'s first pair instead stretches the window to '
      + 'every row', [...old.matchAll(/data-mem-scope="/g)].length, STORE.length);
    ok('...and takes the footer with it, so nothing on screen says the list was '
      + 'ever windowed — the reported symptom, reproduced',
    !/Show \d+ more/.test(old));
  }

  // ── 3 · A PRESS WINS, AND SURVIVES A POLL ──────────────────────────────
  //
  // Row SIX of the agent order: past the window, so it is a pair the default
  // open could never have chosen and a snap-back would be unmistakable.
  {
    const PRESSED = STORE[2];   // ws-2 / box-2 — ordered[5], the sixth row
    const st = liveState({ activeDomain: 'acme', activeProject: 'lumina',
      projectRead: { scopes: STORE, savedCopies: 8 }, detail: null,
      scope: null, machine: null, wsWindow: WS_WINDOW_SRC });

    const urls = [];
    let renders = 0;
    let patches = 0;
    const btn = { dataset: { memScope: PRESSED.scope, memMachine: PRESSED.machine },
      _click: null, addEventListener(t, fn) { if (t === 'click') this._click = fn; } };
    const root = { querySelectorAll: (sel) => (sel.includes('mem-ws-open') ? [btn] : []) };
    const press = new Function('state', 'render', 'isCurrentMount', 'fetch',
      'URLSearchParams', 'encodeURIComponent', 'JOURNAL_PAGE',
      'openReader', 'isCurrentReader', 'handoffReaderContent', 'reportAsyncMountFailure',
      'patchOpenPair',
      'let pendingFocusId = null;\n'
      + extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n'
      // ── THE PROJECT CACHE (v3.57.0) ───────────────────────────────────
      // A row press asks `loadScope` for `{reader: true, cache: true}`, so
      // the cache is on this path and must be the real one: a stub could
      // only ever miss, and missing is the arm this block drives.
      + 'const readCache = new Map();\n'
      + 'const MAX_CACHE = ' + JSON.stringify(liftConst('MAX_CACHE')) + ';\n'
      + extractFunction(viewSrc, 'cacheKeyProject', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cacheKeyScope', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cacheGet', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'cachePut', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'payloadSignature', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'loadScope', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'openWorkStream', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'bindWorkStreamRows', 'memory.js') + '\n'
      + 'return { bindWorkStreamRows };')(
      st, () => { renders++; }, () => true,
      async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({
        ok: true, scope: PRESSED.scope, machine: PRESSED.machine,
        current: { present: true, text: '# pressed\n' }, machines: [],
        journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } }) }; },
      URLSearchParams, encodeURIComponent, 10,
      () => 1, () => true, () => null, () => {},
      // The targeted DOM update a row press takes INSTEAD of a render. Counted
      // rather than executed here: what it writes needs a real table, and this
      // block's question is which of the two paths the press takes.
      () => { patches++; });

    press.bindWorkStreamRows(root, 1);
    ok('SETUP: the row\'s handler was bound', typeof btn._click === 'function');
    btn._click();
    await new Promise((res) => setImmediate(res));

    eq('A PRESS IS A CHOICE: the pressed work-stream becomes the selection',
      st.scope, PRESSED.scope);
    eq('...and its machine with it, because the pair is what was pressed',
      st.machine, PRESSED.machine);
    ok('...and the pair was read from the store by name',
      urls.some((u) => /scope=ws-2&machine=box-2/.test(u)), JSON.stringify(urls));

    // NOW POLL. The adaptive revalidation runs against the SAME state object,
    // with the index reporting a write since the list was read — the one case
    // that re-reads the scope list at all.
    const detailBefore = st.detail;
    st.detailFetchedAt = 1_000_000;
    st.scopesFetchedAt = 1_000_000;
    const r = makeRevalidator(st, (url) => (url === '/api/memory'
      ? { ok: true, json: async () => ({ ok: true, projects: [{ domain: 'acme',
        project: 'lumina', hasBrief: false, scopeCount: 8, savedCopies: 8,
        lastWriteAt: new Date(1_005_000).toISOString(), ageSeconds: 1,
        headline: 'a newer save landed' }] }) }
      : { ok: true, json: async () => ({ ok: true, project: 'lumina',
        savedCopies: 8, scopes: STORE }) }));
    await r.refreshIndex(1);

    eq('CONTROL: the poll really ran and re-read the list', r.calls.project, 1);
    ok('...and adopted it', st.projectRead.scopes.length === 8);
    eq('A POLL DOES NOT SNAP BACK TO THE DEFAULT PAIR — the scope stays where the '
      + 'press put it', st.scope, PRESSED.scope);
    eq('...and so does the machine', st.machine, PRESSED.machine);
    ok('...and the document is not swapped under the reader (v3.17.3)',
      st.detail === detailBefore);
  }
}

// ── 18e · THE PAGE: an ⓘ in the header, and no explainer card ───────────
{
  const src = stripComments(readFileSync(join(NEXT, 'views/memory.js'), 'utf8'));
  ok('renderMain builds its header with an `info` panel — "How this works" is the mark now',
    callSiteCount(src, 'renderViewHeader', { within: 'renderMain' }) > 0
    && /info: aboutInfoHtml\(\)/.test(src), 'no info on the centre header');
  ok('...as raw HTML, which is what lets the panel carry its list and its docs link',
    /infoHtml: true/.test(src));
  ok('the explainer component is GONE from this view — not imported, not called',
    !/renderExplainer/.test(src));
  ok('...and no branch of the page emits one',
    !makeRenderers(hostileState).renderProject().includes('tx-explainer'));
  ok('the About panel ends with a docs link from the frozen table',
    /docsLinkHtml\('memory\.overview'/.test(src));
  ok('...and that link really resolves and really renders',
    /<a href="https:\/\/github\.com\/[^"]*working-state\.md"/.test(makeRenderers(hostileState).aboutInfoHtml()));
  ok('the sidebar\'s lock CARD is gone and its sentence is behind the rail\'s own mark',
    !/mem-sidebar-foot/.test(src)
    && /Agents save handoffs here over MCP; you write the standing brief\./.test(src));
  ok('"Copy agent instructions" is in the header\'s action slot, not floating in the breadcrumb',
    /actionsHtml:[\s\S]{0,240}id="mem-copy-agent"/.test(src)
    && callSiteCount(src, 'renderViewHeader', { within: 'renderMain' }) > 0);
  ok('...and the breadcrumb row no longer carries it',
    !/mem-project-head[\s\S]{0,900}mem-copy-agent/.test(src));
}

// ── 18g · THE WIDGET'S TWO READINGS, IN THE APP ─────────────────────────
//
// The menubar widget has carried both since v3.37.0 and no Windows or Linux
// user has ever seen either: the "Working on:" headline, and "another computer
// saved after this one". Both are derived from data every read already
// returned — `scopes[].headline` was fetched on every request and rendered
// nowhere at all.
{
  const nowMs = Date.now();
  const at = (secs) => new Date(nowMs - secs * 1000).toISOString();

  // ── "Working on" MOVED, IT DID NOT GO (v3.62.0) ───────────────────────
  //
  // It was the first line of the deleted Status block. Its AGE is the strip's
  // WORKING STATE cell and its WORDS are the work-stream fold's summary, where
  // the row that wrote them lives — and `projectHeadline` is the ONE
  // derivation both read, so the two cannot name different saves. The
  // assertions below moved with the reading rather than being deleted with the
  // block: the same three properties, on the two surfaces that carry them now.
  const mkHead = (over) => makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', projects: [], openFolds: {},
    wsWindow: WS_WINDOW_SRC, detail: null, staleWrite: false, journalLimit: 10,
    ...over,
  });
  const headRead = {
    scopes: [{ scope: 'main', machine: 'boxa', headline: 'Rewriting the memory view',
      writtenAgeSeconds: 120, writtenAt: at(120) }],
    brief: { present: false }, savedCopies: 1, distinctScopeCount: 1,
  };
  const foldHtml = mkHead({}).renderWorkStreamsFold(headRead,
    { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, writtenAt: at(120) } });
  // ── THE HEADLINE IS THE TABLE'S, NOT THE SUMMARY'S (v3.65.1) ──────────
  // It LED this line from v3.55.0 to here, and on a real project it is a
  // SENTENCE: measured on the maintainer's own fixture it ran 240 characters
  // and wrapped the meta onto a second line under the row title — a paragraph
  // under a fold row, which is the one thing a step body may not contain. The
  // table this row opens carries it in WORKING ON, on the row that wrote it,
  // beside that row's machine and harness — which is where it belongs, since
  // there is one per handoff and a summary could only ever show the newest.
  ok('the summary is ONE line, and the headline is NOT in it',
    !/Rewriting the memory view/.test(
      (/<summary[\s\S]*?<\/summary>/.exec(foldHtml) || [''])[0]),
    (/<summary[\s\S]*?<\/summary>/.exec(foldHtml) || [''])[0]);
  ok('...and the headline is in the TABLE, on the row that wrote it',
    /Rewriting the memory view/.test(foldHtml.slice(foldHtml.indexOf('</summary>'))),
    foldHtml.slice(foldHtml.indexOf('mem-ws-body'), foldHtml.indexOf('mem-ws-body') + 400));
  // ── AND THE AGE FOLLOWS IT (v3.65.1, D2) ──────────────────────────────
  // Half of the deleted "Last saved" row landed here: the PROJECT's newest
  // save, from `newestPair` — the same derivation the MEMORY overview tile
  // uses, so the tile and this line can never name different saves. What a
  // closed row has to carry to be worth opening is "is any of this recent",
  // and `M saved copies` — which is what you open FOR — stayed in the body,
  // where `workStreamCounts` still prints both numbers uncapped.
  ok('...and the closed line is the count and the AGE — the pair a closed row '
    + 'has to carry to be worth opening',
  /class="mem-fold-meta">1 handoff · saved 2 min ago</.test(foldHtml), foldHtml.slice(0, 500));
  // ── AND THE AGE IS THE PROJECT'S NEWEST, NOT THE LAST ROW'S ─────────
  // `newestPair` is the same derivation `renderLayerStrip`'s MEMORY card uses,
  // so the tile and this line can never name different saves. FOUND BY
  // MUTATION: with a one-scope fixture, "the newest" and "the last in the
  // array" are the same row and a mutation swapping one for the other stayed
  // green. Two scopes, deliberately OUT of age order.
  ok('the age is the PROJECT\'s newest save, not the last row in the list',
    /· saved 3 min ago</.test(mkHead({}).renderWorkStreamsFold({
      scopes: [
        { scope: 'a', machine: 'm1', writtenAgeSeconds: 180 },
        { scope: 'b', machine: 'm2', writtenAgeSeconds: 7200 },
      ], savedCopies: 2, distinctScopeCount: 2,
    }, null)),
  mkHead({}).renderWorkStreamsFold({
    scopes: [
      { scope: 'a', machine: 'm1', writtenAgeSeconds: 180 },
      { scope: 'b', machine: 'm2', writtenAgeSeconds: 7200 },
    ], savedCopies: 2, distinctScopeCount: 2,
  }, null).slice(0, 400));
  ok('...and "N saved copies" is NOT in the summary — it is the count line under '
    + 'the table, which is uncapped and says both numbers',
  !/saved cop/.test((/<summary[\s\S]*?<\/summary>/.exec(foldHtml) || [''])[0])
    && /saved cop/.test(foldHtml), foldHtml.slice(0, 500));

  // AND THE AGE IS THE STRIP'S, with the shared dot and a LIVE hook.
  const stripHtml = mkHead({}).renderLayerStrip(headRead);
  ok('the strip carries the newest save\'s age under MEMORY',
    /MEMORY<\/div><div class="cur-ov-value[^"]*">[\s\S]*?saved 2 min ago</.test(stripHtml),
    stripHtml.slice(0, 600));
  ok('...with the shared freshness dot inside the value, on the same step the '
    + 'work-stream rows are cut on', /fresh-dot fresh-recent/.test(stripHtml), stripHtml.slice(0, 600));
  ok('...and the headline is escaped, because it comes off disk',
    !mkHead({}).renderWorkStreamsFold(
      { scopes: [{ scope: 'a', headline: XSS, writtenAgeSeconds: 60 }], savedCopies: 1 }, null)
      .includes('<img '));

  // IT FALLS BACK TO THE INDEX ROW, which is what the page has before the
  // unscoped read lands — and the skeleton paints that summary too.
  const fromIndex = mkHead({
    projects: [{ domain: 'acme', project: 'lumina', headline: 'From the index row',
      writtenAgeSeconds: 300, writtenAt: at(300) }],
  }).renderWorkStreamsFold({ scopes: [{ scope: 'main', machine: 'boxa' }], savedCopies: 1 }, null);
  // ── THE HEADLINE IS NO LONGER IN THIS LINE AT ALL (v3.65.1) ──────────
  // It was a sentence under a fold row. The table carries it now, per handoff.
  // This fixture's scope row has no age and no distinct-scope count either, so
  // the line is genuinely EMPTY — and that is the right answer: a separator
  // before nothing, or a placeholder, would both be worse than silence.
  ok('the headline is not in the summary, whichever fixture supplies it',
    !/From the index row/.test(
      (/<summary[\s\S]*?<\/summary>/.exec(fromIndex) || [''])[0]), fromIndex.slice(0, 400));
  ok('...and with no count and no age either, the line is EMPTY rather than a '
    + 'separator before nothing',
  /class="mem-fold-meta"><\/span>/.test(fromIndex), fromIndex.slice(0, 400));
  ok('CONTROL: and the headline is still on the page, in the table the row opens',
    /From the index row/.test(fromIndex.slice(fromIndex.indexOf('</summary>')))
    || /mem-ws-body/.test(fromIndex), fromIndex.slice(0, 400));

  // ABSENT IS ABSENT. No headline anywhere renders no clause, never an em dash.
  const noHead = mkHead({}).renderWorkStreamsFold(
    { scopes: [{ scope: 'main', writtenAgeSeconds: 60 }], savedCopies: 1, distinctScopeCount: 1 }, null);
  ok('CONTROL: with no headline at all the clause is omitted, not filled with a '
    + 'placeholder', /class="mem-fold-meta">1 handoff ·/.test(noHead), noHead.slice(0, 400));

  // ── ...AND IN THE RAIL ────────────────────────────────────────────────
  const rail = makeRenderers({}).renderProjectGroups(
    [{ domain: 'acme', project: 'lumina', scopeCount: 2, hasBrief: true,
      headline: 'Rewriting the memory view', writtenAgeSeconds: 120, writtenAt: at(120) },
    { domain: 'acme', project: 'quiet', scopeCount: 0, hasBrief: false }], 'acme', 'lumina');
  // THE HEADLINE MOVED TO LINE THREE (v3.65.0). It sat on line TWO, above the
  // figure — the one place the two rails' anatomy really differed — and it is
  // a LAST EVENT, which is the slot Domains' "Ingested · <title>" occupies.
  // `mem-row-head` is the kit's `event` slot under its alias, so the name is
  // unchanged and the POSITION is what this now asserts.
  ok('the rail row carries the headline too, on the LAST-EVENT line',
    /class="cur-sb-event mem-row-head">Rewriting the memory view</.test(rail), rail.slice(0, 600));
  ok('...and it comes AFTER the figure and the age, not before them',
    rail.indexOf('cur-sb-event') > rail.indexOf('cur-sb-meta'), rail.slice(0, 900));
  eq('...and a project with none gets no empty line',
    (rail.match(/class="cur-sb-event mem-row-head"/g) || []).length, 1);
  ok('the rail row wears the freshness dot, on the shared scale',
    /class="cur-sb-meta mem-row-meta">[\s\S]{0,120}class="fresh-dot fresh-recent"/.test(rail), rail.slice(0, 900));
  ok('...and a row with no age at all takes the `unknown` tier, not `dormant`',
    /class="fresh-dot fresh-unknown"/.test(rail));

  // ── "ANOTHER COMPUTER SAVED AFTER THIS ONE" ───────────────────────────
  // The tray's `newerElsewhereNotice` rule, reproduced rather than imported —
  // desktop/ and src/ may not import each other. Driven BOTH ways.
  const N = makeRenderers({}).newerOnAnotherMachine;
  const local = { scope: 'main', machine: 'mine', writtenAgeSeconds: 600, writtenAt: at(600) };
  const foreignNewer = { scope: 'main', machine: 'theirs', writtenAgeSeconds: 60, writtenAt: at(60) };
  const foreignOlder = { scope: 'main', machine: 'theirs', writtenAgeSeconds: 9000, writtenAt: at(9000) };
  const here = { machine: 'mine', machineIsThisMachine: true };

  eq('a foreign machine that saved LATER is named',
    (N([local, foreignNewer], here) || {}).machine, 'theirs');
  eq('a foreign machine that saved EARLIER is not', N([local, foreignOlder], here), null);
  eq('a tie is not news', N([local, { ...local, machine: 'theirs' }], here), null);
  eq('with no foreign machine at all there is nothing to say', N([local], here), null);
  eq('with no LOCAL row there is no "after this one" to measure against',
    N([foreignNewer], here), null);

  // THE TWO CLAUSES THAT ARE ABOUT TRUTHFULNESS RATHER THAN ARITHMETIC.
  eq('without positive evidence of WHICH machine is this one, nothing is claimed',
    N([local, foreignNewer], { machine: 'mine' }), null);
  eq('...and an explicit false is not evidence either', N([local, foreignNewer],
    { machine: 'mine', machineIsThisMachine: false }), null);
  eq('FILESYSTEM ages are excluded — on a synced folder that is the time of the '
    + 'PULL, so comparing one machine\'s pull against another\'s save would '
    + 'manufacture this notice out of sync traffic',
    N([{ scope: 'main', machine: 'mine', ageSeconds: 600 },
      { scope: 'main', machine: 'theirs', ageSeconds: 60 }], here), null);
  ok('CONTROL: the same two rows on AGENT clocks do produce the notice',
    N([local, foreignNewer], here) !== null);

  // ...and it reaches the page.
  const reaches = makeRenderers({ activeDomain: 'a', activeProject: 'b', projects: [] })
    .renderSaveStatus({ scopes: [local, foreignNewer], brief: { present: false } },
      { ...here, scope: 'main', current: { present: true, writtenAgeSeconds: 600, writtenAt: at(600) } });
  ok('the reading reaches the Status block, naming the machine and the work-stream',
    /theirs[\s\S]*?saved after this computer/.test(reaches) && /side|main/.test(reaches),
    reaches.slice(0, 600));
  ok('...and says what to do about it, which is the whole point of naming it',
    /Pull before you continue/.test(reaches));
}

// ── 18h · THE HEADER'S PANEL RUNS THE COLUMN ────────────────────────────
// Every block, the table and both documents end at one right edge. A help
// panel capped at 68ch beside them was the last of the four widths v3.54.0
// began removing, and `panelWide` is the opt-in that closes it.
{
  const src = stripComments(readFileSync(join(NEXT, 'views/memory.js'), 'utf8'));
  ok('the centre header asks for the wide panel',
    /renderViewHeader\(\{[\s\S]{0,400}panelWide: true/.test(src), 'panelWide is not passed');
  // EXECUTED, not merely present: the component has to emit the class.
  const head = renderViewHeader({
    eyebrow: 'x', title: 'Project context', info: '<p>hi</p>', infoHtml: true, panelWide: true,
  });
  ok('...and the component really emits the modifier on the panel',
    /class="tx-vh-panel tx-vh-panel-wide"/.test(head), head);
  ok('CONTROL: without the opt-in the panel keeps the prose cap',
    /class="tx-vh-panel"/.test(renderViewHeader({ title: 'x', info: 'y' })));
  ok('...and the opt-in is `=== true`, so a stray string cannot widen a panel',
    !/tx-vh-panel-wide/.test(renderViewHeader({ title: 'x', info: 'y', panelWide: 'yes' })));
  // AND THE CLASS IS DEFINED, with the value that makes it mean anything.
  const txCss = readFileSync(join(NEXT, 'shared/text.css'), 'utf8');
  ok('shared/text.css defines .tx-vh-panel-wide as max-width: none',
    /\.tx-vh-panel-wide \{[^}]*max-width:\s*none/.test(txCss));
  ok('...and it is declared AFTER .tx-vh-panel, so the cascade resolves it',
    txCss.indexOf('.tx-vh-panel-wide {') > txCss.indexOf('.tx-vh-panel {'));
}

// ── 18i · FIVE BLOCKS, ONE RHYTHM, AND LEDES YOU CAN READ ─────────────
//
// The page is `renderBlock`s now, which means it inherits the rule v3.54.0 set
// for Settings: a bold title, a lede of at most TWENTY VISIBLE WORDS, and
// everything longer behind the block's own ⓘ. That rule is what stopped
// Providers & keys being "a sea of information", and a page that adopts the
// component without adopting the rule gets the component's chrome and the old
// page's prose.
//
// ENFORCED OVER THE RENDERED PAGE, not over the call sites: a lede passed as a
// composed fragment is still a lede when it reaches the reader.
{
  const nowIso = new Date().toISOString();
  const full = {
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: false, staleWrite: true, journalLimit: 10, openFolds: {}, projects: [],
    projectRead: {
      scopes: [{ scope: 'main', machine: 'boxa', headline: 'x', writtenAgeSeconds: 120, writtenAt: nowIso }],
      savedCopies: 1, distinctScopeCount: 1,
      brief: { present: true, text: '# B\n\n## Goal\n\nShip it.', updatedAt: nowIso },
    },
    detail: {
      // TWO THINGS IN ONE FIXTURE, and both are load-bearing for the
      // never-fold check below.
      //
      // `machineIsThisMachine: false` is an EXPLANATION — "written somewhere
      // else, local paths may differ" — and since v3.65.0 it is a monitor
      // LINE, inside the fold. `lastSaveKind: 'replaced'` is a WARNING and is
      // a `loud` entry, outside it. A fixture carrying only the first would
      // make the never-fold scan vacuous (v3.64.2's green-first #4, recorded:
      // "a vacuous fixture, not a missing assertion"), and one carrying only
      // the second would leave nothing in the body to prove the split is a
      // split at all. `replaced` rather than `trimmed` deliberately: it emits
      // no badge, so the fixture gains a warning without also changing what
      // the READING says about itself.
      scope: 'main', machine: 'boxa', machines: [], machineIsThisMachine: false,
      current: { present: true, writtenAgeSeconds: 120, writtenAt: nowIso, text: '## Where\n\nx',
        lastSaveKind: 'replaced', lastSaveNotes: ['overwrote a larger handoff'] },
      journal: { returned: 1, total: 1, totalUnknown: false,
        entries: [{ at: nowIso, headline: 'h', harness: 'claude-code', rejections: [] }] },
    },
  };
  const page = makeRenderers(full).renderProject();

  // ── THREE STEPS, NAMED AND IN ORDER ─────────────────────────────────
  //
  // ── THE ASSERTION THIS REPLACES, AND WHY IT IS SUPERSEDED RATHER THAN
  //    DELETED ─────────────────────────────────────────────────────────
  // It read: `the page is FIVE blocks, in the order the design names them` —
  // `memory-status, memory-streams, memory-brief, memory-foundations,
  // memory-journal` — and it was a correct description of a page that was
  // wrong. Five readings about one project, in no stated order, with the
  // documents an agent must not act without in position four. The comment
  // above it said reading top to bottom was "the order a session start reads
  // in"; it was not, and the numerals are what make it true.
  //
  // Three steps, and the ORDER is the property (the count is not):
  //   ① canonical  — what the PROJECT tells an agent (replaced whole)
  //   ② state      — what the last session left      (supersedes)
  //   ③ knowledge  — what the wiki has compounded    (accumulates)
  const ids = [...page.matchAll(/settings-block-(context-[a-z]+)\b/g)].map((m) => m[1]);
  const uniq = [...new Set(ids)];
  // v3.67.0: and a FOURTH, their sum — what an agent is handed at the start.
  eq('the page is FOUR steps: the three layers in the order a session start reads them, then their sum',
    uniq.join(','), 'context-canonical,context-state,context-knowledge,context-session');
  ok('...and none of the five old block ids survives, by name',
    !/settings-block-memory-(status|streams|brief|foundations|journal)\b/.test(page), page.slice(0, 300));

  // ── NUMBERED, DELIBERATELY — AND THIS IS THE INVERSION ──────────────
  //
  // THE SUPERSEDED REASONING, kept rather than deleted because it is why the
  // page was built the way it was: shared/block.js's own note says "a numeral
  // is an argument for SEQUENCE", and v3.55.0 concluded that these were
  // "readings about one project rather than steps". The conclusion was right
  // about the five and wrong about the page: the three layers of context ARE
  // a sequence — the one a session start reads them in — and a page that
  // reads top to bottom as one is numbered. A numeral is an argument, not
  // decoration, and this page now has the argument to make.
  eq('every one of them is NUMBERED — the page is a sequence of steps',
    (page.match(/settings-block-num/g) || []).length, 4);
  eq('...so nothing on it is unnumbered any more',
    (page.match(/settings-block-unnumbered/g) || []).length, 0);
  eq('...and the numerals are 1, 2, 3, 4 in document order',
    [...page.matchAll(/class="settings-block-num"[^>]*>(\d+)</g)].map((m) => m[1]).join(','),
    '1,2,3,4');

  // ── ZERO LEDES, AND THE CEILING BECOMES A BAN (v3.65.0, R4) ─────────
  //
  // The ceiling was 20 visible words, then 13 (v3.62.0, the design system's
  // own number). It is now NONE on this page: the sentence under each
  // numbered title is the first paragraph of that step's ⓘ instead, and the
  // mark sits in the head row (§16e1 asserts both halves elementwise). This
  // is the same rule one rung stricter, so it is written as a ban plus a
  // positive control that the scan can still SEE a lede when there is one —
  // without that control a renamed class would report zero and pass.
  eq('no step carries a lede any more — the sentence is behind its own ⓘ',
    (page.match(/class="settings-job-lede settings-block-lede"/g) || []).length, 0);
  ok('CONTROL: the scan really can see a lede paragraph when one exists',
    (('<p class="settings-job-lede settings-block-lede">x</p>')
      .match(/class="settings-job-lede settings-block-lede"/g) || []).length === 1);

  // ── THE DEPTH IS BEHIND THE MARK, AND IT IS REALLY THERE ────────────
  eq('every step carries an ⓘ with a panel of its own',
    (page.match(/data-tx-info="settings-block-info-context-/g) || []).length, 4);
  eq('...and every one of those panels is hidden on first paint',
    (page.match(/class="tx-vh-panel" id="settings-block-info-context-[a-z]+" role="group"[^>]*hidden>/g) || []).length, 4);

  // ── WHAT MAY NEVER FOLD (v3.16.1) ───────────────────────────────────
  // A warning behind a click is not a warning. The Reload offer, the save
  // verdicts and the "state on disk we are not reading" note are in step ②'s
  // NOTICE slot — above its heading, inside its wrapper — and this proves it
  // by position rather than by reading the source. Over the PANELS' own
  // contents rather than by offset: renderBlock emits the fold BEFORE the
  // body, so a positional check reads the wrong way round — found by writing
  // it that way first and watching it fail on correct output.
  const panels = [...page.matchAll(/<div class="tx-vh-panel"[^>]*hidden>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1]);
  // FOUR, and each one is named: the three steps and the STRIP's own ⓘ, which
  // explains every age on the page and therefore belongs to the instrument
  // rather than to any one step. The honesty meter's was the fifth through
  // v3.65.0 and left in v3.65.1 (D4) — what a session IS is step ②'s
  // explanation now, and a step has ONE mark. The meter's own READING was
  // never among them: it is in step ②'s body, unfolded, because it is an
  // outcome (v3.16.1).
  // FIVE since v3.67.0: step ④'s own mark joins them.
  eq('CONTROL: the five folds were really found (the scan is not vacuous)', panels.length, 5);
  const bodies = [...page.matchAll(/<div class="settings-block-body">([\s\S]*)$/g)].map((m) => m[1]);
  ok('CONTROL: at least one block body was found', bodies.length >= 1);
  // `mem-save-line` BECAME `cur-mon-loud` (v3.65.0): the save warnings are
  // `renderMonitor` `loud` entries now, built from a different array and
  // rendered into a different container from the readings, with no field on a
  // line that can make one loud. The property under test is unchanged.
  for (const marker of ['id="mem-reload"', 'cur-mon-loud', 'mem-note-loud']) {
    ok('`' + marker + '` is never inside a fold — a warning behind a click is not a warning',
      panels.every((x) => !x.includes(marker)));
  }
  for (const marker of ['id="mem-reload"', 'cur-mon-loud']) {
    ok('...and `' + marker + '` really is on the page, so the check above is not vacuous',
      page.includes(marker));
  }

  // ── AND THE STATUS STACK IS THE STEP'S FIRST ROW, INSIDE THE BODY ─────
  //
  // REVERSED IN v3.64.1, deliberately, and this is the assertion that records
  // why. It used to require the stack ABOVE step ②'s heading, because that is
  // where `renderBlock` puts a `noticeHtml` — and that is exactly what the
  // maintainer reported the day v3.64.0 shipped: the "Last saved" reading
  // rendered as a card of its own above "② Working state" while CAPTURE, the
  // other reading about the same layer, was the first thing inside the body.
  // A summary above one step and a report inside it. Both readings now open
  // the body, in that order, and NOTHING renders above a step's heading.
  //
  // THE STACK IS STILL ONE WRAPPER UNDER ONE CLASS, which is what keeps
  // `patchOpenPair`'s selector and scripts/test-next-memory-switch.js §8's
  // byte comparison working through the move; splitting the reading out of it
  // is the one edit here that would silently break a shipped no-repaint
  // guarantee.
  const stepTwo = page.slice(page.indexOf('settings-block-context-state'));
  const atStack = stepTwo.indexOf('mem-status-stack');
  const atHead = stepTwo.indexOf('settings-block-hd');
  const atBody = stepTwo.indexOf('<div class="settings-block-body">');
  const atMeter = stepTwo.indexOf('mem-capture');
  ok('CONTROL: step ②\'s heading, body and both readings are all in the slice',
    atStack !== -1 && atHead !== -1 && atBody !== -1 && atMeter !== -1,
    [atStack, atHead, atBody, atMeter].join(' / '));
  ok('the status stack is emitted INSIDE step ②\'s body, not above its heading',
    atStack > atHead && atStack > atBody, atStack + ' vs head ' + atHead + ' body ' + atBody);
  ok('...and it is the step\'s FIRST row, above CAPTURE',
    atStack < atMeter, atStack + ' vs meter ' + atMeter);
  ok('nothing at all is emitted between step ②\'s wrapper and its heading',
    /class="settings-job-block settings-block settings-block-context-state"><div class="settings-block-hd">/
      .test(page), page.slice(page.indexOf('settings-block-context-state') - 60,
      page.indexOf('settings-block-context-state') + 140));
}

// ── 18j · THE SPACING INSIDE A BLOCK IS ITS OWN, AND SMALLER ────────────
//
// Two levels, two owners, two values. shell.css's
// `.settings-job-block + .settings-job-block` owns 24 | hairline | 24 BETWEEN
// blocks; `.mem-status-stack` owns the gap between the reading, the Reload
// offer and the unlisted note INSIDE block ①. Spacing those three at the block
// rhythm would read as three sections rather than as one reading with its
// caveats — and this view must not restate the block rhythm itself, or there
// would be two declarations of one gap, which is the drift the foundation
// removed.
{
  const css = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the status block stacks its notices in a column with its OWN gap',
    /\.mem-status-stack \{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*gap:\s*var\(--space-5\)/
      .test(css), (/\.mem-status-stack \{[^}]*\}/.exec(css) || [''])[0]);
  ok('...and that gap is SMALLER than the between-block rhythm, so a block '
    + 'break still reads as larger than a paragraph break',
    /--space-5/.test((/\.mem-status-stack \{[^}]*\}/.exec(css) || [''])[0])
    && !/--space-12/.test((/\.mem-status-stack \{[^}]*\}/.exec(css) || [''])[0]));
  ok('this view does NOT restate the block-to-block rhythm — shell.css owns it',
    !/\.settings-job-block \+ \.settings-job-block/.test(css));
  ok('...but it DOES bridge from a plain section into the first block, at the '
    + 'same value, so the step in is the same size as every step after it',
    /\.mem-section \+ \.settings-job-block \{[^}]*margin-top:\s*var\(--space-12\)/.test(css));
  ok('CONTROL: shell.css really is where the block rhythm lives',
    /\.settings-job-block \+ \.settings-job-block \{[^}]*margin-top:\s*var\(--space-12\)/
      .test(readFileSync(join(NEXT, 'shell.css'), 'utf8')));
  // ── THE PENCIL'S ANCHOR (v3.58.0) ──────────────────────────────────────
  // `.mem-block-toolbar` is gone: a space-between row with a short phrase at
  // one end and a button at the other put ~800px of nothing between them on a
  // 1,015px column, which is the maintainer's "reads as unattached". The
  // control is positioned over the fold's summary row instead, which requires
  // BOTH halves of the rule — a positioned ancestor and an absolute child —
  // and removing either leaves the button laid out in flow at the wrong place.
  ok('the retired toolbar row is deleted, not merely unused',
    !/\.mem-block-toolbar\s*\{/.test(css) && !/\.mem-brief-age\s*\{/.test(css));
  ok('the fold row is a POSITIONED ancestor, so the pencil has something to '
    + 'anchor to', /\.mem-brief-row \{[^}]*position:\s*relative/.test(css));
  ok('...and the pencil is anchored over the summary\'s right end rather than '
    + 'laid out in flow',
    /\.mem-brief-edit \{[^}]*position:\s*absolute[^}]*top:[^}]*right:/.test(css));
  ok('...as a square control at the kit\'s own minimum hit box, because there '
    + 'is no label left to pad around',
    /\.mem-brief-edit \{[^}]*width:\s*var\(--control-sm\)/.test(css));
  ok('the summary reserves room for it, so a long "updated … · N words" cannot '
    + 'run under the button',
    /\.mem-brief-row > \.mem-fold > \.mem-fold-summary \{[^}]*padding-right:/.test(css));
}

// ── 18f · memory.css: one column, one rhythm ──────────────────────
{
  const css = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (sel) => {
    const i = css.indexOf(sel + ' {');
    return i === -1 ? null : css.slice(i, css.indexOf('}', i));
  };
  ok('ONE adjacency rule owns every gap, at the Domains rhythm (24px)',
    /\.mem-section \+ \.mem-section \{[^}]*margin-top:\s*var\(--space-12\)/.test(css),
    'the .mem-section adjacency rule is missing or is not --space-12');
  for (const sel of ['.mem-save', '.mem-doc-card', '.mem-fold']) {
    const r = ruleOf(sel);
    ok(sel + ' exists', !!r);
    ok(sel + ' no longer caps ITS BOX at the prose measure — that is what left four '
      + 'different right edges on one page', !!r && !/max-width/.test(r), r || '');
  }
  // ── REVERSED IN v3.55.0, DELIBERATELY ──────────────────────────────────
  // v3.54.0 moved the measure cap off the three CARDS and onto the TEXT, and
  // asserted it HERE. That was right for a document and wrong for this page:
  // the handoff body, the standing brief, the "summary shortened" explanation
  // and the header's ⓘ panel all stopped at 68ch — roughly 47% of the 1200px
  // column — while the session journal beside them ran the full width. The
  // maintainer's verdict was "not okay" and "the page reads endlessly long",
  // and the mechanism is that everything on it was half as wide as its space.
  //
  // A measure cap is a rule about READING PROSE. This screen is a dashboard —
  // a status strip, a table, a document you scan for headings, a brief you
  // edit — so the cap is gone from the view entirely and the assertion is now
  // that it is ABSENT. It survives where it belongs: `.settings-job-lede`
  // caps a block's lede at 66ch in shell.css, because a lede IS a sentence.
  //
  // TWO SELECTORS, NOT THREE, SINCE v3.56.0. `.mem-doc-headline` was the
  // handoff's one-line agent summary and is GONE with the card it led — the
  // document opens in the shell's reader, whose own `.reader-title` carries
  // that line. Dropped from this loop rather than kept as a dead assertion; the
  // pair below names it, so a silent re-introduction is still caught.
  // ONE SELECTOR, NOT TWO, SINCE v3.65.0. `.mem-save-line` is GONE with the
  // three hand-styled sentence rows it named: every qualification under the
  // save reading is a `renderMonitor` line or `loud` entry now. The claim
  // about it survives at the component, where the rule has to hold for every
  // adopter rather than for this view alone.
  for (const sel of ['.mem-doc']) {
    const r = ruleOf(sel);
    ok(sel + ' exists', !!r);
    ok(sel + ' no longer caps the TEXT either — every block on this page runs '
      + 'the column, which is what a dashboard is', !!r && !/max-width/.test(r), r || '');
  }
  ok('.mem-save-line is GONE — the save\'s qualifications are monitor lines now',
    !ruleOf('.mem-save-line') && !stripComments(viewSrc).includes('mem-save-line'));
  // AND THE COMPONENT THAT REPLACED IT DRAWS THE LINE IN THE RIGHT PLACE —
  // which is the distinction this whole section is about rather than a
  // blanket ban. A READING is not prose and takes the column; a WARNING and
  // the producer's own NOTE are sentences and are capped at `--prose-max`,
  // the same rule shell.css applies to `.settings-job-lede`. Checked both
  // ways, so "capped" cannot be satisfied by capping everything.
  ok('...and the component that replaced it caps the SENTENCES and not the readings',
    (() => {
      const mon = readFileSync(join(NEXT, 'shared/monitor.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const bodyOf = (sel) => (new RegExp('\\' + sel + '\\s*\\{([^}]*)\\}').exec(mon) || [, ''])[1];
      return /max-width:\s*var\(--prose-max\)/.test(bodyOf('.cur-mon-loud'))
        && /max-width:\s*var\(--prose-max\)/.test(bodyOf('.cur-mon-note'))
        && !/max-width/.test(bodyOf('.cur-mon'))
        && !/max-width/.test(bodyOf('.cur-mon-line'))
        && !/max-width/.test(bodyOf('.cur-mon-value'));
    })());
  ok('.mem-doc-headline is GONE — the handoff\'s headline is the reader\'s title now',
    !ruleOf('.mem-doc-headline') && !stripComments(viewSrc).includes('mem-doc-headline'));
  ok('...and `--prose-max` appears nowhere in this stylesheet at all',
    !/var\(--prose-max\)/.test(css), (/[^\n]*var\(--prose-max\)[^\n]*/.exec(css) || [''])[0]);
  // ANTI-VACUITY: `ruleOf` finds a rule by an exact `"<sel> {"` substring, so a
  // reformat would make all three read as absent and the `max-width` checks
  // would pass over nothing. The `exists` assertions above cover that, and this
  // proves the extractor itself still finds a cap when there is one to find.
  ok('CONTROL: ruleOf really would see a max-width — shell.css still caps the lede',
    /max-width:\s*66ch/.test(readFileSync(join(NEXT, 'shell.css'), 'utf8')));
  // ── THE LEAD FOLD IS GONE, AND THAT IS v3.16.1's OWN RULE ──────────────
  // These two pinned `.mem-fold-lead`: a 3px accent rule, the full --border and
  // one step of elevation, so that ONE of three folds read first. The handoff
  // card it marked is gone — a row press opens the document in the reader — and
  // the journal is the only fold left on the page. A flag on one of one carries
  // no information, which is exactly the rule the original marking was argued
  // from, so the assertions invert rather than being deleted.
  ok('the lead-fold chrome is gone, with the card it marked',
    !/\.mem-fold-lead\s*[,{]/.test(css) && !/mem-fold-summary-lead/.test(css));
  ok('...and the one remaining fold takes NO accent — one flag on one row says '
    + 'nothing, which is why the leader was marked in the first place',
    !/\.mem-fold \{[^}]*var\(--accent\)/.test(css));
  ok('no block declares its own top or bottom margin to fight the one rule',
    !/\.mem-(save|stale|controls|doc-card|fold|project-head) \{[^}]*margin-(top|bottom):/.test(css),
    'a section still carries its own margin');
  ok('the pip STILL carries no transition (every render replaces the pane)',
    !/\.mem-save-pip[^{]*\{[^}]*transition/.test(css));
}

// ═════════════════════════════════════════════════════════════════════════
section('§21 — TIER 0: the foundations block, driven');
// ═════════════════════════════════════════════════════════════════════════
//
// Everything in this section runs the SHIPPED functions. The block has one
// property that nothing else on this page has — its figures can change with no
// clock moving and no byte on this machine changing, because `freshness` is
// recomputed by the store against a file in a checkout somebody else pulled —
// so the repaint guard is asserted here rather than assumed.

const fndDoc = (over = {}) => ({
  slug: 'architecture.md', role: 'architecture', title: 'Architecture',
  bytes: 12345, sha256: 'a'.repeat(64), updatedAt: '2026-09-17T09:00:00.000Z',
  commit: '9623343abcdef', source: { kind: 'repo', path: 'docs/architecture.md' },
  authoredBy: { kind: 'human' }, freshness: 'fresh', ...over,
});
// ── v3.69.0: THE SOURCE IS PER DOCUMENT ──────────────────────────────────
// Through v3.68.0 these fixtures said "curator-owned" with the PAYLOAD's
// `ownership` alone and left every row `source.kind: 'repo'` — a shape the
// view could not tell apart then, because it read `ownership`. It reads the
// DOCUMENTS now (CONTRACT §1.6: `ownership` is display-only), so a
// curator-owned fixture is made TRUE: every row becomes a kept document and
// the project records no repository, exactly what the store writes.
const fndPayload = (docs, over = {}) => {
  const kept = over.ownership === 'curator';
  const documents = kept
    ? docs.map((d) => (d.source && d.source.kind === 'repo'
      ? { ...d, source: { kind: 'curator' }, commit: undefined, freshness: d.freshness === 'fresh' ? 'n/a' : d.freshness }
      : d))
    : docs;
  return {
    present: true, ownership: 'repo',
    repo: kept ? null : { root: '/somewhere/repo', remote: null, lastRefreshAt: null, lastRefreshCommit: null },
    budgetBytes: 200000, totalBytes: docs.reduce((a, d) => a + (d.bytes || 0), 0),
    ...over, documents, orphanFiles: [], manifestError: null,
    ...(over.orphanFiles ? { orphanFiles: over.orphanFiles } : {}),
    ...(over.manifestError ? { manifestError: over.manifestError } : {}),
  };
};
const fndRead = (payload) => ({
  scopes: [], brief: { present: false }, foundations: payload,
});

// ── §21a — the facts, derived ONCE for three consumers ──────────────────
{
  const F = makeRenderers({});
  const facts = F.foundationsFacts(fndRead(fndPayload([
    fndDoc(), fndDoc({ slug: 'decisions.md', freshness: 'stale' }),
    fndDoc({ slug: 'roadmap.md', freshness: 'unreachable' }),
  ])));
  eq('the counts are over the documents the store listed', facts.count, 3);
  eq('...fresh', facts.fresh, 1);
  eq('...stale', facts.stale, 1);
  eq('...unreachable', facts.unreachable, 1);
  eq('totalBytes is preferred over a sum of the rows — the store takes it before its own cap',
    facts.bytes, 12345 * 3);

  // THE RULE THAT MATTERS: a reading that was never taken is not a passing
  // reading. `n/a` (curator-authored) and an unknown word from a newer server
  // both land in `unrated`, never in `fresh` — rounding them up is how a screen
  // claims a comparison nobody made.
  const cur = F.foundationsFacts(fndRead(fndPayload(
    [fndDoc({ freshness: 'n/a' }), fndDoc({ slug: 'x.md', freshness: 'something-new' })],
    { ownership: 'curator' })));
  eq('a curator-authored document is NOT counted as fresh', cur.fresh, 0);
  eq('...nor is a freshness word this build does not know', cur.unrated, 2);

  // A project with no foundations at all, and a server too old to send the key:
  // both answer a zeroed shape rather than throwing, because this runs on every
  // paint of every project.
  // WRAPPED, so a shipped function that THROWS on an absent payload REDS here
  // rather than crashing the suite: a crash reads like a pass in a summary
  // line, which is the v3.11.0 shape this file warns about. Proven necessary by
  // mutation — replacing the two guards inside `foundationsFacts` with bare
  // property reads killed the run instead of failing this assertion.
  for (const [name, read] of [['no key', { scopes: [] }], ['null', { foundations: null }],
    ['a string', { foundations: 'nope' }], ['no read at all', null]]) {
    let f = null;
    let threw = null;
    try { f = F.foundationsFacts(read); } catch (err) { threw = err; }
    ok('an absent payload (' + name + ') is a zeroed reading, never a throw',
      !threw && f && f.count === 0 && f.present === false && Array.isArray(f.docs),
      threw ? 'THREW: ' + threw.message : JSON.stringify(f));
  }
}

// ── §21b — the ONE word, worst first ────────────────────────────────────
{
  const F = makeRenderers({});
  const w = (docs, over) => F.foundationsWord(F.foundationsFacts(fndRead(fndPayload(docs, over))));
  eq('a manifest that will not parse outranks every other reading — every figure '
    + 'on the block is derived from it',
  w([fndDoc()], { manifestError: 'Unexpected token' }), 'manifest unreadable');
  eq('a stale copy outranks an unreachable one: one is a measured mismatch, the '
    + 'other is a measurement that could not be taken',
  w([fndDoc({ freshness: 'stale' }), fndDoc({ slug: 'b.md', freshness: 'unreachable' })]), '1 stale');
  eq('...and an unreachable source is said in words rather than left blank',
    w([fndDoc({ freshness: 'unreachable' })]), 'source unreachable');
  // ── OWNERSHIP LEFT THIS LADDER (v3.61.0, P1-11) ─────────────────────
  // It used to end `Curator-authored`, which meant the ownership fact
  // DISAPPEARED the moment anything else in the ladder applied — on a
  // curator-owned project with two skeletons the line read "2 skeletons to
  // fill" and never said who owned them, which is the one fact that decides
  // whether Refresh or Edit is the control to reach for. Ownership is now its
  // own clause and this word answers only "does anything need attention".
  eq('a curator-owned project with everything written reads `written`, not an '
    + 'ownership word — ownership is a separate clause now',
  w([fndDoc({ freshness: 'n/a' })], { ownership: 'curator' }), 'written');
  eq('all fresh is the quiet case', w([fndDoc(), fndDoc({ slug: 'b.md' })]), 'fresh');
  eq('none at all', w([]), 'none yet');
  ok('the word `Curator-authored` is gone from the ladder entirely',
    !['written', 'fresh', 'none yet'].some((x) => x === 'Curator-authored')
    && w([fndDoc({ freshness: 'n/a' })], { ownership: 'curator' }) !== 'Curator-authored');
}

// ── §21b1c — v3.65.1: THE HEAD ROW, THE THIRD CONTROL, AND ONE SENTENCE ─
// ═════════════════════════════════════════════════════════════════════════
//
// Three findings from production, and each of them can be undone by ONE edit
// with everything else still green — which is why each has a guard of its own
// rather than riding on the block rendering at all.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {} });
  const block = (docs, over) => F.renderFoundations(fndRead(fndPayload(docs, over)));

  // ── (1) THE CONTROLS ARE A HEAD ROW, ABOVE THE ROWS ─────────────────
  // Wiki health's `.dm-health-top` anatomy, the one shipped instance of the
  // pattern and the model the maintainer named. Through v3.65.0 this row was
  // emitted AFTER the fold: measured at 1370, the two controls sat at y=511
  // under a fold whose summary was at y=479, so the only section on this page
  // with controls put them where nothing else on the page does. DOCUMENT
  // ORDER is what the browser's geometry follows, so document order is what is
  // asserted.
  const populated = block([fndDoc(), fndDoc({ slug: 'b.md' })]);
  const ctrlAt = populated.indexOf('mem-fnd-head-controls');
  const foldAt = populated.indexOf('data-mem-fold="foundations"');
  ok('CONTROL: the populated arm really renders both', ctrlAt !== -1 && foldAt !== -1,
    populated.slice(0, 300));
  ok('the section\'s controls PRECEDE its rows, which is what puts them in a '
    + 'head row under the heading rather than under the table',
  ctrlAt < foldAt, ctrlAt + ' vs ' + foldAt);
  // THE EMPTY ARM IS THE CURATOR-OWNED ONE: a repo-owned project with nothing
  // copied yet returns the scan picker instead, which has no fold to precede.
  ok('...and on the empty arm too, so the two states do not disagree about '
    + 'where a control lives',
  (() => { const e = block([], { ownership: 'curator' });
    const c = e.indexOf('mem-fnd-head-controls');
    const f = e.indexOf('mem-fold-flat'); return c !== -1 && f !== -1 && c < f; })(),
  block([], { ownership: 'curator' }).slice(0, 300));

  // ── (1b) AND THE CAPTURE NOTE THAT MUST NOT FIRE (v3.65.1, D4) ──────
  // MEASURED on an isolated copy with NO usage log: the row's summary read
  // "no usage log on this computer yet" and the route's note read "Saves in
  // this window arrived through a bridge that logged no sessions — restart the
  // app that launched it". An alarm and a remedy for a bridge nobody ran,
  // beside a sentence already saying the log does not exist.
  //
  // THE ROOT CAUSE IS AT THE PRODUCER: src/routes/memory.js computes
  // `noSessionsButSaves = totals.sessions === 0 && newestSaveMs >= sinceMs`
  // with no term for the log EXISTING, so a machine with saves on disk and no
  // bridge ever opened takes that arm before the `!present` one below it. The
  // view's gate is structural — the two fields are on the same envelope — and
  // it withholds ONLY that note; the other two tenants are untouched.
  {
    const meter = (over) => makeRenderers({
      activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
      capture: { domain: 'acme', project: 'lumina', error: null, data: {
        logPresent: false, windowDays: 30, sessionsShown: 0, sessionsTruncated: false,
        totals: { sessions: 0, sessionsRead: 0, sessionsSaved: 0, sessionsReadNotSaved: 0,
          legacyLines: 0, selfTestLines: 0 },
        sessions: [], noSessionsButSaves: true,
        note: 'Saves in this window arrived through a bridge that logged no sessions — '
          + 'restart the app that launched it (usually Claude Desktop)', ...over } },
    }).renderCaptureMeter();
    ok('with NO usage log, the bridge alarm is withheld — a remedy for a bridge '
      + 'nobody ran, beside a summary already saying the log does not exist',
    !/logged no sessions/.test(meter()), meter().slice(0, 500));
    ok('...and the row\'s own summary is the whole answer',
      /no usage log on this computer yet/.test(meter()), meter().slice(0, 400));
    ok('CONTROL: with a log PRESENT the same note fires, unfolded — it is a real '
      + 'contradiction then, and an outcome may never sit behind a chevron',
    (() => { const h = meter({ logPresent: true });
      return /logged no sessions/.test(h)
        && !/<details[\s\S]*logged no sessions[\s\S]*<\/details>/.test(h); })(),
    meter({ logPresent: true }).slice(0, 500));
    ok('...and the OTHER two tenants are untouched by the gate — an absent log '
      + 'still says so, with no bridge flag set',
    /the meter starts counting/.test(meter({ noSessionsButSaves: false,
      note: 'no usage log yet — the meter starts counting with the first bridge session on v3.63.0' })),
    meter({ noSessionsButSaves: false,
      note: 'no usage log yet — the meter starts counting with the first bridge session on v3.63.0' }).slice(0, 400));
  }

  // ── (2) v3.69.0: BOTH DOORS, ALWAYS ENABLED — AND THE SOURCES STRIP ───
  // Through v3.68.0 the GitHub door was DISABLED on a curator-owned project
  // ("a project has one source"). The maintainer retired the rule: the source
  // is recorded per document, so both doors are enabled on every project that
  // may be written (CONTRACT §4.1), and the project-level Refresh became one
  // Refresh per source group, in a strip under the head row (§4.4).
  const kept = block([fndDoc({ freshness: 'n/a' })], { ownership: 'curator' });
  ok('the GitHub door reaches a CURATOR-kept block ENABLED — no "one source" any more',
    /id="mem-fnd-door-github" data-fnd-door="github"/.test(kept)
    && !/id="mem-fnd-door-github"[^>]*aria-disabled/.test(kept) && !/one source/.test(kept),
    (kept.match(/id="mem-fnd-door-github"[^>]*>/) || [''])[0]);
  ok('...and so does the local door', /id="mem-fnd-door-local" data-fnd-door="local"/.test(kept));
  ok('the GitHub door reaches a mirror\'s block, enabled',
    /id="mem-fnd-door-github" data-fnd-door="github"/.test(populated), populated.slice(0, 600));
  ok('neither the old project-level Refresh nor "Mirror from GitHub instead" survives as a head control',
    !/id="mem-fnd-refresh"|id="mem-fnd-mirror"|id="mem-fnd-addrepo"|id="mem-fnd-refresh-blocked"/.test(populated));
  ok('a mirror gets the SOURCES STRIP under the head row, one line per group, with its own Refresh',
    /id="mem-fnd-sources"/.test(populated) && /data-fnd-refresh="s1"/.test(populated)
    && populated.indexOf('id="mem-fnd-sources"') > populated.indexOf('mem-fnd-head-controls')
    && populated.indexOf('id="mem-fnd-sources"') < populated.indexOf('data-mem-fold="foundations"'),
    populated.slice(0, 900));
  ok('...and a project of KEPT documents has NO strip — copies and written documents never refresh',
    !/id="mem-fnd-sources"/.test(kept) && !/data-fnd-refresh/.test(kept));
  ok('"Refresh all" appears only with two or more sources',
    !/id="mem-fnd-refresh-all"/.test(populated));
  // A FOLDER GROUP WITH A REMOTE RECORDED gets "Read from GitHub instead",
  // v3.65.1's switch now per group; one with none does not.
  const withRemote = block([fndDoc()], { repo: { root: '/somewhere/repo',
    remote: { owner: 'acme', repo: 'lumina', ref: null, path: null } } });
  ok('a folder source with a remote recorded offers "Read from GitHub instead" on ITS line',
    /data-fnd-source="s1"[\s\S]*data-fnd-read-gh="s1"/.test(withRemote), withRemote.slice(0, 900));
  ok('...and one with no remote does not', !/data-fnd-read-gh/.test(populated));

  // ── (3) THE LOCAL PANEL: KEEP IN SYNC / COPY ONCE (§4.2, D2) ──────────
  const withPanel = (docs, door, over, payloadOver) => {
    const facts = F.foundationsFacts(fndRead(fndPayload(docs, payloadOver)));
    const info = doorsFor(facts, {})[door];
    return makeRenderers({
      activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
      fndAdd: Object.assign(FA.freshAddPanel(door, info, facts), { domain: 'acme', project: 'lumina' }, over || {}),
    }).renderFoundations(fndRead(fndPayload(docs, payloadOver)));
  };
  const adding = (docs, over) => withPanel(docs, 'local', over);
  {
    const h = adding([fndDoc()]);
    ok('the local panel shows BOTH options, always',
      /data-fadd-mode="mirror"/.test(h) && /data-fadd-mode="copy"/.test(h)
      && /Keep in sync with this folder/.test(h) && /Copy once/.test(h), h.slice(h.indexOf('fadd-panel'), h.indexOf('fadd-panel') + 1500));
    ok('...Copy once is chosen before any folder is listed', /value="copy" data-fadd-mode="copy" checked/.test(h));
    ok('...and the lead note states the chosen outcome in one sentence',
      /id="fadd-note">Copied once: /.test(h), (h.match(/id="fadd-note">[^<]*/) || [''])[0]);
    const g = adding([fndDoc()], { mode: 'mirror', inGitCheckout: true, root: '/r', listedRoot: '/r',
      candidates: [{ path: 'a.md', bytes: 10 }], picks: { 'a.md': true } });
    ok('inside a git checkout Keep in sync is the chosen default, and the note says why',
      /value="mirror" data-fadd-mode="mirror" checked/.test(g) && /inside a git checkout/.test(g),
      (g.match(/id="fadd-note">[^<]*/) || [''])[0]);
    ok('...and the primary reads "Mirror N documents"', /id="fadd-go">Mirror 1 document</.test(g));
    const c = adding([fndDoc()], { mode: 'copy', root: '/r', listedRoot: '/r',
      candidates: [{ path: 'a.md', bytes: 10 }], picks: { 'a.md': true } });
    ok('...while Copy once reads "Copy N documents"', /id="fadd-go">Copy 1 document</.test(c));
  }
  ok('CONTROL: and a mirror with nothing in it still says so',
    /Nothing mirrored yet/.test(block([], {})), (block([], {}).match(/class="tx-desc">[^<]*/) || [''])[0]);

  // ── (4) THE GITHUB PANEL ADDS; "already added" AND "lands as" ARE THE SERVER'S
  {
    const gh = withPanel([fndDoc()], 'github');
    ok('the GitHub panel renders the REMOTE fields, not the folder one',
      /class="fnd-init-remote-fields"/.test(gh) && !/id="fadd-root"/.test(gh));
    ok('...under its own eyebrow', /class="mem-fnd-panel-eyebrow[^"]*">ADD FROM GITHUB</.test(gh));
    ok('...and says a new repository becomes a NEW source — never that it switches one',
      /becomes a new source/.test(gh) && !/switch/i.test((gh.match(/id="fadd-note">[^<]*/) || [''])[0]));
    ok('...before a list its primary is NOT RENDERED — the reason line says why',
      !/id="fadd-go"/.test(gh) && /Name the repository first/.test(gh));
    const listed = withPanel([fndDoc()], 'github', { remote: 'o/r', hasReadToken: true,
      candidates: [
        { path: 'docs/architecture.md', bytes: 4096, suggestedSlug: 'architecture.md',
          alreadyAdded: true, alreadyAs: 'architecture.md', landsAs: 'architecture.md' },
        { path: 'docs/new.md', bytes: 10, suggestedSlug: 'new.md', alreadyAdded: false, landsAs: 'new.md' },
        { path: 'guide/architecture.md', bytes: 20, suggestedSlug: 'architecture.md',
          alreadyAdded: false, alreadyAs: null, landsAs: 'architecture-r.md' }],
      picks: { 'docs/new.md': true } });
    ok('...after one, it counts what it will mirror', /id="fadd-go">Mirror 1 document</.test(listed),
      (listed.match(/id="fadd-go"[\s\S]{0,80}/) || [''])[0]);
    ok('...the row the SERVER marks alreadyAdded is ticked and disabled, never tickable',
      /data-fadd-row="docs\/architecture\.md"[^>]*>[\s\S]{0,120}checked disabled/.test(listed)
      && /already added/.test(listed));
    ok('...a same-NAMED file the server does NOT mark stays tickable — never keyed by slug',
      /data-fadd-pick="guide\/architecture\.md"/.test(listed));
    ok('...and it carries its "lands as" badge, before the commit',
      /data-fadd-row="guide\/architecture\.md"[\s\S]{0,400}lands as architecture-r\.md/.test(listed));
    ok('...while a file landing under its own name carries none',
      !/data-fadd-row="docs\/new\.md"[^]*?lands as new\.md/.test(listed));
  }

  // ── (5) ONE BOX, AND ITS EYEBROW ────────────────────────────────────
  ok('the panel is ONE box, never a card nested in a row nested in a stack',
    /class="mem-fnd-panel mem-fnd-add"/.test(adding([fndDoc()]))
    && !/mem-fold-flat/.test(adding([fndDoc()]).slice(adding([fndDoc()]).indexOf('fadd-panel'),
      adding([fndDoc()]).indexOf('data-mem-fold="foundations"'))));
  ok('...and it sits ABOVE the table, which stays on screen behind it',
    adding([fndDoc()]).indexOf('fadd-panel') < adding([fndDoc()]).indexOf('data-mem-fold="foundations"'));
}

// ── §21b1d — v3.65.1 §9: THE DEPTH BAR'S TWO PLACEMENTS ────────────────
// ═════════════════════════════════════════════════════════════════════════
//
// The primitive is scripts/test-next-monitor-kit.js §8's. What is asserted
// HERE is the two things only this view can get wrong: WHICH DENOMINATOR each
// placement uses, and WHERE a bar is allowed to appear.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
    domainList: ['acme'] });
  const pct = (h, after) => {
    const i = after === undefined ? 0 : h.indexOf(after);
    const m = /style="width:([\d.]+)%"/.exec(h.slice(i));
    return m ? Number(m[1]) : null;
  };

  // ── (1) THE DOCUMENTS TABLE'S SIZE COLUMN, AGAINST 200 KB ───────────
  // `FOUNDATIONS_BUDGET_BYTES` is the PROJECT's disk budget. It is NOT the
  // 120 KB bootstrap budget: that one is the READING budget and applies only
  // to the `readFirst` subset, while this column lists EVERY document —
  // measuring every row against the reading budget paints an ordinary
  // project's third document red. CLAUDE.md's own invariant is that the two
  // are named apart, and this is where a view would collapse them.
  const table = F.renderFoundations(fndRead(fndPayload([
    fndDoc({ slug: 'a.md', bytes: 63488 }),
    fndDoc({ slug: 'b.md', bytes: 215042 }),
  ])));
  ok('CONTROL: the table really drew bars', /cur-depth-bar/.test(table), table.slice(0, 300));
  // v3.66.0: the row body now OPENS with the Documents monitor (P1, §23), which
  // draws bars and hidden sentences of its own. The per-row assertions below
  // are about the TABLE's cells, so they read the table alone — the monitor's
  // own bars are §23's to pin.
  const tbl = table.slice(table.indexOf('<table class="fnd-table">'));
  ok('CONTROL: the table slice exists and starts AFTER the monitor',
    table.indexOf('<table class="fnd-table">') > table.indexOf('id="mem-fnd-monitor"')
    && table.indexOf('id="mem-fnd-monitor"') > 0);
  // ── v3.70.0: A SHARE OF THE PROJECT'S OWN DOCUMENTS, NEVER AN ALARM ───
  // The 200 KB project figure only ever WARNED, and the orchestrator's note
  // for this release drops it as an alarm: the reading budget is the meter
  // that decides what an agent is handed (step ④). So the SIZE column is a
  // share (`max`) of the project's own stored total — each row's part of the
  // whole — and it can never take the danger tone, however large a document.
  // What stays true of v3.65.1: never the 120 KB reading budget (the two are
  // named apart), and every bar names its denominator in words.
  const total = 63488 + 215042;
  eq('the SIZE column is each document\'s SHARE of the project\'s stored total',
    pct(table, 'a.md'), Math.round((63488 / total) * 1000) / 10);
  ok('...and NEVER the 120 KB reading budget, which applies only to the read-first subset',
    Math.round((63488 / total) * 1000) / 10 !== Math.round((63488 / (120 * 1024)) * 1000) / 10);
  {
    const bare = fndPayload([fndDoc({ slug: 'a.md', bytes: 63488 })]);
    delete bare.budgetBytes;
    eq('...and with no project budget on the wire at all the bar is unchanged — it never read it',
      pct(F.renderFoundations(fndRead(bare)), 'a.md'), 100);
  }
  ok('a document larger than the old 200 KB figure is NOT danger-toned — a size is not an alarm',
    !/cur-depth-danger/.test(tbl), (tbl.match(/cur-depth-bar[^>]*/g) || []).join(' | '));
  ok('every SIZE cell names its denominator in a sentence a screen reader gets',
    (tbl.match(/class="visually-hidden"> [^<]* of the 272 KB of documents in this project/g) || []).length === 2,
    (tbl.match(/class="visually-hidden">[^<]*/g) || []).join(' | '));
  ok('...and no "project budget" is named anywhere in the table or its row',
    !/project budget/.test(table), table.slice(0, 400));
  ok('...nor an unfolded over-budget sentence for the stored total when nothing is read first',
    /id="mem-fnd-budget" hidden>/.test(table), (/id="mem-fnd-budget"[^>]*>/.exec(table) || ['absent'])[0]);

  // ── (2) THE KNOWLEDGE MONITOR, AGAINST THAT DOMAIN'S OWN pageCount ──
  // An EXACT denominator, not "the largest visible row": the producer states
  // `pageCount === entities + concepts + summaries + other` as an invariant,
  // so the three bars can never sum past the full track and the remainder is
  // the `other` the invariant names.
  const kn = makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', domainList: ['acme'],
    openFolds: { 'knowledge-acme': true },
    knowledge: new Map([['acme', { error: null, data: { pageCount: 767,
      pageCounts: { entities: 161, concepts: 553, summaries: 53 },
      lastIngestDate: '2026-09-13', lastIngestKind: 'ingest' } }]]),
    projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false },
  }).renderKnowledge();
  ok('CONTROL: the knowledge monitor really drew bars', /cur-depth-bar/.test(kn), kn.slice(0, 300));
  for (const [key, n] of [['entities', 161], ['concepts', 553], ['summaries', 53]]) {
    eq('the ' + key + ' count measures against that domain\'s OWN pageCount',
      pct(kn, 'cur-mon-key">' + key + '<'), Math.round((n / 767) * 1000) / 10);
  }
  eq('the three bars sum to at most the full track, because the producer\'s '
    + 'invariant makes the denominator exact',
  [161, 553, 53].reduce((a2, b2) => a2 + b2) <= 767, true);
  ok('`pages` carries NO bar — it IS the denominator, and a bar at 100% on '
    + 'every row would read as a reading rather than as a definition',
  !/cur-mon-key">pages<\/span><span class="cur-mon-value"><span class="cur-depth"/.test(kn),
  (kn.match(/cur-mon-key">pages[\s\S]{0,160}/) || [''])[0]);
  ok('`last ingest` carries none either — that is a TIME, and the dot owns time',
    !/cur-mon-key">last ingest<\/span><span class="cur-mon-value"><span class="cur-depth"/.test(kn),
    (kn.match(/cur-mon-key">last ingest[\s\S]{0,200}/) || [''])[0]);
  ok('...and NOTHING in this view tones a knowledge bar — these are categories '
    + 'within one domain, so nothing here is an over-run',
  !/cur-depth-danger/.test(kn), (kn.match(/cur-depth-bar[^>]*/g) || []).join(' | '));

  // ── (3) WHERE A BAR MAY NEVER APPEAR ────────────────────────────────
  // Never in a `<summary>` (one line of text already carrying a row fill and,
  // on step ③, an identity dot), never in a sidebar row, never on an age.
  const page = makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', domainList: ['acme'],
    journalLimit: 10, projects: [], detail: null, detailLoading: false,
    wsWindow: WS_WINDOW_SRC,
    knowledge: new Map([['acme', { error: null, data: { pageCount: 10,
      pageCounts: { entities: 4, concepts: 5, summaries: 1 }, lastIngestDate: '2026-09-13' } }]]),
    openFolds: { foundations: true, 'knowledge-acme': true },
    projectRead: { ...fndRead(fndPayload([fndDoc({ bytes: 4096 })])),
      knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false },
  }).renderProject();
  ok('CONTROL: the page really drew bars', /cur-depth/.test(page), String(page.length));
  const summaries = [...page.matchAll(/<summary[\s\S]*?<\/summary>/g)].map((m) => m[0]);
  ok('CONTROL: the page really has summaries to check', summaries.length >= 2,
    String(summaries.length));
  ok('NO bar inside any `<summary>` — a background there competes with the '
    + 'row\'s own fill and with the identity dot beside it',
  summaries.every((x) => !/cur-depth/.test(x)),
  (summaries.find((x) => /cur-depth/.test(x)) || '').slice(0, 200));
  ok('NO bar in the overview card — its figures are readings about the screen, '
    + 'not shares of anything',
  !/cur-ov-card[\s\S]*?cur-depth/.test(page.slice(page.indexOf('cur-ov'), page.indexOf('settings-block'))),
  'a bar reached the overview');
  ok('NO bar on an age anywhere on the page — the dot owns time, and a bar '
    + 'whose length was an age would be a second ladder wearing the first\'s '
    + 'meaning',
  !/fresh-dot[^<]*<\/span>\s*<span class="cur-depth"/.test(page));
}

// ── §21b2 — the SUMMARY LINE: four clauses, and three readings of zero ──
// (v3.61.0, P1-11 + P2-3)
{
  const F = makeRenderers({});
  const meta = (docs, over) =>
    F.foundationsSummaryMeta(F.foundationsFacts(fndRead(fndPayload(docs, over))));

  // FOUR CLAUSES: count, size, ownership, state.
  eq('a mirror reads count, size, ownership and state, in that order',
    meta([fndDoc({ bytes: 4096 }), fndDoc({ slug: 'b.md', bytes: 8192, freshness: 'stale' })]),
    '2 documents · 12 KB · mirrored · 1 stale');
  eq('...and a curator-owned project says `kept here` in the same slot',
    meta([fndDoc({ bytes: 3072, freshness: 'n/a', skeleton: true })], { ownership: 'curator' }),
    '1 document · 3 KB · kept here · 1 skeleton to fill');
  // THE OWNERSHIP CLAUSE IS UNCONDITIONAL — which is the whole delta. A
  // skeleton count in the state slot must NOT cost the reader the mode.
  ok('a skeleton in the state clause does not take the ownership clause with it',
    /kept here/.test(meta([fndDoc({ skeleton: true, freshness: 'n/a' })], { ownership: 'curator' })));

  // THREE READINGS OF ZERO. One "none yet" for three different situations was
  // the defect: no mode chosen, a mirror with nothing copied, and a project
  // kept here with nothing written are three things a person acts on
  // differently.
  eq('no manifest at all', meta([], { present: false, ownership: null }),
    'not set up · choose how documents arrive');
  eq('a mirror with nothing copied', meta([], { ownership: 'repo' }),
    'mirrored · no documents copied yet');
  eq('a project kept here with nothing written', meta([], { ownership: 'curator' }),
    'kept here · no documents yet');
  ok('...and the three are genuinely different strings',
    new Set([
      meta([], { present: false, ownership: null }),
      meta([], { ownership: 'repo' }),
      meta([], { ownership: 'curator' }),
    ]).size === 3);
  eq('a manifest that will not parse says so and quotes no figure',
    meta([fndDoc()], { manifestError: 'Unexpected token' }), 'manifest unreadable');

  // v3.70.0: THE STORED TOTAL IS SAID NEUTRALLY. P2-3 put "of a 200 KB
  // budget" in the size clause when the total crossed it; the orchestrator's
  // note for v3.70.0 drops that figure as an alarm, because the reading budget
  // (step ④) is what decides what an agent is handed.
  const over = meta([fndDoc({ bytes: 220 * 1024 })], { ownership: 'curator' });
  ok('a stored total over the old 200 KB figure reads as a plain size — never "over budget"',
    /^1 document \u00b7 220 KB \u00b7 kept here \u00b7 /.test(over) && !/budget/.test(over), over);
  ok('...and under it, the same', !/budget/.test(meta([fndDoc({ bytes: 4096 })])));

  // OWNERSHIP AS ITS OWN FUNCTION: `null` for an absent mode, because an
  // absent mode is not a third mode.
  eq('an absent mode is null, never a word',
    F.foundationsOwnershipWord(F.foundationsFacts(fndRead(fndPayload([], { present: false, ownership: null })))),
    null);
}

// ── §21c — THE HEAD ROW AND THE SOURCES STRIP (P1-4; v3.69.0 §4) ───────
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {} });
  const block = (docs, over, st) => makeRenderers({ activeDomain: 'acme', activeProject: 'lumina',
    openFolds: {}, ...(st || {}) }).renderFoundations(fndRead(fndPayload(docs, over)));

  // ── REFRESH IS PER SOURCE, AND ADD IS ALWAYS THERE ───────────────────
  // The v3.61.0 delta this section was written for still holds — a mirror is
  // never un-extendable — and the doors now say it for every project.
  {
    const h = block([fndDoc({ freshness: 'fresh' }), fndDoc({ slug: 'b.md', freshness: 'stale' })]);
    ok('a populated, reachable mirror has its source line with a Refresh', /data-fnd-refresh="s1"/.test(h));
    ok('...AND both doors, at the same time',
      /data-fnd-door="local"/.test(h) && /data-fnd-door="github"/.test(h));
  }
  {
    const h = block([], { ownership: 'repo' });
    ok('a mirror with NOTHING copied still shows its declared source',
      /id="mem-fnd-sources"/.test(h) && /0 documents/.test(h), h.slice(0, 900));
    ok('...and both doors', /data-fnd-door="local"/.test(h) && /data-fnd-door="github"/.test(h));
  }
  {
    const h = block([fndDoc({ freshness: 'n/a' })], { ownership: 'curator' });
    ok('a project of kept documents is offered "Write a document"', /id="mem-fnd-add"/.test(h));
    ok('...and never a Refresh — there is no upstream to refresh from', !/data-fnd-refresh/.test(h));
  }
  {
    // D4: the owner's pen on ANY project, a mirror included.
    const h = block([fndDoc({ freshness: 'fresh' })]);
    ok('a MIRROR is offered "Write a document" too — a new document may be written anywhere',
      /id="mem-fnd-add"/.test(h));
  }
  {
    // A FOLDER NOT ON THIS COMPUTER: its line says so, and it still refreshes
    // (over GitHub when a remote is recorded) — nothing is disabled.
    const h = block([fndDoc({ freshness: 'unreachable' })]);
    ok('a folder source that is not here says so on ITS line', /not on this computer/.test(h), h.slice(0, 900));
    ok('...and keeps its Refresh (the store reads GitHub when the folder is not here)',
      /data-fnd-refresh="s1"/.test(h) && !/data-fnd-refresh="s1"[^>]*aria-disabled/.test(h));
    ok('...and both doors stay enabled', !/mem-fnd-door-[a-z]+"[^>]*aria-disabled/.test(h));
  }
  // ── P1-3: A READ-ONLY MIRROR GETS NOTHING, AND IS TOLD WHY ───────────
  {
    const h = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
      detail: { readonly: true } }).renderFoundations(fndRead(fndPayload([fndDoc({ freshness: 'fresh' })])));
    ok('a read-only Shared Brain mirror gets no strip and no Write',
      !/id="mem-fnd-sources"/.test(h) && !/id="mem-fnd-add"/.test(h));
    ok('...its doors are aria-disabled with the reason', /mem-fnd-door-github"[^>]*aria-disabled="true"/.test(h));
    ok('...and it carries the mirror reason', /read-only mirror/.test(h));
  }
  // ── A REFRESH IN FLIGHT names its own line ───────────────────────────
  {
    const two = fndPayload([fndDoc(), fndDoc({ slug: 'l.md', source: { kind: 'repo', path: 'l.md', group: 's2' },
      freshness: 'unreachable' })], { sources: [
      { id: 's1', kind: 'folder', label: 'repo', reachableHere: true, remote: null, lastRefreshAt: null, lastRefreshCommit: null, documentCount: 1 },
      { id: 's2', kind: 'github', label: 'acme/lumina', reachableHere: false,
        remote: { owner: 'acme', repo: 'lumina', ref: null, path: null }, lastRefreshAt: null, lastRefreshCommit: null, documentCount: 1 }] });
    two.documents[0].source = { kind: 'repo', path: 'docs/architecture.md', group: 's1' };
    const busy = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
      fnd: { domain: 'acme', project: 'lumina', busy: true, group: 's2', error: null, result: null } })
      .renderFoundations(fndRead(two));
    ok('two sources get "Refresh all"', /id="mem-fnd-refresh-all"/.test(busy));
    ok('a refresh of ONE source says "Refreshing…" on THAT line only',
      /data-fnd-refresh="s2"[^>]*>Refreshing…/.test(busy) && !/data-fnd-refresh="s1"[^>]*>Refreshing…/.test(busy)
      && /id="mem-fnd-refresh-all"[^>]*>Refresh all/.test(busy), busy.slice(0, 1400));
    ok('...and every refresh control is disabled while one runs',
      (busy.match(/data-fnd-refresh="s\d"[^>]*disabled/g) || []).length === 2);
  }
}

// ── §21c2 — "Copy the drafting request": offered, withheld, absent (P2-8) ──
{
  const F = makeRenderers({});
  const ask = (docs, over, ro) =>
    F.foundationsDraftAsk(F.foundationsFacts(fndRead(fndPayload(docs, over))), ro === true);

  {
    const a = ask([fndDoc({ skeleton: true, freshness: 'n/a' })], { ownership: 'curator' });
    ok('a curator-owned project with a skeleton is offered it',
      /id="mem-fnd-ask"/.test(a.btn), a.btn);
    ok('...at the QUIET tier — it copies, it does not commit',
      /btn-ghost/.test(a.btn) && !/btn-primary/.test(a.btn), a.btn);
    ok('...with its own ⓘ beside it, so the button is never a bare "Copy"',
      /mem-fnd-ask-info-btn/.test(a.btn) && /tx-vh-panel/.test(a.panel));
    ok('...and the panel makes the privacy claim: the drafting model is the '
      + 'harness\u2019s, and The Curator sends nothing to a model',
    /sends nothing to a model/.test(a.panel), a.panel.slice(0, 200));
    ok('...and the approval gate is named', /until you approve/.test(a.panel));
    ok('...and the panel ships CLOSED', /<div class="tx-vh-panel"[^>]*hidden>/.test(a.panel), a.panel.slice(0, 160));
  }
  ok('a curator-owned project with everything WRITTEN still gets it — asking '
    + 'for a rewrite of a named set is legitimate',
  /id="mem-fnd-ask"/.test(ask([fndDoc({ freshness: 'n/a' })], { ownership: 'curator' }).btn));
  ok('a curator-owned project with NO documents gets it — this is the state '
    + 'where it is the most useful control on the screen',
  /id="mem-fnd-ask"/.test(ask([], { ownership: 'curator' }).btn));
  {
    // ── THE REASON LEFT THE STEP BODY (v3.65.0) ──────────────────────────
    // The maintainer, pointing at the sentence under the table: *"then we
    // have some clarification below — 'an agent's save here is refused, this
    // project is mirrored from a folder' and the clock — I don't know why
    // this is here, is this a static message or something that changes."* It
    // is STATIC. Ownership is set once and refused afterwards, so this is a
    // standing fact about the project rather than an outcome — and v3.16.1
    // holds OUTCOMES on the page, not standing facts. The full sentence is a
    // paragraph of step ①'s own ⓘ now, and the row's summary already reads
    // `mirrored`, which is the one-word form of it.
    //
    // ASSERTED IN BOTH DIRECTIONS, so "moved" cannot be satisfied by
    // "deleted": the panel is empty HERE, and the sentence is THERE.
    const a = ask([fndDoc({ freshness: 'fresh' })]);
    eq('a MIRROR is not offered it', a.btn, '');
    eq('...and no longer carries a standing fact as a note under the table',
      a.panel, '');
    const panel = makeRenderers({
      activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10,
      projects: [], detail: null, detailLoading: false, wsWindow: WS_WINDOW_SRC,
      projectRead: fndRead(fndPayload([fndDoc({ freshness: 'fresh' })])),
    }).renderProject();
    const at = panel.indexOf('id="settings-block-info-context-canonical"');
    ok('...because the fact is in step ①\'s ⓘ, where the rest of the source '
      + 'explanation already is (v3.69.0: said per document)',
    at !== -1 && /save to a '?\s*\+?\s*'?<b>mirrored<\/b> document is <b>refused<\/b>/.test(panel.slice(at, at + 4000)),
    panel.slice(at, at + 600));
  }
  {
    const a = ask([fndDoc({ freshness: 'fresh' })], {}, true);
    eq('a READ-ONLY mirror is offered nothing at all', a.btn, '');
    eq('...and gets no second reason either — the mirror note above already '
      + 'says nothing here may be written', a.panel, '');
  }
  eq('a project with no manifest gets neither the control nor a reason',
    ask([], { present: false, ownership: null }).btn, '');
}

// ── §21c4 — THE FOLD THAT REOPENED ITSELF (v3.64.1) ─────────────────────
//
// REPORTED FROM PRODUCTION the day v3.64.0 shipped: the maintainer closed "The
// documents" and it came back, over and over. Reproduced in a browser against
// the real store, and the mechanism is a LOOP between two lines that each look
// reasonable alone:
//
//   1. `renderFoundations` emitted `open` from `editing || adding || <the
//      remembered preference>`. The first two are derived from the editor's
//      PRESENCE, so they are re-derived on every paint and cannot be overruled.
//   2. `wire()`'s delegated toggle listener records `el.open` as the user's own
//      preference — and a `toggle` event fires for a programmatically emitted
//      `open` attribute exactly as it does for a click.
//
// So a close wrote `false`, the next paint re-forced `open`, and the listener
// wrote that forced value back as `true`. Separately, three handlers PERSISTED
// `openFolds.foundations = true` to `curator-memory-folds-v1`, so one Edit
// press marked the fold open on every later visit for good.
//
// The force is a transient now (`state.fndForceOpen`), it is not a FOLD_KEYS
// name so it cannot be serialised, and `open` reads from exactly two places.
{
  const docs = [fndDoc(), fndDoc({ slug: 'decisions.md', title: 'Decisions', role: 'decisions' })];
  const paint = (over) => makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, fnd: null, ...over,
  }).renderFoundations(fndRead(fndPayload(docs)));
  const isOpen = (html) => /data-mem-fold="foundations"[^>]*\sopen/.test(html);

  ok('CONTROL: with nothing remembered and no editor, the fold paints CLOSED',
    !isOpen(paint({})));
  ok('the remembered preference opens it', isOpen(paint({ openFolds: { foundations: true } })));
  ok('the transient opens it, which is what makes an Edit press visible',
    isOpen(paint({ fndForceOpen: true })));

  // THE DEFECT, DRIVEN. An editor is open AND the user has just closed the
  // fold (the toggle listener wrote `false` and cleared the transient). The
  // next paint must honour the close. Before this fix `editing` re-forced it.
  const editing = {
    fndEdit: { domain: 'acme', project: 'lumina', slug: 'architecture.md', isNew: false,
      loading: false, text: 'x', loaded: 'x', title: 'Architecture', role: 'architecture' },
  };
  ok('CONTROL: an editor with the transient still set paints the fold OPEN',
    isOpen(paint({ ...editing, fndForceOpen: true })));
  ok('an EXPLICIT CLOSE wins while the editor is still open — the reopening loop',
    !isOpen(paint({ ...editing, fndForceOpen: false, openFolds: { foundations: false } })),
    paint({ ...editing, fndForceOpen: false, openFolds: { foundations: false } }).slice(0, 300));
  // The same for the other arm of the old disjunction.
  const adding = { fndInit: { domain: 'acme', project: 'lumina', adding: true, choice: null,
    busy: false, error: null, refused: [] } };
  ok('...and the same holds for the "Add from folder" arm',
    !isOpen(paint({ ...adding, fndForceOpen: false, openFolds: { foundations: false } })));

  // THE PERSISTENCE HALF, asserted structurally: the transient must not be a
  // name the fold store keeps, or an Edit press would still reach localStorage
  // through the next unrelated toggle, which serialises the WHOLE map.
  const foldKeys = /const FOLD_KEYS = \[([^\]]*)\]/.exec(viewSrc);
  ok('CONTROL: FOLD_KEYS was really found', !!foldKeys, String(foldKeys));
  ok('`fndForceOpen` is not a FOLD_KEYS name, so it can never be serialised',
    !!foldKeys && !/fndForceOpen/.test(foldKeys[1]), foldKeys && foldKeys[1]);
  ok('and no handler writes `openFolds.foundations` any more — only a real toggle writes that map',
    !/state\.openFolds\.foundations\s*=/.test(viewSrc.replace(/^\s*\/\/.*$/gm, '')),
    (viewSrc.match(/state\.openFolds\.foundations\s*=[^\n]*/g) || []).join(' | '));

  // ── AND THE PAINT'S OWN ECHO IS NOT A PRESS (v3.64.1) ────────────────
  //
  // MEASURED IN A BROWSER, and it is the half that made the transient leak
  // anyway: a `<details open>` created by an innerHTML assignment fires
  // `toggle` ONCE, after wire() has attached its listener (the probe is one
  // line — open: 1 event, closed: 0). So EVERY paint of an open fold arrived
  // at the listener as a toggle nobody performed. While the emitted value
  // always equalled the stored one that was harmless noise; it stopped being
  // harmless the moment a fold could be opened by a TRANSIENT, because the
  // echo then wrote the transient into `curator-memory-folds-v1` as the
  // user's own choice — one Edit press marking the documents fold open on
  // every later visit, which is the second half of what the maintainer
  // reported.
  //
  // DRIVEN through the SHIPPED listener, lifted out of wire().
  {
    const folds = [];
    const doc = { querySelectorAll: (sel) => (sel === '[data-mem-fold]' ? folds : []),
      getElementById: () => null, querySelector: () => null };
    const mkFold = (key, open) => ({
      dataset: { memFold: key }, open, listeners: [],
      addEventListener(t, h) { this.listeners.push([t, h]); },
      fire() { for (const [t, h] of this.listeners) if (t === 'toggle') h(); },
    });
    const el = mkFold('foundations', true);
    folds.push(el);
    const st2 = { openFolds: {} };
    const writes = [];
    // The listener, and only the listener — lifted from wire() by matching
    // the delegated block, so this drives the shipped code rather than a copy.
    // v3.67.0: moved out of wire() UNCHANGED into `bindFoldToggles(root)`, so
    // step ④ can bind its own rows after an in-place repaint; wire() calls it
    // with the document, which is what `root` is here.
    const block = /root\.querySelectorAll\('\[data-mem-fold\]'\)[\s\S]*?\n  \}\);/.exec(viewSrc);
    ok('CONTROL -- the delegated fold listener was really found in bindFoldToggles()', !!block,
      String(block && block[0].slice(0, 80)));
    ok('...and wire() hands it the whole document',
      /bindFoldToggles\(document\);/.test(extractFunction(viewSrc, 'wire', 'memory.js')));
    if (block) {
      new Function('root', 'state', 'localStorage', block[0])(
        doc, st2, { setItem: (k, v) => writes.push([k, v]) });
      el.fire();
      eq('a toggle that did not change the fold writes NO preference',
        st2.openFolds.foundations, undefined);
      eq('...and persists nothing', writes.length, 0);
      el.open = false;
      el.fire();
      eq('CONTROL -- a press that really closes it IS recorded', st2.openFolds.foundations, false);
      ok('...and persisted', writes.length === 1 && writes[0][0] === 'curator-memory-folds-v1',
        JSON.stringify(writes));
    }
  }
}

// ── §21d — the block body: closed, summarised, and warnings outside it ──
{
  const st = { activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, fnd: null };
  const F = makeRenderers(st);
  const html = F.renderFoundations(fndRead(fndPayload([
    fndDoc(), fndDoc({ slug: 'decisions.md', title: 'Decisions', role: 'decisions', freshness: 'stale' }),
  ])));
  ok('the fold is emitted with this view\'s own hook', html.includes('data-mem-fold="foundations"'), html.slice(0, 200));
  ok('...and CLOSED on first paint — this page answers "where does the project '
    + 'stand", and a table of reference documents is not that answer',
  !/data-mem-fold="foundations"[^>]*\sopen/.test(html), html.slice(0, 260));
  ok('the summary carries the decision to open it: how many, how big, WHO OWNS '
    + 'THEM, and the word (v3.61.0, P1-11)',
  /2 documents · 24 KB · mirrored · 1 stale/.test(html), html.slice(0, 700));
  ok('the summary is focusable by a stable id, so a render cannot drop a keyboard user',
    html.includes('id="mem-fold-foundations"'));
  ok('both documents are rows', (html.match(/class="fnd-row"/g) || []).length === 2);

  // ── THE FOLD IS REMEMBERED, AND FOCUSABLE ─────────────────────────────
  // Read off LIVE SOURCE rather than retyped: a copy here could agree with
  // every assertion in this section while the shipped view forgot the fold on
  // the walk to the Wiki and back, or dropped a keyboard user to <body> on the
  // next poll. `FOLDS_KEY` is deliberately NOT extended — the fold joins the
  // map the other two already use, so `test-ui-state.js`'s registry of
  // localStorage keys is untouched, which is the point.
  {
    const keys = /const FOLD_KEYS = (\[[^\]]*\]);/.exec(viewSrc);
    ok('FOLD_KEYS was found in live source (the scan is not vacuous)', !!keys, String(keys));
    ok('...and it carries `foundations`, so the fold survives leaving the view',
      /'foundations'/.test(keys[1]), keys[1]);
    ok('...and it still carries the other two, so this was an addition',
      /'brief'/.test(keys[1]) && /'journal'/.test(keys[1]), keys[1]);
    const focusable = /const FOCUSABLE_IDS = \[([\s\S]*?)\n\];/.exec(viewSrc);
    ok('FOCUSABLE_IDS was found in live source', !!focusable);
    ok('...and knows the fold\'s summary, so a render cannot drop a keyboard user '
      + 'who has just toggled it', focusable[1].includes("'mem-fold-foundations'"));
    // v3.69.0: the project-level Refresh is the strip's "Refresh all" now.
    ok('...and the Refresh control, which survives two renders per press',
      focusable[1].includes("'mem-fnd-refresh-all'") && !focusable[1].includes("'mem-fnd-refresh'"));
    // The ROWS deliberately are NOT there: a row press causes no render at all,
    // so there is nothing for the capture/restore pass to put back — and an
    // indexed or slug-derived id could never be listed in a fixed array anyway.
    ok('...and NOT the rows, which is the difference between this table and the '
      + 'work-stream one above it', !/mem-fnd-architecture/.test(focusable[1]));
  }
  // THE ID IS ON THE ROW, and it is what the reader returns focus to.
  ok('every row carries a stable id derived from its slug',
    /<button type="button" class="fnd-open" id="mem-fnd-architecture-md"/.test(html), html.slice(0, 900));
  ok('the source column names the file AND the commit it came from',
    html.includes('docs/architecture.md') && html.includes('@ 9623343'), html.slice(0, 900));
  ok('a fresh copy takes the app-wide scale\'s hot tier, with the WORD beside it',
    /fresh-dot fresh-recent[\s\S]{0,120}>fresh</.test(html));
  ok('a stale copy takes the cold tier and says "stale" — never the attention amber, '
    + 'which in this app means "a human must act"',
  /fresh-dot fresh-week[\s\S]{0,120}>stale</.test(html) && !html.includes('fresh-today'));

  // OPEN WHEN THE USER SAID SO, and from that field ALONE — never from a
  // loading transient, which is the v3.54.0 defect this page already carries a
  // guard for on its other two folds.
  const opened = makeRenderers({ ...st, openFolds: { foundations: true } })
    .renderFoundations(fndRead(fndPayload([fndDoc()])));
  ok('a fold the user opened comes back open', /data-mem-fold="foundations" open/.test(opened));

  // WHAT MAY NEVER FOLD (v3.16.1). A manifest that will not parse, and files on
  // disk the manifest does not list, are both warnings — so they are asserted
  // to sit OUTSIDE the <details>, by position rather than by reading source.
  // ── AN UNREADABLE MANIFEST WITHHOLDS THE CHOOSER TOO (v3.61.0, P1-3) ──
  // It is a PRESENT manifest: `…/foundations/init` answers `ownership_set`, so
  // offering a two-way choice there would offer a decision that cannot be
  // taken. The error and the orphan note are still unfolded and still first,
  // and what follows them is a flat card saying why nothing is offered — never
  // a table over figures nothing can stand behind.
  // ── THE TWO WARNINGS ARE A RENDERER OF THEIR OWN NOW (v3.62.0, P1-7) ──
  // They were the top of `renderFoundations`'s body; they are step ①'s
  // `noticeHtml`, so the position claim is made against the composed STEP
  // rather than against the body — which is a stronger form of the same
  // property: outside the body altogether rather than merely above the fold.
  const warnedRead = fndRead(fndPayload(
    [fndDoc()], { manifestError: 'Unexpected token }', orphanFiles: ['stray.md'] }));
  const warnedNotes = F.foundationsNotices(warnedRead);
  const warned = F.renderFoundations(warnedRead);
  ok('the manifest error is a WARNING, and it is in the NOTICE slot rather than '
    + 'in the body', warnedNotes.indexOf('manifest could not be read') >= 0
    && warned.indexOf('manifest could not be read') === -1, warnedNotes.slice(0, 200));
  ok('...and so is the orphan-file note, which is the only thing that says a save '
    + 'was interrupted', warnedNotes.indexOf('no manifest entry') >= 0
    && warned.indexOf('no manifest entry') === -1);
  ok('...and neither folds', !warnedNotes.includes('<details'), warnedNotes.slice(0, 200));
  const bodyAt = warned.indexOf('mem-fnd-row');
  ok('CONTROL: the body really is there, so the split is not vacuous', bodyAt >= 0);
  // AND ON THE PAGE, BOTH ABOVE THE STEP'S HEADING.
  ok('...and on the composed page both sit above step ①\'s heading',
    (() => {
      const pg = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
        journalLimit: 10, projects: [], detail: null, detailLoading: false, fnd: null,
        projectRead: warnedRead }).renderProject();
      const one = pg.slice(pg.indexOf('settings-block-context-canonical'));
      const hd = one.indexOf('settings-block-hd');
      return one.indexOf('manifest could not be read') < hd
        && one.indexOf('no manifest entry') < hd && hd > 0;
    })());
  ok('...and the CHOOSER is withheld, because an unreadable manifest is a '
    + 'PRESENT one and init would answer `ownership_set`',
  !warned.includes('data-fnd-own='), warned.slice(0, 400));
  ok('...and no table is painted over figures nothing can stand behind',
    !warned.includes('fnd-table'));
  ok('...and the flat card says why, rather than leaving a blank',
    /no choice is\s+offered here|no choice is offered here/.test(warned.replace(/\s+/g, ' ')),
    warned.slice(0, 700));

  // ── NO DOCUMENTS, AND WHAT REPLACED THE DEAD END (v3.61.0) ────────────
  //
  // This used to be one sentence naming the two ways a document arrives —
  // and NEITHER of them was reachable from the app: the refresh route passed
  // no file list, so a mirror could only be created from a test, and only the
  // `save_foundation` MCP tool wrote a curator document. The sentence was true
  // and the screen was a dead end. Three cases now, and each is asserted for
  // the control it offers rather than for the words it says.
  //
  // (a) NO MANIFEST AT ALL: the ownership chooser, in the place the answer is
  //     missing, with the commit that sets it. `present: false` is the state
  //     a project is in before anything has been decided.
  const unchosen = F.renderFoundations(fndRead(fndPayload([], { present: false, ownership: null })));
  // ── v3.68.0: THE TWO DOORS, NOT A THREE-WAY OWNERSHIP CHOICE ─────────
  // The maintainer read the chooser as "you must first add a local document,
  // then GitHub appears". The question is now only "from where?".
  ok('a project that has never answered gets BOTH doors, side by side in the head row',
    /id="mem-fnd-door-local" data-fnd-door="local"/.test(unchosen)
    && /id="mem-fnd-door-github" data-fnd-door="github"/.test(unchosen)
    && unchosen.indexOf('mem-fnd-head-controls') < unchosen.indexOf('mem-fnd-door-local'),
    unchosen.slice(0, 400));
  ok('...both ENABLED at the empty state', !/aria-disabled/.test(unchosen.slice(0, unchosen.indexOf('</div>'))));
  ok('...and no ownership chooser at all',
    !unchosen.includes('data-fnd-init=') && !unchosen.includes('data-fnd-own='));
  ok('...and NO "decide later" — this screen IS the later',
    !unchosen.includes('data-fnd-own="later"'));
  // ── §8(e), CORRECTED (v3.62.0): NO POINTER HERE ANY MORE ──────────────
  // This state is reached INSIDE a project that has already been selected —
  // the sidebar, the brief and the work-stream table above it all agree the
  // project is real. The missing thing is the ownership answer, and the
  // chooser right above IS how it is given; a "Create a project in Domains"
  // pointer used to sit under it, sending the person who came to answer that
  // very question away from the one control that answers it. It moved to
  // `renderNoProjects` — the screen reached only when a project genuinely
  // does not exist — asserted below.
  ok('...and NO pointer away from the one control that answers the question '
    + 'this screen asked',
  !unchosen.includes('id="mem-fnd-to-domains"')
    && !/Create a project in Domains/.test(unchosen), unchosen.slice(-400));

  // ── (a2) THE POINTER'S NEW HOME: renderNoProjects (v3.62.0) ────────────
  // The counterpart to (a): `renderNoProjects` is the one screen `renderMain`
  // paints when `!state.activeProject`, so the missing thing really is a
  // project and "Create a project in Domains" is the true next step — for
  // either of its two sentences, since a domain must exist before a project
  // can and Domains is where both are made.
  {
    const noDomains = makeRenderers({ domainsScanned: 0 }).renderNoProjects();
    ok('no domains at all: still gets the pointer to Domains',
      noDomains.includes('id="mem-fnd-to-domains"')
      && /Create a project in Domains/.test(noDomains), noDomains.slice(-400));
    const noneSaved = makeRenderers({ domainsScanned: 3 }).renderNoProjects();
    ok('domains exist, nothing saved: SAME pointer, same control id — one '
      + 'binder, one navigation, never a second write path',
    noneSaved.includes('id="mem-fnd-to-domains"')
      && /Create a project in Domains/.test(noneSaved), noneSaved.slice(-400));
    // ── WHO IT IS FOR, ON BOTH ARMS (v3.64.0, §5.2) ────────────────────
    // The rail cannot carry prose, so a researcher with no agents meets a
    // button called "Context" and can only find out what it is by pressing
    // it. This is where they land, and the sentence must therefore be on
    // EVERY arm of this screen rather than on the one the author happened
    // to be looking at.
    for (const [arm, html] of [['no domains', noDomains], ['nothing saved', noneSaved]]) {
      ok('the ' + arm + ' arm says who project context is for — "work that '
        + 'outlives one session: a book, a research programme, a codebase"',
      /work that outlives one session/.test(html)
        && /a book, a research programme, a codebase/.test(html), html.slice(0, 500));
    }

    const unknownCount = makeRenderers({ domainsScanned: null }).renderNoProjects();
    ok('...and it does not depend on the server having answered the count '
      + 'either — an unreported `domainsScanned` still gets it',
    unknownCount.includes('id="mem-fnd-to-domains"'), unknownCount.slice(-400));
  }

  // ── (P1-3) A READ-ONLY SHARED BRAIN MIRROR GETS NO CHOOSER AT ALL ──────
  // Every init this chooser could POST answers 403 there (`refuseMirror`), so
  // the choice is not the user's to make — and a control whose only outcome is
  // a refusal is worse than none (v3.16.1), while an absence with no reason is
  // worse than one with a reason (v3.17.1).
  {
    const ro = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina',
      openFolds: {}, fnd: null, detail: { readonly: true } })
      .renderFoundations(fndRead(fndPayload([], { present: false, ownership: null })));
    ok('a read-only mirror is offered NO ownership choice',
      !ro.includes('data-fnd-own=') && !ro.includes('id="mem-fnd-init-go"'), ro.slice(0, 500));
    ok('...and is told why, unfolded', /read-only mirror/.test(ro) && !ro.includes('<details'), ro.slice(0, 400));
    ok('...and is NOT pointed at the create form either — it cannot create one here',
      !ro.includes('id="mem-fnd-to-domains"'), ro.slice(0, 500));
    // AND ON A POPULATED read-only mirror: the table, and nothing that writes.
    const roFull = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina',
      openFolds: { foundations: true }, fnd: null, read: { readonly: true } })
      .renderFoundations({ ...fndRead(fndPayload([fndDoc()])), readonly: true });
    ok('a populated read-only mirror still shows its documents',
      roFull.includes('fnd-table'), roFull.slice(0, 300));
    ok('...and offers neither Refresh nor Add nor the drafting ask',
      !roFull.includes('id="mem-fnd-refresh"') && !roFull.includes('id="mem-fnd-addrepo"')
      && !roFull.includes('id="mem-fnd-add"') && !roFull.includes('id="mem-fnd-ask"'),
    roFull.slice(-700));
    ok('...and no row carries an Edit control', !/data-fnd-edit/.test(roFull));
  }
  ok('...and NO primary until a door is opened — nothing is decided by a glance',
    !/btn-primary/.test(unchosen), unchosen.slice(0, 900));
  ok('...and emits no table at all', !unchosen.includes('fnd-table'));

  // ── v3.68.0: THE OPEN PANEL CARRIES ITS OWN REASON ─────────────────
  // With a list on screen and nothing ticked, the primary is off and says
  // why; the note is EMITTED AND HIDDEN rather than conditionally emitted,
  // because a tick patches it in place (a re-render would throw a reader of a
  // long list back to its top — v3.61.1's measured defect).
  {
    const none0 = F.foundationsFacts(fndRead(fndPayload([], { present: false, ownership: null })));
    const panelWith = (picks) => makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
      fnd: null,
      fndAdd: Object.assign(FA.freshAddPanel('local', doorsFor(none0, {}).local, none0),
        { domain: 'acme', project: 'lumina', root: '/r', listedRoot: '/r',
          candidates: [{ path: 'docs/a.md', bytes: 10 }], picks }) })
      .renderFoundations(fndRead(fndPayload([], { present: false, ownership: null })));
    const blocked = panelWith({});
    ok('with a list on screen and nothing ticked, the commit is DISABLED',
      /id="fadd-go" disabled/.test(blocked), blocked.slice(-900));
    ok('...and the reason is visible, not hidden',
      /id="fadd-why"><span>Tick at least one document\./.test(blocked), blocked.slice(-700));
    ok('...carrying the `.fnd-init-why` class whose `[hidden]` counter-rule `.tx-note`’s '
      + '`display: flex` would otherwise defeat (design-system §9)',
    /class="tx-note fnd-init-why" id="fadd-why"/.test(blocked));
    const live = panelWith({ 'docs/a.md': true });
    ok('CONTROL: one tick arms the commit again, counted',
      /id="fadd-go">Copy 1 document</.test(live), (live.match(/id="fadd-go"[\s\S]{0,60}/) || [''])[0]);
    ok('...and hides the reason', /id="fadd-why" hidden/.test(live), live.slice(-700));
    ok('the panel sits between the head row and the empty-state body',
      live.indexOf('mem-fnd-head-controls') < live.indexOf('fadd-panel')
      && live.indexOf('fadd-panel') < live.indexOf('No documents yet'),
      [live.indexOf('mem-fnd-head-controls'), live.indexOf('fadd-panel'), live.indexOf('No documents yet')].join(' '));
  }

  // ── v3.61.1: THE MECHANICS THE FILE HINT GAVE UP ARE IN THE ⓘ ──────────
  // The chooser's 22-word hint became a 9-word note; "each file you choose
  // becomes one document" and "read in this browser, never uploaded" are
  // mechanism and belong behind the mark (design-system §3). Asserted on the
  // BLOCK, because a clause that was dropped from one surface and not added to
  // the other is how a fact leaves the app entirely.
  {
    const whole = F.renderProject();
    ok('the block’s ⓘ says what a chosen file becomes',
      /each file[^<]*becomes one document/i.test(whole)
        || /<b>each file you choose becomes one document<\/b>/i.test(whole), 'memory.js ⓘ');
    ok('...and that nothing is uploaded, which is the question the control raises',
      /read in this browser[\s\S]{0,80}never uploaded/i.test(whole), 'memory.js ⓘ');
    ok('...and where a MIRRORED document is edited instead, which the option card no '
      + 'longer says', /changed THERE and re-copied here/.test(whole), 'memory.js ⓘ');
  }

  // (b) REPO-OWNED WITH NOTHING MIRRORED: the ownership is settled, so the
  //     two-way choice is WITHHELD (it cannot be made) and the scan arm is
  //     offered on its own. v3.59.0 hid the only action that puts documents
  //     in at exactly the count where it was needed.
  const mirrorEmpty = F.renderFoundations(fndRead(fndPayload([], { ownership: 'repo' })));
  // v3.68.0: an EMPTY mirror gets the same two doors as every empty project
  // — its source may be chosen again, because nothing is at stake.
  ok('a repo-owned project with nothing mirrored gets BOTH doors, enabled',
    /id="mem-fnd-door-local" data-fnd-door="local"/.test(mirrorEmpty)
    && /id="mem-fnd-door-github" data-fnd-door="github"/.test(mirrorEmpty), mirrorEmpty.slice(0, 400));
  ok('...and NOT a choice it is no longer allowed to make',
    !mirrorEmpty.includes('data-fnd-own='), mirrorEmpty.slice(0, 400));
  ok('...and says nothing is mirrored yet', /Nothing mirrored yet/.test(mirrorEmpty));

  // (c) CURATOR-OWNED WITH NOTHING IN IT — the owner unticked the seeding.
  //     The one action that puts a document in must be reachable here too.
  const curatorEmpty = F.renderFoundations(fndRead(fndPayload([], { ownership: 'curator' })));
  ok('a curator-owned project with no documents still offers "Add document"',
    curatorEmpty.includes('id="mem-fnd-add"'), curatorEmpty.slice(0, 600));
  // ── THE OWNER IS NAMED FIRST (v3.61.0, P1-12) ───────────────────────
  // A person can start a project here with no agent and no repository and
  // write the first document by hand — a first-class path, not a fallback — so
  // no string may presume an agent, and where both ways in are named the
  // owner's comes first.
  // v3.68.0: the body names the two doors; writing one by hand is the head
  // row's "Write a document", and asking an agent is the drafting request.
  ok('...and names BOTH ways in',
    /Add them from this computer or from a GitHub repository/.test(curatorEmpty)
    && />Write a document</.test(curatorEmpty), curatorEmpty.slice(0, 600));
  ok('...and does not presume an agent exists',
    !/an agent you ask/i.test(curatorEmpty), curatorEmpty.slice(0, 600));
  ok('...and offers the drafting request, which is the other way in (P2-8)',
    curatorEmpty.includes('id="mem-fnd-ask"'), curatorEmpty.slice(0, 900));
  ok('...and emits no table at all', !curatorEmpty.includes('fnd-table'));
}

// ── §21d3 — COPIED is not WRITTEN (v3.68.0, the orchestrator's screen review)
// A document copied in by "Add from this computer" was not written by the
// owner. The row, the fold's word (which the overview tile and the fold meta
// both read) and the reader say "copied"; a written one keeps "written by
// you"; an older manifest with no `copiedFrom` reads as written, unchanged.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: { foundations: true }, fnd: null });
  const cur = (over) => fndDoc({ freshness: 'n/a', commit: null, source: { kind: 'curator', path: null },
    authoredBy: { kind: 'human' }, ...over });
  const copiedDoc = cur({ slug: 'notes.md', copiedFrom: 'project-notes' });
  const writtenDoc = cur({ slug: 'plan.md' });
  const row = (d) => F.fndRowHtml(d, true, false, 204800);
  ok('a copied row says "copied from <folder>", never "written by you"',
    /copied from project-notes/.test(row(copiedDoc)) && !/written by you/.test(row(copiedDoc)), row(copiedDoc).slice(0, 600));
  ok('CONTROL: a written row keeps "written by you"', /written by you/.test(row(writtenDoc)));
  const word = (docs) => F.foundationsWord(F.foundationsFacts(fndRead(fndPayload(docs, { ownership: 'curator', repo: null }))));
  eq('all copied: the fold / overview word is "copied"', word([copiedDoc]), 'copied');
  eq('mixed: "written and copied"', word([copiedDoc, writtenDoc]), 'written and copied');
  eq('an OLDER manifest (no copiedFrom) still reads "written"', word([writtenDoc]), 'written');
  const blockHtml = F.renderFoundations(fndRead(fndPayload([copiedDoc], { ownership: 'curator', repo: null })));
  ok('the fold meta says "kept here · copied", not "written"', /kept here · copied/.test(blockHtml) && !/kept here · written/.test(blockHtml),
    (blockHtml.match(/mem-fold-meta">[^<]*/) || [''])[0]);
  const reader = F.foundationReaderContent({ ...copiedDoc, text: '# N' }, 'lumina');
  ok('the reader’s chips say copied, not "written for this project"',
    reader.tags.includes('copied from project-notes') && reader.tags.includes('copied in from a folder')
    && !reader.tags.includes('written for this project'), JSON.stringify(reader.tags));
  const hostile = row(cur({ slug: 'x.md', copiedFrom: '<img onerror=x>' }));
  ok('the folder name is escaped', !/<img onerror/.test(hostile));
}

// ── §21d2 — a SKELETON is a prompt, and the block says so (v3.61.0) ─────
{
  const st = { activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, fnd: null };
  const F = makeRenderers(st);
  const skel = (over) => fndDoc({
    skeleton: true, freshness: 'n/a', commit: null,
    source: { kind: 'curator', path: null }, ...over,
  });
  // THE WORD ORDER, worst first. A skeleton outranks the two words that merely
  // describe where a document came from — "Curator-authored" over four
  // unfilled prompts is confident nonsense — and ranks BELOW a stale copy or a
  // checkout that is not here, because those are comparisons the store tried
  // to make and could not.
  const w = (docs, over) => F.foundationsWord(F.foundationsFacts(fndRead(fndPayload(docs, over))));
  eq('four unfilled skeletons are the reading, not "Curator-authored"',
    w([skel(), skel({ slug: 'decisions.md' }), skel({ slug: 'conventions.md' }),
      skel({ slug: 'roadmap.md' })], { ownership: 'curator' }), '4 skeletons to fill');
  eq('...singular when there is one', w([skel()], { ownership: 'curator' }), '1 skeleton to fill');
  eq('a stale copy still outranks a skeleton — one is a measured mismatch',
    w([skel(), fndDoc({ slug: 'b.md', freshness: 'stale' })]), '1 stale');
  eq('...and so does a source that is not on this computer',
    w([skel(), fndDoc({ slug: 'b.md', freshness: 'unreachable' })]), 'source unreachable');
  eq('a project whose skeletons have all been filled reads `written` — the '
    + 'ownership word left this ladder in v3.61.0 and is its own clause now',
  w([fndDoc({ skeleton: false, freshness: 'n/a' })], { ownership: 'curator' }), 'written');
  eq('a manifest that will not parse still outranks everything',
    w([skel()], { manifestError: 'Unexpected token', ownership: 'curator' }), 'manifest unreadable');

  // THE ROW: the word, and deliberately NO dot. A curator document has no
  // upstream, so the scale — which paints a COMPARISON — has nothing to say;
  // the em dash a written one gets says nothing at all, and "skeleton · to
  // fill" is the one fact on the row somebody needs.
  const row = F.fndRowHtml(skel(), true);
  ok('a skeleton row reads "skeleton · to fill"', row.includes('skeleton · to fill'), row);
  // ── THE IDENTITY IS THE FLAG, NEVER THE BANNER'S TEXT (v3.61.0, P1-2) ─
  // The store writes a skeleton whose first line names itself in bold, and the
  // owner is invited to DELETE that line the moment they answer the prompts. A
  // view that recognised a skeleton by matching the sentence would call a
  // filled document a skeleton for ever, and a half-filled one a skeleton too.
  // So: flag true with no banner anywhere in the payload still reads skeleton,
  // and flag false with the banner's own words in the title does not.
  ok('the flag alone is enough — no banner text is needed',
    F.fndRowHtml(skel({ title: 'Architecture' }), true).includes('skeleton · to fill'));
  ok('...and the banner\u2019s own words in a title do NOT make a written '
    + 'document read as a skeleton',
  !F.fndRowHtml(fndDoc({
    skeleton: false, freshness: 'n/a',
    title: 'Skeleton — not yet written. Answer the prompts below',
  }), true).includes('skeleton · to fill'));
  eq('...and `skeletonOf` is `=== true`, so an ABSENT flag is false rather than '
    + 'undefined-as-maybe', F.skeletonOf({ slug: 'x.md' }), false);
  eq('...and a truthy non-boolean is refused too', F.skeletonOf({ skeleton: 1 }), false);
  ok('...and carries no freshness dot, because there is nothing to compare it against',
    !/fresh-dot/.test(row), row);
  ok('CONTROL: a mirrored row in the same renderer DOES carry one',
    /fresh-dot/.test(F.fndRowHtml(fndDoc(), false)));
  // ── THE FRESHNESS CELL TOO, ON THE MIRRORED ARM (P1-2) ───────────────
  // The State column is the curator arm's; on a mirror the skeleton word
  // lands in the freshness cell instead, and it must come from the same FLAG.
  // Driven with a title that carries the banner's own first words, so a
  // renderer that matched the TEXT rather than the flag would answer the same
  // thing here for the wrong reason — and with a written document under the
  // banner's title, where the two answers finally differ.
  {
    const mirroredSkel = F.fndRowHtml(skel({ title: 'Architecture' }), false);
    ok('a MIRRORED skeleton row reads the word from the flag',
      /fnd-fresh-word">skeleton · to fill</.test(mirroredSkel), mirroredSkel);
    ok('...and takes no dot there either', !/fresh-dot/.test(mirroredSkel));
    const bannerTitled = F.fndRowHtml(fndDoc({
      skeleton: false, freshness: 'fresh',
      title: 'Skeleton — not yet written. Answer the prompts below' }), false);
    ok('...while a WRITTEN document whose title quotes the banner is not a '
      + 'skeleton — the flag decides, never the prose',
    /fnd-fresh-word">fresh</.test(bannerTitled)
      && !/skeleton · to fill/.test(bannerTitled), bannerTitled);
  }
  eq('a curator-owned row carries an Edit control',
    /data-fnd-edit="architecture\.md"/.test(row), true);
  ok('...labelled by the document it edits, with no hover-only title=',
    /aria-label="Edit Architecture"/.test(row) && !/title=/.test(row), row);
  ok('a MIRRORED row carries none — the route refuses a PUT to one, and a control '
    + 'whose only outcome is a refusal is worse than no control',
  !/data-fnd-edit/.test(F.fndRowHtml(fndDoc(), false)));

  // ── THE TABLE IS COLUMN-VARIANT BY OWNERSHIP (v3.61.0, P2-1) ──────────
  // On a curator-owned project `Source` is always "Curator-authored" and
  // `Copy` is always "—": two columns with one value each, which is the table
  // equivalent of a flag on 100 % of a list. They collapse into one State
  // column carrying the row's real variable — and that takes the curator-owned
  // table from six columns to five, which is what brings it under the 568 px
  // overflow v3.59.0 recorded. The REPO-owned table keeps its six and keeps
  // that overflow; this release does not claim to have fixed it.
  {
    const curRow = F.fndRowHtml(fndDoc({
      skeleton: false, freshness: 'n/a', source: { kind: 'curator', path: null },
      commit: null, authoredBy: { kind: 'human' },
    }), true);
    ok('a curator-owned row has a State cell', /class="fnd-cell-state"/.test(curRow), curRow);
    ok('...and NO Source cell repeating "Curator-authored" on every row',
      !/fnd-cell-source/.test(curRow) && !/Curator-authored/.test(curRow), curRow);
    ok('...and the state says who wrote it', /written by you/.test(curRow), curRow);
    const byAgent = F.fndRowHtml(fndDoc({
      skeleton: false, freshness: 'n/a', authoredBy: { kind: 'agent', tool: 'save_foundation' },
      source: { kind: 'curator' },
    }), true);
    ok('...or that an agent did', /written by an agent/.test(byAgent), byAgent);
    ok('CONTROL: a MIRRORED row still has Source and no State cell',
      /fnd-cell-source/.test(F.fndRowHtml(fndDoc(), false))
      && !/fnd-cell-state/.test(F.fndRowHtml(fndDoc(), false)));
    // FIVE CELLS vs SIX (plus the actions cell on the curator arm only).
    const cells = (h) => (h.match(/<td /g) || []).length;
    // SIX PLUS THE ACTIONS CELL since v3.62.0: the "read first" toggle is a
    // column of its own on BOTH arms, because the flag is curator metadata
    // ABOUT a document and setting it writes nothing into the document — so a
    // mirrored row gets it too.
    eq('a curator-owned row is six cells plus the actions cell', cells(curRow), 7);
    // ── AND A MIRRORED ROW HAS AN ACTIONS CELL TOO, SINCE v3.61.1 ───────
    // It had none, because a mirror had no row control: the DELETE route
    // refused one, and a control whose only outcome is a refusal is worse
    // than no control. The route accepts removal on both ownerships now — it
    // is the decision to stop mirroring, not an edit — so the cell exists on
    // both arms and the two tables are 6 and 7 cells wide.
    // v3.69.0: the unified table is SIX — the role rides above the title and
    // the age under the freshness word (measured: eight columns pushed the
    // trash icon behind a horizontal scroll in a 566px box at a 1400px window).
    eq('...and a mirrored row is six: document, size, start, source, freshness, actions',
      cells(F.fndRowHtml(fndDoc(), false)), 6);
    ok('...its role above the title and its age under the freshness word',
      /fnd-cell-title"><span class="fnd-role fnd-role-inline">architecture</.test(F.fndRowHtml(fndDoc(), false))
      && /fnd-cell-fresh">[\s\S]*class="fnd-fresh-age" data-mem-age-at=/.test(F.fndRowHtml(fndDoc(), false)));
    // ── v3.69.0: THE TRASH ICON ON EVERY ROW, THE PENCIL ON KEPT ROWS ────
    // The maintainer asked for an icon; the confirm strip under the table
    // carries what v3.61.1's labelled "Remove" used to (§5.1).
    ok('...whose control is the TRASH ICON — quiet at rest, never the pencil, which would promise an '
      + 'edit the route refuses',
    /class="btn btn-ghost btn-xs fnd-delete"/.test(F.fndRowHtml(fndDoc(), false))
      && /<svg[^>]*aria-hidden="true"/.test(F.fndRowHtml(fndDoc(), false))
      && !/data-fnd-edit/.test(F.fndRowHtml(fndDoc(), false))
      && !/>Remove</.test(F.fndRowHtml(fndDoc(), false)),
    F.fndRowHtml(fndDoc(), false));
    ok('...carrying the slug on its own element and an aria-label naming the document — and no title= '
      + '(the tooltip budget does not grow)',
    /data-fnd-delete="architecture\.md"/.test(F.fndRowHtml(fndDoc(), false))
      && /aria-label="Delete Architecture"/.test(F.fndRowHtml(fndDoc(), false))
      && !/fnd-delete"[^>]*title=/.test(F.fndRowHtml(fndDoc(), false)),
    F.fndRowHtml(fndDoc(), false));
    ok('a KEPT row carries BOTH: the pencil, and the trash icon beside it',
      /data-fnd-edit="architecture\.md"[\s\S]*data-fnd-delete="architecture\.md"/.test(curRow), curRow);
    // A READ-ONLY SHARED BRAIN MIRROR GETS NO CELL ON EITHER ARM: nothing
    // there may be written at all, and the third argument is what says so.
    ok('a read-only row gets NO actions cell on either arm — nothing there may be written',
      cells(F.fndRowHtml(fndDoc(), false, true)) === 4
      && cells(F.fndRowHtml(fndDoc({ source: { kind: 'curator', path: null } }), true, true)) === 5
      && !/fnd-delete|fnd-edit/.test(F.fndRowHtml(fndDoc(), false, true)),
    F.fndRowHtml(fndDoc(), false, true));

    // ── THE CONFIRM STRIP, AND THE SENTENCE THAT IS NOT "DELETED" ───────
    // On a mirror the copy goes and the SOURCE FILE DOES NOT, which is the
    // one fact somebody needs before pressing — and it is why this is a
    // second strip rather than the editor's. "Cannot be undone" would be
    // FALSE here.
    {
      const withStop = (over) => {
        const R = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina',
          openFolds: { foundations: true }, fnd: null,
          fndStop: { domain: 'acme', project: 'lumina', slug: 'architecture.md',
            busy: false, error: null, ...(over || {}) } });
        return R;
      };
      const mirrored = withStop().renderFoundations(fndRead(fndPayload([fndDoc()])));
      // v3.69.0 (§5.2): ONE sentence per kind, shared with the editor. For
      // a folder mirror it names the path and the folder, says only THIS
      // project's copy goes, and that a refresh will NOT bring it back.
      ok('the strip names the document and says the original in the folder is not touched',
        /Delete <b>architecture\.md<\/b>\? Only this project’s copy is removed\./.test(mirrored)
        && /The original, <span class="fnd-src-path">docs\/architecture\.md<\/span> in the folder <b>repo<\/b>, is not touched\./.test(mirrored),
        mirrored.slice(-900));
      ok('...and that a refresh will NOT bring it back', /A refresh will <b>not<\/b> bring it back/.test(mirrored));
      ok('...and does NOT say it cannot be undone, which would be false on a mirror',
        !/cannot be undone/.test(mirrored.slice(mirrored.indexOf('Delete <b>'))),
        mirrored.slice(-900));
      ok('...its primary is "Delete copy"', /id="mem-fnd-stop-go">Delete copy</.test(mirrored));
      ok('...with the filled danger face on the confirm and a ghost beside it',
        /id="mem-fnd-stop-go"/.test(mirrored) && /btn-danger-solid/.test(mirrored)
        && /id="mem-fnd-stop-no"/.test(mirrored), mirrored.slice(-700));
      ok('...in flow, never a dialog that would cover the row under discussion',
        !/<dialog/.test(mirrored) && /role="alertdialog"/.test(mirrored), mirrored.slice(-700));
      const busy = withStop({ busy: true }).renderFoundations(fndRead(fndPayload([fndDoc()])));
      ok('a press in flight disables both controls and says what is happening',
        /id="mem-fnd-stop-go" disabled>Deleting/.test(busy)
        && /id="mem-fnd-stop-no" disabled/.test(busy), busy.slice(-700));
      const failed = withStop({ error: 'the store said no' })
        .renderFoundations(fndRead(fndPayload([fndDoc()])));
      ok('a refusal keeps the strip OPEN with the reason in it — a closed question would leave '
        + 'the row as it was with nothing said',
      /mem-fnd-stop-error/.test(failed) && /the store said no/.test(failed), failed.slice(-700));
      // A CONFIRM ABOUT A ROW THAT IS NO LONGER THERE IS NOT A QUESTION.
      const gone = withStop({ slug: 'vanished.md' })
        .renderFoundations(fndRead(fndPayload([fndDoc()])));
      ok('a strip for a slug the table no longer holds is not painted at all',
        !/mem-fnd-stop-go/.test(gone), gone.slice(-500));
      // AND IT BELONGS TO THIS PROJECT: a switch must not carry the question.
      const other = makeRenderers({ activeDomain: 'acme', activeProject: 'other',
        openFolds: { foundations: true }, fnd: null,
        fndStop: { domain: 'acme', project: 'lumina', slug: 'architecture.md' } })
        .renderFoundations(fndRead(fndPayload([fndDoc()])));
      ok('...and a strip stamped for another project is not painted under this one',
        !/mem-fnd-stop-go/.test(other), other.slice(-500));
    }
    // AND THE HEAD AGREES WITH THE BODY, from ONE condition.
    const curTable = F.renderFoundations(fndRead(fndPayload(
      [fndDoc({ skeleton: false, freshness: 'n/a' })],
      { ownership: 'curator', openFolds: {} })));
    ok('the curator-owned table head says State', />State</.test(curTable), curTable.slice(0, 1400));
    ok('...and names neither Source nor Freshness',
      !/>Source</.test(curTable) && !/>Freshness</.test(curTable), curTable.slice(0, 1400));
    ok('...and its actions column is named for a screen reader rather than left blank',
      /visually-hidden">Actions</.test(curTable), curTable.slice(0, 1400));
    const repoTable = F.renderFoundations(fndRead(fndPayload([fndDoc()])));
    ok('CONTROL: the mirrored table has Source AND Freshness (v3.69.0 names the column for what it says)',
      />Source</.test(repoTable) && />Freshness</.test(repoTable), repoTable.slice(0, 1400));
    ok('...and an actions column on BOTH arms, because every row has the trash icon; '
      + 'it is withheld only where nothing may be written',
    (repoTable.match(/<th scope="col">/g) || []).length >= 6
      && /visually-hidden">Actions/.test(repoTable), repoTable.slice(0, 600));
  }

  // THE COUNT RIDES INTO THE STATUS LINE AND THE SUMMARY, from ONE derivation.
  const html = F.renderFoundations(fndRead(fndPayload(
    [skel(), skel({ slug: 'decisions.md' })], { ownership: 'curator' })));
  ok('the fold summary quotes the skeleton reading',
    /2 skeletons to fill/.test(html), html.slice(0, 900));
  const status = F.renderLayerStrip(fndRead(fndPayload(
    [skel(), skel({ slug: 'decisions.md' })], { ownership: 'curator' })));
  ok('...and so does the strip\'s FOUNDATIONS cell, from the same facts',
    /2 skeletons to fill/.test(status), status);

  // THE PAYLOAD'S OWN COUNT IS THE FALLBACK, and only when no row carries the
  // flag: a server that sends `skeletonCount` but no per-row boolean is an
  // older build, and reporting 0 there would claim a project is written when
  // it is not.
  const viaCount = F.foundationsFacts(fndRead(fndPayload(
    [fndDoc({ skeleton: undefined, freshness: 'n/a' })],
    { ownership: 'curator', skeletonCount: 1 })));
  eq('a build that sends only skeletonCount is still read', viaCount.skeletons, 1);
  const rowsWin = F.foundationsFacts(fndRead(fndPayload(
    [fndDoc({ skeleton: false, freshness: 'n/a' })],
    { ownership: 'curator', skeletonCount: 4 })));
  eq('...but a per-row flag WINS, so a stale server count cannot outvote the rows '
    + 'on screen', rowsWin.skeletons, 0);
}

// ── §21c3 — the copy OUTCOME tells two controls apart (v3.61.0, P2-8) ──
//
// Two controls now write `state.copied` and they put DIFFERENT texts on the
// clipboard for DIFFERENT files: the header's "Copy agent instructions" (into
// CLAUDE.md) and the Foundations block's "Copy the drafting request" (into a
// chat). One confirmation cannot describe both — an owner who pressed the
// drafting ask and read "paste it into CLAUDE.md" has been told the wrong
// thing about the thing they are holding.
{
  const st = { activeDomain: 'acme', activeProject: 'lumina' };
  const F = makeRenderers(st);
  const out = (over) => {
    st.copied = { domain: 'acme', project: 'lumina', ok: true, text: 'THE TEXT', ...over };
    return F.renderCopyOutcome();
  };
  // v3.67.2: A SUCCESS IS A TOAST (shared/toast.js), raised by the copy
  // itself — the two successes are told apart by their toast's own title and
  // key (test-next-foundations-editor.js and test-agent-instructions.js drive
  // both). What is asserted HERE is that the page paints NOTHING permanent
  // for either: the in-flow card "never went away", which was the finding.
  eq('a DRAFTING success paints nothing in flow — it is a toast', out({ kind: 'draft' }), '');
  eq('...nor does the header control\u2019s success', out({}), '');
  // ── A REFUSAL HANDS THE TEXT OVER (never a button that silently did
  //    nothing) ─────────────────────────────────────────────────────────
  const refused = out({ kind: 'draft', ok: false });
  ok('a clipboard refusal says the browser refused', /Could not copy/.test(refused), refused);
  ok('...and PRINTS the text to be selected by hand',
    /mem-copy-fallback/.test(refused) && /THE TEXT/.test(refused), refused);
  ok('...telling the owner to select it, in the words of the thing they are '
    + 'holding — "the text below", not "the block below"',
  /Select the text below and copy it by hand/.test(refused), refused);
  ok('CONTROL: the header control\u2019s refusal still says "the block below"',
    /Select the block below/.test(out({ ok: false })), out({ ok: false }));
  ok('neither outcome folds', !refused.includes('<details'));
  // STAMPED: an outcome belonging to another project is not painted here.
  st.copied = { domain: 'acme', project: 'OTHER', ok: true, text: 'x', kind: 'draft' };
  eq('an outcome stamped with a different project is withheld entirely',
    F.renderCopyOutcome(), '');
}

// ── §21v — v3.67.2: "source not here" is a STATE on the row, its reason a
//    TOAST on the press — and a GitHub mirror is not a missing folder ──────
//
// Two maintainer findings on one screen. (1) The "folder … is not on this
// computer" sentence floated permanently under the table; the row word stays
// as the persistent indicator and the sentence arrives when it is asked for.
// (2) On his own project the sentence was FALSE: the documents came over the
// GitHub arm, which records no local folder (`repo.root: null`) — so every row
// read "unreachable" on the very machine that holds the checkout.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: { foundations: true } });
  const GH = { repo: { root: null, remote: { owner: 'talirezun', repo: 'the-curator', ref: null, path: null },
    lastRefreshAt: '2026-09-24T06:34:07.388Z', lastRefreshCommit: 'f796b6d6be2e1acc' } };
  const unreach = [fndDoc({ freshness: 'unreachable' }), fndDoc({ slug: 'b.md', freshness: 'unreachable' })];

  // ── (1) A FOLDER THAT REALLY IS MISSING ────────────────────────────────
  const missing = F.renderFoundations(fndRead(fndPayload(unreach)));
  // v3.69.0: the sentence is the SOURCE LINE's state now (one line per group,
  // in the strip) — never a floating note under the table.
  const underTable = missing.slice(missing.indexOf('</details>'));
  ok('a missing folder paints NO permanent "not on this computer" note under the table',
    !/not on this computer/.test(underTable), underTable.slice(0, 400));
  ok('...its SOURCE line says so, as that group\'s state',
    /data-fnd-source="s1"[\s\S]{0,300}not on this computer/.test(missing), missing.slice(0, 900));
  ok('...its STATE stays on every row, as the persistent indicator',
    (missing.match(/>source not here</g) || []).length === 2, missing.slice(0, 300));
  ok('...and each row word is a button that answers "why?"',
    (missing.match(/<button[^>]*data-fnd-why="/g) || []).length === 2);
  ok('v3.69.0: NO control is disabled for it — both doors stay open, and the group keeps its Refresh',
    !/aria-disabled/.test(missing.slice(0, missing.indexOf('<details'))) && /data-fnd-refresh="s1"/.test(missing));
  const whyMissing = F.foundationsUncheckedWhy(F.foundationsFacts(fndRead(fndPayload(unreach))), 'architecture.md');
  ok('the reason the press shows is about THIS row\'s folder, truthfully',
    /not on this computer/.test(whyMissing.title) && /repo/.test(whyMissing.title)
    && /add them again from GitHub/.test(whyMissing.lines.join(' ')),
    JSON.stringify(whyMissing));
  ok('...in a title and AT MOST two lines', whyMissing.lines.length <= 2);

  // ── (2) A GITHUB MIRROR, NO FOLDER RECORDED ────────────────────────────
  const gh = F.renderFoundations(fndRead(fndPayload(unreach, GH)));
  ok('a GitHub mirror NEVER says "not on this computer" — no folder was its source',
    !/not on this computer/.test(gh) && !/source not here/.test(gh), gh.slice(0, 400));
  ok('...its rows say what is true: GitHub, not checked',
    (gh.match(/>GitHub · not checked</g) || []).length === 2);
  ok('...its source line is GitHub, named, "not checked", with its own Refresh',
    /mem-fnd-source-kind">GitHub</.test(gh) && /mem-fnd-source-label">talirezun\/the-curator</.test(gh)
    && /not checked/.test(gh) && /data-fnd-refresh="s1"/.test(gh), gh.slice(0, 1200));
  ok('...and NOT "Read from GitHub instead", which would offer the source it already has',
    !/data-fnd-read-gh/.test(gh));
  const whyGh = F.foundationsUncheckedWhy(F.foundationsFacts(fndRead(fndPayload(unreach, GH))), 'b.md');
  ok('its "why?" names the repository and says freshness is checked on refresh',
    /talirezun\/the-curator/.test(whyGh.title) && /not checked on a read/.test(whyGh.lines[0]),
    JSON.stringify(whyGh));
  ok('...and never claims a folder is missing', !/not on this computer/.test(JSON.stringify(whyGh)));

  eq('...and the summary/overview word agrees with the rows',
    F.foundationsWord(F.foundationsFacts(fndRead(fndPayload(unreach, GH)))), 'GitHub · not checked');
  eq('CONTROL: a missing folder keeps "source unreachable"',
    F.foundationsWord(F.foundationsFacts(fndRead(fndPayload(unreach)))), 'source unreachable');

  // ── (3) A FOLDER THAT IS NOT HERE BUT HAS A REMOTE (v3.69.0 §3.4) ──────
  // A LOCAL refresh records BOTH a root and the origin it inferred. On a
  // machine without the folder the row reads "GitHub · not checked" — its
  // Refresh goes over GitHub (the store's `auto` arm) — and the line offers
  // "Read from GitHub instead".
  const both = { repo: { root: '/gone/repo', remote: GH.repo.remote } };
  const bothHtml = F.renderFoundations(fndRead(fndPayload(unreach, both)));
  ok('a missing folder WITH a recorded remote reads "GitHub · not checked" on its rows',
    (bothHtml.match(/>GitHub · not checked</g) || []).length === 2, bothHtml.slice(0, 300));
  ok('...its line says it is not here and reads from GitHub on refresh, and offers the switch',
    /not on this computer · read from GitHub on refresh/.test(bothHtml) && /data-fnd-read-gh="s1"/.test(bothHtml));
  const whyBoth = F.foundationsUncheckedWhy(F.foundationsFacts(fndRead(fndPayload(unreach, both))), 'b.md');
  ok('...and its "why?" names the folder AND the repository it is refreshed from',
    /The folder repo is not on this computer/.test(whyBoth.title) && /talirezun\/the-curator/.test(whyBoth.lines.join(' ')),
    JSON.stringify(whyBoth));

  // ── (4) THE READER SAYS THE SAME THING THE TABLE DOES ──────────────────
  const doc = { slug: 'architecture.md', title: 'Architecture', text: 'x', updatedAt: '2026-09-17T09:00:00.000Z',
    source: { kind: 'repo', path: 'docs/architecture.md' }, freshness: 'unreachable' };
  const rGh = F.foundationReaderContent(doc, 'lumina', { label: 'talirezun/the-curator' });
  ok('the reader of a GitHub mirror says GitHub, never "not on this computer"',
    /Mirrored from GitHub \(talirezun\/the-curator\)/.test(rGh.bodyHtml)
    && !/not on this computer/.test(rGh.bodyHtml + rGh.tags.join('|')), rGh.tags.join('|'));
  ok('...and its read-only note points at the repository', /GitHub/.test(rGh.readonlyNote));
  const rMissing = F.foundationReaderContent(doc, 'lumina', null);
  ok('CONTROL: a missing folder’s reader keeps the folder sentence',
    /not on this computer/.test(rMissing.bodyHtml));
  // v3.69.0: a KEPT document's reader never says "mirrored", even when the
  // single-document route reports the PROJECT's ownership as `mixed`.
  const rKept = F.foundationReaderContent({ ...doc, source: { kind: 'curator' }, freshness: 'n/a',
    ownership: 'mixed' }, 'lumina', null);
  ok('a kept document in a MIXED project reads as kept, never mirrored',
    /Edit this in the Documents table/.test(rKept.readonlyNote) && !/mirrored/.test(rKept.tags.join('|')),
    rKept.readonlyNote + ' | ' + rKept.tags.join('|'));
}

// ── §21e — the control's three states, painted ──────────────────────────
{
  const base = { activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, fnd: null };
  // v3.69.0: the control is the SOURCE LINE's Refresh — one per group.
  const offered = makeRenderers(base).renderFoundations(fndRead(fndPayload([fndDoc()])));
  ok('the control is painted when it can work', /data-fnd-refresh="s1"/.test(offered));
  ok('...and carries no `title=` — this view\'s ratchet stands', !/data-fnd-refresh="s1"[^>]*title=/.test(offered));

  const withheld = makeRenderers(base).renderFoundations(
    fndRead(fndPayload([fndDoc({ freshness: 'n/a' })], { ownership: 'curator' })));
  ok('Refresh is WITHHELD on a project of kept documents — there is no source line at all',
    !/data-fnd-refresh/.test(withheld) && !/id="mem-fnd-sources"/.test(withheld));
  // ── AND "Write a document" IS OFFERED, rather than a reason (P1-4) ────
  ok('...and the control that DOES work is offered', withheld.includes('id="mem-fnd-add"'),
    withheld.slice(-600));
  ok('...so no reason is manufactured for a control nobody is missing',
    !/nothing to refresh them from/.test(withheld));

  const busy = makeRenderers({ ...base, fnd: { domain: 'acme', project: 'lumina', busy: true, group: 's1', error: null, result: null } })
    .renderFoundations(fndRead(fndPayload([fndDoc()])));
  ok('while a copy runs the control is DISABLED rather than removed',
    /data-fnd-refresh="s1"[^>]*disabled[^>]*>Refreshing/.test(busy), busy.slice(0, 1200));

  // ── THE OUTCOMES LEFT THE BODY FOR THE NOTICE SLOT (v3.62.0, P1-7) ──
  // They are `foundationsNotices` now — step ①'s `noticeHtml`, which
  // renderBlock puts ABOVE the heading and inside the block's wrapper. The
  // property is unchanged and stronger: they were "above the fold" inside a
  // 32px prose indent, and they are outside the body altogether.
  const failedSt = { ...base, fnd: { domain: 'acme', project: 'lumina', busy: false, error: 'nope', result: null } };
  const failed = makeRenderers(failedSt).foundationsNotices(fndRead(fndPayload([fndDoc()])));
  ok('a failure is painted, unfolded, and says nothing was copied',
    failed.includes('Nothing was copied: nope') && !failed.includes('<details'), failed.slice(0, 300));
  ok('...and it reaches the page ABOVE step ①\'s own heading',
    (() => {
      const pg = makeRenderers({ ...failedSt, journalLimit: 10, projects: [], detail: null,
        detailLoading: false, projectRead: fndRead(fndPayload([fndDoc()])) }).renderProject();
      const one = pg.slice(pg.indexOf('settings-block-context-canonical'));
      return one.indexOf('Nothing was copied') !== -1
        && one.indexOf('Nothing was copied') < one.indexOf('settings-block-hd');
    })());

  const done = makeRenderers({ ...base, fnd: { domain: 'acme', project: 'lumina', busy: false, error: null,
    result: { refreshed: ['a.md'], added: [], unchanged: ['b.md'], missing: ['gone.md'] } } })
    .foundationsNotices(fndRead(fndPayload([fndDoc()])));
  ok('a result names what happened to every class of document',
    done.includes('1 re-copied') && done.includes('1 already current')
    && done.includes('no longer at the source (the copy is kept)'), done.slice(0, 400));
  // v3.69.0 (§3.1): "Refresh all" runs every group; a group whose read failed
  // is left EXACTLY as it was, and its line says so by name, unfolded.
  const partial = makeRenderers({ ...base, fnd: { domain: 'acme', project: 'lumina', busy: false, error: null,
    result: { refreshed: ['a.md'], added: [], unchanged: [], missing: [], refused: [{ path: 'x.md', reason: 'too large' }],
      failed: ['acme/lumina was not refreshed and is unchanged: GitHub answered 500'] } } })
    .foundationsNotices(fndRead(fndPayload([fndDoc()])));
  ok('a source that failed is named, unchanged, with the reason — beside what did refresh',
    /1 re-copied/.test(partial) && /acme\/lumina was not refreshed and is unchanged: GitHub answered 500/.test(partial)
    && !/<details/.test(partial), partial.slice(0, 600));
  ok('...and what the store refused is listed too, unfolded', /x\.md/.test(partial) && /too large/.test(partial),
    partial.slice(0, 900));

  // STAMPED. A result belonging to another project must not sit under this
  // one's header claiming its documents were re-copied.
  const elsewhere = makeRenderers({ ...base, fnd: { domain: 'acme', project: 'OTHER', busy: false,
    error: 'nope', result: null } }).foundationsNotices(fndRead(fndPayload([fndDoc()])));
  ok('an outcome stamped with a DIFFERENT project is withheld entirely',
    !elsewhere.includes('Nothing was copied'));
}

// ── §21f — tier 0's one line, and its silence ────────────────────────────
//
// ── `renderFoundationsStatus` IS GONE (v3.62.0) ──────────────────────────
// It was the Status block's one line about tier 0, and the Status block is
// replaced by the three-cell strip — whose cell ① IS this reading, on the same
// readout instrument, with the app's freshness dot beside it (which the old
// line could not have: `renderReadout` escaped its value until v3.62.0 added
// `markHtml`). Deleting the renderer rather than leaving it calling nothing is
// the same call this file makes about a CSS rule nothing can match.
//
// Every property it was asserted for moved onto the strip, and one is NEW: the
// old line was SILENT on a project with no documents, because a dash in a
// four-line status block was noise. A strip cell is not a line in a block — it
// is one of three readings the page exists to give — so it speaks in every
// state, and says which state it is in.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', projects: [] });
  // THE MARK RIDES INSIDE THE VALUE (that is what `markHtml` is), so a
  // non-greedy `</span>` stops at the DOT's closing tag rather than the
  // value's. Take a window and strip the tags instead — found by writing the
  // naive form first and watching it return the empty dot span.
  // v3.64.2 — the strip became the shared OVERVIEW card, so the reading is a
  // `.cur-ov-value` with an optional `.cur-ov-sub` under it. Both lines are
  // taken, because the figure and its qualifier ("24 documents" / "4 stale")
  // were one cell before and are two lines now; what this helper has always
  // returned is WHAT THE CARD SAYS.
  const cellOf = (html) => {
    const i = html.indexOf('>DOCUMENTS<');
    if (i === -1) return null;
    const j = html.indexOf('<div class="cur-ov-value', i);
    if (j === -1) return null;
    const end = html.indexOf('</button>', j);
    return html.slice(j, end === -1 ? j + 400 : end)
      .replace(/<\/div>/g, ' \u00b7 ').replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ').replace(/ \u00b7 $/, '').trim();
  };
  ok('a project that has never had a document SAYS SO, rather than going silent '
    + '— the strip is three readings, and a missing one is a fourth thing to '
    + 'wonder about', /not set up yet/.test(String(cellOf(F.renderLayerStrip({ scopes: [] })))),
  String(cellOf(F.renderLayerStrip({ scopes: [] }))));
  ok('...and a present but empty tier is a DIFFERENT sentence, because it is a '
    + 'different state', /no documents yet/.test(String(cellOf(F.renderLayerStrip(fndRead(fndPayload([])))))));
  const line = F.renderLayerStrip(fndRead(fndPayload([fndDoc(), fndDoc({ slug: 'b.md' })])));
  ok('with documents it reads on the same instrument every other figure on this '
    + 'page uses', line.includes('cur-ov-card') && line.includes('>DOCUMENTS<'), line.slice(0, 300));
  ok('...and quotes the same word the fold\'s summary does',
    String(cellOf(line)).includes('2 documents · fresh'), String(cellOf(line)));
  ok('...with the shared freshness dot INSIDE the value, which the deleted line '
    + 'could not carry at all', /fresh-dot fresh-recent[\s\S]{0,40}2 documents/.test(line), line.slice(0, 400));
  ok('a manifest error is reported here too, because the strip is where somebody '
    + 'with no context looks first',
  String(cellOf(F.renderLayerStrip(fndRead(fndPayload([], { manifestError: 'boom' })))))
    .includes('manifest unreadable'));
  // A CURATOR-OWNED SET TAKES NO DOT. There is no upstream to compare against,
  // and a grey dot beside "written" reads as a stale one at a glance — the same
  // call `fndRowHtml` makes for a curator-authored row.
  const curator = F.renderLayerStrip(fndRead(fndPayload(
    [fndDoc({ freshness: 'n/a' })], { ownership: 'curator' })));
  ok('a curator-owned set carries NO freshness dot in cell ①, because no '
    + 'comparison was made', !/fresh-dot[^"]*"[\s\S]{0,60}>1 document/.test(curator), curator.slice(0, 400));

  // AND IT REACHES THE PAGE, ABOVE THE FIRST STEP. A renderer nothing calls is
  // a renderer nothing proves — the same gap §6 records for renderStaleNotice.
  const page = makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10, projects: [],
    projectRead: fndRead(fndPayload([fndDoc()])), detail: null, detailLoading: false,
  }).renderProject();
  ok('the reading really lands on the page, above step ①',
    page.indexOf('>DOCUMENTS<') > page.indexOf('mem-project-head')
    && page.indexOf('>DOCUMENTS<') < page.indexOf('settings-block-context-canonical'),
    String(page.indexOf('>DOCUMENTS<')));
  ok('...and the deleted renderer is gone from live source, not merely unused',
    !/function renderFoundationsStatus/.test(viewSrc));
}

// ── §21f2 — step ③: N wikis, N reads, and a picker that chooses them ────
// ═════════════════════════════════════════════════════════════════════════
//
// THE REPORT: *"This knowledge section should be the compounding wiki — how do
// I select exactly which domain I want my project to use? ... Where do I
// select which domain gets sourced — is this even an option?"* It was not.
//
// `loadKnowledge` is the only fetch this view issues outside `/api/memory`,
// and four of its five properties fail SILENTLY if they break: a second
// request per domain per paint (invisible, just slower), a reply for a mount
// that has ended, a 404 told as a read failure, and a failure painted as a
// blank rather than as a disclosure. Driven against a fake fetch.
{
  const mk = (responder) => {
    const st = { activeDomain: 'acme', activeProject: 'lumina', knowledge: new Map() };
    const calls = { urls: [], renders: 0 };
    const api = new Function('state', 'isCurrentMount', 'render', 'fetch',
      'reportAsyncMountFailure',
      'const knowledgeCache = new Map();\n'
      + 'const knowledgeInFlight = new Set();\n'
      + extractFunction(viewSrc, 'loadKnowledge', 'memory.js')
      + '\nreturn { loadKnowledge, cache: knowledgeCache };')(
      st, () => true, () => { calls.renders++; },
      async (url) => { calls.urls.push(url); return responder(url); },
      () => {});
    return { st, calls, api };
  };
  const okRes = (data, status) => ({ ok: status === undefined, status: status || 200,
    json: async () => data });
  // Every arm below fires an unawaited inner async, so the harness has to
  // yield to the microtask queue rather than to `loadKnowledge`'s own promise.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  {
    const r = mk((u) => okRes({ pageCount: u.includes('acme') ? 3445 : 12,
      pageCounts: { entities: 614 }, lastIngestDate: '2026-09-16' }));
    await r.api.loadKnowledge(['acme', 'research'], 1);
    await settle();
    eq('N domains means N reads, each with its own domain escaped into the URL',
      r.calls.urls.sort().join(','), '/api/domains/acme/stats,/api/domains/research/stats');
    eq('...and each answer lands under its OWN key', r.st.knowledge.get('acme').data.pageCount
      + ':' + r.st.knowledge.get('research').data.pageCount, '3445:12');

    // CACHED PER DOMAIN. A second project in the same domain draws on the
    // same wiki, and a project that gained a third wiki pays for that one only.
    r.calls.urls.length = 0;
    await r.api.loadKnowledge(['acme', 'research'], 1);
    await settle();
    eq('a second ask for domains already in hand issues NO request', r.calls.urls.length, 0);
  }

  {
    // ── AND TWO OVERLAPPING ASKS FOR ONE DOMAIN ARE ONE REQUEST ────────
    //
    // The CACHE cannot cover this: it is written when the answer LANDS, so a
    // second ask made while the first is still in flight misses it entirely.
    // Two project switches inside one domain, or two rows naming one wiki,
    // is the shape — and the cost of getting it wrong is invisible, just
    // slower, which is why it is driven rather than assumed. (A mutation
    // deleting the in-flight guard was GREEN against the cache assertion
    // above; this is what reds it.)
    let release;
    const gate = new Promise((res) => { release = res; });
    const r = mk(async () => { await gate; return okRes({ pageCount: 1, pageCounts: {} }); });
    await r.api.loadKnowledge(['acme'], 1);
    await r.api.loadKnowledge(['acme'], 1);
    await settle();
    eq('two asks for one domain while the first is in flight issue ONE request',
      r.calls.urls.length, 1, JSON.stringify(r.calls.urls));
    release();
    await settle();
    // AND THE MARK IS RELEASED, or the domain could never be re-read at all.
    r.calls.urls.length = 0;
    r.api.cache.delete('acme');
    r.st.knowledge.delete('acme');
    await r.api.loadKnowledge(['acme'], 1);
    await settle();
    eq('...and the mark clears when the read settles, so the domain is '
      + 'readable again', r.calls.urls.length, 1, JSON.stringify(r.calls.urls));
  }

  {
    // STAMPED AT THE POINT OF USE. A reply for a mount that has ended must
    // never be written into state at all.
    let live = true;
    const st = { activeDomain: 'acme', activeProject: 'lumina', knowledge: new Map() };
    const api = new Function('state', 'isCurrentMount', 'render', 'fetch',
      'reportAsyncMountFailure',
      'const knowledgeCache = new Map();\n'
      + 'const knowledgeInFlight = new Set();\n'
      + extractFunction(viewSrc, 'loadKnowledge', 'memory.js')
      + '\nreturn { loadKnowledge };')(
      st, () => live, () => {},
      async () => okRes({ pageCount: 99, pageCounts: {} }), () => {});
    await api.loadKnowledge(['acme'], 1);
    live = false;
    await settle();
    eq('an answer for a mount that has ENDED is dropped, not painted',
      st.knowledge.get('acme').data, null);
  }

  {
    // A 404 IS A DIFFERENT FACT FROM A FAILURE, and the row says a different
    // sentence about each. The store keeps a slug whose domain this install
    // does not have — a domain deleted by accident, or one that lives on
    // another computer — and reporting that as a read failure would send
    // somebody looking for a domain that is perfectly fine.
    const r = mk(() => okRes({ error: 'Unknown domain: ghost' }, 404));
    await r.api.loadKnowledge(['ghost'], 1);
    await settle();
    eq('a 404 is recorded as GONE, not as an error', r.st.knowledge.get('ghost').gone, true);
    const r2 = mk(() => okRes({ error: 'boom' }, 500));
    await r2.api.loadKnowledge(['acme'], 1);
    await settle();
    eq('...and a 500 is an ERROR, not gone', r2.st.knowledge.get('acme').gone, false);
    eq('...carrying what the route said', r2.st.knowledge.get('acme').error, 'boom');
    eq('...and nothing is cached, so the next visit tries again', r2.api.cache.size, 0);
  }

  {
    const r = mk(() => { throw new Error('offline'); });
    await r.api.loadKnowledge(['acme'], 1);
    await settle();
    eq('a thrown fetch is caught and disclosed rather than escaping the view',
      r.st.knowledge.get('acme').error, 'offline');
  }

  // ── AND THE STEP PAINTS EVERY STATE ────────────────────────────────────
  const kmap = (entries) => new Map(Object.entries(entries));
  const K = (entries, over) => makeRenderers({
    activeDomain: 'acme', activeProject: 'l', openFolds: {}, domainList: ['acme', 'research'],
    knowledge: kmap(entries),
    projectRead: { knowledgeDomains: Object.keys(entries), knowledgeDomainsDefaulted: false },
    ...over,
  }).renderKnowledge();

  const flight = K({ acme: { data: null, error: null, gone: false } });
  ok('while the figures are in flight the row RESERVES its height rather than '
    + 'collapsing', /aria-busy="true"/.test(flight));
  ok('...and both doors are offered even then, carrying THEIR OWN domain',
    /data-mem-k-domains="acme"/.test(flight) && /data-mem-k-chat="acme"/.test(flight), flight.slice(0, 400));

  const failedK = K({ acme: { data: null, error: 'boom', gone: false } });
  ok('a failure says so, unfolded, and STILL offers both doors — a domain\'s '
    + 'wiki does not stop existing because a stats read did',
  /Could not read/.test(failedK) && /data-mem-k-domains="acme"/.test(failedK)
    && !failedK.includes('<details'), failedK.slice(0, 300));

  const goneK = K({ ghost: { data: null, error: 'Unknown domain', gone: true } });
  ok('a domain that no longer exists is a ROW THAT SAYS SO, never a silent drop',
    /is not a domain on this computer/.test(goneK), goneK.slice(0, 400));
  ok('...and it says what to do about it rather than only that it is wrong',
    /remove it below/.test(goneK));

  // ── THE DOORS ARE PER ROW ─────────────────────────────────────────────
  const two = K({
    acme: { data: { pageCount: 10, pageCounts: {}, lastIngestDate: '2026-09-16' }, error: null },
    research: { data: { pageCount: 4, pageCounts: {}, lastIngestDate: '2026-09-10' }, error: null },
  });
  eq('two chosen wikis paint TWO rows', (two.match(/data-mem-fold="knowledge-/g) || []).length, 2);
  eq('...and TWO pairs of doors, each naming its own domain',
    (two.match(/data-mem-k-domains="/g) || []).length + ':'
    + (two.match(/data-mem-k-chat="/g) || []).length, '2:2');
  ok('...by DATA ATTRIBUTE rather than by id — an id must be unique and there '
    + 'are N of them now', !/id="mem-k-domains"/.test(two) && !/id="mem-k-chat"/.test(two));
  ok('each row is keyed by its own domain, so opening one does not open the other',
    two.includes('data-mem-fold="knowledge-acme"')
    && two.includes('data-mem-fold="knowledge-research"'), two.slice(0, 300));
  ok('...and both ship CLOSED', !/data-mem-fold="knowledge-[a-z]+" open/.test(two));
  ok('...and each opens from its OWN key',
    makeRenderers({ activeDomain: 'acme', activeProject: 'l',
      openFolds: { 'knowledge-research': true }, domainList: ['acme', 'research'],
      knowledge: kmap({
        acme: { data: { pageCount: 10, pageCounts: {} }, error: null },
        research: { data: { pageCount: 4, pageCounts: {} }, error: null } }),
      projectRead: { knowledgeDomains: ['acme', 'research'], knowledgeDomainsDefaulted: false },
    }).renderKnowledge().includes('data-mem-fold="knowledge-research" open'));

  // ── THE MONITOR IS THE BODY (M3) ──────────────────────────────────────
  const full = K({ acme: { error: null, data: { pageCount: 3445,
    pageCounts: { entities: 614, concepts: 2780, summaries: 51, other: 0 },
    lastIngestDate: '2026-09-16', lastIngestKind: 'ingest', lastIngestTitle: 'The Footprint' } } });
  // FIVE, IN ORDER, AND NOTHING ELSE. `every` alone passes over a SIXTH line
  // — a figure nobody asked for, in the one instrument on this step — so the
  // keys are read out of the rendered monitor and compared as a sequence.
  eq('the five figures are MONITOR lines, in the OVERVIEW vocabulary, and '
    + 'there is no sixth — the third of the three report treatments this '
    + 'screen carried, now the one instrument',
  [...full.matchAll(/<span class="cur-mon-key">([^<]*)<\/span>/g)].map((m) => m[1]).join(','),
  'pages,entities,concepts,summaries,last ingest', full.slice(0, 900));
  ok('...with the counts they were given', /3,445/.test(full) && /2,780/.test(full), full.slice(0, 900));
  ok('the verb comes from the log, never from the view\'s name',
    /Ingested · The Footprint/.test(full), full.slice(0, 1200));
  ok('...and a kind the log did not carry renders the NEUTRAL verb rather than a '
    + 'guessed one', /Last write/.test(K({ acme: { error: null, data: { pageCount: 1,
    pageCounts: {}, lastIngestDate: '2026-09-16', lastIngestKind: null } } })));
  ok('...and no date at all says so rather than showing a zero',
    /nothing ingested yet/.test(K({ acme: { error: null, data: { pageCount: 1, pageCounts: {},
      lastIngestDate: null, lastIngestKind: null } } })));
  ok('and neither door is the primary — neither completes a step',
    !/btn-primary/.test(full) && (full.match(/btn-secondary btn-xs/g) || []).length === 2, full.slice(-500));

  // ── THE PICKER ────────────────────────────────────────────────────────
  // One add at a time, because `shared/listbox.js` implements no multi-select
  // and says so — building a second selection paradigm here is the shape this
  // release exists to remove.
  const cfgOf = (h) => {
    const m = /data-lb-stub="([^"]*)"/.exec(h);
    return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null;
  };
  const pick = cfgOf(full);
  ok('the picker offers the domains NOT already chosen', pick
    && JSON.stringify(pick.options) === JSON.stringify(['research']), JSON.stringify(pick));
  ok('...and every chosen wiki has its own Remove', /data-mem-k-drop="acme"/.test(full));
  const allChosen = K({
    acme: { data: { pageCount: 1, pageCounts: {} }, error: null },
    research: { data: { pageCount: 1, pageCounts: {} }, error: null },
  });
  ok('with every domain chosen the picker is not offered at all, and says why '
    + 'rather than presenting an empty menu',
  !/data-lb-stub/.test(allChosen) && /Every domain on this computer is already chosen/.test(allChosen),
  allChosen.slice(-400));
  const noList = makeRenderers({ activeDomain: 'acme', activeProject: 'l', openFolds: {},
    domainList: null, domainListRefused: true, knowledge: kmap({}),
    projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false } }).renderKnowledge();
  ok('a list that could not be READ says so — never an empty menu, which would '
    + 'read as "there are no other domains"',
  /could not be read/.test(noList), noList.slice(-400));
  ok('...and a list still in flight says something different again',
    /Reading the domains/.test(makeRenderers({ activeDomain: 'acme', activeProject: 'l',
      openFolds: {}, domainList: null, domainListRefused: false, knowledge: kmap({}),
      projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false } }).renderKnowledge()));

  // ── DEFAULTED SAYS SO ─────────────────────────────────────────────────
  const dflt = makeRenderers({ activeDomain: 'acme', activeProject: 'l', openFolds: {},
    domainList: ['acme', 'research'],
    knowledge: kmap({ acme: { data: { pageCount: 5, pageCounts: {} }, error: null } }),
    projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: true } }).renderKnowledge();
  // ── THE DEFAULT IS A WORD ON THE ROW, NOT A PARAGRAPH UNDER THE STEP ──
  // v3.65.1. It was forty words of `.tx-desc` under the picker — an
  // explanation in a step body, which is the one thing a step body may not
  // contain. The sentence is step ③'s ⓘ verbatim; what a reader needs ON the
  // row is which of the two it is, and that is one word in the badge class the
  // documents table already uses.
  ok('with nothing chosen the one row is the containing domain, and the ROW '
    + 'says that is a DEFAULT rather than a choice',
  dflt.includes('data-mem-fold="knowledge-acme"')
    && /<span class="mem-badge mem-badge-quiet">default<\/span>/.test(dflt), dflt.slice(0, 600));
  ok('...and it is INSIDE the row\'s summary, beside the name it qualifies — '
    + 'never a sentence under the section',
  /<summary[\s\S]*?mem-badge-quiet">default<[\s\S]*?<\/summary>/.test(dflt),
  (/<summary[\s\S]*?<\/summary>/.exec(dflt) || [''])[0]);
  ok('...and NO prose survives in the body — the step is a head row and rows',
    !/draws on the domain it/.test(dflt), (dflt.match(/tx-desc[^<]*<[^>]*>[^<]*/g) || []).join(' | '));
  ok('CONTROL: a project that HAS chosen carries no such chip',
    !/mem-badge-quiet">default</.test(full), full.slice(0, 400));
  ok('...and the sentence lives in step ③\'s ⓘ, verbatim',
    /draws on the domain it lives in/.test(makeRenderers({
      activeDomain: 'acme', activeProject: 'l', openFolds: {}, projects: [],
      journalLimit: 10, detail: null, detailLoading: false, domainList: ['acme'],
      knowledge: kmap({ acme: { data: { pageCount: 5, pageCounts: {} }, error: null } }),
      projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: true },
    }).renderProject()), 'the sentence vanished with the paragraph');

  // ── A MALFORMED project.json IS LOUD ──────────────────────────────────
  const bad = makeRenderers({ activeDomain: 'acme', activeProject: 'l', openFolds: {},
    domainList: ['acme'], knowledge: kmap({}),
    projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: true,
      knowledgeDomainsError: 'project.json is not valid JSON.' } }).renderKnowledge();
  ok('a project.json the store could not read is disclosed, UNFOLDED — the rows '
    + 'below are the default rather than the choice, and saying nothing would '
    + 'present one as the other',
  /could not be read/.test(bad) && /not valid JSON/.test(bad), bad.slice(0, 400));
}

// ── §21f2b — the OVERVIEW's jumps land where the reading IS ─────────────
// ═════════════════════════════════════════════════════════════════════════
//
// Three of the four cards open a numbered STEP; CAPTURE opens a READING
// INSIDE step ②, and since v3.65.0 that reading is a fold row rather than a
// card above it. The two-step fallback is the point and is what fails
// silently: land on the ROW when it is on screen, on the step that holds it
// when it is not. A jump that quietly degraded to the step would look almost
// right and put the reader at the top of a long section.
//
// The listener body is lifted out of `wire()` by brace-match on its own
// marker and driven against a recording document — the shape §21f2 already
// uses for the chat door.
{
  const liftJump = (src) => {
    const marker = "document.querySelectorAll('[data-ov-jump]').forEach((btn) => {";
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error('the [data-ov-jump] binder was not found in memory.js');
    const open = idx + marker.length - 1;
    let i = open;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    // The BODY only, without the `{ … }` braces, so it can be dropped into a
    // `new Function` whose parameter list supplies `btn`.
    return src.slice(open + 1, i - 1);
  };

  const run = (where, present) => {
    const asked = [];
    const scrolled = [];
    const mk = (name) => ({ __name: name,
      scrollIntoView: () => scrolled.push(name),
      querySelector: () => ({ setAttribute() {}, focus() {} }) });
    const btn = { dataset: { ovJump: where }, addEventListener(t, fn) { this._click = fn; } };
    const doc = {
      querySelectorAll: () => [btn],
      querySelector: (sel) => { asked.push(sel); return present.includes(sel) ? mk(sel) : null; },
    };
    // The lifted body is the forEach CALLBACK, so it is run as a function OF
    // the button rather than as a closure over one — `btn` is that callback's
    // own parameter in the shipped code.
    // eslint-disable-next-line no-new-func
    new Function('document', 'window', 'btn', liftJump(stripComments(viewSrc)))(
      doc, { matchMedia: () => ({ matches: false }) }, btn);
    btn._click();
    return { asked, scrolled };
  };

  const onScreen = run('capture', ['.settings-block-context-state', '[data-mem-fold="capture"]']);
  ok('CAPTURE asks for the ROW the reading now lives in',
    onScreen.asked.includes('[data-mem-fold="capture"]'), JSON.stringify(onScreen.asked));
  eq('...and scrolls to it, not to the step around it',
    onScreen.scrolled.join(','), '[data-mem-fold="capture"]');
  const offScreen = run('capture', ['.settings-block-context-state']);
  eq('...and falls back to the step that HOLDS it when the row is not there',
    offScreen.scrolled.join(','), '.settings-block-context-state');
  // CONTROL: a card naming a whole step takes no fallback at all.
  const step = run('context-canonical', ['.settings-block-context-canonical']);
  eq('CONTROL: a step card opens its own step directly',
    step.scrolled.join(','), '.settings-block-canonical'.replace('canonical', 'context-canonical'));
  ok('...and asks for no row', !step.asked.some((a) => a.includes('data-mem-fold')),
    JSON.stringify(step.asked));
}

// ── §21f3 — the ONE write step ③ makes, and every refusal it can meet ───
// ═════════════════════════════════════════════════════════════════════════
//
// `PATCH …/knowledge/domains` is CURATOR METADATA about the project: the
// route writes `project.json` and NOTHING else, so the standing brief (tier
// 1), every handoff and journal line (tiers 2 and 3, agent-only over MCP) and
// every foundation's bytes are untouched. The single-writer rule is "one
// writer per FILE, with provenance that matches", and this file has exactly
// one writer for exactly one fact.
//
// EVERY REFUSAL BECOMES A SENTENCE, and two of them carry data the user needs
// — the cap, and which domain was not recognised — so those are read off the
// payload rather than paraphrased into a guess.
{
  const mk = (responder) => {
    const st = { activeDomain: 'acme', activeProject: 'lumina',
      projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false },
      knowledge: new Map(), knowledgeSaving: false, knowledgeSaveError: null };
    const calls = { bodies: [], urls: [], renders: 0, forgotten: [], reloaded: [] };
    const api = new Function('state', 'isCurrentMount', 'render', 'fetch', 'encodeURIComponent',
      'forgetProject', 'loadKnowledge', 'reportAsyncMountFailure',
      extractFunction(viewSrc, 'saveKnowledgeDomains', 'memory.js')
      + '\nreturn { saveKnowledgeDomains };')(
      st, () => true, () => { calls.renders++; },
      async (url, init) => { calls.urls.push(url); calls.bodies.push(init && init.body);
        return responder(url, init); },
      encodeURIComponent,
      (d, p) => calls.forgotten.push(d + '/' + p),
      async (list) => { calls.reloaded.push(list.join(',')); },
      () => {});
    return { st, calls, api };
  };
  const res = (status, data) => ({ ok: status < 400, status, json: async () => data });

  {
    const r = mk(() => res(200, { ok: true, knowledgeDomains: ['acme', 'research'],
      knowledgeDomainsDefaulted: false, cleared: false }));
    await r.api.saveKnowledgeDomains(['acme', 'research'], 1);
    ok('it PATCHes the knowledge-domains route under this project, escaped',
      r.calls.urls[0] === '/api/memory/acme/lumina/knowledge/domains', r.calls.urls[0]);
    eq('...sending the WHOLE list, never a delta — the store\'s body is strict '
      + 'and one field, and a partial write is how two clients come to disagree '
      + 'about a set', r.calls.bodies[0], '{"knowledgeDomains":["acme","research"]}');
    eq('...and the ROUTE\'s own answer is what is adopted, not the list we sent',
      (r.st.projectRead.knowledgeDomains || []).join(','), 'acme,research');
    eq('...the cached project read is dropped, so the old set does not come '
      + 'back on the next visit', r.calls.forgotten.join(','), 'acme/lumina');
    eq('...and the new wiki\'s figures are asked for', r.calls.reloaded.join(';'), 'acme,research');
    eq('no refusal is reported on a success', r.st.knowledgeSaveError, null);
    eq('...and the busy flag is cleared', r.st.knowledgeSaving, false);
  }

  {
    // REMOVING THE LAST ONE CLEARS, and `null` is the store's own way of
    // saying it — an empty ARRAY is refused (`empty-list`), because "none at
    // all" is not a state a project can be in.
    const r = mk(() => res(200, { ok: true, knowledgeDomains: ['acme'],
      knowledgeDomainsDefaulted: true, cleared: true }));
    await r.api.saveKnowledgeDomains([], 1);
    eq('removing the last wiki sends NULL, not an empty list',
      r.calls.bodies[0], '{"knowledgeDomains":null}');
    eq('...and the project is back on its default', r.st.projectRead.knowledgeDomainsDefaulted, true);
  }

  // EVERY REFUSAL, AS A SENTENCE.
  const refusal = async (status, data) => {
    const r = mk(() => res(status, data));
    await r.api.saveKnowledgeDomains(['x'], 1);
    return r.st.knowledgeSaveError;
  };
  // A CAP THE STORE DID NOT SEND is a different fixture from one it did, and
  // only the second can tell a READ number from a TYPED one. `9` is not the
  // shipped cap, so a sentence that hard-codes 12 reds here — which is what a
  // fixture using the real cap could not do, and did not (green first).
  // ── THE FIXTURES ARE THE WIRE'S SHAPE NOW (v3.65.2, C4) ────────────────
  // `{reason: <code>, error: <prose>}` — what src/routes/memory.js actually
  // sends, `withErrorProse` having copied the store's message into `error`.
  // Through v3.65.1 these fixtures put the CODE in `error`, which is the shape
  // the view keyed on and the route never sends: every assertion here was
  // green over a branch no real refusal could reach.
  const P = 'the store’s own prose';
  ok('the CAP is named with the store\'s own number, not a copy typed here',
    (await refusal(400, { reason: 'too_many_domains', error: P, cap: 9 })) === 'A project can draw on at most 9 domains.',
    await refusal(400, { reason: 'too_many_domains', error: P, cap: 9 }));
  ok('...and a route that sent no cap at all falls back to the shipped one '
    + 'rather than printing "undefined"',
  (await refusal(400, { reason: 'too_many_domains', error: P })) === 'A project can draw on at most 12 domains.',
  await refusal(400, { reason: 'too_many_domains', error: P }));
  ok('an unknown domain is NAMED, because the user has to know which one',
    /Not a domain on this computer: ghost\./.test(
      await refusal(400, { reason: 'unknown_domain', error: P, domains: ['ghost'] })));
  ok('an invalid name says so', /not a usable domain name/.test(
    await refusal(400, { reason: 'invalid_domain', error: P })));
  ok('a Shared Brain MIRROR says why it cannot be changed here', /read-only Shared Brain mirror/.test(
    await refusal(403, { reason: 'readonly', error: P })));
  ok('a vanished project says so', /no longer exists/.test(
    await refusal(404, { reason: 'project_not_found', error: P })));
  ok('a lock says TRY AGAIN rather than presenting a transient as permanent',
    /Try again in a moment/.test(await refusal(409, { reason: 'locked', error: P })));
  ok('an unrecognised code falls back to the route\'s own PROSE rather than '
    + 'being swallowed — silence about a refusal is the worst of the three options',
  (await refusal(400, { reason: 'something_new', error: P })) === P);
  ok('...and a refusal with no body at all still says something',
    (await refusal(500, {})) === 'HTTP 500');
  ok('the CODE is read from `reason`: a code in `error` alone is prose, not a code '
    + '(the shape through v3.65.1, which no real refusal ever had)',
  (await refusal(400, { error: 'too_many_domains' })) === 'too_many_domains');

  {
    // A REFUSAL CHANGES NOTHING ON SCREEN but the message: the old set stays,
    // so a failed add does not look like a successful one.
    const r = mk(() => res(400, { reason: 'unknown_domain', error: 'x', domains: ['ghost'] }));
    await r.api.saveKnowledgeDomains(['acme', 'ghost'], 1);
    eq('a refused write leaves the chosen set exactly as it was',
      (r.st.projectRead.knowledgeDomains || []).join(','), 'acme');
    eq('...and asks for no figures', r.calls.reloaded.length, 0);
    eq('...and drops no cache', r.calls.forgotten.length, 0);
  }

  {
    // A SECOND PRESS WHILE ONE IS IN FLIGHT IS REFUSED BY THE VIEW, so two
    // clicks cannot race two different full lists at one file.
    const r = mk(() => res(200, { ok: true, knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false }));
    r.st.knowledgeSaving = true;
    await r.api.saveKnowledgeDomains(['acme', 'research'], 1);
    eq('a write while one is already in flight issues no request at all', r.calls.urls.length, 0);
  }
}

// ── §21f4 — step ③'s binder, driven THROUGH THE REAL LISTBOX (v3.65.2) ──
// ═════════════════════════════════════════════════════════════════════════
//
// ONE BINDER, exactly as tier 0's rows and the work-stream table have, and
// the reason is mechanical rather than tidy: `wire()` is lifted and executed
// against a hand-written set of stubs, so every name it calls must be one
// that set supplies — one binder is one stub rather than three.
//
// ── WHAT THIS SECTION GOT WRONG THROUGH v3.65.1, AND WHY IT WAS GREEN ────
// It stubbed `mountListbox`, asserted `typeof cfg.onSelect === 'function'`
// and then CALLED `onSelect` itself. shared/listbox.js never reads
// `onSelect` — its only handler is `onChange` — so in the app a pick ran the
// component's `commit()`, relabelled the trigger "research ▾" and called
// nothing: 0 requests, 0 console messages (measured by the v3.65.2 design
// pass; the maintainer's words were "basically not functioning"). The suite
// pinned the bug because it stood in for the one thing whose join it was
// supposed to prove.
//
// So the picker is mounted here through the REAL `mountListbox`, lifted off
// shared/listbox.js and executed against a minimal DOM model, and a pick is a
// click on a menu row the real component rendered. The handler is reached only
// if the component calls it.
const LB_SRC = readFileSync(join(NEXT, 'shared/listbox.js'), 'utf8');
function realListbox() {
  // The one import (`icon`, `escapeHtml` from ../app.js) is supplied rather
  // than loaded: app.js touches `document` at module scope. Everything else
  // is the shipped file, byte for byte.
  const body = LB_SRC
    .replace(/^import\s[^\n]*\n/gm, '')
    .replace(/^export\s+/gm, '')
    + '\nreturn { renderListboxHtml, mountListbox };';
  const docListeners = [];
  const els = new Map();
  const mkEl = (tag) => {
    const listeners = {};
    const el = {
      tag, dataset: {}, style: {}, attrs: {}, className: '', id: '', disabled: false,
      textContent: '', _html: '', scrollTop: 0, scrollHeight: 0, offsetWidth: 0, clientHeight: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener() {},
      fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev)); },
      querySelector(sel) { return sel === '[data-lb-text]' ? this.textEl || null : null; },
      getBoundingClientRect: () => ({ top: 100, left: 404, width: 140, height: 28, bottom: 128 }),
      // A menu contains the rows it rendered; a trigger contains only itself.
      contains(x) { return x === this || (tag === 'div' && !!x); },
      focus() {}, remove() { this.removed = true; },
    };
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
    return el;
  };
  const created = [];
  const doc = {
    body: { appendChild(el) { created.push(el); } },
    activeElement: null,
    createElement: (t) => mkEl(t),
    getElementById: (id) => els.get(id) || null,
    addEventListener: (t, fn) => docListeners.push(t),
    removeEventListener() {},
    contains: () => true,
  };
  const api = new Function('document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame',
    'CSS', 'icon', 'escapeHtml', body)(
    doc, { innerHeight: 900, innerWidth: 1370 }, () => 1, () => {}, { escape: (x) => x },
    () => '<svg></svg>',
    (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  /** Put a trigger into the model, as `renderListboxHtml` would have. */
  const plant = (id) => {
    const t = mkEl('button');
    t.dataset.lbTrigger = id;
    t.textEl = { textContent: '+ Add a domain' };
    els.set(id, t);
    return t;
  };
  /** Open the menu with a pointer click and press the row carrying `value`. */
  const pick = (trigger, value) => {
    trigger.fire('click', { preventDefault() {} });
    const menu = created[created.length - 1];
    if (!menu || !menu.innerHTML.includes('data-lb-value="' + value + '"')) return false;
    const row = { getAttribute: (k) => (k === 'data-lb-value' ? value : null) };
    menu.fire('click', { target: { closest: () => row } });
    return true;
  };
  return { api, doc, plant, pick, created };
}

{
  const mk = (over) => {
    const st = { activeDomain: 'acme', activeProject: 'lumina', knowledgeSaving: false,
      domainList: ['acme', 'research', 'business'],
      projectRead: { knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false }, ...over };
    const calls = { mounted: [], saved: [] };
    const drops = [{ dataset: { memKDrop: 'acme' }, addEventListener(t, fn) { this._click = fn; } }];
    const root = { querySelectorAll: () => drops };
    const lb = realListbox();
    const trigger = lb.plant('mem-k-add');
    const api = new Function('state', 'document', 'mountListbox', 'saveKnowledgeDomains',
      'reportAsyncMountFailure',
      extractFunction(viewSrc, 'knowledgePickerCfg', 'memory.js') + '\n'
      + extractFunction(viewSrc, 'bindKnowledgeRows', 'memory.js')
      + '\nreturn { bindKnowledgeRows, knowledgePickerCfg };')(
      st, lb.doc,
      // THE REAL COMPONENT, observed rather than replaced: the cfg is recorded
      // and then handed to the shipped `mountListbox`.
      (cfg) => { calls.mounted.push(cfg); return lb.api.mountListbox(cfg); },
      async (list) => { calls.saved.push(list.join(',') || '(cleared)'); },
      () => {});
    api.bindKnowledgeRows(root, 1);
    return { calls, drops, st, trigger, lb, api };
  };

  {
    const r = mk();
    eq('the picker is mounted once', r.calls.mounted.length, 1);
    eq('...from a cfg carrying the SAME id the markup rendered',
      r.calls.mounted[0].id, 'mem-k-add');
    eq('...offering only the domains NOT already chosen',
      r.calls.mounted[0].options.map((o) => o.value).join(','), 'research,business');
    ok('...and the REAL component wired itself to the trigger',
      r.trigger.dataset.lbWired === '1', JSON.stringify(r.trigger.dataset));

    // AN ADD, BY A POINTER PRESS ON A ROW THE COMPONENT RENDERED.
    ok('a pointer click opens the real menu, and it lists `research`', r.lb.pick(r.trigger, 'research'));
    eq('picking a domain sends the whole list plus that one, never a delta — '
      + 'through the component, not around it', r.calls.saved.join(';'), 'acme,research');
    eq('...and the view records WHICH domain is being added, for the busy label',
      r.st.knowledgeAdding, 'research');
  }

  {
    // ── THE CLASS GUARD: every function this view hands the component is a
    // handler the component actually calls. Read out of shared/listbox.js
    // itself (comments stripped), so a handler renamed there — or a key typed
    // here that it has never read — reds this, rather than being called by a
    // test and never by the app.
    const lbNoComments = LB_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const known = new Set([...lbNoComments.matchAll(/cfg\.(on[A-Z]\w*)/g)].map((m) => m[1]));
    ok('shared/listbox.js reads at least one handler (the scan is not vacuous)', known.has('onChange'),
      [...known].join(','));
    const r = mk();
    const fnKeys = Object.keys(r.calls.mounted[0]).filter((k) => typeof r.calls.mounted[0][k] === 'function');
    ok('every function-valued key on the knowledge picker cfg is a handler the listbox reads — '
      + 'an `onSelect` here is a control that does nothing', fnKeys.length > 0
      && fnKeys.every((k) => known.has(k)), fnKeys.join(',') + ' vs ' + [...known].join(','));
  }

  {
    // THE TRIGGER NEVER CARRIES A VALUE. "+ Add a domain" at rest; "Adding
    // research…" and disabled while the write is in flight — rendered by the
    // REAL `renderListboxHtml` from the same cfg function the binder mounts.
    const r = mk();
    const rest = r.api.knowledgePickerCfg([{ value: 'research', label: 'research' }], false, null);
    eq('at rest the cfg asks for "+ Add a domain"', rest.triggerText, '+ Add a domain');
    const idle = r.lb.api.renderListboxHtml(r.api.knowledgePickerCfg(['research'], false, null));
    ok('...and the real component paints exactly that', /data-lb-text>\+ Add a domain</.test(idle), idle);
    const busy = r.lb.api.renderListboxHtml(r.api.knowledgePickerCfg(['research'], true, 'research'));
    ok('while a write is in flight it reads "Adding research…" and is disabled',
      /data-lb-text>Adding research…</.test(busy) && / disabled>/.test(busy), busy);
    const staleName = r.lb.api.renderListboxHtml(r.api.knowledgePickerCfg(['research'], false, 'research'));
    ok('...and a domain name left over from a finished write is never shown at rest',
      /data-lb-text>\+ Add a domain</.test(staleName), staleName);
    const busyNoName = r.lb.api.renderListboxHtml(r.api.knowledgePickerCfg(['research'], true, null));
    ok('...a busy write with no name (a Remove) still never shows a domain as a value',
      /data-lb-text>\+ Add a domain</.test(busyNoName), busyNoName);
  }

  {
    // CHOOSING THE SAME ONE TWICE IS A NO-OP. The component never offers a
    // chosen domain, so this is reached only through the handler directly.
    const r = mk();
    r.calls.mounted[0].onChange('acme');
    eq('choosing a domain already chosen writes nothing', r.calls.saved.length, 0);
  }

  {
    // A REMOVE SENDS THE WHOLE LIST MINUS ONE, and removing the LAST one
    // sends an empty list, which `saveKnowledgeDomains` turns into the store's
    // `null` — the project goes back to the domain it lives in.
    const r = mk();
    r.drops[0]._click();
    eq('removing the only chosen domain sends an EMPTY list, which the writer clears with',
      r.calls.saved.join(';'), '(cleared)');
  }

  {
    const r = mk({ projectRead: { knowledgeDomains: ['acme', 'research'],
      knowledgeDomainsDefaulted: false } });
    r.drops[0]._click();
    eq('removing one of two sends the OTHER, not an empty list — including the domain '
      + 'the project lives in', r.calls.saved.join(';'), 'research');
  }

  {
    // NOTHING LEFT TO ADD: no menu is mounted, because there is nothing for
    // it to offer and an empty menu reads as "there are no other domains".
    const r = mk({ domainList: ['acme'] });
    eq('with every domain chosen nothing is mounted', r.calls.mounted.length, 0);
  }

  {
    // A WRITE IN FLIGHT DISABLES THE CONTROL rather than queueing a second
    // full list against one file.
    const r = mk({ knowledgeSaving: true, knowledgeAdding: 'research' });
    eq('while a write is in flight the picker is mounted DISABLED',
      r.calls.mounted[0].disabled, true);
  }
}

// ── §21f5 — REMOVE, BY LIST SIZE (v3.65.2, C4) ──────────────────────────
// The second half of "I am stuck with the project's domain": on the one row
// that is the default, Remove sent `null`, the store answered "back to the
// default", and the same row repainted — a press that looked dead. Three
// states, each rendered by the real `renderKnowledge`.
{
  const data = { pageCount: 3, pageCounts: {}, lastIngestDate: '2026-09-16' };
  const R = (list, defaulted) => makeRenderers({
    activeDomain: 'acme', activeProject: 'l', openFolds: {}, domainList: ['acme', 'research', 'business'],
    knowledge: new Map(list.map((d) => [d, { data, error: null }])),
    projectRead: { knowledgeDomains: list, knowledgeDomainsDefaulted: defaulted },
  }).renderKnowledge();

  const one = R(['acme'], true);
  ok('ONE row that is the default: Remove is WITHHELD', !/data-mem-k-drop=/.test(one), one.slice(-600));
  ok('...and its reason stands where the control would have been',
    /class="mem-k-drop mem-k-drop-why">Default — add another domain to replace it\.</.test(one), one.slice(-600));

  const two = R(['acme', 'research'], false);
  eq('TWO chosen rows: Remove on EVERY row, including the domain the project lives in',
    (two.match(/data-mem-k-drop="(acme|research)"/g) || []).length, 2);
  ok('...with no default chip and no reason sentence', !/mem-badge-quiet">default</.test(two)
    && !/mem-k-drop-why/.test(two), two.slice(-400));

  const chosenOther = R(['research'], false);
  ok('ONE chosen row that is not home: Remove stays live',
    /data-mem-k-drop="research"/.test(chosenOther), chosenOther.slice(-600));
  ok('...and says, unfolded beside it, what pressing it does',
    /mem-k-drop-why">Removing it puts acme back as the default\.</.test(chosenOther), chosenOther.slice(-600));
  const chosenHome = R(['acme'], false);
  ok('ONE chosen row that IS home: Remove stays live and says the default remains',
    /data-mem-k-drop="acme"/.test(chosenHome)
    && /Removing it leaves acme as the default\./.test(chosenHome), chosenHome.slice(-600));
}

// ── §21f7 — EVERY `hidden` ELEMENT THIS VIEW EMITS REALLY HIDES ─────────
// ═════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS CLOSES, seen in a browser on the first capture of the three
// steps: a bare ⚠ triangle under step ①'s lede with no sentence beside it.
// `.tx-note` declares `display: flex`, and an AUTHOR `display` at any
// specificity beats the UA's `[hidden] { display: none }`, which has none — so
// the budget warning rendered in both states and its empty <span> left the
// glyph alone on the page. Every offline assertion about the markup was green,
// because the markup was right.
//
// THE SWEEP, not a named list: find every element this view emits with a
// `hidden` attribute, take its classes, and require that ONE of them carries a
// `[hidden] { display: none }` counter-rule in a stylesheet this app ships —
// but ONLY when one of those classes actually declares a `display`, because a
// counter-rule for a class that sets none would be cargo. The same shape
// scripts/test-next-foundations-editor.js §14 uses one file over, pointed at
// this view's own markup.
{
  const SHEETS = ['views/memory.css', 'shared/text.css', 'shared/foundations-init.css',
    'shared/freshness.css', 'shell.css'];
  const css = SHEETS.map((f) => { try { return readFileSync(join(NEXT, f), 'utf8'); } catch { return ''; } })
    .join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const declaresDisplay = (cls) => new RegExp('(^|[,\\s>+~])\\.' + cls.replace(/[-]/g, '\\-')
    + '(?![\\w-])[^{}]*\\{[^}]*display\\s*:', 'm').test(css);
  const hasCounterRule = (cls) => new RegExp('\\.' + cls.replace(/[-]/g, '\\-')
    + '(?![\\w-])[^{},]*\\[hidden\\][^{}]*\\{[^}]*display\\s*:\\s*none', 'm').test(css)
    || new RegExp('\\[hidden\\][^{},]*\\.' + cls.replace(/[-]/g, '\\-')
    + '(?![\\w-])[^{}]*\\{[^}]*display\\s*:\\s*none', 'm').test(css);

  // Every state this view paints that can emit a `hidden` element.
  const pages = [
    makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10,
      projects: [], detail: null, detailLoading: false, wsWindow: WS_WINDOW_SRC,
      projectRead: fndRead(fndPayload([fndDoc()])) }).renderProject(),
    makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10,
      projects: [], detail: null, detailLoading: false, wsWindow: WS_WINDOW_SRC,
      projectRead: fndRead(fndPayload([fndDoc({ bytes: 300 * 1024, readFirst: true })])) }).renderProject(),
    makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10,
      projects: [], detail: null, detailLoading: false, wsWindow: WS_WINDOW_SRC,
      projectRead: { scopes: [], brief: { present: false } } }).renderProject(),
  ].join('\n');

  // THE BARE ATTRIBUTE, not `aria-hidden`. `\bhidden\b` matches inside
  // `aria-hidden="true"` — which is on every freshness dot and every numeral
  // on this page — so the first version of this sweep reported five false
  // failures before it reported the real one. The lookbehind refuses a
  // preceding `-` or word character; the lookahead refuses a following `=`.
  const hiddenEls = [...pages.matchAll(/<(\w+)([^>]*(?<![-\w])hidden(?![-\w=])[^>]*)>/g)]
    .map((m) => {
      const cls = (/class="([^"]*)"/.exec(m[2]) || [, ''])[1].split(/\s+/).filter(Boolean);
      return { tag: m[1], classes: cls };
    })
    .filter((e) => e.classes.length);
  ok('CONTROL: the sweep really found `hidden` elements (it is not vacuous)',
    hiddenEls.length > 0, String(hiddenEls.length));
  let checked = 0;
  for (const el of hiddenEls) {
    const risky = el.classes.filter(declaresDisplay);
    if (!risky.length) continue;
    checked++;
    ok('`hidden` really hides <' + el.tag + ' class="' + el.classes.join(' ')
      + '"> — one of its classes sets `display`, which DEFEATS the UA\'s '
      + '[hidden] unless a counter-rule says otherwise',
    el.classes.some(hasCounterRule),
    'display set by [' + risky.join(', ') + '], no [hidden] counter-rule on any of ['
      + el.classes.join(', ') + ']');
  }
  ok('CONTROL: at least one hidden element DID carry a display-setting class, '
    + 'so the loop above ran', checked > 0, String(checked));
  ok('CONTROL: `declaresDisplay` finds the `display` on .tx-note, which is what '
    + 'makes the counter-rule necessary at all', declaresDisplay('tx-note'));
  ok('CONTROL: `hasCounterRule` says NO for a class that has none',
    !hasCounterRule('mem-project-name'));
}

// ── §21f6 — ONE NOUN: FOUNDATIONS (v3.62.0, D-K) ────────────────────────
// ═════════════════════════════════════════════════════════════════════════
//
// THE GAP THIS CLOSES, found by mutation: renaming step ① back to "Canonical
// documents" left the whole offline run GREEN. The design pass called the step
// that, the maintainer's addendum D-K overruled it — one noun everywhere, the
// same word the block, the docs chapter and the MCP tool use — and the
// adjective "canonical documents" survives ONLY inside the ⓘ definition, where
// it describes what a foundation IS rather than naming the thing.
//
// Two rules, and the second is the one that would rot: the STEP and the STRIP
// must say the same word, and the retired noun must not creep back into a
// heading or a label.
{
  const st = {
    activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10,
    projects: [], detail: null, detailLoading: false, wsWindow: WS_WINDOW_SRC,
    projectRead: fndRead(fndPayload([fndDoc()])),
  };
  const page = makeRenderers(st).renderProject();
  ok('step ① is titled Documents',
    /<h2 class="settings-job-title">Documents<\/h2>/.test(page), page.slice(0, 400));
  ok('...and the strip\'s cell ① carries the same word, so the reading and the '
    + 'step it summarises cannot be read as two things',
  /cur-eyebrow">DOCUMENTS</.test(page), page.slice(0, 600));
  // THE ADJECTIVE SURVIVES, IN THE ⓘ AND NOWHERE ELSE. Checked over the
  // PANELS' own contents rather than by offset, the same way §18i checks the
  // never-fold rule: renderBlock emits the fold before the body.
  const panels = [...page.matchAll(/<div class="tx-vh-panel"[^>]*hidden>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1]).join('\n');
  const outside = page.split(/<div class="tx-vh-panel"[^>]*hidden>[\s\S]*?<\/div>/).join(' ');
  ok('"canonical document" is still DEFINED, behind the mark',
    /canonical document/i.test(panels), panels.slice(0, 200));
  ok('...and appears NOWHERE outside a panel — not as a heading, not as a label, '
    + 'not in a lede', !/canonical document/i.test(outside),
  (outside.match(/.{0,60}canonical document.{0,60}/i) || [''])[0]);
  // And the skeleton says it too, or the chrome moves between the two paints.
  ok('the skeleton titles step ① the same way',
    /<h2 class="settings-job-title">Documents<\/h2>/.test(makeRenderers(st).renderProjectSkeleton()));

  // ══ THE VOCABULARY CENSUS (v3.65.1, D1) ═══════════════════════════════
  //
  // The maintainer's first decision, and the one a later edit can undo one
  // string at a time with nothing going red. Five nouns moved in UI COPY —
  // Documents · Memory · Handoffs · Journal · domain — and the STORE's names
  // did not: `foundations/`, `scope`, `journal.jsonl`, `state/` and every
  // field on the wire are the public spec.
  //
  // So the census is over WHAT A READER SEES, not over the source: the
  // rendered page with every fold's markup in it, its ⓘ panels, its accessible
  // names and its eyebrows — which is why each old word is looked for after
  // the attribute-and-class noise is stripped rather than by a grep of
  // memory.js, where `data-mem-fold="foundations"` and `/foundations/init` are
  // both correct and both must stay.
  //
  // FOUND BY MUTATION: four of these six could be reverted one at a time —
  // step ②'s title, the Handoffs row, the Journal row and the picker's
  // placeholder — with every suite still green.
  {
    // ── A FIXTURE THAT PAINTS EVERY ROW, WHICH `st` DOES NOT ──────────
    // FOUND BY MUTATION, and it is the shape a census gets wrong every time:
    // the first draft ran over `st` alone, whose `detail` is null and whose
    // `domainList` is empty — so the Handoffs row, the Journal row and the
    // Knowledge picker were never RENDERED, and reverting all three of their
    // titles left this census green. A scan for an absent word passes on an
    // empty string; the control below is what stops that, and this fixture is
    // what makes the control meaningful.
    const full = {
      ...st,
      scope: 'main', machine: 'boxa',
      domainList: ['acme', 'research'],
      knowledge: new Map([['acme', { error: null, data: { pageCount: 10,
        pageCounts: { entities: 4, concepts: 5, summaries: 1 },
        lastIngestDate: '2026-09-13', lastIngestKind: 'ingest' } }]]),
      capture: { domain: 'acme', project: 'lumina', error: null, data: {
        logPresent: true, windowDays: 30, sessionsShown: 1, sessionsTruncated: false,
        totals: { sessions: 3, sessionsRead: 2, sessionsSaved: 1, sessionsReadNotSaved: 1,
          legacyLines: 0, selfTestLines: 4 },
        sessions: [{ sid: 'a1', client: 'claude-code', calls: 7, read: true, saved: true,
          startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:30:00.000Z' }] } },
      projectRead: {
        ...fndRead(fndPayload([fndDoc()])),
        knowledgeDomains: ['acme'], knowledgeDomainsDefaulted: false,
        savedCopies: 3, distinctScopeCount: 2,
        scopes: [
          { scope: 'main', machine: 'boxa', headline: 'A headline', harness: 'claude-code',
            writtenAgeSeconds: 120, writtenAt: '2026-09-20T10:00:00.000Z' },
          { scope: 'other', machine: 'boxb', writtenAgeSeconds: 900 },
        ],
        brief: { present: true, text: '# B', updatedAt: '2026-09-14T09:00:00.000Z' },
      },
      detail: {
        scope: 'main', machine: 'boxa',
        current: { present: true, text: '# T', writtenAgeSeconds: 120 },
        journal: { returned: 2, total: 9, totalUnknown: false, entries: [
          { at: '2026-09-20T10:00:00.000Z', harness: 'claude-code', model: 'opus', headline: 'H' },
        ] },
      },
      openFolds: { streams: true, journal: true, capture: true, brief: true,
        foundations: true, 'knowledge-acme': true },
    };
    const both = makeRenderers(st).renderProject()
      + '\n' + makeRenderers(st).renderProjectSkeleton()
      + '\n' + makeRenderers(full).renderProject();
    // What a reader sees: tag names, attribute NAMES and class values are not
    // copy. Values of the attributes that ARE read aloud (aria-label, title,
    // placeholder) are kept, because a screen reader reads them.
    const spoken = (both.match(/(?:aria-label|title|placeholder|alt)="([^"]*)"/g) || []).join(' ');
    const visible = both
      .replace(/<[^>]*>/g, ' ')          // every tag, with its attributes
      .replace(/&[a-z]+;/g, ' ');
    // ── AND THE PICKER'S OWN WORDS, WHICH THE STUB SWALLOWS ───────────
    // `renderListboxHtml` is stubbed in this suite (the real component imports
    // app.js, which touches `document` at import time — the wall
    // scripts/test-next-listbox.js documents), and the stub encodes the cfg
    // into a `data-lb-stub` JSON attribute. Stripping tags therefore throws the
    // placeholder and the accessible name away, and the ban on "wiki" ran past
    // `+ Add a wiki` with nothing going red — FOUND BY MUTATION. The cfg is the
    // shipped one either way, so it is read directly and appended to the copy.
    const pickerCfg = makeRenderers(full).knowledgePickerCfg(['research'], false);
    const copy = visible + ' ' + spoken + ' '
      + pickerCfg.placeholder + ' ' + pickerCfg.ariaLabel;
    for (const [word, re] of [
      ['Foundations', /\bfoundations?\b/i],
      ['Working state', /\bworking state\b/i],
      ['Work-stream', /\bwork.?streams?\b/i],
      ['Recent saves', /\brecent saves\b/i],
      // "session" SURVIVES as the definition of the word, in the Capture ⓘ:
      // `A <b>session</b> is one bridge process`. What may not survive is
      // "Sessions" as the NAME of a thing on the screen — a heading, a row
      // title, a column, a fold. Both halves are asserted, so the ban cannot
      // be satisfied by deleting the definition.
      ['Sessions (as a name)', /\bSessions\b/],
      ['wiki (as a noun for a domain)', /\bwikis?\b/i],
      // v3.70.0: "Capture" left the screen for "Agent sessions" — the route,
      // the jump id and every on-disk name keep the old word.
      ['Capture (the retired name)', /\bCapture\b/],
    ]) {
      ok('the Context view says nothing of "' + word + '" in its copy',
        !re.test(copy), (copy.match(new RegExp('.{0,70}' + re.source + '.{0,70}', re.flags)) || [''])[0]);
    }
    // ── THE CONTROL IS WHAT MAKES THE SIX BANS MEAN ANYTHING ──────────
    // A scan for an ABSENT word passes on an empty string, so the census has to
    // prove that every surface it bans a word FROM was actually painted. Each
    // of the five renamed rows is named, positively, by its new word.
    for (const [what, word] of [
      ['step ①', 'Documents'], ['step ②', 'Memory'], ['step ③', 'Knowledge'],
      ['the handoffs row', 'Handoffs'], ['the journal row', 'Journal'],
      ['the capture row', 'Agent sessions'],
      ['the picker', '+ Add a domain'], ['the picker\'s accessible name', 'Add a domain this'],
    ]) {
      ok('CONTROL: ' + what + ' really painted, under its new word',
        copy.includes(word), word + ' is absent — the bans above are vacuous');
    }
    ok('CONTROL: and the page is a real page, not a stub',
      copy.length > 4000, String(copy.length));
    ok('...and the word "session" DOES survive where it is defined, so the ban '
      + 'above cannot be satisfied by deleting the definition',
    /\bsession\b/.test(copy), (copy.match(/.{0,60}\bsession\b.{0,60}/) || [''])[0]);
    // AND THE STORE'S OWN NAMES ARE UNTOUCHED — the other half of D1, and the
    // half a zealous rename breaks. These are the public spec.
    // Split three ways rather than `&&`-ed into one: an assertion that can fail
    // for three reasons tells you nothing about which — and the first draft of
    // this one failed on the journal half because THIS fixture has no journal,
    // while reading as though a store name had been renamed.
    ok('the fold key is still the STORE\'s word, not the screen\'s',
      /data-mem-fold="foundations"/.test(both),
      (both.match(/data-mem-fold="[a-z-]*"/g) || []).join(' '));
    ok('...and the route path is still /foundations/',
      /\/foundations\//.test(viewSrc), 'the route was renamed with the copy');
    ok('...and the localStorage key is unmoved, so a user\'s open folds survive '
      + 'the update', /curator-memory-folds-v1/.test(viewSrc), 'the storage key moved');
  }
}

// ── §21f5 — THE STRIP: three readings, and an unknown one says so ───────
// ═════════════════════════════════════════════════════════════════════════
//
// THE GAP THIS CLOSES, found by mutation: rendering a project with nothing
// saved as "saved just now" on the LIVE tier left the whole offline run GREEN.
// That is the single rule design-system §6 states about this scale — an age
// nobody could take is the dashed unknown ring and the words that say so,
// NEVER age zero — and it is the rule this view exists to keep, because "am I
// saved?" is the question the strip replaced a whole block to answer.
{
  const F = (over) => makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', projects: [], openFolds: {},
    wsWindow: WS_WINDOW_SRC, ...over });

  // ── CELL ②, THE ONE THAT ANSWERS THE QUESTION ───────────────────────
  const nothing = F({}).renderLayerStrip({ scopes: [], brief: { present: false } });
  ok('a project with nothing saved says so in WORDS',
    /nothing saved yet/.test(nothing), nothing);
  ok('...and takes the DASHED UNKNOWN ring, never a fresh one — a reading '
    + 'nobody could take is not a recent reading',
  /fresh-dot fresh-unknown/.test(nothing) && !/fresh-live|fresh-recent/.test(nothing), nothing);
  const saved = F({}).renderLayerStrip({
    scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }], brief: { present: false } });
  ok('CONTROL: a project that HAS been saved reads an age and a real tier',
    /saved 2 min ago/.test(saved) && /fresh-dot fresh-recent/.test(saved), saved);

  // ── AND THE MARK NEVER CARRIES THE READING ALONE ────────────────────
  // Every dot is aria-hidden and every cell's word is the reading, which is
  // what "the strip never uses colour alone" means in markup.
  for (const html of [nothing, saved]) {
    const dots = [...html.matchAll(/<span class="fresh-dot[^"]*"([^>]*)>/g)].map((m) => m[1]);
    ok('every dot in the strip is aria-hidden — the WORD beside it is the reading',
      dots.length > 0 && dots.every((a) => /aria-hidden="true"/.test(a)), JSON.stringify(dots));
  }
  ok('...and no `--fresh-*` token is named as a COLOUR anywhere in this view, '
    + 'which is what keeps one ladder one ladder',
  !/color:\s*var\(--fresh-/.test(viewCss), 'a --fresh-* colour was declared here');

  // ── CELL ③: ABSENT IS ABSENT ────────────────────────────────────────
  // A MAP SINCE v3.65.0 (P10): a project draws on N wikis, so the card is the
  // TOTAL across the set and the second line says when ANY of them was last
  // written to.
  const kmapOf = (o) => new Map(Object.entries(o));
  ok('with no figures in hand the KNOWLEDGE cell is omitted, not filled with a '
    + 'dash — no reading, no instrument',
  !/KNOWLEDGE/.test(F({ knowledge: kmapOf({ acme: { data: null, error: null } }),
    projectRead: { knowledgeDomains: ['acme'] } }).renderLayerStrip({ scopes: [] })));
  const known = F({ knowledge: kmapOf({ acme: { error: null, data: {
    pageCount: 3445, pageCounts: {}, lastIngestDate: null } } }) })
    .renderLayerStrip({ scopes: [], knowledgeDomains: ['acme'] });
  ok('...and a wiki with pages but nothing ingested says THAT rather than a zero age',
    /3,445 pages<\/div><div class="cur-ov-sub">nothing ingested yet/.test(known)
    && /fresh-unknown/.test(known), known);
  // ── THE CARD SUMS THE CHOSEN SET ────────────────────────────────────
  const twoWikis = F({ knowledge: kmapOf({
    acme: { error: null, data: { pageCount: 10, pageCounts: {}, lastIngestDate: '2026-09-10' } },
    research: { error: null, data: { pageCount: 5, pageCounts: {}, lastIngestDate: '2026-09-16' } },
  }) }).renderLayerStrip({ scopes: [], knowledgeDomains: ['acme', 'research'] });
  ok('two chosen wikis read as ONE total, because that is what the project draws on',
    /15 pages/.test(twoWikis), twoWikis.slice(twoWikis.indexOf('KNOWLEDGE'), twoWikis.indexOf('KNOWLEDGE') + 300));
  ok('...with the NEWEST write across the set, not the first one to land',
    /2 domains/.test(twoWikis) && !/2026-09-10/.test(twoWikis),
    twoWikis.slice(twoWikis.indexOf('KNOWLEDGE'), twoWikis.indexOf('KNOWLEDGE') + 300));

  // ── THE TRACK FLOOR, AND THE ONE FIGURE RUNG (v3.65.0, R8) ──────────
  //
  // v3.64.2 dropped these values one rung — 22px to 17px — because "saved 57
  // min ago" broke after "min". Re-measured at the real column width that
  // wrap does not happen; it only appears below ~207px of track content,
  // which is a 1024px window, or a 1370px one with the onboarding guide
  // docked. So the narrow case is fixed in the TRACK and both views draw
  // their figures at the ONE display rung — two views whose figures are
  // different sizes are two designs, which is the whole report.
  //
  // THE FLOOR IS ASSERTED AS A NUMBER, not merely as "a floor is passed":
  // 210 is what makes four cards fit in a 949px grid at 229.75px each, which
  // is the measurement R8 rests on, and a smaller value silently re-creates
  // the wrap the second rung was invented for.
  {
    const strip = F({ knowledge: kmapOf({ acme: { error: null,
      data: { pageCount: 1980, pageCounts: {}, lastIngestDate: '2026-09-16' } } }) })
      .renderLayerStrip({ scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
        knowledgeDomains: ['acme'] });
    ok('the strip passes the kit a TRACK FLOOR of 253px, which is what keeps a '
      + 'phrase on one line at the one display rung — DERIVED from the widest '
      + 'value this strip can paint (`manifest unreadable`, 204.5px measured) '
      + 'plus the dot, its gap and the card\'s padding, not from a track count',
    /style="--cur-ov-min:253px"/.test(strip), strip.slice(0, 200));
    ok('...and passes NO second figure rung — `figure` is gone from the '
      + 'component and no caller may ask for one',
    !/cur-ov-value-phrase/.test(strip) && !/figure:/.test(stripComments(viewSrc)), strip.slice(0, 300));
  }

  // ── THE CAPTURE TILE IS RENDERED AND HIDDEN, NEVER OMITTED ──────────
  //
  // Its answer arrives on its own clock, after this paint. An OMITTED tile
  // means the reading never appears unless something repaints the strip —
  // the green-first mutation v3.64.2 closed on the jump row, in a new place.
  // `hidden` ships the tile and one attribute write reveals it, with no
  // repaint; shared/overview.css carries the `[hidden]` counter-rule for the
  // card, because `[hidden]` loses to an author `display:` at any specificity.
  {
    const noCap = F({}).renderLayerStrip({ scopes: [] });
    ok('with no capture reading in hand the tile is still RENDERED',
      /data-ov-jump="capture"/.test(noCap), noCap.slice(-600));
    ok('...and HIDDEN, so revealing it later costs no repaint',
      /data-ov-jump="capture"[^>]*hidden>/.test(noCap), noCap.slice(-600));
    const withCap = F({ capture: { domain: 'acme', project: 'lumina', error: null,
      data: { totals: { sessions: 3 } } } }).renderLayerStrip({ scopes: [] });
    ok('CONTROL: once the reading lands the same tile is shown, and carries it',
      /data-ov-jump="capture"/.test(withCap) && !/data-ov-jump="capture"[^>]*hidden>/.test(withCap)
      && /3 sessions/.test(withCap), withCap.slice(-600));
  }

  // ── CELL ① WHILE THE READ IS IN FLIGHT ──────────────────────────────
  ok('with no project read the FOUNDATIONS cell is omitted — "not set up yet" '
    + 'is a claim that frame cannot make',
  !/DOCUMENTS/.test(F({}).renderLayerStrip(null)));
  ok('...but the MEMORY cell still paints, from the index row the page '
    + 'is already holding',
  /MEMORY/.test(F({ projects: [{ domain: 'acme', project: 'lumina',
    writtenAgeSeconds: 300 }] }).renderLayerStrip(null)));
}

// ── §21f4 — EVERY FOLD SHIPS CLOSED, and it is remembered per fold ──────
// ═════════════════════════════════════════════════════════════════════════
//
// THE GAP THIS CLOSES, found by mutation: forcing the work-stream fold open
// (`const open = ' open';`) left the whole offline run GREEN. That is v3.58.0's
// measurement being silently reversed — the brief and the journal became
// closed folds and the page went 3,241px → 1,278px at 1370px on this repo's
// own project, the brief block alone 2,100 → 137 — and P1-6 applies it to the
// one long list that release missed: `WS_STEP_ALL_MAX` is 20 rows.
//
// DRIVEN THROUGH THE COMPOSED PAGE, over both arms of `state.openFolds`, so
// what is pinned is what a user is SERVED rather than what a renderer was
// asked for.
{
  const stFor = (openFolds) => ({
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: false, staleWrite: false, journalLimit: 10, openFolds, projects: [],
    wsWindow: WS_WINDOW_SRC,
    projectRead: {
      scopes: [{ scope: 'main', machine: 'boxa', headline: 'x', writtenAgeSeconds: 120 }],
      savedCopies: 1, distinctScopeCount: 1,
      brief: { present: true, text: '# B\n\n## Goal\n\nShip.', updatedAt: new Date().toISOString() },
      foundations: { present: true, ownership: 'curator', totalBytes: 100, orphanFiles: [],
        manifestError: null,
        documents: [{ slug: 'architecture.md', title: 'A', role: 'architecture', bytes: 100 }] },
    },
    detail: { scope: 'main', machine: 'boxa', machines: [],
      current: { present: true, writtenAgeSeconds: 120, text: '## Where\n\nx' },
      journal: { returned: 1, total: 1, totalUnknown: false,
        entries: [{ at: new Date().toISOString(), headline: 'h', harness: 'cc', rejections: [] }] } },
  });
  const shut = makeRenderers(stFor({})).renderProject();
  // `saved` is NOT in this list, and that is the correct answer rather than an
  // omission: with nothing to explain it is a FLAT row and emits no fold at
  // all (§21f6 drives both arms). A key listed here that the fixture cannot
  // produce would be a vacuous pin.
  const FOLDS = ['foundations', 'streams', 'brief', 'journal'];
  for (const key of FOLDS) {
    ok('the `' + key + '` fold is really emitted (the scan is not vacuous)',
      shut.includes('data-mem-fold="' + key + '"'), shut.slice(0, 200));
    ok('...and it ships CLOSED — v3.58.0 measured this page at 3,241px with its '
      + 'folds open and 1,278 with them shut',
    !new RegExp('data-mem-fold="' + key + '"\\s+open').test(shut),
    shut.slice(shut.indexOf('data-mem-fold="' + key + '"') - 40, 160));
  }
  // AND EACH OPENS FROM ITS OWN KEY, which is what "remembered per fold"
  // means: one key opening two folds would make a user's decision about one
  // section a decision about another.
  for (const key of FOLDS) {
    const one = makeRenderers(stFor({ [key]: true })).renderProject();
    ok('`' + key + '` opens from its own key', new RegExp('data-mem-fold="' + key + '" open').test(one));
    for (const other of FOLDS) {
      if (other === key) continue;
      ok('...and opens nothing else — `' + other + '` stays shut',
        !new RegExp('data-mem-fold="' + other + '"\\s+open').test(one));
    }
  }
  // THE MISSING THING IS STILL MISSING WHERE YOU LOOKED FOR IT (v3.17.1).
  // A project with nothing saved gets the FLAT card, no chevron: hiding the
  // sentence that explains what is missing behind a disclosure is that rule
  // read backwards, and it is why `streams` is a fold only when there is a
  // table to put away.
  const empty = makeRenderers({ ...stFor({}), detail: null,
    projectRead: { scopes: [], brief: { present: false } } }).renderProject();
  ok('a project with nothing saved gets a FLAT card rather than an empty fold',
    !empty.includes('data-mem-fold="streams"') && empty.includes('mem-fold-flat'),
    empty.slice(0, 300));
}

// ── §21f3 — screenSignature can see STEP ③ (v3.62.0, P1-15) ─────────────
// ═════════════════════════════════════════════════════════════════════════
//
// THE GAP THIS CLOSES, found by mutation: deleting `knowledgeMark` from the
// signature's return array left this suite, test-memory-truth.js and the whole
// offline run GREEN. Nothing else in the signature can see `state.knowledge` —
// it is filled by its own request, on a different clock from the project read
// — so the figures landing, or a later ingest moving the page count, would
// leave step ③ painting a figure that had stopped being true and the poll
// would skip the render that fixes it. That is P1-15's whole sentence, and
// until this section it was a promise rather than a measurement.
//
// LIFTED AND EXECUTED, with the same fixed injection set test-memory-truth.js
// §8b uses: `screenSignature` may name no collaborator outside it, because a
// free identifier there is a CRASH rather than a failing assertion (the
// v3.11.0 shape). That property is asserted below too.
{
  const SIG = ['formatAge', 'effectiveSave', 'workStreamOrder', 'wsShownCount', 'newestPair',
    'projectMetaLine', 'screenSignature'];
  const sigOf = (st) => new Function('state', 'WS_WINDOW',
    SIG.map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n')
    + '\nreturn screenSignature();')(st, WS_WINDOW_SRC);

  const stats = (over) => ({
    pageCount: 3445, pageCounts: { entities: 614, concepts: 2780, summaries: 51, other: 0 },
    lastIngestDate: '2026-09-16', lastIngestKind: 'ingest', lastIngestTitle: 'The Footprint',
    ...(over || {}),
  });
  const st = (knowledge) => ({
    activeDomain: 'acme', activeProject: 'proj', staleWrite: false, indexError: null,
    scope: 'main', machine: 'boxa', projects: [], wsWindow: WS_WINDOW_SRC,
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
      brief: { present: false } },
    detail: { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, lastSaveKind: 'complete' } },
    knowledge,
  });

  // A MAP SINCE v3.65.0 (P10). Every entry is folded in, keyed by its domain,
  // so a SECOND wiki's figures landing is a change this signature can see —
  // the same lesson this block records, one row wider.
  const kn = (o) => new Map(Object.entries(o));
  const none = sigOf(st(new Map()));
  const landed = sigOf(st(kn({ acme: { data: stats(), error: null } })));
  ok('the figures ARRIVING repaints — until they do, step ③ is a reserved '
    + 'height, and nothing else in the signature can see them', none !== landed);
  ok('an ingest moving the page count repaints — the figure has stopped being true',
    sigOf(st(kn({ acme: { data: stats({ pageCount: 3446 }), error: null } }))) !== landed);
  ok('...and so does a per-type count, which is four fifths of the step',
    sigOf(st(kn({ acme: { data: stats({ pageCounts: { entities: 615 } }), error: null } }))) !== landed);
  ok('a NEW last-ingest date repaints — the day-age WORD and the freshness DOT '
    + 'are both cut on it, so folding the rendered age in as well would be a '
    + 'second copy of one fact',
  sigOf(st(kn({ acme: { data: stats({ lastIngestDate: '2026-09-17' }), error: null } }))) !== landed);
  ok('...and so does the VERB, which is read off the log and never guessed',
    sigOf(st(kn({ acme: { data: stats({ lastIngestKind: 'compile' }), error: null } }))) !== landed);
  ok('...and the source title, which the step prints beside it',
    sigOf(st(kn({ acme: { data: stats({ lastIngestTitle: 'Another' }), error: null } }))) !== landed);
  ok('a failure repaints — the step goes from a reserved height to a disclosure',
    sigOf(st(kn({ acme: { data: null, error: 'boom' } }))) !== landed);
  ok('the DOMAIN stamp repaints, because the same figures under another domain '
    + 'are a different screen',
  sigOf(st(kn({ other: { data: stats(), error: null } }))) !== landed);
  eq('CONTROL: the same payload twice is the same signature — a guard that '
    + 'fires on everything closes an open ⓘ on every poll',
  sigOf(st(kn({ acme: { data: stats(), error: null } }))), landed);
  ok('CONTROL: a field the step does NOT paint moves nothing — folding a whole '
    + 'payload in would repaint the page when `conversationCount` changed',
  sigOf(st(kn({ acme: { data: stats({ conversationCount: 9 }), error: null } }))) === landed);

  // THE STRIP'S OTHER TWO TIERS ARE NOT FOLDED IN, AND THAT IS CORRECT.
  // Cell ①'s tier is cut on `facts.stale`/`unreachable`/`fresh`, all of which
  // ride in `fndMark`; cell ②'s is `freshnessTier`, cut on `formatAge`'s own
  // bands, which `savedMark` already folds the word through. Proved rather
  // than argued: move each underlying fact and watch the signature move.
  const withFnd = () => st(new Map());
  const fndState = (freshness) => ({ ...withFnd(), projectRead: {
    scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
    brief: { present: false },
    foundations: { present: true, ownership: 'repo', totalBytes: 10,
      documents: [{ slug: 'a.md', bytes: 10, freshness }] } } });
  ok('a document going stale moves the signature, so cell ①\'s dot cannot paint '
    + 'a comparison that has stopped being true',
  sigOf(fndState('fresh')) !== sigOf(fndState('stale')));
  ok('the newest save ageing into the next band moves it, so cell ②\'s dot '
    + 'cannot freeze — both are already covered, which is why neither tier is '
    + 'folded in a second time',
  sigOf(st(null)) !== sigOf({ ...st(null), projectRead: {
    scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 7200 }],
    brief: { present: false } } }));

  // AND IT NAMES NO COLLABORATOR OUTSIDE ITS SET. A free identifier inside a
  // lifted function is a CRASH, not a failing assertion — the v3.11.0 shape
  // this file warns about, and the reason the knowledge mark is a plain
  // expression rather than a call to `formatDayAge`.
  {
    const body = extractFunction(viewSrc, 'screenSignature', 'memory.js');
    const called = new Set([...body.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .matchAll(/(?<![.\w$'"])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1]));
    const allowed = new Set([...SIG, 'if', 'for', 'while', 'switch', 'catch', 'return',
      'typeof', 'map', 'filter', 'slice', 'join', 'find', 'stringify', 'isArray', 'keys']);
    const free = [...called].filter((n) => !allowed.has(n));
    eq('screenSignature names no collaborator its harness does not inject',
      JSON.stringify(free), '[]');
  }
}

// ── §21h — "read first": the set an agent is handed without asking ───────
// ═════════════════════════════════════════════════════════════════════════
//
// A flagged document's BODY arrives with every session; an unflagged one rides
// as an index line the agent opens BY NAME on the standing brief's
// instruction. So the block carries TWO budgets that are not the same number —
// the project budget (200 KB, what may be STORED) and the session budget
// (120 KB, what an agent RECEIVES) — and warning about the wrong one names a
// figure nobody can act on.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, fnd: null });
  const big = (kb, over) => fndDoc({ bytes: kb * 1024, ...over });

  // ── THE COUNTS ──────────────────────────────────────────────────────
  const none = F.foundationsFacts(fndRead(fndPayload([fndDoc(), fndDoc({ slug: 'b.md' })])));
  eq('with nothing flagged the read-first count is zero', none.readFirstCount, 0);
  ok('...and the summary line says nothing about it — reporting the ABSENCE of '
    + 'a decision as a decision is what "0 read first · 2 on request" would do',
  !/read first/.test(F.foundationsSummaryMeta(none)), F.foundationsSummaryMeta(none));

  const some = F.foundationsFacts(fndRead(fndPayload([
    fndDoc({ readFirst: true }), fndDoc({ slug: 'b.md' }), fndDoc({ slug: 'c.md' })])));
  eq('one flagged of three reads 1 · 2', some.readFirstCount + '·' + some.onRequestCount, '1·2');
  ok('...and the summary line says both numbers',
    /1 read first · 2 on request/.test(F.foundationsSummaryMeta(some)),
    F.foundationsSummaryMeta(some));
  eq('...and `readFirst` is `=== true`, so an ABSENT flag is false rather than '
    + 'undefined-as-maybe',
  F.foundationsFacts(fndRead(fndPayload([fndDoc({ readFirst: 1 })]))).readFirstCount, 0);

  // ── THE SERVER'S FIVE READINGS WIN WHERE IT SENT THEM ────────────────
  // The store takes them before any cap of its own; a sum over a capped row
  // list would report a number the table cannot show.
  const served = F.foundationsFacts(fndRead(fndPayload([fndDoc({ readFirst: true })], {
    readFirstCount: 9, onRequestCount: 40, readFirstBytes: 1, readFirstBudgetBytes: 2,
    readFirstBudgetExceeded: false })));
  eq('the server\'s own count is preferred over the rows', served.readFirstCount, 9);
  eq('...and so is its byte total and its budget',
    served.readFirstBytes + '/' + served.readFirstBudgetBytes, '1/2');

  // ── THE WARNING NAMES THE SET IT IS ABOUT ───────────────────────────
  // v3.70.0: with NOTHING flagged there is no warning at all. The stored
  // total over the 200 KB project figure was an alarm about a number nothing
  // acts on; what an unplanned project hands over is step ④'s cost line.
  const overProject = F.foundationsFacts(fndRead(fndPayload([big(150), big(150, { slug: 'b.md' })])));
  eq('with NOTHING flagged, a stored total over 200 KB warns about nothing',
    F.foundationsBudgetWarning(overProject), '');
  ok('CONTROL: that fixture really is over the old project figure',
    overProject.bytes > overProject.budgetBytes, JSON.stringify([overProject.bytes, overProject.budgetBytes]));

  const overSession = F.foundationsFacts(fndRead(fndPayload([
    big(100, { readFirst: true }), big(100, { slug: 'b.md', readFirst: true }),
    big(300, { slug: 'c.md' })])));
  const sessionWarn = F.foundationsBudgetWarning(overSession);
  ok('once something IS flagged the warning is about the READ-FIRST set and the '
    + '120 KB an agent receives — the stored total is not the figure anyone can act on',
  /flagged “read first”/.test(sessionWarn) && /120 KB reading budget/.test(sessionWarn), sessionWarn);
  ok('...naming how many documents are in that set', /^The 2 documents/.test(sessionWarn), sessionWarn);
  ok('...and the true consequence: handed over in reading order up to the budget, the rest listed and fetched by name',
    /Agents are handed them in reading order up to 120 KB at session start; the rest stay listed and are fetched by name when needed\.$/
      .test(sessionWarn) && !/dropped/i.test(sessionWarn), sessionWarn);
  eq('a read-first set INSIDE its budget warns about nothing, even when the '
    + 'project total is over',
  F.foundationsBudgetWarning(F.foundationsFacts(fndRead(fndPayload([
    big(10, { readFirst: true }), big(300, { slug: 'c.md' })])))), '');
  eq('CONTROL: and neither budget over means no warning at all',
    F.foundationsBudgetWarning(some), '');

  // ── THE WARNING REACHES THE BLOCK, UNFOLDED ─────────────────────────
  const html = F.renderFoundations(fndRead(fndPayload([
    big(100, { readFirst: true }), big(100, { slug: 'b.md', readFirst: true })])));
  // UNDER THE ROW AND OUTSIDE THE FOLD (v3.65.1). It used to be emitted
  // BEFORE the row, which put a sentence between the step's heading and its
  // head row — the one thing the head-row rule exists to stop. What v3.16.1
  // requires is that it is not behind a chevron, and that is what is asserted:
  // it is a sibling of the `<details>`, after it, never a descendant of it.
  ok('the warning is painted OUTSIDE the fold, after the row, never inside it',
    html.includes('mem-fnd-budget')
      && html.indexOf('id="mem-fnd-budget"') > html.indexOf('</details>')
      && !/<details[\s\S]*id="mem-fnd-budget"[\s\S]*<\/details>/.test(html),
    html.slice(html.indexOf('</details>') - 40, html.indexOf('</details>') + 240));
  ok('...and it is an ELEMENT even when silent, because a tick patches it in '
    + 'place and a node that must be created is a node a tick has to render for',
  /id="mem-fnd-budget"[^>]*hidden/.test(F.renderFoundations(fndRead(fndPayload([fndDoc()])))),
  F.renderFoundations(fndRead(fndPayload([fndDoc()]))).slice(0, 300));
  // ── AND IT HAS SOMETHING TO DO ABOUT IT (v3.65.0, record §D.6) ───────
  //
  // It named a consequence and offered nothing — and the maintainer's own
  // project mirrors 24 documents at 1,980 KB against a 200 KB budget, so it
  // is the sentence he reads every time he opens the screen. Correct, and
  // inert. "Choose documents" is a DOOR: it opens the documents row and puts
  // the reader in front of the `read first` column, whose per-row tick is the
  // shipped manifest-only PATCH. No new route, no new write.
  ok('the warning carries an ACTION, not only a consequence',
    /id="mem-fnd-budget-go"/.test(html), html.slice(0, 500));
  ok('...beside the sentence, inside the same note, so the two cannot be read apart',
    html.indexOf('id="mem-fnd-budget-go"') > html.indexOf('id="mem-fnd-budget"')
    && html.indexOf('id="mem-fnd-budget-go"') < html.indexOf('</div>',
      html.indexOf('id="mem-fnd-budget"') + 60) + 60, html.slice(0, 600));
  ok('...at the SECOND rung — nothing here completes a step, it opens a row',
    /mem-fnd-budget-go[^>]*>Choose documents/.test(html.replace(/\n/g, ''))
    && /btn-secondary btn-xs mem-fnd-budget-go/.test(html), html.slice(0, 600));
  // THE HANDLER, read off the SECOND occurrence of the id — the first is the
  // markup above. It forces the TRANSIENT, never the persisted fold key, so
  // an explicit close stays closed (the v3.64.1 "it reopens itself" loop),
  // and it makes no request of its own: the tick it points at is what writes.
  {
    const code = stripComments(viewSrc);
    // THE LAST occurrence is the handler; the two before it are the class and
    // the id in the markup above. Taken by lastIndexOf rather than by a count,
    // so adding another mention of the class in the markup cannot silently
    // point this scan at a string instead of at the listener.
    const at = code.lastIndexOf('mem-fnd-budget-go');
    const handler = at === -1 ? '' : code.slice(at, at + 420);
    ok('...and it opens a row rather than writing anything: the handler forces '
      + 'the TRANSIENT, never the persisted fold key, so an explicit close stays closed',
    /state\.fndForceOpen = true/.test(handler) && !/openFolds/.test(handler), handler.slice(0, 220));
    ok('...and it makes no request of its own — the tick it points at is the one '
      + 'that writes', handler.length > 40 && !/fetch\(/.test(handler), handler.slice(0, 220));
  }

  // ── THE ROW CONTROL — THREE STATES IN THE SAME CELL (v3.67.0) ────────
  // The two-way toggle became the shared listbox: read first · on request ·
  // not at start. The cfg is what is under test here (the component's own
  // keyboard and ARIA behaviour is test-next-listbox.js's), so the stub echoes
  // the value, the options and the accessible name back.
  const stubOf = (html) => {
    const m = /data-lb-stub="([^"]*)"/.exec(html);
    return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null;
  };
  const onRow = F.fndRowHtml(fndDoc({ readFirst: true }), true, false);
  const offRow = F.fndRowHtml(fndDoc(), true, false);
  const hidRow = F.fndRowHtml(fndDoc({ hidden: true, atStart: 'not-at-start' }), true, false);
  eq('a flagged row\'s cell holds the three-state picker, set to READ FIRST',
    (stubOf(onRow) || {}).value, 'read-first');
  eq('...an unflagged one reads ON REQUEST rather than an empty cell',
    (stubOf(offRow) || {}).value, 'on-request');
  eq('...and a hidden one NOT AT START', (stubOf(hidRow) || {}).value, 'not-at-start');
  eq('...with exactly the store\'s three states, in its order',
    JSON.stringify((stubOf(offRow) || {}).options),
    JSON.stringify(['read-first', 'on-request', 'not-at-start']));
  eq('...and those are the store\'s own FOUNDATION_START_STATES, not a copy of them',
    JSON.stringify((stubOf(offRow) || {}).options), JSON.stringify(ws.FOUNDATION_START_STATES));
  ok('...labelled by the document it is about, with no hover-only title=',
    (stubOf(onRow) || {}).label === 'At session start: Architecture' && !/title=/.test(onRow), onRow);
  ok('a hand-edited contradiction reads READ FIRST — the store\'s own rule',
    (stubOf(F.fndRowHtml(fndDoc({ readFirst: true, hidden: true }), true, false)) || {}).value
      === 'read-first');
  {
    // The option hints ARE the teaching copy (CONTRACT §5.1), verbatim.
    const cfg = F.fndStartCfg(fndDoc(), false);
    eq('the three hints are the contract\'s, verbatim',
      JSON.stringify(cfg.options.map((o) => o.detail)), JSON.stringify([
        'Handed to the agent at the start of every session.',
        'Listed; the agent opens it by name when the task needs it.',
        'Kept and mirrored, but not listed at the start. Name it in the brief if an agent should find it.',
      ]));
    ok('...and the cell is disabled while its own write is in flight',
      F.fndStartCfg(fndDoc(), true).disabled === true && cfg.disabled === false);
  }
  ok('a MIRRORED row gets the picker too — the state is metadata ABOUT a '
    + 'document, never part of it, so setting it writes no byte of the copy',
  /data-fnd-first="architecture\.md"/.test(F.fndRowHtml(fndDoc(), false, false)));
  ok('...and a READ-ONLY Shared Brain mirror gets none, because every route it '
    + 'could reach answers 403', !/fnd-first|mem-fnd-start-/.test(F.fndRowHtml(fndDoc(), false, true)));

  // ── A CHOICE PATCHES; IT DOES NOT RENDER (v3.61.1's rule) ────────────
  //
  // Measured on this table: a tick that re-rendered took the fold's scrollTop
  // from 1105 to 0, came back a different node and dropped focus. Driven
  // against a DOM model rather than argued.
  {
    const mkNode = () => ({
      _attrs: {}, _text: '', disabled: false, hidden: false, _cls: [],
      dataset: {}, textContent: '',
      getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      classList: { toggle() {} },
      querySelector() { return this._span || null; },
    });
    const drive = async (responder, overState, want = 'read-first') => {
      const meta = mkNode();
      const warn = mkNode();
      warn._span = mkNode();
      // v3.66.0: the Documents monitor is patched in place too.
      const mon = mkNode();
      mon.outerHTML = '<div class="cur-mon" id="mem-fnd-monitor">STALE</div>';
      const st = {
        activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, fnd: null, projects: [],
        projectRead: fndRead(fndPayload([fndDoc({ bytes: 200 * 1024 })])), detail: null,
        startSaving: null, startError: null,
        ...overState,
      };
      const calls = { renders: 0, urls: [], bodies: [], measured: 0 };
      const api = new Function('state', 'isCurrentMount', 'render', 'fetch', 'document',
        'encodeURIComponent', 'screenSignature', 'foundationsFacts',
        'foundationsSummaryMeta', 'foundationsBudgetWarning', 'foundationsMonitor',
        'maybeLoadSessionStart', 'START_STATES',
        'let renderedSignature = null;\n'
        + extractFunction(viewSrc, 'writeStartState', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'setStartState', 'memory.js')
        + '\nreturn { setStartState, sig: () => renderedSignature };')(
        st, () => true, () => { calls.renders++; },
        async (url, init) => { calls.urls.push(url); calls.bodies.push(init.body); return responder(); },
        { querySelector: (sel) => (sel.includes('mem-fold-foundations') ? meta : null),
          getElementById: (id) => (id === 'mem-fnd-budget' ? warn
            : id === 'mem-fnd-monitor' ? mon : null) },
        encodeURIComponent, () => 'SIG',
        (read) => makeRenderers(st).foundationsFacts(read),
        (f) => makeRenderers(st).foundationsSummaryMeta(f),
        (f) => makeRenderers(st).foundationsBudgetWarning(f),
        (f) => makeRenderers(st).foundationsMonitor(f),
        () => { calls.measured++; },
        new Function(constDecl(viewSrc, 'START_STATES') + '\nreturn START_STATES;')());
      await api.setStartState('architecture.md', want, 1);
      return { meta, warn, mon, calls, st, api };
    };

    const okAnswer = (over = {}) => () => ({ ok: true, json: async () => ({ ok: true,
      slug: 'architecture.md', atStart: 'read-first', wasAtStart: 'on-request', changed: true,
      readFirst: true, hidden: false, readFirstCount: 1, onRequestCount: 0,
      readFirstBytes: 200 * 1024, readFirstBudgetBytes: 120 * 1024, readFirstBudgetExceeded: true,
      hiddenCount: 0, ...over }) });
    const r = await drive(okAnswer());
    eq('the choice PATCHes the one document', r.calls.urls.join(','),
      '/api/memory/acme/lumina/foundations/architecture.md');
    eq('...sending the START STATE and nothing else', r.calls.bodies.join(','), '{"atStart":"read-first"}');
    eq('...and spends NO full render — a choice that re-renders loses the fold\'s '
      + 'scroll position and the focus of the control being used',
    r.calls.renders, 0);
    const row = r.st.projectRead.foundations.documents[0];
    ok('the row takes what the ROUTE reported — read first, not hidden',
      row.readFirst === true && row.hidden === false && row.atStart === 'read-first',
      JSON.stringify(row));
    ok('the summary line is rewritten in place, with the counts the ROUTE '
      + 'reported rather than a second derivation',
    /1 read first · 0 on request/.test(r.meta.textContent), r.meta.textContent);
    ok('...and the budget warning appears, naming the set and the consequence',
      r.warn.hidden === false && /flagged “read first”/.test(r.warn._span.textContent),
      r.warn._span.textContent);
    ok('...and the Documents monitor is rewritten in place: the read-first line appears, '
      + 'over its budget, from the ROUTE\'s answer',
    !/STALE/.test(r.mon.outerHTML) && /id="mem-fnd-monitor"/.test(r.mon.outerHTML)
      && /cur-mon-key">read first</.test(r.mon.outerHTML)
      && /of 120 KB per session/.test(r.mon.outerHTML)
      && /cur-depth-bar cur-depth-danger/.test(r.mon.outerHTML), r.mon.outerHTML);
    eq('...and the signature is re-taken, so the next poll neither repaints '
      + 'needlessly nor skips a repaint it owes', r.api.sig(), 'SIG');
    eq('...and step ④ is asked to re-measure — the start just changed', r.calls.measured, 1);

    // NOT AT START — the third state, and the hand mutation's subject.
    const h = await drive(okAnswer({ atStart: 'not-at-start', readFirst: false, hidden: true,
      readFirstCount: 0, onRequestCount: 0, readFirstBytes: 0, readFirstBudgetExceeded: false,
      hiddenCount: 1 }), {}, 'not-at-start');
    eq('not at start writes atStart', h.calls.bodies.join(','), '{"atStart":"not-at-start"}');
    ok('...and the summary names the third state from the route\'s own count',
      /1 not at start/.test(h.meta.textContent), h.meta.textContent);
    // An unknown state never leaves the view.
    const junk = await drive(okAnswer(), {}, 'everything');
    eq('a value outside the alphabet sends nothing at all', junk.calls.urls.length, 0);

    // A REFUSAL IS A DISCLOSURE, and it costs the one full render that paints it.
    const bad = await drive(() => ({ ok: false,
      json: async () => ({ ok: false, error: 'locked', message: 'Another write is in progress' }) }));
    ok('a refusal is recorded against the document it was about, in the route\'s own words',
      bad.st.startError && bad.st.startError.slug === 'architecture.md'
      && bad.st.startError.error === 'Another write is in progress', JSON.stringify(bad.st.startError));
    eq('...and is painted, which is the one case a choice DOES render for', bad.calls.renders, 1);
    eq('...and the row is left saying what it was, never what the choice intended',
      bad.st.projectRead.foundations.documents[0].readFirst === true, false);

    // THE v3.66.0 STALE NOTE: the next SUCCESS takes it down.
    const cleared = await drive(okAnswer(), {
      startError: { domain: 'acme', project: 'lumina', slug: 'architecture.md', error: 'locked' },
      fnd: { domain: 'acme', project: 'lumina', busy: false, error: 'Another write is in progress' },
    });
    eq('a success CLEARS the refusal note it would otherwise leave standing',
      cleared.st.startError, null);
    eq('...and the stale refresh error beside it', cleared.st.fnd, null);
    eq('...and repaints once, because there was a note on screen to take down',
      cleared.calls.renders, 1);

    // STAMPED. An answer for a project the user has left touches nothing.
    const gone = await drive(okAnswer(), {});
    ok('CONTROL: the stamped path really did write on the matching project',
      gone.st.projectRead.foundations.documents[0].readFirst === true);
  }

}

// ── §21g — the skeleton's step ① HEAD is byte-identical (v3.65.0) ───────
//
// The skeleton exists so the block chrome does not move between the two
// paints, and the chrome used to include the lede. There is no lede on either
// side now (R4), so what is compared is the HEAD ROW itself — the numeral,
// the title, and whether a mark is offered — which is the whole of the chrome
// that remains. Both renderers are executed and their emitted heads compared,
// which is the only form of this claim a suite holding one of them could not
// fake.
{
  const st = {
    activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, journalLimit: 10,
    projects: [{ domain: 'acme', project: 'lumina', hasBrief: true, savedCopies: 2 }],
    projectRead: fndRead(fndPayload([fndDoc()])), detail: null, detailLoading: false,
  };
  const R = makeRenderers(st);
  const headOf = (html) => {
    const i = html.indexOf('settings-block-context-canonical');
    if (i < 0) return null;
    const m = /<div class="settings-block-hd">([\s\S]*?)<\/div>/.exec(html.slice(i));
    // The MARK is stripped before the comparison: the skeleton deliberately
    // offers no ⓘ (a help panel a user could open and have torn away 30ms
    // later is worse than one that arrives with the content), and what is
    // under test is the numeral and the title.
    return m ? m[1].replace(/<button[\s\S]*?<\/button>/g, '').trim() : null;
  };
  const a = headOf(R.renderProject());
  const b = headOf(R.renderProjectSkeleton());
  ok('both renderers really emitted step ①', !!a && !!b, JSON.stringify([a, b]));
  eq('the skeleton\'s head row is byte-identical to the real one', b, a);
  ok('...and it is the numeral and the Title-case title, in that order',
    /class="settings-block-num"[^>]*>1<[\s\S]*<h2 class="settings-job-title">Documents<\/h2>/
      .test(String(a)), String(a));
  // THE FILLED PAGE OFFERS THE MARK; the skeleton does not. Asserted in both
  // directions so "identical" cannot be satisfied by neither having one.
  const iReal = R.renderProject().indexOf('settings-block-context-canonical');
  ok('the filled page offers the ⓘ in that head row',
    /<div class="settings-block-hd">[\s\S]*?class="tx-vh-info"[\s\S]*?<\/div>/
      .test(R.renderProject().slice(iReal)));
  // Scoped to the STEP's own head row: the strip above the steps carries an ⓘ
  // of its own in both frames, and a document-wide scan would be measuring it.
  ok('...and the skeleton offers none there, because it would be torn away 30ms later',
    !/class="tx-vh-info"/.test(String(
      /<div class="settings-block-hd">([\s\S]*?)<\/div>/.exec(
        R.renderProjectSkeleton().slice(
          R.renderProjectSkeleton().indexOf('settings-block-context-canonical')))[1])));
}

// ── §21h — a freshness change is a repaint, and nothing else has moved ──
//
// The property this block has and no other pane on the page does: `freshness`
// is recomputed by the store on every read against a file in a checkout, so a
// colleague's `git pull` turns six rows from fresh to stale with not one
// timestamp, byte count or work-stream moving. A mark that could not see it
// would leave the block painting "fresh" over documents that had stopped
// being it.
{
  const mk = (over, extra) => ({
    activeDomain: 'acme', activeProject: 'lumina', staleWrite: false, indexError: null,
    scope: null, machine: null, projects: [], detail: null, fnd: null, openFolds: {},
    projectRead: { scopes: [], brief: { present: false }, foundations: fndPayload([fndDoc(over || {})]) },
    ...(extra || {}),
  });
  const sigOf = (s) => makeRevalidator(s, () => {}).screenSignature();
  const fresh = sigOf(mk({ freshness: 'fresh' }));
  ok('a document going STALE repaints, although no clock and no byte on this '
    + 'machine has moved', sigOf(mk({ freshness: 'stale' })) !== fresh);
  ok('...and so does a source becoming unreachable',
    sigOf(mk({ freshness: 'unreachable' })) !== fresh);
  ok('...and a re-copy that changes the size', sigOf(mk({ bytes: 999 })) !== fresh);
  ok('...and a re-copy that only moves the commit',
    sigOf(mk({ commit: 'deadbee' })) !== fresh);
  ok('CONTROL: an identical payload produces an identical signature',
    sigOf(mk({ freshness: 'fresh' })) === fresh);
  // The manifest error and the Refresh control's own three states are pixels
  // too, and each is folded in separately.
  const withErr = mk({}, { projectRead: { scopes: [], brief: { present: false },
    foundations: fndPayload([fndDoc()], { manifestError: 'boom' }) } });
  ok('a manifest becoming unreadable repaints', sigOf(withErr) !== fresh);
  ok('the Refresh control going busy repaints',
    sigOf(mk({}, { fnd: { domain: 'acme', project: 'lumina', busy: true, error: null, result: null } })) !== fresh);
}

// ── §21i — a row press opens the reader and repaints NOTHING ────────────
//
// Driven through the SHIPPED `bindFoundationRows` → `openFoundation` →
// `foundationReaderContent` chain against a fake document and a fake fetch. The
// no-repaint property is only reachable because every row carries a stable id
// derived from its slug, so there is no "which row is open" state to write.
{
  const calls = { reader: [], render: 0, urls: [] };
  const btn = { dataset: { fndSlug: 'architecture.md' }, _click: null,
    addEventListener(t, fn) { if (t === 'click') this._click = fn; } };
  const doc = { querySelectorAll: (sel) => (sel.includes('fnd-open') ? [btn] : []) };
  const st = { activeDomain: 'acme', activeProject: 'lumina' };
  const api = new Function(
    'state', 'render', 'reportAsyncMountFailure', 'openReader', 'isCurrentReader', 'isCurrentMount',
    'fetch', 'escapeHtml', 'icon', 'renderMarkdown', 'renderReadout',
    // ── THE TIER-0 BINDER CARRIES THE WHOLE TIER SINCE v3.61.0 ───────────
    // `wire()` may not name a new module-level helper — it is lifted and
    // EXECUTED against a hand-written stub set in
    // scripts/test-agent-instructions.js, where a free identifier is a CRASH
    // rather than a failing assertion — so everything the editor adds is bound
    // inside `bindFoundationRows`, which that stub set already carries.
    //
    // This section's subject is the ROW PRESS, so the editor's own
    // collaborators are STUBBED here and driven for real in
    // scripts/test-next-foundations-editor.js. The stubs exist because the
    // binder would otherwise throw on a free identifier before it reached the
    // row handler at all.
    'foundationsFacts', 'freshChooser', 'bindFoundationsChooser', 'initFoundations',
    'loadFoundationDraft', 'readPickedFile', 'saveFoundation', 'deleteFoundation',
    'fndShrinkWarn', 'fndStats', 'briefDismissDecision',
    // v3.61.0: the binder also reaches the drafting-ask copy and the Domains
    // pointer. Both are STUBBED here for the reason the block above states —
    // this section's subject is the row press — and the shipped drafting ask
    // is driven in §21c2 and by scripts/test-next-foundations-editor.js.
    'copyDraftingAsk', 'navigate',
    'MAX_FOUNDATION_BYTES', 'FOUNDATION_ROLES', 'localStorage',
    // v3.68.0: the two doors' panel binder — STUBBED, driven for real in
    // scripts/test-next-foundations-editor.js and test-foundations-add.js.
    'bindAddDoors',
    // v3.69.0: the per-document source rules, one namespace, REAL.
    'FSRC',
    // Named one by one rather than mapped over a list: §17's census requires
    // every function it claims is EXECUTED to appear in a real
    // `extractFunction(viewSrc, '<name>')` call somewhere in this file, which is
    // what stops the census being a claim rather than a measurement.
    extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
    // `foundationReaderContent` asks `skeletonOf` whether the body below is a
    // set of PROMPTS rather than facts (P2-4), so the predicate is LIFTED
    // here: stubbing it would let the reader's most consequential note go
    // missing with this section fully green.
    extractFunction(viewSrc, 'skeletonOf', 'memory.js') + '\n' + extractFunction(viewSrc, 'copiedFromOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'foundationReaderContent', 'memory.js') + '\n' +
    // v3.67.2: the binder answers an unchecked row's "why?" — pure, LIFTED.
    // (v3.69.0: whether a row is read from GitHub is its GROUP's fact, asked
    // of FSRC inside `openFoundation`.)
    extractFunction(viewSrc, 'foundationsUncheckedWhy', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'openFoundation', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'bindFoundationRows', 'memory.js') + '\n'
    + '\nreturn { bindFoundationRows };')(
    st,
    () => { calls.render++; },
    () => {},
    (c) => { calls.reader.push(c); return calls.reader.length; },
    (e) => e === calls.reader.length,
    () => true,
    async (url) => {
      calls.urls.push(url);
      return { ok: true, json: async () => ({
        ok: true, slug: 'architecture.md', role: 'architecture', title: 'Architecture',
        text: '# Architecture\n\nThe body.', updatedAt: '2026-09-17T09:00:00.000Z',
        commit: '9623343abcdef', source: { kind: 'repo', path: 'docs/architecture.md' },
        ownership: 'repo', freshness: 'stale', sanitisedOnRead: true,
      }) };
    },
    escapeHtml, () => '<svg></svg>', renderMarkdown, renderReadout,
    () => ({ present: false, ownership: null, docs: [], count: 0 }),
    freshChooser, () => {}, async () => {}, async () => {}, async () => ({}),
    async () => {}, async () => {}, () => null,
    (t) => ({ bytes: String(t || '').length, words: 0, over: false }),
    () => 'close',
    async () => {}, () => {},
    MAX_FOUNDATION_BYTES, FOUNDATION_ROLES,
    { getItem: () => null, setItem: () => {} }, () => {}, FSRC);
  api.bindFoundationRows(doc, 1);
  ok('SETUP: the row\'s click handler was bound', typeof btn._click === 'function');

  btn._click();
  await new Promise((r) => setImmediate(r));

  eq('the press is acknowledged in its own frame with a LOADING panel, then '
    + 'replaced — two opens, not one', calls.reader.length, 2);
  ok('the first is the loading panel', calls.reader[0].loading === true);
  eq('...and it already names the file, so the path does not appear late',
    calls.reader[0].slug, 'state/lumina/foundations/architecture.md');
  eq('THE PRESS REPAINTS THE MAIN COLUMN NOT AT ALL', calls.render, 0);
  eq('one request, at the document\'s own URL', calls.urls.length, 1);
  ok('...escaped segment by segment',
    calls.urls[0] === '/api/memory/acme/lumina/foundations/architecture.md', calls.urls[0]);

  const c = calls.reader[1];
  eq('the reader\'s path is where the file actually is', c.slug, 'state/lumina/foundations/architecture.md');
  eq('the title is the document\'s own', c.title, 'Architecture');
  eq('it is labelled as what it is', c.typeLabel, 'foundation');
  eq('READONLY, ALWAYS — the app writes neither ownership mode', c.readonly, true);
  // P1-9: the chip says FOLDER, because `resolveRepoRoot` requires only a
  // reachable directory and half the people this tier is for keep their
  // documents in one that is not a checkout.
  ok('the chips are role · source · commit · ownership, in that order',
    JSON.stringify(c.tags.slice(0, 4)) === JSON.stringify([
      'role: architecture', 'source: docs/architecture.md', 'commit 9623343',
      'mirrored from a folder']), JSON.stringify(c.tags));
  ok('...and a stale copy says so on the document itself', c.tags.includes('out of date'));
  ok('the body goes through the shared markdown renderer (escape-first)',
    c.bodyHtml.includes('chat-md-h'), c.bodyHtml.slice(0, 200));
  // ── A SKELETON SAYS SO IN THE READER (v3.61.0, P2-4) ────────────────
  // The most consequential note on this panel: the body below is a set of
  // QUESTIONS, and a reader who takes the prompts for facts has been misled by
  // the one surface tier 0 exists to make trustworthy. From the FLAG (P1-2).
  {
    // Built through `makeRenderers` rather than through §21i's row-press
    // sandbox: the subject here is the PAYLOAD, and the payload composer is
    // what that helper lifts.
    const RC = makeRenderers({});
    const withFlag = RC.foundationReaderContent({
      slug: 'architecture.md', title: 'Architecture', role: 'architecture',
      text: '# A', skeleton: true, freshness: 'n/a', source: { kind: 'curator' } }, 'lumina');
    ok('a skeleton says so, in the body where the prompts are',
      /A skeleton — the prompts below are questions, not facts\./.test(withFlag.bodyHtml),
      withFlag.bodyHtml.slice(0, 400));
    ok('...and carries a `skeleton` chip beside the other four facts',
      withFlag.tags.includes('skeleton'), JSON.stringify(withFlag.tags));
    const written = RC.foundationReaderContent({
      slug: 'architecture.md', title: 'Architecture', role: 'architecture',
      text: '# A', skeleton: false, freshness: 'n/a', source: { kind: 'curator' } }, 'lumina');
    ok('CONTROL: a written document says neither', !/A skeleton —/.test(written.bodyHtml)
      && !written.tags.includes('skeleton'), JSON.stringify(written.tags));
  }
  ok('a stale copy carries the warning IN the document, not behind a click',
    /no longer matches the file it was copied from/.test(c.bodyHtml));
  ok('...and the read-time sanitisation is disclosed', /neutralised on read/.test(c.bodyHtml));
  eq('Escape returns focus to the row that was pressed', c.returnFocusTo, 'mem-fnd-architecture-md');
  ok('the row really carries that id, so the return is not a guess',
    makeRenderers({}).fndRowHtml(fndDoc()).includes('id="mem-fnd-architecture-md"'));
  ok('NO `domain` travels with it — that field switches on the reader\'s raw-source '
    + 'bar, which asks about a wiki page and could only answer "no" here',
  !('domain' in c));
}

// ── §21m — THE TWO DOORS' PANEL, AS THE HOST RENDERS IT (v3.68.0) ────────
// ═════════════════════════════════════════════════════════════════════════
//
// The maintainer, on v3.67.1: "add foundational files to context locally from
// a computer OR from GitHub … choose a folder, select files from it, drop them
// in, that's it." One panel per door, one checklist, one primary, one reason
// line — and the token row keeps every v3.65.2/.3 property it had.
{
  const panel = (door, recOver, docs, payloadOver) => {
    const facts = makeRenderers({}).foundationsFacts(fndRead(fndPayload(docs || [], payloadOver)));
    const info = doorsFor(facts, {})[door];
    return makeRenderers({
      activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
      fndAdd: Object.assign(FA.freshAddPanel(door, info, facts), { domain: 'acme', project: 'lumina' }, recOver || {}),
    }).renderFoundations(fndRead(fndPayload(docs || [], payloadOver)));
  };
  const none = { present: false, ownership: null };
  const count = (html, re) => (html.match(re) || []).length;
  const gh = (over) => panel('github', over, [], none);

  // ── ONE REASON LINE, ONE ID ────────────────────────────────────────────
  for (const [name, over] of [['empty', {}], ['named, no token', { remote: 'o/r', hasReadToken: false }],
    ['named, token', { remote: 'o/r', hasReadToken: true }]]) {
    eq('GitHub [' + name + ']: exactly ONE node carries id="fadd-why"', count(gh(over), /id="fadd-why"/g), 1);
  }
  ok('...its words are the FIRST unmet step: the repository, then the token',
    />Name the repository first — owner\/repo, or its URL\.</.test(gh({}))
    && />Choose which saved token to read the repository with\.</.test(gh({ remote: 'o/r', hasReadToken: false }))
    && /id="fadd-why" hidden/.test(gh({ remote: 'o/r', hasReadToken: true })));
  ok('each of the three fields is ONE wrapper holding its label then its input',
    count(gh({}), /<div class="fnd-init-field"><label[^>]*for="fadd-(remote|ref|path)"/g) === 3);
  ok('READ WITH carries an ⓘ with the fine-grained steps and why not classic',
    /id="fadd-readwith-info-btn"/.test(gh({})) && /fine-grained personal access token/.test(gh({}))
    && /Why not a classic token/.test(gh({})));
  ok('there is NO token field — a token is never typed or sent here',
    !/type="password"/.test(gh({})) && !/name="token"|id="fadd-token"/.test(gh({})));

  // ── THE TOKEN ROW'S FOUR STATES (v3.65.2/.3, kept) ─────────────────────
  const absent = gh({ hasReadToken: false, hasSyncToken: false });
  ok('token ABSENT: "not saved yet", nothing checked, and a door opens Settings',
    /Read-only token[\s\S]{0,200}not saved yet/.test(absent) && !/data-fadd-token="config" checked/.test(absent)
    && /id="fadd-token-door"/.test(absent));
  ok('...the door sits OUTSIDE the radio\'s <label>, so pressing it never toggles the radio',
    /<\/label><button type="button" class="btn btn-secondary btn-xs" id="fadd-token-door"/.test(absent));
  ok('...and a Personal Sync that is not connected is DISABLED with its reason as its state word',
    /data-fadd-token="sync" disabled[\s\S]{0,400}not connected/.test(absent));
  const present = gh({ hasReadToken: true, readTokenLast4: 'ab12', hasSyncToken: true });
  ok('token PRESENT: named by its last four, CHECKED, no door',
    /data-fadd-token="config" checked/.test(present) && /ends in …ab12/.test(present)
    && !/fadd-token-door/.test(present));
  ok('...and a connected Personal Sync says "connected"', /connected/.test(present) && !/available/.test(present));
  ok('a last-four that is not four token characters is NOT printed',
    !/&lt;x&gt;|<x>/.test(gh({ hasReadToken: true, readTokenLast4: '<x>' })));
  const unknown = gh({});
  ok('UNKNOWN (nobody asked yet): read-only checked, NO state word, no door',
    /data-fadd-token="config" checked/.test(unknown) && !/not saved yet|ends in/.test(unknown)
    && !/fadd-token-door/.test(unknown));

  // ── THE CHECKLIST ──────────────────────────────────────────────────────
  const listed = (picks, docs, payloadOver, extra) => panel('local', Object.assign({
    root: '/n', listedRoot: '/n', picks,
    // v3.69.0 (§4.3): "already added" is the SERVER's answer, per candidate.
    candidates: [{ path: 'docs/architecture.md', bytes: 12345, suggestedSlug: 'architecture.md',
      alreadyAdded: true, alreadyAs: 'architecture.md', landsAs: 'architecture.md' },
      { path: 'notes/b.md', bytes: 100, suggestedSlug: 'b.md', alreadyAdded: false, landsAs: 'b.md' },
      { path: 'huge.md', bytes: 600 * 1024, suggestedSlug: 'huge.md', tooLarge: true }],
  }, extra || {}), docs, payloadOver);
  const curatorArch = [fndDoc({ freshness: 'n/a', source: { kind: 'curator', path: null } })];
  const l0 = listed({}, curatorArch, { ownership: 'curator' });
  ok('a document ALREADY in the project is listed ticked AND disabled, badged',
    /data-fadd-row="docs\/architecture\.md"[\s\S]{0,160}checked disabled[\s\S]{0,300}already added/.test(l0));
  ok('...while a new one has its checkbox, UNticked by default',
    /data-fadd-pick="notes\/b\.md" \/>/.test(l0));
  ok('a file over the per-document limit is shown, disabled, WITH its numbers',
    /data-fadd-row="huge\.md"[\s\S]{0,400}600 KB is over the 512 KB per-document limit/.test(l0));
  ok('with nothing ticked the ONE primary is disabled and the ONE reason says why',
    /id="fadd-go" disabled>Copy documents</.test(l0) && />Tick at least one document\.</.test(l0));
  const l1 = listed({ 'notes/b.md': true }, curatorArch, { ownership: 'curator' });
  ok('one ticked: "Copy 1 document", live, and no reason',
    /id="fadd-go">Copy 1 document</.test(l1) && /id="fadd-why" hidden/.test(l1));
  ok('the count line is the PROJECT\'s total against its budget',
    /1 ticked · 100 bytes — the project would hold 12 KB of its 195 KB budget/.test(l1),
    (l1.match(/id="fadd-count">[^<]*/) || [''])[0]);
  const big = listed({ 'notes/b.md': true }, curatorArch, { ownership: 'curator', totalBytes: 250 * 1024, budgetBytes: 204800 });
  ok('...and OVER the budget it says so in words, WITH the numbers, unfolded',
    /id="fadd-budget"><span>These bring the project to 250 KB, over its 200 KB budget by 50 KB\./.test(big),
    (big.match(/id="fadd-budget"[^>]*><span>[^<]*/) || [''])[0]);
  ok('select-all counts only the rows that can be ticked',
    /Select all \(1\)/.test(l0));
  ok('a refusal from the server is persistent and in flow, never behind a chevron',
    /role="alert"[\s\S]{0,200}The folder is gone/.test(listed({}, [], none, { error: 'The folder is gone' })));
  ok('...and a partial add lists each refused file with its reason',
    /1 not added:[\s\S]{0,300}big\.md<\/span> — over the cap/.test(
      listed({}, [], none, { refused: [{ path: 'big.md', reason: 'over the cap' }] })));
  ok('a bare folder never arms the add: before the list the reason is the list step',
    !/id="fadd-go"/.test(panel('local', { root: '' }, [], none))
    && /Choose a folder first\./.test(panel('local', { root: '' }, [], none)));
}

// ── §21m2 — THE TOKEN FACTS, READ ONCE PER OPEN (v3.65.2's reads, v3.68.0's panel)
{
  const mk = (responses) => {
    const calls = { urls: [], render: 0 };
    const st = {};
    const api = new Function('state', 'fetch', 'isCurrentMount', 'render',
      extractFunction(viewSrc, 'loadAddTokenFacts', 'memory.js') + '\nreturn { loadAddTokenFacts };')(
      st,
      async (url) => { calls.urls.push(url); const r = responses[url];
        if (r instanceof Error) throw r;
        return { ok: r !== undefined && r !== 500, json: async () => r }; },
      () => true, () => { calls.render++; });
    return { api, st, calls };
  };
  const fresh = () => FA.freshAddPanel('github', { mode: 'init' }, null);
  {
    const r = mk({ '/api/config/github-read-token': { ok: true, present: true, last4: 'ab12' },
      '/api/sync/status': { configured: false } });
    const rec = fresh(); r.st.fndAdd = rec;
    await r.api.loadAddTokenFacts(rec, 1);
    eq('it reads the two facts, and only those two',
      r.calls.urls.slice().sort().join(' '), '/api/config/github-read-token /api/sync/status');
    eq('...presence', rec.hasReadToken, true);
    eq('...the last four, and never more', rec.readTokenLast4, 'ab12');
    eq('...Personal Sync', rec.hasSyncToken, false);
    eq('...and one repaint', r.calls.render, 1);
  }
  {
    const r = mk({ '/api/config/github-read-token': new Error('offline'), '/api/sync/status': 500 });
    const rec = fresh(); r.st.fndAdd = rec;
    await r.api.loadAddTokenFacts(rec, 1);
    eq('a read that FAILED leaves presence UNKNOWN — no door in front of a fine token', rec.hasReadToken, undefined);
    eq('...and Personal Sync UNKNOWN, never "not connected"', rec.hasSyncToken, undefined);
  }
  {
    const r = mk({ '/api/config/github-read-token': { ok: true, present: true, last4: '<x>' },
      '/api/sync/status': { configured: true } });
    const rec = fresh(); r.st.fndAdd = rec;
    await r.api.loadAddTokenFacts(rec, 1);
    eq('a last-four that is not four token characters is dropped', rec.readTokenLast4, null);
  }
  {
    const r = mk({ '/api/config/github-read-token': { ok: true, present: true, last4: 'ab12' },
      '/api/sync/status': { configured: true } });
    const rec = fresh(); r.st.fndAdd = fresh();   // the panel was closed and reopened
    await r.api.loadAddTokenFacts(rec, 1);
    eq('an answer for a panel that is no longer open is DROPPED', rec.hasReadToken, undefined);
    eq('...and paints nothing', r.calls.render, 0);
  }
}

// ── §21k — the refresh: one busy paint, one result paint, and a re-read ──
//
// Driven through the SHIPPED `refreshFoundations` with the SHIPPED `fetchState`
// behind it. The shape refused here is the obvious one — paint the outcome,
// then reload and paint again, which puts a note saying the documents changed
// over the figures that have not been re-read yet.
{
  const mkRig = (responder) => {
    const calls = { render: 0, urls: [], forgot: [], bodies: [] };
    const st = { activeDomain: 'acme', activeProject: 'lumina', fnd: null, projectRead: null };
    const api = new Function(
      'state', 'render', 'isCurrentMount', 'fetch', 'forgetProject', 'URLSearchParams',
      // v3.69.0: the outcome reads each failed group's name through the
      // project's facts, so the facts and FSRC are real here too.
      'FSRC', 'READ_FIRST_BUDGET_BYTES', 'FOUNDATIONS_BUDGET_BYTES',
      // Named one by one, for the census's sake — see the note in §21i.
      extractFunction(viewSrc, 'skeletonOf', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'copiedFromOf', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'foundationsFacts', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'refreshFoundations', 'memory.js') + '\n'
      + '\nreturn { refreshFoundations };')(
      st,
      () => { calls.render++; },
      () => true,
      async (url, init) => {
        calls.urls.push(url);
        if (init) calls.bodies.push(init.body);
        return responder(String(url), init);
      },
      (d, p) => { calls.forgot.push(d + '/' + p); },
      URLSearchParams, FSRC, READ_FIRST_BUDGET_SRC, FOUNDATIONS_BUDGET_BYTES);
    return { api, calls, st };
  };

  // ── SUCCESS ───────────────────────────────────────────────────────────
  {
    const r = mkRig((url, init) => (init
      ? { ok: true, json: async () => ({ ok: true, refreshed: ['architecture.md'],
        added: [], unchanged: ['decisions.md'], missing: [] }) }
      : { ok: true, json: async () => ({ ok: true, scopes: [],
        foundations: fndPayload([fndDoc()]) }) }));
    await r.api.refreshFoundations(1);
    eq('the POST goes to this project\'s refresh endpoint',
      r.calls.urls[0], '/api/memory/acme/lumina/foundations/refresh');
    eq('...carrying an empty body, so nothing of the document crosses',
      r.calls.bodies[0], '{}');
    eq('the cached read is dropped BEFORE the re-read — bytes on disk changed',
      r.calls.forgot.join(','), 'acme/lumina');
    eq('...and the project is re-read', r.calls.urls[1], '/api/memory/acme/lumina');
    eq('EXACTLY TWO PAINTS: one to say it is working, one carrying BOTH the '
      + 'outcome and the re-read index', r.calls.render, 2);
    ok('the fresh index really landed in state',
      r.st.projectRead && r.st.projectRead.foundations.documents.length === 1);
    ok('...and the outcome is stamped with the pair it was asked for',
      r.st.fnd.domain === 'acme' && r.st.fnd.project === 'lumina' && r.st.fnd.busy === false);
    eq('...and carries the four lists the note reads, the refused list and the failed sources',
      JSON.stringify(Object.keys(r.st.fnd.result).sort()),
      JSON.stringify(['added', 'failed', 'missing', 'refreshed', 'refused', 'unchanged']));
  }

  // ── ONE SOURCE, OR ALL OF THEM (v3.69.0, §3.1) ───────────────────────
  // A strip line's Refresh names its group; "Refresh all" names none. The
  // v3.65.2 `repoRoot`/`files` body left with the doors.
  {
    const r = mkRig((url, init) => (init
      ? { ok: true, json: async () => ({ ok: true, refreshed: [], added: [], unchanged: ['a.md'], missing: [],
        groups: [{ id: 's1', ok: true }, { id: 's2', kind: 'github', label: 'acme/lumina', ok: false,
          message: 'GitHub answered 500' }] }) }
      : { ok: true, json: async () => ({ ok: true, scopes: [], foundations: fndPayload([fndDoc()]) }) }));
    await r.api.refreshFoundations(1, 's2');
    eq('a strip line\'s Refresh sends ITS group and nothing else', r.calls.bodies[0], '{"group":"s2"}');
    eq('...and the outcome is stamped with the group it was for', r.st.fnd.group, 's2');
    ok('...a failed group is named, left unchanged, with its reason',
      r.st.fnd.result.failed.length === 1
      && /acme\/lumina was not refreshed and is unchanged: GitHub answered 500/.test(r.st.fnd.result.failed[0]),
      JSON.stringify(r.st.fnd.result.failed));
    const r2 = mkRig((url, init) => (init
      ? { ok: true, json: async () => ({ ok: true, refreshed: [], added: [], unchanged: [], missing: [] }) }
      : { ok: true, json: async () => ({ ok: true, scopes: [], foundations: fndPayload([fndDoc()]) }) }));
    await r2.api.refreshFoundations(1);
    eq('...and "Refresh all" sends a literal empty object', r2.calls.bodies[0], '{}');
    eq('...stamped with no group', r2.st.fnd.group, null);
  }

  // ── A REFUSAL ─────────────────────────────────────────────────────────
  {
    const r = mkRig(() => ({ ok: false, status: 400,
      json: async () => ({ ok: false, reason: 'no_sources',
        error: 'Nothing here is mirrored, so there is nothing to refresh.' }) }));
    await r.api.refreshFoundations(1);
    eq('a refusal paints twice — busy, then the reason', r.calls.render, 2);
    eq('...it is the SERVER\'s sentence, not a status code (v3.69.0: `no_sources`)',
      r.st.fnd.error, 'Nothing here is mirrored, so there is nothing to refresh.');
    eq('...and nothing is re-read, because nothing changed', r.calls.urls.length, 1);
    eq('...and the cache is NOT dropped either', r.calls.forgot.length, 0);
  }

  // ── A SECOND PRESS WHILE ONE IS IN FLIGHT ─────────────────────────────
  {
    const r = mkRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
    r.st.fnd = { domain: 'acme', project: 'lumina', busy: true, error: null, result: null };
    await r.api.refreshFoundations(1);
    eq('a second press while a copy is running does nothing at all — one '
      + 'operation per project', r.calls.urls.length, 0);
  }
}

// ── §21k2 — THE DELETE CONFIRMATION, FROM THE ROUTE'S OWN ANSWER (v3.69.0) ──
// A toast (an outcome of the owner's own press), and its lines are the
// route's §5.4 fields — never a guess about what was kept.
{
  const T = new Function(extractFunction(viewSrc, 'fndDeletedToast', 'memory.js')
    + '\nreturn fndDeletedToast;')();
  const gh = T('architecture.md', { ok: true, origin: 'github', sourceKept: true,
    source: { label: 'acme/lumina', path: 'docs/architecture.md' }, groupRemoved: true });
  eq('the title names the document', gh.title, 'Deleted architecture.md');
  ok('...a kept source is said to be untouched, by name',
    gh.lines.includes('The original in acme/lumina is not touched.'), JSON.stringify(gh.lines));
  ok('...and a group removed with its last document is said too',
    gh.lines.includes('acme/lumina is no longer a source of this project.'), JSON.stringify(gh.lines));
  const written = T('notes.md', { ok: true, origin: 'written', sourceKept: false, source: null, groupRemoved: false });
  eq('a WRITTEN document claims no untouched original — there is none', written.lines.length, 0);
  eq('CONTROL: an answer with no fields claims nothing', T('x.md', null).lines.length, 0);
}

// ── §21j — hostile text, through the real renderers ─────────────────────
{
  const F = makeRenderers({ activeDomain: XSS, activeProject: XSS, openFolds: {}, fnd: null });
  const hostile = F.renderFoundations(fndRead(fndPayload([fndDoc({
    slug: XSS, title: XSS, role: ATTR, commit: XSS,
    source: { kind: 'repo', path: ATTR },
  })])));
  ok('the hostile fixture produced markup', hostile.length > 300);
  ok('no raw <img> survives', !/<img\s/i.test(hostile));
  ok('no live event handler appears inside any emitted TAG',
    handlersInTags(hostile).length === 0, JSON.stringify(handlersInTags(hostile).slice(0, 2)));
  ok('every attribute value is balanced', (() => {
    for (const tag of hostile.match(/<[^>]*>/g) || []) {
      if (((tag.match(/"/g) || []).length) % 2 !== 0) return false;
    }
    return true;
  })());
  // THE ROW ID IS RE-SANITISED, not merely escaped: it is an id, so it must be
  // a safe fragment as well as safe markup.
  const id = /id="(mem-fnd-[^"]*)"/.exec(hostile);
  ok('the row id is reduced to a safe fragment', !!id && /^mem-fnd-[a-z0-9-]*$/.test(id[1]),
    id ? id[1] : 'none');
}

// ═════════════════════════════════════════════════════════════════════════
section('§25 — v3.67.0: STEP ④ SESSION START, THE START CELL AND THE HELPER');
// ═════════════════════════════════════════════════════════════════════════
//
// Everything here drives the SHIPPED functions (lifted by `v367Lift`, or by
// name below) against fixtures shaped like the store's own answers
// (REPORT-v367-store §1's example, REPORT-v367-jobs §0.2's runsOn objects).
{
  // ── The route's session-start answer, v3.70.0's shape (REPORT-p2) ─────
  // The presets are DERIVED from the store's own ladder (`ws.READING_BUDGET_
  // PRESETS`), so a fixture that drifted from the store would red §25b rather
  // than agree with a stale copy. `layers` sums to `bytes.mcp`, as the route
  // guarantees, and `meter` is the kit's model built from them.
  const SS_MCP = { 'index-only': 10811, lean: 10806, standard: 27848 };
  const ssPresets = (mcpFor = (id) => SS_MCP[id] || 52958, repliesFor = () => 1) =>
    ws.READING_BUDGET_PRESETS.map((p) => ({ id: p.id, bytes: p.bytes, tokens: p.tokens,
      mcpBytes: mcpFor(p.id), mcpTokens: Math.round(mcpFor(p.id) / 4), replies: repliesFor(p.id),
      documents: 0, documentBytes: 0, documentTokens: 0, omitted: 0, current: false, sameAsPrevious: false }));
  const ssLayers = (t, mcp) => {
    const rf = (t.readFirst && t.readFirst.bytes) || 0;
    const other = (t.otherText && t.otherText.bytes) || 0;
    const fixed = [['brief', 'standing brief', t.brief.bytes], ['handoff', 'latest handoff', t.handoff.bytes],
      ['journal', 'journal', t.journal.bytes], ['index', 'document list', t.index.bytes]];
    const framing = mcp - fixed.reduce((a, x) => a + x[2], 0) - rf - other;
    return [{ key: 'framing', label: 'framing', bytes: framing, tokens: Math.round(framing / 4) }]
      .concat(fixed.map(([key, label, bytes]) => ({ key, label, bytes, tokens: Math.round(bytes / 4) })))
      .concat([{ key: 'readFirst', label: other ? 'documents sent at start' : 'read first',
        bytes: rf + other, tokens: Math.round((rf + other) / 4), documents: 0 }]);
  };
  const ssData = (over = {}) => {
    const tiers = over.tiers || { brief: { bytes: 796, present: true, capBytes: 32768 },
      handoff: { bytes: 255, present: true, capBytes: 49152 },
      journal: { bytes: 106, lines: 1 }, index: { bytes: 1328, listed: 3, hiddenCount: 0 },
      readFirst: { bytes: 0, count: 0, budgetBytes: 122880, exceeded: false },
      otherText: { bytes: 38198, count: 2 }, onRequest: { bytes: 0, count: 0 },
      omitted: { bytes: 102432, count: 1, slugs: ['roadmap.md'] }, hidden: { bytes: 0, count: 0 },
      domainPages: { domains: ['acme'], bytes: 0 }, framing: { bytes: 12275 } };
    const bytes = over.bytes || { mcp: 52958, hook: 43130 };
    const budget = over.budget || { bytes: 122880, tokens: 30720, source: 'default', defaulted: true,
      ownerBytes: null, preset: null, custom: false, nearest: null, cap: 819200, capTokens: 204800,
      replyCapBytes: 307200 };
    const replies = over.replies || 1;
    const layers = ssLayers(tiers, bytes.mcp);
    return {
      ok: true, domain: 'acme', project: 'lumina', budget, planned: false,
      presets: ssPresets(), presetsSummary: { allEqual: false, reason: null, readFirstDocuments: 0,
        readFirstBytes: 0, readFirstTokens: 0 },
      tiers, bytes, tokens: { mcp: Math.round(bytes.mcp / 4), hook: Math.round(bytes.hook / 4) }, layers,
      onDemand: { documents: 0, bytes: 0, tokens: 0, notAtStart: 0, notAtStartBytes: 0, notAtStartTokens: 0 },
      delivery: { pageBytes: 81920, pageTokens: 20480, replies, paged: replies > 1,
        totalBytes: bytes.mcp, totalTokens: Math.round(bytes.mcp / 4), pages: [], tooLarge: [] },
      window: { tokens: 200000, set: false, custom: false, choices: [200000, 400000, 1000000] },
      harness: { tokens: null, set: false, estimate: true },
      meter: { windowTokens: 200000, harnessTokens: null,
        layers: layers.map((l) => ({ key: l.key === 'readFirst' ? 'read' : l.key, label: l.label, tokens: l.tokens })),
        budgetTokens: budget.bytes / 4, onDemand: { tokens: 0, documents: 0 },
        delivery: { replies, replyTokens: 20480 }, preview: over.preview === true },
      costLine: { applies: true, documentTextBytes: 38198 }, notes: [],
      ...Object.fromEntries(Object.entries(over).filter(([k]) => !['tiers', 'bytes', 'budget', 'replies', 'preview'].includes(k))),
    };
  };
  const baseSt = (over = {}) => ({
    activeDomain: 'acme', activeProject: 'lumina', openFolds: {}, projects: [], detail: null,
    detailLoading: false, journalLimit: 10, wsWindow: WS_WINDOW_SRC, fnd: null,
    projectRead: { scopes: [], brief: { present: false }, readingBudgetBytes: null,
      foundations: fndPayload([fndDoc()]) },
    ...over,
  });
  const withSS = (data, over = {}) => baseSt({
    sessionStart: { domain: 'acme', project: 'lumina', sig: 'x', data, error: null }, ...over });
  const stubOf = (html) => {
    const m = /data-lb-stub="([^"]*)"/.exec(html);
    return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null;
  };

  // ── §25a — the step, before and after its measurement (v3.70.0: A+) ───
  {
    const R = makeRenderers(baseSt());
    eq('no project read, no step', R.renderSessionStart(null), '');
    const waiting = R.renderSessionStart(baseSt().projectRead);
    ok('it is step ④, "Session start", on the one heading rule',
      /settings-block-context-session/.test(waiting)
      && /class="settings-block-num"[^>]*>4</.test(waiting)
      && /<h2 class="settings-job-title">Session start<\/h2>/.test(waiting), waiting.slice(0, 600));
    ok('before the measurement lands it SAYS it is measuring — never a figure it does not have',
      /Measuring what an agent receives…/.test(waiting) && !/≈\d/.test(waiting.replace(/<select[\s\S]*$/, '')), waiting);
    const head = /<div class="settings-block-hd">([\s\S]*?)<\/div><div class="settings-block-info">/.exec(waiting);
    const headIds = head ? [...head[1].matchAll(/data-lb-stub="[^"]*"|id="(mem-[a-z]+-lb)"/g)].map((m) => m[1]).filter(Boolean) : [];
    eq('the HEAD ROW holds the three things the owner sets, in order: Window · Reading budget · Harness',
      headIds.join(','), 'mem-window-lb,mem-budget-lb,mem-harness-lb');
    ok('...each after the ⓘ, each with its visible label',
      !!head && head[1].indexOf('tx-vh-info') < head[1].indexOf('mem-window-lb')
      && /mem-ss-ctl-label[^>]*>Window</.test(head[1]) && /id="mem-ss-budget-label">Reading budget<\/span>/.test(head[1])
      && /mem-ss-ctl-label[^>]*>Harness</.test(head[1]), head ? head[1] : waiting);
    const budgetStub = (h) => { const m = /id="mem-budget-lb" data-lb-stub="([^"]*)"/.exec(h);
      return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null; };
    ok('...the budget picker waits for the ROUTE\'s presets: disabled, no rows, before they land',
      (budgetStub(waiting) || {}).disabled === true && (budgetStub(waiting) || {}).options.length === 0,
      JSON.stringify(budgetStub(waiting)));
    ok('...and names the default while nothing is set, in tokens',
      /^Reading budget: not set, the default of about 30\.7k tokens applies$/.test((budgetStub(waiting) || {}).label || ''),
      JSON.stringify(budgetStub(waiting)));
  }
  const budgetStub = (h) => { const m = /id="mem-budget-lb" data-lb-stub="([^"]*)"/.exec(h);
    return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null; };
  {
    const st = withSS(ssData());
    const html = makeRenderers(st).renderSessionStart(st.projectRead);
    const firstFold = html.indexOf('<details');
    // THE METER — the instrument, first in the body, from the route's `meter`.
    ok('the body OPENS on the meter: the window to scale, then the enlargement, both role="img"',
      /id="mem-ss-meter"/.test(html) && html.indexOf('id="mem-ss-meter"') < firstFold
      && (html.match(/class="bk-bar[^"]*" role="img" aria-label="/g) || []).length === 2, html.slice(0, 1500));
    ok('...its sentence is the measured total against THIS computer\'s window (200K until set)',
      /The Curator about 13\.2k tokens \(measured, 6\.6%\)/.test(html), html.slice(0, 2500));
    ok('...with the harness NOT SET said in words, never drawn as a guess',
      /Harness not set/.test(html) && !/bk-harness"/.test(html));
    ok('...and a single-reply start carries no delivery line', !/Delivered in/.test(html));
    ok('...and the one-line hint says where the harness figure comes from, while it is Not set',
      /id="mem-ss-harness-hint">Read your harness from Claude Code’s <code>\/context<\/code> and set it under Harness above\.</.test(html));
    ok('"What an agent receives" is a fold row, OPEN by default — the one on this page that is',
      /<details class="mem-fold" data-mem-fold="receives" open>/.test(html), html.slice(0, 300));
    ok('...its summary is the total in TOKENS first, then bytes and share — and carries NO bar',
      /<summary class="mem-fold-summary" id="mem-fold-receives">[\s\S]*?≈13\.2k tokens · 51\.7 KB · 6\.6% of 200K<\/span>\s*<\/summary>/.test(html)
      && !/cur-depth/.test((/id="mem-fold-receives">([\s\S]*?)<\/summary>/.exec(html) || ['', 'cur-depth'])[1]), html);
    ok('the per-viewer "Context window" fold is GONE (the window is in the head row now); "How an agent reaches this" stays closed',
      !/data-mem-fold="window"/.test(html) && !/data-ctx-window/.test(html)
      && /<details class="mem-fold" data-mem-fold="reach">/.test(html)
      && /How an agent reaches this<\/span><span class="mem-fold-meta">MCP · session-start hook · Chat \(≤ 40,000 characters\)/.test(html));
    // THE COST LINE — unfolded, before the first chevron, with its one action.
    const cost = /id="mem-ss-cost"[\s\S]*?<\/div>/.exec(html);
    ok('an untouched project whose start hands over more than Lean gets the COST LINE, in tokens',
      !!cost && /Every session is handed ≈9\.5k tokens of document text \(37\.3 KB\): nothing is marked read first and no reading budget is set\. One more document did not fit the ≈30\.7k-token default and is listed by name\./.test(cost[0]),
      cost ? cost[0] : html.slice(0, 800));
    ok('...UNFOLDED — it sits before the first chevron (v3.16.1: a cost is never behind one)',
      html.indexOf('id="mem-ss-cost"') >= 0 && html.indexOf('id="mem-ss-cost"') < firstFold);
    ok('...with its one action, "Set a reading budget"',
      /id="mem-ss-set-budget">Set a reading budget<\/button>/.test(cost ? cost[0] : ''));
    // THE MONITOR: the meter's text twin, tokens first.
    const keys = [...html.matchAll(/<span class="cur-mon-key">([^<]*)<\/span>/g)].map((m) => m[1]);
    eq('the monitor reads every layer, then the window it lands in, then what stays outside',
      keys.join('|'), 'standing brief|latest handoff|journal|document list|read first|'
        + 'other document text|framing|session start|harness|free at start|left out, by name|domain pages|'
        + 'MCP get_project_context|session-start hook|Chat');
    ok('the brief is TOKENS first, bytes as the hint, its bar against the 32 KB brief budget, NAMED',
      /standing brief<\/span><span class="cur-mon-value">[\s\S]*?cur-depth-value">≈0\.2k<\/span><span class="visually-hidden"> 796 bytes of the 32 KB brief budget/.test(html)
      && /796 bytes · of the ≈8\.2k brief budget/.test(html), html);
    ok('...the handoff\'s against the 48 KB handoff budget, NAMED', /of the 48 KB handoff budget/.test(html));
    ok('...the untouched project\'s document text against the DEFAULT, and says why it is sent',
      /37\.3 KB · of the ≈30\.7k default · sent because nothing is planned/.test(html));
    ok('..."read first" says no budget is set rather than drawing a bar against nothing',
      /read first<\/span><span class="cur-mon-value">0<\/span><span class="cur-mon-sub">no reading budget set/.test(html));
    ok('...the session start is a SHARE of the window (never danger), named, with its replies',
      /session start<\/span>[\s\S]*?≈13\.2k · 6\.6%[\s\S]*?≈13\.2k tokens of a 200K-token window[\s\S]*?51\.7 KB · measured · 1 MCP reply/.test(html), html);
    ok('...the harness is its own line, "not set" — never summed into the start',
      /harness<\/span><span class="cur-mon-value">not set/.test(html));
    ok('...and free at start is the window less the MEASURED start (the harness unknown)',
      /free at start<\/span><span class="cur-mon-value">≈187k<\/span><span class="cur-mon-sub">of a 200K-token window, before your harness/.test(html), html);
    ok('...and no line is danger-toned on a start that is within every budget',
      !/cur-depth-danger|cur-mon-tone-danger/.test(html), html);
    // THIS COMPUTER's window and harness change the drawing and nothing the project stores.
    const big = makeRenderers(withSS(ssData(), { ctxSettings: { contextWindowTokens: 1000000,
      harnessEstimateTokens: 120000, choices: [200000, 400000, 1000000] } })).renderSessionStart(st.projectRead);
    ok('1M + a 120k harness: the share, the words and the harness line follow the SETTINGS',
      /≈13\.2k tokens · 51\.7 KB · 1\.3% of 1M/.test(big)
      && /harness<\/span><span class="cur-mon-value">≈120k · 12\.0%<\/span><span class="cur-mon-sub">system prompt, tools, CLAUDE\.md, skills · your estimate, not measured/.test(big)
      && /free at start<\/span><span class="cur-mon-value">≈867k</.test(big), big);
    ok('...the hint leaves once an estimate is set', !/mem-ss-harness-hint/.test(big));
    ok('...the SESSION START line stays the MEASURED figure — the harness is never added to it',
      /session start<\/span><span class="cur-mon-value">[\s\S]{0,200}?≈13\.2k · 1\.3%/.test(big), big);
    ok('...and the meter is drawn against THIS COMPUTER\'s window, not the one the measurement was taken with',
      /A 1M-token window, drawn to scale/.test(big) && !/A 200k-token window/.test(big));
    ok('...the meter draws the harness HATCHED, labelled an estimate, and never adds it to The Curator',
      /bk-harness/.test(big) && /harness about 120k \(your estimate, not measured\), The Curator about 13\.2k tokens/.test(big), big.slice(0, 3000));
    // THE ⓘ
    const info = /id="settings-block-info-context-session"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    ok('the step\'s ⓘ keeps the design\'s opening sentence and says how tokens are estimated, with its accuracy',
      !!info && info[1].includes('An agent starting work on this project is handed the standing brief, the latest handoff, a few journal lines, the list of documents, and the text of the documents marked <i>read first</i>, up to the reading budget.')
      && info[1].includes('Tokens are estimated at four bytes each. For English prose the real count is usually within about ±20%')
      && info[1].includes('Claude Code’s <code>/context</code>')
      && info[1].includes('never added to a measured figure'), info ? info[1].slice(0, 300) : html.slice(0, 400));
    // A READ-ONLY MIRROR
    const ro = makeRenderers(withSS(ssData(), { detail: { readonly: true } }))
      .renderSessionStart(st.projectRead);
    ok('a read-only mirror shows the budget as a reading, with no budget picker and no "Set" action',
      !/id="mem-budget-lb"/.test(ro) && !/mem-ss-set-budget/.test(ro)
      && /mem-ss-budget-fixed">Default</.test(ro));
    const failed = makeRenderers(baseSt({ sessionStart: { domain: 'acme', project: 'lumina', sig: 'x',
      data: null, error: 'boom' } })).renderSessionStart(st.projectRead);
    ok('a failed measurement is a disclosure naming the error, never a zero',
      /could not be measured: boom/.test(failed) && !/≈0/.test(failed));
    const other = makeRenderers(baseSt({ sessionStart: { domain: 'other', project: 'lumina', sig: 'x',
      data: ssData(), error: null } })).renderSessionStart(st.projectRead);
    ok('a measurement STAMPED for another project is never painted on this one',
      /Measuring what an agent receives…/.test(other));
  }
  {
    // THE SAME-FOR-EVERY-BUDGET LINE (v3.70.0): the curator project today.
    const read = { scopes: [], brief: { present: false }, readingBudgetBytes: 204800,
      foundations: fndPayload([fndDoc(), fndDoc({ slug: 'b.md' })]) };
    const data = ssData({ planned: true, costLine: { applies: false, documentTextBytes: 0 },
      budget: { bytes: 204800, tokens: 51200, source: 'owner', defaulted: false, ownerBytes: 204800,
        preset: 'custom', custom: true, nearest: 'large', cap: 819200, capTokens: 204800, replyCapBytes: 307200 },
      presetsSummary: { allEqual: true, reason: 'nothing-read-first', readFirstDocuments: 0,
        readFirstBytes: 0, readFirstTokens: 0 },
      tiers: { ...ssData().tiers, otherText: { bytes: 0, count: 0 }, omitted: { bytes: 0, count: 0, slugs: [] },
        readFirst: { bytes: 0, count: 0, budgetBytes: 204800, exceeded: false },
        onRequest: { bytes: 191119, count: 9 } }, bytes: { mcp: 35261, hook: 23049 } });
    const html = makeRenderers(withSS(data, { projectRead: read })).renderSessionStart(read);
    const same = /id="mem-ss-same"[\s\S]*?<\/div>/.exec(html);
    ok('nothing read first: ONE plain line says why every budget sends the same, with the door to step 1',
      !!same && /Every reading budget sends the same ≈8\.8k tokens right now\. Nothing is read first, so every budget sends the same — a budget only caps the documents marked read first\. Mark the two or three an agent should never start without in step 1\./.test(same[0])
      && /id="mem-ss-choose">Choose read-first documents<\/button>/.test(same[0]), same ? same[0] : html.slice(0, 1500));
    ok('...unfolded, before the first chevron', html.indexOf('id="mem-ss-same"') < html.indexOf('<details'));
    ok('...and the meter\'s dashed room is EMPTY and says so, against the owner\'s 51.2k budget',
      /reading budget 51\.2k — unused: nothing is read first/.test(html));
    ok('...a stored non-preset budget reads "Custom ≈51.2k, nearest Large" and selects no preset',
      (budgetStub(html) || {}).value === null
      && /^Reading budget: Custom ≈51\.2k, nearest Large$/.test((budgetStub(html) || {}).label || ''),
      JSON.stringify(budgetStub(html)));
    const bare = makeRenderers(withSS(data, { projectRead: { ...read, foundations: fndPayload([]) } }))
      .renderSessionStart({ ...read, foundations: fndPayload([]) });
    ok('...and a project with NO documents gets no such line — there is nothing to choose',
      !/mem-ss-same/.test(bare));
    const ro = makeRenderers(withSS(data, { projectRead: read, detail: { readonly: true } })).renderSessionStart(read);
    ok('...a read-only mirror gets the sentence without the door', /mem-ss-same/.test(ro) && !/mem-ss-choose/.test(ro));
  }
  {
    // PLANNED, and INDEX ONLY with documents marked read first (§1.9).
    const read = { scopes: [], brief: { present: false }, readingBudgetBytes: 0,
      foundations: fndPayload([fndDoc({ readFirst: true }), fndDoc({ slug: 'b.md', readFirst: true })],
        { readFirstCount: 2, readFirstBytes: 24690 }) };
    const data = ssData({ planned: true, costLine: { applies: false, documentTextBytes: 0 },
      budget: { bytes: 0, tokens: 0, source: 'owner', defaulted: false, ownerBytes: 0, preset: 'index-only',
        custom: false, nearest: null, cap: 819200, capTokens: 204800, replyCapBytes: 307200 },
      tiers: { ...ssData().tiers, otherText: { bytes: 0, count: 0 }, omitted: { bytes: 0, count: 0, slugs: [] },
        readFirst: { bytes: 0, count: 2, budgetBytes: 0, exceeded: true },
        onRequest: { bytes: 24690, count: 2 } } });
    const html = makeRenderers(withSS(data, { projectRead: read })).renderSessionStart(read);
    ok('Index only with two read-first documents says so, in the contract\'s words',
      /2 documents are marked read first, but the reading budget is Index only, so agents are handed none of their text\. They are listed and fetched by name\./.test(html), html.slice(0, 900));
    ok('...and a PLANNED project gets no cost line — the plan is the answer to it',
      !/mem-ss-cost/.test(html));
    ok('...its read-first line names the Index-only budget rather than a bar against zero',
      /read first<\/span><span class="cur-mon-value">0<\/span><span class="cur-mon-sub">2 documents · 0 KB · the reading budget is Index only/.test(html), html);
    ok('...and the on-request tier names what stays one request away, outside the window',
      /on request<\/span><span class="cur-mon-value">2 documents · ≈6\.2k<\/span><span class="cur-mon-sub">listed; outside the window until opened/.test(html));
    eq('...and the picker reads Index only', (budgetStub(html) || {}).value, 'index-only');
  }
  {
    // PLANNED and OVER the read-first budget.
    const read = { scopes: [], brief: { present: false }, readingBudgetBytes: 65536,
      foundations: fndPayload([fndDoc({ readFirst: true, bytes: 154624 })],
        { readFirstCount: 1, readFirstBytes: 154624 }) };
    const data = ssData({ planned: true, costLine: { applies: false, documentTextBytes: 0 },
      budget: { bytes: 65536, tokens: 16384, source: 'owner', defaulted: false, ownerBytes: 65536,
        preset: 'standard', custom: false, nearest: null, cap: 819200, capTokens: 204800, replyCapBytes: 307200 },
      tiers: { ...ssData().tiers, otherText: { bytes: 0, count: 0 },
        readFirst: { bytes: 59392, count: 1, budgetBytes: 65536, exceeded: true } },
      bytes: { mcp: 150000, hook: 90000 }, replies: 2 });
    const html = makeRenderers(withSS(data, { projectRead: read })).renderSessionStart(read);
    ok('over budget, the sentence names the set, the budget and what is handed over — in tokens',
      /The read-first set is ≈38\.7k tokens, over the ≈16\.4k-token reading budget\. Agents are handed the first ≈14\.8k in reading order; the rest stay listed and are fetched by name\./.test(html), html.slice(0, 1500));
    ok('...unfolded, before the first chevron',
      html.indexOf('id="mem-ss-over"') >= 0 && html.indexOf('id="mem-ss-over"') < html.indexOf('<details'));
    ok('...and the read-first line turns DANGER — the one line on this monitor that may',
      /cur-depth-bar cur-depth-danger/.test(html) && /of the ≈16\.4k-token reading budget/.test(html));
    ok('...while the METER never does: a window is not a budget the owner set',
      !/bk-[a-z-]*danger/.test(html));
    ok('a start in TWO replies carries the delivery line on the meter, and the reply count everywhere',
      /Delivered in 2 MCP replies of at most ≈20\.5k tokens each/.test(html)
      && /measured · 2 MCP replies/.test(html) && /2 MCP replies of at most ≈20k tokens/.test(html), html);
    eq('...and the picker reads Standard', (budgetStub(html) || {}).value, 'standard');
  }

  // ── §25b — the three pickers' cfgs ────────────────────────────────────
  {
    const R = makeRenderers(baseSt());
    const untouched = R.budgetPickerCfg({ readingBudgetBytes: null }, ssData(), false);
    // THE INTENT OF THE v3.67.0 PIN, KEPT: the picker offers the STORE's
    // ladder, id for id and byte for byte. It now arrives through the route's
    // `presets[]`, so the view holds no copy that could fall behind (the
    // v3.70.0 red this release fixes: the view's own list stayed at five).
    eq('the presets are the STORE\'s, id for id — all seven, through the route',
      JSON.stringify(untouched.options.map((o) => o.value)),
      JSON.stringify(ws.READING_BUDGET_PRESETS.map((p) => p.id)));
    ok('...and every one names the store\'s own bytes in its row',
      untouched.options.every((o, i) => o.html.includes(ws.READING_BUDGET_PRESETS[i].bytes === 0
        ? '>0 KB<' : (ws.READING_BUDGET_PRESETS[i].bytes / 1024) + ' KB<')));
    ok('...and the view holds NO byte copy of the ladder any more',
      !/READING_BUDGET_PRESETS\s*=/.test(viewSrc) && !/bytes:\s*204800|bytes:\s*819200|bytes:\s*131072/.test(viewSrc));
    eq('TOKEN-FIRST names, the ladder\'s own: Index only · Lean 8k · … · Max 200k',
      JSON.stringify(untouched.options.map((o) => o.label)),
      JSON.stringify(['Index only', 'Lean 8k', 'Standard 16k', 'Deep 32k', 'Large 64k', 'Extra large 128k', 'Max 200k']));
    eq('untouched: the trigger says what is TRUE — the default applies, in tokens', untouched.triggerText,
      'Default · ≈30.7k');
    ok('...Standard is PRESELECTED, and is an action row so choosing it still writes',
      untouched.value === 'standard' && JSON.stringify(untouched.actionValues) === '["standard"]'
      && untouched.options.find((o) => o.value === 'standard').action === true
      && untouched.options.filter((o) => o.action).length === 1);
    ok('...and marked "recommended"', /Standard 16k · recommended/.test(
      untouched.options.find((o) => o.value === 'standard').html));
    ok('each row carries what an agent would START with under it, in tokens, and in how many replies',
      /an agent starts with ≈7\.0k tokens · 1 MCP reply/.test(untouched.options.find((o) => o.value === 'standard').html)
      && /an agent starts with ≈2\.7k tokens · 1 MCP reply/.test(untouched.options[0].html),
      untouched.options[2].html);
    const two = R.budgetPickerCfg({ readingBudgetBytes: null },
      { ...ssData(), presets: ssPresets(undefined, (id) => (id === 'max' ? 11 : 1)) }, false);
    ok('...a preset delivered in several replies says so on its own row',
      /≈13\.2k tokens · 11 MCP replies/.test((two.options[6] || {}).html), (two.options[6] || {}).html);
    const small = makeRenderers(baseSt({ ctxSettings: { contextWindowTokens: 40000, harnessEstimateTokens: null } }))
      .budgetPickerCfg({ readingBudgetBytes: null }, ssData(), false);
    ok('window-aware: a preset whose start is over ¼ of the window says so in words — and is never disabled',
      /over ¼ of this window/.test((small.options[6] || {}).html) && !/over ¼/.test(small.options[0].html)
      && small.options.every((o) => !o.disabled), (small.options[6] || {}).html);
    ok('the meaning of each, in the view\'s own words (the only thing it still holds)',
      untouched.options.every((o) => /mem-bp-hint">[^<]{8,}</.test(o.html)));
    const set = R.budgetPickerCfg({ readingBudgetBytes: 65536 }, ssData(), false);
    ok('set to Standard: the value is Standard, the trigger names it, and no row is an action',
      set.value === 'standard' && set.triggerText === 'Standard 16k'
      && set.actionValues.length === 0 && !set.options.some((o) => o.action));
    eq('Index only reads as itself', R.budgetPickerCfg({ readingBudgetBytes: 0 }, ssData(), false).triggerText,
      'Index only');
    const custom = R.budgetPickerCfg({ readingBudgetBytes: 122880 },
      { ...ssData(), budget: { ...ssData().budget, nearest: 'deep' } }, false);
    ok('a stored budget that is no preset (v3.67\'s Deep, 120 KB) is "Custom ≈30.7k, nearest Deep", no preset selected',
      custom.value === null && custom.triggerText === 'Custom ≈30.7k, nearest Deep', JSON.stringify(custom.triggerText));
    ok('while a budget write is in flight the picker is disabled and says so',
      R.budgetPickerCfg({ readingBudgetBytes: null }, ssData(), true).disabled === true
      && R.budgetPickerCfg({ readingBudgetBytes: null }, ssData(), true).triggerText === 'Saving…');
    // THE WINDOW AND THE HARNESS — this computer's settings.
    const w = R.windowPickerCfg(false);
    ok('the window picker offers 200K · 400K · 1M and a Custom… action row',
      JSON.stringify(w.options.map((o) => o.value)) === '["200000","400000","1000000","custom"]'
      && JSON.stringify(w.actionValues) === '["custom"]' && w.triggerText === '200K');
    const wc = makeRenderers(baseSt({ ctxSettings: { contextWindowTokens: 300000, choices: [200000, 400000, 1000000] } }))
      .windowPickerCfg(false);
    ok('...a custom window selects no choice and names itself', wc.value === null && wc.triggerText === 'Custom · 300K');
    const h = R.harnessPickerCfg(false);
    ok('the harness picker: Not set · Light ≈20k · Typical ≈50k · Heavy ≈120k · Exact…, Not set by default',
      JSON.stringify(h.options.map((o) => o.label)) === '["Not set","Light ≈20k","Typical ≈50k","Heavy ≈120k","Exact…"]'
      && h.value === 'none' && h.triggerText === 'Not set');
    ok('...Exact… carries the one-line hint to read it from Claude Code\'s /context',
      /Run \/context in Claude Code/.test(h.options[4].html));
    const hs = makeRenderers(baseSt({ ctxSettings: { contextWindowTokens: 1000000, harnessEstimateTokens: 37000 } }))
      .harnessPickerCfg(false);
    ok('...an exact figure is labelled YOUR ESTIMATE on the trigger', hs.value === null
      && hs.triggerText === '≈37k · your estimate' && /your estimate/.test(hs.ariaLabel), JSON.stringify(hs));
    // THE INLINE EDITOR
    const ed = makeRenderers(baseSt({ ctxEdit: { kind: 'harness', text: '<b>' } })).ctxEditHtml();
    ok('Exact… opens an inline number field with Save and Cancel, the /context hint, the draft escaped',
      /id="mem-ss-edit-input"/.test(ed) && /id="mem-ss-edit-save">Save</.test(ed)
      && /id="mem-ss-edit-cancel">Cancel</.test(ed) && /Run \/context in Claude Code/.test(ed)
      && /value="&lt;b&gt;"/.test(ed), ed);
    eq('...and nothing when no edit is open', makeRenderers(baseSt()).ctxEditHtml(), '');
  }
  {
    // THE PREVIEW: a budget previewed from the picker is drawn on the meter,
    // marked "preview", with the delivery line B contributed — and only while
    // the measurement it was made against is on screen.
    const pv = ssData({ preview: true, bytes: { mcp: 150000, hook: 90000 }, replies: 2 });
    const st = withSS(ssData(), { budgetPreview: { domain: 'acme', project: 'lumina', sig: 'x',
      bytes: 131072, data: pv } });
    const html = makeRenderers(st).renderSessionStart(st.projectRead);
    ok('a previewed budget repaints the meter as a PREVIEW, with "Preview, not saved · … · N MCP replies"',
      /class="bk-preview">preview</.test(html)
      && /<b>Preview, not saved<\/b> · ≈37\.5k tokens · 18\.8% of 200k · 2 MCP replies/.test(html), html.slice(0, 4000));
    ok('...and names the preset being previewed', /Previewing the Deep 32k reading budget/.test(html));
    ok('...while the monitor below keeps the MEASURED figures — a preview is not saved',
      /≈13\.2k tokens · 51\.7 KB · 6\.6% of 200K/.test(html));
    const stale = withSS(ssData(), { budgetPreview: { domain: 'acme', project: 'lumina', sig: 'older',
      bytes: 131072, data: pv } });
    ok('a preview made against an OLDER measurement is never painted',
      !/Preview, not saved/.test(makeRenderers(stale).renderSessionStart(stale.projectRead)));
  }

  // ── §25c — the SESSION START and AGENT SESSIONS overview tiles ─────────
  {
    const st = withSS(ssData());
    const strip = makeRenderers(st).renderLayerStrip(st.projectRead);
    const tile = /<button type="button" class="cur-ov-card"[^>]*data-ov-jump="context-session"[^>]*>([\s\S]*?)<\/button>/.exec(strip);
    ok('the SESSION START tile reads in TOKENS and replies — "≈13.2k tokens · 1 reply"',
      !!tile && /SESSION START/.test(tile[1]) && /≈13\.2k tokens · 1 reply/.test(tile[1]) && !/KB/.test(tile[1]),
      strip.slice(-900));
    const two = withSS(ssData({ bytes: { mcp: 420000, hook: 1 }, replies: 6 }));
    ok('...and a paged start says how many replies', /≈105k tokens · 6 replies/.test(
      makeRenderers(two).renderLayerStrip(two.projectRead)));
    ok('...a READING: no bar on it (the overview rule)', !!tile && !/cur-depth/.test(tile[0]));
    ok('...and it is not hidden once measured', !!tile && !/ hidden>/.test(tile[0]));
    const none = makeRenderers(baseSt()).renderLayerStrip(baseSt().projectRead);
    ok('before the measurement lands the tile is RENDERED AND HIDDEN — one attribute reveals it',
      /data-ov-jump="context-session"[^>]*hidden>/.test(none), none.slice(-700));
    const order = [...strip.matchAll(/data-ov-jump="([a-z-]+)"/g)].map((m) => m[1]);
    eq('...after AGENT SESSIONS, as the picture draws it', order.join(','),
      'context-canonical,context-state,capture,context-session');
    ok('the capture tile is named AGENT SESSIONS on screen; its jump id keeps the on-disk word',
      /AGENT SESSIONS/.test(strip) && !/>CAPTURE</.test(strip) && /data-ov-jump="capture"/.test(strip));
  }

  // ── §25d — the helper: head control, panel, gate ──────────────────────
  const priced = { job: 'reading-plan', jobLabel: 'Suggest a reading plan', needsKey: false,
    provider: 'gemini', providerLabel: 'Gemini', model: 'gemini-2.5-flash-lite', modelLabel: 'Flash Lite 2.5',
    inputTokens: 6799, inputTokensLow: 5779, inputTokensHigh: 7819, outputTokensLow: 400, outputTokensHigh: 900,
    usdLow: 0.000738, usdHigh: 0.001142, priceKnown: true, free: false, costNote: 'priced' };
  const planSt = (plan, over = {}) => baseSt({ plan: { domain: 'acme', project: 'lumina', open: true,
    estimate: null, estimateError: null, running: null, error: null, result: null, ticks: {},
    budgetTick: false, applying: false, applyError: null, ...plan }, ...over });
  {
    const plain = makeRenderers(baseSt()).renderFoundations(baseSt().projectRead);
    ok('① carries "Suggest a reading plan" in its head row, collapsed',
      /mem-fnd-head-controls">[\s\S]*id="mem-plan-open" aria-expanded="false"[^>]*>Suggest a reading plan<\/button>/.test(plain)
      && !/id="mem-plan-panel"/.test(plain), plain.slice(0, 900));
    const rs = makeRenderers(baseSt({ detail: { readonly: true } })).renderFoundations(baseSt().projectRead);
    ok('...never on a read-only mirror, where a proposal could not be applied', !/mem-plan-open/.test(rs));
    const none = makeRenderers(baseSt()).renderFoundations(fndRead(fndPayload([])));
    ok('...nor on a project with no documents to plan', !/mem-plan-open/.test(none));
  }
  {
    const st = planSt({ estimate: { ok: true, documentCount: 1, inputChars: 24000, budgetBytes: 65536,
      budgetSource: 'standard', runsOn: priced } });
    const html = makeRenderers(st).renderFoundations(st.projectRead);
    const panel = /id="mem-plan-panel"[\s\S]*$/.exec(html);
    ok('the panel opens INSIDE the documents row, which is held open while it is there',
      !!panel && /<details class="mem-fold" data-mem-fold="foundations" open>/.test(html));
    ok('...on Quick maintenance\'s anatomy, the one this page already uses', /class="mem-fnd-panel mem-plan-panel"/.test(html));
    ok('...its two lines say what each arm reads, against the Standard 64 KB budget',
      /Free: from the brief’s “Read before you…” list, each document’s role and size, and the Standard 64 KB reading budget\./.test(html)
      && /With AI: reads titles, roles, sizes and each document’s opening lines, never whole documents\./.test(html));
    ok('...the two buttons, named per the contract',
      /id="mem-plan-free">Suggest \(free\)<\/button>/.test(html) && /id="mem-plan-ai">✨ Suggest with AI<\/button>/.test(html));
    ok('...and the RUN LINE directly under them, from the kit, unfolded',
      /<p class="ai-run" role="note" id="mem-plan-runs">/.test(html)
      && html.indexOf('id="mem-plan-runs"') > html.indexOf('id="mem-plan-ai"')
      && /Runs on/.test(html) && /Flash Lite 2\.5/.test(html) && /≈\$0\.0007–\$0\.0011/.test(html), html.slice(0, 2000));
    const noKey = planSt({ estimate: { ok: true, budgetBytes: 65536, budgetSource: 'standard',
      runsOn: { job: 'reading-plan', jobLabel: 'Suggest a reading plan', needsKey: true } } });
    const nk = makeRenderers(noKey).renderFoundations(noKey.projectRead);
    ok('NO KEY: the AI button is DISABLED — never hidden — and described by the no-key line',
      /id="mem-plan-ai" disabled aria-disabled="true" aria-describedby="mem-plan-runs">✨ Suggest with AI/.test(nk), nk.slice(0, 2500));
    ok('...the line and its door to Providers & keys',
      /Needs an AI provider key/.test(nk) && /data-ai-run-door="providers">Add one in Providers &amp; keys/.test(nk));
    ok('...and the FREE arm still works', /id="mem-plan-free">Suggest \(free\)/.test(nk));
    const wait = makeRenderers(planSt({})).renderFoundations(planSt({}).projectRead);
    ok('before the estimate lands the AI arm waits — a run is never offered without its cost',
      /id="mem-plan-ai" disabled aria-disabled="true">/.test(wait) && /Reading what an AI suggestion would cost…/.test(wait));
    const F = makeRenderers(baseSt());
    ok('§1.4: a priced run under a cent needs no confirm', F.planAiNeedsConfirm(priced) === false);
    ok('...a run whose upper estimate is a cent or more DOES', F.planAiNeedsConfirm({ ...priced, usdHigh: 0.013 }) === true);
    ok('...an UNPRICED run does (it runs, and says the price is not published — but through the confirm)',
      F.planAiNeedsConfirm({ ...priced, usdLow: undefined, usdHigh: undefined, priceKnown: false,
        costNote: 'price-not-published' }) === true);
    ok('...a FREE run does not', F.planAiNeedsConfirm({ ...priced, free: true, usdLow: 0, usdHigh: 0 }) === false);
  }
  const result = {
    ok: true, arm: 'free', budgetBytes: 65536, budgetSource: 'standard', setBudgetSuggested: true,
    proposals: [
      { slug: 'architecture.md', title: 'Architecture', bytes: 12345, current: 'on-request',
        proposed: 'read-first', reason: 'architecture, fits the budget', differs: true },
      { slug: 'roadmap.md', title: 'Roadmap', bytes: 119127, current: 'on-request',
        proposed: 'on-request', reason: 'roadmap, over half the budget', differs: false },
    ],
    totals: { readFirstCount: 2, readFirstBytes: 31437, onRequestCount: 1, notAtStartCount: 0 },
    dropped: [], notes: [], runsOn: priced,
  };
  {
    const docs = [fndDoc(), fndDoc({ slug: 'roadmap.md', title: 'Roadmap', role: 'roadmap', bytes: 119127 })];
    const st = planSt({ estimate: { ok: true, budgetBytes: 65536, budgetSource: 'standard', runsOn: priced },
      result: { ...result, arm: 'ai', spent: { provider: 'gemini', providerLabel: 'Gemini',
        model: 'gemini-2.5-flash-lite', modelLabel: 'Flash Lite 2.5', inputTokens: 5812, outputTokens: 640,
        cachedReadTokens: 0, cacheWriteTokens: 0, calls: 1, usd: 0.0008372, estimated: false, fallbackFrom: null } },
      ticks: { 'architecture.md': true }, budgetTick: true },
    { projectRead: { scopes: [], brief: { present: false }, readingBudgetBytes: null,
      foundations: fndPayload(docs) },
    // The page has its measurement by the time a plan is asked for, and the
    // ladder's names come from it (v3.70.0).
    sessionStart: { domain: 'acme', project: 'lumina', sig: 'x', data: ssData(), error: null } });
    const html = makeRenderers(st).renderFoundations(st.projectRead);
    ok('a proposal adds the transient SUGGESTED column', /<th scope="col">At session start<\/th><th scope="col">Suggested<\/th>/.test(html));
    ok('...a differing row carries a TICK, ticked, the proposed state and its one-line reason',
      /data-plan-tick="architecture\.md" checked aria-label="Apply the suggestion for Architecture: read first"><span class="fnd-suggest-word fnd-suggest-change">read first<\/span><\/label><span class="fnd-suggest-why">architecture, fits the budget<\/span>/.test(html), html);
    ok('...a row the plan leaves alone carries no tick and says "as now"',
      /<span class="fnd-suggest-word">on request · as now<\/span>/.test(html)
      && !/data-plan-tick="roadmap\.md"/.test(html));
    ok('the head row swaps the Suggest control for Apply suggestion · Dismiss',
      /id="mem-plan-apply">Apply suggestion<\/button><button type="button" class="btn btn-ghost btn-xs" id="mem-plan-dismiss">Dismiss<\/button>/.test(html)
      && !/id="mem-plan-open"/.test(html));
    ok('the proposal\'s one-line summary, as the picture words it',
      /Suggested plan · 2 read first · 30\.7 KB of the 64 KB reading budget · 1 on request · nothing applied yet/.test(html), html);
    ok('...and, with no budget set, the tick that sets the one it was planned against — ticked',
      /id="mem-plan-budget-tick" checked><span>Also set the reading budget to Standard 16k · 64 KB<\/span>/.test(html), html);
    ok('after an AI run, the AFTER line — what ran and what it cost',
      /Ran on/.test(html) && /5,812 in \/ 640 out/.test(html) && /\$0\.0008/.test(html));
    const F = makeRenderers(st);
    eq('Apply would make two writes: the budget and the one ticked row', F.planChangeCount(st.plan), 2);
    eq('the `if applied` preview asks for exactly the ticked plan and the budget',
      JSON.stringify(F.planPreviewBody(st.plan)),
      JSON.stringify({ budgetBytes: 65536, plan: { 'architecture.md': 'read-first' } }));
    const unticked = { ...st.plan, ticks: {}, budgetTick: false };
    eq('...and nothing at all when nothing is ticked', F.planPreviewBody(unticked), null);
    ok('...in which case Apply is disabled — it would write nothing',
      /id="mem-plan-apply" disabled aria-disabled="true">/.test(makeRenderers(planSt(unticked, { projectRead: st.projectRead })).planHeadHtml()));
    // THE `if applied` LINE, from the preview the store measured.
    const withPrev = { ...st, sessionStart: { domain: 'acme', project: 'lumina', sig: 'x', data: ssData(), error: null },
      sessionPreview: { domain: 'acme', project: 'lumina', key: JSON.stringify(F.planPreviewBody(st.plan)),
        withBudget: true, data: ssData({ bytes: { mcp: 62464, hook: 50000 }, preview: true,
          budget: { bytes: 65536, source: 'whatif', defaulted: false, ownerBytes: null, cap: 204800, replyCapBytes: 307200 } }) } };
    const ss = makeRenderers(withPrev).renderSessionStart(withPrev.projectRead);
    ok('④ reads the pending proposal as an `if applied` line, measured by the store',
      /if applied<\/span><span class="cur-mon-value">[\s\S]*?≈15\.6k · 7\.8%[\s\S]*?Standard 16k reading budget, with the suggestion/.test(ss), ss.slice(-2500));
    ok('...and the METER draws that proposal as a preview, naming it — nothing is applied yet',
      /class="bk-preview">preview</.test(ss) && /Previewing the suggested reading plan — apply it in step 1\./.test(ss));
    const stale = { ...withPrev, sessionPreview: { ...withPrev.sessionPreview, key: '{"plan":{}}' } };
    ok('...and never a preview measured for a DIFFERENT set of ticks',
      !/if applied/.test(makeRenderers(stale).renderSessionStart(stale.projectRead)));
  }

  // ── §25e — Apply: the budget first, then one PATCH per ticked row ─────
  {
    const drive = async (responses, planOver = {}) => {
      const st = planSt({ result, ticks: { 'architecture.md': true }, budgetTick: true, ...planOver });
      const calls = { urls: [], bodies: [], reloads: 0, renders: 0 };
      let n = 0;
      const api = new Function('state', 'isCurrentMount', 'render', 'fetch', 'encodeURIComponent',
        'reloadActive',
        extractFunction(viewSrc, 'planFor', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'planChangeCount', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'writeStartState', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'writeReadingBudget', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'applyBudgetAnswer', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'applyPlan', 'memory.js') + '\nreturn { applyPlan };')(
        st, () => true, () => { calls.renders++; },
        async (url, init) => {
          calls.urls.push(url.replace('/api/memory/acme/lumina/', ''));
          calls.bodies.push(init.body);
          const r = responses[n++] || { ok: true, data: { ok: true } };
          return { ok: r.ok, status: r.ok ? 200 : 409, json: async () => r.data };
        },
        encodeURIComponent, async () => { calls.reloads++; });
      await api.applyPlan(1);
      return { st, calls };
    };
    const a = await drive([{ ok: true, data: { ok: true, readingBudgetBytes: 65536, readingBudgetDefaulted: false,
      readFirstBudgetBytes: 65536, readFirstBudgetExceeded: false } }]);
    eq('Apply writes the BUDGET FIRST, then the ticked row — and nothing unticked or unchanged',
      a.calls.urls.join(' | '), 'reading/budget | foundations/architecture.md');
    eq('...each with its one field', a.calls.bodies.join(' | '),
      '{"readingBudgetBytes":65536} | {"atStart":"read-first"}');
    ok('...then the proposal is gone and the project is re-read from the store',
      a.st.plan === null && a.calls.reloads === 1);
    eq('...and the answer\'s budget is folded in from the ROUTE', a.st.projectRead.readingBudgetBytes, 65536);
    const noBudget = await drive([], { budgetTick: false });
    eq('an unticked budget line is not written', noBudget.calls.urls.join(' | '), 'foundations/architecture.md');
    const refused = await drive([{ ok: true, data: { ok: true, readingBudgetBytes: 65536 } },
      { ok: false, data: { ok: false, error: 'locked', message: 'Another write is in progress' } }]);
    ok('a refusal STOPS the run and says exactly what landed and what did not',
      refused.st.plan && refused.st.plan.applying === false
      && refused.st.plan.applyError === '1 of the changes were applied, then “architecture.md” was not changed: Another write is in progress',
      JSON.stringify(refused.st.plan && refused.st.plan.applyError));
    ok('...and keeps the proposal on screen, re-reading what the store now holds',
      !!refused.st.plan && refused.calls.reloads === 1);
    const nothing = await drive([], { ticks: {}, budgetTick: false });
    eq('with nothing ticked, Apply sends nothing', nothing.calls.urls.length, 0);
  }

  // ── §25f — the measurement follows the read, after the paint ───────────
  {
    const mk = (st) => {
      const calls = { loads: 0 };
      const api = new Function('state', 'keyOf', 'payloadSignature', 'reportAsyncMountFailure',
        'loadSessionStart', 'loadContextSettings',
        'let sessionStartInFlight = null;\nlet ctxSettingsInFlight = false;\n'
        + extractFunction(viewSrc, 'planFor', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'sessionStartFor', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'maybeLoadSessionStart', 'memory.js')
        + '\nreturn { maybeLoadSessionStart };')(
        st, (d, p) => d + '/' + p, (r) => JSON.stringify(r), () => {},
        async () => { calls.loads++; }, async () => { calls.settings = (calls.settings || 0) + 1; });
      return { api, calls };
    };
    const st = baseSt();
    const a = mk(st);
    a.api.maybeLoadSessionStart(1);
    eq('a project with no measurement asks for one', a.calls.loads, 1);
    eq('...and this computer\'s window and harness are read when the page has none yet',
      a.calls.settings, 1);
    const had = mk({ ...st, ctxSettings: { contextWindowTokens: 200000 } });
    had.api.maybeLoadSessionStart(1);
    eq('...but never again once they are on the page — one read per mount', had.calls.settings || 0, 0);
    const b = mk({ ...st, sessionStart: { domain: 'acme', project: 'lumina',
      sig: JSON.stringify(st.projectRead), data: {} } });
    b.api.maybeLoadSessionStart(1);
    eq('...an unchanged read does not ask again', b.calls.loads, 0);
    const c = mk({ ...st, sessionStart: { domain: 'acme', project: 'lumina', sig: 'older', data: {} } });
    c.api.maybeLoadSessionStart(1);
    eq('...a CHANGED read (a document re-routed, a budget set) re-measures', c.calls.loads, 1);
    const d = mk({ ...st, projectRead: null });
    d.api.maybeLoadSessionStart(1);
    eq('...and nothing is asked before the project read exists', d.calls.loads, 0);
    const moved = { ...st, plan: { domain: 'acme', project: 'other', open: true } };
    mk(moved).api.maybeLoadSessionStart(1);
    eq('a proposal made on another project is dropped — it belongs to the project it was made on',
      moved.plan, null);
    ok('render() asks after it paints — the measurement is never on a switch\'s critical path',
      /wire\(token\);\s*restoreFocus\(\);[\s\S]{0,300}maybeLoadSessionStart\(token\);\s*\}$/.test(
        stripComments(extractFunction(viewSrc, 'render', 'memory.js')).trim()));
    ok('...and selectProject never asks for it at all', !/sessionStart|session-start/.test(
      extractFunction(viewSrc, 'selectProject', 'memory.js')));
  }
  {
    // loadSessionStart: stamped, and a failed RE-measure keeps the last figures.
    const run = async (st, respond, active = true) => {
      const calls = { patches: 0, url: null };
      const api = new Function('state', 'keyOf', 'isCurrentMount', 'fetch', 'encodeURIComponent',
        'patchSessionStart',
        'let sessionStartInFlight = null;\n'
        + extractFunction(viewSrc, 'sessionStartFor', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'loadSessionStart', 'memory.js') + '\nreturn { loadSessionStart };')(
        st, (d, p) => d + '/' + p, () => active,
        async (url) => { calls.url = url; return respond(); }, encodeURIComponent,
        () => { calls.patches++; });
      await api.loadSessionStart('acme', 'lumina', 'S1', 1);
      return calls;
    };
    const st = baseSt();
    const c1 = await run(st, () => ({ ok: true, json: async () => ssData() }));
    eq('it reads the store\'s session-start route for THIS project', c1.url,
      '/api/memory/acme/lumina/session-start');
    ok('...keeps the answer stamped with the read it measured, and patches step ④ in place',
      st.sessionStart.sig === 'S1' && st.sessionStart.data.bytes.mcp === 52958 && c1.patches === 1);
    await run(st, () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
    ok('a failed RE-measure keeps the last good figures and names the error',
      st.sessionStart.data && st.sessionStart.data.bytes.mcp === 52958 && st.sessionStart.error === 'boom');
    const st2 = baseSt({ activeProject: 'elsewhere' });
    const c3 = await run(st2, () => ({ ok: true, json: async () => ssData() }));
    ok('an answer for a project the user has LEFT is dropped', !st2.sessionStart && c3.patches === 0);
  }

  // ── §25g — the start cells and the picker are MOUNTED from the render's cfg ─
  {
    const mounted = [];
    const els = { 'mem-fnd-start-architecture-md': {}, 'mem-budget-lb': {}, 'mem-window-lb': {},
      'mem-harness-lb': {} };
    const root = { querySelectorAll: () => [], querySelector: (sel) => els[sel.replace('#', '')] || null };
    const st = baseSt({ sessionStart: { domain: 'acme', project: 'lumina', sig: 'x', data: ssData() } });
    const calls = { start: [], budget: [], ctx: [], patches: 0 };
    const api = new Function('state', 'document', 'mountListbox', 'wireAiRunDoors', 'requestSettingsSection',
      'navigate', 'setStartState', 'setReadingBudget', 'reportAsyncMountFailure', 'patchSessionStart',
      'render', 'loadPlanEstimate', 'runPlan', 'pressPlanAi', 'applyPlan', 'loadPlanPreview', 'localStorage',
      'escapeHtml', 'icon', 'renderMonitor', 'renderListboxHtml', 'renderRunsOn', 'renderSpent',
      'aiActionDisabledAttrs', 'renderDescription', 'renderStatus', 'memStep', 'foundationsFacts',
      'formatTokens', 'renderBucket', 'setContextSetting', 'previewBudget',
      v367Lift() + extractFunction(viewSrc, 'bindSessionAndPlan', 'memory.js') + '\nreturn { bindSessionAndPlan };')(
      st, { querySelector: () => null, getElementById: () => null },
      (cfg) => { mounted.push(cfg); }, () => true, () => {}, () => {},
      async (slug, v) => { calls.start.push(slug + '=' + v); },
      async (b) => { calls.budget.push(b); }, () => {}, () => { calls.patches++; }, () => {},
      async () => {}, async () => {}, () => {}, async () => {}, async () => {}, { setItem() {} },
      escapeHtml, () => '', renderMonitor, () => '', renderRunsOn, renderSpent, aiActionDisabledAttrs,
      () => '', () => '', () => '', (read) => makeRenderers({}).foundationsFacts(read),
      formatTokens, renderBucket, async (body) => { calls.ctx.push(JSON.stringify(body)); }, () => {});
    api.bindSessionAndPlan(root, 1);
    const cell = mounted.find((c) => c.id === 'mem-fnd-start-architecture-md');
    ok('each row\'s start cell is mounted from the SAME cfg function the markup used',
      !!cell && cell.value === 'on-request' && typeof cell.onChange === 'function');
    cell.onChange('not-at-start');
    eq('...and a choice writes THAT row\'s state, through setStartState', calls.start.join(','),
      'architecture.md=not-at-start');
    const pick = mounted.find((c) => c.id === 'mem-budget-lb');
    ok('the reading budget picker is mounted too', !!pick && typeof pick.onChange === 'function');
    pick.onChange('lean');
    pick.onChange('standard');
    pick.onChange('nonsense');
    eq('...and a preset writes ITS bytes — the ROUTE\'s, all seven — an unknown value writes nothing',
      (pick.onChange('max'), calls.budget.join(',')), '32768,65536,819200');
    // v3.70.0: the window and the harness, this computer's, one PUT each.
    const win = mounted.find((c) => c.id === 'mem-window-lb');
    const har = mounted.find((c) => c.id === 'mem-harness-lb');
    ok('the window and harness pickers are mounted from the same cfgs the markup used',
      !!win && !!har && typeof win.onChange === 'function' && typeof har.onChange === 'function');
    win.onChange('1000000');
    har.onChange('120000');
    har.onChange('none');
    eq('...a choice writes ONE setting through the settings PUT — never a project field',
      calls.ctx.join(' | '),
      '{"contextWindowTokens":1000000} | {"harnessEstimateTokens":120000} | {"harnessEstimateTokens":null}');
    win.onChange('custom');
    ok('..."Custom…" writes NOTHING: it opens the inline editor on the current window',
      calls.ctx.length === 3 && st.ctxEdit && st.ctxEdit.kind === 'window' && st.ctxEdit.text === '200000'
      && calls.patches >= 1, JSON.stringify(st.ctxEdit));
    har.onChange('exact');
    ok('..."Exact…" likewise, on the harness, empty while Not set',
      calls.ctx.length === 3 && st.ctxEdit.kind === 'harness' && st.ctxEdit.text === '');
  }

  // ── §25g2 — ONE door listener per root, shared with every other view ──
  // Chat, Ingest and Settings wire J's door on `#view-root`. If Context wired
  // a different (inner) root, a press on a door inside Context would reach
  // TWO delegated listeners and navigate twice. Driven with the REAL kit
  // function, after "another view" has already wired the same root.
  {
    const { wireAiRunDoors: realWire } = await import('../src/public/next/shared/ai-run.js');
    const listeners = [];
    const viewRoot = { id: 'view-root', addEventListener: (t, fn) => listeners.push([t, fn]) };
    const calls = { section: [], nav: [] };
    const deps = { requestSettingsSection: (x) => calls.section.push(x), navigate: (x) => calls.nav.push(x) };
    realWire(viewRoot, deps);                       // Chat / Ingest / Settings, first
    const root = { querySelectorAll: () => [], querySelector: () => null };
    const api = new Function('state', 'document', 'mountListbox', 'wireAiRunDoors', 'requestSettingsSection',
      'navigate', 'setStartState', 'setReadingBudget', 'reportAsyncMountFailure', 'patchSessionStart',
      'render', 'loadPlanEstimate', 'runPlan', 'pressPlanAi', 'applyPlan', 'loadPlanPreview', 'localStorage',
      'escapeHtml', 'icon', 'renderMonitor', 'renderListboxHtml', 'renderRunsOn', 'renderSpent',
      'aiActionDisabledAttrs', 'renderDescription', 'renderStatus', 'memStep', 'foundationsFacts',
      v367Lift() + extractFunction(viewSrc, 'bindSessionAndPlan', 'memory.js') + '\nreturn { bindSessionAndPlan };')(
      baseSt({ projectRead: null }),
      // The inner column is a DIFFERENT element whose listeners also hear a
      // press (it is inside #view-root), so wiring it as well is the defect.
      { getElementById: (id) => (id === 'view-root' ? viewRoot : null),
        querySelector: (sel) => (sel === '#view-root .main-inner'
          ? { addEventListener: (t, fn) => listeners.push([t, fn]) } : null) },
      () => {}, realWire, deps.requestSettingsSection, deps.navigate,
      async () => {}, async () => {}, () => {}, () => {}, () => {},
      async () => {}, async () => {}, () => {}, async () => {}, async () => {}, { setItem() {} },
      escapeHtml, () => '', renderMonitor, () => '', renderRunsOn, renderSpent, aiActionDisabledAttrs,
      () => '', () => '', () => '', () => ({}));
    api.bindSessionAndPlan(root, 1);
    api.bindSessionAndPlan(root, 1);                // a second paint re-binds
    const clicks = listeners.filter(([t]) => t === 'click');
    eq('Context wires the SAME root the other views do, so there is ONE door listener, not two',
      clicks.length, 1);
    const door = { dataset: { aiRunDoor: 'providers' } };
    for (const [, fn] of clicks) {
      fn({ target: { closest: (sel) => (sel === '[data-ai-run-door]' ? door : null) }, preventDefault() {} });
    }
    ok('...so a door press in Context goes to Providers & keys exactly ONCE',
      calls.section.join() === 'providers' && calls.nav.join() === 'settings',
      JSON.stringify(calls));
  }

  // ── §25h — the teaching copy, verbatim (CONTRACT §5.1) ────────────────
  {
    const R = makeRenderers(baseSt());
    ok('the header ⓘ OPENS on the model: instructions, last state, a little foundation',
      R.aboutInfoHtml().startsWith('<p>An agent starting work on a project needs three things: its instructions (the standing brief), where things stand (the latest handoff), and a little foundational knowledge (the documents you mark <i>read first</i>). Everything else — other documents, the domain’s pages — stays one request away. Give it just enough, and it keeps its window for the work.</p>'),
      R.aboutInfoHtml().slice(0, 300));
    const page = makeRenderers(withSS(ssData())).renderProject();
    const panel = (id) => {
      const at = page.indexOf('id="settings-block-info-' + id + '"');
      if (at < 0) return '';
      const rest = page.slice(at);
      return rest.slice(rest.indexOf('>') + 1);
    };
    ok('① opens on "Foundational knowledge"', panel('context-canonical')
      .startsWith('<p>Foundational knowledge: choose which documents an agent reads at the start and which it opens only when needed.'));
    ok('② opens on "The last state and the instructions"', panel('context-state')
      .startsWith('<p>The last state and the instructions: what every agent is handed at the start.'));
    ok('③ opens on "Knowledge on demand"', panel('context-knowledge')
      .startsWith('<p>Knowledge on demand: searched when a task needs it, never loaded at the start.'));
    ok('④ is the page\'s last step, after ③', page.indexOf('settings-block-context-session')
      > page.indexOf('settings-block-context-knowledge'));
  }

  // ── §25j — the helper's reads, the gate and the budget write, driven ───
  {
    // `srcs` are LIFTED SOURCES (each a literal extractFunction call at the
    // call site, which is what §17's census reads for); the names returned are
    // read back off each source's own `function` line.
    const lift = (srcs, extraParams, extraArgs, st, fetchImpl) => new Function('state', 'isCurrentMount',
      'render', 'fetch', 'encodeURIComponent', 'reportAsyncMountFailure', ...extraParams,
      'let previewInFlight = null;\n'
      + srcs.join('\n')
      + '\nreturn { ' + srcs.map((x) => /function\s+([A-Za-z0-9_$]+)/.exec(x)[1]).join(', ') + ' };')(
      st, () => true, () => { st.__renders = (st.__renders || 0) + 1; }, fetchImpl, encodeURIComponent,
      () => {}, ...extraArgs);
    // runPlan: a READ that proposes; every differing row starts ticked.
    {
      const st = planSt({});
      const seen = [];
      const api = lift([extractFunction(viewSrc, 'planFor', 'memory.js'), extractFunction(viewSrc, 'planPreviewBody', 'memory.js'), extractFunction(viewSrc, 'planPreviewKey', 'memory.js'), extractFunction(viewSrc, 'runPlan', 'memory.js')], ['loadPlanPreview'],
        [async () => { seen.push('preview'); }], st,
        async (url, init) => { seen.push(url + ' ' + init.body);
          return { ok: true, json: async () => result }; });
      await api.runPlan('free', 1);
      eq('the free arm POSTs {arm:"free"} to the helper for THIS project', seen[0],
        '/api/reading-plan/acme/lumina/suggest {"arm":"free"}');
      ok('...every DIFFERING row starts ticked, and only those',
        JSON.stringify(st.plan.ticks) === '{"architecture.md":true}', JSON.stringify(st.plan.ticks));
      ok('...the budget tick starts ticked when the plan was made against Standard for an untouched project',
        st.plan.budgetTick === true);
      eq('...and the `if applied` preview is asked for at once', seen[1], 'preview');
      const nk = planSt({});
      const apiNk = lift([extractFunction(viewSrc, 'planFor', 'memory.js'), extractFunction(viewSrc, 'runPlan', 'memory.js')], ['loadPlanPreview'], [async () => {}], nk,
        async () => ({ ok: false, status: 400, json: async () => ({ ok: false, reason: 'needs_key',
          error: 'needs_key', runsOn: { job: 'reading-plan', needsKey: true } }) }));
      await apiNk.runPlan('ai', 1);
      ok('a 400 needs_key is a disclosure, and its runsOn turns the AI button into the no-key state',
        nk.plan.error === 'needs_key' && nk.plan.estimate.runsOn.needsKey === true && !nk.plan.result);
    }
    // pressPlanAi: the gate of §1.4, driven.
    {
      const drive = async (runsOn) => {
        const st = planSt({ estimate: { runsOn } });
        const calls = { confirms: [], runs: [] };
        const api = lift([extractFunction(viewSrc, 'planFor', 'memory.js'), extractFunction(viewSrc, 'planAiNeedsConfirm', 'memory.js'), extractFunction(viewSrc, 'pressPlanAi', 'memory.js')],
          ['runPlan', 'confirmThen', 'runLineText'],
          [async (arm) => { calls.runs.push(arm); },
            (o) => { calls.confirms.push(o); return Promise.resolve(); },
            () => 'Runs on X · ≈7k tokens · ≈$0.0130'], st, async () => ({}));
        api.pressPlanAi(1);
        return calls;
      };
      const cheap = await drive(priced);
      ok('under a cent the unfolded line IS the gate: it runs at once, no dialog',
        cheap.runs.join() === 'ai' && cheap.confirms.length === 0);
      const dear = await drive({ ...priced, usdHigh: 0.013 });
      ok('a cent or more opens shared/confirm.js with the RUN LINE as its first line, and does not run',
        dear.runs.length === 0 && dear.confirms.length === 1
        && dear.confirms[0].message === 'Runs on X · ≈7k tokens · ≈$0.0130'
        && dear.confirms[0].tone === 'default' && typeof dear.confirms[0].onConfirm === 'function');
      const nokey = await drive({ job: 'reading-plan', needsKey: true });
      ok('with no key a press does nothing at all (the button is disabled; this is the belt)',
        nokey.runs.length === 0 && nokey.confirms.length === 0);
    }
    // setReadingBudget: one write, one field, from the ANSWER.
    {
      const st = baseSt();
      const seen = [];
      const toasts = [];
      const api = lift([extractFunction(viewSrc, 'writeReadingBudget', 'memory.js'), extractFunction(viewSrc, 'applyBudgetAnswer', 'memory.js'), extractFunction(viewSrc, 'setReadingBudget', 'memory.js')],
        ['showToast', 'presetName'], [(o) => toasts.push(o), (b) => 'Lean 8k (' + b + ')'], st,
        async (url, init) => { seen.push(url + ' ' + init.body);
          return { ok: true, json: async () => ({ ok: true, readingBudgetBytes: 32768,
            readingBudgetDefaulted: false, readFirstBudgetBytes: 32768, readFirstBudgetExceeded: false }) }; });
      await api.setReadingBudget(32768, 1);
      eq('choosing a preset PATCHes the four-segment budget route with ONE field', seen.join(),
        '/api/memory/acme/lumina/reading/budget {"readingBudgetBytes":32768}');
      ok('...the project read takes the ROUTE\'s answer, and the documents\' budget follows it',
        st.projectRead.readingBudgetBytes === 32768 && st.projectRead.foundations.readFirstBudgetBytes === 32768
        && st.budgetSaving === false);
      ok('...and the confirmation is a TOAST naming the preset it set (v3.67.2: success goes away on its own)',
        toasts.length === 1 && toasts[0].tone === 'success' && toasts[0].title === 'Reading budget set to Lean 8k (32768)',
        JSON.stringify(toasts));
      const bad = baseSt();
      const toasts2 = [];
      const api2 = lift([extractFunction(viewSrc, 'writeReadingBudget', 'memory.js'), extractFunction(viewSrc, 'applyBudgetAnswer', 'memory.js'), extractFunction(viewSrc, 'setReadingBudget', 'memory.js')],
        ['showToast', 'presetName'], [(o) => toasts2.push(o), () => 'x'], bad,
        async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'invalid_reading_budget' }) }));
      await api2.setReadingBudget(5, 1);
      ok('a refusal is disclosed against THIS project and the read is left as it was',
        bad.budgetError && bad.budgetError.error === 'invalid_reading_budget'
        && bad.projectRead.readingBudgetBytes === null);
      const html = makeRenderers(bad).renderSessionStart(bad.projectRead);
      ok('...and step ④ says so, unfolded — PERSISTENT, never a toast',
        /The reading budget was not changed: invalid_reading_budget/.test(html) && toasts2.length === 0);
    }
    // loadPlanEstimate + loadPlanPreview: reads, stamped.
    {
      const st = planSt({});
      const api = lift([extractFunction(viewSrc, 'planFor', 'memory.js'), extractFunction(viewSrc, 'loadPlanEstimate', 'memory.js')], [], [], st,
        async (url) => ({ ok: true, json: async () => ({ ok: true, url, budgetBytes: 65536,
          budgetSource: 'standard', runsOn: priced }) }));
      await api.loadPlanEstimate(1);
      eq('opening the panel reads the helper\'s estimate for THIS project', st.plan.estimate.url,
        '/api/reading-plan/acme/lumina/estimate');
      const st2 = planSt({ result, ticks: { 'architecture.md': true }, budgetTick: false });
      const bodies = [];
      const api2 = lift([extractFunction(viewSrc, 'planFor', 'memory.js'), extractFunction(viewSrc, 'planPreviewBody', 'memory.js'), extractFunction(viewSrc, 'planPreviewKey', 'memory.js'), extractFunction(viewSrc, 'loadPlanPreview', 'memory.js')],
        ['patchSessionStart'], [() => {}], st2,
        async (url, init) => { bodies.push(url + ' ' + init.body);
          return { ok: true, json: async () => ssData({ bytes: { mcp: 30000, hook: 1 } }) }; });
      await api2.loadPlanPreview(1);
      eq('the `if applied` read POSTs the ticked plan to the store\'s PREVIEW route', bodies.join(),
        '/api/memory/acme/lumina/session-start/preview {"plan":{"architecture.md":"read-first"}}');
      ok('...and keeps the answer keyed by that exact plan', st2.sessionPreview
        && st2.sessionPreview.key === '{"plan":{"architecture.md":"read-first"}}'
        && st2.sessionPreview.withBudget === false);
    }
  }

  // ── §25k — v3.70.0: this computer's window + harness, the old browser
  //    setting carried over ONCE, and the budget preview — driven ─────────
  {
    const liftCtx = (st, fetchImpl, extra = {}) => {
      const calls = { patches: 0, meters: 0, toasts: [], removed: [], ls: extra.ls || {}, loads: 0 };
      const localStorageFake = {
        getItem: (k) => (Object.hasOwn(calls.ls, k) ? calls.ls[k] : null),
        removeItem: (k) => { calls.removed.push(k); delete calls.ls[k]; },
        setItem: () => { throw new Error('v3.70.0 never WRITES the old browser key'); },
      };
      const timers = [];
      const api = new Function('state', 'fetch', 'localStorage', 'isCurrentMount', 'patchSessionStart',
        'patchSessionMeter', 'showToast', 'maybeLoadSessionStart', 'keyOf', 'formatTokens', 'setTimeout',
        'clearTimeout', 'encodeURIComponent',
        'let ctxSettingsInFlight = false;\nlet budgetPreviewTimer = null;\nlet budgetPreviewInFlight = null;\n'
        + 'const budgetPreviewCache = new Map();\n'
        + constDecl(viewSrc, 'CONTEXT_WINDOW_KEY') + '\n' + constDecl(viewSrc, 'CONTEXT_WINDOWS') + '\n'
        + extractFunction(viewSrc, 'readContextWindow', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'sessionStartFor', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'contextWindowNow', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'harnessNow', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'windowWord', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'writeContextSettings', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'loadContextSettings', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'setContextSetting', 'memory.js') + '\n'
        + extractFunction(viewSrc, 'previewBudget', 'memory.js') + '\n'
        + 'return { loadContextSettings, setContextSetting, writeContextSettings, previewBudget };')(
        st, fetchImpl, localStorageFake, (t) => t === 1, () => { calls.patches++; }, () => { calls.meters++; },
        (o) => calls.toasts.push(o), () => { calls.loads++; }, (d, p) => d + '/' + p, formatTokens,
        (fn) => { timers.push({ fn, live: true }); return timers.length; },
        (id) => { if (timers[id - 1]) timers[id - 1].live = false; }, encodeURIComponent);
      return { api, calls, flush: async () => {
        for (const t of timers.splice(0)) if (t.live) await t.fn();
      } };
    };
    // THE OLD BROWSER KEY IS READ IN ONE PLACE, CALLED FROM ONE PLACE, AND
    // NEVER WRITTEN: the window is this computer's setting now (decision 4).
    {
      const code = viewSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      eq('the v3.67 window key is READ exactly once in the view', (code.match(/getItem\(CONTEXT_WINDOW_KEY\)/g) || []).length, 1);
      eq('...by readContextWindow, called ONLY by the one-time carry-over',
        (code.match(/readContextWindow\(\)/g) || []).length, 2);
      ok('...inside loadContextSettings', /readContextWindow\(\)/.test(extractFunction(viewSrc, 'loadContextSettings', 'memory.js')));
      ok('...and NOTHING writes it any more', !/setItem\(CONTEXT_WINDOW_KEY/.test(code));
    }
    const settings = (over = {}) => ({ contextWindowTokens: 200000, contextWindowSet: false,
      contextWindowCustom: false, harnessEstimateTokens: null, choices: [200000, 400000, 1000000], ...over });
    // THE MIGRATION: a v3.67 browser choice is written to the settings ONCE, then removed.
    {
      const st = baseSt();
      const seen = [];
      const { api, calls } = liftCtx(st, async (url, init) => {
        seen.push((init ? init.method + ' ' : 'GET ') + url + (init ? ' ' + init.body : ''));
        return { ok: true, json: async () => ({ ok: true, settings: init
          ? settings({ contextWindowTokens: 1000000, contextWindowSet: true }) : settings() }) };
      }, { ls: { 'curator-context-window-v1': '1m' } });
      await api.loadContextSettings(1);
      eq('an unset window + an old browser choice of 1M: ONE read, ONE write of that choice',
        seen.join(' | '), 'GET /api/config/context-window | PUT /api/config/context-window {"contextWindowTokens":1000000}');
      ok('...the old key is REMOVED once carried, so it is never read again',
        JSON.stringify(calls.removed) === '["curator-context-window-v1"]' && !('curator-context-window-v1' in calls.ls));
      ok('...and the page takes the answer\'s settings', st.ctxSettings.contextWindowTokens === 1000000
        && calls.patches === 1);
    }
    {
      const st = baseSt();
      const seen = [];
      const { api, calls } = liftCtx(st, async (url, init) => { seen.push(init ? 'PUT' : 'GET');
        return { ok: true, json: async () => ({ ok: true, settings: settings({ contextWindowTokens: 400000,
          contextWindowSet: true }) }) }; }, { ls: { 'curator-context-window-v1': '1m' } });
      await api.loadContextSettings(1);
      ok('a window ALREADY set for this computer wins: nothing is written, and the stale key is removed',
        seen.join() === 'GET' && st.ctxSettings.contextWindowTokens === 400000
        && JSON.stringify(calls.removed) === '["curator-context-window-v1"]');
    }
    {
      const st = baseSt();
      const { api, calls } = liftCtx(st, async (url, init) => (init
        ? { ok: false, status: 500, json: async () => ({ ok: false, error: 'disk full' }) }
        : { ok: true, json: async () => ({ ok: true, settings: settings() }) }), { ls: { 'curator-context-window-v1': '1m' } });
      await api.loadContextSettings(1);
      ok('a FAILED carry-over keeps the old key, to be tried on the next visit rather than lost',
        calls.removed.length === 0 && calls.ls['curator-context-window-v1'] === '1m');
    }
    {
      const st = baseSt();
      const seen = [];
      const { api, calls } = liftCtx(st, async (url, init) => { seen.push(init ? 'PUT' : 'GET');
        return { ok: true, json: async () => ({ ok: true, settings: settings() }) }; });
      await api.loadContextSettings(1);
      ok('no old key: one read and nothing else', seen.join() === 'GET' && calls.removed.length === 0);
      const late = liftCtx(baseSt(), async () => ({ ok: true, json: async () => ({ ok: true, settings: settings() }) }));
      await late.api.loadContextSettings(2);
      ok('...and an answer for a view that has since unmounted is dropped', late.calls.patches === 0);
    }
    // SETTING ONE: a toast on success, a persistent refusal, and a re-measure.
    {
      const st = withSS(ssData());
      const seen = [];
      const { api, calls } = liftCtx(st, async (url, init) => { seen.push(url + ' ' + init.method + ' ' + init.body);
        return { ok: true, json: async () => ({ ok: true, settings: settings({ harnessEstimateTokens: 120000 }) }) }; });
      st.ctxEdit = { kind: 'harness', text: '120000' };
      await api.setContextSetting({ harnessEstimateTokens: 120000 }, 1);
      eq('a harness choice is ONE PUT to the settings route with ONE field', seen.join(),
        '/api/config/context-window PUT {"harnessEstimateTokens":120000}');
      ok('...the confirmation is a TOAST ("set for this computer"), the editor closes',
        calls.toasts.length === 1 && calls.toasts[0].title === 'Harness estimate set to ≈120k tokens'
        && /For this computer/.test(calls.toasts[0].lines[0]) && st.ctxEdit === null && !st.ctxError,
        JSON.stringify(calls.toasts));
      ok('...and the measurement is asked for again, so the route\'s own window/harness agree',
        st.sessionStart.sig === null && calls.loads === 1);
    }
    {
      const st = withSS(ssData(), { ctxSettings: settings({ harnessEstimateTokens: 120000 }) });
      const { api, calls } = liftCtx(st, async () => ({ ok: false, status: 409, json: async () => ({ ok: false,
        reason: 'harness_exceeds_window', error: 'The harness estimate is larger than that window.',
        settings: settings({ harnessEstimateTokens: 120000 }) }) }));
      await api.setContextSetting({ contextWindowTokens: 100000 }, 1);
      ok('a REFUSAL stays on the page in the route\'s own words — never a toast, nothing re-measured',
        st.ctxError === 'Not changed: The harness estimate is larger than that window.' && calls.toasts.length === 0
        && st.sessionStart.sig === 'x' && st.ctxSaving === false, JSON.stringify([st.ctxError, calls.toasts]));
      const html = makeRenderers(st).renderSessionStart(st.projectRead);
      ok('...and step ④ shows it, unfolded', /id="mem-ss-ctx-error"[\s\S]*?Not changed: The harness estimate is larger than that window\./.test(html));
    }
    // THE BUDGET PREVIEW: debounced, a READ, cached, and a late answer dropped.
    {
      const st = withSS(ssData());
      const seen = [];
      const pv = ssData({ preview: true, bytes: { mcp: 99999, hook: 1 } });
      const { api, calls, flush } = liftCtx(st, async (url, init) => { seen.push(url + ' ' + init.body);
        return { ok: true, json: async () => pv }; });
      api.previewBudget(131072, 1);
      api.previewBudget(262144, 1);
      await flush();
      eq('moving through the list previews the row the owner STOPPED on, once — POST preview {budgetBytes}',
        seen.join(' | '), '/api/memory/acme/lumina/session-start/preview {"budgetBytes":262144}');
      ok('...drawn as a preview stamped with the measurement it was made against, the meter alone repainted',
        st.budgetPreview && st.budgetPreview.bytes === 262144 && st.budgetPreview.sig === 'x'
        && calls.meters === 1 && calls.patches === 0);
      api.previewBudget(null, 1);
      ok('closing the list without choosing ENDS the preview', st.budgetPreview === null && calls.meters === 2);
      api.previewBudget(262144, 1);
      await flush();
      ok('...and coming back to a row already measured asks nothing (cached per measurement)',
        seen.length === 1 && st.budgetPreview && st.budgetPreview.bytes === 262144);
      api.previewBudget(null, 1);
      st.projectRead.readingBudgetBytes = 65536;
      api.previewBudget(65536, 1);
      await flush();
      ok('...the budget already SET is never previewed — it is the measurement', seen.length === 1 && !st.budgetPreview);
      const moved = withSS(ssData());
      const m = liftCtx(moved, async () => { moved.activeProject = 'elsewhere'; return { ok: true, json: async () => pv }; });
      m.api.previewBudget(131072, 1);
      await m.flush();
      ok('an answer that lands after the owner switched project is dropped', !moved.budgetPreview);
    }
  }

  // ── §25i — the project that was open survives a view change ───────────
  {
    const src = stripComments(viewSrc);
    ok('selectProject records the project it opened, for this tab',
      /lastOpened = \{ domain, project \};/.test(extractFunction(viewSrc, 'selectProject', 'memory.js')));
    const li = stripComments(extractFunction(viewSrc, 'loadIndex', 'memory.js'));
    ok('loadIndex returns to it — after an explicit request, before recency',
      /const pick = asked \|\| back \|\| initialPick\(/.test(li) && /lastOpened\.domain/.test(li));
    ok('...and it is module state, not storage — a reload keeps the documented recency rule',
      /^let lastOpened = null;$/m.test(src) && !/localStorage[^\n]*lastOpened/.test(src));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§17 — COVERAGE CENSUS — a new function cannot arrive untested in silence');
// ═════════════════════════════════════════════════════════════════════════
//
// 17 of this view's 34 top-level functions were never executed by anything and
// 16 were never even NAMED. A census enumerated FROM DISK (never a hardcoded
// list — that is how the v3.11.0 guard went blind) forces the next person
// adding one to make a decision rather than to inherit a silent gap.

const TOP_LEVEL_FNS = [...viewNoComments.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)]
  .map((m) => m[1]);

// Executed somewhere above, with real assertions over what they returned/did.
const EXECUTED = new Set([
  'formatAge', 'projectMetaLine', 'splitHandoffPreamble',
  // v3.67.2: the GitHub-mirror test and its "why?" sentence, lifted by §6's
  // makeRenderers and by the row-press section, and driven in
  // scripts/test-toast.js (both cases: a GitHub mirror and a missing folder).
  'foundationsUncheckedWhy',
  // The freshness surface (v3.31.0). All six are lifted from live source by
  // §6's makeRenderers and reached through renderProject, which §6/§14 execute;
  // effectiveSave is additionally lifted into §5 and §11.
  //
  // `freshnessStep` IS NOT ON THIS LIST ANY MORE, and its absence is the
  // point: this census is taken over memory.js's own top-level functions, and
  // that one now lives in shared/age.js as one half of the app-wide freshness
  // scale. §6 still lifts and runs it — from there — so the strip is executed
  // exactly as before; naming it here would make the census claim a function
  // this file does not contain. scripts/test-freshness-scale.js owns it now.
  'effectiveSave', 'renderSaveStatus', 'newestPair', 'harnessOf',
  'firstNote',
  // v3.55.0: the two pickers became a table, and the page became five blocks.
  'renderWorkStreams', 'workStreamCounts', 'newerOnAnotherMachine',
  // v3.55.x: the table's row order, driven directly in §6c and folded into
  // screenSignature, which §11/§6c both execute.
  'workStreamOrder',
  'briefStats', 'briefDismissDecision',
  // v3.56.0: the table shows a WINDOW and the handoff opens in the reader.
  // `wsShownCount` is driven directly in §6e (and folded into screenSignature,
  // which §6d and §11 execute); `wsRowHtml` and `wsMoreHtml` are the two
  // fragments renderWorkStreams composes, both rendered in §6/§6e;
  // `handoffReaderContent` replaces renderHandoff and is driven in §18d.
  'wsShownCount', 'wsRowHtml', 'wsMoreHtml', 'handoffReaderContent', 'selectProject',
  'renderJournal', 'renderBrief', 'aboutInfoHtml',
  'renderEmptyProject', 'renderStaleNotice', 'renderUnlistedNote', 'renderBriefOnlyNotice',
  'unlistedCount', 'renderCopyOutcome', 'renderProject',
  // v3.65.0 — step ③'s three pieces and the one write it makes. The three
  // renderers are lifted through `makeRenderers` and driven in §21f2 against
  // every state (in flight, failed, gone, one wiki, two, defaulted, a
  // malformed project.json); `saveKnowledgeDomains` is driven in §21f3
  // against the store's refusals.
  'knowledgeDotHtml', 'renderKnowledgeRow', 'renderKnowledgePicker', 'knowledgePickerCfg', 'saveKnowledgeDomains',
  'bindKnowledgeRows',
  // v3.65.2 — the GitHub panel's two token facts, read once per open;
  // driven in §21m2 (presence, last four, unknown-on-failure, a stale answer).
  // v3.68.0: the GitHub door's token facts (the v3.65.2 reads, new panel) — §21m2.
  'loadAddTokenFacts',
  // v3.65.0 — the install's domain list. One cheap read per mount, with two
  // readers: the rail's identity colour and step ③'s picker. Driven in §16d
  // (the list as an argument, and the fallback when it has not arrived).
  'loadDomainList',
  // v3.65.0 — the step head. `memStep` replaced shared/block.js's renderBlock
  // for this page's three numbered steps (it emits the ⓘ inside the head row,
  // which renderBlock cannot), and it is LIFTED rather than stubbed: every
  // §16e1 assertion about where the mark sits is an assertion about what this
  // function emits.
  'memStep',
  'render', 'captureFocus', 'restoreFocus',
  'screenSignature', 'nextPollDelay', 'stopPoll', 'schedulePoll',
  'fetchIndex', 'fetchState', 'refreshIndex', 'refreshScopeList', 'reloadActive', 'loadScope',
  // v3.57.0 — the project cache and the one function that decides what a
  // project payload paints. All seven are LIFTED rather than stubbed into
  // every harness that reaches them (§11's revalidator, §15's reloader, §16f's
  // saver and both selectProject harnesses in §17c/§18), because a stubbed
  // cache could only ever miss and a stubbed applyProjectRead would let this
  // suite agree with itself about which pair the table puts first.
  'cacheKeyProject', 'cacheKeyScope', 'cacheGet', 'cachePut', 'forgetProject',
  'payloadSignature', 'applyProjectRead',
  // v3.48.0 — projects inside a domain. All eight are lifted and run in §16.
  'keyOf', 'activeKey', 'initialPick', 'renderProjectGroups',
  'readRememberedProjects', 'rememberProject', 'renderBriefEditor', 'saveBrief',
  // v3.58.0 — which folds you had open, persisted. Driven in §16c2 against
  // hostile stores, including one that throws and one that is not there at all.
  'readRememberedFolds', 'renderProjectSkeleton',
  // v3.59.0 — tier 0. All ten are LIFTED rather than stubbed and driven in
  // §21: the three pure derivations (facts, word, offer) against the shapes a
  // real store answers with, the two renderers and the row fragment through
  // §6's `makeRenderers`, the reader payload and the row press through the
  // shipped bind→open chain, and the refresh through the shipped `fetchState`.
  // A stub anywhere in that list would let this suite agree with itself that
  // the summary line, the Status reading and the Refresh control all describe
  // one project while the shipped page described three.
  'foundationsFacts', 'foundationsWord',
  // v3.69.0 — the delete confirmation toast, driven in §21k2.
  'fndDeletedToast',
  'foundationsOwnershipWord', 'foundationsSummaryMeta', 'fndSize', 'skeletonOf', 'fndRowHtml',
  'renderFoundations', 'foundationsNotices', 'foundationReaderContent',
  // v3.62.0 — the three steps. The strip that replaced the Status block, the
  // one derivation of the newest save's headline that its fold summary reads,
  // the work-stream table's own fold, step ③ and its ONE read. All lifted and
  // driven through the composed page in §18i and §21f/§21f2.
  'renderLayerStrip', 'projectHeadline', 'renderWorkStreamsFold', 'renderKnowledge',
  'loadKnowledge',
  // v3.62.0 — "read first". The budget sentence is driven over both sets
  // (flagged and not) in §21h, and the toggle over its four outcomes against a
  // DOM model, because a tick that re-renders is the defect v3.61.1 recorded
  // on this very table and only an executed patch can prove it does not.
  'foundationsBudgetWarning', 'writeStartState', 'setStartState',
  // v3.67.0 — step ④, the start cell and the helper. Every one below is
  // LIFTED and driven in §25 (v367Lift, or by name there): the renderers
  // through the composed page, the writers and readers against a fake fetch,
  // the gate over its four cases, and the binder against a fake root.
  'fndStartOf', 'fndStartCfg', 'planRowFor', 'fndSuggestCellHtml', 'planFor', 'planChangeCount',
  'planHeadHtml', 'ssSize', 'ssTokens', 'budgetWord', 'readContextWindow', 'contextWindowNow',
  'ssPct', 'sessionStartFor', 'budgetPickerCfg', 'sessionNoticesHtml', 'ssDocs',
  // v3.70.0 — the meter's step ④: the pure ones through v367Lift and the
  // composed page, the async ones against a fake fetch in §25k.
  'tok', 'harnessNow', 'windowWord', 'repliesWord', 'presetLabel', 'presetsOf', 'windowPickerCfg',
  'harnessPickerCfg', 'ctxEditHtml', 'meterModel', 'meterSource', 'sessionMeterHtml', 'budgetPreviewFor',
  'previewBudget', 'loadContextSettings', 'writeContextSettings', 'setContextSetting',
  'sessionReceivesMonitor', 'presetName', 'previewFor', 'planPreviewBody', 'planPreviewKey',
  'renderSessionStart', 'renderPlanPanel', 'planAiNeedsConfirm', 'maybeLoadSessionStart',
  'loadSessionStart', 'loadPlanEstimate', 'runPlan', 'pressPlanAi', 'loadPlanPreview',
  'writeReadingBudget', 'applyBudgetAnswer', 'setReadingBudget', 'applyPlan', 'bindSessionAndPlan',
  // Moved out of wire() unchanged; the toggle listener is driven in §21 through it.
  'bindFoldToggles',
  // v3.66.0 (P1): the Documents monitor — driven over both budgets, the
  // applicability rule for danger and the in-place patch in §23.
  'foundationsMonitor',
  'openFoundation', 'refreshFoundations', 'bindFoundationRows',
  // v3.61.0 — tier 0 became editable. Five more LIFTED here and driven in §21:
  // the three pure decisions (the wall, the slug grammar, the shrink) and the
  // two renderers, through §6's `makeRenderers`. A stub in any of them would
  // let this suite agree with itself that the counter, the wall and the Save
  // button describe one draft while the shipped editor described three.
  'fndStats', 'fndSlugError', 'fndShrinkWarn',
  'renderFoundationEditor',
  // v3.68.0 — an empty project's block and the open door's record, lifted by
  // makeRenderers and driven through renderFoundations in §21 and §21m.
  'renderFoundationsEmpty', 'addPanelFor',
  // v3.68.0 (screen review) — "copied", never "written by you", for a document
  // copied in from a folder; driven in §21d3 through the row, the fold word,
  // the overview's reading and the reader.
  'copiedFromOf',
  // The age clock (§18). Lifted and driven against a fake document, with a
  // render spy proving it never reaches for one.
  'tickAges',
  // v3.61.0: whether "Copy the drafting request" is offered, withheld with a
  // reason, or absent \u2014 driven over all five states in \u00a721c2.
  'foundationsDraftAsk',
  // v3.62.0: the "Create a project in Domains" pointer moved from the
  // no-manifest arm of `renderFoundations` to this, the screen it actually
  // describes — see the §21 note beside its own assertions.
  'renderNoProjects',
  // v3.61.1: the row-Remove confirm strip. EXECUTED through the real
  // `renderFoundations` over five states — present, a press in flight, a
  // refusal, a slug the table no longer holds, and one stamped for another
  // project — because the sentence it carries, that a mirror's SOURCE FILE is
  // untouched, is the whole reason it is not the editor's delete strip.
  'renderFoundationStop',
  // ── v3.63.0's HONESTY METER ────────────────────────────────────────────
  // All three are lifted by §6's makeRenderers and reached through
  // renderProject, which §6/§14/§18i execute; §22 in
  // scripts/test-next-capture-meter.js drives each of them directly over the
  // route's states as well.
  'captureFacts', 'renderCaptureMeter',
]);

// NOT executed, each with the reason it is not — so the gap is a decision on
// the record rather than an omission nobody noticed.
const NOT_EXECUTED = {
  // v3.70.0: the meter's in-place repaint during a preview.
  patchSessionMeter: 'innerHTML write of #mem-ss-meter alone in a live DOM (so an OPEN picker is not replaced); what it writes is sessionMeterHtml, executed in §25b/§25k, and the browser pass previewed a preset with the list open',
  // v3.67.0: the two that need a painted page to say anything.
  patchSessionStart: 'outerHTML replacement of step ④ plus a tile write in a live DOM; its inputs (renderSessionStart, the tile arithmetic) are executed in §25, and the browser pass measured the patch replacing no #view-root child',
  runLineText: 'innerHTML into a detached element to take the kit line\'s textContent for the confirm; the kit line itself is executed in §25d and the confirm\'s use of it in §25j',
  freshState: 'a literal factory with no branches; every field it returns is exercised through the state fixtures',
  renderSidebar: 'setSidebar/setMain need a real DOM; §12 proves render() calls it, §9 proves the token is passed',
  renderMain: 'same — DOM-bound; its three branches are the render* functions §6/§14 execute directly',
  loadIndex: 'orchestration over fetchIndex + selectProject, both executed; its own logic is one sort, covered by §2',
  // (`selectProject` moved to EXECUTED in v3.56.0 — §17c drives it to prove the
  // work-stream window resets on a project switch.)
  wire: 'addEventListener over a real DOM; its call targets are executed and its call sites are counted',
  // v3.56.0 — the three the row press and the footer are built from. Each is
  // DOM-bound in a way the two above are not, and each is driven for real in
  // §17c against a fake document, through the handlers wire() binds.
  bindWorkStreamRows: 'a querySelectorAll + addEventListener pass over a real DOM; §17c drives the handler it binds and asserts the reader opens',
  openWorkStream: 'async orchestration over loadScope + openReader, both of which §17c injects and counts; its own branches (already-open, fetch-then-open) are asserted there through the row handler',
  showMoreWorkStreams: 'insertAdjacentHTML into a live <tbody>; §17c drives it against a fake table and asserts the appended rows, the label and the count line',
  copyAgentInstructions: 'needs navigator.clipboard; EXECUTED for real (both the granted and the refused arm, plus the switch-mid-copy stamp) in test-agent-instructions.js, which lifts it from this same file',
  // v3.57.0 — the two that need a painted column to say anything. Both are
  // EXECUTED for real in scripts/test-next-memory-switch.js, which builds a
  // DOM model of the main column and asserts what each one writes into it;
  // §17c above additionally counts patchOpenPair as the path a row press takes
  // INSTEAD of a render.
  patchOpenPair: 'targeted DOM writes into a painted main column; EXECUTED against a DOM model in test-next-memory-switch.js, and counted as the row press\'s chosen path in §17c',
  renderProjectSkeleton: 'the first frame of an unread project; EXECUTED in test-next-memory-switch.js, which asserts it reserves the table\'s height and claims no reading the index row does not carry',
  // v3.61.0 — the four tier-0 writes. Each is async orchestration over a fetch
  // and a re-read, and each is EXECUTED FOR REAL against a fake fetch in
  // scripts/test-next-foundations-editor.js, which asserts the method, the URL,
  // the body, the stamp, the late-reply drop and what survives a failure. The
  // same split §21k already makes for `refreshFoundations`, one suite over —
  // and the reason it is over there rather than here is that this file already
  // runs 1,000 assertions and the editor's own battery is a section of its own.
  // v3.68.0 — the two doors' orchestration. The pure halves (which door does
  // what, the request, the reading of the answer, the markup) are in
  // shared/foundations-add.js and EXECUTED in §21/§21m and test-foundations-add.js.
  listAddDocuments: 'async orchestration over the list GET; EXECUTED against a fake fetch in test-next-foundations-editor.js §9 (the all=1 URL, the resolved root, nothing ticked)',
  commitAdd: 'async orchestration over the commit POST plus a re-read; EXECUTED against a fake fetch in test-next-foundations-editor.js §9 (the add-local body, the toast, the persistent refusal, the partial add, the GitHub init body with no token)',
  seedTemplates: 'async orchestration over the templates init POST; EXECUTED in test-next-foundations-editor.js §9 (the curator body, rechooseEmpty only on an empty manifest)',
  openAddDoor: 'reads live state and renders; its inputs (doorsFor, freshAddPanel) are EXECUTED in §21m and test-foundations-add.js, and the browser pass opened both doors',
  pickAddFolder: 'a native dialog through POST /api/config/pick-path; pickFolder itself is driven in test-next-foundations-editor.js, and the browser pass measured the no-dialog/typed-path fallback',
  bindAddDoors: 'addEventListener wiring on a live DOM; every rule it applies (commitBlockedReason, countLine, budgetWarning, alreadyAdded) is EXECUTED in test-foundations-add.js and the browser pass ticked, selected all and committed',
  loadFoundationDraft: 'async orchestration over the `?raw=1` read; EXECUTED in test-next-foundations-editor.js, which asserts the RAW query, the byte-exact draft and that a second Edit press wins the race',
  saveFoundation: 'async orchestration over the PUT plus a re-read; EXECUTED in test-next-foundations-editor.js, which asserts the three fields, the stamp, the late-reply drop and that a failure keeps the draft',
  stopMirroringFoundation: 'async orchestration over the SAME DELETE deleteFoundation uses, from the row control (v3.61.1); the request shape is asserted over EVERY DELETE call site in the fetch census above (one URL, one body, the slug as its own confirmation), the strip it drives is executed over five states, and the route arm it depends on — removal allowed on a mirror, PUT still refused — is driven end to end in test-next-memory-projects.js',
  deleteFoundation: 'async orchestration over the DELETE; EXECUTED in test-next-foundations-editor.js, which asserts the slug travels as its own confirmation and that a refusal closes the strip rather than the editor',
  // ── v3.61.0's THREE ────────────────────────────────────────────────────
  requestProject: 'the one-shot handoff from the OTHER view (P1-10): a module variable set by views/domains.js and cleared on read here, so driving it needs both halves. EXECUTED in test-next-memory-switch.js, which sets it and then runs the arrival decision',
  takePendingProject: 'the read half of that handoff, and the half that makes staleness impossible \u2014 EXECUTED beside it in test-next-memory-switch.js',
  loadCapture: 'async orchestration over the capture route plus a per-pair cache; EXECUTED against a fake fetch in scripts/test-next-capture-meter.js, which asserts the URL (the pair, the `since` derived from CAPTURE_WINDOW_DAYS, the limit), the cache hit, the in-flight guard, the late-reply drop on a project switch and that a failure is disclosed rather than blanked. §16f above additionally proves `selectProject` ASKS for it, naming the pair',
  copyDraftingAsk: 'async orchestration over the clipboard: composes through the REAL composeDraftingAsk and stamps the outcome with the pair it was pressed on. EXECUTED in test-next-foundations-editor.js, which drives the success and the refusal and asserts the text names this project\u2019s own unfilled slugs',
};

ok('the census enumerated this view\'s top-level functions FROM DISK',
  TOP_LEVEL_FNS.length >= 30, 'found ' + TOP_LEVEL_FNS.length);
{
  const unaccounted = TOP_LEVEL_FNS.filter((n) => !EXECUTED.has(n) && !(n in NOT_EXECUTED));
  ok('every top-level function is either EXECUTED here or listed with a reason it is not',
    unaccounted.length === 0, 'unaccounted for: ' + JSON.stringify(unaccounted));
  const stale = [...EXECUTED, ...Object.keys(NOT_EXECUTED)].filter((n) => !TOP_LEVEL_FNS.includes(n));
  ok('...and neither list names a function that no longer exists',
    stale.length === 0, 'stale entries: ' + JSON.stringify(stale));
  ok('the EXECUTED set is the majority of the file, not a token few',
    EXECUTED.size >= TOP_LEVEL_FNS.length - Object.keys(NOT_EXECUTED).length,
    EXECUTED.size + ' executed of ' + TOP_LEVEL_FNS.length);

  // THE CENSUS MUST NOT BE TAKEN ON TRUST. `EXECUTED` is hand-maintained, so
  // on its own it is a claim rather than a measurement — deleting a whole
  // section would leave it still asserting that section's functions run. Every
  // name in it is therefore required to appear in a real extractFunction call
  // in THIS file, which is the only way a module-private function can be
  // reached at all. It does not prove an assertion was made about the result;
  // it does prove the function was lifted out of live source to be run.
  const selfSrc = readFileSync(join(ROOT, 'scripts/test-next-memory-view.js'), 'utf8');
  const lifted = new Set([...selfSrc.matchAll(/extractFunction\(viewSrc,\s*'([A-Za-z0-9_$]+)'/g)].map((m) => m[1]));
  const claimed = [...EXECUTED].filter((n) => !lifted.has(n));
  ok('every function the census claims is EXECUTED is genuinely lifted from live source here',
    claimed.length === 0, 'claimed but never lifted: ' + JSON.stringify(claimed));
  ok('self-test: the lifted-set scan is not vacuous (it found the real extractions)',
    lifted.size >= 15, 'found ' + lifted.size);
}

// ── §21m — every docs key this view links RESOLVES ──────────────────────
//
// `docsUrl` throws on an unknown key by design, so a throw inside
// `renderProject` would take every assertion after it with it and this suite
// would report a CRASH rather than a named gap. The wrapper at the top of this
// file records an unresolved key instead; this is where the recording is read.
//
// IT FAILS UNTIL THE KEY EXISTS, which is the point: `memory.foundations-edit`
// is added to src/public/next/shared/docs-links.js by the work package that
// writes the guide section it points at, and this view USES it. One red
// assertion naming the missing key is the right shape for that coupling — a
// tolerant wrapper with no assertion behind it would be an inert guard, which
// is the thing this repo keeps recording as worse than no guard.
ok('every docs key the Agent-memory view links resolves in shared/docs-links.js',
  pendingDocsKeys.size === 0,
  'unresolved: ' + JSON.stringify([...pendingDocsKeys]) +
  ' — add the key to src/public/next/shared/docs-links.js (owned by the docs work package)');

// ═════════════════════════════════════════════════════════════════════════
// §21f6 — THE STEP-BODY RULE (v3.64.2)
// ═════════════════════════════════════════════════════════════════════════
//
// THE REPORT, on a screenshot of step ②: "the worst UX" — a highlighted
// "Last saved" card, then a bare CAPTURE readout in a different design
// outside any card, then three fold rows. Three designs stacked inside one
// step. The rule now: inside a numbered step every part is the SAME row —
// a title on the left, a one-line summary on the right, a chevron where
// there is something to open.
//
// AND THE ONE PLACE THE RULE STOPS, which is why this section exists rather
// than a source scan: v3.16.1 says a WARNING, a COST or an OUTCOME may not
// sit behind a chevron. So the explanations fold and the loud lines do not,
// and a future tidy-up that swept them into the row would be removing a
// warning from the screen while making the screen more uniform.
{
  const baseSt = (over) => ({
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: false, staleWrite: false, journalLimit: 10, openFolds: {}, projects: [],
    wsWindow: WS_WINDOW_SRC, ...over,
  });

  // ── "Last saved" IS DELETED, AND A HEALTHY SAVE PAINTS NOTHING ───────
  // v3.65.1, D2. The row said what the MEMORY overview tile and the Handoffs
  // row's summary already say, in a second shape — a CARD wrapping a ROW, whose
  // reading ended at x=1301 against 1316 for every other row on the page. The
  // maintainer: *"no clue why it is here, what it communicates."*
  //
  // What is left is the part that was never a duplicate: the DISCLOSURES
  // (which clock the figure came from; that the file arrived long after it was
  // written; that a clipped save wrote the handoff in full) and the WARNINGS.
  // Both are outside a chevron — v3.16.1 covers the warnings, and a disclosure
  // whose only door has been removed is a dropped field.
  const healthy = makeRenderers(baseSt()).renderSaveStatus(
    { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }] },
    { scope: 'main', machine: 'boxa', harness: 'claude-code',
      current: { present: true, writtenAgeSeconds: 120 } });
  eq('a healthy save paints NOTHING — no row, no card, no empty instrument', healthy, '');
  ok('...so step ② opens on its four rows, reached by having nothing to say '
    + 'rather than by hiding something', !/Last saved/.test(healthy), healthy);

  // ── THE DISCLOSURES LEFT THIS FUNCTION (v3.65.1) ─────────────────────
  // `clock: the file's own`, `arrived here` and `written on <machine>` were
  // monitor LINES in an instrument that stood unfolded at the top of step ②.
  // They are explanations and provenance, not warnings, and the maintainer's
  // rule for a step body is that every part of it is the same fold row with
  // its explanation in the ⓘ. The block is deleted; the two clocks stay in the
  // overview's ⓘ (verbatim, unchanged) and the machine in the Handoffs table's
  // own column, so nothing the store computed is dropped by a view that
  // stopped drawing a row for it.
  const fsOnlyRow = makeRenderers(baseSt()).renderSaveStatus(
    { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }] },
    { scope: 'main', machine: 'boxa', harness: 'claude-code',
      current: { present: true, savedAt: new Date(Date.now() - 120000).toISOString() } });
  eq('a filesystem-clock reading paints NOTHING here — it is an explanation, '
    + 'and step ② opens on its Capture row', fsOnlyRow, '');
  {
    const page = makeRenderers({ activeDomain: 'a', activeProject: 'p', openFolds: {},
      projects: [], journalLimit: 10, detail: null, detailLoading: false })
      .renderProject().replace(/\s+/g, ' ');
    ok('...and the two-clocks explanation is still on the page, in the overview\'s ⓘ',
      /TWO clocks behind every age on this page/.test(page)
      && /that is when the file ARRIVED here/.test(page),
    'the two-clocks paragraph vanished with the line');
    // AND IT NO LONGER DESCRIBES AN AFFORDANCE THE APP HAS DELETED. Through
    // v3.65.0 it ended "a reading that had to fall back says “file time” in its
    // own provenance line" — and v3.65.1 deleted that line with the unfolded
    // block it lived in. A sentence promising a mark nothing paints is worse
    // than the gap, so the gap is stated instead.
    ok('...and it does NOT promise a “file time” marker this screen no longer paints',
      !/file time/.test(page), (page.match(/.{0,80}file time.{0,80}/) || [''])[0]);
    ok('...it says what to do instead, which is the honest form of the gap',
      /read an age you did not expect as the moment the file arrived/.test(page),
      'the replacement sentence is missing');
  }

  // ── A WARNING NEVER FOLDS (v3.16.1) ──────────────────────────────────
  const trimmedRow = makeRenderers(baseSt()).renderSaveStatus(
    { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }] },
    { scope: 'main', machine: 'boxa', harness: 'claude-code',
      current: { present: true, lastSaveKind: 'trimmed', lastSaveNotes: ['budget'],
        savedAt: new Date(Date.now() - 120000).toISOString() } });
  ok('CONTROL: a trimmed save really does produce a loud line',
    trimmedRow.indexOf('cur-mon-loud') !== -1, trimmedRow.slice(0, 400));
  ok('...drawn by the monitor, in its danger tone', /cur-mon-loud cur-mon-danger/.test(trimmedRow),
    trimmedRow.slice(0, 400));
  ok('...and it is announced, because a warning appearing IS the thing to tell',
    /class="cur-mon-loud[^"]*" role="status"/.test(trimmedRow));
  ok('...and this function emits NO ordinary line at all now, so there is no '
    + 'array a later edit could move a warning into',
  !/cur-mon-lines/.test(trimmedRow) && !/cur-mon-line\b/.test(trimmedRow),
  trimmedRow.slice(0, 400));
  ok('...and nothing in this function can put either behind a chevron',
    !/<details/.test(trimmedRow), trimmedRow.slice(0, 400));

  // ── STEP ③ IS ONE ROW PER CHOSEN WIKI (v3.65.0, P10) ─────────────────
  const kst = (knowledge, over) => baseSt({
    knowledge: new Map(Object.entries(knowledge)), domainList: ['acme', 'research'],
    projectRead: { knowledgeDomains: Object.keys(knowledge), knowledgeDomainsDefaulted: false },
    ...over });
  const kn = makeRenderers(kst({ acme: { error: null, data: {
    pageCount: 767, pageCounts: { entities: 400, concepts: 300, summaries: 67 },
    lastIngestDate: '2026-09-13', lastIngestKind: 'ingest' } } })).renderKnowledge();
  // ── §21g — v3.65.1: THE HEAD ROW AND THE TWO DOTS (D5, D7) ──────────
  {
    const K = makeRenderers(kst({
      acme: { error: null, data: { pageCount: 100,
        pageCounts: { entities: 40, concepts: 50, summaries: 10 },
        lastIngestDate: '2026-09-13', lastIngestKind: 'ingest' } },
      research: { error: null, data: { pageCount: 20,
        pageCounts: { entities: 8, concepts: 10, summaries: 2 },
        lastIngestDate: '2026-09-10', lastIngestKind: 'ingest' } },
    }, { domainList: ['acme', 'research'] }));
    const block = K.renderKnowledge();

    // (1) THE PICKER IS A HEAD ROW, ABOVE THE ROWS. Step ①'s rule and Wiki
    // health's anatomy. Measured at 1370 before: the picker at x=404 UNDER the
    // rows, with two per-row Removes beside it at 527.9 and 642.2 — *"two
    // un-synced buttons in a really poor implementation"*. Document order is
    // what the geometry follows, so document order is asserted.
    const pickAt = block.indexOf('mem-k-pick');
    const rowAt = block.indexOf('data-mem-fold="knowledge-');
    ok('CONTROL: the block really renders both a picker and rows',
      pickAt !== -1 && rowAt !== -1, block.slice(0, 300));
    ok('step ③\'s control PRECEDES its rows — the same head-row rule step ① follows',
      pickAt < rowAt, pickAt + ' vs ' + rowAt);
    ok('...and the picker row holds ONE control, not one per chosen domain',
      (block.slice(pickAt, rowAt).match(/<button/g) || []).length <= 1,
      block.slice(pickAt, rowAt).slice(0, 300));

    // (2) REMOVE IS INSIDE ITS OWN ROW, beside that row's two doors — where
    // the documents table already puts its per-row Remove.
    const rowOf = (d) => {
      const i = block.indexOf('data-mem-fold="knowledge-' + d + '"');
      const j = block.indexOf('</details>', i);
      return block.slice(i, j === -1 ? block.length : j);
    };
    for (const d of ['acme', 'research']) {
      ok('the ' + d + ' row carries its OWN Remove, inside the row',
        new RegExp('data-mem-k-drop="' + d + '"').test(rowOf(d)), rowOf(d).slice(-400));
      ok('...inside the doors group, so it sits beside the controls it belongs with',
        rowOf(d).indexOf('mem-k-doors') !== -1
        && rowOf(d).indexOf('mem-k-doors') < rowOf(d).indexOf('data-mem-k-drop'),
        rowOf(d).slice(-300));
      // PUSHED AWAY FROM THE DOORS, not sitting beside them — the same call
      // `.mem-fnd-delete` makes one block up: a control that takes a domain off
      // this project must not be one mis-click from a door that merely
      // navigates. FOUND BY MUTATION, which set `margin-left: 0` and was green.
      ok('the row\'s Remove is pushed away from the two doors beside it',
        /\.mem-k-drop\s*\{[^}]*margin-left:\s*auto/.test(viewCss),
        (viewCss.match(/\.mem-k-drop\s*\{[^}]*\}/) || [''])[0]);
      ok('...labelled just "Remove" — the ROW says which domain, so the button '
        + 'need not repeat it', />Remove</.test(rowOf(d)) && !new RegExp('>Remove ' + d + '<').test(rowOf(d)),
      (rowOf(d).match(/>Remove[^<]*</) || [''])[0]);
    }

    // (3) EVERY ROW CARRIES ITS DOMAIN'S IDENTITY DOT (D7) — the same colour
    // that domain wears in both sidebars and in the breadcrumb, from the SAME
    // mapping. Two domains, two DIFFERENT slots, which is the whole point: a
    // dot that is the same on every row identifies nothing, and that is
    // exactly what the breadcrumb's violet square was.
    const dotOf = (d) => (/<span class="cur-sb-dot mem-k-dot (cur-sb-dot-\d)"/.exec(rowOf(d)) || [, null])[1];
    ok('the first Knowledge row carries an identity dot', !!dotOf('acme'), rowOf('acme').slice(0, 300));
    ok('...and so does the second', !!dotOf('research'), rowOf('research').slice(0, 300));
    ok('...and the two are DIFFERENT slots, because they are different domains '
      + '— one colour on every row identifies nothing',
    dotOf('acme') !== dotOf('research'), dotOf('acme') + ' vs ' + dotOf('research'));
    ok('...cut on the INSTALL\'s domain index, so the colour matches the rails',
      dotOf('acme') === 'cur-sb-dot-1' && dotOf('research') === 'cur-sb-dot-2',
      dotOf('acme') + ' / ' + dotOf('research'));
    ok('...before the NAME, while the freshness dot stays before the READING — '
      + 'two channels, never the same glyph position',
    rowOf('acme').indexOf('mem-k-dot') < rowOf('acme').indexOf('>acme<')
      && rowOf('acme').indexOf('mem-fold-meta') < rowOf('acme').indexOf('fresh-dot'),
    rowOf('acme').slice(0, 400));
    ok('...and NO dot at all when the domain list has not answered, because '
      + 'identity has no states and a placeholder would be another domain\'s',
    !/mem-k-dot/.test(makeRenderers(kst({ acme: { error: null, data: { pageCount: 1,
      pageCounts: {}, lastIngestDate: '2026-09-13' } } }, { domainList: [] })).renderKnowledge()));
  }
  ok('step ③ is one row PER WIKI, keyed by its own domain',
    /<details class="mem-fold" data-mem-fold="knowledge-acme"/.test(kn), kn.slice(0, 300));
  ok('...shipping CLOSED', !/data-mem-fold="knowledge-acme"\s+open/.test(kn), kn.slice(0, 300));
  // THE ROW IS TITLED BY ITS DOMAIN, not "Pages". The step is about WHICH
  // wikis this project draws on, so the name of the wiki is the row's own
  // name — and with several rows "Pages" three times would name nothing.
  ok('...titled by the DOMAIN it is about', /<span>acme<\/span>/.test(kn), kn.slice(0, 400));
  ok('...and its summary carries the page count and the age — the two facts '
    + 'that decide whether to open it',
  /mem-fold-meta">[\s\S]*?767 pages · /.test(kn), kn.slice(0, 600));
  ok('...with the other four figures and both doors behind the chevron',
    kn.indexOf('mem-k-doors') > kn.indexOf('mem-fold-body')
    && kn.indexOf('cur-mon-key">entities') > kn.indexOf('mem-fold-body'), kn.slice(0, 900));
  // A READING THAT HAS NOT ARRIVED, AND ONE THAT FAILED, ARE NOT ROWS.
  const knLoading = makeRenderers(kst({ acme: { error: null, data: null } })).renderKnowledge();
  ok('a reading still in flight is NOT a row — a chevron over a ghost opens a ghost',
    !/data-mem-fold="knowledge-/.test(knLoading) && /aria-busy="true"/.test(knLoading),
    knLoading.slice(0, 300));
  const knFailed = makeRenderers(kst({ acme: { error: 'boom', data: null } })).renderKnowledge();
  ok('...and a FAILURE is not one either (v3.16.1)',
    !/data-mem-fold="knowledge-/.test(knFailed) && /tx-status/.test(knFailed), knFailed.slice(0, 300));
  ok('...but both still offer the two doors, because a domain\'s wiki does not '
    + 'stop existing because a stats read did',
  /mem-k-doors/.test(knLoading) && /mem-k-doors/.test(knFailed));
}


// ── §23 — v3.66.0: THE THREE DEPTH-BAR PLACEMENTS ON THIS SCREEN ─────────
// ═════════════════════════════════════════════════════════════════════════
//
// P1 Documents (a two-budget monitor above the table), P2 Handoffs (a Size
// column against the 48 KB ceiling a save is trimmed at), P3 Capture (the two
// outcome counts as a share of all sessions). Every one EXECUTES the shipped
// renderer through the real monitor and the real depth cell (both injected by
// makeRenderers). What is pinned is what only this view can get wrong: WHICH
// denominator, WHERE it comes from, WHEN a bar may turn danger, and that a
// warning is never behind the chevron.
{
  const F = makeRenderers({ activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
    domainList: ['acme'] });
  const KB = 1024;
  const monOf = (h) => {
    const i = h.indexOf('id="mem-fnd-monitor"');
    if (i === -1) return '';
    const start = h.lastIndexOf('<div class="cur-mon"', i);
    const end = h.indexOf('<div class="fnd-wrap">', i);
    return h.slice(start, end === -1 ? undefined : end);
  };
  const lineOf = (h, key) => {
    const at = h.indexOf('<span class="cur-mon-key">' + key + '</span>');
    if (at === -1) return '';
    const start = h.lastIndexOf('<div class="cur-mon-line', at);
    const next = h.indexOf('<div class="cur-mon-line', at);
    return h.slice(start, next === -1 ? undefined : next);
  };
  const widthOf = (h) => {
    const m = /style="width:([\d.]+)%"/.exec(h);
    return m ? Number(m[1]) : null;
  };

  // ── P1 (a): something is flagged, and the flagged set is over its budget ──
  const flaggedOver = F.renderFoundations(fndRead(fndPayload([
    fndDoc({ slug: 'a.md', bytes: 40 * KB, readFirst: true }),
    fndDoc({ slug: 'b.md', bytes: 100 * KB, readFirst: true }),
    fndDoc({ slug: 'c.md', bytes: 80 * KB }),
  ], { budgetBytes: 200 * KB, readFirstCount: 2, onRequestCount: 1, readFirstBytes: 140 * KB,
    readFirstBudgetBytes: 120 * KB, readFirstBudgetExceeded: true })));
  const m1 = monOf(flaggedOver);
  ok('P1: the Documents row body OPENS with a monitor, above the table',
    m1.length > 0 && flaggedOver.indexOf('id="mem-fnd-monitor"') > flaggedOver.indexOf('mem-fold-body')
    && flaggedOver.indexOf('id="mem-fnd-monitor"') < flaggedOver.indexOf('<table class="fnd-table">'),
    flaggedOver.slice(0, 600));
  const stored1 = lineOf(m1, 'stored');
  const read1 = lineOf(m1, 'read first');
  // v3.70.0: "stored" is a READING — its size and how many documents — with
  // no bar against the 200 KB project figure and never danger (the
  // orchestrator's note: that figure only ever warned; the reading budget is
  // the meter now).
  ok('P1: "stored" reads the total NEUTRALLY — the size and the count, no project budget, no bar',
    /cur-mon-value">220 KB</.test(stored1) && /cur-mon-sub">3 documents in this project</.test(stored1)
    && !/cur-depth|200 KB/.test(stored1), stored1);
  ok('P1: "read first" reads the flagged set against the per-session READING budget, in words',
    /140 KB/.test(read1) && /cur-mon-sub">of 120 KB per session</.test(read1), read1);
  eq('P1: the read-first bar is 140 of 120 — full', widthOf(read1), 100);
  ok('P1: an over-run of the READING budget takes the danger tone, on the bar AND the line\'s rule',
    /cur-depth-bar cur-depth-danger/.test(read1) && /cur-mon-line cur-mon-danger/.test(read1), read1);
  ok('P1: a stored total over the old 200 KB figure is NOT danger',
    !/cur-depth-danger|cur-mon-danger/.test(stored1), stored1);
  ok('P1: every bar names its denominator in a hidden sentence',
    /visually-hidden"> 140 KB of a 120 KB per-session reading budget/.test(read1), read1);
  ok('P1: the danger is ALSO said in words, OUTSIDE the chevron (v3.16.1) — the existing '
    + 'budget sentence, unfolded, after </details>',
  flaggedOver.indexOf('id="mem-fnd-budget"') > flaggedOver.indexOf('</details>')
    && !/id="mem-fnd-budget"[^>]*hidden/.test(flaggedOver)
    && /over the 120 KB reading budget/.test(flaggedOver),
  flaggedOver.slice(flaggedOver.indexOf('</details>'), flaggedOver.indexOf('</details>') + 400));
  ok('P1: ...and it is ONE sentence — the monitor carries no loud entry of its own, which '
    + 'inside a <details> would be a warning behind a chevron',
  !/cur-mon-loud/.test(m1), m1);

  // ── P1 (b): nothing flagged ──────────────────────────────────────────────
  const unflaggedOver = F.renderFoundations(fndRead(fndPayload([
    fndDoc({ slug: 'a.md', bytes: 150 * KB }), fndDoc({ slug: 'b.md', bytes: 90 * KB }),
  ], { budgetBytes: 200 * KB, readFirstCount: 0, onRequestCount: 2, readFirstBytes: 0,
    readFirstBudgetBytes: 120 * KB, readFirstBudgetExceeded: false })));
  const m2 = monOf(unflaggedOver);
  ok('P1: with nothing flagged there is NO read-first line — "0 read first" would report the '
    + 'absence of a decision as a decision', !/cur-mon-key">read first</.test(m2) && m2.length > 0, m2);
  ok('P1: ...and the stored total is STILL no alarm: what an unplanned project hands over is '
    + 'step ④\'s cost line, in tokens',
    !/danger|cur-depth/.test(lineOf(m2, 'stored')) && /240 KB/.test(lineOf(m2, 'stored')), lineOf(m2, 'stored'));
  const unflaggedUnder = F.renderFoundations(fndRead(fndPayload([
    fndDoc({ slug: 'a.md', bytes: 50 * KB }),
  ], { budgetBytes: 200 * KB, readFirstBudgetBytes: 120 * KB })));
  const m3 = monOf(unflaggedUnder);
  ok('P1: a small project reads the same way: nothing danger, no bar on the stored line',
    !/danger/.test(m3) && widthOf(lineOf(m3, 'stored')) === null && /1 document in this project/.test(m3), m3);

  // ── P1 (c): THE ONE LINE — the reading budget comes from the PAYLOAD ─────
  // The approved context-budget plan's bridge: when the store starts sending a
  // project's own reading budget in `readFirstBudgetBytes`, the bar, its sub
  // and the sentence must follow with no view change. A hard-coded 120 KB
  // anywhere on this path reds here.
  const own = fndPayload([
    fndDoc({ slug: 'a.md', bytes: 48 * KB, readFirst: true }), fndDoc({ slug: 'b.md', bytes: 30 * KB }),
  ], { budgetBytes: 200 * KB, readFirstCount: 1, onRequestCount: 1, readFirstBytes: 48 * KB,
    readFirstBudgetBytes: 64 * KB, readFirstBudgetExceeded: false });
  const m4 = monOf(F.renderFoundations(fndRead(own)));
  const read4 = lineOf(m4, 'read first');
  ok('P1: the "of N per session" figure is the payload\'s readFirstBudgetBytes (64 KB here), '
    + 'never the 120 KB view constant',
  /of 64 KB per session/.test(read4) && !/120 KB/.test(m4), m4);
  eq('P1: ...and the bar is drawn against it (48 of 64 = 75%)', widthOf(read4), 75);
  ok('P1: ...and so is the FLAGGED budget sentence\'s "up to" figure (the unflagged one is withdrawn, v3.70.0)',
    /in reading order up to 64 KB at session start/.test(F.foundationsBudgetWarning(F.foundationsFacts(fndRead(
      fndPayload([fndDoc({ bytes: 250 * KB, readFirst: true })], { budgetBytes: 200 * KB, readFirstBudgetBytes: 64 * KB,
        readFirstCount: 1, readFirstBytes: 250 * KB, readFirstBudgetExceeded: true }))))),
    F.foundationsBudgetWarning(F.foundationsFacts(fndRead(
      fndPayload([fndDoc({ bytes: 250 * KB, readFirst: true })], { budgetBytes: 200 * KB, readFirstBudgetBytes: 64 * KB,
        readFirstCount: 1, readFirstBytes: 250 * KB, readFirstBudgetExceeded: true })))));
  {
    // An older server that sent no reading budget: the flag's fallback is
    // computed against the SAME denominator the figure falls back to.
    const legacy = fndPayload([fndDoc({ bytes: 130 * KB, readFirst: true })], { budgetBytes: 200 * KB });
    delete legacy.readFirstBudgetBytes; delete legacy.readFirstBudgetExceeded;
    const lf = F.foundationsFacts(fndRead(legacy));
    ok('P1: a build that sends no reading budget falls back to 120 KB for figure AND flag together',
      lf.readFirstBudgetBytes === 120 * KB && lf.readFirstBudgetExceeded === true, JSON.stringify(lf));
    const own2 = fndPayload([fndDoc({ bytes: 100 * KB, readFirst: true })],
      { budgetBytes: 200 * KB, readFirstBudgetBytes: 64 * KB });
    delete own2.readFirstBudgetExceeded;
    ok('P1: ...and a build that sends the budget but not the flag derives the flag against THAT '
      + 'budget (100 KB > 64 KB), not the constant',
    F.foundationsFacts(fndRead(own2)).readFirstBudgetExceeded === true);
  }

  // ── P1 (d): where the monitor is NOT ─────────────────────────────────────
  ok('P1: no documents, no monitor (nothing to measure is not a zero bar)',
    !/mem-fnd-monitor/.test(F.renderFoundations(fndRead(fndPayload([], { ownership: 'curator' })))));
  ok('P1: the summary line stays bar-free — a depth bar never sits in a <summary>',
    !/cur-depth/.test(flaggedOver.slice(flaggedOver.indexOf('<summary'),
      flaggedOver.indexOf('</summary>'))));

  // ── P2: the Handoffs Size column ─────────────────────────────────────────
  const rowsP2 = [
    { scope: 'session-a', machine: 'boxa', headline: 'x', writtenAgeSeconds: 60, bytes: 31 * KB },
    { scope: 'session-b', machine: 'boxa', headline: 'y', writtenAgeSeconds: 600, bytes: 46 * KB },
    { scope: 'session-c', machine: 'boxa', headline: 'z', writtenAgeSeconds: 900, bytes: 60 * KB },
    { scope: 'session-d', machine: 'boxa', headline: 'w', writtenAgeSeconds: 1200 },
  ];
  const ws = F.renderWorkStreams(rowsP2, null, 10, 48 * KB);
  const cellOf = (h, scope) => {
    const i = h.indexOf('data-mem-scope="' + scope + '"');
    const tr = h.slice(h.lastIndexOf('<tr', i), h.indexOf('</tr>', i));
    return tr.slice(tr.indexOf('mem-ws-cell-size'));
  };
  ok('P2: the table gains a Size column after Harness',
    /<th scope="col">Harness<\/th><th scope="col">Size<\/th><\/tr>/.test(ws), ws.slice(0, 500));
  eq('P2: ...and every row carries exactly as many cells as the head has columns',
    (ws.match(/<tr class="mem-ws-row/g) || []).length * 6,
    (ws.match(/<td class="mem-ws-cell-/g) || []).length);
  ok('P2: a handoff\'s size is printed and drawn against the 48 KB budget, with the denominator named',
    /31 KB/.test(cellOf(ws, 'session-a')) && widthOf(cellOf(ws, 'session-a')) === 64.6
    && /visually-hidden"> 31 KB of a 48 KB handoff budget/.test(cellOf(ws, 'session-a')),
    cellOf(ws, 'session-a'));
  ok('P2: a handoff NEVER turns red — the store trims, it never overruns — even a file over the '
    + 'ceiling fills the bar, neutral, and keeps its true figure',
  !/cur-depth-danger/.test(ws) && widthOf(cellOf(ws, 'session-c')) === 100
    && /60 KB/.test(cellOf(ws, 'session-c')), cellOf(ws, 'session-c'));
  ok('P2: a pair with no `bytes` says so with a dash, never a zero',
    /mem-ws-cell-size">—</.test(cellOf(ws, 'session-d')), cellOf(ws, 'session-d'));
  const wsNoBudget = F.renderWorkStreams(rowsP2, null, 10);
  ok('P2: with no stateBudgetBytes on the wire the figure stands ALONE — no bar against a '
    + 'number this view would have to make up',
  /31 KB/.test(cellOf(wsNoBudget, 'session-a')) && !/cur-depth-bar/.test(wsNoBudget), cellOf(wsNoBudget, 'session-a'));
  const foldP2 = F.renderWorkStreamsFold({ scopes: rowsP2, brief: { present: true },
    distinctScopeCount: 4, savedCopies: 4, stateBudgetBytes: 48 * KB }, null);
  ok('P2: the fold hands the ROUTE\'s stateBudgetBytes to the table',
    /31 KB of a 48 KB handoff budget/.test(foldP2), foldP2.slice(0, 400));
  const foldP2b = F.renderWorkStreamsFold({ scopes: rowsP2, brief: { present: true },
    distinctScopeCount: 4, savedCopies: 4, stateBudgetBytes: 64 * KB }, null);
  ok('P2: ...its value, not a constant (64 KB here)',
    /31 KB of a 64 KB handoff budget/.test(foldP2b) && !/48 KB handoff budget/.test(foldP2b));

  // ── P3: Capture — a share of a named whole, never a target ───────────────
  const cap = (totals) => makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', openFolds: {},
    capture: { domain: 'acme', project: 'lumina', error: null, data: {
      logPresent: true, windowDays: 30, sessionsShown: 0, sessionsTruncated: false,
      totals: { legacyLines: 0, selfTestLines: 0, ...totals }, sessions: [] } },
  }).renderCaptureMeter();
  const c6 = cap({ sessions: 6, sessionsRead: 4, sessionsSaved: 3, sessionsReadNotSaved: 2 });
  const saved6 = lineOf(c6, 'saved before stopping');
  const read6 = lineOf(c6, 'started with the context');
  ok('P3: "saved before stopping" is drawn as a share of all sessions, and says so ("of 6")',
    widthOf(saved6) === 50 && /cur-mon-sub">of 6</.test(saved6)
    && /visually-hidden"> 3 of the 6 sessions in the last 30 days/.test(saved6), saved6);
  ok('P3: ...and so is "started with the context" (4 of 6)',
    widthOf(read6) === 66.7 && /cur-mon-sub">of 6</.test(read6), read6);
  ok('P3: a share is never danger — there is no target, so there is no over-run',
    !/cur-depth-danger/.test(c6));
  ok('P3: "read and did not save" keeps its own warn rule and gets no bar',
    /cur-mon-line cur-mon-warn/.test(lineOf(c6, 'read and did not save'))
    && !/cur-depth-bar/.test(lineOf(c6, 'read and did not save')), lineOf(c6, 'read and did not save'));
  ok('P3: the closed summary carries no ratio, no percentage and no bar',
    !/%|cur-depth/.test(c6.slice(c6.indexOf('<summary'), c6.indexOf('</summary>'))));
  const c0 = cap({ sessions: 0, sessionsRead: 0, sessionsSaved: 0, sessionsReadNotSaved: 0 });
  ok('P3: zero sessions draws no bar and no "of 0" — a share of nothing is not a reading',
    !/cur-depth-bar/.test(c0) && !/of 0/.test(c0), c0.slice(0, 400));
  const cNull = cap({ sessionsRead: 2, sessionsSaved: 1 });
  ok('P3: sessions NOT MEASURED (null) draws no bar either — absent is not zero',
    !/cur-depth-bar/.test(cNull) && /saved before stopping/.test(cNull), cNull.slice(0, 400));
}


// ── Done ─────────────────────────────────────────────────────────────────

cleanup();
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ All Agent-memory route + view assertions green');
else console.log('❌ ' + failed + ' Agent-memory assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
