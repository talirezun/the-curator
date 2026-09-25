/**
 * `my-curator context` — the bootstrap, to stdout.
 *
 * Calls `getProjectContext()` — the SAME store function `get_project_context`
 * calls, with the same `include` / `slugs` / `max_bytes` options — and writes
 * the result out. `--json` emits the STORE'S ENVELOPE VERBATIM
 * (`JSON.stringify` of what the store returned, no reshaping); the default is
 * a readable Markdown rendering of the same facts, shaped for a context
 * injection.
 *
 * ── WHY `--json` IS THE STORE'S ENVELOPE AND NOT THE MCP TOOL'S ────────────
 * `getProjectContextHandler` in `mcp/tools/working-state.js` wraps the same
 * store reply for a MODEL: it frames the brief with an authority note, adds
 * `content_is_data`, `resolved_by` and a prose `report`, and bounds the whole
 * thing against the 400 KB MCP response guard. Those are properties of the
 * MCP transport and of a model reading it, not facts about the project. A
 * programmatic caller of this command wants the facts, so it gets the store's
 * own envelope — and `scripts/test-cli-curator.js` §2 pins that the two
 * clients agree field for field on every fact the handler forwards untouched
 * (`foundations`, `current`, `journal.entries`, `seen`, `scope`), which is the
 * claim that actually matters: one store, two clients, one answer.
 *
 * ── IT IS A READ. IT WRITES NOTHING ────────────────────────────────────────
 * Including the MCP usage log. A CLI read is not an MCP call, and a line here
 * would make the honesty meter count a session that never opened a bridge —
 * inflating exactly the reading the meter exists to make honest. §5 of the
 * suite fingerprints the log across a run.
 */
import {
  EXIT_OK, EXIT_REFUSED, EXIT_USAGE, out, note, refuse,
  flagStr, flagBool, resolveProjectForCli, renderResolveRefusal, renderStoreRefusal,
} from './resolve.js';

export const CONTEXT_USAGE =
  'my-curator context [--project <domain/project|project>] [--domain <d>] [--scope <name>]\n'
  + '                   [--json] [--budget <bytes>] [--include index|changed|all]\n'
  + '                   [--slugs a.md,b.md] [--for-hook] [--harness <id>]';

/** `--slugs a,b` or repeated `--slugs a --slugs b`, both to one list. */
function parseSlugs(flags) {
  const raw = flags.slugs;
  if (raw === undefined || raw === true) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  const items = [];
  for (const entry of arr) {
    if (typeof entry !== 'string') continue;
    for (const s of entry.split(',')) {
      const t = s.trim();
      if (t) items.push(t);
    }
  }
  return items.length ? items : undefined;
}

// ── MOVED, NOT CHANGED (v3.67.0) ─────────────────────────────────────────
// The rendering lives in src/brain/context-markdown.js now, so the app's
// session-start preview route can measure the hook's exact bytes without a
// route importing src/cli/** (the structural guarantee test-cli-curator.js
// pins). Re-exported here under the SAME names: `hook.js` and the suites that
// import them from this file are untouched.
import {
  classifyContextAuthority, renderAuthority, renderFramedContextMarkdown, renderContextMarkdown,
} from '../brain/context-markdown.js';

export { classifyContextAuthority, renderAuthority, renderFramedContextMarkdown, renderContextMarkdown };

export async function runContext(parsed) {
  const { flags } = parsed;
  if (flagBool(flags, 'help')) { out(CONTEXT_USAGE); return EXIT_OK; }

  const resolved = await resolveProjectForCli({
    project: flagStr(flags, 'project'),
    domain: flagStr(flags, 'domain'),
    cwd: flagStr(flags, 'cwd') || process.cwd(),
  });
  if (!resolved.ok) return refuse(renderResolveRefusal(resolved), EXIT_USAGE);

  const budget = flagStr(flags, 'budget') || flagStr(flags, 'maxBytes');
  const include = flagStr(flags, 'include');
  if (include && !['index', 'changed', 'all'].includes(include)) {
    return refuse(`--include must be one of index, changed, all — got "${include}".`, EXIT_USAGE);
  }

  const { getProjectContext } = await import('../brain/working-state.js');
  const ctx = await getProjectContext(resolved.domain, resolved.project, {
    scope: flagStr(flags, 'scope') || undefined,
    include: include || undefined,
    slugs: parseSlugs(flags),
    maxBytes: budget !== null ? Number(budget) : undefined,
  });
  if (!ctx.ok) return refuse(renderStoreRefusal(ctx), EXIT_REFUSED);

  if (flagBool(flags, 'forHook')) {
    // The harness's session-start envelope, and nothing else. The shape is the
    // adapter's — a harness whose envelope is unverified gets NOTHING rather
    // than a guess at another harness's shape (Decision C's corollary).
    const { sessionStartEnvelope, harnessEntry, ownSaveScope } = await import('./hook.js');
    const id = flagStr(flags, 'harness');
    const entry = harnessEntry(id);
    if (!entry) {
      note(`--for-hook needs a --harness this build knows. Unknown: "${id || '(none)'}". Nothing was emitted.`);
      return EXIT_OK;
    }
    // The same line the hook injects: whose work-stream this is, and where
    // this tool's saves go (v3.76.0).
    const env = sessionStartEnvelope(entry, await renderFramedContextMarkdown(ctx, { saveTarget: await ownSaveScope(entry, flags) }));
    if (env === null) {
      note(`No session-start envelope is shipped for "${entry.id}": ${entry.sessionStart?.withheld || 'unverified'}. Nothing was emitted.`);
      return EXIT_OK;
    }
    out(JSON.stringify(env));
    return EXIT_OK;
  }

  if (flagBool(flags, 'json')) {
    out(JSON.stringify(ctx));
    return EXIT_OK;
  }
  out(await renderFramedContextMarkdown(ctx));
  return EXIT_OK;
}
