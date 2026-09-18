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
// and Agent memory. A dozen unverifiable strings is a rot surface.
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

  // ── Agent memory ───────────────────────────────────────────────────────
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
  'memory.foundations': { file: 'user-guide.md', anchor: 'foundations--canonical-documents-that-travel' },
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
