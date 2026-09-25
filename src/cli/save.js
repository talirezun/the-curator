/**
 * `my-curator save` — a save from the shell.
 *
 * Reads a JSON object from stdin (or `-f <file>`) in exactly
 * `save_working_state`'s field shape and calls `saveWorkingState`. Every
 * refusal the store returns is surfaced verbatim with a non-zero exit.
 *
 * ── THE ARGUMENT NAMES ARE THE MCP's, BOTH SPELLINGS ───────────────────────
 * snake_case is the house style (`now_state`, `next_steps`, `open_questions`,
 * `foundations_read`, `repo_root`) and camelCase is accepted beside it, exactly
 * as `pickSectionArgs` in `mcp/tools/working-state.js` accepts both — and, like
 * that function, the mapping is DERIVED from the store's own `STATE_SECTIONS`
 * rather than typed out, so a section added to the store cannot silently lose
 * its argument here. A hook that pipes the same JSON body at the CLI and at the
 * bridge must land the same file; a second spelling table is how that stops
 * being true.
 *
 * ── WHY JSON AND NOT MARKDOWN ──────────────────────────────────────────────
 * There is no read-side section parser in the store, and writing one here
 * would be a second grammar to keep in step with `STATE_SECTIONS`. A third
 * party that wants to write markdown writes the FILE, per the public spec —
 * it does not come through this command.
 *
 * ── IT NEVER COMPOSES (Decision C) ─────────────────────────────────────────
 * This command writes what it is given. It does not summarise a transcript,
 * call a model, or synthesise a handoff: a fabricated handoff is worse than a
 * missing one, because the store's whole contract is that what is written was
 * written by whoever the provenance names. `my-curator hook` therefore never
 * calls this — it asks the model to call the tool itself.
 *
 * ── AND THE SAVE IS COMPLETE, NOT A DELTA ──────────────────────────────────
 * A save OVERWRITES the scope's `current.md`. Sending only the fields that
 * changed silently drops everything recorded by the previous save — the
 * store's rule, and the reason the skill says "save early and often" and
 * "every save must be complete".
 */
import { readFileSync } from 'node:fs';
import {
  EXIT_OK, EXIT_REFUSED, EXIT_USAGE, out, note, refuse,
  flagStr, flagList, flagBool, resolveProjectForCli, renderResolveRefusal, renderStoreRefusal,
} from './resolve.js';

export const SAVE_USAGE =
  'my-curator save [--project <domain/project|project>] [--domain <d>] [--scope <name>]\n'
  + '                --scope default: your tool\'s scope when --harness is given, else main\n'
  + '                [-f <file> | --file <file> | - ]        JSON body on stdin by default\n'
  + '                [--headline "…"] [--now-state "…"] [--now-state-file <f>]\n'
  + '                [--next-steps "…" …] [--decisions "…" …] [--traps "…" …]\n'
  + '                [--open-questions "…" …] [--foundations-read <json|file>]\n'
  + '                [--harness <name>] [--model <id>] [--repo-root <abs>]\n'
  + '                [--replace] [--dry-run] [--json]';

/**
 * THE REFUSAL FOR AN EMPTY BODY, byte-identical to the MCP handler's.
 *
 * `saveWorkingStateHandler` refuses a missing headline before the store sees
 * the call, and this is that sentence. One wording across both clients: an
 * agent told one thing by the bridge and another by the CLI has to learn two
 * failure modes for one rule.
 */
export const MISSING_HEADLINE =
  'headline is required and must be a non-empty string — it is the only thing a future session sees '
  + 'before deciding to open this state.';

const EMPTY_BODY =
  'Nothing was sent to save. A save OVERWRITES this scope\'s handoff, so an empty body would replace a '
  + 'real one with nothing. Pipe the complete state as a JSON object on stdin, or pass -f <file>.';

/** Read all of stdin. Returns '' when stdin is a TTY or closed immediately. */
export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8');
}

/**
 * Both spellings → the store's camelCase keys, derived from STATE_SECTIONS.
 * `observations[].observed_at` is mapped too — the one camelCase key in an
 * otherwise snake_case schema, and a silent loss if it is not (the store
 * stamps the SAVE time when it finds no `observedAt`, replacing the caller's
 * real observation time with "now").
 */
export function pickSectionArgs(body, STATE_SECTIONS) {
  const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const outArgs = {};
  for (const sec of STATE_SECTIONS) {
    const s = snake(sec.key);
    const v = body?.[s] !== undefined ? body[s] : body?.[sec.key];
    if (v !== undefined) outArgs[sec.key] = sec.key === 'observations' ? normaliseObservations(v) : v;
  }
  return outArgs;
}

function normaliseObservations(v) {
  const one = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    if (o.observedAt !== undefined || o.observed_at === undefined) return o;
    const { observed_at: at, ...rest } = o;
    return { ...rest, observedAt: at };
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

/** `--foundations-read` takes inline JSON or a path to a JSON file. */
function readFoundationsReadFlag(raw) {
  if (!raw) return undefined;
  const text = raw.trim().startsWith('{') || raw.trim().startsWith('[')
    ? raw
    : readFileSync(raw, 'utf8');
  return JSON.parse(text);
}

export async function runSave(parsed, deps = {}) {
  const { flags, _ } = parsed;
  if (flagBool(flags, 'help')) { out(SAVE_USAGE); return EXIT_OK; }

  // v3.74.0 — `otherToolReplaceSentence`: the same "you replaced another
  // tool's handoff" sentence the MCP reply prints, from the one composer.
  const { STATE_SECTIONS, saveWorkingState, otherToolReplaceSentence, defaultScopeFor, scopeChoiceSentence } = await import('../brain/working-state.js');

  // ── The body: a file, or stdin ───────────────────────────────────────────
  const file = flagStr(flags, 'f') || flagStr(flags, 'file');
  let raw = '';
  try {
    if (file && file !== '-') raw = readFileSync(file, 'utf8');
    else raw = await (deps.readStdin || readStdin)(deps.stdin || process.stdin);
  } catch (err) {
    return refuse(`Could not read the state body: ${err.message}`, EXIT_USAGE);
  }

  let body = {};
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      body = JSON.parse(trimmed);
    } catch (err) {
      return refuse(
        `The state body is not valid JSON: ${err.message}\n`
        + 'Send a JSON object in save_working_state\'s field shape — see docs/spec/working-state-v1.md.',
        EXIT_USAGE,
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return refuse('The state body must be a JSON OBJECT, not an array or a scalar.', EXIT_USAGE);
    }
  }

  // ── Flags override the body, field by field ──────────────────────────────
  const merged = { ...body };
  const put = (key, v) => { if (v !== undefined && v !== null) merged[key] = v; };
  put('headline', flagStr(flags, 'headline'));
  put('scope', flagStr(flags, 'scope'));
  put('harness', flagStr(flags, 'harness'));
  put('model', flagStr(flags, 'model'));
  put('repo_root', flagStr(flags, 'repoRoot'));
  put('now_state', flagStr(flags, 'nowState'));
  const nowStateFile = flagStr(flags, 'nowStateFile');
  if (nowStateFile) {
    try { merged.now_state = readFileSync(nowStateFile, 'utf8'); }
    catch (err) { return refuse(`Could not read --now-state-file: ${err.message}`, EXIT_USAGE); }
  }
  put('next_steps', flagList(flags, 'nextSteps'));
  put('decisions', flagList(flags, 'decisions'));
  put('traps', flagList(flags, 'traps'));
  put('open_questions', flagList(flags, 'openQuestions'));
  const fr = flagStr(flags, 'foundationsRead');
  if (fr) {
    try { merged.foundations_read = readFoundationsReadFlag(fr); }
    catch (err) { return refuse(`--foundations-read is neither JSON nor a readable JSON file: ${err.message}`, EXIT_USAGE); }
  }
  if (flagBool(flags, 'replace')) merged.replace = true;

  if (!Object.keys(merged).length) return refuse(EMPTY_BODY, EXIT_USAGE);
  if (typeof merged.headline !== 'string' || !merged.headline.trim()) {
    return refuse(MISSING_HEADLINE, EXIT_USAGE);
  }

  // ── The project ──────────────────────────────────────────────────────────
  const resolved = await resolveProjectForCli({
    project: flagStr(flags, 'project') || (typeof merged.project === 'string' ? merged.project : null),
    domain: flagStr(flags, 'domain') || (typeof merged.domain === 'string' ? merged.domain : null),
    cwd: flagStr(flags, 'cwd') || process.cwd(),
  });
  if (!resolved.ok) return refuse(renderResolveRefusal(resolved), EXIT_USAGE);

  // `machine` is NOT an argument — deliberately, and for the same reason the
  // MCP tool refuses one: it is a path segment, and the only use for choosing
  // one would be to write into another machine's folder, which cannot be a
  // legitimate handoff. The store detects it.
  const input = {
    project: resolved.project,
    scope: merged.scope,
    headline: merged.headline,
    harness: typeof merged.harness === 'string' ? merged.harness : undefined,
    model: typeof merged.model === 'string' ? merged.model : undefined,
    replace: merged.replace === true,
    repoRoot: typeof merged.repo_root === 'string' ? merged.repo_root
      : typeof merged.repoRoot === 'string' ? merged.repoRoot : undefined,
    ...pickSectionArgs(merged, STATE_SECTIONS),
  };

  if (flagBool(flags, 'dryRun')) {
    // Reports and writes NOTHING — the courtesy the three destructive wiki
    // scripts give, and §6 of the suite fingerprints the state tree across it.
    const preview = {
      ok: true,
      dryRun: true,
      domain: resolved.domain,
      project: resolved.project,
      resolvedBy: resolved.resolvedBy || resolved.source,
      // v3.76.0 — the store's own default: no scope + a harness is that
      // tool's scope, else `main` (defaultScopeFor), so a dry run never names
      // a scope the real save would not use.
      scope: input.scope || defaultScopeFor(input.harness).scope,
      wouldWrite: Object.fromEntries(
        Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [
          k, Array.isArray(v) ? `${v.length} item(s)` : typeof v === 'string' ? `${v.length} char(s)` : v,
        ]),
      ),
    };
    if (flagBool(flags, 'json')) out(JSON.stringify(preview));
    else {
      out(`DRY RUN — nothing was written.\nProject: ${preview.domain}/${preview.project} (resolved by ${preview.resolvedBy})`
        + `\nScope:   ${preview.scope}\nFields:  ${Object.keys(preview.wouldWrite).join(', ')}`);
    }
    return EXIT_OK;
  }

  const result = await saveWorkingState(resolved.domain, input);
  if (!result.ok) {
    if (flagBool(flags, 'json')) out(JSON.stringify({ ok: false, reason: result.reason, message: result.message }));
    return refuse(renderStoreRefusal(result), EXIT_REFUSED);
  }

  if (flagBool(flags, 'json')) out(JSON.stringify(result));
  else {
    out(`Saved ${result.domain}/${result.project} · scope '${result.scope}' · machine ${result.machine}`
      + `\n${result.path} (${result.bytes} bytes)`
      + (scopeChoiceSentence(result) ? `\n${scopeChoiceSentence(result).trim()}` : '')
      + `\nThis OVERWROTE the previous save for that scope.`
      + (result.overwrote ? `\n${otherToolReplaceSentence(result.overwrote, result.scope).trim()}` : ''));
  }
  // Notes are disclosure, not the product: a trim or a defaulted observation
  // time is something the caller should see and nothing a pipe should receive.
  for (const n of result.notes || []) note(`note: ${n}`);
  if (result.foundationsRefresh && result.foundationsRefresh.attempted === false) {
    note(`foundations were not refreshed: ${result.foundationsRefresh.skipped}`);
  }
  return EXIT_OK;
}

export { EXIT_OK, EXIT_REFUSED, EXIT_USAGE };
