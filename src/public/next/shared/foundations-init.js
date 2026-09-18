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
// ── IT IMPORTS ONLY FROM THE DOM-FREE KIT, AND THAT IS DELIBERATE ────────
// The rule this module was written under is shared/text.js's: nothing that
// reaches a DOM at import time, so the module stays executable in a plain Node
// suite (scripts/test-next-foundations-editor.js imports it directly rather
// than lifting it by brace-matching) and every DOM it touches is PASSED IN.
// Until v3.61.1 that was enforced as "no imports at all", which is the same
// thing only while no DOM-free kit module exists.
//
// `shared/age.js` is one: its own header says "Nothing here touches
// `document`, so a suite can import this module in plain Node", and it is the
// app's SINGLE age ladder — `formatAge`'s body is deliberately byte-identical
// in three places and pinned three ways precisely because copying it is the
// failure mode. A fourth hand-kept copy in this file, to put an age on a
// candidate row, would have needed a fourth pin. So the import is taken and
// the CONTRACT is now stated as what it always meant: this module may import
// from the DOM-free kit (`age.js`) and from nothing else — asserted as an
// allow-list by the suite rather than as the absence of the word `import`.
//
// It still carries its own `escapeHtml` — a four-line copy, pinned against the
// shell's by the suite — because the shell's lives in `app.js`, which IS
// DOM-bound at import time.
import { formatAge, freshnessTier } from './age.js';
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
    // ── THE NATIVE FOLDER PICKER (v3.61.1) ────────────────────────────────
    // `picking` is the dialog being open — it blocks for as long as the person
    // browses, so the control has to say so. `pickUnavailable` is the SENTENCE
    // the server gave when there is no picker on this build at all: a fact,
    // held so the button can be WITHHELD with its reason rather than offered
    // and failed on every press (v3.16.1). `pickError` is a picker that should
    // have worked and did not, painted in flow like every other refusal here.
    picking: false,
    pickError: null,
    pickUnavailable: null,
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

// ═════════════════════════════════════════════════════════════════════════
// WHAT IS TICKED, WHAT IT COSTS, AND WHY A CONTROL IS OFF
// ═════════════════════════════════════════════════════════════════════════

/**
 * THE ROLES A SCAN TICKS BY ITSELF (v3.61.1).
 *
 * ── THE DEFECT THIS CLOSES, MEASURED ON THE MAINTAINER'S OWN REPOSITORY ──
 * v3.61.0 ticked EVERY usable candidate, on the argument that somebody who
 * pressed "Find documents" wants what is there. On a real repository that
 * came out as **25 documents · 1,875 KB** mirrored against a 200 KB project
 * budget — nine times over it — including `README (6).md` out of a gitignored
 * source folder. The argument was right about the gesture and wrong about the
 * set: what the person wants is the documents an agent must not act without,
 * and the scan already knows which those are, because it assigns every
 * candidate a role.
 *
 * So the default is the FOUR canonical roles and nothing else. `api`, `guide`
 * and `other` — the roles a README, a changelog and a handbook land on — are
 * listed, sized, aged and one tick away, and they start unticked. The count
 * line says "4 of 25 ticked" so the untouched twenty-one are a visible
 * decision rather than an omission.
 *
 * The first four of `FOUNDATION_ROLES` by definition, sliced from it rather
 * than re-typed: the store's order IS the reading order, and a second literal
 * list here would be free to disagree with it.
 */
export const DEFAULT_TICK_ROLES = Object.freeze(FOUNDATION_ROLES.slice(0, 4));

/** Would the scan tick this candidate by itself? Pure, and the only rule. */
export function ticksByDefault(cand) {
  if (!cand || cand.tooLarge) return false;
  if (!cand.path) return false;
  return DEFAULT_TICK_ROLES.includes(cand.suggestedRole);
}

/** The `picks` map a fresh scan result starts with. */
export function defaultPicks(candidates) {
  const out = {};
  const list = Array.isArray(candidates) ? candidates : [];
  for (const cand of list) if (ticksByDefault(cand)) out[String(cand.path)] = true;
  return out;
}

/**
 * THE BYTES THE TICKED CANDIDATES WOULD ADD UP TO.
 *
 * Candidates only. A typed extra has no size — the browser has never seen
 * that file — so it is EXCLUDED from the figure and DISCLOSED beside it by
 * `countLineText`, rather than being counted as zero, which would make the
 * total read as a measurement when it is a lower bound.
 */
export function tickedBytes(choice) {
  const c = choice && typeof choice === 'object' ? choice : null;
  const list = c && Array.isArray(c.candidates) ? c.candidates : [];
  let total = 0;
  for (const cand of list) {
    if (!cand || cand.tooLarge) continue;
    const p = String(cand.path || '');
    if (!p || !c.picks || c.picks[p] !== true) continue;
    total += Number.isFinite(cand.bytes) && cand.bytes > 0 ? cand.bytes : 0;
  }
  return total;
}

/**
 * THE RUNNING TOTAL, AS ONE LINE — recomputed on every tick, in place.
 *
 * "4 of 25 ticked · 186 KB of a 200 KB budget". The second clause is why this
 * line exists: the tick count alone cannot tell somebody they are about to
 * blow the budget, and the budget is the figure that decides how much of what
 * they mirror an agent will actually receive.
 */
export function countLineText(choice) {
  const c = choice && typeof choice === 'object' ? choice : null;
  const list = c && Array.isArray(c.candidates) ? c.candidates : [];
  const usable = list.filter((cand) => cand && cand.path && !cand.tooLarge).length;
  const ticked = pickedFiles(c || {}).filter((f) => {
    // `pickedFiles` returns candidates AND extras; the count of TICKED rows is
    // the candidate half, so the extras are counted in their own clause.
    return list.some((cand) => cand && cand.path === f.path && !cand.tooLarge);
  }).length;
  const extras = c && Array.isArray(c.extras) ? c.extras.length : 0;
  let out = ticked + ' of ' + usable + ' ticked · ' + formatBytes(tickedBytes(c))
    + ' of a ' + formatBytes(FOUNDATIONS_BUDGET_BYTES) + ' budget';
  if (extras) out += ' · ' + extras + ' added by path, size not known yet';
  return out;
}

/**
 * OVER THE BUDGET — a WARNING, and it names the consequence.
 *
 * The 200 KB project budget is a DISCLOSURE and never a wall (D6): the store
 * accepts the write. What it does not accept is sending all of it — the
 * session bootstrap has its own 120 KB budget and drops document BODIES
 * last-first when it is exceeded. So the sentence says what happens rather
 * than "too big": a person who reads "over budget" and shrugs is right to,
 * and a person who reads "and the rest is dropped" ticks fewer boxes.
 *
 * Never folded (v3.16.1). Returns '' when there is nothing to warn about, so
 * the caller can concatenate it unconditionally.
 */
export function budgetWarning(choice) {
  const bytes = tickedBytes(choice);
  if (bytes <= FOUNDATIONS_BUDGET_BYTES) return '';
  return 'Over the ' + formatBytes(FOUNDATIONS_BUDGET_BYTES) + ' budget: agents receive '
    + formatBytes(120 * 1024) + ' per session and the rest is dropped, last in reading order first.';
}

/**
 * WHY "Find documents" IS OFF — the reason, as the sentence under it.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
 * The maintainer, on v3.61.0, with the Mirror arm open: *"I don't see any scan
 * feature anywhere."* It was there — disabled, because the path field was
 * empty, and nothing on the screen said so. A greyed control with no reason
 * does not read as "not yet", it reads as "not for you", and the candidate
 * list that only exists after a scan was therefore unreachable.
 *
 * Returns '' when the control is live, so the note is emitted only in the
 * state it explains.
 */
export function scanBlockedReason(choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  if (c.scanning === true) return '';
  if (!String(c.repoRoot || '').trim()) return 'Type or choose the folder first.';
  return '';
}

/**
 * WHY THE COMMIT IS OFF — the same rule for both hosts.
 *
 * A mirror that has been SCANNED and has nothing ticked would set the
 * ownership and copy no documents: `chooserBody` omits an empty `files`, so
 * the wire carries a decision nobody made. Before a scan there is nothing to
 * tick and pointing at the folder is a complete answer (documents can be
 * added later), which is why the rule keys on `candidates` being a non-empty
 * ARRAY rather than on the picks alone — the two states are different asks
 * and a single "nothing ticked" test would refuse the legitimate one.
 */
export function commitBlockedReason(choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  if (c.ownership !== 'repo') return '';
  if (!Array.isArray(c.candidates) || !c.candidates.length) return '';
  if (pickedFiles(c).length) return '';
  return 'Tick at least one document.';
}

/**
 * HOW OLD THE SOURCE FILE IS — the shared dot, and the word beside it.
 *
 * The app's ONE freshness scale (shared/freshness.css, `shared/age.js`'s
 * bands) and the `data-mem-age-at` hook `tickAges` walks once a second, so a
 * picker left open does not drift. No `.fresh-` rule is declared by this
 * component's stylesheet — that prefix belongs to shared/freshness.css
 * outright and scripts/test-freshness-scale.js fails a second declarer — and
 * no text here is painted with a `--fresh-*` token: the dot is the graphic,
 * the word is the fact, and the word carries it on its own for anyone who
 * cannot see the colour.
 *
 * '' when there is no timestamp: an unknown age has nothing to tick and a
 * dashed ring beside the word "unknown" on every row of a folder the scan
 * could not stat is noise rather than information.
 */
export function candidateAgeHtml(iso) {
  const t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  const words = formatAge(secs);
  if (!words) return '';
  return '<span class="fnd-init-cand-age" data-mem-age-at="' + escapeHtml(iso) + '">' +
    '<span class="fresh-dot fresh-' + freshnessTier(secs) + '" aria-hidden="true"></span>' +
    '<span class="mem-age-words">' + escapeHtml(words) + '</span>' +
  '</span>';
}

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
      // ── EACH LINE SAYS WHAT YOU WILL DO NEXT (v3.61.1) ──────────────────
      // Both lines were a CONSEQUENCE and neither said what the arm asks of
      // you, which is how the maintainer read the whole Mirror arm as having
      // no scan in it: "Copied byte for byte. You edit them in the folder,
      // never here." describes the end state of a decision whose first step —
      // picking which files — was invisible until the card was pressed. The
      // line now names that step. Where a document is EDITED afterwards is
      // mechanism and is in the host's ⓘ, which says it in more words than a
      // card can.
      // Both stay within the 13-word ceiling: 13 and 11.
      opt('curator', 'The Curator keeps them',
        'Four skeletons to fill — by you or an agent. Or your own files.') +
      opt('repo', 'Mirror a folder on this Mac',
        'Copied byte for byte from a folder. You pick which files.') +
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

/**
 * The MIRROR arm: a path, a scan, and the candidate rows it found.
 *
 * ── WHAT v3.61.1 CHANGED HERE, AND WHY ──────────────────────────────────
 * The maintainer, on the shipped v3.61.0 arm: *"I don't see any scan feature
 * anywhere."* Three things were true at once — the only way to name a folder
 * was to TYPE an absolute path, "Find documents" was disabled with no reason
 * given, and the candidate list (the whole point of the arm) does not exist
 * until a scan runs. Each one alone is a small friction; together they make
 * the feature unreachable, and the screen still looks finished.
 *
 * So: an INSTRUCTION line above the controls naming the three steps in order,
 * a native "Choose folder…" beside the field (withheld WITH its reason where
 * there is no picker), the disabled scan control carrying the sentence that
 * arms it, and the list under a one-line instruction saying what a tick means.
 */
function repoArm(id, choice, busy) {
  const dis = busy ? ' disabled' : '';
  const scanning = choice.scanning === true;
  const picking = choice.picking === true;
  const cands = Array.isArray(choice.candidates) ? choice.candidates : null;

  // ── THE ARM'S OWN INSTRUCTION (≤ 13 words: 10) ─────────────────────────
  // An INSTRUCTION, which is one of the three things design-system §3 admits
  // in a lede. It names the order of the two steps, because the second one
  // does not exist on screen until the first has run.
  const armLede =
    '<p class="fnd-init-armhd">Point at the folder, then tick the documents to copy.</p>';

  // ── THE NATIVE PICKER, OR THE REASON THERE IS NONE ─────────────────────
  // `POST /api/config/pick-path` — a read, deliberately NOT `pick-folder`,
  // which repoints the whole knowledge base. When the server answers
  // `no-dialog` the button is WITHHELD and its reason printed: a control whose
  // only outcome is a refusal is worse than no control, and the field beside
  // it is the answer in that state (v3.16.1).
  const pickBtn = choice.pickUnavailable
    ? ''
    : '<button type="button" class="btn btn-secondary btn-xs fnd-init-pick"' +
      ' id="' + escapeHtml(id) + '-pick"' + (busy || picking ? ' disabled' : '') + '>' +
      (picking ? 'Choosing…' : 'Choose folder…') +
    '</button>';

  const field =
    '<label class="fnd-init-label cur-eyebrow" for="' + escapeHtml(id) + '-root">' +
      'Folder on this Mac</label>' +
    '<div class="fnd-init-row">' +
      '<input class="fnd-init-path" id="' + escapeHtml(id) + '-root" type="text"' +
        ' autocomplete="off" spellcheck="false" placeholder="/Users/you/code/your-project"' +
        ' value="' + escapeHtml(choice.repoRoot || '') + '"' + dis + ' />' +
      pickBtn +
      '<button type="button" class="btn btn-secondary btn-xs fnd-init-scan"' +
        ' id="' + escapeHtml(id) + '-scan"' +
        (busy || scanning || !String(choice.repoRoot || '').trim() ? ' disabled' : '') + '>' +
        (scanning ? 'Looking…' : 'Find documents') +
      '</button>' +
    '</div>' +
    // ── WHY THE CONTROL IS OFF, UNDER THE CONTROL ───────────────────────
    // Emitted ALWAYS and merely `hidden`, because the path field writes into
    // state WITHOUT a render (a render rebuilds the input and takes the caret
    // with it) — so the only way this sentence can appear and disappear as
    // the field fills is for the live node to be toggled. `.fnd-init-why` has
    // its own `[hidden]` counter-rule in the stylesheet: `.tx-note` declares
    // `display: flex`, which defeats the attribute (design-system §9).
    reasonNote(id + '-why', scanBlockedReason(choice)) +
    // The picker's own two outcomes, both in flow: a build with no dialog, and
    // a dialog that failed.
    (choice.pickUnavailable
      ? '<div class="fnd-init-note"><span>' + escapeHtml(String(choice.pickUnavailable)) +
        '</span></div>'
      : '') +
    (choice.pickError
      ? '<div class="fnd-init-note fnd-init-note-loud"><span>' +
        escapeHtml(String(choice.pickError)) + '</span></div>'
      : '');

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
      // ── WHAT A TICK MEANS, ABOVE THE LIST (8 words) ──────────────────────
      // The list is the arm's main content once it exists, and the rows carry
      // a checkbox whose meaning — "an agent reads this first" — is the whole
      // subject of the tier. One line, in flow, never folded.
      '<p class="fnd-init-listhd">Tick the documents an agent must read first.</p>' +
      '<div class="fnd-init-cands">' +
        cands.map((cand) => candidateRow(id, choice, cand, busy)).join('') +
      '</div>' +
      (choice.truncated
        ? '<div class="fnd-init-note"><span>Only the first ' + cands.length +
          ' files are listed. Mirror these now and refresh later for the rest.</span></div>'
        : '') +
      // ── THE RUNNING TOTAL (v3.61.1) ──────────────────────────────────────
      // Ticks and BYTES, against the project budget. Patched in place on every
      // tick by the binder — never re-rendered, because a re-render of a
      // 44-row list throws the reader back to the top of it.
      '<div class="fnd-init-count" id="' + escapeHtml(id) + '-count">' +
        escapeHtml(countLineText(choice)) +
      '</div>' +
      // OVER BUDGET IS A WARNING AND NEVER FOLDS. Emitted always and `hidden`
      // under the budget, for the same reason the scan's reason note is: the
      // tick that crosses the line does not re-render.
      '<div class="fnd-init-note fnd-init-note-loud fnd-init-budget"' +
        ' id="' + escapeHtml(id) + '-budget"' + (budgetWarning(choice) ? '' : ' hidden') + '>' +
        '<span>' + escapeHtml(budgetWarning(choice)) + '</span>' +
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
      // ── THE ROLE CHIPS BELONG TO THIS FIELD, AND SAY SO (v3.61.1) ──────
      //
      // THE DEFECT: on the shipped arm these seven buttons sat at the level of
      // the arm, under the typed-path row, with no label of their own — and
      // the maintainer read them as an unexplained row of chips, which is what
      // they were. Nothing said they governed the path in the field above, and
      // nothing said they did NOT govern the ticked rows in the list (whose
      // roles have their own per-row control).
      //
      // So they are INSIDE the field's own group, behind the word "as", and
      // they appear only while the field has text — there is no file to give a
      // role to until then. Emitted ALWAYS and toggled by `hidden` on the live
      // node, because the field writes into state without a render; the
      // `[hidden]` counter-rule is in the stylesheet beside the rule that
      // makes this a flex row (design-system §9).
      '<div class="fnd-init-extra-as" id="' + escapeHtml(id) + '-extra-as"' +
        (extraDraft ? '' : ' hidden') + '>' +
        '<span class="fnd-init-as-word">as</span>' +
        renderRoleOptions({ value: extraRole, hook: 'fnd-extra-role', disabled: busy,
          label: 'Role for the file you are adding' }) +
      '</div>' +
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

  // THE ARM'S CONTROLS AS ONE GROUP, under the card that opened them. The
  // instruction is the group's first line; the stylesheet gives the group its
  // own indent and rule so the controls read as belonging to the pressed
  // option rather than floating at the level of the two option cards.
  return '<div class="fnd-init-arm">' + armLede + field + err + list + extraBlock + '</div>';
}

/**
 * THE SENTENCE UNDER A CONTROL THAT IS OFF.
 *
 * Emitted ALWAYS and `hidden` when there is no reason, never omitted: both
 * call sites sit beside a field that writes into state WITHOUT a render, so
 * the only way the note can appear as the condition changes is for the binder
 * to toggle a node that is already there. A `.tx-note` — the kit's one-line
 * qualifier for the control directly above it — with the `[hidden]`
 * counter-rule it needs because `.tx-note` sets `display: flex`.
 *
 * NO ICON. `.tx-note` renders one when given one, and this repo's own rule is
 * that an icon repeating the sentence beside it is not a second fact; the
 * loud refusals in this arm carry the attention treatment, and this is not a
 * refusal — it is the condition that arms a control.
 */
function reasonNote(domId, reason) {
  return '<div class="tx-note fnd-init-why" id="' + escapeHtml(domId) + '"' +
    (reason ? '' : ' hidden') + '><span>' + escapeHtml(reason || '') + '</span></div>';
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
    // `data-fnd-cand-row` is how the binder finds this row from the checkbox
    // inside it WITHOUT `closest()`: one lookup by path, which works the same
    // in the browser and in the suite's DOM model.
    '<div class="fnd-init-cand' + (tooLarge ? ' is-refused' : '') + '"' +
      ' data-fnd-cand-row="' + escapeHtml(path) + '">' +
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
      // ── HOW OLD THE SOURCE FILE IS (v3.61.1) ────────────────────────────
      // The maintainer's fourth finding: a picker listing a repository's
      // documents cannot answer "is this one still maintained", which is the
      // question that decides whether it belongs in tier 0 at all. The shared
      // dot and the shared words, on the shared hook, so it ticks with every
      // other age on the page. UNIFORM across rows including refused ones:
      // the age is a fact about the file, not a property of being usable.
      candidateAgeHtml(cand && cand.modifiedAt) +
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
      // ── A SLOT THAT IS ALWAYS THERE, FILLED ON DEMAND (v3.61.1) ─────────
      // The seven options are still painted for ONE row at a time — seven
      // buttons over forty rows is a wall, which is why `roleOpenFor` exists.
      // What changed is WHERE they are written: into a slot that is part of
      // every row, by the binder, rather than by re-rendering the arm. A
      // re-render rebuilt the scroll container and threw a reader of a 44-row
      // list back to the top of it, which is the defect the maintainer
      // reported; the slot is what lets the same state change be one
      // `innerHTML` write inside the row being pressed. `:empty` hides it, so
      // a closed slot occupies nothing.
      '<div class="fnd-init-roleslot" data-fnd-roleslot="' + escapeHtml(path) + '">' +
        (open && !tooLarge
          ? renderRoleOptions({ value: role, hook: 'fnd-role', scope: path, disabled: busy,
            label: 'Role for ' + path })
          : '') +
      '</div>' +
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
    '</div>' +
    // ── THE HINT IS A ONE-LINE NOTE NOW (v3.61.1) ───────────────────────
    //
    // It was 22 words wrapped beside the button — "Optional. Each file becomes
    // one document, read on this computer — nothing is uploaded until you set
    // up documents." — and it was the longest run of text in the card,
    // directly under a checkbox and above a primary. Two of its three clauses
    // are MECHANISM (what a chosen file becomes, and that it is read in this
    // browser), which design-system §3 puts behind the ⓘ; both hosts' panels
    // now say it in the room they have for it.
    //
    // WHAT STAYS VISIBLE is the privacy claim, because "nothing is uploaded"
    // answers a question somebody has BEFORE pressing a control that reads
    // their files, and because its second half is the one clause in this
    // module whose truth depends on which host is showing: on the create form
    // the project does not exist yet, so "until you create the project" is
    // literally true; in Agent memory it already does, and what has not
    // happened is the documents. 9 words either way, one line at both hosts'
    // widths.
    '<div class="tx-note fnd-init-why">' +
      '<span>Optional — nothing is uploaded until you ' +
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

/**
 * ASK FOR A FOLDER — `POST /api/config/pick-path`, which MUTATES NOTHING.
 *
 * Deliberately not `pick-folder`: that route repoints the whole knowledge
 * base (its own docblock calls `setDomainsDir` "the ONE set of post-pick
 * rules"), and what this arm needs is a string for a text field. The route
 * header carries the full argument for why that is a second route rather than
 * a flag on the first.
 *
 * Never throws. The four answers are distinguished by `reason` alone, so a
 * caller never reads a status code:
 *   {ok:true, path}            a folder was chosen
 *   {reason:'cancelled'}       the dialog was dismissed — say nothing
 *   {reason:'no-dialog', …}    there is no picker here; withhold the button
 *   {reason:'failed', …}       a picker that should work did not; say so
 */
export async function pickFolder(fetchImpl) {
  const f = typeof fetchImpl === 'function' ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, reason: 'no-dialog', message: 'This browser cannot make requests.' };
  try {
    const res = await f('/api/config/pick-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A KEY, not a sentence: the route looks it up in a frozen table of
      // literals, because its repo arm builds a shell command.
      body: JSON.stringify({ prompt: 'foundations' }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (data && data.ok === true && typeof data.path === 'string' && data.path.trim()) {
      return { ok: true, path: data.path.trim() };
    }
    const reason = data && typeof data.reason === 'string' ? data.reason : null;
    if (reason === 'cancelled') return { ok: false, reason: 'cancelled' };
    const message = [data && data.message, data && data.hint].filter(Boolean).join(' ')
      || ('The folder picker did not answer (HTTP ' + res.status + ').');
    // A 501 IS THE ONLY ANSWER THAT WITHHOLDS THE BUTTON. Anything else — a
    // 500, an unparseable body, a route that is not there on an older server —
    // is a failure of this attempt, not a statement about the build, and a
    // failure must not silently delete a control that works for other people.
    if (reason === 'no-dialog' || res.status === 501) return { ok: false, reason: 'no-dialog', message };
    return { ok: false, reason: 'failed', message };
  } catch (err) {
    return { ok: false, reason: 'failed', message: (err && err.message) || 'the request failed' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════

/**
 * A PATH, SAFE INSIDE AN ATTRIBUTE SELECTOR.
 *
 * `[data-fnd-cand-row="…"]` is built from a filesystem path, and a path may
 * legally contain a double quote or a backslash — either of which would end
 * the selector's string early and throw a SyntaxError out of
 * `querySelector`, taking the tick with it. `CSS.escape` is the wrong tool
 * (it escapes an IDENT, not a string body), so the two characters that can
 * terminate a quoted string are the two that are escaped.
 */
function cssEscapeAttr(p) {
  return String(p == null ? '' : p).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The role one candidate carries: the owner's override, else the scan's. */
function roleOfCandidate(choice, p) {
  if (choice && choice.roles && FOUNDATION_ROLES.includes(choice.roles[p])) return choice.roles[p];
  const list = choice && Array.isArray(choice.candidates) ? choice.candidates : [];
  const cand = list.find((x) => x && x.path === p);
  const suggested = cand && cand.suggestedRole;
  return FOUNDATION_ROLES.includes(suggested) ? suggested : 'other';
}

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
      // ── AND THE SENTENCE THAT SAYS WHY IT WAS OFF ─────────────────────
      // Patched on the live node beside the disabled flag it explains, from
      // the SAME predicate the renderer used (`scanBlockedReason`), so the
      // control and its reason cannot come apart. A render here would rebuild
      // the field and take the caret with it.
      const why = doc.getElementById(id + '-why');
      if (why) {
        const reason = scanBlockedReason(choice);
        const span = typeof why.querySelector === 'function' ? why.querySelector('span') : null;
        if (span) span.textContent = reason;
        why.hidden = !reason;
      }
    });
    pathEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const scan = doc.getElementById(id + '-scan');
      if (scan && !scan.disabled) scan.click();
    });
  }

  const runScan = () => {
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
          // ── THE FOUR CANONICAL ROLES ARE TICKED, NOT EVERYTHING ────────
          // v3.61.0 ticked every usable candidate and, on the maintainer's own
          // repository, that came out as 25 documents / 1,875 KB against a
          // 200 KB budget. `defaultPicks` holds the rule and the argument.
          choice.picks = defaultPicks(got.candidates);
        }
        rerender();
      }).catch((err) => fail(err));
  };

  const scanBtn = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-scan') : null;
  if (scanBtn) scanBtn.addEventListener('click', runScan);

  // ── THE NATIVE FOLDER PICKER (v3.61.1) ──────────────────────────────────
  //
  // Picking FILLS THE FIELD AND SCANS, in one gesture: somebody who has just
  // chosen the folder in a dialog has answered the question "which folder",
  // and making them press a second button to find out what is in it is the
  // step that made this arm read as having no scan at all.
  //
  // `no-dialog` is recorded as a FACT on the choice, which withholds the
  // button and prints the reason. Every other outcome leaves the button where
  // it is: a cancel is not an error and says nothing on screen, and a failure
  // is painted in flow.
  const pickBtn = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-pick') : null;
  if (pickBtn) {
    pickBtn.addEventListener('click', () => {
      if (choice.picking) return;
      choice.picking = true;
      choice.pickError = null;
      rerender();
      pickFolder(c.fetchImpl).then((got) => {
        choice.picking = false;
        if (got.reason === 'no-dialog') {
          choice.pickUnavailable = got.message;
        } else if (got.reason === 'failed') {
          choice.pickError = got.message;
        } else if (got.ok && got.path) {
          choice.repoRoot = got.path;
          // The scan needs the field's own repaint first — `runScan` reads
          // `choice.repoRoot`, which is already set, and rerender() inside it
          // paints the new path into the input.
          runScan();
          return;
        }
        rerender();
      }).catch((err) => fail(err));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE CANDIDATE LIST: DELEGATED, AND PATCHED IN PLACE
  // ═══════════════════════════════════════════════════════════════════════
  //
  // ── THE DEFECT, AND WHY IT WAS STRUCTURAL ────────────────────────────────
  // The maintainer, mirroring a real repository: *"when I select or deselect a
  // document I'm always thrown at the top — confusing with 50 documents."*
  // Measured before the fix, on a folder of 44 candidates at a 1370px window:
  // ticking the second-from-last row left the list's own `scrollTop` at 0,
  // having been 1105, with the container a DIFFERENT NODE and the focused
  // checkbox no longer focused. Every tick called the host's `onChange`, which
  // in Agent memory is `render(token)` — a full view render. The state change
  // was one boolean in a map; the repaint was the whole screen.
  //
  // ── THE RULE THIS FOLLOWS ────────────────────────────────────────────────
  // The same one the create form's keystroke handling and the brief editor's
  // counter already follow in this tree: a change that does not alter WHICH
  // CONTROLS EXIST writes state and patches the nodes that read it. Only a
  // scan result and an arm switch repaint, because both genuinely replace the
  // arm's contents.
  //
  // What a tick patches, and the full list of it: the row's own checkbox (the
  // browser already did that), the running count and budget line, the
  // over-budget warning, and — through `onSelect` — the host's commit control
  // and its reason note. Nothing else on the screen reads `picks`.
  //
  // DELEGATION rather than per-node listeners, for two reasons: the role
  // options are written into a row AFTER binding (so a listener bound at
  // render time would never see them), and one listener over a 200-row list is
  // 200 fewer.
  const attr = (el, key) => (el && el.dataset
    ? el.dataset[key]
    : (el && typeof el.getAttribute === 'function' ? el.getAttribute('data-' + key) : null));
  // The nearest ancestor (or the node itself) carrying `data-<key>`. Written
  // as a parent walk rather than `closest()` so it behaves identically in the
  // browser and in a suite's DOM model, where a node has no `closest`.
  const hostOf = (el, key) => {
    let n = el;
    for (let i = 0; n && i < 8; i++) {
      if (attr(n, key) != null) return n;
      n = n.parentElement || null;
    }
    return null;
  };
  const rowFor = (p) => (typeof scope.querySelector === 'function'
    ? scope.querySelector('[data-fnd-cand-row="' + cssEscapeAttr(p) + '"]') : null);
  const byId = (suffix) => (typeof doc.getElementById === 'function'
    ? doc.getElementById(id + suffix) : null);

  /** Everything on screen that reads `picks`, and nothing more. */
  const patchSelection = () => {
    const countEl = byId('-count');
    if (countEl) countEl.textContent = countLineText(choice);
    const budgetEl = byId('-budget');
    if (budgetEl) {
      const warn = budgetWarning(choice);
      const span = typeof budgetEl.querySelector === 'function'
        ? budgetEl.querySelector('span') : null;
      if (span) span.textContent = warn;
      budgetEl.hidden = !warn;
    }
    // The host owns its own commit control — this module emits none — so the
    // reason is handed over rather than written from here.
    if (typeof c.onSelect === 'function') c.onSelect(commitBlockedReason(choice));
  };

  /** Fill or empty ONE row's role slot. Never touches another row's DOM. */
  const paintRoleSlot = (p) => {
    const row = rowFor(p);
    const slot = row && typeof row.querySelector === 'function'
      ? row.querySelector('[data-fnd-roleslot]') : null;
    const btn = row && typeof row.querySelector === 'function'
      ? row.querySelector('[data-fnd-role-open]') : null;
    const open = choice.roleOpenFor === p;
    if (slot) {
      slot.innerHTML = open
        ? renderRoleOptions({ value: choice.roles[p] || roleOfCandidate(choice, p), hook: 'fnd-role',
          scope: p, disabled: false, label: 'Role for ' + p })
        : '';
    }
    if (btn && typeof btn.setAttribute === 'function') {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };

  if (typeof scope.addEventListener === 'function') {
    scope.addEventListener('change', (ev) => {
      const box = hostOf(ev && ev.target, 'fndCand');
      if (!box) return;
      const p = attr(box, 'fndCand');
      if (!p) return;
      if (box.checked) choice.picks[p] = true; else delete choice.picks[p];
      patchSelection();
    });
    scope.addEventListener('click', (ev) => {
      const openBtn = hostOf(ev && ev.target, 'fndRoleOpen');
      if (openBtn) {
        const p = attr(openBtn, 'fndRoleOpen');
        if (!p) return;
        const was = choice.roleOpenFor;
        choice.roleOpenFor = was === p ? null : p;
        // ONE ROW AT A TIME, and closing the other one is a patch of that row
        // rather than a repaint of the list.
        if (was && was !== p) paintRoleSlot(was);
        paintRoleSlot(p);
        return;
      }
      const roleBtn = hostOf(ev && ev.target, 'fndRole');
      if (roleBtn) {
        const role = attr(roleBtn, 'fndRole');
        const p = attr(roleBtn, 'fndRoleScope');
        if (!role || !p || !FOUNDATION_ROLES.includes(role)) return;
        choice.roles[p] = role;
        choice.roleOpenFor = null;
        // Picking a role is also a statement that this file is wanted.
        choice.picks[p] = true;
        const row = rowFor(p);
        const label = row && typeof row.querySelector === 'function'
          ? row.querySelector('[data-fnd-role-open]') : null;
        if (label) label.textContent = role;
        const box = row && typeof row.querySelector === 'function'
          ? row.querySelector('[data-fnd-cand]') : null;
        if (box) box.checked = true;
        paintRoleSlot(p);
        patchSelection();
      }
    });
  }

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
      const draft = normaliseRelPath(choice.extraPath);
      const add = doc.getElementById(id + '-extra-add');
      if (add) add.disabled = !draft;
      // ── THE ROLE CHIPS APPEAR WITH THE FILE THEY BELONG TO ────────────
      // There is nothing to give a role to until something is typed. Toggled
      // on the live node for the same reason the Add button's flag is: this
      // field must not be re-rendered under the caret.
      const as = doc.getElementById(id + '-extra-as');
      if (as) as.hidden = !draft;
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
