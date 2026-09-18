/**
 * src/routes/memory.js — Agent memory over HTTP.
 *
 * The HTTP face of `src/brain/working-state.js` for the /next shell's
 * "Agent memory" view and for the Domains view's Projects sub-section.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * v3.48.0 — PROJECTS INSIDE A DOMAIN, AND THE FIRST WRITE ROUTES
 * ─────────────────────────────────────────────────────────────────────────
 * A DOMAIN is where knowledge lives (the wiki). A PROJECT is a thing you
 * build. A project lives in exactly one domain; a domain can host many. Each
 * project has exactly ONE standing brief (tier 1) and its own work-streams
 * (tier 2 `current.md` per scope per machine) with their journals (tier 3).
 *
 * Until v3.48.0 this file used the word "project" for what was actually a
 * DOMAIN — `GET /api/memory` returned one row per domain and called it a
 * project. That is why the legacy alias below exists at all, and why the
 * index's rows now carry BOTH a `domain` and a `project`.
 *
 * ── WHY THERE ARE WRITE ROUTES NOW, AND WHAT THEY MAY NOT TOUCH ──────────
 * Up to v3.47 this router was GET-only, and its docblock argued that a
 * browser write path would make the app a SECOND writer to a store whose
 * whole per-machine safety argument rests on having exactly one. That
 * argument is kept, and it is kept EXACTLY as narrow as it always was:
 *
 *   · TIER 2 (`<scope>/<machine>/current.md`) and TIER 3 (`journal.jsonl`)
 *     are still agent-only. Nothing in this file writes them, and nothing
 *     here can: the store functions this router calls do not reach them.
 *     Those are the files the per-machine layout protects, because they are
 *     the ones two machines could otherwise land on together, and they are
 *     the ones whose value is that an AGENT observed them — a human edit
 *     arriving under the last agent's harness/model provenance line is the
 *     dishonesty the old block described.
 *
 *   · TIER 1 (`<project>/project.md`, the standing brief) is the HUMAN'S,
 *     and always was. docs/working-state.md has said since v3.17.0 that a
 *     human edits it by opening it in Obsidian. Editing it in the app is the
 *     same edit through a nicer door: it is stamped `authoredBy.kind:
 *     'human'`, which is exactly what `classifyBriefAuthority` already reads
 *     to decide that a brief carries the OWNER's standing instructions.
 *
 * So the write surface here is: create / rename / delete a project, and
 * replace a project's brief. Four operations, all tier 1, all on files an
 * agent does not race for.
 *
 * ── THE ONE PROPERTY THIS DOES COST, STATED RATHER THAN IMPLIED AWAY ─────
 * `project.md` has no `<machine>` segment, so it is the one file in the
 * store where two machines CAN produce a conflicting hunk under Personal
 * Sync's `git pull --no-rebase -X theirs`. That was already true before this
 * release (docs/working-state.md §2 carves it out explicitly); adding a
 * second, easier writer makes it easier to reach. It is not made worse by
 * being in a browser rather than in Obsidian — both are the human — but it
 * is a real edge and it belongs in this comment rather than in a release
 * note nobody re-reads.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ROUTING IS BY SEGMENT COUNT, BECAUSE THE TWO NAMES LOOK ALIKE
 * ─────────────────────────────────────────────────────────────────────────
 * A domain slug and a project slug are drawn from the same alphabet, so
 * `/api/memory/lumina` is genuinely ambiguous on its face. Express matches
 * by segment count, which is what makes the disambiguation structural rather
 * than a heuristic:
 *
 *   GET    /                                 the index, every project
 *   GET    /:domain/projects                 one domain's projects
 *   POST   /:domain/projects                 create        {project, brief?}
 *   PATCH  /:domain/projects/:project        rename/brief  {rename?, brief?}
 *   DELETE /:domain/projects/:project        delete        {confirm}
 *   GET    /:domain/:project                 one project's brief + state
 *   GET    /:project                         DEPRECATED alias (see below)
 *
 * ONE literal collides with a legal project slug: `projects` itself, which
 * would shadow `GET /:domain/:project` for a project of that name. Rather
 * than leave that to chance, `projects` is REFUSED as a project name by the
 * create and rename routes (RESERVED_PROJECT_NAMES), so the app cannot
 * produce the collision. A project directory named `projects` created out of
 * band — by hand, or by an MCP client — is still listed by
 * `GET /:domain/projects` and is still readable by every MCP tool; only its
 * own detail URL on this router is unreachable. That is stated here because
 * it is a real, small, permanent hole and hiding it would be worse than the
 * hole.
 *
 * ── THE DEPRECATED ALIAS ─────────────────────────────────────────────────
 * `GET /api/memory/:project` was the v3.17.0–v3.47 detail route, where
 * `:project` meant a DOMAIN. It is kept for ONE release, resolving to that
 * domain's default project, and every response carries `deprecated: true`
 * plus the URL that replaces it. It is not kept because anything in this
 * repo still calls it — the /next view is updated in the same release — but
 * because the shape of this app is that a user's browser can be running a
 * cached older shell against a newer server for as long as the tab is open.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BOUNDS
 * ─────────────────────────────────────────────────────────────────────────
 * Every byte returned is capped at the source: `readWorkingState` reads
 * `current.md` through MAX_STATE_BYTES (48 KB), the brief through
 * MAX_BRIEF_BYTES (32 KB), and the journal through MAX_JOURNAL_TAIL_BYTES
 * with an entry cap of MAX_JOURNAL_ENTRIES. `listWorkingScopes` caps at
 * MAX_INDEX_ENTRIES pairs. This router adds ONE cap of its own — MAX_PROJECTS
 * on the index — and does not re-cap anything else, because a second set of
 * limits maintained here would drift from the store's own.
 *
 * The one place this router does NOT defer to the store is the INCOMING
 * brief: the store TRIMS an over-budget write and discloses the trim, which
 * is right for an agent near its context limit (a refused handoff is a lost
 * handoff) and wrong for a person who typed the text and can see it. So a
 * brief larger than MAX_BRIEF_BYTES is refused here with both numbers named,
 * and nothing is written.
 */

import { Router } from 'express';
import { listDomains, isDomainReadonly } from '../brain/files.js';
import * as workingState from '../brain/working-state.js';
import { isDomainActive, conflictResponse } from '../brain/write-registry.js';
// >>> WP-V TEMPORARY — DELETE THESE FOUR IMPORTS AT MERGE >>>
// Only the read-only tier-0 stand-in at the foot of this file uses them; see
// the fenced block there for why it exists and what deleting it restores.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getDomainsDir } from '../brain/config.js';
// <<< WP-V TEMPORARY <<<

const router = Router();

/**
 * Cap on the index listing, reported through `truncated` rather than hidden.
 *
 * The store applies its OWN cap first (`MAX_PROJECTS_TOTAL`, also 200), so
 * this is a second, equal ceiling and normally does nothing. Both are kept:
 * neither file should have to know the other's number, and the count each
 * route returns as `total` is the store's own, taken before either cap — a
 * cap reported as a measurement is the collapse `distinctScopeCount` exists
 * one tier down to undo.
 */
export const MAX_PROJECTS = 200;

/**
 * Project names this router refuses to CREATE or RENAME to.
 *
 *   · `projects` — collides with the `/:domain/projects` literal above.
 *   · `project.md` / `journal.jsonl` — the store's own reserved filenames;
 *     a directory with either name would sit exactly where those files go.
 *   · `foundations` — the DIRECTORY tier 0 lives in, `<project>/foundations/`.
 *     A project of that name would sit exactly where the domain's OWN
 *     project's foundations directory goes (that project's tree IS the state
 *     root), so the two would be addressed by one path. Refused for the same
 *     reason as the two filenames, with the same message shape.
 *
 * A name outside this set is still checked by `isSafeSegment`, which is the
 * store's rule and is imported rather than restated (a second copy of a
 * validation rule is a second thing that can drift — this repo's most
 * reliably repeated defect).
 */
export const RESERVED_PROJECT_NAMES = new Set([
  'projects', 'project.md', 'journal.jsonl', 'foundations',
]);

// ═════════════════════════════════════════════════════════════════════════
// THE STORE ADAPTER
//
// One function per store call, so that if `src/brain/working-state.js` moves
// again this file is the only thing that moves with it. It is THIN on
// purpose: the store owns the path chokepoint, the sanitisers, the byte caps
// and the write lock, and a second opinion about any of them here would be a
// second thing to keep in step.
//
// ── WHY THIS LAYER IS NOT OPTIONAL, v3.48.0 ─────────────────────────────
// This router was written against a contract in which the project-aware
// reads took the project POSITIONALLY — `readWorkingState(domain, project,
// opts)`. The store that shipped takes it on the OPTIONS object:
// `readWorkingState(domain, {project, scope, machine, journalLimit})` and
// `listWorkingScopes(domain, {project, withSaveTimes})`. That mismatch does
// NOT throw. The store reads `opts.project` off a string, gets `undefined`,
// and answers happily about the DOMAIN'S OWN project — the wrong tree under
// the right name, with every assertion green. The tray hit the identical
// mismatch; see `desktop/tray-summary.js`.
//
// ── AND WHY THERE IS NO LONGER A SECOND ARM ─────────────────────────────
// This file carried a fallback for a store with no projects API at all, and
// a `501 store_lacks_projects` to go with it. The projects API lives in THIS
// checkout, which the `.app` wraps, so no install can have one half without
// the other: the arm was one only a fake could reach, and code only a fake
// reaches is code nothing proves. It is gone, along with the 501.
// ═════════════════════════════════════════════════════════════════════════

/**
 * TEST SEAM, and nothing else. Null in production, where the real module is
 * used. Same pattern and same rationale as `compileConversation`'s
 * `opts.generateText` and `ingestMultiPhase`'s trailing `llm` argument: the
 * alternative is a source-regex assertion, which proves a line exists and
 * nothing about what it does.
 */
let storeOverride = null;
export function __setWorkingStateStoreForTest(store) { storeOverride = store; }
function ws() { return storeOverride || workingState; }

/**
 * The default project of a domain: the domain's OWN project, whose slug IS
 * the domain name and whose tree is the state root itself.
 *
 * That is permanent, not a migration waiting to happen: the store's
 * `projectPrefix` is a pure string comparison and returns '' for it, so no
 * reader or writer probes the disk to decide which layout a path uses. A
 * tree written years from now puts the domain's own project in exactly the
 * same place.
 */
function defaultProjectOf(domain) { return domain; }

/**
 * Normalise ONE project row for the wire.
 *
 * An ALLOW-LIST, not a spread, and for the reason `toWire()` in the ingest
 * queue records: a spread forwards whatever the store grows next, including
 * anything a fellow's synced file put there. Fields absent from the store's
 * row become `null`/`0`/`[]` here rather than `undefined`, so a consumer can
 * tell "the store looked and there was nothing" from "the field does not
 * exist on this server" — the fact-versus-absence rule this module's
 * neighbours keep re-learning.
 */
function projectRow(domain, r) {
  return {
    domain,
    project: r.project,
    // The STORE's own word. It was `isLegacyDefault` on the contract this
    // router was written against, which asserted something false: the state
    // root is not a pre-v3.48.0 leftover awaiting a migration, it is where a
    // domain's own project lives permanently. Renamed here, in the tray, and
    // in the views, all in the same release, so no consumer reads a field
    // that stopped being emitted. (Read `r.isLegacyDefault` too? No: a
    // fallback to a name nothing emits is a fallback nothing can exercise.)
    isDefaultProject: r.isDefaultProject === true,
    hasBrief: r.hasBrief === true,
    briefBytes: Number.isInteger(r.briefBytes) ? r.briefBytes : 0,
    briefUpdatedAt: r.briefUpdatedAt ?? null,
    briefAuthoredBy: r.briefAuthoredBy ?? null,
    scopeCount: Number.isInteger(r.distinctScopeCount) ? r.distinctScopeCount
      : (Number.isInteger(r.scopeCount) ? r.scopeCount : 0),
    distinctScopeCount: Number.isInteger(r.distinctScopeCount) ? r.distinctScopeCount
      : (Number.isInteger(r.scopeCount) ? r.scopeCount : 0),
    savedCopies: Number.isInteger(r.savedCopies) ? r.savedCopies : 0,
    scopesTruncated: r.scopesTruncated === true,
    unlistedEntries: Number.isInteger(r.unlistedEntries) ? r.unlistedEntries : 0,
    unlistedReason: r.unlistedReason ?? null,
    layoutWarning: r.layoutWarning ?? null,
    lastWriteAt: r.lastWriteAt ?? null,
    ageSeconds: Number.isFinite(r.ageSeconds) ? r.ageSeconds : null,
    writtenAt: r.writtenAt ?? null,
    writtenAgeSeconds: Number.isFinite(r.writtenAgeSeconds) ? r.writtenAgeSeconds : null,
    headline: r.headline ?? null,
    harness: r.harness ?? null,
    // The store reads the model off the same journal line it reads the
    // harness off. Dropping one of a pair it computed honestly is this
    // module's own recorded defect class (CLAUDE.md, memory-layer
    // invariants), so both cross the wire.
    model: r.model ?? null,
    lastSaveKind: r.lastSaveKind ?? null,
    lastSaveNotes: Array.isArray(r.lastSaveNotes) ? r.lastSaveNotes : [],
    newestScope: r.newestScope ?? null,
    newestMachine: r.newestMachine ?? null,
    harnessShared: r.harnessShared === true,
    harnessSharedScopes: Array.isArray(r.harnessSharedScopes) ? r.harnessSharedScopes : [],
    harnessScanned: Number.isInteger(r.harnessScanned) ? r.harnessScanned : 0,
  };
}

/**
 * The pair a project row SPEAKS FOR, on the clock the row DISPLAYS.
 *
 * ── TWO READINGS OF ONE PROJECT ON ONE SCREEN ────────────────────────────
 * `listProjects` reads its headline, harness, model, save kind and newest
 * scope off `listWorkingScopes(...).scopes[0]` — the FIRST pair, and the
 * store sorts pairs by `mtimeMs`, the FILE clock. That sort is correct for
 * what it serves (the tray and the route's own `scope=latest` consume it)
 * and is NOT changed.
 *
 * But every age this app renders goes through the view's `effectiveSave`,
 * which prefers the AGENT'S clock — `writtenAt`, out of the journal — and
 * falls back to the file's only when there is no journal time at all. On
 * every synced machine after a checkout, and in any copied folder, git
 * rewrites mtime and the two clocks disagree. The sidebar row then read
 * "curator-v3-17-1-acceptance · 2 weeks ago" with a dormant dot while the
 * Status block beside it, on the same fetch, said the newest save was three
 * hours ago on another scope. v3.55.0 put the freshness DOT, the age WORDS
 * and the table ORDER in lockstep on the agent clock; the PROJECT ROW was
 * left on the other one.
 *
 * ── THE RULE, STATED PLAINLY ─────────────────────────────────────────────
 * Each pair's effective time is its agent time when it has one, else its
 * file time — the same preference `effectiveSave` applies, so the row and
 * the page cannot disagree about which save is newest. Newest wins; ties
 * keep the store's order, so this is a total order and a re-poll cannot swap
 * two rows. A pair with NO readable time at all never wins over one that has
 * a reading (absence is not an age of zero), and wins only by being alone.
 *
 * THE FALLBACK IS LOAD-BEARING, not a formality. A pair whose journal never
 * recorded a time still has a file time, and it can legitimately beat a pair
 * whose agent time is a fortnight old — which is precisely what the table
 * beside this row does with it. Dropping the fallback would make such a pair
 * unselectable and hand the row back to a stale save.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED: `lastWriteAt` / `ageSeconds`. They are
 * the FILE clock, they are named and documented as such, and a consumer that
 * wants to show when bytes last landed on this disk has nowhere else to read
 * it. So when the winning pair carries no agent clock at all, this row
 * reports `writtenAt: null` beside a `lastWriteAt` belonging to a different
 * pair — an absence and a fact, which is the pair of things this module
 * refuses to collapse.
 *
 * Costs nothing: a pure pick over the array `withScopeFacts` has already
 * fetched. No extra call, no extra read, the 900 ms index budget untouched.
 *
 * @returns {object|null} the winning pair, or null when there are none.
 */
function agentNewestPair(scopes) {
  const secs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const fromStamp = (s) => {
    if (typeof s !== 'string' || !s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };
  // Younger is newer, so the comparison is on AGE and the smallest wins.
  // Ages are taken over stamps where the store computed them, because it
  // computed every one of them against a single `now`.
  const ageOf = (p) => {
    if (!p || typeof p !== 'object') return null;
    const w = secs(p.writtenAgeSeconds);
    if (w !== null) return w;
    const wAt = fromStamp(p.writtenAt);
    if (wAt !== null) return Math.max(0, Math.round((Date.now() - wAt) / 1000));
    const f = secs(p.ageSeconds);
    if (f !== null) return f;
    const fAt = fromStamp(p.lastWriteAt);
    if (fAt !== null) return Math.max(0, Math.round((Date.now() - fAt) / 1000));
    return null;
  };
  let best = null;
  let bestAge = null;
  for (const p of Array.isArray(scopes) ? scopes : []) {
    if (!p || typeof p !== 'object') continue;
    const age = ageOf(p);
    if (best === null) { best = p; bestAge = age; continue; }
    if (age === null) continue;                       // absence never displaces a reading
    if (bestAge === null || age < bestAge) { best = p; bestAge = age; }
  }
  return best;
}

/**
 * THE PAIR THE WORK-STREAMS TABLE PUTS FIRST — the one `?open=newest` opens.
 *
 * ── WHY THIS IS NOT `agentNewestPair` ────────────────────────────────────
 * The two answer the same question on the same clock and differ in exactly
 * one place: TIE-BREAKING. `agentNewestPair` keeps the first pair it meets on
 * an exact tie (the store's own mtime order), which is right for a row that
 * merely has to SPEAK for a project. This one is asked which row the TABLE
 * shows at the top, and the table's order is `workStreamOrder` in
 * `src/public/next/views/memory.js`: equal ages fall to the scope name, then
 * the machine name, then the position in the response.
 *
 * TIES ARE NOT A CORNER CASE HERE. Every age on a scope row is a whole number
 * of seconds, and on a store that arrived over sync — or was simply copied —
 * git stamps every `current.md` with the same mtime, so a project whose pairs
 * carry no journal time at all ties on EVERY row at once (measured: 17 pairs,
 * `ageSeconds: 196` on all of them). A pick that broke those ties differently
 * from the table would open a handoff under a highlight sitting on some other
 * row, which is the v3.56.0 defect in a smaller place.
 *
 * So the rule is stated once here and pinned against the view's own function
 * by `scripts/test-next-memory-view.js`; `agentNewestPair` is deliberately
 * left exactly as it is, because its consumers pin its own behaviour.
 *
 * Pure, and over the array the unscoped read already produced — no extra
 * store call.
 *
 * EXPORTED for the guard, and only for it. Two of its rules — a row with NO
 * readable time never displacing one that has a reading, and an all-absent
 * list still answering rather than returning nothing — are unreachable through
 * the HTTP surface, because `listWorkingScopes` gives every real row an
 * `ageSeconds` from its own file. They are kept because they are what still
 * holds if that ever stops being true, and they are driven directly rather
 * than left as an untested branch with a comment claiming it works.
 *
 * @returns {object|null} the winning pair, or null when there are none.
 */
export function tableFirstPair(scopes) {
  const secs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const fromStamp = (s) => {
    if (typeof s !== 'string' || !s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
  };
  // `effectiveSave`'s ladder, in its order: the agent's clock whenever there
  // is one at all, the file's only as a fallback. `savedAt` / `arrivedAt` are
  // in that function because `current` carries them; a scope INDEX row never
  // does, so naming them here would be dead text pretending to be a rule.
  const ageOf = (p) => {
    if (!p || typeof p !== 'object') return null;
    const w = secs(p.writtenAgeSeconds) ?? fromStamp(p.writtenAt);
    if (w !== null) return w;
    return secs(p.ageSeconds) ?? fromStamp(p.lastWriteAt);
  };
  const rows = (Array.isArray(scopes) ? scopes : []).filter(Boolean);
  if (!rows.length) return null;
  // Decorated once, for the reason `workStreamOrder` records: `ageOf` reads
  // the clock, so computing the key inside the comparator would let `now`
  // advance mid-sort and make the comparator self-inconsistent.
  const keyed = rows.map((s, i) => ({ s, i, age: ageOf(s) }));
  const byName = (a, b) => (
    String(a.scope || '') < String(b.scope || '') ? -1
      : String(a.scope || '') > String(b.scope || '') ? 1
        : String(a.machine || '') < String(b.machine || '') ? -1
          : String(a.machine || '') > String(b.machine || '') ? 1 : 0);
  keyed.sort((a, b) => {
    if (a.age === null && b.age !== null) return 1;
    if (b.age === null && a.age !== null) return -1;
    if (a.age !== b.age) return a.age - b.age;
    return byName(a.s, b.s) || a.i - b.i;
  });
  return keyed[0].s;
}

/**
 * Fold the per-work-stream facts into a row the store answers cheaply.
 *
 * ── WHAT IS MISSING FROM A STORE ROW, AND WHY IT IS MISSING ──────────────
 * `listProjects` builds a row from ONE stat sweep and at most ONE journal
 * tail — the newest pair's — because a Projects list over twenty projects
 * would otherwise spend twelve hundred tail reads to render twenty headlines.
 * That is the right trade for the list it was written for.
 *
 * Four facts do not survive it, and all four are DISCLOSURES:
 *
 *   · `harnessShared` / `harnessSharedScopes` — two different tools writing
 *     into ONE (scope, machine) folder, where each save overwrites the other's
 *     work. v3.34.0 added this because the app had been silent about it. It is
 *     a property of a work-stream's whole journal, so the newest pair's tail
 *     cannot see it.
 *   · `harnessScanned` — how many pairs that verdict actually looked at, so a
 *     cap can never read as a census.
 *   · `scopesTruncated` / `unlistedEntries` / `unlistedReason` — work-streams
 *     the store would not list, and why. A handoff sitting in a folder called
 *     `_wip` is on disk and unread, and the count is the only thing saying so.
 *
 * So this route pays for them, on the SHOWN rows only (after the cap), with
 * one `listWorkingScopes` per row. That is the same call the pre-v3.48.0 index
 * made once per domain, so the index costs what it has always cost times the
 * number of projects in a domain — a small number, and bounded above by
 * MAX_PROJECTS. Dropping the disclosures instead would be cheaper and would be
 * this module's own recorded defect: a consumer silently dropping a fact the
 * layer below computed honestly.
 */
async function withScopeFacts(store, rows) {
  const out = [];
  for (const row of rows) {
    let idx = null;
    try { idx = await store.listWorkingScopes(row.domain, { project: row.project }); }
    catch { idx = null; }
    const scopes = idx && idx.ok && Array.isArray(idx.scopes) ? idx.scopes : [];
    const speaker = agentNewestPair(scopes);
    out.push({
      ...row,
      // ONE PROJECT, ONE CLOCK. See agentNewestPair: the store hands this row
      // the pair that is newest by MTIME, the page renders every age off the
      // AGENT'S clock, and on any synced or copied store the two disagree.
      // A FIXED set of keys, never a spread of the pair — projectRow's
      // allow-list rule holds here too, and `scopes[]` carries fields
      // (`harnesses`, `journalEntriesScanned`, `bytes`) that are not on this
      // wire contract.
      ...(speaker ? {
        headline: speaker.headline ?? null,
        harness: speaker.harness ?? null,
        model: speaker.model ?? null,
        lastSaveKind: speaker.lastSaveKind ?? null,
        // The notes come off the SAME journal line as the kind. Taking one
        // from the new pair and leaving the other on the old one would make
        // the row describe two different saves at once — this module's own
        // recorded defect class, committed deliberately.
        lastSaveNotes: Array.isArray(speaker.lastSaveNotes) ? speaker.lastSaveNotes : [],
        newestScope: speaker.scope ?? null,
        newestMachine: speaker.machine ?? null,
        writtenAt: speaker.writtenAt ?? null,
        writtenAgeSeconds: Number.isFinite(speaker.writtenAgeSeconds) ? speaker.writtenAgeSeconds : null,
      } : {}),
      scopesTruncated: !!(idx && idx.ok && idx.truncated),
      unlistedEntries: idx && idx.ok && Number.isInteger(idx.unlistedEntries) ? idx.unlistedEntries : 0,
      unlistedReason: (idx && idx.ok && idx.unlistedReason) || null,
      harnessShared: scopes.some((sc) => sc.harnessShared === true),
      harnessSharedScopes: scopes.filter((sc) => sc.harnessShared === true)
        .slice(0, 10)
        .map((sc) => ({ scope: sc.scope, machine: sc.machine, harnesses: sc.harnesses || [] })),
      // The SCANNED set, named as such. It is `scopes.length` — the shown
      // pairs — and not `savedCopies`, which is the store's uncapped count:
      // saying the collision scan covered pairs it never opened is the exact
      // cap-as-census collapse the field exists to prevent.
      harnessScanned: scopes.length,
    });
  }
  return out;
}

/**
 * Every project in one domain, newest first.
 *
 * `total` is the STORE's, which it takes before its own cap, so a truncated
 * list still reports how many there are. Counting `projects.length` here
 * would report a CAP as a measurement — the same collapse
 * `distinctScopeCount` exists to undo one tier down.
 */
async function projectsIn(store, domain) {
  const out = await store.listProjects(domain);
  if (out && out.ok === false) return { projects: [], total: 0, truncated: false, refusal: out };
  const rows = await withScopeFacts(
    store, (out && Array.isArray(out.projects) ? out.projects : []).map((r) => projectRow(domain, r)));
  return {
    projects: rows,
    total: Number.isInteger(out && out.total) ? out.total : rows.length,
    truncated: !!(out && out.truncated),
    layoutWarning: (out && out.layoutWarning) || null,
    unlistedEntries: Number.isInteger(out && out.unlistedEntries) ? out.unlistedEntries : 0,
    refusal: null,
  };
}

/**
 * Every project in every domain, newest first, capped.
 *
 * The store caps at MAX_PROJECTS_TOTAL and this route caps at MAX_PROJECTS.
 * Both are applied, because they are the same ceiling from two directions and
 * neither file should have to know the other's number; `total` stays the
 * store's uncapped count either way.
 */
async function allProjects(store) {
  const out = await store.listAllProjects();
  const rows = (out && Array.isArray(out.projects) ? out.projects : [])
    .map((r) => projectRow(r.domain, r));
  const total = Number.isInteger(out && out.total) ? out.total : rows.length;
  return {
    // ENRICHED AFTER THE CAP, never before: the per-row work is bounded by
    // what is actually returned.
    projects: await withScopeFacts(store, rows.slice(0, MAX_PROJECTS)),
    total,
    truncated: rows.length > MAX_PROJECTS || !!(out && out.truncated),
    layoutWarning: (out && out.layoutWarning) || null,
    // HOW MANY DOMAINS WERE LOOKED AT. Load-bearing, not decoration: the store
    // omits a domain's own project when it has neither a brief nor a save, so
    // an EMPTY index means either "you have no domains" or "you have domains
    // and no agent has saved in any of them" — two different first screens,
    // and without this field the view would have to guess which.
    domainsScanned: Number.isInteger(out && out.domainsScanned) ? out.domainsScanned : null,
  };
}

/**
 * One project's state.
 *
 * THE ONE PLACE THE STORE'S SIGNATURE IS KNOWN. The project rides on the
 * OPTIONS object — `readWorkingState(domain, {project, scope, machine,
 * journalLimit})` — and passing it positionally is silent: the store reads
 * `opts.project` off a string, gets undefined, and answers about the
 * domain's own project instead. Everything else in `opts` is the store's own
 * and is passed through un-reshaped.
 */
async function readState(store, domain, project, opts) {
  return store.readWorkingState(domain, { ...opts, project });
}

// ═════════════════════════════════════════════════════════════════════════
// TIER 0 — FOUNDATIONS, AND WHY A ROUTE MAY WRITE ONE
// ═════════════════════════════════════════════════════════════════════════
//
// The header block above states this router's tier boundary: tiers 2 and 3
// are agent-only, tier 1 is the human's. Tier 0 — the canonical documents a
// project carries VERBATIM (architecture, decisions, conventions, roadmap) —
// splits along a different line, and the line is OWNERSHIP rather than tier:
//
//   · A CURATOR-OWNED document was authored through `save_foundation`, on the
//     owner's explicit instruction, and carries an agent's provenance. This
//     router does not write one and there is no route that can. A human edit
//     surface for those is a later release; until then the single-writer
//     property holds exactly as it does for a handoff.
//
//   · A REPO-OWNED document is a MIRROR. Its source of truth is a file in a
//     code repository, and a refresh is a deterministic BYTE COPY of that file
//     — `sha256` compared, copied when it differs, `commit` stamped. Running
//     it does not make this app a second AUTHOR: it makes it a second COPIER
//     of a document whose author is the repository, and two copiers of one
//     byte string converge rather than conflict. That is why
//     `POST …/foundations/refresh` is a legitimate route and
//     `PUT …/foundations/:slug` is not.
//
// The one property it does cost is the same one `project.md` costs, stated in
// the header: tier 0 has no `<machine>` segment, so two machines refreshing
// from checkouts at different commits converge on whichever SAVED LAST under
// `git pull -X theirs`. It is not silent — the stored `commit` is shown beside
// the document — and any machine re-asserts its own checkout with one refresh,
// which is cheap and idempotent. docs/sync.md carries the paragraph.

/**
 * The stored slug rule, at the trust boundary.
 *
 * A COPY of the store's, and the one place in this file where a validation
 * rule is restated rather than imported — because the store function that
 * owns it does not exist yet on every install this router has to run against,
 * and a boundary check that is skipped when the store is absent is not a
 * boundary check. It is the spec's rule verbatim: lowercase alphanumerics and
 * hyphens, a leading alphanumeric, 1–64 characters, `.md`.
 */
const FOUNDATION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;

/**
 * The store that answers the tier-0 calls.
 *
 * Identical to `ws()` in production; the fenced lines are the temporary
 * stand-in described above and are removed when the store ships.
 */
function fstore() {
  const s = ws();
  // >>> WP-V TEMPORARY — DELETE THESE TWO LINES AT MERGE >>>
  if (typeof s.listFoundations !== 'function') return wpvFoundationsFake();
  // <<< WP-V TEMPORARY <<<
  return s;
}

/**
 * The tier-0 INDEX for one project, normalised for the wire.
 *
 * An ALLOW-LIST per document, for the reason `projectRow` records: a spread
 * forwards whatever the store grows next, including anything a synced
 * manifest.json put there. Absent facts become `null`/`0`/`[]` rather than
 * `undefined`, so a consumer can tell "the store looked and there was
 * nothing" from "this server does not know the field".
 *
 * NEVER A BODY. This rides on the detail envelope, which is fetched on every
 * project switch and on the Reload path; a 200 KB budget of document text on
 * a read whose job is "what is here" would make the cheapest screen in the app
 * the most expensive one. `GET …/foundations/:slug` is the body.
 */
function foundationsWire(out) {
  if (!out || typeof out !== 'object') return null;
  const docs = Array.isArray(out.documents) ? out.documents : [];
  return {
    present: out.present === true,
    ownership: out.ownership || null,
    repo: out.repo && typeof out.repo === 'object' ? {
      root: out.repo.root ?? null,
      remote: out.repo.remote ?? null,
      lastRefreshAt: out.repo.lastRefreshAt ?? null,
      lastRefreshCommit: out.repo.lastRefreshCommit ?? null,
    } : null,
    budgetBytes: Number.isInteger(out.budgetBytes) ? out.budgetBytes : 0,
    totalBytes: Number.isInteger(out.totalBytes) ? out.totalBytes : 0,
    documents: docs.filter(Boolean).map((d) => ({
      slug: d.slug ?? null,
      role: d.role ?? null,
      title: d.title ?? null,
      bytes: Number.isInteger(d.bytes) ? d.bytes : 0,
      sha256: d.sha256 ?? null,
      updatedAt: d.updatedAt ?? null,
      commit: d.commit ?? null,
      source: d.source && typeof d.source === 'object'
        ? { kind: d.source.kind ?? null, path: d.source.path ?? null } : null,
      authoredBy: d.authoredBy ?? null,
      // COMPUTED, NEVER REMEMBERED (the spec's own invariant 3). Forwarded
      // exactly as the store answered it — including `unreachable`, which is
      // a FACT about this machine and not a failure to be smoothed into
      // `stale`.
      freshness: d.freshness ?? null,
    })),
    // A `.md` file in the directory with no manifest entry. The manifest is
    // written LAST on every save, so a crash leaves a document without an
    // entry rather than an entry without a document — and this count is the
    // only thing that says so.
    orphanFiles: Array.isArray(out.orphanFiles) ? out.orphanFiles.slice(0, 20) : [],
    manifestError: out.manifestError ?? null,
  };
}

/**
 * Read the index, and never let it fail the read it rides on.
 *
 * The foundations index is a PASSENGER on `GET /:domain/:project`. That route
 * answers about the brief, the work-streams and the handoff, and a project
 * whose manifest is unreadable must still be able to show all three — so a
 * throw here becomes `manifestError`, which is what the view renders, rather
 * than a 500 over a screen that is otherwise correct.
 */
async function foundationsIndexFor(domain, project) {
  try {
    const out = await fstore().listFoundations(domain, project);
    if (out && out.ok === false) {
      return { ...foundationsWire({}), manifestError: out.error || out.message || out.reason || 'unreadable' };
    }
    return foundationsWire(out);
  } catch (err) {
    return { ...foundationsWire({}), manifestError: err.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// GUARDS — every one of them runs BEFORE any path is built.
// ═════════════════════════════════════════════════════════════════════════

/** The domain must be a real domain. Resolved against listDomains(), never parsed. */
async function requireDomain(res, domain) {
  const domains = await listDomains();
  if (!domains.includes(domain)) {
    res.status(404).json({ ok: false, error: `Unknown domain: ${domain}`, reason: 'unknown_domain' });
    return false;
  }
  return true;
}

/**
 * A project NAME check, at the trust boundary, using the store's own rule.
 *
 * `isSafeSegment` is imported, not restated: it is the same predicate the
 * store uses to decide what it will address, so a name this router accepts
 * and the store then refuses cannot happen.
 */
function validProjectName(store, name) {
  return typeof name === 'string' && store.isSafeSegment(name);
}

/** Writes are refused on a read-only Shared Brain mirror, as everywhere else. */
async function refuseMirror(res, domain) {
  if (await isDomainReadonly(domain)) {
    res.status(403).json({
      ok: false,
      reason: 'readonly',
      error: `"${domain}" is a read-only Shared Brain mirror. Projects and briefs live in your own `
        + 'domains; a mirror is rebuilt from the collective on the next Pull and local writes are lost.',
    });
    return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory — the index, one row per PROJECT
// ═════════════════════════════════════════════════════════════════════════
/**
 * "Which of my projects have agent memory, and how fresh is it?"
 *
 * ── WHAT IS NOT A ROW, AND WHY THAT CHANGED IN v3.48.0 ──────────────────
 * Up to v3.47 this route emitted one row per DOMAIN, always, including a
 * domain with nothing saved at all. The store now decides: `listProjects`
 * omits a domain's own project when it has NEITHER a brief NOR a save,
 * because a row describing an empty tree is noise on a screen whose job is
 * "which project". That answer is not re-litigated here — one description of
 * "which projects exist", shared by this route, the Domains view's Projects
 * list and the menu-bar widget, is worth more than this route's own opinion,
 * and a second opinion maintained in a router is a second thing that drifts.
 *
 * The cost is that an EMPTY index is ambiguous — no domains, or domains with
 * no agent memory yet — so `domainsScanned` rides along and the view says
 * which. An empty project a user CREATED is still a row: it has a brief,
 * because `createProject` always writes one.
 *
 * `newestScope`/`newestMachine` exist so the view can open the freshest
 * handoff in ONE request instead of a round-trip to discover the scope and a
 * second one to read it.
 *
 * TWO CLOCKS AND WHY BOTH SHIP: `lastWriteAt`/`ageSeconds` are filesystem
 * mtime, which git rewrites on checkout, so on a machine that pulls state
 * from another they are the time of the PULL. `writtenAt`/`writtenAgeSeconds`
 * come from the journal line the agent wrote and are the save's own clock.
 * Neither replaces the other, and `writtenAt` is nullable, so a consumer
 * that falls back must say so.
 *
 * `scopeCount` counts DISTINCT SCOPES (work-streams); `savedCopies` counts
 * (scope, machine) pairs. Both are taken before the store's index cap, so
 * either may legitimately exceed MAX_INDEX_ENTRIES — truncation describes
 * the LIST, never a count.
 *
 * CAVEAT, stated rather than implied away: `scopeCount` does NOT mean the
 * same thing on the detail route, which spreads the store's shape and so
 * reports the PAIR total under that name. Both routes carry `savedCopies`
 * (pairs) and `distinctScopeCount` (work-streams); read those two and the
 * route you are talking to stops mattering.
 */
router.get('/', async (_req, res) => {
  try {
    const store = ws();
    const { projects, total, truncated, layoutWarning, domainsScanned } = await allProjects(store);
    res.json({ ok: true, projects, total, truncated, layoutWarning, domainsScanned });
  } catch (err) {
    console.error('Memory index error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory/:domain/projects — one domain's projects
//
// REGISTERED BEFORE `/:domain/:project`. Express matches in registration
// order within a segment count, so this literal has to come first; see the
// header block for the one collision that creates and why `projects` is a
// reserved project name because of it.
// ═════════════════════════════════════════════════════════════════════════
router.get('/:domain/projects', async (req, res) => {
  try {
    const { domain } = req.params;
    if (!await requireDomain(res, domain)) return;
    const store = ws();
    const listed = await projectsIn(store, domain);
    if (listed.refusal) {
      return res.status(statusForStoreRefusal(listed.refusal)).json(withErrorProse(listed.refusal));
    }
    const readonly = await isDomainReadonly(domain);
    res.json({
      ok: true,
      domain,
      projects: listed.projects,
      // The STORE's count, taken before its own cap. `projects.length` here
      // would report a CAP as a measurement.
      total: listed.total,
      truncated: listed.truncated,
      // Directory entries in this domain's state tree that the store will
      // not address, and why. Surfaced rather than dropped: a handoff sitting
      // in a folder called `_wip` is on disk and unread, and the count is the
      // only thing that says so.
      unlistedEntries: listed.unlistedEntries,
      layoutWarning: listed.layoutWarning,
      readonly,
      // Whether a project here can be created, renamed or deleted AT ALL —
      // one field answering the question the view actually has, rather than
      // two the view would have to combine.
      //
      // Since the capability arm was removed this folds in exactly one
      // refusal — the domain being a read-only Shared Brain mirror (403) —
      // and it is KEPT as its own field rather than collapsed into
      // `!readonly` at the view, because it is the answer to "may I write
      // here", which is what the view asks, and the two stop being the same
      // question the moment another refusal is added.
      canWrite: !readonly,
    });
  } catch (err) {
    console.error('Memory projects error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/memory/:domain/projects — create a project
//
// TIER 1 ONLY: this creates the project's directory and, if a brief was
// typed, its `project.md`. It never touches a scope or a journal.
// ═════════════════════════════════════════════════════════════════════════
router.post('/:domain/projects', async (req, res) => {
  try {
    const { domain } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;

    const store = ws();

    const body = req.body || {};
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    if (!validProjectName(store, project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project',
        error: `"${project}" is not a usable project name. Use lowercase letters, digits, `
          + '"." "_" or "-", up to 64 characters.',
      });
    }
    if (RESERVED_PROJECT_NAMES.has(project)) {
      return res.status(400).json({
        ok: false, reason: 'reserved_project',
        error: `"${project}" is reserved and cannot be a project name.`,
      });
    }
    const brief = typeof body.brief === 'string' ? body.brief : null;
    const tooBig = briefTooBig(store, brief);
    if (tooBig) return res.status(400).json(tooBig);

    // The provenance is stamped EXPLICITLY, not left to the store's default.
    // The default is no provenance comment at all, which `parseBriefProvenance`
    // reads back as null and `classifyBriefAuthority` grants OWNER authority to
    // — the right reading for a brief typed by hand, and the same reading this
    // one deserves, since a person typed it into the app's own editor. Saying
    // it out loud is better than inheriting it: an agent-written brief is
    // stamped, so an UNSTAMPED file would otherwise be indistinguishable from
    // one written before v3.48.0, and this way the file says which it is.
    const out = await store.createProject(domain, project, {
      ...(brief ? { brief } : {}),
      authoredBy: { kind: 'human' },
    });
    if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(withErrorProse(out));
    res.status(201).json({ ok: true, domain, project, created: true });
  } catch (err) {
    console.error('Memory create-project error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /api/memory/:domain/projects/:project — rename and/or replace the brief
//
// Both in one call because they are one gesture in the UI (the project's
// settings), and because doing them as two requests would leave a rename
// applied with the brief write against the OLD name if the second failed.
// The rename is applied FIRST and the brief is then written to whatever name
// the project now has, so a partial failure is always "renamed, brief
// unchanged" — visible, and re-runnable.
// ═════════════════════════════════════════════════════════════════════════
router.patch('/:domain/projects/:project', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;

    const store = ws();
    const body = req.body || {};
    const wantsRename = typeof body.rename === 'string' && body.rename.trim() !== ''
      && body.rename.trim() !== project;
    const wantsBrief = typeof body.brief === 'string';

    if (!wantsRename && !wantsBrief) {
      return res.status(400).json({
        ok: false, reason: 'nothing_to_do',
        error: 'Send `rename`, `brief`, or both.',
      });
    }
    if (!validProjectName(store, project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }

    let current = project;

    if (wantsRename) {
        const next = body.rename.trim();
      if (!validProjectName(store, next)) {
        return res.status(400).json({
          ok: false, reason: 'invalid_project',
          error: `"${next}" is not a usable project name. Use lowercase letters, digits, `
            + '"." "_" or "-", up to 64 characters.',
        });
      }
      if (RESERVED_PROJECT_NAMES.has(next)) {
        return res.status(400).json({
          ok: false, reason: 'reserved_project', error: `"${next}" is reserved and cannot be a project name.`,
        });
      }
      // A rename MOVES a directory. Refused while this domain has a write in
      // flight, for the same reason PUT /api/domains/:domain is: the mover
      // and the writer resolve their paths independently, so the writer
      // happily recreates the old directory and writes into a folder nothing
      // lists. Same predicate (isDomainActive), same response shape.
      if (isDomainActive(domain)) {
        const { status, body: conflict } = conflictResponse(`rename project "${project}"`);
        return res.status(status).json(conflict);
      }
      const out = await store.renameProject(domain, project, next);
      if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(withErrorProse(out));
      current = next;
    }

    if (wantsBrief) {
      const tooBig = briefTooBig(store, body.brief);
      if (tooBig) return res.status(400).json({ ...tooBig, renamedTo: wantsRename ? current : undefined });
      const out = await saveBrief(store, domain, current, body.brief);
      if (out && out.ok === false) {
        return res.status(statusForStoreRefusal(out)).json({ ...withErrorProse(out), renamedTo: wantsRename ? current : undefined });
      }
    }

    res.json({
      ok: true,
      domain,
      project: current,
      renamed: wantsRename ? { from: project, to: current } : null,
      briefSaved: wantsBrief,
    });
  } catch (err) {
    console.error('Memory patch-project error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/memory/:domain/projects/:project — delete a project
//
// TYPED CONFIRMATION, at the ROUTE and not only in the view. This removes a
// project's brief, every work-stream handoff under it and every journal —
// the whole point of which is that they are the only record of decisions
// that were never written down anywhere else. A confirmation that lives only
// in a view is a confirmation any other client skips.
// ═════════════════════════════════════════════════════════════════════════
router.delete('/:domain/projects/:project', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;

    const store = ws();
    if (!validProjectName(store, project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }

    const confirm = req.body && typeof req.body.confirm === 'string' ? req.body.confirm : '';
    if (confirm !== project) {
      return res.status(400).json({
        ok: false, reason: 'confirm_required',
        error: `Type the project name to confirm. Expected "${project}".`,
      });
    }
    if (isDomainActive(domain)) {
      const { status, body } = conflictResponse(`delete project "${project}"`);
      return res.status(status).json(body);
    }

    const out = await store.deleteProject(domain, project, { confirm });
    if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(withErrorProse(out));
    res.json({ ok: true, domain, project, deleted: true });
  } catch (err) {
    console.error('Memory delete-project error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory/:domain/:project/foundations/:slug — ONE document, verbatim
//
// Registered BEFORE the two-segment reads for readability only: four segments
// and two cannot shadow each other, so unlike `/:domain/projects` this
// ordering is not load-bearing. What IS load-bearing is that it comes before
// the one-segment deprecated alias, which would otherwise match nothing here
// but is kept last on principle.
// ═════════════════════════════════════════════════════════════════════════
/**
 * The bytes as stored, with the provenance that qualifies them.
 *
 * VERBATIM IS THE POINT. A foundation is a canonical document — an
 * architecture note, a decisions log — and the whole reason it is stored
 * rather than ingested is that a summary of it is not it. So nothing on this
 * path rewrites the text; the store's read-time defang neutralises
 * protocol-shaped markup without deleting a word, and says so through
 * `sanitisedOnRead`, which is forwarded.
 *
 * THE SLUG IS VALIDATED HERE, at the boundary, with the same rule the store
 * uses — see FOUNDATION_SLUG_RE for why this is the one restated rule in the
 * file. A name that is not a slug is a 400 and never reaches a path builder.
 */
router.get('/:domain/:project/foundations/:slug', async (req, res) => {
  try {
    const { domain, project, slug } = req.params;
    if (!await requireDomain(res, domain)) return;
    const store = fstore();
    if (!validProjectName(ws(), project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }
    if (!FOUNDATION_SLUG_RE.test(String(slug || ''))) {
      return res.status(400).json({
        ok: false, reason: 'invalid_slug',
        error: `"${slug}" is not a usable document name. Use lowercase letters, digits and `
          + '"-", up to 64 characters, ending in ".md".',
      });
    }
    const out = await store.readFoundation(domain, project, slug);
    // ABSENT IS A 404, not a 200 describing an empty document. The store
    // distinguishes "there is no such entry" from "the file would not read",
    // and both are forwarded with their own reason; what is never done is
    // answering 200 with an empty body, which is how a typo renders as a
    // working, blank page (the same rule `project_not_found` follows below).
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'foundation_not_found';
      const body = withErrorProse({
        ok: false, reason, domain, project, slug,
        ...(out || {}),
        error: (out && (out.error || out.message))
          || `"${slug}" is not a foundation document in "${project}".`,
      });
      return res.status(statusForStoreRefusal({ reason })).json(body);
    }
    res.json({ ...out, ok: true, domain, project });
  } catch (err) {
    console.error('Memory foundation read error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/memory/:domain/:project/foundations/refresh — re-copy the mirror
//
// THE ONE TIER-0 WRITE THIS APP MAKES, and the header block above this
// section's helpers records the argument in full: a refresh is a byte copy
// from a repository that is already the document's author, so running it
// makes this app a second COPIER rather than a second WRITER. It never
// composes, never merges, never calls an LLM, and it cannot create a
// curator-owned document — that is what the 400 below is for.
// ═════════════════════════════════════════════════════════════════════════
router.post('/:domain/:project/foundations/refresh', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
    if (!validProjectName(ws(), project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }

    const store = fstore();
    const index = await store.listFoundations(domain, project);

    // ── CURATOR-OWNED IS A 400, AND IT IS NOT AN ERROR CONDITION ────────
    // It is a statement about what this project's documents ARE: written by an
    // agent the owner commissioned, with no upstream file to copy from. There
    // is nothing to refresh and nothing that could be, so the honest answer is
    // a refusal naming the reason rather than a no-op reporting success.
    if (index && index.ownership === 'curator') {
      return res.status(400).json({
        ok: false, reason: 'curator_owned',
        error: 'These documents were written for this project, not mirrored from a repository, '
          + 'so there is nothing to refresh from. Ask your agent to rewrite one instead.',
      });
    }

    const body = req.body || {};
    const asked = typeof body.repoRoot === 'string' && body.repoRoot.trim() ? body.repoRoot.trim() : null;
    // The manifest's own `repo.root` is the default, and it is ADVISORY: it
    // records the path on the machine that last refreshed, which on any other
    // machine is a hint and not a fact. An absent or unreachable one is a 409
    // — "the state on this server is not one this request can act on" — never
    // a 500, because nothing is broken: the checkout is simply not here.
    const root = asked || (index && index.repo && index.repo.root) || null;
    if (!root) {
      return res.status(409).json({
        ok: false, reason: 'repo_unreachable',
        error: 'This project has no repository path recorded on this computer, so there is '
          + 'nothing to copy from. Save state from the checkout once with `repo_root` set, '
          + 'or pass the path.',
      });
    }

    const out = await store.refreshFoundationsFromRepo(domain, project, root, {});
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'repo_unreachable';
      const status = (reason === 'curator_owned' || reason === 'curator-owned') ? 400
        : statusForStoreRefusal({ reason });
      return res.status(status).json(withErrorProse({
        ok: false, reason, domain, project, repoRoot: root, ...(out || {}),
      }));
    }
    res.json({
      ok: true, domain, project, repoRoot: root,
      refreshed: Array.isArray(out.refreshed) ? out.refreshed : [],
      unchanged: Array.isArray(out.unchanged) ? out.unchanged : [],
      added: Array.isArray(out.added) ? out.added : [],
      // NEVER DELETED, ONLY REPORTED. A source file that has vanished from the
      // repository leaves its copy in place — the copy is the only remaining
      // record of it — and this list is what says the two have parted.
      missing: Array.isArray(out.missing) ? out.missing : [],
      commit: out.commit ?? null,
    });
  } catch (err) {
    console.error('Memory foundations refresh error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory/:domain/:project — one project's brief + state
// ═════════════════════════════════════════════════════════════════════════
/**
 * The store's `readWorkingState` result, unmodified but for `domain`,
 * `readonly` and the pair-count alias. Shape is deliberately 1:1 with the
 * store rather than reshaped here: a second shape maintained in this file
 * would drift from the one the MCP tools return, and then the app and the
 * agent would describe the same file differently.
 *
 * Without `scope`: the brief plus the scope index ("what exists?").
 * With `scope`:    the brief plus that scope's current.md and journal. With
 *                  no `machine`, the most recently written machine wins —
 *                  that is what makes cross-machine handoff work, and the
 *                  response says which machine it chose so the view never
 *                  has to guess.
 * `scope=latest`:  the newest-written work-stream, resolved server-side, so
 *                  a client can open the freshest handoff without first
 *                  fetching the index to learn its name.
 *
 * An invalid `scope`/`machine` comes back from the store as `ok: false` with
 * a reason, and is surfaced as a 400. `journalLimit` is passed through
 * un-clamped ON PURPOSE: the store clamps it to [1, MAX_JOURNAL_ENTRIES]
 * itself, and clamping it a second time here is the two-copies-of-a-bound
 * shape.
 */
router.get('/:domain/:project', async (req, res) => {
  await handleDetail(req, res, req.params.domain, req.params.project, false);
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory/:project — DEPRECATED alias for the default project
//
// Registered LAST so it can never shadow a two-segment route. See the header
// block: this was the v3.17.0–v3.47 detail route, where `:project` meant a
// DOMAIN, and it is kept for one release because a browser tab can be
// running a cached older shell against a newer server.
// ═════════════════════════════════════════════════════════════════════════
router.get('/:project', async (req, res) => {
  const domain = req.params.project;
  await handleDetail(req, res, domain, defaultProjectOf(domain), true);
});

async function handleDetail(req, res, domain, project, deprecated) {
  try {
    if (!await requireDomain(res, domain)) return;

    const store = ws();
    if (!validProjectName(store, project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }

    // `scope` IS PASSED THROUGH, keyword and all. This route used to resolve
    // `latest` itself before calling the store, and that was a second copy of
    // a rule the store already owns — and a copy that DISAGREED with it: the
    // store resolves an ACTUAL work-stream named `latest` in preference to the
    // keyword (see LATEST_SCOPE), because opening a different work-stream than
    // the one named is a correctness bug wearing a helpfulness costume. The
    // route's copy always meant "newest". Deleted, not fixed twice.
    //
    // `latest` over a project with nothing saved resolves to null in the
    // store, which reads as the scope-less "what exists?" answer — the honest
    // reply, rather than a 400 about a scope the caller never named. The
    // response carries `scopeResolvedBy` so a client can tell which of the two
    // it got.
    const opts = {};
    if (typeof req.query.scope === 'string' && req.query.scope) opts.scope = req.query.scope;
    if (typeof req.query.machine === 'string' && req.query.machine) opts.machine = req.query.machine;
    if (req.query.journalLimit != null && req.query.journalLimit !== '') {
      const n = Number(req.query.journalLimit);
      if (Number.isFinite(n)) opts.journalLimit = n;
    }

    // ── `?open=newest` — THE INDEX AND THE FIRST HANDOFF IN ONE ANSWER ───
    //
    // The Agent-memory view needs BOTH halves to paint a project: the
    // work-stream index (which only a scope-LESS read produces) and one
    // pair's `current.md` + journal (which only a SCOPED read produces).
    // Until now it asked twice, in series, because the second request's URL
    // is not knowable until the first has answered — so the detail column
    // sat empty for the whole of the second trip and repainted twice. The
    // maintainer's report was that switching project "loads with some
    // delay"; measured on a real store, a switch cost 3 requests and
    // collapsed the column from 3,821px to 215px for a frame in between.
    //
    // OPT-IN, AND ONLY WITHOUT `scope`. A caller that names a scope has
    // already decided what to open, so there is nothing for this to pick,
    // and `?scope=` keeps its exact shipped behaviour — byte-identical
    // against a recorded fixture in scripts/test-next-memory-view.js.
    //
    // THE VALUE IS A WORD, NOT A FLAG. `open=newest` says which pair, so a
    // later `open=<something else>` is an addition rather than a redefinition
    // of a boolean; anything this route does not recognise is ignored and the
    // read behaves exactly as it does today.
    const wantOpen = req.query.open === 'newest' && !opts.scope;

    const state = await readState(store, domain, project, opts);
    if (!state.ok) {
      const body = withErrorProse(state);
      return res.status(statusForStoreRefusal(state))
        .json(deprecated ? { ...body, ...deprecationNote(domain, project) } : body);
    }
    // A NAMED PROJECT THAT IS NOT THERE IS A 404, not a 200 describing an
    // empty tree. The store answers `ok: true, projectExists: false` on
    // purpose — it distinguishes "created but empty" from "never created",
    // which is a distinction its callers need — but over HTTP the two are
    // different answers to "GET this project", and returning 200 for a name
    // that does not exist is how a typo renders as a working, blank page.
    // The domain's OWN project always exists (its tree is the state root),
    // so this can only fire for a named one.
    if (state.projectExists === false) {
      const body = {
        ok: false, reason: 'project_not_found', domain, project,
        error: `"${project}" is not a project in "${domain}".`,
      };
      return res.status(404).json(deprecated ? { ...body, ...deprecationNote(domain, project) } : body);
    }

    const readonly = await isDomainReadonly(domain);

    // ONE NAME, TWO QUANTITIES — resolved by adding an unambiguous one
    // rather than by redefining either existing field.
    //
    // `scopeCount` means DISTINCT SCOPES on the index route (its docblock
    // says so, and test-next-memory-view pins scopeCount !== savedCopies
    // there) and the (scope, machine) PAIR total here, because this route
    // spreads the store's own shape and the store's meaning is pinned by
    // test-mcp-working-state §D7. Redefining either one breaks a guard that
    // is load-bearing somewhere else, so neither is touched. Both routes
    // offer the SAME unambiguous pair-count name instead.
    const withCounts = (typeof state.scopeCount === 'number')
      ? { ...state, savedCopies: state.scopeCount }
      : state;

    // ── THE OPENED PAIR RIDES ALONG, IN THE SHAPE IT WOULD HAVE HAD ──────
    //
    // `open` is byte-for-byte what `GET …?scope=<s>&machine=<m>` answers,
    // built by the same `readState` through the same envelope — not a
    // hand-picked projection of it. A client can therefore use one code path
    // for both, and the guard that pins the equality is a deep comparison
    // against the real second request rather than a field list that would
    // have to be maintained alongside the store's.
    //
    // `null` RATHER THAN AN OMITTED KEY when a project has no pairs at all:
    // the caller asked a question and "there is nothing to open" is the
    // answer, which a missing key cannot say apart from "this server does not
    // know about `open`". An OLDER server answers with no key, and the view
    // falls back to its second request — which is why the distinction has to
    // be visible.
    //
    // A FAILED inner read is reported as `null` too, and the outer read still
    // returns 200: the index half is correct and useful, and the client's
    // fallback path re-asks for the detail and surfaces the real error there.
    // ── TIER 0 RIDES ALONG, INDEX ONLY ──────────────────────────────────
    //
    // ONE CALL, TWO PLACES. `open` claims to be byte-for-byte what
    // `GET …?scope=&machine=` answers, and that request carries this field —
    // so the same object is attached to both rather than to the outer envelope
    // alone, or the claim would stop being true the day tier 0 shipped. It is
    // the SAME reference, not a second read: one manifest, read once.
    //
    // ON ORDER: the spec asks for `foundations` between `open` and `journal`,
    // and the two can never appear at one level — `open` is built only for a
    // scope-LESS read and `journal` only for a scoped one. It sits directly
    // after `open` here, and directly after the store's spread inside `open`,
    // where `journal` has already arrived; re-ordering the store's own fields
    // to place it earlier would move keys that §3b pins byte-identical.
    const foundations = await foundationsIndexFor(domain, project);

    let open;
    if (wantOpen) {
      const pick = Array.isArray(state.scopes) ? tableFirstPair(state.scopes) : null;
      open = null;
      if (pick && pick.scope) {
        const inner = { scope: pick.scope };
        if (pick.machine) inner.machine = pick.machine;
        if (opts.journalLimit !== undefined) inner.journalLimit = opts.journalLimit;
        const sub = await readState(store, domain, project, inner);
        if (sub && sub.ok) {
          open = {
            ...((typeof sub.scopeCount === 'number') ? { ...sub, savedCopies: sub.scopeCount } : sub),
            domain, project, readonly, foundations,
          };
        }
      }
    }

    res.json({
      ...withCounts,
      domain,
      project,
      readonly,
      ...(wantOpen ? { open } : {}),
      foundations,
      ...(deprecated ? deprecationNote(domain, project) : {}),
    });
  } catch (err) {
    console.error('Memory read error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

/** What replaced the deprecated alias, said in the response rather than in a changelog. */
function deprecationNote(domain, project) {
  return {
    deprecated: true,
    deprecationNote: `GET /api/memory/${domain} is deprecated and will be removed after v3.48.0. `
      + `Use GET /api/memory/${domain}/${project}.`,
    replacedBy: `/api/memory/${encodeURIComponent(domain)}/${encodeURIComponent(project)}`,
  };
}

/**
 * Refuse a brief larger than the store's own cap, rather than letting it be
 * TRIMMED.
 *
 * The store trims and discloses, which is right for an agent — a refused
 * handoff near a context limit is a lost handoff — and wrong for a person
 * who typed the text and is looking at it. Returns the 400 body, or null.
 */
function briefTooBig(store, text) {
  if (typeof text !== 'string') return null;
  const cap = Number.isInteger(store.MAX_BRIEF_BYTES) ? store.MAX_BRIEF_BYTES : 32 * 1024;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= cap) return null;
  return {
    ok: false,
    reason: 'brief_too_large',
    error: `That brief is ${bytes.toLocaleString()} bytes and the limit is ${cap.toLocaleString()}. `
      + 'Nothing was saved. Move the long parts into wiki pages and point at them from the brief.',
    bytes,
    limit: cap,
  };
}

/**
 * Save a brief.
 *
 * ── WHY `saveProjectBriefText` AND NOT `saveProjectBrief` ────────────────
 * The store exports both. `saveProjectBrief(project, a, b, c)` DISPATCHES ON
 * ARGUMENT SHAPE and still accepts its pre-v3.48.0 structured form
 * `(project, {brief, decisions, …})`, which composes the document from four
 * known section keys — so any `## ` heading the owner wrote by hand and the
 * store does not know about (the maintainer's own brief has "Roadmap" and
 * "How I want you to work") is silently dropped on the next write. The
 * whole-text writer is named directly so this call site cannot be re-read as
 * the other one by anybody, including a future shape-dispatcher.
 *
 * ── `authoredBy: { kind: 'human' }`, STAMPED RATHER THAN OMITTED ─────────
 * The store's default is no provenance comment at all, which reads back as
 * null and is granted OWNER authority — the reading a hand-typed brief gets,
 * and the correct one here too. It is stated explicitly anyway: an
 * agent-written brief IS stamped, so an unstamped file is indistinguishable
 * from one written before v3.48.0, and a file that says what it is beats a
 * file whose meaning depends on knowing which version wrote it.
 *
 * ── `replace: true`, AND THE ONE THING IT GIVES UP ──────────────────────
 * The store refuses a write that shrinks a brief to under 5% of itself,
 * because tier 1 is overwritten in place with no journal behind it. That
 * guard is right for an agent composing a document it cannot see. It is
 * wrong here, and worse than wrong: the app's editor is SEEDED WITH THE
 * CURRENT TEXT, so a shrink is something a person did to text on their own
 * screen and then pressed Save on — and the refusal's own advice ("repeat
 * the call with replace: true") is advice a person in a browser cannot take.
 * Advice that cannot be followed is worse than none. An EMPTY brief is still
 * refused, by `saveProjectBriefText` itself, ahead of the shrink guard and
 * regardless of this flag.
 *
 * The cost, stated: a brief LONGER than the read cap comes into the editor
 * truncated, and saving it would drop the tail. The view shows "the tail is
 * not shown" above the box when that is true; the route cannot see it.
 */
async function saveBrief(store, domain, project, text) {
  return store.saveProjectBriefText(domain, project, text, {
    authoredBy: { kind: 'human' },
    replace: true,
  });
}

/**
 * Map a store refusal to an HTTP status.
 *
 * The store's reasons are HYPHENATED (`unknown-state-project`); this router's
 * own are underscored (`invalid_project`). Both spellings are listed rather
 * than normalised, because normalising would mean rewriting the store's
 * `reason` on the way out and a caller matching on the string it was given by
 * the store would then stop matching.
 *
 * Named reasons only. A refusal this router does not recognise is a 400
 * rather than a 500: the store refuses INPUT, and calling an unrecognised
 * refusal a server error would tell the user to retry something that will
 * never succeed. `io` is the exception and is a 500, because it is the one
 * reason that is genuinely OUR fault and genuinely worth retrying.
 */
function statusForStoreRefusal(out) {
  const reason = out && typeof out.reason === 'string' ? out.reason : '';
  if (reason === 'unknown-project' || reason === 'unknown-state-project'
    || reason === 'project_not_found') return 404;
  // TIER 0. A named document that is not there is the same answer as a named
  // project that is not there, in both the store's hyphenated spelling and
  // this router's underscored one — listed rather than normalised, for the
  // reason this function's docblock gives.
  if (reason === 'foundation_not_found' || reason === 'unknown-foundation'
    || reason === 'unknown_foundation') return 404;
  // NOT A 500 AND NOT A 400: the checkout this mirror is copied from is not on
  // this computer. Nothing is malformed and nothing is broken — the server's
  // own state is simply not one the request can act on, which is 409's
  // meaning and the same status a held write lock gets below.
  if (reason === 'repo_unreachable' || reason === 'repo-unreachable'
    || reason === 'unreachable') return 409;
  if (reason === 'readonly') return 403;
  if (reason === 'project-exists' || reason === 'project_exists') return 409;
  // A write lock held by somebody else, and the same status this router's own
  // in-flight guard uses for the same situation.
  if (reason === 'locked') return 409;
  if (reason === 'io') return 500;
  return 400;
}

/**
 * The store says `message`; this router says `error`; the shell reads `error`.
 *
 * `fetchJSON` in `src/public/next/views/domains.js` renders `body.error` and
 * falls back to "Request failed (409)". So a store refusal forwarded verbatim
 * — "a project called X already exists in Y" — reaches the user as a status
 * code. Both keys are emitted, with `message` untouched, so a client matching
 * on either keeps working.
 */
function withErrorProse(out) {
  if (!out || typeof out !== 'object') return out;
  if (typeof out.error === 'string' && out.error) return out;
  if (typeof out.message !== 'string' || !out.message) return out;
  return { ...out, error: out.message };
}

// >>> WP-V TEMPORARY — DELETE THIS FENCED BLOCK AT MERGE >>>
//
// WP-S owns `src/brain/working-state.js` and ships `listFoundations`,
// `readFoundation` and `refreshFoundationsFromRepo` there with the shapes this
// router is written against. Until that lands, this worktree has no store
// functions to call at all, and a route that cannot be RUN is a route nothing
// proves — so the three calls are answered by a READ-ONLY stand-in over the
// same on-disk layout, which is what let the routes, the view and the browser
// check be driven for real in this branch.
//
// It reads and it hashes; it writes nothing, and it REFUSES the refresh rather
// than performing a copy the real store owns. `fstore()` reaches it only when
// the store has no `listFoundations`, so deleting this block and the two fenced
// lines in `fstore()` is the whole merge.
function wpvFoundationsFake() {
  const dirOf = (domain, project) => join(
    getDomainsDir(), domain, 'state', project === domain ? '' : project, 'foundations');
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  return {
    async listFoundations(domain, project) {
      const dir = dirOf(domain, project);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) return { present: false, documents: [] };
      let manifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
      catch (err) { return { present: false, documents: [], manifestError: err.message }; }
      const listed = new Set();
      const documents = (manifest.documents || []).map((d) => {
        listed.add(d.slug);
        let freshness = 'n/a';
        if (d.source && d.source.kind === 'repo') {
          const src = manifest.repo && manifest.repo.root
            ? join(manifest.repo.root, d.source.path) : null;
          if (!src || !existsSync(src)) freshness = 'unreachable';
          else freshness = sha(readFileSync(src)) === d.sha256 ? 'fresh' : 'stale';
        }
        let bytes = d.bytes;
        try { bytes = statSync(join(dir, d.slug)).size; } catch { /* keep the manifest's */ }
        return { ...d, bytes, freshness };
      });
      const orphanFiles = readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !listed.has(f));
      return {
        present: true,
        ownership: manifest.ownership || null,
        repo: manifest.repo || null,
        budgetBytes: manifest.budgetBytes || 200000,
        totalBytes: documents.reduce((a, d) => a + (d.bytes || 0), 0),
        documents, orphanFiles, manifestError: null,
      };
    },
    async readFoundation(domain, project, slug) {
      const idx = await this.listFoundations(domain, project);
      const meta = (idx.documents || []).find((d) => d.slug === slug);
      if (!meta) return { ok: false, reason: 'foundation_not_found' };
      const file = join(dirOf(domain, project), slug);
      if (!existsSync(file)) return { ok: false, reason: 'foundation_not_found' };
      const text = readFileSync(file, 'utf8');
      return {
        ok: true, slug, role: meta.role, title: meta.title, text,
        bytes: Buffer.byteLength(text, 'utf8'), sha256: meta.sha256,
        updatedAt: meta.updatedAt, commit: meta.commit ?? null,
        source: meta.source, authoredBy: meta.authoredBy, ownership: idx.ownership,
        freshness: meta.freshness, sanitisedOnRead: false, truncated: false,
      };
    },
    async refreshFoundationsFromRepo() {
      return { ok: false, reason: 'store_pending',
        message: 'The foundations store has not shipped in this build.' };
    },
  };
}
// <<< WP-V TEMPORARY <<<

export default router;
