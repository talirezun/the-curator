/**
 * The per-harness adapter table — one measured record per agent harness.
 *
 * PURE DATA PLUS PURE FUNCTIONS. Nothing here reads a file, spawns a process,
 * writes anything, or imports a Node builtin AT ALL. That is deliberate and
 * load-bearing: this module is imported by the CLI
 * (`src/cli/install-hooks.js`), by `scripts/test-harness-adapters.js`, and is
 * importable by a view exactly as `src/public/next/shared/agent-instructions.js`
 * is — the views are served to the browser as raw ESM with no bundler, so a
 * single `import … from 'node:path'` here would take the page down. The path
 * helpers therefore join with `/` rather than calling `path.join`, which is
 * identical on POSIX for these inputs (no `..`, no absolute segment) and has
 * NOT been exercised on Windows.
 *
 * ── WHY A TABLE AT ALL ─────────────────────────────────────────────────────
 * Thirteen harnesses were researched for v3.63.0 and TEN of them have some
 * lifecycle hook — but they disagree on the event names, on the config file,
 * on the file FORMAT, and on the shape of "ask the model to save". Worse,
 * three of them accept a hook that does nothing: Cline's `PreCompact` is
 * accepted as a file and maps to `undefined`, so it never fires; Codex's
 * `SessionEnd` caps at 3 s, which is not an MCP round trip; Gemini CLI's
 * `SessionEnd` is fire-and-forget. A naive adapter would have written all
 * three and shipped a feature that does nothing, silently, on three harnesses.
 * So "exists and is useless" has to be REPRESENTABLE, which is why
 * `hooks.state` is four words and not a boolean.
 *
 * ── EVERY FACT CARRIES ITS PROVENANCE, AND `verified` IS NOT A DECORATION ──
 * Each fact block (`mcpConfig`, `instructionFile`, `hooks`, `skillsTree`,
 * `clientInfo`) carries `source` and `verified`. `verified` is true ONLY for
 * `source: 'source' | 'docs' | 'observed' | 'repo'`; `community` and
 * `unverified` are both FALSE, because a community report is not a
 * measurement — the design record names `cursor-vscode` and `claude-code`'s
 * client labels as community-reported and says in terms that they must not be
 * seeded anywhere as settled. A consumer that wants to make a claim about a
 * harness reads `verified` first.
 *
 * `measured` is `null` on every entry EXCEPT `claude-code` (v3.64.0, package
 * M): §E's protocol has now been run once, against a real harness, and that
 * one row carries the result. A harness with no measurement row renders as
 * NOT MEASURED everywhere it appears — that is still true for the other
 * fourteen, and `measured: null` is what makes it true without a second flag.
 *
 * An entry MAY also carry `observations`: a frozen array of plain sentences
 * recording single live sessions that were NOT the §E protocol (no arms, no
 * counts). They are printed verbatim and never promoted into `measured` —
 * one session is an anecdote with a date, not a shape (Antigravity, v3.76.0).
 *
 * ── THE SHAPE OF A NON-NULL `measured` ──────────────────────────────────────
 * No shape existed before this release, so this is it — PURE DATA, no
 * functions, and every number is a COUNT out of a stated `n`, never a
 * percentage (CLAUDE.md's rule for this campaign: "no percentages anywhere —
 * N=4 is a shape"). A future measurement pass (a second harness, a repeat run)
 * fills the same shape; it does not invent a new one.
 *
 *   {
 *     date,               'YYYY-MM-DD' — the day the protocol was run.
 *     harnessVersion,     the harness's own version string, verbatim.
 *     model,              the model id the harness ran, verbatim.
 *     n,                  runs per arm (the 2026-09-10 shape's N — a shape,
 *                         not a statistical sample size).
 *     protocol,           one sentence: launch mode, auth, the allow-list —
 *                         enough that a re-run can be compared to this one.
 *     arms: {             one entry per arm actually run, keyed by its
 *                         letter; an arm not run is simply absent, never
 *                         zeroed — absence and a real zero must stay
 *                         distinguishable.
 *       <letter>: {
 *         sessions,        runs attempted in this arm (out of `n`).
 *         read,            of those, how many read state via an MCP tool
 *                         call (`get_project_context`/`get_working_state`)
 *                         before doing anything else.
 *         readViaHook,     of those, how many received state via hook
 *                         injection instead (invisible to the usage log —
 *                         see `notes`; 0 on an arm with no hooks installed).
 *         saved,           of those, how many saved via a real MCP
 *                         `save_working_state` call before stopping.
 *         skillActivated,  of those, how many the transcript shows the
 *                         continuity skill actually firing in.
 *       },
 *       …
 *     },
 *     verdicts: { <letter>: 'not-measured'|'measured-no'|'measured-partial'|'measured-yes', … },
 *                         the EXACT word `scripts/measure-harness.js` printed
 *                         for that arm's window — never re-derived here, so
 *                         this table and the instrument can never quietly
 *                         disagree about what a run was called.
 *     notes,              an array of short, plain sentences: the caveats a
 *                         reader must have alongside the numbers above to not
 *                         over-read them — an instrument limitation, a
 *                         mechanism finding, anything that changes what a
 *                         count is allowed to claim. Prose, not data a
 *                         consumer should branch on.
 *   }
 *
 * ── WHAT THIS MODULE DOES NOT DO ───────────────────────────────────────────
 *   - It never composes the bridge's launch line. `mcpEntryFor(id, launch)`
 *     takes `{command, args}` from the caller, which gets it from
 *     `buildCuratorEntry()` in `src/routes/mcp.js` — THE one launch line
 *     (v3.6.1's recorded defect was a second one). A second launch line built
 *     here would be that defect with a new address, and importing the route
 *     module would pull Express into a CLI's startup and into a browser.
 *   - It never hand-writes prose a model reads. `instructionSnippetFor()`
 *     DERIVES its text from `composeAgentInstructionsFull()` — Decision J,
 *     and this repository's most reliably recurring defect class. The only
 *     strings this module authors are addressed to a HUMAN: which file to
 *     paste into on this harness, and why a refusal happened.
 *   - It never writes. Writing hooks is `src/cli/install-hooks.js`.
 *
 * ── THE TWO TABLES THIS ONE HAS TO AGREE WITH, AND HOW THAT IS ENFORCED ────
 * `src/cli/doctor.js` already carries harness config PATHS (`harnessTargets`)
 * and `src/cli/hook.js` already carries the ENVELOPES (`HARNESS_HOOKS`). Both
 * are package C's files and are not edited here. Two hand-maintained copies of
 * one thing is the defect this repository records most often, so the
 * duplication is made NON-SILENT rather than tolerated:
 * `scripts/test-harness-adapters.js` §4 resolves this table's paths against the
 * same fixture home/cwd and requires SET EQUALITY with `harnessTargets()`, and
 * §5 requires every id and event in `HARNESS_HOOKS` to exist here with the same
 * envelope class. A drift reds the suite on the next run.
 *
 * THE SEAM THIS LEAVES OPEN, STATED: the right end state is that `doctor.js`
 * imports `harnessTargets` from THIS file. That edit is package C's to make
 * and was not made here.
 *
 * Line references below point into the v3.63.0 design record
 * (`DESIGN-capture-v3.63.0.md`), §2 per harness and §2.11's matrix.
 */
// ─────────────────────────────────────────────────────────────────────────
// VOCABULARIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * The FOUR states of a harness's hook mechanism. Four, not two, because the
 * research found four genuinely different situations and collapsing any two
 * would make the table lie in the user's favour:
 *
 *   verified         a hook mechanism exists, takes a shell command, and the
 *                    response envelope for at least one usable event is
 *                    measured or documented — an adapter can wire it.
 *   unverified       a hook mechanism exists and takes a shell command, but
 *                    the envelope, the config path, or both are unmeasured.
 *                    An entry MAY be written; what it can emit is decided by
 *                    `HARNESS_HOOKS`, never guessed at here.
 *   present-useless  hooks exist and CANNOT carry the ask: OpenCode and Kilo
 *                    take TypeScript plugins, not shell commands; Windsurf has
 *                    twelve hooks and not one of them is a stop, session-end
 *                    or pre-compaction hook.
 *   none             no hook mechanism at all (Zed, #57890; Aider; Claude
 *                    Desktop).
 *
 * NOTE ON A DIVERGENCE, since it will look like an error otherwise. The design
 * record's §B.1/§B.3 names its four states `null` / `plugin-only` /
 * `exists-unverified` / a real config. This table uses the four WORDS above,
 * which is the vocabulary the build contract fixed. The mapping is exact:
 * `null` → `none`, `plugin-only` → `present-useless` + `mechanism:
 * 'ts-plugin'`, `exists-unverified` → `unverified`, a real config →
 * `verified`. Windsurf moves from the record's `null` to `present-useless`,
 * which is strictly more accurate: it HAS twelve hooks, and saying it has none
 * would be a second way to be wrong about it.
 */
export const HOOK_STATES = Object.freeze({
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  PRESENT_USELESS: 'present-useless',
  NONE: 'none',
});

const HOOK_STATE_VALUES = Object.freeze(Object.values(HOOK_STATES));

/** The class the PRODUCT shows — §2.11's last table. */
export const CAPTURE_CLASSES = Object.freeze({
  HOOK_ASSISTED: 'hook-assisted',
  PLUGIN_ONLY: 'plugin-only',
  ADVISORY_ONLY: 'advisory-only',
  OUT_OF_REACH: 'out-of-reach',
});

/**
 * Where a fact came from. `community` counts as NOT verified — the design
 * record says so by name for `cursor-vscode` and `claude-code`, and Copilot
 * CLI moving its own client label inside six months is the reason.
 */
export const FACT_SOURCES = Object.freeze(['source', 'docs', 'observed', 'repo', 'community', 'unverified']);
const VERIFIED_SOURCES = new Set(['source', 'docs', 'observed', 'repo']);

/** `verified` is DERIVED from `source`, so the two can never disagree. */
function fact(source, rest) {
  if (!FACT_SOURCES.includes(source)) throw new Error(`harness-adapters: unknown fact source "${source}"`);
  return Object.freeze({ source, verified: VERIFIED_SOURCES.has(source), ...rest });
}

/** The MCP server's name, and the `--harness` id, are both hyphenated. */
export const MCP_SERVER_NAME = 'my-curator';

/**
 * Gemini CLI's policy parser REJECTS a server alias containing an underscore
 * (§2.3). `my-curator` is safe; a future rename to `my_curator` would break
 * that one harness silently, so the rule is asserted rather than remembered.
 */
export const ALIAS_MUST_NOT_CONTAIN = '_';

// Path templates. `H` is under the user's home, `P` under the project root.
// They are TEMPLATES, not paths: nothing is resolved until a caller supplies a
// home and a cwd, which is what lets a test resolve them against a fixture.
const H = (...segments) => Object.freeze({ base: 'home', segments: Object.freeze(segments) });
const P = (...segments) => Object.freeze({ base: 'project', segments: Object.freeze(segments) });

/** A path template → an absolute path, against a supplied home and project root. */
export function resolveTemplate(tpl, { home = '', project = '' } = {}) {
  if (!tpl || typeof tpl !== 'object' || !Array.isArray(tpl.segments)) return null;
  const base = tpl.base === 'home' ? home : project;
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}/${tpl.segments.join('/')}`;
}

/** Every path template in a list → absolute paths, dropping what cannot resolve. */
export function resolveTemplates(list, dirs) {
  return (Array.isArray(list) ? list : []).map((t) => resolveTemplate(t, dirs)).filter(Boolean);
}

/** A template rendered for a HUMAN: `~/.claude/settings.json`, `.claude/settings.json`. */
export function displayTemplate(tpl) {
  if (!tpl) return '';
  const rel = tpl.segments.join('/');
  return tpl.base === 'home' ? `~/${rel}` : rel;
}

// ─────────────────────────────────────────────────────────────────────────
// THE TABLE
//
// Fifteen entries. The design record's §B.3 ships thirteen; `claude-desktop`
// is the fourteenth and it is here because it is a real MCP client this
// repository already wires (`src/routes/mcp.js`'s whole wizard is addressed to
// it) and because `doctor.js`'s own target list carries it. It has NO hooks
// and NO project instruction file, which is exactly what its row says.
// `antigravity` is the fifteenth (v3.76.0), from the vendor's own docs.
// ─────────────────────────────────────────────────────────────────────────
const ENTRIES = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    // Not in the record's §B.3 table; carried because this repo already writes
    // this file (routes/mcp.js:44-50) and doctor.js lists both paths.
    mcpConfig: fact('repo', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [
        H('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        H('.config', 'Claude', 'claude_desktop_config.json'),
      ],
      project: [],
    }),
    instructionFile: fact('repo', { names: [], cap: null, firstMatch: false, note: 'Claude Desktop reads no per-project instruction file; the block belongs in a project on the desktop app.' }),
    hooks: fact('repo', { state: HOOK_STATES.NONE, reason: 'Claude Desktop has no hook mechanism.', events: {}, refusedEvents: {}, envelope: null, loopGuard: null, writer: null, configPath: { user: [], project: [], local: [] }, format: null }),
    skillsTree: fact('repo', { path: '~/.claude/skills' }),
    captureClass: CAPTURE_CLASSES.ADVISORY_ONLY,
    clientInfo: fact('community', { names: ['claude-ai'], note: 'An MCP log elsewhere carries `claude-ai` for Claude Desktop. Never conflate it with Claude Code — a different surface (§2.13).' }),
    measured: null,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    // §2.1 (216-240). 33 hook events; Stop BLOCKS; SessionStart injects but
    // NOT via MCP — "SessionStart fires before the servers are available" —
    // which is the sentence the `my-curator` command exists because of.
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [H('.claude.json')],
      project: [P('.mcp.json')],
    }),
    instructionFile: fact('docs', { names: ['CLAUDE.md'], cap: null, firstMatch: false, note: null }),
    hooks: fact('docs', {
      state: HOOK_STATES.VERIFIED,
      reason: null,
      // Canonical event key → this harness's own event name.
      events: { 'session-start': 'SessionStart', 'pre-compact': 'PreCompact', stop: 'Stop' },
      // Events that EXIST and are deliberately NOT written, with the measured
      // reason, so `doctor` can name one it finds and a reader sees the choice.
      refusedEvents: {
        SessionEnd: 'a hook cannot close a bridge session it has no handle on — the sid is minted inside the MCP child',
      },
      envelope: 'exit2',
      loopGuard: 'stop_hook_active',
      writer: 'claude-code',
      format: 'json',
      configPath: {
        user: [H('.claude', 'settings.json')],
        project: [P('.claude', 'settings.json')],
        local: [P('.claude', 'settings.local.json')],
      },
      // The entry shape is documented (type/command/timeout/statusMessage).
      shapeVerified: true,
    }),
    skillsTree: fact('docs', { path: '~/.claude/skills' }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    // Observed 2026-09-20 (package M's campaign): every session line in the
    // real usage log carried the literal `claude-code`, with no other label
    // ever appearing in the window. Moved from `community` — flip only,
    // nothing else in this fact changes.
    clientInfo: fact('observed', { names: ['claude-code'], note: 'Observed 2026-09-20 on every session line in the campaign\'s usage-log window; no other label appeared.' }),
    // Measured 2026-09-20 (package M). See the module's own header comment
    // for the shape, and MEASUREMENT-claude-code-2026-09-20.md (outside this
    // repo, the campaign's own handoff folder) for the full per-run table and
    // findings this is transcribed from — these are that report's own
    // numbers, not a re-derivation.
    measured: Object.freeze({
      date: '2026-09-20',
      harnessVersion: '2.1.275',
      model: 'claude-haiku-4-5-20251001',
      n: 4,
      protocol: 'Claude Code CLI headless `-p` (--output-format stream-json --verbose '
        + '--max-turns 40 --no-session-persistence), launched from the desktop-app bundle\'s '
        + 'binary, API-key auth (not OAuth), a fixed --allowedTools allow-list, one neutral '
        + 'task per run with no instruction to save and no mention of The Curator.',
      arms: Object.freeze({
        c: Object.freeze({ sessions: 4, read: 1, readViaHook: 4, saved: 4, skillActivated: 2 }),
        b: Object.freeze({ sessions: 4, read: 0, readViaHook: 0, saved: 0, skillActivated: 1 }),
        a: Object.freeze({ sessions: 4, read: 1, readViaHook: 0, saved: 1, skillActivated: 3 }),
      }),
      verdicts: Object.freeze({ c: 'measured-partial', b: 'not-measured', a: 'measured-partial' }),
      notes: Object.freeze([
        'All 12 core runs (arms C, B, A) plus both compaction-probe calls left `npm test` green — task completion and memory-layer engagement are independent variables in this dataset.',
        'Arm C (skill + block + hooks): the SessionStart hook injects the standing brief, latest handoff and journal as additionalContext before the agent\'s first turn, so 3 of 4 sessions never called a read tool at all — they still started with state, just not via a tool call the usage log can see. `read: 1` undercounts arm C\'s actual continuity behaviour for this reason; it is not a bug in the instrument, it is the instrument\'s stated read-tool-only definition.',
        'Stop hooks do not fire in headless `-p` mode at all — confirmed across all 6 arm-C sessions (the 4 core runs plus the compaction probe and its resume): every one shows only the two SessionStart hook events and nothing else; the on-disk loop-guard markers all show `askedAt: null`.',
        '`/compact` under `-p --resume` DOES fire PreCompact, but with no hook_started/hook_response pair — the only trace is an embedded `<local-command-stdout>` block inside a user-role message reading "Compacted PreCompact […] completed successfully".',
        'Without the SessionStart hook (arms B and A), in 5 of 6 save attempts the agent found `save_working_state` by ToolSearch and then, instead of issuing a real tool_use call, fabricated a shell command or script named after the tool (e.g. `Bash({command: "mcp call my-curator save_working_state …"})`, a fake shell function wrapping the tool\'s own name, or a JSON payload written to a file and never sent anywhere) — the dominant, unpredicted finding of this campaign.',
        'Arm B (skill + block, no hooks): zero MCP bridge sessions were logged across all 4 runs — every attempt failed before a real tool call reached the bridge, so `not-measured` here means "no session ever started", not "sessions started and failed to save".',
        'Two limits of this instrument at measurement time, both named so a reader does not over-read the counts above: (1) a bridge process that never receives a real tool call writes no session line at all, so a failed attempt like arm B\'s is invisible to the log as anything other than silence; (2) arm C\'s hook-injected read happens before the MCP servers are available to the agent and is therefore not a tool call the usage log can record — see the arm-C note above.',
        '3 of 14 sessions (one each in arms C, B and A) committed straight to the fixture\'s own git history unprompted — the task never mentioned version control — which is itself a finding about what an unprompted agent reaches for when the memory layer is not in front of it via a hook.',
      ]),
    }),
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    // §2.2 (241-262). The TIMEOUTS are the finding: SessionEnd is 1 s default
    // / 3 s MAX — not an MCP round trip — while Stop has 600 s and PreCompact
    // can BLOCK. That inverts the naive mapping, which is why it is in the
    // table rather than left to a user to discover.
    mcpConfig: fact('docs', {
      format: 'toml',
      shape: 'mcp_servers',
      key: 'mcp_servers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env_vars',
      // The vendor command exists and is PREFERRED over merging TOML by hand:
      // this package ships no TOML parser and a hand-merge of a file it cannot
      // read is Decision L's exact failure.
      addCommand: 'codex mcp add',
      // `startup_timeout_sec`, NOT `startup_timeout_ms` — an easy, silent
      // mis-write named in §2.2.
      timeoutKey: 'startup_timeout_sec',
      user: [H('.codex', 'config.toml')],
      project: [P('.codex', 'config.toml')],
    }),
    instructionFile: fact('docs', {
      names: ['AGENTS.md'],
      // §2.12, measured: the instruction BLOCK (1,562 bytes) fits with room to
      // spare; the neutral playbook (63,500 bytes, 53,195 with --core) is 1.9x
      // this cap and would be truncated mid-document, silently.
      cap: 32 * 1024,
      firstMatch: false,
      note: null,
    }),
    hooks: fact('docs', {
      state: HOOK_STATES.UNVERIFIED,
      reason: 'the hook FILE and its events are documented; the entry shape inside it is not measured',
      events: { 'pre-compact': 'PreCompact', stop: 'Stop' },
      refusedEvents: {
        SessionEnd: 'a 1 s default and a 3 s hard maximum — not an MCP round trip, so a save cannot be driven from it even in principle',
        SessionStart: 'the session-start injection envelope is unverified on this harness',
      },
      envelope: 'exit2',
      loopGuard: 'stop_hook_active',
      writer: 'codex',
      format: 'json',
      configPath: {
        user: [H('.codex', 'hooks.json')],
        project: [P('.codex', 'hooks.json')],
        local: [],
      },
      shapeVerified: false,
      // 600 s on Stop is the documented budget; the entry asks for far less.
      timeoutSeconds: { stop: 600, 'pre-compact': 30 },
    }),
    skillsTree: fact('unverified', { path: null, note: 'Whether Codex has a skills tree is unverified, and it decides whether Codex gets the full playbook or the block alone (§2.12).' }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('source', { names: ['codex-mcp-client'] }),
    measured: null,
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    // §2.3 (263-282). SessionEnd is fire-and-forget (the CLI does not wait)
    // and PreCompress cannot block, so neither event a designer reaches for
    // first can carry a save. `AfterAgent` is the viable capture point — and
    // its envelope is UNMEASURED, so it ships withheld rather than guessed.
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      timeoutKey: 'timeout',
      user: [H('.gemini', 'settings.json')],
      project: [P('.gemini', 'settings.json')],
    }),
    instructionFile: fact('docs', {
      names: ['GEMINI.md'],
      cap: null,
      firstMatch: false,
      fromSetting: 'context.fileName',
      note: 'The file is named by `context.fileName` — NESTED, and an ARRAY, replacing the old flat `contextFileName`. `AGENTS.md` is opt-in and not read by default.',
    }),
    hooks: fact('docs', {
      state: HOOK_STATES.UNVERIFIED,
      reason: 'the events are documented; every response envelope is unmeasured, so this build emits none of them',
      events: { stop: 'AfterAgent' },
      refusedEvents: {
        SessionEnd: 'fire-and-forget — the CLI does not wait for it, so it cannot complete a save',
        PreCompress: 'cannot block, and its envelope is unverified',
      },
      envelope: 'unverified',
      loopGuard: 'cli-marker',
      // No writer in this build: the one usable event's envelope is withheld
      // in `HARNESS_HOOKS`, so an entry here would invoke a command that emits
      // nothing — present and useless, the exact outcome this table exists to
      // make impossible.
      writer: null,
      format: 'json',
      configPath: {
        user: [H('.gemini', 'settings.json')],
        project: [P('.gemini', 'settings.json')],
        local: [],
      },
      shapeVerified: false,
    }),
    skillsTree: fact('unverified', { path: null }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('source', { names: ['gemini-cli-mcp-client'] }),
    measured: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    // Added v3.76.0 (W2). Google's agent app (and its IDE variant). Every fact
    // below is from the vendor's OWN customization docs, shipped inside the
    // app at `~/.gemini/antigravity/builtin/skills/agy-customizations/`
    // (SKILL.md, docs/{rules,skills,plugins,hooks,mcp_servers,json_configs}.md),
    // read 2026-09-25, plus what was seen on the maintainer's Mac that day.
    //
    // THE MCP FILE IS THREE FILES. The docs name `~/.gemini/config/
    // mcp_config.json` as the global one; the maintainer's Mac also carries
    // `~/.gemini/antigravity/mcp_config.json` and (for the IDE)
    // `~/.gemini/antigravity-ide/mcp_config.json` — three separate files, not
    // links, each naming `my-curator`. Doctor reports all three, because a
    // bridge configured in one and stale in another is exactly the drift a
    // user cannot see.
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [
        H('.gemini', 'config', 'mcp_config.json'),
        H('.gemini', 'antigravity', 'mcp_config.json'),
        H('.gemini', 'antigravity-ide', 'mcp_config.json'),
      ],
      project: [],
      note: 'The docs name ~/.gemini/config/mcp_config.json; ~/.gemini/antigravity/ and ~/.gemini/antigravity-ide/ '
        + 'each held their own mcp_config.json on the maintainer\'s Mac on 2026-09-25 (observed, three separate files).',
    }),
    // rules.md: `GEMINI.md` and `AGENTS.md`, walked up from the working
    // directory to the repository root, no frontmatter, always on for their
    // directory. NOT `CLAUDE.md` — measured 2026-09-25: the session that read
    // state unprompted had the block in AGENTS.md. Each rule file is capped at
    // 24,000 bytes after includes are expanded and truncated on a line
    // boundary past it.
    instructionFile: fact('docs', {
      names: ['AGENTS.md', 'GEMINI.md'],
      cap: 24000,
      firstMatch: false,
      note: 'Antigravity reads AGENTS.md and GEMINI.md walking up from the working folder to the repository root — not CLAUDE.md.',
    }),
    hooks: fact('docs', {
      // `verified` in this table's sense: the envelopes are DOCUMENTED
      // (hooks.md's input/output contract), so an adapter can wire them. It
      // does NOT mean a run was observed — `measured` stays null and
      // `shapeVerified` false until the maintainer runs them.
      state: HOOK_STATES.VERIFIED,
      reason: null,
      // PreInvocation fires before EVERY model call, not once per session.
      // `firstInvocationOnly` is what makes it a session start: the CLI
      // injects on the first call it sees for a conversation id and emits
      // `{}` for every later one (src/cli/hook.js, `oncePerSession`).
      events: { 'session-start': 'PreInvocation', stop: 'Stop' },
      firstInvocationOnly: true,
      refusedEvents: {
        PostInvocation: 'it fires after every round of tool calls, not once at the turn end — an ask there would repeat through the turn',
        PreToolUse: 'a tool gate, not a lifecycle point — it cannot carry a session-start read or a turn-end ask',
      },
      // hooks.md §5: `{"decision":"continue","reason":…}` blocks the stop and
      // injects `reason` as a system message; §3: `injectSteps:
      // [{ephemeralMessage}]` injects before the model runs.
      envelope: 'decision-continue',
      // No "I already asked" field in the Stop payload, so the CLI's own
      // marker (keyed on `conversationId`) is the loop guard.
      loopGuard: 'cli-marker',
      writer: 'antigravity',
      format: 'json',
      // A hooks.json whose TOP-LEVEL keys are hook NAMES, each holding its
      // events; PreInvocation and Stop take a FLAT list of handlers. The
      // Curator's handlers live under one name, `my-curator`.
      fileShape: 'named-hooks',
      hookName: MCP_SERVER_NAME,
      configPath: {
        // A hooks.json sits in a customization root: `.agents/` in the
        // project (documented by example), `~/.gemini/config/` globally
        // (the documented global root; hooks.json there is inferred from
        // "your customization root directory", not shown by example).
        user: [H('.gemini', 'config', 'hooks.json')],
        project: [P('.agents', 'hooks.json')],
        local: [],
      },
      shapeVerified: false,
      // hooks.md: the default is 30 s. Session start reads the store once;
      // every later invocation only checks a marker.
      timeoutSeconds: { 'session-start': 30, stop: 30 },
    }),
    // skills.md + plugins.md: a skill is `skills/<name>/SKILL.md` inside a
    // customization root, or inside `plugins/<plugin>/` under one. The
    // maintainer's install is `~/.gemini/config/plugins/the-curator/skills/`.
    // `roots` is what `my-curator doctor` walks, looking for
    // `<root>/skills/<skill>/` and `<root>/plugins/*/skills/<skill>/`.
    skillsTree: fact('docs', {
      path: '~/.gemini/config/plugins/<plugin>/skills/',
      roots: [H('.gemini', 'config'), P('.agents')],
      note: 'Also .agents/skills/ (or .agents/plugins/<plugin>/skills/) in a workspace.',
    }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    // NOT IDENTIFIED. Its sessions log as `other`. The language server is a Go
    // binary that speaks the 2026-07-28 MCP revision (the per-request
    // `io.modelcontextprotocol/clientInfo` key is present in it), but the name
    // it sends was not recoverable from the binary and no log on the Mac
    // records it. How to read it once is in docs/working-state.md; nothing
    // may be seeded here until it has been SEEN.
    clientInfo: fact('unverified', {
      names: [],
      note: 'Not identified — Antigravity\'s sessions are labelled `other` in the usage log until the name it sends has been observed.',
    }),
    measured: null,
    // Single live sessions on the maintainer's Mac, 2026-09-25 — NOT the §E
    // protocol, so they are not a `measured` row and carry no counts. Printed
    // verbatim by `my-curator doctor`.
    observations: Object.freeze([
      '2026-09-25 · with the Curator block in AGENTS.md, a session told only "Continue." called get_project_context unprompted.',
      '2026-09-25 · without the AGENTS.md block, a session saved unprompted — but to scope `main`, replacing another tool\'s handoff there.',
      'The hooks (PreInvocation read, Stop ask) are built from the vendor documentation and have NOT been run yet.',
    ]),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    // §2.4 (283-294). `stop` -> `followup_message`, auto-submitted back to the
    // agent and bounded by `loop_limit` (default 5 — we write 1, because one
    // ask per turn is the whole intent and five would nag).
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      // `type: "stdio"` is REQUIRED alongside `command` on this harness.
      requiresType: 'stdio',
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [H('.cursor', 'mcp.json')],
      project: [P('.cursor', 'mcp.json')],
    }),
    instructionFile: fact('docs', { names: ['.cursor/rules', 'AGENTS.md'], cap: null, firstMatch: false, note: 'Cursor reads AGENTS.md as well as .cursor/rules.' }),
    hooks: fact('docs', {
      state: HOOK_STATES.VERIFIED,
      reason: null,
      events: { 'session-start': 'sessionStart', 'pre-compact': 'preCompact', stop: 'stop' },
      refusedEvents: {
        sessionEnd: 'fire-and-forget — the CLI does not wait for it',
      },
      // STRICTLY GENTLER than a block and preferred wherever a harness offers
      // both: a block PREVENTS the turn ending, a followup_message SUBMITS a
      // message, which is closer to what Decision C wants.
      envelope: 'followup-message',
      loopGuard: 'loop_limit',
      loopLimit: 1,
      writer: 'cursor',
      format: 'json',
      configPath: {
        user: [H('.cursor', 'hooks.json')],
        project: [P('.cursor', 'hooks.json')],
        local: [],
      },
      shapeVerified: false,
    }),
    skillsTree: fact('docs', { path: '~/.claude/skills', note: 'Cursor reads ~/.claude/skills, so an Agent-Skills install reaches it.' }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('community', { names: ['cursor-vscode'], note: 'Community-reported only, not documented (§2.13).' }),
    measured: null,
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    // §2.5 (295-310). The richest lifecycle surface — sessionEnd, agentStop
    // AND preCompact all exist, the only harness of the thirteen with all
    // three; "hooks run synchronously and block agent execution". It is also
    // the first observed NEW-ERA MCP client: it sends `server/discover` before
    // `initialize` (issue #4888).
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [H('.copilot', 'mcp-config.json')],
      project: [P('.github', 'mcp.json'), P('.mcp.json')],
    }),
    instructionFile: fact('docs', { names: ['CLAUDE.md', 'GEMINI.md'], cap: null, firstMatch: false, note: 'Copilot CLI reads CLAUDE.md and GEMINI.md as well as its own instructions file.' }),
    hooks: fact('docs', {
      state: HOOK_STATES.UNVERIFIED,
      reason: 'the events are documented and block synchronously; the ask SHAPE is unmeasured',
      events: { 'session-start': 'sessionStart', 'pre-compact': 'preCompact', stop: 'agentStop' },
      refusedEvents: {},
      envelope: 'unverified',
      loopGuard: 'cli-marker',
      writer: 'copilot-cli',
      format: 'json',
      // A DIRECTORY of JSON files, not one file — the whole file is ours.
      perFile: 'curator.json',
      configPath: {
        user: [H('.copilot', 'hooks')],
        project: [P('.github', 'hooks')],
        local: [],
      },
      shapeVerified: false,
    }),
    skillsTree: fact('docs', { path: '.agents/skills/' }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('docs', {
      names: ['copilot-cli', 'github-copilot-developer'],
      note: 'It moved from `github-copilot-developer` to `copilot-cli` inside six months — many-to-one, and the argument for never branching on the value.',
    }),
    measured: null,
  },
  {
    id: 'cline',
    label: 'Cline',
    // §2.6 (311-324). A hook file that is ACCEPTED and never fires: PreCompact
    // maps to `undefined`. The docs say ~/.cline/mcp.json; the SOURCE says the
    // settings path. Source wins, and both are checked.
    mcpConfig: fact('source', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: 'stdio',
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [H('.cline', 'data', 'settings', 'cline_mcp_settings.json'), H('.cline', 'mcp.json')],
      project: [],
    }),
    instructionFile: fact('unverified', { names: [], cap: null, firstMatch: false, note: 'Which instruction file Cline reads is unverified.' }),
    hooks: fact('unverified', {
      state: HOOK_STATES.UNVERIFIED,
      reason: 'the hook configuration PATH for this harness is not measured — writing to a guessed path is how a feature ships doing nothing',
      events: { stop: 'TaskComplete', 'session-end': 'SessionShutdown' },
      refusedEvents: {
        PreCompact: 'Cline accepts a PreCompact hook and maps it to `undefined`, so it NEVER fires — an entry here would be dead',
      },
      envelope: 'unverified',
      loopGuard: 'cli-marker',
      writer: null,
      format: null,
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('unverified', { path: null }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('source', {
      names: ['Cline', '@cline/core'],
      note: 'One product, two values — `Cline` from VS Code, `@cline/core` from the SDK/CLI. The reason the allow-list maps values MANY-to-one.',
    }),
    measured: null,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    // §2.10 (355-368). Hooks are TYPESCRIPT PLUGINS, not shell commands. The
    // MCP entry takes `command` as ONE argv array and the env key is
    // `environment`, not `env`. Measured 4/4 self-activating.
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcp',
      key: 'mcp',
      requiresType: 'local',
      argvShape: 'single-array',
      envKey: 'environment',
      addCommand: null,
      user: [H('.config', 'opencode', 'opencode.json')],
      project: [P('opencode.json')],
    }),
    instructionFile: fact('docs', { names: ['AGENTS.md', 'CLAUDE.md'], cap: null, firstMatch: false, note: 'Read walking up from cwd.' }),
    hooks: fact('docs', {
      state: HOOK_STATES.PRESENT_USELESS,
      mechanism: 'ts-plugin',
      reason: 'hooks here are TypeScript plugins (`session.idle`, `experimental.session.compacting`), not shell commands — there is nothing for a config writer to write',
      events: {},
      refusedEvents: { 'session.idle': 'a TypeScript plugin entry point, not a shell command' },
      envelope: null,
      loopGuard: null,
      writer: null,
      format: null,
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('docs', { path: '.agents/skills/' }),
    captureClass: CAPTURE_CLASSES.PLUGIN_ONLY,
    clientInfo: fact('docs', { names: ['opencode'] }),
    measured: null,
  },
  {
    id: 'goose',
    label: 'goose',
    // §2.10. TRUE SessionEnd and Stop SHELL hooks — the best fit of the
    // thirteen for a shell-command capture hook. The hook file is
    // `hooks.json`; goose's field vocabulary is `cmd` / `args` / `envs`.
    mcpConfig: fact('docs', {
      format: 'yaml',
      shape: 'extensions',
      key: 'extensions',
      requiresType: 'stdio',
      argvShape: 'command+args',
      envKey: 'envs',
      addCommand: null,
      user: [H('.config', 'goose', 'config.yaml')],
      project: [],
    }),
    instructionFile: fact('unverified', { names: [], cap: null, firstMatch: false, note: 'Which instruction file goose reads is unverified.' }),
    hooks: fact('docs', {
      state: HOOK_STATES.UNVERIFIED,
      reason: 'the events and the file are documented; the response envelope is unmeasured',
      events: { stop: 'Stop', 'session-end': 'SessionEnd' },
      refusedEvents: {},
      envelope: 'unverified',
      loopGuard: 'cli-marker',
      writer: 'goose',
      // The FILE is `hooks.json` and is parsed as JSON. The design record
      // describes it as "YAML `cmd`/`args`/`envs`", which is goose's FIELD
      // vocabulary, not the file's syntax — the path it gives ends `.json`.
      // Writing YAML into a `.json` file on the strength of that sentence
      // would be a guess that breaks the harness, so the fields are goose's
      // and the syntax is the extension's.
      format: 'json',
      fieldStyle: 'cmd-args-envs',
      configPath: {
        user: [H('.agents', 'plugins', MCP_SERVER_NAME, 'hooks', 'hooks.json')],
        project: [],
        local: [],
      },
      shapeVerified: false,
    }),
    skillsTree: fact('docs', { path: '.agents/skills/' }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('observed', { names: ['goose-desktop'] }),
    measured: null,
  },
  {
    id: 'kilo',
    label: 'Kilo',
    // §2.10 — an OpenCode fork, same shapes. Its config PATHS were not
    // measured, so it carries the shape and NO path: a doctor that reports
    // "not configured" for a file it looked for in the wrong place is worse
    // than one that says it did not look.
    mcpConfig: fact('unverified', {
      format: 'json',
      shape: 'mcp',
      key: 'mcp',
      requiresType: 'local',
      argvShape: 'single-array',
      envKey: 'environment',
      addCommand: null,
      user: [],
      project: [],
      note: 'Shape as OpenCode (a fork). The config file locations are not measured, so none are listed.',
    }),
    instructionFile: fact('unverified', { names: ['AGENTS.md', 'CLAUDE.md'], cap: null, firstMatch: false, note: 'As OpenCode; unverified on this fork.' }),
    hooks: fact('docs', {
      state: HOOK_STATES.PRESENT_USELESS,
      mechanism: 'ts-plugin',
      reason: 'as OpenCode: hooks are TypeScript plugins, not shell commands',
      events: {},
      refusedEvents: {},
      envelope: null,
      loopGuard: null,
      writer: null,
      format: null,
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('docs', { path: '.agents/skills/' }),
    captureClass: CAPTURE_CLASSES.PLUGIN_ONLY,
    clientInfo: fact('docs', { names: ['kilo'] }),
    measured: null,
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    // §2.10. Cordis YAML overlays plus a Claude-Code-hooks BRIDGE carrying
    // `Stop` but no SessionEnd and no PreCompact.
    //
    // AND THE FACT ABOUT OUR OWN LAUNCH LINE: it STRIPS `DSH_*` and
    // credential-shaped environment variables from stdio children. Anything
    // the bridge needs must arrive as an argv flag — `buildCuratorEntry`
    // already passes `--domains-path` that way, so the bridge works, but
    // `CURATOR_MCP_VIA` would be stripped and a self-test run under dsh would
    // write UNMARKED lines. Harmless today; recorded so nobody debugs it twice.
    mcpConfig: fact('unverified', {
      format: 'yaml',
      shape: 'cordis',
      key: 'mcp_servers',
      requiresType: 'stdio',
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [],
      project: [],
      stripsEnv: true,
      note: 'A Cordis YAML overlay. The overlay file location is not measured, so none is listed. This harness strips credential-shaped env from stdio children — argv only.',
    }),
    instructionFile: fact('unverified', { names: [], cap: null, firstMatch: false, note: null }),
    hooks: fact('unverified', {
      state: HOOK_STATES.UNVERIFIED,
      reason: 'the Cordis overlay path is not measured — the Stop event arrives through a Claude-Code-hooks bridge, but where the entry is written is not',
      events: { stop: 'Stop' },
      refusedEvents: {
        SessionEnd: 'this harness carries no session-end hook',
        PreCompact: 'this harness carries no pre-compaction hook',
      },
      envelope: 'exit2',
      loopGuard: 'stop_hook_active',
      writer: null,
      format: 'yaml',
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('docs', { path: '.agents/skills/' }),
    captureClass: CAPTURE_CLASSES.HOOK_ASSISTED,
    clientInfo: fact('docs', { names: ['dsh-mcp-client'] }),
    measured: null,
  },
  {
    id: 'windsurf',
    label: 'Windsurf / Devin Desktop',
    // §2.7 (325-334). TWELVE hooks, and not one of them is a session-end,
    // stop or pre-compaction hook. So capture here is the instruction block
    // and the skill, exactly as today — the honest output for this harness,
    // and not a failure.
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'mcpServers',
      key: 'mcpServers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      user: [H('.codeium', 'windsurf', 'mcp_config.json')],
      project: [],
    }),
    // Rule files are capped at 6,000 / 12,000 CHARACTERS. The lower figure is
    // the cap carried here: a cap that is sometimes wrong in the user's favour
    // is worse than one that is always safe.
    instructionFile: fact('docs', { names: [], cap: 6000, capMax: 12000, firstMatch: false, note: 'Rule files are capped at 6,000 / 12,000 characters.' }),
    hooks: fact('docs', {
      state: HOOK_STATES.PRESENT_USELESS,
      reason: 'twelve hooks exist and NONE of them is a stop, session-end or pre-compaction hook — no hook here can carry the ask',
      events: {},
      refusedEvents: {},
      envelope: null,
      loopGuard: null,
      writer: null,
      format: null,
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('unverified', { path: null }),
    captureClass: CAPTURE_CLASSES.ADVISORY_ONLY,
    clientInfo: fact('docs', { names: ['Windsurf'] }),
    measured: null,
  },
  {
    id: 'zed',
    label: 'Zed',
    // §2.8 (335-345). No hook mechanism exists (open proposal #57890). MCP
    // servers sit under a FLAT `context_servers`. Instructions are a
    // FIRST-MATCH list in which `.rules` and `AGENTS.md` OUTRANK `CLAUDE.md`,
    // so a block pasted into CLAUDE.md in a repo that has AGENTS.md is dead
    // text here — one of the three traps a user cannot see.
    //
    // And one to disclose rather than let a user discover: Zed contacts MCP
    // servers even when AI features are disabled (issue #46846). Not our
    // defect, and we do nothing about it, but a user who turned AI off and
    // sees the bridge process start deserves the sentence.
    mcpConfig: fact('docs', {
      format: 'json',
      shape: 'context_servers',
      key: 'context_servers',
      requiresType: false,
      argvShape: 'command+args',
      envKey: 'env',
      addCommand: null,
      flat: true,
      user: [H('.config', 'zed', 'settings.json')],
      project: [],
    }),
    instructionFile: fact('docs', {
      names: ['.rules', 'AGENTS.md', 'CLAUDE.md'],
      cap: null,
      firstMatch: true,
      note: 'FIRST MATCH wins, and `.rules` and `AGENTS.md` outrank `CLAUDE.md` — a block in CLAUDE.md beside an AGENTS.md is dead text on this harness.',
    }),
    hooks: fact('docs', {
      state: HOOK_STATES.NONE,
      reason: 'no hook mechanism exists on this harness (open proposal #57890)',
      events: {},
      refusedEvents: {},
      envelope: null,
      loopGuard: null,
      writer: null,
      format: null,
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('unverified', { path: null }),
    captureClass: CAPTURE_CLASSES.ADVISORY_ONLY,
    clientInfo: fact('docs', { names: ['Zed'] }),
    measured: null,
  },
  {
    id: 'aider',
    label: 'Aider',
    // §2.9 (346-354). No MCP client. No hooks. No AGENTS.md auto-read. No
    // skills. Several third-party pages claim otherwise and are wrong.
    //
    // It gets a row that names the WRAPPER rather than an em dash, because a
    // documented shell function is a real answer for a real user:
    //   P=$(my-curator resolve) && my-curator context --project "$P"   … before
    //   … | my-curator save --project "$P"                             … after
    mcpConfig: null,
    instructionFile: fact('source', { names: [], cap: null, firstMatch: false, note: 'No instruction file is auto-read on this harness.' }),
    hooks: fact('source', {
      state: HOOK_STATES.NONE,
      reason: 'no hook mechanism and no MCP client — the only capture available is a wrapper around the process',
      events: {},
      refusedEvents: {},
      envelope: null,
      loopGuard: null,
      writer: null,
      format: null,
      configPath: { user: [], project: [], local: [] },
      shapeVerified: false,
    }),
    skillsTree: fact('source', { path: null }),
    captureClass: CAPTURE_CLASSES.OUT_OF_REACH,
    clientInfo: fact('source', { names: [], note: 'No MCP client, so no client label is ever sent.' }),
    measured: null,
  },
];

/** id → adapter, frozen. */
export const ADAPTERS = Object.freeze(Object.fromEntries(
  ENTRIES.map((e) => [e.id, Object.freeze(e)]),
));

/** Every harness id, in table order. */
export function listHarnesses() {
  return ENTRIES.map((e) => e.id);
}

/** The adapter for an id, or null. Never throws, never guesses a near-match. */
export function adapterFor(id) {
  if (typeof id !== 'string' || !id) return null;
  return ADAPTERS[id.trim().toLowerCase()] || null;
}

/**
 * Where to look for an installed copy of the repo's skills on this harness —
 * `<root>/skills/<skill>/` and `<root>/plugins/<plugin>/skills/<skill>/` for
 * each root. Empty for a harness whose table row carries no `roots`.
 */
export function skillRootsFor(id, dirs) {
  const a = adapterFor(id);
  return resolveTemplates(a?.skillsTree?.roots || [], dirs);
}

/** Every harness whose hooks this build can actually write. */
export function writableHarnesses() {
  return ENTRIES.filter((e) => e.hooks?.writer).map((e) => e.id);
}

// ─────────────────────────────────────────────────────────────────────────
// THE MCP ENTRY
//
// The LAUNCH LINE IS THE CALLER'S. `buildCuratorEntry(getDomainsDir())` in
// `src/routes/mcp.js` is the one source for how this bridge is launched, and
// it is passed IN. This function's whole job is to put a `{command, args}`
// into the shape THIS harness's config file wants — a translation, not an
// authorship. A second launch line composed here is v3.6.1's recorded defect.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The MCP server entry for one harness.
 *
 * @param {string} id
 * @param {{command: string, args?: string[]}} launch  from `buildCuratorEntry`
 * @returns {{ok: true, id, format, shape, key, name, entry, config, text, paths, addCommand}}
 *          | {ok: false, reason, message}
 */
export function mcpEntryFor(id, launch, opts = {}) {
  const a = adapterFor(id);
  if (!a) return refusals.unknownHarness(id);
  if (!a.mcpConfig) {
    return Object.freeze({
      ok: false,
      reason: 'no_mcp_client',
      message: `${a.label} has no MCP client at all, so there is no server entry to write. `
        + 'The only capture available on it is a wrapper around the process: `my-curator context` '
        + 'before the session and `my-curator save` after it.',
    });
  }
  const command = launch && typeof launch.command === 'string' ? launch.command : '';
  if (!command) {
    return Object.freeze({
      ok: false,
      reason: 'no_launch_line',
      message: 'mcpEntryFor needs the bridge launch line from buildCuratorEntry({command, args}). '
        + 'It is never composed here: one launch line, one source.',
    });
  }
  const args = Array.isArray(launch.args) ? launch.args.map(String) : [];
  const m = a.mcpConfig;
  const name = typeof opts.name === 'string' && opts.name ? opts.name : MCP_SERVER_NAME;

  // The server object, in this harness's argv and type conventions.
  const entry = {};
  if (m.requiresType) entry.type = m.requiresType;
  if (m.argvShape === 'single-array') entry.command = [command, ...args];
  else { entry.command = command; if (args.length) entry.args = args; }
  if (m.shape === 'mcp') entry.enabled = true;

  // The document a caller would merge into, and its serialisation.
  let config;
  let text;
  if (m.format === 'json') {
    config = { [m.key]: { [name]: entry } };
    text = `${JSON.stringify(config, null, 2)}\n`;
  } else if (m.format === 'toml') {
    config = { [m.key]: { [name]: entry } };
    text = renderTomlServer(m.key, name, entry);
  } else if (m.format === 'yaml') {
    config = { [m.key]: { [name]: entry } };
    text = renderYamlServer(m.key, name, entry, m.envKey);
  } else {
    return Object.freeze({ ok: false, reason: 'unknown_format', message: `No serialiser for format "${m.format}".` });
  }

  return Object.freeze({
    ok: true,
    id: a.id,
    label: a.label,
    name,
    format: m.format,
    shape: m.shape,
    key: m.key,
    entry: Object.freeze(entry),
    config,
    text,
    paths: Object.freeze({
      user: m.user.map(displayTemplate),
      project: m.project.map(displayTemplate),
    }),
    // Codex ships `codex mcp add`, and it is PREFERRED over merging TOML by
    // hand: this package has no TOML parser, and Decision L forbids merging
    // into a document it cannot read.
    addCommand: m.addCommand ? `${m.addCommand} ${name} -- ${[command, ...args].map(shellQuote).join(' ')}` : null,
    verified: m.verified,
    source: m.source,
  });
}

/** A TOML table for ONE server. Narrow by construction — no TOML library. */
function renderTomlServer(key, name, entry) {
  const lines = [`[${key}.${quoteTomlKey(name)}]`];
  for (const [k, v] of Object.entries(entry)) {
    if (Array.isArray(v)) lines.push(`${k} = [${v.map(tomlString).join(', ')}]`);
    else if (typeof v === 'boolean') lines.push(`${k} = ${v ? 'true' : 'false'}`);
    else lines.push(`${k} = ${tomlString(String(v))}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A YAML mapping for ONE server. Narrow by construction — no YAML library. */
function renderYamlServer(key, name, entry, envKey) {
  const lines = [`${key}:`, `  ${yamlKey(name)}:`];
  for (const [k, v] of Object.entries(entry)) {
    if (Array.isArray(v)) {
      lines.push(`    ${k}:`);
      for (const item of v) lines.push(`      - ${yamlString(String(item))}`);
    } else if (typeof v === 'boolean') lines.push(`    ${k}: ${v ? 'true' : 'false'}`);
    else lines.push(`    ${k}: ${yamlString(String(v))}`);
  }
  if (envKey) lines.push(`    ${envKey}: {}`);
  return `${lines.join('\n')}\n`;
}

const TOML_BARE = /^[A-Za-z0-9_-]+$/;
function quoteTomlKey(k) { return TOML_BARE.test(k) ? k : tomlString(k); }
function tomlString(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function yamlKey(k) { return TOML_BARE.test(k) ? k : yamlString(k); }
function yamlString(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

/**
 * POSIX shell quoting for a path that may contain a space or a quote.
 *
 * Exported because `install-hooks` writes command STRINGS into config files
 * that a shell runs, and an unquoted `/Applications/The Curator.app/…` is two
 * arguments. Single quotes, with the `'\''` escape — the only form that is
 * safe for every byte a POSIX filename may hold.
 */
export function shellQuote(s) {
  const str = String(s);
  if (str === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return `'${str.split("'").join("'\\''")}'`;
}

// ─────────────────────────────────────────────────────────────────────────
// THE INSTRUCTION SNIPPET
//
// DERIVED, never authored (Decision J). The text a MODEL reads is exactly
// `composeAgentInstructionsFull(args)` — the same bytes the app's Copy control
// hands out, sha-pinned in `scripts/test-agent-instructions.js` — and this
// module adds NOTHING to it. What it adds is addressed to a HUMAN: which file
// to paste into on THIS harness, and the trap that file carries.
//
// Three traps a user cannot see, which is why the `files` list is per-harness
// and not one sentence naming four files (Decision K, Risk 4):
//   - Zed resolves FIRST MATCH with `.rules` and `AGENTS.md` above CLAUDE.md;
//   - Gemini CLI reads `context.fileName` (nested, an ARRAY) and takes
//     AGENTS.md only opt-in;
//   - Codex caps AGENTS.md at 32 KiB and truncates past it, silently.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} id
 * @param {{domain: string, project: string}} args
 * @param {{compose?: Function}} [opts] test-only seam for the composer
 * @returns {{ok:true, id, label, text, bytes, files, cap, overCap, note}|{ok:false,...}}
 */
export async function instructionSnippetFor(id, args, opts = {}) {
  const a = adapterFor(id);
  if (!a) return refusals.unknownHarness(id);
  let compose = opts.compose;
  if (typeof compose !== 'function') {
    ({ composeAgentInstructionsFull: compose } = await import('../public/next/shared/agent-instructions.js'));
  }
  let text;
  try {
    text = compose(args);
  } catch (err) {
    return Object.freeze({
      ok: false,
      reason: 'missing_project',
      message: `The instruction block names a project, so it needs both a domain and a project: ${err.message}`,
    });
  }
  const bytes = new TextEncoder().encode(text).length;
  const info = a.instructionFile;
  const cap = info?.cap ?? null;
  return Object.freeze({
    ok: true,
    id: a.id,
    label: a.label,
    // BYTE-IDENTICAL to the app's Copy control. Pinned by execution in
    // scripts/test-harness-adapters.js §3.
    text,
    bytes,
    files: Object.freeze([...(info?.names || [])]),
    firstMatch: info?.firstMatch === true,
    cap,
    // The block is ~1.5 KB, so this is false everywhere today. It is computed
    // rather than assumed because the FILE it goes into is the user's and may
    // already be large — on Codex the whole file is capped, not our paragraph.
    overCap: cap !== null && bytes > cap,
    fromSetting: info?.fromSetting || null,
    note: instructionNoteFor(a),
    verified: info?.verified === true,
    source: info?.source || 'unverified',
  });
}

/** The human-facing sentence about WHERE the block goes on this harness. */
export function instructionNoteFor(a) {
  const info = a?.instructionFile;
  if (!info) return '';
  const names = info.names || [];
  if (!names.length) {
    return info.note
      || `${a.label} has no instruction file this release has measured. Paste the block wherever this harness reads standing instructions, and check it with \`my-curator doctor\`.`;
  }
  const where = info.firstMatch
    ? `${a.label} takes the FIRST match of ${names.join(', ')} — a block in a later file is never read.`
    : `${a.label} reads ${names.join(' and ')}.`;
  const capNote = info.cap
    ? ` That file is capped at ${info.cap.toLocaleString('en-US')} bytes and is truncated past it, silently — keep the whole file under the cap, not just this block.`
    : '';
  const setting = info.fromSetting ? ` The file is named by \`${info.fromSetting}\` (nested, an array).` : '';
  return `${where}${setting}${capNote}`;
}

// ─────────────────────────────────────────────────────────────────────────
// THE FIVE REFUSALS
//
// First-class outcomes, not exceptions. Every one of them returns a frozen
// `{ok:false, reason, message}` and NOTHING here writes: a refusal that writes
// a file is the worst outcome this package has, and the suite fingerprints the
// whole fixture tree across every refusing arm to prove it never happens.
//
// The wording pattern is `buildFullConfigPayload`'s (`routes/mcp.js:125-161`):
// name the file, name what could not be done, and say what to do instead —
// "you cannot merge into a document you cannot read".
// ─────────────────────────────────────────────────────────────────────────
export const refusals = Object.freeze({
  /** 1. A `--harness` this build does not know. It gets NOTHING, not a guess. */
  unknownHarness(id) {
    return Object.freeze({
      ok: false,
      reason: 'unknown_harness',
      message: `"${id ?? ''}" is not a harness this build knows. Known: ${listHarnesses().join(', ')}. `
        + 'Nothing was written and nothing was emitted: a harness whose shapes have not been measured '
        + 'would be receiving another harness\'s, which is at best ignored and at worst parsed as something else.',
    });
  },

  /** 2. Hooks asked for on a harness whose hook state cannot carry them. */
  noHooks(id) {
    const a = adapterFor(id);
    if (!a) return refusals.unknownHarness(id);
    const h = a.hooks || {};
    const reason = h.reason || 'this harness has no hook this release can write';
    return Object.freeze({
      ok: false,
      reason: 'no_hooks',
      state: h.state || HOOK_STATES.NONE,
      message: `No hook was written for ${a.label}: ${reason}. `
        + `Capture on this harness is the instruction block and the skill — run \`my-curator install-hooks ${a.id} `
        + '--print-instructions` for the block and the file it belongs in.',
    });
  },

  /** 3. Decision L — a config file that exists and cannot be parsed. */
  unparseableConfig(file, detail) {
    return Object.freeze({
      ok: false,
      reason: 'config_unparseable',
      file: file || null,
      message: `${file} exists and could not be parsed${detail ? ` (${detail})` : ''}, so nothing was written. `
        + 'Merging into a file we cannot read would silently drop whatever else is configured in it — '
        + 'other hooks, other servers, your own settings. Fix the syntax error in that file first, '
        + 'or run with --dry-run and add the entry by hand.',
    });
  },

  /** 4. A config file that parses and whose SHAPE is not the one we merge into. */
  shapeMismatch(file, key, found) {
    return Object.freeze({
      ok: false,
      reason: 'config_shape_mismatch',
      file: file || null,
      message: `${file} parses, but its \`${key}\` is ${found} where this harness's format needs an object, `
        + 'so nothing was written. Either that file belongs to a different tool, or it was hand-edited into '
        + 'a shape this writer does not recognise. Nothing was changed; --dry-run prints what would have gone in.',
    });
  },

  /**
   * 5. Decision E — the binary could not be resolved to an ABSOLUTE path.
   *
   * A hook command is written into `.claude/settings.json`, which is
   * COMMITTED, so a bare name absent from a teammate's PATH turns a capture
   * feature into "Claude Code is broken on this repo". And `curator` is
   * Elastic's bin on a Debian box. So every command written is an absolute
   * path, or nothing is written at all.
   */
  binNotResolved(name, searched) {
    return Object.freeze({
      ok: false,
      reason: 'bin_not_resolved',
      message: `"${name}" did not resolve to an executable file, so no hook was written. `
        + 'A hook command is written as an ABSOLUTE path, never a bare name: the file it goes in is committed, '
        + 'and a name that is not on a teammate\'s PATH turns capture into "the harness is broken on this repo". '
        + `Pass --bin <absolute path>.${searched ? ` Searched: ${searched}.` : ''}`,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// SMALL DERIVED READINGS — used by install-hooks and by any reporting surface
// ─────────────────────────────────────────────────────────────────────────

/** Canonical event key → this harness's own event name. */
export function hookEventsFor(id) {
  const a = adapterFor(id);
  return a?.hooks?.events ? { ...a.hooks.events } : {};
}

/** Can this build write hook configuration for this harness at all? */
export function canWriteHooks(id) {
  const a = adapterFor(id);
  return Boolean(a?.hooks?.writer);
}

/** The hook config file templates for a scope, or an empty list. */
export function hookConfigPaths(id, scope = 'project') {
  const a = adapterFor(id);
  const p = a?.hooks?.configPath;
  if (!p) return [];
  return [...(p[scope] || [])];
}

/** Is `HOOK_STATES`' vocabulary respected? Exported so a suite can assert it. */
export function isHookState(v) { return HOOK_STATE_VALUES.includes(v); }
