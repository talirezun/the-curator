# Roadmap — automatic sync (researched, recommended in part, not built)

> **Nothing in this file describes shipped behaviour.** As of v3.33.0 every sync
> operation in The Curator happens because a human clicked something. There is no
> timer, no background push, no background pull. This document is the research
> behind whether there should be, written so the implementing session can start
> without re-deriving the hazard analysis. Update it in place as decisions firm
> up. Same convention as [roadmap-chat-modes.md](roadmap-chat-modes.md) and
> [roadmap-menubar-widget.md](roadmap-menubar-widget.md).
>
> **Measurements in §3 were taken on 2026-08-31** against `src/brain/sync.js` at
> v3.33.0, using throwaway repositories under the system temp directory. No
> network call was made to any real remote; every "remote" is a local
> `git init --bare`. Every figure is tagged MEASURED or INFERRED.
>
> **Read [sync.md](sync.md) and the `v3.32.0` row in `CLAUDE.md` before changing
> anything here.** Connecting sync destroyed four hours of a user's working state
> in August 2026. That incident is the reason this is a research document and not
> a pull request.

---

## 0. The one-paragraph version

The request is real and the safe half of it is bigger than it looks. **Automatic
PUSH is structurally incapable of destroying a local file** — measured, not
argued — and it costs *zero network calls* when there is nothing to send.
**Automatic PULL is a different animal**: it rewrites files under the user, it
silently prefers the remote on a genuine conflict, and — a finding from this
research — every `pull()` recursively deletes any top-level folder in the
domains folder that has no `CLAUDE.md` in it. So the recommendation is
**automatic push, on by explicit opt-in; pull stays a decision, made one click
away and impossible to forget by showing what is waiting**. The multi-machine
problem is asymmetric, and so should the solution be.

---

## 1. The problem, stated precisely

Working state lives at `state/<scope>/<machine>/current.md` and is written by an
agent over MCP, usually while the person is doing something else. It reaches
another machine only through Personal Sync — the user's own private GitHub
repository. Today that requires two deliberate clicks by a human: **Sync now** on
the machine that wrote the handoff, and **Sync now** on the machine that wants to
read it.

Two failure modes follow, and they are not the same failure mode:

| | Machine that WROTE the handoff | Machine that wants to READ it |
|---|---|---|
| What is missing | The bytes never left this machine | The bytes are on GitHub but not here |
| What it costs | The handoff is stranded; if this disk is lost or overwritten it is gone | You start a session on stale context |
| Who is present | **Nobody** — the agent saved it, the person walked away | **The person, right now**, about to start work |
| Safe to automate? | **Yes** — see §4 | **Mostly not** — see §5 |

That asymmetry is the whole design. The sending side has nobody watching, which
is exactly why it needs automating. The receiving side has somebody watching, at
the one moment when a pull is safest — which is exactly why it does not.

---

## 2. What sync actually does today

Read `src/brain/sync.js`. Compressed:

**`push()`** — ensure `domains/.gitignore` is current → untrack already-committed
hygiene junk (`.write-lock`, `.DS_Store`, Obsidian leftovers) → delete
*already-dead* `.write-lock` files from disk → `git status --porcelain` →
`git add -A` + commit → count what is ahead → `git push`. **No merge, no
checkout, no reset.**

**`pull()`** — ensure `.gitignore` → **auto-commit whatever is in the tree**
("Auto-save before sync") → fetch for reporting → `git pull --no-rebase -X theirs
origin main` → untrack hygiene junk → commit the cleanup →
**`pruneGhostDomainDirs()`** → return.

**`sync()`** — `pull()` then `push()`.

**`getRemoteStatus()`** — `git fetch` + count what origin has that we do not.
Writes only remote-tracking refs inside the git dir; touches no file in the
domains folder. Serialised in-process, TTL-cached 5 minutes (60 s on failure),
and — the honesty rule the whole module is built on — a failed check returns
`behindFiles: null`, **never** a reassuring `0`.

**The route guard.** `guardConcurrent` in `src/routes/sync.js` returns 409 while
`hasActiveWrites()` is true. Read §6.1 before trusting that sentence.

---

## 3. Measurements

All against real `git` (2.48.1), throwaway repos under the system temp dir,
`file://` remotes, driving the **real** exported functions from
`src/brain/sync.js` with `__setSyncTestOverrides()` and
`__setDomainsDirOverride()`. The maintainer's real config file was fingerprinted
before and after every run and is unchanged; his real `domains/` was never
touched; port 3333 was never disturbed.

### 3.1 Cost of one cycle — MEASURED

Domain of 200 wiki pages plus a schema. Git subprocess counts come from
`GIT_TRACE2_EVENT` (`cmd_name` events), so they include git's own child
processes.

| Operation | git subprocesses | of which network-capable | wall time |
|---|---:|---:|---:|
| `setup(mode:'push')` — first connect | 19 | 2 | 263 ms |
| `push()` — **nothing to send** | 8 | **0** | 71 ms |
| `pull()` — **nothing incoming** | 19 | **3** | 156 ms |
| `sync()` — nothing to do either way | 27 | 3 | 223 ms |
| `sync()` — one file changed | 39 | 4 | 333 ms |

**The decisive number is the zero.** A `push()` with nothing to send never opens
a connection at all — it discovers locally that it is not ahead of `origin/main`
and returns. A `pull()` fetches unconditionally, every single time, whether or
not anything is waiting.

So a push-only automatic job **is free while you are not working** and costs one
GitHub round trip only in the minutes after you actually did something. A
pull-based job pays a round trip on every tick forever.

Wall times are against a **local** remote and are a floor for the local work
only. The real cost of the network leg is dominated by DNS + TLS + round-trip
latency to GitHub and was deliberately **not measured** (that would mean a real
fetch against a real remote). For scale, the app already governs this: 30 s
timeout on the background check, 5-minute server-side TTL, and since v3.31.0 the
frontend's 10-minute `refreshSyncRemoteBadge` timer is gated on
`document.hidden`.

> `roadmap-menubar-widget.md` §2.3's table still lists both shell timers as
> "Skips work while hidden? **NO**". That was true at v3.30.0 and is stale —
> v3.31.0 gated both. Fix it there when that document is next touched.

### 3.2 `push()` does not modify a single local file — MEASURED

100 wiki pages plus a `state/<scope>/<machine>/` folder holding `current.md` and
`journal.jsonl`. Every file in the domains folder was sha256'd before and after.

| Case | Files changed on local disk by `push()` |
|---|---|
| Push with one modified page, succeeds | **NONE** |
| Push **rejected** (another machine pushed first) | **NONE** — the local edit is still on disk, still committed, and goes out on the next cycle after a pull |

The two writes `push()` *can* make are `domains/.gitignore` (idempotent; only
when a rule is missing) and deleting `.write-lock` files the write registry
already considers dead. Neither is wiki content and neither fired here.

This is the single most important property in this document. **A push cannot lose
your work.** Git refuses a non-fast-forward push server-side, before anything
local changes.

### 3.3 A pull is a fast-forward *only* when the tree is clean and not ahead — MEASURED

Two clones of one remote. Machine A pushes a change to a page; machine B pulls.

| B's state before pulling | What `git pull --no-rebase -X theirs` does |
|---|---|
| Clean tree, 0 commits ahead | **Fast-forward.** No merge commit. `-X theirs` cannot engage — there is nothing to resolve |
| **Uncommitted** local edit to the same page | **git REFUSES**: *"Your local changes to the following files would be overwritten by merge"*. Nothing is changed |
| Local edit **committed** first | Merge runs, `-X theirs` takes origin's version. The local content is gone from disk and survives only in that commit, reachable by SHA |

**Read row two next to row three.** Git already protects an uncommitted local
edit — and `pull()`'s auto-commit is precisely what disarms that protection. That
is the right trade for an attended click (a half-merged wiki full of conflict
markers in someone's Obsidian vault is worse), and it is the wrong trade for an
unattended job, because the person who would have read the refusal is not there.

**The useful consequence:** the safe pull is cheaply identifiable. `git status
--porcelain` empty **and** `rev-list --count origin/main..HEAD` == 0 means the
pull is a pure fast-forward with no merge and no `-X theirs`.

### 3.4 Every `pull()` `rm -rf`s stray top-level folders — MEASURED, and this was a surprise

`pruneGhostDomainDirs()` runs at the end of **every** `pull()`, unconditionally.
It walks the top level of the domains folder and recursively deletes any
non-dot-prefixed directory that does not contain a `CLAUDE.md`.

Fixture: one real domain, plus `Attachments/` holding a file, plus `newdomain/`
containing a draft but no schema yet.

```
before pull: [ Attachments, demo, newdomain ]
after  pull: [ demo ]
pull() reported pruned: ["Attachments","newdomain"]
Attachments/diagram.png still exists: false
```

Nothing was incoming. The pull had no work to do. Both folders were destroyed
anyway.

This is correct, deliberate behaviour for its actual purpose — when another
machine deletes a domain, git removes the tracked files but leaves the empty
directory behind, and this cleans that up. It is also, in an unattended job,
**the largest single blast radius in the whole feature**:

- The domains folder is a documented Obsidian vault root ("a parent folder
  covering multiple domains"). A folder a user creates in Obsidian at that root —
  `Attachments/`, `Inbox/`, `Templates/` — is deleted by the next pull.
- A domain being created by hand, or one whose `CLAUDE.md` the user deleted, is
  deleted with everything in it.
- The frontend does surface it, in `views/sync.js`'s result line, as *"removed N
  deleted domains"* — which is both **only visible after a click** and **wrong
  wording** for a folder that was never a domain.

Today a user has to click Sync for this to happen. On a five-minute timer it
happens within five minutes of them making the folder, with no click to associate
it with and no dialog to read.

### 3.5 Two processes, one git dir: 10 failures out of 10 — MEASURED

Since v3.32.0, a second install pointed at an already-synced domains folder
**adopts** the existing repository rather than creating a second one. That is the
right fix, and it means two processes now share one git dir. Two concurrent
`git add` + `git commit` rounds, ten times:

```
concurrent commit rounds failing: 10 / 10
fatal: Unable to create '<...>/.git/index.lock': File exists.
```

Every failure is *safe* — git refuses, nothing is changed. But every failure is
also a sync that **silently did not happen**, which is §7's problem. The
in-process serialisation The Curator already has (`_fetchGate`,
`hasActiveWrites()`) does not cross a process boundary and was never meant to.

### 3.6 The write guard cannot see an MCP write — MEASURED

`guardConcurrent` checks `hasActiveWrites()`, which reads a **module-level `Map`
in the web server process**. The MCP server is a separate child process spawned
by the AI client; its write tools take the per-domain **file lock** instead.

```
file lock held (as the MCP holds it):                               true
hasActiveWrites() — what guardConcurrent in routes/sync.js checks:  false
=> an automatic sync guarded only by hasActiveWrites() would proceed: true
```

And `save_working_state` — the write this entire feature exists to propagate —
takes **no lock at all**, deliberately (`working-state.js`, and
`working-state.md` §7 explains why: the write target is per-`(scope, machine)`
and `current.md` is written atomically, so there is nothing to serialise).

So the guard that exists today protects an automatic sync from an ingest started
**in the browser window**, and from nothing else.

---

## 4. Automatic PUSH — the part that should exist

### 4.1 Why it is safe

Structural, not a hope. §3.2 measured it: a push changes nothing under the
domains folder, in either the success or the rejection case. It has no merge, no
checkout, no reset, and no prune. Git's server-side non-fast-forward refusal is
the backstop, and it fires before any local state moves.

### 4.2 Why it is worth doing

It shortens the window in which your work exists in exactly one place. Every
local-loss class in this project's history — a bad Health fix-all, a semantic
merge that deleted the wrong pages, a `reset --hard` — is recoverable from the
remote **if the bytes got there first**, and recoverable only by `git reflog` if
they did not.

**Stated honestly: this would not have prevented the v3.32.0 incident.** That
loss happened during the *first connect*, before any push was possible. It would
shorten the window for every subsequent instance of the same class.

### 4.3 What it may do, exactly

- `push()`, and nothing else.
- Only when there is something to send (`push()` establishes this itself for
  free — §3.1).
- Only when no write is in flight **in any process** (§6.1 — this needs building).
- Only when the install is not in the split-repo state (`getStatus().splitSyncRepo`).
- Only when it holds the cross-process auto-sync claim (§6.2 — needs building).

### 4.4 What it may NOT do

- It may not auto-commit in order to clear its own path in any sense beyond what
  `push()` already does. `push()`'s `git add -A` + commit is the same operation
  the attended button performs; that is the ceiling, not a starting point.
- It may not retry a **403 / expired token** on a schedule. That failure never
  self-heals and needs a human; see §7.
- It may not surface a raw git error anywhere. `push()` throws with git's own
  message, which embeds absolute filesystem paths and can embed a
  credential-bearing URL. A background job must route every failure through the
  same treatment `remoteErrorMessage()` gives the polled `/remote-status` route —
  map what is mappable, and never echo the rest.

### 4.5 The trigger

**Event-first, timer as the net.**

v3.32.0 already hooked the sync-badge refresh to `beginDomainWrite`'s release,
firing only when the last handle settles. **Note which layer that is:**
`beginDomainWrite` lives in `src/public/next/app.js` — it is the *frontend's*
client-side write gate, and it fires only while a renderer is alive. The
server-side equivalent, and the right chokepoint for a background job, is
`registerWrite()`'s release token in `src/brain/write-registry.js`. Auto-push
should hang off **that**, with a quiet-period debounce (60–120 s after the last
handle settles) so a burst of writes produces one push rather than N.

**The timer is not redundant**, and the reason is the whole point of the feature:
`save_working_state` runs in the MCP process and takes neither the registry nor
the lock, so the web server never learns it happened. The timer is what catches
the agent's handoff. It is also what catches an Obsidian edit. Neither reaches
`registerWrite()` at all.

### 4.6 The interval

**Default 5 minutes. Floor 1 minute if a user insists. No shorter.**

The cost does not constrain it — §3.1 measured a no-op push at 8 local git
subprocesses, 71 ms, and **zero** network. What constrains it is that nothing
below a few minutes is perceptible: the thing being raced is a human walking to
another machine.

The interval must be paused, not merely skipped, while:
- the machine is offline (a failed push should back off, not hammer);
- a write is in flight anywhere;
- the app is not running at all — which is fine, because the next launch pushes.

### 4.7 Default: OFF

This project's convention is that anything touching user data fails safe, and
this qualifies. Three reasons beyond convention:

1. It uses a stored credential to write to a remote. A user who has never seen
   that happen should not have it start happening because they updated.
2. Installs in the **pre-v3.32.0 split state still exist** and `getStatus()`
   reports `splitSyncRepo` for them. Automating a git operation on an install
   that is in the exact condition that caused the data loss is not a default.
3. A user with a large private repository, a metered connection, or an
   organisation policy about what leaves the machine is entitled to be asked.

The control belongs in the Sync view, on by one click, with the sentence that
matters written next to it: *this sends your changes to GitHub in the background;
it never changes anything on this computer.*

---

## 5. Automatic PULL — the part that should not

### 5.1 The four things a pull can do that nobody asked for

1. **`-X theirs` silently prefers the remote** on any genuinely conflicting hunk.
   Documented, deliberate, and correct for an attended click.
2. **Worse than that: it can splice.** `sync.md` and `working-state.md` both
   record this and the brief for this research understated it. `-X theirs` is a
   *preference inside a three-way line merge*, so where one side left a section
   untouched the other side's edit merges cleanly. The measured result was a
   single well-formed handoff carrying one machine's heading, provenance line and
   timestamp with a *different* machine's `## Firm decisions` substituted in.
   Exit 0, `Auto-merging`, clean tree, nothing flagged — the forgery checks look
   for a malformed file and a spliced one is not malformed. Reproduced in
   `scripts/test-working-state-sync.js` §2b.
3. **It auto-commits your tree first**, which is what turns git's own refusal
   (§3.3, row 2) into a silent overwrite.
4. **It `rm -rf`s stray top-level folders** (§3.4), unconditionally, whether or
   not anything was incoming.

### 5.2 Obsidian

The vault root is the wiki folder, or a parent of it. Three things follow:

- **An unsaved Obsidian buffer is invisible to git.** A file being edited but not
  yet saved leaves the tree *clean*, so even the strict fast-forward precondition
  in §3.3 does not see it. The pull replaces the file on disk; Obsidian reloads
  it or warns; if the user then saves, their buffer wins locally and goes out on
  the next push. For a wiki page that is survivable — the wiki accumulates. For
  `state/project.md`, which has **no machine segment** and is hand-authored, it is
  the documented exposure, and an automatic pull increases how often the window
  is open.
- **A folder created at the vault root is destroyed** by the next pull (§3.4).
  This is the concrete, user-visible harm.
- `.obsidian/workspace.json` is already excluded so Obsidian's pane churn does
  not make the tree dirty. The *rest* of `.obsidian/` does sync, so auto-push
  will occasionally produce a commit the user did not consciously cause. Harmless,
  worth one sentence in the docs.

### 5.3 The narrow version that would be defensible

If a later release wants automatic pull, this is the shape, and it is a real
narrowing rather than a hedge:

- **Only as a fast-forward.** Refuse unless `git status --porcelain` is empty AND
  `rev-list --count origin/main..HEAD` is 0. §3.3 proves that under those
  conditions no merge runs, so `-X theirs` cannot engage and a splice is
  unrepresentable.
- **Never auto-commit to reach that state.** A dirty tree means *skip this tick*,
  which reproduces git's own refusal instead of disarming it.
- **Do not prune.** `pruneGhostDomainDirs()` must not run in an unattended pull —
  or must be narrowed to directories the merge itself just emptied. As written it
  deletes folders the sync had nothing to do with.
- **Not while the app window is focused**, and not within N seconds of an
  observed mtime change under the vault, as a weak proxy for "someone is editing
  right now". Weak, and should be described as weak.

Even then, the user gains one click. That is the trade, stated plainly.

### 5.4 What is lost by not automating the pull, and how the widget covers it

Lost: arriving at machine B, you must click once before your agent has today's
context.

Covered by making the click unmissable rather than by removing it. Everything
needed already exists:

- `GET /api/sync/remote-status` already returns `behindFiles`, `behindCommits`,
  `files` (a 20-path preview) and `checkedAt`, already TTL-cached, already
  serialised, already honest about failure (`null`, never `0`).
- The menubar widget shows **"14 files waiting · last pushed from another machine
  3 h ago"** and a **Pull now** button. One click, in the surface the user is
  already looking at, at the moment they sit down.
- On window focus after an idle period, refresh that number. The app already
  revalidates view-scoped pollers on `focus`/`visibilitychange`.

That converts *"remember to sync"* into *"notice a number"*, which is a much
easier thing to ask of a person, and it costs no unattended write.

---

## 6. What must be built first

These are preconditions, not follow-ups. Shipping the timer without them is
shipping the timer without a guard.

### 6.1 A write check that crosses processes

`hasActiveWrites()` is per-process (§3.6). Before anything runs unattended there
must be one predicate that answers *"is anything writing to this domains folder
right now"* across the web server, the MCP child, and a second install. The
pieces exist — the per-domain `.write-lock` file, `isFileLocked()`, its
30-minute + dead-PID staleness rule — and nothing consumes them at the sync
boundary. `GET /api/write-status` has the same blind spot and would inherit the
fix.

Note the honest limit: `save_working_state` takes no lock by design, and that
design is correct for its own reasons. So the check reduces the window; it does
not close it. That is acceptable for push (§3.2 — the worst case is a commit
boundary in an odd place) and is one more reason it is not acceptable for pull.

### 6.2 A cross-process claim on the auto-sync job

§3.5 measured 10/10 `index.lock` failures for two processes sharing one git dir.
Two installs over one folder is now a *supported* configuration, so this is
reachable. The smallest thing that works: an `O_EXCL`-created owner file inside
the shared git dir carrying `{installId, pid, claimedAt}` with a TTL and
adopt-on-stale, following the same pattern v3.25.0 used for the machine-id file.
One install runs the timer; the other does not.

Auto-sync must **refuse outright** while `getStatus().splitSyncRepo` is true —
that is the pre-v3.32.0 two-histories-one-folder state, and the remedy (Disconnect,
Connect again) is already in the Sync view.

### 6.3 Persisted health state

§7. Without it there is no way to say *"this has been failing for a week"*, and
that sentence is the difference between a feature and a liability.

---

## 7. Silent failure — the thing that makes this dangerous

**An automatic sync that has been quietly failing is worse than one that never
ran, because the user believes they are backed up.** Every mechanism in §3 and §6
produces exactly this shape: an `index.lock` collision fails safely and silently;
an expired PAT fails safely and silently; a closed lid fails safely and silently.

What must be recorded, per install, in `.sync-config.json` or beside it:

| Field | Why |
|---|---|
| `lastAutoPushAt` | The number the UI shows |
| `lastAutoPushOk` | **`true` / `false` / `null`.** `null` is "we do not know" and must never paint green — the same honesty rule `behindFiles: null` already follows |
| `lastAutoPushError` | Mapped sentence only, never raw git text (§4.4) |
| `consecutiveFailures` | Drives escalation |
| `disabledReason` | Set when the job turns itself off |

Escalation, in three steps:

1. **Quiet.** A single failure is a closed lid. Retry with backoff.
2. **Visible.** After **3 consecutive failures**, or **60 minutes with pending
   changes and no successful push**, the menubar glyph and the rail badge change
   state and the Sync view carries a line: *"Automatic sync last succeeded 4
   hours ago — <mapped reason>."* Not a modal. A background feature must not
   interrupt.
3. **Stopped, loudly.** An **authentication failure disables the job** and says
   so. A 403 from an expired token will not fix itself, and retrying it every
   five minutes for a year is how a user ends up a year behind.

The place this must appear is the **menubar glyph**, because in the exact
scenario the feature exists for — an agent saving a handoff while the person is
in another window — the app's own window may not be opened for days.

---

## 8. What must NEVER happen automatically

Named explicitly, because a future session will be tempted by at least three of
these.

1. **`setup()`, in any mode, for any reason.** Connecting is the operation that
   destroyed data. Never on a timer, never as a self-repair, never as "the
   config looked stale so I reconnected".
2. **Anything carrying `confirmOverwrite`.** That flag exists so a human sees a
   file count and says yes. There is no unattended equivalent.
3. **Any pull that is not a fast-forward** — that is, any pull that runs a merge,
   which is any pull that can engage `-X theirs` (§3.3, §5.1).
4. **Auto-committing the user's tree so that a pull can proceed.** This is
   `pull()`'s existing first step, it is right for a click, and it is the
   mechanism that converts git's own refusal into a silent overwrite.
5. **`pruneGhostDomainDirs()`'s `rm -rf`** of any directory the sync did not
   itself empty (§3.4).
6. **Disconnect, credential rotation, or any write to `.sync-config.json`'s
   `repoUrl` / `token` / `gitDir`.**
7. **Any sync while a write is in flight in any process** — and today the check
   cannot see the MCP process, so §6.1 is a precondition and not a nice-to-have.
8. **Retrying an authentication failure indefinitely without telling anyone**
   (§7).
9. **Auto-sync on an install reporting `splitSyncRepo`** (§6.2).
10. **Anything in Shared Brain.** Push, pull, synthesize and revoke are a
    *different* remote with a different trust model, `synthesize` spends real LLM
    money, and `revoke` is the app's most destructive surface. Nothing in this
    document reaches them.

---

## 9. Files that would change (rough estimate)

```
NEW:
  src/brain/auto-sync.js          — the scheduler: eligibility, debounce, backoff,
                                    health state. No git of its own — calls push().
  src/brain/sync-claim.js         — cross-process owner claim (§6.2); may instead
                                    live inside write-registry.js beside the
                                    existing O_EXCL lock code

MODIFIED:
  src/brain/write-registry.js     — a cross-process "is anything writing" predicate (§6.1)
  src/brain/sync.js               — expose that predicate at the sync boundary;
                                    make pruneGhostDomainDirs() opt-in per call
  src/routes/sync.js              — guardConcurrent consults the new predicate;
                                    GET /api/sync/auto (state) + POST (enable/disable)
  src/routes/config.js            — persist autoSync settings + health fields
  src/public/next/views/sync.js   — the toggle, the interval, the health line
  desktop/                        — menubar: pending-count, "pushed N h ago",
                                    Sync now / Pull now, failure glyph
  docs/sync.md                    — a user-facing section; the ghost-prune warning
  docs/user-guide.md              — one paragraph
  docs/api-reference.md           — the new endpoints
  CLAUDE.md                       — changelog row + an Active Development Decision
```

---

## 10. Open questions for the maintainer

1. **Should auto-push also run at app launch and at quit?** Launch is obviously
   good (it catches everything written while the app was closed by the MCP).
   Quit is more interesting — `desktop/`'s busy-quit branches have never run
   against a real write, and adding a push to shutdown makes an untested path
   load-bearing.
2. **Is `pruneGhostDomainDirs()` right even for the attended pull?** Deleting a
   folder a user made in Obsidian is surprising with or without a timer. Options:
   narrow it to directories git just emptied; ask; or leave it and document it.
   This is a decision about shipped behaviour, so it does not belong in this
   roadmap — but this research is where it was found.
3. **Should the "N files waiting" number be fetched more often once auto-push
   exists?** The two facts become asymmetric: your outbound changes leave
   automatically, so the only number that still matters is inbound. Arguably the
   10-minute remote check becomes the *more* important timer, not the less.
4. **One install or all?** §6.2 proposes one install owns the job. The
   alternative — every install pushes, and they collide harmlessly — is simpler
   and produces §3.5's failures as normal operation, which §7 then has to learn
   not to escalate on. Simpler code, noisier health state.
5. **Does auto-push change the case for auto-pull?** Once every machine pushes on
   its own, "the remote is ahead" becomes the normal steady state rather than an
   event. That may make the fast-forward window in §5.3 *more* often available —
   or it may just mean the number in the widget is never zero, which would be a
   worse experience than today.

---

## RECOMMENDATION

*Plain language. This is the section to read aloud.*

**Yes to automatic sync — but only the half that sends.**

**What I recommend building.** The app should quietly send your work up to
GitHub in the background, every few minutes, without you clicking anything. I
measured what sending actually does: it does not change a single file on your
computer. Not when it works, and not when it fails. It cannot delete a page, it
cannot overwrite a handoff, it cannot undo an edit. The worst it can do is
succeed. It is also free when you have not done anything — if there is nothing
new to send, it does not even contact GitHub. So on the machine where your agent
just saved its notes, this is close to pure gain: the notes leave the machine
while you are already doing something else, which is exactly the problem you
described.

**What I recommend against.** The app should *not* automatically bring changes
*down* from GitHub in the background. Bringing changes down means rewriting files
on your computer while you are not looking, and three things about it are worse
than they sound. When two computers changed the same page, it silently keeps
GitHub's version and drops yours — and in the worst case it stitches the two
together into a document neither computer ever wrote, which looks perfectly
normal and which nothing flags. It also deletes any folder sitting in your
knowledge folder that is not a proper domain — I measured this: a folder called
`Attachments` with a file in it was erased by a pull that had nothing to do,
without warning. Today that only happens when you deliberately click Sync. On a
five-minute timer it would happen five minutes after you made the folder, with no
click to blame it on.

**What you lose, and how the widget covers it.** You lose one click. When you sit
down at your other machine, you would still have to pull. So the widget should
make that impossible to forget: **"14 files waiting — your other machine pushed 3
hours ago"**, with a **Pull now** button right there. That is the moment a pull is
safest anyway — you are present, nothing is running, nothing is half-typed. The
app can already work all of that out; nothing new has to be invented for it.

**Default: off.** It should be a switch you turn on once, in the Sync view, not
something that starts happening because you updated the app.

**The one risk to understand before you agree.** A background sync that quietly
stops working is worse than one you never had, because you will believe your work
is safe when it is not. An expired GitHub token, a dropped connection, or two
copies of The Curator both trying at once — I measured that last one, and it
fails every single time — all fail silently and safely. So the switch is only
worth turning on if the app also *tells you when it has stopped*: a changed icon
in the menubar after a few failures, a plain sentence saying when it last
succeeded, and — for an expired token, which will never fix itself — it should
stop trying and say so rather than retry quietly for a year.
