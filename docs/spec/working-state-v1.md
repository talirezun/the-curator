# `working-state/1` — the on-disk format

**Status:** stable, version **1**. **Published:** v3.63.0.
**Implementations:** The Curator (reference), plus anything you write.

This is a **contract about bytes on disk**, not a tour of a product and not an API. It exists so a
tool that is not The Curator — a script, another agent harness, a build system, something in Go or
Python — can **read and write an agent's working state** without this codebase, and have The
Curator read the result back with no repair step.

Everything below is derived from the reference implementation's own constants, and
[`scripts/test-spec-working-state.js`](../../scripts/test-spec-working-state.js) executes those
constants against the tables in this file on every `npm test` run. **A number here that drifts from
the code reds the build.** That is the only promise that makes the rest of them worth anything.

> **Who should read this.** Somebody writing a *writer*. If you only want to use the format from an
> agent, the MCP tools and the `my-curator` command already speak it — see
> [`docs/working-state.md`](../working-state.md) and
> [`docs/mcp-user-guide.md`](../mcp-user-guide.md).

---

## 1. What v1 covers, and how it changes

v1 covers four kinds of file under a domain's `state/` directory:

| Tier | File | Who writes it | Semantics |
|---|---|---|---|
| 0 | `foundations/manifest.json` + `<slug>.md` | the owner, or a mirror of a repository | **replaced whole**, verbatim |
| 1 | `project.md` | the human owner (or an agent they commissioned) | **edited**, long-lived |
| 2 | `<scope>/<machine>/current.md` | one agent, on one machine | **overwritten** every save |
| 3 | `<scope>/<machine>/journal.jsonl` | the same writer | **appended**, never rewritten |

Beside them, since v3.74.0, a tier-2 folder may hold **`previous.md`**: one kept copy of a handoff
that a save by a **different tool** replaced (§6b). It is not a tier of its own, it is never a
handoff, and nothing counts it as one.

**The rule that makes the tiers different from a wiki:** state **supersedes**, knowledge
**accumulates**. A handoff is replaced, not merged — a blocker resolved on Tuesday must not be
resurrected by Wednesday's write, and a union merge cannot express *no longer true*.

**Compatibility rules for a v1 implementation:**

1. **A reader ignores fields it does not know.** Unknown keys in `manifest.json`, in a journal line,
   or in a handoff are not errors. **The same holds for files:** a file in a `<scope>/<machine>/`
   folder that is not `current.md` or `journal.jsonl` — `previous.md` (§6b), or anything a later
   version adds — is not a scope, a machine or a handoff, and a reader that lists or counts
   work-streams must ignore it. A (scope, machine) pair exists exactly when its `current.md` does.
2. **A writer that round-trips a document preserves fields it does not understand.** The manifest
   gained `skeleton` in v3.61.0 and `readFirst` in v3.62.0 without the version moving; a writer that
   re-serialises only the fields it knows silently deletes the owner's routing decisions. (The
   reference implementation keeps unknown keys from v3.68.1: unknown top-level and per-document
   manifest keys are re-emitted after the known ones, capped at 32 keys and 4 KB of JSON each, and
   every drop is named.)
3. **`manifest.json`'s `"version"` is `1` or `2`.** Additive fields do not bump it. Version 2
   (v3.69.0) exists for manifests an older reader must not rewrite — a project mixing kept and
   mirrored documents, or mirroring from more than one source. **A writer writes the lowest version
   that expresses the manifest.** A version a reader does not recognise is refused, not guessed at,
   and never removed.
4. **Booleans added this way are read with `=== true`.** Absent means `false`. A string, a `1` or a
   `"yes"` from a hand edit is **not** evidence; the fail-safe direction is chosen per field and is
   stated where it matters (§8).

---

## 2. The layout

A domain directory holds `state/`. Two shapes live in it, and the difference is one string
comparison:

```
domains/<domain>/state/                     ← the DOMAIN'S OWN project
  project.md
  project.json
  <scope>/<machine>/current.md
  <scope>/<machine>/journal.jsonl
  <scope>/<machine>/previous.md             ← optional, §6b
  foundations/manifest.json
  foundations/<slug>.md

domains/<domain>/state/<project>/           ← a NAMED project
  project.md
  project.json
  <scope>/<machine>/current.md
  <scope>/<machine>/journal.jsonl
  <scope>/<machine>/previous.md             ← optional, §6b
  foundations/manifest.json
  foundations/<slug>.md
```

**The rule:** if `project === domain` (string equality, after both are validated as names), the
project's files live at the **state root** — never at `state/<domain>/`. Otherwise they live under
`state/<project>/`.

**This is permanent, and the reason belongs in the spec rather than in a footnote.** `state/` is
synchronised between machines. If a newer version moved the domain's own project into a
subdirectory, an older version reading the same synchronised tree would find the state root empty
and report a fresh, blank project — not an error, which is what makes it dangerous. A mixed fleet is
the normal case, so the root layout is frozen.

A directory named `foundations` is therefore **not** a project, and neither are `project.md`,
`project.json`, `current.md` or `journal.jsonl` — see the reserved names in §4.

`project.json` is **optional** and absent on most projects: a project with no metadata file is not
incomplete, it has simply chosen nothing (§7b).

---

## 3. The `<machine>` segment, and why omitting it corrupts data

```
<scope>/<hostname-slug>-<install-id>/current.md
```

The segment is **one path segment** carrying a slug of the machine's hostname, a hyphen, and a
per-installation random id (the reference implementation mints `crypto.randomBytes(3)` — 6 hex
characters; a reader accepts 4–16). Example: `mac-862f5b`.

It is **remembered, not recomputed**: the first save on a machine writes the chosen name to a local
identity file and every later save reuses it, because a hostname is a fact about the network rather
than about the computer, and re-deriving it gave one laptop two state folders on a rename.

### Why a writer must not "simplify" this

The reference implementation's synchronisation resolves with
`git pull --no-rebase -X theirs`. On a conflicting hunk that strategy **discards the local side
silently and reports success**. Worse than losing a side, it **splices**: two machines editing one
`current.md` produce a well-formed handoff that existed on neither of them, whose provenance line
attests that a named author made a decision they never made.

Per-machine paths mean **no hunk ever conflicts**. Two machines write two files; a reader sees both
and can say which is newer and where each came from. A writer that drops the segment — or reuses one
machine's segment from another machine — reintroduces the splice, and nothing will tell either user.

**The carve-out, stated honestly.** Tier 1 (`project.md`) and tier 0 (`foundations/`) have **no**
machine segment, deliberately: a standing brief and a canonical document are one thing per project,
not one per computer. So those two tiers **do** take the splice risk, and the bargain is stated
rather than hidden — they are edited rarely, by one person or from one repository, and the
repository (for a mirror) or the owner (for a brief) re-asserts the true content on the next write.
A writer that wants the guarantee gets it on tiers 2 and 3 only.

---

## 4. Names

Every path segment a caller supplies — a domain, a project, a scope, a machine — must satisfy:

| Rule | Value |
|---|---|
| Length | 1 to `64` characters |
| First character | a letter or a digit |
| Allowed characters | letters, digits, `.`, `-`, `_` |
| Never | contains `..`, or consists only of `.` |

Matching regular expression, applied after the length and `..` checks:
`^[a-z0-9][a-z0-9._-]*$` (case-insensitive).

A name that fails is **refused**, not repaired — except for a *scope*, which a writer may normalise
to a safe segment (`feature/auth` → `feature-auth`) and must then report the name it actually used,
because the caller will otherwise read back with a name that matches nothing.

**Reserved names.** A project may not be called `project.md`, `project.json`, `journal.jsonl`,
`current.md` or `foundations`, and a domain's own project is addressed by the domain's name (§2).

**Foundation slugs** are narrower — see §8: `^[a-z0-9][a-z0-9-]{0,63}\.md$`.

---

## 5. `current.md` — the handoff

One file per `(project, scope, machine)`. **A save overwrites it.** There is no merge, no delta and
no append: a writer sends the complete state every time, or the previous save's content is gone.

### The document

```markdown
# Working state — <scope>

> <headline>

_Machine: <machine> · Scope: <scope> · Saved: <iso-8601>[ · Harness: <name>][ · Model: <id>]_

## Where things stand

<prose>

## Firm decisions — do not re-litigate

- <item>
```

- Line 1 is `# Working state — <scope>` (an em dash, U+2014).
- The blockquote line is the **headline**: the one line a future session sees before deciding to
  open the file at all. It is **required**.
- The italic line is the **provenance**, fields joined by ` · ` (U+00B7 with a space each side), in
  this order: `Machine`, `Scope`, `Saved`, then `Harness` and `Model` **only when present**.
- Then the sections below, **each at most once**, in **this order**, with a blank line after the
  heading and after the body.

### The sections

| # | Heading (exact) | Field | Shape | Required |
|---|---|---|---|---|
| 1 | `Where things stand` | `nowState` | prose | no |
| 2 | `Firm decisions — do not re-litigate` | `decisions` | list | no |
| 3 | `Traps and dead ends` | `traps` | list | no |
| 4 | `Next steps` | `nextSteps` | list | no |
| 5 | `Observations (point-in-time)` | `observations` | obs | no |
| 6 | `Open questions` | `openQuestions` | list | no |
| 7 | `Foundations read` | `foundationsRead` | list | no |

**A section with no content is omitted entirely** — a heading with an empty body is not written.
Only the title, the headline and the provenance are unconditional.

**The order is normative, and the reason is published** rather than left as taste: `decisions` and
`traps` sit *ahead of* `nextSteps` because a model that starts executing the action list on sight
meets the dead end before it has read the warning about it. That was measured with live models, not
assumed.

**Shapes:**

- **prose** — paragraphs. Blank lines are allowed; runs of four or more newlines collapse to three.
- **list** — one item per line, each beginning `- `. An item is **one logical line**: newlines
  inside it are flattened, so a single item can never forge a second bullet or a heading break.
- **obs** — a list whose items carry a timestamp:
  `- <statement> — observed <iso-8601>[ — recheck: \`<command>\`]`.
  The separator is ` — ` (space, em dash, space). `recheck` is rendered inside a code span and any
  backtick in it is removed before rendering, so it cannot break out.

**`Foundations read`** is a list of `- <slug> · <sha256>` lines — the tier-0 documents this session
actually read, and the only section a reader parses back into structure (§11). Lines are matched
strictly: a hyphen, whitespace, a valid foundation slug, whitespace, `·`, whitespace, 64 lowercase
hex characters.

### Trimming, and the asymmetry that governs it

If the rendered document exceeds the handoff budget (§9), the writer **drops trailing items from
whichever list is currently largest**, records the drop **in the document itself**
(`- _(N more omitted — over the 48 KB state budget)_`), and saves. It does **not** refuse.

> **A handoff is trimmed because refusing it loses it; a foundation is refused because trimming it
> lies about it.**

An agent at the end of its context whose handoff is rejected has nowhere to put it. A canonical
document, by contrast, is a verbatim artefact: a truncated copy of an architecture decision record
is a document that says something its author did not.

### Reading a handoff back

The reference implementation **does not parse the handoff into fields**. It returns the whole
document and parses exactly one section (`Foundations read`). So:

- A writer must render the grammar above. A reader may treat the rest as text.
- **A heading that appears twice is a signal, not a section.** The reference writer emits each at
  most once, so a repeat means the file was hand-edited or arrived over synchronisation carrying a
  section this format did not write. It is **flagged and never removed**.
- There is no markdown → fields parser in v1, and none is promised. A tool that wants structure
  should keep its own copy of what it sent.

---

## 6. `journal.jsonl` — the append-only index

One JSON object per line, UTF-8, `\n`-terminated, opened with `O_APPEND`. **Never rewritten, never
re-ordered, never compacted.** It sits beside the `current.md` it describes, in the same
`(scope, machine)` directory.

```json
{"at":"2026-09-19T10:57:06.408Z","scope":"session-2026-09-19-spec","machine":"mac-862f5b","harness":"claude-code","model":"opus-5","headline":"Spec draft rendered from the live store","bytes":833,"rejections":[]}
```

| Field | Type | Meaning |
|---|---|---|
| `at` | ISO 8601 string | when the save was written, by the **writer's own clock** |
| `scope` | string | the scope directory this line belongs to |
| `machine` | string | the machine segment (§3) |
| `harness` | string or `null` | the agent harness that saved, as a label |
| `model` | string or `null` | the model, as a label |
| `headline` | string | the handoff's headline at that moment |
| `bytes` | integer | the size of the `current.md` that was written |
| `rejections` | array of strings | notes about what the sanitiser changed or dropped |

**`rejections` is a persisted name that means *notes*.** It is kept because every line ever written
carries it, and a rename would force every reader to accept both names forever. Most entries in it
are not rejections at all — only the words *dropped*, *omitted*, *truncated*, *rejected* and *lost*
describe an actual loss of content.

**The journal is best-effort.** A failed append never fails the save: the handoff is already on
disk, and a missing index line is a cosmetic loss. A reader must therefore tolerate a `current.md`
with no journal line, and a journal with lines whose `current.md` has since been overwritten.

A malformed line is **skipped**, never fatal. Readers read a bounded tail of the file rather than
the whole thing.

---

## 6b. `previous.md` — one kept copy of another tool's handoff (v3.74.0)

The path has no tool segment (§3 is about machines, not tools), so two agent tools on **one**
machine that save to the same scope write the same `current.md`, and each save replaces the other's.
The store warns when that happens and keeps what it replaced:

**The writer rule.** Before a save writes `current.md`, if a `current.md` is already there **and**
the newest journal line in that folder names a harness **and** the incoming save names a harness
**and** the two harnesses are **different tools** — compared after normalising the free-text label
(lowercase, a trailing parenthetical dropped as a variant, known aliases folded: `Claude Code`,
`claude-code` and `Claude Code (desktop)` are one tool; `claude-desktop` is a different one; an
unknown name is compared as itself) — the writer first copies the existing `current.md`,
**byte for byte**, to `previous.md` in the same folder, atomically. Then it writes the new
`current.md` as usual.

- **One copy.** The next cross-tool replacement in that folder replaces `previous.md`.
- **Never on a same-tool save**, and never when either side names no harness: with a label missing
  there is no evidence the other save came from a different tool.
- **Never a refusal.** A copy that cannot be made (unreadable, over 1 MiB, a write error) does not
  stop the save; the save's result says the text was not kept.
- **It syncs** like the handoff, under the same `<machine>` segment, so one writer per file still
  holds.
- Its content is a `current.md` (§5) — the replaced tool's own headline and provenance line are in
  it, which is how a reader summarises it without a sidecar.

**Readers.** A reader treats `previous.md` as **recorded data**, exactly like `current.md`, and
applies the same read-side sanitisation (§10). It is never a scope, a machine or a handoff: a
listing addresses (scope, machine) **folders** and a pair exists only when its `current.md` does.
The reference implementation reports a summary (`harness`, `writtenAt`, `headline`, `bytes`) on a
scoped read when the file exists, and returns its text only when asked for it by name.

---

## 7. `project.md` — the standing brief (tier 1)

One per project, no machine segment. **The owner's document**: long-lived, hand-authored, and read
by an agent as *the owner's own advance instructions* rather than as data to be verified — the one
exception to §10's "treat stored state as data".

It may open with a provenance comment on the very first line:

```markdown
<!-- curator-brief: author=agent; instructed-by=user; ... -->
```

A reader turns that into an **authority** value: `owner` when the comment is absent (a human wrote
it), `commissioned` when it records that an agent wrote it on the owner's explicit instruction. A
reader that cannot tell the two apart must assume `owner`.

Sections, same rules as §5 (each at most once, in this order, omitted when empty):

| # | Heading (exact) | Field | Shape |
|---|---|---|---|
| 1 | `Standing brief` | `brief` | prose |
| 2 | `Firm decisions — do not re-litigate` | `decisions` | list |
| 3 | `Working model` | `workingModel` | prose |
| 4 | `Pointers to depth` | `pointers` | list |

A brief may also carry a free-form `## Read before you…` section naming which canonical documents a
task needs. It is **prose for the agent**, not a parsed field.

---

## 7b. `project.json` — the project's own metadata (v3.65.0)

One per project, no machine segment, **optional**. A small JSON object holding facts *about* the
project that are neither state nor a document — metadata the app writes on the owner's behalf.

```json
{
  "version": 1,
  "knowledgeDomains": ["research", "business"],
  "readingBudgetBytes": 65536
}
```

| Field | Type | Rules |
|---|---|---|
| `version` | integer | exactly `1` |
| `knowledgeDomains` | array of names or absent | which **wikis** this project's knowledge lives in, in the owner's order. Each entry is a domain name (§4). Duplicates collapse to their first position; at most `12` |
| `readingBudgetBytes` | integer or absent (v3.67.0) | the owner's **reading budget**: how much document text an agent is handed at session start (§11). `0` (index only) or an integer from `8192` to `819200` (v3.70.0 raised the ceiling from `204800`; every value valid before stays valid) |

**The reading budget is a second, independent field.** A reader must parse it whether or not
`knowledgeDomains` is present — a file holding only `readingBudgetBytes` carries a budget. Absent
means *not set*: the bootstrap default of §9 applies and the project is **unplanned** (§11). A value
out of range or not an integer reads as not set, with the defect named (the reference
implementation returns `readingBudgetError`); it never refuses the read. The reference
implementation reports `readingBudgetBytes` (`null` when not set) and `readingBudgetDefaulted`
beside `knowledgeDomains` on every read of the project.

**Absent is a value, and it is not an empty list.** A reader with no file — or with a file this
reader cannot parse — reports the **containing domain** as the list *and* reports that it was
defaulted. Those are two fields, and a reader that returns only the list cannot tell "the owner
chose exactly this domain" from "nobody has chosen". The reference implementation names them
`knowledgeDomains` and `knowledgeDomainsDefaulted`, and carries both on every read of the project
(§11) rather than only on a detail read.

The containing domain is **not** forced into a chosen list: a project may point only at other
domains, and a `shared-*` read-only mirror is a legitimate entry — reading a mirror's wiki is what a
mirror is for.

**A malformed file never refuses a read.** It reads as the default with the defect *named* (the
reference implementation returns a `metaError` string), for the same reason a malformed
`foundations/manifest.json` reads as `present: false` with `manifestError`: a hand-editable file
that syncs must not be able to take a project's whole bootstrap down with it.

**Who writes it.** The owner, through the app — this file is metadata *about* the project, so it is
not tier 2/3 state and the single-writer rule ("one writer per file, with provenance that matches")
is satisfied by the app being that one writer. **An agent does not write it**: choosing where a
project's knowledge lives, and how much an agent reads at the start, are the owner's decisions, so
neither a handoff save nor the CLI's save touches this file.

**A writer must merge, not replace.** Read the file, change the one field, write it back — a field a
later version adds must survive a write by an earlier one. A file left holding nothing but
`version` should be removed rather than kept as a stub.

---

## 8. `foundations/` — canonical documents (tier 0)

Documents that must be read **word for word**: an architecture note, an ADR set, conventions, a
roadmap. Unlike the wiki, which digests and accumulates, this tier stores the document itself and
**replaces it whole**.

```
foundations/
  manifest.json
  architecture.md
  decisions.md
```

- **Slug grammar:** `^[a-z0-9][a-z0-9-]{0,63}\.md$`.
- **Documents are stored verbatim.** No heading escaping, no frontmatter injection, no rewriting —
  because `sha256(stored)` must equal `sha256(source)`, and because a mirrored architecture document
  *is* headings.
- **The manifest is written LAST**, whole and atomically. A crash therefore leaves a document with
  no manifest entry (reported as an *orphan file*) and never an entry pointing at a document that
  is not there.

### `manifest.json`

```json
{
  "version": 1,
  "ownership": "repo",
  "repo": {
    "root": "/Users/me/src/lumina",
    "remote": { "owner": "acme", "repo": "lumina", "ref": "main", "path": "docs" },
    "lastRefreshAt": "2026-09-19T09:12:00.000Z",
    "lastRefreshCommit": "9f3c1a…40 hex"
  },
  "budgetBytes": 204800,
  "order": ["architecture", "decisions", "conventions", "roadmap", "api", "guide", "other"],
  "documents": [
    {
      "slug": "architecture.md",
      "role": "architecture",
      "title": "Architecture",
      "source": { "kind": "repo", "path": "docs/architecture.md" },
      "sha256": "…64 hex…",
      "bytes": 18422,
      "updatedAt": "2026-09-19T09:12:00.000Z",
      "commit": "…40 hex…",
      "authoredBy": { "kind": "human" },
      "skeleton": false,
      "readFirst": true
    },
    {
      "slug": "roadmap-2025.md",
      "role": "roadmap",
      "title": "Roadmap 2025",
      "source": { "kind": "repo", "path": "docs/roadmap-2025.md" },
      "sha256": "…64 hex…",
      "bytes": 96210,
      "updatedAt": "2026-09-19T09:12:00.000Z",
      "commit": "…40 hex…",
      "authoredBy": { "kind": "human" },
      "skeleton": false,
      "readFirst": false,
      "hidden": true
    }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `version` | integer | `1` here; `2` for the shape in *manifest.json, version 2* below. Anything else: refuse the manifest, do not guess, and never remove it |
| `ownership` | `"repo"` \| `"curator"` \| `null` | **v1 only. Derived in v2.** In v1: `repo` when every document is mirrored from the one source in `repo`, `curator` when every document is kept here |
| `repo.root` | string or `null` | an **advisory** absolute path on the machine that last refreshed. On any other machine it is a hint, never a fact. `null` is ordinary: a mirror created from a GitHub repository (v3.65.0) has never been copied from a folder on any machine |
| `repo.remote` | object or `null` | `{owner, repo, ref, path}` — GitHub coordinates (v3.63.0). `ref` and `path` may be `null`. An unparseable value reads as `null`, which is what `null` has always meant: no mirror recorded |
| `repo.lastRefreshAt` | ISO string or `null` | |
| `repo.lastRefreshCommit` | 40 hex or `null` | the commit the last refresh read |
| `budgetBytes` | positive integer | defaults to the project budget in §9 |
| `order` | array of role names | the **reading order**. Every known role is appended if missing, so the array is total |
| `documents[]` | array | at most `200` entries |

Per document:

| Field | Type | Rules |
|---|---|---|
| `slug` | string | the slug grammar above; unique within the manifest |
| `role` | string | one of `architecture`, `decisions`, `conventions`, `roadmap`, `api`, `guide`, `other` |
| `title` | string | ≤ `120` characters; defaults to the slug without `.md` |
| `source` | object | `{kind: "repo", path}` or `{kind: "curator"}` (v2 adds `group` on a `repo` source). **`kind` must match `ownership`** — v1 only |
| `sha256` | 64 hex | of the **stored bytes**. This is the document's identity |
| `bytes` | non-negative integer | |
| `updatedAt` | ISO string or `null` | |
| `commit` | 40 hex or `null` | the source commit, when known |
| `authoredBy` | object | `{kind: "human"}` / `{kind: "agent", …}` — the provenance a human write must carry |
| `skeleton` | boolean (v3.61.0) | `true` = this document is a **prompt to be filled in**, not a fact. Absent = `false`; any save clears it |
| `readFirst` | boolean (v3.62.0) | `true` = an agent must not start work here without it. Absent = `false` |
| `hidden` | boolean (v3.67.0) | `true` = **not at start**: kept and mirrored, but absent from the session-start index. Absent = `false`. Never `true` together with `readFirst` |

**`readFirst` is tri-state on write**: omitted leaves an existing value alone, and `absent = false`
on a new document.

**Three start states, two flags (v3.67.0).** A document is *read first* (`readFirst: true`), *not
at start* (`hidden: true`), or *on request* (neither). The two flags are **mutually exclusive** and a
writer sets them in **one** manifest write; a file carrying both reads as read first — the
direction that hands an agent more, never less — and the contradiction is disclosed. A writer
should write `hidden` only when it is `true`. Like `readFirst`, `hidden` is the owner's routing, so a
save of the document's text preserves it, an explicit `readFirst: true` clears it, and a mirror
refresh preserves it **by slug**. A reader that predates `hidden` drops it on its next rewrite and
the document reappears at session start: the fail-safe direction.

**Sources are per document (v3.69.0).** Each document records its own source: it is **kept**
(`{kind: "curator"}` — written here, or copied in once, with `copiedFrom` naming the folder's
basename) or **mirrored** (`{kind: "repo", path}`) from a **source group**: one folder, or one GitHub
repository, that documents are copied FROM. One project may hold kept documents and documents from
up to **8** groups (`MAX_SOURCES_PER_PROJECT`) at once. The invariant that protects data is **one
writer per FILE**, not one source per project: a mirrored document's file is written only by a
refresh or an add from its group (the source is the author), a kept document's only by a save, and a
save to a slug whose entry is a mirror is refused. A v1 manifest expresses at most one group (its
`repo`) and one kind of document (its `ownership`); anything more is written as version 2, below.

A group records `root` (a folder on one machine), `remote` (a GitHub repository), or **both** — and
at least one of them, or there is nothing to copy from. A group **born remote**, or one **switched to
remote**, carries `root: null`, which is ordinary and **not** an error. A group can be RE-CHOSEN
(v3.65.1): switching it re-copies its documents' bytes, sets its `remote` and clears its `root`
**in the same write** — a second write would be a second failure point, able to leave a group naming a
stale folder and a fresh repository at once. A switch changes no document's kind:
`ownership` never moves in v1, and a mirrored document stays mirrored in v2. `readFirst` is preserved **by slug** across the
re-copy, for the reason §8 gives: the source owns the bytes, the owner owns the routing. A reader
holding both a `root` and a `remote` for a group prefers the folder when it is reachable on this
machine, and the network otherwise. A group whose last document is removed is removed in the same
write; a removed mirrored document is **not** brought back by a refresh, because a refresh's work
list is the manifest's documents plus files a caller names.

### `manifest.json`, version 2

Written only when v1 cannot express the manifest: kept and mirrored documents together, or ≥ 2
source groups. There is **no `ownership` and no `repo`** — both are derived on read.

```json
{
  "version": 2,
  "sources": [
    { "id": "s1", "root": "/Users/me/src/second-brain",
      "remote": { "owner": "talirezun", "repo": "second-brain", "ref": null, "path": null },
      "lastRefreshAt": "2026-09-24T10:00:00.000Z", "lastRefreshCommit": "…40 hex…" },
    { "id": "s2", "root": null,
      "remote": { "owner": "acme", "repo": "lumina", "ref": "main", "path": null },
      "lastRefreshAt": null, "lastRefreshCommit": null }
  ],
  "budgetBytes": 204800,
  "order": ["architecture", "decisions", "conventions", "roadmap", "api", "guide", "other"],
  "documents": [
    { "slug": "decisions-agents.md", "role": "decisions", "title": "Decisions",
      "source": { "kind": "repo", "path": "docs/dev/decisions-agents.md", "group": "s1" },
      "sha256": "…64 hex…", "bytes": 1, "updatedAt": "…", "commit": "…40 hex…",
      "authoredBy": { "kind": "human" }, "skeleton": false, "readFirst": true },
    { "slug": "lumina-architecture.md", "role": "architecture", "title": "Lumina architecture",
      "source": { "kind": "repo", "path": "docs/architecture.md", "group": "s2" }, "…": "…" },
    { "slug": "notes.md", "role": "other", "title": "Notes", "source": { "kind": "curator" },
      "copiedFrom": "dev", "…": "…" }
  ]
}
```

`sources[]` — at most `8` entries:

| Field | Type | Rules |
|---|---|---|
| `id` | string | `^s[1-9][0-9]?$`, unique within the manifest; a new group takes the smallest unused id. It means nothing outside this manifest |
| `root` | string or `null` | the same **advisory** absolute path as v1's `repo.root` |
| `remote` | object or `null` | `{owner, repo, ref, path}`, as v1's `repo.remote` |
| `lastRefreshAt` | ISO string or `null` | |
| `lastRefreshCommit` | 40 hex or `null` | |
| *(kind)* | derived, never stored | `root` non-null: a **folder** source (which may also be read over GitHub when `remote` is recorded); `root: null`: a **GitHub** source |

**At least one of `root` / `remote` is non-null**, or the group has nothing to refresh from; a reader
accepts such a group and reads it as *source not recorded*. A group with zero documents is allowed (a
*declared* source).

Per document, in addition to the v1 fields: a `repo` source carries **`group`**, which must name an
existing `sources[].id`; a `curator` source carries none. Within one group one path maps to one slug
and one slug to one path; the same path in two different groups is allowed. Slugs stay unique across
the manifest, and the 200-document and 200 KB caps are unchanged.

**How a v1 manifest reads as the same model.** A v1 `repo` manifest is one group `s1` (its `repo`),
and each of its documents belongs to `s1`; a v1 `curator` manifest, or `repo: null`, has no groups. A
writer that changes nothing writes nothing, and a project that stops mixing (its last GitHub
document removed, say) is written as **v1 again**, so an older reader can read it once more.

**An older reader and version 2.** A reader that knows only version 1 refuses the file by rule 3 —
it reads no documents from it and writes nothing to it, so it can never rewrite a mixed manifest
under one `repo` (which would copy one repository's `docs/README.md` over another's). The reference
implementation from v3.68.1 says so as "saved by a newer version of The Curator — update the app",
and never tells the user to fix or remove the file; v3.68.0 and earlier refuse it as unreadable.

### Freshness is computed, never remembered

No document carries a "fresh" flag. A reader compares the **stored `sha256`** against the source's
current hash when the source is reachable, and reports one of:

| Value | Meaning |
|---|---|
| `fresh` | the stored copy matches the source |
| `stale` | the source has changed since the copy was made |
| `unreachable` | the source could not be read from here — **not** a claim that it changed |

A remote mirror's freshness is **not** compared over the network on a read. A GitHub comparison
happens only inside an explicit refresh, which is an action with a button, never a read that rides
on every page load.

---

## 9. Budgets, and what happens at each one

| Limit | Value (bytes or count) | Constant | Behaviour at the limit |
|---|---|---|---|
| One handoff (`current.md`) | 49,152 (48 KB) | `MAX_STATE_BYTES` | **Trimmed and disclosed in the file** — never refused |
| One standing brief | 32,768 (32 KB) | `MAX_BRIEF_BYTES` | Truncated, and the truncation is noted |
| Items in one list | 40 | `MAX_ITEMS_PER_LIST` | Trailing items dropped, the count recorded |
| One list item | 600 | `MAX_ITEM_CHARS` | Truncated **by code point** (§10) |
| The headline | 200 | `MAX_HEADLINE_CHARS` | as above |
| One prose field | 8,000 | `MAX_PROSE_CHARS` | as above |
| A harness or model label | 80 | `MAX_META_CHARS` | as above |
| One canonical document | 524,288 (512 KB) | `MAX_FOUNDATION_BYTES` | **Refused** — a verbatim document cannot be honestly trimmed |
| Foundations per project | 204,800 (200 KB) | `FOUNDATIONS_BUDGET_BYTES` | **Accepted and disclosed** — over budget is a reading the owner acts on |
| Documents per project | 200 | `MAX_FOUNDATIONS_PER_PROJECT` | Refused |
| A bootstrap read, when the owner has set no reading budget | 122,880 (120 KB) | `CONTEXT_MAX_BYTES_DEFAULT` | Bodies dropped in reverse reading order, omissions disclosed |
| A bootstrap read, ceiling | 819,200 (800 KB) | `CONTEXT_MAX_BYTES_CAP` | A caller may not ask for more, and an owner may not set more |
| The smallest non-zero reading budget | 8,192 (8 KB) | `READING_BUDGET_MIN_BYTES` | Below it only `0` (index only) is a reading budget; anything else reads as not set (§7b) |
| The manifest file | 1,048,576 (1 MB) | `MAX_FOUNDATIONS_MANIFEST_BYTES` | Read cap; a larger file is malformed |

A writer is not obliged to implement the trimming — but it **is** obliged not to exceed the
budgets, and if it trims it must say so in the file, because the whole product rests on a reader
being able to tell a short handoff from a cut one.

---

## 10. Sanitisation — what a writer applies, and what a reader re-applies

The file a reader opens was **not necessarily written by that reader**: it arrives over
synchronisation, it is editable in any text editor, and on a shared machine it may have been written
by another tool. So the rules run on **write, per field** and again on **read, over the whole file**.

| Rule | On write | On read | What it does |
|---|---|---|---|
| Control characters | ✔ | ✔ | strips C0 and DEL, keeping `\n` and `\t` (a literal NUL makes git treat the file as binary) |
| Zero-width / bidi | ✔ | ✔ | strips the Cf characters that hide or reorder text. **U+200C and U+200D are deliberately kept** — they are required by emoji sequences and by Persian and several Indic scripts |
| Protocol-shaped tags | ✔ | ✔ | `<system-reminder>`, `<tool_use>`, `<invoke>`, `<human>` … → `&lt;…`, so stored text cannot impersonate a channel |
| Role markers | ✔ | ✔ | a line-initial `Human:` / `Assistant:` / `System:` / `Claude:` → `…&#58;` |
| Heading escaping | ✔ tiers 1–3 | ✘ | a line-initial `# ` → `\# `, so a field cannot forge a section heading. **OFF for tier 0** |
| Defanging | ✔ | ✔ | `https://x` → `https[:]//x`; `… \| sh` → `… &#124; sh` |

**Defang never deletes.** A legitimate handoff routinely carries URLs and shell commands, and
destroying them destroys the product. Two characters are inserted, nothing is removed, and a human
reads straight through it while a terminal, a browser and an auto-linker do not. Both substitutions
are idempotent by construction, which matters because they run on every read.

**It is not a safety verdict.** Defanged text is still hostile text if it was hostile; it has been
made non-actionable to a copy-paste, not made true. A command with no URL and no pipe is untouched.

**Heading escaping is off for tier 0** because a canonical document *is* headings, and because
`sha256(stored)` must equal `sha256(source)` for freshness to mean anything. The trade is stated
rather than hidden: a tier-0 document can carry a heading that a naive reader might mistake for a
section of its own container. It is never rendered inside one.

**Truncation is by code point, never by UTF-16 code unit.** Cutting a 200-character headline that
ends in an emoji with a UTF-16 slice produces a lone surrogate, which reaches disk as U+FFFD and
crosses every JSON boundary after that. A writer in any language must count characters the way its
users do.

---

## 11. The bootstrap — what a reader assembles, and in what order

"Start a session" is one read. It assembles, in this order:

1. **The standing brief** (`project.md`), with its authority note **first** — it is the owner's
   instruction and outranks everything after it.
2. **The latest handoff** — `current.md` for the scope asked for, or the most recently written scope
   when the caller asks for the latest.
3. **A bounded journal tail** — the most recent entries, newest first.
4. **The foundations**: the **index always**, then bodies chosen by the table below, in
   `manifest.order` order, within the reading budget: the caller's, else the owner's
   `readingBudgetBytes` (§7b), else the bootstrap default (§9).

### Which bodies arrive

`anyReadFirst` means at least one manifest entry carries `readFirst: true`. A project is
**planned** when the owner has set a reading budget (§7b).

| `include` | no document flagged, unplanned | at least one flagged, or planned |
|---|---|---|
| `index` | no bodies | no bodies |
| `changed` | bodies whose `sha256` differs from the caller's `seen` map | bodies of **all** read-first documents (none, when nothing is flagged); the `seen` map is **ignored**; everything else is index only |
| `all` | every body, in reading order | every body |

**The default** is `changed` when hashes are known (passed by the caller, or recorded in the latest
handoff's `Foundations read` section), **or** when any document is flagged, **or** when the project is
planned, and `all` otherwise. A planned project whose reading budget is `0` reads as `index`.

**So an untouched project is unchanged.** With no reading budget set, nothing about which bodies
arrive differs from a reader that predates the field.

**Documents *not at start*** (`hidden: true`, §8) are absent from the index, from `all`, from the
budgeted set and from the `seen` map; the reader reports how many there are. A caller that names
one by slug still receives it — keeping a document off the start is not denying it.

**So flagging one document changes what every other document costs a session.** That is part of the
contract, not a user-interface detail.

**Why read-first bodies ignore the `seen` map**, which is the one real judgement in this section: the
hash delta is an economy for a set the agent reads once and remembers. `readFirst` is the owner
saying *do not start work here without this*, which is a **per-session** instruction — a resumed
session has the hashes and none of the text, and under a delta rule would be handed an index and no
orientation at all.

A caller may also name documents by slug; those come back **whole**, in the order given, and are
excluded from the budgeted set rather than sent twice.

**Delivery in pages (v3.70.0) is a property of a reader's transport, not of this format.** The
reference implementation's MCP door sends one bootstrap in replies of at most 81,920 bytes of
serialised JSON (≈20k tokens), because a common harness shows a tool reply of at most 25,000 tokens
and moves a larger one into a file. Documents are never cut to make a page: whole documents, in the
order above, and a document larger than one page travels alone. Page 1 carries items 1–3 and the
index exactly as an unpaged read does; each page but the last names the next in
`foundations.continuation` (`page`, `of`, `remaining`, `slugs`). A reply that fits one page carries
no paging field at all. What is selected — and therefore the `seen` map — does not depend on paging.

**Reads never write.** Nothing is marked seen by reading it. The reader returns the map of hashes it
served, and the **caller records it on its next save** — which is exactly what the
`Foundations read` section of `current.md` is for.

When the budget is exceeded, bodies are **omitted and named**, never cut — with one exception: when
the very first document alone exceeds the budget it is cut and flagged as truncated, because a
caller who asked for documents and received none has been told nothing. The exception does not
apply to a reading budget of `0`, which is a plan rather than a shortfall.

---

## 12. What this format deliberately does not do

- **No locking on tiers 2 and 3.** Per-`(scope, machine)` paths mean the only possible racer is two
  savers on one machine in the same scope, and the last complete write wins. Tier 0 is the exception
  and does take a lock, because it has no machine segment.
- **No merge of two machines' handoffs.** They are two files. A reader may show both; nothing
  combines them.
- **No identity for a project beyond its folder name.** There is no id, no UUID and no registry.
- **No migration.** A legacy tree is read where it lies and written where it lies.
- **No markdown → fields parser** for the handoff (§5). Only `Foundations read` is parsed back.
- **No schema for the wiki.** The knowledge base beside `state/` is plain markdown with
  `[[wikilinks]]` and is not part of this specification.
- **No transport.** How the files reach another machine — git, rsync, a shared drive — is the
  implementer's choice. The `<machine>` segment (§3) exists so that a three-way merge never has to
  make a decision about them.

---

## 13. Conformance

A writer conforms to `working-state/1` when, for every file it writes:

1. Names satisfy §4 and the layout satisfies §2.
2. Tier 2 and tier 3 paths carry a `<machine>` segment that is unique to the writing machine (§3).
3. `current.md` renders the grammar of §5 — title, headline, provenance, sections at most once, in
   order, empty ones omitted.
4. Every bounded value is within §9.
5. The write-side rules of §10 are applied per field.
6. A journal line, if written, carries the eight fields of §6 and is appended, never rewritten.
6b. `previous.md`, if written, follows the writer rule of §6b — a byte-for-byte copy of the
   replaced `current.md`, written only on a cross-tool replacement, never on a same-tool save.
7. A manifest, if written, is valid per §8 and is written **last**.

The reference implementation's acceptance test for this document is a writer built **only** from
this file, by someone without this repository, whose output The Curator reads back reporting
`sanitisedOnRead: false` and `headingsSuspect: false` — nothing repaired, nothing flagged.

**How this file is kept true:**
[`scripts/test-spec-working-state.js`](../../scripts/test-spec-working-state.js) parses the tables
above and compares every heading string, every section order, every budget number and every name
grammar against the live constants in `src/brain/working-state.js` and `src/brain/mcp-usage.js`. It
runs in `npm test`. A specification that drifts from the code is worse than none, because it is a
promise made to people who cannot see the code.

---

## Appendix A — the local usage log (not part of the state format)

A conforming implementation does **not** need this. It is documented here because it sits in the
same family and because a reader may encounter the file: The Curator's MCP bridge appends one
**content-free** line per tool call to a local log outside `state/`, and never synchronises it.

```json
{"ts":"2026-09-19T10:57:06.408Z","tool":"get_project_context","domain":"articles","ok":true,"refused":false,"ms":12,"sid":"9f2c1a4b7e30","project":"lumina"}
{"ts":"2026-09-19T10:57:06.400Z","ev":"session","sid":"9f2c1a4b7e30","client":"claude-code"}
```

- **Tool line:** `ts`, `tool`, `domain`, `ok`, `refused`, `ms`, `sid` always; `project` and `via`
  optional. **Nothing else, ever** — no arguments, no results, no paths, no error text.
- **Session line:** written once per bridge process, `ev: "session"`, carrying the `sid` and the
  client label so the label does not ride on every line. It is written **when the client identifies
  itself**, rather than before the first tool call, so a bridge that is opened and never asked for
  a tool still records that a session happened.
- `sid` is `^[0-9a-f]{12}$` — a minted random id, once per process. One bridge process is one
  session.
- `client` is **optional** on the session line — absent when no client had identified itself — and
  is an **allow-listed label** for reporting only. The MCP specification's
  revision `2026-07-28` makes `clientInfo` optional, per-request and self-reported, and says a
  server **SHOULD NOT** change behaviour on it. Nothing does.
- Every line is at most `300` bytes (`MAX_LINE_BYTES`), which is arithmetic over each field's bound
  rather than a measurement.

See [`docs/mcp-user-guide.md`](../mcp-user-guide.md) for the privacy statement and the rotation
rule.

---

## Appendix B — related reading

| Document | What it adds |
|---|---|
| [`docs/working-state.md`](../working-state.md) | the design record: why each rule exists, what is not enforced, the limits |
| [`docs/mcp-user-guide.md`](../mcp-user-guide.md) | the tools an agent calls, and the usage log |
| [`docs/api-reference.md`](../api-reference.md) | the HTTP routes the app serves over the same store |
| [`docs/sync.md`](../sync.md) | how `state/` travels between machines, and what it cannot promise |
