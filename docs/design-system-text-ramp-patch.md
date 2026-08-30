# Design-system patch — the dim text ramp

**Status:** applied in the app, **not yet applied to the design-system bundle.**

The app's `src/public/next/tokens/color.css` and the shipped design-system
bundle are normally byte-identical (a v3.24.2 audit confirmed six of seven token
files identical and the seventh differing only by the documented `--font-scale`).
**This change deliberately breaks that byte-identity on `color.css`, and that is
the point** — the maintainer approved a change to the SYSTEM, not an app-side
override. Applying the patch below to the bundle re-converges the two.

Until that happens, the app's `color.css` carries an in-file note saying the
three values intentionally differ, so the next auditor does not "fix" them back.

The bundle lives outside this repository, in the maintainer's own files. Its
path is deliberately not recorded here.

---

## The change

`--text` is **untouched in both themes.** At `#EDEDF4` it is already L\* 93.9 —
"more white but not full white", which is what was asked for. The complaint was
about the rungs beneath it.

Only the three dim rungs move: lighter in dark, darker in light.

```diff
--- a/tokens/color.css
+++ b/tokens/color.css
@@ :root — dark @@
   /* Text */
   --text:        #EDEDF4;
-  --text-2:      #A8A8BC;
-  --text-3:      #74748A;
-  --text-faint:  #4A4A5E;
+  --text-2:      #BDBDD1;
+  --text-3:      #8F8FA5;
+  --text-faint:  #66667A;
   --text-on-accent: #FFFFFF;
@@ [data-theme="light"] @@
   --text:       #14141F;
-  --text-2:     #55556A;
-  --text-3:     #7B7B90;
-  --text-faint: #A8A8BC;
+  --text-2:     #45455A;
+  --text-3:     #66667B;
+  --text-faint: #858599;
   --text-on-accent: #FFFFFF;
```

Nothing else in the file changes — no ink ramp entry, no border, no surface, no
brand, type-triad or status colour.

## Why

The ramp had collapsed to two usable levels. `--text-3` failed the 4.5:1 AA text
floor in both themes and `--text-faint` failed even the 3:1 non-text floor, so
the app had spent releases routing **around** the broken rungs — most visibly an
override in `shell.css` that promoted `.cur-eyebrow` from `--text-3` to
`--text-2` "rather than at source", because `tokens/base.css` is byte-frozen.
Every such rescue flattened the ramp by one more role. Fixing the rung is what
lets the rescues retire, and the eyebrow override was retired in the same change.

## Measured

WCAG 2.x relative-luminance arithmetic on the raw sRGB values, against
`--surface` (`#0C0C14` dark, `#FFFFFF` light). Helper controlled first: an
identical pair returns **1.00**, black-on-white returns **21.00**.

| token | dark before → after | light before → after |
|---|---|---|
| `--text` | 16.71 → 16.71 (unchanged) | 18.27 → 18.27 (unchanged) |
| `--text-2` | 8.34 → **10.54** | 7.26 → **9.33** |
| `--text-3` | 4.27 → **6.16** | 4.14 → **5.60** |
| `--text-faint` | 2.26 → **3.47** | 2.34 → **3.61** |

Worst case across every surface a text rule can land on (`--canvas`,
`--surface`, `--surface-raised`, `--surface-sunken`, `--surface-inset`):

| token | dark worst | light worst |
|---|---|---|
| `--text-2` | 8.09 → **10.23** | 6.56 → **8.43** |
| `--text-3` | 4.15 → **5.98** | 3.74 → **5.06** |
| `--text-faint` | 2.19 → **3.37** | 2.11 → **3.26** |

So after the change `--text`, `--text-2` and `--text-3` all clear the 4.5:1 AA
text floor on every surface in both themes, and `--text-faint` clears the 3:1
non-text floor everywhere while remaining deliberately under 4.5.

## `--text-faint` stays under the text floor on purpose

Two reasons, both load-bearing:

1. It is the rung that is **not** for running text. A four-step ramp where every
   step is a legal body-text colour has no bottom.
2. `scripts/test-next-contrast-ratchet.js` enforces "no below-floor token is
   painted as text", and its positive control has to fire on a token that
   genuinely fails. `--text-faint` is that token. If it were lifted over 4.5 the
   ratchet's control would go vacuous and would have to be re-based again.

## Lightness steps

CIE L\*, top of ramp to bottom:

* **dark** — 93.9 / 77.2 / 60.1 / 43.8, steps **16.8 / 17.1 / 16.2**. Even.
* **light** — 6.8 / 30.1 / 43.9 / 56.1, steps **23.3 / 13.8 / 12.3**. **Not
  even**, and not made even, because `--text` (`#14141F`, L\* 6.8) is frozen and
  evening the light ramp would mean moving it. Recorded rather than implied away.

## Applying it to the bundle

1. Open the bundle's `tokens/color.css`.
2. Apply the diff above verbatim — six lines changed, three per theme.
3. Re-run any bundle-side contrast check; the figures above should reproduce
   exactly from the hexes alone.
4. Then remove the "intentionally differs from the bundle" note from the app's
   `src/public/next/tokens/color.css`, so the byte-identity invariant is stated
   as holding again.
