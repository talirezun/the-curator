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
// A domain's slot is RECORDED per domain (v3.76.0) — see
// `resolveIdentitySlots` at the foot of this file. It is not the domain's
// position in any list: adding or deleting a domain recolours nothing else.
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

// ── A DOMAIN'S SLOT IS ITS OWN, NOT ITS POSITION (v3.76.0) ────────────────
// Until v3.76.0 the slot was the domain's POSITION in `listDomains()`, so
// deleting or adding a domain recoloured every domain after it (observed
// 2026-09-25: after a delete, "Research" moved from olive to blue). Now each
// domain RECORDS its slot, once, in `domains/<slug>/.curator-identity.json`
// (src/brain/domain-identity.js). The file lives INSIDE the domain folder, so
// it travels with a rename, rides GitHub Sync to every Mac, goes to the trash
// with a delete and comes back with a restore.
//
// `resolveIdentitySlots` is the ONE rule that turns what is recorded into
// what is painted. It is pure and deterministic — the same folder names and
// the same recorded slots give the same answer on every machine:
//
//   1. Names are taken in code-unit order (`a < b`), never locale order.
//   2. A recorded, valid slot is kept — unless a name EARLIER in that order
//      already holds it (two Macs created domains at once and both picked the
//      same free slot). The earlier name keeps it; the later one is treated as
//      unrecorded.
//   3. Every unrecorded name, in order, takes the LOWEST FREE slot. With all
//      slots taken (more than IDENTITY_SLOTS domains) it takes the least-used
//      slot, lowest number first — the old wrap, without the reshuffle.
//
// A first run over an install with nothing recorded therefore gives slot 1,
// 2, 3 … in name order — exactly the colours a sorted folder listing gave
// before, so most installs see no change at all.

/** A recorded slot is usable when it is an integer 1..IDENTITY_SLOTS. */
export function isValidIdentitySlot(slot) {
  return Number.isInteger(slot) && slot >= 1 && slot <= IDENTITY_SLOTS;
}

/**
 * names: string[] (domain folder names). recorded: Map|object name -> slot
 * (anything invalid or absent is "unrecorded").
 * Returns a Map name -> slot (1-based), one entry per name.
 */
export function resolveIdentitySlots(names, recorded) {
  const get = (n) => {
    if (!recorded) return undefined;
    return recorded instanceof Map ? recorded.get(n) : recorded[n];
  };
  const order = Array.from(new Set((names || []).map(String)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map();
  const uses = new Array(IDENTITY_SLOTS + 1).fill(0);
  for (const n of order) {
    const s = get(n);
    if (isValidIdentitySlot(s) && uses[s] === 0) { out.set(n, s); uses[s] = 1; }
  }
  for (const n of order) {
    if (out.has(n)) continue;
    let pick = 1;
    for (let s = 1; s <= IDENTITY_SLOTS; s++) {
      if (uses[s] < uses[pick]) pick = s;
    }
    out.set(n, pick);
    uses[pick]++;
  }
  return out;
}

/** The slot -> the hex the widget paints; '' / null for an invalid slot. */
export function slotHex(slot, theme) {
  if (!isValidIdentitySlot(slot)) return null;
  const ramp = theme === 'light' ? IDENTITY_PALETTE.light : IDENTITY_PALETTE.dark;
  return ramp[slot - 1];
}
