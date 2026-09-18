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

// ── v3.59.0: the foundations tier gets a SECOND, separately pinned paragraph ─
//
// TEMPLATE above is frozen because it is a measured artefact — editing it
// would silently invalidate the 2026-09-10 experiment. TEMPLATE_FOUNDATIONS is
// NOT that: it is new prose for a feature the experiment predates, so it has
// no numbers of its own to protect. It still gets the same discipline
// (a byte-for-byte pin against a hand-written literal and a sha256, in
// scripts/test-agent-instructions.js) for the ordinary reason any model-read
// instruction text in this repo does: a well-meant reword is a silent
// behaviour change to every agent that reads it next.
//
// It is composed AFTER the pinned block, never merged into it — TEMPLATE's
// own 501-byte/sha256 pin has to keep matching TEMPLATE alone, so a second,
// independent constant is the only shape that lets both stay frozen at once.
// No placeholders: unlike TEMPLATE, it names no project — the paragraph above
// it has already said which project and which tools to call on it.
export const TEMPLATE_FOUNDATIONS = [
  'This project also keeps foundations — canonical documents such as its architecture and firm',
  'decisions — that travel with it. At session start, call `get_project_context` instead of',
  '`get_working_state` to receive them alongside the brief and handoff. On every',
  '`save_working_state` call, include `foundations_read` (the hashes you were given) so the next',
  'session knows what changed.',
].join('\n') + '\n';

// ── v3.61.0: a THIRD, separately pinned paragraph — the seed for a skeleton ──
//
// v3.59.0 taught an agent to READ foundations. It said nothing about a
// foundation that arrives as a SKELETON — a document seeded with prompts
// rather than facts (the "start a project" flow, `foundation-skeletons.js`,
// WP-S) — and an agent with no instruction to look for that banner has no
// reason to treat a skeleton any differently from a finished document, or to
// know that filling one in is something it may do at all.
//
// TEMPLATE_SEED closes that gap the same way TEMPLATE_FOUNDATIONS closed the
// first one: composed AFTER it, never merged into it, so TEMPLATE's own
// 501-byte/sha256 pin and TEMPLATE_FOUNDATIONS's own pin both keep matching
// their own text alone. A third independent constant is the only shape that
// lets all three stay frozen at once. Pinned the same way (a hand-written
// literal AND a sha256, in scripts/test-agent-instructions.js §S8) for the
// same reason: a well-meant reword of model-read instruction text is a
// silent behaviour change to every agent that reads it next.
export const TEMPLATE_SEED = [
  'Some foundations may be skeletons — prompts, not facts; the document says so',
  'at the top. As you learn the project, fill each one and save it with',
  '`save_foundation` (`commissioned_by_owner: true` — this block is the owner\'s',
  'commission). On the first commit, export the filled foundations into the',
  'repository\'s `docs/` folder.',
].join('\n') + '\n';

/**
 * The block for one project, PLUS the foundations addendum, PLUS the seed
 * addendum — what the Copy control pastes as of v3.61.0. `composeAgentInstructions`
 * itself is untouched (its output is still exactly the measured 501-byte
 * artefact for the same arguments), so anything that still wants the
 * original alone keeps calling it directly.
 *
 * @param {{domain: string, project: string}} args
 * @returns {string} heading, blank line, the measured block, a blank line,
 *   the foundations paragraph, a blank line, then the seed paragraph — one
 *   trailing newline.
 */
export function composeAgentInstructionsFull(args) {
  return composeAgentInstructions(args) + '\n' + TEMPLATE_FOUNDATIONS + '\n' + TEMPLATE_SEED;
}

// ── v3.61.0: the drafting request — a ONE-OFF chat message, not a standing
// instruction, and NOT part of composeAgentInstructionsFull ─────────────────
//
// The three constants above are pasted into an entry file (CLAUDE.md /
// AGENTS.md / …) and re-read by an agent every session — that is what
// "standing instruction" means, and it is why they are frozen. This constant
// answers a different gap: a curator-owned project's tier 0 can be seeded with
// SKELETONS (foundation-skeletons.js, the "start a project" flow) — prompts,
// not facts — and an owner who wants an agent to fill them in needs a sentence
// naming the tool, the project and the approval gate. Composing that sentence
// by hand is exactly the friction that TEMPLATE existed to remove for the
// working-state block; this is the same fix for the drafting ask.
//
// It is pasted into a CHAT, once, to ask for a draft — never into an entry
// file, and it must never be appended to composeAgentInstructionsFull: doing
// so would put a "draft these now" imperative into a file an agent re-reads
// every session, i.e. a standing instruction to keep re-drafting. Kept as its
// own constant and its own compose function so the two call sites (an entry
// file vs a chat box) can never collapse into one.
//
// TEMPLATE_DRAFT_ASK is pinned the same way TEMPLATE_FOUNDATIONS and
// TEMPLATE_SEED are — a hand-written literal AND an independent sha256 in
// scripts/test-agent-instructions.js §S9 — for the same reason: a well-meant
// reword of model-read instruction text is a silent behaviour change to every
// agent that reads it next. Every named phrase in it is load-bearing:
// `save_foundation` and `commissioned_by_owner` name the exact tool and its
// gate, "Show me each document before saving" states the approval order, and
// "do not invent facts" is the same rule this release puts in
// skills/my-curator/SKILL.md for a commissioned save — the drafting ask and
// the skill must not be able to say different things about what an agent may
// invent.
//
// `{{DOMAIN_PROJECT}}` stands for `domain/project`, exactly as it does in
// TEMPLATE. `{{DOCUMENTS}}` stands for a natural-English list of the
// project's UNFILLED documents — composed from the project's real skeleton
// slugs by composeDraftingAsk below, not a fixed guess, because a fixed list
// of four role names is wrong the moment a project's skeletons were unticked
// or it carries other roles (api, guide, other). The sha pin below covers
// this TEMPLATE (the two placeholders, unsubstituted) rather than any one
// rendered string, the same way TEMPLATE's own pin covers the placeholder
// text and not any one project's composed block.
export const TEMPLATE_DRAFT_ASK =
  'Draft the unfilled foundations of the Curator project {{DOMAIN_PROJECT}} — {{DOCUMENTS}} — ' +
  'from what you can see of this codebase. Show me each document before saving. When I approve ' +
  'one, save it with save_foundation and commissioned_by_owner: true; do not invent facts to ' +
  'fill a prompt — leave the prompt and ask me.';

// The four roles `foundation-skeletons.js` seeds a fresh curator-owned project
// with, in seeding order. Named here rather than imported from
// `src/brain/foundation-skeletons.js`: that module sits on the server/MCP
// import graph and this one is a browser ES module loaded with no build step
// (see the file header) — the four words are data, not logic, so duplicating
// them costs far less than adding a cross-boundary import for a browser file.
// Used ONLY when a project's real skeleton list is empty (or not given), i.e.
// exactly the shape the seed itself writes.
const DEFAULT_DRAFT_ROLES = ['architecture', 'decisions', 'conventions', 'roadmap'];

/** English list join: "a", "a and b", "a, b and c" — no Oxford comma, matching
 * this constant's own prose ("architecture, decisions, conventions and
 * roadmap" reads the same way). */
function joinNatural(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/**
 * The sentence a user pastes into ANY harness with the my-curator MCP
 * installed to have its model draft a project's unfilled foundations.
 *
 * Pure: no I/O, no clock, no globals, no module state — same rule as
 * `composeAgentInstructions`, and the same REFUSAL shape: an empty domain or
 * project is refused rather than composed around, because the rendered
 * sentence is an instruction naming a `save_foundation` target, and a target
 * project "" cannot exist.
 *
 * @param {{domain: string, project: string, documents?: Array<{slug?: string,
 *   role?: string, title?: string}>}} args `documents` is the project's real
 *   unfilled skeletons (Q8: composed from what the project actually has, not
 *   a fixed guess). Each entry is named by its `role` if present, else its
 *   `title`; entries with neither are skipped. An empty or omitted array
 *   falls back to the four default roles a fresh curator-owned project is
 *   seeded with.
 * @returns {string} the composed sentence, both placeholders substituted.
 */
export function composeDraftingAsk(args) {
  // Same guard shape as composeAgentInstructions, and the same reason:
  // String(undefined) is the truthy string "undefined", so a coerce-then-check
  // would sail past a missing argument and compose a sentence naming project
  // "undefined". Read the fields off a defaulted object and require a
  // non-empty STRING before coercing anything.
  const a = args && typeof args === 'object' ? args : {};
  const domain = typeof a.domain === 'string' ? a.domain : '';
  const project = typeof a.project === 'string' ? a.project : '';
  if (!domain || !project) {
    throw new Error('composeDraftingAsk needs both a domain and a project');
  }
  const documents = Array.isArray(a.documents) ? a.documents : [];
  const labels = [];
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue;
    const role = typeof doc.role === 'string' ? doc.role.trim() : '';
    const title = typeof doc.title === 'string' ? doc.title.trim() : '';
    const label = role || title;
    if (label) labels.push(label);
  }
  const names = labels.length ? labels : DEFAULT_DRAFT_ROLES.slice();
  return TEMPLATE_DRAFT_ASK
    .split('{{DOMAIN_PROJECT}}').join(domain + '/' + project)
    .split('{{DOCUMENTS}}').join(joinNatural(names));
}
