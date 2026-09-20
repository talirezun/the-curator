# Roadmap — the context engine (v3.61.0 → v3.65.0)

> **Read this like the other roadmap documents in this folder.** Same convention as
> [roadmap-chat-modes.md](roadmap-chat-modes.md), [roadmap-menubar-widget.md](roadmap-menubar-widget.md)
> and [roadmap-automatic-sync.md](roadmap-automatic-sync.md): **most of what follows has not been
> built.** Every row carries a status — `built`, `in flight`, `designed`, `planned` — and a status
> is the only thing in this file you may rely on. Where a claim rests on code, the file is cited;
> where a claim rests on a measurement, the date and the sample size are named. Anything not cited
> and not labelled is an intention, not a fact.
>
> **Written 2026-09-18**, against `main` after v3.60.0, with v3.61.0's store and skills merged and
> its views and routes still in flight (`package.json` reads `3.60.0`). It consolidates a UX design
> pass, an audience inventory and a build contract taken the same day — session working documents,
> not files in this repository. Update this file in place as decisions firm up; when a release
> ships, move its row's status and leave the reasoning where it is.
>
> **The positioning it is written under is locked and is not up for revision here:**
> *your brain → your team's brain → your agents' brain* ([README](../README.md),
> [user-guide §1](user-guide.md#1-what-is-this-app)). Nothing below proposes changing it.

---

## A. Premise, and the two audiences

**The premise, decided by the maintainer on 2026-09-18.** The biggest problem in front of anyone
working with AI is **context**. A project larger than one context window loses its context between
sessions, between harnesses, between models and between machines. Solving that for coding solves it
for any multi-session work, because the failure is structural and not domain-specific. **Vendor
lock-in is the second problem, not the first** — but it is what makes the first one permanent, since
context held inside one vendor's product is abandoned on the day you switch. And a third condition
is already real rather than hypothetical: **several harnesses may work one project in parallel**,
so a store that assumes one writer at a time is answering a question nobody asked any more.

**The Curator is the context engine.** Per project it holds three layers, portable as plain markdown
in a folder the user chose and synced through the user's own private git repository, read and written
over a harness-neutral MCP bridge (a stdio child process — [mcp/server.js](../mcp/server.js)).

| Layer | What it holds | Verb | How it changes | Where it lives |
|---|---|---|---|---|
| **Foundations** — canonical documents | Architecture, decisions, conventions, roadmap, API surface, a guide — verbatim | **add** (mirror a folder, or write it here) | **Replaced whole** — never merged, never paraphrased | `state/[<project>/]foundations/` |
| **Agent memory** — volatile state | The standing brief (the owner's), the latest handoff, the journal | **save** | **Supersedes** — each save replaces the last, so a resolved blocker cannot come back | `state/[<project>/]…` |
| **Domain knowledge** — the wiki | Entities, concepts, summaries, cross-linked | **ingest** | **Accumulates** — a new source deepens existing pages instead of duplicating them | `wiki/` |

The verbs matter more than the layers. **`ingest` and `add` are opposite operations** and the app
has had one front door for both: ingest sends a file through the model, writes wiki pages and files
the original in gitignored `raw/` — the original is never the product; add keeps a document
verbatim — the original *is* the product. Full design record of the three layers:
[working-state.md](working-state.md), whose foundations chapter is the tier-0 contract.

**Two audiences, one roof, neither abandoned.**

| | Audience 1 — the knowledge builder | Audience 2 — the builder working with agent harnesses |
|---|---|---|
| What they came for | A second brain, or a shared/company brain: ingest → wiki → chat → share | A context engine: their project's context surviving a change of session, harness, model or machine |
| Their unit of work | A **domain** | A **project** inside a domain |
| Layer they live in | Domain knowledge | Foundations + agent memory |
| First minute today | Coherent end to end and must not be disturbed | Four things are wrong for them (§C, v3.62.0) |

**Two recommendations the maintainer adopted, and they order everything below.**

1. **The project is the unit for audience 2, and the one-call bootstrap is the core primitive.**
   `get_project_context` ([mcp/tools/catalogue.js](../mcp/tools/catalogue.js), v3.59.0) already
   returns the brief, the latest handoff and the canonical documents a caller has not seen, in one
   response. Everything else on the read side is an optimisation of that call.
2. **The hard problem is CAPTURE, not storage.** State exists only if agents save it. Capture is
   **advisory** by design, and on a harness whose model never reaches for the skill it silently does
   nothing at all — measured, not assumed: on 2026-09-10, 16 headless runs, N=4 per arm, **Claude
   Code saved in 0 of 4 runs with the skill alone** and 3 of 4 with the instruction block in the
   harness's own entry file, while **opencode activated the skill as its first action 4 of 4** in
   both arms ([working-state.md § Activation](working-state.md#activation-put-the-discipline-where-the-harness-cannot-skip-it)).
   A store with a perfect read path and no write discipline is an empty store.

Two more conditions follow from those: **parallel harnesses need awareness of each other's
handoffs**, and **volatile → canonical needs a promote gesture** (a decision recorded in a handoff
is superseded by the next save; if it is durable it belongs one tier down). And one rule over all of
it, from the standing brief's *Agnostic by default* commitment: **claims of reach are measured, never
asserted** — the Agent Skills standard existing does not mean a given host implements it.

---

## B. The scenario spine

Both audiences in one table, in the order a person meets them. **Audience 1's rows are the protected
basics** — they are first because they must not regress, not because they are done with.
`K` = knowledge builder, `B` = builder with agent harnesses. Status is of `main` on 2026-09-18.

| # | Audience | Scenario | Served by | Status |
|---|---|---|---|---|
| K1 | 1 | First launch, no key, no domain: a dismissible three-step docked panel points at Settings | shipped (`views/onboarding.js`) | built |
| K2 | 1 | Point the app at a wiki folder that already exists, or create the first domain | shipped (`views/domains.js`) | built |
| K3 | 1 | Ingest one source; read the created / updated / unchanged split | shipped (`views/ingest.js`) | built |
| K4 | 1 | Drop 2+ files: a batch, a free estimate before the spend, an optional USD cap, sequential execution | shipped | built |
| K5 | 1 | An ingest finishes while they are on another view — **nothing tells them** | v3.65.0 (there is no Ingest rail button left to badge — it moves to the Domains entry) | planned |
| K6 | 1 | They drop a `.md` they wanted kept verbatim; it is billed, atomized, and the original lands in gitignored `raw/` | v3.61.0 pointer note · v3.62.0 the full ingest-or-keep fork | in flight / designed |
| K7 | 1 | Browse a domain, filter the page list from the OVERVIEW tiles, open a page in the reader, follow a backlink | shipped | built |
| K8 | 1 | Ask a question and get an answer citing their own pages, with a per-answer cost and a reasoning breakdown | shipped (v3.58.0) | built |
| K9 | 1 | Compile a thread into wiki pages through the same write pipeline as ingest | shipped (v2.5.0) | built |
| K10 | 1 | Run a health scan; fix the safe issues in one press | shipped | built |
| K11 | 1 | Merge semantic duplicates behind the per-pair preview gate | shipped (v2.4.5) | built |
| K12 | 1 | Run a Shared Brain for a cohort; join one with an invite token; revoke a member | shipped | built |
| K13 | 1 | Sync to their own private repository; set up a second machine without losing anything | shipped | built |
| K14 | 1 | Open the vault folder in Obsidian and colour the graph by type | shipped + guide | built |
| K15 | 1 | Chat's view header states `the default view`, untrue since v3.49.0 moved the default to Domains | v3.62.0 | planned |
| K16 | 1 | `index.md` has rotted, and it is the grounding step for every agent write into their wiki | standing (§D) | open |
| K17 | 1 | OVERVIEW, PAGES · THE WIKI and WIKI HEALTH have no ⓘ to explain themselves | v3.62.0 | planned |
| B1 | 2 | Create a project and choose, once, where its documents come from: keep them here · mirror a folder · decide later | v3.61.0 | in flight |
| B2 | 2 | Onboard a checkout: name a folder, scan it, tick the documents, mirror them byte-for-byte | v3.61.0 | in flight |
| B3 | 2 | Mirror a **plain folder with no git** — supported by the store today; only the copy said "repository" | v3.61.0 | in flight |
| B4 | 2 | Seed four skeletons (architecture, decisions, conventions, roadmap) and answer the prompts by hand, with no agent and no repo | v3.61.0 (`src/brain/foundation-skeletons.js`) | in flight |
| B5 | 2 | Get an agent to draft those four: one copyable request naming the project, the tool and the approval gate | v3.61.0 | designed |
| B6 | 2 | Import a `.md`/`.txt` from disk into a curator-owned project, reviewed in the editor before it is saved | v3.61.0 | in flight |
| B7 | 2 | Choose *decide later*, and be offered the same choice again at the Foundations block | v3.61.0 | in flight |
| B8 | 2 | Edit or delete a curator-owned document in the app, on raw bytes, with a human provenance stamp | v3.61.0 | in flight |
| B9 | 2 | A cold session on any harness: one call returns the brief, the last handoff and the documents it has not seen | v3.59.0 | built |
| B10 | 2 | An agent saves a handoff before it stops; the save overwrites, so a missed one yields the previous state | v3.59.0 (advisory) | built |
| B11 | 2 | **A harness whose model never activates the skill saves nothing, and nothing says so** | v3.63.0 | **shipped, and the last clause first**: the meter names the sessions that did not save. The hooks that ask are written; **no harness has yet been measured with them installed** |
| B12 | 2 | Prove capture happened: sessions this week, by harness, saved / not saved | v3.63.0 (honesty meter) | **shipped**. Three states told apart — no log · a log with no session in the window · the reading — over a 30-day window |
| B13 | 2 | A non-Claude tool writes the format without any skill at all | v3.63.0 (public spec + a neutral `my-curator` command) | **the spec is published** and pinned to the live constants by a suite. The acceptance run — a writer built by somebody without this repository — **has not been done** |
| B14 | 2 | A session ends by compaction rather than by choice, and the handoff still lands | v3.63.0 (per-harness hooks, where one exists) | **partly**: the pre-compaction hook is written for the harnesses that have one, and the research settled that **Codex is the only harness whose pre-compaction hook can block**. Not measured on any of them |
| B15 | 2 | Two harnesses work one project in parallel and each needs to know what the other recorded | v3.65.0 (awareness digest) | planned |
| B16 | 2 | A decision that has stopped being volatile becomes canonical, on the owner's instruction | v3.65.0 (promote-to-foundation) | planned |
| B17 | 2 | A mirror has gone stale, or its checkout is not on this machine: the state is visible and Refresh is withheld with its reason | v3.59.0 / v3.60.0 | built |
| B18 | 2 | Their first minute tells them to get an API key the memory layer does not need | v3.62.0 | planned |
| B19 | 2 | Their unit of work is five clicks deep, below an "advanced" divider, in a view that cannot create it | v3.61.0 pointer · v3.62.0 rail order · **v3.64.0 the divider is gone and Context is one of three** | built |
| B20 | 2 | Plan a project in Chat with no repo and no agent, then save one answer as a canonical document | v3.65.0 | designed |
| B21 | 2 | A Chat conversation that starts from the project's canonical documents instead of a keyword search over them | v3.64.0 | built |
| B22 | 2 | Extend an existing mirror with a fifth document — Add and Refresh are not mutually exclusive | v3.61.0 | in flight |
| B23 | 2 | The domain's **own** project (which cannot be renamed or deleted) gets foundations like any other | v3.61.0 | in flight |
| B24 | 2 | The menu bar icon marks a project whose mirrored documents are behind their source | v3.60.0 | built |

**41 rows — 17 for audience 1, 24 for audience 2.** Two things the spine deliberately does not do:
it does not rank the audiences, and it does not promise that a `built` row is finished. K16 is
`built` software over rotted data, and B10 is `built` code whose behaviour is advisory.

---

## C. The releases, in order

### v3.61.0 — the start-a-project flow *(in flight: store and skills merged, views and routes pending)*

**Goal.** A user with existing architecture documents, a checkout full of them, or nothing but an
intention can start a project and get its canonical layer populated **without asking an agent to
paste documents one at a time**, which was the only way in before this release.

**Scope.**

| Feature | Notes |
|---|---|
| Ownership set once, at creation | `initFoundations(domain, project, {ownership, repoRoot?, files?, seed?})` in `src/brain/working-state.js`; refused once any manifest exists, even an empty one |
| Mirror a folder on this machine | A plain folder is a first-class source; `repo.lastRefreshCommit` is simply `null` when there is no git |
| A read-only repository scan that proposes and never decides | Three union rules, `.md`/`.txt`, role-word basenames, ADR-shaped folders; each candidate carries its first heading; over-cap files flagged rather than hidden |
| Four seeded skeletons | `src/brain/foundation-skeletons.js` — one source for the banner and the four documents, each ≤ 2 KB, prompts rather than invented facts |
| The owner's edit surface | Create / edit / delete a curator-owned document inside the Foundations fold, loading **raw** bytes (`?raw=1`), stamped `authoredBy: {kind: 'human'}` |
| The copyable drafting request | One sentence naming the project, `save_foundation` and the approval gate; composed from the project's real skeleton slugs, with the sha pin on the template |
| Every MCP tool exercised, in the suite and by an in-app run | The census stays at **24** tools ([mcp/tools/catalogue.js](../mcp/tools/catalogue.js)) |
| The two-door first-run card | *Build a second brain* / *Give your agents memory* — non-blocking, dismissible, setting the landing view and the step set |
| The cheap shell copy fixes | Chat's false `the default view` eyebrow; onboarding step 1's false "nothing works without a key"; the rail array; a `Create a project in Domains` pointer on the memory empty state; one pointer note on Ingest for `.md`/`.txt` |

**What it deliberately does NOT do.**

- **No stepped wizard for project creation.** The create form's home is the group's footer row —
  a measured decision from v3.48.1 — and a first-run modal was refused on the record (`views/onboarding.js`'s
  own header, decision R7). Two phases in one slot, no pips.
- **No full ingest-or-keep fork.** `views/ingest.js` is the money surface; the fork touches the
  confirm grid's decision column, the paid-primary logic and the estimator's suppression. One
  pointer note ships now; the fork is v3.62.0 with its own package.
- **No rename of "Agent memory".** The rename is decided and scheduled for v3.62.0, because
  `renderViewHeader` derives ⓘ panel ids from the title and two of them are hand-listed in
  `FOCUSABLE_IDS`; the pins, the docs anchors and the label have to move in one commit.
- **No LLM anywhere near tier 0.** No server-side drafting, no summarisation on the way in or out.
  The drafting model is the harness's, because the harness has the code and The Curator does not.
- **No 25th MCP tool and no new bridge capability.** [mcp/server.js](../mcp/server.js) declares
  `capabilities: { tools: {} }` — the copyable sentence is the harness-neutral floor.
- **No second create path.** The pointer navigates; it does not post.

**Acceptance, per scenario.** B1: a project created with each of the three arms; the third writes no
manifest. B2/B3: a scan of a git checkout and of an ordinary folder both mirror, and the second shows
the source path with no commit. B4: four skeletons, each with the visible banner, each ≤ 2 KB, from
one module. B5: the request copies, names the real slugs, and is withheld with its reason on a
repo-owned project. B6: a chosen file's bytes reach the editor unchanged; over 512 KB is refused
before any read; a slug colliding with a skeleton replaces it and says so. B7: the chooser reappears
at the Foundations block and nowhere else. B8: a raw round-trip through the textarea reproduces the
identical sha256. B22: Add and Refresh are both offered on a repo-owned project with documents.
B23: every new route is driven against the domain's **own** project, whose foundations land at
`state/foundations/` with no `<project>` segment. K6: the pointer note appears only for `.md`/`.txt`.
K15/B18: the two false statements are gone.

**Protected basics it must not regress.** Domains card order OVERVIEW → PAGES · THE WIKI → PROJECTS
→ WIKI HEALTH (`scripts/test-next-domain-card-order.js`); the page list's absence of a gate
(`scripts/test-next-domain-pages.js`); `HOME_VIEW`, `NAV_VIEWS` and the divider
(`scripts/test-next-shell-rail.js`); the ingest drop target never being replaced mid-drag
(`scripts/test-next-ingest-dropzone.js`); the free estimate staying free and staying before the
spend (`scripts/test-next-cost-honesty.js`); the app staying **read-only over tiers 2 and 3**
(`scripts/test-working-state.js`, `scripts/test-working-state-disclosure.js`); the memory view's
"No agent memory yet" branch, which exists so a four-domain user is not told to create a fifth
(`scripts/test-next-memory-view.js`); every block lede ≤ 13 visible words
(`scripts/test-next-settings-sections.js` §G3).

**Open questions carried out of it.** A second `repo.root` for a project whose conventions live in a
different checkout (§F D9). What a deleted **skeleton** means — an ordinary delete ships, fixed slots
would be a schema decision (§F D10). Whether the shared Markdown renderer should gain a blockquote
pass at all (§F D11).

---

### v3.62.0 — the shell for two audiences

**Goal.** The shell stops being designed for one audience. Audience 2 can find their unit of work,
and audience 1 loses nothing.

**Scope.**

| Feature | Notes |
|---|---|
| **Projects as a first-class rail view for audience 2** | Not a new view: the rail order becomes `chat · ingest · domains · memory · shared` so the per-session surface sits above the opt-in one, and the memory view gains the ability to host project creation |
| **Rename `Agent memory` → `Project context`, rail caption `Context`** | Decided. The view holds foundations (not memory, and not written by an agent when mirrored or owner-edited), the owner's brief, and genuine agent memory — two of four are the owner's. Eyebrow `your agents' brain` is untouched: the positioning is locked |
| **A home with two doors** | The first-run card's two doors become the app's front door rather than only its first minute. `HOME_VIEW` is `domains` today and "home" is a synonym for it; a real home view is a restructure with its own proof |
| **Where projects are created** | Extract the create panel to one shared module with a **single** `POST /api/memory/:domain/projects` call site inside it, hosted by the Domains group footer row **and** the memory view's empty state (with a domain `<select>` on the second host). The rule being honoured is this repo's own: a duplicated create *call site* is what v3.7.0 deleted |
| **The Ingest drop-zone fork: ingest-or-keep** | A segmented control in the confirm grid's **decision** column. Choosing *keep it word for word* removes the whole spend half — estimate, budget cap, the `✨` and the `.btn-ai` tint — because the arm spends nothing; the primary becomes `.btn-primary` and a project + role picker appears. A PDF is refused with the reason; over 512 KB is refused with both numbers named; N files are N adds with each outcome listed |
| **The rail-level ingest-finished badge** | The single biggest everyday defect for audience 1: the finished-ingest surfaces are Ingest-view-only, and the batch path has the identical hole. The machinery exists — the Sync pending badge's render/patch path is the shape to copy |
| **The reading plan — the owner routes tier 0** *(added by the maintainer on 2026-09-19; closes D19, ex-Q11)* | A per-document `readFirst` flag in the manifest (schema still `1`, additive); the bootstrap returns the **index always** and the **bodies of the read-first set**, with everything else fetched by name through a new `slugs` argument on `get_project_context` (**no twenty-fifth tool**); the flag is settable on **either ownership** through `PATCH …/foundations/:slug`, because it writes the manifest and never the document; the brief's template gains a **"Read before you…"** routing section; and a **fourth** byte-pinned instructions paragraph tells an agent that an index row with no text is a document to ask for, not one that is missing. Behaviour with nothing flagged is byte-identical to v3.61.1 |
| **The three-layer ⓘ** | One closed fold on the Domains OVERVIEW block teaching *accumulates / supersedes / replaced whole*. It closes a named v3.58.0 gap: three of the blocks audience 1 reads most cannot explain themselves |

**What it deliberately does NOT do.**

- **No persona or mode switch.** Argued down on four specific grounds, the first of which is
  decisive: the maintainer is both audiences. Nothing in the store models a persona, so the flag
  would live in one browser and diverge per machine — on a product whose whole thesis is that
  context travels between machines. And there is no clean cut: Domains hosts the wiki *and* the
  project list, Settings hosts the bridge *and* the model picker, one sync commit carries both.
- **No modal first run.** R7 stands; the two doors stay non-blocking, dismissible and always both
  visible.
- **No stored persona behind the doors.** The step set is **derived from facts on every load** — a
  stored choice goes stale the day the user does the other thing.
- **No second write path anywhere.** The shared create panel has one call site; the memory host is
  a second *host*, not a second route.
- **No change to how tier 0 syncs**, and the facts are worth restating here because the reading
  plan makes people ask about them again. Foundations live under `state/`, so they **do** sync —
  the copies travel to every machine, unlike `raw/`, which is gitignored. What does not travel is
  the ability to **refresh**: `repo.root` is advisory and machine-specific, so a machine without
  the checkout reads *source not on this computer* rather than *stale*, and the refresh control is
  withheld with that reason. **Remove** on a mirrored document deletes the copy and its manifest
  entry and nothing else — the file in your folder is untouched — because it is the decision to
  stop mirroring, not a claim about the document. Two machines editing one curator-owned document
  between syncs converge to **whichever saved last**, the `project.md` carve-out one tier down.
  **The piece that would remove the second of those is the GitHub mirror, and it is v3.63.0's**
  (below): sourcing from the repository rather than from one disk is what makes a refresh possible
  from any machine, and it is placed there rather than here because it is network-facing engine
  work — rate limits, PAT scope, eventual consistency — which is v3.63.0's register, not this
  release's.

**Acceptance, per scenario.** K5: an ingest finishing while the user is on Chat or Memory is visible
on the rail, and the batch path is covered by the same assertion. K6: choosing the verbatim arm
shows no estimate, no budget cap and no `.btn-ai` chrome, and a PDF is refused with the reason.
K17: the ⓘ is closed on first paint and holds the definition. B18: the agent door makes no
model-key claim and points at the MCP bridge; its done-ness comes from `GET /api/mcp/usage`
(harness-neutral) and **not** from the Claude-Desktop-config-only `installed` fact, which would
rebuild the never-completing-step defect for a Claude Code or Cursor user. B19: a project is
creatable from the memory view, through the shared module.

**Protected basics it must not regress.** Every row of audience 1's must-not-regress list is this
release's checklist, and four are load-bearing here specifically: Chat stays domain-scoped and
single-select with the live pages-in-scope readout (`scripts/test-next-chat-scopebar.js`); the
Shared Brain enable toggle stays on that view's own off-state and nowhere else
(`scripts/test-next-sharedbrain-ui-parity.js`); the Sync pending badge stays git-only in scope and
cheap (`scripts/test-next-sync-badge-invalidation.js`); Settings keeps General as its landing
section in frequency order (`scripts/test-next-settings-default-section.js`). Two named risks with
their mitigations: rewording onboarding step 1 could send a user past the key they will need for
Ingest and Chat — the sentence names *which* halves need one, in that order; and two extra steps
would give audience 1 a five-step panel with two irrelevant steps, which is today's defect
mirrored — hence deriving the step set rather than showing all five. Also: `STEP_ORDER` stops being
one constant and its pin becomes two ordered sets, and `FOCUSABLE_IDS`, four-ish suites and the
docs anchors move in the same commit as the rename.

**Open questions carried out of it.** Whether the two doors eventually deserve a real home view of
their own (§F D12). Whether the 568 px column arithmetic holds for the Foundations summary line
beside two head controls — nothing in the design pass was rendered (§F D13).

---

### v3.63.0 — capture guarantees

> **SHIPPED — and what shipped is the mechanism, not the measurement.** The command, the adapters,
> the public spec, the honesty meter and the GitHub mirror arm all landed. **Every harness row in
> the matrix reads *not measured*.** The protocol that would change one is fixed and written down
> (`scripts/measure-harness.js`'s header *is* the protocol: arms A/B/C, N=4, one task that never
> mentions saving, an isolated fixture), and until it has been run against a real harness nothing in
> the product or the docs describes a hook as working. Three corrections the build made to the scope
> below, each because the code or the research said otherwise:
>
> - **The research doubled this release's adapter work.** The premise was that lifecycle hooks are
>   rare. **Ten of thirteen harnesses have one**, they disagree on the event, the file, the format
>   and the response shape, and **three accept a hook that never fires**. So `hooks.state` is four
>   words rather than a boolean (`verified` · `unverified` · `present-useless` · `none`), and
>   `install-hooks` has to be able to **refuse** and still be useful.
> - **The capture point is the TURN END, not the session end.** Codex's `SessionEnd` caps at 3 s and
>   Gemini CLI's and Cursor's are fire-and-forget: on three harnesses a session-end hook physically
>   cannot complete a save. No `SessionEnd` hook is installed anywhere.
> - **The meter could not be built from the shipped log**, which checklist item 5 below asked to be
>   confirmed rather than assumed. It could not: the line had no session id and no project. The
>   session id was unavoidable; the **project** field is a real content widening, from one
>   user-chosen slug to two, and it was taken deliberately rather than quietly — a per-project page
>   showing a figure aggregated over a whole domain would have been a false reading on the one
>   screen built to prevent those. The line ceiling moved 200 → 300 bytes to pay for both, with the
>   arithmetic re-derived rather than re-measured.
> - **The binary is `my-curator`, not `curator`.** Elastic's `elasticsearch-curator` is ≈57k
>   downloads a week and owns `/usr/bin/curator` on Debian; npm's `config-curator` ships a `curator`
>   bin too. The short name is an opt-in alias that **refuses to install when it is shadowed**.

**Goal.** Close the gap between *the store can hold a handoff* and *a handoff is there tomorrow*.
This is the release the whole layer's value depends on, because a read path with no write discipline
returns an empty store confidently.

**Scope.**

| Feature | Notes |
|---|---|
| **A neutral `curator` command, with per-harness adapters** | One entry point a harness's own configuration can invoke, so saving does not depend on a model deciding to reach for a skill. The adapters are thin and named per harness; the command is the contract |
| **Hooks where a harness exposes session-end or compaction** | Research first, per harness: some expose a session-end or pre-compaction hook and some do not. Where one exists the save is wired to it; where none exists that is stated, not worked around |
| **A public working-state spec** | The on-disk format published so **any** tool can write it — the store's shape is already plain markdown plus append-only JSONL, and the spec makes that a contract instead of an implementation detail. A third-party writer needs the layout, the section vocabulary, the machine-segment rule and the budgets |
| **An honesty meter, per project** | Sessions this week, grouped by harness, **saved / not saved**. The one question the memory layer exists for is *did this session start with the bootstrap and save before it stopped*, and the app should answer it without the owner reading a file. The content-free MCP usage log (v3.60.0, `src/brain/mcp-usage.js`, `GET /api/mcp/usage`) is the existing seam: it already records one line per tool call — tool, domain, outcome, duration, and nothing else |
| **The live harness matrix** | Claude Code, Codex, Cursor and Gemini CLI, each measured for **reads** and for **unprompted saves**, published as a verified-in table with the date, the sample size and the arms |
| **Mirror from a GitHub repository — a third ownership arm** | Sources foundations from a GitHub repo over the API instead of a local checkout, **as shipped, using a SEPARATE read-only token by default** — `githubReadToken` in `.curator-config.json`, fine-grained and scoped to the source repository — with Personal Sync's own token available only when explicitly named, because a classic sync token can read every repository the user owns and that permission was granted for something else; populates `repo.remote` — a manifest field that already exists in [src/brain/working-state.js](../src/brain/working-state.js) but today is only ever carried through or defaulted to `null`, never actively written; refreshes by blob sha. The Shared Brain adapter already speaks the shape this needs — [src/brain/sharedbrain-github-adapter.js](../src/brain/sharedbrain-github-adapter.js) does `GET`/`PUT`/`DELETE …/contents/:path` and `GET …/git/trees/:branch?recursive=1` — so this arm reuses a proven client rather than inventing one. Its value, stated honestly: it removes the "source not on this computer" state for any machine that can reach the remote. Its costs, stated honestly: network and rate limits, the PAT's scope (Personal Sync's token was never asked to cover an arbitrary foundations-source repo), and the eventual consistency the Shared Brain adapter already argues around (never read-after-write against GitHub's contents API on a correctness path). Placed here rather than in v3.62.0 because it is network-facing engine work — reliability, rate limits, honest disclosure of what a machine can and cannot reach — which is v3.63.0's register; v3.62.0's scope is shell and rail only, with no backend addition |

**What it deliberately does NOT do.**

- **It does not make capture mandatory.** Capture stays advisory and the fail-safe direction is
  unchanged: a missed save yields the **previous** state, never a corrupted one. That is the whole
  reason no enforcement exists, and a guarantee that could lose a handoff would be worse than the
  gap it closed.
- **It does not replace a harness's own memory features.** See §E.
- **It does not publish an unmeasured claim.** A harness with no measurement appears in the matrix
  as *not measured*, with what would have to be run to change that. The standing commitment is
  explicit: the Agent Skills standard existing does not mean a given host implements it.
- **It does not extend the honesty meter beyond what the usage log records.** The log is
  content-free on purpose — no argument, no result, no path, no error text — and a meter that needed
  more than that would need a different log and a fresh privacy decision.

**Acceptance, per scenario.** B11: on a harness the matrix records as never self-activating, the
neutral command path produces a save without the model having chosen to. B12: a project's meter
distinguishes *no session ran* from *a session ran and did not save*, and a project with no bridge
traffic at all reads as such rather than as a failure. B13: a writer built only from the published
spec produces a handoff the store reads back with no repair step. B14: on a harness with a
session-end or compaction hook, an ended-by-compaction session lands a handoff; on one without,
the matrix says so.

**Protected basics it must not regress.** The `<machine>` path segment stays
`<hostname-slug>-<install-id>` and is not collapsed — it is what makes `pull -X theirs` safe on
tiers 2–3. A save stays **complete, not a delta**, and stays idempotent. An over-budget save is
**trimmed and disclosed**, never refused, because an agent near its context limit whose handoff is
rejected loses it entirely. The app stays read-only over tiers 2 and 3
(`scripts/test-working-state-disclosure.js`, whose dominant defect class is a consumer silently
dropping a field the store honestly computed). The usage log stays content-free and outside
`domains/` so it can never sync (`scripts/test-mcp-usage.js`). And the two skills stay **one
source** with the neutral form derived, never a second hand-maintained copy — these files are read
by models, so two copies would instruct two agents differently.

**Open questions carried out of it.** Whether the honesty meter's "session" is a bridge session or
a harness session, and whether the two can be told apart from a content-free log (§F D14). Whether
the neutral command ships as part of this repository or beside it (§F D15).

---

### v3.64.0 — the shell for two audiences, the docs and the website *(built — 2026-09-20)*

**Status: built.** This section was written on 2026-09-19 as a plan and is kept below as the
record of what was decided. What follows first is what **shipped**, with numbers, and what moved
to v3.65.0. The plan's own wording after this block is unedited except where a decision was taken
differently — those are named here, not silently rewritten.

**What shipped.**

| | Shipped | The number that says so |
|---|---|---|
| **(a)** | Positioning: *"The Curator — the context engine"* above the unchanged tagline. "Engine" replaces the old noun in every product claim | Zero occurrences of the retired noun in `README.md`, `docs/**` and `public-knowledge/**`; the two surviving occurrences are historical `v3.59.0` changelog rows, kept byte-for-byte |
| **(b)** | The rail is **three** entries — Chat · Domains · Context — with **no divider**. `HOSTED_VIEWS` keeps `ingest` and `shared` registered, navigable and restorable | `NAV_VIEWS.length === 3`, `RAIL_DIVIDER_AFTER === null`, `ALL_VIEWS` still set-equal to `Object.keys(VIEW_META)` (7) |
| **(c)** | The domain page hosts **six** sections. INGEST and SHARED BRAIN are closed folds, remembered per domain, and each is one panel with two hosts rather than a copy | No function in `views/ingest.js` or `views/shared.js` renamed or moved; the two unowned tripwire suites green, untouched |
| **(d)** | Chat reads one project in-process, within its own **40,000-character** budget, on top of the wiki's unchanged 60,000 / 12,000 / 50 | Nine sha256 digests of the pre-v3.64.0 prompt reproduced exactly with no project pinned |
| **(e)** | First run unchanged, with the knowledge door's third step now opening the INGEST section rather than a rail entry that no longer exists | `requestDomainFold` / `ADD_SOURCES_FOLD`, the third self-clearing shell handoff |
| **(f)** | The docs spine — a regrouped table of contents, a routing table in chapter 1, and a new chapter for the three places | **Exactly one** `## ` heading added to `docs/user-guide.md` (`7b`); zero removed, zero renumbered |
| **(i)** | **The measurement campaign ran.** Claude Code, 2026-09-20, three arms, N = 4 | Below |

**Measured in the browser, on the domain page.** Page height at 1370 px: **1,821 px** with both
new folds closed, **2,288 px** open. Horizontal overflow at 568 px: **0**. A drag held over the
INGEST zone through a health revalidation: **149 events, the same drop-target node throughout** —
which is D-J's acceptance, taken rather than argued. Contrast on the new surfaces, lowest **5.60**
light / **6.16** dark against a 4.5 floor. One figure did **not** reproduce: v3.57.0's *one*
`#view-root` child replaced on a cached domain switch measured **3–4** here, and measured 3–4 on
`main` as well — so it is this harness disagreeing with that one, not a regression this release
introduced. Recorded rather than smoothed over; re-deriving the v3.57.0 baseline is v3.65.0's.

**(i), as run.** Claude Code CLI 2.1.275, headless `-p`, `claude-haiku-4-5-20251001`, API-key auth,
one neutral task per run that never mentioned saving or The Curator, on a throwaway fixture project
in the real store. Verdict words, from the instrument's own output:

| Arm | Sessions | Read at start | Saved before stopping | Verdict |
|---|---|---|---|---|
| **C** — skill + block + hooks | 4 | 1 via a tool call, **4 via the `SessionStart` hook** | 4 | `measured-partial` |
| **B** — skill + block, no hooks | 0 | 0 | 0 | `not-measured` |
| **A** — skill only | 1 | 1 | 1 | `measured-partial` |

**Two limits of the instrument, named so the counts are not over-read.** (1) A bridge process that
never receives a real tool call writes **no session line at all**, so arm B's zero means *no session
ever started*, not *four sessions started and failed to save* — and a failed attempt is
indistinguishable from silence. (2) Arm C's hook-injected read happens **before** the MCP servers
are reachable, so it is not a tool call the usage log can record; `measured-partial` is correct by
the script's read-tool-only definition and is a different claim from *"3 of 4 ignored their state"*.
The first limit is partly closed in this release: the session line now rides the client's own
identification rather than the first tool call.

**The finding nobody predicted.** Without the `SessionStart` hook, in **5 of 6** save attempts
across arms B and A the agent found `save_working_state` by name and then ran something shaped like
a shell command named after it — a fabricated `mcp call …`, a shell function wrapping the tool's
own name, a JSON payload written to a file and never sent — instead of issuing the call. The skill
and the instruction block were present in every one of those runs. The hook is what works.
`Stop` hooks **never fired** in headless `-p` mode, across all six arm-C sessions; `PreCompact` did
fire under `-p --resume`, leaving only an embedded standard-output line as evidence.

**Codex, Cursor and Gemini CLI remain `not measured`**, and every one of the thirteen other rows in
the adapter table still reads `null`.

**Decided differently from the plan below.** Two items:

- **The `## Read before you…` demotion named in (f) was not made, and should not be.** Both
  occurrences — `docs/user-guide.md` and `docs/working-state.md` — sit **inside fenced code
  blocks**: they are examples of what a standing brief looks like, and the store writes that
  section at `##`. Demoting them would falsify the example. The heading census counts them only
  because its scanner is fence-unaware, which is a property of the scanner recorded in the same
  design pass.
- **The `memory.knowledge` docs-links key was not added.** The key lives in
  `src/public/next/shared/docs-links.js` and would need a view to render it; neither file belongs
  to the docs package. Carried to v3.65.0. The table stays at **eighteen** keys.

**What moved to v3.65.0**, unchanged from the table further down this section: the **Home
dashboard**, Chat's **Save as foundation**, the **cross-scope digest**, **promote-to-foundation**,
a **25th MCP tool** for the skeletons, the **ingest auto-split at headings**, and the
**ingest-finished badge** — which now belongs on the Domains rail entry, there being no Ingest
entry left to badge. One item joined them during the build: the **page-level drop
forward** — a file dropped anywhere on the domain page being handed to the INGEST section — which
needs one more export from `views/ingest.js` and was not worth widening that seam for in the
release that created it. Today a drop outside the section is **refused rather than opened**, which
is the safe half and was never in doubt.

**Still open for the maintainer.** The npm package name (`the-curator` vs `my-curator`); the
licence on `github-read-client.js`; `COPY_SUCCESS_BANNER` naming harnesses this build cannot
reach; whether two machine ids on one computer should be reconciled or left as they are; and
whether the website's second animation is worth its budget. See §F.

---

#### The plan, as written on 2026-09-19

**Recorded into this roadmap 2026-09-19**, the day after v3.63.0's tag, from two same-day read-only
design passes — one over the app shell (the rail, the domain page, Chat), one over the website and
the documentation narrative — taken against `main` = `d10b27f` = tag **v3.63.0**. Neither pass
edited code; this section records what they decided, not what has shipped. **The three-entry rail
was "designed, not scheduled" as recently as the day this pass started** (the website design pass's
own premise-check found no scheduled release for it); the maintainer scheduled it here, at v3.64.0,
which is what makes this section possible to write with one release number rather than two.

**Goal.** Two goals, inward and outward, shipped together because the outward half's design pass
concluded the two cannot be split cleanly (see (g)). Inward: the shell stops being drawn for one
audience — three rail entries instead of five, Ingest and Shared Brain re-hosted (never removed) as
sections of the domain page they already describe, and Chat can read a project's canonical context
in addition to the wiki it already retrieves from. Outward: the website and the documentation stop
describing an app three-plus releases behind, the retired noun — "context machine" — goes everywhere it is a product
claim, and neither surface may say more about agent capture than v3.63.0's instrument has actually
measured.

**(a) Positioning.** The category line **"The Curator — the context engine"** sits above the
unchanged tagline, **"Your brain. Your team's brain. Your agents' brain."** — neither the tagline
nor the positioning it expresses is up for revision here. "Engine" replaces "machine" everywhere it
is a product claim, in both repositories, in one landing (§F **D20**). One exemption survives in the
app repo: `CLAUDE.md`'s frozen `v3.59.0` changelog row, which this repository keeps byte-for-byte and
never rewrites — a changelog row is evidence of what was said at the time. **This roadmap's own prior
exemption (its audience-2 table cell, quoting what audience 2 came for) is withdrawn by the
maintainer's instruction that produced this section** — see the retirement above in §A. The
one-paragraph description, quoted verbatim from the design pass:

> A local app that turns what you read into a compounding wiki, shares it with a cohort, and holds
> your projects' context — foundations, working state, knowledge — so any agent, in any harness,
> resumes where the last one stopped. Plain markdown, in your own repo.

This paragraph lives in the meta description, the JSON-LD and `llms.txt` — never on the page itself,
where the hero stays a headline and at most two short lines (hard cap 30 words). The site's
`featureList` gains one clause for the `my-curator` command and one for the capture meter, and drops
one release note that was never a feature.

**(b) The rail.** `NAV_VIEWS` becomes three entries — **Chat · Domains · Context**, read as *ask ·
knowledge · context* (§F **D21**) — with no divider (`RAIL_DIVIDER_AFTER = null`): the divider's
existing meaning is *"advanced, not for everyone"*, which contradicts a shell built for two
first-class audiences. **Home stays `domains`** (§F **D22**); the logo/Home redundancy this creates
is accepted, not fixed, and is left for the v3.65.0 Home dashboard to resolve. Ingest and Shared
Brain leave the rail but not the app: a new `HOSTED_VIEWS = ['ingest', 'shared']` array widens
`ALL_VIEWS` so both view ids stay registered, restorable from the stored `curator-next-view` last-
view key, and navigable by name; `VIEW_META` keeps both entries in full (captions, titles, icons)
because other surfaces still read them — a mount-error card, and a model-read MCP refusal string
keyed to `VIEW_META.shared.caption`.

*What the design pass found about the tray.* No view id and no URL crosses the Electron main/
renderer process boundary — the tray's only two live couplings to the shell are
`document.querySelector('[data-view="memory"]')` and the `settings` equivalent, driven by
`executeJavaScript` clicks through the DOM, never a deep link or a query string. So the tray was
never the reason `ingest`/`shared` had to keep a rail button; the real reasons are three others that
genuinely are: the Sync view's "Open Shared Brain" button (`navigate('shared')`), the knowledge
door's third onboarding step, and the stored last-view key, which a user who quit on Ingest or
Shared Brain depends on. `navigate()`'s own gate is the view **registry**, not the rail array, and an
unknown name is a silent no-op with no warning — precisely why `HOSTED_VIEWS` keeps both ids
registered rather than merely dropping them from `NAV_VIEWS`.

*What the design pass found about Shared Brain.* The enable toggle is an **install-level** fact
(`GET /api/sharedbrain/feature-flag`; `#btn-sb-enable` POSTs `/api/sharedbrain/enable-flag`), not a
per-domain one, and the standing invariant is *"one control, one place, and nowhere else"* — pinned
by a suite that asserts the Settings view mentions no Shared Brain at all. Rendering that off-state
on N domain pages would put the one control in N places, the literal negation of the invariant, so
**the toggle does not move** (§F **D23**): it stays on the Shared Brain view's own off-state, and a
domain page's SHARED BRAIN section, when the flag is off, renders one line and a door — *"Shared
Brain is off on this install."* plus "Open Shared Brain" — never a second off-state. A connection is
not one-to-one with a domain in either direction (one connection carries an array of contributing
domains, and separately a derived, never-stored, mirror domain), so the section needs a lens the code
does not have today: a domain page belongs to a connection when it contributes to it, or when it
*is* that connection's mirror.

**(c) The domain page's section order and the re-hosting rule.** Six sections, in order: OVERVIEW ·
**ADD SOURCES** (was the Ingest view, a closed fold) · PAGES · THE WIKI · PROJECTS IN THIS DOMAIN ·
**SHARED BRAIN** (was the Shared Brain view, lensed to this domain, a closed fold) · WIKI HEALTH. ADD
SOURCES sits above the wiki because it is how the wiki gets its contents, continuing the v3.49.0
ordering argument that a page states first what a domain *holds*; SHARED BRAIN sits between PROJECTS
and WIKI HEALTH because it is a fact *about* the domain, like Projects, and stays above the
maintenance report for the same reason Projects does. Neither insertion touches the one adjacency a
page-order suite pins today — the eyebrow immediately preceding its own browse list. On a `shared-*`
mirror domain there is **no ADD SOURCES section at all** (ingest already refuses mirrors as
destinations) — absent, never merely disabled — and the Shared Brain section becomes one read-only
strip naming the connection and its last synthesis.

The re-hosting rule (§F **D24**): **one panel, two hosts, and the seam is additive.**
`views/ingest.js` keeps its full-page view registration and gains a small set of exported entry
points (a mount function, an unmount function, a busy predicate) that the domain page calls as a
section host; `views/shared.js` gains the same shape. **No function moves file, and no function is
renamed** — several existing suites cut named functions out of both files by brace-matching their
own source, so a "tidy while moving" refactor does not fail softly on this seam, it throws. Two of
those suites are owned by nobody in this release and serve as the tripwire: if the seam stays
additive, both stay green, untouched.

Page length is managed by folds and jump controls, never by cutting: both new sections are closed on
first paint, remembered per domain, and the OVERVIEW stat tiles double as jump-and-open controls,
gaining two new tiles (SOURCES, and — when a connection exists — SHARED).

*The drop-zone hazard, ranked the release's highest risk.* v3.46.0's real defect, in this exact code:
`dragover` fired continuously, the first one triggered a re-render, and the drop target was destroyed
mid-drag — drag-and-drop simply did not work in the Mac app. The fix living inside `views/ingest.js`
is *"while a drag is in progress this view mutates, it never re-renders."* Hosting that drop zone
inside a page with its own stale-while-revalidate cycle puts a second, unrelated re-render source
above that rule. So while a hosted panel reports itself busy, the domain page's re-render **patches
instead of replacing** `#view-root`'s children. This is the one obligation in this release that
**cannot be verified offline** — no sandbox reproduces a destroyed node identity under a real drag —
and it is required, mandatory work, not a confirmation: measured in a real browser, with the drop
target proven to be the same node object before and after a drag held while a health revalidation
returns.

A mandatory browser re-measurement set, five items: the existing no-repaint figures still hold on a
cached switch; the domain page's length at 1370 px and 568 px, both fold states, overflow required to
be 0; the drag-hazard proof above; a live ingest batch survives a visit to WIKI HEALTH and back with
its SSE stream re-attached; contrast on every new surface, both themes, against the 4.5 floor.

**(d) Chat with a project.** A **project pill** joins the scope bar as a second group — eyebrow
PROJECT, one listbox pill, and, when the project has more than one work-stream, a smaller scope pill
defaulting to `latest` — to the left of the existing domain scope group, which stays first and stays
the one selector that decides which wiki pages are in scope. Persisted **per device** in
`localStorage`, not per conversation (which reopens the question this file's D16 answered the other
way — see §F **Q17**).

The **second retrieval source over `state/`**: with a project pinned, `src/brain/chat.js` calls
`getProjectContext(domain, project, {scope, include: 'changed', maxBytes:
PROJECT_CONTEXT_BUDGET_CHARS})` from `src/brain/working-state.js` **in-process** — no new HTTP route,
no second assembly of the bootstrap. (There was never an HTTP route serving this shape: the app's own
surface reaches the same store through a differently-shaped `GET /api/memory/:domain/:project`, and
the MCP tool is the only existing caller of `getProjectContext`.) A new
**`PROJECT_CONTEXT_BUDGET_CHARS = 40,000`** constant sits beside, and is additive to, the existing
wiki budgets (`CONTENT_BUDGET_CHARS = 60,000`, `CATALOGUE_BUDGET_CHARS = 12,000`) — smaller than the
MCP bootstrap's 120 KB default because one chat turn already carries 60 KB of wiki, a catalogue and
conversation history. Both budgets are stated to the user under the composer, and every omission
`getProjectContext` discloses reaches the user as a line, never a stderr entry. The wiki-only path is
byte-identical when no project is pinned.

What is read, and in what order, mirrors the MCP bootstrap's own selection rule and its own
serialisation order — the content-is-data framing first, the standing brief with its authority note
first inside it, then the latest handoff, then read-first foundations in reading order, then other
foundations by keyword match against the same query context the wiki retrieval already builds. The
reason for reusing the order, not just the strings: that order is commented as load-bearing where the
MCP composes it, and a second, differently-ordered rendering of the same content is a second thing
that has to stay true. **The framing extraction** (part of package (h) below) moves those constants
down into a new `src/brain/context-framing.js`, byte-identical, so `src/brain/chat.js` can build the
same injection defence without `src/brain/` ever importing from `mcp/` — the dependency runs the
other way, and always has.

**Chat never writes to state (§F D25).** The app stays read-only over tiers 2 and 3 by standing
invariant, and tier 0 stays writable only through the owner's own edit or a commissioned
`save_foundation`. Chat-reads-a-project needs none of that. **"Save as foundation" — a write surface
with its own approval flow and its own editor — is explicitly NOT in this release**: a rail change,
two re-hosts and a retrieval change is already the most one release can carry and still be verified
in a single browser pass. It lands in v3.65.0 beside the Home dashboard, where the editor it opens
into is already the subject (see the renamed v3.65.0 section below).

A project pinned in Chat that is then deleted answers a **400 with a named reason before the stream
opens** — never a silently wiki-only answer.

**(e) First run.** The two doors (`DOORS`/`STEP_SETS`) are unchanged — both already land on
`domains` and `memory`, both of which survive the three-entry rail unchanged. Two small edits: the
knowledge door's third step keeps the view id `ingest` in its target table (so the mapping change is
a suite change, never a silent one) but its **navigation** becomes "Open Domains", landing on the ADD
SOURCES fold; and the Context view's empty state gains one sentence naming who the layer is for —
work that outlives one session: a book, a research programme, a codebase — because a reader with no
agents now sees a rail button called *Context* with no rail caption to explain it (captions are one
word; the rail cannot carry prose).

**(f) The docs narrative.** **README** front door: the front-door sentence naming what The Curator
is becomes "the context engine," and the centred website line above Quick Start gains the category line
and the tagline as a two-line centred block above it; a new `### Two audiences` subsection sits under
the existing three-kinds table, naming both audiences in the same two rows the website's routing
section carries, so the two never say different things. **User guide chapter 1** gains a closing
routing table (four rows) sending each audience to its first chapter, and the guide's **table of
contents is regrouped** under three captions — ASK (chapters 1–7), KNOWLEDGE (8–13, 17), CONTEXT
(13b, 13c, 15, 15b), REFERENCE (14, 16, 16b, 18–21) — **with NO chapter renumbered** (§F **D26**). A
census across both repositories found **33 distinct `user-guide.md` anchors** referenced from the
website alone and 69 from the app repo, 11 of them pinned `DOCS_LINKS` keys a suite fails on if they
move, plus a second, independently hand-maintained anchor table in
`public-knowledge/curator-links.md` — renumbering even one chapter would therefore not be a
documentation edit, it would be a breaking change to four consumers, two of them outside this
repository. The one heading that does move is the file's single un-numbered `## Read before you…`
heading, which breaks the numbered grammar every other chapter follows: it is demoted to a `###`
inside chapter 13b, where it already lives topically, after confirming nothing links to its anchor.
**`docs/product-overview.md`** gets four surgical edits (its version line, the positioning paragraph,
the three-write-rules wording aligned with the other three files that carry it, and a "where it
stands" update naming v3.62.0/v3.63.0 under the same honest-reach language as (i)) rather than the
full reconciliation an eighteen-release-stale, 18,203-word file actually needs — that reconciliation
is carried forward as its own open question (§F **Q26**). **The Lumina set**
(`public-knowledge/curator-*.md`) gains the noun change and two new topics in `curator-overview.md`
only — *"which of the two things is it for me"* and *"do my agents actually save, and how would I
know"* — per the set's own rule that a fact lives in exactly one file; `curator-agent-memory.md`'s
one non-question heading is renamed to match the set's own convention. The set has room: even before
these additions it sits at roughly half of its ~95,000-token design target.

**(g) The website.** The home page grows from 10 sections to **13**: three new sections (`ways`,
`context`, `bridge`) are inserted, none is deleted, and `install` moves down one slot so the routing
section reads first.

| # | `data-section` | Headline | Status |
|---|---|---|---|
| 01 | `ask` | Your brain. Your team's brain. Your agents' brain. | hero rewritten to two lines |
| 02 | `ways` | Two ways in. The same files underneath. | **new** — routes the two audiences |
| 03 | `install` | Install in the way that fits your machine. | moved down one slot, unchanged |
| 04 | `brains` | The same markdown files serve you, your team and your agents. | cards rewritten to equal length |
| 05 | `context` | The context a project runs on, carried between sessions. | **new** + a second animation |
| 06 | `how` | Two short paths through the same files. | rewritten — two four-step paths, not eight cards |
| 07 | `bridge` | One bridge, two front doors. | **new** — the 24 MCP tools, the CLI, the honesty statement |
| 08 | `app` | Same app on the Mac and in the browser. | lede corrected now (W1); rail lede + screenshots wait for W2 |
| 09–13 | `widget` · `files` · `compounding` · `people` · `star` | unchanged | eyebrow numerals only |

**The word budgets, before → after, quoted from the design pass:**

| Family | Row | Budget per card | Ratio cap | Before | After |
|---|---|---|---|---|---|
| Hero body | §01 | 30 words total, ≤ 2 lines | — | 60 (one paragraph) | **24** |
| Section lede | all | 26 words, 1–2 sentences | — | 62 (two ledes on one section) | **≤ 26** |
| Two-ways card | §02 | 24–34 | 1.35× | — | 30 · 32 → **1.07×** |
| Kind-of-context card | §04 | 18–26 | 1.35× | 21 · 21 · 36 → 1.71× | 21 · 21 · 20 → **1.05×** |
| Brain card | §04 | 30–40, one paragraph | 1.35× | 43 · 30 · 133 → 4.43× | 34 · 30 · 36 → **1.20×** |
| Context block | §05 | 20–28 | 1.35× | — | 27 · 25 · 22 → **1.23×** |
| How-it-works step | §06 | 14–20 | 1.35× | 16·25·16·17·20·19·18·45 → 2.81× | 16·16·15·19·17·17·17·18 → **1.27×** |
| Bridge card | §07 | 24–32 | 1.35× | — | 30 · 32 · 27 → **1.19×** |

**The 1.35× copy-budget rule (§F D28):** a row of peer cards may vary by at most 1.35× in word count
(measured over the card's body text, after stripping tags), and no card carries more than one
paragraph. 1.35 is not arbitrary — it is the ratio the site's already-good rows already sit under.
Enforced by a script, `site/scripts/check-copy-budget.mjs`, shipped with a planted-defect control
that must fail (re-inflate one card and require red) — never by review alone, because the defect this
rule exists to catch (a hero paragraph at 60 words beside neighbours at 21 and 30; a brain-card row
spread 4.43×) survived every prior release's review.

**The second animation, `buildContextLoop()`.** The existing knowledge-path animation
(`buildPipeline`, ~3.4 KB) is kept, unmoved; one label changes, `AGENTS VIA MCP` →
`AGENTS · MCP + CLI`, because the CLI is now a second front door. A **second, new** animation draws
the context layer as a **cycle** — foundations feeding two sessions in two different harnesses, each
session's handoff *replaced whole*, the next session reading it — rather than as a fourth output box
on the existing knowledge-flow graphic. A fourth output box would say "agents are a fourth reader of
the wiki," which is precisely the pre-context-engine story the positioning retires. Six frames over a
10-second cycle, budgeted at ≤ 3,600 bytes (hard ceiling 4,000; over it, the counter frame is dropped
and the cut reported, never the code compressed).

**The reduced-motion fix.** All seven of the site's SMIL-based graphics (six existing plus the new
one) keep animating today for a visitor who asked for none — the existing reduced-motion CSS block
cannot reach `<animate>` elements, which are not CSS animations, and no pause mechanism exists
anywhere in the site. The fix is one helper (pausing every `<svg>` root at a chosen rest frame) called
at mount and again on the media query's own change event, verified per graphic as a number (paused
state and current time) rather than "looks static."

**W1 ships now; W2 waits for the release that tags the three-entry rail (§F D27).** The website lands
in two parts, split at the dependency rather than at a version number, because the website design
pass's own premise-check found the rail *"designed, not scheduled"* the same day the maintainer
scheduled it here — closing that gap is what makes a single release number possible for the copy that
depends on it. **W1 — the catch-up** describes the app as it is at v3.63.0 (the noun, the hero, the
card budgets, the two-ways-in section, the context section and its animation, the two how-it-works
paths, the bridge section, the corrected five-view rail lede, the version strings, the Lumina
re-copy) and may land as soon as it is verified, independent of whether this release has shipped yet.
**W2 — the shell** (the three-entry rail lede, three re-taken screenshots, the site-map's new rows)
lands only after this release's own Tests workflow is green. A site that advertises a rail nobody can
see yet is exactly the same defect as a site that claims a harness nobody has measured — this file's
§F **D20** carries the noun, and (i) below carries the reach discipline the sentence borrows from.

**The Lumina copies have already drifted.** `site/lumina-knowledge/curator-*.md` are documented as
byte-identical reproducibility copies of `public-knowledge/*.md`; a diff taken during the design pass
found all four differ, because the site's copy sits at v3.60.0 while the app's is at v3.63.0. The fix
is a `cp` plus a `shasum -a 256`-verified copy on both sides, never an in-place edit, and the
maintainer's manual re-upload to Lumina is carried in the release report as an unchecked box — no
builder can perform it.

**(h) Packages and landing order across both repos, the two seams.** In the app repo, ten packages:
**A** the rail · **B** the Ingest host seam · **C** the Shared Brain host seam · **D** the domain page
· **K** the framing extraction · **L** Chat reads a project · **G** desktop/tray strings ·
**E** docs + public knowledge · **M** the measurement campaign · **X** release. Landing order: **K**
and **A** first, independent of the host seams; **B** and **C** before **D** (which imports the
signatures **B**/**C** fix); **D** and **G** feed **E**, which reads every other package's report;
**M** runs first in wall-clock time and gates nothing in the tree. In the website repository, five
packages: **A** the noun (spans both repositories, in two commits, and lands first, alone) ·
**W1** the site's sections and copy · **N** the animations (parallel with **W1**) · **W2** the shell
(gated on the rail) · **D** the app-side docs (rides the app release) · **W-verify** the two new
guards (after **W1** and **N**). **A file appears in exactly one package's ownership row** on either
side; a builder who needs a file it does not own reports it rather than editing it. Two seams the
orchestrator resolves at merge, never a builder: the `OFFLINE` suite-array tail in
`scripts/run-tests.js` gains two entries (a domain-sections suite, a chat-project-context suite), and
`CONTRIBUTING.md`'s checked (not hand-maintained) suite-count line moves by two.

**(i) The measurement campaign — this release's first job, regardless.** v3.63.0 shipped the
instrument (`scripts/measure-harness.js`) and every `measured` field in
`src/brain/harness-adapters.js` still reads `null`. Nothing in the product or the docs may describe a
hook as working until a verdict word exists, and this campaign runs **before** anything else in this
release that touches copy claiming reach. Three arms — **A** skill only · **B** skill + instructions
block · **C** skill + block + adapter hooks (what v3.63.0 built) — N = 4 neutral runs per arm per
harness, one fixed task on a throwaway fixture project that never mentions saving, ending naturally,
plus one compaction-ending variant for arm C. Against the real install, not the test-isolation
environment — the point is to measure what a real harness actually does. Start with Claude Code, then
`my-curator doctor` to see which of the others are actually wired on this machine before assuming any
of them are. Only after a run produces a verdict word (`not-measured` / `measured-no` /
`measured-partial` / `measured-yes`) may the adapter table, `doctor.js`, or any doc's "not measured"
language move — never from inference, and never in advance of a run.

**What it deliberately does NOT do.**

| Item | Where it goes instead | Why |
|---|---|---|
| The Home dashboard — every project's three-layer strip, capture and freshness | **v3.65.0** | The maintainer's decision; it is also the only thing that resolves the logo/Domains redundancy (d), so the two land together rather than the redundancy being papered over twice |
| Chat "Save as foundation" (B20) | **v3.65.0**, beside the Home dashboard | It is a **write** surface into tier 0 with an owner-approval flow; this release already carries a rail change, two re-hosts and a retrieval change |
| The cross-scope digest (B15) | **v3.65.0** | It is a change to `getProjectContext`'s envelope, which package L reads here; changing a contract and its first new consumer in one release means neither can be the control for the other |
| Promote-to-foundation (B16) | **v3.65.0**, with "Save as foundation" | Same editor, same approval flow, same suite — two gestures, one design |
| An MCP read tool for the skeletons (a 25th tool) | **v3.65.0 or later** | A tool-count decision — the catalogue, the usage-log driver and the Tool map must move in the same commit, and nothing here touches `mcp/tools/index.js` |
| The MCP `prompts` capability | Unscheduled | Client support is uneven; the copyable sentence remains the harness-neutral floor |
| The Ingest drop-zone fork (ingest-or-keep) | **v3.65.0** | It is a *feature* in the confirm grid, independent of the re-host; landing it here would make the section's first version its second design |
| The ingest auto-split at headings (Q8, this file) | **Still proposed; v3.65.0** | Nothing about it is designed yet; `TEXT_CAP = 80,000` stays, unchanged, until it is |
| The rail-level ingest-finished badge (K5) | **Kept, and its shape changes** | There is no longer an Ingest rail button to badge — it moves to the **Domains** entry, on the Sync-badge's own render/patch idiom; recommended for v3.65.0, with the dashboard |
| Renaming `/api/memory` (Tier C) | Refused, again | The view id, two `localStorage` keys, six docs-links keys and every `mem-*`/`fnd-*` class all still depend on it |

**Acceptance, per scenario.** The rail: three buttons, no divider, the logo still lands on Domains,
and a stored `ingest`/`shared` last-view still restores. K5 (audience 1's everyday loop): a user
drops a source on the domain page, sees the free estimate before spend, starts it, visits WIKI HEALTH
and returns to find the panel still live. The drag hazard: proven in a real browser, not argued —
same drop-target node before and after a drag held through a health revalidation. Shared Brain: on a
contributing domain, only that domain's connections appear, still through the per-connection
in-flight registry; on a mirror, ADD SOURCES is absent and `#btn-sb-enable` exists in exactly one
file in the tree. B21 (Chat reads a project): with a project pinned, the answer is built from the
canonical documents and the brief, both budgets are stated, and an omission is named; with no project
pinned, the prompt is byte-identical to v3.63.0's. The injection defence: the framing sentence is
emitted before any project text, the authority note precedes the brief, and the caveat body is
byte-identical to the string the MCP tool holds today, asserted from the new shared module. A stale
pin: a project pinned in Chat and then deleted answers a 400 with a named reason before the stream
opens. Positioning: the retired noun has **zero** hits in `README.md`, `docs/**` and
`public-knowledge/**`, and survives only in the frozen `v3.59.0` changelog row — which, since that
row was archived, now exists in **two** places rather than one (`CHANGELOG-ARCHIVE.md`'s full row
and `CLAUDE.md`'s one-line index entry for it). Both are evidence of what was said at the time and
neither is edited; the acceptance is the zero, not a repository-wide count of one.
The campaign: at least one harness carries a real verdict word from a real run, and every row that
does not still reads `not-measured`.

**Protected basics it must not regress.** Every row of audience 1's must-not-regress list from
earlier releases, plus, load-bearing here specifically: Chat stays domain-scoped and single-select
with the live pages-in-scope readout, extended (not rewritten) by the project pill; the Shared Brain
enable toggle stays on that view's own off-state and nowhere else, the census widening to
`views/domains.js`; the domain page's page list keeps its absence of a loading gate even while a
hosted panel is busy — the busy-quiesce **patches**, it never skips a repaint the loading gate
expects; Send and Stop stay one element, one id, one listener; Compile-to-Wiki stays a thread item
with no `max-height`/`overflow` of its own; the per-message copy control stays visible at rest; on
the bridge, any new tool still needs a `refuseIfReadonly()` call site with the catalogue and the
usage-log driver moved in the same commit; a foundation is still stored and returned verbatim, no
summarisation on the way in or out; no `## ` heading in `docs/user-guide.md` changes except the one
demotion named in (f); the three "context engine" sentences across `README.md`, `docs/README.md` and
`docs/user-guide.md` stay byte-identical to each other; `node scripts/test-docs-links.js` and
`node scripts/test-public-knowledge.js` stay green.

**Risks, ranked.**

1. **The drop zone inside a page that re-renders itself** — the highest risk, because it has already
   happened once, in this exact code, at v3.46.0. Mitigated by the busy-quiesce rule in (c), verified
   only in a real browser under a real drag; the de-risking fallback, named in advance, is that ADD
   SOURCES renders a destination, the activity and an "Open Ingest" door instead of the full drop
   zone, for one more release, if the measurement fails.
2. **The domain page becomes the "four audiences' worth of card" page it was already warned about**
   before this release adds two more sections. Mitigated by closed folds, jump tiles, and a mandatory
   overflow-zero measurement at both 1370 px and 568 px; the honest residual is that a user with a
   connection, a project and a health report still has a long page even folded, and the real answer
   is v3.65.0's Home dashboard.
3. **A re-host that quietly becomes a rewrite.** Both hosted views are thousands of lines long and
   several suites cut named functions out of them by brace-matching source; a "tidy while moving"
   refactor throws rather than failing softly. Mitigated by the additive-seam rule in (c) and the two
   untouched tripwire suites.
4. **A silent unreachability.** `navigate()`'s gate is the registry, and an unknown view name is a
   silent no-op with no warning; a divider naming a view outside `NAV_VIEWS` renders nothing, also
   silently. Mitigated by a new assertion that executes view registration against a stub for every
   `HOSTED_VIEWS` name, and by re-checking both Electron `[data-view]` selectors against a
   three-entry rail.
5. **The injection defence weakening in transit.** The caveat body is the memory layer's defence
   against a handoff carrying text shaped like an instruction, and it was measured once, live: planted
   state was never obeyed, but in 3 of 10 live runs a model reproduced a hostile command as a
   recommended next step. Chat is a new consumer of that text, on a surface where the user reads
   prose rather than a JSON envelope. Mitigated by moving the framing constants byte-identical and
   reusing the MCP's own serialisation order, with a negative control that a wrongly-ordered prompt
   must red.
6. **The site deploys on merge, with no staging, and this release rewrites roughly a third of it.**
   The only post-deploy gate is a curl for 200 and a canonical tag, which a page that renders as one
   broken line would still pass. Mitigated by a mandatory pre-merge browser pass with a
   zero-console-errors requirement, and by splitting the site packages so no single commit carries
   both template and animation-logic changes.
7. **A copy pass is exactly where an unmeasured claim gets written**, because a marketing sentence is
   shorter than an honest one ("works with Claude Code, Codex and Cursor" is eight words; the true
   sentence is thirty). Mitigated by the forbidden-sentence list the website design pass wrote out
   verbatim (no percentage or success figure about capture; no "your agent will save"; no "never
   loses context"; no user/install/star counts) and by marking the bridge section's third card as
   unsoftenable.
8. **A heading edit breaks a link nobody clicks until a stranger does.** 33 website-referenced
   anchors, 11 pinned `DOCS_LINKS` keys and a second hand-maintained anchor table exist outside this
   repository's own test coverage. Mitigated by renumbering nothing (D26), by a set-equality check
   over the guide's headings before and after, and by a new anchor-resolution guard on the website
   side that is the first thing that has ever checked the site's own links into the docs at all.

**Open questions carried out of it.** See §F **Q15–Q27** below — both design passes' open questions,
deduplicated and numbered continuing this file's sequence. One item the website design pass posed as
a question — which release ships the three-entry rail — is **not** among them: the maintainer's
2026-09-19 instruction that produced this section answers it (v3.64.0, this one), so it is recorded
above as fact rather than carried forward as open. Whether the second animation in (g) gets built at
all (as opposed to a static diagram) is still genuinely open — see **Q22**.

---

### v3.65.0 — closing the loops

**Retitled 2026-09-19.** This section carried the title *"v3.64.0 — awareness and promotion"* through
this file's prior revision. The shell design pass that produced the section above moved this
release's number to v3.65.0 and, per its own §8 (reproduced in the section above's "What it
deliberately does NOT do" table), took **one** of this section's six original rows — *"Chat: read a
project's context"* (B21) — out of it and into v3.64.0, where it now ships as (d) above. The other
five rows, and the goal they serve, are otherwise unchanged from this file's prior revision.

**What v3.64.0 handed it, 2026-09-20.** Eight items, seven named in that release's own deferral
table and one added during the build — the **page-level drop forward** on the domain page, which
needs one more export from `views/ingest.js`. All still `planned`: the **Home dashboard** (which is also the only real answer to the
logo/Domains redundancy, and to a domain page that is long even folded); Chat's **Save as
foundation**; the **cross-scope digest**; **promote-to-foundation** from a handoff decision; a
**25th MCP tool** for the skeletons; the **ingest auto-split at headings**, still undesigned; and
the **ingest-finished badge**, which changed shape rather than moving — there is no Ingest rail
button left to badge, so it belongs on the **Domains** entry via the Sync badge's own render/patch
idiom. Three smaller carries joined them: the `memory.knowledge` docs-links key, reconciling (or
deliberately not reconciling) the two machine ids one computer mints, and re-deriving v3.57.0's
one-child-replaced baseline for a cached domain switch, which this release's harness measured at
3–4 on `main` as well as on its own branch.

**Goal.** Make the store useful when **more than one** session works a project, and give the owner
a gesture for moving something from volatile to canonical.

**Scope.**

| Feature | Notes |
|---|---|
| **A cross-scope "what changed since your last session" digest, inside the bootstrap** | `get_project_context` returns one scope's latest handoff today. The digest adds a bounded summary of what **other** scopes and machines recorded since this caller's last save, so two harnesses working one project in parallel are not each other's blind spot. It is a read: the bootstrap never writes |
| **Promote-to-foundation, from a handoff decision** | A decision in a handoff is superseded by the next save. When it has stopped being volatile, the owner promotes it: the text opens in the **existing** foundation editor, unsaved, and reaches disk only through a commissioned save (`save_foundation` with `commissioned_by_owner: true`) or the owner's own `PUT`. No new write path |
| **An MCP read tool for the skeletons** | Any harness fetches the unfilled prompts in one call instead of the owner pasting a sentence. Narrower than it looks: `get_project_context` already returns skeleton documents and marks them, per document and as a count (`getProjectContext` in [src/brain/working-state.js](../src/brain/working-state.js)), so this is a convenience for a client that does not want the whole bootstrap. It is a **25th tool**, and the tool count is a release decision — the catalogue is pinned against the `tools` array's order and the `refuseIfReadonly` census |
| **The MCP prompts primitive** | [mcp/server.js](../mcp/server.js) declares `capabilities: { tools: {} }` — **tools only, today**. Adding `prompts` lets a client offer "draft this project's foundations" in its own UI. Client support is uneven, so the copyable sentence stays the harness-neutral floor and the prompt is an upgrade: one text, one source, two transports |
| **Chat: "Save as foundation"** *(moved here from v3.64.0 by the 2026-09-19 shell design pass's Decision D-O: the read half of Chat-and-a-project ships at v3.64.0 as (d); this write half is deferred so a release carrying a rail change, two re-hosts and a retrieval change is not also carrying a write surface with its own approval flow)* | One more per-message action in an **answer's** meta row, beside the copy control — deliberately not the thread-level Compile control, which acts on the whole conversation. It opens the ordinary editor pre-filled with that answer's raw Markdown; the owner picks project, role and slug and presses Save. Serves a builder with no repo and no agent planning in conversation, and drafting from what the domain's wiki already knows |

**Proposed for this release — maintainer to confirm.**

| Feature | Notes |
|---|---|
| **Ingest auto-split at headings for an over-cap source** | `TEXT_CAP` in [src/brain/ingest.js](../src/brain/ingest.js) is **80,000 characters** and **STAYS** — it is the one number that keeps a single ingest's cost and its output-token ladder bounded, and raising it moves both without telling anybody. What is proposed instead is a pre-ingest **split at headings**: a source over the cap is divided at its own `#`/`##` boundaries into parts, and the parts are ingested as **ONE job** — one queue item, one estimate, one result panel, one `log.md` entry — rather than as several unrelated sources the user has to re-assemble mentally. Open, and the reason this is proposed rather than scheduled: whether each part gets its own summary page or one summary spans the whole source (the second is what a reader wants and the harder one to write), what the slug of a part is, and how the estimate quotes a multiple for a source that will become N calls. Nothing here is designed; the cap's behaviour today (truncate at 80,000 and warn) is unchanged until it is |

**Relation to [roadmap-chat-modes.md](roadmap-chat-modes.md).** Modes 3 (**Dictate**) and 4
(**Curate**) are designed-but-unbuilt for the **wiki**. "Save as foundation" above is their tier-0
sibling (its read-side sibling, Chat reading a project's context, ships at v3.64.0 as (d) and is
covered there instead), and the boundary is the one that document already draws by its own logic:
Dictate and Curate write pages that **accumulate**; this writes documents that are **replaced
whole**. The two roadmaps should be read together and neither should grow a copy of the other's
design.

**What it deliberately does NOT do.**

- **No automatic promotion.** Nothing heuristically decides that a handoff line is canonical, for
  the same reason nothing selects what belongs in a project: that judgement is the owner's.
- **No LLM between the owner and the canonical layer.** A drafted or derived document opens in the
  existing editor, **unsaved**, with its provenance stated unfolded. It is a drafting aid on top of
  the editor, never a second write path.
- **No cross-scope write.** The digest reads other scopes; it never writes into them, and it does
  not mark anything as seen on a caller's behalf.
- **No merge of two parallel handoffs.** Each scope keeps its own, and `<machine>` keeps them from
  ever conflicting in one file. Presenting both honestly is the goal; reconciling them is not.

**Acceptance, per scenario.** B15: two scopes saving between one caller's sessions produce a digest
naming both, bounded, with truncation disclosed and the bootstrap's budget unchanged. B16: a
promoted decision arrives in the editor unsaved, and nothing reaches disk without an explicit save;
the resulting document carries the right `authoredBy` for whoever pressed Save. B20: a saved answer
goes through the same 512 KB wall, the same budget disclosure and the same human stamp as any other
curator-owned document. (B21 — Chat reads a project's context — shipped at v3.64.0; its acceptance is
recorded there.)

**Protected basics it must not regress.** Compile to Wiki stays a thread item with an
estimate/confirm and no `max-height` or `overflow` of its own (`scripts/test-next-chat-compile.js`);
Send and Stop stay one element, one id, one listener (`scripts/test-next-chat-cancel.js`); citation
chips keep their titles with the path in `data-cite`; the per-message copy control stays visible at
rest (`scripts/test-next-chat-copy.js`). On the bridge: any new tool must add a
`refuseIfReadonly()` call site, and the catalogue, the usage-log driver and the tool map must move
with it in the same commit (`scripts/test-mcp-usage.js`). A foundation is still stored and returned
**verbatim** — no summarisation on the way in or out.

**Open questions carried out of it.** Whether "Save as foundation" should be offered on a
**question** as well as an answer (§F D17 — already decided: on both). **D16 is contested, not
settled**, by the 2026-09-19 shell design pass, which built the v3.64.0 pill on **per device**
persistence rather than D16's "per conversation" — see §F **Q17**.

---

## D. Standing, not phased

Three items that belong to no release and should be re-measured rather than re-derived.

| Item | Why it is standing | The measurement that exists |
|---|---|---|
| **`index.md` rot** | It is the grounding step for every agent write into a wiki, so it degrades the layer audience 1 owns, on every domain, continuously. `get_index` is faithful; the files are wrong | Rows against pages, recorded in v3.17.1/v3.17.2's known-and-unfixed notes: one domain **0 of 64**, another 31 of 379, another 698 of 3,379 |
| **Whether models reach for the tools unprompted** | The answer changes with every model and harness release, so it is a reading nobody can take once. It is also the fact the whole capture argument rests on | 2026-09-10, 16 headless runs, N=4 per arm, one task, one model, two harnesses — a shape, not a rate. Save *quality* was not judged and interactive sessions were not measured |
| **The second-brain basics** | Audience 1's list does not stop being work because audience 2 arrived. It is the acquisition path | The audience inventory's own gap list: the finished-ingest badge (K5, now v3.62.0), `index.md` rot, nothing telling a reader their wiki changed outside the view that changed it, the front door (README and a user guide with no ten-minute path), the Model Lab and Compare, three blocks with no ⓘ (K17), a cited page appearing twice in two styles, a nested git repository under the domains folder breaking sync outright, four views still giving create-only advice on their empty states, Compile being invisible to the client-side write gate, per-file skip on a running batch, a thinking bubble that follows a conversation switch, the shell collapsing at 375 px, and **almost nothing rendered in Electron since v3.46.0** — which is the one release that drove the real app and found a real defect that way |

---

## E. Cautions

Five rules that should survive this roadmap even if every release in it is re-planned.

1. **Do not replace a harness's own memory features — interoperate.** A harness that has its own
   memory, rules file or session store is not a competitor to be displaced; it is a reader and a
   writer to be met. The Curator's claim is that context is **portable**, and a store that demanded
   exclusivity would be making the vendor-lock-in argument from the other side. The neutral command
   and the public spec exist so a harness's own mechanism can drive this store, not so this store
   can supplant it.
2. **The wiki is never the coding memory.** The wiki's merge unions bullets, so a blocker resolved
   on Tuesday is resurrected by Wednesday's write: **a union merge cannot express "no longer
   true"**. That is why there are two stores and not one, and why `state/` is never routed through
   `writePage` — which could not carry it anyway, since `normalizePath` flattens to a basename and
   two projects' scopes would collide on one file. Do not merge working state into the wiki, in
   either direction, for any reason.
3. **No LLM between the owner and the canonical layer without the owner's approval in the editor.**
   Tier 0 is stored and returned verbatim, which is the same trust the standing brief has. Any
   future drafting aid opens **in the existing editor, unsaved, with its provenance stated**, and
   the owner's Save is the only thing that writes. A confident document generated from a digest is
   precisely the failure tier 0 exists to fix.
4. **No persona or mode switch.** The maintainer is both audiences; nothing in the store models a
   persona; every shared screen would have to answer "which mode am I in"; and the app already
   refused this shape's modal ancestor. The legitimate need behind it — *meet me where I am* — is
   served by a door that explains all three layers, a rail in frequency order, and first-run
   guidance derived from what the user actually has.
5. **Claims of reach are measured or labelled unverified.** Per harness, per model, with the date,
   the arms and the sample size. Never overclaim: an open standard existing is not a host
   implementing it, and a skill being installed is not a skill running.

---

## F. Open questions for the maintainer

**Already decided (2026-09-18), recorded so they are not re-opened.**

| | Decision |
|---|---|
| D1 | The Documents choice on the create form defaults to **decide later** — fail-safe: nothing is written on an unread form |
| D2 | First run gets **two non-blocking doors** (*Build a second brain* / *Give your agents memory*) setting the landing view and the steps that follow; still dismissible, never a modal; the agent door drops the model-key claim and points at the MCP bridge |
| D3 | A **PDF is refused** at tier 0, with the reason: documents are kept word for word, a PDF needs converting — ingest it into the wiki, or export it as Markdown first |
| D4 | **Rename `Agent memory` → `Project context`**, rail caption `Context`, scheduled with the v3.62.0 shell release (it moves `FOCUSABLE_IDS`, suites and docs chapters) |
| D5 | The skeleton banner's first line is **bold text**, not a blockquote, this release |
| D6 | Deleting a skeleton is an **ordinary delete** — no fixed slots; whether a project keeps four slots is a schema question for later |
| D7 | Second-machine curator-owned edits get **the documentation carve-out only** this release; an editor warning needs a sync fact the view does not have |
| D8 | The drafting request is **composed from the project's real skeleton slugs**, with the sha pin covering the template rather than the rendered string |
| D9 | (was Q1) **One mirror root per project** — a second root is not designed until a user needs it |
| D10 | (was Q2) **No fixed document slots** — roles are a vocabulary and the seed is a convenience; deleting a skeleton stays an ordinary delete |
| D11 | (was Q3) **A blockquote pass in `shared/markdown.js`**, strictly `> ` lines, ships as its own v3.62.0 item, measured against the v3.58.0 document corpus before it ships; the bold banner stays |
| D12 | (was Q4) **No home view in v3.62.0** — judged only after the two-audience shell has been used |
| D13 | (was Q5) **CLOSED by measurement** — the 568 px arithmetic was measured in the Browser pane during v3.61.0 (summary meta 356 px in 466 available; overflow 0 at 589 and 959 px); the Electron gap remains |
| D14 | (was Q6) A **"session" in the honesty meter is a bridge session** (one MCP child process, initialize → exit) — the only unit a content-free log can observe; harnesses are told apart by one new bounded content-free usage-line field `client`, read from the MCP client's own declared name (v3.63.0) — **as shipped it rides a once-per-process SESSION line rather than every line**, and it is read from **both protocol eras**: revision `2026-07-28` REMOVED the initialize handshake and makes `clientInfo` an optional, per-request, self-reported `_meta` entry that a server SHOULD NOT branch on, so the value is allow-listed, many-to-one, and read by nothing but a report |
| D15 | (was Q7) **The neutral `curator` command lives in this repository**, published as a bin of the same package so it installs without the app, adapters as files beside it; split out only if adapters need their own cadence |
| D16 | (was Q8) **Chat's project pill persists per conversation**, as a field on the conversation file (absence = none), so it travels with sync |
| D17 | (was Q9) **"Save as foundation" is offered on a question and on an answer** — the editor opens pre-filled either way; the owner's approval in the editor is the rule, not a preview |
| D18 | (was Q10) **The honesty meter never fails or blocks a session** — it reports, and may show a reading as a warning; capture stays advisory |

| D19 | (was Q11) **The foundations budget on a mature project: the recommendation was taken, and it SHIPPED in v3.62.0.** See below |

**Decided 2026-09-19, from the two same-day design passes behind the v3.64.0 section above.**

| | Decision |
|---|---|
| D20 | **Positioning: "The Curator — the context engine"** above the unchanged tagline; "engine" replaces "machine" everywhere either word is a product claim, in both repositories, in one landing. One exemption survives — `CLAUDE.md`'s frozen `v3.59.0` changelog row — and this file's own prior exemption (its audience-2 table cell) is **withdrawn**: see the retirement in §A |
| D21 | **The rail becomes three entries — Chat · Domains · Context** (*ask · knowledge · context*), no divider; Ingest and Shared Brain leave the rail but stay reachable, registered and restorable as `HOSTED_VIEWS`, because `navigate()`'s gate is the view registry, not the rail array, and an unknown name is a silent no-op |
| D22 | **`HOME_VIEW` stays `domains`.** The logo/Home redundancy this creates is accepted, not fixed, and is left for the v3.65.0 Home dashboard |
| D23 | **The Shared Brain enable toggle stays on that view's own off-state, install-level, and does not move to the domain page** — a per-domain copy of it would put one control in N places, the literal negation of "one control, one place, nowhere else"; a domain page's Shared Brain section reads the connection through a lens instead |
| D24 | **Re-hosting Ingest and Shared Brain into the domain page is additive, never a rewrite: one panel, two hosts, no function moves file or is renamed.** Two existing suites that cut named functions from both views by brace-matching source are the tripwire — green and untouched is the proof the seam held |
| D25 | **Chat reads a project's canonical context in-process, but never writes to it.** "Save as foundation" is a write surface with its own approval flow and is explicitly deferred to v3.65.0, alongside the Home dashboard whose editor it will open into |
| D26 | **The user guide's spine (ask · knowledge · context) is delivered without renumbering a single chapter** — a table of contents regrouped under three captions, plus a routing table at the end of chapter 1. A census found 33 website-referenced anchors, 11 pinned `DOCS_LINKS` keys and a second, independently hand-maintained anchor table outside this repository; renumbering even one chapter would be a breaking change to four consumers, two of them external |
| D27 | **The website lands in two parts, split at the dependency rather than at a version number:** W1 (the catch-up, describing the app as it is at v3.63.0) ships as soon as it is verified; W2 (the three-entry-rail lede and screenshots) waits for this release's own Tests workflow to go green |
| D28 | **A row of peer cards on the website may vary by at most 1.35× in word count, and no card carries more than one paragraph** — enforced by a script with a planted-defect control, never by review alone, because review had already let a 4.43× spread and a 60-word hero paragraph ship |

**D19 in full, because it is the one open question this roadmap closed by building it.** The
measurement that raised it stands — on this repository's own documents, `docs/architecture.md`
372 KB, `docs/working-state.md` 125 KB, `CONTRIBUTING.md` 70 KB, `docs/design-system-source.md`
68 KB, `docs/roadmap-context-engine.md` 47 KB, `docs/sync.md` 37 KB (`wc -c`, 2026-09-19) —
against a 200 KB project budget (exceeded is accepted and disclosed, never refused) and the
bootstrap's 120 KB default reading budget, which drops document bodies last-first. Of the three
options, **the first two shipped together** and the third stayed undesigned:

| | Option | Outcome |
|---|---|---|
| 1 | Keep both budgets and teach that foundations are the documents an agent must not act without, not the reference manual | **Shipped** — in the user guide's "mark sparingly", in `docs/working-state.md`'s budgets table, and in the block's own over-budget disclosure |
| 2 | A per-document "include in bootstrap" flag | **Shipped as `readFirst`** — manifest schema still `1`, additive, absent = false |
| 3 | A curator-owned excerpt beside a large mirrored document, the owner writing it, no LLM | **Not designed.** Still needs a schema field; left open |

**What shipped, precisely, is wider than the flag**, and the extra half is what makes the flag
safe: the bootstrap now returns the **INDEX of every document, always**, so a document that is not
marked is *named* rather than absent — and `get_project_context` gained **`slugs`** so an agent
opens any of them whole, by name, with no twenty-fifth tool. The brief's template gained a
**"Read before you…"** routing section, because which document suits which kind of work is a
sentence rather than a boolean and belongs to the owner. The one real judgement recorded with it:
**read-first bodies ignore `seen_hashes`**, because the hash delta is an economy for a set read
once and remembered while the flag is a per-session instruction, and a resumed session holds the
hashes and none of the text.

**And one risk the flag creates, which the release had to close explicitly:** an agent reading an
index row with no text can conclude the document does not exist — *"this project has no decision
log"* — which is worse than the gap v3.59.0 closed, because it looks like knowledge rather than
ignorance. Three surfaces now say otherwise in as many words: the tool description, the continuity
skill, and a **fourth** byte-pinned paragraph in the instructions block (`TEMPLATE_READ_FIRST`, 58
words, sha256 `907c7d9a…`), composed after `TEMPLATE_SEED` so v3.59.0's and v3.61.0's paragraphs
and the 501-byte measured block keep their own pins untouched.

**Still open, numbered.**

12. **Step ③'s ⓘ has no docs link.** Every other ⓘ on the Project-context screen ends in one;
    step ③'s explains the layer and stops, because the key it wants (`memory.knowledge`) was never
    added to `shared/docs-links.js` — v3.62.0's shell package added `domains.three-layers` and no
    other. `docsUrl()` throws on an unknown key and a hand-typed URL is the one thing
    `scripts/test-docs-links.js` cannot check, so the gap was left open rather than papered over.
    One key and one call site.

13. **The brief template exists in three copies and they have drifted.** `briefTemplate` in
    `src/brain/working-state.js` is authoritative and is what seeds a real `project.md`;
    `views/memory.js` and `views/domains.js` carry their own placeholder copies, which still say
    `## Working model` where the store says `## How I want you to work here`, and neither has
    v3.62.0's `## Read before you…`. A user can therefore read a heading in the app's editor that
    the seeded file does not contain. The fix is one shared constant, the same move
    `src/brain/foundation-skeletons.js` already makes for the skeletons; it was not taken in
    v3.62.0 because it touches two views in a release whose view package was owned elsewhere.

14. **A curator-owned excerpt beside a large mirrored document** — D19's third option, still
    undesigned. It needs a schema field (an excerpt is a second body for one manifest entry, or a
    second entry pointing at the first), and it has to answer what happens to the excerpt when the
    source changes: a stale excerpt of a fresh document is a worse failure than no excerpt, and
    computing one without an LLM means the owner writes it, which means it can silently rot. No
    user has asked for it yet; the flag plus the index may make it unnecessary.

**Carried from the two 2026-09-19 design passes behind the v3.64.0 section above, deduplicated —
each with the pass's own recommendation, where it gave one.**

15. **The rail divider.** D21 removes it, on the grounds that "advanced" contradicts "both audiences
    first-class." Keeping `RAIL_DIVIDER_AFTER = 'domains'` would be the lower-churn option, and it
    would still fall between Domains and Context either way. *Recommendation: remove it. Cost of
    being wrong: one line, either direction.*

16. **The onboarding "Open Ingest" step.** Should the knowledge door's third step keep navigating to
    the full-page Ingest view — a screen with no rail button, which a user cannot find again — or
    navigate to Domains and open the ADD SOURCES fold? *Recommendation: Domains plus the fold; a
    first-run step that teaches an unreachable screen is worse than one extra click.*

17. **The project pill's lifetime, and D16's reopening.** D16 recorded "per conversation." The
    2026-09-19 shell design pass built the v3.64.0 pill **per device** instead, on the grounds that a
    conversation JSON syncs, so a per-conversation field could pin a project on a machine where it
    does not resolve. *Recommendation: per device now (as shipped); revisit per-conversation when the
    conversation schema next changes for another reason.* **This is the one place a prior decision
    (D16) and a later design pass disagree; the maintainer's word settles which stands.**

18. **The ingest auto-split at headings**, still nothing about it designed: whether each part gets
    its own summary page or one summary spans the source, what a part's slug is, how the estimate
    quotes a multiple for a source that becomes N calls. *Recommendation: v3.65.0, after those three
    questions have answers.*

19. **The ingest-finished badge, now that there is no Ingest rail button to badge.** It moves to the
    Domains entry (the Sync-badge's own render/patch idiom). Is a badge on Domains — which also means
    "your domains changed" — the right signal, or does it want the Home dashboard first?
    *Recommendation: v3.65.0, with the dashboard.*

20. **Three items carried from v3.63.0, still unresolved:** the npm package name (`the-curator` vs
    `my-curator`); the licence on `src/brain/github-read-client.js` (built MIT, unconfirmed); and
    whether `COPY_SUCCESS_BANNER` should point at `my-curator doctor` instead of the harnesses it
    names today — a byte-pinned, model-read constant, so this is a decision, not a docs edit.

21. **The three brief templates** (the store's, `views/memory.js`'s, `views/domains.js`'s) were
    aligned on one heading in v3.62.0 but not unified. Package D of the v3.64.0 shell work touches
    `domains.js` again. Should it unify on the store's template, or is that a separate release?
    *Recommendation: separate — it is a data-shape change wearing a copy change's clothes.*

22. **Does the website's second animation (`buildContextLoop`) get built, or is the budget better
    spent on a static diagram?** A static SVG is cheaper, raises no reduced-motion question, and a
    still frame can be reused in the user guide. *Recommendation: build the animation, and export a
    still frame at its rest second for the docs in the same pass* — the animation earns the section
    and the still costs one extra step.

23. **13 website sections, or 12?** The one merge worth making is folding `#widget` into `#app` as a
    second panel behind the existing tab row, which would hold the section count at 12; it is real
    work and is not scheduled in any package. *Recommendation: ship 13 now and revisit the merge when
    `#app`'s screenshots are re-taken for W2* — one measurement of that section instead of two.

24. **Does the website get a "for agent users" landing path** — a second page or a deep link that
    opens with the audience-2 card pre-selected? *Recommendation: no, not this release* — the
    two-ways-in section already routes in one screen, and the site has no build step, so a second
    page is a second hand-maintained large file. *What would change the answer:* a measurable share
    of arrivals from an agent-tooling context, which nothing on the site currently measures.

25. **Does the ask panel's fourth topic chip rename from "agent memory" to "project context"?** The
    app renamed the view in v3.62.0, but the Lumina document stays `curator-agent-memory.md` on
    purpose (the set is uploaded by filename, and its budget is keyed on that name).
    *Recommendation: rename the chip, keep the filename* — a label a visitor reads and an upload
    identity answer to different constraints.

26. **Is `docs/product-overview.md` worth a full reconciliation, or should it be retired?** Eighteen
    releases of capability have landed since its self-declared "current as of" line. (f) above takes
    four surgical edits now rather than the real reconciliation the file needs.
    *Recommendation: take the four edits now and put the full reconciliation on this roadmap.* *What
    would change the answer:* if the maintainer no longer hands this file to models, retiring it and
    letting `docs/README.md` plus the Lumina overview carry the job is the honest move.

27. **Should the website carry a Content-Security-Policy?** Out of scope for a copy-and-shell
    release, and it can break the ask widget, Google Fonts and the CDN scripts it currently loads
    cross-origin without an allow-list written and tested first. *Recommendation: not this release;
    keep it on the roadmap beside the site's other infrastructure items. Not a builder's call.*

---

## G. Pre-implementation checklists

One per release, in the style [roadmap-chat-modes.md](roadmap-chat-modes.md) uses: the things to
settle **before** an implementing session writes code.

**v3.61.0 — start a project**

1. Drive `init`, the repository scan, `PUT` and `DELETE` against the **domain's own project**, whose
   foundations land at `state/foundations/` with no `<project>` segment — and check it against the
   known v3.57.0 reserved-name route collision, where `/:domain/projects` matches before
   `/:domain/:project`.
2. Confirm the ownership refusal fires on an **empty** manifest, not only on one with documents.
3. Confirm the copy says **folder**, not repository, everywhere a plain folder is a valid source.
4. Re-run the `refuseIfReadonly` census from the call sites across `mcp/tools/**` — never from
   prose — and confirm the tool count is unchanged at 24.
5. Verify the raw round-trip: load with `?raw=1`, save unchanged, compare sha256.
6. Confirm the drafting request has **one** source with a sha pin and is **not** appended to the
   instruction block that gets pasted into a harness's entry file — that file is re-read every
   session, and a "draft these now" imperative there is a permanent instruction.
7. Walk audience 1's must-not-regress list end to end before the release is cut.

**v3.62.0 — the shell for two audiences**

1. Decide the rename's blast radius first: `FOCUSABLE_IDS`, the ⓘ panel ids derived from the view
   title, the suites that pin the header string, and the docs chapters and anchors — all in one
   commit, or not this release.
2. Decide whether the step set is derived or enumerated **before** building the doors; the panel's
   suite pins `STEP_ORDER` as the single source of that order.
3. Confirm the bridge step's done-ness comes from the harness-neutral usage fact, not from the
   Claude-Desktop-config-only `installed` fact.
4. Extract the create panel to one module with **one** `POST` inside it before adding a second host.
5. For the ingest fork: confirm the non-paying arm loses the estimate, the budget cap, the `✨` and
   the `.btn-ai` tint. If the arm that spends nothing keeps the paying chrome, the app has taught
   the user the two are the same thing with different words.
6. Measure the rail-badge change in the real Mac app, not only in a browser — the one release that
   drove Electron found a drag-and-drop defect that way.

**v3.63.0 — capture guarantees**

1. **Research before design:** for each of Claude Code, Codex, Cursor and Gemini CLI, establish what
   the harness actually exposes — a session-end hook, a compaction hook, an auto-loaded entry file,
   a skill mechanism, none of the above — and write that down before proposing an adapter.
2. Fix the measurement protocol first: arms, N per arm, the task, the model, and what counts as a
   save. Publish the matrix with those attached, and mark every unmeasured harness *not measured*.
3. Decide Q7 (where the command lives) before writing an adapter.
4. Freeze the public spec's scope: layout, section vocabulary, the `<machine>` rule, budgets,
   disclosure fields. A spec that omits the machine segment would invite a writer that breaks sync
   safety.
5. Confirm the honesty meter can be built from the **content-free** log alone. If it cannot, that is
   a privacy decision to take explicitly, not a field to add quietly.
6. Keep the fail-safe direction: design the failure case first — what the owner sees when nothing
   saved — and make sure it is never a lost handoff.

**How those six came out, since they were a checklist rather than a plan.** (1) Done, and it
overturned the premise — §2 of the v3.63.0 design record carries thirteen harnesses, two of them
source-verified against documentation that contradicts them. (2) Done and published; every row is
*not measured*. (3) Taken: the command lives in this repository, works with the app closed, and is a
second **local client** rather than anything the server can reach. (4) Frozen, and the `<machine>`
rule is published **with its reason** — the `-X theirs` splice — because a spec that stated the rule
without the hazard would invite a writer to simplify it away. (5) Confirmed **negative**, and the
privacy decision was taken explicitly (above). (6) Held: capture is advisory, a hook may only ask,
and a missed save still yields the previous state.

**Two carried questions, and what the design pass recommended.** Both are recorded here as the
**maintainer's decisions**, not as settled facts:

- **Q7 — pull "Chat → canonical" forward into v3.63.0?** *Recommended against.* v3.63.0's register
  is engine work — a command, a log schema, a public spec, a network client — and the Chat rows are
  view work on a foundation editor that v3.62.0 had just restyled. Mixing them would have given one
  release two unrelated must-not-regress lists. It stays at v3.64.0.
- **Q8 — which release gets the ingest auto-split?** *Recommended for v3.64.0.* `TEXT_CAP` silently
  drops everything past 80,000 characters, mitigated only by a warning nobody reads on a green
  result panel. Splitting at headings is **audience 1's** work and belongs beside the ingest fork,
  not beside a capture release. *What would change the answer: one user losing real content to the
  cap.*

**v3.64.0 — the shell for two audiences, the docs and the website**

1. Run the measurement campaign first, in wall-clock time — it gates nothing in the build tree, but
   nothing in this release's copy may claim reach ahead of a real verdict word.
2. Land the framing extraction (K) and the rail package (A) before either host seam (B, C); land both
   host seams before the domain page (D), which imports the signatures they fix.
3. Before any builder touches `views/ingest.js` or `views/shared.js`: confirm the two tripwire suites
   this release owns nobody, and re-read them after the seam lands — green and untouched is the only
   proof the additive rule held.
4. Take the drag-hazard measurement (§3.7 item 3 of the shell design pass) in a real browser before
   declaring the domain page done; no offline sandbox reproduces a destroyed drop-target node.
5. Freeze the user guide's table-of-contents regrouping and the routing table's four rows before
   touching a single `## ` heading; confirm the anchor set is unchanged by set equality, not by eye.
6. Decide W1 vs W2's gate explicitly: W1 may ship the moment it is verified; W2 waits for this
   release's own Tests workflow, not for a date.
7. Ship the copy-budget guard (`check-copy-budget.mjs`) with its planted-defect control before
   trusting any card's word count — a guard that has never failed has not been shown to work.
8. Confirm the caveat-body / injection-defence string moved byte-identical into the new shared
   module, with the negative control (a wrongly-ordered prompt must red) exercised before merge.

**v3.65.0 — closing the loops**

1. Settle the digest's budget against the bootstrap's existing one (120 KB default, truncation
   disclosed) before adding a field; two budgets competing silently is the defect to avoid.
2. Decide the 25th-tool question as a release decision, and move the catalogue, the usage driver and
   the tool map in the same commit as any new tool.
3. Decide whether the `prompts` capability ships at all; if it does, keep **one** text with the
   copyable sentence as the harness-neutral floor.
4. Confirm that "Save as foundation" writes tier 0 only through the existing editor and the existing
   save — no second write path, even a partial one.
5. Read [roadmap-chat-modes.md](roadmap-chat-modes.md) alongside this section and keep the boundary
   explicit: Dictate and Curate write pages that accumulate; this writes documents replaced whole.

---

## Related reading

| Document | Why |
|---|---|
| [working-state.md](working-state.md) | The memory layer's design record, including the foundations chapter, the budgets, the sync carve-outs and what a handoff cannot do |
| [roadmap-chat-modes.md](roadmap-chat-modes.md) | Chat Modes 3 and 4 — the wiki siblings of v3.64.0's two Chat rows |
| [mcp-user-guide.md](mcp-user-guide.md) | The bridge from the user's side, including the tool map and the usage log |
| [sync.md](sync.md) | Why `<machine>` is load-bearing, and the no-machine-segment bargain tier 0 and the standing brief share |
| [design-system-source.md](design-system-source.md) | The heading, lede and ⓘ rule (§3) every copy change above is held to |
| [use-cases.md](use-cases.md) | The audience-facing workflows, including the coding-agent one and its measurement caveats |
