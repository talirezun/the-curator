// The paste-into-your-entry-file block that makes the working-state discipline
// reach an agent whose harness never activated the skill.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS A MEASUREMENT RATHER THAN A GUESS ──
//
// Capture is skill-instructed and advisory: nothing in the store, the tools or
// the app makes an agent save. That was always documented. What was NOT known
// is that a harness can decline to activate the skill at all — and one does.
//
// Measured (2026-09-10, 16 headless runs, one task, Haiku 4.5, an isolated
// store, N=4 per arm; docs/working-state.md carries the table):
//
//   harness      skill only        skill + this block
//   Claude Code  0/4 runs saved    3/4 runs saved
//   opencode     4/4 runs saved    4/4 runs saved
//
// On Claude Code the skill was installed and listed and never fired, even
// though the task prompt opened with "Continue", one of its own trigger
// phrases; on opencode the skill activated FIRST every time and the block
// bought nothing. So this is not a better skill description — the difference
// is in KIND (never reads, never saves → reads and saves) on the harness that
// does not self-activate, and zero on the harness that does. N=4 is a shape,
// not a rate: nothing here licenses "75%".
//
// ── WHY THE TEXT IS FROZEN ─────────────────────────────────────────────────
//
// TEMPLATE below is the artefact that was measured, byte for byte, with the
// two placeholders left in. Editing a word of it does not "improve the
// wording" — it invalidates the only evidence that any of this works, and the
// next reader has no way to tell that the measurement no longer describes what
// ships. scripts/test-agent-instructions.js pins the composed output against a
// hand-written second copy and against the tested artefact's sha256, so an
// edit here is RED rather than silent. If the text must change, re-run the
// experiment and replace the numbers in the same commit.
//
// ── WHY IT LIVES IN src/public/next/shared/ ────────────────────────────────
//
// One text, one file, no build step. The Domains view and the Agent-memory
// view import it as a browser ES module (express.static serves src/public, and
// nothing outside it); Node imports the same path directly, which is how the
// suite and any future CLI read it — the precedent beside it is
// format-usd.js and ingest-queue-logic.js. Putting it under src/brain/ would
// have needed either a route or a second copy for the browser, and a second
// copy of a MODEL-READ instruction set is this repository's most reliably
// recurring defect.
//
// The store's `markerLine` (`domain/project`, copied by "Copy marker line") is
// untouched and stays the one-line pointer. This is the other half: the marker
// says WHICH project, this says WHAT TO DO ABOUT IT.

// The heading the block is pasted under. Separate from BODY because the brief
// for this work names it separately ("plus one leading line") and because a
// future host-specific variant may want a different heading over the same,
// unchanged, measured paragraph.
export const HEADING = '## Working state';

// VERBATIM, placeholders included. `{{DOMAIN_PROJECT}}` stands where the
// measured artefact read `exp/widget`; `{{PROJECT}}` stands where it read
// `widget`, at both of its occurrences. Nothing else differs from the file
// that was pasted into the arm-B runs, including the hard line breaks — those
// are part of what was measured and are not re-flowed for a longer name.
export const TEMPLATE = [
  "This repository's working state lives in The Curator (project `{{DOMAIN_PROJECT}}`, see",
  '`.curator-project`). At the START of every session call the my-curator MCP tool',
  '`get_working_state` with project "{{PROJECT}}" and scope "latest" and read the standing',
  'brief before acting. SAVE with `save_working_state` under project "{{PROJECT}}", scope',
  '"main", after every material decision and at least every ten tool calls, and ALWAYS',
  'before you stop; a save overwrites, so send the complete state each time.',
].join('\n') + '\n';

/**
 * The block for one project, ready to paste into whatever file the user's
 * harness loads every session.
 *
 * Pure: no I/O, no clock, no globals, no module state. Same arguments in,
 * byte-identical string out, in a browser and in Node alike.
 *
 * REFUSES an empty domain or project rather than composing around one. The
 * output is an instruction a model will follow, and a block naming project ""
 * tells an agent to save into a project that cannot exist — a failure the
 * agent would report as a refusal from the store, several turns and one lost
 * handoff later. Every caller reads both names off a row the store produced,
 * so there is no legitimate path here with either missing.
 *
 * @param {{domain: string, project: string}} args
 * @returns {string} heading, blank line, block; one trailing newline.
 */
export function composeAgentInstructions(args) {
  // `String(undefined)` is the string "undefined", which is TRUTHY — so a
  // coerce-then-check would sail past the guard below and compose a block
  // telling an agent to save under project "undefined". Read the fields off a
  // defaulted object and require a non-empty STRING before coercing anything.
  const a = args && typeof args === 'object' ? args : {};
  const domain = typeof a.domain === 'string' ? a.domain : '';
  const project = typeof a.project === 'string' ? a.project : '';
  if (!domain || !project) {
    throw new Error('composeAgentInstructions needs both a domain and a project');
  }
  const body = TEMPLATE
    .split('{{DOMAIN_PROJECT}}').join(domain + '/' + project)
    .split('{{PROJECT}}').join(project);
  return HEADING + '\n\n' + body;
}

/**
 * The one-sentence banner shown after a successful copy. Exported so the two
 * views cannot drift apart on it, and so the suite asserts the shipped wording
 * rather than a copy of it.
 *
 * It names four files rather than one because the whole point of the block is
 * that it is harness-neutral: Claude Code reads CLAUDE.md, Codex and opencode
 * read AGENTS.md, Gemini CLI reads GEMINI.md, Cursor reads .cursor/rules.
 */
export const COPY_SUCCESS_BANNER =
  'Agent instructions copied — paste into CLAUDE.md, AGENTS.md, GEMINI.md or your Cursor rules';
