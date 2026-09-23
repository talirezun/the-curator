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
// ── AND THE MONITOR KIT (v3.65.2) ───────────────────────────────────────
// shared/monitor.js has no imports and touches no DOM, so it clears the same
// bar age.js does. It is taken for two readings the add panel needs and must
// not draw by hand: the recorded folder as a monitor line, and the running
// total as a DEPTH BAR against the project budget (design rule 6) — a second
// hand-built bar here is the shape rule 6 exists to prevent.
import { renderMonitor, renderDepthCell } from './monitor.js';
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
    // ── THE REMOTE MIRROR'S FOUR FIELDS (v3.65.0) ──────────────────────
    // The maintainer asked for this twice, and the gap it closes is named in
    // the store's own docblock: `initFoundations` refused anything that was
    // not an absolute path on this machine, so a computer with no checkout
    // could REFRESH a mirror somebody else started and could never START one.
    //
    // `remote` takes `owner/repo`, an https:// URL or a git@ URL — the store
    // resolves all three through ONE validator, so this field accepts what
    // that validator accepts rather than carrying a second grammar. A blank
    // `remoteRef` is the repository's default branch and a blank
    // `remotePath` is the whole repository, both of which the store spells
    // out, so both are OMITTED rather than sent empty.
    //
    // THERE IS NO TOKEN FIELD, AND THERE MAY NEVER BE ONE. `tokenSource`
    // names WHICH FILE the store reads a token out of — `config` is the
    // read-only token in Settings, `sync` is Personal Sync's PAT — and the
    // store's own rule is that a token in an argument neither authorises a
    // read nor appears in an answer. This form may not become the first
    // credential path into the app.
    //
    // ── `null` IS "NOBODY HAS CHOSEN" (v3.65.3) ──────────────────────────
    // Not `'config'`. The radio that is checked is DERIVED from the token
    // facts until the owner presses one — `selectedTokenSource` below — so a
    // saved read-only token is checked, and with no read-only token NOTHING
    // is, rather than a radio for a token that does not exist, or silently
    // Personal Sync's. Only the owner's own press writes a word here.
    remote: '',
    remoteRef: '',
    remotePath: '',
    tokenSource: null,
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
    // ── ADDING TO A MIRROR THAT ALREADY HAS DOCUMENTS (v3.65.2, C2) ──────
    // Set by the Context host when "Add from folder" opens on a populated
    // mirror. The maintainer called the old flow "rusty": the folder the app
    // already knew had to be typed again, a path typed there was scanned but
    // then IGNORED by the copy, eight rows arrived ticked, the one already
    // mirrored among them, and a second path field sat beside the list with
    // no word on what it was for. So in this mode:
    //   · `fixedRoot` is the manifest's recorded folder — shown as a fact and
    //     scanned on open, never a field, unless it is not on this computer;
    //   · `rootEditable` flips on when the scan of it fails, bringing the
    //     field back PREFILLED, and then the path scanned is the path sent;
    //   · `mirrored` are the source paths already copied — listed, never
    //     tickable; `projectBytes` is what they weigh, so the running total
    //     is the PROJECT's, against the project budget;
    //   · nothing is ticked by default, and a file the scan missed is added
    //     INTO the list (`extraOpen` is its row, open or closed).
    addMode: false,
    fixedRoot: null,
    rootEditable: false,
    mirrored: [],
    projectBytes: null,
    extraOpen: false,
    // THE TOKEN FACTS (v3.65.2, C1). Read by the Context host once per open
    // of the GitHub panel — `hasReadToken`/`readTokenLast4` from
    // `GET /api/config/github-read-token` (presence and four characters,
    // never the value), `hasSyncToken` from `GET /api/sync/status`. Unknown
    // is `undefined`, and unknown is never rendered as "available".
    hasReadToken: undefined,
    readTokenLast4: null,
    hasSyncToken: undefined,
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
  // ── A REMOTE MIRROR IS STILL `ownership: 'repo'` (v3.65.0) ───────────
  // The store keeps ONE ownership per project and a remote mirror IS a
  // mirror: what makes it remote is a non-null `repo.remote`, not a third
  // ownership word. So this arm sends `remote` + `tokenSource` INSTEAD of
  // `repoRoot` — the store refuses the two together by name
  // (`root-and-remote`, "a mirror has one source"), which is why they are
  // exclusive here too rather than merely conventionally so.
  //
  // `remote` GOES AS A STRING when there is nothing else to say and as the
  // four-field OBJECT when a ref or a path was given; the store's own
  // `resolveRemoteArg` accepts both, and a string cannot carry a ref.
  if (c.ownership === 'remote') {
    const remote = String(c.remote || '').trim();
    if (!remote) return null;
    const ref = String(c.remoteRef || '').trim();
    const path = String(c.remotePath || '').trim();
    const out = { ownership: 'repo', tokenSource: selectedTokenSource(c) || 'config' };
    out.remote = (ref || path) ? remoteObject(remote, ref, path) : remote;
    const files = pickedFiles(c);
    if (files.length) out.files = files;
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
 * THE TOKEN SOURCE, filtered to the two the store names.
 *
 * `config` on anything else, and the reason is that the store REFUSES an
 * unrecognised word outright (`invalid-token-source`) rather than
 * normalising it, because this call RECORDS a decision that cannot be
 * changed afterwards. A wrong word would strand the project.
 */
export function tokenSourceOf(choice) {
  const v = choice && typeof choice === 'object' ? choice.tokenSource : null;
  return v === 'sync' ? 'sync' : 'config';
}

/**
 * THE RADIO THAT IS CHECKED — 'config', 'sync', or null for none (v3.65.3).
 *
 * ── THE REPORT ────────────────────────────────────────────────────────────
 * The maintainer, with a read-only token saved and tested: READ WITH showed
 * Personal Sync's token selected. Nothing in the code selects it — a fresh
 * panel starts on the read-only token and `state = freshState()` runs on every
 * entry to the view — but each option's <label> was `flex: 1 1 auto`, the full
 * width of the panel, with its state word pushed to the far right, so a press
 * ANYWHERE on that ~1,700px row checked Sync. The rows now hug their text; and
 * the default is derived here, so it can never be a leftover:
 *
 *   · the owner pressed one        → that one, whatever the facts say;
 *   · a read-only token is saved   → the read-only token;
 *   · none is saved (a FACT)       → nothing — the door to Settings is beside
 *                                    it, and Personal Sync's token, which reads
 *                                    every repository its account can see, is
 *                                    never the silent answer;
 *   · nobody looked (unknown)      → the read-only token, as before: a failed
 *                                    read must not look like "no token".
 */
export function selectedTokenSource(choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  if (c.tokenSource === 'sync' || c.tokenSource === 'config') return c.tokenSource;
  return c.hasReadToken === false ? null : 'config';
}

/**
 * `owner/repo` (plus an optional ref and path) as the object the store takes.
 *
 * A URL form is left WHOLE in `repo` for the store to resolve: this file
 * parses `owner/repo` because that is the one shape it can split without
 * inventing a grammar, and hands anything else over unparsed rather than
 * guessing at it. `undefined` rather than `''` for an absent ref or path —
 * the store reads an absent ref as the default branch and an absent path as
 * the whole repository, and an empty string would be a third meaning.
 */
export function remoteObject(remote, ref, path) {
  const raw = String(remote || '').trim();
  const simple = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw);
  const base = simple
    ? { owner: raw.split('/')[0], repo: raw.split('/')[1] }
    : { repo: raw };
  if (ref) base.ref = ref;
  if (path) base.path = path;
  return base;
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
  const mirrored = new Set(c && Array.isArray(c.mirrored) ? c.mirrored : []);
  for (const cand of list) {
    if (!cand || cand.tooLarge) continue;
    const p = String(cand.path || '');
    if (!p || c.picks[p] !== true) continue;
    // ALREADY MIRRORED IS NEVER RE-SENT as an "add" — it has no checkbox, and
    // a stale pick from before it was mirrored must not reach the wire.
    if (mirrored.has(p)) continue;
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
 * WHAT A FRESH SCAN TICKS: NOTHING (v3.65.3).
 *
 * ── THREE RULES, THE LAST ONE THE MAINTAINER'S ────────────────────────────
 * v3.61.0 ticked EVERY usable candidate; on his own repository that came out
 * as 25 documents / 1,875 KB against a 200 KB budget. v3.61.1 narrowed it to
 * the four canonical roles (architecture, decisions, conventions, roadmap),
 * and v3.65.2 ticked nothing when ADDING to a populated mirror. The remote arm
 * kept the role rule, and a real repository whose files all sit under
 * `documentation/architecture/` arrived 22 of 32 ticked, 2,351 KB against the
 * same 200 KB: *"it comes with all documents ticked — default should be
 * unticked, then you select what you need."*
 *
 * A role is a guess from a path, and a guess that ticks for the owner is
 * a guess the owner has to find and undo. So every scan — local or remote,
 * first set-up or add, on the Domains create form or on Context — starts with
 * nothing ticked; the list is sized so the choice is informed, and the commit
 * says "Tick at least one document." until one is.
 */
export function untickedPicks() {
  return {};
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
  const mirrored = new Set(c && Array.isArray(c.mirrored) ? c.mirrored : []);
  let total = 0;
  for (const cand of list) {
    if (!cand || cand.tooLarge) continue;
    const p = String(cand.path || '');
    if (!p || !c.picks || c.picks[p] !== true || mirrored.has(p)) continue;
    total += Number.isFinite(cand.bytes) && cand.bytes > 0 ? cand.bytes : 0;
  }
  return total;
}

/**
 * THE RUNNING TOTAL, AS A DEPTH BAR (v3.65.2, C1 + C2) — the host panels'.
 *
 * Two clauses and one bar. In ADD mode: "2 ticked · 99 KB", then the PROJECT
 * total — what is already mirrored plus what is ticked — against the 200 KB
 * project budget, drawn by the kit's `renderDepthCell`, which turns danger by
 * itself when the total is over (rule 6; the loud budget sentence stays
 * unfolded under it, so the fact is also in words). On the GitHub panel:
 * "1 of 31 ticked · 395 KB" with the ticked set against the same budget.
 *
 * Returns MARKUP: every string in it is either escaped here or passed to the
 * kit, which escapes. The create form keeps `countLineText`, unchanged.
 */
export function countLineHtml(choice) {
  const c = choice && typeof choice === 'object' ? choice : null;
  const list = c && Array.isArray(c.candidates) ? c.candidates : [];
  const mirrored = new Set(c && Array.isArray(c.mirrored) ? c.mirrored : []);
  const usable = list.filter((cand) => cand && cand.path && !cand.tooLarge
    && !mirrored.has(cand.path)).length;
  const picked = pickedFiles(c || {});
  const ticked = picked.filter((f) => list.some((cand) => cand && cand.path === f.path)).length;
  const bytes = tickedBytes(c);
  const unknownSize = list.filter((cand) => cand && cand.addedByPath && c.picks[cand.path] === true).length;
  const add = !!(c && c.addMode);
  const base = add && Number.isFinite(c.projectBytes) && c.projectBytes > 0 ? c.projectBytes : 0;
  const total = base + bytes;
  let words = add
    ? ticked + ' ticked · ' + formatBytes(bytes)
    : ticked + ' of ' + usable + ' ticked · ' + formatBytes(bytes);
  if (unknownSize) words += ' · size of ' + unknownSize + ' added by path not known yet';
  return '<span class="fnd-init-count-words">' + escapeHtml(words) + '</span>' +
    '<span class="fnd-init-count-total">' +
      (add ? '<span class="fnd-init-count-key">project total</span>' : '') +
      renderDepthCell({
        value: formatBytes(total) + ' of ' + formatBytes(FOUNDATIONS_BUDGET_BYTES),
        amount: total, budget: FOUNDATIONS_BUDGET_BYTES,
        label: add ? 'mirrored and ticked, against the project budget'
          : 'ticked, against the project budget',
      }) +
    '</span>';
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
 * OVER THE BUDGET — a WARNING, and it names what actually happens.
 *
 * ── v3.65.3: THE SENTENCE WAS FALSE ────────────────────────────────────────
 * It read "agents receive 120 KB per session and the rest is dropped, last in
 * reading order first." Checked against `src/brain/working-state.js`:
 *   · the 200 KB project budget (`FOUNDATIONS_BUDGET_BYTES`) is DISCLOSED and
 *     never enforced — the store accepts every write;
 *   · 120 KB (`CONTEXT_MAX_BYTES_DEFAULT`) bounds only the document TEXT
 *     `getProjectContext` hands over at session start, in reading order — the
 *     read-first documents when any are flagged, otherwise all of them (or the
 *     ones that changed since the last session);
 *   · a document that does not fit is OMITTED FROM THAT ONE READING and named,
 *     never dropped: it stays in the index, and an agent fetches it whole by
 *     name (`slugs`), outside the 120 KB.
 * Nothing is dropped. The sentence says so, because a person who reads "the
 * rest is dropped" un-ticks documents their agents could have opened.
 *
 * The chooser cannot know which documents will be flagged "read first", so it
 * names both cases in one clause. Never folded (v3.16.1). Returns '' when there
 * is nothing to warn about, so the caller can concatenate it unconditionally.
 */
export function budgetWarning(choice) {
  // In ADD mode the budget is the PROJECT's, so what is already mirrored
  // counts — the same total the depth bar above it draws.
  const base = choice && choice.addMode && Number.isFinite(choice.projectBytes)
    && choice.projectBytes > 0 ? choice.projectBytes : 0;
  const bytes = tickedBytes(choice) + base;
  if (bytes <= FOUNDATIONS_BUDGET_BYTES) return '';
  return 'Over the ' + formatBytes(FOUNDATIONS_BUDGET_BYTES) + ' project budget. Agents are handed '
    + 'up to ' + formatBytes(120 * 1024) + ' of document text at session start (only the read-first '
    + 'ones, if any are flagged); every other document stays listed and is fetched by name when needed.';
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
  // ── THE REMOTE ARM'S OWN REASON (v3.65.0) ────────────────────────────
  // Every disabled control states its reason as a note — v3.61.1's finding,
  // from the maintainer concluding there was no scan at all because the
  // button was silently off. A remote scan needs a repository named and a
  // token to read it with, and those are two different reasons: one is
  // something to type here, the other is something to set in Settings.
  if (c.ownership === 'remote') {
    if (!String(c.remote || '').trim()) return 'Name the repository first.';
    // Nothing selected happens only when no read-only token is saved, so it
    // carries the same sentence as pressing the read-only token then.
    const sel = selectedTokenSource(c);
    if ((sel === null || sel === 'config') && c.hasReadToken === false) {
      return 'No read-only token yet — add one in Settings, or read with Personal Sync’s token.';
    }
    if (sel === 'sync' && c.hasSyncToken === false) {
      return 'Personal Sync is not connected, so there is no token to read with.';
    }
    return '';
  }
  // ── ADD MODE, THE RECORDED FOLDER (v3.65.2, C2) ──────────────────────
  // Shown as a fact and scanned on open, so there is nothing to wait for —
  // unless that scan failed, in which case the field is back, prefilled, and
  // the reason names the one thing to do while it still holds that path.
  if (c.addMode && c.fixedRoot && !c.rootEditable) return '';
  if (c.addMode && c.rootEditable && c.fixedRoot
      && String(c.repoRoot || '').trim() === String(c.fixedRoot).trim()) {
    return 'That folder is not on this computer. Point at your copy of it.';
  }
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
  // ── THE REMOTE ARM HAS ONE MORE REASON (v3.65.0) ─────────────────────
  // A remote mirror with no repository named cannot be committed at all, and
  // a remote INIT that carries no `files` performs no network call — so a
  // set-up with nothing ticked would record an ownership pointing at a
  // repository nobody has proved exists. The store refuses to record
  // ownership against a failed read for exactly that reason; this refuses
  // one that was never attempted.
  if (c.ownership === 'remote') {
    if (!String(c.remote || '').trim()) return 'Name the repository first.';
    if (selectedTokenSource(c) === null) return 'Choose which token to read with.';
    if (!Array.isArray(c.candidates) || !c.candidates.length) return 'Find the documents first.';
    if (!pickedFiles(c).length) return 'Tick at least one document.';
    return '';
  }
  if (c.ownership !== 'repo') return '';
  // ── ADD MODE: A BARE FOLDER NEVER ARMS THE COPY (v3.65.2, C2) ────────
  // Through v3.65.1 the add panel's primary was live the moment a folder was
  // typed — before a scan, with nothing ticked — and pressing it posted `{}`:
  // a plain refresh presented as an "add". Here there is nothing to add until
  // a file is ticked, so both states have a reason.
  if (c.addMode) {
    if (c.scanning === true) return '';
    if (!Array.isArray(c.candidates)) return 'Find the documents first.';
    if (!pickedFiles(c).length) return 'Tick at least one file.';
    return '';
  }
  if (!Array.isArray(c.candidates) || !c.candidates.length) return '';
  if (pickedFiles(c).length) return '';
  return 'Tick at least one document.';
}

/**
 * THE FIRST UNMET STEP, AS ONE SENTENCE (v3.65.2, C1).
 *
 * The host-owned reason line reads THIS — one node, one sentence — where the
 * GitHub panel used to print "Name the repository first." twice, from two
 * nodes sharing one id (the chooser's scan note and the host's commit note),
 * with the host's never patched after its first paint because
 * `getElementById` reaches the first. Precedence is the order the steps
 * happen in: what to type, what to read with, what to find, what to tick.
 */
export function nextStepReason(choice) {
  const own = choice && typeof choice === 'object' ? choice.ownership : null;
  // Only the two arms that SCAN have a scan step; the curator arm has none,
  // and `scanBlockedReason` would answer its folder question for it.
  if (own !== 'repo' && own !== 'remote') return commitBlockedReason(choice);
  return scanBlockedReason(choice) || commitBlockedReason(choice);
}

/**
 * THE READ-WITH ⓘ — how to create the token this form reads with (v3.65.2).
 *
 * The maintainer's five steps, verbatim, then why not a classic token, then
 * where the token is saved. Static markup, nothing interpolated, exported so a
 * host renders it through the kit's `renderInfoMark` rather than this module
 * growing a second ⓘ of its own.
 */
export const READ_WITH_INFO_HTML =
  '<p>A <b>fine-grained personal access token</b> with read-only access to the repositories you '
  + 'want to mirror. Not a classic one. In GitHub:</p>'
  + '<ol>'
  + '<li>Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate '
  + 'new token.</li>'
  + '<li>Resource owner: the account or organisation that owns the repository.</li>'
  + '<li>Repository access: Only select repositories, then pick the repository or repositories '
  + 'whose documentation you want to mirror. You can pick several with one token.</li>'
  + '<li>Permissions → Repository permissions → Contents: Read-only. Metadata read-only is added '
  + 'automatically. Nothing else.</li>'
  + '<li>Expiry: fine-grained tokens require one, up to a year. Set a reminder to renew it.</li>'
  + '</ol>'
  + '<p><b>Why not a classic token:</b> a classic token reads every repository your account can '
  + 'see. A fine-grained one reads only the repositories you pick, and only their contents.</p>'
  + '<p>The token is never typed here. This chooses which saved token to read with; you save it '
  + 'once in Settings → Knowledge base.</p>';

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
      // ── THE THIRD SOURCE (v3.65.0, record §D.7) ──────────────────────
      // The maintainer asked for this twice. Until now a project could only
      // mirror a folder that exists on THIS computer, which meant a machine
      // with no checkout could refresh a mirror somebody else started and
      // could never start one — the store's own recorded gap.
      opt('remote', 'Mirror a GitHub repository',
        'Read over the network. No checkout needed on this computer.') +
      (choice.allowLater
        ? opt('later', 'Decide later',
          'Nothing is written now. Documents asks again when you are ready.')
        : '') +
    '</div>';

  // ── THE HOST'S OPTIONS (v3.65.2) ────────────────────────────────────
  // `flat` drops the arm's own frame — the Context host already draws ONE
  // panel around this, and a tinted arm inside a tinted panel was two left
  // edges and two tints (the "box in a box"); the create form keeps its
  // framed arm, because there it ties the arm to the pressed option card.
  // `reasons: 'host'` means the host owns the ONE reason line and this module
  // emits none — two nodes sharing `<id>-why` was the duplicate-id defect.
  // `readWithInfo` is the host's ⓘ for the READ WITH row, and `tokenDoor` says
  // the host can open Settings, so "Add one in Settings" is a real door.
  const host = {
    flat: c.flat === true,
    hostReasons: c.reasons === 'host',
    readWithInfo: c.readWithInfo && typeof c.readWithInfo === 'object' ? c.readWithInfo : null,
    tokenDoor: c.tokenDoor === true,
  };
  return (
    '<div class="fnd-init" data-fnd-init="' + escapeHtml(id) + '">' +
      options +
      (own === 'repo' ? repoArm(id, choice, busy, host) : '') +
      (own === 'remote' ? remoteArm(id, choice, busy, host) : '') +
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
/**
 * THE GITHUB ARM (v3.65.0, record §D.7).
 *
 * ── WHAT IT SHARES WITH THE FOLDER ARM, AND WHY THAT MATTERS ────────────
 * Everything after the source: the candidate list, the tick defaults, the
 * count line and the running budget total are the SAME functions the local
 * arm uses, so "4 of 25 ticked · 186 KB of a 200 KB budget" reads the same
 * way whichever source it came from. What differs is the four fields above
 * the list and one honest omission in every row.
 *
 * ── NO AGE ON A REMOTE CANDIDATE, AND IT SAYS SO ────────────────────────
 * A git tree carries no timestamp, so `modifiedAt` is `null` on every remote
 * row — uniformly, which is the store's own word. That is "not read", not
 * "none", and `candidateAgeHtml` renders nothing for it. A line above the
 * list says so once rather than every row carrying a dash: an unknown age on
 * twenty-five rows is noise, and a FAKE age would be worse than either.
 *
 * ── AND NO TOKEN FIELD ──────────────────────────────────────────────────
 * The radio names WHICH FILE the token is read from. The store reads it from
 * `.curator-config.json` (`config`) or from Personal Sync's PAT (`sync`) and
 * from nowhere else; a token in a body is not read, here or in the store. The
 * place to SET one is Settings, and this form points at it rather than
 * becoming a second credential path into the app.
 */
function remoteArm(id, choice, busy, hostOpts) {
  const host = hostOpts && typeof hostOpts === 'object' ? hostOpts : {};
  const dis = busy ? ' disabled' : '';
  const scanning = choice.scanning === true;
  const cands = Array.isArray(choice.candidates) ? choice.candidates : null;

  const armLede =
    '<p class="fnd-init-armhd">Name the repository, then tick the documents to copy.</p>';

  // ── EACH FIELD IS ONE WRAPPER, LABEL ABOVE INPUT (v3.65.2, C1) ─────────
  // Through v3.65.1 the label and the input were SIBLINGS in an auto-fit grid
  // with `align-items: end`, so six items flowed into five tracks: labels laid
  // out as if they were fields, bottom-aligned 21px BELOW their inputs, and the
  // third input wrapped alone to a second row — the "labels below their
  // inputs, huge gaps" in the maintainer's screenshot. One wrapper per field,
  // three columns.
  const text = (name, label, placeholder, value) =>
    '<div class="fnd-init-field">' +
      '<label class="fnd-init-label cur-eyebrow" for="' + escapeHtml(id) + '-' + name + '">' +
        escapeHtml(label) + '</label>' +
      '<input class="fnd-init-path" id="' + escapeHtml(id) + '-' + name + '" type="text"' +
        ' autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(placeholder) + '"' +
        ' value="' + escapeHtml(value || '') + '"' + dis + ' />' +
    '</div>';

  // ── READ WITH, TRUE IN EVERY STATE (v3.65.2, C1) ───────────────────────
  // THE REPORT: "I cannot enter the token here, I don't have an option." Both
  // state words were blank because no host ever set the facts, and the note
  // pointed at a Settings field that did not exist. Now the host reads
  // presence and four characters once per open, and the row says what is
  // true: the token's last four when it is saved; "not saved yet" with a door
  // to Settings when it is not; no state word at all when nobody looked.
  //
  // ── EACH OPTION SAYS WHAT IT IS AND WHERE IT LIVES (v3.65.3) ─────────────
  // The maintainer: "two options … not clear which is which — we have two
  // GitHub tokens." So each option carries its name, where that token is kept,
  // and its own state word BESIDE it — no longer pushed to the far right edge,
  // where "connected" floated a panel's width away from the option it belonged
  // to (and where the full-width <label> it sat in made the whole row a press
  // target — see `selectedTokenSource`). Personal Sync's option also says
  // plainly why it is not the default.
  const src = selectedTokenSource(choice);
  const last4 = typeof choice.readTokenLast4 === 'string'
    && /^[A-Za-z0-9_]{1,4}$/.test(choice.readTokenLast4) ? choice.readTokenLast4 : '';
  const configState = choice.hasReadToken === true
    ? (last4 ? 'ends in …' + last4 : 'saved')
    : choice.hasReadToken === false ? 'not saved yet' : '';
  const door = choice.hasReadToken === false && host.tokenDoor
    ? '<button type="button" class="btn btn-secondary btn-xs fnd-init-token-door"' +
      ' id="' + escapeHtml(id) + '-token-door"' + dis + '>Add one in Settings</button>'
    : '';
  // A SOURCE THAT CANNOT WORK IS DISABLED, AND ITS STATE WORD IS THE REASON
  // (v3.61.1: every disabled control states its reason). Never when the
  // source is the checked one — a checked-and-disabled radio could not be
  // moved off by pressing it.
  const syncOff = choice.hasSyncToken === false && src !== 'sync';
  const tokenOpt = (value, name, where, state, sub, off, after) =>
    '<div class="fnd-init-token-line">' +
      '<label class="fnd-init-token-opt">' +
        '<input type="radio" name="' + escapeHtml(id) + '-token" value="' + escapeHtml(value) + '"' +
          ' data-fnd-token="' + escapeHtml(value) + '"' +
          (src === value ? ' checked' : '') + (busy || off ? ' disabled' : '') + ' />' +
        '<span class="fnd-init-token-text">' +
          '<span class="fnd-init-token-head">' +
            '<span class="fnd-init-token-name">' + escapeHtml(name) + '</span>' +
            '<span class="fnd-init-token-where">' + escapeHtml(where) + '</span>' +
            (state
              ? '<span class="fnd-init-token-sep" aria-hidden="true">·</span>'
                + '<span class="fnd-init-token-state">' + escapeHtml(state) + '</span>'
              : '') +
          '</span>' +
          (sub ? '<span class="fnd-init-token-sub">' + escapeHtml(sub) + '</span>' : '') +
        '</span>' +
      '</label>' + (after || '') +
    '</div>';
  const info = host.readWithInfo;
  const tokens =
    '<div class="fnd-init-readwith">' +
      '<span class="fnd-init-label cur-eyebrow">Read with</span>' +
      (info && typeof info.btn === 'string' ? info.btn : '') +
    '</div>' +
    (info && typeof info.panel === 'string' ? info.panel : '') +
    '<div class="fnd-init-tokens" role="radiogroup"' +
      ' aria-label="Which stored token to read the repository with">' +
      tokenOpt('config', 'Read-only token', '— Settings › Knowledge base', configState,
        '', false, door) +
      tokenOpt('sync', 'Personal Sync’s token', '— the one that syncs your knowledge base',
        choice.hasSyncToken === false ? 'not connected'
          : choice.hasSyncToken === true ? 'connected' : '',
        // "every repository" is true of a CLASSIC token only (docs/sync.md:
        // a fine-grained sync token reaches its own repository and no other),
        // so the sentence says which, rather than over-claiming either way.
        'Granted for sync. If it is a classic token it can read every repository its account '
          + 'can see — which is why it is not the default.', syncOff, '') +
    '</div>' +
    // THE IN-FLOW NOTE IS THE ⓘ'S NOW, where a host supplies one: it is an
    // explanation, and explanations live behind the ⓘ. A host with no ⓘ (the
    // create form) keeps the sentence, so no host loses it.
    (info ? '' : '<p class="fnd-init-note"><span>The token is never typed here — this chooses which '
      + 'stored one to read with. Add a read-only token in Settings.</span></p>');

  const fields =
    '<div class="fnd-init-remote-fields">' +
      text('remote', 'Repository', 'owner/repo', choice.remote) +
      text('remote-ref', 'Branch or tag', 'the default branch', choice.remoteRef) +
      text('remote-path', 'Folder', 'the whole repository', choice.remotePath) +
    '</div>' +
    tokens +
    '<div class="fnd-init-row">' +
      '<button type="button" class="btn btn-secondary btn-xs fnd-init-scan"' +
        ' id="' + escapeHtml(id) + '-scan"' +
        (busy || scanning || scanBlockedReason(choice) ? ' disabled' : '') + '>' +
        (scanning ? 'Looking…' : 'Find documents') +
      '</button>' +
    '</div>' +
    (host.hostReasons ? '' : reasonNote(id + '-why', scanBlockedReason(choice)));

  const err = choice.scanError
    ? '<div class="fnd-init-note fnd-init-note-loud"><span>' +
      escapeHtml('Nothing was read: ' + choice.scanError) + '</span></div>'
    : '';

  let list = '';
  if (cands && !cands.length) {
    list = '<div class="fnd-init-note"><span>Nothing matched in that repository. The scan ' +
      'looks in docs folders and for documents named after a role; try a narrower folder, or ' +
      'a different branch.</span></div>';
  } else if (cands) {
    list =
      // ── A TICK MEANS COPY (v3.65.2) ─────────────────────────────────────
      // It read "Tick the documents an agent must read first." — false: a
      // tick copies the file, and "read first" is a separate flag set per row
      // in the documents table afterwards (`pickedFiles` sends no readFirst).
      '<p class="fnd-init-listhd">Tick the files to copy into this project.</p>' +
      // ONE LINE, NOT TWENTY-FIVE DASHES. See the docblock.
      '<p class="fnd-init-note"><span>Age is unknown for a remote scan — a git tree carries no ' +
        'timestamps, so nothing here claims one.</span></p>' +
      '<div class="fnd-init-cands">' +
        cands.map((cand) => candidateRow(id, choice, cand, busy)).join('') +
      '</div>' +
      (choice.truncated
        ? '<div class="fnd-init-note"><span>Only the first ' + cands.length +
          ' files are listed. Mirror these now and refresh later for the rest.</span></div>'
        : '') +
      countBlock(id, choice, host) +
      '<div class="fnd-init-note fnd-init-note-loud fnd-init-budget"' +
        ' id="' + escapeHtml(id) + '-budget"' + (budgetWarning(choice) ? '' : ' hidden') + '>' +
        '<span>' + escapeHtml(budgetWarning(choice)) + '</span>' +
      '</div>';
  }

  // IN A FLAT HOST the panel's own description already says what to do, so
  // the arm's instruction would be the same sentence twice.
  return '<div class="fnd-init-arm' + (host.flat ? ' fnd-init-arm-flat' : '') + '">' +
    (host.flat ? '' : armLede) + fields + err + list + '</div>';
}

/**
 * THE COUNT LINE — text on the create form, a depth bar in a host panel.
 * One node either way, `<id>-count`, which the binder patches on every tick.
 */
function countBlock(id, choice, host) {
  const rich = !!(host && host.hostReasons);
  return '<div class="fnd-init-count' + (rich ? ' fnd-init-count-rich' : '') + '"' +
    ' id="' + escapeHtml(id) + '-count"' + (rich ? ' data-fnd-count-rich="1"' : '') + '>' +
    (rich ? countLineHtml(choice) : escapeHtml(countLineText(choice))) +
  '</div>';
}

function repoArm(id, choice, busy, hostOpts) {
  const host = hostOpts && typeof hostOpts === 'object' ? hostOpts : {};
  const dis = busy ? ' disabled' : '';
  // ── THE RECORDED FOLDER IS A FACT, NOT A QUESTION (v3.65.2, C2) ────────
  // Adding to a mirror that already has documents: the manifest names the
  // folder, so the panel says it and the host scans it on open. The field
  // comes back — prefilled with that path — only when the scan of it failed,
  // and then whatever is in it is what the copy is sent against.
  const fixed = choice.addMode === true && !!choice.fixedRoot && choice.rootEditable !== true;
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

  const field = fixed
    ? renderMonitor({ label: 'The folder this project mirrors',
      lines: [{ key: 'from', value: String(choice.fixedRoot) }] }) +
      (choice.scanning === true
        ? '<div class="tx-note fnd-init-why"><span>Reading the folder…</span></div>' : '')
    : '<div class="fnd-init-field">' +
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
    '</div>' +
    // ── WHY THE CONTROL IS OFF, UNDER THE CONTROL ───────────────────────
    // Emitted ALWAYS and merely `hidden`, because the path field writes into
    // state WITHOUT a render (a render rebuilds the input and takes the caret
    // with it) — so the only way this sentence can appear and disappear as
    // the field fills is for the live node to be toggled. `.fnd-init-why` has
    // its own `[hidden]` counter-rule in the stylesheet: `.tx-note` declares
    // `display: flex`, which defeats the attribute (design-system §9).
    (host.hostReasons ? '' : reasonNote(id + '-why', scanBlockedReason(choice))) +
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

  const addMode = choice.addMode === true;
  let list = '';
  if (cands && !cands.length && !addMode) {
    list = '<div class="fnd-init-note"><span>Nothing matched in that folder. The scan looks in ' +
      'docs folders and for documents named after a role; a file kept somewhere else can be ' +
      'added by path below.</span></div>';
  } else if (cands) {
    list =
      // ── WHAT A TICK MEANS, ABOVE THE LIST (v3.65.2) ──────────────────────
      // It said "Tick the documents an agent must read first." — while the
      // arm's own lede said "tick the documents to copy". A tick COPIES the
      // file; "read first" is a separate flag, set per row in the documents
      // table afterwards, and `pickedFiles` sends none.
      (cands.length || !addMode
        ? '<p class="fnd-init-listhd">Tick the files to copy into this project.</p>'
        : '<div class="fnd-init-note"><span>Nothing matched in that folder. A file kept ' +
          'somewhere else in it can be added by its path.</span></div>') +
      '<div class="fnd-init-cands" id="' + escapeHtml(id) + '-cands">' +
        cands.map((cand) => candidateRow(id, choice, cand, busy)).join('') +
        // ── A FILE THAT ISN'T LISTED IS THE LIST'S LAST ROW (v3.65.2) ─────
        // It was a second path field BESIDE the list, with seven role chips
        // floating under it and no word on why it existed — "the second part
        // I don't understand". Now it is one quiet row at the end of the list
        // it adds to, and what it adds becomes an ordinary ticked row with
        // the same role control as its neighbours: one list, one total.
        (addMode ? extraRowHtml(id, choice, busy) : '') +
      '</div>' +
      (choice.truncated
        ? '<div class="fnd-init-note"><span>Only the first ' + cands.length +
          ' files are listed. Mirror these now and refresh later for the rest.</span></div>'
        : '') +
      // ── THE RUNNING TOTAL (v3.61.1) ──────────────────────────────────────
      // Ticks and BYTES, against the project budget. Patched in place on every
      // tick by the binder — never re-rendered, because a re-render of a
      // 44-row list throws the reader back to the top of it.
      countBlock(id, choice, host) +
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
  // IN ADD MODE the lede is the host panel's own description, and the typed
  // path lives in the list (above) rather than in a block of its own.
  return '<div class="fnd-init-arm' + (host.flat ? ' fnd-init-arm-flat' : '') + '">' +
    (addMode ? '' : armLede) + field + err + list + (addMode ? '' : extraBlock) + '</div>';
}

/**
 * THE LIST'S LAST ROW: "+ A file that isn't listed" (v3.65.2, C2).
 *
 * Closed, a ghost button. Open, IN THE SAME ROW: a labelled path field and
 * "Add to list". Written by the binder into the live row on open rather than
 * by re-rendering the list — a re-render rebuilds the scroll container and
 * throws a reader who scrolled to the bottom back to the top, the defect
 * v3.61.1 measured on a 44-row list.
 */
export function extraRowHtml(id, choice, busy) {
  return '<div class="fnd-init-cand fnd-init-extra-row" id="' + escapeHtml(id) + '-extra-row">' +
    extraRowInner(id, choice, busy) + '</div>';
}

/** The row's contents alone — what the binder writes into the live row. */
function extraRowInner(id, choice, busy) {
  const dis = busy ? ' disabled' : '';
  const open = choice && choice.extraOpen === true;
  const draft = normaliseRelPath(choice && choice.extraPath);
  const inner = open
    ? '<div class="fnd-init-field fnd-init-extra-field">' +
        '<label class="fnd-init-label cur-eyebrow" for="' + escapeHtml(id) + '-extra">' +
          'Path inside this folder</label>' +
        '<div class="fnd-init-row">' +
          '<input class="fnd-init-path" id="' + escapeHtml(id) + '-extra" type="text"' +
            ' autocomplete="off" spellcheck="false" placeholder="notes/architecture.md"' +
            ' data-fnd-extra-field="1"' +
            ' value="' + escapeHtml((choice && choice.extraPath) || '') + '"' + dis + ' />' +
          '<button type="button" class="btn btn-secondary btn-xs fnd-init-extra-add"' +
            ' id="' + escapeHtml(id) + '-extra-add" data-fnd-extra-add="1"' +
            (busy || !draft ? ' disabled' : '') + '>' +
            'Add to list</button>' +
        '</div>' +
      '</div>'
    : '<button type="button" class="btn btn-ghost btn-xs fnd-init-extra-open"' +
        ' id="' + escapeHtml(id) + '-extra-open" data-fnd-extra-open="1"' + dis +
        '>+ A file that isn’t listed</button>';
  return inner;
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
  // ── ALREADY MIRRORED: LISTED IN PLACE, NEVER TICKABLE (v3.65.2, C2) ────
  // Through v3.65.1 the document this project already mirrors came back from
  // the scan as a NEW candidate, ticked, its bytes counted a second time in
  // the running total. It stays in the list — where it is in the folder is
  // worth seeing — with no checkbox and the table's own quiet badge.
  const mirrored = Array.isArray(choice.mirrored) && choice.mirrored.includes(path);
  if (mirrored) {
    return '<div class="fnd-init-cand is-mirrored" data-fnd-cand-row="' + escapeHtml(path) + '">' +
      '<span class="fnd-init-cand-main">' +
        '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>' +
        '<span class="mem-badge mem-badge-quiet fnd-init-mirrored">mirrored</span>' +
      '</span>' +
      '<span class="fnd-init-cand-size">' + escapeHtml(formatBytes(cand && cand.bytes)) + '</span>' +
      '<span class="fnd-init-cand-role-flat">' +
        escapeHtml((cand && cand.suggestedRole) || 'other') + '</span>' +
    '</div>';
  }
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
          : cand && cand.addedByPath
            ? '<span class="fnd-init-cand-head">added by path</span>' : '') +
      '</label>' +
      // A path added by hand has never been read by this browser, so its size
      // is said to be unknown rather than printed as "0 bytes".
      '<span class="fnd-init-cand-size">' + escapeHtml(cand && cand.addedByPath
        && !Number.isFinite(cand.bytes) ? 'size not known' : formatBytes(cand && cand.bytes)) + '</span>' +
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
 * WHAT IS IN THAT REPOSITORY — a read, and only a read (v3.65.0).
 *
 * `GET /api/memory/repo-scan?source=remote&remote=owner%2Frepo[&ref][&path]
 * [&tokenSource]`. TWO REQUESTS at the producer for any repository — the ref,
 * then ONE recursive tree carrying every path and every blob size — and NO
 * BLOB IS FETCHED, so the cost does not grow with the number of candidates.
 *
 * NEVER THROWS, and every refusal the store names comes back as a SENTENCE
 * naming the token's SOURCE rather than the token: `no-token` says which file
 * is empty, `unauthorised` says the token in that file was refused. The token
 * itself is never in a request, never in an answer and never in an error —
 * that is the store's rule and this function is the only place a view could
 * have broken it.
 */
export async function scanRemote(opts, fetchImpl) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const f = typeof fetchImpl === 'function' ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, error: 'this browser cannot make requests' };
  const remote = String(o.remote || '').trim();
  if (!remote) return { ok: false, error: 'name the repository first' };
  const q = ['source=remote', 'remote=' + encodeURIComponent(remote)];
  if (String(o.ref || '').trim()) q.push('ref=' + encodeURIComponent(String(o.ref).trim()));
  if (String(o.path || '').trim()) q.push('path=' + encodeURIComponent(String(o.path).trim()));
  q.push('tokenSource=' + encodeURIComponent(o.tokenSource === 'sync' ? 'sync' : 'config'));
  try {
    const res = await f('/api/memory/repo-scan?' + q.join('&'));
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok || !data || !data.ok) {
      // THE CODE IS `reason` (v3.65.2) — the same correction v3.65.1 made in
      // the Context host's commit path and missed here: `error` is the
      // route's PROSE, so keying on it alone matched none of the nine
      // sentences. `error` is still tried, as the host does.
      const code = data && typeof data.reason === 'string' ? data.reason : null;
      const prose = data && typeof data.error === 'string' ? data.error : null;
      return { ok: false, error: remoteRefusalText(code, o) || remoteRefusalText(prose, o)
        || (data && data.message) || prose || ('HTTP ' + res.status) };
    }
    return {
      ok: true,
      remote: data.remote || null,
      commit: typeof data.commit === 'string' ? data.commit : null,
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      truncated: data.truncated === true,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'the request failed' };
  }
}

/**
 * ONE REFUSAL, ONE SENTENCE — and every sentence names the token's SOURCE.
 *
 * The store names nine ways a remote read can fail and answers each with a
 * code; a view that printed the code would be showing a person a word from a
 * protocol. `null` for a code this table does not know, so the caller falls
 * back to the producer's own message rather than to a guess — the collapse
 * this repository keeps paying for is a consumer inventing an answer where
 * the producer already gave one.
 */
export function remoteRefusalText(code, opts) {
  const where = (opts && opts.tokenSource === 'sync')
    ? 'Personal Sync’s token' : 'the read-only token in Settings';
  switch (code) {
    case 'no-token':
      return 'There is no token to read with — ' + where + ' is not set.';
    case 'unauthorised':
      return where.charAt(0).toUpperCase() + where.slice(1)
        + ' was refused by GitHub. It may have expired, or it may not reach this repository.';
    case 'rate-limited':
      return 'GitHub is rate-limiting this token. Try again in a few minutes.';
    case 'remote-not-found':
      return 'GitHub has no such repository, branch or folder — or ' + where
        + ' cannot see it.';
    case 'remote-tree-truncated':
      // THE STORE THROWS RATHER THAN MIRRORING PART OF A REPOSITORY, and the
      // sentence says what to do about it instead of what went wrong.
      return 'That repository is too large to list in one read. Name a folder inside it.';
    case 'remote-too-large':
      return 'One of those documents is larger than a foundation may be.';
    case 'invalid-remote':
      return 'That is not a repository this can read. Use owner/repo, or the repository’s URL.';
    case 'invalid-token-source':
      return 'That is not a token this app stores.';
    case 'remote-unreachable':
      return 'GitHub could not be reached from this computer.';
    case 'remote-http':
      return 'GitHub answered with an error. Try again in a moment.';
    case 'remote-unavailable':
      return 'The remote reader is not available on this build.';
    default:
      return null;
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
  // ── ONE REASON LINE, AND THE HOST OWNS IT (v3.65.2, C1) ────────────────
  // With `reasons: 'host'` this module renders no `<id>-why` node, so every
  // place below that used to patch one hands the FIRST UNMET STEP to the host
  // instead — the one node the host renders, patched from one predicate.
  const hostReasons = c.reasons === 'host';
  const report = () => {
    if (typeof c.onSelect === 'function') c.onSelect(nextStepReason(choice));
  };

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
      if (hostReasons) { report(); return; }
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

  // ── THE THREE REMOTE FIELDS, STRAIGHT INTO STATE (v3.65.0) ─────────────
  // The same rule as the path field above and for the same reason: a render
  // rebuilds the input and takes the caret with it. What changes on screen as
  // you type is the scan button's disabled flag and the sentence that says
  // why, and both are patched on the LIVE nodes from the SAME predicate the
  // renderer used — so the control and its reason cannot come apart.
  const syncScanGate = () => {
    const scan = doc.getElementById(id + '-scan');
    const reason = scanBlockedReason(choice);
    if (scan) scan.disabled = !!reason || choice.scanning === true;
    if (hostReasons) { report(); return; }
    const why = doc.getElementById(id + '-why');
    if (why) {
      const span = typeof why.querySelector === 'function' ? why.querySelector('span') : null;
      if (span) span.textContent = reason;
      why.hidden = !reason;
    }
  };
  for (const [suffix, field] of [['remote', 'remote'], ['remote-ref', 'remoteRef'],
    ['remote-path', 'remotePath']]) {
    const el = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-' + suffix) : null;
    if (!el) continue;
    el.addEventListener('input', () => { choice[field] = el.value; syncScanGate(); });
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const scan = doc.getElementById(id + '-scan');
      if (scan && !scan.disabled) scan.click();
    });
  }
  // THE TOKEN SOURCE. A repaint, not a patch: the two radios carry their own
  // availability words and the scan gate reads the chosen source, so what
  // changes is more than one node's disabled flag.
  all('[data-fnd-token]').forEach((el) => {
    el.addEventListener('change', () => {
      const next = el.dataset ? el.dataset.fndToken : el.getAttribute('data-fnd-token');
      if (next !== 'config' && next !== 'sync') return;
      choice.tokenSource = next;
      rerender();
    });
  });

  // ── THE DOOR TO SETTINGS (v3.65.2, C1) ─────────────────────────────────
  // Rendered only when the host said it can open Settings, and the press is
  // the host's: this module does not navigate.
  const door = typeof doc.getElementById === 'function' ? doc.getElementById(id + '-token-door') : null;
  if (door && typeof c.onOpenTokenSettings === 'function') {
    door.addEventListener('click', () => { c.onOpenTokenSettings(); });
  }

  const runScan = () => {
      // ── THE REMOTE ARM READS OVER THE NETWORK (v3.65.0) ──────────────
      // ONE read, and it is the only network call this form makes before the
      // owner ticks anything. Two requests at the producer for any
      // repository — the ref, then one recursive tree — and no blob, so the
      // cost does not grow with the number of candidates. A truncated tree
      // refuses LOUDLY and mirrors nothing, which is the store's own rule.
      if (choice.ownership === 'remote') {
        const want = String(choice.remote || '').trim();
        if (!want || choice.scanning || scanBlockedReason(choice)) return;
        choice.scanning = true;
        choice.scanError = null;
        rerender();
        scanRemote({ remote: want, ref: choice.remoteRef, path: choice.remotePath,
          tokenSource: selectedTokenSource(choice) || 'config' }, c.fetchImpl).then((got) => {
          // The reply belongs to the repository it was asked for. Somebody who
          // corrects the name and scans again must not have the first answer
          // land on top of the second.
          if (String(choice.remote || '').trim() !== want) return;
          choice.scanning = false;
          if (!got.ok) {
            choice.scanError = got.error;
            choice.candidates = null;
          } else {
            choice.scanError = null;
            choice.candidates = got.candidates;
            choice.truncated = got.truncated;
            // NOTHING IS TICKED (v3.65.3) — the same rule as every scan in
            // this module; `untickedPicks` holds the argument.
            choice.picks = untickedPicks();
          }
          rerender();
        }).catch((err) => fail(err));
        return;
      }
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
          // ── THE RECORDED FOLDER IS NOT HERE (v3.65.2, C2) ──────────────
          // The field comes back PREFILLED with it, and from then on the path
          // in the field is the path scanned AND the path the copy is sent
          // against (`repoRoot` on the refresh body) — never one scanned and
          // another copied from.
          if (choice.addMode && choice.fixedRoot && !choice.rootEditable) {
            choice.rootEditable = true;
          }
        } else {
          choice.scanError = null;
          choice.candidates = got.candidates;
          choice.truncated = got.truncated;
          // NOTHING IS TICKED — on a first set-up, on an add, and on the
          // remote arm alike (v3.65.3). `untickedPicks` holds the history.
          choice.picks = untickedPicks();
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
    if (countEl) {
      // A HOST PANEL'S COUNT CARRIES A DEPTH BAR, so it is markup — built
      // from escaped words and the kit's own cell, never from a raw string.
      const rich = countEl.dataset ? countEl.dataset.fndCountRich === '1'
        : (typeof countEl.getAttribute === 'function' && countEl.getAttribute('data-fnd-count-rich') === '1');
      if (rich) countEl.innerHTML = countLineHtml(choice);
      else countEl.textContent = countLineText(choice);
    }
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
    if (hostReasons) report();
    else if (typeof c.onSelect === 'function') c.onSelect(commitBlockedReason(choice));
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
      // ── "+ A file that isn't listed" AND "Add to list" (v3.65.2, C2) ────
      if (choice.addMode) {
        if (hostOf(ev && ev.target, 'fndExtraOpen')) { openExtraRow(); return; }
        if (hostOf(ev && ev.target, 'fndExtraAdd')) { addToList(); return; }
      }
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

  // ── A FILE THAT ISN'T LISTED, IN ADD MODE (v3.65.2, C2) ────────────────
  // The row is the list's last; opening it and adding from it are PATCHES of
  // that row and an insert of one candidate row above it — never a repaint of
  // the list, which would rebuild the scroll container under a reader who has
  // just scrolled to its bottom. The field writes into state with no render,
  // the house rule for every field in this module.
  const extraRow = () => byId('-extra-row');
  function paintExtraRow(focus) {
    const row = extraRow();
    if (!row) { rerender(); return; }
    row.innerHTML = extraRowInner(id, choice, false);
    if (focus) {
      const input = byId('-extra');
      if (input && typeof input.focus === 'function') input.focus();
    }
  }
  function openExtraRow() {
    choice.extraOpen = true;
    paintExtraRow(true);
  }
  function addToList() {
    const p = normaliseRelPath(choice.extraPath);
    if (!p) return;
    if (!Array.isArray(choice.candidates)) choice.candidates = [];
    const mirrored = Array.isArray(choice.mirrored) && choice.mirrored.includes(p);
    const have = choice.candidates.find((x) => x && x.path === p);
    if (!have && !mirrored) {
      const cand = { path: p, bytes: null, suggestedRole: roleForBasename(p), addedByPath: true };
      choice.candidates.push(cand);
      choice.picks[p] = true;
      const row = extraRow();
      if (row && typeof row.insertAdjacentHTML === 'function') {
        row.insertAdjacentHTML('beforebegin', candidateRow(id, choice, cand, false));
      } else {
        choice.extraPath = '';
        choice.extraOpen = false;
        rerender();
        return;
      }
    } else if (have && !mirrored && !have.tooLarge) {
      // ALREADY IN THE LIST: adding it again is a tick, never a second row.
      choice.picks[p] = true;
      const r = rowFor(p);
      const box = r && typeof r.querySelector === 'function' ? r.querySelector('[data-fnd-cand]') : null;
      if (box) box.checked = true;
    }
    choice.extraPath = '';
    choice.extraOpen = false;
    paintExtraRow(false);
    patchSelection();
  }
  if (choice.addMode && typeof scope.addEventListener === 'function') {
    scope.addEventListener('input', (ev) => {
      const el = hostOf(ev && ev.target, 'fndExtraField');
      if (!el) return;
      choice.extraPath = el.value;
      const add = byId('-extra-add');
      if (add) add.disabled = !normaliseRelPath(choice.extraPath);
    });
    scope.addEventListener('keydown', (ev) => {
      if (!ev || ev.key !== 'Enter' || !hostOf(ev.target, 'fndExtraField')) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      addToList();
    });
  }

  // ── THE TYPED PATH (D21) ────────────────────────────────────────────────
  // The field writes straight into state with no repaint, for the reason the
  // root field above states; the only thing on screen it changes is the Add
  // button's disabled state, set on the LIVE node with the SAME predicate the
  // renderer uses. The ROLE row beside it does repaint, because a pressed
  // option button has to come back pressed.
  // THE CREATE FORM'S TYPED-PATH BLOCK. In add mode the same ids belong to the
  // in-list row above and are handled by delegation, so they are not bound
  // here a second time.
  const extraEl = !choice.addMode && typeof doc.getElementById === 'function'
    ? doc.getElementById(id + '-extra') : null;
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
  const addBtn = !choice.addMode && typeof doc.getElementById === 'function'
    ? doc.getElementById(id + '-extra-add') : null;
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

  // ── THE SCAN RUNS ON OPEN, IN ADD MODE (v3.65.2, C2) ────────────────────
  // The folder is recorded and the scan is a cheap local read, so the panel
  // opens on the list rather than on a button with nothing to wait for. Once
  // per chooser, and the conditions are what make it once: an answer fills
  // `candidates`, a failure sets `scanError` and brings the field back, and a
  // scan in flight is `scanning` — so a repaint's re-bind never scans again.
  if (c.autoScan === true && choice.addMode && choice.fixedRoot && !choice.rootEditable
      && choice.candidates == null && !choice.scanning && !choice.scanError) {
    choice.repoRoot = String(choice.fixedRoot);
    runScan();
  }
}
