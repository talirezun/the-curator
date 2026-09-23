// ═══════════════════════════════════════════════════════════════════════════
//  shared/identity-palette.js — THE IDENTITY PALETTE, AS DATA (v3.66.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// One domain, one colour, EVERYWHERE it is named (design rule 5). The browser
// paints the palette from `tokens/identity.css` (`--id-1` … `--id-12`); the
// macOS menubar widget cannot read CSS, so it reads THIS module through
// `src/brain/identity-palette.js`, which re-exports it. The two are pinned
// byte-for-byte, slot by slot and theme by theme, by
// scripts/test-identity-palette.js — which also RE-COMPUTES every contrast
// and CIEDE2000 floor below from these hexes, so an edit that walks a slot
// under a floor reds rather than ships.
//
// ── THE SLOT COUNT IS ONE CONSTANT ───────────────────────────────────────
// `IDENTITY_SLOTS` is read by `identityDotClass()` (shared/sidebar.js) and by
// the widget, and by nothing else. Twelve today. Setting it to 8 is a
// ONE-LINE change: domains 9+ then wrap to slot 1, and slots 1–8 carry a
// pairwise minimum of ΔE00 15.3 (dark) / 16.4 (light) instead of 12's 7.6 /
// 7.7. The CSS keeps declaring all twelve hues either way — an unused
// custom property costs nothing and paints nothing.
//
// ── HOW THE TWELVE WERE CHOSEN (DESIGN-visual-channels-v3.66.0 §1.3) ─────
//   · HARD EXCLUSIONS, ΔE00 ≥ 20 in the same theme: every freshness ink
//     (--fresh-hot / -mid / -cold), --danger, --danger-text and the two tone
//     inks (--success-text, --attention-text). Until v3.66.0 four of the six
//     slots WERE other channels' inks (slot 4 = --fresh-hot, slot 6 =
//     --fresh-cold, slot 3 dark = --fresh-mid, slot 5 = --danger-text), so a
//     domain dot and a "recent" freshness dot could be the same pixels.
//   · SOFT EXCLUSIONS, ΔE00 ≥ 10: the accent pair and the page-TYPE triad
//     (entity / concept / summary), which keep their own names and values in
//     tokens/identity.css and do NOT move with this palette.
//   · CONTRAST ≥ 3.3:1 (the 3:1 non-text floor plus margin) on every app
//     surface a dot sits on, in its theme, and ≥ 3:1 on the widget's menu
//     bands.
//   · ONE HUE PER SLOT ACROSS BOTH THEMES — lightness moves per theme, the
//     family does not, so a theme toggle never re-colours a domain.
//   · NESTED ORDER: slots 1–8 maximise the minimum pairwise distance; 9–12
//     are the honest remainder, each told from a same-family neighbour by
//     lightness (4↔10, 6↔11, 8↔12, and 1↔12 in light).
//
// ── THE MAPPING IS STABLE ────────────────────────────────────────────────
// A domain's slot is its index in the install's own `listDomains()` order,
// modulo IDENTITY_SLOTS. No colour is persisted anywhere; position N is
// position N on every screen and in the widget.
//
// PURE DATA AND PURE FUNCTIONS. No import, no DOM, no Node builtin — so a
// view, an offline suite and Electron's main process can all load it.

/** How many distinct identity colours a domain can take. THE one constant. */
export const IDENTITY_SLOTS = 12;

/** The palette itself, index 0 = slot 1. Frozen: a caller cannot recolour it. */
export const IDENTITY_PALETTE = Object.freeze({
  dark: Object.freeze([
    '#86CDFF', // 1  sky
    '#8A9513', // 2  olive
    '#EA5202', // 3  orange
    '#289DA9', // 4  cyan-teal
    '#E34CBB', // 5  magenta
    '#DB8AFE', // 6  orchid
    '#B6D431', // 7  lime
    '#4588F7', // 8  blue
    '#BC56E5', // 9  purple
    '#089AC3', // 10 ocean
    '#FB79E3', // 11 pink
    '#5FA1F3', // 12 cornflower
  ]),
  light: Object.freeze([
    '#1479B0', // 1  sky
    '#70790E', // 2  olive
    '#7A2A06', // 3  orange
    '#157079', // 4  cyan-teal
    '#BD2099', // 5  magenta
    '#63287A', // 6  orchid
    '#424E15', // 7  lime
    '#03409C', // 8  blue
    '#9F36C7', // 9  purple
    '#105E77', // 10 ocean
    '#910080', // 11 pink
    '#026FD7', // 12 cornflower
  ]),
});

/**
 * An install's domain index -> its slot, 1-based.
 * A non-finite index is slot 1 rather than NaN, and a negative one is folded
 * to its absolute value — the arithmetic `identityDotClass` has always used.
 */
export function identitySlot(index) {
  const n = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return (n % IDENTITY_SLOTS) + 1;
}

/**
 * An install's domain index -> the hex the widget paints for it.
 * `theme` is 'dark' or 'light'; anything else is treated as 'dark', the
 * app's default theme, rather than returning undefined.
 */
export function identityHex(index, theme) {
  const ramp = theme === 'light' ? IDENTITY_PALETTE.light : IDENTITY_PALETTE.dark;
  return ramp[identitySlot(index) - 1];
}
