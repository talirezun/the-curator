// Every link from the app into the user documentation, in one table.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// A docs link written at the call site is a string that nothing can check. It
// survives a heading being reworded, a section being split, a file being
// renamed — it just quietly starts landing at the top of a page, or on
// GitHub's "we couldn't find that anchor" no-op, and the only way anyone finds
// out is by clicking it. There were two such strings in /next
// (app.js's INSTANCE_DOCS_URL and mcp-wizard.js's MCP_GUIDE_URL) and the next
// phase of this release adds roughly a dozen more, one per fold on Settings
// and Project context. A dozen unverifiable strings is a rot surface.
//
// So the destination is DATA, and scripts/test-docs-links.js reads the real
// markdown in docs/ and fails if any file is missing or any anchor no longer
// matches a heading in it. The check is cheap, offline and free, and it fires
// on the commit that renames the heading rather than on the user who clicks.
//
// ── WHY A KEY RATHER THAN A PATH AT THE CALL SITE ──────────────────────────
//
// `docsUrl('settings.software-update')` THROWS on a key that is not in the
// map. A typo is therefore a blank screen in development, not a link to
// nowhere in production — the failure is loud, immediate and local. Passing a
// file and anchor at the call site would put the same unverifiable strings
// back, one indirection further down.
//
// ── NO DOM, NO IMPORTS ─────────────────────────────────────────────────────
//
// Same contract as shared/agent-instructions.js: this module touches nothing
// in `window` and imports nothing, so a Node test can import it directly and
// assert against the real values rather than re-typing them. `docsLinkHtml`
// builds a string; it does not create an element.

/**
 * `main`, not a tag. The docs are read as "what this version of the app does"
 * and the app auto-updates to main, so a user reading a tagged copy would be
 * reading the wrong release for their install more often than the right one.
 */
const DOCS_BASE = 'https://github.com/talirezun/the-curator/blob/main/docs/';

/**
 * key → { file, anchor }. `anchor: null` means the whole file IS the topic.
 *
 * Keys are `<surface>.<topic>`: the surface is where the link is rendered, the
 * topic is what the user was reading when they reached it. Nothing depends on
 * the prefix — it is there so a reader of this table can tell at a glance
 * which screen would lose a link if an entry were removed.
 *
 * Frozen, and frozen DEEPLY (the entries too, below): a caller that could
 * assign into this map would be a second, invisible source of destinations,
 * which is the whole thing this file exists to prevent.
 */
export const DOCS_LINKS = {
  // ── The two links that already existed, moved here unchanged ──────────
  // Both resolve byte-for-byte to the strings app.js and mcp-wizard.js used
  // to hard-code; scripts/test-docs-links.js pins that, so this migration
  // cannot have moved a live link by accident.
  'app.two-installs': { file: 'user-guide.md', anchor: 'two-installs-one-knowledge-folder' },
  'settings.mcp-bridge': { file: 'mcp-user-guide.md', anchor: null },

  // ── Settings ───────────────────────────────────────────────────────────
  'settings.software-update': { file: 'user-guide.md', anchor: 'version-and-updates' },
  // Text size and the setup guide are two bullets of one section — the
  // section IS "Appearance and the setup guide", and splitting them across
  // two anchors would mean inventing a heading the docs do not have.
  'settings.text-size': { file: 'user-guide.md', anchor: 'appearance-and-the-setup-guide' },
  'settings.setup-guide': { file: 'user-guide.md', anchor: 'appearance-and-the-setup-guide' },
  // §6b rather than the General section's own bullet: the bullet says what
  // the control does, §6b is where the three ways a new menu bar icon can
  // silently fail to appear are written down, and that is what someone
  // opening a fold about the menu bar is actually looking for.
  'settings.menu-bar': { file: 'user-guide.md', anchor: '6b-the-menu-bar-icon-mac-app' },
  'settings.system-check': { file: 'system-check.md', anchor: null },
  'settings.mcp-default-domain': { file: 'user-guide.md', anchor: 'default-domain-for-mcp-writes-v252' },
  // The caps are the part a user hits and cannot argue with (20,000 pages,
  // the candidate-pair cap, the token ceiling), so the limits anchor points
  // at the numbers rather than at the feature overview.
  'settings.health-limits': { file: 'ai-health.md', anchor: 'scale-caps-baked-into-the-code' },
  'settings.knowledge-base': { file: 'user-guide.md', anchor: 'knowledge-base-folder' },
  // THE TOOL MAP. The guide's MCP section rather than a section of its own,
  // because the first thing a reader of the map wants is the PRIVACY claim,
  // and that claim only means anything beside the description of the bridge
  // the log belongs to. `mcp-user-guide.md` carries the path and the same
  // privacy paragraph; this key lands on the part that explains how to READ
  // the map — the two session readings and what "not used since this log
  // began" means, which is the one phrase on that block nobody can guess.
  'settings.mcp-tool-map': { file: 'user-guide.md', anchor: 'the-tool-map--what-your-agents-used' },

  // ── Domains ────────────────────────────────────────────────────────────
  // v3.62.0. THE THREE-LAYER LEGEND, and there is exactly one of it.
  //
  // The OVERVIEW block's five figures ARE the model in miniature — four wiki
  // counts and one PROJECTS count — so the one place that teaches the SET
  // (accumulates / supersedes / replaced whole) is the ⓘ beside them. The
  // Project-context view teaches the three verbs one at a time, in place, in
  // the ⓘ of the step that carries each; a second copy of the legend there
  // would be two hand-maintained descriptions of one thing, which is the rule
  // views/memory.js records for why its own header ⓘ exists at all.
  //
  // THE PREFIX IS `domains.` BECAUSE THE PREFIX NAMES THE SURFACE THE LINK IS
  // RENDERED ON — this file's own rule, above — not the topic's home file.
  //
  // The anchor ALREADY EXISTS: docs/user-guide.md's "### The three kinds of
  // context it carries", chapter 1, with the three-row table this panel is the
  // short form of. So this key resolves on the commit that adds it, which is
  // what scripts/test-docs-links.js checks, rather than on a docs commit that
  // has to land first. The legend says "canonical documents" where the guide's
  // table says "Canonical documents — foundations": one noun on the screen
  // (FOUNDATIONS is the block's name), the adjective inside the definition.
  'domains.three-layers': { file: 'user-guide.md', anchor: 'the-three-kinds-of-context-it-carries' },

  // ── Project context (the view; the KEYS keep `memory.`) ────────────────
  // The view was renamed in v3.62.0 and these six keys deliberately did not
  // follow. A key names the DOCS TOPIC, and their destinations —
  // working-state.md and two user-guide anchors — were not renamed; renaming
  // the keys would be six declarations, nine call sites and two test lines of
  // pure churn on a module where `docsUrl()` THROWS on an unknown key, i.e.
  // where a half-applied edit is a blank screen.
  'memory.overview': { file: 'working-state.md', anchor: null },
  // The brief is tier 1 and the one tier a human owns; the section that says
  // so by name is the one to land on, not the layout diagram.
  'memory.standing-brief': { file: 'working-state.md', anchor: 'tier-1-is-not-tier-2-the-brief-is-the-owners' },
  'memory.handoff': { file: 'working-state.md', anchor: 'the-sections-a-handoff-carries' },
  // The journal has no heading of its own — it is tier 3, and "The three
  // tiers" is where it is defined against the other two. Recorded here so
  // the next reader does not go looking for a #session-journal that the
  // docs have never had.
  'memory.session-journal': { file: 'working-state.md', anchor: 'the-three-tiers' },
  // TIER 0 — the canonical documents that travel with a project. The landing
  // is the USER GUIDE rather than working-state.md, deliberately: the other
  // four keys above answer "what is this tier", and this one is reached from a
  // block whose ⓘ has already said that. What someone opening it wants next is
  // the part only the guide carries — which documents are worth making
  // canonical, and the two ways one arrives (an agent commissioned to write it,
  // or a byte copy refreshed from the project's repository).
  'memory.foundations': { file: 'user-guide.md', anchor: 'documents--the-files-that-travel-with-a-project' },
  // v3.61.0: the start-a-project flow and the curator-owned editor. This one
  // is reached from the Foundations block's own ⓘ (WP-V), on the sentence
  // that names how a curator-owned document gets edited — what someone
  // pressing "Edit" wants next is the walkthrough, not the tier's definition
  // again (that is `memory.foundations`, above).
  'memory.foundations-edit': { file: 'user-guide.md', anchor: 'start-a-project' },

  // ── The explainers' guide cards (v3.71.0) ──────────────────────────────
  // One per entry in shared/explainers.js whose destination no key above
  // already names. The card SHOWS the heading, so each of these lands on a
  // heading whose words match the screen's (scripts/test-explainers.js
  // checks the heading text as well as the anchor). Three of them are the
  // headings the v3.71.0 docs pass retitles or adds — "Documents — …",
  // "Memory — …" and "Session start and the context window" — because the
  // old ones said Foundations, working state and "Step ④". The same retitle
  // moved `memory.foundations` above to the new Documents heading.
  'context.page': { file: 'user-guide.md', anchor: 'project-context--what-the-screen-shows' },
  'context.overview': { file: 'user-guide.md', anchor: 'the-freshness-dot-one-scale-everywhere' },
  'context.documents': { file: 'user-guide.md', anchor: 'documents--the-files-that-travel-with-a-project' },
  'context.memory': { file: 'user-guide.md', anchor: 'memory--the-brief-handoffs-and-the-journal' },
  'context.knowledge': { file: 'user-guide.md', anchor: 'the-three-layers-and-the-one-rule-that-separates-them' },
  'context.session-start': { file: 'user-guide.md', anchor: 'session-start-and-the-context-window' },
  'settings.github-token': { file: 'user-guide.md', anchor: 'github-read-only-token' },
  'app.what-is-this': { file: 'user-guide.md', anchor: '1-what-is-this-app' },
  'app.first-run': { file: 'user-guide.md', anchor: '5-first-run--the-getting-started-panel' },
  'domains.page': { file: 'user-guide.md', anchor: '10-manage-your-domains' },
  'domains.pages': { file: 'user-guide.md', anchor: 'the-pages-lens--wiki--context--all' },
  'domains.health': { file: 'user-guide.md', anchor: '17-wiki-health' },
  'chat.page': { file: 'user-guide.md', anchor: '9-chat-with-your-brain' },
  'shared.page': { file: 'user-guide.md', anchor: '15b-shared-brain' },
};
for (const v of Object.values(DOCS_LINKS)) Object.freeze(v);
Object.freeze(DOCS_LINKS);

/**
 * The absolute URL for a key.
 * @param {string} key one of `DOCS_LINKS`'s keys
 * @returns {string}
 * @throws on an unknown key — see the header: loud and local beats a dead link
 */
export function docsUrl(key) {
  const entry = Object.prototype.hasOwnProperty.call(DOCS_LINKS, key) ? DOCS_LINKS[key] : null;
  // hasOwnProperty, not `DOCS_LINKS[key]` — `docsUrl('constructor')` would
  // otherwise reach Object.prototype and return something shaped enough to
  // pass a truthiness check. Same own-property rule chat.js records for
  // normalizeResponseStyle, for the same reason.
  if (!entry) throw new Error('docsUrl: unknown docs key "' + String(key) + '"');
  return DOCS_BASE + entry.file + (entry.anchor ? '#' + entry.anchor : '');
}

/** The five characters that change meaning inside markup or an attribute. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An outbound link to the docs, ready to drop into an HTML string.
 *
 * `rel="noopener noreferrer"` is not decoration on a `target="_blank"`: the
 * opened page gets a `window.opener` handle back into this document without
 * it. The URL comes from the frozen map above and never from an argument, so
 * only the LABEL can carry anything a caller composed — and it is escaped.
 *
 * @param {string} key   one of `DOCS_LINKS`'s keys
 * @param {string} label the visible text
 * @returns {string} HTML
 */
export function docsLinkHtml(key, label) {
  return '<a href="' + escapeHtml(docsUrl(key)) + '" target="_blank" rel="noopener noreferrer">' +
    escapeHtml(label) + '</a>';
}
