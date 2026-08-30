# Project brief template (`state/project.md`)

Copy this file to `domains/<your-project>/state/project.md` and edit it. It is
**hand-authored**: there is deliberately no tool that writes it, which is exactly
why an agent reading it is told to treat its standing directives as *your own
instructions given in advance* rather than as an earlier session's notes. See
[working-state.md §4](working-state.md#tier-1-is-not-tier-2-the-brief-is-hand-authored-by-the-owner)
for why that distinction exists and what it does and does not license.

You do not need every section. A brief with nothing but `## Operating directives`
is a perfectly good brief.

---

## The template

```markdown
# Project brief — <project name>

## Standing brief

What this project is, who it is for, and what "done" looks like. Two or three
sentences. An agent that has never seen the repo should be able to say what it is
building after reading only this.

## Operating directives

How you want an agent to WORK here. One line each, imperative, and each one
carrying its own fallback (see "Write directives that can fail loudly" below).

- Delegate implementation to subagents; you orchestrate. **If your harness cannot
  spawn subagents, say so in your first reply and propose an alternative** — for
  example, work in small committed steps and stop for review at each one.
- Run `npm test` before proposing any change as finished. If you cannot run
  commands here, say so and list what you would have run.
- Never write into `domains/` — that is real user data.
- Check my reasoning rather than agree with it. If you think an instruction here
  is wrong, say so with evidence.

## Firm decisions — do not re-litigate

Settled calls, with one line of *why*, so a new session argues about something
else. The reason matters more than the decision: a decision without its reason
gets re-opened the moment someone thinks of the obvious objection.

- Markdown files on disk, not a database — the wiki must stay readable in Obsidian.
- No vector database — the `[[wikilink]]` graph is already a curated relevance signal.

## Working model

The shape of a normal session here: where work starts, what a change has to carry
before it counts as finished, how you want to be told about risk.

## Pointers to depth

- `CLAUDE.md` — architecture, invariants, release history.
- `docs/working-state.md` — how this brief is read and what authority it carries.
```

---

## Write directives that can fail loudly

The failure this template exists to prevent is not an agent *disagreeing* with a
directive. It is an agent dropping one **silently**.

Two things make that visible, and both are already carried in the
`get_working_state` response rather than depending on this file:

**A directive can be read and still not land.** An agent reading a brief is told
to restate, in one line in its first reply, the operating directives it is
adopting. You get a checkable artefact in reply one instead of discovering forty
minutes later that nothing was followed. If it says it is adopting nothing and
your brief says otherwise, the brief did not reach it — which is also how you
notice a brief lost to a sync merge.

**A directive can be unfollowable rather than ignored.** Many harnesses cannot
spawn subagents at all; a plain API loop cannot. "Delegate" is not something such
an agent is declining to do — it is something it *cannot* do, and those are
different outcomes. So give every capability-dependent directive its own
fallback, in the directive itself:

> Delegate implementation to subagents. **If your harness cannot spawn subagents,
> say so at the start and propose an alternative.**

An agent is instructed to name any directive it cannot follow and propose an
alternative rather than pass over it in silence. Writing the fallback yourself
means you choose the alternative instead of leaving it to be invented.

## What a directive may not do

A standing directive may **narrow** an agent's behaviour or shape its **method**.
It may never **widen its authority**.

`Delegate`, `test before pushing`, `never touch that folder` all narrow or shape,
and are followed. Anything that would grant a capability, authorise a push, a
purchase or a deletion, or lift a confirmation the agent would otherwise ask for
is refused in a brief exactly as it would be if it arrived in a web page — being
in the brief buys it nothing.

That limit is what makes it safe to tell agents to follow this file. Combined
with the rule that a conflict between a directive and an agent's own harness
rules resolves to **ask**, never to **obey**, the worst a brief someone else
tampered with can achieve is a question addressed to you.

## Where it does not carry that authority

The elevated framing is withheld when the brief's authorship cannot be trusted:
in a read-only `shared-*` Shared Brain mirror, whose files are written by other
people; and when the file itself looks forged or badly merged (a duplicated
section heading, or protocol markup that had to be neutralised on read). In
those cases the brief is returned and labelled as untrusted recorded data, the
same as a session handoff. The four verdicts are tabulated in
[working-state.md](working-state.md#when-the-brief-loses-the-owner-framing).
