# Roadmap — menubar widget: background running + a live view of agent memory (planned, not yet implemented)

> **Nothing in this file describes shipped behaviour.** As of v3.30.0 the Mac app
> is a single `BrowserWindow` with a Dock icon and no status-bar presence at all.
> This is design context plus a resource baseline, written so the work can start
> immediately after v3.31.0 without re-deriving anything. Update it in place as
> decisions firm up. Same convention as
> [roadmap-chat-modes.md](roadmap-chat-modes.md).
>
> **Written against a measurement session on 2026-08-31**, macOS 15 / arm64,
> against the running v3.30.0 build installed in `/Applications`. Every number in
> §2 is tagged MEASURED or INFERRED. The ones tagged INFERRED are the ones a
> future session should measure rather than inherit.

---

## 0. The one-paragraph version

The Curator's memory layer is written by **agents, over MCP, while the user is
doing something else entirely**. Today the only way to see that happening is to
open the app and navigate to the Agent memory view. A menubar presence turns an
invisible background process into an observable one, and — because the MCP server
and the memory layer are useful with the window closed — it also makes "closing
the window" stop meaning "stopping the product". The widget is an **observer**:
the app is read-only over working state by design, and it must stay that way.

---

## 1. The feature

### 1.1 The audience, stated narrowly on purpose

**A developer with a coding agent running right now in another window, who wants
to keep half an eye on what that agent is recording without breaking their own
flow.**

That is the whole design target. "Migrate and keep context between different
harnesses" is the job the memory layer exists to do; the widget is the
instrument panel for it. Every proposal below is justified against that one
scenario, and the test applied throughout is: *does this help that person, in
that moment, without making them stop what they are doing?* If it does not, it is
Dock-icon work — it belongs in the full app's Agent memory view, not in the
menubar.

Two things follow from taking the audience seriously:

- **This person already knows what a scope is.** The widget does not need to
  teach the model. It needs to report state densely and get out of the way.
- **This person is not looking at it most of the time.** The panel is closed
  during almost the entire life of the process. That is a design constraint and
  a cost constraint, and §2.6 treats it as one.

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

### 1.3 What the widget shows — decided, not enumerated

Three candidates were on the table. The decision is **scopes are the content,
the brief is a one-line fact, and the log is a link**.

#### Scopes — the core, and the only thing that gets real space

The panel's body is a list of recent **(project, scope, machine)** rows, newest
write first. `GET /api/memory` already returns exactly this, in one request, with
every field the row needs:

| Field from `GET /api/memory` | What the row does with it |
|---|---|
| `project` | Row group heading |
| `newestScope` | The primary label |
| `newestMachine` | Shown **only when it is not this machine** (see below) |
| `ageSeconds` / `lastWriteAt` | The recency encoding — §1.5 |
| `headline` | The one-line summary the agent wrote; this is the payload |
| `distinctScopeCount` / `savedCopies` | "3 scopes · 5 saved copies" secondary line |
| `hasBrief` / `briefUpdatedAt` | The brief's one line — see below |
| `unlistedEntries` / `unlistedReason` | A warning row when non-zero — never swallowed |
| `scopesTruncated` | "showing N of M" — a cap must never read as a measurement |

**How many rows.** Cap the panel at **8 project rows**, newest-write-first, with
a "Open Agent memory…" item beneath that reaches all of them. Eight is not
arbitrary: it is roughly what fits above the fold of a menubar panel at a
comfortable row height without the panel becoming a window, and the audience is
watching *one* agent — the rows below the eighth are, by construction, not the
thing they are watching. `MAX_PROJECTS` is 200 server-side; the panel must show
the truncation, not hide it.

**Machine.** Show it only when `newestMachine` differs from this host. On a
single-machine setup the column is noise; the moment it appears it is the most
interesting thing on the row, because it means *the other machine just wrote
this*. The read already carries `machineIsThisMachine` on the scoped route;
the index route does not, so the widget compares `newestMachine` against the
same `machineId()` the store derives (see §4).

**When there are none.** This matters more than it looks: it is the first thing
every new user sees. The empty state is **not** an error and must not read like
one. `GET /api/memory` deliberately returns a row for every domain including
those with nothing saved, precisely so this state is expressible. The panel
should say something like *"No agent memory yet — a coding agent writes here
through the my-curator MCP"* with a link to the setup docs, and nothing else.
The failure to avoid is a blank panel that looks broken.

#### The standing brief — one line, and the honest reason

`state/project.md` is tier 1: hand-authored, returned on every read, and
deliberately unwritable by any tool. **A menubar dropdown is the wrong surface
for it**, and I want to argue that rather than assert it:

- It is up to 32 KB (`MAX_BRIEF_BYTES`) of prose and firm decisions. That is a
  document, not a status line.
- It changes on the order of *weeks*. The audience is watching something that
  changes on the order of *minutes*. Putting a rarely-changing document in a
  surface designed for a fast-changing one wastes the space that the
  fast-changing thing needs.
- Its whole value to a resuming agent is that it is read **in full, at the start
  of a session**. Skimming three lines of it in a menubar serves nobody.

So the brief gets **one line per project row**: *"Standing brief · updated 6
days ago"*, or *"No standing brief"* when `hasBrief` is false. That is the
honest version of its value here — **it exists, and it is this old** — and it is
genuinely useful, because a stale or missing brief is exactly the thing that
makes a resumed session go wrong, and the person watching an agent work is the
person who can fix it. Clicking the line opens the full app on that project.

#### Logs — a link, not a tail

`~/Library/Logs/The Curator/curator.log`, bounded at 5 MB with single-generation
rotation. **Do not tail it in the panel.** The decisive fact is not the width —
it is the volume:

`src/brain/logger.js` records startup facts, provider and model, update outcomes
and caught errors. **Per-request logging was deliberately excluded** (v3.29.0's
row says so explicitly: an access line per GET turns a support file into noise
within a day). So on a healthy machine this log emits **a handful of lines a
day**, most of them at launch. A tail of it in a menubar panel would show the
same three startup lines for hours and then, on the one day something breaks,
show a truncated stack trace at 300 px wide.

What earns the space instead is **one item — "Open Log…" — plus a state
indicator that only appears when it has something to say**: if the app has
written an `error`-level line since launch, the item reads *"Open Log — 2 errors
today"*. That is the shape of log line that earns menubar space: not the content,
but the *count of things that went wrong*, which is a real, bounded, glanceable
fact.

**One honest gap:** that count does not exist yet. `getLogFileStats()` returns
`{path, bytes, mtimeMs}` — the file, not its contents. An error count needs a
process-lifetime counter incremented in `logError()`, which is three lines and
no new state on disk. Say so rather than implying the data is already there.

### 1.4 NSMenu versus a rendered popover — argued, then decided

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
   §1.1's scenario. Phase 2 replaces the menu with a popover and adds the two
   encodings. Phase 1 costs no renderer; Phase 2's cost is then paid against a
   feature people are already using, which is the right order to spend it in.

**If the popover is built, three non-negotiables** (all of them cost items in
§2.6):

- `backgroundThrottling: true` explicitly set on it, not inherited by accident.
- The window is **destroyed on close**, not hidden, unless measurement shows the
  re-create latency is perceptible. A hidden renderer is a resident renderer.
- **Nothing animates and nothing polls while it is closed.** The data it renders
  is pushed to it (§1.6), so a closed panel has nothing to do.

### 1.5 Visual encodings — what is honest, and what is refused

Our data is not a system monitor's data, and this is the central design problem.
A CPU meter has a continuous, bounded numeric series; that is what makes a
sparkline and a percentage bar truthful. A scope save is a **discrete event with
a timestamp, a byte count, a harness, a model and a headline**. There is no rate,
no percentage of anything, and **no completion** — a save is not partway to
being finished, it is done or it has not happened.

This project has a recorded rule that a fact and its absence must never collapse
into the same value (v3.15.0). Borrowed chrome that implies precision we do not
have is that same defect rendered in pixels.

#### ACCEPTED — budget fill, and it is a genuine bounded percentage

`MAX_STATE_BYTES = 48 KB` is a real, hard cap. An over-budget save is
**trimmed and disclosed in `notes`**, never refused — so approaching the cap is a
real condition with a real consequence the user can act on (split the scope). The
journal records `bytes` on **every** line.

`bytes / 48 KB` is therefore an honest percentage bar: bounded, meaningful at
both ends, and it surfaces truncation behaviour that already exists and is
currently invisible unless you read the notes. **This is the one percentage bar
the design should have**, and it is worth having precisely because it is the one
number in the whole store that behaves like the reference app's numbers.

Render it small — a 3 px rule under the headline — and colour it only past a
threshold (say 80%), so it is invisible until it means something.

#### ACCEPTED — recency, encoded as buckets, not as a linear bar

Recency is the strongest candidate for the "progress bar" the maintainer asked
for, and it needs care, because **it is unbounded**. A scope can be four seconds
old or eight months old. A linear bar needs a maximum, and any maximum is
invented — which makes the bar's *fullness* a fiction.

The honest encoding is **discrete states with a log-ish scale**, shown as a dot
or a short filled pip, plus the exact relative time in text:

| State | Age | Reading |
|---|---|---|
| Live | < 2 min | An agent is working in this scope **right now** |
| Warm | < 30 min | This session |
| Today | < 12 h | Earlier today |
| Cool | < 7 d | This week |
| Cold | ≥ 7 d | Dormant |

Five states, because the audience's real question is a five-way one and not a
continuous one: *is it moving now / did it just move / is this today's work /
is this last week's / is this abandoned?* The text beside it (`4 min ago`)
carries the precision; the pip carries the glance. `formatAge` is **already
exported** from `src/public/next/views/memory.js:730` and must be shared rather
than reimplemented — two functions rendering "4 min ago" is the smallest possible
version of the two-surfaces-drift problem §1.7 is about.

#### ACCEPTED, WITH A CONSTRAINT — a save-event strip, not a sparkline

`journal.jsonl` is genuinely a time series: one append-only line per save
carrying `{ at, scope, machine, harness, model, headline, bytes, rejections }`.
Plotting saves over time would show a coding session's rhythm — dense bursts
while an agent works, flat while nothing runs. For someone watching an agent
work, *"has it written anything in the last ten minutes"* is a real question and
this answers it at a glance.

**But it must not be a filled area sparkline.** A filled curve interpolates
between samples and implies a continuous quantity exists *between* the points.
Saves have no value between them — there is no "amount of memory" at 14:32 that
is halfway between the 14:30 save and the 14:35 save. Drawing one would be
exactly the borrowed-chrome defect.

**And it has no precedent — which is a caution, not a veto.** §3.3 searched
specifically for discrete-event menubar apps and found **none** using any
time-series graphic; every one converges on a status glyph plus a relative
timestamp. Sparklines appear only in continuous-metric apps. So this proposal is
genuinely novel, and novel-in-a-menubar is usually novel-for-a-reason. It should
be the **last** thing built and the first thing cut.

The honest form is a **rug plot / event strip**: a horizontal track covering a
fixed window (last 60 minutes), one tick per save, positioned by time. It reads
instantly as *"three saves in the last hour, the last one just now"* and it
claims nothing it cannot support. Optionally, tick *height* encodes `bytes` —
which is a real per-event quantity — but that is a Phase 3 refinement and the
plain strip is already useful.

The constraint: it needs journal data, which the index route does not return.
See §5 question 2 — this is the one place the feature wants an endpoint that
does not exist.

#### REFUSED — and the reasons, so nobody re-adds them

| Refused | Why |
|---|---|
| **A percentage-complete bar for a save** | There is no completion. A save is atomic (`writeFileAtomic` = tmp + rename). A bar would render a fiction. |
| **A filled sparkline of save events** | Implies interpolation between discrete events. See above. |
| **A live CPU/memory/throughput meter of The Curator itself** | It borrows the reference app's *subject*, not just its chrome. Nobody installed a second brain to watch its RSS, and it would be the one part of the panel that must poll continuously — the single most expensive thing we could add, bought for the least value. |
| **A "context window used" gauge** | The Curator does not know the agent's context window. Inferring it from handoff size would be a fabricated number on a surface whose whole job is telling the truth about state. |
| **A tail of `curator.log`** | Volume is a few lines a day (§1.3). Replaced by an error *count*. |
| **A count-up "time since last save" that ticks every second** | It would be the only thing in the design forcing a timer while the panel is open, for a number nobody reads to the second. Recompute on open and on push. |

#### ACCEPTED — a last-updated stamp on the panel itself

Added because of §3.3's strongest finding: OpenAI's Codex menubar app has an open
bug filed **precisely** for showing event data with no freshness marker, and the
proposed remedy is *"showing a 'last updated at HH:MM' timestamp"*.

So the panel carries one **absolute** `HH:MM` stamp in its footer, distinct from
the rows' **relative** ages. The two answer different questions — *how old is
this event* versus *how old is this reading* — and conflating them is how a
widget comes to display a confidently stale list. It also costs one line and
makes a silently-dead watch (§1.6) visible rather than invisible, which is the
failure mode the fallback poll exists for.

#### The menubar glyph itself

The icon is the presence signal — *"The Curator is running"* — and it should
carry **at most one bit** beyond that. The candidate bit is **live**: an agent
has written in the last two minutes. A subtle filled/hollow state on a template
image is enough, and template images are the only thing guaranteed to look right
against light, dark, and tinted menu bars (Electron's own tray guidance — §3.2).

**§3.3 offers a better candidate bit, and it is worth considering seriously.**
`gitnews-menubar` distinguishes *unread* from **"unseen — probably just
arrived"** — novelty relative to when you last looked. For our audience that may
be the stronger signal: "live" goes false two minutes after an agent stops, while
"unseen" stays true until the user actually looks, which is the question they are
really asking. It costs a little more state (a last-opened timestamp, per
install, not per scope). Open question — §5.5.

Also worth recording from §3.3: **CCMenu collapses many pipelines into one glyph
by priority** — running first, broken second. Our equivalent priority order would
be *live > unseen > idle*, and it is worth stealing, because the alternative
(a glyph that reflects only the newest scope) is wrong the moment there are two.

Explicitly **no badge count** and **no animation**. A count of what? Saves since
you last looked is a "read state" the app would have to store per-user, and an
animated glyph in a menu bar is the thing people uninstall apps over.

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

### 1.7 Clicking through to read — one surface, not two

A handoff's `now_state` runs to several thousand characters; `MAX_STATE_BYTES` is
48 KB. **That does not fit in a menubar panel under any design**, so the design
must decide where reading happens.

**Decision: clicking a row opens the full app on the Agent memory view, scoped to
that project and scope.** The widget does not grow its own reader.

The trade-off, named honestly:

- **Cost of this choice:** one extra click and a window appears — a heavier
  gesture than the reference apps' self-contained panels. For a user who only
  wants to *read the last headline*, the panel already showed it, so the click
  is only paid by someone who wants the full document; that is the right person
  to charge.
- **Cost of the alternative:** a second surface rendering the same content. This
  project has a specific, repeated finding that two surfaces rendering one thing
  drift — v3.26.0's five modal implementations that had each privately copied a
  scrim value and then diverged; the `--scrim` token that was undefined and so
  taught four stylesheets to inline a literal. A second working-state reader
  would have its own sanitiser call sites, its own truncation handling, its own
  `unlistedEntries` disclosure — every one of which is a place the two can
  disagree about the same file. The Agent memory view already handles all of it,
  including the fold-state and revalidation behaviour that took two releases to
  get right.

There is a real second option worth recording: **"Reveal in Finder" / open
`current.md` in the user's editor**. It is one line of code (`shell.openPath`),
it costs no new surface, and for this specific audience — developers — it may
genuinely be the preferred read. Offer it as a secondary item on the row
(⌥-click, or a submenu), not as the primary action.

### 1.8 The Dock icon, and how the window comes back

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

**The headline result: I found no app, anywhere, that uses a sparkline for
discrete events.** Sparklines appear only in continuous-metric apps (Stats'
chart widgets; iStat Menus' 10-minute-to-28-day history graphs — VERIFIED,
bjango.com version history). Every discrete-event app converges on the same
vocabulary:

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

---

## 4. Implementation plan — files that would change

**Phase 1 — background running + tray + menu. No renderer added.**

| File | Change |
|---|---|
| `desktop/main.js` | Create `Tray`; build the menu; wire "Open The Curator" to the **existing** `revealWindow()`; wire Quit to `app.quit()` (never `app.exit()`); read `backgroundMode` before creating anything |
| `desktop/lib/tray-menu.js` **(new)** | **Pure**, Electron-free: turn a `GET /api/memory` payload into a menu template + glyph state. Same shape as `quit-decision.js` — the offline suite can then **execute** it |
| `desktop/lib/state-watch.js` **(new)** | **Pure-ish**: debounce, dot-prefix filtering, `/state/` path filter, fallback-poll scheduling. Injectable clock and watcher so it is testable offline |
| `desktop/lib/dock-mode.js` **(new)** | Pure: resolve `'window' \| 'tray' \| 'tray-only'` from config, with the fail-safe default |
| `desktop/electron-builder.yml` | `LSUIElement` is **not** set statically — the mode is runtime, via `app.setActivationPolicy('accessory' \| 'regular')` (§3.2: the documented API; `dock.hide()` carries a 1-second no-op window and a launch-activation race). See §5, question 9 |
| `src/brain/config.js` | Read/write top-level `backgroundMode` (**not** `ui.*` — see §1.10) |
| `src/routes/config.js` | Expose it on the config GET/POST |
| `src/public/next/views/settings.js` | The three-way control, plus copy explaining what `tray-only` removes |
| `src/public/next/app.js` | **Recommendation 1**: gate the two shell `setInterval`s on `document.hidden` |
| `scripts/test-desktop-packaging.js` | Assert tray Quit routes through `before-quit`; assert `backgroundThrottling`; source-scan the `main.js` call sites |
| `scripts/test-tray-menu.js` **(new)** | Execute `tray-menu.js` and `state-watch.js` against fixtures — the parts that can be proven offline |
| `docs/mac-app.md`, `docs/user-guide.md`, `docs/working-state.md` | Document the mode; §6 of `working-state.md` currently says the in-app view is the only surface |

**Phase 2 — popover panel + the two honest encodings.**

| File | Change |
|---|---|
| `desktop/main.js` | Frameless `BrowserWindow`, positioned from `tray.getBounds()`; `blur` to close; destroy on close |
| `desktop/lib/panel-position.js` **(new)** | Pure: tray bounds + display work area → window bounds. Multi-display and notch edge cases; testable offline |
| `src/public/panel/**` **(new)** | The panel page. **Reuses `next/tokens/`** — it must not become a second design system |
| `src/routes/memory.js` | **Possibly** a journal-summary endpoint for the event strip — see §5, question 2 |

**Explicitly NOT changed:** `desktop/lib/quit-decision.js` (the decision is
correct; only its call context changes), `src/brain/working-state.js` (the
widget reads, never writes), and anything under `src/public/app.js` (`/old`).

---

## 5. Open questions for the maintainer

1. **Which mode should the Settings control default to for a *new* install?**
   §1.10 argues `window` for everyone, so an update changes nothing. But a
   first-time installer has no habits to protect, and `tray` is arguably the
   better introduction to what this product is. Two defaults, keyed on
   `installOrigin` (which v3.28.0 already records), is possible — and is also
   exactly the kind of cleverness that produces two code paths and one bug.

2. **Is the save-event strip (§1.5) worth an endpoint?** It is the one
   visualisation that needs data `GET /api/memory` does not return. The options
   are a new `GET /api/memory/:project/journal?since=`, widening the index route
   (which must stay cheap — a badge polls it), or dropping the strip. I lean
   toward a **separate** endpoint so the index route's cost profile is untouched.

3. **Should the row's primary click open the app, or open `current.md` in the
   user's editor?** §1.7 picks the app and offers the editor as secondary. For
   this audience specifically, the reverse may be right.

4. **How many rows, and grouped by project or flat by recency?** §1.3 proposes 8
   rows grouped by project. A flat "8 most recent saves across everything" list
   is the better match for *"what has the agent just done"* and the worse match
   for *"what is the state of my projects"*.

5. **What does the tray glyph carry — nothing, one bit, or a rendered image?**
   Three options, in ascending cost: a completely static icon (defensible — it
   never draws the eye, which for a background app is a feature); one bit, either
   *live* or gitnews-style *unseen* (§1.5 leans to this, and CCMenu's
   priority-collapse rule tells us how to reduce many scopes to one glyph); or a
   **base64-rendered image** via `tray.setImage()`, which §3.5 establishes is
   possible and which could put a save-event strip in the *bar itself*, no
   popover required. The third is the closest thing to the maintainer's
   screenshot that Phase 1 can reach, and it is also the easiest to overdo.

6. **Is `tray-only` worth shipping?** It is the mode the "real estate" complaint
   most directly asks for, and the mode with the most ways to strand a user.
   Shipping only `window` and `tray` initially is a defensible first cut.

7. **Recommendation 2 (the GPU process) is unmeasured and potentially the
   largest win in this document.** Should it be pulled out of this roadmap and
   done as its own small measured change, independent of the widget?

8. **`menubar@9.5.3` or `electron-menubar@10.2.1` — or neither?** §3.2 found both
   packages active with overlapping maintainers, the fork claiming to be the
   successor and the original explicitly supporting Electron 43. Adopting either
   buys tray-bounds positioning, blur-to-hide, and the `dock.hide()` race
   workaround — perhaps 200 lines we would otherwise write and get wrong. Against
   that: this repo has **zero devDependencies at the root** and has refused
   dependencies four times on that principle, and it would be a runtime dependency
   of `desktop/`, which currently has none either. Phase 1 (menu only) needs none
   of it, so the decision can be deferred to Phase 2 — but the two candidates
   should be re-checked then, not assumed.

9. **`setActivationPolicy('accessory')` or `LSUIElement` in `extendInfo`?** §3.2
   establishes the runtime API is the documented one and that Electron never
   mentions `LSUIElement`. But a static `LSUIElement` never bounces the Dock at
   launch, whereas the runtime call can briefly show the icon — which is why the
   `menubar` library ships a 2000 ms re-hide. The runtime API is required anyway
   for a three-way switchable mode; the question is whether `tray-only` users
   would be better served by a relaunch into a statically-configured state.

---

## 6. Sequencing — and I agree with it

**This is scoped for a release after v3.31.0, and that is the right call.**

v3.31.0 exists to make the download-install-run path work without crashing.
This feature changes the app's **process lifetime model**: the app stops being
something you open and close and becomes something that is always there. That
touches the quit guard, the Dock, the window lifecycle, and — if the popover is
built — adds a second renderer. Every one of those is a way to make "it launches
and works" false, which is precisely the property v3.31.0 exists to establish.

`desktop/README.md` is also blunt that the busy-quit `ask` branches have **never
run against a real write**. Making the app long-lived makes those branches
*more* likely to fire. Landing both changes in one release means the first real
exercise of an untested path happens inside a release whose goal is stability.

**One dissent, and it is small.** Recommendations 1 and 2 in §2.7 are not part of
this feature. Gating two `setInterval`s on `document.hidden` is a few lines with
an existing three-times-proven pattern, and measuring the GPU process costs one
launch. Both improve the app that ships in v3.31.0 and neither touches the
lifecycle. If anything from this document lands early, it should be those — and
they should be argued on their own merits, not carried in on this feature's back.
