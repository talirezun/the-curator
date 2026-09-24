// ═══════════════════════════════════════════════════════════════════════════
//  shared/block.js — THE NUMBERED / UNNUMBERED SECTION BLOCK, FOR ANY VIEW
// ═══════════════════════════════════════════════════════════════════════════
//
// A block is: an optional numeral, a bold title, a lede of at most twenty
// visible words with everything longer behind a shared ⓘ fold, and a body —
// separated from the block above it by ONE declaration (24 | hairline | 24).
// v3.53.0 built it for Providers & keys, v3.54.0 moved the other four Settings
// sections onto it, and it is now the page rhythm this app uses wherever a
// screen reads as a sequence of sections rather than as one run of prose.
//
// ── WHY IT LEFT views/settings.js ──────────────────────────────────────────
// It was a `function settingsBlock(...)` inside a view module with ZERO
// exports, so every other view that wanted the same rhythm had exactly one
// way to get it: copy it. views/domains.js had already taken that route for
// the ⓘ half (a second `infoMark`, by hand), and the Agent-memory rebuild
// would have made a third. A pattern with three hand copies is not a pattern,
// it is three files that agree until one of them is edited.
//
// ── THE CLASS NAMES STILL SAY "settings", AND THAT IS DELIBERATE ───────────
// `settings-job-block`, `settings-block-hd`, `settings-block-num`,
// `settings-job-title`, `settings-job-lede`, `settings-block-lede`,
// `settings-block-info`, `settings-block-body`, `settings-block-unnumbered`.
// They are wrong names for a shared component and they are NOT renamed here.
// Those strings are pinned BY NAME in shipped suites — the emitted markup in
// test-next-settings-sections.js, test-next-providers-page.js,
// test-next-model-picker.js and test-next-model-gone-ui.js, the CSS
// arithmetic in test-next-button-family.js — and a rename would be a large,
// mechanical, high-blast-radius diff landing in the same release as a helper
// that is supposed to change nothing. RENAMING IS A LATER PASS, on its own,
// with the pins moved in the same commit. Recorded here so the next person
// finds the reason rather than the smell.
//
// ── WHERE THE CSS LIVES ────────────────────────────────────────────────────
// shell.css, beside `.cur-group`, as of the same release. It was in
// views/settings.css, which a second view cannot rely on: index.html links
// views/settings.css LAST of the view sheets, so a rule another view depended
// on would sit at a different point in the cascade than its own. The rules
// moved UNCHANGED in value.
//
// ── THE OTHER COPY IS STILL ALIVE ──────────────────────────────────────────
// views/settings.js keeps its own `settingsBlock` for now (its `infoMark`
// is gone as of v3.71.1): suites lift it out of that file by brace-matching
// and EXECUTE it, so deleting it here would take those with it.
// scripts/test-shared-block.js proves the two implementations emit the same
// BYTES over a fixture matrix, which is the property that matters while both
// are live. Collapsing them is the same later pass as the rename.

// v3.71.1: the ⓘ is an EXPLAINER, by key — never prose. explainer.js imports
// only import-free modules, so this file stays executable headless.
import { explainerMark } from './explainer.js';

// ── escapeHtml ─────────────────────────────────────────────────────────────
// A byte-for-byte copy of app.js's, for the same reason shared/text.js carries
// one: app.js cannot be imported from a module that must stay executable in an
// offline suite (it touches `document` at import time). The equality is PINNED
// rather than trusted — scripts/test-shared-block.js compares this against
// app.js's copy over a corpus and goes red naming the input. Do not "improve"
// it independently.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * One block.
 *
 * ── `num` MAY BE null, AND A NULL IS A STATEMENT ───────────────────────────
 * The numerals on Providers & keys are an argument: that page reads top to
 * bottom as a sequence. A section that is merely a section — General's
 * Software update, Appearance, System check — is not step 1 of anything, and
 * a numeral there would claim an order the page does not have. A null renders
 * no `.settings-block-num` AND adds `settings-block-unnumbered`, which zeroes
 * the 32px indent that exists only to clear a numeral; without that the prose
 * would hang inside a heading with nothing to its left.
 *
 * The test is `!= null`, never falsy: a numbering scheme that silently loses
 * its 0 is the kind of thing nobody finds twice. No block is numbered 0 today,
 * which is exactly why the guard has to be written down rather than observed.
 *
 * ── `id` AND `title` ARE REQUIRED, AND THIS THROWS WITHOUT THEM ────────────
 * `id` is not decoration: it is the block's own class (`settings-block-<id>`)
 * — which views scope their internal spacing to — and the STEM of the ⓘ
 * panel's DOM id, `settings-block-info-<id>`. Missing, both collapse: every
 * block on the screen gets the same class, and the fold gets the id
 * `settings-block-info-`, so a second folded block silently steals the first
 * one's panel (the exact defect v3.54.0's renderViewHeader fixed one layer
 * up — `document.getElementById` returns the first in document order, and the
 * prose a user needs exists in the DOM and cannot be reached by anyone).
 * `title` missing renders an empty `<h2>` and a screen-reader heading with no
 * text. Both fail LOUDLY here rather than rendering something that looks
 * nearly right — the opposite direction from `renderInfoMark`, which returns
 * '' because "nothing to say" is a legitimate state and "no id" is not a
 * legitimate block.
 *
 * ── `noticeHtml` IS ABOVE THE HEADING AND INSIDE THE WRAPPER ───────────────
 * Providers & keys block 2 is the caller this exists for: a banner about the
 * build model belongs to block 2 and to nothing else. Putting it BETWEEN two
 * blocks would belong to neither AND break the
 * `.settings-job-block + .settings-job-block` adjacency that is the page's
 * only source of block-to-block spacing.
 *
 * ── `ledeHtml` AND `bodyHtml` ARE TRUSTED HTML; THE ⓘ IS A KEY ──────────────
 * The first two are composed fragments the caller has already escaped — they
 * carry <strong>, <code> and whole cards. The ⓘ is `infoKey`, a key into
 * shared/explainers.js (v3.71.1): the panel is the shared explainer, so a
 * block cannot carry a prose panel, a warning or a cost behind its mark.
 * `id` and `title` are escaped here, because they are values, not markup.
 *
 * With no `ledeHtml` there is no lede paragraph AND no ⓘ — the mark lives
 * inline at the end of the lede sentence, so a block with nothing to fold and
 * a block with no lede both render exactly what they did before the fold
 * existed.
 *
 * @param {{num?: number|string|null, id: string, title: string,
 *          ledeHtml?: string, bodyHtml?: string, infoKey?: string|null,
 *          noticeHtml?: string}} o
 * @returns {string} HTML
 */
export function renderBlock(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const id = typeof opts.id === 'string' ? opts.id.trim() : '';
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (!id) throw new Error('renderBlock: `id` is required — it is the block class and the ⓘ panel id stem');
  if (!title) throw new Error('renderBlock: `title` is required — a block with no heading is not a block');

  const num = opts.num === undefined ? null : opts.num;
  const ledeHtml = typeof opts.ledeHtml === 'string' ? opts.ledeHtml : '';
  const bodyHtml = typeof opts.bodyHtml === 'string' ? opts.bodyHtml : '';
  const noticeHtml = typeof opts.noticeHtml === 'string' ? opts.noticeHtml : '';
  const infoKey = typeof opts.infoKey === 'string' && opts.infoKey ? opts.infoKey : '';

  const info = infoKey
    ? explainerMark('settings-block-info-' + id, infoKey)
    : { btn: '', panel: '' };
  const numbered = num != null;

  return (
    '<div class="settings-job-block settings-block settings-block-' + escapeHtml(id) + '' +
      (numbered ? '' : ' settings-block-unnumbered') + '">' +
      (noticeHtml || '') +
      '<div class="settings-block-hd">' +
        (numbered
          ? '<span class="settings-block-num" aria-hidden="true">' + escapeHtml(String(num)) + '</span>'
          : '') +
        '<h2 class="settings-job-title">' + escapeHtml(title) + '</h2>' +
      '</div>' +
      (ledeHtml
        ? '<p class="settings-job-lede settings-block-lede">' + ledeHtml + info.btn + '</p>' +
          (info.panel ? '<div class="settings-block-info">' + info.panel + '</div>' : '')
        : '') +
      '<div class="settings-block-body">' + bodyHtml + '</div>' +
    '</div>'
  );
}
