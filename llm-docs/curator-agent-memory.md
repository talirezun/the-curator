# The Curator — project context (working state and foundations)

## What is project context?

Project context is everything one project gives an agent. The screen that shows it was called Agent memory until v3.62.0, and the older name still describes half of it: the working state — called **Memory** on screen since v3.65.1 — an agent leaves behind at the end of a session so the next session picks the work up instead of starting cold. The other half is the project's foundations, shown on screen as **Documents** — the canonical documents it is built against. These are copy renames only: the store still uses `foundations`, `scope` and `journal.jsonl` on disk and over MCP.

Layers 1 and 2 of The Curator are your sources and the wiki built from them. Layer 3 is this.

It is a small, deliberate store held as plain markdown inside a domain, at `domains/<domain>/state/`. It syncs to your private GitHub repository with the rest of your knowledge and opens in Obsidian or any text editor like any other file.

## What problem does it solve?

A coding session ends. The next one starts with nothing: not the decisions you already settled, not the approaches you tried and ruled out, not the number your test suite was sitting at before you touched anything. So the next session re-derives what it can, re-opens questions you had closed, and walks back into a dead end you had already mapped.

That gap opens every time you change session, agent, model, harness or machine — a new window, a switch from Claude Desktop to Cursor, a different model, or moving from the laptop to the desktop.

Vendor features hold context inside one vendor. Working state is portable by construction: it is files on your disk, read and written over an open protocol, so a handoff written by one tool is read by another.

## What exactly does The Curator store?

Four tiers, under the project's folder inside a domain's `state/`.

| Tier | File | Who writes it | Write behaviour | What it holds |
|---|---|---|---|---|
| 0 — foundations, added in version 3.59.0 | `<project>/foundations/<slug>.md`, plus a `manifest.json` | A repository, mirrored byte-for-byte. Or an agent, on your explicit instruction | Replaced whole, never merged | The project's canonical documents, verbatim: architecture, firm decisions, conventions, roadmap, API surface, a guide |
| 1 — standing brief | `<project>/project.md` | You. Or an agent, on your explicit instruction | Replaced whole | What this project is, the firm decisions that hold across every session, the working model, pointers to where the depth lives. One per project, shared by every work-stream, returned on every read |
| 2 — handoff | `<project>/<scope>/<machine>/current.md` | An agent, through `save_working_state`. Nothing else | Overwritten in full on every save | Where things stand right now, what to do next, what is settled, what to avoid, what is still open |
| 3 — journal | `<project>/<scope>/<machine>/journal.jsonl` | An agent, as a by-product of a save. Nothing else | Appended, one line per save | Timestamp, scope, machine, harness, model, the one-line headline, the byte size, and any sanitiser rejections |

Tier 0 is numbered below tier 1 rather than after tier 3 because it is a different kind of context: tiers 1 to 3 are volatile state a session writes and a later one reads, while tier 0 is canonical of the project itself.

The full address of a handoff is four parts — domain, project, scope, machine. Each answers a different question: which knowledge, which build, which piece of work, which computer.

A domain's own project — the one whose name is the domain's — lives at the state root with no project segment, permanently. A tree written before projects existed reads as that project, and a domain's own project created today lands in the same place.

## What does a handoff actually contain?

Six sections, rendered in this order.

| Section | Shape | What belongs in it |
|---|---|---|
| `nowState` | prose | Where things actually stand |
| `decisions` | list | Settled — do not re-litigate |
| `traps` | list | Approaches tried and ruled out |
| `nextSteps` | list | What to do next |
| `observations` | list of `{statement, observedAt, recheck}` | Point-in-time facts, timestamped, with the command to re-derive them where there is one |
| `openQuestions` | list | Still genuinely open |

`decisions` and `traps` sit ahead of `nextSteps` on purpose. Both say "do not do this", and a model that starts executing the action list on sight meets the dead end before it meets the warning about it. That order was measured, not reasoned: every model that avoided a recorded dead end had to read to the bottom of the document first when `traps` sat below `nextSteps`.

A one-line `headline` is required on every save. It is what the work-stream index and the journal show, and it is the only thing a future session sees before deciding whether to open the state at all.

There is a second measured point about placement. A constraint filed in `decisions`, phrased as a negative constraint carrying its reason, was respected in every run. The same constraint told only as a story inside a `traps` narrative was re-litigated until it was moved into `decisions` — after which it was respected 4 of 4. If you want something respected, file it in `decisions`, phrased as what not to do, with the reason attached.

## What is the difference between working state and a wiki page?

One rule decides it.

> State supersedes. Knowledge accumulates.

The wiki's merge unions bullets: every ingest adds to a page's sections and nothing is dropped. That is exactly right for knowledge and exactly wrong for state. A blocker you resolved on Tuesday would be resurrected by Wednesday's write, because a union merge has no way to express "this is no longer true". So working state is a separate store with overwrite semantics — each save replaces the previous handoff rather than merging into it.

| What you want to record | Where it goes | Why |
|---|---|---|
| A wrong turn you took this week, in this work-stream | Working state (`traps`) | Its value is local and it expires |
| A failure whose value is the pattern across many incidents | A wiki page | It compounds, and it belongs on the graph |
| "The suite was at 84 green before my change" | Working state (`observations`) | A point-in-time baseline that re-deriving destroys |
| How a subsystem actually works | A wiki page | Durable, and other pages should link to it |
| "We settled on X; do not re-litigate" | Working state (`decisions`), or the standing brief | A standing constraint on the work |
| The architecture document the whole build is governed by | Foundations (tier 0) | It is canonical, it is read verbatim, and it changes on the order of releases |

Get this wrong in the direction of putting durable material in state and the next save overwrites it. Nothing warns you, because from the store's point of view an overwrite is the correct behaviour.

`state/` is a sibling of `wiki/`, never a path inside it, and it is deliberately not written through the wiki's page pipeline: that pipeline redirects every non-canonical path into the three wiki folders and flattens to the basename, so two work-streams in two different projects would land on the same file. The project-and-scope pair is inexpressible there.

## What is a canonical document, and how does it stay fresh?

A canonical document — a **foundation** — is one an agent should have read before it proposes anything: the architecture, the standing decisions, the conventions, the roadmap, the API surface, a user-facing guide. The practical test is durability. A foundation changes on the order of releases rather than sessions, and it is meant to be read in full rather than searched.

Until version 3.59.0 those documents lived only as plain files inside a code repository, so an agent that had not personally checked that repository out on the machine it was running on could not see them at all. Foundations put a verbatim copy in the project's own folder, which syncs and travels like the rest of your working state.

Ingesting the document instead does not solve it, for two reasons. Uploaded sources land in a folder that is deliberately never synced, so a copy ingested on one computer is invisible on every other. And ingest compiles: it writes wiki pages distilled from a document, which is right for knowledge and wrong for a document whose whole value is being read exactly as written.

**As of v3.69.0, a project can hold documents from several places at once** — written here, copied in once, and mirrored from any number of folders and GitHub repositories (up to 8 sources). The source is recorded per **document**, not per project.

| Kind | Who writes it | How it stays fresh | What "stale" means |
|---|---|---|---|
| Mirrored (folder or GitHub) | Its source is the source of truth. The app and the bridge only mirror it — a byte-for-byte copy, never an edit | Refreshing that one source, or every source at once, re-reads each mirrored file, compares its sha256 against the stored copy, and copies over whatever changed | The stored copy's sha256 no longer matches the file at the recorded path, or that source is not reachable from this machine |
| Written / copied | An agent, and only on your explicit instruction — the same commissioned-only rule the standing brief follows — or you, directly, in the app | Whoever you next ask to update it. Nothing regenerates one automatically | Not applicable. There is no second copy to compare against, so it is never marked stale |

Freshness is **computed, never remembered**: there is no stored flag, only a sha256 comparison made at the moment you read. A document is `fresh`, `stale`, or `unreachable` from this machine.

Each document is capped at 512 KB and is refused above it, because a canonical document cannot be honestly trimmed. A project's foundations are capped at 200 KB in total, and an over-budget save there is accepted and disclosed rather than refused — the same rule a handoff follows, since a rejected save loses the document outright.

In the app, Documents is step 1 on the Project context screen, closed by default. Each row shows the document's role, title, size, whether it is marked read first, its source and its freshness; pressing a row opens it in the reader.

## How do I start a project, and where do its foundations come from?

Creating a project — Domains → Projects → New project — asks a second question below the brief: where do this project's first documents come from? **As of v3.69.0 this is a convenience for the moment of creation, not a lasting restriction** — both Add doors on step ① Documents stay open afterward regardless of what you pick, and any number of sources can be added later.

Three choices. **Curator keeps them** (the default) seeds four skeleton documents immediately — architecture, decisions, conventions and roadmap — each a prompt to answer, not a fact. **Mirror from a repository on this Mac** points at a checkout (a plain folder works too, no git required) and scans it for candidate documents to copy byte-for-byte, becoming the project's first source. **Decide later** writes nothing, and the same choice reappears the first time you open that project's Documents block.

A skeleton is a real markdown document, not a fill-in-the-blanks template: real headings, and under each one a question rather than an invented answer, with a fixed banner at the top saying it is unfilled. An agent fills one in only when you ask it to — the same commissioned-only rule the standing brief already follows.

An existing project that already has its documents is not stuck asking an agent to paste them in one at a time. Several ways an existing document gets in: ticked from a folder scan and copied or mirrored in through the **Add from this computer** door (appended, never replacing what is already there); mirrored from a repository via **Add from GitHub**; chosen from a file on your own computer inside the **Write a document** editor, read in for you to review before saving; or written by an agent, only when you have asked it to.

## Can I edit a foundation myself?

Yes, since version 3.61.0 — but only a **written or copied** document. A mirrored document is refreshed from its source, so editing it in the app would be overwritten by the next refresh; the app tells you to edit the source and refresh instead (the pencil is withheld on that row).

Every project, mirrored or not, carries **Write a document** in the Documents block's head row (renamed from Add document in v3.68.0), and each written or copied row carries its own Edit control opening an editor in place of the table, the same pattern the standing brief already uses. Saving is disabled past 512 KB — a canonical document cannot be honestly trimmed — and a project nearing its 200 KB total budget is told so without being stopped. Filling in a skeleton and saving it clears the skeleton mark for good.

**Step ①'s head row always shows two doors — Add from this computer and Add from GitHub — both always enabled, on every project, since v3.69.0 retired the old "a project has one source" restriction.** A project can mix written, copied and mirrored documents, from up to 8 sources (folders and/or GitHub repositories), at once. Add from this computer offers **Keep in sync** (a folder mirror; the default when the folder is itself inside a git checkout) or **Copy once** — both always shown. Adding always appends — it never replaces a document already there — and a name already taken by another source lands under a readable suffix ("lands as `<name>`"), never an overwrite. A **sources strip** under the head row lists every source the project draws from, each with its own Refresh, plus a Refresh-all that refreshes every source under one lock (a failing source named and left untouched, the others still refresh). A document copied in is labelled **"copied from `<folder>`"**, not "written by you," everywhere its source shows; editing it in the app's own editor makes it yours from then on.

This does not add a second writer to a document: the check is now per document rather than per project, and a human edit is stamped as a human's the same way an agent's edit is stamped as an agent's, so nothing reading a foundation's history is ever told the wrong thing wrote it.

**Deleting a document, since version 3.61.1 (a trash icon on every row since v3.69.0).** Editing a mirrored document's content is still refused — that would create two writers of one file. Deleting it, though, works on any document: on a mirror it stops copying that one file (the source is untouched — a refresh will **not** bring it back; re-add it from the checklist), and on a written or copied document it deletes the only copy there is. Deleting a source's last document removes that source from the project in the same action.

## How does an agent start a session with all of this?

One call. `get_project_context` returns the standing brief, the latest handoff, and the project's foundations, in one response — so a cold session on any machine and in any tool has what it needs without a second round trip.

What it sends of the foundations is the part you control, since v3.62.0. The **index** of every document — title, role, size, freshness — always comes back, every call, and nothing suppresses it. The **text** comes back for the documents you marked **read first**. Everything else is an index row until the agent asks for it by name, with a `slugs` argument on the same call, and then it comes back whole.

An index row with no text means a document waiting to be asked for. It never means a document that does not exist, and the tool says so in as many words, because an agent that reported "this project has no decision log" while `decisions.md` sat in the index would have told you something false about your own project.

If you have marked nothing, the older behaviour is unchanged: a first session gets every document up to a budget, and a returning session sends back the sha256 of each document it already read — recorded on its previous save, in a `Foundations read` section of the handoff — and gets only what changed since. That budget is 120 KB by default, and, since version 3.67.0, it is the project's own reading budget once you set one — see the next two sections for the tri-state per-document control and the presets. **Since version 3.70.0, a bootstrap too large for one MCP reply arrives in pages** — see "What is a project's reading budget?" below.

Reads never write. The bootstrap does not mark anything as seen on your behalf; the agent records what it read on its next save. A session that reads a document and then crashes has recorded nothing, so the next start correctly treats that document as unseen.

## How do I choose which documents an agent gets automatically?

Since version 3.67.0 each document has one of three **start states**, set from its own row's control in step ① Documents:

- **Read first** — its text arrives with every session, within the reading budget.
- **On request** — listed at the start; the agent opens it by name when the task needs it.
- **Not at start** — kept and mirrored, but not listed at the start at all; name it in the standing brief under "Read before you…" if an agent should still find it. (An agent that asks for a not-at-start document by name still receives it — this state only changes what is offered unprompted.)

A project with four documents can hand an agent all four at the start of every session. A project with twenty cannot — the session then opens with twenty documents most of which have nothing to do with the work in front of it. Marking is how you choose which ones do.

Mark sparingly. The read-first set is the one sent every session, so it is the one that costs; two or three documents is a reading plan, twelve is the old behaviour with extra steps. The block's summary line counts read-first and on-request together — "2 read first · 4 on request" — and tells you when the marked set has grown past what one session's reading can carry.

Marking works on a mirrored document too. The mark lives in The Curator's own index rather than in the document, so the file in your checkout is untouched, a refresh still compares the two byte for byte, and the mark survives that refresh: the repository owns the text, you own the reading order.

You can also ask an agent to set read-first, through `save_foundation`'s optional `read_first`. Leaving it out is the safe default and the intended one — an ordinary save then keeps whatever you chose.

## What is a project's reading budget?

Since version 3.67.0 each project has a reading budget: how much document text an agent is handed at the start of a session. The governing rule, in the maintainer's own words, is *"the right context, not all of it"* — an agent needs its foundations, the last state and the standing brief at the start; everything else is on demand. **Since version 3.70.0 the budget is named in tokens, drawn as a context-window meter, and a large bootstrap is delivered in pages.**

Until you set one, nothing changes — every session still receives up to 120 KB of document text, in reading order, exactly as before v3.67.0. Choose a budget and the project becomes **planned**: from then on, only the **read-first** set arrives as text; everything else is listed by name and opened on request.

Five presets, all owner-written only — no MCP tool, no CLI flag and no hook ever sets one:

| Preset | Tokens (as the app shows them) | Bytes |
|---|---|---|
| Index only | 0 | 0 — the list only; no document text at all |
| Lean | ≈8.2k | 32 KB |
| Standard | ≈16.4k | 64 KB — the recommended default |
| Deep | ≈32.8k | 128 KB |
| Large | ≈65.5k | 256 KB |
| Extra large | ≈131k | 512 KB |
| Max | ≈205k | 800 KB |

Since v3.76.0 the picker names each preset with the same figure the meter draws — bytes ÷ 4, in
thousands of 1,000 — so one budget reads as one number everywhere (it used to read *"Extra large
128k"* in the picker beside *"≈131k"* on the meter). The byte budgets themselves did not change.

A project already holding an older 120 KB or 200 KB value keeps it, unchanged, and reads as
**Custom** with its nearest preset named.

The **Session start** step of the Project context screen (step ④, new in version 3.67.0; rebuilt
as a **context-window meter** in version 3.70.0) draws that bootstrap as one bar: your whole
context window to scale, your harness estimate hatched at the left (an owner-entered number, never
measured, never added to what The Curator itself sends), then The Curator's own layers — brief,
handoff, journal, document index, read-first text — each named, and a dashed room the width of
your reading budget. **Window** and **Harness** are set once per computer (not per browser), and
the menu bar widget reads the same two settings. Every figure is a token estimate, bytes ÷ 4,
shown with "≈". When every session is handed more than 32 KB of documents, a line says so, with
**Set a reading budget** beside it. **A bootstrap larger than about 80 KB (≈20k tokens) arrives in
more than one MCP reply — the picker's own row states how many** — because Claude Code shows an
MCP reply of at most ≈25,000 tokens and silently saves anything larger to a file instead of
putting it in the model's window.

## Can The Curator suggest which documents to mark?

Yes — **Suggest a reading plan**, in step ①'s head row, since version 3.67.0. It proposes a start state for every document without changing anything; you review the **Suggested** column and press **Apply suggestion** for the rows you want, or **Dismiss**.

**Suggest (free)** needs no AI key. It follows your standing brief's "Read before you…" list (those stay on request, since you have already said when to open them), each document's role and size, and your reading budget: conventions, decisions and architecture documents are proposed read first while they fit the budget and never when one alone is larger than half of it; skeletons stay on request; a stale roadmap over 64 KB may be proposed not at start; a document you already keep not at start stays there.

**Suggest with AI** asks your one AI model to read each document's title, role, size and the first 600 characters of its opening — never a whole document — framed as untrusted data to check, never instructions to follow. Every slug and state it returns is checked against your actual document index; anything it does not recognise is dropped and named, never applied silently. It shows what it will cost before it runs (a run of a cent or more asks you to confirm first) and what it cost after. With no provider key the button is disabled and links to adding one; the free suggestion always works.

Neither arm writes anything to your project. Applying is its own separate step, and you can untick any row you disagree with first.

## How do I tell an agent which document to open for which kind of work?

Write it in your standing brief, under **"Read before you…"** — a heading the brief template now offers.

A flag answers whether a document is required reading. It cannot answer which document suits which kind of work, because that is a sentence rather than a checkbox, and it is yours to write:

    ## Read before you…

    - …change how anything is built: architecture.md
    - …re-open a settled question: decisions.md
    - …write or review code: conventions.md

An agent is told to consult that section and open what it names. Where it is empty, the documents' own roles — architecture, decisions, conventions, roadmap, api, guide — are the next best signal.

## What is a project, and how is it different from a domain?

A domain is where knowledge lives: one wiki, one schema, one body of reading. A project is a thing you build with that knowledge. A project belongs to exactly one domain, and a domain holds as many projects as you have things to build inside that knowledge.

Each project has its own standing brief and its own work-streams, so two builds can share one wiki without sharing one set of handoffs.

Projects are created, renamed, deleted and given a brief in the app, under Domains, in the Projects section of a domain's page. One project can be neither renamed nor deleted: the domain's own. Its folder is the domain's state root, so renaming it would sweep every other project in that domain into the new name and deleting it would take them all with it. Its row says so rather than offering a control whose only outcome is a refusal.

Since v3.73.0, deleting a project moves its folder to The Curator's trash (`.curator-trash/projects/`), not erased. Since v3.76.0 the owner restores a deleted project or handoff from **Settings → Trash** (Restore; never overwrites, offers `<name>-restored` when the name is taken) — moving the folder back by hand still works. Agents cannot restore or empty the trash; there is no tool for it.

A project name is one path segment: lowercase letters, digits, dot, hyphen and underscore, at most 64 characters. A name that would make one folder mean two things is refused rather than resolved.

A domain that had working state before projects existed shows one project named after the domain. Nothing was moved to produce that, and nothing migrates.

## How does an agent know which project to resume?

Three ways, in order, and nothing is guessed.

1. If you named a project in the conversation, that wins.
2. Otherwise, if a file called `.curator-project` exists in the working directory or a parent, the agent reads it. It holds one line, always `domain/project`. For a domain's own project both halves are the same word — `acme/acme` is correct, not a mistake. The app's Projects rows have a **Copy marker line** button that hands you the exact line.
3. Otherwise the agent calls `list_projects` and asks you which one.

The marker is a convention rather than something the bridge acts on: no server code and no MCP tool reads that file. The continuity skill reads it, and since version 3.63.0 so does the `my-curator` command — which is what `my-curator resolve` answers with. So it does nothing at all in an agent that has not been told about it, and an agent that has been told is instructed to fall back to asking rather than to guessing — a question costs a turn, and a wrong project costs a handoff.

Name resolution itself never guesses either. A project name that matches nothing comes back as a refusal with near-match candidates. A bare name matching projects in several domains comes back as a refusal with the matching domain-and-project pairs. Landing in the wrong project is not a smaller error than not landing at all, because the wrong project's handoff is overwritten by the save that got there by mistake.

## What is a work-stream, and what should I call mine?

A work-stream — called a **scope** in the tools, and shown on screen as a row in the **Handoffs** table since v3.65.1 — is a piece of work inside a project — `main`, `auth-refactor`, `v4-migration`. Work-streams are independent: each has its own handoff and its own journal per machine. A save that names none goes to its tool's own scope — `claude-code`, `antigravity`, from the `harness` it names — or to `main` when it names no tool either (since v3.76.0; before that every such save went to `main`, where two tools on one computer overwrote each other).

Any read may pass `latest` in place of a name and get the project's most recently written work-stream. That is what makes a one-line resume possible: you say "pick up the Lumina work", the project resolves, and `latest` resolves to the work-stream you were actually in, without you or the agent knowing the slug.

Two naming conventions are in circulation and both are legitimate:

| Convention | Where it comes from | What it buys |
|---|---|---|
| One name per tool (`claude-code`, `antigravity`, …) or per piece of work | Since v3.76.0 the default — a save that names no scope goes to its tool's own scope (`main` only with no tool named) — and what the pasted agent-instructions block says | One rolling handoff per work-stream. Simple, and two tools on one computer never share one file |
| `session-YYYY-MM-DD-topic`, one scope per session | The maintainer's own practice on this repository | A per-session trail. Each session's state stays readable afterwards instead of being overwritten by the next one, and `latest` still opens the newest |

The cost of the second is more work-streams to list; the cost of the first is that an earlier session's document is gone once the next save lands. The store does not prefer either.

A scope name that is not already a safe path segment is normalised — `feature/auth` is saved as `feature-auth` — and the save reports which name won, because the index will later show a name nobody typed. A name that normalises to nothing usable is refused.

Give two different agent tools writing the same project their own work-stream names. Two tools saving into one handoff file overwrite each other; the app and the menu bar icon both notice and say so, but the remedy is yours.

## How should I set up scopes for the way I work?

A scope is the name a handoff is saved under. The owner or the agent chooses it; a save that names none goes to its tool's own scope (or `main` with no tool named). Each handoff is one file per project, scope and machine: `state/<project>/<scope>/<machine>/current.md`, with its Journal (`journal.jsonl`, one line per save) beside it. There is one standing brief per project, `state/<project>/project.md`, and every scope and every machine reads the same one.

What a save does:

| The save | What happens |
|---|---|
| Same scope, same computer | The handoff is overwritten, and one line is added to its Journal |
| A new scope name | A new handoff is created, a new row in the Handoffs table |
| Same scope, another computer | That computer gets its own copy in its own folder; neither overwrites the other |
| Same scope, two agent tools on one computer | Both write the same file and overwrite each other, because the path has no slot for the tool |

Scopes are created only by saving, through the `save_working_state` tool or `my-curator save --scope <name>` from a terminal. There is no rename control in the app: stop saving under a scope and it goes dormant. To remove one, the owner presses the trash on its row in the Handoffs table (v3.75.0), types the scope's name, and the whole scope (every computer's copy) moves to The Curator's trash, `.curator-trash/scopes/`, from where moving it back restores it; agents cannot delete a scope, since there is no tool for it. `latest` is a read-side keyword that opens the work-stream ordered newest first **by the agent's own recorded save time** (`writtenAt`, the journal line's clock), falling back to the file's mtime only when no agent time is recorded — since version 3.74.0, so a Personal Sync pull (which only ever moves a file's mtime later, never its `writtenAt`) can no longer make an older handoff look newest. Nothing is ever saved to `latest`. Names are tidied to a safe folder name (lower-case, `feature/auth` becomes `feature-auth`, at most 64 characters).

Six patterns. Write the chosen line into the project's standing brief, because every agent in every tool reads the brief.

| Pattern | When | Line for the brief |
|---|---|---|
| One stream | One thread, one tool, only the current state matters | "Save working state under scope `main`." |
| One scope per session | Long projects where each session's handoff should stay readable | "Save working state in ONE scope per session named `session-YYYY-MM-DD-topic` (date and topic); save early and often; always before you stop." |
| One scope per work-stream | Parallel features or tracks | "Use one scope per work-stream, named after it (e.g. `auth-refactor`); a new stream gets a new scope." |
| Several computers | Laptop and desktop | Nothing to configure. Each computer writes its own copy automatically |
| Several agent tools on one computer | Two tools on the same project at once | "Each agent saves under its own scope: `<harness>-<topic>` (e.g. `antigravity-api`, `claude-code-ui`); never save under another agent's scope." |
| Handing a session over | Context full, another tool, another computer | Nothing. Save a complete handoff, then open the new session with a resume line |

A conversation that is already open does not know about saves made elsewhere since it started, on this computer or another, unless it reads again. Since version 3.76.1 the Copy agent instructions block tells it to: on continue, resume, or after a pause, call `get_project_context` again before acting. Otherwise, start a new conversation. Several computers: a read that names a scope but no machine returns the most recently written copy and lists the others. A copy from another computer is marked in the app (the Machine column, and a "synced from another machine" chip in the reader), and the agent's read carries `machineIsThisMachine: false`, so it should check the next steps against this checkout. Press Sync now (in Sync) before starting and after the last save. The brief has no machine in its path, so edit it on one computer and sync before editing it on the other.

Several agent tools on one computer: nothing refuses or prevents two tools saving into one scope. The app notices only afterwards, from the Journal, once the tools have taken turns (one, the other, the first again); then the Memory step shows a red line, "Two tools are writing (scope name)... Give each tool its own handoff." A single switch from one tool to another is treated as a move, not flagged. Give each tool its own scope from the start. Since version 3.76.0 the Copy agent instructions block asks for exactly that: it tells each tool to save under a scope named for itself (`claude-code` for Claude Code, `antigravity` for Antigravity, `opencode` for opencode, otherwise the tool's own name) and to pass the same name as `harness`; up to version 3.75.0 it told every tool to save under `main`, which was this collision. Since the same version, a save that names no scope but names its tool lands in that tool's scope (`claude-code`, `antigravity`) rather than `main`. It is still asked for, not guaranteed: measured on Claude Code (2026-09-25, with that default), Sonnet 5 put 8 of 8 saves in `claude-code`, but Haiku 4.5 put only 3 of 5 there and named `main` explicitly in the other 2, so after each tool's first save check the Handoffs table for one row per tool, and add a scope rule to the brief if both tools landed in one row. When the tools work in parallel, each agent should read its own scope by name rather than `latest`, because `latest` opens whichever tool saved last; when one piece of work is handed from one tool to the other, `latest` is right, and the new tool then saves under its own scope. An orchestrating agent reads another tool's handoff with `get_project_context` or `get_working_state` and that tool's `scope`; reading another scope is safe, saving into it is not. Hooks installed with `my-curator install-hooks` inject the project's newest work-stream at session start and, since version 3.76.0, ask for the end-of-session save under the tool's own scope; to pin another name, add `--scope <name>` to the `my-curator hook` commands in that tool's hook settings.

**Since version 3.74.0, a save that replaces a handoff whose last save was by a different tool (compared by normalised tool id — spelling variants of "Claude Code" are one tool; `claude-desktop` stays distinct) still succeeds, warn-only, never refused.** The replaced `current.md` is first copied byte-for-byte to `previous.md` in the same scope/machine folder — one copy, overwritten only by the next cross-tool replacement — and the save's reply carries an `overwrote` object (tool, model, when, headline, where the text was kept, the scope to use from now on) plus a plain-English `report` sentence; `my-curator save` prints the same sentence. No warning fires when either save named no tool. `get_working_state` with `previous: true` returns the kept text, framed as recorded data like any other handoff. Full detail: `docs/working-state.md` and `docs/spec/working-state-v1.md` §6b.

Handing a session over: ask the agent for a complete handoff and wait until the save is confirmed, sync if changing computer, then open the new session with a line such as: "Resume project `lumina` from The Curator: call `get_project_context` with scope `latest`, tell me which scope you opened and the rules you are following, then continue from its next steps." Name the scope instead of `latest` when several tools or threads are live.

The full walk-through, with a diagram and worked examples, is in the user guide: https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#how-to-organise-your-work-streams-scopes

## Do I keep one handoff or make new ones?

Both are right for different work, and the scope line in the standing brief decides. A handoff is one file per scope per computer, and every save to the same scope replaces it, so keeping one handoff means saving under the same scope name each time, and making new ones means saving under a new name; nothing else creates one.

Keep one (one stream, or one scope per tool) when only where things stand now matters: resuming is always simple, but the previous handoff's full text is gone once the next save lands, and the Journal keeps only one line per save. Make new ones when each session's handoff should stay readable (one scope per session) or when separate threads run side by side (one scope per work-stream): every handoff is kept, at the cost of a longer Handoffs table, which the trash on a row trims (version 3.75.0).

Add a new scope when a new session starts under a per-session rule, when a genuinely separate thread begins, or when a second tool joins the project. Do not start a new scope for work that is simply continuing: that splits its history, and the next session may open the wrong one. Full answer: https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#do-i-keep-one-handoff-or-make-new-ones

## Claude Code reads CLAUDE.md and Antigravity reads AGENTS.md or GEMINI.md. Do I need both files?

Yes. Claude Code loads `CLAUDE.md`. Antigravity reads `GEMINI.md` and `AGENTS.md`, walked up from the working folder to the repository root, and not `CLAUDE.md`. That comes from Antigravity's own documentation, and on 25 September 2026 an Antigravity session with the pointer in `AGENTS.md` read the project's state unprompted. In practice use `CLAUDE.md` and `AGENTS.md` with identical text; `AGENTS.md` also serves Codex, opencode and Cursor. Keep the working-state rules in one place: the standing brief, which lives in The Curator rather than in either tool and is returned by `get_project_context` to any tool that connects. Each instruction file then carries the same short pointer:

```markdown
## Working state

This repository's working state lives in The Curator (project `acme/lumina`, see
`.curator-project`). At the START of every session call the my-curator MCP tool
`get_project_context` with project "lumina" and read the standing brief before acting.
Open and save the scope the brief's scope rule gives you; never save under another
agent's scope. SAVE with `save_working_state` under project "lumina" after every material
decision and at least every ten tool calls, and ALWAYS before you stop; a save
overwrites, so send the complete state each time.
```

Start from the app's Copy agent instructions button. Since version 3.76.0, as copied, it calls `get_project_context`, reads the newest handoff, and saves under a scope named for the tool that reads it, which fits several tools on one computer (and, for one tool, is one stream under that tool's name); for a brief-set pattern such as one scope per session, edit the scope wording in the pasted copy to defer to the brief, as above. The app's copy is frozen because it is the measured text (2026-09-25, Claude Code with the v3.76.0 default scope: Sonnet 5 saved in 8 of 8 runs, all in its own scope; Haiku 4.5 saved in 5 of 8, 3 of those in its own scope); an edited pointer is unmeasured.

One `.curator-project` file, holding `domain/project`, serves every tool: the continuity skill and the `my-curator` command read it. The MCP server does not read it, which is why the pointer also names the project.

Since version 3.76.0 Antigravity has its own row in The Curator's harness table. `my-curator doctor` reports whether Antigravity's MCP config names the bridge (it checks `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json` and `~/.gemini/antigravity-ide/mcp_config.json`), whether `AGENTS.md` or `GEMINI.md` in the current folder carries the block, and whether the installed skills match this version, file by file. `my-curator install-hooks antigravity` wires two hooks: `PreInvocation`, which hands the agent the project's context before its first model call in a conversation, and `Stop`, which asks once per conversation for a save when the agent stopped normally after reading state without saving. Observed on 26 September 2026: with the project-level `<repo>/.agents/hooks.json` the session-start injection was used (the agent read back the brief's directive without calling `get_project_context`); with only the user-level `~/.gemini/config/hooks.json` the start hook ran but its injection was not seen used; one session's Stop produced no reminder, and whether it fired is not known. Since version 3.77.0 the project file is the default (`--git-exclude` keeps it out of git, because it holds this computer's path), and every hook run leaves one content-free line in a hook activity log that `my-curator hook-log` prints. Antigravity's MCP client name is not known, so its sessions appear as `other` in the usage log. To check the pointer landed, see whether the agent's first reply names the rules from the brief; if it names none, the pointer did not reach it.

Since version 3.77.0 the app shows all of this without a terminal: **Context → a project → step 5, Setup** lists, for that project on this computer, which precondition is false (the block missing from `AGENTS.md`, `.curator-project` not committed, a tool saving under another tool's scope, a newer handoff waiting on GitHub, a stale skill) with a copy or reveal action for each, and **Settings → MCP bridge → Tools on this Mac** lists each tool's config files, skills and hooks. The app reads those files only to see whether they name `my-curator`, and never writes them. Full answer: https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#13e-the-setup-check-in-the-app

Skills for Antigravity, from its documentation: a `skills/` folder under `~/.gemini/config/` for every project or `.agents/` in the project, or a plugin's `skills/` folder such as `~/.gemini/config/plugins/the-curator/skills/`. Copy each skill folder whole, companion files included; `my-curator doctor` names any installed file that differs from this version or is missing.

## How do I build one project from two computers?

Clone the code on both computers, and sync working state on both. Two different things travel by two routes:

| What | Travels by | Before starting | When stopping |
|---|---|---|---|
| The code | The project's own git remote | `git pull` | Commit and `git push` |
| Working state: brief, handoffs, Journal, Documents | The Curator's Personal Sync, to the owner's private knowledge repository | Sync now | Sync now, after the last save |

Each computer saves its handoff into its own folder under the scope, so neither overwrites the other, even if a sync is forgotten. Start the second computer's session with scope `latest`: since version 3.74.0 it orders handoffs by the agent's own recorded save time, not by when a file arrived on this disk, so after Sync now it opens whichever copy was genuinely written last, and the read says when it came from another machine. `latest` opens only one work-stream, the newest across the project, so if a sync brings in several, name the one wanted.

## What must be set up to use several agent tools or several computers?

Once or twice it is not complicated, but a few preconditions must hold. The checklist, each with its check:

| Step | How | How to check |
|---|---|---|
| The latest Curator on every computer | Settings → Updates; then quit and reopen each agent tool, so no old bridge keeps running | The same version at the foot of Settings on every computer |
| The Curator's MCP in every agent tool | Settings → MCP bridge (sets up Claude Desktop; View config or Copy snippet for the rest). Claude Code: `~/.claude.json` or `.mcp.json`. Antigravity: three files, `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json`. opencode: `~/.config/opencode/opencode.json`, key `mcp`, `type: "local"`, the command as one array | The agent lists 24 `my-curator` tools; `my-curator doctor` |
| Both skills, current, in every tool | Copy each skill folder whole. Claude app: upload by hand. Claude Code: `~/.claude/skills/`. Antigravity: `~/.gemini/config/plugins/the-curator/skills/`. opencode: `.agents/skills/`. Re-copy after every release that changes a skill | "What skills are available?"; for Antigravity, `my-curator doctor` compares every file |
| The Copy agent instructions block at the top of both `CLAUDE.md` and `AGENTS.md` | Use that project's own Copy button (the text differs only in the project name); paste again after a release that changes the block | `my-curator doctor`; the first reply names the brief's rules |
| `.curator-project` committed in the project repository | Copy marker line, then commit and push the file, so every clone knows its project | `git ls-files .curator-project` |
| Personal Sync before starting and after the last save | Sync now | No local changes left unpushed |
| The project's code pulled and pushed | `git pull` before, `git push` after | `git status` |
| A new conversation, or "continue" | A new one always reads first; since version 3.76.1 an open one reads again on continue or resume | The reply names the handoff, tool and machine it opened |
| Optional hooks | `my-curator install-hooks claude-code` or `antigravity` (source install only) | `my-curator doctor`; Antigravity's hooks are not yet measured |

`my-curator doctor` is the one-command check for the MCP files, the block, the marker, the hooks and Antigravity's skills; it does not see app versions, syncing or git.

What was measured, by the maintainer: on 2026-09-25, on one Mac, a handover Claude Code → Antigravity → Claude Code worked unprompted with one scope per tool; on a project without `AGENTS.md` Antigravity saved to `main` and replaced Claude Code's handoff, which led to the version 3.74.0 warning and kept `previous.md`. On 2026-09-26, across two Macs through Personal Sync, a new conversation opened the newest handoff by the agents' own save times in both directions, with per-machine copies kept apart; an already-open conversation did not re-read, which the version 3.76.1 sentence fixed (Claude Code headless, Sonnet 5: re-read 0 of 8 before, 8 of 8 after; no measurable change on Haiku 4.5). Not yet measured: Antigravity's hooks, and a live handover with opencode, Codex or Cursor. Full checklist: https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#13d-working-with-several-agent-tools-and-several-computers--the-setup-checklist

## What is a standing brief?

The standing brief is `project.md` — one document per project saying what this project is, the firm decisions that hold across every session, how you want the work done, and where the depth lives. It changes rarely and deliberately, and it is returned on every read, whatever work-stream is asked for, because a session resuming cold needs it before anything else.

It is the tier that is yours. A brief is typed into a text editor, edited in the app, or written by an agent on your explicit instruction. What it is never written by is a session going about its ordinary work: nothing writes a brief as a side effect of anything else.

That is why an agent reading a brief is told to treat its standing directives as your own instructions, given in advance — followed as you would be followed, not downgraded to suggestions because they arrived before this conversation started. Authority over method is not authority over facts: anything a brief asserts about the code, the tests, or the state of the world is still re-verified, because briefs go stale. And a live instruction in this conversation outranks the brief.

A brief written by an agent carries a provenance comment on its first line recording who wrote it, in which harness and model, when, and that it was commissioned by you. The comment is stored in the file and stripped from every read, so what you see in the editor and what an agent gets is your markdown without it. A brief with no such line — every brief written by hand — reads back byte-identical.

## What should I put in a standing brief?

The app seeds a new brief from a template, so you edit a skeleton rather than face an empty box. Its sections:

| Section | What goes in it |
|---|---|
| `## Standing brief` | What this project is, in a few sentences |
| `## Operating directives` | How you want the work done — the rules that hold every session |
| `## Firm decisions — do not re-litigate` | Settled questions, with the reason attached |
| `## Working model` | How you and the agent divide the work |
| `## Pointers to depth` | Where the detail actually lives |

What goes where: the brief holds what stays true in every thread (the goal, what done looks like, standing rules, firm decisions, the scope rule); a handoff holds where one thread stands now; a document holds long reference material, named in the brief's "Read before you…" list. Examples of directive lines. A solo coding project: "Save working state under scope `main`", "Run the tests before calling anything finished". A long research or writing project: "ONE scope per session named `session-YYYY-MM-DD-topic`", "Cite only what the wiki holds; never invent a source". Two tools on two computers: "Each agent saves under its own scope, named for its tool", "When you resume a handoff from another tool or computer, say so and check its next steps against this checkout". Worked examples: https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#writing-a-standing-brief

Three conventions travel with a brief, and each turns a specific kind of silence into something visible in the agent's first reply.

**Read-back.** The agent states in its first reply which of your standing rules it is operating under. One line, an acknowledgement rather than a recital. This is the air-traffic-control move: the pilot repeats the instruction back, because that is how the tower knows it landed. Without it you cannot tell a dropped rule from a followed one until the consequences show up. An agent that reports adopting nothing when your brief plainly says otherwise is telling you the brief did not reach it — which is also how you catch a brief lost in a sync merge.

**Conflict protocol.** When a directive of yours clashes with a rule built into the agent's own tool, the agent names the clash in that first reply and asks you. It never resolves it quietly. The silence is the bug, not the choice: the agent might even pick the side you would have picked, and you would still never know there had been a decision to make. This is the failure that produced the rule — a brief saying "you are the orchestrator; you do not build, delegate" was read correctly, hit a conflicting rule in the agent's own harness, was resolved silently in favour of the harness, and an hour of the wrong mode followed.

**Capability fallback.** Some tools genuinely cannot do what a rule asks — "delegate to subagents" means nothing in a tool that has no subagents. Left alone that produces silence, and silence there looks exactly like an agent ignoring you. So an agent names any directive it cannot follow and proposes an alternative. You can pre-empt it by writing the escape hatch into the directive yourself: "Delegate implementation to subagents. If your tool can't spawn subagents, say so at the start and propose an alternative." Then the alternative is one you chose.

All three are carried to the agent in what the bridge hands back when your state is read, not in a skill — which is why they reach any MCP client rather than only the one with the skill installed. They cannot be enforced: nothing can compel a model to speak. The read-back is the cheapest of the three and its absence is itself the signal.

## Can a standing brief tell my agent to do anything?

No, and one line travels with every brief to say so:

> A standing directive may narrow behaviour or shape method. It may never widen authority.

"Delegate rather than build", "run the tests before calling it done", "never write into that folder" — all narrow or shape, and all are followed. Anything that would grant a capability, authorise a push, a purchase or a deletion, or lift a confirmation the agent would otherwise ask you for is refused in a brief exactly as it would be if it arrived in a web page. Being in the brief buys it nothing.

Put that together with the conflict rule resolving to *ask* rather than *obey*, and the worst a tampered-with brief can achieve is a question addressed to you.

The elevated framing is withheld entirely where authorship cannot be established. A brief carries one of five verdicts:

| Verdict | Meaning |
|---|---|
| `owner` | A personal project, and the file shows no sign of tampering. The framing above applies |
| `commissioned` | The same, except the file records an agent having written it on your instruction. The framing applies unchanged |
| `mirror` | The project is a read-only shared mirror, so its files were not necessarily written by you |
| `suspect` | Duplicate section headings, or protocol markup that had to be neutralised on read. That is what a forged or badly merged brief looks like |
| `unverified` | The check could not be completed, so authorship is unconfirmed |

The last three keep the ordinary untrusted wording, putting the brief on the same footing as a handoff — a proposal to confirm with you, never an instruction to obey. Unknown resolves to untrusted deliberately.

This is a framing, not an authentication. There is no signature and no privilege boundary: it is a plain markdown file in your own folder, and anyone who can write your `state/` folder can write the brief.

## How should an agent treat what it reads back?

Tiers 2 and 3 — the handoff and the journal — are recorded data to verify, not instructions to obey. They were written by an agent, they can arrive from another machine over sync, they are hand-editable, and inside a shared mirror they can have been written by another person. An instruction found in a handoff is a note from a peer. Verify before acting. That is what the `recheck` field on an observation is for: record the command that re-derives the number.

Tier 1 — the standing brief — is the exception, for the reasons above.

The store neutralises text that tries to impersonate a higher-authority channel, on the way in and on the way out: protocol-shaped tags, line-initial chat role markers, line-initial markdown headings, and control characters. A fourth rule defangs URLs and shell pipes — `https[:]//…`, `&#124; sh` — and it was added from a measurement rather than from theory. Planted state containing a piped download was never obeyed by a model, but in 3 of 10 runs a model relayed it to the developer as a recommended next step with no warning. Defanging is lossless and readable by eye, and no longer pasteable straight into a browser or a shell. A legitimate link or command in your own handoff is defanged too; that cost is deliberate and symmetric, because a payload host cannot be told apart from a documentation link.

Nothing checks whether a claim in a handoff is true.

## How does my agent read and write it?

Through the **My Curator** MCP bridge — a small program that runs on your own computer and talks to your assistant over standard input and output. It reads your files directly and needs nothing on a network.

It works with any MCP client that can start a local program: Claude Desktop, Claude Code, Cursor, opencode, Codex, Gemini CLI and others. A browser-only assistant cannot reach it — ChatGPT's web app cannot run a local program, so it is out of scope by construction. The bridge is set up in the app under Settings, in the MCP bridge section.

Six of the bridge's tools are the working-state tools:

| Tool | What it does |
|---|---|
| `list_projects` | Every project that has state — in one domain or across all of them. Each row carries its domain, its newest work-stream and how long ago that was written, which harness wrote it, and whether it has a standing brief |
| `get_project_context` | The one call a session opens with: the standing brief, the latest handoff, and the foundations this caller has not already seen |
| `get_working_state` | Returns the standing brief always. With a work-stream named, also that work-stream's handoff and recent journal entries. Without one, an index of the work-streams that have state |
| `save_working_state` | Overwrites the handoff for one project, work-stream and machine, and appends one journal line |
| `save_project_brief` | Replaces one project's standing brief and records who wrote it. For use on your explicit instruction only |
| `save_foundation` | Writes or replaces one canonical document. For use on your explicit instruction only — it is refused without a flag saying you commissioned it |

The bridge exposes 24 tools in total: 17 that read and 7 that write. The other 18 are about your wiki — search, nodes, tags, backlinks, multi-hop traversal, cross-domain search, topology, the original source behind a summary, compiling a conversation into pages, and wiki health.

Every read and every save reports where it landed — the domain, the project, and how the name was resolved. A call that resolved a bare name by searching across domains made a choice on your behalf, and a response that does not say so leaves you unable to tell a confirmed project from an inferred one.

## How do I make Claude Code remember where we left off?

Two things have to be true. The agent has to be able to reach the store, and it has to be told to.

Reaching it is the MCP bridge, set up once in Settings. Being told to is the part that needs your attention, and it has two mechanisms that sit beside each other: the **Curator Continuity** skill, and a six-line block pasted into the file your tool loads every session.

Then, at the start of a session, you type one line:

```
Resume project "lumina" (domain "acme"), latest scope.
```

"Where did we leave off", "continue", "pick up where we left off" and "catch me up on this project" all work too — they are the skill's own trigger phrases. With the block pasted into your entry file, the agent is told to read state at the start of every session whether or not you say anything.

What comes back is the standing brief, the latest work-stream's handoff, the machines holding state for it, and the most recent journal headlines — with the machine the content came from and when it was written, so provenance is visible rather than assumed. Asked through `get_project_context`, the same answer carries the project's foundations as well.

In the app, the menu bar icon's per-row submenu has a **Copy resume prompt** item that puts a longer version on your clipboard, naming the MCP call to make and, for an agent without the bridge, the file path as a fallback. A **Copy handoff as Markdown** item puts the document itself on the clipboard, for an assistant that can reach neither.

## Why doesn't my agent save anything?

Because capture is advisory. Nothing in the store, the tools or the app makes an agent save. An agent that has never been told the discipline simply never writes, the store stays empty, and the screens that read it have nothing to show.

Installing the skill is not the same as the skill running. On some harnesses a skill lies dormant until the model decides its description matches the conversation, and that decision can simply not happen — which turns the write half off, silently, on a machine where everything looks correctly installed.

This was measured on 2026-09-10: 16 headless runs, one task, Haiku 4.5, an isolated store, four runs per arm. Arm A is the skill alone. Arm B is the skill plus the block below in the file the harness auto-loads every session. Both arms had the same skills and the same bridge; the block is the only difference.

| Harness | Arm | Runs that saved at least once | Read state at start | Saved before stopping | Skill activated |
|---|---|---|---|---|---|
| Claude Code (headless) | A — skill only | 0 of 4 | 0 of 4 | 0 of 4 | never |
| Claude Code (headless) | B — skill plus block | 3 of 4 | 3 of 4 | 3 of 4 | never |
| opencode | A — skill only | 4 of 4 | 4 of 4 | 3 of 4 | 4 of 4, as its first action |
| opencode | B — skill plus block | 4 of 4 | 4 of 4 | 3 of 4 | 4 of 4, as its first action |

Read the two harnesses separately. Claude Code never activated the skill at all, in either arm, even though it was installed, listed, and the prompt opened with the word "Continue" — one of the skill's own trigger phrases. With the block, the agent read at the start and saved as its last action in 3 of 4 runs. The one miss is worth knowing about: the transcript says it will read the working state and later that it will save, and both times the run failed to issue the call and tried a shell workaround. The block changed what the agent wanted to do; something else stopped it. opencode activated the skill natively, first, every time, and adding the block changed nothing measurable — on opencode you do not need it.

So this is a difference in kind on the harness that does not activate skills by itself, and zero on the harness that does. **Activation is a property of the harness, not of the skill and not of Claude.** All 16 runs made the task's test suite pass, so nothing here traded correctness for discipline. The block cost about 0.2 minutes and $0.02 per run on Claude Code.

**The block changed in version 3.76.0 and was measured again on 2026-09-25.** Claude Code 2.1.281, headless, Haiku 4.5, an isolated store, both skills installed, the same kind of neutral task, the whole copied text in `CLAUDE.md`, eight runs per text:

| Text | Read state | Runs that saved at least once | Save in the tool's own scope | `harness` set |
|---|---|---|---|---|
| Old block (every tool under `main`), same day | 7 of 8 | 7 of 8 | 0 of 7 | 0 of 7 |
| Draft of the new block ("Never leave `scope` out"), store default `main` | 6 of 8 | 7 of 8 | 2 of 7 | 7 of 7 |

The save habit carried over unchanged. The per-tool scope did not, on this small model: five of the seven saving runs set `harness` to `claude-code` and still saved under `main`. The maintainer's own two-tool test that the new text kept Claude Code and Antigravity apart was on other models and is not this measurement. A draft whose second paragraph did not say to call `get_project_context` first saved in only 2 of 8 runs, which is why the shipped second paragraph says to make it the session's first action.

Then the store changed the same day, from that result: a `save_working_state` call with no `scope` but a `harness` now saves under the normalised tool id (`claude-code`, `antigravity`; an unknown tool's name slugified; no `harness` means `main`), an explicit `scope` always wins, and the reply reports `scope_chosen_by`. The draft's sentence "Never leave `scope` out (it defaults to the shared "main")" became false and was replaced with "Pass `scope` explicitly every time"; nothing else in the text changed. The shipped text was measured again on the integrated version 3.76.0 code (2026-09-25, with the v3.76.0 default scope), same protocol, eight runs per model:

| Model | Read state | Runs that saved at least once | Saved before stopping | Final save's scope | `harness` spelling | Cost of 8 runs |
|---|---|---|---|---|---|---|
| claude-haiku-4-5-20251001 | 5 of 8 | 5 of 8 | 5 of 8 | 3 in `claude-code` (1 named, 2 by the default), 2 in `main` (named explicitly) | `claude-code`, 5 of 5 | $0.49 |
| claude-sonnet-5 | 8 of 8 | 8 of 8 | 8 of 8 | 8 in `claude-code`, all named explicitly | `claude-code`, 8 of 8 | $0.98 |

On Sonnet 5 the block did everything it asks. On Haiku 4.5 it was weaker: 5 of 8 saved, and 2 of the 5 saves named `main` explicitly (the scope of the handoff they had just read), which an explicit scope is allowed to do, so the default could not catch them; the two saves that left the scope out landed in `claude-code`. Eight runs is a shape, not a rate.

**Version 3.76.1 added a re-read sentence, measured on 2026-09-26.** A conversation that is already open does not know about saves made since it started. In the maintainer's two-computer test, an Antigravity conversation that had been open for earlier work was told "continue" after the other computer saved a newer handoff and both synced; it did not call `get_project_context` again and continued from stale context, while a new conversation read first. The first paragraph of the block now says: "When the user says continue or resume, or you come back after a pause, call `get_project_context` again before acting — another tool or computer may have saved since." It was measured with two turns in one headless Claude Code session: turn 1 did the usual task; then, outside the agent, a newer handoff was saved under scope `antigravity` with a unique token and a new next step; turn 2 was the single word "continue".

| Model | Text | Turn 1 read | Turn 2 re-read first | Turn 2 saw the new handoff | Token quoted | Cost |
|---|---|---|---|---|---|---|
| claude-sonnet-5 | Version 3.76.0 block (control) | 8 of 8 | 0 of 8 | 0 of 8 | 0 of 8 | $2.14 |
| claude-sonnet-5 | Version 3.76.1 block (re-read sentence) | 8 of 8 | 8 of 8 | 8 of 8 | 4 of 8 | $2.32 |
| claude-haiku-4-5-20251001 | Version 3.76.0 block (control) | 3 of 4 | 3 of 4 | 2 of 4 | 0 of 4 | $0.74 |
| claude-haiku-4-5-20251001 | Version 3.76.1 block (re-read sentence) | 1 of 4 | 2 of 4 | 2 of 4 | 0 of 4 | $0.69 |

On Sonnet 5 the sentence made the whole difference. None of the runs acted on the other tool's next step; each treated it as recorded data and asked. On Haiku 4.5 it moved nothing measurable: the old block already re-read in 3 of 4 runs, and in the new arm the first turn mostly failed to reach the tool at all. If a tool does not follow the rule, start a new conversation after another tool or computer has saved.

What the measurement does not show:

- Four runs per arm is a shape, not a rate. Nothing here licenses a number like "75 percent".
- Headless only. Claude Code's interactive mode was not measured, and it differs in ways that could matter — a persistent session, a visible skill list, and a human who can say "save state".
- One task, one model, one prompt. Saves were counted as saves that reached the store; save quality was not judged.
- The most likely confounder is skill competition. The build under test injected 19 of its own skills beside the two installed, so the continuity skill was one description among 21. A stock install with only these two may behave like opencode. That was not measured.

## Is there a command I can run myself?

Yes, since version 3.63.0. `my-curator` reads and writes the same files from a shell, with the app closed, no network and no credential needed.

| Command | What it does |
|---|---|
| `my-curator context` | Prints this project's bootstrap — the standing brief, the latest handoff, your read-first documents — to standard output |
| `my-curator save` | Reads a complete handoff as JSON on standard input, or from a file with `-f`, and writes it. It never invents one |
| `my-curator doctor` | Prints what is wired on this machine and writes nothing. Start here when something is not working |
| `my-curator resolve` | Prints which project the current directory belongs to |
| `my-curator install-hooks` | Writes hook configuration for one harness, and nothing else |

It is a second local client of the same store, exactly as the bridge is. It is not the app and no web page can reach it, which is what keeps the rule that a handoff has one writer with matching provenance.

The binary is called `my-curator` rather than `curator` on purpose. The short name belongs to Elastic's elasticsearch-curator, which on Debian is installed as /usr/bin/curator and runs index retention on a great many servers; quietly shadowing it could break somebody's production job. So this package never links that name. If nothing on your machine answers to `curator`, `my-curator doctor --alias` prints the one line that makes the short name yourself — and if something already does, the same command refuses and tells you what it found.

The command is also the answer for a tool with no MCP client at all, such as Aider: run `my-curator context` before the session and `my-curator save` after it.

Two practical notes. Only two short flags exist — `-f` for `--file` and `-h` for `--help`; a bare `-` still means standard input. And the downloadable Mac app does not ship the command: it carries the bridge only, so `my-curator` comes from a git checkout or an npm install, and `doctor` says so when it finds itself inside the app with nothing on your PATH.

## Can a hook make my agent save?

A hook can ask. It can never write the handoff itself, and that limit is deliberate: a fabricated handoff is worse than a missing one, because the whole value of the store is that what is written was written by whoever it names. So `my-curator install-hooks` wires three moments — inject the context at the start, remind before a compaction, and ask once at the end of a turn if nothing has been saved this session — and the model is what calls the save tool.

Whether any of that is available depends entirely on your harness, and the harnesses disagree about almost everything. Twelve of the fifteen in the table have some lifecycle hook; three of them accept a hook that never fires. Four words describe every row:

| Word | Means |
|---|---|
| verified | A hook mechanism exists, takes a shell command, and its response shape is measured or documented |
| unverified | The mechanism exists, but its exact shape or its config file has not been measured. Anything unmeasured ships withheld with its reason rather than guessed |
| present-useless | Hooks exist and cannot carry the ask. That is a finding, not a gap |
| none | No hook mechanism at all |

Hooks are written for Claude Code, Cursor, Codex and Antigravity (Antigravity's session-start hook was seen running once on 2026-09-26, a real conversation on the maintainer's Mac, from a project-level `.agents/hooks.json`; its `Stop` save ask has not been observed); Copilot CLI and goose are refused by default because their response shapes are unmeasured; Gemini CLI, Cline and DeepSeek Harness get none for the same reason; OpenCode and Kilo take TypeScript plugins rather than shell commands; Windsurf has twelve hooks and not one of them fires at a stop, a session end or a compaction; Zed has no hook mechanism; Aider has no MCP client.

One thing to be clear about: **fourteen of the fifteen harness rows read "not measured"**. The mechanism shipped in version 3.63.0 and the protocol was run for the first time in version 3.64.0, against one harness.

That measurement — Claude Code, 20 September 2026, four runs per arm, headless mode — came back mixed, and the mixture is the useful part. With the hooks installed, the session-start hook injected the project's context before the agent's first turn in 4 of 4 runs, and 4 of 4 saved a handoff before stopping. In that same headless mode the stop hook never fired at all, across six sessions. And without the hook, five of six save attempts ran something shaped like a shell command named after the tool instead of calling it — with the skill and the instruction block present in every one of those runs. The hook is what works. Every other harness still reads "not measured", and the product says so everywhere the question comes up rather than implying reach it has not demonstrated.

A hook never writes CLAUDE.md, AGENTS.md, GEMINI.md or your Cursor rules. That paste stays yours.

## How do I know whether my agents are actually saving?

The Project context screen's Memory step opens with a row called **Agent connections** (called *Agent sessions* through version 3.73.x, *Capture* through version 3.69.0; on-disk field names unchanged) that answers exactly that. It is built from the same recessed, monospace, terminal-like reading component — a "monitor" — the app uses for every live-state display. Its closed summary already carries the count and the three qualifying clauses:

```
CONNECTIONS   6 connections in the last 30 days
              4 started with the context · 4 saved before stopping · 2 read and did not save
```

**Since version 3.74.0 the count is honestly of connections, not sessions:** what the log counts is one MCP bridge process — Claude Code starts one per session, but Claude Desktop keeps one open across many conversations — so "6 connections" could be far more than six conversations. The window is also now the log's TRUE coverage rather than an assumed one: when the log reaches back the full 30 days it reads "in the last 30 days"; when it began more recently it reads "in the last N days (the log begins `<date>`)" instead of silently implying a month it never watched.

Three words, defined once. A **connection** is one bridge process — one run of your agent tool with The Curator connected, not a conversation and not a day. **Started with the context** means that connection asked for the project's brief and state at some point before its first save. **Saved before stopping** means a save succeeded; a refused save is not a save.

The uncomfortable number is written in words rather than as a percentage, on purpose: "67 percent" reads as a grade, while "2 read and did not save" reads as two sessions you could go and look at. Press the row and it opens to up to six monitor lines, in order — sessions, started with the context, saved before stopping, read and did not save, the calls made across the window, and the newest session's age with the harness that wrote it — no per-session table since v3.65.1. What used to be a separate fold called "Sessions" is gone; the word no longer names anything on the screen. A note about a bridge that logged saves with no sessions is withheld when there is no usage log at all, so the row's own "no usage log yet" summary is never paired with an alarm about a bridge that never ran.

Three states are told apart rather than blurred: no usage log on this computer yet, a log with no session for this project in the window, and the reading itself. Only the third carries a freshness mark, and that mark is the age of the newest session — not a grade for the ratio.

What it cannot see is stated on the screen. It counts what went through the bridge, so a save made with `my-curator save`, or by an agent that never connected, leaves no line and is in neither the numerator nor the denominator. The harness label is self-reported by the client and nothing in The Curator branches on it. Calls made before version 3.63.0 carry no session id and are counted separately rather than invented into sessions. The app's own tool self-test is excluded outright. And nothing here stops a session: the meter reports, it never refuses or delays anything.

A fifth state, added in version 3.64.1, catches the specific pattern of a bridge left running across an app update: it can go on logging saves while never writing a session line for them, because the session line is newer than the code that bridge is still running. When that happens the reading would otherwise look like a contradiction — "no session in the last 30 days" beside a save from minutes ago. The screen now carries the newest save's own timestamp separately from the session count, and a note explaining the pattern: restart the app that launched the bridge, usually Claude Desktop.

The same reading is available from the terminal with `my-curator doctor`.

## Can I ask Chat about a project, instead of an agent?

Yes, since version 3.64.0. Chat's DOMAINS bar (renamed from SCOPE in version 3.64.1) carries a project pill beside the domain: pin a project and the answer draws on that project's standing brief, its latest handoff, a slice of its journal and the canonical documents you marked "read first" — on top of the domain's wiki, never instead of it.

Three things are worth knowing. It is a reading and never a save: chat writes nothing to a project. The project's text reaches the model as recorded data to verify, never as instructions, under the same defence the MCP bridge uses, from the same source. And the two budgets are separate, so pinning a project never quietly costs you wiki pages; when something does not fit, the answer says what was left out.

The pin is remembered on that computer, per domain, and clears itself if the project is deleted. Pinning a project the domain does not have is refused with a plain reason before the answer starts, rather than quietly answering from the wiki alone.

After a turn, the project picker's footer shows two readings. **Documents** is how many characters of the project's documents actually reached the prompt, drawn as a depth bar against a 40,000-character ceiling — "18.4k of 40k characters" — a figure that had been mislabelled "KB" since it shipped and was corrected to characters in version 3.66.0; if a document did not fit, the footer says so in words. **Whole block** is the size of everything the project added — brief, handoff, journal and documents together — in characters, with no bar of its own, because the budget governs documents only.

**Since version 3.67.0**, Chat also honours a project's own reading budget when one is set: the 40,000-character ceiling above is a cap, not a floor, so a smaller project budget shrinks it further, and at **Index only** chat reads no document text at all and does not fetch documents by keyword.

## Can another tool read and write this format?

Yes, and that is now a published contract rather than an inference from the files. `docs/spec/working-state-v1.md` in the repository is the on-disk format, versioned `working-state/1`: the file layout, the machine-name rule and the merge hazard it exists to prevent, the handoff's section grammar heading by heading, the sanitisation a reader re-applies, the journal line, the foundations manifest field by field, the size budgets with the behaviour attached to each, and the bootstrap contract.

It is written for somebody building a writer without this codebase, and it is kept honest by execution: a test suite parses the specification's own tables against the live constants, renders a real handoff and checks it against the grammar the document publishes. A specification that drifts from the code fails the build, which matters more here than anywhere else in the project — it is a promise made to people who cannot read the source.

## Can I refresh a mirrored document from a computer that does not have the repository?

Yes, since version 3.63.0. A mirrored project can record its GitHub repository, and a refresh can then read the documents from the repository itself instead of from a checkout on one particular disk. Before this, the freshness column read "source not on this computer" for ever on every machine but one. **Since version 3.67.2**, a document mirrored from GitHub reads **"GitHub · not checked"** rather than that false "not on this computer" reading — freshness is compared only when you refresh, never on an ordinary read. A recorded folder that really is missing from this machine still reads "source not here," now shown as a pressable word (or a disabled control) that explains itself.

It only ever reads. The client has no way to write — no PUT, no DELETE and no path to one — so a refresh cannot alter the repository it is mirroring, whatever credential it holds. If the file listing comes back truncated it refuses loudly and changes nothing, because a silent miss would keep a stale copy while reporting success. And nothing is written until every file has been fetched, so a network failure half way leaves the mirror exactly as it was.

It does not borrow your sync credential without asking. The recommended setup is a second, read-only, fine-grained GitHub token scoped to the source repository, added in **Settings → Knowledge base → GitHub read-only token** (version 3.65.2 and later). Personal Sync's own token can be used instead, but only when you name it, because a classic token of that kind can read every repository you own and that permission was granted for sync rather than for this. Either way the token is never written to a log, never placed in a URL and never included in an error message; when something fails, the message names which file the token came from, which is the part you can act on.

**Creating the token.** In GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token. Set the resource owner to the account or organisation that owns the repository. Under repository access, choose only the repository or repositories you want to mirror — one token can cover several. Under repository permissions, set Contents to read-only; metadata read-only is added automatically, and nothing else is needed. Fine-grained tokens require an expiry of up to a year, so set a reminder to renew it. Copy the value once and paste it into the Settings field above; it is not shown again. A classic token also works but can read every repository your account owns, which is why the fine-grained kind is recommended.

What it does not change: the copies still travel by sync, a mirror refreshed on two machines between syncs still converges to whichever saved last, and the repository is still the source of truth.

## Can I add a GitHub source alongside a folder mirror?

Yes. Through v3.68.0 the Add from GitHub door, pressed on a project that mirrored a folder, **switched** the project's one mirror to GitHub — re-copying its documents from the named repository and clearing the folder path, so only one source survived. **Since v3.69.0** a project can hold a folder source and a GitHub source side by side: pressing Add from GitHub on such a project either joins an existing GitHub source with the same owner/repo and ref (a second machine's checkout catching up), or opens a new one — it no longer clears anything. Any document you had marked read first stays marked, by name. As with any mirror action, there is no token field: you name which file on this computer the read-only token comes from, and a source that already has one recorded reuses it. **As of version 3.65.3**, the panel's READ WITH row offers up to two saved tokens, each named by where it lives — the read-only token (Settings → Knowledge base, by its last four characters) and Personal Sync's own token (never the default, because a classic Personal Sync token can read every repository its account can see). Whichever is a read-only token is saved, it is selected automatically; with none saved, nothing is selected and the row offers a door straight into Settings → Knowledge base to add one.

## What is "Copy agent instructions", and what does it give me?

It is a button in two places: on every project's row under Domains, beside **Copy marker line**; and in the header of the **Project context** screen. It puts a short block on your clipboard with your domain and project already filled in. **Since version 3.67.2**, a confirmation appears briefly in the bottom-right corner and closes on its own after 30 seconds (it waits while your pointer is over it; press Copy again to see it once more), and it says exactly where to paste the block: at the very top of the file your agent reads every session — `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex and others, `GEMINI.md` for Gemini CLI, or a rule file in `.cursor/rules` for Cursor. Position matters because Codex silently truncates `AGENTS.md` at 32,768 bytes, so a block appended at the bottom can be cut off unread.

This is the composed block. `<domain>` and `<project>` stand where your own names appear; the project name is substituted at two points and the `domain/project` pair at one.

```markdown
## Working state

This repository's working state lives in The Curator (project `<domain>/<project>`, see
`.curator-project`). At the START of every session call the my-curator MCP tool
`get_project_context` with project "<project>" and read the standing brief and latest
handoff before acting. When the user says continue or resume, or you come back after a
pause, call `get_project_context` again before acting — another tool or computer may have
saved since. SAVE with `save_working_state` under project "<project>" with the
`scope` argument set to your tool's name — "claude-code" if you are Claude Code,
"antigravity" if you are Antigravity, "opencode" if you are opencode, otherwise your
tool's own name, lowercase and hyphenated. Pass `scope` explicitly every time, and never
save under another tool's scope. Save after every material
decision, at least every ten tool calls, and ALWAYS before you stop; a save overwrites,
so send the complete state each time. Pass `harness` as that same name and `model` as
your exact model id if you know it (omit it otherwise — never search files for it), and
record the `seen` map as `foundations_read`.

This project also keeps foundations — canonical documents such as its architecture and firm
decisions — that travel with it. `get_project_context` is the call that returns them with
the brief and handoff, so make it your first action of the session, before you read code
or run anything. Its `seen` map holds their hashes: passing that back as `foundations_read`
on every save is how the next session learns which of them changed.

Some foundations may be skeletons — prompts, not facts; the document says so
at the top. As you learn the project, fill each one and save it with
`save_foundation` (`commissioned_by_owner: true` — this block is the owner's
commission). If the project has a repository, export the filled
foundations into its `docs/` folder on the first commit.

Foundations marked "read first" arrive with their text; the rest arrive as an index.
Open any of them by name with `get_project_context` and `slugs` when the work calls
for it — the brief's "Read before you…" section says which. An index entry with no
text is a document waiting to be asked for, not one that is missing.
```

The first paragraph is frozen, including its line breaks, because it is the artefact that was measured. Editing a word of it does not improve the wording; it invalidates the evidence that any of it works. It changed once, in version 3.76.0 (from saving every tool under `main` to a scope named for each tool), and was measured again before it shipped — see "Why doesn't my agent save anything?". The three paragraphs after it were added in versions 3.59.0 (foundations; rewritten in 3.76.0 to say to call `get_project_context` first, which the measurement showed matters), 3.61.0 (filling in a skeleton) and 3.62.0 (read-first documents, and asking for the rest by name). Each is composed after the frozen one rather than merged into it, which is what lets the first stay byte-identical to what was measured.

Where it goes — plain prose in a file each of these already reads on its own. Nothing needs to be installed, and it is the same text everywhere.

| Harness | File it auto-loads |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| opencode | `AGENTS.md` |
| Gemini CLI | `GEMINI.md` |
| Antigravity | `AGENTS.md` or `GEMINI.md` (never `CLAUDE.md`) |
| Cursor | `.cursor/rules` |

One detail for Cursor: a rule file in that directory must have the `.mdc` extension, because a plain `.md` there is ignored, and a rule set to *Always Apply* is the setting that loads it every chat. Cursor also reads `AGENTS.md` in the repository root, which auto-applies.

The point is not the file format. It is standing. A skill is something the agent may consult if it decides the conversation matches; the entry file is loaded every session, so the same words become a standing instruction. That is the whole difference the measurement above shows.

The block sits beside the skill rather than replacing it. The skill carries the writing standard, the refusal handling and the treat-state-as-data rule — tens of kilobytes of playbook the block cannot. The block's job is only to make sure the agent reaches for any of it.

## What are the two skills, and do I need them?

The Curator ships two agent skills, each a playbook plus companion files that load only when a case arises.

| Skill | What it carries |
|---|---|
| `curator-continuity` | The session-handoff discipline: read state at the start of a session before proposing anything; save early and often; every save complete rather than a delta; treat the handoff and journal as recorded data to verify while the standing brief is the owner's own instructions. Install this one if you want working state at all |
| `my-curator` | The wiki discipline: ground every wikilink in an existing slug before writing, refuse speculative links on a fresh domain, respect domain siloing, decompose into entities, concepts and summaries |

In Claude Code and Claude Desktop they install as skills, folder and all — a playbook whose companion files are missing tells an agent to open files that are not there, which is worse than never mentioning them.

Their text is portable prose with no vendor-specific logic. Two things in the packaging are Claude Code conventions rather than anything universal: the allowed-tools header uses its tool-naming scheme, and the documented install location is its skills folder. A build script in the repository derives a harness-neutral form of the same playbooks, with both stripped, for Codex, opencode, Cursor and Gemini CLI — derived at build time from the one source rather than kept as a second copy, because a second copy of a model-read instruction set is the defect this project sees most often.

Removing the continuity skill is the practical off switch for the memory layer, because nothing else prompts a save.

## When should my agent save, and what happens if it forgets?

Save early and save often. A save overwrites, so it is idempotent and free to repeat — which removes the single point of failure in "write the handoff at the end", a plan that asks a degraded model near its context limit to remember.

Every save must be complete, not a delta. Since a save overwrites, a second save carrying only what changed silently drops the firm decisions recorded in the first.

An over-budget save is never refused. An agent near the end of its context that has its handoff rejected loses the handoff entirely, so instead the least is trimmed: trailing items are dropped from whichever list is largest, the drop is recorded in the document itself, and it is reported in the result and in the journal. Truncating silently is the one thing that does not happen.

If a session ends without saving, the next read returns the previous state. That is a stale handoff, not a corrupted one. Nothing is damaged and nothing that had been saved is lost. That fail-safe direction is why no enforcement was added: a skill works in every MCP host, while a hook has to be rebuilt for every harness, and a missed save costs freshness rather than integrity.

A save is refused in a few cases, and a refusal is returned as a result rather than thrown: the domain is not a real domain; the domain is a read-only shared mirror; the project name matches nothing or matches in several domains; there is no headline; the work-stream or machine name is unusable; the brief would be empty; or a near-empty save would overwrite a substantially larger existing handoff. That last one is the shape of a context-starved agent about to erase good state by accident — the refusal names the existing byte count and the missing sections, and a caller that genuinely means it repeats the call with a confirmation flag.

## Does it work across two computers?

Yes. `state/` matches none of the sync exclusion rules, so it is tracked by your knowledge repository and travels with Personal Sync exactly like your wiki pages.

Cross-machine handoff works on the reading side. Ask for a work-stream without naming a machine and you get the most recently written one, plus a list of every machine that has state for it. Save on the laptop, resume on the desktop.

The app labels this rather than hiding it. When a handoff you are reading was written on another computer, a badge names the machine and a caption reads "synced here — local paths and processes may differ", because the next steps below it were observed somewhere else.

There is also a clock note. A file that arrived over sync carries the moment of the pull as its file timestamp, because git rewrites that on checkout. So the app shows the agent's own clock where the journal recorded one, says "this file arrived on this computer N ago" when the two clocks are known and disagree by more than two minutes, and says plainly when the only time it has is the file's.

Foundations travel the same way, which is the point of them: a canonical document mirrored from a repository on the laptop is readable on the desktop even if that computer has never checked the repository out. Unlike a handoff, a foundation has no machine name in its path — it is meant to be identical everywhere — so a repository-owned mirror converges on whichever machine saved last. That is acceptable because the repository, not the mirror, is the source of truth: any machine re-asserts its own checkout with a refresh, which is a cheap byte comparison, and the app shows the stored commit beside the local checkout's current one so a machine that has drifted is visible rather than silent.

## Why is there a machine name in the path?

Because two computers writing the same handoff file would destroy each other's work silently.

Personal Sync resolves with a git pull strategy that, on a conflicting hunk, keeps the remote version and discards the local one without reporting a conflict. And that is the milder of two outcomes. The strategy is a conflict preference inside an ordinary three-way merge, so where one machine re-sends a section unchanged, the other machine's edit applies cleanly and the merge splices. Measured on real git, the survivor carried one machine's headline, provenance line and timestamp with the other machine's firm-decisions section substituted in — a document that existed on neither computer, well formed and internally coherent, whose own header attests to a decision its named author never made. Nothing flags it, because a spliced file is not a malformed one. The capture discipline makes this likelier rather than rarer, since a save must be complete and unchanged sections are re-sent verbatim.

A per-machine path means the two machines never write the same file, so the conflicting hunk never arises. Nothing has to be resolved, because nothing collides.

The segment is not a bare hostname. It was, and that was measured to fail: two clones with the same default macOS hostname both wrote to the same folder and the second machine's next sync destroyed the first's handoff and its journal — the exact collision the segment exists to prevent, defeated by a hostname collision alone. It is now a hostname slug plus a short install identifier generated once and stored outside your domains folder so it never syncs. A folder already written as a bare hostname stays fully readable; nothing is migrated or renamed. If the identifier cannot be persisted, the store falls back to the old behaviour rather than failing the save, and says so on the result — losing the collision guard costs a merge risk, while refusing the save loses the handoff outright.

The folder name is remembered rather than recomputed, for a related reason: macOS re-derives the hostname from the network, so one laptop alternated between two names and owned two folders under one work-stream, fragmenting its own append-only journal.

One computer can also mint two machine names on purpose, and a developer's usually has. A git checkout of the project and the installed Mac app resolve different user-data folders by design, so each keeps its own install identifier and therefore its own machine name. Handoffs saved through the bridge and through the `my-curator` command then land in different folders and do not supersede one another; asking for the latest work-stream answers with whichever was written last. `my-curator doctor` reports both identifiers, and both usage logs, when they differ. Nothing is merged, and nothing is renamed on your behalf.

Read the guarantee narrowly. It is about merges, and only about merges.

| Threat | Does the machine segment help? |
|---|---|
| Two machines writing the same handoff, resolved by the pull strategy | Yes. They never write the same file |
| A three-way merge splicing one machine's sections into another's file | Yes. Same reason |
| Two machines editing the same standing brief | No. The brief has no machine segment |
| A checkout or hard reset replacing this machine's own folder from an older revision | No. Path uniqueness is irrelevant; the file is simply overwritten |
| Two independent sync repositories over one domains folder | No. Both write the same paths from different histories |

The last two are addressed in the sync layer rather than by the layout: connecting sync now measures what a checkout would overwrite and refuses unless you are shown the count and confirm, offers a non-destructive merge instead, and joins an existing sync repository rather than creating a second one over the same folder. The practical instruction that follows: connecting sync on a machine that already has state on it is the risky moment, not the daily pull.

The standing brief is the one file two machines can genuinely conflict on, because it has no machine segment — deliberately, since the brief belongs to the project rather than to any one computer. A brief changes a few times a year and a write replaces it whole, so the window is as wide as your sync habit makes it and no wider. Edit a brief, then sync. Editing briefs on two machines in one day is the case this layout does not cover, and the remedy is a sync between the two edits.

## Where do I see this inside the app?

The **Context** item on the rail — one of three, since version 3.64.0 — opens **Project context**, which shows everything one project gives an agent. Since v3.62.0 it is numbered steps under an overview card, read top to bottom, in the order a session start reads them: step ① **Documents**, step ② **Memory**, step ③ **Knowledge** — renamed from *Foundations*/*Working state* in v3.65.1, copy only; the store still says `foundations` and `working state` — and, new in version 3.67.0, step ④ **Session start**, described below. Since version 3.64.2 that overview card is the same component the Domains page draws its own OVERVIEW figures in — one shared component, not two builds of the same idea. Since v3.65.1, a domain named anywhere on this screen — the breadcrumb, a sidebar row, a Knowledge row — carries that domain's own colour, the same one it has on the Domains page.

- **The sidebar lists your projects, grouped by domain**, each with its work-stream count and how long ago it was last written to. A project with a brief but no save yet is listed, dimmed, reading "no state saved yet", because that is a real answer rather than a broken row. The screen opens on whichever project was written to most recently and remembers the last project you looked at in each domain; since version 3.67.0 it also keeps the project you explicitly selected across a view change, rather than falling back to the most recently touched one.
- **The header carries Copy agent instructions**, beside a breadcrumb naming the domain and project.
- **The overview card** answers the question people actually arrive with: where does this project stand? One reading per layer — DOCUMENTS, MEMORY, KNOWLEDGE, **AGENT CONNECTIONS** (*CAPTURE* before version 3.74.0) and, since version 3.67.0, **SESSION START** (the same total step ④ shows: what an agent is handed at the start) — each with its figure, a qualifier under it, and a freshness dot and the word beside it, because colour never carries a reading on its own. Press one and the page jumps to the step it names; unlike the same card on a domain page, nothing here filters — these are readings, not a filter. An unknown age is drawn as a dashed ring and the words, never as age zero.
- **Step ①, Documents** holds the canonical documents. Its head row always carries two doors, **Add from this computer** and **Add from GitHub**, both always enabled — since v3.69.0 a project can mix written, copied and mirrored documents from up to 8 sources at once — plus a sources strip with per-source Refresh once the project has one, and, since version 3.67.0, **Suggest a reading plan** / **Suggest with AI**. Its table's SIZE column carries a small tinted bar behind each figure, showing that document's share of the 200 KB project budget, and its **At session start** column, since v3.67.0, is a real tri-state control — read first, on request, or not at start — see "How do I choose which documents an agent gets automatically?" above.
- **Step 2, Memory** holds four collapsed rows, in this order: Agent connections (the honesty meter, below — called *Agent sessions* through v3.73.x, *Capture* through v3.69.0), Handoffs (your agents'; one right-aligned summary line — handoff count and the newest one's age, nothing under the title while closed; press a row to read that handoff in the reader, where its own headline lives), The brief (yours, with a pencil beside it; since v3.76.0 its age is the brief's own written time, with the file's time added as "changed on disk" only when a hand edit or a sync moved the file later), and Journal — the session journal, with an inline "Show N more". Only genuinely loud outcomes about one specific save sit above the four rows, unfolded, and only when they fire: content that had to be trimmed, a label that was shortened, a deliberately replaced handoff, two tools sharing one file, newer state elsewhere, another machine that saved after this one. **There is no "Last saved" row as of v3.65.1**, and — also new in v3.65.1 — no unfolded line naming which clock an age came from or which machine wrote the open handoff either: the first is explained once in the overview's own info panel, the second is the Handoffs table's own MACHINE column per row. A healthy save renders nothing above the four rows at all. Since v3.76.0 every age on the page — the MEMORY tile, the Handoffs summary, each sidebar row — is recomputed from its timestamp every second, the freshness dots recolour as they age, a project moves from Active to Idle by itself at 24 hours, an Active row names every tool that saved in the last 24 hours (read from the journal, so a tool whose handoff another tool replaced is still named), and the Handoffs table's Harness column shows one name per tool (Claude Code, never claude-code on the next row).
- **Step 3, Knowledge** is one row per domain the project draws on — the project's own domain is always listed, since v3.65.1 — each reading "domain · N pages · last ingest age" with that domain's own colour dot, and opening to five figures (entity/concept/summary each with a small bar against that domain's page count) and two doors: Open in Domains, and Ask this domain, plus its own Remove. A **"+ Add a domain"** picker in the step's head row lets you add up to twelve domains a project draws on, including a read-only Shared Brain mirror. A small **default** badge marks a row only while nothing has been explicitly chosen yet, and disappears the moment you add one — curator metadata about the project (`project.json`), written by the app, never by an agent. Version 3.65.2 fixed the picker and Remove themselves, which had not actually worked in v3.65.1 despite being on screen: adding and removing a domain now go through the real route end to end. Remove is withheld with a reason on a single default row, live on every row once there are two or more, and live with a stated outcome on a single explicitly-chosen row.
- **Step ④, Session start (new in version 3.67.0; a context-window meter since version 3.70.0)** is what an agent is actually handed when it starts work on this project: the standing brief, the latest handoff, a few journal lines, the document index, and the text of every document marked read first — up to the reading budget. Its head row holds the budget picker (seven presets, Index only through Max — see "What is a project's reading budget?" above) plus **Window** and **Harness**, both set per computer. Below that, the meter draws your window to scale, the harness hatched, and The Curator's own layers named, with a dashed room the width of your reading budget. When the total is large, the line carries a **Set a reading budget** action.
- **Every fold starts closed and remembers whether you left it open.** Each summary line carries the figure that decides whether to open it. Step ④'s "what an agent receives" monitor is the one exception — it opens by default.

The qualifying lines that can appear above the Memory step's rows — as of v3.65.1, only outcomes about one specific save, never which clock or which machine (both moved to the overview's info panel and the Handoffs table respectively):

| Line | When it appears | What it means |
|---|---|---|
| "part of this handoff did not survive the save" | Handoff content was cut — a section, or items past a list's cap | The handoff really is missing what the note names. Ask the agent to save that content again |
| A full-width report, "Handoff saved in full" (version 3.65.2) | Only a label was clipped, most often the one-line headline, capped at 200 characters | Nothing urgent. It states plainly that the handoff saved in full, shows the character count against the limit as a bar, and one line per note if more than one field was clipped. It clears on the next save whose headline fits |
| "that save deliberately replaced a larger handoff" | The agent overrode the guard that refuses a small save over a much larger one | Nothing was lost from what it sent, but the longer document it overwrote is not recoverable |
| "two tools are writing this handoff" | Two agent tools have both saved into the same handoff file | Give each tool its own scope |
| "newer state in this project" | Another scope in this project holds something more recent | Worth checking. An agent can be saving beside you into a scope you are not watching |
| "this machine saved after this computer" | Another machine has saved more recently than this one | Pull before you continue |

The overview's MEMORY tile says "saved", never "you are saved". It knows when the last save happened; it cannot know whether anything has changed since.

Almost all of the screen is read-only, and that is by design rather than by omission. A browser write path into a handoff would make the app a second writer to those files, which is the property the whole sync-safety argument rests on, and a human edit arriving through the app would wear the last agent's provenance line. The standing brief is the one exception, because it was never in that argument: it has no machine segment and it is your document.

There is a second place memory shows up. A domain's page in the app lists its pages with facet tabs, and beside Entities, Concepts and Summaries there is a **Memory** tab listing each project's standing brief and each work-stream's latest handoff, with the path under `state/` shown. Clicking one opens it in the same reader a wiki page uses. The Memory tab carries its own count, and the "All" tab does not include them — "All" means wiki pages, so the two figures can never disagree.

## Can I see it without opening the app?

On a Mac, yes. The app can put a small icon in the menu bar showing the same store, and it answers one question: whether your agent has actually written the handoff, and how long ago.

It is off unless you turn it on, under Settings, in the General section, under Menu bar. It takes effect immediately. Off is the default because a brand-new install has no agent memory at all, so an on-by-default icon's only possible content is "no agent memory yet" — the worst first impression the feature can make.

**Since version 3.74.0 ("Layout A") the menu shows, in this order:**

- **A pulse strip row** — "7 days · at least N saves · N tools" (the count is a floor, worded "at least" because a truncated log can undercount) — with a submenu, **Saves by tool**, one strip per normalised harness/tool (e.g. "Claude Code · 200 saves", "Antigravity · none · last seen 1 Sep").
- **Active · last 24 h** — one row per (project × harness) that saved in the last 24 hours. Line one: "`<project>` · `<Harness>` · `<age>`" with the app's own freshness dot (filled hot with a halo under 60 s, filled hot under 1 h, filled mid under 24 h, filled cold under 7 d, hollow cold at 7 d or more — the same scale used everywhere else, replacing the old pie-chart glyph). Line two: "`<model>` — `<headline>`". Projects are taken in whole (never split across the fold) up to a five-row cap; the rest collapse to **"+N more active projects."**
- **Notices, only when true** — stale mirrored docs, "Two tools are writing `<project>` / `<scope>`" (one line per collision, not one per harness pair), handoffs waiting on GitHub, another machine having saved after this one — now directly under the Active rows rather than at the bottom.
- **Idle · N projects** — a fold; its submenu lists the idle project rows the same way.
- **Knowledge · N domains** — a fold; its submenu draws each domain's page-count bar, in that domain's own identity colour.
- **Open Project Context…**, **Open The Curator**, **Settings…**, **Updated HH:MM**, and **Quit**.

**Removed from the menu in this release (the app still shows all of it, just not here):** the "Working on: …" headline and its grey harness/model line, the "Session start" line, the "Documents · N" line, and the "N of M saved" capture bars — those bars counted MCP bridge process ids, not real sessions, and were retired for that reason.

A row's submenu offers Open in The Curator, Copy resume prompt, Copy handoff as Markdown, and Reveal the handoff file in Finder.

It reads the same files as everything else and it never writes. It is also deliberately not a second reader of the handoff document: it shows rows, ages and the agent's own one-line headline, and clicking a row opens the app. The document itself is rendered in one place only. Nothing leaves your machine.

## What does "· docs stale" mean in the menu bar?

A project's foundations are its canonical documents — architecture, firm decisions, conventions —
either mirrored byte-for-byte from a repository or written by an agent you asked. When a mirrored
document no longer matches the checkout it was copied from, that project's header in the menu bar
gains a small `· docs stale` mark, or `· N docs stale` when more than one has drifted. Nothing
appears when every mirrored document is current, and a document an agent wrote rather than
mirrored never triggers it, because there is no second copy to compare it against. A mirrored
document whose source could not be reached from this Mac — for example a GitHub document with no
read token — is shown separately as `· 1 doc not checked` (since v3.76.0): nothing was compared, so
it is not called stale.

The fix is either to refresh the mirror from the repository, on whichever machine has that
checkout, or, for an agent-written document, to save the version you actually want kept.

## Does carrying state actually change the answers?

There are two measurements, and they answer different questions.

**Does the handoff change what a model proposes?** The project's own measurement, not a benchmark, and small: one seeded project, one open question, two providers, 8 runs, $0.074. Without the working state the model proposed a command the project had already recorded as failed in 3 of 4 runs, and an architecture the team had ruled out in 4 of 4. With the handoff present: 0 of 4 for both. Read that as the shape of the effect at four runs per condition, not as a constant.

**Does it make the next session know where to start?** Measured against this project's own real handoff, asking an open "what should I do next?": without state the model named the correct top priority in 0 of 4 runs; with state, 8 of 8.

The honest other half of that second measurement: a handoff cures ignorance, not disagreement. In the same runs, the model proposed something the handoff explicitly ruled out in 3 of 4 runs without state and 3 of 8 with it — real, directional, and nowhere near zero. Twice the model quoted the decision and overrode it in the same sentence. Recording a decision stops the next session being ignorant of it. It does not stop the next session thinking it knows better.

## What are the limits?

Every limit exists so that a read is self-capping and cannot blow the response budget an agent has to pay for out of its context window.

| Limit | Value |
|---|---|
| Handoff document | 48 KB |
| Standing brief | 32 KB |
| Prose field | 8,000 characters |
| List item | 600 characters |
| Items per list | 40 |
| Headline | 200 characters |
| Journal entries returned to an agent | 8 by default, 20 at most |
| Journal entries shown in the app | 10 by default, 50 at most |
| Work-stream index entries | 60 |
| Projects listed, per domain and in total | 200 |

The journal limits differ by surface deliberately. Every byte the bridge returns is carried in the agent's context window on the turn it asks; a person scrolling a page pays no such tax.

The index cap is a listing limit, not a reachability limit. A project with more than 60 saved copies still resolves any work-stream you name by its own folder, so one older than the newest 60 stays readable by name even though it has scrolled off the index. It is not a counting limit either: every count a read reports is taken before the slice, so a truncated index still says truthfully how many work-streams and how many saved copies exist, and says which list is short.

Reads are capped at the source, so a hand-edited or synced oversized file cannot reach the response guard.

## What does this deliberately not do?

- **Nothing forces a save.** A hook can ask for one and can never write it, and there is no scheduler. Saving is guided by the skill layer and by the block you paste, and it is advisory. On screen, the reading of it is called **Agent connections** (*Agent sessions* through v3.73.x, *Capture* through v3.69.0); it counts only bridge connections that reached the project through the MCP bridge — a connection started only by the hook or `my-curator context` is not counted, and the row says so at zero.
- **Nothing saves periodically or automatically.** Every save is an agent deciding to make one.
- **The app writes the standing brief, curator-owned canonical documents, and the project's own metadata — and nothing else.** The handoff and the journal are written by an agent and by nothing else — in the app, in the menu bar icon, and everywhere else.
- **There are no rollups.** Nothing composes a Done, Decided or Blocked view across work-streams or projects.
- **Nothing migrates.** A tree written before projects existed is read where it lies. Moving it under a name of its own is a hand move you may make if you want it, and the app does not offer it.
- **An ambiguous folder is reported, not repaired.** The store names it and leaves it exactly as it found it.
- **Nothing creates a project implicitly.** An unknown name is refused with candidates, on a read and on a save alike.
- **No lock is taken.** The write target is per work-stream and per machine, so the only possible racers are two savers on the same machine for the same work-stream; the handoff is written atomically, so a reader sees the old file or the new one and never a partial one, and both journal lines land.

## Something is wrong — what do I check?

**The Project context screen is empty.** Nothing has saved yet. Install the `curator-continuity` skill, and paste the block from **Copy agent instructions** into the file your tool loads every session. That is the write half, and it is not code.

**My agent says it is going to save and then nothing appears.** Check that the MCP bridge is connected — Settings, MCP bridge, Run self-test. In one measured run the agent said it would save, failed to issue the call, and tried a shell workaround instead.

**I updated The Curator and my agent still behaves like the old version.** An MCP server started by your client before the update keeps running the old code and the old tool set for its whole session. No code change reaches a process that is already running. Quit and reopen Claude Desktop, Cursor, or whichever client spawns the bridge.

**One computer shows up as two machines.** Same cause: a client that started the bridge before an update. Restart it and the next save lands in the right folder. Nothing is migrated, merged or deleted — both folders stay on disk, both stay listed in the Machine picker with their own timestamps, and both stay readable by name. Only the next save is pinned, which is what stops the split growing.

**A work-stream I know exists is not in the list.** A folder whose name is not a safe single path segment — containing a space, an accented character, or a leading underscore — is left unread and counted rather than silently skipped, and the response names the count and the fix. Renaming it makes it readable.

**I want to read the orphaned half of a split machine.** Pass its folder name as the machine argument, or pick it from the Machine selector, which lists every folder under the work-stream with its own age.

**Something was destroyed by a sync.** Recovery is a reflog question, not a log question. A log that finds nothing is not evidence of loss in a repository that has been hard-reset; the commit may still be on disk and merely unreachable.

**Claude Code interactive.** Only headless runs were measured. Interactive mode differs in ways that could matter, and nothing here describes it.

For the full technical account — the layout, every disclosure field, the security posture and the measurements in their original form — see [docs/working-state.md](https://github.com/talirezun/the-curator/blob/main/docs/working-state.md).
