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

## The unification pass (v3.54.0) — five patterns the bundle does not model

The bundle defines **tokens and component specs**. It does not say *which*
component a given job takes, how wide a column may be, or what a status row
contains — and until v3.54.0 the app answered those questions once per view.
Twenty-one button call sites disagreed about the variants, Settings had four
different block rhythms, and two sidebars listed the same domains in two
vocabularies.

The five rules below are now declared **once each, in one file each**, and each
one names the file that owns it. None of them is a token change: every value
below resolves to a bundle token or to an app-side token already recorded above.

| Pattern | Owner (the authoritative file) | Guard |
|---|---|---|
| The button taxonomy | the comment block above `.btn` in `src/public/next/shell.css` | `scripts/test-next-button-family.js` |
| The Settings block | `settingsBlock()` in `src/public/next/views/settings.js` + `.settings-job-block` in `views/settings.css` (built for one section in v3.53.0, generalised here) | `scripts/test-next-settings-sections.js` |
| The help affordance | `src/public/next/shared/text.css` (`.tx-vh-info`, `.tx-vh-panel`, `.tx-note`) + `shared/docs-links.js` | `scripts/test-next-text-system.js`, `scripts/test-docs-links.js`, contrast ratchet §11 |
| The content cap | `.main-inner` in `shell.css`, `--prose-max` in `tokens/space.css` | — (measured in the browser; see below) |
| The status row | `src/public/next/shared/age.js` | `scripts/test-sidebar-status-rows.js` |

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
      Lede, ≤ 20 visible words, with the ⓘ mark at its end
      [ ⓘ panel — sibling of the lede, hidden on first paint ]
      Body — the controls
  ────────────────── 1px --border ──────────────────
```

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
| **The lede** | the one fact that says what the block is for | **≤ 20 visible words**, capped at `66ch` |
| **`.tx-vh-panel`** (the ⓘ fold) | the argument behind it | explanations only — capped at `68ch`, ships closed |
| **`.tx-note`** | the single line that qualifies the control directly above it | **one line by contract** (`align-items: center`); a note that wraps is a `.tx-desc` that has not admitted it yet |

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
| An ⓘ panel | `68ch` | `.tx-vh-panel` |
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
| Freshness mark | a dot, four steps, `aria-hidden` | a **dashed ring** |
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

`freshnessStep(seconds)` in `views/memory.js` is a **five**-step ladder cut on
`formatAge`'s unit bands (just now / minutes / hours / days / weeks), because
that surface measures a save that can be seconds old. It is a different
question, not a second tuning of the same one.

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
