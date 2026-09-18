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
| `typography.css` | **Yes** | `--font-scale`, and the added `--type-caption` rung — both below |
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

### `typography.css` — the caption rung (v3.49.0)

One **added** token, `--type-caption`; nothing existing moved. The bundle's
smallest labelled rung is `--type-eyebrow`, and it is **mono** by design —
`typography.css`'s own header reserves the mono face for "everything the machine
owns: paths, slugs, wiki-links, counts, versions, timestamps, eyebrow labels".

The rail's section names are none of those. They are prose a human reads, at a
size the bundle had no sans rung for, so the app adds one:

```
--type-caption: var(--weight-medium) var(--text-xs)/var(--leading-tight) var(--font-sans);
```

**11px, not 12px, and the difference is the width of the whole app's left
column.** Measured in a real browser at `deviceScaleFactor: 2` against the app's
own Largest text setting (`--font-scale: 1.18`, so the rung resolves to
12.98px), the seven captions render:

| Caption | Width |
|---|---|
| Domains | 53.27px |
| Settings | 50.84px |
| Memory | 50.02px |
| Shared | 43.36px |
| Ingest | 38.02px |
| Sync | 30.27px |
| Chat | 28.88px |

At the 12px rung "Domains" is ~58px and the rail column would have had to grow
past 72px to hold it. Note which caption is widest: **"Settings" is the longest
by character count and "Domains" is the widest by pixels.** The first draft of
this work sized the column against "Settings" and was 2.43px short. Measure; do
not count letters.

`--app-rail-w` (in `shell.css`, not a bundle token) is the column that
measurement sized: **60px → 72px in v3.49.0**, giving the caption a 60px content
box and 6.73px of slack on the widest caption at the largest text size.

### `motion.css` — the press vocabulary (v3.27.0)

The bundle has no counterpart for any of these; they were added when the app
adopted a real press state. `--press-shift`, `--press-scale`, `--press-scale-icon`,
`--t-press`, and `@keyframes curator-panel-in` (a consolidation that **deleted**
two byte-equivalent keyframes rather than becoming a third). The file also carries
an in-file refusal block explaining why there is no `--t-select` — a proposed
token that turned out byte-identical to the existing `--t-state`. Leave the
refusal in place; it is the record of a decision, not dead prose.

### Motion in the shell — the three sequences (v3.57.0)

`motion.css` names durations and curves. It does **not** name distances: every
amplitude in the shell is a px literal at the rule that uses it, with its
reason beside it. That is deliberate — 8px on a 1,100px column and 28px on a
620px drawer are the same *gesture* at different sizes, and one shared token
would be wrong for both.

**1. The view change: exit → mount → enter.** `navigate()` adds `.view-exit` to
`#view-root` and `#sidebar`, waits `--dur-instant` (80ms), and only then tears
down the outgoing view, mounts the new one and fires `.view-enter`
(`--dur-mid` / `--dur-fast`). Measured end to end at 1280×860: the outgoing
column is still on screen and still carrying its own content at 65.6ms
(opacity 0.015, translateX −5.9px); the content swaps at 83.4ms; the arrival
finishes at 265ms.

Before this, a view change had **no leaving phase at all** — the first painted
frame after a rail click was already the new view at opacity 0, because the
teardown and the mount happened in the same task as the click. What a user saw
was an arrival with nothing to arrive *from*.

Three consequences worth knowing before touching it:

- The exit fills `forwards`, because its job is to **hold** opacity 0 until the
  content is swapped. Every path that mounts therefore clears the class first,
  and the sequence is skipped outright in a hidden document, where the timer
  that clears it can be clamped to a second.
- **The mount is no longer synchronous with `navigate()`.** Code that touches
  the new view's DOM immediately after navigating must go through
  `afterViewMount(cb)`, which runs immediately when nothing is pending.
- Reduced motion is read as **the resolved value of a `--dur-*` token**, not as
  a `matchMedia` query — `motion.css` expresses reduced motion by zeroing those
  properties, so reading them is the one answer that cannot disagree with the
  stylesheet.

**2. The reader: an element inserted already carrying its end-state class never
transitions.** `shell.css` had written a slide-and-fade for `.reader-scrim` /
`.reader-panel` since the overlay shipped, gated on `.open` — and it had never
played once, because `renderReader()` put `.open` into the markup string. A CSS
transition interpolates between a computed before-state and a computed
after-state; an element that entered the DOM in its final state has no
before-state, so there is nothing to interpolate and the rule is simply its
static style.

Measured at the first animation frame after clicking a wiki row:

| | before | after |
|---|---|---|
| `.reader-scrim` opacity | **1** | **0**, then 0.128 at frame 2, 1 at +200ms |
| `.reader-panel` transform | **none** | **translateX(28px)**, then 24.4px, then 0 |

The rule is: **insert without the end-state class, read a computed value to
force a style flush, then add the class** — and on every *later* render while
the overlay is open, patch in place rather than replacing the node, because the
loading→content swap lands inside the 180ms the panel is sliding and a
replacement rebuilds it at its end state.

The panel's amplitude was re-decided once the transition actually ran:
`translateX(16px) translateY(6px)` → `translateX(28px)`. The drawer is flush to
three edges of the main column and bordered on the fourth; it moves on the one
axis it is attached to, and 16px on a 620px panel read as a fade with a wobble
rather than as something arriving.

Dismissing (Esc, the scrim, the ✕) now animates out over the same `--t-enter`;
`closeReader()` — what `navigate()` calls — stays instant, because an overlay
outliving the column underneath it is the thing that read as buggy.

**3. `.content-reveal` — the one primitive for late content.** A view emits it
on a block's **first fill only**, for content that arrives after the enter
animation has ended. Re-emitting it on every render turns a refresh into a
flash, which is the defect rather than the fix.

It reuses `@keyframes curator-panel-in` rather than declaring a near-identical
twin — motion.css retired two keyframes to close exactly that drift, and
`test-next-press-motion.js` §5 refuses duplicate bodies. It carries **no
fill-mode**, following the measured decision already recorded at `.view-enter`:
`backwards`/`both` are not needed to prevent a flash of the finished state
(t=0 *is* the from-state without one), and they add a second way for a block to
be pinned invisible by a frozen document timeline — the worse failure for
something the user is meant to read.

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

## The unification pass (v3.54.0–v3.56.0) — the patterns the bundle does not model

The bundle defines **tokens and component specs**. It does not say *which*
component a given job takes, how wide a column may be, or what a status row
contains — and until v3.54.0 the app answered those questions once per view.
Twenty-one button call sites disagreed about the variants, Settings had four
different block rhythms, and two sidebars listed the same domains in two
vocabularies.

The rules below are now declared **once each, in one file each**, and each
one names the file that owns it. Five of them landed in v3.54.0; **§6–§8 are
v3.55.0**, which finished two of the five — the block left `views/settings.js`,
and the status row's three private freshness ladders became one named scale;
**§9–§10 are v3.56.0**, and both are rules that were already being followed in
some files and nowhere written down. None of them is a token change: every value
below resolves to a bundle token or to an app-side token already recorded above.

| Pattern | Owner (the authoritative file) | Guard |
|---|---|---|
| The button taxonomy | the comment block above `.btn` in `src/public/next/shell.css` | `scripts/test-next-button-family.js` |
| The Settings block | `settingsBlock()` in `src/public/next/views/settings.js` + `.settings-job-block` in `views/settings.css` (built for one section in v3.53.0, generalised here; **lifted out to `shared/block.js` and `shell.css` in v3.55.0** — see §6 below) | `scripts/test-next-settings-sections.js`, `scripts/test-shared-block.js` |
| The help affordance | `src/public/next/shared/text.css` (`.tx-vh-info`, `.tx-vh-panel`, `.tx-note`) + `shared/docs-links.js` | `scripts/test-next-text-system.js`, `scripts/test-docs-links.js`, contrast ratchet §11 |
| The content cap | `.main-inner` in `shell.css`, `--prose-max` in `tokens/space.css` | — (measured in the browser; see below) |
| The status row | `src/public/next/shared/age.js` | `scripts/test-sidebar-status-rows.js` |
| The freshness scale (v3.55.0) | `src/public/next/shared/freshness.css` + the `--fresh-*` family in `tokens/color.css` | `scripts/test-freshness-scale.js` |
| The `[hidden]` counter-rule (v3.56.0) | each stylesheet, immediately beside the class that sets `display` | `scripts/test-next-memory-view.js` §16h |
| The reader as the detail view (v3.56.0) | `openReader` / `closeReader` / `dismissReader` in `src/public/next/app.js` | `scripts/test-next-memory-view.js` |
| The type standard (v3.56.0) | **§11 below** — the role → token table; the ramp itself is `tokens/typography.css` | `scripts/test-next-text-system.js` §10, `scripts/test-css-tokens.js` (`FROZEN_PX_CEILING`) |

### 1. The button taxonomy, and who decides the size

Four tiers in descending weight. **The tier is the button's job, never its
prominence**, and the size is a property of where the button *is*.

| Variant | Face | Means | Rule |
|---|---|---|---|
| `.btn-primary` | filled violet, all three gloss devices | **commit** — the one action that completes the step in front of the user | **At most one per card, row or panel.** A panel with two has not decided what it is asking for |
| `.btn-secondary` | `--surface-raised` on a `--control-edge` border | **act** — fetch, test, disclose, navigate, go back | **The default.** Reaching for primary instead is how a panel ends up with three |
| `.btn-ghost` | transparent, `--text-2` | **quiet** — Cancel, Dismiss, Close, Copy, Skip, Set active, Disconnect | Reversible, dismissive, or one of many on a row |
| `.btn-ai` | `--accent-tint` on `--accent-border` | **spends money** | Tinted, never filled, never glossed |
| `.btn-danger` | transparent, `--danger-text` on `--border`; tints to `--danger-tint` on hover | **destroys data** | Tinted, never filled, never glossed |
| `.btn-danger-solid` | filled `--danger-fill` | the one exception | **Only** inside a confirm dialog whose primary action *is* the deletion — the tier-1 slot used honestly |

**Neither consequence variant is glossed, and that is structural.** Gloss
asserts "this is a raised object". The two controls in the app that cost you
something must never also be the most inviting thing on screen, so the tint
**replaces** tier 1 rather than decorating it. `.btn-ai`'s seven consumers are
the seven paid actions: **Ingest**, **Start batch** (`views/ingest.js`),
**Compile to wiki** (`views/chat.js`), **Push contributions** and **Run
synthesis** (`views/shared.js`), **AI maintenance** (`views/domains.js`) and
**Verify AI connection · $0.0001** (`views/settings.js`). The price stays on the
label, never in a fold.

**Size is set by the container, not the author.**

| Where the button stands | Height | Class |
|---|---|---|
| Directly in a section body | `--control-md` (32px) | `.btn` default |
| Inside a card, a row, a notice, a table or a confirm strip | `--control-sm` (28px) | `.btn-xs` |

That is a fact about the button's position, so it is never a judgement call at
the call site. `views/settings.js` encodes the tier-1 test in one expression —
`hasKeyField ? 'secondary' : 'primary'` on the key Save button: pasting your
*first* key is the step; replacing a key you already have is not.

> Two rules that were previously enforced by a scoped repaint of another
> variant are now the variant itself: `views/chat.css`'s hand-built
> `.chat-bulk-delete` and `views/shared.css`'s `.sb-revoke-go .btn-danger`
> override are both **gone**, replaced by `btn btn-danger btn-xs` and
> `btn btn-danger-solid`. The *judgements* survive; the mechanisms do not.

### 2. The Settings block, and its measured rhythm

Every section of Settings is now a stack of `settingsBlock(num, id, title,
lede, body, info, notice?, infoOpts?)` calls. One block is:

```
  [ notice — never folded, above the heading ]
  ①  Bold title
      Lede — OPTIONAL, ≤ 13 visible words, with the ⓘ mark at its end
      [ ⓘ panel — sibling of the lede, hidden on first paint ]
      Body — the controls
  ────────────────── 1px --border ──────────────────
```

**Nothing else goes in that gap.** A lede is optional (nine view headers carry
none), and the two slots above are the whole of what may sit between the
heading and the body: a loose `<p>` there is the shape §3 removes.
`scripts/test-next-settings-sections.js` G3b measures the RENDERED gap for each
block — a `<p>` in the body is legitimate, one in the gap is not, and only the
output can tell them apart.

**The rhythm is 24 | hairline | 24**, and it is one rule rather than four
declarations:

```css
.settings-job-block            { padding-top: var(--space-12); border-top: 1px solid var(--border); }
.settings-job-block + .settings-job-block { margin-top: var(--space-12); }
```

`--space-12` is **24px**, one step above the **16px** `.cur-group + .cur-group`
gives two groups *inside* one block, so a block break reads as larger than a
group break rather than the same size. The margin is on the adjacent sibling
only, so the first block keeps its own top padding and the page does not open
with a gap. This is the same two-sided rhythm `.dm-section + .dm-section` gives
Domains (v3.50.0).

**What it replaced, measured on the page before v3.53.0:** 16px of padding plus
a 1px rule = **17px** between blocks, against **14px** of gap *inside* a block —
so a block break read as very slightly larger than a paragraph break. The
maintainer's verdict on that page was "a sea of information".

**Two releases, and the split matters when reading the history.** v3.53.0 built
`settingsBlock` and this rhythm for **Providers & keys alone**: five call sites,
all numbered ①–④, and no `null` arm. What v3.54.0 adds is the *generalisation* —
the `num == null` branch with `.settings-block-unnumbered`, the `infoOpts`
parameter, and eight further call sites covering General (4), MCP bridge (2),
Health & scan limits (1) and Knowledge base (1). Before it, four of the five
sections had no block structure at all and spaced themselves by hand, including
one `style="margin-top:22px"` on MCP bridge that this change deletes rather than
converts to a token.

**A numeral is an argument, not decoration.** `settingsBlock(null, …)` renders
no `.settings-block-num` **and** adds `.settings-block-unnumbered`, which zeroes
the 32px indent that exists only to clear a numeral.

| Section | Blocks | Numbered? |
|---|---|---|
| **General** | Software update · Appearance · System check · Setup guide | No — none of them is step 1 of anything |
| **Providers & keys** | ① Connect a provider · ② What builds your wiki · ③ Chat · ④ All models | **Yes** — the page reads top to bottom as a sequence |
| **Knowledge base** | Vault folder | No |
| **MCP bridge** | ① Connect a client · ② Default domain for MCP writes | **Yes** — ② is the answer to a question ① has to raise first |
| **Health & scan limits** | Semantic-duplicate scan limits | No |

The 32px indent is **derived, not chosen**: 20px numeral + the 12px
`.settings-block-hd` gap. A hand-picked indent drifts the moment the numeral
changes size.

### 3. The help system: lede, ⓘ, "Read more in the guide"

Three parts, and the third is the one that can rot.

**The affordance is accent-coloured everywhere.** `.tx-vh-info` was `--text-2`
at rest — the same colour as the sentence beside it — so on eleven surfaces it
read as punctuation. It now sits at `--accent-text` at rest, takes an
`--accent-tint` fill plus an `--accent-border` ring on hover and focus, and
`--accent-tint-strong` while open; the panel it opens carries a **2px
`--accent` left rule** over a faint `--accent-tint` wash. One colour, one shape,
one meaning: *violet means there is an explanation here*.

Measured in a real browser, both themes, on the three surfaces the mark sits on:

| Surface | Rest |
|---|---|
| View header, on `--canvas` | 9.55 dark / 8.84 light |
| Settings block, on `--surface` | 9.31 / 9.13 |
| Sidebar, on `--mat-sidebar` | 8.74 / 8.51 |

Every state stays above **7:1** in both themes — the tint moves the face, not
the reading. The first two figures are reproduced exactly by the token
arithmetic in `scripts/test-next-contrast-ratchet.js` §11; the third cannot be,
because `--mat-sidebar` is a blurred material and no arithmetic composites a
backdrop filter.

**Three text roles, and choosing between them:**

| Role | Use for | Rule |
|---|---|---|
| **The lede** | the one fact the reader needs *before* acting | **optional; ≤ 13 visible words**, capped at `66ch` |
| **`.tx-vh-panel`** (the ⓘ fold) | the argument behind it | explanations only — the BOX takes the column, the prose inside it wraps at `92ch`; ships closed |
| **`.tx-note`** | the single line that qualifies the control directly above it | **one line by contract** (`align-items: center`); a note that wraps is a `.tx-desc` that has not admitted it yet |

**Thirteen is measured, not chosen** (v3.58.0). v3.53.0 drew the line at twenty
and the pass that applied it everywhere then audited what had been written:
**17 shipped block ledes, median 13 visible words** — and nine view headers
carrying none at all. So thirteen is where the ledes that came out well already
sit, and twenty was a ceiling only the outliers ever felt. It was the outliers
— 18, 17, 16, 15, 14 — that each carried a second clause, and in every case that
second clause was a definition or a reassurance rather than something the reader
needed before pressing the button.

**A lede carries exactly one of three things**, and if what you have is not one
of them, it is not a lede:

| Admissible | Example |
|---|---|
| an **INSTRUCTION** — what to do, or where the control is | "Pick any model you have connected — per message, in the composer." |
| a **CONDITION** — when this applies, or what qualifies | "Any MCP client running local servers: Claude Desktop, Claude Code, Cursor." |
| a **READING** — a figure or state the reader needs before acting | "Caps what one scan may cost. Used by Health → Ask AI scans." |

**A DEFINITION never goes in a lede.** "A repository is a folder GitHub stores
for you" is true, useful, and the reader does not need it to press the button;
it goes behind the ⓘ with the mechanism and the argument. The same applies to
reassurance — "your knowledge base is never touched" answers *is this safe?*,
which is a question about the mechanism — provided it is not on the never-fold
list below.

**No loose sentence between a heading and its content.** A block may hold a
heading, at most one lede, the ⓘ fold, and its body. A paragraph that is none of
those is a second voice nobody decided to add: move it into the lede if it fits
and is admissible, into the ⓘ if it explains, into a `.tx-note` under the
control it qualifies, or cut it. The two Shared Brain surfaces were the worked
example — a 49-word `.settings-hint-text` under the off-state's title and a
54-word one under the wizard's admin step, each doing a lede's job at four times
the length. `scripts/test-next-settings-sections.js` G3b enforces the gap on the
four Settings sections, with a positive control that injects a loose paragraph
and requires the detector to catch it.

**What may never be folded**, because a warning behind a click is not a warning
(v3.16.1): warnings and banners, costs, refusals, validation errors, and the
outcome of something the user just pressed. The worked example is the menu-bar
control in `views/settings.js`: its 58-word explanation moved under the
Appearance block's ⓘ, and its `.settings-fail-note` — the three ways a new menu
bar icon can silently fail to appear — **stays visible** whenever the icon is
on.

**A control may never go inside a fold.** `shared/text.js` toggles the panel
from a delegated listener on the button, so a control inside the panel would be
reachable only after that toggle. The licence is for a link, a `<strong>` or a
`<code>`.

**Every fold ends with a link into `docs/`, and none of those links is a
string.** `src/public/next/shared/docs-links.js` holds one frozen table of
`key → { file, anchor }`; `docsUrl(key)` **throws** on an unknown key, so a typo
is a blank screen in development rather than a dead link in production.
`scripts/test-docs-links.js` reads the real markdown in `docs/` and fails if a
file is missing or an anchor no longer matches a heading in it — **so renaming a
heading that a key points at is a red suite, on the commit that renames it.**
Fourteen keys are live today, across Settings and Agent memory.

### 4. The content cap: 1200px, and cap the prose, never the cards

`.main-inner` moved **900px → 1200px** (a 1144px content box at 28px of side
padding). Reported with screenshots on a 2000px window: Ingest, Shared Brain,
Agent memory and Settings "sit in a narrow strip and look squeezed" while Chat
fills the window — because `views/chat.css` had already cancelled the cap
outright so its scope bar and composer could reach the window edges. One view
had opted out and five had not, which is what made it read as an inconsistency
rather than a decision.

**900px was a prose measure wearing a layout measure's clothes.** At 844px of
content box, a 15px/1.55 paragraph is ~95 characters — already past the 60–75
the type scale is set for. What the cap *was* doing was forbidding a second
column: Ingest's 480px field stack, Shared Brain's 560px cards and Domains'
420px tiles all had room for a neighbour and nowhere to put one.

**The house rule that replaces it: the container stops being the thing that
keeps a sentence readable.** Paragraph roles carry their own `ch` measure.

| Run | Cap | Where |
|---|---|---|
| A Settings block lede | `66ch` | `.settings-job-lede` — uncapped it ran ~163 columns at 1200px |
| An ⓘ panel’s prose | `92ch`, on the panel’s own one-column grid track — the BOX is uncapped | `.tx-vh-panel` |
| A `.tx-note` | `--prose-max` (`68ch`) | `shared/text.css` |
| A kit group-row sentence | `--prose-max` | `.cur-group-label > span` — measured **1118px, ~159 columns** at a 2000px viewport before the cap |

Cards, tables, rows and tiles are **not** capped: they take the full 1144px.
Capping `.cur-group-label` itself was refused — that column is `flex: 1` and its
job is to push the control to the trailing edge, so capping it would let the
control drift inward on a wide window. The cap is on the *sentence*.

### 5. The status row, and the day-age bands

Two sidebars list the same domains — Ingest's **DESTINATION** rows and Domains'
**KNOWLEDGE** rows — and they now carry one anatomy:

```
  name
  <key figure> · ●  🕐 <relative age>        ← line one
  Ingested · <source title>                   ← line two, omitted when there is none
```

| Part | Value | When it is unknown |
|---|---|---|
| Key figure | `3,445 pages`, locale-grouped | `page count unknown` (Ingest) / `— pages` (Domains) |
| Freshness mark | a dot, `aria-hidden`, painted on the app-wide scale in §6 below (v3.54.0 shipped it as four view-local steps) | a **dashed ring** |
| Age | `today` / `yesterday` / `3 days ago` / `2 weeks ago` / `5 months ago` | `nothing written yet` |
| Last event | `Ingested · <title>`, `Compiled · <title>`, or the neutral `Last write` | the line is omitted entirely |

**The verb comes from the log, not from the view's name.** `lastIngestKind` is
`'ingest' | 'compile' | null` on the wire; `appendLog` is called by conversation
**compile** as well as by ingest, so a hardcoded "Ingested" would be false on a
domain that is only ever compiled into. A `null` kind renders the neutral
**"Last write"** — never a guessed verb.

**The vocabulary lives in `src/public/next/shared/age.js`, and there are two
clocks on purpose.**

| Function | Resolution | Why it is separate |
|---|---|---|
| `formatAge(seconds)` | second | The ladder Agent memory and the menubar tray already speak. **Byte-identical** to the bodies in `views/memory.js` and `desktop/lib/tray-model.js`; the three are extracted from source and compared byte for byte by `scripts/test-sidebar-status-rows.js` |
| `formatDayAge(dateStr)` | calendar day, local time | `lastIngestDate` is a `YYYY-MM-DD` heading with **no time of day**, and `log.md`'s mtime is rewritten by Personal Sync on every pull. Feeding a fabricated midnight into `formatAge` would print "7 hr ago" for a write that happened at any hour of today |

**The mark and the word are cut on the same bands.** `dayFreshnessStep` reads
its boundaries off `formatDayAge`'s own ladder, so a dot can never say *today*
while the words beside it say *1 week ago*:

| Step | Age | Ladder arm |
|---|---|---|
| 3 | `today` | `days < 1` |
| 2 | `yesterday`, `N days ago` | `days < 7` |
| 1 | `N weeks ago` | `days < 35` |
| 0 | a month or more, **and a date in the future** | everything past it |
| `null` | unknown | — |

Three rules carried over from v3.34.0 and applied here: **one age source**,
**never rounded younger** (a future date reads `dated ahead` and takes step 0,
never "today"), and **unknown rendered as unknown**. The absolute date is not
discarded — it travels in the row's accessible name through
`.visually-hidden`, never a `title=`, which is hover-only and therefore
invisible to keyboard and touch.

`freshnessStep(seconds)` is a **five**-step ladder cut on `formatAge`'s unit
bands (just now / minutes / hours / days / weeks), because Agent memory measures
a save that can be seconds old. It is a different *resolution*, not a second
tuning of the same scale — and as of v3.55.0 it lives in `shared/age.js` beside
`formatAge`, with both halves relabelled onto one named scale (§6 below).

### 6. The freshness scale (v3.55.0) — one ladder, six named tiers

v3.54.0 gave the two sidebars one *anatomy* (§5) and left them with two
byte-identical-modulo-prefix *ladders*, and a third in Agent memory. All three
painted the **brand violet**, which in this app means identity and primary
action — so "saved a week ago" was drawn in the same ink as the Ingest button —
and none of them agreed with the menu bar tray a user sees in the same glance.

What replaced them is one scale, owned outright by
**`src/public/next/shared/freshness.css`**. That file owns the `fresh-` prefix
the way `shared/text.css` owns `tx-`: `scripts/test-freshness-scale.js` fails any
other stylesheet that declares a `.fresh-` rule.

| Tier | Band | Ink | The word beside it | Face |
|---|---|---|---|---|
| `.fresh-live` | < 1 min | `--fresh-hot` | `just now` | filled, plus a `--fresh-hot-halo` ring |
| `.fresh-recent` | < 1 hr | `--fresh-hot` | `N min ago` | filled |
| `.fresh-today` | < 24 hr | `--fresh-mid` | `N hr ago` / `today` | filled |
| `.fresh-week` | < 7 days | `--fresh-cold` | `N days ago` | filled |
| `.fresh-dormant` | ≥ 7 days | `--fresh-cold` | `N weeks ago` and older | **hollow** (`inset` ring) |
| `.fresh-unknown` | no age at all | `--text-faint` | `nothing written yet` | **dashed** ring |

The tokens resolve to `--teal-500/600`, `--summary-500/600` and
`--ink-200/400` — the tray's own teal / amber / neutral semantics
(`desktop/lib/menu-dots.js`), reached without either side importing the other.

**They are a separate family from `--success` / `--attention`, deliberately.**
`--attention` means *a human has to act*; "saved today" is not a call to action
and a dormant domain is a finished one, not a failed one. Painting either with
the status ramp would make every quiet row read as a task.

**Measured contrast** — WCAG arithmetic over the token values, the method in
`scripts/test-next-contrast-ratchet.js` (helper validated by controls: 1.00 on an
identical pair, 21.00 black on white), and a browser pass over a static harness
agreeing to the hundredth:

| Token | on `--surface` dark / light | on `--surface-raised` dark / light |
|---|---|---|
| `--fresh-hot` | 7.74 / 4.05 | 7.51 / 4.05 |
| `--fresh-mid` | 8.78 / 3.58 | 8.52 / 3.58 |
| `--fresh-cold` | 8.34 / 5.84 | 8.09 / 5.84 |
| `--text-faint` (the unknown ring) | 3.47 / 3.61 | 3.37 / 3.61 |

**The floor is 3:1, and that is the correct floor**: every one of these paints a
graphic — an 8px dot, a 12px pip — under WCAG 1.4.11, never a word. The age in
words beside the mark stays on a text token, and the test fails any `color:`
declaration naming a `--fresh-*`. Every mark is `aria-hidden`; colour is never
the only carrier.

> **Reported rather than fixed:** on a *selected* sidebar row, which paints
> `rgba(255,255,255,0.10)` over `--surface`, the dashed `unknown` ring measures
> **2.74** in the dark theme — under the floor. `--text-faint` is the ring all
> three retired ladders already used, `tokens/color.css` names it as the rung
> that deliberately sits below the text floor, and the mark is redundant with
> the words *"nothing written yet"* printed beside it. Moving it to `--text-3`
> (4.85 on that backdrop) is a one-token change and is the maintainer's call.
> The guard grades `--surface` and `--surface-raised` only, and says so.

**Three rules the scale is built on, each one load-bearing:**

- **Cut on `formatAge`'s own bands, never a second threshold table.**
  `freshnessTier` / `dayFreshnessTier` in `shared/age.js` read their boundaries
  off the word ladders, so the mark and the phrase beside it change at the same
  instant and can never contradict each other.
- **An unknown age is not age zero.** It is the one state that differs in
  **kind** — a dashed border — rather than further along the ramp.
- **The pre-attentive cut is at one hour**, which is why `live` and `recent`
  share an ink while `today` takes a different hue: *5 minutes ago* and *4 hours
  ago* have to differ before you read them.

**Two tiers currently have no `.fresh-dot` consumer**, and that is stated in the
file rather than hidden. Both sidebars read a `YYYY-MM-DD` heading with no time
of day, so `dayFreshnessTier` enters the scale at `today`. The rules exist
because `freshnessTier` — the second-resolution half, which the Agent-memory pip
is cut on — *can* return them, and a tier the scale names with no rule behind it
is an invisible mark on the first second-resolution consumer. The guard asserts
the set of rules in the stylesheet **equals** the set of tiers those two
functions can return, in both directions.

**The shape is not shared, only the scale.** A domain's row wears a round 8px
`.fresh-dot`; an Agent-memory work-stream wears a 12px square pip with a 2px
radius, whose geometry stays in `views/memory.css`. The tier modifiers set ink
and fill and touch no geometry, so any future mark can wear them.

**No transition, no animation.** Every `/next` view re-renders by replacing
`innerHTML`, so a class-keyed transition on a mark could never run — it would be
a declaration that reads as behaviour and is dead on arrival (the shape v3.27.0
found in `progress-ring.js`). The `live` halo is a static `box-shadow` for the
same reason: a pulse would be the one thing on the screen that moves, and it
would move forever.

### 7. The block, lifted out of Settings (v3.55.0)

§2's block is now `renderBlock(o)` in
**`src/public/next/shared/block.js`**, and its CSS moved from `views/settings.css`
to **`shell.css`**, beside `.cur-group`. The values are unchanged; what changed
is who can use it.

**Why it had to move.** It was a `function settingsBlock(...)` inside a view
module with **zero exports**, so any other view wanting the same rhythm had
exactly one route: copy it. `views/domains.js` had already taken that route for
the ⓘ half, and the Agent-memory rebuild would have made a third. The CSS had to
move for a second reason: `index.html` links `views/settings.css` **last** of the
view sheets, so a rule another view depended on would sit at a different point in
the cascade than its own.

The ⓘ half is now `renderInfoMark(id, label, info, opts)` in `shared/text.js`,
returning the mark and the panel as **two fragments** rather than one string —
the mark is inline and the panel is a block, so the caller places each where its
own layout wants it. `shared/text.js` already owned the *mechanism*
(`data-tx-info`, the one delegated listener); what it lacked was a way to ask for
the affordance outside a view header.

Two things are deliberately **not** done in this pass, and both are recorded at
the code:

- **The class names still say `settings-`.** `settings-job-block`,
  `settings-block-hd`, `settings-block-num`, `settings-job-title`,
  `settings-job-lede`, `settings-block-info`, `settings-block-body`,
  `settings-block-unnumbered`. They are pinned **by name** in four shipped
  suites. Renaming is a later pass, on its own, with the pins moved in the same
  commit.
- **`views/settings.js` keeps its own copy** of `settingsBlock` and `infoMark`,
  because four shipped suites lift them out of that file by brace-matching and
  **execute** them. `scripts/test-shared-block.js` proves the two
  implementations emit the same **bytes** over a fixture matrix, which is the
  property that matters while both are live.

`renderBlock` **throws** on a missing `id` or `title` rather than rendering
something nearly right: `id` is the block's own class *and* the stem of the ⓘ
panel's DOM id, so without it every block on the screen shares a class and the
second folded block silently steals the first one's panel. The `num` test is
`!= null`, never falsy — a numbering scheme that quietly loses its `0` is the
kind of thing nobody finds twice.

**`panelWide` — the opt-in that became the default.** `renderViewHeader` used to
cap its ⓘ panel's BOX at `68ch`. v3.55.0 added `panelWide: true` as the one
escape, for Agent memory, a dashboard whose sections all run the column's width
and where a help panel stopping at 47% of it was the most visible remnant of the
four-widths page v3.54.0 started removing. The same complaint then arrived for
the block-level marks — Domains' **PROJECTS** ⓘ measured **556.8px in a 959px
column** at 1370 and in a 1144px column at 2000 — which made the cap wrong in
general rather than wrong for one page: §4's house rule is *cap the prose, never
the cards*, and a panel with a border, a leading rule, a wash and its own
padding is a card. So `.tx-vh-panel` is `max-width: none` for everyone, and the
measure moved INSIDE it: the panel is a one-column grid on `minmax(0, 92ch)`, so
every child — and every bare text node, which CSS wraps in an anonymous grid
item — keeps a readable line while the card takes the column. A grid rather than
a capped wrapper because `renderInfoMark` emits its escaped prose as a bare text
node whose exact bytes are pinned in several places. `.tx-vh-panel-wide` survives
as a no-op, still declared **after** `.tx-vh-panel`, because memory.js still
passes the option and `scripts/test-next-memory-view.js` §18h asserts both; the
`=== true` test stays with it. `display: grid` is only safe here because
`.tx-vh-panel[hidden] { display: none }` is (0,2,0) and beats it — v3.56.0's
`.mem-note` defect is that same cascade, unguarded.

### 8. The Ingest column: controls take the container, notices keep a measure (v3.55.0)

§4's house rule — *cap the prose, never the cards* — needed one more turn inside
Ingest, where **five** separate rules carried `max-width: 480px`. They are one
token now, `--ing-col: 560px`, and the number is derived rather than chosen:
`(1144 − 32 gap) / 2 = 556`, rounded up, so a notice sitting **outside** the grid
lines up with one sitting **inside** it.

**What the token binds changed, and that is the point.** It binds **notices**
only — `.ing-status-block`, `.ing-duplicate`, `.ing-progress`,
`.ing-queue-overwrite-row`: blocks whose content is words, which a 1144px line
does not help anyone read. **Controls take their container**: the domain listbox,
the drop zone and the action row are the thing you came to use.

```
.ing-confirm-grid {
  grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr));
  gap: var(--space-8);
  align-items: start;
}
```

`auto-fit` + `minmax`, **not a viewport media query**: the thing that has to fit
is the main column — the viewport minus a 72px rail, a 272px sidebar, 56px of
padding and a scrollbar — so a viewport breakpoint would be a guess at a number
the grid can measure exactly. Two tracks appear when the column can hold
`2 × 420 + 32`; below that it is one, and `min(420px, 100%)` makes a narrow
column shrink instead of overflow. `align-items: start` so the shorter column
does not stretch its card to the height of the file list. The columns come out
equal, where the brief asked for 420/360 — equal is what `auto-fit` gives, and
the column carrying the money earns the width.

**The split is by ROLE.** Left is what you are about to spend on (destination,
drop zone, file lists); right is the decision (cost, notes, budget cap, overwrite
switch, actions). One `renderConfirmGrid(leftHtml, rightHtml)` serves the batch
gate **and** the single-file form, so the two cannot drift into two layouts.

**An empty second cell is a hole, not a held track.** The previous note in the
stylesheet defended the empty `<div>` on the grounds that it stops `auto-fit`
collapsing the track, so the form "does not change width when a result arrives".
Measured on the shipped build in the **common** state — no file chosen, no result
— the form was **477px** wide at a 1370px window and **564px** at 2000px, with
477 and 564px of *nothing* beside it, on the screen a user meets first. That
trade is refused: a blank right side now emits **one** cell and `auto-fit` hands
it the whole column (measured **970px** at 1370, **1144px** at 2000). The form
does narrow when a ring or a result opens the second column — accepted and
stated, because that is a state change with the most legible cause an app has.

The test is `.trim()`, not truthiness: every caller builds the right side by
concatenating self-suppressing renderers, and a stray newline between two empty
strings is still nothing to show. `.ing-confirm-grid-single` carries **no rule of
its own** — `auto-fit` already does the work — and exists so the state is
nameable in the DOM for a guard and for any future rule that is not
`:only-child`.

**The cost card is the help pattern's exact case.** `basis` is 140–226 words
rendered as the readout's provenance line — `--text-2xs` monospace, about sixteen
lines of it, directly under the one figure on the screen a user is deciding on.
So the server now sends a second string, `basisLede`, at most 20 visible words,
and the gate renders **`basisLede` as the visible provenance** with `basis`
behind an ⓘ. **What does not fold is the caveat**: v3.16.1's rule puts costs,
spend figures and irreversibility outside every panel, so `basisLede` always
carries *"Actual spend can land above the range"*, and the estimator's own
warnings stay where they were — `renderStatus`, unfolded, above the Start button.
With no lede on the wire the **full** basis goes back into the provenance line:
a long sentence is worse than a short one, and both beat a spending screen that
says nothing about its own accuracy.

### 9. The `[hidden]` counter-rule (v3.56.0)

**An author rule that sets `display` defeats `hidden`, and nothing warns you.**
`[hidden] { display: none }` lives in the **user-agent** stylesheet. Author rules
beat UA rules at every specificity, so the moment a class on that element
declares `display`, the attribute stops doing anything — the element is visible
in every state it will ever have, and every markup assertion about it stays
green, because the markup was never wrong.

That is not a hypothetical. The standing brief's "Too long to save" wall was
emitted `hidden` below the 32,768-byte cap and toggled by the input handler
without a render, both asserted; and it was on screen over an 8,484-byte draft
with **Save** enabled, because `.mem-note { display: flex }` was winning.

**The rule.** Any element toggled by the `hidden` attribute whose class sets
`display` needs its own `[hidden]` rule in the same stylesheet, next to the class
it defends against:

```css
.mem-note[hidden] { display: none; }
```

`.mem-note[hidden]` is **(0,2,0)** against `.mem-note`'s (0,1,0) — a class plus an
attribute against a class — so it wins on specificity alone. **No `!important`**,
and the visible state is untouched. Where the element takes more than one class
(`.mem-note.mem-note-loud`), check the arithmetic against each: two separate
class rules are (0,1,0) each, so one attribute rule still covers both; a
*compound* selector would not be covered by it.

Four rules in the tree carry this today, and it is worth knowing that they split
in two:

| Rule | Status |
|---|---|
| `.mem-note[hidden]` (`views/memory.css`) | **Live.** `.mem-note` sets `display: flex` |
| `.reader-source-bar[hidden]` (`views/domains.css`) | **Live.** `.reader-source-bar` sets `display: flex` |
| `.chat-cost-panel[hidden]` (`views/chat.css`) | **Prophylactic.** The class sets no `display`; the rule is declared *before* it so a future one cannot win by source order |
| `.tx-vh-panel[hidden]` (`shared/text.css`) | **Prophylactic**, same shape |

The two prophylactic ones are the pattern working as intended: `views/chat.css`
wrote its rule and the reason for it in v3.23.0, and `views/memory.css` simply
never carried one. **Declare it whether or not the class sets `display` today** —
it costs one line, and the failure it prevents is silent, permanent and
indistinguishable from a markup bug.

**Guard it by resolving the cascade, not by reading either layer.** §16h of
`scripts/test-next-memory-view.js` takes the wall's real class list off the
*rendered markup* rather than a retyped literal, and asks what `display`
resolves to — so a `display` added later to either class reds the suite instead
of reopening the defect. A test asserting `hidden` is in the markup passed
throughout, and proved nothing.

### 10. The reader is the detail view (v3.56.0)

**A list on the page, and a press opens one item in the right-hand overlay.**
The wiki settled this years ago: `views/domains.js` lists pages and opens one in
the shell's reader, and has opened *memory* rows the same way since v3.50.0.
v3.56.0 made it the rule rather than one view's habit — Agent memory's work-stream
table is now an index, and its handoff document, which had been a full-width block
on the page, opens in the same overlay.

**Why it is a rule and not a preference.** A dashboard answers *where do things
stand*; a document is a different act, and fifteen hundred words of one
work-stream sitting underneath the summary of all of them turns a page you scan
into a page you scroll. The overlay also keeps the rail and the sidebar live
behind it, which is the correct relationship for a document you are reading
*about* something you are still looking at.

**What it costs, and what it does not.** Nothing new on the wire: the reader
*composes* a payload out of a read the view had already made. So "open in the
reader" is a rendering decision, not a fetch, and a view that already has the
data should not be adding a route to adopt this.

**The one shell change it needed** — and it is here because *a reader the keyboard
cannot get out of is not an alternative to a document on the page*. The payload
takes an optional **`returnFocusTo`**, an element id, and the three **user**
dismiss paths (Esc, the scrim, the ✕) go through `dismissReader`, which reads the
id before `closeReader` clears the state and focuses it after. `closeReader` is
untouched, so `navigate()` still does **not** pull focus into a pane it is about
to replace, and a payload without the field behaves exactly as every payload did
before. Pass an **id**, never a node: every render on these screens replaces the
pane by `innerHTML` while the reader is up, so a captured node is a node the
document no longer contains.

Two omissions in the memory payload are themselves the pattern:

- **No `domain` field.** That field switches on the reader's raw-source bar,
  which asks `GET /api/wiki/:domain/source` about a wiki page. A handoff is not a
  wiki page and has no ingested source, so supplying it would buy a request that
  can only answer "no". `views/domains.js` omits it on the same kind of row.
- **No backlinks.** Nothing links to a handoff, so the payload's `backlinks` is `[]`.

**Known gap, recorded rather than claimed away:** `renderReader` draws its
**BACKLINKS** heading and its "no other page links here yet" note
*unconditionally*, so a handoff shows `BACKLINKS · 0` — reader furniture
answering a question this kind of page does not have. The raw-source bar is
correctly suppressed (it is gated on `p.domain`); the backlinks block has no
equivalent gate. A payload-level opt-out is the fix, and it is not built.

**An absent document is said, never rendered as an empty one.** A pair can be
listed and its `current.md` still unreadable here; a blank panel reads as *"this
handoff is empty"*, which is a different claim from *"there is nothing to read"*.

### 11. The type standard: one size per role (v3.56.0)

The bundle ships a **size ramp** and a set of **composed roles**
(`--type-h1 … --type-eyebrow`). It does not say which of them a *block title*,
a *sidebar row name* or a *readout figure* takes — so, as with the buttons in
§1, the app answered that question once per view. The maintainer's report, from
his own production screenshots: *"some titles are much bigger than they should
be — we need a standard, the size of fonts set per role."*

Measured before anything moved, in a real browser over all seven views and
their sidebars at 1400 px, dark theme, `--font-scale: 1`, with
`getComputedStyle` on live elements: **five roles were rendering at two sizes
each, one eyebrow was rendering in the wrong FACE, and three rules had left the
ramp entirely.** The table below is the standard; the assertions in
`scripts/test-next-text-system.js` **§10** are the part of it a stylesheet edit
cannot walk away from.

| Role | Token | At scale 1 | Where |
|---|---|---|---|
| View title — the one `<h1>` on a screen | `--type-h1` | 27 / 600 sans | `.view-title`, `.reader-title` |
| Hero or overlay title — a column or modal with **no** `<h1>` | `--type-h2` | 22 / 600 sans | `.chat-empty-title`, `.mcpw-title`, `.sbw-title` |
| **Block, card and sidebar title** | `--type-h3` | 16 / 600 sans | `.settings-job-title`, `.sidebar-title`, `.sb-card-title`, `.sync-setup-title`, `.dm-health-title`, `.empty-title`, … |
| Page subtitle — the line that qualifies the `<h1>` | `--text-base` / `--weight-medium` | 14 / 500 sans | `.mem-project-name`, `.mem-project-domain`, `.mem-project-sep` |
| Sub-title — a group **inside** a block or card | `--text-md` / `--weight-semibold` | 13 / 600 sans | `.tx-status-title`, `.settings-shelf-title`, `.model-lane-title`, `.ing-change-title`, … |
| Eyebrow | `--type-eyebrow` + `--track-eyebrow`, uppercase | 11 / 500 **mono** | `.cur-eyebrow`, `.cur-group-title`, `.dm-path-eyebrow`, `.chat-scope-eyebrow` |
| Body | `--type-body` | 14 / 400 sans | `body`, `.chat-answer`, `.view-body` |
| Lede / description | `--type-body-sm` | 13 / 400 sans | `.tx-desc`, `.settings-job-lede`, `.tx-explainer-body` |
| **Readout value** — an instrument's figure | `--text-base`, mono | 14 / 500 mono | `.tx-readout-value`, declared **once**, in `shared/text.css` |
| Readout label | `--text-xs` | 11 / 500 sans | `.tx-readout-label` |
| Readout provenance | `--text-2xs` | 10 / 400 mono | `.tx-readout-prov` |
| Tile figure — a **display** readout in a dedicated group | `--text-2xl` | 22 / 600 sans | `.dm-stat-value` (the five OVERVIEW tiles) — the one deliberate exception, below |
| Sidebar row name | `--text-md` (weight steps to `--weight-medium` on the **active** row only) | 13 | `.dm-row-name`, `.mem-row-name`, `.sync-domain-name`, `.sb-conn-name`, `.ing-dest-name`, `.chat-conv-title` |
| Sidebar row meta | `--text-2xs` | 10 / 400 | `.dm-row-meta`, `.mem-row-meta`, `.chat-conv-meta`, `.ing-dest-meta`, `.sb-conn-state` |
| Micro-label — a table header or an uppercase strip label | `--text-2xs` / `--weight-medium`, uppercase | 10 / 500 | `.mem-ws-table th`, `.browse-table th`, `.mem-working-label` |
| Note / caption | `--text-xs` | 11 / 400 | `.tx-note`, `.rail-cap` (`--type-caption`) |
| Button label | `--text-md`; `--text-xs` on `.btn-xs` | 13 / 11 | `.btn` in `shell.css` |

**No rule anywhere sets a font size in px.** A px literal renders at 1×
whatever the user picks in Settings → General, silently — the whole reason the
ramp is `calc(<n>px * var(--font-scale))`. `scripts/test-css-tokens.js`'s
`FROZEN_PX_CEILING` is a **ratchet that may only ever tighten**; v3.56.0 lowered
it from `shell.css: 3, views/shared.css: 2, views/sync.css: 2` to
**`shell.css: 1`**, and the one remaining entry is not a font size at all —
`.rail-badge`'s `font: … var(--text-2xs)/15px …` sets a **line-height** matched
to the badge's own 15 px box, so the digit stays centred in a fixed-height pill
at every text scale.

#### The readout figure is one rung under the block title

`.tx-readout-value` was `--text-lg` — **exactly the block-title rung** — and it
is set in mono, whose figures are full-width by construction, so at an equal px
it reads heavier than the sans heading beside it. Two consequences were visible
in the maintainer's screenshots: in the Agent-memory Status block the reading
*"38 min ago"* rendered at the same size as the block's own heading *"Status"*
and louder than the "Working on" line that is the block's actual subject; in the
Domains Wiki-health card the figure **`0`** rendered *larger* than the card
title beside it, which was `--text-base` / 500 at the time.

Both halves were wrong and both moved: the figure dropped to **`--text-base`**
and `.dm-health-title` took the card-title rung it always belonged to. The
ceiling the standard states is `--text-lg`; the figure sits one rung under it,
still a clear step above the description (13) and the label (11) beneath it, so
**a figure is the loudest thing in its own readout and never competes with the
title of the block containing it.**

#### The one deliberate exception: the Domains OVERVIEW tiles

`.dm-stat-value` stays at **`--text-2xl` (22 / 600, sans)** rather than joining
the readout rung, and it is the only size in the table that is not shared with
another view. Those five tiles are a **display** readout: the figure *is* the
content of its own group, it sits alone under a one-word eyebrow with nothing to
compete with, and the group's whole job is to answer "how big is this domain" at
a glance. Its sans face is also left alone — the mono/sans split in
`tokens/typography.css` would argue for mono, but changing the face of the
screen's headline figures is a design change with its own proof, not a side
effect of a sizing pass.

#### The Memory "Working on" line is a reading, not a title

It carries the headline an agent wrote — arbitrary text from a file, up to
`MAX_HEADLINE_CHARS` (200) in `working-state.js`. At a title rung a long one
becomes three or four lines of bold that dwarf the block title above it and push
the Last-saved strip off the first screen, which is what the screenshots showed.
It takes the **body** rung, `--text-md` / `--weight-medium` — the same treatment
a sidebar row's *active* name gets — and is clamped to **two** lines. Two, not
one: the Status block gives it about 900 px at 1400 px, so a 200-character
headline needs roughly two of them, and a one-line clamp would ellipsise the
majority of real headlines when the point of the line is that you can read it
without opening anything.

#### One eyebrow face

`.cur-group-title` — the caption above every kit group ("OVERVIEW",
"PAGES · THE WIKI", "WIKI HEALTH") — spelt out
`var(--weight-medium) var(--text-xs)/1 var(--font-sans)`, which is
`--type-eyebrow` **byte for byte except for the family**. Measured on the
Domains screen, it rendered 11 px / 500 **sans** while "KNOWLEDGE" in the
sidebar beside it rendered 11 px / 500 **mono**: one role, two faces, on one
screen. `tokens/typography.css`'s own header reserves mono for "everything the
machine owns" and names *eyebrow labels* in that list, so the sans was the
deviation. Nothing else about the caption moved.


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
