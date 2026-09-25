/**
 * `my-curator hook <event> --harness <id>` — the one place the capture policy
 * lives.
 *
 * Reads the harness's payload JSON on STDIN, writes THAT HARNESS'S response
 * JSON on STDOUT, and exits 0 unless it means to block.
 *
 * ── WHAT A HOOK MAY DO, AND WHAT IT MAY NEVER DO (Decision C) ──────────────
 * It may ASK (a turn-end nudge), INJECT (the bootstrap at session start), or
 * RECORD (a line on stderr). It may NOT compose, summarise, edit or truncate a
 * handoff, and it never calls a model. A fabricated handoff is worse than a
 * missing one: the store's contract is that what was written was written by
 * whoever the provenance names. So this command never calls `saveWorkingState`
 * — it asks the MODEL to call `save_working_state` itself, which is the only
 * way the provenance stays true.
 *
 * The capture point is the TURN END, not the session end, and that is a
 * mechanical constraint as well as a principled one: Codex's `SessionEnd` has
 * a 1 s default and a 3 s hard maximum (not an MCP round trip), Gemini CLI's
 * and Cursor's `sessionEnd` are fire-and-forget — the CLI does not wait. On
 * those three a session-end hook physically CANNOT complete a save, so
 * `session-end` here only records and exits.
 *
 * ── ONE POLICY, SEVERAL ENVELOPES ──────────────────────────────────────────
 * The harnesses disagree on the shape of "ask the model to save": Claude Code
 * BLOCKS (exit 2, reason on stderr), Cursor AUTO-CONTINUES
 * (`{"followup_message": …}`), Codex blocks on `Stop` and can refuse a
 * compaction with `{"continue": false}`, Antigravity re-enters its loop on
 * `{"decision": "continue", "reason": …}` and injects before the model with
 * `{"injectSteps": [{"ephemeralMessage": …}]}` — documented, not yet observed. The ladder below is ONE decision
 * procedure; the table owns the serialisation.
 *
 * AN UNVERIFIED ENVELOPE IS NEVER APPROXIMATED. A harness whose shape this
 * release has not measured gets `emit: null` with the reason recorded, and the
 * hook exits 0 having only written a stderr line. Emitting a shape borrowed
 * from another harness would at best be ignored and at worst be parsed as
 * something else entirely. Gemini CLI's `AfterAgent` is the named case: the
 * viable capture point is right, the envelope is unmeasured, so it ships
 * withheld until §E measures it.
 *
 * ── THE TABLE IS EXPORTED, NOT COPIED ──────────────────────────────────────
 * `HARNESS_HOOKS` is the CLI's source for which id maps to which event names
 * and which envelope. `src/cli/install-hooks.js` (package H) writes
 * `--harness <id>` into every command it installs and MUST take those ids from
 * here rather than keeping a second list: two lists of one thing is this
 * repo's most-recurring defect class, and a harness wired with an id this file
 * does not know receives nothing at all, silently.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT_OK, EXIT_USAGE, out, note, flagStr, flagBool, resolveProjectForCli } from './resolve.js';

export const HOOK_USAGE =
  'my-curator hook <session-start|stop|pre-compact|session-end> --harness <id>\n'
  + '            [--project <domain/project>] [--scope <name>] [--budget <bytes>]\n'
  + '            the harness payload arrives as JSON on stdin; the envelope leaves on stdout';

/** The deliberate block. Not an error — the one control-flow change we make. */
export const EXIT_BLOCK = 2;

/**
 * THE SENTENCE. One sentence, naming the tool and the project, and nothing
 * else: a nudge that explains itself at length is a nudge a model argues with.
 */
export function askSentence(domain, project, scope) {
  return 'Working state has not been saved this session. Call `save_working_state` for project '
    + `\`${domain}/${project}\`, scope \`${scope}\`, with the complete state, then stop.`;
}

// ─────────────────────────────────────────────────────────────────────────
// THE TABLE
//
// `emit` shapes:
//   {kind:'json', build(text)}  — stdout JSON, exit 0
//   {kind:'block'}              — exit 2, the sentence on stderr (Claude Code's
//                                 convention; Codex's `Stop` follows it, and
//                                 dsh carries `Stop` through a Claude-Code
//                                 hooks bridge, so it inherits it — marked
//                                 `inferred` because nothing has measured it)
//   null + `withheld: '<reason>'`— nothing is emitted, the reason is recorded
// ─────────────────────────────────────────────────────────────────────────
export const HARNESS_HOOKS = Object.freeze({
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    sessionStart: { emit: (text) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) },
    preCompact: { emit: (text) => ({ systemMessage: text }) },
    stop: { block: true },
    loopField: 'stop_hook_active',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    sessionStart: { emit: (text) => ({ additional_context: text }) },
    // Cursor's own docs call `preCompact` observational only — the copy says
    // so rather than implying it will be obeyed.
    preCompact: { emit: (text) => ({ user_message: text }) },
    // STRICTLY GENTLER than a block, and preferred wherever a harness offers
    // both: Claude Code's block PREVENTS the turn ending; Cursor's
    // `followup_message` SUBMITS a message, which is closer to what Decision C
    // wants. `loop_limit: 1` is written into the hook entry by install-hooks
    // (the documented default is 5, and five asks is nagging).
    stop: { emit: (text) => ({ followup_message: text }) },
    loopField: 'loop_count',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    // `SessionStart` exists, but its context-injection envelope is unmeasured.
    sessionStart: { emit: null, withheld: 'the session-start injection envelope is unverified on this harness' },
    // The ONE blocking pre-compaction hook the research found. `{"continue":
    // false}` is the documented refusal; no second key is invented for the
    // reason, which goes on stderr where nothing parses it as a contract.
    preCompact: { emit: () => ({ continue: false }), reasonOnStderr: true },
    stop: { block: true },
    loopField: 'stop_hook_active',
  },
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    sessionStart: { emit: null, withheld: 'no session-start hook is carried by the Claude-Code hooks bridge' },
    preCompact: { emit: null, withheld: 'this harness carries no pre-compaction hook' },
    // Inherited from the Claude-Code hooks bridge it implements, not measured.
    stop: { block: true, inferred: true },
    loopField: 'stop_hook_active',
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    sessionStart: { emit: null, withheld: 'the SessionStart envelope is unverified on this harness' },
    preCompact: { emit: null, withheld: 'PreCompress cannot block, and its envelope is unverified' },
    // The capture point is right — `AfterAgent`, since `SessionEnd` is
    // fire-and-forget — and the ENVELOPE is not measured. Withheld with the
    // reason until it is.
    stop: { emit: null, withheld: 'the AfterAgent envelope is unverified — it ships withheld rather than guessed' },
    loopField: null,
  },
  'copilot-cli': {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    sessionStart: { emit: null, withheld: 'the sessionStart envelope is unverified on this harness' },
    preCompact: { emit: null, withheld: 'the preCompact envelope is unverified on this harness' },
    stop: { emit: null, withheld: 'the agentStop envelope is unverified — hooks block execution, but the ask shape is unmeasured' },
    loopField: null,
  },
  goose: {
    id: 'goose',
    label: 'goose',
    sessionStart: { emit: null, withheld: 'the SessionStart envelope is unverified on this harness' },
    preCompact: { emit: null, withheld: 'this harness carries no pre-compaction hook' },
    stop: { emit: null, withheld: 'the Stop envelope is unverified on this harness' },
    loopField: null,
  },
  // v3.76.0 (W2). Both envelopes are DOCUMENTED in the vendor's hooks.md
  // (shipped inside the app, agy-customizations/docs/hooks.md) and NOT yet
  // observed firing — the adapter row says so (`measured: null`).
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    // PreInvocation, contract §3: `{"injectSteps":[{"ephemeralMessage": …}]}`
    // — "a transient system message" before the model runs. It fires before
    // EVERY model call, so `oncePerSession` injects on the first call for a
    // conversation id only; every later call gets `{}`. `ephemeralMessage`
    // rather than `userMessage`: the bootstrap is recorded DATA, and putting
    // it in the user's mouth would promote it to the user's own instruction.
    sessionStart: { emit: (text) => ({ injectSteps: [{ ephemeralMessage: text }] }), oncePerSession: true },
    preCompact: { emit: null, withheld: 'Antigravity documents no pre-compaction hook' },
    // Stop, contract §5: `"continue"` blocks the stop and re-enters the loop,
    // with `reason` injected as a system message. Only a MODEL stop is asked
    // on — forcing a loop that ended on an error or on the step limit back
    // into motion to ask for a save would be the hook making things worse.
    stop: { emit: (text) => ({ decision: 'continue', reason: text }), onlyOnTermination: ['model_stop'] },
    // No "already asked" field in the payload; the CLI's marker is the guard.
    loopField: null,
    // "Hook commands … must output their result as a JSON object on stdout."
    // Every path that emits nothing emits this instead of an empty stdout.
    emptyEnvelope: {},
  },
  cline: {
    id: 'cline',
    label: 'Cline',
    sessionStart: { emit: null, withheld: 'the session-start envelope is unverified on this harness' },
    // Accepted as a file and mapped to `undefined`, so it NEVER fires. Named
    // here so `doctor` can report an entry somebody wrote by hand.
    preCompact: { emit: null, withheld: 'Cline accepts a PreCompact hook and never fires it — an entry here would be dead' },
    stop: { emit: null, withheld: 'the TaskComplete envelope is unverified on this harness' },
    loopField: null,
  },
});

/** The canonical entry for a `--harness` value, or null. */
export function harnessEntry(id) {
  if (typeof id !== 'string' || !id) return null;
  return HARNESS_HOOKS[id.trim().toLowerCase()] || null;
}

/** Every event name a harness might call us with → our three canonical ones. */
const EVENT_ALIASES = new Map(Object.entries({
  'session-start': 'session-start', sessionstart: 'session-start', session_start: 'session-start',
  stop: 'stop', agentstop: 'stop', 'agent-stop': 'stop', afteragent: 'stop',
  taskcomplete: 'stop', 'task-complete': 'stop', turnend: 'stop', 'turn-end': 'stop',
  'pre-compact': 'pre-compact', precompact: 'pre-compact', pre_compact: 'pre-compact',
  precompress: 'pre-compact',
  'session-end': 'session-end', sessionend: 'session-end', session_end: 'session-end',
  sessionshutdown: 'session-end',
}));

export function canonicalEvent(raw) {
  if (typeof raw !== 'string') return null;
  return EVENT_ALIASES.get(raw.trim().toLowerCase().replace(/\s+/g, '')) || null;
}

/** The session-start envelope for a harness, or null when it is withheld. */
export function sessionStartEnvelope(entry, text) {
  const arm = entry?.sessionStart;
  if (!arm || typeof arm.emit !== 'function') return null;
  return arm.emit(text);
}

// ─────────────────────────────────────────────────────────────────────────
// THE CLI'S OWN LOOP GUARD
//
// Rung 1 of the ladder is the harness's own "I already asked" field, and it is
// the good one. Where a harness offers none — Codex, Copilot CLI, goose,
// Cline, dsh are all unverified on this point — this marker is the only net,
// and it is the WEAKER kind: a file under the OS temp dir keyed by the
// harness's own session id, written when we ask and removed at session start.
//
// It also carries `startedAt`, which is what bounds the usage-log window: with
// no session start there is no honest way to tell "this session did not save"
// from "this session's save is older than the log window", and the ladder
// refuses to ask rather than guess. A missing marker at `stop` MINTS one, so a
// session that began before the hook was installed is bounded from its second
// turn rather than never.
// ─────────────────────────────────────────────────────────────────────────
export function markerDir() {
  // TEST-ONLY seam, in the CURATOR_TEST_* family and unset in production. It
  // exists because this directory is the one piece of state the CLI keeps
  // OUTSIDE the fixtures a suite controls, so without it a suite's result
  // depends on markers an earlier run left behind — which is precisely how one
  // mutation in this package's battery went green: the assertion was passing
  // on a leftover file, not on the rung it named.
  const t = process.env.CURATOR_TEST_HOOK_DIR;
  if (t) return path.resolve(t);
  return path.join(os.tmpdir(), 'curator-hooks');
}

/**
 * The key carries the DOMAINS FOLDER as well as the harness and the session,
 * because a harness session id is unique to that harness and nothing more: two
 * Curator installations on one machine (a real setup — the app ships a
 * `--domains-path` flag precisely for it) would otherwise share one marker and
 * one would answer for the other's session.
 */
export function markerPathFor(harnessId, sessionKey, scopeKey = '') {
  const h = createHash('sha256')
    .update(`${harnessId}\u0000${sessionKey}\u0000${scopeKey}`)
    .digest('hex').slice(0, 16);
  return path.join(markerDir(), `${h}.json`);
}

/** The harness's own session id, under whichever name it uses. */
export function sessionKeyFrom(payload, fallback) {
  const p = payload && typeof payload === 'object' ? payload : {};
  for (const k of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId', 'chat_id']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return `no-session:${fallback || ''}`;
}

export function readMarker(file) {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

export function writeMarker(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch { return false; }
}

export function clearMarker(file) {
  try { rmSync(file, { force: true }); } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────
// WHAT THE USAGE LOG CAN TELL US
//
// Package S adds `sid`, `client` and `project` to the line and exports a
// `summariseSessions()`. Until it lands — and on any install running an older
// build — this reads the JSONL by its documented shape: six always-present
// keys plus the optional `via`. `via: 'self-test'` lines are EXCLUDED, exactly
// as `readUsage`'s two session readings exclude them: a self-test is not a
// session and saved nobody's handoff.
//
// The project filter is deliberately permissive in one direction: a line with
// NO `project` field is from a build that did not record one, and counting it
// is the fail-safe direction (it can only make us ask LESS often, never more).
// ─────────────────────────────────────────────────────────────────────────
const SAVE_TOOL = 'save_working_state';
const BOOTSTRAP_TOOLS = new Set(['get_project_context', 'get_working_state']);

export function tallyUsageLines(lines, { since, domain, project }) {
  let saves = 0; let bootstraps = 0; let anyCall = 0;
  const wanted = new Set([project, `${domain}/${project}`].filter(Boolean));
  for (const r of lines) {
    if (!r || typeof r !== 'object') continue;
    if (r.via === 'self-test') continue;
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at) || at < since) continue;
    if (r.project !== undefined && r.project !== null && !wanted.has(r.project)) continue;
    anyCall++;
    if (r.tool === SAVE_TOOL && r.ok === true && r.refused !== true) saves++;
    if (BOOTSTRAP_TOOLS.has(r.tool)) bootstraps++;
  }
  return { saves, bootstraps, anyCall };
}

/**
 * Read the usage log's raw lines — from EVERY log this machine may be writing.
 *
 * ── WHY A UNION, AND THE DEFECT IT CLOSES (v3.64.0) ────────────────────────
 *
 * This used to read `getMcpUsageLogPath()` and nothing else — the log THIS
 * process would write to. On a machine that has both a checkout and the
 * installed `.app` (the maintainer's, and every developer's) those are two
 * different files, and the one the hook could see was never the one the bridge
 * was writing. Rung 3 of the ladder ("a save landed in this session") could
 * therefore never fire, and the hook asked the model to save at the end of
 * EVERY turn, including turns that had just saved.
 *
 * `candidateUsageLogPaths()` in `src/brain/mcp-usage.js` owns the list and the
 * whole argument for it, including why an isolated test never gets the second
 * file. Reading more than one log can only make the tally larger, which can
 * only make this hook ask LESS often — the fail-safe direction it already
 * takes for a line that carries no `project`.
 *
 * ── AND THE DEAD PROBE IS GONE ─────────────────────────────────────────────
 *
 * v3.63.0 tried `summariseSessions()` first and used its answer when it
 * carried a `lines` array. It never does: that function is a PURE aggregate
 * over records returning `{sessions, totals}`, and called with no argument it
 * answers about an empty list — so the probe always fell through to the file,
 * correctly and by accident. Removed rather than repaired: an aggregate is not
 * what a ladder that needs raw lines wants, and a branch that cannot be taken
 * is a branch that cannot be tested.
 */
export async function readUsageLines() {
  let files = [];
  try {
    const usage = await import('../brain/mcp-usage.js');
    files = usage.candidateUsageLogPaths();
  } catch { return { lines: [], via: 'unavailable', files: [] }; }
  const lines = [];
  for (const file of files) {
    // Oldest generation first, so a rotated line sorts before its successors.
    for (const f of [`${file}.1`, file]) {
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        try { lines.push(JSON.parse(t)); } catch { /* a malformed line is skipped, never fatal */ }
      }
    }
  }
  return { lines, via: 'jsonl', files };
}

// ─────────────────────────────────────────────────────────────────────────
// THE LADDER — every rung is a refusal to intervene
//
// 1. The harness says it already asked                → exit 0
// 2. No project resolvable                            → exit 0
// 2b. No bounded session window                       → exit 0 (mint a marker)
// 3. A save landed for this project in this session   → exit 0
// 4. No bridge session at all in this window          → exit 0
// 5. Otherwise ASK, once, in this harness's own shape
//
// Rung 5 fires AT MOST ONCE PER TURN by construction (rung 1). Asking twice is
// how a loop starts, and that rung is non-negotiable on every harness.
// ─────────────────────────────────────────────────────────────────────────
export function stopDecision({ payload, entry, marker, facts }) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // Rung 1, in three forms: the harness's own field, the generic one every
  // Claude-Code-shaped harness sends, and our own marker.
  const loopField = entry?.loopField;
  if (p.stop_hook_active === true || p.stopHookActive === true) return { act: 'exit', rung: 1, why: 'stop_hook_active' };
  if (loopField && loopField !== 'stop_hook_active') {
    const v = p[loopField];
    if (v === true || (typeof v === 'number' && v >= 1)) return { act: 'exit', rung: 1, why: loopField };
  }
  if (marker?.askedAt) return { act: 'exit', rung: 1, why: 'already asked in this session (marker)' };
  // A harness that reports WHY its loop ended (Antigravity's
  // `terminationReason`): only a model stop is asked on. An absent field is
  // not a reason to refuse — the rest of the ladder decides.
  const only = entry?.stop?.onlyOnTermination;
  const term = p.terminationReason;
  if (Array.isArray(only) && typeof term === 'string' && term && !only.includes(term)) {
    return { act: 'exit', rung: 1, why: `the loop ended by ${term.slice(0, 40)}, not by a model stop` };
  }
  if (!facts) return { act: 'exit', rung: 2, why: 'no project resolved' };
  if (!Number.isFinite(facts.since)) return { act: 'exit', rung: 2, why: 'no session start is recorded, so the window cannot be bounded' };
  if (facts.saves > 0) return { act: 'exit', rung: 3, why: 'a save_working_state landed in this session' };
  if (facts.bootstraps === 0) return { act: 'exit', rung: 4, why: 'no bridge session for this project in this window' };
  return { act: 'ask', rung: 5, why: 'the session read state and did not save it' };
}

/**
 * Whether this invocation has put anything on stdout. A harness whose entry
 * carries `emptyEnvelope` (Antigravity: "must output … a JSON object") gets
 * that object on every path that would otherwise leave stdout empty — see
 * `runHook`. Reset at the top of every `runHook`.
 */
let emitted = false;
function send(text) { emitted = true; out(text); }

/** Emit an envelope, or record why nothing was emitted. Never throws. */
function emitFor(arm, text, label) {
  if (!arm || typeof arm.emit !== 'function') {
    note(`my-curator hook: nothing emitted for ${label} — ${arm?.withheld || 'no envelope is shipped for this event'}.`);
    return false;
  }
  send(JSON.stringify(arm.emit(text)));
  return true;
}

/**
 * The working folder the harness is in. `cwd` where the harness sends it;
 * Antigravity sends `workspacePaths` instead and runs the hook in the folder
 * holding `hooks.json` (for a user-scope install, `~/.gemini/config/`), so
 * `process.cwd()` would resolve the wrong project there.
 */
export function payloadCwd(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.cwd === 'string' && p.cwd) return p.cwd;
  if (Array.isArray(p.workspacePaths)) {
    const w = p.workspacePaths.find((x) => typeof x === 'string' && x);
    if (w) return w;
  }
  return null;
}

export async function runHook(parsed) {
  emitted = false;
  const code = await runHookInner(parsed);
  // A harness that requires a JSON object on stdout gets its empty one when
  // nothing else was emitted. An exit-2 block keeps stdout EMPTY by contract,
  // and no harness with `emptyEnvelope` blocks.
  const entry = harnessEntry(flagStr(parsed.flags, 'harness'));
  if (!emitted && code !== EXIT_BLOCK && entry?.emptyEnvelope && canonicalEvent(parsed._[0])) {
    send(JSON.stringify(entry.emptyEnvelope));
  }
  return code;
}

async function runHookInner(parsed) {
  const { flags, _ } = parsed;
  if (flagBool(flags, 'help')) { send(HOOK_USAGE); return EXIT_OK; }

  const event = canonicalEvent(_[0]);
  if (!event) {
    note(`my-curator hook: unknown event "${_[0] ?? ''}".\n${HOOK_USAGE}`);
    return EXIT_USAGE;
  }

  const harnessId = flagStr(flags, 'harness');
  const entry = harnessEntry(harnessId);
  // AN UNKNOWN HARNESS MUST NEVER RECEIVE AN ENVELOPE SHAPED FOR ANOTHER.
  // Exit 0 and emit nothing: a harness this build does not know is a harness
  // whose response shape we would be inventing.
  if (!entry) {
    note(`my-curator hook: "${harnessId || '(no --harness)'}" is not a harness this build knows. `
      + `Known: ${Object.keys(HARNESS_HOOKS).join(', ')}. Nothing was emitted.`);
    return EXIT_OK;
  }

  // The payload. A hook that cannot read its own stdin must not fail the turn.
  let payload = {};
  try {
    const { readStdin } = await import('./save.js');
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    note('my-curator hook: the payload on stdin was not readable JSON — continuing with an empty payload.');
    payload = {};
  }

  const cwd = payloadCwd(payload) || flagStr(flags, 'cwd') || process.cwd();
  const sessionKey = sessionKeyFrom(payload, cwd);
  let installKey = '';
  try { installKey = (await import('../brain/config.js')).getDomainsDir(); } catch { installKey = ''; }
  const marker = markerPathFor(entry.id, sessionKey, installKey);

  // ── session-start: inject, and never error ──────────────────────────────
  // EVERY failure here is `{}` (or nothing) and exit 0: no marker, an
  // unresolvable name, an unreadable store. A first-run user must never see an
  // error from a hook they did not ask for.
  if (event === 'session-start') {
    // A harness whose "session start" is really "before every model call"
    // (Antigravity's PreInvocation) is injected ONCE per conversation: a
    // marker that already has a start means this conversation was served.
    // Only when the harness sent a real id — with no id there is nothing to
    // key "once" on, and a missed injection is worse than a repeated one.
    if (entry.sessionStart?.oncePerSession && !sessionKey.startsWith('no-session:')) {
      const prior = readMarker(marker);
      if (prior?.startedAt) {
        note(`my-curator hook session-start (${entry.id}): already injected for this conversation. Nothing was injected.`);
        return EXIT_OK;
      }
    }
    clearMarker(marker);
    writeMarker(marker, { harness: entry.id, sessionKey, startedAt: new Date().toISOString(), askedAt: null });
    try {
      const resolved = await resolveProjectForCli({
        project: flagStr(flags, 'project'), domain: flagStr(flags, 'domain'), cwd,
      });
      if (!resolved.ok) {
        note(`my-curator hook session-start: no project was resolved (${resolved.error || 'refused'}). Nothing was injected.`);
        return EXIT_OK;
      }
      const arm = entry.sessionStart;
      if (!arm || typeof arm.emit !== 'function') {
        note(`my-curator hook session-start: ${arm?.withheld || 'no envelope is shipped for this harness'}. Nothing was injected.`);
        return EXIT_OK;
      }
      const { getProjectContext } = await import('../brain/working-state.js');
      // v3.66.0: the FRAMED rendering — the brief's authority classified by the
      // same classifier the MCP and Chat use, never assumed to be the owner's.
      const { renderFramedContextMarkdown } = await import('./context.js');
      const budget = flagStr(flags, 'budget');
      const ctx = await getProjectContext(resolved.domain, resolved.project, {
        scope: flagStr(flags, 'scope') || undefined,
        maxBytes: budget !== null ? Number(budget) : undefined,
      });
      if (!ctx.ok) {
        note(`my-curator hook session-start: the store refused the read (${ctx.reason}). Nothing was injected.`);
        return EXIT_OK;
      }
      send(JSON.stringify(arm.emit(await renderFramedContextMarkdown(ctx))));
    } catch (err) {
      note(`my-curator hook session-start: ${err.message}. Nothing was injected.`);
    }
    return EXIT_OK;
  }

  // ── session-end: record only ────────────────────────────────────────────
  // No session-end hook is installed by design: a hook cannot close a bridge
  // session in the usage log (the sid is minted inside the MCP child and the
  // hook has no handle on it), and on three harnesses it could not complete a
  // save even if it wanted to. If one is invoked anyway, it records and exits.
  if (event === 'session-end') {
    note(`my-curator hook session-end (${entry.id}): recorded. No save is driven from a session-end hook — `
      + 'the capture point is the turn end.');
    return EXIT_OK;
  }

  // ── stop / pre-compact: the ladder ──────────────────────────────────────
  const state = readMarker(marker);
  let facts = null;
  let resolved = null;
  try {
    resolved = await resolveProjectForCli({
      project: flagStr(flags, 'project'), domain: flagStr(flags, 'domain'), cwd,
    });
    if (resolved.ok) {
      const since = state?.startedAt ? Date.parse(state.startedAt) : NaN;
      if (Number.isFinite(since)) {
        const { lines } = await readUsageLines();
        facts = { since, ...tallyUsageLines(lines, { since, domain: resolved.domain, project: resolved.project }) };
      } else {
        facts = { since: NaN, saves: 0, bootstraps: 0, anyCall: 0 };
        // Self-heal: this session is bounded from its NEXT turn.
        writeMarker(marker, {
          harness: entry.id, sessionKey, startedAt: new Date().toISOString(), askedAt: null,
        });
      }
    }
  } catch (err) {
    note(`my-curator hook ${event}: ${err.message}. Nothing was asked.`);
    return EXIT_OK;
  }

  const decision = stopDecision({ payload, entry, marker: state, facts: resolved?.ok ? facts : null });
  if (decision.act !== 'ask') {
    note(`my-curator hook ${event} (${entry.id}): no ask — rung ${decision.rung}, ${decision.why}.`);
    return EXIT_OK;
  }

  const scope = flagStr(flags, 'scope') || (await latestScopeOf(resolved)) || 'main';
  const sentence = askSentence(resolved.domain, resolved.project, scope);
  writeMarker(marker, { ...(state || {}), harness: entry.id, sessionKey, askedAt: new Date().toISOString() });

  if (event === 'pre-compact') {
    const arm = entry.preCompact;
    if (arm?.reasonOnStderr) {
      // The refusal is the documented `{"continue": false}`; the sentence goes
      // on stderr rather than into an invented key on an unmeasured envelope.
      if (typeof arm.emit === 'function') send(JSON.stringify(arm.emit(sentence)));
      note(sentence);
      return EXIT_OK;
    }
    emitFor(arm, sentence, `${entry.id} pre-compact`);
    return EXIT_OK;
  }

  // stop
  const arm = entry.stop;
  if (arm?.block) {
    // Claude Code's convention: exit 2 with the reason on stderr. STDOUT STAYS
    // EMPTY — it is the envelope channel, and an exit-2 block carries no
    // envelope.
    note(sentence);
    return EXIT_BLOCK;
  }
  emitFor(arm, sentence, `${entry.id} stop`);
  return EXIT_OK;
}

/** The work-stream the agent is actually in, so the ask names the right one. */
async function latestScopeOf(resolved) {
  if (!resolved?.ok) return null;
  try {
    const { readWorkingState } = await import('../brain/working-state.js');
    const s = await readWorkingState(resolved.domain, { project: resolved.project, scope: 'latest' });
    return s.ok && typeof s.scope === 'string' && s.scope ? s.scope : null;
  } catch { return null; }
}
