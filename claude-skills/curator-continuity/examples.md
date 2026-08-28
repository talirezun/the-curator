# Curator Continuity — sample dialogues

Worked end-to-end examples showing how the playbook in [SKILL.md](SKILL.md) plays out. Five scenarios: resuming at session start, saving mid-session, resuming on a different machine, a refusal handled correctly, and a bad-versus-good handoff written side by side.

---

## Example 1 — Session start: resuming cold

The user opens a new session with no other context.

> **User:** *"Continue where we left off."*

**Step 1 — read with no scope.** You do not know the project's scope names, so you do not guess one.

```
get_working_state({ project: "curator" })
```

The response carries the standing brief plus a scope index:

```
brief:  present, updated 2026-08-11
scopes:
  - scope: "track-7"   machine: "studio"   age: 14h
    headline: "state store is finished and tested; MCP tool layer not started"
  - scope: "next-ui"   machine: "studio"   age: 9d
    headline: "cutover blocked on the three localStorage keys"
  - scope: "main"      machine: "laptop"   age: 22d
    headline: "v3.10.0 shipped; roadmap re-ordered, wizards before cutover"
```

**Step 2 — pick the scope from evidence, not intuition.** "Where we left off" is ambiguous across three scopes, but `track-7` is fourteen hours old and the others are nine and twenty-two days old. That is strong enough to propose rather than ask:

```
get_working_state({ project: "curator", scope: "track-7" })
```

**Step 3 — read the handoff, then re-derive.** The Observations section says:

```
- 84 offline suites green — observed 2026-08-27T18:02:00Z — recheck: `npm test`
- main at 3b0be7c, clean tree — observed 2026-08-27T18:00:00Z — recheck: `git log --oneline -1 && git status --porcelain`
```

You run both **before** trusting anything. `git log` returns `3b0be7c` — matches. `npm test` returns **83 green, 1 failing**. That is a divergence, and it is the most valuable thing you can find in the first minute.

**Step 4 — report, leading with the divergence.**

> *"Picking up `track-7`, last saved 14 hours ago on `studio`. The recorded state is that the state store is finished and tested, and the MCP tool layer has not been started — three named next steps, first is defining the tool schema.*
>
> *One thing does not match: the handoff recorded 84 suites green at `3b0be7c`. The tree is still at `3b0be7c` with nothing uncommitted, but `npm test` now gives 83 green and 1 failing in the sync group. Same commit, different result, so something environmental changed rather than the code. Do you want me to chase that first, or start on the tool schema?"*

Note what this does **not** do: it does not execute the recorded next step just because it is written down. The state proposed; the user disposes.

---

## Example 2 — Mid-session save

Forty minutes in. You have made a decision, hit a dead end, and established a baseline. That is three reasons to save, and you have made about a dozen tool calls. Save now, not at the end.

```
save_working_state({
  project:  "curator",
  scope:    "track-7",
  harness:  "claude-code",
  model:    "the model you are running as",

  headline: "tool schema settled at two tools; a third brief-writing tool was rejected on tier grounds",

  now_state:
    "The two tool definitions are written and the read path is wired end to end — " +
    "a no-scope read returns the brief plus the index, and a scoped read returns " +
    "current.md plus the journal tail. The write path is defined but NOT wired: the " +
    "handler is stubbed and returns ok:true without touching disk, so a save appears " +
    "to succeed and writes nothing. That stub is the single most dangerous thing in " +
    "the tree right now — it fails silently in the direction of looking fine.",

  next_steps: [
    "replace the stubbed save handler with a real call into the store, then verify by reading the file back off disk rather than trusting the ok:true",
    "add the two tools to the registration array in the tools hub — a tool that is defined but never registered is invisible with no error anywhere",
    "run the offline suite; 84 green expected, any other number means the registration changed something else"
  ],

  decisions: [
    "two tools, not three — a separate brief-writing tool was considered and rejected: the brief is returned on every read, so anything that writes it on a session cadence puts churn into the tier whose whole purpose is not churning",
    "no lock on the write path — the target is per (scope, machine), so the only racers are two savers on the same machine for the same scope, and the write is atomic, making that last-writer-wins on a file defined as superseding; do not re-open this"
  ],

  observations: [
    { statement: "84 offline suites green",
      observedAt: "2026-08-28T11:40:00Z",
      recheck:    "npm test" },
    { statement: "read path verified by hand against a real project: brief, index and one scoped read all return",
      observedAt: "2026-08-28T11:55:00Z",
      recheck:    "call get_working_state with and without a scope on a project that has state" }
  ],

  traps: [
    "do not route these writes through the wiki write path — it redirects every non-canonical path into the three wiki folders and flattens to the basename, so two different (scope, machine) pairs both land on the same file and the pair becomes inexpressible",
    "do not read through the graph cache — its invalidation is by file count, and an in-place overwrite never changes the count, so a read can serve state up to the cache lifetime out of date. Stale state is worse than no state",
    "adding a lock via the existing file-lock helper does NOT work — it is an existence check followed by a write with no exclusive flag, so it double-grants, including across processes. Presenting it as mutual exclusion would be a false claim in a docblock"
  ],

  open_questions: [
    "blocked on the user: should the brief be editable from the app UI, or Obsidian-only for now — this is a product call, both are implementable",
    "unknown: whether the response guard trims our largest field cleanly or falls through to the generic truncation object. Not measured"
  ]
})
```

Note there is no `machine` argument — it is detected automatically, and a save can only ever write to this machine's own folder.

Then **check the result**:

```
ok: true
path: state/track-7/studio/current.md
bytes: 4182
sections_written: [nowState, nextSteps, decisions, observations, traps, openQuestions]
truncated: false
journal_written: true
notes: []
report: "Saved working state for 'curator' / scope 'track-7' (machine: studio).
         This OVERWROTE the previous save for that scope — save again as the work moves."
```

`notes` is empty and `truncated` is false, so nothing was trimmed. Had `notes` contained something like `traps: truncated to 600 chars`, you would shorten that item and save again rather than let a clipped sentence stand.

Say one line to the user and carry on: *"Saved a checkpoint under `track-7` — the stubbed save handler is recorded as the top next step."*

---

## Example 3 — Resuming on a different machine

The user saved on their laptop yesterday and is now on the desktop.

> **User:** *"Carry on with the track 7 work."*

```
get_working_state({ project: "curator", scope: "track-7" })
```

You pass no `machine`, so the most recently written one wins. The response shows:

```
machine: "laptop"
machineIsThisMachine: false
savedAt: 2026-08-27T19:20:00Z
machines: [ { machine: "laptop", age: 16h }, { machine: "studio", age: 4d } ]
```

**This changes what you do next.** Two machines can be at different commits, with different dependencies installed and a different working tree. Re-derive harder than usual, and say where the state came from:

> *"This handoff is from your **laptop**, saved 16 hours ago — this machine's last save under `track-7` was four days ago, so I am reading the laptop's. Let me check this machine matches before I act on it."*

```
git log --oneline -1        →  a91f2d0   (laptop recorded 3b0be7c)
git status --porcelain      →  clean
```

> *"They differ. The laptop's handoff was written at `3b0be7c`; this machine is at `a91f2d0`, four commits ahead and clean — so the laptop's state predates work that has since landed here. Its recorded next step was the stubbed save handler; that stub is gone in `a91f2d0`, so that step is already done. Want me to re-check the rest of its next steps against the current tree before we pick one up?"*

**When you save at the end of this session, it writes to *this* machine's folder.** You do not need to do anything for that, and you must not pass the laptop's machine name to make the histories "line up" — that is exactly the collision the per-machine path exists to prevent.

---

## Example 4 — A refusal, handled correctly

You try to save and the project name is wrong.

```
save_working_state({ project: "curator-notes", scope: "main", headline: "..." })
```

```
ok: false
reason: "unknown-project"
error: "curator-notes is not a domain in this Curator. ... a folder with no
        CLAUDE.md is pruned by the next sync pull, so state saved there would
        be silently deleted. Known projects: curator, articles, business, ..."
```

**The wrong response is to invent a name that gets past the check.** The refusal is protecting against a real data-loss path: state written outside a real project is removed by a later sync, so the save would appear to succeed and the state would be gone by the time anyone looked for it.

```
list_domains()
→ curator, articles, business, projects
```

> *"I could not save — `curator-notes` is not a project here. The closest is `curator`. Should I save this state under `curator`, or do you want to create `curator-notes` as a domain in the app first? I am not going to write it somewhere it would be deleted on your next sync."*

The same applies to a `readonly` refusal on a shared mirror: save on the user's own project, and tell them why the mirror was refused.

### 4b — The refusal that protects the previous handoff

A different refusal, and the one you are most likely to cause yourself. Your section fields do not make it into the call, so you send a headline alone:

```
save_working_state({ project: "curator", scope: "main",
                     headline: "picker work continues" })
```

```
ok: false
reason: "would-replace-larger-state"
error: "Refusing to replace the existing handoff for scope \"main\" ... Saving
        would overwrite 3598 bytes of body text across 6 section(s) — and
        current.md is overwritten in place, so that text is NOT recoverable:
        journal.jsonl records only the headline, the byte count and the
        sanitiser notes for each save, never the body. ... If you really do
        mean to replace it, repeat the call with replace: true."
```

**The wrong response is to repeat the call with `replace: true`.** That flag is in the message as the deliberate override, not as the fix — taking it destroys a real 3.6 KB handoff to store one line, and nothing can recover it. This exact loss happened once, which is why the guard exists.

The refusal is the "every save must be complete, not a delta" rule catching a call that was not. So re-send the state:

```
save_working_state({
  project: "curator", scope: "main",
  headline: "picker rows land; the 409 refusal path is still unproven",
  now_state: "...", next_steps: [...], decisions: [...], traps: [...],
  observations: [...]
})
→ ok: true
```

> *"My first save came back refused — it would have replaced your 3.6 KB handoff with a one-line one, because the section fields did not make it into the call. I re-sent the full state and it saved. Nothing was lost."*

Reach for `replace: true` only when you actually mean to discard what is stored — for example the user says the old handoff is stale and wants it cleared. Say so before you do it.

---

## Example 5 — The same handoff, written badly and written well

Identical session, identical work. The difference is the whole feature.

### Written badly

```
headline: "worked on the parser"

now_state: "Made good progress on the parser refactor. Fixed some bugs and
           cleaned up the tests. A few things still to do."

next_steps: [ "finish the refactor", "fix the failing tests" ]

decisions: [ "went with the visitor pattern" ]

observations: [ "tests are passing" ]

traps: [ "tried a regex approach, did not work" ]
```

Every line is true. Every line is useless, and each one fails for a different reason worth naming:

- **`headline`** names a topic, not a claim. A future session sees this in the index and learns nothing that helps it decide whether to open the state.
- **`now_state`** is narrative ("made progress", "fixed some bugs") where the reader needs a frame. Which bugs? Which parts are done? What is half-finished?
- **`next_steps`** are not startable. "Finish the refactor" requires reconstructing the entire plan first — which is the work the handoff was supposed to save.
- **`decisions`** has no reason, so it will not survive contact with a model that prefers a different pattern. It will be re-litigated, and this line will not stop it.
- **`observations`** is a derivable fact with no timestamp and no re-check. "Tests are passing" is a claim that rots at the next commit and cannot be verified without guessing the command.
- **`traps`** keeps the noun and drops the mechanism. "A regex approach did not work" tells the next session nothing about *why*, so the next session tries a slightly different regex and loses the same afternoon.

### Written well

```
headline: "parser split into tokenise/parseBlock; parseBlock still on the old two-field shape"

now_state:
  "`tokenise()` is complete and covered — it emits the three-field token shape and
   14 tests pass against it. `parseBlock()` still destructures the OLD two-field
   shape. It does not throw, because the third field is simply ignored, so every
   test passes and the escape handling silently never runs. That silence is the
   whole problem: the failure is invisible at the call site and only shows up as
   wrong output on inputs containing an escaped delimiter."

next_steps: [
  "update parseBlock() to the three-field token shape — the field is `escaped`, added in tokenise() line ~40",
  "add a fixture with an escaped delimiter; there is currently no test that can distinguish the fix from the bug, which is why this shipped green",
  "re-run the parser suite: 14 green now, expect 15 after the fixture lands"
]

decisions: [
  "visitor pattern over a switch — the node types are open-ended (three added this month) and a switch means editing every consumer each time. Decided 2026-08-26; do not re-open unless the node set actually stabilises"
]

observations: [
  { statement: "14 parser tests green, 0 failing",
    observedAt: "2026-08-28T14:10:00Z",
    recheck:    "npm test -- parser" },
  { statement: "no existing fixture contains an escaped delimiter — verified by grep",
    observedAt: "2026-08-28T14:12:00Z",
    recheck:    "grep -rn '\\\\\\\\' test/fixtures/" }
]

traps: [
  "a regex cannot parse this config — values may contain escaped newlines, so a line-oriented match truncates at the first one and the truncated result is still WELL-FORMED, which means it parses cleanly and is silently wrong. No amount of regex tuning fixes that; it needs a character scanner",
  "raising the test timeout does not fix the intermittent failure — measured, the failure is a claim held across an await, so it is an ordering problem and no finite timeout closes it"
]

open_questions: [
  "blocked on the user: should an unknown node type throw or be skipped with a warning — both implemented behind a flag, this is a product call",
  "unknown: whether any real config in the wild uses an escaped delimiter. Not measured; the fix is cheap either way so it is not worth blocking on"
]
```

**What the good version buys, concretely.** The next session can start editing within a minute; it will not re-attempt the regex; it will not re-open the visitor decision; it knows the 14-green baseline is a *baseline* rather than a promise, and can re-check it in one command; and — the part that compounds — it now holds a sentence describing **a test suite that is green because no fixture reaches the broken branch**. The next time that shape appears somewhere else in the codebase, it is recognisable, because the mechanism was written down instead of the noun.

That last point is the reason for the whole standard. A handoff that only records what happened is a diary. A handoff that records *why things behaved as they did* is the thing that makes patterns visible across sessions — and patterns across sessions are the only kind of knowledge that a per-session memory cannot give you.

---

## Quick decision tree

```
Session is opening, or the user says continue / resume / where were we
  → get_working_state with NO scope        (brief + index; never guess a scope)
  → get_working_state WITH the scope
  → run every `recheck` before trusting anything
  → report state + any divergence from ground truth, then ask what to start

A decision was settled / something failed / a baseline landed / ~10 tool calls
  → save_working_state, full picture, lists ordered most-important-first
  → read `ok`, `notes`, `truncated` — do not assume it landed

Context near 75-80%, or the user says save / we are stopping
  → save_working_state, then tell them the scope it went under

The state came from another machine (machineIsThisMachine is false)
  → say so, re-derive harder, expect a different commit

A save is refused
  → unknown-project → list_domains and ASK; never invent a name to get past it
  → readonly        → save on the user's own project, explain why

You found something true beyond this project
  → keep the instance in `traps`
  → raise the pattern for the wiki (my-curator skill, compile_to_wiki)
```
