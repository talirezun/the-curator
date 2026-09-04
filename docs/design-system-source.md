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
| `material.css` | App-side only | The material vocabulary — below |
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

### `material.css` — the material vocabulary (this release)

A **new file with no bundle counterpart**, linked after `color.css`,
`shape.css` and `motion.css`. It exists because the system has never had a
*material* vocabulary: no token for how a surface catches light, how an edge
separates two planes, how a control reads as pressable, or how something that
travels distance moves. Direction: **"Quiet System" — faithful AppKit at
AppKit amplitude**, plus exactly one borrowed device (below).

It is a **separate file rather than edits to `color.css` / `shape.css`**, and
that is the point of it: those two stay diffable against the bundle. `color.css`
already carries one approved deviation (the text ramp) and a second family
inside it would destroy the "byte-identical apart from one recorded block"
property this document depends on.

**It introduces no second design system.** No new violet scale, no new neutral
ramp, no new radius set, no new text-colour ramp. Two new hexes in the whole
file, each with its measurement.

**Three existing names are REDEFINED, and all three are measured defect fixes:**

| Name | Was | Now | Why |
|---|---|---|---|
| `--accent-hover` (dark) | `--violet-400` | `--violet-500` | white on `#9D80F8` is **3.05:1** — the primary button's own label dropped below AA on hover. **No violet lighter than `--violet-500` (4.53:1) clears 4.5**, so hover on dark cannot be a lightening of the fill; the specular and the lift carry it instead. |
| `--ring-focus` | `0 0 0 3px var(--accent-tint-strong)` | keyline + 0.85 halo | measured **1.26:1 dark / 1.24:1 light** — under the 3:1 floor. The one state that exists to be findable was the hardest thing on the page to find. Now 3.46 / 4.75. |
| `--danger-fill` | *(did not exist)* | `#D83B50` dark | white on `--danger` `#EF5568` is **3.40:1**. `--danger` itself is untouched — it is a border and text colour in the tinted variant, where 3.40 never applied. |

`--inset-hi` is **deliberately NOT redefined**, and that is the reusable
reading: the token is correct for the light *raised surfaces* it was authored
for and wrong only when landed on a saturated accent fill. The bug was the
**pairing**, so the fix is on the pairing — `--gloss-specular` (0.18 light /
0.22 dark, both composting to the same **1.44:1** perceived lift) supersedes it
for new work and `--inset-hi` keeps its one existing consumer.

**The one borrowed device, and the refusal that scopes it.** From the
Liquid-Glass family the app takes the **two-line material edge** — a lit inner
lip plus a dark outer separator — on chrome that floats over content (sidebar,
rail, menu, sheet) and **never on a content surface**. Both lines are always
drawn, because which one does the work *swaps by theme*: on dark the outer
separator is 1.02:1 against a near-black canvas and the lip carries the edge;
on light it inverts. **Refraction is refused on the record**: Electron 43 has
no native Liquid Glass (electron#50415 is closed unmerged), CSS can only do
`blur() saturate()` plus hand-placed gradients, and Apple has walked the
material back twice since WWDC25 — toward darker edges and brighter speculars,
which is a description of the gloss recipe rather than of refraction.

**A finding this work produced about the palette itself, recorded because it
constrains the next phase.** The light theme's type triad has almost no
headroom: `--concept-600` measures **3.22:1 against pure white**, 0.22 over the
1.4.11 floor. The domain list's type dots sit on the sidebar, so **any light
sidebar plane darker than about `#F7F7FA` pushes that dot under 3:1** — the
first attempt at a proper macOS grey sidebar (1.18:1) took it to 2.64 and
`scripts/test-next-domain-dots.js` caught it. The light sidebar's separation is
therefore carried entirely by the two-line edge, and its plane is pinned to the
darkest value the triad allows. Lifting the light triad — the greens especially
— would buy a real light plane, and that is a colour-system change with its own
diff and its own approval.

### The gloss geometry, and the hover sheen (v3.46.0)

Two reports on the same control — the dark-theme primary `Choose files` button:
a **ring drawn around the button, outside the fill** ("looks like something is
broken"), and a **hover that barely changes anything**. Both were properties of
the recipe rather than of any one value, so both fixes are recorded here.

**The ring was geometry, not colour.** `.btn` carries `border: 1px solid
transparent` (the baseline that stops a variant-less `.btn` falling through to
Chromium's bevelled UA chrome, and what keeps every variant the same size).
An absolutely positioned box's containing block is its parent's **padding**
box, and an `inset` box-shadow is likewise clipped to the padding box — so
`.btn::before { inset: 0 }` plus `box-shadow: var(--gloss-specular),
var(--gloss-shade)` on the element left the face gradient *and* both inset
devices stopping one pixel short, with `background-color` painting that 1px
frame raw. Measured by decoding painted pixels at 2× on the real button, dark,
column through its centre:

| | before | after |
|---|---|---|
| primary, top edge vs the brightest top row | **1.577:1** | **1.002:1** |
| primary, bottom edge vs the darkest bottom row | **1.647:1** | **1.000:1** |
| danger-solid, top / bottom | 1.478 / 1.653 | 1.005 / 1.000 |
| light primary, top / bottom | 1.584 / 1.225 | 1.002 / 1.000 |

**The fix moves the overlay, not the border.** Dropping the transparent border
from the filled variants also removes the ring and was refused: it makes every
primary button 2px narrower than every secondary one, which is the invariant
`.btn`'s own note records. Instead the border width is named `--btn-border-w`,
and `.btn-primary::before` / `.btn-danger-solid::before` take
`inset: calc(var(--btn-border-w) * -1)` — the border box exactly. A
pseudo-element has no border of its own, so its padding box *is* its border
box and nothing can clip its shadows short again. `--gloss-specular`,
`--gloss-shade` and `--gloss-pressed` therefore live on that overlay; the
element keeps only `--gloss-contact` / `--elev-2`, the devices drawn **outside**
the box. `border-radius: inherit` becomes correct in the same move: 7px on a
box whose radius really is 7px, rather than 7px on the 6px-radius padding box.

`.btn-secondary` is **deliberately excluded**. Its border is real and opaque
(`--control-edge`), so its padding box is exactly where its face should stop;
its "ring" measures 2.37:1 top / 3.24:1 bottom on dark, which is the edge doing
its 1.4.11 job. Growing the face over it would tint the one device carrying
that floor for the whole variant.

**The sheen — `--gloss-sheen`, the fourth device.** Hover on dark had nothing
to move: `--accent-hover` aliases `--violet-500`, which *is* `--accent` (see
the redefinition table above — no lighter violet clears 4.5 for the label), so
the whole of hover was `--gloss-specular` going 0.22 → 0.34, one CSS pixel of a
32px control. `--gloss-sheen` is a top-lit dome on a second overlay
(`::after`, the same border box), fading in over `--t-hover-in` (110 ms) and
out over `--t-hover-out` (120 ms) — the kit's existing asymmetry, no new
duration — alongside the existing `--elev-2` lift and a slightly deeper
`--gloss-shade-hi`. The press still inverts to `--gloss-pressed` at 80 ms, and
the sheen leaves on the same 80 ms, because a specular dome on a pressed
control is the one combination that reads as broken.

**Why it is a dome and not a wash, in numbers.** White on the dark fill is
**4.528:1** against a 4.5 floor, so the luminance budget before the label drops
below AA is ~0.0015 — a flat white wash at the sheen's own peak alpha would put
it at **2.93:1** dark / **3.14:1** light. The dome instead reaches alpha 0 at
**10.24px** of the 32px layer (the border box *is* `--control-md` under
`box-sizing: border-box`), while the tallest glyph of a centred 13px/500 label
starts at ~**10.7px**. Decoded from painted pixels: the last row on which hover
differs from rest is CSS y **9.5**, and across every row the glyphs occupy the
hover composite is **byte-identical** to the rest composite — hover cannot move
the label's backdrop at all. `scripts/test-next-design-kit.js` §6b recomputes
all of this from `--control-md`, `--text-md` and the gradient's own
percentages, and carries the flat-wash failure as its control.

**A pre-existing finding this measurement surfaced, not fixed here.**
`--gloss-face`'s top stop lightens the fill under the *upper* part of the
label, so the worst white-on-backdrop reading across the glyph band is
**4.355:1** on the dark primary at rest — below 4.5, and unchanged by this
work (it measures 4.355 before and after). The light primary's *hover* fill
step (`--violet-600` → `--violet-500`) lands at **4.387:1**, likewise
before and after. Both predate v3.46.0 and both are the face gradient rather
than the sheen; fixing them means either flattening the face's top stop or
moving the fill, and neither belongs in a ring fix.

### `shared/switch.css` — the switch (this release)

Also new, also with no bundle counterpart. macOS draws a two-value choice three
ways and they are not interchangeable: a **switch** turns a facility on and off,
a **checkbox** states a fact about a thing, and a **segmented control** picks one
of N peer modes. The bundle models the second and the third; this is the first.
Appearance (Light / Dark) stays segmented, because it is a mode pair and System
Settings itself draws it that way.

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
