# Where the design system lives

The Curator's visual language — colour, type, spacing, shape, motion tokens plus
component specs — is defined by a **design-system bundle that lives outside this
repository**. This file records where it comes from and how the copies relate,
so nobody has to rediscover it.

## The three copies, and which one is the master

| Copy | Role | Tracked by git? |
|---|---|---|
| The bundle in the maintainer's own storage | **MASTER.** The one that is edited. | No — outside this repo |
| `the_curator_design_system/` at the repo root | **READ-ONLY MIRROR.** So agents and contributors can read the system without a personal filesystem path appearing in a committed file. | No — gitignored |
| `src/public/next/tokens/*.css` | **The app's own tokens.** Copied from the bundle; this is what actually ships. | Yes |

**There is exactly one master, and it is not in this repo.** The mirror is a
convenience for reading. Editing the mirror changes nothing that ships and will
be silently lost the next time it is refreshed.

## Refreshing the mirror

Copy the bundle over the top of `the_curator_design_system/`. It is gitignored,
so nothing about the refresh reaches the public repository.

Because the mirror is untracked, **git cannot tell you when it has gone stale.**
If a token value in the mirror disagrees with `src/public/next/tokens/`, check
the master before assuming either is wrong.

> **Reading the mirror from a git worktree.** It is untracked, so it does not
> exist inside `.claude/worktrees/*`. An agent working in a worktree must read it
> from the primary checkout.

## Known, deliberate divergence

**Every token file that differs from the bundle is listed below.** A `diff -rq`
of `the_curator_design_system/tokens` against `src/public/next/tokens` is the
check; if it reports a file this section does not name, either the divergence is
undocumented or the mirror is stale.

| Token file | Differs? | Why |
|---|---|---|
| `color.css` | **Yes** | The text ramp — below |
| `typography.css` | **Yes** | `--font-scale` — below |
| `motion.css` | **Yes** | The press vocabulary — below |
| `fonts-local.css` | App-side only | No bundle counterpart |
| everything else | No | Byte-identical |

### The text ramp (v3.25.0)

As of **v3.25.0** the app's `tokens/color.css` **intentionally differs** from the
bundle on three token names — `--text-2`, `--text-3` and `--text-faint`, i.e. six
literals, one per theme. The ramp had
collapsed to two usable levels because rung 3 failed the contrast floor in both
themes and was being routed around app-side rather than fixed at source.

- The exact diff to apply to the bundle is **[design-system-text-ramp-patch.md](design-system-text-ramp-patch.md)**.
- `src/public/next/tokens/color.css` carries an in-file note saying the same
  thing, so an auditor comparing the two does not "correct" the app back to the
  old values.

**Until that patch is applied to the master, the master describes an older
version of the system than the app implements.** That is the expected state, not
a defect — but it should not be left indefinitely.

### `typography.css` — `--font-scale` (structural, not one added line)

The app adds a user-facing font-size setting the bundle does not model. It is
**not** a single new token: all thirteen size declarations are rewritten to
`calc(<bundle value> * var(--font-scale))`, so a byte-diff against the bundle
looks far larger than "one token added". That whole diff is this one feature.

### `motion.css` — the press vocabulary (v3.27.0)

The bundle has no counterpart for any of these; they were added when the app
adopted a real press state. `--press-shift`, `--press-scale`, `--press-scale-icon`,
`--t-press`, and `@keyframes curator-panel-in` (a consolidation that **deleted**
two byte-equivalent keyframes rather than becoming a third). The file also carries
an in-file refusal block explaining why there is no `--t-select` — a proposed
token that turned out byte-identical to the existing `--t-state`. Leave the
refusal in place; it is the record of a decision, not dead prose.

## Things the app deliberately does not take from the bundle

Recorded so a future conformance audit does not flag them as drift:

- **The light modal scrim.** The applied prototype specifies `0.68` dark / **`0.42`**
  light. `shell.css` ships `0.68` dark / **`0.5`** light, because `0.42` measured
  **2.80** against WCAG 1.4.11's 3:1 floor while `0.5` clears it. Same species as
  the checkbox border below — a bundle-specified value that fails a floor — and,
  like it, a finding about the bundle rather than a matter of taste. (`--modal-scrim`
  is also an app-side token *name*: the bundle inlines the literal, which is how
  five stylesheets came to hold five drifting private copies of it.)
- **The checkbox's unchecked border.** The bundle specifies `--border-strong`,
  which measures **1.59:1 dark / 1.64:1 light** against WCAG 1.4.11's 3:1 floor
  for non-text — on the one boundary that carries the whole control, since the
  fill contributes nothing at 1.01/1.07. The app uses `--text-3` instead. This
  is a finding about the bundle, not a deviation for taste.

  > **The `--text-3` figure originally recorded here — 4.27/4.14 — was already
  > stale when it was written.** Those are the *pre*-ramp values, measured before
  > v3.25.0 moved `--text-3` in the very same release. Against `--surface-inset`,
  > the shipped token now measures **6.24 dark / 5.24 light**, derived offline
  > from the token hex values in `tokens/color.css` (controls: an identical pair
  > gives 1.00, black-on-white gives 21.00). The `--border-strong` figures above
  > are browser-composited readings and are deliberately left as measured —
  > flat-token arithmetic reproduces the dark one at 1.61 but returns 1.53 for
  > light, and a composited reading beats arithmetic where the two disagree.
  > Either way, the conclusion is unchanged: the specified border fails 3:1 and
  > the substitute clears it comfortably.

## Related

- [design-system-text-ramp-patch.md](design-system-text-ramp-patch.md) — the pending patch to the master.
- [architecture.md](architecture.md) — where the app's tokens sit in the frontend.
