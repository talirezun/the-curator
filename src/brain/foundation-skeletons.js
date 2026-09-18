/**
 * The four SKELETON documents a curator-owned project is seeded with (v3.61.0).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS THE ONLY COPY ────────────────────
 * Tier 0 (the foundations, v3.59.0) holds the canonical documents an agent
 * must not work without: the architecture, the decisions, the conventions, the
 * roadmap. Until this release a project could only ACQUIRE them — mirrored
 * from a repository checkout, or written by a commissioned agent — so a brand
 * new project's tier 0 was empty and the front door said nothing about what
 * belongs there. Seeding answers that: four documents that carry PROMPTS, not
 * prose, so the tier is a set of questions the owner wants answered rather
 * than an invented claim about their project. The same argument as
 * `briefTemplate` in working-state.js: a template that ASSERTS anything is
 * read by every future agent as the owner's own standing instruction.
 *
 * It lives in `src/brain/` and NOT in a view because this repo's most-repeated
 * defect class is a template copied per surface — three brief templates exist
 * today (working-state.js, routes/memory.js, views/domains.js) with no drift
 * guard between them. The store, the routes and the MCP all reach this one.
 *
 * ── TWO CONSTRAINTS ON THE TEXT, BOTH PINNED BY TEST ─────────────────────
 * 1. STDOUT SILENCE. This module is on the MCP import graph (working-state.js
 *    imports it, mcp/tools/working-state.js imports that), and the MCP
 *    protocol reserves stdout for JSON-RPC frames. Diagnostics here use
 *    console.error or nothing at all. There is no logging in this file and
 *    there must never be.
 * 2. FIXED POINT OF THE READ SANITISER. A stored foundation is written
 *    VERBATIM and `neutraliseProtocol` runs over it on every READ, reporting
 *    `sanitisedOnRead`. A seeded document that tripped that filter would come
 *    back changed and flagged on its very first read — the store telling the
 *    owner that the app's own seed may have been written by another machine.
 *    So none of this text may contain a URL scheme, a pipe into an
 *    interpreter, a protocol-shaped tag, a line-initial chat role marker, or
 *    an invisible/control character. `scripts/test-foundations-init.js` proves
 *    it by SAVING and READING each one and requiring
 *    `sanitisedOnRead === false` with the sha unchanged — never by reading
 *    this comment.
 *
 * Roles and slugs match the store's `FOUNDATION_ROLES` and
 * `FOUNDATION_SLUG_RE`; the manifest's reading order does the rest.
 */

/**
 * The first line of every skeleton, and the one line a filled document must
 * lose. It is VISIBLE (bold plain text, not a comment) because the document
 * is read by people in Obsidian and by agents as plain text: an HTML comment
 * would be invisible in the first surface and meaningless in the second.
 * It carries NO blockquote marker (`> `) — /next's shared renderer
 * (src/public/next/shared/markdown.js) has no blockquote pass and escapes
 * the whole string before matching Markdown syntax, so a leading `> ` was
 * rendering as a literal `&gt;` in the reader instead of a quote. Bold text
 * needs no such pass; `renderInline`'s `**…**` handling is enough.
 */
export const SKELETON_BANNER =
  '**Skeleton — not yet written.** Answer the prompts below and delete this line. '
  + 'An agent writes one only when you ask it to.';

/** One skeleton: banner, `# Title`, then `## ` prompt headings. */
function skeleton(slug, role, title, body) {
  return Object.freeze({
    slug,
    role,
    title,
    text: `${SKELETON_BANNER}\n\n# ${title}\n\n${body.join('\n')}\n`,
  });
}

export const FOUNDATION_SKELETONS = Object.freeze([
  skeleton('architecture.md', 'architecture', 'Architecture', [
    '_What an agent must understand before changing anything here._',
    '',
    '## What this is',
    '',
    '- What does this project DO, in two sentences?',
    '- Who or what uses it, and through which entry point?',
    '',
    '## The shape of it',
    '',
    '- Which folders or modules exist, and what does each one own?',
    '- Where does a request, a job or a build START, and what does it touch on the way?',
    '- Which pieces are allowed to depend on which? Name the direction.',
    '',
    '## The load-bearing parts',
    '',
    '- Which files would break the most if they were changed carelessly?',
    '- Which invariants hold everywhere, and what breaks when one is dropped?',
    '- Where does state live, and who is allowed to write it?',
    '',
    '## What it is not',
    '',
    '- Which capabilities look present but are deliberately absent?',
    '- Which parts are known-temporary, and what replaces them?',
  ]),
  skeleton('decisions.md', 'decisions', 'Decisions', [
    '_Settled questions, with the reason each was settled. Newest first._',
    '',
    '## How to use this file',
    '',
    '- One entry per decision: the date, the choice, the alternatives, the reason.',
    '- A decision that is reversed is not deleted — it is marked superseded, with the new entry beside it.',
    '',
    '## Decisions',
    '',
    '### YYYY-MM-DD — the decision, in one line',
    '',
    '- **What was decided.**',
    '- **What was rejected**, and what it would have cost.',
    '- **Why**, in terms of something measured or a constraint that is real.',
    '- **What would reopen it** — the fact that, if it changed, would make this wrong.',
    '',
    '## Do not re-litigate',
    '',
    '- Which questions are closed, and where the argument is recorded?',
  ]),
  skeleton('conventions.md', 'conventions', 'Conventions', [
    '_How work is done here, so an agent does not have to guess._',
    '',
    '## Code',
    '',
    '- Which language, runtime and version?',
    '- Formatting and linting: what runs, and is it enforced anywhere?',
    '- Naming: files, functions, tests. What pattern is already in use?',
    '',
    '## Tests',
    '',
    '- How are tests run, and which command must be green before a change lands?',
    '- What must a new test do to count — what does a passing test have to prove?',
    '',
    '## Commits and review',
    '',
    '- Branch and commit-message conventions, if any.',
    '- What may never be committed (secrets, generated files, personal paths)?',
    '',
    '## Boundaries',
    '',
    '- Which files or folders must not be touched without asking?',
    '- Which actions need the owner first (releasing, pushing, spending money)?',
  ]),
  skeleton('roadmap.md', 'roadmap', 'Roadmap', [
    '_What is next, and what is deliberately not next._',
    '',
    '## Now',
    '',
    '- What is being worked on, and what would "done" look like?',
    '',
    '## Next',
    '',
    '- What follows, and what has to be true before it can start?',
    '',
    '## Later, or maybe never',
    '',
    '- What has been considered and parked? Note why, so it is not re-proposed.',
    '',
    '## Known problems',
    '',
    '- What is broken or unfinished and already known? Name the symptom.',
  ]),
]);

/** Every seeded slug, in seeding order. */
export const SKELETON_SLUGS = Object.freeze(FOUNDATION_SKELETONS.map((s) => s.slug));

/** The skeleton for one slug, or null. Accepts a bare stem (`architecture`). */
export function skeletonFor(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  const t = slug.trim().toLowerCase();
  const want = t.endsWith('.md') ? t : `${t}.md`;
  return FOUNDATION_SKELETONS.find((s) => s.slug === want) || null;
}
