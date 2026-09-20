/**
 * my-curator — shared CLI plumbing: argv, output discipline, exit codes, and
 * the one project resolver.
 *
 * ── WHAT THIS COMMAND IS (Decision B) ──────────────────────────────────────
 * Not "the app". A SECOND LOCAL CLIENT of the same store, exactly as
 * `mcp/server.js` is: it runs as the user, is invoked by the user's own
 * harness, reads the same files through the same `src/brain` modules, needs no
 * running server, no network and no credential. The single-writer rule is one
 * writer per FILE with matching provenance, and a `my-curator save` writes the
 * same `(project, scope, machine)` path an MCP save from this machine would.
 * It must never become reachable from a browser: no Express route may call it,
 * and `src/routes/**` must not import `bin/**` or this directory.
 *
 * ── OUTPUT DISCIPLINE, AND WHY IT IS NOT A STYLE CHOICE ────────────────────
 *   - stdout is THE PRODUCT: the bootstrap, or a harness hook envelope. A
 *     harness PARSES it. Every diagnostic, warning and refusal goes to stderr.
 *     Same rule as the MCP's stdout discipline (CLAUDE.md), same reason.
 *   - `process.exitCode`, NEVER `process.exit()`. Measured in this repo by
 *     `skills/build.mjs`'s closing note: on a pipe, stdout writes are async and
 *     `process.exit()` discards everything past ~64 KB — a bootstrap truncated
 *     mid-sentence, silently. §7 of `scripts/test-cli-curator.js` executes that
 *     case with a payload over the pipe buffer rather than trusting the note.
 *   - No colour, no spinner, no TTY branch. Every consumer is a program.
 *   - No telemetry. In particular a READ here never writes the MCP usage log:
 *     a CLI read is not an MCP call, and recording one would make the honesty
 *     meter count sessions that never opened a bridge.
 *
 * ── EXIT CODES ─────────────────────────────────────────────────────────────
 *   0  fine
 *   1  a refusal from the STORE (its own `reason`/`message`, surfaced verbatim)
 *   2  a usage error, an ambiguous project, AND the `stop` hook's deliberate
 *      block — the three cases where the caller, not the store, has to act
 *   3+ unused
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

/** Write to stdout. The product — never a diagnostic. */
export function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Write to stderr. Everything that is not the product. */
export function note(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** A refusal: message on stderr, exit code set, nothing on stdout. */
export function refuse(message, code = EXIT_USAGE) {
  note(message);
  process.exitCode = code;
  return code;
}

/**
 * argv → `{ _: positional, flags }`.
 *
 * `--k v`, `--k=v` and a bare `--flag` (true). A REPEATED flag collects into an
 * array, which is how `--next-steps a --next-steps b` builds a list without a
 * separator convention that would break on a comma inside a sentence. `--`
 * ends flag parsing. An unknown flag is NOT an error here — the subcommand
 * decides, because a flag this parser has never heard of is the subcommand's
 * business and a parser that refuses one blocks every future flag.
 *
 * ── THE TWO SHORT FLAGS, AND THE HANG THAT BOUGHT THEM (v3.64.0) ───────────
 *
 * `SHORT_FLAGS` has exactly two entries and is not the beginning of a general
 * short-option parser. Until v3.64.0 this loop had no `-x` arm at all, so `-f`
 * fell through the `startsWith('--')` test into the POSITIONALS — while
 * `src/cli/save.js` has read `flagStr(flags, 'f')` since the day it shipped
 * and prints `-f <file>` in its own usage text. The two never met.
 *
 * The consequence was not a refusal, which would have been found in a minute.
 * `runSave` saw no `--file`, took its stdin arm, and `readStdin` waited on a
 * terminal that was never going to close: `my-curator save -f handoff.json`
 * HUNG, in silence, indefinitely — measured on the maintainer's Mac,
 * 2026-09-20. A hang is the worst refusal shape this CLI can produce: no exit
 * code to test, nothing on stderr, and inside a harness hook it does not fail
 * the turn, it stops it.
 *
 * Deliberately NOT generalised. No clustering (`-fx`), no `-f=v`, no `-p` for
 * `--project`, no single-dash long names: each of those is a second way to
 * spell something that already has one. A bare `-` stays a POSITIONAL, because
 * `save` documents it as "read stdin" and a flag parser must not eat a
 * meaning the subcommand owns.
 */
export const SHORT_FLAGS = Object.freeze({ '-f': '--file', '-h': '--help' });

/** Does this argv token introduce a flag rather than a value? */
function isFlagToken(t) {
  return typeof t === 'string' && (t.startsWith('--') || Object.hasOwn(SHORT_FLAGS, t));
}

export function parseArgv(argv) {
  const flags = Object.create(null);
  const rest = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (literal) { rest.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    // Rewritten to the long spelling BEFORE anything else reads it, so the two
    // forms cannot diverge — `-f` is `--file` down to the repeats-collect-into
    // -an-array behaviour and the camelCase alias.
    if (Object.hasOwn(SHORT_FLAGS, a)) a = SHORT_FLAGS[a];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const body = a.slice(2);
    let key; let value;
    const eq = body.indexOf('=');
    if (eq !== -1) { key = body.slice(0, eq); value = body.slice(eq + 1); }
    else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !isFlagToken(next)) { value = next; i++; }
      else value = true;
    }
    if (!key) continue;
    const camel = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    for (const k of new Set([key, camel])) {
      if (flags[k] === undefined) flags[k] = value;
      else if (Array.isArray(flags[k])) flags[k].push(value);
      else flags[k] = [flags[k], value];
    }
  }
  return { _: rest, flags };
}

/** A flag as a string, or null. An array takes its LAST value. */
export function flagStr(flags, name) {
  const v = flags?.[name];
  const one = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof one === 'string' && one !== '' ? one : null;
}

/** A flag as a list of strings: repeats collect, a lone string is one item. */
export function flagList(flags, name) {
  const v = flags?.[name];
  if (v === undefined || v === true) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const items = arr.filter((x) => typeof x === 'string' && x !== '');
  return items.length ? items : undefined;
}

export function flagBool(flags, name) {
  const v = flags?.[name];
  if (v === true) return true;
  if (typeof v === 'string') return v !== 'false' && v !== '0' && v !== 'no';
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// THE `.curator-project` MARKER
//
// One line at a repository root, `domain/project` or a bare `project`. The
// SKILL has read it since v3.17.0 and `docs/working-state.md` says plainly
// that "no server code and no MCP tool reads that file". After v3.63.0 the
// CLI reads it too — still not the server and still not a tool, but the
// sentence needs correcting in the same release (package E).
//
// It is a plain file anybody can edit, so its content is a NAME TO LOOK UP,
// never an instruction: it is trimmed, capped, and handed to the store's own
// resolver, which refuses rather than guesses. Nothing else about the file is
// honoured — a second line, a flag, a path are all ignored.
// ─────────────────────────────────────────────────────────────────────────
export const MARKER_FILENAME = '.curator-project';
const MARKER_MAX_BYTES = 4096;
const MARKER_MAX_DEPTH = 64;

/** The nearest `.curator-project` at or above `startDir`, or null. */
export function findMarker(startDir) {
  let dir;
  try { dir = path.resolve(startDir || process.cwd()); } catch { return null; }
  for (let i = 0; i < MARKER_MAX_DEPTH; i++) {
    const file = path.join(dir, MARKER_FILENAME);
    try {
      if (existsSync(file) && statSync(file).isFile()) {
        const raw = readFileSync(file, 'utf8').slice(0, MARKER_MAX_BYTES);
        const line = String(raw.split(/\r?\n/)[0] || '').trim();
        if (line) return { file, line };
        // An EMPTY marker is a file the user made and did not fill in. Keep
        // walking: a parent that names a project is better than a refusal
        // caused by a placeholder somebody touched and forgot.
      }
    } catch { /* unreadable — keep walking; never fatal */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** `domain/project` or a bare name → `{domain, project}` for the resolver. */
export function parseMarkerLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const parts = s.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { domain: parts[0], project: parts[1] };
  if (parts.length === 1) return { domain: null, project: parts[0] };
  return null;
}

/**
 * The three rungs, in order, and the refusal.
 *
 * 1. `--project` / `--domain`  → the store's resolver.
 * 2. `.curator-project` in cwd or ANY parent → the line, as a name to look up.
 * 3. Neither → the configured default domain's own project, which is exactly
 *    what `resolveProjectArg` in `mcp/tools/working-state.js` does when a
 *    model names nothing. Same rung, same answer, so the CLI and the bridge
 *    can never open different projects from the same machine.
 *
 * It NEVER creates a project and it NEVER guesses one: an ambiguous or unknown
 * name comes back with the store's candidates and exit 2. Opening a project
 * the user did not name would put every save after it in the wrong tree.
 */
export async function resolveProjectForCli(opts = {}) {
  const { resolveProject } = await import('../brain/working-state.js');
  const { getDefaultDomain } = await import('../brain/config.js');
  const { listDomains } = await import('../brain/files.js');

  let named = opts.project || null;
  let domainArg = opts.domain || null;

  // `--project acme/lumina` is the form the marker line uses and the form the
  // app's "Copy marker line" hands out, so the flag accepts it too. The store's
  // resolver takes the two halves SEPARATELY — passing the slashed string as a
  // project name would run it through `slugSegment`, which flattens the
  // separator and turns a valid pointer into a name that exists nowhere.
  if (named && named.includes('/')) {
    const parts = named.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (domainArg && domainArg !== parts[0]) {
        return {
          ok: false, error: 'conflicting_domain', source: 'flag',
          message: `--domain ${domainArg} and --project ${named} name different domains. `
            + 'Pass one or the other, not two that disagree.',
          candidates: [],
        };
      }
      domainArg = parts[0];
      [, named] = parts;
    }
  }

  if (named || domainArg) {
    const r = await resolveProject({ domain: domainArg, project: named });
    return { ...r, source: 'flag' };
  }

  const marker = opts.marker === false ? null : findMarker(opts.cwd || process.cwd());
  if (marker) {
    const parsed = parseMarkerLine(marker.line);
    if (parsed) {
      const r = await resolveProject({ domain: parsed.domain, project: parsed.project });
      if (r.ok) return { ...r, source: 'marker', markerFile: marker.file, markerLine: marker.line };
      return {
        ...r,
        source: 'marker',
        markerFile: marker.file,
        markerLine: marker.line,
        message: `${r.message} (read from the marker file ${marker.file})`,
      };
    }
  }

  const def = getDefaultDomain();
  if (def) {
    let domains = [];
    try { domains = await listDomains(); } catch { domains = []; }
    if (domains.includes(def)) {
      return {
        ok: true, domain: def, project: def, isDefaultProject: true,
        resolvedBy: 'default', source: 'default',
      };
    }
  }

  // Nothing named, no marker, no usable default. List what exists rather than
  // pick one — the same courtesy the store's own refusals pay.
  const { listAllProjects } = await import('../brain/working-state.js');
  let candidates = [];
  try {
    const all = await listAllProjects({ namesOnly: true });
    candidates = (all.projects || []).slice(0, 20).map((p) => ({ domain: p.domain, project: p.project }));
  } catch { candidates = []; }
  return {
    ok: false,
    error: 'project_required',
    source: 'none',
    message: 'No project was named, no `.curator-project` marker was found in this directory or any parent, '
      + 'and no default domain is configured. Pass --project <domain/project>, or put a marker file at the '
      + 'repository root. Nothing was opened for you.',
    candidates,
  };
}

/** A refusal from `resolveProjectForCli`, rendered for stderr. */
export function renderResolveRefusal(r) {
  const lines = [r.message || 'The project could not be resolved.'];
  if (r.candidates?.length) {
    lines.push('Candidates:');
    for (const c of r.candidates) lines.push(`  ${c.domain}/${c.project}`);
  }
  return lines.join('\n');
}

export const RESOLVE_USAGE =
  'my-curator resolve [--project <domain/project|project>] [--domain <d>] [--json] [--cwd <dir>]';

/**
 * `my-curator resolve` — which project this directory is, and nothing else.
 *
 * The one subcommand whose whole output is the answer to "which project", so a
 * shell wrapper on a harness with no hooks at all (Aider) can still do the
 * right thing: `P=$(my-curator resolve) || exit`. On an ambiguity it prints
 * the candidates on stderr and exits 2 — it never picks one.
 */
export async function runResolve(parsed) {
  const { flags } = parsed;
  if (flagBool(flags, 'help')) { out(RESOLVE_USAGE); return EXIT_OK; }
  const r = await resolveProjectForCli({
    project: flagStr(flags, 'project'),
    domain: flagStr(flags, 'domain'),
    cwd: flagStr(flags, 'cwd') || process.cwd(),
  });
  if (!r.ok) return refuse(renderResolveRefusal(r), EXIT_USAGE);
  if (flagBool(flags, 'json')) {
    out(JSON.stringify({
      ok: true,
      domain: r.domain,
      project: r.project,
      isDefaultProject: r.isDefaultProject === true,
      resolvedBy: r.resolvedBy || null,
      source: r.source,
      markerFile: r.markerFile || null,
      markerLine: r.markerLine || null,
    }));
  } else out(`${r.domain}/${r.project}`);
  return EXIT_OK;
}

/**
 * A store refusal, rendered for stderr. The store owns the wording; this adds
 * nothing to it but the reason code, which a script can grep for.
 */
export function renderStoreRefusal(r) {
  const reason = r?.reason || r?.error || 'refused';
  const message = r?.message || r?.error || 'The store refused the call and gave no reason.';
  return `${message}\n(reason: ${reason})`;
}
