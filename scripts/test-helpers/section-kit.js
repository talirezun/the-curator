// The section kit (src/public/next/shared/section.js) for suite sandboxes.
//
// views/domains.js and views/shared.js call the kit's renderers from inside
// functions that many suites lift by brace-matching and execute inside
// `new Function` against a fixed parameter list — so a sandbox that does not
// pass them dies with a bare ReferenceError. Every such sandbox spreads these
// two arrays into its parameter and argument lists, and gets the REAL
// functions rather than stubs, so its assertions about the markup are
// assertions about the shipped component (the renderOverview precedent).

import * as SECTION from '../../src/public/next/shared/section.js';

export const SECTION_KIT_NAMES = Object.freeze([
  'renderSectionHead', 'renderSectionTitle', 'renderCard', 'renderControlRow',
  'renderFoldRows', 'renderFoldRow', 'renderFoldItem', 'renderActionCard', 'actionChip',
  'renderStatusLine',
]);

export const SECTION_KIT_VALUES = Object.freeze(SECTION_KIT_NAMES.map((n) => {
  if (typeof SECTION[n] !== 'function') throw new Error('shared/section.js no longer exports ' + n);
  return SECTION[n];
}));

/** The same pair as an object, for sandboxes that take an `inject` map. */
export const SECTION_KIT = Object.freeze(Object.fromEntries(
  SECTION_KIT_NAMES.map((n, i) => [n, SECTION_KIT_VALUES[i]])));
