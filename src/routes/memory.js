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
import { stat } from 'fs/promises';
import { listDomains, isDomainReadonly } from '../brain/files.js';
import * as workingState from '../brain/working-state.js';
import { isDomainActive, conflictResponse } from '../brain/write-registry.js';

const router = Router();

/**
 * Cap on the index listing. Not a store constant — until v3.48.0 the store
 * had no notion of "how many projects" — so it lives here with the rest of
 * this route's own bounds, and is reported through `truncated` rather than
 * hidden. When the store supplies its own cap (MAX_PROJECTS_TOTAL) the
 * store's answer is already capped and this is a second, equal ceiling.
 */
export const MAX_PROJECTS = 200;

/**
 * Project names this router refuses to CREATE or RENAME to.
 *
 *   · `projects` — collides with the `/:domain/projects` literal above.
 *   · `project.md` / `journal.jsonl` — the store's own reserved filenames;
 *     a directory with either name would sit exactly where those files go.
 *
 * A name outside this set is still checked by `isSafeSegment`, which is the
 * store's rule and is imported rather than restated (a second copy of a
 * validation rule is a second thing that can drift — this repo's most
 * reliably repeated defect).
 */
export const RESERVED_PROJECT_NAMES = new Set(['projects', 'project.md', 'journal.jsonl']);

// ═════════════════════════════════════════════════════════════════════════
// THE STORE ADAPTER
//
// This router is written against the v3.48.0 store API (listProjects,
// listAllProjects, createProject, renameProject, deleteProject,
// readProjectBrief, saveProjectBrief(domain, project, text, opts), and the
// project-aware forms of listWorkingScopes / readWorkingState).
//
// It also keeps working against the PRE-v3.48.0 store, where a "project" was
// a domain and there was exactly one per domain. That is not politeness
// toward an old version: it is what lets this file be built, reviewed and
// TESTED against the store as it exists today, and it degrades in the only
// safe direction — a legacy store reports one default project per domain and
// refuses the tier-1 writes with a named reason, rather than silently
// writing structured sections over a hand-written brief.
//
// Capability is detected ONCE per call from the presence of `listProjects`,
// not from `Function.length` — a default parameter changes an arity without
// changing a contract, and a signature probe that is wrong reads WRONG DATA
// rather than throwing.
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

/** Does this store know about projects inside a domain? */
function hasProjects(store) { return typeof store.listProjects === 'function'; }

/** The default project of a domain: the legacy tree, read under the domain's own name. */
function defaultProjectOf(domain) { return domain; }

/**
 * Does this project have a standing brief, and when did it last change?
 *
 * Goes through `resolveInsideState`, the store's single path chokepoint, and
 * never builds a path itself. A `project.md` that is a directory, a dangling
 * symlink, or outside the state root all resolve to "no brief" rather than
 * to a throw.
 *
 * Cheap on purpose: the index needs to know a brief EXISTS, not what it
 * says. Reading 32 KB of brief per project to render a one-line row would be
 * the mistake `GET /api/wiki/:domain` makes (14 MB to answer "what pages
 * exist"). Used ONLY on the legacy path; the v3.48.0 store reports
 * `hasBrief`/`briefUpdatedAt` from its own walk.
 */
async function briefStat(store, domain) {
  const abs = store.resolveInsideState(domain, store.BRIEF_FILENAME);
  if (!abs) return null;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    return { updatedAt: st.mtime.toISOString(), bytes: st.size };
  } catch {
    return null;                                   // no brief — the normal case
  }
}

/** One index row, built from a legacy (one-project-per-domain) store. */
async function legacyRow(store, domain) {
  const idx = await store.listWorkingScopes(domain);
  const scopes = idx.ok ? idx.scopes : [];
  const newest = scopes.length ? scopes[0] : null;
  const brief = await briefStat(store, domain);
  const distinctScopes = Number.isInteger(idx.distinctScopeCount)
    ? idx.distinctScopeCount
    : new Set(scopes.map((r) => r.scope).filter(Boolean)).size;
  return {
    domain,
    project: defaultProjectOf(domain),
    isLegacyDefault: true,
    hasBrief: brief !== null,
    briefUpdatedAt: brief ? brief.updatedAt : null,
    // A legacy brief predates provenance entirely, so the AUTHORITY is
    // unknown rather than assumed. `null` is that; 'owner' would be a guess
    // wearing the store's vocabulary.
    briefAuthoredBy: null,
    scopeCount: distinctScopes,
    distinctScopeCount: distinctScopes,
    savedCopies: idx.ok ? idx.total : 0,
    scopesTruncated: idx.ok ? idx.truncated : false,
    unlistedEntries: idx.ok ? (idx.unlistedEntries || 0) : 0,
    unlistedReason: (idx.ok && idx.unlistedReason) ? idx.unlistedReason : null,
    layoutWarning: null,
    lastWriteAt: newest ? newest.lastWriteAt : null,
    ageSeconds: newest ? newest.ageSeconds : null,
    writtenAt: newest ? (newest.writtenAt ?? null) : null,
    writtenAgeSeconds: newest ? (newest.writtenAgeSeconds ?? null) : null,
    headline: newest ? newest.headline : null,
    harness: newest ? (newest.harness ?? null) : null,
    lastSaveKind: newest ? (newest.lastSaveKind ?? null) : null,
    lastSaveNotes: newest && Array.isArray(newest.lastSaveNotes) ? newest.lastSaveNotes : [],
    newestScope: newest ? newest.scope : null,
    newestMachine: newest ? newest.machine : null,
    harnessShared: scopes.some((s) => s.harnessShared === true),
    harnessSharedScopes: scopes.filter((s) => s.harnessShared === true)
      .slice(0, 10)
      .map((s) => ({ scope: s.scope, machine: s.machine, harnesses: s.harnesses || [] })),
    harnessScanned: scopes.length,
  };
}

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
    isLegacyDefault: r.isLegacyDefault === true,
    hasBrief: r.hasBrief === true,
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
    lastSaveKind: r.lastSaveKind ?? null,
    lastSaveNotes: Array.isArray(r.lastSaveNotes) ? r.lastSaveNotes : [],
    newestScope: r.newestScope ?? null,
    newestMachine: r.newestMachine ?? null,
    harnessShared: r.harnessShared === true,
    harnessSharedScopes: Array.isArray(r.harnessSharedScopes) ? r.harnessSharedScopes : [],
    harnessScanned: Number.isInteger(r.harnessScanned) ? r.harnessScanned : 0,
  };
}

/** Every project in one domain, newest first. */
async function projectsIn(store, domain) {
  if (hasProjects(store)) {
    const out = await store.listProjects(domain);
    const rows = (out && Array.isArray(out.projects) ? out.projects : []).map((r) => projectRow(domain, r));
    return { projects: rows, truncated: !!(out && out.truncated) };
  }
  return { projects: [projectRow(domain, await legacyRow(store, domain))], truncated: false };
}

/** Every project in every domain, newest first, capped. */
async function allProjects(store) {
  if (typeof store.listAllProjects === 'function') {
    const out = await store.listAllProjects();
    const rows = (out && Array.isArray(out.projects) ? out.projects : [])
      .map((r) => projectRow(r.domain, r));
    return {
      projects: rows.slice(0, MAX_PROJECTS),
      total: rows.length,
      truncated: rows.length > MAX_PROJECTS || !!(out && out.truncated),
    };
  }
  const domains = await listDomains();
  const shown = domains.slice(0, MAX_PROJECTS);
  const rows = [];
  for (const domain of shown) rows.push(projectRow(domain, await legacyRow(store, domain)));
  return { projects: rows, total: domains.length, truncated: domains.length > shown.length };
}

/**
 * One project's state. `opts` is the store's own read options
 * (`scope`, `machine`, `journalLimit`), passed through un-reshaped.
 *
 * THE SIGNATURE ASSUMPTION IS NAMED HERE, once. The v3.48.0 contract writes
 * the project-aware read as `readWorkingState(domain, project, …)`; this
 * adapter calls `(domain, project, opts)` and the legacy store as
 * `(domain, opts)`. If the store lands on a different shape, THIS function
 * is the only thing that changes.
 */
async function readState(store, domain, project, opts) {
  if (hasProjects(store)) return store.readWorkingState(domain, project, opts);
  if (project !== defaultProjectOf(domain)) {
    return {
      ok: false,
      reason: 'project_not_found',
      message: `"${project}" is not a project in "${domain}".`,
    };
  }
  return store.readWorkingState(domain, opts);
}

/**
 * Resolve `scope=latest` to a real scope name.
 *
 * Done here rather than left to the store when the store cannot do it, so
 * the two callers of this router (the view and anything scripted) get one
 * answer. `latest` is the NEWEST-WRITTEN pair's scope, which is `scopes[0]`
 * — the store sorts newest-first and every consumer already relies on it.
 * Returns the input unchanged when it is not the literal `latest`, and null
 * when there is nothing saved at all.
 */
async function resolveScopeName(store, domain, project, scope) {
  if (typeof scope !== 'string' || scope.toLowerCase() !== 'latest') return scope;
  if (typeof store.resolveScope === 'function') {
    const r = await store.resolveScope(domain, project, 'latest');
    // The store may answer with a bare name or with a small object; both are
    // accepted, and anything else degrades to the index walk below rather
    // than to a throw.
    if (typeof r === 'string') return r;
    if (r && typeof r.scope === 'string') return r.scope;
  }
  const idx = hasProjects(store)
    ? await store.listWorkingScopes(domain, project)
    : await store.listWorkingScopes(domain);
  const scopes = idx && idx.ok && Array.isArray(idx.scopes) ? idx.scopes : [];
  return scopes.length ? scopes[0].scope : null;
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

/**
 * The store must be new enough to have the tier-1 write functions.
 *
 * 501 rather than 500: nothing failed, the capability is absent. Named so a
 * caller sees WHICH function is missing instead of a stack trace, and so the
 * legacy path can never fall through into the pre-v3.48.0 `saveProjectBrief`,
 * which takes STRUCTURED sections and would drop every hand-written heading
 * a real brief carries.
 */
function requireProjectWrites(res, store, fnName) {
  // `hasProjects` FIRST, and it is not belt-and-braces. The pre-v3.48.0 store
  // already exports a `saveProjectBrief` — with a DIFFERENT signature — so a
  // bare `typeof store[fnName] === 'function'` would wave the legacy store
  // through and then call `saveProjectBrief(domain, project, text, opts)`
  // against `saveProjectBrief(project, input)`: the domain would be read as
  // the project, the project string as the input object, every section would
  // come back undefined, and the store would render an EMPTY brief over the
  // user's own. A capability probe that can be satisfied by a same-named
  // function with a different contract is not a capability probe.
  if (hasProjects(store) && typeof store[fnName] === 'function') return true;
  res.status(501).json({
    ok: false,
    reason: 'store_lacks_projects',
    error: `This server's working-state store has no ${fnName}(). Projects inside a domain need `
      + 'v3.48.0 or later of src/brain/working-state.js.',
  });
  return false;
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/memory — the index, one row per PROJECT
// ═════════════════════════════════════════════════════════════════════════
/**
 * "Which of my projects have agent memory, and how fresh is it?"
 *
 * Returns a row for every project in every domain — including a domain with
 * NOTHING saved, whose default project is reported with `scopeCount: 0`.
 * That is a real, useful answer: it is what a user sees before their first
 * agent session, and hiding it would make the view look broken rather than
 * empty.
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
    const { projects, total, truncated } = await allProjects(store);
    res.json({ ok: true, projects, total, truncated });
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
    const { projects, truncated } = await projectsIn(store, domain);
    const readonly = await isDomainReadonly(domain);
    res.json({
      ok: true,
      domain,
      projects,
      total: projects.length,
      truncated,
      readonly,
      // Whether a project here can be created, renamed or deleted AT ALL —
      // one field answering the question the view actually has, rather than
      // two the view would have to combine. It folds in BOTH refusals:
      //
      //   · the server's capability (an older working-state store has no
      //     projects API, and the write routes answer 501), and
      //   · this domain being a read-only Shared Brain mirror (403).
      //
      // Reporting the capability alone would render a full set of controls
      // on a mirror whose every button answers 403 — a control whose only
      // outcome is a refusal is worse than no control. And it is a fact
      // about the server that ANSWERED, never a version string used as a
      // proxy for one.
      canWrite: hasProjects(store) && typeof store.createProject === 'function' && !readonly,
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
    if (!requireProjectWrites(res, store, 'createProject')) return;

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

    const out = await store.createProject(domain, project, brief ? { brief } : {});
    if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(out);
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
      if (!requireProjectWrites(res, store, 'renameProject')) return;
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
      if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(out);
      current = next;
    }

    if (wantsBrief) {
      if (!requireProjectWrites(res, store, 'saveProjectBrief')) return;
      const tooBig = briefTooBig(store, body.brief);
      if (tooBig) return res.status(400).json({ ...tooBig, renamedTo: wantsRename ? current : undefined });
      const out = await saveBrief(store, domain, current, body.brief);
      if (out && out.ok === false) {
        return res.status(statusForStoreRefusal(out)).json({ ...out, renamedTo: wantsRename ? current : undefined });
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
    if (!requireProjectWrites(res, store, 'deleteProject')) return;
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
    if (out && out.ok === false) return res.status(statusForStoreRefusal(out)).json(out);
    res.json({ ok: true, domain, project, deleted: true });
  } catch (err) {
    console.error('Memory delete-project error:', err);
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

    const opts = {};
    if (typeof req.query.scope === 'string' && req.query.scope) {
      const resolved = await resolveScopeName(store, domain, project, req.query.scope);
      // `latest` against a project with nothing saved resolves to nothing.
      // The scope-less read is the honest answer to that — it says what
      // exists, which is nothing — rather than a 400 about a scope the
      // caller never named.
      if (resolved) opts.scope = resolved;
    }
    if (typeof req.query.machine === 'string' && req.query.machine) opts.machine = req.query.machine;
    if (req.query.journalLimit != null && req.query.journalLimit !== '') {
      const n = Number(req.query.journalLimit);
      if (Number.isFinite(n)) opts.journalLimit = n;
    }

    const state = await readState(store, domain, project, opts);
    if (!state.ok) {
      return res.status(state.reason === 'project_not_found' ? 404 : 400)
        .json(deprecated ? { ...state, ...deprecationNote(domain, project) } : state);
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
    res.json({
      ...withCounts,
      domain,
      project,
      readonly,
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
 * Save a brief through whichever writer the store offers.
 *
 * The v3.48.0 writer takes the WHOLE markdown text, which is the shape that
 * matters: the pre-v3.48.0 `saveProjectBrief(project, {brief, decisions, …})`
 * takes STRUCTURED sections and re-renders the document from them, so it
 * DROPS every hand-written heading a real brief carries (the maintainer's
 * own has "Roadmap" and "How I want you to work"). This adapter therefore
 * refuses to fall back to it — `requireProjectWrites` has already returned
 * 501 on a store that only has the old one, because `hasProjects` is false
 * there and the caller checks it first.
 */
async function saveBrief(store, domain, project, text) {
  return store.saveProjectBrief(domain, project, text, {
    authoredBy: { kind: 'human' },
  });
}

/**
 * Map a store refusal to an HTTP status.
 *
 * Named reasons only. A refusal this router does not recognise is a 400
 * rather than a 500: the store refuses INPUT, and calling an unrecognised
 * refusal a server error would tell the user to retry something that will
 * never succeed.
 */
function statusForStoreRefusal(out) {
  const reason = out && typeof out.reason === 'string' ? out.reason : '';
  if (reason === 'unknown-project' || reason === 'project_not_found') return 404;
  if (reason === 'readonly') return 403;
  if (reason === 'exists' || reason === 'project_exists') return 409;
  return 400;
}

export default router;
