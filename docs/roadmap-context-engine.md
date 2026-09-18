# Roadmap — the context engine (v3.61.0 → v3.64.0)

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
| What they came for | A second brain, or a shared/company brain: ingest → wiki → chat → share | A context machine: their project's context surviving a change of session, harness, model or machine |
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
| K5 | 1 | An ingest finishes while they are on another view — **nothing tells them** | v3.62.0 (rail-level badge) | planned |
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
| B11 | 2 | **A harness whose model never activates the skill saves nothing, and nothing says so** | v3.63.0 | planned |
| B12 | 2 | Prove capture happened: sessions this week, by harness, saved / not saved | v3.63.0 (honesty meter) | planned |
| B13 | 2 | A non-Claude tool writes the format without any skill at all | v3.63.0 (public spec + a neutral `curator` command) | planned |
| B14 | 2 | A session ends by compaction rather than by choice, and the handoff still lands | v3.63.0 (per-harness hooks, where one exists) | planned |
| B15 | 2 | Two harnesses work one project in parallel and each needs to know what the other recorded | v3.64.0 (awareness digest) | planned |
| B16 | 2 | A decision that has stopped being volatile becomes canonical, on the owner's instruction | v3.64.0 (promote-to-foundation) | planned |
| B17 | 2 | A mirror has gone stale, or its checkout is not on this machine: the state is visible and Refresh is withheld with its reason | v3.59.0 / v3.60.0 | built |
| B18 | 2 | Their first minute tells them to get an API key the memory layer does not need | v3.62.0 | planned |
| B19 | 2 | Their unit of work is five clicks deep, below an "advanced" divider, in a view that cannot create it | v3.61.0 pointer · v3.62.0 rail order + shared create panel | in flight / planned |
| B20 | 2 | Plan a project in Chat with no repo and no agent, then save one answer as a canonical document | v3.64.0 | designed |
| B21 | 2 | A Chat conversation that starts from the project's canonical documents instead of a keyword search over them | v3.64.0 | designed |
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
different checkout (§F Q1). What a deleted **skeleton** means — an ordinary delete ships, fixed slots
would be a schema decision (§F Q2). Whether the shared Markdown renderer should gain a blockquote
pass at all (§F Q3).

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
their own (§F Q4). Whether the 568 px column arithmetic holds for the Foundations summary line
beside two head controls — nothing in the design pass was rendered (§F Q5).

---

### v3.63.0 — capture guarantees

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
a harness session, and whether the two can be told apart from a content-free log (§F Q6). Whether
the neutral command ships as part of this repository or beside it (§F Q7).

---

### v3.64.0 — awareness and promotion

**Goal.** Make the store useful when **more than one** session works a project, and give the owner
a gesture for moving something from volatile to canonical.

**Scope.**

| Feature | Notes |
|---|---|
| **A cross-scope "what changed since your last session" digest, inside the bootstrap** | `get_project_context` returns one scope's latest handoff today. The digest adds a bounded summary of what **other** scopes and machines recorded since this caller's last save, so two harnesses working one project in parallel are not each other's blind spot. It is a read: the bootstrap never writes |
| **Promote-to-foundation, from a handoff decision** | A decision in a handoff is superseded by the next save. When it has stopped being volatile, the owner promotes it: the text opens in the **existing** foundation editor, unsaved, and reaches disk only through a commissioned save (`save_foundation` with `commissioned_by_owner: true`) or the owner's own `PUT`. No new write path |
| **An MCP read tool for the skeletons** | Any harness fetches the unfilled prompts in one call instead of the owner pasting a sentence. Narrower than it looks: `get_project_context` already returns skeleton documents and marks them, per document and as a count (`getProjectContext` in [src/brain/working-state.js](../src/brain/working-state.js)), so this is a convenience for a client that does not want the whole bootstrap. It is a **25th tool**, and the tool count is a release decision — the catalogue is pinned against the `tools` array's order and the `refuseIfReadonly` census |
| **The MCP prompts primitive** | [mcp/server.js](../mcp/server.js) declares `capabilities: { tools: {} }` — **tools only, today**. Adding `prompts` lets a client offer "draft this project's foundations" in its own UI. Client support is uneven, so the copyable sentence stays the harness-neutral floor and the prompt is an upgrade: one text, one source, two transports |
| **Chat: "Save as foundation"** | One more per-message action in an **answer's** meta row, beside the copy control — deliberately not the thread-level Compile control, which acts on the whole conversation. It opens the ordinary editor pre-filled with that answer's raw Markdown; the owner picks project, role and slug and presses Save. Serves a builder with no repo and no agent planning in conversation, and drafting from what the domain's wiki already knows |
| **Chat: read a project's context** | A project pill in the scope bar — where "what this conversation is about" already lives, rather than the composer row, which is about *how this message is answered*. With a project picked, the prompt is built from its foundations and standing brief under the bootstrap's own budget rules, **in addition to** the wiki retrieval `src/brain/chat.js` already does, with the two budgets stated rather than silently competing |

**Relation to [roadmap-chat-modes.md](roadmap-chat-modes.md).** Modes 3 (**Dictate**) and 4
(**Curate**) are designed-but-unbuilt for the **wiki**. The two Chat rows above are their tier-0
siblings, and the boundary is the one that document already draws by its own logic: Dictate and
Curate write pages that **accumulate**; these write documents that are **replaced whole**. The two
roadmaps should be read together and neither should grow a copy of the other's design.

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
curator-owned document. B21: with a project picked, the answer is built from the canonical documents
and the brief, and both budgets are stated.

**Protected basics it must not regress.** Compile to Wiki stays a thread item with an
estimate/confirm and no `max-height` or `overflow` of its own (`scripts/test-next-chat-compile.js`);
Send and Stop stay one element, one id, one listener (`scripts/test-next-chat-cancel.js`); citation
chips keep their titles with the path in `data-cite`; the per-message copy control stays visible at
rest (`scripts/test-next-chat-copy.js`). On the bridge: any new tool must add a
`refuseIfReadonly()` call site, and the catalogue, the usage-log driver and the tool map must move
with it in the same commit (`scripts/test-mcp-usage.js`). A foundation is still stored and returned
**verbatim** — no summarisation on the way in or out.

**Open questions carried out of it.** Whether the project pill persists per conversation or per
session — the conversation JSON syncs, so per conversation makes it travel *and* makes it a schema
field (§F Q8). Whether "Save as foundation" should be offered on a **question** as well as an
answer (§F Q9).

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

**Still open, numbered.**

1. **A second mirror root.** The manifest records one `repo.root` and the picker scans it. A project
   whose conventions live in a second checkout has no path in, and a second root is a schema change.
   Unresolved and not designed.
2. **Fixed slots for a project's canonical documents.** D6 ships an ordinary delete. If a project is
   meant to always *have* an architecture document, "missing" and "the owner said there is none" are
   two different summary lines and the store cannot currently tell them apart.
3. **A blockquote pass in the shared Markdown renderer.** The right long-term answer, and it needs
   its own corpus measurement against the same document set v3.58.0 used (where the fuller
   CommonMark fix changed 108 documents and **23 of those swallowed a following paragraph**). Whose
   risk budget owns `shared/markdown.js` is the question, not whether the pass is nice to have.
4. **A real home view.** The two doors are a first-run card in v3.62.0. Whether the app eventually
   gets a home that is not a synonym for Domains is a restructure with its own content cap, block
   rhythm and proof.
5. **Rendered layout.** Nothing in the design pass was rendered — every wireframe was derived from
   shipped CSS and recorded measurements. The 568 px arithmetic (a four-clause summary line beside
   two head controls) needs one pass in a browser on an isolated copy before it is asserted, and
   the Electron gap in §D applies to all of it.
6. **What a "session" is in the honesty meter.** Bridge session or harness session, and whether a
   content-free log can tell them apart. Getting this wrong makes the meter confidently wrong about
   the one thing it exists to report.
7. **Where the neutral `curator` command lives.** Inside this repository (one release, one test
   suite, one version) or beside it (installable without the app, versioned separately). This
   decides how the per-harness adapters are distributed.
8. **Whether Chat's project pill persists per conversation or per session.** Conversations sync, so
   per conversation makes it travel — and makes it a schema field on the conversation JSON.
9. **Whether "Save as foundation" is offered on a question as well as an answer.** A question is the
   owner's own text, which is the same argument [roadmap-chat-modes.md](roadmap-chat-modes.md) makes
   for Dictate needing no preview at all.
10. **Whether the honesty meter should ever be able to fail a session.** It reports today. If it ever
    warned, or blocked, capture would stop being advisory — and the fail-safe direction is the
    reason no enforcement exists.

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

**v3.64.0 — awareness and promotion**

1. Settle the digest's budget against the bootstrap's existing one (120 KB default, truncation
   disclosed) before adding a field; two budgets competing silently is the defect to avoid.
2. Decide the 25th-tool question as a release decision, and move the catalogue, the usage driver and
   the tool map in the same commit as any new tool.
3. Decide whether the `prompts` capability ships at all; if it does, keep **one** text with the
   copyable sentence as the harness-neutral floor.
4. Settle Q8 (pill persistence) before touching the conversation schema.
5. Confirm that nothing in either Chat row writes to tier 0 except through the existing editor and
   the existing save.
6. Read [roadmap-chat-modes.md](roadmap-chat-modes.md) alongside this section and keep the boundary
   explicit: Dictate and Curate write pages that accumulate; these write documents replaced whole.

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
