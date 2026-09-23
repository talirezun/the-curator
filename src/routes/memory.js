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
 *   · TIER 0 (`<project>/foundations/`) splits on OWNERSHIP rather than on
 *     tier, and since v3.61.0 the CURATOR-OWNED side is the human's too.
 *     The full four-part argument — one writer per FILE with provenance that
 *     matches, not one writer per process — is at the tier-0 block further
 *     down, beside the code it governs.
 *
 * So the write surface here is: create / rename / delete a project, replace
 * a project's brief, set the ownership once, WRITE one canonical document on a
 * curator-owned project only — REMOVE one on either ownership (v3.61.1) — and
 * FLAG one read-first on either ownership (v3.62.0). The asymmetry is the
 * point, and the three cases fall out of one rule rather than three:
 *
 *   · An EDIT to a mirrored document would make two writers of one FILE, so
 *     `PUT` stays curator-only (`requireManifest`'s neighbour,
 *     `requireCuratorOwned`).
 *   · REMOVING its entry is the decision to stop mirroring it. It rewrites
 *     the manifest and touches nothing in the folder the copy came from.
 *   · FLAGGING it read-first is the same kind of act one step smaller:
 *     `readFirst` is CURATOR METADATA ABOUT a document, never part of it, so
 *     `setFoundationReadFirst` writes `manifest.json` and nothing else and
 *     every mirrored `.md` stays byte-for-byte the checkout's — which is what
 *     the freshness claim `sha(stored) === sha(source)` rests on. The manifest
 *     is ALREADY a file this app writes on a mirror, on every refresh. And who
 *     reads what first is a decision a repository cannot make for its owner.
 *
 * All tier 1 and tier 0, all on files an agent does not race for.
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
 *   GET    /repo-scan?root=<abs>             candidate documents in a folder
 *   GET    /:domain/projects                 one domain's projects
 *   GET    /:domain/projects?as=project      …or the PROJECT called
 *                                            `projects`, if there is one
 *                                            (v3.62.0; see that route)
 *   POST   /:domain/projects                 create        {project, brief?,
 *                                                           foundations?}
 *   PATCH  /:domain/projects/:project        rename/brief  {rename?, brief?}
 *   DELETE /:domain/projects/:project        delete        {confirm}
 *   GET    /:domain/:project/foundations/:slug   one document (`?raw=1`)
 *   PUT    /:domain/:project/foundations/:slug   write one  {text, title?,
 *                                                role?, readFirst?} — the
 *                                                flag is TRI-STATE: omit it
 *                                                to leave the reading plan
 *                                                alone (v3.62.0)
 *   PATCH  /:domain/:project/foundations/:slug   the reading plan ONLY
 *                                                {readFirst} — EITHER
 *                                                ownership (v3.62.0)
 *   DELETE /:domain/:project/foundations/:slug   remove one {confirm} — EITHER
 *                                                ownership (v3.61.1): on a
 *                                                mirror it stops mirroring
 *                                                that document and leaves the
 *                                                source file alone; only PUT
 *                                                is curator-only
 *   POST   /:domain/:project/foundations/init    set ownership ONCE
 *   POST   /:domain/:project/foundations/refresh re-copy the mirror {files?,
 *                                                source? local|remote|auto,
 *                                                tokenSource? config|sync,
 *                                                remote?} — v3.63.0 reads the
 *                                                bytes from GitHub when the
 *                                                checkout is not on this
 *                                                machine; 409 only when BOTH
 *                                                arms are impossible
 *   POST   /:domain/:project/foundations/source
 *                                            "Mirror from GitHub instead"
 *                                            (v3.65.1) — re-point an existing
 *                                            repo-owned mirror at a GitHub
 *                                            repository {remote, tokenSource?,
 *                                            files?}: the bytes are re-copied,
 *                                            `repo.remote` is set and
 *                                            `repo.root` cleared in ONE write,
 *                                            ownership stays `repo`, and
 *                                            `readFirst` survives by slug
 *   GET    /:domain/:project/capture         the honesty meter — sessions,
 *                                            read/saved, off the local usage
 *                                            log (v3.63.0; `?since=`, `?limit=`;
 *                                            read-only, never blocks)
 *   GET    /:domain/:project                 one project's brief + state
 *   GET    /:project                         DEPRECATED alias (see below)
 *
 * TWO literals collide with a legal project slug: `projects`, which would
 * shadow `GET /:domain/:project` for a project of that name, and — since
 * v3.61.0 — `repo-scan`, which is the shape the one-segment deprecated alias
 * matches. Both are REFUSED as a project name by the create and rename routes
 * (RESERVED_PROJECT_NAMES), so the app cannot MINT the collision.
 *
 * ── AND THE ONE IT COULD NOT MINT, CLOSED IN v3.62.0 ─────────────────
 * Reserving a NAME cannot help with the domain's OWN project, because that
 * one is not minted — it exists because the domain does, and its slug IS the
 * domain name (`defaultProjectOf`). So a domain called `projects` has a
 * project called `projects`, and `/projects/projects` is one URL naming two
 * live resources: the Domains view's list and the Project-context view's
 * detail read. v3.57.0 recorded it; v3.61.0 recorded it again as "a project
 * literally named after its domain is still unreachable on the 2-segment
 * read". The list won and the detail simply lost.
 *
 * It is now settled by the CALLER rather than by the path: `?as=project` on
 * `GET /:domain/projects` makes that handler decline (`next()`), and Express
 * continues to `GET /:domain/:project`. The default — no `as` at all — is
 * byte-identical to what shipped, on every domain, so nothing that worked
 * before can now answer differently. The full argument, including why an
 * unrecognised value is a 400 while `?open=newest` is ignored, is at that
 * route. A project of either reserved name created OUT OF BAND is therefore
 * now fully addressable too — `projects` through `as=project`, `repo-scan`
 * through its two-segment detail URL, which the one-segment alias never
 * shadowed.
 *
 * The FOUR-segment foundations routes are unaffected in both directions:
 * `/:domain/projects` matches exactly two segments and cannot shadow four, so
 * `…/alpha/alpha/foundations/init` and every sibling reach the domain's own
 * project — asserted, not assumed, in
 * scripts/test-next-memory-projects.js §S10g. `PATCH`/`DELETE
 * /:domain/projects/:project` shadow nothing: they are the only routes on
 * their (method, segment-count) pair, and the new `PATCH
 * /:domain/:project/foundations/:slug` is the only route on ITS pair
 * (four segments, PATCH).
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
import {
  readUsageLinesUnion, summariseSessions, MAX_LINE_BYTES, MAX_LINE_BYTES_LABEL,
} from '../brain/mcp-usage.js';

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
 *   · `repo-scan` — v3.61.0. A one-segment literal on this router, exactly
 *     the shape the deprecated `GET /:project` alias matches. Registration
 *     order keeps the scan reachable, so this is the OTHER end of the same
 *     hole `projects` closes: a project of that name would have an
 *     unreachable detail URL on the alias. The STORE does not reserve it
 *     (`RESERVED_PROJECT_NAMES` in working-state.js holds the four names
 *     that collide with a file or directory it addresses, and this is not
 *     one), so a project directory of that name made out of band is still
 *     listed and still readable by every MCP tool — the app simply never
 *     mints one.
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
  'projects', 'repo-scan', 'project.md', 'journal.jsonl', 'foundations',
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
// TIER 0 — FOUNDATIONS, AND WHY A ROUTE MAY WRITE ONE (rewritten v3.61.0)
// ═════════════════════════════════════════════════════════════════════════
//
// The header block above states this router's tier boundary: tiers 2 and 3
// are agent-only, tier 1 is the human's. Tier 0 — the canonical documents a
// project carries VERBATIM (architecture, decisions, conventions, roadmap) —
// splits along a different line, and the line is OWNERSHIP rather than tier.
//
// v3.59.0 read this file's own argument too narrowly and concluded that NO
// route may write a curator-owned document. v3.61.0 adds `init`, `PUT` and
// `DELETE` under `…/foundations/`, and does so WITHOUT weakening anything,
// because the property was never "one PROCESS may write". It is:
//
//        ONE WRITER PER FILE, AND PROVENANCE THAT MATCHES.
//
// Four parts, each of which has to hold on its own:
//
//   (i)  ONE OWNERSHIP PER PROJECT, enforced in the STORE before any write
//        reaches disk — `saveFoundation` refuses a `curator`-sourced save
//        into a `repo`-owned project (`ownership-mismatch`), and
//        `refreshFoundationsFromRepo` refuses a curator-owned one. A write
//        from this router is always `source: {kind:'curator'}`, so it is
//        STRUCTURALLY incapable of landing on a mirror: not "we check", but
//        "there is no shape of request that could". `initFoundations` is the
//        SETTER for that one decision and refuses to re-make it
//        (`ownership-set`) — the routes here add a front door to an invariant
//        that already existed, not a new invariant.
//
//   (ii) THE HUMAN'S EDIT CARRIES THE HUMAN'S STAMP. Every write on this
//        router passes `authoredBy: {kind:'human'}`, exactly as the standing
//        brief does, which reads back with no harness and no model. An agent
//        writes this tier only through `save_foundation`, only when
//        commissioned, and carries its own line. The dishonesty the v3.17.0
//        block described — a human edit arriving under the last agent's
//        provenance — is what the stamp prevents, and it is why the stamp is
//        stated at the call site rather than left to a default.
//
//  (iii) THE COST, STATED. Tier 0 has NO `<machine>` segment (the same
//        carve-out `project.md` has), so two machines editing one
//        curator-owned document converge on whichever SAVED LAST under
//        Personal Sync's `git pull --no-rebase -X theirs` — and unlike a
//        mirror there is no upstream to re-assert it from and no journal
//        behind it. Edit rarely, sync after. docs/sync.md carries the
//        paragraph; this is not made worse by being in a browser rather than
//        in Obsidian — both are the human — but it is real.
//
//   (iv) WHAT THIS ROUTER IS, ON EACH SIDE. On a MIRROR it is a second
//        COPIER: a refresh compares `sha256` against a file the repository
//        already authors and copies the bytes when they differ, and two
//        copiers of one byte string converge rather than conflict. On a
//        CURATOR-OWNED document it is the OWNER'S PEN. It is NEITHER on
//        tiers 2 and 3, which stay agent-only, and nothing in this file can
//        reach them — the store functions it calls do not.

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

/** The three per-document start states on the wire (v3.67.0) — the store's
 *  FOUNDATION_START_STATES, restated for the same reason the slug rule is:
 *  a route-boundary check must not depend on the store being present. */
const START_STATES = Object.freeze(['read-first', 'on-request', 'not-at-start']);

/**
 * The store that answers the tier-0 calls.
 *
 * The SAME store `ws()` returns — one name, so that a suite installing the
 * test seam gets the tier-0 calls too, and so that a grep for the tier's
 * store calls finds one function rather than a scattering of `ws()` sites.
 */
function fstore() {
  return ws();
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
/**
 * ONE document's row, allow-listed. Extracted in v3.61.0 so the index and
 * the `PUT` response cannot describe the same document differently.
 */
function foundationDocRow(d) {
  return {
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
    // v3.61.0. ALWAYS PRESENT, never omitted when false: a block reading "N
    // skeletons to fill" needs a positive AND a negative answer from every
    // row, not an absence to interpret. A store that does not know the field
    // answers `false`, which is what an unfilled skeleton is not.
    skeleton: d.skeleton === true,
    // ── THE OWNER'S ROUTING FLAG (v3.62.0) ────────────────────────────
    // `readFirst` is what a session is handed every time; everything else
    // rides as an index row an agent opens BY NAME. Same `=== true` and the
    // same always-present rule as `skeleton` above, for the same reason: a
    // table with a "read first" column needs a negative answer from every
    // row, not an absence to interpret. It is CURATOR METADATA ABOUT a
    // document rather than part of it, which is why it exists on a mirror at
    // all — the manifest moves, the copied bytes do not.
    readFirst: d.readFirst === true,
    // v3.67.0 — the third state ("not at start"), always present, and the
    // one-word reading of all three in the wire alphabet. `atStart` is
    // derived from the two flags here rather than trusted, so a row can never
    // say one thing in `readFirst`/`hidden` and another in `atStart`.
    hidden: d.hidden === true && d.readFirst !== true,
    atStart: d.readFirst === true ? 'read-first' : d.hidden === true ? 'not-at-start' : 'on-request',
  };
}

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
    // ── THE FOUR REMOTE READINGS (v3.63.0), FORWARDED FIELD BY FIELD ────
    //
    // `listFoundations`'s own doc comment names what each means and why
    // `remoteChecked` is always false off THIS call: a GitHub comparison
    // happens only inside `refreshFoundationsFromRepo`, an action with a
    // button, never on a read that rides on every project switch and on the
    // menubar widget's summary. These four are project-level facts (whether
    // a repo is recorded, and what the last refresh — local or remote —
    // found), not a per-document reading, so they sit beside `repo` rather
    // than inside a document row.
    remoteMirror: out.remoteMirror === true,
    remoteChecked: out.remoteChecked === true,
    remoteCommit: out.remoteCommit ?? null,
    remoteError: out.remoteError ?? null,
    // HOW MANY DOCUMENTS ARE STILL PROMPTS (v3.61.0). Derived from the rows
    // below rather than trusted from the store's own tally, so the summary
    // line and the table can never disagree — and computed here rather than
    // left to the view, because two surfaces counting the same array is the
    // shape this file's neighbours keep re-learning.
    skeletonCount: docs.filter((d) => d && d.skeleton === true).length,
    // ── THE FIVE READ-FIRST READINGS (v3.62.0), FORWARDED, NOT DERIVED ──
    //
    // Taken from the store rather than recomputed here, because the store's
    // own `readFirstReadings` is what `setFoundationReadFirst` and the
    // bootstrap answer with, and three surfaces counting one array is the
    // shape this file's neighbours keep re-learning. Absent facts become
    // 0/false so a consumer can tell "the store looked and there was nothing"
    // from "this server does not know the field".
    //
    // `readFirstBudgetBytes` IS NOT `budgetBytes`. The first is the
    // BOOTSTRAP's reading budget (120 KB — what one session is actually
    // handed); the second is the PROJECT budget (200 KB — what tier 0 may
    // hold on disk). A project can sit comfortably under 200 KB and still
    // flag more than a bootstrap will send, so collapsing the two would make
    // a view say "within budget" about the wrong budget.
    readFirstCount: Number.isInteger(out.readFirstCount) ? out.readFirstCount : 0,
    onRequestCount: Number.isInteger(out.onRequestCount) ? out.onRequestCount : 0,
    readFirstBytes: Number.isInteger(out.readFirstBytes) ? out.readFirstBytes : 0,
    readFirstBudgetBytes: Number.isInteger(out.readFirstBudgetBytes) ? out.readFirstBudgetBytes : 0,
    readFirstBudgetExceeded: out.readFirstBudgetExceeded === true,
    // ── THE OWNER'S READING BUDGET (v3.67.0), FORWARDED ─────────────────
    // `readingBudgetBytes` here is the EFFECTIVE number (the owner's, else
    // the 120 KB default) and `readingBudgetSource` says whose; `planned` is
    // "the owner set one". `readFirstBudgetBytes` above now equals it.
    hiddenCount: Number.isInteger(out.hiddenCount) ? out.hiddenCount : 0,
    readingBudgetBytes: Number.isInteger(out.readingBudgetBytes) ? out.readingBudgetBytes : 0,
    readingBudgetSource: out.readingBudgetSource === 'owner' ? 'owner' : 'default',
    planned: out.planned === true,
    manifestNotes: Array.isArray(out.manifestNotes) ? out.manifestNotes.filter((n) => typeof n === 'string').slice(0, 20) : [],
    documents: docs.filter(Boolean).map(foundationDocRow),
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

/**
 * The store's refusal reason, in this router's own spelling — for the tier-0
 * WRITE routes only.
 *
 * ── WHY TRANSLATE AT ALL, GIVEN `statusForStoreRefusal`'s RULE ───────────
 * That function lists both spellings rather than normalising, precisely so a
 * caller matching on the string the store handed it goes on matching. That
 * rule protects EXISTING callers of existing routes. These routes are new in
 * v3.61.0: nothing has ever matched on their reasons, the contract and
 * docs/api-reference.md name them underscored, and the views are built to
 * that table. The precedent is in this file already — `POST …/refresh`
 * answers `curator_owned`, which is the ROUTE's word for the store's
 * `ownership-mismatch`.
 *
 * AN EXPLICIT TABLE, AND PASS-THROUGH OTHERWISE. A reason this table does
 * not name crosses the wire in the STORE's own spelling, so a refusal the
 * store grows next is never silently relabelled into something a client
 * would mis-read — it arrives unrecognised, which is honest, and
 * `statusForStoreRefusal` still decides its status.
 */
const TIER0_WIRE_REASON = new Map([
  ['invalid-ownership', 'invalid_ownership'],
  ['root-not-allowed', 'root_not_allowed'],
  ['ownership-set', 'ownership_set'],
  ['manifest-unreadable', 'manifest_unreadable'],
  ['repo-unreachable', 'repo_unreachable'],
  ['invalid-root', 'invalid_root'],
  ['ownership-mismatch', 'repo_owned'],
  ['too-large', 'too_large'],
  ['invalid-slug', 'invalid_slug'],
  ['invalid-role', 'invalid_role'],
  ['empty-foundation', 'empty'],
  ['not-found', 'foundation_not_found'],
  // v3.62.0. `setFoundationReadFirst` answers these two where the older write
  // routes reached them through `requireManifest`/`requireCuratorOwned`
  // instead. Named here so the PATCH's refusals cross the wire in the same
  // underscored spelling as every other tier-0 route's.
  ['no-manifest', 'no_manifest'],
  ['unsafe-path', 'unsafe_path'],
  // v3.65.0 — the remote init arm's own three. Every refusal the GitHub READ
  // can name (`no-token`, `rate-limited`, `remote-tree-truncated`, …) is
  // deliberately NOT in this table: those cross the wire in the store's own
  // spelling, exactly as they do from `…/refresh`, so one client branch reads
  // both doors.
  ['remote-not-allowed', 'remote_not_allowed'],
  ['root-and-remote', 'root_and_remote'],
  ['invalid-token-source', 'invalid_token_source'],
  // v3.67.0 — the start-state setter's own refusal.
  ['invalid-start-state', 'invalid_at_start'],
]);
function tier0Reason(reason) {
  return TIER0_WIRE_REASON.get(String(reason || '')) || reason || 'io';
}

/**
 * A store refusal from a tier-0 write, as an HTTP answer.
 *
 * The status comes from the STORE's own spelling (that is what
 * `statusForStoreRefusal` knows), and the wire `reason` from the table above;
 * every other field the store returned rides along — `ownership` and
 * `documentCount` on `ownership-set`, `bytes` and `cap` on `too-large`,
 * `manifestError` — because a refusal that names its numbers is the only one
 * a person can act on, and dropping a fact the store computed honestly is
 * this module's own recorded defect class.
 */
function tier0Refusal(res, out, extra) {
  const storeReason = (out && out.reason) || 'io';
  const status = statusForStoreRefusal({ reason: storeReason });
  return res.status(status).json(withErrorProse({
    ...(out || {}),
    ...extra,
    ok: false,
    reason: tier0Reason(storeReason),
  }));
}

/**
 * The mirror step's report, allow-listed.
 *
 * `refused` is the field this exists for: a file somebody ticked in the
 * picker and did NOT get is exactly the kind of fact that vanishes when a
 * response is projected by hand, and the view renders it un-folded beside the
 * outcome (v3.16.1 — refusals never fold).
 */
function refreshWire(out) {
  if (!out || typeof out !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []);
  return {
    ok: out.ok !== false,
    refreshed: list(out.refreshed),
    unchanged: list(out.unchanged),
    added: list(out.added),
    // NEVER DELETED, ONLY REPORTED: a source that has vanished from the
    // folder leaves its copy in place, and this list is what says the two
    // have parted.
    missing: list(out.missing),
    refused: (Array.isArray(out.refused) ? out.refused : []).slice(0, 50).map((r) => ({
      path: r && typeof r.path === 'string' ? r.path.slice(0, 200) : null,
      reason: r && typeof r.reason === 'string' ? r.reason.slice(0, 200) : null,
    })),
    commit: out.commit ?? null,
    notes: Array.isArray(out.notes) ? out.notes.slice(0, 20).filter((n) => typeof n === 'string') : [],
  };
}

/**
 * Read the tier-0 index for a WRITE route, and decide whether the write may
 * proceed at all.
 *
 * THREE ANSWERS, AND EACH IS A DIFFERENT SENTENCE TO A PERSON:
 *   · `manifest_unreadable` — there IS a manifest and this store cannot read
 *     it. Rewriting it could drop entries for documents nobody can see, so
 *     nothing is written; the store refuses this too, and refusing here as
 *     well means the message names the file rather than the operation.
 *   · `no_manifest` — ownership has never been chosen. `init` is the call.
 *   · `repo_owned` — the documents are MIRRORED, so the edit belongs in the
 *     folder they are mirrored from. Checked HERE rather than left to the
 *     store's `ownership-mismatch` only because the sentence a person needs
 *     ("edit it there and refresh") is about the app's own two controls.
 *
 * Returns `{ok: true, index}` or sends the refusal and returns `{ok: false}`.
 */
async function requireCuratorOwned(res, domain, project) {
  let index;
  try { index = await fstore().listFoundations(domain, project); }
  catch (err) {
    res.status(500).json({ ok: false, reason: 'io', error: err.message });
    return { ok: false };
  }
  if (index && index.ok === false) { tier0Refusal(res, index, { domain, project }); return { ok: false }; }
  if (index && index.manifestError) {
    res.status(400).json({
      ok: false, reason: 'manifest_unreadable', domain, project, manifestError: index.manifestError,
      error: `This project's foundations/manifest.json could not be read (${index.manifestError}). `
        + 'Nothing was written: rewriting a manifest this app cannot read could drop entries for '
        + 'documents it cannot see. Fix or remove that file first.',
    });
    return { ok: false };
  }
  if (!index || index.present !== true) {
    res.status(400).json({
      ok: false, reason: 'no_manifest', domain, project,
      error: 'This project has not chosen where its canonical documents live yet. Choose that first '
        + '— keep them here, or mirror them from a folder on this computer — and then edit them.',
    });
    return { ok: false };
  }
  if (index.ownership === 'repo') {
    res.status(400).json({
      ok: false, reason: 'repo_owned', domain, project, ownership: 'repo',
      error: 'This document is mirrored from the repository — edit it there and refresh. '
        + 'A mirror is a byte copy of a file whose author is the folder it came from, so an edit '
        + 'made here would be overwritten by the next refresh.',
    });
    return { ok: false };
  }
  return { ok: true, index };
}

/**
 * The same read, WITHOUT the ownership refusal — for REMOVAL (v3.61.1).
 *
 * ── WHY REMOVAL IS NOT AN EDIT, AND WHY v3.61.0 GOT THIS WRONG ───────────
 * `requireCuratorOwned` refuses a mirror because an EDIT there would be
 * overwritten by the next refresh: the folder is the author, so a write here
 * would make two writers of one file. That argument does not reach removal.
 * Removing a mirrored document is not a claim about its CONTENT, it is the
 * decision to stop mirroring it — and the refresh's work list is built from
 * `manifest.documents` (`refreshCore`, working-state.js), so an entry that is
 * gone STAYS gone until somebody names that file again. v3.61.0's own comment
 * here claimed "the next refresh would simply put it back", and the code says
 * otherwise; the release recorded the refusal as "arguably wrong" and this is
 * the correction.
 *
 * What it leaves in place: the typed confirmation, the slug grammar, the
 * read-only-mirror refusal, `no_manifest` and `manifest_unreadable`. PUT keeps
 * `requireCuratorOwned` unchanged — a mirrored document still cannot be
 * EDITED here, which is the invariant that matters.
 *
 * Returns `{ok: true, index}` or sends the refusal and returns `{ok: false}`.
 */
async function requireManifest(res, domain, project) {
  let index;
  try { index = await fstore().listFoundations(domain, project); }
  catch (err) {
    res.status(500).json({ ok: false, reason: 'io', error: err.message });
    return { ok: false };
  }
  if (index && index.ok === false) { tier0Refusal(res, index, { domain, project }); return { ok: false }; }
  if (index && index.manifestError) {
    res.status(400).json({
      ok: false, reason: 'manifest_unreadable', domain, project, manifestError: index.manifestError,
      error: `This project's foundations/manifest.json could not be read (${index.manifestError}). `
        + 'Nothing was removed: rewriting a manifest this app cannot read could drop entries for '
        + 'documents it cannot see. Fix or remove that file first.',
    });
    return { ok: false };
  }
  if (!index || index.present !== true) {
    res.status(400).json({
      ok: false, reason: 'no_manifest', domain, project,
      error: 'This project has no canonical documents yet, so there is nothing to remove.',
    });
    return { ok: false };
  }
  return { ok: true, index };
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
// GET /api/memory/repo-scan?root=<abs> — what a folder has that could be a
// foundation. READ-ONLY, and PROJECT-FREE.
//
// REGISTERED SECOND, AND THAT IS CORRECTNESS. `repo-scan` is one segment
// past `/api/memory/`, which is exactly what the deprecated `GET /:project`
// alias matches — so registered after it, this route would never be reached
// and a scan would come back as a 404 about a domain called `repo-scan`.
// Express matches in registration order within a segment count; this row
// therefore has to precede `/:project`, and sitting immediately after the
// index makes the reason visible instead of implied. `repo-scan` is a
// reserved project name for the other half of the same hole.
//
// NO DOMAIN, NO PROJECT, NO WRITE. The scan answers "what is in this folder
// that could become a canonical document" — a question about the user's own
// disk, asked before a project has chosen anything. It is therefore not
// guarded by `requireDomain`/`refuseMirror` (there is no domain to guard and
// nothing to write); the containment that matters is the store's, which
// requires an ABSOLUTE path, resolves it through `realpath`, descends no
// symlinked directory and offers no symlinked file whose target leaves the
// root. This route adds no second opinion about any of that.
// ═════════════════════════════════════════════════════════════════════════
router.get('/repo-scan', async (req, res) => {
  try {
    const root = typeof req.query.root === 'string' ? req.query.root.trim() : '';
    // The LOCAL arm first, and returning from inside it, so the remote arm
    // below is an addition rather than a wrapper: `test-next-foundations-
    // editor.js` §12 reads a 3,000-character window from this handler's
    // first line and requires the local arm's per-field `modifiedAt` forward
    // inside it — an unowned pin, measured, and this ordering is what keeps
    // it true.
    if (req.query.source !== 'remote') {
      const out = await fstore().scanRepoForFoundations(root);
      if (!out || out.ok === false) {
        // TWO DIFFERENT FACTS, TWO DIFFERENT STATUSES, and the store already
        // separates them: `invalid-root` means the text is not a usable
        // absolute path (400 — fix what you typed), `repo-unreachable` means
        // it is a fine path that is not on this computer (409 — nothing is
        // malformed, the folder is simply not here).
        return tier0Refusal(res, out || { reason: 'invalid-root' }, { root: root || null });
      }
      res.json({
        ok: true,
        // THE RESOLVED root, not the one that was typed: a symlinked or
        // `..`-shaped path is answered with where it actually landed, so the
        // caller mirrors from the same folder the scan read.
        root: out.root,
        candidates: (Array.isArray(out.candidates) ? out.candidates : []).map((c) => ({
          path: c.path ?? null,
          bytes: Number.isInteger(c.bytes) ? c.bytes : 0,
          suggestedRole: c.suggestedRole ?? null,
          // The slug the store WOULD derive from this path, so the picker and
          // the mirror agree about what a ticked row becomes — the view
          // deriving its own would be a second copy of a rule.
          suggestedSlug: c.suggestedSlug ?? null,
          tooLarge: c.tooLarge === true,
          // WHICH RULE ADMITTED IT. A picker showing a file from a folder
          // called `adr/` has to be able to say why it is there.
          matchedBy: c.matchedBy ?? null,
          firstHeading: c.firstHeading ?? null,
          // ── WHEN THE SOURCE FILE WAS LAST TOUCHED (v3.61.1) ────────────
          // The store's ISO `mtime`, forwarded FIELD BY FIELD like every
          // other key here rather than by a spread, so a field the store
          // grows does not reach a client until somebody decides it should.
          // `?? null` and not a truthiness test: the store already answers
          // null for an unreadable timestamp, and the picker renders an
          // absent age as "unknown" rather than inventing one.
          modifiedAt: typeof c.modifiedAt === 'string' ? c.modifiedAt : null,
        })),
        truncated: out.truncated === true,
        // THE CAP, THE DEPTH AND THE WALL, named rather than left for a view
        // to hard-code: "200 of them, and we looked 4 levels down" is what
        // makes a short list readable as a measurement instead of a failure.
        cap: Number.isInteger(out.cap) ? out.cap : null,
        maxDepth: Number.isInteger(out.maxDepth) ? out.maxDepth : null,
        maxDocumentBytes: Number.isInteger(out.maxDocumentBytes) ? out.maxDocumentBytes : null,
      });
      return;
    }

    // ── THE REMOTE ARM (v3.65.0) ────────────────────────────────────────
    //
    // `?source=remote&remote=owner/repo` lists the same candidates out of a
    // GITHUB repository, for the machine that has no checkout to point at.
    // TWO requests whatever the repository's size (the ref, then one
    // recursive tree) and no blob is fetched — which is the only reason this
    // is offered at all rather than a form that asks the owner to type paths.
    //
    // STILL A GET, and still the same read-only route. It costs a rate limit
    // and touches a credential FILE, so it is an action with a button and
    // never a poll — the same rule `…/refresh` states. It is a GET because it
    // writes nothing: making it a POST would put a non-mutating read into
    // every mutating-route census in this repo.
    //
    // NO TOKEN CROSSES THIS ROUTE. `tokenSource` names which file to read it
    // from, exactly as on the init and the refresh.
    {
      const remote = typeof req.query.remote === 'string' ? req.query.remote.trim().slice(0, 300) : '';
      const scan = await fstore().scanRemoteForFoundations({
        remote: remote || null,
        // BESIDE the remote, never inside it: git prints no branch and no
        // folder in a remote URL, so a caller holding `owner/repo` as a
        // string has nowhere to put them. The store re-normalises both.
        ...(typeof req.query.ref === 'string' && req.query.ref.trim() ? { ref: req.query.ref.trim().slice(0, 200) } : {}),
        ...(typeof req.query.path === 'string' && req.query.path.trim() ? { path: req.query.path.trim().slice(0, 300) } : {}),
        tokenSource: req.query.tokenSource === 'sync' ? 'sync' : 'config',
      });
      if (!scan || scan.ok === false) {
        const reason = (scan && scan.reason) || 'invalid-remote';
        const status = REFRESH_REMOTE_STATUS.get(reason) ?? statusForStoreRefusal({ reason });
        return res.status(status).json(withErrorProse({ ...(scan || {}), ok: false, reason }));
      }
      return res.json({
        ok: true,
        // NULL, and never a path: nothing on this computer was read.
        root: null,
        source: 'remote',
        remote: scan.remote || null,
        commit: scan.commit ?? null,
        tokenSource: scan.tokenSource ?? null,
        candidates: (Array.isArray(scan.candidates) ? scan.candidates : []).map((c) => ({
          path: c.path ?? null,
          bytes: Number.isInteger(c.bytes) ? c.bytes : 0,
          suggestedRole: c.suggestedRole ?? null,
          suggestedSlug: c.suggestedSlug ?? null,
          tooLarge: c.tooLarge === true,
          matchedBy: c.matchedBy ?? null,
          // ALWAYS NULL ON THIS ARM, and the same field name rather than an
          // omitted key: a tree carries no heading and no timestamp, and the
          // picker renders both as unknown. An absent key would read as "this
          // server is older" instead of "this repository was not opened".
          firstHeading: null,
          modifiedAt: null,
        })),
        truncated: scan.truncated === true,
        cap: Number.isInteger(scan.cap) ? scan.cap : null,
        maxDepth: Number.isInteger(scan.maxDepth) ? scan.maxDepth : null,
        maxDocumentBytes: Number.isInteger(scan.maxDocumentBytes) ? scan.maxDocumentBytes : null,
        requests: Number.isInteger(scan.requests) ? scan.requests : null,
      });
    }
  } catch (err) {
    console.error('Memory repo-scan error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/memory/:domain/projects — one domain's projects
//
// REGISTERED BEFORE `/:domain/:project`. Express matches in registration
// order within a segment count, so this literal has to come first — without
// it the Domains view's list endpoint would not be reachable at all.
//
// ── THE COLLISION THAT ORDERING CREATES, AND HOW IT IS RESOLVED (v3.62.0) ─
//
// The second segment `projects` is genuinely ambiguous. For every domain it
// can mean the LIST; for a domain whose own project is named `projects` — and
// `defaultProjectOf(domain)` returns the DOMAIN NAME, so that is exactly the
// domain called `projects`, which is the maintainer's own — it can equally
// mean that project's DETAIL read. `/projects/projects` is one URL and two
// resources, and both are live: the Domains view needs the list, the
// Project-context view needs the detail.
//
// So it cannot be settled from the path, and the previous release did not
// settle it: v3.57.0 recorded it, v3.61.0 recorded it again as "a project
// literally named after its domain is still unreachable on the 2-segment
// read". What was reachable was the list; the detail simply lost.
//
// THE RULE: the second segment `projects` means the LIST unless the request
// says `?as=project`, in which case this handler declines by calling `next()`
// and Express continues to `GET /:domain/:project` — which re-parses its own
// params and is answered about a project called `projects`.
//
//   GET /articles/projects                → the list         (unchanged)
//   GET /projects/projects                → the list         (unchanged)
//   GET /projects/projects?as=project     → the detail read  (NEW)
//   GET /articles/projects?as=project     → the detail read of a project
//                                           called `projects` in `articles`,
//                                           404 when there is none
//
// WHY IT CANNOT MISROUTE. The default is byte-identical to what shipped: a
// caller that has never heard of `as` gets exactly today's answer, on every
// domain, including one called `projects`. The only way to reach the other
// resource is to ASK for it by name, and asking for it on a domain that has
// no such project is a 404 from `handleDetail`'s own `project_not_found` arm
// rather than a wrong 200. A domain called `projects` holding a real project
// called `projects` — which the STORE permits, since its own
// `RESERVED_PROJECT_NAMES` holds only the four names that collide with a file
// or directory it addresses, and `projects` is not one — therefore has BOTH
// of its resources addressable, which is the first time that has been true.
//
// WHY NOT RESERVE THE NAME HARDER INSTEAD. `RESERVED_PROJECT_NAMES` below
// already stops this app MINTING such a project, and that is kept. It cannot
// help here: the domain's OWN project is not minted, it exists because the
// domain does, and its name is the domain's name. Reserving `projects` as a
// DOMAIN name would be a migration for every install that has one.
//
// WHY A QUERY PARAMETER RATHER THAN A NEW PATH. A new path (`…/project/…`)
// would be a second public shape for a read that already has one, and this
// router already carries one deprecated alias it is trying to retire. `as` is
// ADDITIVE: no existing URL changes meaning, and the contract stays "one
// path, two resources, and the caller names which".
//
// AN UNRECOGNISED VALUE IS A 400, not an ignored field — deliberately
// different from `?open=newest`, which this router DOES ignore when it does
// not recognise it. The difference is what a mistake costs. `open` picks how
// much of one resource to send; `as` picks WHICH RESOURCE, so silently
// serving the list to somebody who typed `as=projct` is the exact failure
// this parameter exists to remove.
// ══════════════════════════════════════════════════════════════════════════

/**
 * The one value of `?as=` that changes which resource `…/projects` names.
 * Exported so a suite pins the literal rather than re-typing it, and so the
 * two readings of the segment have a name in code.
 */
export const AS_PROJECT = 'project';
export const AS_LIST = 'list';

router.get('/:domain/projects', async (req, res, next) => {
  try {
    const { domain } = req.params;
    // THE DISAMBIGUATOR IS READ BEFORE THE DOMAIN IS RESOLVED, so a
    // fall-through never costs a `listDomains()` this handler is not going to
    // use — and, more importantly, so the 404 for an unknown domain comes
    // from ONE place (the handler that actually answers) rather than from
    // whichever of the two got there first.
    const as = req.query.as;
    if (as !== undefined) {
      if (as === AS_PROJECT) return next();
      if (as !== AS_LIST) {
        return res.status(400).json({
          ok: false, reason: 'invalid_as',
          error: `"${String(as).slice(0, 40)}" is not a value for \`as\`. `
            + `Use \`as=${AS_LIST}\` for this domain's projects, or \`as=${AS_PROJECT}\` `
            + 'to read a project that is itself called "projects".',
        });
      }
    }
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
    // ── TIER 0 IN THE SAME GESTURE (v3.61.0), OPT-IN ─────────────────────
    // `foundations` is the start-a-project ownership choice. The STORE
    // validates `ownership`, refuses a `repoRoot` on the curator arm and
    // resolves the folder; a second opinion here would be a second thing to
    // keep in step. The SHAPE is checked (an object, not an array, not a
    // string) because anything else would reach the store as
    // `opts.foundations.ownership` on a string and read `undefined` — the
    // silent-mismatch shape this file's store-adapter block was written
    // about.
    //
    // AN ALLOW-LIST, NOT THE OBJECT AS SENT, and this one is a trust
    // boundary rather than tidiness: `createProject` reads
    // `foundations.authoredBy` and prefers it over the caller's own, so a
    // body carrying `{authoredBy: {kind: 'agent', harness: 'x'}}` would have
    // stamped the owner's seeded skeletons with an agent's provenance —
    // exactly the dishonesty part (ii) of the tier-0 argument forbids, and
    // reachable from any loopback client. Four fields cross; the stamp is
    // this router's to set and nobody else's.
    const f = body.foundations && typeof body.foundations === 'object'
      && !Array.isArray(body.foundations) ? body.foundations : null;
    const wantsFoundations = !!f;

    const out = await store.createProject(domain, project, {
      ...(brief ? { brief } : {}),
      authoredBy: { kind: 'human' },
      ...(wantsFoundations ? {
        foundations: {
          ownership: f.ownership,
          ...(typeof f.repoRoot === 'string' ? { repoRoot: f.repoRoot } : {}),
          ...(Array.isArray(f.files) ? { files: f.files } : {}),
          ...(f.seed === false ? { seed: false } : {}),
          authoredBy: { kind: 'human' },
        },
      } : {}),
    });
    if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(withErrorProse(out));

    // ── A TIER-0 FAILURE IS DISCLOSED, NEVER A 5xx AND NEVER A ROLLBACK ──
    // The project EXISTS at this point: it has a brief, a marker line and a
    // place for handoffs. Deleting it to report a tidier failure would throw
    // away the thing that succeeded, and the owner can re-make the choice
    // from the Foundations block — which is the same call.
    const init = out && out.foundations && typeof out.foundations === 'object' ? out.foundations : null;
    const initOk = !!(init && init.ok !== false);
    res.status(201).json({
      ok: true, domain, project, created: true,
      // WHAT GOES IN `.curator-project` at the root of the project folder, so an
      // agent knows which project to resume. The store composes it;
      // the fallback is the same string and exists only so an older store
      // cannot make this field absent, which a view would read as "this
      // server does not know about marker lines".
      markerLine: (out && typeof out.markerLine === 'string' && out.markerLine)
        || `${domain}/${project}`,
      foundations: initOk ? foundationsWire(init.foundations || init) : null,
      // The mirror step's own report, when there was one. `refused[]` is the
      // reason this rides along rather than being left to the wire index: a
      // file the owner ticked and did NOT get is invisible in a document
      // list, and the create banner is the only place it can still be said.
      refresh: initOk && init.refresh ? refreshWire(init.refresh) : null,
      foundationsError: out && out.foundationsError
        ? {
          reason: tier0Reason(out.foundationsError.reason),
          message: out.foundationsError.message
            || 'The canonical documents could not be set up. The project itself was created.',
        }
        : null,
    });
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

/** The store's refusals, in this router's underscored spelling. Explicit,
 *  and a reason this table does not name crosses the wire in the store's own
 *  spelling — the same rule `TIER0_WIRE_REASON` states. */
const KNOWLEDGE_WIRE_REASON = new Map([
  ['not-a-list', 'invalid_knowledge_domains'],
  ['empty-list', 'invalid_knowledge_domains'],
  ['invalid-domain', 'invalid_domain'],
  ['unknown-domain', 'unknown_domain'],
  ['too-many-domains', 'too_many_domains'],
  ['unknown-state-project', 'project_not_found'],
  ['invalid-state-project', 'invalid_project'],
  ['unsafe-path', 'unsafe_path'],
]);
/** A refusal's status, where the shared table would answer 400 for a fact
 *  that is not about the request's shape. */
const KNOWLEDGE_STATUS = new Map([
  // The project is not there. 404 for the same reason `handleDetail` answers
  // 404 for a project that does not exist.
  ['unknown-state-project', 404],
  // A domain that is not on this computer is a fact about the SERVER's state
  // as much as the request's, but the caller named it and can fix it: 400,
  // with the names that were not found in `domains`.
  ['unknown-domain', 400],
  ['locked', 409],
]);

// ═════════════════════════════════════════════════════════════════════════
// PATCH /api/memory/:domain/:project/knowledge/domains — which wikis (v3.65.0)
//
// A HUMAN WRITE, AND LEGITIMATE. The router's tier boundary above stands
// unchanged: tiers 2 and 3 are agent-only, tier 1 is the human's. This writes
// NEITHER. `knowledgeDomains` is CURATOR METADATA ABOUT the project — which
// wikis its knowledge lives in — held in `state/[<project>/]project.json`,
// which has exactly one writer (the owner, here) and stamps nothing with an
// agent's provenance. It is the same reading that made v3.62.0's
// `readFirst` PATCH legitimate on either ownership: metadata about a thing is
// not the thing. `save_working_state` and `my-curator save` do NOT write it —
// an agent does not choose a project's knowledge.
//
// FOUR SEGMENTS, DELIBERATELY. `PATCH /:domain/projects/:project` is
// registered above and matches any three-segment PATCH whose SECOND segment
// is literally `projects` — and a domain's own project is named after the
// domain, so the maintainer's own `projects/projects` would have had its
// knowledge write swallowed by the rename handler (v3.62.0's `?as=project`
// collision, in the one shape a query parameter cannot fix: a PATCH body
// cannot disambiguate a path that already matched something else). Four
// segments cannot collide with it at all, and `…/foundations/:slug` is the
// precedent for a project sub-resource at that depth.
//
// A STRICT ONE-FIELD BODY, the template being v3.62.0's `readFirst` PATCH:
// an unknown key is a 400 rather than a silent ignore, because this route
// records a decision and a decision half-applied is worse than refused.
// `null` CLEARS the choice — the project goes back to reading as its own
// domain — and is not the same as `[]`, which is refused: a project that
// searches nothing has no knowledge, and nobody means that.
// ═════════════════════════════════════════════════════════════════════════
router.patch('/:domain/:project/knowledge/domains', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
    if (!validProjectName(ws(), project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!Object.prototype.hasOwnProperty.call(body, 'knowledgeDomains')) {
      return res.status(400).json({
        ok: false, reason: 'invalid_knowledge_domains',
        error: 'Send `{ knowledgeDomains: ["research", "business"] }`, or `{ knowledgeDomains: null }` '
          + 'to go back to this project’s own domain.',
      });
    }
    const extra = Object.keys(body).filter((k) => k !== 'knowledgeDomains');
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts only \`knowledgeDomains\`. It was also sent: ${extra.slice(0, 10).join(', ')}.`,
      });
    }
    const wanted = body.knowledgeDomains;
    if (wanted !== null && !Array.isArray(wanted)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_knowledge_domains',
        error: '`knowledgeDomains` must be a list of domain names, or null to clear the choice.',
      });
    }

    const out = await ws().setKnowledgeDomains(domain, project, wanted);
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'io';
      return res.status(KNOWLEDGE_STATUS.get(reason) ?? statusForStoreRefusal({ reason }))
        .json(withErrorProse({ ...(out || {}), ok: false, domain, project, reason: KNOWLEDGE_WIRE_REASON.get(reason) || reason }));
    }
    res.json({
      ok: true, domain, project,
      knowledgeDomains: Array.isArray(out.knowledgeDomains) ? out.knowledgeDomains : [],
      // WAS IT CHOSEN, OR IS IT THE DEFAULT. The same pair the read carries,
      // so a view can repaint from this reply without a second request — and
      // so `cleared: true` is never mistaken for "now empty".
      knowledgeDomainsDefaulted: out.knowledgeDomainsDefaulted === true,
      cleared: out.cleared === true,
      cap: Number.isInteger(out.cap) ? out.cap : null,
    });
  } catch (err) {
    console.error('Memory knowledge-domains error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /api/memory/:domain/:project/reading/budget — the READING BUDGET (v3.67.0)
//
// A HUMAN WRITE on exactly the footing of `knowledge/domains` above: curator
// metadata ABOUT a project in `state/[<project>/]project.json`, one writer
// (the owner, here), never tier 1/2/3. FOUR SEGMENTS for the same collision
// that route records: a three-segment PATCH whose second segment is literally
// `projects` is swallowed by `PATCH /:domain/projects/:project`.
//
// A STRICT ONE-FIELD BODY: `{readingBudgetBytes: int|null}`. 0 is Index only;
// 8192 … 204800 is a budget; null CLEARS it, and the project reads as
// unplanned — v3.66.0's behaviour — again.
// ═════════════════════════════════════════════════════════════════════════
const READING_BUDGET_STATUS = new Map([
  ['unknown-state-project', 404],
  ['locked', 409],
]);
const READING_BUDGET_WIRE_REASON = new Map([
  ['invalid-reading-budget', 'invalid_reading_budget'],
  ['unknown-state-project', 'project_not_found'],
  ['invalid-state-project', 'invalid_project'],
  ['unsafe-path', 'unsafe_path'],
]);
const READING_BUDGET_CAP = 204800;
const READING_BUDGET_MIN = 8192;
function isReadingBudgetValue(v) {
  return Number.isInteger(v) && (v === 0 || (v >= READING_BUDGET_MIN && v <= READING_BUDGET_CAP));
}

router.patch('/:domain/:project/reading/budget', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
    if (!validProjectName(ws(), project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(body).filter((k) => k !== 'readingBudgetBytes');
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts only \`readingBudgetBytes\`. It was also sent: ${extra.slice(0, 10).join(', ')}.`,
      });
    }
    const v = body.readingBudgetBytes;
    if (!Object.prototype.hasOwnProperty.call(body, 'readingBudgetBytes') || (v !== null && !isReadingBudgetValue(v))) {
      return res.status(400).json({
        ok: false, reason: 'invalid_reading_budget',
        error: `Send \`{ readingBudgetBytes: <bytes> }\` — 0 for Index only, or a whole number from ${READING_BUDGET_MIN} `
          + `to ${READING_BUDGET_CAP} — or \`{ readingBudgetBytes: null }\` to go back to the default.`,
      });
    }
    const out = await ws().setReadingBudget(domain, project, v);
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'io';
      return res.status(READING_BUDGET_STATUS.get(reason) ?? statusForStoreRefusal({ reason }))
        .json(withErrorProse({ ...(out || {}), ok: false, domain, project, reason: READING_BUDGET_WIRE_REASON.get(reason) || reason }));
    }
    res.json({
      ok: true, domain, project,
      readingBudgetBytes: Number.isInteger(out.readingBudgetBytes) ? out.readingBudgetBytes : null,
      readingBudgetDefaulted: out.readingBudgetDefaulted === true,
      cleared: out.cleared === true,
      readFirstBudgetBytes: Number.isInteger(out.readFirstBudgetBytes) ? out.readFirstBudgetBytes : 0,
      readFirstBudgetExceeded: out.readFirstBudgetExceeded === true,
    });
  } catch (err) {
    console.error('Memory reading-budget error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET  /api/memory/:domain/:project/session-start          (v3.67.0)
// POST /api/memory/:domain/:project/session-start/preview
//
// WHAT AN AGENT RECEIVES AT SESSION START, MEASURED — never estimated. The
// MCP figure is the REAL `get_project_context` handler's serialised size
// (after its own response bound), called DIRECTLY rather than through the MCP
// dispatcher, so a preview is never logged as a session in the usage log. The
// hook figure is the REAL session-start Markdown (`renderFramedContextMarkdown`,
// moved to src/brain/ so no route imports src/cli/). Both are READS: nothing
// is written anywhere, including the usage log.
//
// Tokens are NEVER on the wire. The view divides by four and says so; a wire
// field would be an estimate dressed as a measurement.
//
// `presets[]` carries all five presets' MCP bytes in ONE answer (a what-if run
// per preset), so hovering a preset in the picker costs no request at all.
// The preview POST is for the one what-if that needs a body — a proposed plan
// of up to 200 documents does not belong in a URL.
//
// Read routes are not behind `refuseMirror` (a mirror's start is real).
// ═════════════════════════════════════════════════════════════════════════
const SESSION_START_PLAN_MAX = 200;
const SESSION_BRIEF_CAP = 32768;
const SESSION_HANDOFF_CAP = 49152;
const SESSION_REPLY_CAP = 307200;
const PRESET_BYTES = Object.freeze([
  ['index-only', 0], ['lean', 32768], ['standard', 65536], ['deep', 122880], ['max', 204800],
]);

const utf8 = (x) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x ?? null), 'utf8');
/** Exactly as mcp/tools/index.js serialises a reply. */
const mcpSize = (obj) => Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8');

/**
 * The session-start report. `whatIf` is the store's internal option
 * (`{ownerBudgetBytes?, startStates?}`), reached ONLY from this router.
 * Exported for the suite; not a route of its own.
 */
export async function sessionStartReport(domain, project, whatIf = null) {
  const { getProjectContextHandler } = await import('../../mcp/tools/working-state.js');
  const { renderFramedContextMarkdown } = await import('../brain/context-markdown.js');
  const run = (wi) => getProjectContextHandler({ domain, project }, null, wi ? { whatIf: wi } : {});
  const out = await run(whatIf);
  if (!out || out.ok !== true) return { ok: false, reason: out?.reason || 'io', error: out?.error || 'unreadable' };
  const f = out.foundations || {};
  const mcp = mcpSize(out);

  // THE HOOK DOOR: the store envelope the hook reads (no caller budget, the
  // store's own journal default), rendered by the real function.
  const store = workingState;
  const ctx = await store.getProjectContext(domain, project, whatIf ? { whatIf } : {});
  const hook = ctx && ctx.ok === true ? utf8(await renderFramedContextMarkdown(ctx)) : 0;

  // Every preset, same plan, one what-if run each — MCP bytes only.
  const presets = [];
  for (const [id, bytes] of PRESET_BYTES) {
    const wi = { ...(whatIf || {}), ownerBudgetBytes: bytes };
    const p = await run(wi);
    presets.push({ id, bytes, mcpBytes: p && p.ok === true ? mcpSize(p) : null });
  }

  // "Not at start" documents are absent from the reply by design; their size
  // comes from the index, with the what-if plan applied the same way.
  const list = await store.listFoundations(domain, out.project);
  const plan = whatIf && whatIf.startStates && typeof whatIf.startStates === 'object' ? whatIf.startStates : null;
  const hiddenDocs = (list && list.ok !== false && Array.isArray(list.documents) ? list.documents : [])
    .filter((d) => {
      const st = plan && Object.prototype.hasOwnProperty.call(plan, d.slug) ? plan[d.slug] : d.atStart;
      return st === 'not-at-start';
    });

  const sent = Array.isArray(f.documents) ? f.documents : [];
  const rows = Array.isArray(f.index) ? f.index : [];
  const sizeOf = new Map(rows.map((r) => [r.slug, Number.isInteger(r.bytes) ? r.bytes : 0]));
  const sentSlugs = new Set(sent.map((d) => d.slug));
  const omittedSlugs = Array.isArray(f.budget?.omitted) ? f.budget.omitted.filter((x) => typeof x === 'string') : [];
  const omittedSet = new Set(omittedSlugs);
  const readFirstSent = sent.filter((d) => d.readFirst === true);
  const otherSent = sent.filter((d) => d.readFirst !== true);
  const onRequest = rows.filter((r) => !sentSlugs.has(r.slug) && !omittedSet.has(r.slug));
  const textBytes = (arr) => arr.reduce((n, d) => n + utf8(d.text || ''), 0);

  const tiers = {
    brief: { bytes: out.brief?.present ? utf8(out.brief.text || '') : 0, present: out.brief?.present === true, capBytes: SESSION_BRIEF_CAP },
    handoff: { bytes: out.current?.present ? utf8(out.current.text || '') : 0, present: out.current?.present === true, capBytes: SESSION_HANDOFF_CAP },
    journal: {
      bytes: Array.isArray(out.journal?.entries) && out.journal.entries.length ? utf8(out.journal.entries) : 0,
      lines: Array.isArray(out.journal?.entries) ? out.journal.entries.length : 0,
    },
    index: { bytes: rows.length ? utf8(rows) : 0, listed: rows.length, hiddenCount: Number.isInteger(f.hiddenCount) ? f.hiddenCount : 0 },
    readFirst: {
      bytes: textBytes(readFirstSent), count: readFirstSent.length,
      budgetBytes: Number.isInteger(f.readFirstBudgetBytes) ? f.readFirstBudgetBytes : 0,
      exceeded: f.readFirstBudgetExceeded === true,
    },
    otherText: { bytes: textBytes(otherSent), count: otherSent.length },
    onRequest: { bytes: onRequest.reduce((n, r) => n + (sizeOf.get(r.slug) || 0), 0), count: onRequest.length },
    omitted: { bytes: omittedSlugs.reduce((n, sl) => n + (sizeOf.get(sl) || 0), 0), count: omittedSlugs.length, slugs: omittedSlugs.slice(0, 200) },
    hidden: { bytes: hiddenDocs.reduce((n, d) => n + (Number.isInteger(d.bytes) ? d.bytes : 0), 0), count: hiddenDocs.length },
    domainPages: { domains: Array.isArray(out.knowledgeDomains) ? out.knowledgeDomains.slice(0, 12) : [], bytes: 0 },
    framing: { bytes: 0 },
  };
  const counted = tiers.brief.bytes + tiers.handoff.bytes + tiers.journal.bytes + tiers.index.bytes
    + tiers.readFirst.bytes + tiers.otherText.bytes;
  // "Framing and structure": labels, the report, the authority note, the
  // JSON keys and indentation — everything in the reply that is not a tier.
  tiers.framing.bytes = Math.max(0, mcp - counted);

  const b = f.budget || {};
  const source = ['owner', 'default', 'whatif', 'caller'].includes(b.source) ? b.source : 'default';
  const sentText = tiers.readFirst.bytes + tiers.otherText.bytes;
  const planned = f.planned === true;
  const notes = [];
  if (out.readingBudgetError) notes.push(String(out.readingBudgetError).slice(0, 300));
  if (f.manifestError) notes.push(`the foundations manifest could not be read: ${String(f.manifestError).slice(0, 200)}`);
  if (typeof b.bounded === 'string') notes.push(b.bounded);
  return {
    ok: true, domain: out.domain, project: out.project,
    budget: {
      bytes: Number.isInteger(b.maxBytes) ? b.maxBytes : 0,
      source, defaulted: source === 'default',
      ownerBytes: Number.isInteger(out.readingBudgetBytes) ? out.readingBudgetBytes : null,
      cap: READING_BUDGET_CAP, replyCapBytes: SESSION_REPLY_CAP,
    },
    planned,
    presets,
    tiers,
    bytes: { mcp, hook },
    costLine: { applies: !planned && (f.count || 0) > 0 && sentText > 32768, documentTextBytes: sentText },
    notes,
  };
}

async function sessionStartGate(req, res) {
  const { domain, project } = req.params;
  if (!await requireDomain(res, domain)) return null;
  const store = ws();
  if (!validProjectName(store, project)) {
    res.status(400).json({ ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.` });
    return null;
  }
  const state = await readState(store, domain, project, {});
  if (!state.ok) { res.status(statusForStoreRefusal(state)).json(withErrorProse(state)); return null; }
  if (state.projectExists === false) {
    res.status(404).json({ ok: false, reason: 'project_not_found', domain, project, error: `"${project}" is not a project in "${domain}".` });
    return null;
  }
  return { domain, project };
}

function sendSessionStart(res, report) {
  if (!report || report.ok !== true) {
    const reason = report?.reason || 'io';
    return res.status(statusForStoreRefusal({ reason })).json(withErrorProse({ ok: false, reason, error: report?.error }));
  }
  return res.json(report);
}

router.get('/:domain/:project/session-start', async (req, res) => {
  try {
    const g = await sessionStartGate(req, res);
    if (!g) return;
    sendSessionStart(res, await sessionStartReport(g.domain, g.project, null));
  } catch (err) {
    console.error('Memory session-start error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:domain/:project/session-start/preview', async (req, res) => {
  try {
    const g = await sessionStartGate(req, res);
    if (!g) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(body).filter((k) => k !== 'budgetBytes' && k !== 'plan');
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts only \`budgetBytes\` and \`plan\`. It was also sent: ${extra.slice(0, 10).join(', ')}.`,
      });
    }
    const whatIf = {};
    if (Object.prototype.hasOwnProperty.call(body, 'budgetBytes')) {
      if (body.budgetBytes !== null && !isReadingBudgetValue(body.budgetBytes)) {
        return res.status(400).json({
          ok: false, reason: 'invalid_reading_budget',
          error: `\`budgetBytes\` is 0, a whole number from ${READING_BUDGET_MIN} to ${READING_BUDGET_CAP}, or null.`,
        });
      }
      whatIf.ownerBudgetBytes = body.budgetBytes;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'plan')) {
      const plan = body.plan;
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return res.status(400).json({ ok: false, reason: 'invalid_plan', error: '`plan` is an object of `{ "<slug>.md": "read-first" | "on-request" | "not-at-start" }`.' });
      }
      const entries = Object.entries(plan);
      if (entries.length > SESSION_START_PLAN_MAX) {
        return res.status(400).json({ ok: false, reason: 'invalid_plan', error: `\`plan\` names ${entries.length} documents; at most ${SESSION_START_PLAN_MAX}.` });
      }
      const startStates = {};
      for (const [slug, st] of entries) {
        if (!FOUNDATION_SLUG_RE.test(slug)) {
          return res.status(400).json({ ok: false, reason: 'invalid_slug', error: `"${String(slug).slice(0, 80)}" is not a usable document name.` });
        }
        if (!START_STATES.includes(st)) {
          return res.status(400).json({ ok: false, reason: 'invalid_at_start', error: `"${slug}": the state must be one of ${START_STATES.join(', ')}.` });
        }
        startStates[slug] = st;
      }
      whatIf.startStates = startStates;
    }
    sendSessionStart(res, await sessionStartReport(g.domain, g.project, whatIf));
  } catch (err) {
    console.error('Memory session-start preview error:', err);
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
    // ── `?raw=1` — THE BYTES, FOR AN EDITOR (v3.61.0) ───────────────────
    // The write path is verbatim and the DEFAULT read path defangs, so a
    // surface that loaded a document through the default read and then saved
    // it back would store `https[:]//` where the document says `https://` —
    // corrupting a canonical document on its first edit, with no edit having
    // been made, and breaking the sha equality a mirror's freshness claim
    // rests on. So an EDITOR reads raw and every display path keeps the
    // default. The flag is OPT-IN and the default is untouched: a caller
    // that does not ask gets exactly what v3.59.0 answered.
    const raw = req.query.raw === '1' || req.query.raw === 'true';
    const out = await store.readFoundation(domain, project, slug, raw ? { raw: true } : {});
    // ABSENT IS A 404, not a 200 describing an empty document. The store
    // distinguishes "there is no such entry" from "the file would not read",
    // and both are forwarded with their own reason; what is never done is
    // answering 200 with an empty body, which is how a typo renders as a
    // working, blank page (the same rule `project_not_found` follows below).
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'foundation_not_found';
      const body = withErrorProse({
        ok: false, domain, project, slug,
        ...(out || {}),
        // THE STORE SAYS `not-found`; THIS ROUTER SAYS `foundation_not_found`.
        // Until v3.61.0 the store's spelling crossed the wire un-translated
        // and fell through `statusForStoreRefusal`'s table to the default
        // 400, so a document that simply is not there answered "bad request"
        // — and every guard in the suite was driven against a STUB that
        // happened to use the router's spelling, which is why nothing saw it.
        reason: tier0Reason(reason),
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
// PUT /api/memory/:domain/:project/foundations/:slug — the owner's pen
//
// CURATOR-OWNED ONLY, and the refusal on a mirror is not an error condition:
// it is a statement about what the document IS. See the tier-0 block above
// for the four-part single-writer argument this route rests on.
// ═════════════════════════════════════════════════════════════════════════
/**
 * Create or replace ONE document, whole.
 *
 * ── `replace: true`, AND THE ONE THING IT GIVES UP ──────────────────────
 * The store refuses a write that shrinks a document to under 10 % of the
 * bytes on disk, because tier 0 is replaced in place with no journal behind
 * it. That guard is right for an AGENT composing a document it cannot see.
 * It is wrong here, and worse than wrong: the app's editor is SEEDED WITH
 * THE DOCUMENT'S CURRENT TEXT (through `?raw=1`), so a shrink is something a
 * person did to text on their own screen and then pressed Save on — and the
 * refusal's own advice ("repeat the call with replace: true") is advice a
 * person in a browser cannot take. Advice that cannot be followed is worse
 * than none. Exactly the reasoning `saveBrief` records one tier up, and the
 * honesty moves to the VIEW, which shows a confirm strip naming both sizes
 * when a draft is under 90 % of what was loaded.
 *
 * An EMPTY document is still refused, by the store, ahead of the shrink
 * guard and regardless of this flag. So is one over the 512 KB per-document
 * cap — and that message names BOTH numbers and is forwarded verbatim rather
 * than restated here, because a wall a person can measure is a wall they can
 * act on.
 */
router.put('/:domain/:project/foundations/:slug', async (req, res) => {
  try {
    const { domain, project, slug } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
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
    const body = req.body || {};
    if (typeof body.text !== 'string') {
      return res.status(400).json({
        ok: false, reason: 'empty',
        error: 'Send `text` — the COMPLETE document. A save replaces the whole file.',
      });
    }
    // ── `readFirst` IS TRI-STATE AND MUST STAY THAT WAY (v3.62.0) ───────
    //
    // The store reads `undefined` as "leave the existing flag alone" and an
    // explicit boolean as "move it". So an OMITTED field has to arrive as
    // `undefined`, never as `false`: a save that carried a normalised `false`
    // would silently un-route a document every time its text was edited, and
    // the owner would find their reading plan quietly emptying itself one
    // save at a time with nothing to see.
    //
    // Allow-listed like the rest of this body (v3.61.0: a create body could
    // stamp a seeded skeleton with a FORGED agent provenance), so only a real
    // boolean is forwarded and anything else is the omitted case.
    if (body.readFirst !== undefined && typeof body.readFirst !== 'boolean') {
      return res.status(400).json({
        ok: false, reason: 'invalid_read_first',
        error: '`readFirst` must be true or false. Omit it to leave the document\u2019s '
          + 'current reading plan alone.',
      });
    }

    const gate = await requireCuratorOwned(res, domain, project);
    if (!gate.ok) return;

    // CREATED OR REPLACED, decided BEFORE the write off the manifest this
    // route already read. The store answers `replaced`, which is the same
    // fact inverted; taking it from the pre-write index means the response
    // says "created" for exactly the rows the block did not have.
    const had = (gate.index.documents || []).some((d) => d && d.slug === slug);

    const store = fstore();
    const out = await store.saveFoundation(domain, project, {
      slug,
      text: body.text,
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
      ...(body.role !== undefined && body.role !== null && body.role !== '' ? { role: body.role } : {}),
      // THE HUMAN'S STAMP, part (ii) of the tier-0 argument. Never an agent
      // line, and never left to a default: `save_foundation` over MCP stamps
      // the agent, so an unstamped file would be ambiguous.
      authoredBy: { kind: 'human' },
      // SPREAD, not `readFirst: body.readFirst`. The key must be ABSENT when
      // the caller omitted it, because the store distinguishes an absent key
      // from `false` and an explicit `readFirst: undefined` is the same thing
      // to `inp.readFirst === undefined` but not to a reader of this code.
      ...(body.readFirst === undefined ? {} : { readFirst: body.readFirst }),
      replace: true,
    });
    if (!out || out.ok === false) return tier0Refusal(res, out || { reason: 'io' }, { domain, project, slug });

    // THE ROW, FROM THE INDEX THAT NOW EXISTS. Re-read so `freshness` — which
    // is COMPUTED and which `saveFoundation` does not return — is the same
    // value the table beside the editor will show; the save result is the
    // fallback so a re-read that fails cannot cost the response.
    const after = await foundationsIndexFor(domain, project);
    const row = (after && Array.isArray(after.documents)
      ? after.documents.find((d) => d && d.slug === slug) : null) || foundationDocRow(out);

    res.json({
      ok: true, domain, project,
      created: !had,
      document: row,
      totalBytes: Number.isInteger(out.totalBytes) ? out.totalBytes : 0,
      budgetBytes: Number.isInteger(out.budgetBytes) ? out.budgetBytes : 0,
      // A DISCLOSURE, NEVER A WALL (the per-document cap is the wall). The
      // store accepts an over-budget project and says so; a UI that refused
      // what the store accepted would be inventing a limit.
      budgetExceeded: out.budgetExceeded === true,
      // WHETHER THIS SAVE FILLED A SKELETON. The store computes it and it is
      // the one fact that lets a banner say "Architecture is written now"
      // rather than just "saved" — dropping a fact the store computed
      // honestly is this module's own recorded defect class.
      wasSkeleton: out.wasSkeleton === true,
      // AND WHERE THE FLAG ENDED UP. Forwarded on the SAVE as well as on the
      // PATCH, because a save that preserved a flag and a save that moved one
      // are different facts and the row beside the editor shows the flag.
      readFirst: out.readFirst === true,
      wasReadFirst: out.wasReadFirst === true,
      notes: Array.isArray(out.notes) ? out.notes : [],
    });
  } catch (err) {
    console.error('Memory foundation write error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/memory/:domain/:project/foundations/:slug — the reading plan
//
// EITHER OWNERSHIP, and that is the whole reason this is not the PUT's job.
// ══════════════════════════════════════════════════════════════════════════
/**
 * Flag ONE document read-first, or unflag it. Body: `{readFirst: boolean}` and
 * nothing else.
 *
 * ── WHY THIS IS NOT `PUT … {readFirst}` ──────────────────────────
 * The PUT is refused `repo_owned` on a mirror, on the single-writer argument
 * the tier-0 block above states: an EDIT there would be overwritten by the
 * next refresh, because the folder is the author. A repo-owned project routed
 * only through the PUT would therefore have had no way to flag anything from
 * the app at all — which is most of the projects this tier exists for, since
 * mirroring a checkout is the commonest way documents arrive.
 *
 * ── AND WHY A FLAG ON A MIRROR IS NOT A SECOND WRITER ────────────────
 * The property the argument protects is ONE WRITER PER FILE WITH PROVENANCE
 * THAT MATCHES — never "one process may write". `readFirst` is CURATOR
 * METADATA ABOUT a document, not part of it: `setFoundationReadFirst` writes
 * `foundations/manifest.json` and NOTHING else, so every mirrored `.md` stays
 * byte-for-byte the checkout's and `sha(stored) === sha(source)`, which is the
 * claim the whole freshness reading rests on, is untouched. The manifest is
 * ALREADY a file this app writes on a mirror — `POST …/foundations/refresh`
 * rewrites it on every re-copy, and v3.61.1's `DELETE` rewrites it to stop
 * mirroring a document. This is the same file, one boolean, and the routing
 * decision it records is the OWNER's: who reads what first is not something a
 * repository can know.
 *
 * The cost, stated rather than implied away: tier 0 has no `<machine>`
 * segment, so two machines flagging the same project converge to whichever
 * saved last — the `project.md` carve-out in docs/sync.md, extended one tier
 * down, and the same cost `saveFoundation` already pays.
 *
 * ── THE BODY IS ONE FIELD, AND A SECOND ONE IS A 400 ────────────────
 * Not tidiness: this route is reachable on a MIRROR, so a body that quietly
 * ignored a `text` key would be a write path to a mirrored document wearing
 * the wrong method. Refusing the whole request is what keeps the "this route
 * writes the manifest and nothing else" claim checkable from the outside.
 */
router.patch('/:domain/:project/foundations/:slug', async (req, res) => {
  try {
    const { domain, project, slug } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
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

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // ── v3.67.0: EXACTLY ONE OF `readFirst` OR `atStart` ────────────────
    // `atStart` is the three-state form (`read-first` · `on-request` ·
    // `not-at-start`); `readFirst` keeps its v3.62.0 behaviour and reply
    // byte for byte. Both at once is a 400, like any second key.
    const hasAtStart = Object.prototype.hasOwnProperty.call(body, 'atStart');
    if (hasAtStart) {
      const extraA = Object.keys(body).filter((k) => k !== 'atStart');
      if (extraA.length) {
        return res.status(400).json({
          ok: false, reason: 'unexpected_fields', fields: extraA.slice(0, 10),
          error: `Send exactly one of \`readFirst\` or \`atStart\`. It was also sent: ${extraA.slice(0, 10).join(', ')}.`,
        });
      }
      if (!START_STATES.includes(body.atStart)) {
        return res.status(400).json({
          ok: false, reason: 'invalid_at_start',
          error: `\`atStart\` must be one of ${START_STATES.join(', ')}. This route changes the reading plan and nothing else.`,
        });
      }
      const outA = await fstore().setFoundationStartState(domain, project, slug, body.atStart);
      if (!outA || outA.ok === false) return tier0Refusal(res, outA || { reason: 'io' }, { domain, project, slug });
      return res.json({
        ok: true, domain, project,
        slug: outA.slug || slug,
        atStart: START_STATES.includes(outA.atStart) ? outA.atStart : body.atStart,
        wasAtStart: START_STATES.includes(outA.wasAtStart) ? outA.wasAtStart : null,
        changed: outA.changed === true,
        readFirst: outA.readFirst === true,
        hidden: outA.hidden === true,
        readFirstCount: Number.isInteger(outA.readFirstCount) ? outA.readFirstCount : 0,
        onRequestCount: Number.isInteger(outA.onRequestCount) ? outA.onRequestCount : 0,
        readFirstBytes: Number.isInteger(outA.readFirstBytes) ? outA.readFirstBytes : 0,
        readFirstBudgetBytes: Number.isInteger(outA.readFirstBudgetBytes) ? outA.readFirstBudgetBytes : 0,
        readFirstBudgetExceeded: outA.readFirstBudgetExceeded === true,
        hiddenCount: Number.isInteger(outA.hiddenCount) ? outA.hiddenCount : 0,
      });
    }
    if (typeof body.readFirst !== 'boolean') {
      return res.status(400).json({
        ok: false, reason: 'invalid_read_first',
        error: 'Send `{ readFirst: true }` or `{ readFirst: false }`. This route changes the '
          + 'reading plan and nothing else. (Or `{ atStart: "read-first" | "on-request" | "not-at-start" }`.)',
      });
    }
    const extra = Object.keys(body).filter((k) => k !== 'readFirst');
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts only \`readFirst\`. It was also sent: ${extra.slice(0, 10).join(', ')}. `
          + 'Use PUT to change a document\u2019s text, title or role.',
      });
    }

    // NO `requireCuratorOwned` AND NO `requireManifest` HERE. The store's own
    // gate is the one that matters and it is the one the view has to be able
    // to act on: `no-manifest` before init, `not-found` for a slug that is not
    // listed, `manifest-unreadable` for a manifest this app must not rewrite.
    // Pre-reading the index here would be a SECOND copy of that decision, one
    // that could disagree with the store under the lock the store takes and
    // this route does not.
    const out = await fstore().setFoundationReadFirst(domain, project, slug, body.readFirst);
    if (!out || out.ok === false) return tier0Refusal(res, out || { reason: 'io' }, { domain, project, slug });

    res.json({
      ok: true, domain, project,
      slug: out.slug || slug,
      readFirst: out.readFirst === true,
      // WAS IT ALREADY? `changed: false` is a SUCCESS — the document is in
      // the state that was asked for — and saying so is what lets a view
      // avoid announcing a change nobody made.
      wasReadFirst: out.wasReadFirst === true,
      changed: out.changed === true,
      // THE FIVE READINGS, so the block's summary line ("N read first · M on
      // request") can be patched in place without a re-read of the project.
      // Forwarded from the store rather than recomputed, for the reason
      // `foundationsWire` records at its own copy of these names.
      readFirstCount: Number.isInteger(out.readFirstCount) ? out.readFirstCount : 0,
      onRequestCount: Number.isInteger(out.onRequestCount) ? out.onRequestCount : 0,
      readFirstBytes: Number.isInteger(out.readFirstBytes) ? out.readFirstBytes : 0,
      readFirstBudgetBytes: Number.isInteger(out.readFirstBudgetBytes) ? out.readFirstBudgetBytes : 0,
      // A DISCLOSURE, NEVER A WALL, and measured against the BOOTSTRAP's
      // 120 KB reading budget rather than the project's 200 KB: the flagged
      // set is what one session is handed, so that is the figure a person
      // flagging a fifth document needs to see.
      readFirstBudgetExceeded: out.readFirstBudgetExceeded === true,
      // v3.67.0, additive: the three-state reading of the same row, so a
      // view using either body can repaint from either reply.
      atStart: START_STATES.includes(out.atStart) ? out.atStart : (out.readFirst === true ? 'read-first' : 'on-request'),
      hidden: out.hidden === true,
      hiddenCount: Number.isInteger(out.hiddenCount) ? out.hiddenCount : 0,
    });
  } catch (err) {
    console.error('Memory foundation read-first error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/memory/:domain/:project/foundations/:slug — remove one
//
// TYPED CONFIRMATION AT THE ROUTE, for the same reason
// `DELETE …/projects/:project` has one: a confirmation that lives only in a
// view is a confirmation any other client skips. A canonical document has no
// journal behind it, so this is not recoverable from the app.
// ═════════════════════════════════════════════════════════════════════════
router.delete('/:domain/:project/foundations/:slug', async (req, res) => {
  try {
    const { domain, project, slug } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
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
    const confirm = req.body && typeof req.body.confirm === 'string' ? req.body.confirm : '';
    if (confirm !== slug) {
      return res.status(400).json({
        ok: false, reason: 'confirm_required',
        error: `Type the document's name to confirm. Expected "${slug}".`,
      });
    }

    // ── REMOVAL WORKS ON BOTH OWNERSHIPS (v3.61.1) ──────────────────────
    //
    // It did not, and that was the defect: `requireCuratorOwned` refused a
    // mirror here on the grounds — written into this comment in v3.61.0 —
    // that "a mirrored document is dropped by no longer listing it on the next
    // refresh, never by deleting the copy, which the next refresh would simply
    // put back". The second half is false. `refreshCore` builds its work list
    // from `manifest.documents`, so an entry that is gone stays gone; and the
    // first half describes a control the app does not have. The result was a
    // mirrored project whose document list could not be edited at all —
    // reported by the maintainer on his own repository, 25 rows including
    // files he never meant to mirror. v3.61.0 recorded the refusal as
    // "arguably wrong"; it is wrong.
    //
    // So the gate is the MANIFEST rather than the ownership, and the ownership
    // is REPORTED instead, because the outcome a person needs to read differs:
    // a curator document is gone for good, a mirror's SOURCE FILE is untouched
    // and can be mirrored again. `PUT` keeps `requireCuratorOwned` — a
    // mirrored document still cannot be edited here, which is the invariant
    // the two-writers argument actually protects.
    const gate = await requireManifest(res, domain, project);
    if (!gate.ok) return;
    const wasMirrored = gate.index && gate.index.ownership === 'repo';

    const out = await fstore().removeFoundation(domain, project, slug);
    if (!out || out.ok === false) return tier0Refusal(res, out || { reason: 'io' }, { domain, project, slug });
    res.json({
      ok: true, domain, project,
      removed: out.slug || slug,
      // WHICH OUTCOME THIS WAS. The copy is gone either way; on a mirror the
      // file it was copied FROM is still in the folder, and saying so is the
      // difference between "stopped mirroring" and "deleted my document".
      ownership: wasMirrored ? 'repo' : 'curator',
      sourceKept: wasMirrored === true,
      // WHAT IT WAS. An orphan is a file on disk the manifest never listed —
      // the shape a crash between a document write and the manifest write
      // leaves behind — and removing one is a legitimate cleanup, reported
      // as what it was rather than as an ordinary delete.
      wasOrphan: out.wasOrphan === true,
    });
  } catch (err) {
    console.error('Memory foundation delete error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/memory/:domain/:project/foundations/init — the ownership setter
//
// ONE DECISION, MADE ONCE. Part (i) of the tier-0 argument above: the store
// has refused a mismatch since v3.59.0 and had no way to RECORD the choice
// before a document existed, so a new project's tier 0 was empty and nothing
// told the owner what belongs in it. This is that setter, and it refuses to
// re-make the decision (`ownership_set`) — changing it would mean either
// overwriting documents written here with a mirror, or stranding the copies
// of a folder.
// ═════════════════════════════════════════════════════════════════════════
/**
 * THE BODY THIS ROUTE ACCEPTS, and nothing else (v3.65.0).
 *
 * Named as a set rather than checked inline so the refusal can PRINT it — a
 * 400 that says which fields exist is the difference between a caller fixing
 * a typo and a caller guessing. `token` is deliberately absent: see the
 * handler.
 */
export const INIT_BODY_FIELDS = new Set(['ownership', 'repoRoot', 'files', 'seed', 'remote', 'tokenSource']);

router.post('/:domain/:project/foundations/init', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
    if (!validProjectName(ws(), project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    // ── A STRICT BODY (v3.65.0) ──────────────────────────────────────────
    // The pre-v3.65.0 handler was an allow-list already — it named each field
    // it forwarded — but it IGNORED anything else. Now an unknown key is a
    // 400, and the field that made it worth changing is `token`: the remote
    // arm reads its credential from a FILE and from nothing else, so a `token`
    // in this body must never look accepted. Refusing it by name says so;
    // ignoring it says nothing and invites a second attempt.
    //
    // MEASURED AGAINST THE ONLY CALLER: `chooserBody` in
    // `shared/foundations-init.js` sends `{ownership, repoRoot?, files?,
    // seed?}` and nothing else, so no shipped request becomes a 400.
    const extra = Object.keys(body).filter((k) => !INIT_BODY_FIELDS.has(k));
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts ${[...INIT_BODY_FIELDS].join(', ')}. It was also sent: ${extra.slice(0, 10).join(', ')}.`
          + (extra.includes('token')
            ? ' A GitHub token is NEVER sent here: `tokenSource` names which file on this computer to read it from '
              + '(`config` = the read-only token in Settings, `sync` = Personal Sync’s own).'
            : ''),
      });
    }
    // EVERY FIELD IS THE STORE'S TO VALIDATE. `ownership` has no default
    // here on purpose: guessing one would record a decision the owner did
    // not make, and it is the one decision this tier will not re-make.
    const namedRemote = typeof body.remote === 'string' && body.remote.trim()
      ? body.remote.trim().slice(0, 300)
      : (body.remote && typeof body.remote === 'object' && !Array.isArray(body.remote) ? body.remote : null);
    const out = await fstore().initFoundations(domain, project, {
      ownership: body.ownership,
      ...(typeof body.repoRoot === 'string' ? { repoRoot: body.repoRoot } : {}),
      ...(Array.isArray(body.files) ? { files: body.files } : {}),
      ...(body.seed === false ? { seed: false } : {}),
      // ── THE REMOTE ARM (v3.65.0) ───────────────────────────────────────
      // Forwarded ONLY when the body named one, so an absent key reaches the
      // store as absent and the local arm is unchanged. NO TOKEN CROSSES THIS
      // ROUTE: `tokenSource` names the FILE, exactly as on `…/refresh`.
      ...(namedRemote ? { remote: namedRemote } : {}),
      ...(typeof body.tokenSource === 'string' ? { tokenSource: body.tokenSource } : {}),
      authoredBy: { kind: 'human' },
    });
    if (!out || out.ok === false) {
      // The remote read's own refusals are NOT input errors and the shared
      // table would call them all 400 — the same argument `…/refresh` makes,
      // and the same table, so a rate limit is a 429 whichever door it came
      // through.
      const reason = (out && out.reason) || 'io';
      const remoteStatus = REFRESH_REMOTE_STATUS.get(reason);
      if (remoteStatus !== undefined) {
        return res.status(remoteStatus).json(withErrorProse({
          ...(out || {}), ok: false, domain, project, reason: tier0Reason(reason),
        }));
      }
      return tier0Refusal(res, out || { reason: 'io' }, { domain, project });
    }

    res.status(201).json({
      ok: true, domain, project,
      ownership: out.ownership || null,
      foundations: foundationsWire(out.foundations) || foundationsWire({ documents: out.documents || [] }),
      // WHERE IT MIRRORS FROM when it was born remote, and WHICH FILE the
      // token came from — never the token. Both null on every other arm.
      remote: out.remote && typeof out.remote === 'object' ? {
        owner: out.remote.owner ?? null,
        repo: out.remote.repo ?? null,
        ref: out.remote.ref ?? null,
        path: out.remote.path ?? null,
      } : null,
      tokenSource: out.tokenSource ?? null,
      // WHICH SKELETONS WERE WRITTEN — empty on the repo arm and on
      // `seed: false`, which is a fact and not an omission.
      seeded: Array.isArray(out.seeded) ? out.seeded : [],
      // The mirror step's report when `files` were named, `null` otherwise.
      // `refused[]` is why this is forwarded rather than left to the index: a
      // file the owner ticked and did not get is invisible in a list of the
      // documents that DID arrive.
      refresh: out.refresh ? refreshWire(out.refresh) : null,
      notes: Array.isArray(out.notes) ? out.notes : [],
    });
  } catch (err) {
    console.error('Memory foundations init error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/memory/:domain/:project/foundations/refresh — re-copy the mirror
//
// THE ONE TIER-0 WRITE THIS APP MAKES ON A MIRROR, and the header block above
// this section's helpers records the argument in full: a refresh is a byte
// copy from a repository that is already the document's author, so running it
// makes this app a second COPIER rather than a second WRITER. It never
// composes, never merges, never calls an LLM, and it cannot create a
// curator-owned document — that is what the 400 below is for.
//
// ── THE REMOTE ARM (v3.63.0) DOES NOT WEAKEN THAT ARGUMENT ──────────────
// It changes WHERE the bytes are read from — GitHub's API at a named commit
// rather than a checkout on this disk — and nothing about who authored them.
// The repository is still the author; this is still a copy; two copiers of
// one byte string still converge rather than conflict. What it removes is the
// accident that made the copier's machine special: `repo.root` is a path on
// ONE computer, so on every other one the mirror read "source not on this
// computer" for ever. The three things it adds are all refusals, not powers:
// the client can issue no verb but GET, a truncated file listing aborts
// before a single byte is fetched, and the token is read from a file the user
// wrote rather than from anything that crosses this route.
//
// `source` picks the arm — `auto` (the default) takes the checkout when it is
// here and GitHub when it is not, `local` and `remote` name one. A 409 means
// BOTH were impossible, and says why for each.
//
// NO TOKEN CROSSES THIS ROUTE. `tokenSource` names WHICH FILE to read it
// from (`config` = the separate read-only `githubReadToken`, the recommended
// one; `sync` = Personal Sync's PAT, which the user is asked about because a
// CLASSIC sync token can read every repository they own and was granted for
// something else). A `token` in the body is not read, here or in the store.
// ═════════════════════════════════════════════════════════════════════════

/**
 * A refresh refusal's HTTP status.
 *
 * The remote arm's reasons are NEW and `statusForStoreRefusal` — which is
 * shared with every other tier-0 route — would answer 400 for all of them by
 * its default arm. 400 is wrong for most: a rate limit is not a malformed
 * request, and neither is GitHub having a bad afternoon. Named here, in the
 * one handler that can produce them, rather than widened into the shared
 * table where a future route would inherit answers nobody chose for it.
 */
const REFRESH_REMOTE_STATUS = new Map([
  // The stored credential cannot read that repository. Not 401: the user is
  // not being asked to authenticate to The Curator.
  ['unauthorised', 403],
  // GitHub's limit, not ours, and the one status that says "later".
  ['rate-limited', 429],
  // Upstream conditions. Nothing here is malformed and nothing is broken
  // locally, which is what 502 says and what 400 would deny.
  ['remote-tree-truncated', 502],
  ['remote-http', 502],
  ['remote-unreachable', 502],
  ['remote-too-large', 502],
  // The repository, the ref or the path is not there — or the token cannot
  // see it, which GitHub answers identically and the message says so.
  ['remote-not-found', 404],
  // The request named a remote this cannot read. That one IS input.
  ['invalid-remote', 400],
  // No token in the named file, and no checkout either: the server's state is
  // not one this request can act on — the same 409 an absent checkout gets.
  ['no-token', 409],
  ['remote-unavailable', 500],
]);
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
        error: 'These documents were written for this project, not mirrored from a folder on this '
          + 'computer, so there is nothing to refresh from. Edit one here, or ask your agent to.',
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

    // ── WHICH ARM (v3.63.0) ─────────────────────────────────────────────
    // `auto` is the default and is the honest one: prefer the checkout, fall
    // back to GitHub. `local` reproduces every pre-v3.63.0 answer exactly.
    const source = body.source === 'remote' ? 'remote' : body.source === 'local' ? 'local' : 'auto';
    const tokenSource = body.tokenSource === 'sync' ? 'sync' : 'config';
    // A remote is recorded on the manifest OR named in the body. The store
    // validates the shape and answers `invalid-remote`; this route only needs
    // to know whether the arm is even AVAILABLE before it refuses below.
    const namedRemote = typeof body.remote === 'string' && body.remote.trim()
      ? body.remote.trim().slice(0, 300)
      : (body.remote && typeof body.remote === 'object' && !Array.isArray(body.remote) ? body.remote : null);
    const hasRemote = !!(namedRemote || (index && index.repo && index.repo.remote));

    // NO PATH AND NO REPOSITORY — both arms are impossible, so both reasons
    // are named. A 409 for the same reason it has always been one: nothing is
    // malformed, the server's own state is simply not one the request can act
    // on. The original sentence is kept WORD FOR WORD as the first clause,
    // because it is the actionable half for the user who has a checkout
    // somewhere and because a client may be matching on it.
    if (!root && !hasRemote) {
      return res.status(409).json({
        ok: false, reason: 'repo_unreachable',
        error: 'This project has no folder path recorded on this computer, so there is '
          + 'nothing to copy from. Save state from the checkout once with `repo_root` set, '
          + 'or pass the path. No GitHub repository is recorded for this mirror either, '
          + 'so there is nothing to read over the network.',
        arms: {
          local: { possible: false, reason: 'no_root' },
          remote: { possible: false, reason: 'no_remote' },
        },
      });
    }
    // `local` was asked for by name and there is no path: refuse rather than
    // quietly doing the other thing. Naming an arm is a decision.
    if (!root && source === 'local') {
      return res.status(409).json({
        ok: false, reason: 'repo_unreachable',
        error: 'This project has no folder path recorded on this computer, so there is '
          + 'nothing to copy from. Save state from the checkout once with `repo_root` set, '
          + 'or pass the path.',
        arms: { local: { possible: false, reason: 'no_root' }, remote: { possible: hasRemote, reason: hasRemote ? null : 'no_remote' } },
      });
    }

    // ── `files` (v3.61.0) — ADDING to the mirror, not only re-copying ────
    // Before this release the route passed no file list, so a mirror could
    // only ever be created from a test: the store's `opts.files` existed and
    // nothing reached it. That is the whole gap the repo-scan picker closes.
    // The list is passed through UNVALIDATED here on purpose — the store
    // validates every entry with the same `sourceDigest` rules any mirrored
    // path already follows (inside the root, `.md`/`.txt`, under the cap)
    // and names each refusal in `refused[]`, which this route forwards. A
    // second copy of those rules here would be a second thing to keep in
    // step, and it would decide refusals the store then decides again.
    const files = Array.isArray(body.files) ? body.files : [];
    const out = await store.refreshFoundationsFromRepo(domain, project, root, {
      files,
      source,
      tokenSource,
      // Forwarded ONLY when the body named one — an absent key must reach the
      // store as absent, so the manifest's own remote stays the default.
      ...(namedRemote ? { remote: namedRemote } : {}),
    });
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'repo_unreachable';
      const status = (reason === 'curator_owned' || reason === 'curator-owned') ? 400
        : REFRESH_REMOTE_STATUS.get(reason) ?? statusForStoreRefusal({ reason });
      return res.status(status).json(withErrorProse({
        ok: false, reason, domain, project, repoRoot: root, ...(out || {}),
      }));
    }
    res.json({
      ok: true, domain, project,
      // The REMOTE arm reports `repoRoot: null` — no folder on this computer
      // was read — and the local arm reports the root it resolved. Taken from
      // the store rather than echoed from the request, so a response can
      // never name a folder that was not the source.
      repoRoot: out.repoRoot ?? (out.source === 'remote' ? null : root),
      // ── WHAT THE REMOTE ARM ANSWERED (v3.63.0) ──────────────────────
      // `remoteChecked` is the fact the view needs to choose between "source
      // not on this computer" and "mirrored from GitHub @ <short sha>", and
      // `remoteError` is a CODE rather than a sentence — the sentence is in
      // `error`, and a code is what a client can branch on. Both are always
      // present, including on the local arm where they read false/null,
      // because an absence is not an answer.
      source: out.source === 'remote' ? 'remote' : 'local',
      remoteChecked: out.remoteChecked === true,
      remoteCommit: out.remoteCommit ?? null,
      remoteError: out.remoteError ?? null,
      remote: out.remote && typeof out.remote === 'object' ? {
        owner: out.remote.owner ?? null,
        repo: out.remote.repo ?? null,
        ref: out.remote.ref ?? null,
        path: out.remote.path ?? null,
      } : null,
      // WHICH FILE THE TOKEN CAME FROM, never the token. Null on the local
      // arm, which needs none — and that difference is worth seeing.
      tokenSource: out.tokenSource ?? null,
      refreshed: Array.isArray(out.refreshed) ? out.refreshed : [],
      unchanged: Array.isArray(out.unchanged) ? out.unchanged : [],
      added: Array.isArray(out.added) ? out.added : [],
      // NEVER DELETED, ONLY REPORTED. A source file that has vanished from the
      // repository leaves its copy in place — the copy is the only remaining
      // record of it — and this list is what says the two have parted.
      missing: Array.isArray(out.missing) ? out.missing : [],
      // EVERY `files` ENTRY THAT DID NOT MAKE IT, with its reason (v3.61.0).
      // Forwarded rather than dropped: a file somebody ticked in the picker
      // and did not get is exactly the fact a projected response loses, and
      // the view renders these un-folded beside the outcome.
      refused: (Array.isArray(out.refused) ? out.refused : []).slice(0, 50).map((r) => ({
        path: r && typeof r.path === 'string' ? r.path.slice(0, 200) : null,
        reason: r && typeof r.reason === 'string' ? r.reason.slice(0, 200) : null,
      })),
      commit: out.commit ?? null,
    });
  } catch (err) {
    console.error('Memory foundations refresh error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/memory/:domain/:project/foundations/source — "Mirror from GitHub
// instead" (v3.65.1)
//
// ONE SOURCE PER PROJECT, RE-CHOSEN. `…/init` makes the ownership decision
// once and refuses to re-make it; this route does not touch ownership at all
// — it stays `repo` — and changes only WHERE the bytes are copied from. The
// gap it closes is measured in the store: `refreshRemoteCore` has always
// PRESERVED `repo.root`, so a mirror born from a folder went on taking the
// local arm on that machine for ever and "this project now lives in GitHub"
// could not be said.
//
// A POST, NOT A PATCH: it fetches blobs and rewrites files. It joins this
// repository's mutating-route census (`test-route-write-guards.js`) for that
// reason, beside `…/init` and `…/refresh`.
//
// NO TOKEN CROSSES THIS ROUTE, and a `token` key is refused BY NAME rather
// than ignored — ignoring it says nothing and invites a second attempt.
// `tokenSource` names WHICH FILE on this computer the credential is read
// from, exactly as on `…/init` and `…/refresh`.
// ═════════════════════════════════════════════════════════════════════════
/**
 * THE BODY THIS ROUTE ACCEPTS, and nothing else.
 *
 * `files` is here because the switch takes the same work list a refresh does:
 * absent means "the documents this mirror already lists", which is the right
 * default for changing a source, and a named list may add one. Exported so
 * the refusal can PRINT it, exactly as `INIT_BODY_FIELDS` is.
 */
export const SOURCE_BODY_FIELDS = new Set(['remote', 'tokenSource', 'files']);

router.post('/:domain/:project/foundations/source', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    if (await refuseMirror(res, domain)) return;
    if (!validProjectName(ws(), project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(body).filter((k) => !SOURCE_BODY_FIELDS.has(k));
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts ${[...SOURCE_BODY_FIELDS].join(', ')}. It was also sent: ${extra.slice(0, 10).join(', ')}.`
          + (extra.includes('token')
            ? ' A GitHub token is NEVER sent here: `tokenSource` names which file on this computer to read it from '
              + '(`config` = the read-only token in Settings, `sync` = Personal Sync’s own).'
            : ''),
      });
    }
    // The STORE validates the remote's grammar and the token source, with the
    // same validators `…/refresh` uses — a second copy here would be a second
    // thing to keep in step, and it would decide refusals the store then
    // decides again.
    const namedRemote = typeof body.remote === 'string' && body.remote.trim()
      ? body.remote.trim().slice(0, 300)
      : (body.remote && typeof body.remote === 'object' && !Array.isArray(body.remote) ? body.remote : null);
    const out = await fstore().setFoundationsSource(domain, project, {
      ...(namedRemote ? { remote: namedRemote } : {}),
      ...(typeof body.tokenSource === 'string' ? { tokenSource: body.tokenSource } : {}),
      ...(Array.isArray(body.files) ? { files: body.files } : {}),
    });
    if (!out || out.ok === false) {
      const reason = (out && out.reason) || 'io';
      // ── ONE REFUSAL THIS ROUTE ANSWERS ITSELF ────────────────────────
      // The shared table maps the store's `ownership-mismatch` to
      // `repo_owned`, 400 — the right word on `PUT …/foundations/:slug`,
      // where the refusal IS "this project is repo-owned", and the wrong one
      // here, where the project is curator-owned or has chosen nothing. 409
      // rather than 400 for the reason `statusForStoreRefusal` already gives
      // it to `repo_unreachable` and `locked`: nothing is malformed, the
      // server's own state is simply not one this request can act on.
      // `ownership` rides along so a client can tell the two apart without
      // parsing prose.
      if (reason === 'ownership-mismatch') {
        return res.status(409).json(withErrorProse({
          ...(out || {}), ok: false, domain, project,
          reason: 'ownership_mismatch', ownership: out.ownership ?? null,
        }));
      }
      // Every refusal the GitHub READ can name keeps the status it has
      // through the other two doors — a rate limit is a 429 whichever one it
      // came through.
      const remoteStatus = REFRESH_REMOTE_STATUS.get(reason);
      if (remoteStatus !== undefined) {
        return res.status(remoteStatus).json(withErrorProse({
          ...(out || {}), ok: false, domain, project, reason: tier0Reason(reason),
        }));
      }
      return tier0Refusal(res, out || { reason: 'io' }, { domain, project });
    }
    res.json({
      ok: true, domain, project,
      // WHERE IT READS FROM NOW, and WHICH FILE the token came from — never
      // the token. Taken from the store rather than echoed from the request,
      // so a response can never name a source that was not used.
      remote: out.remote && typeof out.remote === 'object' ? {
        owner: out.remote.owner ?? null,
        repo: out.remote.repo ?? null,
        ref: out.remote.ref ?? null,
        path: out.remote.path ?? null,
      } : null,
      tokenSource: out.tokenSource ?? null,
      // THE SWITCH ITSELF. `previousRoot` is the folder this mirror used to
      // copy from — already on the wire through `foundations.repo.root`, and
      // named here so the view can say what changed rather than what is.
      rootCleared: out.rootCleared === true,
      previousRoot: typeof out.previousRoot === 'string' ? out.previousRoot : null,
      refreshed: Array.isArray(out.refreshed) ? out.refreshed : [],
      unchanged: Array.isArray(out.unchanged) ? out.unchanged : [],
      added: Array.isArray(out.added) ? out.added : [],
      // NEVER DELETED, ONLY REPORTED — the same rule the refresh keeps.
      missing: Array.isArray(out.missing) ? out.missing : [],
      refused: (Array.isArray(out.refused) ? out.refused : []).slice(0, 50).map((r) => ({
        path: r && typeof r.path === 'string' ? r.path.slice(0, 200) : null,
        reason: r && typeof r.reason === 'string' ? r.reason.slice(0, 200) : null,
      })),
      totalBytes: Number.isInteger(out.totalBytes) ? out.totalBytes : 0,
      budgetBytes: Number.isInteger(out.budgetBytes) ? out.budgetBytes : 0,
      budgetExceeded: out.budgetExceeded === true,
      documentCount: Number.isInteger(out.documentCount) ? out.documentCount : 0,
      commit: out.commit ?? null,
      notes: Array.isArray(out.notes) ? out.notes : [],
    });
  } catch (err) {
    console.error('Memory foundations source error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory/:domain/:project/capture — the honesty meter (v3.63.0)
//
// "Did this project's sessions start with the bootstrap, and did they save
// before they stopped?" (the v3.63.0 design's §D). READ-ONLY and NEVER
// BLOCKS (Decision G): `readUsageLinesUnion`/`summariseSessions`
// (`src/brain/mcp-usage.js`) are pure reads of the local, content-free MCP
// usage log, joined here to ONE project by the `sid`/`project`/`client`
// fields package S's usage log added for exactly this route. Nothing here
// writes — not the log, not the store, not a cache re-hash — so there is no
// failure mode where asking for the meter costs the user anything.
//
// An ABSENT log is `logPresent: false` with zeroed totals and an empty
// `sessions` array, never an error: silence in a rotated-away or
// never-written log is not evidence that no agent ever worked here, and the
// store's own rule — a fact and its absence are never the same value — holds
// here too.
//
// `since` (ISO, default 30 days ago) and `limit` (default 20, max 200) are
// both BEST-EFFORT: an unparseable `since` or an out-of-range `limit` falls
// back to its default rather than 400ing. A malformed query string is not a
// reason to refuse a read that costs nothing to answer, and this route's
// only hard refusals are the ones every sibling route already makes about
// the DOMAIN/PROJECT in the path (invalid name, unknown domain, unknown
// project).
//
// `totals` is computed over EVERY session in the window, BEFORE `limit`
// truncates the `sessions` array below it — the store's own rule
// (`distinctScopeCount`, `savedCopies`) restated for this reading: a count
// taken after a display cap is a cap reported as a measurement, and
// `sessionsTruncated` is how a caller is told the list was cut without
// having to compare lengths itself.
//
// The log's ON-DISK PATH is deliberately never in this envelope — the MCP
// bridge page's own privacy panel (`GET /api/mcp/usage`'s neighbour) is
// where a user reads that, and repeating it here would be a second place
// for that sentence to go stale if the path ever moves.
// ═════════════════════════════════════════════════════════════════════════
/** `since` query param → epoch ms; anything unparseable falls back to 30 days ago. */
const CAPTURE_DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000;
/** `limit` query param bounds — default 20 sessions, never more than 200. */
const CAPTURE_DEFAULT_LIMIT = 20;
const CAPTURE_MAX_LIMIT = 200;

function captureSinceMs(raw) {
  if (typeof raw === 'string' && raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return Date.now() - CAPTURE_DEFAULT_SINCE_MS;
}

function captureLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return CAPTURE_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), CAPTURE_MAX_LIMIT);
}

router.get('/:domain/:project/capture', async (req, res) => {
  try {
    const { domain, project } = req.params;
    if (!await requireDomain(res, domain)) return;
    const store = ws();
    if (!validProjectName(store, project)) {
      return res.status(400).json({
        ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.`,
      });
    }
    // Existence, decided exactly the way the sibling detail route decides it
    // (`handleDetail` below): a NAMED project's own directory must be on
    // disk; the domain's own project always exists (its tree IS the state
    // root), so this can only 404 for a named one that was never created.
    // This is a READ, like the foundations-document GET beside it — no
    // `refuseMirror` here: a Shared Brain mirror's usage history is still
    // real history, and `refuseMirror` (403) is reserved for this router's
    // WRITE routes, none of which this is. `readonly` is not even carried on
    // the envelope, for the same reason the foundations-document read
    // doesn't: this route describes MCP call history, not domain content.
    const state = await readState(store, domain, project, {});
    if (!state.ok) return res.status(statusForStoreRefusal(state)).json(withErrorProse(state));
    if (state.projectExists === false) {
      return res.status(404).json({
        ok: false, reason: 'project_not_found', domain, project,
        error: `"${project}" is not a project in "${domain}".`,
      });
    }

    const sinceMs = captureSinceMs(req.query.since);
    const limit = captureLimit(req.query.limit);

    // THE UNION OF EVERY USAGE LOG THIS MACHINE MAY BE WRITING (v3.66.0),
    // not only the one this process would append to. A checkout's server and
    // the installed `.app`'s bridge write two different files (the v3.64.0
    // measurement); reading one of them made this meter say "no session"
    // about sessions the other had logged. It is also what the menubar
    // widget and the MCP bridge page's per-project reading use, so the three
    // can never disagree about one project's sessions. In a bundle install
    // and in every isolated suite the list is ONE file and nothing changes.
    const { present, records } = await readUsageLinesUnion();
    const summary = summariseSessions(records, { project, since: sinceMs });
    // UNCAPPED totals, THEN the display slice — never the other order.
    const shown = summary.sessions.slice(0, limit).map((s) => ({
      sid: s.sid, client: s.client, startedAt: s.startedAt, endedAt: s.endedAt,
      calls: s.calls, read: s.read, saved: s.saved,
    }));

    // ══ THE CONTRADICTION THIS ROUTE CAN SEE, AND MUST NAME (v3.64.1) ══
    //
    // Reported from production the day v3.64.0 shipped, and reproduced here
    // against the maintainer's own store: step ② said "saved 47 min ago" on
    // the reading directly above, and this meter said "no agent session in
    // the last 30 days" directly below it. BOTH WERE TRUE. The saves came
    // through a bridge process that writes no session line — one started
    // before the version that writes one, or one whose log is not the log
    // this install resolves — so the store has the saves and the usage log
    // has no sessions to attribute them to.
    //
    // The two facts are in THIS handler's hands on the same read: `summary`
    // is the usage log's answer and `state` — already read above, for the
    // existence check, so this costs NO second store call — carries the
    // project's own save clocks. Leaving the user to reconcile them is the
    // app presenting a contradiction and calling it a reading.
    //
    // THE SAVE CLOCK IS `lastWriteAt`, deliberately: it is the same field the
    // working-state strip's own cell is derived from, so the note cannot name
    // a save the reading beside it does not show. `writtenAt` is the AGENT'S
    // declared clock and can sit outside the window while the file it wrote
    // landed inside it — a note that disagreed with the figure it is
    // explaining would be worse than no note.
    const scopeRows = Array.isArray(state.scopes) ? state.scopes : [];
    let newestSaveMs = null;
    for (const row of scopeRows) {
      const t = row && typeof row.lastWriteAt === 'string' ? Date.parse(row.lastWriteAt) : NaN;
      if (Number.isFinite(t) && (newestSaveMs === null || t > newestSaveMs)) newestSaveMs = t;
    }
    // SAVES IN THE WINDOW, NO SESSIONS IN IT. Not "no sessions" alone: an
    // honest zero — nobody worked on this project this month — is exactly the
    // reading this meter exists to report, and explaining it away would be
    // the app apologising for a true answer. The clause fires only when the
    // store can point at a save the log cannot account for — which requires
    // a log to exist at all (`present`): with no log on this machine, zero
    // sessions is the `!present` arm's own honest limit, not a bridge that
    // logged nothing, and firing this note there would blame a bridge that
    // was never asked.
    const noSessionsButSaves = present === true && summary.totals.sessions === 0
      && newestSaveMs !== null && newestSaveMs >= sinceMs;

    // ONE note, naming whichever honest limit applies — never both, because
    // an absent log has no lines to be legacy about.
    //
    // THE CONTRADICTION OUTRANKS THE TWO LIMIT NOTES, and the ranking is not
    // arbitrary: those two disclose why a figure is what it is, while this
    // one reconciles two readings the user is looking at AND names a remedy.
    // Nothing is lost by the precedence — `logPresent` is on this envelope
    // and the reading above prints it in words, and `totals.legacyLines` is
    // on it too and the view prints that line whenever this note is silent
    // about it.
    let note = null;
    if (noSessionsButSaves) {
      note = 'Saves in this window arrived through a bridge that logged no sessions — '
        + 'restart the app that launched it (usually Claude Desktop)';
    } else if (!present) {
      note = 'no usage log yet — the meter starts counting with the first bridge session on v3.63.0';
    } else if (summary.totals.legacyLines > 0) {
      const n = summary.totals.legacyLines;
      note = `${n} line${n === 1 ? '' : 's'} predate session ids and are not counted`;
    }

    res.json({
      ok: true,
      domain,
      project,
      since: new Date(sinceMs).toISOString(),
      logPresent: present === true,
      lineCeiling: MAX_LINE_BYTES,
      lineCeilingLabel: MAX_LINE_BYTES_LABEL,
      totals: summary.totals,
      sessions: shown,
      sessionsShown: shown.length,
      sessionsTruncated: summary.sessions.length > shown.length,
      // THE CLOCK THE NOTE IS MADE OF, carried so a view never has to derive
      // it a second time and so a suite can assert the reason rather than the
      // sentence. `null` when nothing in this project has ever been saved.
      newestSaveAt: newestSaveMs === null ? null : new Date(newestSaveMs).toISOString(),
      noSessionsButSaves,
      note,
    });
  } catch (err) {
    console.error('Memory capture read error:', err);
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

    // ── stateBudgetBytes (v3.66.0): THE CEILING A HANDOFF IS TRIMMED AT ──
    //
    // `scopes[].bytes` is each (scope, machine) pair's `current.md` size; this
    // is the number the store renders a save against before writing it
    // (MAX_STATE_BYTES, 48 KB), sent so a view can draw a handoff's size
    // against its budget without hard-coding a second copy of the constant.
    // It is a CEILING, not a target a file can overrun: an over-budget save is
    // trimmed and disclosed in its notes, never refused, so `bytes` cannot
    // exceed it and nothing here should ever be drawn as an over-run.
    // Read off the store actually in use, falling back to the real module's
    // export for a test double that does not carry the constant. On `open` as
    // well as the envelope, because `open` is byte-for-byte what the scoped
    // request answers and that request carries it.
    const stateBudgetBytes = Number.isInteger(store.MAX_STATE_BYTES)
      ? store.MAX_STATE_BYTES : workingState.MAX_STATE_BYTES;

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
            domain, project, readonly, foundations, stateBudgetBytes,
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
      stateBudgetBytes,
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
    || reason === 'unknown_foundation'
    // THE STORE'S OWN SPELLING, added in v3.61.0. `readFoundation` and
    // `removeFoundation` both answer `not-found`, which fell through this
    // table to the default 400 — so a document that is simply not there
    // answered "bad request". Every guard on that route had been driven
    // against a stub using the ROUTER's spelling, which is why nothing saw
    // it until the real store was driven through the same handler.
    || reason === 'not-found') return 404;
  // ── TIER 0's WRITE REFUSALS (v3.61.0), BOTH SPELLINGS, EXPLICIT ───────
  // Each of these is a 400 by the default arm below already. They are named
  // anyway, because the default is "an unrecognised refusal is input, not a
  // server error" — a catch-all whose correctness for these reasons would be
  // a coincidence. Named, they are a decision; unnamed, they are luck.
  if (reason === 'invalid-ownership' || reason === 'invalid_ownership'
    || reason === 'root-not-allowed' || reason === 'root_not_allowed'
    || reason === 'ownership-set' || reason === 'ownership_set'
    || reason === 'manifest-unreadable' || reason === 'manifest_unreadable'
    || reason === 'invalid-root' || reason === 'invalid_root'
    || reason === 'ownership-mismatch' || reason === 'repo_owned'
    || reason === 'too-many-documents' || reason === 'too_many_documents'
    // v3.62.0, both spellings, for the same reason the pairs above are here:
    // `setFoundationReadFirst` answers `no-manifest` and `unsafe-path`
    // directly, and while both are 400 by the default arm, the default's
    // correctness for them would be a coincidence rather than a decision.
    //
    // STATED HONESTLY: these two lines are the only ones in this function
    // that NO behavioural assertion can pin, because deleting them changes no
    // answer — the default arm produces the same 400. A mutation proving that
    // came back green, deliberately, and it is recorded rather than hidden
    // behind an assertion that would have been measuring the default. What
    // IS pinned is the WIRE SPELLING, one table up: dropping `no-manifest`
    // from TIER0_WIRE_REASON makes the PATCH answer the store's hyphenated
    // word where every other tier-0 route answers this router's underscored
    // one, and test-next-memory-routes-live.js §2 reds on it.
    || reason === 'no-manifest' || reason === 'no_manifest'
    || reason === 'unsafe-path' || reason === 'unsafe_path'
    || reason === 'would-replace-larger-foundation') return 400;
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


export default router;
