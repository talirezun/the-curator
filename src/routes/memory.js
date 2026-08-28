/**
 * src/routes/memory.js — Agent memory, READ ONLY.
 *
 * The HTTP face of `src/brain/working-state.js` for the /next shell's
 * "Agent memory" view. Two endpoints, both GET, neither of which writes a
 * byte.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO WRITE ENDPOINT, AND WHY THAT IS NOT AN OVERSIGHT
 * ─────────────────────────────────────────────────────────────────────────
 * The working-state store has exactly one writer: an agent, through the MCP
 * tools (mcp/tools/working-state.js -> saveWorkingState / saveProjectBrief).
 * That single-writer property is what makes the per-machine layout safe (see
 * the LAYOUT block in working-state.js: two machines never touch the same
 * file, so `git pull -X theirs` has no conflicting hunk to resolve away).
 *
 * Adding a browser write path would make the app a SECOND writer to the same
 * files — this repo's named CRITICAL shape (v3.2.0: two hand-maintained
 * copies of a guard; v3.0.14/v2.5.2: one write chokepoint or none). It would
 * also break the honesty of the surface: the whole point of the handoff is
 * that it records what an AGENT observed, with the harness/model provenance
 * to match. A human edit through this route would arrive wearing the last
 * agent's provenance line.
 *
 * If a human wants to edit the brief, `state/project.md` is plain markdown in
 * their own folder — Obsidian opens it. That is the deliberate answer, not a
 * missing feature.
 *
 * Consequences of being read-only, all deliberate:
 *   · No `guardConcurrent`. That wrapper exists to refuse a WRITE while
 *     another write is running; there is nothing here to refuse.
 *   · No write-registry registration, for the same reason.
 *   · Reads are allowed on read-only `shared-*` Shared Brain mirrors, exactly
 *     as GET /api/wiki/:domain/page is — only writes are refused elsewhere in
 *     the app. `readonly` is echoed so the view can say so out loud, because
 *     inside a mirror the state content can have been written by another
 *     PERSON (see working-state.js's THREAT MODEL block).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BOUNDS
 * ─────────────────────────────────────────────────────────────────────────
 * Every byte returned here is already capped at the source: readWorkingState
 * reads current.md through readCapped(MAX_STATE_BYTES = 48 KB), the brief
 * through readCapped(MAX_BRIEF_BYTES = 32 KB), and the journal through
 * readTail(MAX_JOURNAL_TAIL_BYTES) with an entry cap of MAX_JOURNAL_ENTRIES.
 * listWorkingScopes caps at MAX_INDEX_ENTRIES pairs. This route adds ONE cap
 * of its own — MAX_PROJECTS on the index — and otherwise does not re-cap
 * anything, because a second set of limits maintained here would drift from
 * the store's own.
 *
 * The index's cost is honest about itself: listWorkingScopes stats every
 * (scope, machine) pair in a project and reads a 16 KB journal tail per pair
 * to recover the headline. It is deliberately reused rather than replaced
 * with a cheaper hand-rolled walker here — a second inventory implementation
 * would silently disagree with the one the detail read uses, which is exactly
 * the class of bug wiki-read.js's `listMd` import exists to prevent.
 */

import { Router } from 'express';
import { stat } from 'fs/promises';
import { listDomains, isDomainReadonly } from '../brain/files.js';
import {
  readWorkingState,
  listWorkingScopes,
  resolveInsideState,
  BRIEF_FILENAME,
} from '../brain/working-state.js';

const router = Router();

/**
 * Cap on the index listing. Not a store constant — the store has no notion
 * of "how many projects" — so it lives here, with the rest of this route's
 * own bounds, and is reported through `truncated` rather than hidden.
 */
export const MAX_PROJECTS = 200;

/**
 * Does this project have a standing brief, and when did it last change?
 *
 * Goes through `resolveInsideState`, the store's single path chokepoint, and
 * never builds a path itself — the same rule the store enforces on its own
 * internals. A `state/project.md` that is a directory, a dangling symlink, or
 * outside the state root all resolve to "no brief" rather than to a throw.
 *
 * Cheap on purpose: the index needs to know a brief EXISTS, not what it says.
 * Reading 32 KB of brief per project to render a one-line row would be the
 * mistake `GET /api/wiki/:domain` makes (14 MB to answer "what pages exist").
 */
async function briefStat(project) {
  const abs = resolveInsideState(project, BRIEF_FILENAME);
  if (!abs) return null;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    return { updatedAt: st.mtime.toISOString(), bytes: st.size };
  } catch {
    return null;                                   // no brief — the normal case
  }
}

/**
 * GET /api/memory
 *
 * "Which of my projects have agent memory, and how fresh is it?"
 *
 * Returns a row for EVERY domain, not only the ones with state. A project
 * with nothing saved is a real, useful answer — it is what a user sees before
 * their first agent session, and hiding it would make the view look broken
 * rather than empty. `scopeCount: 0` is that state, said plainly.
 *
 * `newestScope`/`newestMachine` exist so the view can open the freshest
 * handoff in ONE request instead of a round-trip to discover the scope and a
 * second one to read it.
 *
 * Response:
 *   { ok, projects: [{ project, hasBrief, briefUpdatedAt, scopeCount,
 *                      savedCopies, scopesTruncated, lastWriteAt, ageSeconds,
 *                      headline, newestScope, newestMachine }],
 *     total, truncated }
 *
 * `scopeCount` counts DISTINCT SCOPES (work-streams); `savedCopies` counts
 * (scope, machine) pairs. See the comment at the derivation for why those are
 * two facts and not one.
 */
router.get('/', async (_req, res) => {
  try {
    const domains = await listDomains();
    const shown = domains.slice(0, MAX_PROJECTS);

    const projects = [];
    for (const project of shown) {
      const idx = await listWorkingScopes(project);
      const scopes = idx.ok ? idx.scopes : [];
      // listWorkingScopes sorts newest-first, so [0] is the freshest pair.
      const newest = scopes.length ? scopes[0] : null;
      const brief = await briefStat(project);

      // TWO DIFFERENT COUNTS, kept apart on purpose.
      //
      // `listWorkingScopes` returns one row per (scope, machine) PAIR, and
      // its `total` counts pairs. Reporting that as "scopes" is wrong and
      // gets worse with every machine: one work-stream synced from a laptop
      // and a build box renders as "2 scopes" when there is one. So
      // `scopeCount` counts DISTINCT SCOPES — the thing a person means by
      // "how many work-streams do I have here" — and `savedCopies` keeps the
      // pair count, which is what the index cap and `scopesTruncated`
      // actually apply to. Collapsing them would make the truncation note
      // compare a scope count against a pair cap.
      const distinctScopes = new Set(scopes.map((r) => r.scope).filter(Boolean)).size;

      projects.push({
        project,
        hasBrief: brief !== null,
        briefUpdatedAt: brief ? brief.updatedAt : null,
        scopeCount: distinctScopes,
        savedCopies: idx.ok ? idx.total : 0,
        scopesTruncated: idx.ok ? idx.truncated : false,
        // A fact and its ABSENCE stay distinguishable: null means "nothing
        // has ever been saved", never "saved at the epoch" or "0 seconds ago".
        lastWriteAt: newest ? newest.lastWriteAt : null,
        ageSeconds: newest ? newest.ageSeconds : null,
        headline: newest ? newest.headline : null,
        newestScope: newest ? newest.scope : null,
        newestMachine: newest ? newest.machine : null,
      });
    }

    res.json({
      ok: true,
      projects,
      total: domains.length,
      truncated: domains.length > shown.length,
    });
  } catch (err) {
    console.error('Memory index error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/memory/:project?scope=&machine=&journalLimit=
 *
 * The store's `readWorkingState` result, unmodified but for an added
 * `readonly` flag. Shape is deliberately 1:1 with the store rather than
 * reshaped here: a second shape maintained in this file would drift from the
 * one the MCP tools return, and then the app and the agent would describe the
 * same file differently.
 *
 * Without `scope`: the brief plus the scope index ("what exists?").
 * With `scope`:    the brief plus that scope's current.md and journal. With
 *                  no `machine`, the most recently written machine wins —
 *                  that is what makes cross-machine handoff work, and the
 *                  response says which machine it chose (`machine`,
 *                  `machineIsThisMachine`) so the view never has to guess.
 *
 * A project that is not a real domain is a 404, resolved against
 * `listDomains()` — the same gate every other read route in this app uses.
 * That check runs BEFORE any filesystem access, so an unknown name never
 * reaches path resolution at all.
 *
 * An invalid `scope`/`machine` comes back from the store as `ok: false` with
 * a reason, and is surfaced as a 400. `journalLimit` is passed through
 * un-clamped ON PURPOSE: the store clamps it to [1, MAX_JOURNAL_ENTRIES]
 * itself, and clamping it a second time here is the two-copies-of-a-bound
 * shape. A non-numeric value is simply not passed, so the store's default
 * applies.
 */
router.get('/:project', async (req, res) => {
  try {
    const { project } = req.params;

    const domains = await listDomains();
    if (!domains.includes(project)) {
      return res.status(404).json({ ok: false, error: `Unknown domain: ${project}` });
    }

    const opts = {};
    if (typeof req.query.scope === 'string' && req.query.scope) opts.scope = req.query.scope;
    if (typeof req.query.machine === 'string' && req.query.machine) opts.machine = req.query.machine;
    if (req.query.journalLimit != null && req.query.journalLimit !== '') {
      const n = Number(req.query.journalLimit);
      if (Number.isFinite(n)) opts.journalLimit = n;
    }

    const state = await readWorkingState(project, opts);
    if (!state.ok) {
      return res.status(400).json(state);
    }

    const readonly = await isDomainReadonly(project);
    res.json({ ...state, readonly });
  } catch (err) {
    console.error('Memory read error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
