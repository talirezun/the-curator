/**
 * `my-curator install-hooks <harness>` — writes HOOK CONFIGURATION, and
 * nothing else.
 *
 * ── THE THREE RULES, EACH FROM A RECORDED DEFECT ───────────────────────────
 *
 * 1. IT NEVER WRITES A MODEL-READ INSTRUCTION FILE (Decision K). `CLAUDE.md`,
 *    `AGENTS.md`, `GEMINI.md`, `.cursor/rules` and `.rules` stay the OWNER's
 *    paste. A tool that edits those becomes a second writer of model-read
 *    text, which is Decision J from the other side — and two copies of a
 *    model-read instruction "would not merely disagree, they would instruct
 *    two agents to behave differently". `--print-instructions` prints the
 *    block and names the file this harness will actually read; the paste is
 *    the owner's.
 *
 * 2. IT REFUSES A FILE IT CANNOT PARSE (Decision L). The precedent is exact
 *    and already in this repository: `buildFullConfigPayload` returns
 *    `merged: null` on a corrupt `claude_desktop_config.json` because "you
 *    cannot merge into a document you cannot read", and a confident-looking
 *    merged payload would delete the user's other servers
 *    (`routes/mcp.js:125-161`). Same rule, same shape, same refusal.
 *
 * 3. EVERY COMMAND IT WRITES IS AN ABSOLUTE PATH (Decision E, Risk 3).
 *    `--scope project` writes `.claude/settings.json`, which is COMMITTED. A
 *    bare `curator` absent from a teammate's PATH turns capture into "the
 *    harness is broken on this repo" — and on a Debian box `curator` is
 *    Elastic's index-retention tool. So the command is resolved to an
 *    absolute path before anything is written, and if it cannot be, nothing
 *    is.
 *
 * ── AND THE ONE THIS PACKAGE EXISTS FOR ────────────────────────────────────
 * IT NEVER INSTALLS AN ENTRY THAT CANNOT DO ANYTHING. Which events a harness
 * can be asked in is decided by `HARNESS_HOOKS` in `src/cli/hook.js` — ONE
 * source, C's — and an event whose envelope that table WITHHOLDS is not
 * written. Cline's `PreCompact` is accepted and maps to `undefined` so it
 * never fires; Codex's `SessionEnd` caps at 3 s, which is not an MCP round
 * trip; Gemini CLI's `AfterAgent` envelope is unmeasured. A naive writer puts
 * all three in a config file and ships a feature that does nothing, silently.
 * Here each is a first-class refusal naming its measured reason.
 *
 * `--allow-withheld` overrides that for a harness whose events are merely
 * UNMEASURED (never for one that is measured-useless), writes the entries, and
 * prints one line per event saying it will emit nothing until the envelope is
 * measured. It exists so the wiring can be laid ahead of §E's measurement by
 * somebody who knows what they are laying — not as a default, because a
 * default that installs a silent no-op is the defect above.
 *
 * ── WHAT IT DOES NOT WRITE, FULL LIST ──────────────────────────────────────
 * Any instruction file; any managed-policy or enterprise-scope file; any MCP
 * server registration (that is the wizard's job and `buildCuratorEntry` is the
 * one launch line); anything outside the adapter's own `hooks.configPath`;
 * anything at all when the target exists and does not parse.
 *
 * Exit codes follow the rest of the command: 0 fine · 1 a refusal · 2 a usage
 * error.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomicSync } from '../brain/atomic-write.js';
import {
  adapterFor, listHarnesses, refusals, resolveTemplates, instructionSnippetFor, shellQuote,
} from '../brain/harness-adapters.js';
import { HARNESS_HOOKS } from './hook.js';
import {
  EXIT_OK, EXIT_REFUSED, EXIT_USAGE, out, note, flagStr, flagBool, findMarker,
} from './resolve.js';

export const INSTALL_HOOKS_USAGE =
  'my-curator install-hooks <harness> [--scope user|project|local] [--dry-run] [--json]\n'
  + '                                  [--uninstall] [--print-instructions] [--bin <abs path>]\n'
  + '                                  [--git-exclude]  (keep a project hook file out of git, locally)\n'
  + '                                  [--allow-withheld] [--cwd <dir>] [--home <dir>]\n'
  + `    harnesses: ${listHarnesses().join(', ')}`;

/** The marker that makes an entry OURS, and the only thing a re-run replaces. */
export const STATUS_PREFIX = 'Curator: ';

/** What each canonical event's `statusMessage` says, where the harness has one. */
const STATUS_FOR = {
  'session-start': `${STATUS_PREFIX}loading project context`,
  'pre-compact': `${STATUS_PREFIX}checking working state`,
  stop: `${STATUS_PREFIX}checking working state`,
  'session-end': `${STATUS_PREFIX}recording`,
};

/** Canonical event key → the key `HARNESS_HOOKS` uses for that arm. */
const ARM_FOR = { 'session-start': 'sessionStart', 'pre-compact': 'preCompact', stop: 'stop' };

/**
 * Is this command string one of OURS?
 *
 * Recognition is by the COMMAND, not by a marker field, because only Claude
 * Code documents `statusMessage` — recognising by a field three of the five
 * harnesses do not have would leave a re-run appending a second copy on those
 * three, forever. The command is the one thing every format carries.
 */
export function isCuratorHookCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  return /(?:^|[/\\\s'"])(?:my-)?curator(?:\.js)?['"]?\s+hook\s+/.test(cmd);
}

// ─────────────────────────────────────────────────────────────────────────
// THE BINARY, RESOLVED TO AN ABSOLUTE PATH OR NOT AT ALL
//
// `curator` is NEVER searched for: on a Debian box it is Elastic's
// `elasticsearch-curator` (~57k downloads a week) and running ITS binary with
// our arguments from a committed hook file is a worse outcome than no hook.
// Only the namespaced `my-curator` is looked up, and the fallback is this
// checkout's own `bin/curator.js` behind the running node — the same shape
// `buildCuratorEntry`'s repo arm uses, for the same reason.
// ─────────────────────────────────────────────────────────────────────────
const REPO_BIN = fileURLToPath(new URL('../../bin/curator.js', import.meta.url));

export function resolveBin({ binFlag = null, env = process.env, execPath = process.execPath } = {}) {
  if (binFlag) {
    const abs = path.resolve(binFlag);
    if (!isExecutableFile(abs)) return refusals.binNotResolved(binFlag, abs);
    return { ok: true, cmd: abs, prefixArgs: [], how: 'flag' };
  }
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const cand = path.join(d, 'my-curator');
    if (isExecutableFile(cand)) return { ok: true, cmd: cand, prefixArgs: [], how: 'path' };
  }
  if (!existsSync(REPO_BIN)) return refusals.binNotResolved('my-curator', `${dirs.length} PATH entries, then ${REPO_BIN}`);
  return { ok: true, cmd: execPath, prefixArgs: [REPO_BIN], how: 'repo' };
}

function isExecutableFile(p) {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────
// THE PLAN — which events get written, and why each other one does not
// ─────────────────────────────────────────────────────────────────────────

/**
 * @returns {{write: Array<{canonical, event, reason?}>, skipped: Array<{event, reason}>}}
 */
export function planEvents(adapter, { allowWithheld = false } = {}) {
  const write = [];
  const skipped = [];
  const events = adapter.hooks?.events || {};
  const hooksEntry = HARNESS_HOOKS[adapter.id] || null;
  for (const [canonical, event] of Object.entries(events)) {
    const armKey = ARM_FOR[canonical];
    if (!armKey) {
      // `session-end` is never installed: a hook cannot close a bridge session
      // it has no handle on — the sid is minted inside the MCP child — so the
      // marker it could write would be unjoinable.
      skipped.push({ event, reason: 'no session-end hook is installed: it cannot close a bridge session it has no handle on' });
      continue;
    }
    const arm = hooksEntry?.[armKey] || null;
    const emits = typeof arm?.emit === 'function' || arm?.block === true;
    if (emits) { write.push({ canonical, event }); continue; }
    const why = arm?.withheld || 'this build ships no envelope for that event';
    if (allowWithheld) write.push({ canonical, event, withheld: why });
    else skipped.push({ event, reason: why });
  }
  // The events that EXIST on this harness and are refused on a MEASURED
  // ground — never overridable, because the measurement is the reason.
  for (const [event, reason] of Object.entries(adapter.hooks?.refusedEvents || {})) {
    skipped.push({ event, reason, measured: true });
  }
  return { write, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// THE WRITERS — six harnesses, four shapes
//
// `claude-code` and `codex` share the NESTED-GROUP shape. That is the least
// guess available: Claude Code's is documented, Codex's twelve events carry
// the same names and its entry shape is NOT measured, so mirroring the harness
// it is modelled on beats inventing a second one. It is marked unverified and
// `--dry-run` prints exactly what would land.
// ─────────────────────────────────────────────────────────────────────────

const WRITERS = {
  'claude-code': { kind: 'nested-groups', root: 'hooks' },
  codex: { kind: 'nested-groups', root: 'hooks' },
  cursor: { kind: 'flat-array', root: 'hooks', version: 1, extra: (a) => ({ loop_limit: a.hooks.loopLimit || 1 }) },
  'copilot-cli': { kind: 'flat-array', root: 'hooks', version: 1, ownFile: true },
  goose: { kind: 'goose-args', root: 'hooks', ownFile: true },
  // v3.76.0. Antigravity's hooks.json has NO `hooks` root: its top-level keys
  // are hook NAMES, each holding its events, and PreInvocation/Stop take a
  // FLAT list of `{type, command, timeout}` handlers (vendor hooks.md). Ours
  // live under one name, the adapter's `hookName`; every other name is left
  // exactly as found.
  antigravity: { kind: 'named-hooks', root: null },
};

/** The command written for one event — a string, or a cmd/args pair. */
function commandFor(bin, adapter, canonical) {
  const argv = [...bin.prefixArgs, 'hook', canonical, '--harness', adapter.id];
  return {
    argv,
    cmd: bin.cmd,
    string: [bin.cmd, ...argv].map(shellQuote).join(' '),
  };
}

/** One named hook's events, stripped of ours. Returns the count removed. */
function stripNamedHook(hook) {
  let removed = 0;
  for (const event of Object.keys(hook)) {
    const arr = hook[event];
    if (!Array.isArray(arr)) continue;
    const kept = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') { kept.push(item); continue; }
      if (Array.isArray(item.hooks)) {
        // A GROUPED event (PreToolUse/PostToolUse carry a `matcher`).
        const inner = item.hooks.filter((h) => !isCuratorHookCommand(h?.command));
        removed += item.hooks.length - inner.length;
        if (inner.length) kept.push({ ...item, hooks: inner });
        continue;
      }
      if (isCuratorHookCommand(item.command)) { removed++; continue; }
      kept.push(item);
    }
    if (kept.length) hook[event] = kept;
    else delete hook[event];
  }
  return removed;
}

/** Strip every entry of ours out of a parsed document. Returns the count. */
function stripOurs(doc, spec) {
  if (spec.kind === 'named-hooks') {
    let removed = 0;
    for (const name of Object.keys(doc || {})) {
      const hook = doc[name];
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) continue;
      const n = stripNamedHook(hook);
      removed += n;
      // A named hook we emptied is gone; one with anything left (somebody
      // else's handler, or only their `enabled`) is theirs and stays.
      const left = Object.keys(hook).filter((k) => k !== 'enabled');
      if (n && left.length === 0) delete doc[name];
    }
    return removed;
  }
  const root = doc?.[spec.root];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return 0;
  let removed = 0;
  for (const event of Object.keys(root)) {
    const arr = root[event];
    if (!Array.isArray(arr)) continue;
    const kept = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') { kept.push(item); continue; }
      if (spec.kind === 'nested-groups') {
        if (!Array.isArray(item.hooks)) { kept.push(item); continue; }
        const inner = item.hooks.filter((h) => !isCuratorHookCommand(h?.command));
        removed += item.hooks.length - inner.length;
        // A group left with no hooks is OUR group; one that still has hooks is
        // somebody else's and keeps its own `matcher` and every other key.
        if (inner.length) kept.push({ ...item, hooks: inner });
        continue;
      }
      if (spec.kind === 'goose-args') {
        const joined = [item.cmd, ...(Array.isArray(item.args) ? item.args : [])].join(' ');
        if (isCuratorHookCommand(joined)) { removed++; continue; }
        kept.push(item);
        continue;
      }
      if (isCuratorHookCommand(item.command)) { removed++; continue; }
      kept.push(item);
    }
    if (kept.length) root[event] = kept;
    else delete root[event];
  }
  return removed;
}

/** Add our entries. The document is already stripped of any previous ours. */
function addOurs(doc, spec, adapter, bin, plan) {
  if (spec.kind === 'named-hooks') {
    const name = adapter.hooks.hookName;
    const hook = doc[name] && typeof doc[name] === 'object' && !Array.isArray(doc[name]) ? doc[name] : {};
    const written = [];
    for (const { canonical, event } of plan.write) {
      const c = commandFor(bin, adapter, canonical);
      const timeout = adapter.hooks?.timeoutSeconds?.[canonical] ?? 10;
      const arr = Array.isArray(hook[event]) ? hook[event] : [];
      arr.push({ type: 'command', command: c.string, timeout });
      hook[event] = arr;
      written.push({ event, canonical, command: c.string });
    }
    doc[name] = hook;
    return written;
  }
  if (!doc[spec.root] || typeof doc[spec.root] !== 'object' || Array.isArray(doc[spec.root])) doc[spec.root] = {};
  if (spec.version !== undefined && doc.version === undefined) doc.version = spec.version;
  const written = [];
  for (const { canonical, event } of plan.write) {
    const c = commandFor(bin, adapter, canonical);
    const timeout = adapter.hooks?.timeoutSeconds?.[canonical] ?? 10;
    let entry;
    if (spec.kind === 'nested-groups') {
      entry = { hooks: [{ type: 'command', command: c.string, timeout, statusMessage: STATUS_FOR[canonical] }] };
    } else if (spec.kind === 'goose-args') {
      // goose's own field vocabulary — `cmd` / `args` / `envs` — which also
      // means no shell quoting is involved at all on this harness.
      entry = { cmd: c.cmd, args: c.argv, envs: {} };
    } else {
      entry = { command: c.string, timeout, ...(spec.extra ? spec.extra(adapter) : {}) };
    }
    const arr = Array.isArray(doc[spec.root][event]) ? doc[spec.root][event] : [];
    arr.push(entry);
    doc[spec.root][event] = arr;
    written.push({ event, canonical, command: c.string });
  }
  return written;
}

/** The shape check — refusal 4. A parsed file whose root is not an object. */
function shapeProblem(doc, spec, file) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return refusals.shapeMismatch(file, spec.root || '(the document)', Array.isArray(doc) ? 'an array' : `a ${doc === null ? 'null' : typeof doc}`);
  }
  if (spec.kind === 'named-hooks') {
    // Every top-level value is a named hook, so every one must be an object —
    // a file whose values are not is a different tool's, or hand-broken.
    for (const [k, v] of Object.entries(doc)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return refusals.shapeMismatch(file, k, Array.isArray(v) ? 'an array' : `a ${v === null ? 'null' : typeof v}`);
      }
      for (const [ev, arr] of Object.entries(v)) {
        if (ev === 'enabled') continue;
        if (!Array.isArray(arr)) return refusals.shapeMismatch(file, `${k}.${ev}`, `a ${arr === null ? 'null' : typeof arr}`);
      }
    }
    return null;
  }
  const root = doc[spec.root];
  if (root === undefined) return null;
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return refusals.shapeMismatch(file, spec.root, Array.isArray(root) ? 'an array' : `a ${root === null ? 'null' : typeof root}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// THE COMMAND
// ─────────────────────────────────────────────────────────────────────────

export async function runInstallHooks(parsed) {
  const { flags, _ } = parsed;
  const json = flagBool(flags, 'json');
  const emit = (payload, code) => {
    if (json) out(JSON.stringify(payload));
    if (!payload.ok) note(payload.message || 'refused');
    return code;
  };

  if (flagBool(flags, 'help')) { out(INSTALL_HOOKS_USAGE); return EXIT_OK; }

  const id = (_[0] || flagStr(flags, 'harness') || '').trim();
  if (!id) {
    note(`my-curator install-hooks: name a harness.\n${INSTALL_HOOKS_USAGE}`);
    return EXIT_USAGE;
  }
  const adapter = adapterFor(id);
  if (!adapter) return emit(refusals.unknownHarness(id), EXIT_USAGE);

  const cwd = flagStr(flags, 'cwd') || process.cwd();
  const home = flagStr(flags, 'home') || homeDir();

  // `--print-instructions` — Decision K's other half. It PRINTS; the paste is
  // the owner's, and no instruction file is opened for writing here or
  // anywhere else in this module.
  if (flagBool(flags, 'printInstructions')) {
    return printInstructions(adapter, flags, cwd, json);
  }

  // Refusal 2 — a harness whose hooks this build cannot write.
  if (!adapter.hooks?.writer || !WRITERS[adapter.id]) {
    return emit(refusals.noHooks(adapter.id), EXIT_REFUSED);
  }

  const scope = (flagStr(flags, 'scope') || 'project').trim();
  if (!['user', 'project', 'local'].includes(scope)) {
    note(`my-curator install-hooks: --scope must be user, project or local (got "${scope}").`);
    return EXIT_USAGE;
  }

  // The project root, for a project/local scope. It is the directory holding
  // the `.curator-project` marker — the same rung `resolve.js` uses — because
  // a project-scope write lands in a COMMITTED file and guessing which
  // repository that is puts a hook in somebody else's.
  let projectRoot = '';
  if (scope !== 'user') {
    const marker = findMarker(cwd);
    if (!marker) {
      return emit(Object.freeze({
        ok: false,
        reason: 'no_project_root',
        message: `No \`.curator-project\` marker was found in ${cwd} or any parent, so there is no project root to write `
          + 'a committed hook file into, and nothing was written. Put the marker file at the repository root '
          + '(the app\'s "Copy marker line" gives you the line), or use --scope user to wire this harness for '
          + 'yourself on this machine only.',
      }), EXIT_REFUSED);
    }
    projectRoot = path.dirname(marker.file);
  }

  const dirs = { home, project: projectRoot };
  const templates = adapter.hooks.configPath?.[scope] || [];
  const targets = resolveTemplates(templates, dirs);
  if (!targets.length) {
    const available = ['user', 'project', 'local'].filter((s) => (adapter.hooks.configPath?.[s] || []).length);
    return emit(Object.freeze({
      ok: false,
      reason: 'no_scope_path',
      message: `${adapter.label} has no hook configuration file at --scope ${scope}, so nothing was written. `
        + (available.length ? `Available: ${available.join(', ')}.` : 'This harness has no measured hook configuration path at all.'),
    }), EXIT_REFUSED);
  }
  let target = targets[0];
  const spec = WRITERS[adapter.id];
  // A DIRECTORY target (Copilot's `.github/hooks/`, goose's plugin tree): the
  // file inside it is entirely ours, so there is nothing of anybody else's to
  // merge with — and nothing of anybody else's to lose.
  if (spec.ownFile && adapter.hooks.perFile) target = path.join(target, adapter.hooks.perFile);

  const bin = resolveBin({ binFlag: flagStr(flags, 'bin') });
  if (!bin.ok) return emit(bin, EXIT_REFUSED);

  // Read the existing document. ABSENT is `{}`; UNPARSEABLE is refusal 3 and
  // NOTHING is written (Decision L).
  let doc = {};
  let existedBefore = false;
  if (existsSync(target)) {
    existedBefore = true;
    let text;
    try { text = readFileSync(target, 'utf8'); }
    catch (err) { return emit(refusals.unparseableConfig(target, err.message), EXIT_REFUSED); }
    if (text.trim()) {
      try { doc = JSON.parse(text); }
      catch (err) { return emit(refusals.unparseableConfig(target, err.message), EXIT_REFUSED); }
    }
  }
  const bad = shapeProblem(doc, spec, target);
  if (bad) return emit(bad, EXIT_REFUSED);

  const uninstall = flagBool(flags, 'uninstall');
  const removed = stripOurs(doc, spec);

  let written = [];
  let plan = { write: [], skipped: [] };
  if (!uninstall) {
    plan = planEvents(adapter, { allowWithheld: flagBool(flags, 'allowWithheld') });
    if (!plan.write.length) {
      return emit(Object.freeze({
        ok: false,
        reason: 'all_events_withheld',
        message: `Nothing was written for ${adapter.label}: every event this build could write for it has its `
          + `envelope withheld — ${plan.skipped.map((s) => `${s.event} (${s.reason})`).join('; ')}. `
          + 'An entry here would invoke a command that emits nothing, which is the outcome this writer exists '
          + 'to prevent. Pass --allow-withheld to lay the wiring anyway, knowing it stays inert until the '
          + 'envelope is measured.',
        skipped: plan.skipped,
      }), EXIT_REFUSED);
    }
    written = addOurs(doc, spec, adapter, bin, plan);
  }

  // Drop an empty root rather than leaving `"hooks": {}` behind after an
  // uninstall of a file we created.
  if (spec.root && doc[spec.root] && Object.keys(doc[spec.root]).length === 0) delete doc[spec.root];

  const text = `${JSON.stringify(doc, null, 2)}\n`;

  if (flagBool(flags, 'dryRun')) {
    // The PRODUCT of a dry run is the document, on stdout, byte for byte.
    out(json ? JSON.stringify({ ok: true, dryRun: true, file: target, document: doc, written, skipped: plan.skipped }) : text);
    note(`my-curator install-hooks: --dry-run — nothing was written. Target would be ${target}.`);
    return EXIT_OK;
  }

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomicSync(target, text, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    return emit(Object.freeze({
      ok: false, reason: 'write_failed', file: target,
      message: `${target} could not be written (${err.message}). Nothing was changed.`,
    }), EXIT_REFUSED);
  }

  const payload = {
    ok: true,
    harness: adapter.id,
    file: target,
    scope,
    created: !existedBefore,
    replaced: removed,
    uninstalled: uninstall,
    written,
    skipped: plan.skipped,
    bin: { command: bin.cmd, how: bin.how },
    shapeVerified: adapter.hooks.shapeVerified === true,
  };
  if (json) out(JSON.stringify(payload));

  note(uninstall
    ? `my-curator install-hooks: removed ${removed} Curator hook ${removed === 1 ? 'entry' : 'entries'} from ${target}.`
    : `my-curator install-hooks: wrote ${written.length} hook ${written.length === 1 ? 'entry' : 'entries'} for `
      + `${adapter.label} into ${target}${removed ? ` (replacing ${removed})` : ''}.`);
  for (const s of plan.skipped) note(`  not written — ${s.event}: ${s.reason}`);
  // An entry written under --allow-withheld is INERT until its envelope is
  // measured, and the line that says so is the whole price of the flag.
  for (const w of written) {
    const why = plan.write.find((x) => x.event === w.event)?.withheld;
    if (why) note(`  ${w.event} was written and will emit nothing until the envelope is measured — ${why}.`);
  }
  // WHAT WAS OBSERVED OF THIS SCOPE (v3.77.0), said beside the write and no
  // more strongly than the observation. Antigravity, 2026-09-26: a user-file
  // start hook ran but its injection was not seen used; the project file's
  // was. The write is still made — the user asked for it.
  const obs = adapter.hooks.scopeObservations?.[scope];
  if (!uninstall && obs && !/was used/.test(obs)) {
    note(`  NOTE: a hook in ${target} ${obs}. --scope project (the default) is where it was seen working.`);
  }
  // A PROJECT hook file carries an ABSOLUTE path to this machine's command, so
  // committing it hands every clone a path that is wrong on their computer.
  // `--git-exclude` keeps it out of git LOCALLY (.git/info/exclude — never
  // .gitignore, which is committed); without the flag, the line says how.
  if (!uninstall && scope !== 'user' && adapter.id === 'antigravity') {
    const rel = path.relative(projectRoot, target);
    const ex = flagBool(flags, 'gitExclude') ? addToGitExclude(projectRoot, rel) : null;
    if (ex && ex.ok) note(`  ${rel} ${ex.already ? 'was already' : 'is now'} listed in ${ex.file} — git will not offer to commit it (this machine only).`);
    else if (ex) note(`  could not add ${rel} to .git/info/exclude: ${ex.reason}`);
    else {
      note(`  NOTE: ${rel} contains an absolute path to this computer's \`my-curator\`. Do not commit it — `
        + `re-run with --git-exclude to add it to .git/info/exclude (local to this machine, never pushed).`);
    }
  }
  if (!uninstall && adapter.hooks.shapeVerified !== true) {
    note('  the entry shape for this harness is documented, not measured — run `my-curator doctor` after the '
      + 'next session to see whether it fired.');
  }
  if (!uninstall) {
    note('  no instruction file was touched: the block is yours to paste. '
      + `\`my-curator install-hooks ${adapter.id} --print-instructions\` prints it and names the file.`);
  }
  return EXIT_OK;
}

/**
 * Add one repository-relative path to `<git dir>/info/exclude`, the LOCAL
 * ignore file git never commits. Idempotent. Never throws.
 */
export function addToGitExclude(projectRoot, rel) {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: projectRoot, encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0 || !r.stdout.trim()) return { ok: false, reason: 'this folder is not a git repository' };
    const file = path.resolve(projectRoot, r.stdout.trim());
    const line = `/${rel.split(path.sep).join('/')}`;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
    if (text.split('\n').some((l) => l.trim() === line)) return { ok: true, already: true, file };
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# The Curator: a hook file with this machine's absolute path\n${line}\n`);
    return { ok: true, already: false, file };
  } catch (err) { return { ok: false, reason: err.message }; }
}

/** `--print-instructions` — prints, never writes. */
async function printInstructions(adapter, flags, cwd, json) {
  const project = flagStr(flags, 'project');
  const domain = flagStr(flags, 'domain');
  let d = domain; let p = project;
  if (p && p.includes('/')) { const parts = p.split('/').filter(Boolean); [d, p] = [parts[0], parts[1]]; }
  if (!d || !p) {
    const { resolveProjectForCli } = await import('./resolve.js');
    const r = await resolveProjectForCli({ project, domain, cwd });
    if (!r.ok) {
      if (json) out(JSON.stringify({ ok: false, reason: r.error || 'project_required', message: r.message }));
      note(r.message || 'No project could be resolved, and the instruction block names one.');
      return EXIT_USAGE;
    }
    d = r.domain; p = r.project;
  }
  const snip = await instructionSnippetFor(adapter.id, { domain: d, project: p });
  if (!snip.ok) {
    if (json) out(JSON.stringify(snip));
    note(snip.message);
    return EXIT_REFUSED;
  }
  if (json) out(JSON.stringify(snip));
  else out(snip.text);
  note(`Paste that block yourself — this command never writes an instruction file. ${snip.note}`);
  if (snip.files.length) note(`Files on this harness: ${snip.files.join(', ')}.`);
  return EXIT_OK;
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/**
 * Every file this module could write, for one harness — used by the suite to
 * prove that nothing outside this list is ever touched, and by a caller that
 * wants to show the target before running.
 */
export function writableTargets(id, dirs) {
  const a = adapterFor(id);
  if (!a?.hooks?.writer) return [];
  const spec = WRITERS[a.id];
  const files = [];
  for (const scope of ['user', 'project', 'local']) {
    for (const t of resolveTemplates(a.hooks.configPath?.[scope] || [], dirs)) {
      files.push(spec?.ownFile && a.hooks.perFile ? path.join(t, a.hooks.perFile) : t);
    }
  }
  return files;
}

/** The writers this build ships, by harness id. Exported for the suite. */
export const HOOK_WRITERS = Object.freeze(Object.keys(WRITERS));
