# Roadmap — menubar widget: background running + a live view of agent memory (Phase 1 SHIPPED; Phases 2–3 not built)

> **This file is no longer entirely a plan, and the split is exact.** **Phase 1 —
> the menu bar icon and its native menu — is built and is in the code.** Phases 2
> (the rendered popover panel and the per-scope popup) and 3 (the bucketed event
> strip) are **not built**, and every word about them below is still design
> context rather than a description of behaviour. §0a is the boundary; read it
> before trusting any other section in the present tense.
>
> **Nothing in the rest of this file was rewritten to match what shipped**, on
> purpose. Where the build deviated from the plan, §0a names the deviation and
> points at the section it deviated from. A roadmap edited into agreement with
> its own outcome stops being able to explain why a decision was made — which is
> the only thing it is still for.
>
> **Written against a measurement session on 2026-08-31**, macOS 15 / arm64,
> against the running v3.30.0 build installed in `/Applications`. Every number in
> §2 is tagged MEASURED or INFERRED. The ones tagged INFERRED are the ones a
> future session should measure rather than inherit. **§2's numbers were not
> re-measured against the shipped tray** — the cost model in §2.6 is what the
> implementation was built to, not a reading taken from it.

### Revision note — SECOND PASS, against v3.33.0

The first pass designed for **one developer, one machine, one agent**. The brief
then widened to two scenarios the maintainer actually runs: **several harnesses
on one machine** (opencode and Claude Code against the same Curator), and
**several machines** syncing through one private repo. Re-deriving the design
against those two scenarios changed six things and left the rest standing.

| | Changed, and why |
|---|---|
| **§1.2a is new** | Two facts about the store were measured this pass and both break a first-pass conclusion. **The state path has no harness segment**, so two harnesses on one machine write the *same* file and silently overwrite each other. And **`ageSeconds` is derived from filesystem mtime**, which git resets on checkout — so on a second machine, every handoff that arrives over sync reads as *"just now"* (MEASURED, §2.9). The first pass's *"Live = an agent is working right now"* glyph would have been wrong on every pull. |
| **§1.3 replaced** | The use cases are now **ranked** rather than enumerated, and the layout is **flat by recency**, not grouped by project. This reverses the first pass's grouping decision; the reasoning is in §1.3. |
| **§1.5 re-derived** | The budget bar and the recency pips survive. The recency pips now read the **true save time**, not the mtime. Two new refusals are added — a sync *progress* bar, and any encoding that makes save FREQUENCY look like productivity. The event strip is demoted to per-scope and per-source. |
| **§1.7 reversed, in part** | The first pass refused a reader in the widget. This pass **ships a popup**, because the maintainer asked for one and because there is a version of it that is safe: the widget renders **the journal** (a structured, sanitised, bounded array), and never renders `current.md`. The tier-to-surface mapping is in §1.7. |
| **§1.10 refined** | The `backgroundMode` field and the `window` default both survive with a stronger argument. What is added is *where the user finds out it exists* — and a note that the **dismissal of that offer** is exactly the consent shape `ui.*` was built for, even though the mode itself is not. |
| **§2.9 is new** | A measured cost model for the **multi-machine** signal, which the first pass did not price at all because it is the one signal that is not local. Conclusion: it is fetched **on panel open only**, never on a timer, so it costs zero when nobody is looking. |

Everything else in the first pass — the observer constraint, the `fs.watch`
measurements, the resource baseline, the Dock/quit analysis, and the prior-art
research — is **unchanged and still load-bearing**. Where this pass disagrees it
says so in the section itself.

---


> **SUPERSEDED.** Deviation 2 above described the remote count as an observation that never triggers a
> check, and recorded the consequence — with the window closed, which is the tray's normal state, no
> observation ever arrived and the line could essentially never appear. That is fixed: the tray now runs
> a check **on menu open only**, never on hover and never on a timer, through `brain/sync.js`'s own
> `getRemoteStatus()` so it inherits the existing TTL cache, in-flight memo and fetch gate rather than
> creating a parallel set. The honest limit is narrower than the original claim: `gitFetch()` serialises
> the fetches **that module issues**, and `git pull`'s own internal fetch is git's subprocess and outside
> it. 60 concurrent runs against real git produced zero failures on either side — including in the
> fetch-vs-fetch shape that is the recorded incident — so that harness could not reproduce the known
> failure and therefore cannot certify its absence. The decision rests instead on this reaching the same
> function, through the same gate, as a call the app already makes on a 10-minute timer whenever the
> window is open.


## 0. The one-paragraph version

The Curator's memory layer is written by **agents, over MCP, while the user is
doing something else entirely** — and increasingly by **more than one agent, in
more than one harness, on more than one machine**. Today the only way to see any
of that happening is to open the app and navigate to the Agent memory view. A menubar presence turns an
invisible background process into an observable one, and — because the MCP server
and the memory layer are useful with the window closed — it also makes "closing
the window" stop meaning "stopping the product". The widget is an **observer**:
the app is read-only over working state by design, and it must stay that way.

---

## 0a. STATUS — what shipped, what deviated, what is still a plan

*Added when Phase 1 landed. Everything after this section is the design pass, unedited.*

### What is in the code

| Thing | Where | Status |
|---|---|---|
| `backgroundMode` — `window` · `tray` · `tray-only`, top-level in `.curator-config.json` | `src/brain/config.js` | **Built.** Default `window`, per §1.10 and §7 |
| `GET /api/config` carries `backgroundMode` + `backgroundModes`; `POST /api/config/background-mode` writes it | `src/routes/config.js` | **Built** |
| The Settings control (Off / On / On, and hide the Dock icon) with the three-ways-it-vanishes warning in its own copy | `src/public/next/views/settings.js` | **Built**, per §7 and §3.10 |
| One cheap projection over the store — `getTraySummary()` | `src/brain/tray-summary.js` | **Built** |
| Row model, age formatting, recency buckets, glyph state | `desktop/lib/tray-model.js` | **Built** |
| The native `Menu` template — Phase 1's whole surface | `desktop/lib/tray-menu.js` | **Built**, per §1.4 |
| The generated template-image glyph (ring / filled) | `desktop/lib/tray-icon.js` | **Built** |
| Recursive `fs.watch`, 150 ms debounce, 5-minute fallback, one-shot glyph expiry | `desktop/lib/state-watch.js` | **Built**, per §1.6 and §2.4 |
| The 3×3 live mode transition, so the setting takes effect without a restart | `desktop/lib/background-mode.js` | **Built** |
| Phase 0 — the agent's own clock beside the file's, and harness-collision detection | `src/brain/working-state.js` | **Shipped separately in v3.34.0**, on its own merits, exactly as §6 asked |

### What deviated from the plan, and why

Five deviations. Each one is a decision taken at build time against a section
below, and the section below is left as it was written.

1. **`tray-only` does not hide the Dock icon.** §1.8 argued for
   `app.setActivationPolicy('accessory')` and verified the API. The build
   **recognises** the mode but treats it as `tray`, because the *return*
   transition — accessory back to regular, which is what happens the moment
   someone opens the window from the menu — is community-reported buggy in
   exactly the direction the feature depends on, and it cannot be tested from
   here. `resolveTrayPlan()` returns `hedged: true` with a reason rather than
   silently collapsing the mode. **§1.8 is therefore unbuilt design, not a
   description.**

2. **The remote count WAS an observation rather than a check on menu open (superseded — see below).** §2.9 and §7
   both say the unpulled-remote count is fetched *at the moment the menu opens*.
   It is not, and the reason is one `brain/sync.js` exposes no way around:
   `getRemoteStatus()` is *cache hit ? return : `git fetch`* with no peek, and a
   second fetch site is the recorded v3.9.1 incident where the user's own pull
   aborted in 11 runs out of 12 over a ref lock. So `noteRemoteStatus()` records
   whatever a completed check last reported — fed from
   `GET /api/sync/remote-status`, which the sync badge already polls — and the
   line is simply absent when there is none. **This has a consequence §2.9 did
   not anticipate and it is stated in full below.**

3. **No in-app offer.** §7 recommends offering the setting *once*, quietly, in
   the Agent memory screen at the moment a project has accumulated work, with a
   `ui.*` dismissal field. Neither the offer nor the field exists. Discovery is
   **Settings → General → Menu bar and nothing else**, which means a user who
   never opens Settings never learns the feature is there.

4. **Clicking a row lands on the project, not the scope.** §1.7's Phase 1
   sentence — *"a row's click simply opens the app on that scope"* — overstates
   what the shell can address. `data-view` and `data-mem-project` are the app's
   own dispatch attributes; the scope picker inside the memory view has no
   routing attribute, so the click lands on **Agent memory, on that project**,
   and stops there.

5. **The budget bar and the recency pip are not drawn.** §1.5 accepts both. An
   `NSMenu` item is a label, a sublabel and a tooltip — it cannot draw a rule or
   a coloured dot. The recency *bucket* is computed (`ageBucket()`, the exact
   five states of §1.5's table) and today drives only the glyph; the bar has no
   surface at all until Phase 2. **Both survive as Phase 2 work, unbuilt.**

### The consequence of deviation 2, stated because it is the widget's weakest point

The remote line is fed by a poll that is **deliberately suppressed exactly when
the widget is the surface in use.** `refreshSyncRemoteBadgeIfVisible()` declines
to fetch while `document.hidden` is true — correct on its own terms, since a
window nobody is looking at should not phone GitHub every ten minutes — and the
observation expires after five. So with the window closed, which is the state
the tray exists for, **no new observation arrives and the existing one goes
stale within five minutes.** In practice the remote line appears only for a few
minutes after the window has been open.

Nothing renders wrongly: absence renders as absence, and "0 waiting" is never
shown for "not checked". But the multi-machine signal §2.9 priced is, in the
tray's normal operating state, **effectively inert**. Closing it needs either a
non-fetching accessor in `brain/sync.js` or a deliberate on-open fetch that
serialises against `pull()` — both real work, neither in this change.

### Still a plan, in the order §6 put them

| Phase | State |
|---|---|
| **0** — two fields on the store's index row | **Shipped** in v3.34.0 |
| **1** — tray + native menu, `window` default | **Shipped** |
| **2** — popover panel + per-scope popup + budget bar + recency pips | **Not built.** §1.7's tier rule (*the widget renders the journal; the app renders the handoff*) and §1.7's hard constraint are the contract it must be built to |
| **3** — bucketed event strip | **Not built**, and §6 still calls it the first thing to cut |

Two items §6 raised that are **not** part of the widget and are still open:
gating the two shell `setInterval`s on `document.hidden` (§2.7 rec 1) — **now
done for the sync badges**, which is what deviation 2 above turns on — and
measuring the GPU process (§2.7 rec 2), **still not measured**.

### What has never been rendered, and this is the honest limit

**No tray icon has ever appeared on any machine.** `new Tray()` has never been
called. What is proven is data: the row model, the menu template, the 3×3 mode
transitions and the glyph's actual decoded pixels are executed and asserted by
`scripts/test-tray-shell.js`, `scripts/test-tray-summary.js` and
`scripts/test-background-mode.js`. What is **not** proven is everything that
needs macOS: that Electron accepts these menu values, that `sublabel` renders as
a second line, that the template image tints correctly in a light bar, a dark
bar and the inverted open-menu state, that `mouse-enter` fires at all, and that
the icon is visible rather than pushed behind the notch. Treat a green suite as
proof about the **model**, never about the **menu bar**.

---

## 1. The feature

### 1.1 The audience, stated narrowly on purpose

**An AI practitioner or developer with one or more coding agents running right
now in other windows, who wants to keep half an eye on what those agents are
recording without breaking their own flow.**

That is the whole design target. "Bridge between sessions, between harnesses,
between LLMs" is the job the memory layer exists to do; the widget is the
instrument panel for it. Every proposal below is justified against that target,
and the test applied throughout is: *does this help that person, in that moment,
without making them stop what they are doing?* If it does not, it is Dock-icon
work — it belongs in the full app's Agent memory view, not in the menubar.

**The two concrete shapes it has to serve**, which the first pass did not:

**Scenario A — one machine, several harnesses.** opencode and Claude Code
running side by side on the same computer, both talking to the same Curator over
MCP. The question is *which of them is working, and on what*. §1.2a shows this is
not merely a labelling problem: **the store cannot tell two harnesses on one
machine apart at all**, so they can silently overwrite each other, and the widget
is the only surface positioned to notice.

**Scenario B — several machines.** Two or three computers, each with its own
harness, each writing into its own local Curator, all syncing through one private
GitHub repo. Working state is per-machine by design, so the widget is how you
notice that **another machine has been working** — and, before you start, that
there is work on the remote you have not pulled yet.

Three things follow from taking the audience seriously:

- **This person already knows what a scope is.** The widget does not need to
  teach the model. It needs to report state densely and get out of the way.
- **This person is not looking at it most of the time.** The panel is closed
  during almost the entire life of the process. That is a design constraint and
  a cost constraint, and §2.6 and §2.9 treat it as one.
- **Scenario B's headline signal is not local**, and that is the one genuinely
  new cost in this design. Everything else the widget wants is on this machine's
  disk and free to watch. "Has another machine pushed?" is a network question,
  and §2.9 prices it and then makes it cost nothing when the panel is shut.

### 1.2 The binding constraint: this is an OBSERVER

`src/routes/memory.js` is read-only by design, and its own docblock explains why
at length. The store has exactly one writer — an agent, through the MCP's
`save_working_state`. That single-writer property is what makes the per-machine
path layout safe: two machines never touch the same file, so Personal Sync's
`git pull --no-rebase -X theirs` has no conflicting hunk to silently resolve
away.

**A menubar widget must therefore never write working state.** Not a "mark as
read", not an "archive this scope", not a note field. Three consequences worth
writing down before anyone is tempted:

1. Adding a write path would make the app a **second writer** to files whose
   sync-safety argument assumes one.
2. A human edit arriving through the app would wear **the last agent's
   provenance line** — the handoff would claim a model and harness wrote
   something a person typed.
3. `state/project.md` (tier 1) is hand-authored and **no MCP tool writes it**,
   deliberately. A widget offering to edit it would be the first tool that does.

The widget reads. Everything it offers that is not a read is a *navigation* —
open the app, open a file in the user's editor, open the log — never a mutation.

### 1.2a Two measured facts about the store that change the design

Both were established this pass, against the real code and against real git.
Both invalidate a first-pass conclusion. Neither is a bug the widget can fix —
they are properties the widget has to **report honestly** rather than paper over.

#### (a) The state path has no harness segment — so two harnesses collide

The handoff is written to `state/<scope>/<machine>/current.md`, and
`machine` is `<hostname-slug>-<install-id>`. Both halves are per **installation**,
not per process. Two MCP servers spawned by two different harnesses on one
computer resolve to the **same** `<machine>` folder.

So in Scenario A, if both agents are told *"carry on with this project"* and
neither names a scope — and the default scope is `main` — **they write the same
`current.md`, and a save overwrites.** The second one wins. Nothing warns anyone:
from the store's point of view an overwrite is the correct behaviour, and it is
the behaviour the whole "state supersedes" design is built on.

Three consequences, in order of importance:

1. **The remedy is scopes, and it is a discipline rather than a mechanism.** Two
   harnesses on two different scopes never collide. Two harnesses on `main` always
   do. Nothing enforces this and nothing should — but something should be able to
   **show** it.
2. **The journal survives the collision.** `journal.jsonl` is append-only and
   carries `harness` on every line, so the *trail* of both harnesses is intact
   even when the *handoff* is not. That is what makes the condition detectable at
   all.
3. **Detecting it is free.** `listWorkingScopes` already reads a 16 KB journal
   tail per pair to recover the headline, then keeps `last.headline` and throws
   the rest of the line away. **`harness` is in that same parsed object.** Two
   consecutive entries with different `harness` values, close together in time,
   in one (scope, machine) folder, is the collision — and it costs **zero
   additional I/O** to see.

**Two things sharpen this rather than soften it.**

*The capture skill actively encourages the collision.* `skills/curator-continuity`
tells an agent to **"reuse an existing scope whenever the work continues"** and
to open a new one only for *"genuinely parallel work"*. That is the right rule for
continuity across sessions, and it is exactly the rule that puts two
simultaneously-running harnesses into one folder. Nothing in the skill mentions
harnesses at all.

*The one existing guard does not cover this case.* `would-replace-larger-state`
refuses a save whose rendered body is under `REPLACE_RATIO` (5%) of a stored
handoff bigger than `MIN_PROTECTED_BODY_BYTES` (1 KB). It protects against a thin
save flattening a substantial one — which is a real and different hazard. **Two
full handoffs from two working harnesses are both substantial, so neither is
refused, and the second simply wins.**

> A caller *can* pass an explicit `machine` argument, which is taken verbatim, so
> a harness could in principle separate itself by writing `machine: "opencode"`.
> That is a workaround, not a design: it makes the segment mean two different
> things (which computer / which program) and would break cross-machine reads,
> which pick the newest *machine*. Recorded so nobody proposes it as the fix.

#### (b) `ageSeconds` is filesystem mtime, and git resets it — MEASURED

`listWorkingScopes` derives `lastWriteAt` and `ageSeconds` from `st.mtime`, and
`readWorkingState` derives `current.savedAt` the same way. **git sets a file's
mtime to the moment it wrote the file locally**, not to the moment the content
was authored.

Measured against real git in an isolated scratch repo (§2.9): a `current.md`
whose content was authored years earlier arrives on a second machine, through
both a clone and an incremental `pull -X theirs`, with **mtime equal to the
moment of the pull**. The journal line's own `at` field still carries the true
authoring time.

| Fact | Where it lives | What it means |
|---|---|---|
| `lastWriteAt` / `ageSeconds` | `st.mtime` | When this file last **changed on this disk** — which for synced state means *when it arrived* |
| `at` | the journal line | When an agent actually **saved** it |

**This breaks the first pass's headline encoding.** §1.5 proposed *"Live (< 2 min)
= an agent is working in this scope right now"*, keyed on `ageSeconds`. In
Scenario B, a single `git pull` would make **every incoming scope** read as Live,
and the tray glyph would announce an agent at work on a machine that has been
asleep for a day. The strongest signal in the design would be wrong precisely in
the scenario it was extended to serve.

**The fix is additive and small, and it helps the shipped app too.** Add
`writtenAt` (from the journal line's `at`) and `harness` to each pair row in
`listWorkingScopes`. Both come from an object the function already parses;
neither costs a read. Leave `lastWriteAt` and `ageSeconds` alone — they are not
wrong, they answer a different question, and two live consumers plus a pinned
MCP contract depend on them. Then the two facts stay separable:

- **written** *3 hr ago* — the agent's clock
- **arrived** *just now* — this machine's clock

`writtenAt` must be **nullable**, because the journal append is best-effort and a
hand-edited line may have no usable `at`. When it is missing the consumer falls
back to `lastWriteAt` **and says which one it used** — the same fact-versus-its-
absence rule this module already enforces everywhere else.

> **This is a pre-existing honesty gap in the shipped Agent memory view**, not
> only a widget concern: that view renders `formatAge(ageSeconds)` from the same
> mtime, so on a multi-machine setup it already reports a freshly-pulled handoff
> as brand new. Worth fixing on its own merits, independently of this feature.

### 1.3 The use cases, ranked — and the layout that falls out of them

The first pass enumerated three candidates and decided among them. This pass
**ranks** them, because the brief is right that a widget showing five things
nobody acts on is worse than one showing two things they do.

The ranking metric is deliberate: **(how often the question gets asked) × (how
often the answer changes what the person does)**. A question that is asked
constantly but almost never changes anything still earns space, because it is
what the person is *looking at*; a question asked once a day that changes an
action every time it is true earns more.

#### The ranking

| # | The question | Asked | Changes an action | Tier |
|---|---|---|---|---|
| 1 | **Is an agent writing right now — and what did it just record?** | Every glance, ~20×/hr | Sometimes (~1 in 10 — "it has gone quiet, go look") | **A** |
| 2 | **Which harness / which machine wrote that?** | Every glance, in Scenario A and B | Rarely on its own — but it is what makes 1, 4 and 5 legible | **A** |
| 3 | **Is there work on the remote I have not pulled?** | Once per session start, Scenario B | **Almost always when true** — you pull before you start | **A** |
| 4 | **Is the scope I am about to resume actually stale?** | Once per resume | **Almost always when true** — you re-derive rather than trust it | **B** |
| 5 | **Are two harnesses writing the same scope?** | Rarely true | **Always when true** — silent overwrite, §1.2a | **B** |
| 6 | **Is a save failing, degraded, or about to be trimmed?** | Rarely true | **Always when true** — everything downstream is then wrong | **B** |
| 7 | Is there local work I have not pushed? | Once per session end | Sometimes | **C** |
| 8 | How old is the standing brief? | Weeks | Rarely | **C** |
| 9 | Has the app logged errors? | Rarely | Sometimes | **C** |

**Tier A gets the body of the panel. Tier B gets a line each, and only when it
has something to say. Tier C gets a link.** Nothing in Tier C is rendered as
content.

**The punchline of the ranking is a single small change.** #2 and #4 both need
the two fields §1.2a identified — `harness` and `writtenAt` — and #5 needs
nothing beyond those two plus the journal line already being parsed. So **three
of the top six use cases are unlocked by adding two fields that cost no
additional I/O**, to a function that already parses them and throws them away.
That is the highest-value change in this document and it is about four lines.

#### What each tier is, concretely

**#1 — presence and headline.** The pip (§1.5) plus the headline the agent wrote.
This is the payload. It is also the thing that makes the widget feel alive rather
than administrative, and it is already fully available.

**#2 — provenance, in ONE slot with two meanings.** This is the layout decision
that answers the brief's question about multi-machine directly:

> **On a row written by this machine, show the HARNESS. On a row written by
> another machine, show the MACHINE.**

One slot, and in each context it holds the interesting fact. On a local row the
machine is constant and therefore noise; the moment a row is remote, the machine
is the single most interesting thing on it — it means *the other computer did
this* — and the harness over there is somebody else's business.

Machine folder names are `<hostname-slug>-<install-id>` and are far too long for
a 300 px panel, so the widget shows the **host part only**, and appends a short
disambiguator **only when two visible rows share a host part** (which is exactly
the hostname-split condition `docs/working-state.md` describes). Never the raw
folder name; that is a Finder / app-view detail.

**#3 — unpulled remote state.** One footer line, and only when non-zero:
*"2 handoffs waiting on GitHub"*. This is the only signal in the design that is
not on local disk; §2.9 prices it and concludes it is fetched **on panel open
only, never on a timer**, so it costs nothing while the panel is shut. The
consequence, stated rather than hidden: **the tray glyph cannot carry this bit.**
The glyph is a local instrument.

**#4 — staleness, and it is a different number from #1.** After §1.2a(b), a row
carries *written* age and, when they differ meaningfully, *arrived* age. A row
reading `written 3 hr ago · arrived just now` is the Scenario B signal in one
line, and it is the line the brief asked what it would look like.

**#5 — the collision warning.** A Tier B line that appears only when true:
*"⚠ two harnesses are writing `<project> · main`"*. It is a warning, not a
metric; it names the scope and it says nothing else, because the remedy (give
them separate scopes) is the user's to apply and the widget has no business
proposing it in six words.

**#6 — save health.** Three distinct conditions, all currently invisible outside
a careful read of the app view:

| Condition | Where the fact lives | Line |
|---|---|---|
| Handoff approaching the 48 KB cap | `bytes` on the pair row (already there) | The budget rule, §1.5 |
| The journal append failed | `journalWritten` on the save result — **not on any read** | Not currently reachable; see §5 |
| Collision guard disarmed | `installIdAvailable` — on the scope read, not the index | One line when false |

Only the first is reachable today at index level. The other two are named here so
they are not mistaken for shipped facts.

#### The standing brief — one line, and the honest reason (unchanged)

`state/project.md` is tier 1: hand-authored, returned on every read, and
deliberately unwritable by any tool. **A menubar dropdown is the wrong surface
for it**, and the argument is worth stating rather than asserting:

- It is up to 32 KB (`MAX_BRIEF_BYTES`) of prose and firm decisions. That is a
  document, not a status line.
- It changes on the order of *weeks*. The audience is watching something that
  changes on the order of *minutes*.
- Its whole value to a resuming agent is that it is read **in full, at the start
  of a session**. Skimming three lines of it in a menubar serves nobody.

So the brief is **Tier C**: it appears nowhere in the body. If it earns anything
at all it is a single line under the project in the scope popup — *"Standing
brief · updated 6 days ago"* — because a stale or missing brief is exactly what
makes a resumed session go wrong. Clicking it opens the app.

#### Logs — a link, not a tail (unchanged)

`~/Library/Logs/The Curator/curator.log`, bounded at 5 MB with single-generation
rotation. **Do not tail it in the panel.** The decisive fact is not the width —
it is the volume: `src/brain/logger.js` records startup facts, provider and
model, update outcomes and caught errors, and **per-request logging was
deliberately excluded** (v3.29.0). So on a healthy machine this log emits a
handful of lines a day, most of them at launch. A tail would show the same three
startup lines for hours and then, on the one day something breaks, a truncated
stack trace at 300 px wide.

What earns the space is **one item — "Open Log…" — plus a state indicator that
only appears when it has something to say**: *"Open Log — 2 errors today"*. That
count does not exist yet: `getLogFileStats()` returns `{path, bytes, mtimeMs}`,
the file and not its contents. An error count needs a process-lifetime counter in
`logError()` — three lines, no new state on disk. Said plainly rather than
implied to be available.

#### The layout

Flat, newest write first, **not grouped by project** — and this reverses the
first pass, which proposed project grouping.

```
┌───────────────────────────────────────────────┐
│  Agent memory                    updated 14:32│   panel, absolute stamp
├───────────────────────────────────────────────┤
│  ●  curator · main         claude-code · 2 min│   ← this machine: harness
│     wired the tray bounds                     │
│                                               │
│  ◐  curator · widget-research  opencode · 18 m│   ← two harnesses, two scopes
│     re-derived the visualisation section      │
│                                               │
│  ○  notes · main            studio · 3 hr ago │   ← other machine: machine
│     arrived just now                          │
│     rewrote the fetch serialiser              │
├───────────────────────────────────────────────┤
│  ↓  2 handoffs waiting on GitHub              │   Tier B — only when true
│  ⚠  two harnesses writing curator · main      │   Tier B — only when true
├───────────────────────────────────────────────┤
│  Open Agent memory…                           │
│  Open The Curator                             │
│  Settings…                                    │
│  Quit The Curator                             │
└───────────────────────────────────────────────┘
```

**Flat by recency rather than grouped by project — the argument.** The audience is
watching *an agent*, and an agent works in one scope at a time. "What has just
happened" is a recency question, and grouping answers a different one ("what is
the state of my projects") that the app's Agent memory view already answers
better, with room for it. Grouping also spends vertical space on headings in the
one surface that has none. The project name survives as a dim prefix on each row,
so nothing is lost but the ordering.

**The cost of flat, stated:** one busy project can monopolise all eight rows. That
is accepted rather than mitigated — a per-project quota inside an eight-row list
is the kind of cleverness that produces two behaviours and one bug, and the
overflow item ("Open Agent memory…") reaches everything.

**Eight rows.** Roughly what fits above the fold of a menubar panel at a
comfortable row height without the panel becoming a window. `MAX_PROJECTS` is 200
server-side and `MAX_INDEX_ENTRIES` is 60 per project; the panel must **show** the
truncation rather than hide it — a cap must never read as a measurement, which is
this project's own recorded rule.

**Where the rows come from.** `GET /api/memory` returns **one row per project**
(the newest pair only), so a flat list of the eight most recent *pairs across all
projects* is not obtainable from it without a route change. It is obtainable
directly: the Electron main process already imports `src/server.js` into its own
Node realm, so it can call `listWorkingScopes` itself, with no HTTP hop and no new
route. Same store function the app and the MCP use — a different projection of it,
not a second inventory. The projection belongs in a pure, Electron-free
`desktop/lib/tray-model.js` so the offline suite can execute it (§4).

#### When there are none

This matters more than it looks: it is the first thing every new user sees. The
empty state is **not** an error and must not read like one. The panel should say
*"No agent memory yet — a coding agent writes here through the my-curator MCP"*,
with a link to the setup docs, and nothing else. The failure to avoid is a blank
panel that looks broken.

It is also the reason the widget is **off by default** (§1.10): on a fresh
install this is the only thing it can ever show.

### 1.4 NSMenu versus a rendered popover — argued, then decided

> **BUILT AS DECIDED.** Phase 1 ships a native `Menu`. See [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan).

The maintainer's reference is the Stats / iStat Menus class: a compact glyph in
the bar, and on click a **popover panel** with titled sections, sparklines and
labelled bars. A plain `NSMenu` cannot draw that.

**Two corrections from §3 before the table, because the naive framing is wrong in
both directions.** First, *"the menu bar cannot draw charts"* is **false in
AppKit** — Stats injects a custom `NSView` into its status item's button, which is
how its `lineChart` and `networkChart` widgets exist at all. It is **true in
Electron**: `Tray` has no API to attach a view (VERIFIED, §3.2). Second, the
constraint is not absolute even for us: xbar and SwiftBar prove a **base64 raster
image is the escape hatch** (§3.5), and `tray.setImage()` accepts one — so a
rendered glyph in the *bar* is reachable from Phase 1 without any popover at all.
That is a genuine third option and it is noted in §5, question 5.

> **Research findings on how the reference apps actually work are in
> [§3](#3-what-other-menubar-apps-actually-do-research).** Read that before
> re-opening this decision.

**The two options, priced:**

| | Electron `Tray` + `Menu` | Electron `Tray` + frameless `BrowserWindow` |
|---|---|---|
| What it can draw | Text, checkmarks, submenus, a template image per item. **`Tray` exposes no way to attach a rendered view — VERIFIED** (§3.2) | Anything the app's own CSS can draw |
| Apple's HIG | **Endorsed**: "Display a menu — not a popover … unless the functionality is too complex for a menu" (§3.6) | A deliberate departure from the HIG, which every comparable app also makes |
| Process cost | **Zero extra renderer processes.** The menu is native, built in the main process | **One additional renderer process**, resident for the life of the app unless destroyed on close |
| Memory cost | Negligible | ~25–45 MB (INFERRED — see §2.7; the measured full-app renderer is 43 MB) |
| Idle cost when closed | Zero — a native menu that is not open runs nothing | Depends entirely on what the page does when hidden — §2.6 |
| Show/hide, click-outside, positioning | Free, native, correct | Hand-built: `tray.getBounds()`, `blur` handling, multi-display and notch edge cases |
| Reuses the app's design system | No | Yes — `tokens/`, the type ramp, light/dark |
| Keyboard / VoiceOver | Free and correct | Hand-built |

**The decision: build the popover, but not first.** The reasoning is a sequence
rather than a single call — and §3's research moved one input (the HIG says
*menu*, explicitly) without moving the conclusion, because the HIG's own test is
*"unless the functionality is too complex for a menu"* and Phase 1 is not:

1. **The data justifies it, narrowly.** §1.5 identifies exactly *two* honest
   visual encodings — recency and budget-fill. Both are bars. Neither is
   drawable in an `NSMenu`. If those two encodings are worth having, a rendered
   panel is required; if they are not, the menu is strictly better on every row
   of the table above.
2. **They are worth having, but the boring list is not far behind.** This is the
   part to be honest about. A list of `scope — 4 min ago — "wired the tray
   bounds"` conveys most of the value. The bars add *pre-attentive* scanning:
   you see which scope is hot without reading. For someone glancing at it twenty
   times an hour, that difference is real. But it is an *improvement on a good
   list*, not a rescue of a bad one.
3. **So ship the list first and the panel second.** Phase 1 is a `Tray` +
   `Menu`: it delivers the background-running property, the presence signal, the
   scope list with relative ages, and the click-through — which is the whole of
   §1.1's Scenario A and most of Scenario B. Phase 2 replaces the menu with a
   popover and adds the two encodings. Phase 1 costs no renderer; Phase 2's cost
   is then paid against a feature people are already using, which is the right
   order to spend it in.

> **SECOND-PASS NOTE — the decision survives, and two inputs moved.** The scope
> **popup** the maintainer asked for (§1.7) is a Phase 2 thing and cannot be built
> in an `NSMenu`, which makes Phase 2 less optional than the first pass implied —
> it is now the phase that satisfies an explicit request rather than a nice-to-have
> pair of bars. And §3.7 found two shipping precedents for drawing events in a
> status surface, so the "nobody does this" caution against a rendered panel is
> weaker than it was. Neither changes the **order**: Phase 1 still delivers
> everything except the popup, at no renderer cost, and it is what should ship
> first.

**If the popover is built, three non-negotiables** (all of them cost items in
§2.6):

- `backgroundThrottling: true` explicitly set on it, not inherited by accident.
- The window is **destroyed on close**, not hidden, unless measurement shows the
  re-create latency is perceptible. A hidden renderer is a resident renderer.
- **Nothing animates and nothing polls while it is closed.** The data it renders
  is pushed to it (§1.6), so a closed panel has nothing to do.

### 1.5 Visual encodings — re-derived for two harnesses and three machines

> **PARTLY BUILT.** The recency buckets are computed and keyed on the true save
> time as this section requires, and the *"changed 4 min ago"* wording is what
> shipped. **Neither the budget bar nor the pip is drawn** — a menu item cannot
> draw either. Deviation 5 in [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan).

The brief asks whether, with several harnesses and several machines in play,
there is now **a genuinely continuous quantity worth drawing**. Re-derived from
scratch rather than inherited, the answer is **no — but the shape of the discrete
data changed, and that matters more.**

Our data is not a system monitor's data, and this is the central design problem.
A CPU meter has a continuous, bounded numeric series; that is what makes a
sparkline and a percentage bar truthful. A scope save is a **discrete event with
a timestamp, a byte count, a harness, a model and a headline**. Adding a second
harness and a third machine does not make it continuous. It makes it a **marked
point process with a source label** — several interleaved streams of instants,
which is a different thing from a signal sampled over time, and it is drawn
differently.

What *did* change: **there is now more than one source**, and the interleaving of
sources is itself information (§1.2a(a)). That is the only genuinely new visual
opportunity in this pass, and §1.5's event strip is redesigned around it.

This project has a recorded rule that a fact and its absence must never collapse
into the same value (v3.15.0). Borrowed chrome that implies precision we do not
have is that same defect rendered in pixels.

#### ACCEPTED — budget fill, unchanged, and it is a genuine bounded percentage

`MAX_STATE_BYTES = 48 KB` is a real, hard cap. An over-budget save is **trimmed
and disclosed in `notes`**, never refused — so approaching the cap is a real
condition with a real consequence the user can act on (split the scope).

`bytes / 48 KB` is therefore an honest percentage bar: bounded, meaningful at both
ends, and it surfaces truncation behaviour that already exists and is currently
invisible unless you read the notes. **This is the one percentage bar the design
should have**, and it is worth having precisely because it is the one number in
the whole store that behaves like the reference app's numbers. `bytes` is already
on every pair row, so it costs nothing.

Render it small — a 3 px rule under the headline — and colour it only past a
threshold (say 80%), so it is invisible until it means something.

#### ACCEPTED, WITH A CORRECTION — recency buckets, keyed on the TRUE save time

Recency is the strongest candidate for the "progress bar" the maintainer asked
for, and it needs care, because **it is unbounded**. A scope can be four seconds
old or eight months old. A linear bar needs a maximum, and any maximum is
invented — which makes the bar's *fullness* a fiction.

The honest encoding is **discrete states on a log-ish scale**, shown as a pip,
plus the exact relative time in text:

| State | Age | Reading |
|---|---|---|
| Live | < 2 min | An agent is working in this scope **right now** |
| Warm | < 30 min | This session |
| Today | < 12 h | Earlier today |
| Cool | < 7 d | This week |
| Cold | ≥ 7 d | Dormant |

**The correction from §1.2a(b): the age driving this must be `writtenAt`, not
`ageSeconds`.** Keyed on mtime, a single `git pull` turns every incoming scope
Live, and the widget announces an agent at work on a machine that has been asleep
since yesterday. That is the design's strongest signal being wrong exactly in the
scenario it was extended to serve. When `writtenAt` is missing the pip falls back
to mtime **and the row says so** — *"changed 4 min ago"* rather than *"written 4
min ago"* — rather than presenting a weaker fact in a stronger fact's clothing.

**Arrival is a second, separate line, not a second pip.** When a row's content was
written elsewhere and landed here recently, the row carries a plain sentence:
*"arrived just now"*. It is a different question from *how old is this work*, and
the two must not be collapsed into one number — which is precisely what the
mtime-only design did.

`formatAge` is **already exported** from `src/public/next/views/memory.js:730` and
must be shared rather than reimplemented — two functions rendering "4 min ago" is
the smallest possible version of the two-surfaces-drift problem §1.7 is about.

#### ACCEPTED, DEMOTED — a per-source event strip, in the scope popup only

`journal.jsonl` is genuinely a point process: one append-only line per save
carrying `{ at, scope, machine, harness, model, headline, bytes, rejections }`.
For a person watching an agent work, *"has it written anything in the last ten
minutes"* is a real question, and *"are two harnesses taking turns in this one
scope"* is a real and currently invisible one.

**The honest form is a rug plot with one lane per source** — a horizontal track
covering a fixed window (say the last 60 minutes), one tick per save, positioned
by time, with a lane per `harness` (Scenario A) or per `machine` (Scenario B):

```
   claude-code  │   ▏  ▏▏      ▏          ▏▏  │
   opencode     │ ▏      ▏  ▏      ▏▏         │
                └─ 60 min ago ──────── now ───┘
```

That reads instantly as *"both of them have been writing this scope"*, which is
the §1.2a(a) collision, and it claims nothing it cannot support. Optionally tick
*height* encodes `bytes`, a real per-event quantity — a Phase 3 refinement; the
plain strip is already useful.

**Three constraints, and the third is new:**

1. **It must never be a filled area sparkline.** A filled curve interpolates
   between samples and implies a continuous quantity exists *between* the points.
   There is no "amount of memory" at 14:32 halfway between the 14:30 and 14:35
   saves. Drawing one is exactly the borrowed-chrome defect.
2. **AMENDED BY §3.7 — it DOES have precedent, and the precedent says bucket
   it.** The first pass found none; a deeper search found **StreakBar** (a
   contribution grid rendered inside the status item) and **VitalsBar** (one bar
   per check, per source, in the pane). Both, and every other example found,
   **bucket into a uniform grid first** — one cell per day, one bar per poll.
   Nobody plots events at irregular real timestamps, and uniform bucketing is what
   makes those strips readable at 16 px. So the strip above becomes **twelve
   five-minute cells across the last hour, one lane per source**, with **every
   cell drawn and empty ones at low opacity** — StreakBar's own encoding, and the
   fact-versus-absence rule arrived at independently. Still the last thing built
   and the first thing cut.
3. **It belongs in the scope popup, not the top-level panel** — this is the
   demotion. A merged strip across every scope answers nothing: ticks from three
   unrelated workstreams next to each other form a pattern that means nothing.
   Split by source *within one scope*, it means something specific. So it is a
   per-scope instrument, it needs the popup (§1.7) to exist first, and it needs
   journal data the index does not carry — which the popup fetches anyway.

#### REFUSED — and the reasons, so nobody re-adds them

| Refused | Why |
|---|---|
| **A percentage-complete bar for a save** | There is no completion. A save is atomic (`writeFileAtomic` = tmp + rename). A bar would render a fiction. |
| **A filled sparkline of save events** | Implies interpolation between discrete events. |
| **A save-rate or saves-per-hour figure drawn as a magnitude** — NEW | Save frequency is a property of **the skill's capture cadence**, not of work done. An agent instructed to save early and often produces more ticks than one that saves twice; drawing that bigger says *more progress* when it means *different instructions*. Any encoding where "more saves" reads as "better" is refused. The strip above escapes this only because it encodes **presence and interleaving**, not amount. |
| **A sync progress bar** — NEW | "How far from being in sync" has no honest denominator: being one commit behind can be one file or four hundred. `behindFiles` and `behindCommits` are two counts, and they should be shown as counts. See §1.9a for where a sync *control* would live. |
| **A live CPU/memory/throughput meter of The Curator itself** | It borrows the reference app's *subject*, not just its chrome. Nobody installed a second brain to watch its RSS, and it would be the one part of the panel that must poll continuously — the most expensive thing we could add, bought for the least value. |
| **A "context window used" gauge** | The Curator does not know the agent's context window. Inferring it from handoff size would be a fabricated number on a surface whose whole job is telling the truth about state. |
| **A tail of `curator.log`** | Volume is a few lines a day (§1.3). Replaced by an error *count*. |
| **A count-up "time since last save" ticking every SECOND** | Forces a timer while the panel is open for a number nobody reads to the second. **Amended by §3.9:** a **60-second** re-render *while the panel is open only* is accepted — syncthingStatus ships exactly that, it is the documented remedy for the Codex stale-snapshot bug, and it costs nothing when closed. Per-second remains refused. |
| **Rendering `current.md`** — NEW | §1.7. The widget renders the journal; the app renders the handoff. |

#### ACCEPTED — a last-updated stamp on the panel itself

Added because of §3.3's strongest finding: OpenAI's Codex menubar app has an open
bug filed **precisely** for showing event data with no freshness marker, and the
proposed remedy is *"showing a 'last updated at HH:MM' timestamp"*.

So the panel carries one **absolute** `HH:MM` stamp in its footer, distinct from
the rows' **relative** ages. The two answer different questions — *how old is this
event* versus *how old is this reading* — and conflating them is how a widget
comes to display a confidently stale list. It also costs one line and makes a
silently-dead watch (§1.6) visible rather than invisible.

#### The menubar glyph itself

The icon is the presence signal — *"The Curator is running"* — and it should carry
**at most one bit** beyond that.

**The glyph is a LOCAL instrument, and that is now an explicit rule.** §2.9 puts
the remote check on panel-open only, so the glyph cannot carry "another machine
has pushed". Trying to would require a background network timer for one bit of
tray state — the single worst cost-to-value trade in this document.

The candidate bit is **live**: an agent has written on *this machine* in the last
two minutes. §3.3 offers a better candidate — `gitnews-menubar` distinguishes
*unread* from **"unseen — probably just arrived"**, novelty relative to when you
last looked. For our audience that may be stronger: "live" goes false two minutes
after an agent stops, while "unseen" stays true until the user actually looks,
which is the question they are really asking. It costs a little state (a
last-opened timestamp, per install, not per scope). Open question — §5.5.

**CCMenu's priority-collapse rule is the one to steal** for reducing many scopes
to one glyph: our order would be *live > unseen > idle*, because a glyph that
reflects only the newest scope is wrong the moment there are two — and in
Scenario A there are always two.

A subtle filled/hollow state on a **template image** is enough; template images
are the only thing guaranteed to look right against light, dark and tinted menu
bars (Electron's own tray guidance — §3.2). Explicitly **no badge count** and
**no animation**: a count of what, and an animated glyph in a menu bar is the
thing people uninstall apps over.

### 1.6 How it stays current — filesystem watch, and this is measured

The MCP server writes state **in a separate process**, so there is no in-process
event to subscribe to. That leaves polling or a filesystem watch. `fs.watch` on
macOS has enough folklore around it that it was tested rather than trusted.

**Measured (see §2.4 for the full numbers):** a single
`fs.watch(getDomainsDir(), { recursive: true })` —

- **works**, and delivers events for saves nested four levels deep;
- **catches scopes and whole projects created *after* the watch was
  established** — no re-arming, no per-directory bookkeeping. This is the
  decisive result; a naive per-directory watch would silently miss every new
  scope, which is exactly the event the widget exists to show;
- median first-event latency **6.5 ms** (range 5–13 ms over 10 saves);
- costs **0.0044% of one core** to hold over a 10,000-file tree, versus
  **0.31%** for a 20-second poll of the same tree — a **70×** difference;
- produced **zero** false positives from 30 wiki writes: none of the 32 events
  those writes generated contained `/state/`.

**Two properties a consumer must handle, both observed:**

1. **Three events per save**, not one — the `.tmp-…` file, `current.md`, and
   `journal.jsonl`, all within the same millisecond. The watcher must **debounce
   (~150 ms) and filter dot-prefixed names**, or every save triggers three
   refreshes.
2. **Every event arrives with `type: 'rename'`, never `'change'`** — an FSEvents
   artefact of the recursive path on macOS. So the event type carries no
   information; the watcher must not branch on it.

**The design.** Watch → debounce → **re-run `listWorkingScopes` in the main
process** → diff against the last snapshot → if changed, update the tray glyph
and push to the panel *if it is open*. **When the panel is closed the cost is a
debounce timer and one index read per actual save** — and saves happen a few
times an hour, not a few times a second.

**Belt and braces, and it is cheap:** a **5-minute** fallback poll. Measurement
made this case *weaker* than expected — the watch survived a burst of 100 saves
with nothing dropped, and survived its own root being deleted and recreated — but
the untested cases are real (a network volume, a `domainsPath` on another volume,
FSEvents overflow under whole-disk load), and the fallback's measured cost is
0.02% of a core. At 300 pairs that is 61 ms every 5 minutes = **0.02% of a
core**. That is the interval I would defend: slow enough to be free, fast enough
that a lost watch degrades to "slightly stale" rather than "silently dead".

**Additionally, refresh on panel open.** The panel is opened deliberately; a
fresh read at that moment costs one index call and removes any question about
staleness at the exact moment the user is looking.

**The rule to write into the code:** the watch and the fallback both live in the
**main process**, not the renderer. A renderer that polls is a renderer that must
stay alive; a main process that watches is a main process that was going to be
alive anyway.

### 1.7 Click a scope, see it — REVERSED IN PART, and here is the safe version

> **NOT BUILT.** There is no popup. A row click opens the app on Agent memory at
> that **project** — not that scope; deviation 4 in
> [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan). The tier rule
> and the hard constraint in this section are the contract Phase 2 must be built to.

The maintainer asked for this specifically: *click a scope to see it, without
having to open the whole app*. The first pass refused, on the grounds that a
handoff runs to 13–16 KB in real use (48 KB cap) and that a second reader of the
same document is how two surfaces drift.

**Both halves of that reasoning are correct, and the conclusion was still too
broad.** Re-derived, there is a version of the popup that gives him what he asked
for and cannot drift, and the distinction is *what gets rendered*.

#### The rule: the widget renders the JOURNAL. The app renders the HANDOFF.

That maps cleanly onto the store's own three tiers, and it is the structural idea
of this section:

| Tier | What it is | Shape | Surface | Why |
|---|---|---|---|---|
| **3 — `journal.jsonl`** | One line per save: `{at, harness, model, headline, rejections}` | A **structured, sanitised, bounded array** | **The widget** | Already parsed by the store; no rendering decisions to make; naturally glanceable |
| **2 — `current.md`** | The handoff, up to 48 KB of headed markdown | A **document** | The app's Agent memory view | Needs section parsing, markdown rendering, fold state, truncation and duplicate-heading disclosure — every one of which is a place two surfaces can disagree |
| **1 — `project.md`** | The standing brief, up to 32 KB, changes weekly | A **document**, hand-authored | The user's editor / Obsidian | It is meant to be read in full at session start, and it is the one tier no tool writes |

**Why the journal is safe and `current.md` is not.** `readWorkingState` returns
the journal as an array of already-sanitised, already-capped fields —
`neutraliseProtocol` has run, `MAX_HEADLINE_CHARS` has been applied, the entry
count is bounded. There is nothing left to decide: the widget prints strings. It
returns `current.md` as **raw markdown text** in `current.text`; anything useful a
widget could do with it requires parsing `STATE_SECTIONS` headings and rendering
markdown, which is a second implementation of both, and the app's version took two
releases to get right (fold state, revalidation, `duplicateHeadings`,
`sanitisedOnRead`, `truncated`).

> **One correction to the first pass while agreeing with its conclusion:** it
> argued the second reader would need "its own sanitiser call sites". It would
> not — sanitisation runs on **read**, in the store, for both surfaces. The real
> drift surface is **parsing and rendering**, which is narrower and, for the
> journal, zero. That narrowing is what makes the popup shippable.

#### What the popup contains

```
┌──────────────────────────────────────────────┐
│  curator · widget-research                   │
│  opencode · claude-opus-5 · written 18 min   │
│  ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁░░░░  22 KB of 48 KB       │  budget rule (§1.5)
├──────────────────────────────────────────────┤
│  18 min   opencode    re-derived the visual… │
│  41 min   opencode    measured git mtime on… │
│   2 hr    claude-code ranked the use cases   │
│   3 hr    claude-code read the store and ro… │
├──────────────────────────────────────────────┤
│  Machines with this scope:  this Mac, studio │
├──────────────────────────────────────────────┤
│  Open in The Curator            Reveal file… │
└──────────────────────────────────────────────┘
```

Everything above the last row comes from **one existing call** —
`GET /api/memory/:project?scope=…&journalLimit=8` — with no new endpoint and no
new parameter. That refutes the first pass's open question 2 for this case: the
*popup* needs nothing new; only the cross-scope event strip would.

**The hard constraint, written so it survives a future feature request:**

> The popup may render **journal entries, counts, ages, machine names and the
> budget bar**. It may **not** render `current.md`, in whole or in part. The first
> time it needs a heading, a bullet list or a code block, it has become a second
> reader and must stop and hand off to the app instead.

#### What he loses, said plainly

The popup shows **what has happened**, not **where things stand**. `now_state` —
the prose section that carries most of the meaning of a handoff — is not in it and
never will be. Someone who reads only the popup is reading the shallowest tier,
and a person resuming a scope still has to open the app or the file. The popup
answers *should I look at this?*; the app answers *what is in it?*

That is the honest trade, and it is the right one: the alternative — a menubar
panel that renders 16 KB of prose — is not a menubar panel.

#### The secondary action, and it may be the primary one for this audience

**"Reveal file…"** (`shell.openPath` / `shell.showItemInFolder`) is one line of
code, costs no new surface, and for developers may genuinely be the preferred
read — the handoff is plain markdown and their editor is already open. It is
offered alongside "Open in The Curator". Which of the two should be the *row's*
default click is §5.3 and is a taste question the maintainer should settle.

#### Phase 1 has no popup at all

In Phase 1 (a native `Menu`, §1.4) a row's click simply opens the app on that
scope — the first pass's answer, and correct for a surface that cannot draw a
card. The popup arrives with Phase 2, which is when there is something to draw it
in. So the sequencing is unchanged; only the Phase 2 content is.

### 1.8 The Dock icon, and how the window comes back

> **NOT BUILT.** `tray-only` is recognised and behaves as `tray`; the Dock icon is
> left alone and the plan reports `hedged: true`. Deviation 1 in
> [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan).

This is the decision with the most consequences and the least room to be clever.

**The right API is `app.setActivationPolicy('accessory')`, not `dock.hide()`.**
VERIFIED in §3.2: `'accessory'` means "doesn't appear in the Dock and doesn't
have a menu bar, **but it may be activated programmatically or by clicking on one
of its windows**" — which is exactly the behaviour this design needs, and it
directly refutes the worry that hiding the Dock icon strands a window. Electron's
docs never mention `LSUIElement` at all, so do not cite them for it.

**Two implementation hazards, both VERIFIED and both easy to hit.** `dock.hide()`
"within one second of a previous call will have no effect" (Electron docs), and
the `menubar` library ships a **2000 ms re-hide** because the first call "can be
silently dropped when it races the launch activation transition". Whichever API
is used, the hide must be confirmed rather than assumed — `dock.isVisible()`
exists for exactly that.

**`LSUIElement` / `app.dock.hide()` — what it actually costs.** An app with no
Dock icon has:
- no Dock tile to click to get the window back,
- **no application menu bar** (no File/Edit/View/Window, no ⌘Q, no ⌘W, no About),
- no ⌘Tab entry,
- no entry in Force Quit's list, which matters because ⌘Q is also gone.

For a product whose primary surface *is* a window — ingest, chat, health,
settings — that is a large amount of standard behaviour to delete. And v3.30.0
has already been through one round of this exact class of mistake: `hiddenInset`
removed the title bar and the app never took over the job the title bar was
doing.

**Decision: three-state, defaulting to the least surprising.**

| Setting | Dock icon | Tray icon | Closing the window |
|---|---|---|---|
| **`window` (default, today's behaviour)** | Always | No | Hides the window; app keeps running (already true since v3.30.0) |
| **`tray` (opt-in)** | Always | Yes | Hides the window; the tray is the way back |
| **`tray-only` (opt-in, advanced)** | Hidden while no window is visible | Yes | Hides the window and the Dock icon |

**§3.4 supplies a reason for the default that is stronger than caution.**
Tailscale moved *off* menubar-only after finding that when items exceed the space
right of the notch they **simply vanish** — "no notification to the user, no
overflow section". And macOS 26 added a Menu Bar privacy control an app must be
explicitly allowed into, so **a newly-created tray icon may not appear at all.**
An install whose only affordance can silently disappear is not one to opt users
into. First-run copy must anticipate an absent icon rather than treating it as a
bug.

The default is **`window`** — identical to today. A user who updates and does
nothing sees no change at all. That is the migration story in §1.10 and it is
also the safest default for a release whose predecessor's headline problem was
"the download-install-run path crashes".

**`tray-only` is offered but hedged**, and the hedge is structural rather than a
warning label: the Dock icon is hidden **only while no window is visible**, and
`app.dock.show()` is called before any window is shown. So the moment the user
opens the app from the tray, the full menu bar and ⌘Q come back. The
never-recoverable state — no Dock, no menu, no window, and a user who has
forgotten what the tray icon looks like — is not reachable, because the tray
icon's menu always carries **"Open The Curator"** as its first item and **"Quit"**
as its last.

**How the window comes back, in every state.** `revealWindow()` in `main.js`
already handles the three cases (destroyed, hidden, minimised) and already has
the comment explaining why `getAllWindows().length === 0` was the wrong test. The
tray's "Open The Curator" item calls exactly that function — a **fourth caller of
one existing recovery path**, not a fourth recovery path.

### 1.9 Quit, when there is no window

The existing guard must not be weakened, and it needs one addition.

`desktop/lib/quit-decision.js` is a pure function over `GET /api/write-status`,
returning `quit` or `ask`, with `safeToQuit: null` deliberately its own case. It
is executed by the offline suite. **None of that changes.**

What changes is the **dialog's parent window**, and `main.js` already handles it:

```js
const { response } = mainWindow
  ? await dialog.showMessageBox(mainWindow, opts)
  : await dialog.showMessageBox(opts);
```

That branch was written for the windowless case and is currently near-dead code.
In tray mode it becomes the **normal** path, so it stops being a hedge and starts
being the thing under test. Two additions:

1. **The app-modal dialog must be brought to the front.** A modal with no parent
   window can appear behind other apps — in tray-only mode the user has no Dock
   icon to click and may not find it. `app.focus({ steal: true })` before showing
   it, and the tray glyph should reflect that something is waiting.
2. **`before-quit` must fire from the tray's Quit item too.** The tray menu's
   Quit calls `app.quit()`, which triggers `before-quit`, which runs the existing
   guard. It must **not** call `app.exit()`, which skips it. This is the single
   most likely way to break the guard while adding a tray, and it should be
   asserted by the packaging suite the way the existing decision function is.

One genuinely new hazard, stated rather than discovered later: **an app that
survives window close survives longer, so it is more likely to be running when a
write is in flight.** The guard becomes *more* load-bearing, not less. And
`desktop/README.md` records that the `ask` branches "have only ever been
exercised as pure functions" — this feature is the reason to fix that.

### 1.9a Where a sync control would live — a note for the automatic-sync work

**Not designed here.** Automatic sync is being researched in parallel and this
section exists only so that work has a place to land and three hazards it must
not walk into.

**Where it goes.** The panel footer, as **one item beside the "N waiting on
GitHub" line** — not in the row list, and never as a per-row control. Sync is a
whole-repo operation; a Sync button on a scope row would imply a per-scope
transfer that does not exist.

**Three constraints the widget imposes on whatever that control turns out to be:**

1. **Never a bar or a percentage.** §1.5 refuses a sync progress bar: being one
   commit behind can be one file or four hundred, so there is no honest
   denominator. `behindFiles` and `behindCommits` are two counts and belong on
   screen as counts.
2. **It must respect `hasActiveWrites()`.** Every mutating sync route is already
   wrapped in `guardConcurrent`; a tray control that bypasses that is a second
   entry point to a guarded operation. It should be **disabled with a reason
   shown**, not hidden — a control that vanishes reads as a bug.
3. **Any background `git fetch` must go through `gitFetch()`.** This is the
   sharpest one. `src/brain/sync.js` records a measured incident: two fetch sites
   writing `refs/remotes/origin/main` concurrently is a compare-and-swap race, and
   **the loser was the user's own pull — it aborted before merging in 11 of 12
   runs against real git.** `gitFetch()` now serialises every fetch this process
   issues. A widget that adds a *third* fetch site on its own timer re-creates
   that race unless it goes through the same function. §2.9's conclusion — fetch
   on panel open only, never on a timer — reduces the exposure but does not remove
   the rule.

### 1.10 Migration, and the user who wants none of this

**Default is off. That is the migration.**

A user who updates to the release carrying this feature gets: the same Dock icon,
the same window, the same close behaviour, **no tray icon**. Nothing appears in
their menu bar unless they ask for it. The feature is discovered in Settings, not
inflicted at launch.

**Where the preference lives, and a finding about that.** The obvious home is
`.curator-config.json`, and the obvious mechanism is v3.28.0's `ui.*` UI-state
allow-list. **That mechanism does not fit**, and it is worth recording why rather
than discovering it in code review: `UI_STATE_SPEC`'s four fields are all
consent-shaped — `monotonic`, `writeOnce`, or a single `clearable` dismissal.
Every field is write-once or one-way by construction, because the whole point of
that table is that a consent cannot be silently downgraded. **A background-mode
preference is a two-way toggle a user may flip repeatedly**, which no field in
that spec can express.

The right precedent is `sharedBrainEnabled` — a plain top-level boolean in the
same file, already read and written freely. So: **a top-level
`backgroundMode: 'window' | 'tray' | 'tray-only'` field**, following
`install-mode.js`'s "a named string, not a boolean" convention so a fourth mode
does not require a second field. Absent or unrecognised resolves to `'window'` —
the same fail-safe asymmetry `paths.js` uses for install-mode detection and
`releaseChannel` uses for its channel.

**Confirmed this pass, and the argument is now stronger than caution.** The
first pass argued `window` as the default because it changes nothing for an
existing user. The stronger reason is about the *new* user: **the widget's value
is proportional to how much agent traffic you have, and a fresh install has
none.** Turning it on by default gives every new user a permanently-empty menu bar
icon whose only content is the empty state (§1.3) — the worst possible first
impression of the feature, and one that teaches them the icon is not worth
clicking. Apple's HIG says the same thing from the other direction: *"Let people —
not your app — decide whether to put your menu bar extra in the menu bar"* (§3.6).

**So: default off, for new and existing installs alike.** No two-defaults-keyed-on-
`installOrigin` cleverness (first pass, §5.1) — one code path.

**But "discovered in Settings" is too passive, and this is the refinement.** The
moment the feature becomes worth having is the moment a project first accumulates
real agent traffic. So: **a single dismissible line in the Agent memory view**,
shown once a project crosses a small threshold (say two saves across at least one
scope), reading roughly *"Watch this from the menu bar — Turn on · Not now"*. Not
a modal, not a launch prompt, not a badge. It appears where the user is already
looking at exactly the thing the widget shows.

**And that dismissal IS an `ui.*` field, even though the mode is not.** The first
pass established that `UI_STATE_SPEC` cannot hold `backgroundMode`, because every
field in it is `monotonic` / `writeOnce` / a one-way `clearable` dismissal and a
background-mode toggle flips both ways. Correct — and the *offer's dismissal* is
the opposite: a one-way "I have been asked, do not ask again", which is precisely
the shape that table exists for. Two fields, two mechanisms, each in the right
place:

| Field | Home | Shape |
|---|---|---|
| `backgroundMode: 'window' \| 'tray' \| 'tray-only'` | top level of `.curator-config.json`, beside `sharedBrainEnabled` | free two-way |
| `ui.menubarOfferSeen` | `UI_STATE_SPEC` | one-way dismissal |

**Naming, because the user's question is not the config key's question.** The
field is about the app's *background mode*; the setting the user is looking for is
*"do I get a menu bar icon"*. The Settings control should be labelled and ordered
around the menubar question — **Off / On / On, and hide the Dock icon** — with the
Dock consequences spelled out under the third option (§1.8). The three-value enum
is right and should not become two booleans: it makes the illegal fourth
combination (no tray, no Dock) unrepresentable.

**One ordering constraint that will bite if missed:** the main process needs this
value **before it creates the tray or the window**, and the renderer does not
exist yet at that point. `main.js` already imports `src/server.js` into its own
Node realm, so it can import `config.js` directly — the same channel
`registerDesktopHost` already uses. It must **not** wait for the renderer to tell
it.

**Reversibility.** Flipping back to `window` in Settings destroys the tray,
calls `app.dock.show()`, and shows the window. No restart. If a restart turns out
to be needed for the Dock transition, say so in the UI rather than half-applying
it.

---

## 2. Resource cost — measured

**Method.** Measured against the running v3.30.0 build installed in
`/Applications`, on macOS 15 / arm64, on 2026-08-31. No `.app` was launched for
this measurement — the already-running process tree was sampled. `sudo` was not
available, so `powermetrics` was not used; CPU is derived from **CPU-time deltas
over long windows**, which is more reliable than `top`'s instantaneous sampling
for a near-idle process anyway.

### 2.1 Memory — and `ps` overstates it by 2.2×

| Process | `ps` RSS | `footprint` phys_footprint | Peak footprint |
|---|---:|---:|---:|
| Main (Node + Electron browser process; **the whole Curator server runs here**) | 187.9 MB | **63 MB** | 66 MB |
| GPU process | 89.1 MB | **85 MB** | 583 MB |
| Renderer (the app UI) | 135.2 MB | **43 MB** | 50 MB |
| Network service (utility) | 41.6 MB | **8.2 MB** | 10 MB |
| **Total** | **443.1 MB** | **199.2 MB** | — |

**MEASURED.** The two columns differ because `ps` RSS counts the Electron
framework's shared pages once per process. **`phys_footprint` is what Activity
Monitor's "Memory" column reports**, so ~199 MB is the number a user judges, not
443 MB. Report the 199.

**Three things to notice:**

- **The GPU process is the largest single consumer at 85 MB**, and it peaked at
  **583 MB**. That is the most surprising number in this table: the app draws a
  static list UI and its GPU process costs more than the renderer and more than
  the entire Node server. This is the first optimisation target (§2.7).
- **The server is nearly free.** The main process at 63 MB carries Electron's
  browser process *plus* the whole of `src/server.js`, Express, all routes, and
  the brain modules.
- **Caveat, and it matters:** this install has **zero domains configured**
  (`GET /api/memory` returned 53 bytes — an empty `projects` array;
  `domainsPathSource` is `default`). **These are floor figures.** A real install
  with a 2,000-page wiki will hold more in the renderer while a large view is
  mounted. Nothing on the *server* side caches the wiki between requests, so the
  main process should not grow much — but that is INFERRED, not measured.

### 2.2 Idle CPU

| Window | Duration | Main | GPU | Renderer | Network | Total CPU-s | % of one core |
|---|---:|---:|---:|---:|---:|---:|---:|
| Window 1 (includes ~25 induced `curl` requests) | 300 s | 0.10 s | 0.02 s | 0.03 s | 0.03 s | **0.18 s** | **0.060%** |
| Window 2 (clean — no induced traffic) | 420 s | 0.11 s | 0.02 s | 0.03 s | 0.05 s | **0.21 s** | **0.050%** |

**MEASURED, two independent windows agreeing.** **0.050% of one core at idle.**

Put in the terms a user judging a background app would use: **at this rate the
app consumes about 43 seconds of CPU time per 24 hours.** That is not a
background app anyone uninstalls over CPU. The thing to protect is that this
stays true once the app is always running — which is what §2.7 is for.

The main process is the largest CPU consumer (0.11 s / 420 s), which is expected:
it is both the Electron browser process and the entire Express server. The GPU
process is nearly idle in CPU terms **while being the largest memory consumer** —
see recommendation 2.

**Window open versus hidden — NOT MEASURED, and here is why.** Determining
whether the window was visible required either an Accessibility-permission
AppleScript query or activating the app — both of which risk a consent dialog on
a machine where the maintainer is working and where crash dialogs have already
fired repeatedly today. I chose not to. What can be said: the GPU process
consumed 0.02 s over 300 s, which is consistent with a window that is not
animating anything, in either state.

### 2.3 Everything the app does on a timer

**Server side: MEASURED — there are ZERO recurring timers, and no filesystem
watches.** A `grep` for `setInterval` across `src/` excluding `src/public/`
returns exactly one hit, and it is a **comment** in `ingest-activity.js`
explaining why that module deliberately does *not* use one ("a timer in a leaf
module keeps the event loop alive"). Every `setTimeout` in `src/` is one-shot: a
bind retry, a shutdown delay, an LLM backoff, an abort timeout. `fs.watch`,
`watchFile` and `chokidar` appear **nowhere** in `src/` or `mcp/`.

This is a genuinely good starting position for a background-resident app and it
should be protected — see §2.7's recommendation 4.

**Frontend (`/next`, which is what the desktop window loads):**

| Timer | File | Interval | Skips work while hidden? | Runs when? |
|---|---|---|---|---|
| `refreshSyncBadge` | `next/app.js:2232` | **60 s** | **NO** | Always, for the life of the page |
| `refreshSyncRemoteBadge` | `next/app.js:2239` | **10 min** | **NO** | Always — **and it is a network call** (`git fetch`, with a 5-min server-side TTL cache) |
| Active batch-job watcher | `next/app.js:2137` | 4 s | n/a | Only while a batch job is `running`; cleared on exit |
| Agent memory poll | `next/views/memory.js` | 20 s adaptive → 300 s cap | **YES** | Only while the Memory view is mounted |
| Ingest activity poll | `next/views/ingest.js` | 2 s active / 15 s idle | **YES** | Only while the Ingest view is mounted |
| Onboarding re-check | `next/views/onboarding.js` | 5 s adaptive → 300 s cap | **YES** | Only until all three setup steps are done, then hard-stops |
| Chat send clock | `next/views/chat.js` | 1 s | n/a | Only during an in-flight turn |
| Ingest elapsed clock | `next/views/ingest.js` | 1 s | n/a | Only during an ingest |
| Restart poll | `next/views/settings.js` | 1.2 s | n/a | Only during an update; self-limits at 30 s |

**MEASURED (by reading and by endpoint timing).** The view-scoped pollers are
already well engineered for this: they are `setTimeout` **chains** (not
`setInterval`, so a slow response cannot stack), they are **adaptive** (bounded
to 1/20th of wall-clock), they **skip fetching entirely while `document.hidden`**,
and they revalidate on `focus`/`visibilitychange`. Nothing in that list needs
fixing for background mode.

**The two shell-level `setInterval`s are the exception, and they are the finding
here.** Neither `refreshSyncBadge` nor `refreshSyncRemoteBadge` checks
`document.hidden`. In a browser tab left open for ten minutes that is invisible.
**In an always-running app with a hidden window it is a 60-second timer and a
10-minute network call, forever.** See §2.7 recommendation 1.

**Endpoint costs, MEASURED** against the running app (empty domains — a floor):

| Endpoint | Median | Size |
|---|---:|---:|
| `GET /api/memory` | 1.5 ms | 53 B |
| `GET /api/sync/status` | 1.3 ms | 20 B |
| `GET /api/write-status` | 0.7 ms | 111 B |
| `GET /api/ingest/activity` | 1.0 ms | 51 B |
| `GET /api/health` | 0.7 ms | 30 B |

### 2.4 `fs.watch` versus polling — measured

Run against synthetic trees built to mirror the real layout (`domains/<p>/state/
<scope>/<machine>/{current.md,journal.jsonl}`, plus wiki files as noise), using
the real `listWorkingScopes` from `src/brain/working-state.js`.

**Cost of one `GET /api/memory`-equivalent index read — MEASURED:**

| Tree | Median |
|---|---:|
| 3 projects × 2 scopes × 1 machine = 6 pairs, 600 wiki files | **1.4 ms** |
| 10 projects × 4 scopes × 2 machines = 80 pairs, 3,000 wiki files | **16.3 ms** |
| 25 projects × 6 scopes × 2 machines = 300 pairs, 10,000 wiki files | **61.2 ms** |

Roughly linear in (scope × machine) pairs, as `memory.js`'s own comment predicts
— it stats every pair and reads a 16 KB journal tail per pair.

**Cost of holding one recursive watch over the same 10,000-file tree —
MEASURED:** 0.8 ms of CPU over 20 s = **0.0044% of one core**.

**The comparison that decides it:**

| Strategy | CPU, 300-pair install |
|---|---:|
| `fs.watch` recursive, idle | **0.0044%** |
| Poll every 20 s | 0.31% (**70×**) |
| Poll every 60 s | 0.10% |
| Poll every 5 min (proposed fallback) | **0.02%** |

**Behavioural results — all MEASURED:**

| Question | Result |
|---|---|
| Does recursive `fs.watch` work on macOS at this depth? | **Yes** — events for saves 4–5 levels deep |
| Does it catch a **new scope** created after the watch started? | **Yes** |
| Does it catch a **whole new project** created after the watch started? | **Yes** |
| First-event latency | **5–13 ms**, median 6.5 ms over 10 saves |
| Events per save | **3** — `.tmp-…`, `current.md`, `journal.jsonl`, same millisecond |
| Event `type` | **Always `rename`**, never `change` (FSEvents artefact) — carries no information |
| False positives from 30 wiki writes | **0 of 32 events** contained `/state/` |
| **100 saves as fast as possible** | **208 events, 101 naming `current.md` — nothing dropped.** Events coalesce (2.08/save, not 3) but every save is reported |
| Watch root **deleted and recreated** (as a `domainsPath` change would) | **Watcher stayed live** and reported a save into the recreated tree. One test, APFS, same volume — see the caveat below |

**On robustness, stated carefully.** The burst result is the important one: an
agent that saves rapidly cannot overflow the watcher into silence, which was the
main risk. The delete-and-recreate result is encouraging but is **one test on one
filesystem**, and it is not the case the fallback poll exists for — network
volumes, FSEvents queue overflow under whole-disk load, and a `domainsPath`
pointed at a different volume were **not** tested. The fallback stays.

### 2.5 The renderer, and `backgroundThrottling`

**MEASURED: `backgroundThrottling` is not configured anywhere in the
repository.** A `grep` across `.js`, `.yml` and `.json` (excluding
`node_modules`) returns nothing. So the window runs at Electron's default.

**VERIFIED** (Electron's `web-preferences.md`, verbatim — see §3.2): the default
is `backgroundThrottling: true`, which throttles "animations and timers when the
page becomes background" and "also affects the Page Visibility API". So the
window already runs throttled when hidden.

**Two caveats, both honest gaps rather than conclusions.**

**(a) Electron's docs do not say whether a `hide()`n window is treated
differently from a merely occluded one.** VERIFIED as a documentation gap. The
only real-world signal is that Gitify — an Electron menubar app — sets it to
`false` specifically to "keep the renderer process active even when the window is
hidden", which implies hidden *does* throttle. Not proof.

**(b) The clamp rate is RECALLED, not verified.** Chromium's background policy
clamps timers to roughly 1 Hz and suspends `requestAnimationFrame`; the Electron
docs do not state the numbers.

**None of that changes the conclusion, and this is the part that matters:** the
two problematic shell timers fire at **60 s and 10 min**, both far slower than
any plausible clamp. **Throttling does not help the timers that actually matter
here** — only an explicit `document.hidden` check does, which is recommendation 1.

The renderer consumed 0.03 s over 300 s (**MEASURED**), consistent with a page
doing 5 sync-badge fetches and nothing else.

### 2.6 What the widget itself would cost — with the panel CLOSED

The panel is closed for almost the entire life of the process, so this is the
number that matters.

| Component | Cost when closed | Basis |
|---|---|---|
| `Tray` icon + native `Menu` | ~0 | Native; a menu that is not open runs nothing. INFERRED but uncontroversial |
| Recursive `fs.watch` | **0.0044% of a core** | MEASURED |
| Debounce timer | 0 when idle (armed only after an event) | By construction |
| Index read per actual save | 1.4–61 ms **per save**, and saves are a few per hour | MEASURED |
| 5-minute fallback poll | **0.02% of a core** at 300 pairs | MEASURED |
| Popover `BrowserWindow`, **destroyed on close** | **0** — no process exists | By construction |
| Popover `BrowserWindow`, **hidden on close** | One resident renderer: ~25–45 MB, plus whatever its page does | INFERRED; measured anchor is the 43 MB full-app renderer |

**Total added idle cost, tray + menu + watch + fallback poll: ~0.025% of one
core and no additional memory.** That is inside the noise of the 0.060% the app
already measures.

**The design that would ruin it**, named so it is refused explicitly: a popover
that stays alive when closed and re-reads the index on a short interval so it is
"instant" when opened. That converts a 0.0044% watch into a permanent poll *and*
a permanent renderer. The push-on-change design in §1.6 gets the same instant-open
property for free, because the main process already holds the current snapshot.

### 2.7 Recommendations, in priority order

1. **Gate the two shell-level `setInterval`s on `document.hidden`.**
   `refreshSyncBadge` (60 s) and `refreshSyncRemoteBadge` (10 min) in
   `src/public/next/app.js` should skip work while hidden and revalidate on
   `visibilitychange`, exactly as the three view pollers already do — the pattern
   is written three times in this codebase already and should be extracted rather
   than copied a fourth time.
   *Saving:* **NOT MEASURED as a delta** (would require driving the window
   hidden). Bounded above by the renderer's entire measured consumption, 0.03 s /
   300 s. **The CPU saving is small; the real win is the 10-minute `git fetch`**,
   which in tray mode would otherwise hit GitHub forever behind a window nobody
   is looking at. That is a network and battery item, not a CPU item, and it is
   the strongest single reason to do this one first.

2. **Investigate the GPU process: 85 MB resident, 583 MB peak, for a static UI.**
   This is the largest single memory consumer and the least justified by what the
   app draws. Worth testing whether `--disable-gpu-compositing` or
   `app.disableHardwareAcceleration()` reduces it without a visible cost — the
   app has no video, no canvas, no WebGL, and (per v3.27.0) exactly one
   deliberately-retained animation. *Saving:* **NOT MEASURED** — this needs a
   launch to A/B and I did not launch anything. **Potentially the largest single
   win available**, and it is the first thing I would measure next.

3. **Set `backgroundThrottling: true` explicitly on every window**, including the
   popover if built. VERIFIED in §3.2 that `true` is already the Electron
   default; making it explicit costs one line and stops a future `webPreferences`
   edit from silently turning it off. *Saving:* zero today; it is a ratchet, not
   an optimisation.

   **A shipping menubar app of exactly our shape does the opposite, and the
   contrast is the point.** Gitify — Electron, tray, frameless popover — sets
   `backgroundThrottling: false` with the in-source comment *"Keep the renderer
   process active even when the window is hidden"* (VERIFIED, §3.2). It has to,
   because **its renderer is what polls GitHub**; a throttled renderer stops
   fetching and the notification count goes stale.

   **We are not in that position, because §1.6 puts the watch and the index read
   in the MAIN process and pushes to the panel.** The renderer owns no data
   acquisition, so it can be throttled *and* destroyed on close, and nothing goes
   stale. That is the concrete payoff of the push design, and it is worth writing
   down because the obvious first implementation — poll from the panel — leads
   straight to Gitify's tradeoff and to a permanently-resident, permanently-awake
   renderer.

   Note also a VERIFIED **documentation gap**: Electron's docs do not say whether
   throttling treats a `hide()`n window differently from an occluded one. Our
   design does not depend on the answer; do not let a future one start to.

4. **Add a guard that keeps the server timer-free.** The zero-recurring-timers
   property (§2.3) is currently an accident of good taste, not an invariant.
   `scripts/test-desktop-packaging.js` (or a sibling) should fail on a new
   `setInterval` in `src/` outside `src/public/`, with an explicit allow-list.
   Cheap now; expensive to recover once one has shipped and something depends on
   it.

5. **If the popover is built, destroy it on close** rather than hiding it, unless
   re-create latency measures as perceptible. *Saving:* **INFERRED ~25–45 MB**
   and one process, against a measured 43 MB anchor.

6. **Do not add a "how long since the last save" ticking clock.** It is the only
   proposal in the design that would require a timer while the panel is open, for
   a number nobody reads to the second.

### 2.8 What I could not measure, and why

| Not measured | Why |
|---|---|
| Idle CPU with the window **hidden** versus **visible** | Determining window visibility needed either an Accessibility-gated AppleScript query or activating the app. Both risk a consent or crash dialog on the maintainer's live machine. Declined. |
| The saving from recommendation 1 or 2 | Both need an A/B with a relaunch. No `.app` was launched, per the brief. |
| Anything at real wiki scale in the *app* | The installed build has **zero domains configured**. §2.1's memory figures are a floor. §2.4 substitutes synthetic trees at the right shape and scale, run against the real `listWorkingScopes`. |
| `powermetrics` / real energy impact | Needs `sudo`. |
| A second renderer's real cost | Would require launching one. Anchored on the measured 43 MB existing renderer and marked INFERRED. |
| Whether Chromium's default `backgroundThrottling` behaves as documented **in this Electron version** | Not exercised. It does not change the conclusion, because the two timers that matter are slower than any clamp. |

---

### 2.9 The multi-machine signal — measured, and then priced to zero

> **BUILT DIFFERENTLY, AND WEAKER.** There is no fetch on menu open. The widget
> renders whatever a completed check last reported, and that check is suppressed
> while the window is hidden — which is the tray’s normal state. Deviation 2 in
> [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan) states the
> consequence in full.

Added this pass. The first pass's cost model covered only **local** signals, and
Scenario B's headline question is not local.

#### (a) git resets mtime — MEASURED

Run in an isolated scratch repo, outside the maintainer's tree, with global and
system git config neutralised. A `current.md` whose content was authored years
earlier, backdated on the authoring machine, then pushed:

| Step | `current.md` mtime |
|---|---|
| On the authoring machine | `2020-01-01T00:00:00` |
| On a second machine, after `git clone` | **the moment of the clone** |
| On the second machine, after an incremental `git pull --no-rebase -X theirs` | **the moment of the pull** |
| The journal line's own `at` field, throughout | `2020-01-01T00:00:00.000Z` |

**MEASURED.** This is ordinary, documented git behaviour — git writes files, and
the filesystem stamps them when written — but it is load-bearing here and was
asserted rather than measured in no document before this one. It is the basis of
§1.2a(b) and of §1.5's correction to the recency pips.

A useful side effect: because a pull writes files under the domains folder, **the
recursive `fs.watch` fires on a pull exactly as it fires on a local save.** So the
widget notices another machine's work *arriving* for free, with no polling and no
network — which is half of Scenario B answered at zero cost. What it cannot see
without the network is work that is on the remote and **not yet pulled**.

#### (b) The unpulled-state signal, and why it is fetched on open only

"Is there state on GitHub I have not pulled" resolves to `getRemoteStatus()` in
`src/brain/sync.js`, which is **a real `git fetch`** — network, 30 s timeout,
5-minute TTL cache, keyed on the repo URL. It is the only thing in this design
that is not a local disk read.

**The decision: the widget never puts this on a timer. It fetches on panel open,
and nowhere else.**

The argument is not cost alone — it is that **the question is only actionable at
the moment the panel is open.** "Has another machine pushed?" changes what you do
at the start of a session, which is exactly when you look. A background fetch
every ten minutes buys a badge that is correct slightly sooner, in exchange for a
network call forever, behind a closed panel, on battery and possibly on a metered
connection. The TTL cache means an open-triggered fetch is usually served from
memory anyway.

This also inherits §3.3's evidence-backed remedy — the Codex menubar bug's first
proposed fix was *"fetch on every open"* — so refresh-on-open is doing two jobs.

| | Cost when the panel is CLOSED |
|---|---|
| Recursive `fs.watch` (catches local saves **and** arriving pulls) | **0.0044% of a core** — MEASURED, first pass |
| 5-minute fallback poll | **0.02% of a core** — MEASURED, first pass |
| Unpulled-remote check | **0** — not scheduled |
| **Total** | **~0.025% of a core, no additional memory, no network** |

**Two consequences, stated rather than discovered later:**

1. **The tray glyph cannot carry the remote bit** (§1.5). It is a local
   instrument. Anyone who later wants "another machine has pushed" reflected in
   the bar is asking for a background network timer, and should be sent back to
   this section.
2. **The first panel open of a session may be slightly slow** — up to the fetch's
   30 s timeout on a bad network. The panel must render the local rows
   immediately and fill the remote line in when it arrives, never block on it.
   A failed check renders as **unknown**, never as a reassuring zero — which is
   already `getRemoteStatus()`'s own contract (`behindFiles: null` on failure).

#### (c) An honest limit in the data — the preview is capped at 20 paths

`countIncoming()` returns `{commits, files, preview}` where **`preview` is
`list.slice(0, 20)`** of `git diff --name-only`. So the *count* of incoming files
is exact, but the widget's ability to say specifically *"and some of them are
handoffs"* depends on a `state/` path appearing in a 20-item alphabetical sample.

Within one domain the ordering happens to favour us — `conversations/` <
`state/` < `wiki/` — but across several domains, one busy domain's wiki pages can
fill the sample before another domain's state files are reached.

**So the footer line must be phrased to what is actually known.** *"2 handoffs
waiting on GitHub"* is only sayable when a `state/` path is visibly in the
preview; otherwise the honest line is *"14 files waiting on GitHub"*. Saying
"handoffs" on the strength of a truncated sample would be a confident claim
resting on a cap — the exact defect this project's own rule about caps and
measurements names.

## 3. What other menubar apps actually do (research)

> Claims are tagged **VERIFIED** (the source was fetched during this pass) or
> **RECALLED** (from training, not confirmed). Re-verify anything RECALLED before
> depending on it. Where sources disagree, both are given.

### 3.1 The reference app: Stats

| Finding | Tag |
|---|---|
| Swift + AppKit, macOS 12+. Not Electron | VERIFIED — `github.com/exelban/stats` |
| **The dropdown is neither an `NSMenu` nor an `NSPopover` — it is a custom `NSWindow`**: `class PopupWindow: NSWindow`, `.titled` + `.fullSizeContentView`, transparent titlebar, clear background with shadow | VERIFIED — `Kit/module/popup.swift` |
| **The menubar glyph is a custom `NSView` injected into the status item's button** (`button?.addSubview(customView)`), not an image. Widget types include `lineChart`, `barChart`, `networkChart`, `pieChart`, `tachometer`, `state` (a dot) | VERIFIED — `Kit/module/widget.swift` |
| Default read interval **1 second** | VERIFIED — `Kit/module/reader.swift` |
| **Readers pause when the popup is hidden** — `if state { reader.unlock(); reader.start() } else { reader.pause(); reader.lock() }` | VERIFIED — `Kit/module/module.swift` |
| No absolute CPU/RAM figures published. README says only that reading data periodically "is not a cheap task", and that disabling Sensors + Bluetooth "could reduce CPU usage … by up to 50%" | VERIFIED — README FAQ |

**Two things this changes.**

First, **"the menubar cannot draw a chart" is false in AppKit** — Stats proves a
status item can host an arbitrary `NSView`. It is true *in Electron*: see §3.2.

Second — and this is the useful one — **Stats does exactly what §1.6 proposes:
it stops working when nobody is looking.** A 1 Hz reader is aggressive, and it is
affordable precisely because it is gated on panel visibility. Our equivalent is
stronger, because our data source is event-driven rather than sampled.

### 3.2 Electron — the constraint is real, and it is narrower than expected

| Finding | Tag |
|---|---|
| **`Tray` can only show a `Menu`.** The API is `setImage`, `setTitle` (macOS), `setToolTip`, `setContextMenu`, `popUpContextMenu`, `getBounds`, plus click events. **There is no API to attach a rendered view.** | VERIFIED — electronjs.org `api/tray` |
| Tray icons "should be Template Images", 16×16 / 32×32@2x | VERIFIED — same |
| `backgroundThrottling` **"Defaults to `true`"**; throttles "animations and timers" and affects the Page Visibility API | VERIFIED — Electron `web-preferences.md`, verbatim |
| Electron's docs **do not distinguish a `hide()`n window from an occluded one** for throttling purposes | VERIFIED as a documentation **gap** |
| Electron publishes **no** performance guidance for tray/background-resident apps — no memory targets, no idle-CPU advice | VERIFIED NEGATIVE — `tutorial/performance` |
| `app.setActivationPolicy('accessory')` — "doesn't appear in the Dock and doesn't have a menu bar, **but it may be activated programmatically or by clicking on one of its windows**" | VERIFIED — `api/app` |
| `dock.hide()` — **"Calling `dock.hide()` within one second of a previous call will have no effect."** `dock.show()` returns a Promise; `dock.isVisible()` exists | VERIFIED — `api/dock` |
| Electron's docs **never mention `LSUIElement`** | VERIFIED as a gap — do not cite Electron docs for it |
| Whether `dock.hide()` requires no visible windows | **UNVERIFIED — docs are silent.** `'accessory'` explicitly permits windows, so the premise is probably wrong |

**The library.** `menubar` (npm) is at **9.5.3**, ~5,500 downloads/week, and a
July 2026 commit reads *"update to electron 43.x.x and drop the peer dependency
ceiling"* — **it explicitly supports our Electron version**. VERIFIED.
**But it appears to have hard-forked to `electron-menubar` @ 10.2.1** under the
Gitify org, whose README says it was *"formerly known as menubar"*, with
**overlapping maintainers on both**, both active June–August 2026. VERIFIED and
**unresolved** — see §5, question 8.

What the library actually does (VERIFIED, read from source): defaults are only
`{ show: false, frame: false }`; positioning is `tray.getBounds()` →
`electron-positioner`; blur → 100 ms timeout → hide; and on macOS with
`showDockIcon: false` it calls `app.dock.hide()` **and re-hides after 2000 ms**,
because the first call *"can be silently dropped when it races the launch
activation transition."* That workaround is a real hazard we would otherwise
rediscover.

### 3.3 Discrete-event menubar apps — the category that matters

**The first pass's headline result was: no app anywhere uses a sparkline for
discrete events, and none draws discrete events at all.** The first half stands.
**The second half is WRONG and is corrected in §3.7** — a second, deeper search
this pass found two shipping open-source precedents for drawing discrete events
in a status surface. Read §3.7 before quoting the paragraph below.

Sparklines proper appear only in continuous-metric apps (Stats' chart widgets;
iStat Menus' 10-minute-to-28-day history graphs — VERIFIED, bjango.com version
history). Among the *text-row* discrete-event apps, the vocabulary does converge:

| App | Bar glyph | Dropdown row | Tag |
|---|---|---|---|
| **CCMenu 2** (CI status, SwiftUI `MenuBarExtra`) | Priority-collapsed aggregate — running builds first, broken second | **`Name — 2 hours ago, build-label`**, built with `Date.RelativeFormatStyle(presentation: .named)` — **named relative time, no graph** | VERIFIED — `MenuItemViewModel.swift` |
| **Gitify** (Electron, GitHub notifications) | Five icon states: idle / idleAlternate / active / error / offline | `tray.setTitle()` carries the **count** beside the icon | VERIFIED — `src/main/handlers/tray.ts` |
| **gitnews-menubar** | Three states, including *"unseen … probably just arrived"* — a **novelty** encoding distinct from "unread" | — | VERIFIED — README |
| **Docker Desktop** | Glyph **animates while starting**, static when running | Text label: "Docker Desktop is running" | PARTIALLY VERIFIED — issue threads, not official docs |
| **Dropbox / Syncthing** | Three-state sync glyph (community requests) | **Timestamp format could not be verified for either.** Honest gap | WEAK |

**The single most useful finding for us** — VERIFIED, `github.com/openai/codex`
issue 36859. OpenAI's Codex macOS menubar app has an open bug filed *precisely*
because it shows event data with no freshness marker:

> "The menu bar popover keeps showing an old snapshot… It does not refresh on its
> own — not when opened, and not over time."

The reporter's proposed remedies are (1) fetch on every open, and (2) *"showing a
'last updated at HH:MM' timestamp in the popover would at least make the
staleness visible."* A shipping developer-tool menubar app, in our exact
category, got a bug for the exact failure mode our design must avoid. §1.6's
refresh-on-open is now evidence-backed rather than merely tidy, and §1.5 gains a
last-updated stamp it did not have.

Note the disagreement: **CCMenu uses relative time; the Codex reporter asks for
absolute `HH:MM`.** They are answering different questions — *how old is this
event* versus *how old is this panel* — which is why §1.5 now uses relative time
for rows and an absolute stamp for the panel.

### 3.4 Tailscale's retreat — the strongest cautionary finding

VERIFIED — `tailscale.com/blog/macos-notch-escape`. Tailscale **moved off
menubar-only**, and the reasons apply to us directly:

- When menubar items exceed the space right of the notch they **simply vanish** —
  *"no notification to the user, no overflow section, no options to rearrange."*
- Their windowed UI now runs *alongside* the menubar app, because searchable
  lists and detailed status were *"completely inaccessible from the restricted
  menu bar space."*

Two consequences, both of which the design already happens to satisfy: **the tray
must never be the only way to reach anything** (§1.8's tray menu always carries
"Open The Curator" and "Quit"), and **`window` mode must stay the default**
(§1.10), because an install whose only affordance may silently disappear is not
one to opt users into.

Also VERIFIED (Stats README FAQ): **macOS 26 added a System Settings → Menu Bar
privacy control that apps must be explicitly allowed into.** A new menubar item
may not appear at all until the user permits it — which the first-run copy has to
anticipate rather than treating an absent icon as a bug.

### 3.5 xbar / SwiftBar — the ceiling of menu-based rendering

VERIFIED from both projects' docs. Both are **line-oriented text + optional
base64 raster image + SF Symbol**, with submenus, colours (including
`light,dark` pairs), `length`/`trim`, and SwiftBar's `badge`. **Neither has a
sparkline, chart, or any layout primitive beyond one-line-per-item.** A plugin
wanting a chart must **render a PNG and base64 it in** — which is the escape
hatch, and is also exactly what Electron's `tray.setImage()` would require.

One conflict left unresolved: whether inline images work on the *menubar title*
line. xbar calls `templateImage` "recommended for the status bar"; SwiftBar's
docs were ambiguous on extraction. **Do not rely on either without testing.**

### 3.6 Apple's HIG argues against the popover, and this must be recorded

VERIFIED — `developer.apple.com/design/human-interface-guidelines/the-menu-bar`,
verbatim:

> **"Display a menu — not a popover — when people click your menu bar extra.
> Unless the app functionality you want to expose is too complex for a menu,
> avoid presenting it in a popover."**

And:

> "Avoid relying on the presence of menu bar extras. The system hides and shows
> menu bar extras regularly…"
> "Let people — not your app — decide whether to put your menu bar extra in the
> menu bar." … "consider giving people the option of doing so during setup."

Menu bar height is **24 pt**; the system truncates and hides extras when space is
constrained.

**How to hold this and the maintainer's screenshot at the same time.** Apple says
menu, not popover. Stats, Gitify, Docker Desktop and Tailscale all ship a
window/popover anyway — and in Electron there is no third option, because `Tray`
renders only a `Menu`. Apple's own SwiftUI `MenuBarExtra` ships
`.menuBarExtraStyle(.window)` for exactly this case (RECALLED, corroborated by
search snippets but **not** directly verified — the API page would not render to
a fetch), so Apple sanctions the rich panel in API while discouraging it in
prose.

**Net effect on §1.4: it strengthens the sequencing, not the conclusion.** The
HIG's test is *"unless the functionality is too complex for a menu"* — and
Phase 1 is, by construction, not too complex for a menu. Shipping the menu first
is the HIG-conformant version of this feature, and Phase 2 is the deliberate,
argued departure from it once the two honest encodings (§1.5) justify the cost.
"Let people decide" is also already satisfied: the feature is opt-in (§1.10).

### 3.7 SECOND-PASS CORRECTION — discrete-event strips DO have precedent

The first pass concluded no menubar app draws discrete events. A deeper search
this pass found two, both open source, and the correction matters because one of
them changes §1.5's proposed shape.

**StreakBar** (`github.com/menubar-apps/StreakBar`, Swift/SwiftUI/AppKit, also on
the Mac App Store) — **VERIFIED, source read.** It renders a GitHub-contribution
grid *inside the status item*:

| Finding | Why it matters here |
|---|---|
| `NSHostingView` added as a subview of `statusItem.button`, `variableLength`, **width computed from the data** (`daysBefore * 3 + 20`, or `(daysBefore + 1) * 17 + 20`) | Same escape hatch as Stats' custom `NSView`, and it confirms an event strip *in the bar itself* is a real shipped thing, not a thought experiment |
| Day mode is literally a rug plot: `HStack(spacing: 1)` of 16×16 rounded cells | The strip shape is viable at menu-bar size |
| **Empty is drawn, not omitted**: `.opacity(level == .NONE && emptyDayTransparency ? 0.2 : 1)` | *Nothing happened* is visibly distinct from *no data* — this project's own fact-versus-absence rule, arrived at independently |
| **Tooltips deliberately suppressed in the bar** (`.help(isFullSize ? tooltip : "")`), enabled in the 400×600 popover, using **the same view at 3× cell size** | One implementation, two sizes — the opposite of the two-surfaces-drift problem |
| `"Updated 4m ago"` overlay in the popover only | The Codex-issue remedy again, independently arrived at |
| Refresh timer 3600 s; `@Environment(\.accessibilityReduceMotion)` gates transitions | Restraint at both ends |

**VitalsBar** (vitalsbar.org, native AppKit + SwiftUI) — **VERIFIED from the
vendor page, verbatim**: *"Each system carries a compact uptime sparkline (one bar
per check, tinted by health)"*, with the menu bar itself showing only the **single
worst state** across all services. So: **worst-case glyph in the bar, one
event-strip per source in the pane.**

**That is structurally identical to what §1.5 arrived at independently** — one
collapsed glyph, per-source strips one level down — which is reassuring, and it is
the strongest single argument for the demotion §1.5 makes.

**And here is the part that changes the design.** Every precedent found —
StreakBar, VitalsBar, the contribution-graph apps — **buckets into a uniform grid
first**: one cell per day, one bar per check. Nobody plots events at their
irregular real timestamps. That is exactly what §1.5's rug plot proposed, and it
is the one genuinely novel bit left — *and uniform bucketing is what makes those
strips readable at 16 px.*

> **§1.5's event strip is therefore amended: bucket it.** Twelve five-minute cells
> across the last hour, one lane per source, cell shaded by whether that source
> saved in that bucket — **and every cell drawn, empty ones at low opacity**, per
> StreakBar. That is legible at menubar scale, it has precedent, and it still says
> only what is true: *this source wrote, in this five minutes*. A cell's shade may
> encode *how many* saves landed in the bucket; it must never encode *how good*
> they were (§1.5's refusals).

**One Electron-specific cost, VERIFIED:** Electron's `Tray` accepts only a
`NativeImage`, so a StreakBar-style strip *in the bar* means rendering a PNG
ourselves on every change — losing `variableLength` auto-sizing and hover
entirely. That prices §5.5's third option honestly: possible, and more expensive
than it looks.

### 3.8 Multi-source rows — a verified row spec worth adopting

**CCMenu 2 — VERIFIED, `MenuItemViewModel.swift` read directly.** The rendered row
is `<icon>  connectfour — 2 hours ago, build.151`: per-source icon, name, em dash,
comma-joined details, relative time via `Date.RelativeFormatStyle(presentation:
.named)`.

Three details worth stealing, and one worth arguing with:

- **The per-source timestamp is OFF by default** (`showBuildTimesInMenu = false`).
  A shipping app in our category decided recency is opt-in. Recorded because it is
  a genuine argument for restraint — though our case differs: CCMenu's rows are
  *present-tense build status*, where "is it red" dominates; ours are *past-tense
  save events*, where recency is the whole content. **We keep it on.**
- **It never silently truncates.** When rows are hidden it appends a *disabled*
  row: `"(3 pipelines hidden)"`. That is §1.3's cap rule, shipped.
- **The glyph is a priority chain**, then optionally a **count** of failures — not
  a per-source anything. Confirms §1.5's collapse rule.
- The row's click action is `openWebPage(pipeline:)` — **a status row's primary
  action is "take me to the underlying thing"**, which is §1.7's question exactly.

**Gitify — VERIFIED, source read.** Multiple accounts render as collapsible
account headers with a count badge; **no per-account "last checked" line anywhere**.
Also: it imports `Menubar` from **`electron-menubar`**, so §3.2's unresolved fork
question has an answer in the form of one real production consumer.

### 3.9 Peer presence in sync clients — thin precedent, and one useful shape

This was searched specifically for Scenario B. **The result is thinner than
expected and it points somewhere useful.**

- **Tailscale — VERIFIED.** The popover lists This Device / My Devices / Shared
  Devices with **online/offline only, no timestamps**. A request for last-seen in
  `tailscale status` (issue 16584) was **closed, not implemented**. And issue 8034
  (open since 2023, macOS): when every peer is offline, hovering "Network Devices"
  produces **no flyout and no message at all** — the user cannot tell *nothing to
  show* from *broken*. That is precisely the empty-state failure §1.3 guards
  against, unfixed in a shipping product.
- **Syncthing core — VERIFIED.** `"Last seen"` is a real per-device string in the
  web GUI. It is a full-app concept, not a menubar one.
- **Resilio Sync — VERIFIED (help docs).** The **tray menu itself** shows a
  **"Date synced"** value on a synced folder, and summarises peers as *"X of Y
  peers"*. A History panel (30 days / 20 K events) lives in the full app. This is
  the closest real precedent for last-activity *in the menu*.
- **syncthingStatus** (`Xpycode/syncthingStatus`, Swift/SwiftUI, `NSPopover`) —
  **VERIFIED, source read**, and it is the closest structural match to §1.3's
  layout that exists. Device rows are **present-tense state only, no last-seen**.
  Recency lives instead in a **separate "Recent Sync Activity" feed**:
  `[icon] folderName ………… 3m ago` with a secondary description line beneath,
  `events.prefix(5)` then a **`"Show All (23)"`** toggle, and an explicit
  `"No sync activity yet"` empty state.

**The conclusion for Scenario B, and it is a real finding.** Every sync client
surfaces peers as a **device list in present tense**, and the ones that surface
recency at all do it as a **separate activity feed**. So the instinct to build a
"machines" section into the panel is the shape the field tried and mostly
abandoned; **the flat, newest-first activity feed §1.3 proposes is the shape that
actually works**, and syncthingStatus is a working implementation of it, down to
the `prefix(5)` + overflow item and the named empty state.

**One amendment to §1.5's refusals from the same source.** syncthingStatus
recomputes its relative times on a **60-second** timer *while the popover is
open*, so the feed does not go stale under the reader's eyes. §1.5 refuses a
**per-second** count-up, and that refusal stands. A **60-second re-render while
open only** is a different thing, has precedent, is the documented remedy for the
Codex stale-snapshot bug, and costs nothing when closed. **Accepted.**

### 3.10 Discoverability is the real risk — THREE silent ways the icon disappears

This is the most important finding of the second pass's research, and it
strengthens §1.10's default rather than changing any layout.

1. **The notch** — first pass, §3.4: items past it *"simply vanish… no
   notification to the user, no overflow section."*
2. **Ice** (`jordanbaird/Ice`, the open-source menu bar manager) — **VERIFIED.** A
   newly-appearing status item lands in whichever section its x-position happens to
   fall into, and it **can land in Always-Hidden**, a section that is deliberately
   *not* revealed on hover and needs a modifier-click or hotkey. Open issue 6
   ("change the location where new menu bar icons come up") asks for new icons to
   go to Visible; still open. Ice's newest **stable** release is `0.11.12` from
   October 2024 — Tahoe fixes exist only in dev pre-releases — and issue 946
   reports macOS 26.5 pushing hidden items into always-hidden with the drag-back
   not persisting. **This is strictly worse than the notch**, because Always-Hidden
   is intentionally unrevealed.
3. **macOS 26's "Allow in the Menu Bar" control** — **VERIFIED** on the Apple
   Developer Forums, and the API answer is a flat no. Apple DTS, verbatim: *"The
   answer to your direct question: Does macOS provide a way for me to determine
   the 'Allow in the menu bar' state for my application? is 'No.'"* The suggested
   substitute is `NSStatusItem.removalAllowed` plus KVO on removal — **which
   Electron's `Tray` does not expose**, so even that partial signal is out of reach
   for us. Whether a new app's toggle defaults on or off **could not be verified**.

**Two design consequences, both cheap:**

- **Never let the tray be the only route to anything** — already satisfied (§1.8:
  "Open The Curator" and "Quit" are always in the menu, and `window` mode is the
  default). Reinforced: the *Settings toggle itself* must say plainly that the icon
  may not appear, and where to look (Menu Bar settings, or a menu bar manager),
  rather than treating an absent icon as a bug report.
- **A fourth, unrelated failure mode, VERIFIED and directly actionable for
  Electron:** an Apple DTS thread (794920) documents apps whose status item did not
  appear *and which did not appear in the "Allow in the Menu Bar" list at all*,
  because the status item was owned by a **second bare executable inside
  `Contents/MacOS/`** rather than the main one. Apple's guidance is to own the
  status item from the **main** executable. For us: **create the `Tray` in the
  Electron main process**, never delegate it to a helper — which is what §4 already
  proposes, now with a reason.

### 3.11 Electron tray specifics, second pass

| Finding | Tag |
|---|---|
| `tray.setTitle(title[, options])` is **current** and macOS-only; `options.fontType` accepts `'monospaced'` / `'monospacedDigit'`, and the title **supports ANSI colours** | VERIFIED — `electron/electron@main` `docs/api/tray.md` |
| `monospacedDigit` is the fix for a count or relative time **jittering the menu bar width** as it changes | VERIFIED (from the same doc's purpose) |
| A blank `setTitle('')` once crashed (electron#12343, Electron 2.0). Ancient and presumably fixed, but it argues for testing the empty-count case rather than assuming it | VERIFIED as a historical issue |
| **No** Electron issue exists about macOS 26, the notch, Ice or Bartender. Electron's `Tray` **is** an `NSStatusItem`, so it inherits all of §3.10 exactly as a native app does, with no API on either side to detect it | VERIFIED NEGATIVE (open-issue list read) + stated interpretation |
| Electron **PR 48738** (Oct 2025) proposes **layered tray icons** — `new Tray({ layers: [template, redDot] })` — motivated by template images being unable to carry colour, and by one `Tray` rendering onto a light and a dark menu bar simultaneously on multi-display Macs. **Merge status not confirmed.** If it lands, it is the clean way to do "template glyph + coloured activity dot" | VERIFIED as an open PR |
| **`LSUIElement` vs `setActivationPolicy` — the community disagrees with §1.8, and it is worth recording.** Reports converge on setting `LSUIElement` in `Info.plist` rather than relying on the runtime call, because runtime-only makes the Dock icon **flash visibly for about a second at launch**, and because switching `.accessory → .regular` at runtime is reported buggy — the app menu does not populate until you tab away and back, and windows get hidden as a side effect | **RECALLED / community consensus, not primary-sourced** |
| StreakBar calls `NSApp.setActivationPolicy(.accessory)` as the first line of `applicationDidFinishLaunching` — the runtime API in a real shipping app | VERIFIED — source read |
| `menubar` / `electron-menubar` expose exactly one knob here, `showDockIcon` (default `false`), and neither README mentions `LSUIElement`, `setActivationPolicy`, the notch or macOS 26 | VERIFIED |

**The `LSUIElement` tension, resolved for now rather than settled.** §1.8 chose
`setActivationPolicy('accessory')` on documentary grounds, and the documentation
is still correct. But the reported bug is in **exactly the direction `tray-only`
needs** — `accessory → regular` when the user opens the window from the tray —
which is the moment the whole hedge in §1.8 depends on. That is one more reason to
**ship `window` and `tray` first and hold `tray-only` back** (§5.6), and to test
the transition on a real build before promising it.

---

---

## 4. Implementation plan — files that would change

**Phase 0 — the four-line change that unlocks half the design.** Independent of
everything else, and worth doing on its own merits because it fixes a live honesty
gap in the shipped Agent memory view (§1.2a(b)).

| File | Change |
|---|---|
| `src/brain/working-state.js` | In `listWorkingScopes`, keep two fields the function already parses and currently discards: **`harness`** and **`writtenAt`** (the journal line's `at`). Purely additive — `lastWriteAt` / `ageSeconds` are untouched, so the MCP contract and both existing consumers are unaffected |
| `src/public/next/views/memory.js` | Prefer `writtenAt` where present; say *"changed"* rather than *"written"* on the mtime fallback |
| `docs/working-state.md`, `docs/api-reference.md` | Name the two facts apart: **written** (the agent's clock) versus **arrived / changed** (this disk's clock) |
| `scripts/test-working-state.js` | Assert both fields, and assert the null fallback names itself |

**Phase 1 — background running + tray + native menu. No renderer added.**

| File | Change |
|---|---|
| `desktop/main.js` | Create the `Tray` **in the main process, never a helper** (§3.10); build the menu; wire "Open The Curator" to the **existing** `revealWindow()`; wire Quit to `app.quit()` (never `app.exit()`); read `backgroundMode` before creating anything |
| `desktop/lib/tray-model.js` **(new)** | **Pure**, Electron-free: `listWorkingScopes` output across projects → the flat, recency-ordered row model of §1.3, including the harness-vs-machine slot rule, the truncation row, and the collision detection of §1.2a(a). Same shape as `quit-decision.js`, so the offline suite can **execute** it |
| `desktop/lib/tray-menu.js` **(new)** | Pure: row model → menu template + glyph state (the `live > unseen > idle` priority collapse, §1.5) |
| `desktop/lib/state-watch.js` **(new)** | **Pure-ish**: debounce (~150 ms), dot-prefix filtering, `/state/` path filter, fallback-poll scheduling. Injectable clock and watcher so it is testable offline |
| `desktop/lib/dock-mode.js` **(new)** | Pure: resolve `'window' \| 'tray' \| 'tray-only'` from config, with the fail-safe default |
| `desktop/electron-builder.yml` | `LSUIElement` **not** set statically for now — the mode is runtime. **But see §3.11**: the community reports the runtime `accessory → regular` transition is buggy in exactly the direction `tray-only` needs, so this line is provisional and must be tested on a real build |
| `src/brain/config.js` | Read/write top-level `backgroundMode` (**not** `ui.*` — §1.10) |
| `src/routes/config.js` | Expose it on the config GET/POST |
| `src/public/next/views/settings.js` | The three-way control, labelled around the **menubar** question (§1.10), plus copy that anticipates the icon **not appearing** (§3.10) |
| `src/public/next/views/memory.js` | The one-line, once-only in-context offer, gated on `ui.menubarOfferSeen` (§1.10) |
| `src/brain/config.js` (`UI_STATE_SPEC`) | Add `menubarOfferSeen` as a one-way dismissal — the mechanism's correct use, unlike the mode |
| `src/public/next/app.js` | **Recommendation 1**: gate the two shell `setInterval`s on `document.hidden` |
| `scripts/test-desktop-packaging.js` | Assert tray Quit routes through `before-quit`; assert `backgroundThrottling`; source-scan the `main.js` call sites; assert the `Tray` is constructed in the main process |
| `scripts/test-tray-model.js` **(new)** | Execute `tray-model.js`, `tray-menu.js` and `state-watch.js` against fixtures — including a fixture where a pulled file's mtime is newer than its `writtenAt`, which is §1.2a(b)'s regression |
| `docs/mac-app.md`, `docs/user-guide.md`, `docs/working-state.md` | Document the mode; §6 of `working-state.md` currently says the in-app view is the only surface |

**Phase 2 — popover panel, the scope popup, and the two honest encodings.**

| File | Change |
|---|---|
| `desktop/main.js` | Frameless `BrowserWindow`, positioned from `tray.getBounds()`; `blur` to close; **destroy** on close |
| `desktop/lib/panel-position.js` **(new)** | Pure: tray bounds + display work area → window bounds. Multi-display and notch edge cases; testable offline |
| `src/public/panel/**` **(new)** | The panel page. **Reuses `next/tokens/`** — it must not become a second design system. Renders the journal, **never `current.md`** (§1.7) |
| — | The scope popup needs **no new endpoint**: `GET /api/memory/:project?scope=&journalLimit=8` already returns exactly the array it renders (§1.7) |

**Phase 3 — the bucketed event strip** (§1.5 as amended by §3.7), per scope, per
source, inside the popup. The only part that might want a journal endpoint the
index does not carry — see §5.2.

**Explicitly NOT changed:** `desktop/lib/quit-decision.js` (the decision is
correct; only its call context changes), the **write** side of
`src/brain/working-state.js` (the widget reads, never writes), `src/routes/memory.js`
(no write endpoint, ever), and anything under `src/public/app.js` (`/old`).

---

## 5. Open questions for the maintainer

**Six of the first pass's nine are now answered.** They are kept, struck through
in prose, with the answer beside them, so nobody re-opens a closed one.

1. **ANSWERED — which mode should a *new* install default to?** `window` (off),
   the same as an existing install. One code path, no `installOrigin` cleverness.
   The added reason (§1.10) is that a fresh install has **no agent traffic**, so an
   on-by-default widget's only content is its empty state. Discovery moves to a
   one-line, once-only offer **inside the Agent memory view**, shown when a project
   first accumulates real traffic.

2. **STILL OPEN, and narrowed — does the event strip need an endpoint?** The
   **scope popup** needs none: `GET /api/memory/:project?scope=&journalLimit=8`
   already returns the journal array it renders. Only the **cross-scope** strip
   would, and that is Phase 3. Options unchanged: a separate
   `GET /api/memory/:project/journal?since=`, widening the index route (which must
   stay cheap — a badge polls it), or dropping the strip. Still leaning to a
   separate endpoint.

3. **ANSWERED, with a taste question left over — app or editor on click?** In
   Phase 1 (native menu) a row click **opens the app on that scope**. In Phase 2
   the row opens the **popup**, which carries both *"Open in The Curator"* and
   *"Reveal file…"*. §3.9's precedent (syncthingStatus) puts Reveal **on the row**,
   and §3.8's (CCMenu) makes the row's primary action *"take me to the underlying
   thing"*. Which of the two is the row's default is the maintainer's call and
   costs nothing to change.

4. **ANSWERED — how many rows, grouped or flat?** **Eight, flat by recency, not
   grouped by project** — reversing the first pass. §1.3 argues it; §3.9 found a
   working implementation of exactly that shape (`prefix(5)` + "Show All (23)"),
   and found that the device-list shape the first pass leaned toward is the one
   the field mostly abandoned.

5. **STILL OPEN — what does the glyph carry?** Now with better information.
   *Static* is defensible. *One bit* is the lean, and the choice is between **live**
   (an agent wrote in the last two minutes) and gitnews-style **unseen** (novelty
   since you last looked); §1.5 leans to unseen, CCMenu's priority-collapse tells
   us how to reduce many scopes to one. The *rendered image* option is now priced:
   §3.7 shows StreakBar does exactly this natively, and §3.11 shows Electron's
   `Tray` takes only a `NativeImage`, so we would render a PNG ourselves on every
   change and lose `variableLength` and hover. **New input:** Electron PR 48738
   (layered tray icons) would make "template glyph + coloured dot" clean if it
   lands — worth checking before building anything custom.

6. **LEANING NO, FOR NOW — is `tray-only` worth shipping?** §3.11 adds a reason to
   hold it: the runtime `accessory → regular` transition, which is exactly what
   `tray-only` depends on when the user opens the window from the tray, is
   **reported buggy** (RECALLED, not primary-sourced — worth 20 minutes on a real
   build before deciding). Shipping `window` and `tray` only is the safer first
   cut, and it costs the user nothing they have today.

7. **STILL OPEN, and still the best isolated win — the GPU process.** 85 MB
   resident, 583 MB peak, for a static UI. Unmeasured. Should be pulled out of this
   roadmap and done as its own small measured change, independent of the widget.

8. **PARTLY ANSWERED — `menubar@9.5.3` or `electron-menubar@10.2.1`?** §3.8 found
   **Gitify imports `Menubar` from `electron-menubar`**, so the fork has at least
   one real production consumer. Phase 1 (native menu) still needs neither, so the
   decision stays deferred to Phase 2 — but note the repo has **zero root
   devDependencies** and `desktop/` has no runtime dependencies either, and both
   libraries mostly buy ~200 lines of positioning, blur-to-hide and the
   `dock.hide()` race workaround.

9. **STILL OPEN, and now contested — `setActivationPolicy` or `LSUIElement`?**
   §1.8 chose the runtime API on documentary grounds and the documentation has not
   changed. §3.11 records community reports pointing the other way (a ~1 s Dock
   flash at launch; a buggy `accessory → regular` transition). The runtime API is
   required anyway for a switchable mode. **Recommendation: do not decide from
   documents — build both once and look**, and until then treat question 6 as
   answered "not yet".

10. **NEW — should the collision warning (§1.2a(a), §1.3 #5) ship in Phase 1?** It
    is the highest-consequence thing the widget can say and it costs no I/O. The
    argument against is that a warning about a condition the user has never hit,
    on a surface they just enabled, is noise — and this project has a recorded rule
    that a warning which fires when it should not is worse than no warning. It fires
    only when two different `harness` values appear consecutively in one folder
    inside a short window; the threshold has never been tuned against real data,
    because there is no real data yet.

11. **NEW — is a first-run fallback needed for an invisible icon?** §3.10 found
    **three independent ways** the icon disappears silently (the notch, Ice's
    Always-Hidden section, the macOS 26 Menu Bar toggle), **no API to detect any of
    them**, and Electron does not even expose `NSStatusItem.removalAllowed`. The
    cheap answer is copy: the Settings toggle says the icon may not appear and
    where to look. The expensive answer is a confirmation the app cannot honestly
    give. Recommendation: copy only.

---

## 6. Sequencing — updated for v3.33.0

> **Phase 0 and Phase 1 have both shipped**; Phases 2 and 3 have not. The table in
> [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan) carries the
> current state. The risk analysis below is why the phases were split this way and
> is unchanged.

**The first pass scoped this for "a release after v3.31.0", and that release has
shipped**, along with v3.32.0 and v3.33.0. The reasoning behind the deferral is
still the reasoning that should govern it:

This feature changes the app's **process lifetime model**. The app stops being
something you open and close and becomes something that is always there. That
touches the quit guard, the Dock, the window lifecycle, and — from Phase 2 — adds
a second renderer. `desktop/README.md` is blunt that the busy-quit `ask` branches
have **never run against a real write**, and making the app long-lived makes those
branches *more* likely to fire, not less.

**What changed in this pass is that the work now splits cleanly into four phases
with very different risk profiles**, and only two of them touch the lifetime model
at all:

| Phase | Touches process lifetime? | Adds a renderer? | Risk |
|---|---|---|---|
| **0** — two fields on the store's index row | No | No | ~None. Additive, and it fixes a live bug in a shipped view |
| **1** — tray + native menu, `window` default | **Yes** | No | The real risk sits here: Dock, quit guard, window lifecycle |
| **2** — popover panel + scope popup | No further | **Yes** | Memory and a second surface; contained |
| **3** — bucketed event strip | No | No | Cosmetic; first thing to cut |

**Phase 0 should not wait for any of this.** It is four lines in
`listWorkingScopes`, it is purely additive, and it corrects a defect that is live
today in the Agent memory view on any multi-machine setup (§1.2a(b)). It should be
argued and shipped on its own merits, not carried in on this feature's back.

**The same still applies to the first pass's two recommendations**: gating the two
shell `setInterval`s on `document.hidden` (§2.7 rec 1) is a few lines with an
existing three-times-proven pattern, and measuring the GPU process (rec 2) costs
one launch. Both improve the app whether or not the widget is ever built.

---

## 7. RECOMMENDATION — in plain language

> **The first two of the three recommendations below are built; the third — the
> pop-up card — is not.** Two other things in this section did not survive the
> build: the once-only in-app offer to turn the setting on (deviation 3) and the
> check-on-open of the remote count (deviation 2). Both are in
> [§0a](#0a-status--what-shipped-what-deviated-what-is-still-a-plan).

*Written to be read aloud. No jargon, no file names.*

### What this is

A small icon in the top menu bar of your Mac that shows what your AI agents have
been writing into The Curator, without you having to open the app.

### Build these three things, in this order

**First — fix a wrong number that is already on screen.**
Right now, when your second computer downloads work from your first computer, The
Curator shows it as *"just now"* — because it is reading the moment the file
landed on the disk, not the moment the agent actually wrote it. So a handoff from
yesterday morning looks like it happened this second. This is a small fix, it is
about four lines, and it needs doing whether or not the widget is ever built. It
also happens to unlock half of what the widget wants to say.

**Second — the menu bar icon, with a plain list.**
Click the icon, see the eight most recent things your agents have saved, newest
first. Each one says which workstream it was, who wrote it, how long ago, and the
one-line summary the agent itself wrote. Underneath: *Open The Curator*, and
*Quit*. That is the whole of it. No graphics yet. This version already does
everything you asked for except the pop-up card, and it is by far the cheapest
thing to build.

**Third — the pop-up card, when you click a workstream.**
You asked to click a scope and see it rather than opening the whole app, and you
should have that. It shows the last few things that happened in that workstream —
each with the time, which tool wrote it, and the summary — plus a small bar
showing how full that handoff is getting, and a button to open the real thing in
the app or in your editor.

### What I would draw, and what I refuse

**I would draw two things, and only two.**

- **A small bar showing how full a handoff is.** There is a real ceiling — 48 KB
  — and when you pass it The Curator quietly trims your handoff. That is worth
  seeing before it happens, and it is the one number in the whole system that
  behaves like the numbers on a system monitor. It stays invisible until it is
  worth noticing.
- **A coloured dot for how recent each entry is** — working right now, this
  session, today, this week, dormant. Five steps, not a sliding bar, because
  "how old" has no maximum and a bar that is "half full" would be inventing one.

**Later, and only if you want it: a little activity strip** showing which tool
wrote in which five-minute slot over the last hour, one row per tool. That is the
closest honest thing to the system-monitor look you pointed at, and it is the one
place where having two tools running at once genuinely makes a picture worth
drawing. It is also the first thing I would cut.

**I refuse four things, and the reason is the same in every case: they would look
precise while telling you nothing true.**

- **A progress bar for a save.** A save is not partly done. It has happened or it
  has not. A bar would be theatre.
- **A wavy line graph of saves over time.** A line between two points says
  something existed in between. Between two saves, nothing exists.
- **Anything where "more saves" looks like "more progress".** How often an agent
  saves is a setting, not an achievement. Drawing it bigger would flatter the
  wrong thing.
- **A CPU or memory meter for The Curator itself.** It is the only part that
  would have to run constantly, it would cost the most, and nobody installed a
  second brain to watch it breathe.

### The setting, and the default

There is a single setting: **Off / On / On, and hide the Dock icon.**

**It should be Off by default, for everybody**, and the reason is not caution. On
a brand-new install there is no agent memory yet, so an on-by-default icon's only
possible content is *"nothing here yet"* — the worst possible first impression,
and it teaches people the icon is not worth clicking. Instead, the app offers it
**once**, quietly, in the Agent memory screen, at the moment a project has
actually accumulated some work. One line, with *Turn on* and *Not now*. If you say
not now, it never asks again.

**One warning to put in the setting's own text.** There are three separate ways a
new menu bar icon can silently fail to appear on a modern Mac — it can be pushed
off the edge behind the notch, a menu bar organiser can file it into a hidden
section, and macOS now has a permission for menu bar items. **Apple provides no
way for an app to find out which of these happened.** So the setting should say
plainly that the icon may not show up and where to look, rather than leaving
someone to conclude the feature is broken.

### The one thing I found that you will want to know about

**Two agent tools running on the same computer cannot be told apart by The
Curator.** If opencode and Claude Code are both working on the same project and
the same workstream, they write to the same file, and each one overwrites the
other. Nothing warns you. The permanent record of *what happened* survives — that
is a separate, append-only log — but the *current handoff* only ever holds
whichever tool saved last.

The fix is on your side, not in the code: **give each tool its own workstream
name**, and they never collide. What the widget can do — for free, because the
information is already being read and thrown away — is **notice when it is
happening and say so in one line**. That is the single most valuable thing in this
whole design, and it costs almost nothing.

### What you will not get

The pop-up card shows **what has happened**, not **where things stand**. The long
"here is the state of play" section of a handoff runs to fifteen thousand
characters or so, and there is no honest way to put that in a menu bar. Anyone
who reads only the pop-up is reading the shallow version. The card is there to
answer *is this worth looking at?* — the app answers *what is in it?*

And one thing the icon itself can never tell you: **whether your other computer
has pushed something you have not downloaded yet.** That question needs the
network, and putting it on a timer would mean The Curator quietly phoning GitHub
forever behind a closed menu. So it is checked **at the moment you open the menu**
and shown as a line inside it — never in the icon.
