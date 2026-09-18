// shared/foundations-init.js — THE OWNERSHIP CHOICE, ONCE, FOR BOTH HOSTS.
//
// A project's canonical documents (tier 0, "foundations", v3.59.0) are either
// MIRRORED from a repository checkout on this computer or KEPT BY THE CURATOR.
// That choice is made ONCE per project and the store refuses a mismatch on
// every later write, so the surfaces that offer it must offer the SAME thing:
//
//   · views/domains.js — the "New project" form, where the choice is folded
//     into the create request and a third answer ("decide later") is allowed;
//   · views/memory.js — the Foundations block of a project that has no
//     manifest yet, where the choice POSTs `…/foundations/init` on its own.
//
// ── WHY ONE MODULE AND NOT TWO COPIES ────────────────────────────────────
// This repo's most-repeated defect class is a template copied per surface:
// three copies of the standing-brief template ship today with no drift guard
// between them. An ownership choice is worse than a template, because the two
// copies would be describing WHICH WRITER OWNS A FILE — and a project created
// with one answer and initialised with the other is a refusal the user cannot
// act on. So the markup, the state shape, the request body and the outcome
// words are all here, and both views call them.
//
// ── IT TAKES NO IMPORTS, AND THAT IS DELIBERATE ──────────────────────────
// Same contract as shared/text.js: no imports, so the module stays executable
// in a plain Node suite (scripts/test-next-foundations-editor.js imports it
// directly rather than lifting it by brace-matching) and it can never reach a
// DOM at import time. The two consequences are that it carries its own
// `escapeHtml` — a four-line copy, pinned against the shell's by the suite —
// and that every DOM it touches is PASSED IN.
//
// ── NO NATIVE <select>, AND NO LISTBOX EITHER ────────────────────────────
// /next purged the native `<select>` in v3.18.0 (shell.css records why: the
// popup a `<select>` paints is an OS surface outside the design system). The
// shared listbox is the app's answer — but it imports `../app.js`, which would
// make this module DOM-bound at import time and, worse, would put the
// component back inside Agent memory, which scripts/test-next-listbox.js §5b
// asserts is free of it in both directions after v3.55.0 took the two pickers
// out. So the role picker here is the shape views/domains.js already uses for
// "pick one of N": a row of option BUTTONS (`.dm-lc-template` is the
// precedent), with `aria-pressed` carrying the selection. Seven roles fit a
// row; in the scan picker, where there is one per candidate, the row is
// revealed for ONE candidate at a time from state rather than painted N times.
//
// ── WHAT IS MIRRORED FROM THE STORE, AND HOW IT STAYS HONEST ─────────────
// Four things: the slug grammar, the seven role names, the per-document byte
// cap and the project budget. Every one of them is a number or a pattern the
// SERVER enforces, so a copy that drifts either blocks a save the server would
// accept or offers one it will refuse with a 400 the user cannot act on. Each
// is pinned against `src/brain/working-state.js` by
// scripts/test-next-foundations-editor.js — the same discipline
// views/memory.js's `BRIEF_MAX_BYTES` has had against the store's
// `MAX_BRIEF_BYTES` since v3.48.0.

/** The store's `FOUNDATION_SLUG_RE` (working-state.js). Mirrored, pinned. */
export const FOUNDATION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;

/** The store's `FOUNDATION_ROLES`, in the store's order. Mirrored, pinned. */
export const FOUNDATION_ROLES = Object.freeze([
  'architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other',
]);

/** The store's `MAX_FOUNDATION_BYTES` — a WALL. Mirrored, pinned. */
export const MAX_FOUNDATION_BYTES = 512 * 1024;

/** The store's `FOUNDATIONS_BUDGET_BYTES` — a DISCLOSURE, never a wall. */
export const FOUNDATIONS_BUDGET_BYTES = 200 * 1024;

/**
 * The four skeleton slugs `POST …/foundations/init` seeds.
 *
 * The skeleton TEXT lives in the store (`src/brain/foundation-skeletons.js`)
 * and no view carries a copy of it — D1. What this list is for is the one
 * thing a view has to answer without a round trip: whether a file the owner
 * is importing would land on a slug the seeding is about to write, so the
 * banner can say "replaced the Architecture skeleton" rather than leaving the
 * owner to work out which of the two won.
 */
export const SKELETON_SLUGS = Object.freeze([
  'architecture.md', 'decisions.md', 'conventions.md', 'roadmap.md',
]);

// ── Escaping ─────────────────────────────────────────────────────────────
// A local copy, for the no-imports reason above. Byte-compared against
// shared/text.js's by the suite, so the two cannot drift.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ═════════════════════════════════════════════════════════════════════════
// DERIVATIONS — a filename in, a slug / a role / a title out
// ═════════════════════════════════════════════════════════════════════════

/**
 * WHICH ROLE A FILENAME SUGGESTS.
 *
 * The same table the store's repo scan uses for `suggestedRole`, mirrored here
 * because the IMPORT path (D18) never reaches that scan: a file the owner
 * picks off their disk is read in the browser and PUT as text, so the server
 * never sees its original name. Two tables answering one question is exactly
 * the drift this file's header warns about, which is why the suite pins them
 * equal rather than trusting this comment.
 *
 * ORDER MATTERS AND IS PART OF THE TABLE. `contributing.md` matches
 * `conventions` before it can reach `guide`, and `adr-0003.md` matches
 * `decisions`. Falls through to `other`, which is a real role, not a failure.
 */
export function roleForBasename(name) {
  const b = String(name == null ? '' : name).toLowerCase()
    .replace(/\.[a-z0-9]+$/, '');
  if (/architecture/.test(b)) return 'architecture';
  if (/^adr/.test(b) || /decision/.test(b)) return 'decisions';
  if (/convention/.test(b) || /contributing/.test(b) || /^style/.test(b)) return 'conventions';
  if (/roadmap/.test(b) || /^plan/.test(b)) return 'roadmap';
  if (/^api/.test(b)) return 'api';
  if (/readme/.test(b) || /guide/.test(b) || /handbook/.test(b)) return 'guide';
  return 'other';
}

/**
 * A FILENAME OR A REPOSITORY PATH, AS A SLUG — or `null`.
 *
 * `null` rather than a best effort, because a slug the store will refuse is a
 * 400 the owner cannot act on: the field is pre-filled only when the
 * derivation lands inside the grammar, and left for them to type otherwise.
 *
 * The normalisation is the smallest set that covers what people actually have
 * on disk: the leading directories go (a slug is flat), `_` and whitespace
 * become hyphens, everything outside the grammar's alphabet goes, runs
 * collapse, and a `.txt` becomes a `.md` because the store stores markdown.
 */
export function slugForFilename(name) {
  let b = String(name == null ? '' : name).replace(/\\/g, '/');
  b = b.slice(b.lastIndexOf('/') + 1).toLowerCase().trim();
  // A DOTFILE HAS NO USABLE NAME HERE, and that is a refusal rather than a
  // best effort: the store's grammar requires a leading alphanumeric, so
  // `.md` would become the slug `md.md` and a hidden `.notes` would become
  // `notes.md` — in both cases a name the owner never chose, on a document
  // they are about to save under it.
  if (!b || b.charAt(0) === '.') return null;
  b = b.replace(/\.(txt|markdown|mdown)$/, '.md');
  const dot = b.lastIndexOf('.md');
  const stem = dot === b.length - 3 && dot > 0 ? b.slice(0, dot) : b;
  const clean = stem
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  const slug = clean + '.md';
  return FOUNDATION_SLUG_RE.test(slug) ? slug : null;
}

/**
 * THE DOCUMENT'S OWN TITLE, if it states one.
 *
 * The first `# ` heading, because that is what a markdown document's title IS
 * — and the basename otherwise, which is a worse title than the document's own
 * but a better one than nothing. Never the second-level headings: a document
 * whose first heading is `## Overview` has not named itself.
 */
export function titleFromText(text, fallback) {
  const src = typeof text === 'string' ? text : '';
  const m = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(src);
  const found = m ? m[1].trim() : '';
  if (found) return found.slice(0, 120);
  const base = String(fallback == null ? '' : fallback);
  const stem = base.slice(base.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
  return (stem || 'Untitled').slice(0, 120);
}

// ═════════════════════════════════════════════════════════════════════════
// THE CHOICE, AS STATE
// ═════════════════════════════════════════════════════════════════════════

/**
 * A FRESH CHOICE.
 *
 * `curator` is the default on the create form and the reason is that it is the
 * answer that works with no preconditions: mirroring needs a checkout on THIS
 * computer at a path the owner can type, and a first-time user creating their
 * first project has neither to hand. It is also the only arm that leaves
 * something behind — four skeletons an agent can fill — rather than an empty
 * tier that reads identically to not having chosen.
 *
 * `allowLater` is the create form's third answer and the Memory block's
 * absence of one: on the create form the choice is one field of a bigger form
 * and postponing it costs nothing, while the Memory block IS the surface
 * somebody opened to make the choice, and "decide later" there is the button
 * they already pressed by not pressing anything.
 */
export function freshChooser(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    // 'curator' | 'repo' | 'later'
    //
    // ── THE DEFAULT IS THE ARM THAT WRITES NOTHING (maintainer's call, Q1) ──
    // On the create form the fail-safe direction decides it: the arm that
    // seeds four documents is not the safe answer on a form somebody has not
    // read, and `later` is — nothing is written, and the Foundations block
    // asks the same question again in the place the answer is missing. Where
    // there IS no third answer (the Memory block, which IS the later), the
    // default is `curator`: it is the only arm that works with no
    // preconditions, because mirroring needs a folder on THIS computer at a
    // path the owner can type.
    ownership: o.allowLater === true ? 'later' : 'curator',
    allowLater: o.allowLater === true,
    // The repository root, typed. Written straight into state on every
    // keystroke WITHOUT a re-render (the house rule: a render rebuilds the
    // field and takes the caret with it).
    repoRoot: '',
    // Seed the four skeletons. Curator arm only; the owner may untick it.
    seed: true,
    // The scan (GET /api/memory/repo-scan), and its three states.
    scanning: false,
    scanError: null,
    candidates: null,          // null = never scanned; [] = scanned, nothing found
    truncated: false,
    // Which candidate paths are ticked, and the role each one carries. Two
    // maps rather than one list of objects, so a tick and a role change are
    // independent writes and neither has to rebuild the other.
    picks: {},                 // path -> true
    roles: {},                 // path -> role (absent = the scan's suggestion)
    // WHICH candidate's role row is open. One at a time across the whole
    // picker: seven option buttons per row over up to 200 rows is a wall, and
    // a role is corrected rarely — the suggestion is usually right.
    roleOpenFor: null,
    // ── FILES THE SCAN DID NOT FIND (D21) ─────────────────────────────────
    // The scan looks where canonical documents usually live; a real project
    // keeps one somewhere else, and "the app cannot see my architecture note"
    // is the whole onboarding case failing on a path rule. So a relative path
    // can be TYPED and joins `files[]` beside the ticked candidates. It is
    // NOT validated here beyond being non-empty and relative: the store's own
    // `sourceDigest` rules are the authority (inside the root, no symlink out,
    // markdown, under the cap), and a second copy of them in a browser would
    // either refuse something the server accepts or promise something it
    // refuses. What comes back in `refused[]` is rendered unfolded.
    extras: [],                // [{ path, role }]
    extraPath: '',             // the draft in the field
    extraRole: 'other',        // the role the draft will carry
    // Files the owner picked off disk (D18). Curator arm only. Each becomes
    // ONE document via one PUT after the project exists; nothing is uploaded.
    //   { name, size, slug, role, title, text, error }
    imports: [],
    // The last refusal from a `Choose a file…` press, outside the list —
    // a file over the wall is never read, so it never becomes an entry.
    importError: null,
  };
}

/**
 * THE REQUEST BODY THIS CHOICE MEANS, or `null` for "decide later".
 *
 * `null` is load-bearing: `POST /api/memory/:domain/projects` must receive NO
 * `foundations` key at all rather than one saying "later", because the route's
 * body is an allow-list and a project with no manifest is the state the Memory
 * block's chooser exists to resolve. An `{ownership: 'later'}` would be a
 * fourth ownership the store has never heard of.
 *
 * `repoRoot` is trimmed and omitted when empty, and `files` is omitted when
 * nothing is ticked — an empty array would ask the server to mirror nothing,
 * which it can do, and which reads on the wire as a mistake rather than as a
 * decision. `seed` is sent only when it is FALSE, because `true` is the
 * server's default and re-stating a default is one more thing to disagree
 * about.
 */
export function chooserBody(choice) {
  const c = choice && typeof choice === 'object' ? choice : null;
  if (!c || c.ownership === 'later') return null;
  if (c.ownership === 'curator') {
    const out = { ownership: 'curator' };
    if (c.seed === false) out.seed = false;
    return out;
  }
  if (c.ownership !== 'repo') return null;
  const out = { ownership: 'repo' };
  const root = String(c.repoRoot || '').trim();
  if (root) out.repoRoot = root;
  const files = pickedFiles(c);
  if (files.length) out.files = files;
  return out;
}

/**
 * The ticked candidates PLUS the typed extras, as the wire's `[{path, role}]`.
 *
 * Order is the scan's, then the order they were typed — so a person who added
 * three by hand sees them in the order they added them, and a `refused[]` row
 * coming back names the path rather than an index into a list they cannot see.
 * A typed path that duplicates a ticked candidate is dropped here rather than
 * sent twice: the server would mirror it once and report it once, and the
 * count line would then disagree with the outcome.
 */
export function pickedFiles(choice) {
  const c = choice && typeof choice === 'object' ? choice : null;
  const list = c && Array.isArray(c.candidates) ? c.candidates : [];
  const out = [];
  const seen = new Set();
  for (const cand of list) {
    if (!cand || cand.tooLarge) continue;
    const p = String(cand.path || '');
    if (!p || c.picks[p] !== true) continue;
    const role = c.roles[p] || cand.suggestedRole || 'other';
    seen.add(p);
    out.push({ path: p, role: FOUNDATION_ROLES.includes(role) ? role : 'other' });
  }
  const extras = c && Array.isArray(c.extras) ? c.extras : [];
  for (const e of extras) {
    const p = normaliseRelPath(e && e.path);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const role = e && FOUNDATION_ROLES.includes(e.role) ? e.role : roleForBasename(p);
    out.push({ path: p, role });
  }
  return out;
}

/**
 * A TYPED PATH, TIDIED — never validated.
 *
 * Leading `./` and `/` go (the store resolves inside the root, so an absolute
 * path is the one shape that is certainly wrong), backslashes become slashes,
 * and the whitespace a paste brings with it is trimmed. Everything else — does
 * it exist, is it inside the root, is it a symlink out, is it markdown, is it
 * under the cap — is the store's `sourceDigest` decision, and the refusal comes
 * back in `refused[]` with its reason. Returns '' for nothing usable.
 */
export function normaliseRelPath(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/').trim();
  s = s.replace(/^\/+/, '').replace(/^(?:\.\/)+/, '');
  return s;
}

/**
 * WHAT HAPPENED, IN THE WORDS THE BANNER USES.
 *
 * Derived from the SERVER'S answer, never from the choice that was sent: a
 * create that asked for four skeletons and got three is a fact the owner needs,
 * and a sentence built from the request would report the ask as the outcome.
 * Returns '' when the response says nothing about tier 0, so a caller can
 * append it unconditionally.
 */
export function chooserOutcomeWords(resp, choice) {
  const r = resp && typeof resp === 'object' ? resp : null;
  if (!r) return '';
  const said = [];
  const seeded = Array.isArray(r.seeded) ? r.seeded.length : 0;
  if (seeded) said.push(seeded + ' skeleton' + (seeded === 1 ? '' : 's') + ' seeded');
  const ref = r.refresh && typeof r.refresh === 'object' ? r.refresh : null;
  const mirrored = ref
    ? (Array.isArray(ref.added) ? ref.added.length : 0) +
      (Array.isArray(ref.refreshed) ? ref.refreshed.length : 0)
    : 0;
  if (mirrored) said.push(mirrored + ' document' + (mirrored === 1 ? '' : 's') + ' mirrored');
  const refused = ref && Array.isArray(ref.refused) ? ref.refused.length : 0;
  if (refused) said.push(refused + ' refused');
  const imported = Array.isArray(r.imported) ? r.imported.length : 0;
  if (imported) said.push(imported + ' document' + (imported === 1 ? '' : 's') + ' imported');
  const replaced = Array.isArray(r.replacedSkeletons) ? r.replacedSkeletons : [];
  if (replaced.length) {
    said.push(replaced.length + ' skeleton' + (replaced.length === 1 ? '' : 's')
      + ' replaced by an imported file (' + replaced.join(', ') + ')');
  }
  // ── "DECIDE LATER" IS THE ONE CLAUSE THE REQUEST OWNS ──────────────────
  //
  // Everything above is read off the SERVER'S answer, deliberately: a create
  // that asked for four skeletons and got three is a fact the owner needs, and
  // a sentence built from the request would report the ask as the outcome.
  //
  // Postponing the choice is different in kind. The server did nothing and
  // says nothing — there is no `foundations` object to read, because no
  // manifest was written — so the only place that fact exists is the choice
  // that was made. Reading it from there is not the mistake this function
  // otherwise avoids: the server CONFIRMS it by having nothing to report, and
  // the alternative is a banner that silently omits the one thing the owner
  // will wonder about ten minutes later.
  if (!said.length && choice && choice.ownership === 'later') {
    return ' · documents: decide later';
  }
  const f = r.foundations && typeof r.foundations === 'object' ? r.foundations : null;
  if (!said.length && f && f.present === false) return '';
  if (!said.length && !f) return '';
  if (!said.length) said.push('documents: decide later');
  return ' · ' + said.join(' · ');
}

// ═════════════════════════════════════════════════════════════════════════
// THE ROLE PICKER — a row of option buttons, the `.dm-lc-template` shape
// ═════════════════════════════════════════════════════════════════════════

/**
 * SEVEN OPTION BUTTONS, one pressed.
 *
 * `aria-pressed` rather than radios: the seven are a toolbar of exclusive
 * choices, every one of them always available, and a radio group would need a
 * name, a legend and a fieldset to say the same thing. The precedent is
 * views/domains.js's template row on the New domain form, which is the same
 * control for the same job.
 *
 * `hook` is the data attribute the host's listener reads the value back from,
 * so one binder can serve the editor's single picker and the scan picker's
 * per-candidate one without either knowing about the other.
 */
export function renderRoleOptions(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const value = FOUNDATION_ROLES.includes(c.value) ? c.value : 'other';
  const hook = String(c.hook || 'fnd-role');
  const scope = c.scope == null ? '' : String(c.scope);
  const disabled = c.disabled === true ? ' disabled' : '';
  const label = c.label ? String(c.label) : 'Role';
  return (
    '<div class="fnd-init-roles" role="group" aria-label="' + escapeHtml(label) + '">' +
      FOUNDATION_ROLES.map((r) => (
        '<button type="button" class="fnd-init-role' + (r === value ? ' is-on' : '') + '"' +
          ' data-' + escapeHtml(hook) + '="' + escapeHtml(r) + '"' +
          (scope ? ' data-fnd-role-scope="' + escapeHtml(scope) + '"' : '') +
          ' aria-pressed="' + (r === value ? 'true' : 'false') + '"' + disabled + '>' +
          escapeHtml(r) +
        '</button>'
      )).join('') +
    '</div>'
  );
}

// ═════════════════════════════════════════════════════════════════════════
// THE CHOOSER, RENDERED
// ═════════════════════════════════════════════════════════════════════════

/**
 * A HUMAN-SIZED BYTE COUNT. Two call sites in this file and two more in the
 * hosts, and a figure that reads "512000 bytes" in one place and "500 KB" in
 * another is two descriptions of one wall.
 */
export function formatBytes(n) {
  const b = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (b < 1024) return b + ' bytes';
  return Math.round(b / 1024).toLocaleString('en-US') + ' KB';
}

/**
 * THE CHOICE, AS MARKUP.
 *
 * ── WHAT IS A LEDE AND WHAT IS NOT (design-system §3) ───────────────────
 * The two options carry a SHORT consequence line each — what you get if you
 * pick it — which is a READING the person needs before pressing. What a
 * foundation IS, why the tier exists and why the choice cannot be changed
 * afterwards are DEFINITIONS, and they belong behind the host's ⓘ. This
 * module therefore emits no ⓘ of its own: the hosts already have one on the
 * block and the section that contains the chooser, and a third mark beside
 * them would be a third voice.
 *
 * ── AND WHAT MAY NEVER FOLD ─────────────────────────────────────────────
 * Every refusal here is painted in flow: the scan's error, the import's
 * pre-read size refusal, and the per-file error on an import row. v3.16.1 —
 * a warning behind a click is not a warning.
 */
export function renderFoundationsChooser(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const id = String(c.id || 'fnd-init');
  const choice = c.choice && typeof c.choice === 'object' ? c.choice : freshChooser({});
  const busy = c.busy === true;
  const dis = busy ? ' disabled' : '';
  const own = choice.ownership;

  const opt = (value, title, line) => (
    '<button type="button" class="fnd-init-opt' + (own === value ? ' is-on' : '') + '"' +
      ' data-fnd-own="' + escapeHtml(value) + '" aria-pressed="' + (own === value ? 'true' : 'false') + '"' +
      dis + '>' +
      '<span class="fnd-init-opt-title">' + escapeHtml(title) + '</span>' +
      '<span class="fnd-init-opt-line">' + escapeHtml(line) + '</span>' +
    '</button>'
  );

  // ── THE OPTIONS CAN BE WITHHELD, AND ONE HOST DOES ──────────────────────
  // A project that is ALREADY repo-owned with no documents mirrored yet needs
  // the scan picker and nothing else: its ownership was decided and the store
  // refuses a change, so painting a two-way choice there would offer a
  // decision that cannot be made. `optionsHidden` is that case, and it is a
  // flag rather than a second renderer because the arm below it is the same
  // arm — two renderers would be the two copies this module exists to avoid.
  const options = c.optionsHidden === true ? '' :
    '<div class="fnd-init-opts" role="group" aria-label="Where this project’s documents live">' +
      // ── THE OWNER IS NAMED FIRST, AND THE WORD IS "FOLDER" ──────────────
      // P1-12: a person can start a project here with no agent and no
      // repository and write the first document by hand — that is a
      // first-class path, so no line may assume an agent exists, and where
      // both ways in are named the owner comes first.
      // P1-9: `resolveRepoRoot` requires only an absolute, reachable
      // DIRECTORY, so "repository" is a label that turns away everybody whose
      // documents live in `~/Documents/lumina-docs`. That a git checkout
      // additionally records the commit is MECHANISM, and it is in the host's
      // ⓘ where the rest of the mechanism is.
      opt('curator', 'The Curator keeps them',
        'Four skeletons with prompts to answer — by you, or by an agent.') +
      opt('repo', 'Mirror a folder on this Mac',
        'Copied byte for byte. You edit them in the folder, never here.') +
      (choice.allowLater
        ? opt('later', 'Decide later',
          'Nothing is written now. Foundations asks again when you are ready.')
        : '') +
    '</div>';

  return (
    '<div class="fnd-init" data-fnd-init="' + escapeHtml(id) + '">' +
      options +
      (own === 'repo' ? repoArm(id, choice, busy) : '') +
      (own === 'curator' ? curatorArm(id, choice, busy, c.existingProject === true) : '') +
    '</div>'
  );
}

/** The MIRROR arm: a path, a scan, and the candidate rows it found. */
function repoArm(id, choice, busy) {
  const dis = busy ? ' disabled' : '';
  const scanning = choice.scanning === true;
  const cands = Array.isArray(choice.candidates) ? choice.candidates : null;
  const picked = pickedFiles(choice).length;

  const field =
    '<label class="fnd-init-label cur-eyebrow" for="' + escapeHtml(id) + '-root">' +
      'Folder on this Mac</label>' +
    '<div class="fnd-init-row">' +
      '<input class="fnd-init-path" id="' + escapeHtml(id) + '-root" type="text"' +
        ' autocomplete="off" spellcheck="false" placeholder="/Users/you/code/your-project"' +
        ' value="' + escapeHtml(choice.repoRoot || '') + '"' + dis + ' />' +
      '<button type="button" class="btn btn-secondary btn-xs fnd-init-scan"' +
        ' id="' + escapeHtml(id) + '-scan"' +
        (busy || scanning || !String(choice.repoRoot || '').trim() ? ' disabled' : '') + '>' +
        (scanning ? 'Looking…' : 'Find documents') +
      '</button>' +
    '</div>';

  // NEVER FOLDED, AND NEVER AN ALERT. The two refusals this can legitimately
  // get — a path that is not absolute, a folder that is not on this computer —
  // are both facts about what the person just typed, and they belong under it.
  const err = choice.scanError
    ? '<div class="fnd-init-note fnd-init-note-loud"><span>' +
      escapeHtml('Nothing was read: ' + choice.scanError) + '</span></div>'
    : '';

  let list = '';
  if (cands && !cands.length) {
    list = '<div class="fnd-init-note"><span>Nothing matched in that folder. The scan looks in ' +
      'docs folders and for documents named after a role; a file kept somewhere else can be ' +
      'added by path below.</span></div>';
  } else if (cands) {
    list =
      '<div class="fnd-init-cands">' +
        cands.map((cand) => candidateRow(id, choice, cand, busy)).join('') +
      '</div>' +
      (choice.truncated
        ? '<div class="fnd-init-note"><span>Only the first ' + cands.length +
          ' files are listed. Mirror these now and refresh later for the rest.</span></div>'
        : '') +
      '<div class="fnd-init-count">' +
        escapeHtml(picked + ' of ' + cands.length + ' found, ' +
          (Array.isArray(choice.extras) ? choice.extras.length : 0) + ' added by path') +
      '</div>';
  }

  // ── A FILE THE SCAN MISSED (D21) ─────────────────────────────────────────
  // Offered whenever a root has been named, not only after a scan found
  // nothing: somebody onboarding a real project usually knows exactly which
  // file they want and where it is, and making them scan first in order to
  // discover it is not there is a step that only wastes their time.
  const extras = Array.isArray(choice.extras) ? choice.extras : [];
  const extraRole = FOUNDATION_ROLES.includes(choice.extraRole) ? choice.extraRole : 'other';
  const extraDraft = normaliseRelPath(choice.extraPath);
  const extraBlock =
    '<div class="fnd-init-extra">' +
      '<label class="fnd-init-label cur-eyebrow" for="' + escapeHtml(id) + '-extra">' +
        'Add a file the scan missed</label>' +
      '<div class="fnd-init-row">' +
        '<input class="fnd-init-path" id="' + escapeHtml(id) + '-extra" type="text"' +
          ' autocomplete="off" spellcheck="false" placeholder="notes/architecture.md"' +
          ' value="' + escapeHtml(choice.extraPath || '') + '"' + dis + ' />' +
        '<button type="button" class="btn btn-secondary btn-xs fnd-init-extra-add"' +
          ' id="' + escapeHtml(id) + '-extra-add"' + (busy || !extraDraft ? ' disabled' : '') + '>' +
          'Add' +
        '</button>' +
      '</div>' +
      renderRoleOptions({ value: extraRole, hook: 'fnd-extra-role', disabled: busy,
        label: 'Role for the file you are adding' }) +
      (extras.length
        ? '<div class="fnd-init-extras">' + extras.map((e, i) => (
          '<div class="fnd-init-import">' +
            '<span class="fnd-init-cand-path">' + escapeHtml(normaliseRelPath(e && e.path)) + '</span>' +
            '<span class="fnd-init-cand-role-flat">' +
              escapeHtml((e && e.role) || 'other') + '</span>' +
            '<button type="button" class="fnd-init-drop" data-fnd-extra-drop="' + i + '"' +
              ' aria-label="' + escapeHtml('Remove ' + normaliseRelPath(e && e.path)) + '"' + dis +
              '>&times;</button>' +
          '</div>'
        )).join('') + '</div>'
        : '') +
    '</div>';

  return '<div class="fnd-init-arm">' + field + err + list + extraBlock + '</div>';
}

/**
 * WHAT THE SERVER WOULD NOT COPY, AND WHY — never folded.
 *
 * The one surface where a typed path pays for itself or does not: a path that
 * is outside the root, is not markdown, is a symlink pointing out, or is over
 * the per-document cap comes back in `refused[]` with the store's own reason,
 * and the person who typed it has to see the reason next to what they typed.
 * Shared, because both hosts show an outcome.
 */
export function renderRefusedList(refused) {
  const list = Array.isArray(refused) ? refused.filter(Boolean) : [];
  if (!list.length) return '';
  return (
    '<div class="fnd-init-note fnd-init-note-loud">' +
      '<span><b>' + list.length + ' file' + (list.length === 1 ? ' was' : 's were') +
        ' not copied.</b> ' +
        escapeHtml(list.slice(0, 6).map((r) => (
          (r.path ? String(r.path) : 'a file') + ' — ' + (r.reason ? String(r.reason) : 'refused')
        )).join(' · ')) +
        (list.length > 6 ? escapeHtml(' … and ' + (list.length - 6) + ' more') : '') +
      '</span>' +
    '</div>'
  );
}

/** One scan candidate: a tick, the path, its size, and its role. */
function candidateRow(id, choice, cand, busy) {
  const path = String(cand && cand.path ? cand.path : '');
  const tooLarge = !!(cand && cand.tooLarge);
  const on = choice.picks[path] === true && !tooLarge;
  const role = choice.roles[path] || (cand && cand.suggestedRole) || 'other';
  const open = choice.roleOpenFor === path;
  const dis = busy || tooLarge ? ' disabled' : '';
  return (
    '<div class="fnd-init-cand' + (tooLarge ? ' is-refused' : '') + '">' +
      '<label class="fnd-init-cand-main">' +
        '<input type="checkbox" class="cur-check" data-fnd-cand="' + escapeHtml(path) + '"' +
          (on ? ' checked' : '') + dis + ' />' +
        '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>' +
        // THE DOCUMENT'S OWN FIRST HEADING, when it has one (D21). A list of
        // twelve paths is a list of twelve filenames; the heading is what the
        // file SAYS it is, and on a repository whose docs folder is
        // `01-intro.md`, `02-arch.md` it is the only thing that distinguishes
        // them. Absent on a file with no `# ` line, never invented.
        (cand && cand.firstHeading
          ? '<span class="fnd-init-cand-head">' + escapeHtml(String(cand.firstHeading)) + '</span>'
          : '') +
      '</label>' +
      '<span class="fnd-init-cand-size">' + escapeHtml(formatBytes(cand && cand.bytes)) + '</span>' +
      // THE REFUSAL IS ON THE ROW, not in a summary at the bottom: the reason
      // this one file cannot be mirrored is a fact about this one file.
      (tooLarge
        ? '<span class="fnd-init-cand-why">over the ' + escapeHtml(formatBytes(MAX_FOUNDATION_BYTES)) +
          ' per-document cap — not copied</span>'
        : '<button type="button" class="fnd-init-cand-role"' +
          ' data-fnd-role-open="' + escapeHtml(path) + '"' +
          ' aria-expanded="' + (open ? 'true' : 'false') + '"' +
          ' aria-label="' + escapeHtml('Change the role of ' + path) + '"' + dis + '>' +
          escapeHtml(role) + '</button>') +
      (open && !tooLarge
        ? renderRoleOptions({ value: role, hook: 'fnd-role', scope: path, disabled: busy,
          label: 'Role for ' + path })
        : '') +
    '</div>'
  );
}

/**
 * The CURATOR arm: the seed tick, and the optional files to start from.
 *
 * `existingProject` distinguishes the two hosts' truth about the file
 * chooser's "nothing is uploaded until…" clause. On the create form the
 * project does not exist yet, so the clause is literally true as written; in
 * Agent memory the project the chooser is attached to already exists — what
 * has not happened yet is the documents themselves.
 */
function curatorArm(id, choice, busy, existingProject) {
  const dis = busy ? ' disabled' : '';
  const imports = Array.isArray(choice.imports) ? choice.imports : [];
  const seedRow =
    '<label class="fnd-init-seed">' +
      '<input type="checkbox" class="cur-check" id="' + escapeHtml(id) + '-seed"' +
        ' data-fnd-seed="1"' + (choice.seed === false ? '' : ' checked') + dis + ' />' +
      '<span>Seed the four skeletons — Architecture, Decisions, Conventions, Roadmap</span>' +
    '</label>';

  // ── A REAL BUTTON, AND AN INPUT THAT IS `hidden` (P1-7) ─────────────────
  //
  // The first cut wrapped a `.visually-hidden` file input in a <label> wearing
  // the button classes. That is the pattern this app's own focus work rules
  // out: a visually-hidden input is STILL FOCUSABLE, so a keyboard user's
  // focus lands on something invisible while the thing that looks like a
  // button cannot be focused at all and can never paint `--ring-focus` — the
  // token that exists precisely because the one state that must be findable
  // was the hardest thing on the page to find.
  //
  // The app's shipped pattern is already correct and is reused verbatim:
  // `<input type="file" … hidden>` (`hidden`, so it is out of the tab order
  // entirely) plus a `<button>` whose handler calls `.click()` on it —
  // views/ingest.js's drop zone. The button carries an id so the host can put
  // it in its focus-restore table.
  const chooser =
    '<div class="fnd-init-row">' +
      '<input type="file" id="' + escapeHtml(id) + '-files"' +
        ' accept=".md,.txt,text/markdown,text/plain" multiple hidden' + dis + ' />' +
      '<button type="button" class="btn btn-secondary btn-xs fnd-init-file"' +
        ' id="' + escapeHtml(id) + '-files-btn"' + dis + '>Choose files…</button>' +
      '<span class="fnd-init-file-hint">Optional. Each file becomes one document, read on this ' +
        'computer — nothing is uploaded until you ' +
        (existingProject ? 'set up documents' : 'create the project') + '.</span>' +
    '</div>';

  const err = choice.importError
    ? '<div class="fnd-init-note fnd-init-note-loud"><span>' +
      escapeHtml(choice.importError) + '</span></div>'
    : '';

  const list = imports.length
    ? '<div class="fnd-init-imports">' + imports.map((f, i) => (
      '<div class="fnd-init-import' + (f.error ? ' is-refused' : '') + '">' +
        '<span class="fnd-init-cand-path">' + escapeHtml(f.slug || f.name) + '</span>' +
        '<span class="fnd-init-cand-size">' + escapeHtml(formatBytes(f.size)) + '</span>' +
        (f.error
          ? '<span class="fnd-init-cand-why">' + escapeHtml(f.error) + '</span>'
          : '<span class="fnd-init-cand-role-flat">' + escapeHtml(f.role || 'other') + '</span>' +
            (SKELETON_SLUGS.includes(f.slug) && choice.seed !== false
              ? '<span class="fnd-init-cand-why">replaces the ' +
                escapeHtml(String(f.slug).replace(/\.md$/, '')) + ' skeleton</span>'
              : '')) +
        '<button type="button" class="fnd-init-drop" data-fnd-import-drop="' + i + '"' +
          ' aria-label="' + escapeHtml('Remove ' + (f.slug || f.name)) + '"' + dis + '>&times;</button>' +
      '</div>'
    )).join('') + '</div>'
    : '';

  return '<div class="fnd-init-arm">' + seedRow + chooser + err + list + '</div>';
}

// ═════════════════════════════════════════════════════════════════════════
// READING A FILE, AND READING A REPOSITORY
// ═════════════════════════════════════════════════════════════════════════

/**
 * ONE FILE THE OWNER PICKED, AS A DOCUMENT.
 *
 * ── THE WALL IS CHECKED BEFORE THE READ, NOT AFTER IT ───────────────────
 * `file.size` is available synchronously and the store refuses anything over
 * `MAX_FOUNDATION_BYTES`, so a 40 MB file is refused with both numbers and is
 * never read into memory. Reading first and refusing afterwards would spend
 * the whole file to learn something the browser already knew.
 *
 * Nothing is uploaded. The text goes into the editor's textarea so the owner
 * SEES it before saving, and the save is the ordinary PUT.
 *
 * `readerImpl` is a test seam — the same shape `compileConversation`'s
 * `opts.generateText` is, and null in production — because `FileReader` is a
 * browser global that a Node suite has no honest way to provide.
 */
export async function readPickedFile(file, readerImpl) {
  const name = (file && file.name) || 'document.md';
  const size = Number.isFinite(file && file.size) ? file.size : 0;
  const base = { name, size, slug: slugForFilename(name), role: roleForBasename(name) };
  // ── WHAT KIND OF FILE IT IS, CHECKED BEFORE ANYTHING ELSE (contract §10) ─
  //
  // The store mirrors `.md` and `.txt` only, and a foundation is text an agent
  // reads verbatim — so extracting a PDF would be a TRANSFORMATION, which is
  // the one thing this tier exists not to do. The refusal therefore names the
  // two ways forward rather than only the rule: ingest transforms on purpose
  // and is the right tool for a PDF, and an export is the right tool when the
  // document itself is what must travel.
  //
  // It is checked FIRST, before the size, because kind is the more specific
  // fact — a 40 MB PDF is not "too large", it is the wrong kind — and it is
  // checked at all, rather than left to the `accept` attribute, because every
  // file dialog on every platform offers an "All files" escape from it.
  //
  // `refusal` is a COMPLETE SENTENCE and `error` is a fragment, and the
  // difference is not stylistic: the hosts render `error` inside a row (as
  // "<name> <error>.") and `refusal` unfolded where the picker is. A file
  // refused on kind never becomes a row at all.
  const ext = /\.([a-z0-9]+)$/i.exec(String(name));
  const kind = ext ? ext[1].toLowerCase() : '';
  if (kind === 'pdf') {
    return {
      ...base, title: titleFromText('', name), text: '', error: 'is a PDF — not read',
      refusal: 'Documents are kept word for word; a PDF needs converting. Ingest it into the '
        + 'wiki, or export it as Markdown first.',
    };
  }
  if (kind !== 'md' && kind !== 'txt' && kind !== 'markdown' && kind !== 'mdown') {
    return {
      ...base, title: titleFromText('', name), text: '',
      error: 'is not Markdown or text — not read',
      refusal: 'Documents are kept word for word, so they have to be Markdown or text. '
        + shortFileName(name) + ' is neither. Ingest it into the wiki instead, or export it '
        + 'as Markdown first.',
    };
  }
  if (size > MAX_FOUNDATION_BYTES) {
    // ── BOTH NUMBERS, AND IN BYTES ────────────────────────────────────────
    // The KB figures alone are useless at the boundary: a file one byte over
    // the cap reads "is 512 KB, over the 512 KB cap", which states a refusal
    // and then contradicts it. So the exact byte counts carry the argument and
    // the KB figures are the gloss.
    return {
      ...base,
      title: titleFromText('', name),
      text: '',
      error: 'is ' + size.toLocaleString('en-US') + ' bytes (' + formatBytes(size)
        + '), over the ' + MAX_FOUNDATION_BYTES.toLocaleString('en-US') + '-byte ('
        + formatBytes(MAX_FOUNDATION_BYTES) + ') per-document cap — not read',
      refusal: null,
    };
  }
  if (!base.slug) {
    return {
      ...base,
      title: titleFromText('', name),
      text: '',
      error: 'has no usable file name — rename it to lowercase letters, digits and hyphens',
      refusal: null,
    };
  }
  let text = '';
  try {
    text = await (typeof readerImpl === 'function' ? readerImpl(file) : readFileAsText(file));
  } catch (err) {
    return {
      ...base, title: titleFromText('', name), text: '',
      error: (err && err.message) || 'could not be read', refusal: null,
    };
  }
  return {
    ...base, title: titleFromText(text, name), text: String(text == null ? '' : text),
    error: null, refusal: null,
  };
}

/**
 * A FILENAME, SHORT ENOUGH TO PUT IN A SENTENCE.
 *
 * The name is the owner's own and every host escapes it on its way into
 * markup, so this is not an escaping function — it is a LENGTH bound, because
 * a 4 KB filename pasted into a file dialog would otherwise become the whole
 * refusal panel.
 */
function shortFileName(name) {
  const s = String(name == null ? '' : name);
  const base = s.slice(s.lastIndexOf('/') + 1);
  return base.length > 60 ? base.slice(0, 57) + '…' : (base || 'That file');
}

/** UTF-8, through the browser's own reader. Wrapped so the caller sees a Promise. */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') { reject(new Error('this browser cannot read local files')); return; }
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
    fr.onerror = () => reject(new Error('could not be read'));
    fr.readAsText(file, 'UTF-8');
  });
}

/**
 * WHAT IS IN THAT CHECKOUT — a read, and only a read.
 *
 * `GET /api/memory/repo-scan?root=<abs>`. Never throws; the two refusals it
 * can legitimately get (a path that is not absolute, a folder that is not on
 * this computer) come back as `error` so the arm can print them under the
 * field the person typed into.
 */
export async function scanRepo(root, fetchImpl) {
  const f = typeof fetchImpl === 'function' ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, error: 'this browser cannot make requests' };
  try {
    const res = await f('/api/memory/repo-scan?root=' + encodeURIComponent(String(root || '')));
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok || !data || !data.ok) {
      return { ok: false, error: (data && (data.message || data.error)) || ('HTTP ' + res.status) };
    }
    return {
      ok: true,
      root: data.root || String(root || ''),
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      truncated: data.truncated === true,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'the request failed' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════

/**
 * BIND ONE CHOOSER.
 *
 * `doc` is passed in rather than reached for, so the same binder runs against
 * a real document in the browser and against a DOM model in the suite. Every
 * listener writes into `cfg.choice` and then decides whether a repaint is
 * owed: the PATH FIELD never repaints (a render rebuilds the input and takes
 * the caret with it — the rule views/domains.js's lifecycle form and
 * views/memory.js's brief editor both follow), and everything else does,
 * because everything else changes which controls are on screen.
 *
 * `onChange` is the host's repaint. `onReport` is how the binder hands back an
 * async outcome (the scan, a file read) that landed after the host may have
 * moved on — the host owns the staleness check, because only it knows what it
 * is looking at now.
 */
export function bindFoundationsChooser(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const doc = c.doc;
  const id = String(c.id || 'fnd-init');
  const choice = c.choice;
  if (!doc || !choice || typeof doc.querySelectorAll !== 'function') return;
  const rerender = typeof c.onChange === 'function' ? c.onChange : () => {};
  const fail = typeof c.onFailure === 'function' ? c.onFailure : () => {};

  const root = typeof doc.querySelector === 'function'
    ? doc.querySelector('[data-fnd-init="' + id + '"]') : null;
  const scope = root || doc;
  const all = (sel) => {
    const list = scope.querySelectorAll(sel);
    return list ? Array.prototype.slice.call(list) : [];
  };

  all('[data-fnd-own]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset ? btn.dataset.fndOwn : btn.getAttribute('data-fnd-own');
      if (!next || next === choice.ownership) return;
      choice.ownership = next;
      // THE OTHER ARM'S WORK IS KEPT, not cleared. Someone who types a path,
      // scans, reads the list and then presses "The Curator keeps them" to
      // compare has not asked to throw the scan away — and `chooserBody`
      // reads only the fields the chosen arm owns, so nothing leaks onto the
      // wire from the arm that is not showing.
      choice.roleOpenFor = null;
      rerender();
    });
  });

  // THE PATH FIELD: straight into state, no repaint. The scan button's
  // disabled state is the only thing on screen this field changes, so it is
  // set on the LIVE node, with the SAME predicate the renderer uses.
  const pathEl = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-root') : null;
  if (pathEl) {
    pathEl.addEventListener('input', () => {
      choice.repoRoot = pathEl.value;
      const scan = doc.getElementById(id + '-scan');
      if (scan) scan.disabled = !String(choice.repoRoot || '').trim() || choice.scanning === true;
    });
    pathEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const scan = doc.getElementById(id + '-scan');
      if (scan && !scan.disabled) scan.click();
    });
  }

  const scanBtn = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-scan') : null;
  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      const root2 = String(choice.repoRoot || '').trim();
      if (!root2 || choice.scanning) return;
      choice.scanning = true;
      choice.scanError = null;
      rerender();
      scanRepo(root2, c.fetchImpl).then((got) => {
        // The reply belongs to the root it was asked for. A person who
        // corrects the path and scans again must not have the first answer
        // land on top of the second.
        if (String(choice.repoRoot || '').trim() !== root2) return;
        choice.scanning = false;
        if (!got.ok) {
          choice.scanError = got.error;
          choice.candidates = null;
        } else {
          choice.scanError = null;
          choice.candidates = got.candidates;
          choice.truncated = got.truncated;
          // EVERYTHING USABLE IS TICKED. The person pressed "Find documents"
          // in order to mirror what is there; making them tick eight boxes
          // afterwards is the friction, not the safety. The refused ones are
          // never ticked, and the count line says how many are selected.
          choice.picks = {};
          for (const cand of got.candidates) {
            if (cand && cand.path && !cand.tooLarge) choice.picks[cand.path] = true;
          }
        }
        rerender();
      }).catch((err) => fail(err));
    });
  }

  all('[data-fnd-cand]').forEach((box) => {
    box.addEventListener('change', () => {
      const p = box.dataset ? box.dataset.fndCand : box.getAttribute('data-fnd-cand');
      if (!p) return;
      if (box.checked) choice.picks[p] = true; else delete choice.picks[p];
      rerender();
    });
  });

  all('[data-fnd-role-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset ? btn.dataset.fndRoleOpen : btn.getAttribute('data-fnd-role-open');
      if (!p) return;
      choice.roleOpenFor = choice.roleOpenFor === p ? null : p;
      rerender();
    });
  });

  all('[data-fnd-role]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const role = btn.dataset ? btn.dataset.fndRole : btn.getAttribute('data-fnd-role');
      const p = btn.dataset ? btn.dataset.fndRoleScope : btn.getAttribute('data-fnd-role-scope');
      if (!role || !p || !FOUNDATION_ROLES.includes(role)) return;
      choice.roles[p] = role;
      choice.roleOpenFor = null;
      // Picking a role is also a statement that this file is wanted.
      choice.picks[p] = true;
      rerender();
    });
  });

  // ── THE TYPED PATH (D21) ────────────────────────────────────────────────
  // The field writes straight into state with no repaint, for the reason the
  // root field above states; the only thing on screen it changes is the Add
  // button's disabled state, set on the LIVE node with the SAME predicate the
  // renderer uses. The ROLE row beside it does repaint, because a pressed
  // option button has to come back pressed.
  const extraEl = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-extra') : null;
  const addExtra = () => {
    const p = normaliseRelPath(choice.extraPath);
    if (!p) return;
    choice.extras.push({
      path: p,
      role: FOUNDATION_ROLES.includes(choice.extraRole) ? choice.extraRole : roleForBasename(p),
    });
    choice.extraPath = '';
    // The role does NOT reset. Somebody adding three ADRs by hand picks
    // `decisions` once; resetting to `other` between them would make the
    // control fight the person using it.
    rerender();
  };
  if (extraEl) {
    extraEl.addEventListener('input', () => {
      choice.extraPath = extraEl.value;
      const add = doc.getElementById(id + '-extra-add');
      if (add) add.disabled = !normaliseRelPath(choice.extraPath);
    });
    extraEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      addExtra();
    });
  }
  const addBtn = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-extra-add') : null;
  if (addBtn) addBtn.addEventListener('click', addExtra);

  all('[data-fnd-extra-role]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const role = btn.dataset ? btn.dataset.fndExtraRole : btn.getAttribute('data-fnd-extra-role');
      if (!role || !FOUNDATION_ROLES.includes(role)) return;
      choice.extraRole = role;
      rerender();
    });
  });

  all('[data-fnd-extra-drop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset ? btn.dataset.fndExtraDrop : btn.getAttribute('data-fnd-extra-drop');
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= choice.extras.length) return;
      choice.extras.splice(i, 1);
      rerender();
    });
  });

  const seedEl = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-seed') : null;
  if (seedEl) {
    seedEl.addEventListener('change', () => { choice.seed = !!seedEl.checked; rerender(); });
  }

  const fileEl = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-files') : null;
  // THE BUTTON OPENS THE HIDDEN INPUT (P1-7). One line, and it is the whole
  // reason the input may be `hidden` rather than merely invisible.
  const fileBtn = typeof doc.getElementById === 'function'
    ? doc.getElementById(id + '-files-btn') : null;
  if (fileBtn && fileEl) {
    fileBtn.addEventListener('click', () => {
      if (typeof fileEl.click === 'function') fileEl.click();
    });
  }
  if (fileEl) {
    fileEl.addEventListener('change', () => {
      const files = fileEl.files ? Array.prototype.slice.call(fileEl.files) : [];
      if (!files.length) return;
      choice.importError = null;
      Promise.all(files.map((f) => readPickedFile(f, c.readerImpl))).then((read) => {
        for (const r of read) {
          // ── A KIND REFUSAL IS A SENTENCE, NOT A ROW (contract §10) ──────
          // A PDF was never a candidate document, so listing it beside four
          // real ones as a row with a reason in a narrow cell says the wrong
          // thing about what happened: nothing was read, and the sentence
          // that says why belongs where the picker is. A SIZE refusal is
          // still a row — that file WAS the right kind, and one fact about
          // it disqualified it.
          if (r.refusal) { choice.importError = r.refusal; continue; }
          // A REFUSED FILE IS STILL LISTED, with its reason on its own row:
          // a file that silently did not arrive is the worst outcome for
          // somebody who picked six and got five.
          choice.imports.push(r);
        }
        rerender();
      }).catch((err) => fail(err));
    });
  }

  all('[data-fnd-import-drop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset ? btn.dataset.fndImportDrop : btn.getAttribute('data-fnd-import-drop');
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= choice.imports.length) return;
      choice.imports.splice(i, 1);
      rerender();
    });
  });
}
