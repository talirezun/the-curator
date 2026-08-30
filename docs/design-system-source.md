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

## Known, deliberate divergence

As of **v3.25.0** the app's `tokens/color.css` **intentionally differs** from the
bundle on three values — `--text-2`, `--text-3` and `--text-faint`. The ramp had
collapsed to two usable levels because rung 3 failed the contrast floor in both
themes and was being routed around app-side rather than fixed at source.

- The exact diff to apply to the bundle is **[design-system-text-ramp-patch.md](design-system-text-ramp-patch.md)**.
- `src/public/next/tokens/color.css` carries an in-file note saying the same
  thing, so an auditor comparing the two does not "correct" the app back to the
  old values.

**Until that patch is applied to the master, the master describes an older
version of the system than the app implements.** That is the expected state, not
a defect — but it should not be left indefinitely.

## Things the app deliberately does not take from the bundle

Recorded so a future conformance audit does not flag them as drift:

- **`--font-scale`** — the app adds a user-facing font-size setting the bundle
  does not model.
- **The checkbox's unchecked border.** The bundle specifies `--border-strong`,
  which measures **1.59:1 dark / 1.64:1 light** against WCAG 1.4.11's 3:1 floor
  for non-text — on the one boundary that carries the whole control, since the
  fill contributes nothing at 1.01/1.07. The app uses `--text-3` (4.27/4.14).
  This is a finding about the bundle, not a deviation for taste.

## Related

- [design-system-text-ramp-patch.md](design-system-text-ramp-patch.md) — the pending patch to the master.
- [architecture.md](architecture.md) — where the app's tokens sit in the frontend.
