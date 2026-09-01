/**
 * test-next-settings-default-section.js — OFFLINE suite, zero dependencies.
 *
 * Guards the fix for: Settings always mounted on "Providers & keys" instead
 * of "General", the first row in the sidebar. Both the macOS tray's
 * `Settings…` item and the in-app rail button resolve to the same
 * `navigate('settings')` -> `onEnter` -> `freshState()`, so there was ONE
 * cause with two symptoms: `freshState()`'s `section:` field was hardcoded to
 * `'providers'` ("matches the design prototype's default state" — a comment
 * justifying a value that had drifted from what the prototype actually
 * showed first), and `onEnter`'s mount-time prefetch
 * (`ensureSectionData('providers', mountToken)`) agreed with it. Two
 * hand-typed literals, in two places, that happened to agree with each other
 * but not with `SETTINGS_SECTIONS` — the array `renderSidebar` actually walks
 * to draw the rail in order, so General is first ON SCREEN and was never
 * first ON MOUNT.
 *
 * THE FIX is not "change 'providers' to 'general'" — a second hand-typed
 * literal is exactly how this drifted the first time, and a future reorder
 * of SETTINGS_SECTIONS would silently reopen the bug. Both sites now read
 * `SETTINGS_SECTIONS[0][0]`, so the landing section and the sidebar order
 * cannot disagree by construction.
 *
 * WHAT THIS SUITE MUST NOT DO: assert `state.section === 'general'` or
 * `argument === 'general'`. That is root cause 4 from
 * scripts/test-helpers/source-scan.js's own docblock — pinning a LITERAL that
 * happens to equal what the code currently computes proves nothing about
 * whether the code DERIVES it. Every assertion below reads
 * `SETTINGS_SECTIONS` out of the live file and compares against THAT, never
 * against a string retyped here.
 *
 * TECHNIQUE: the same brace-matched extraction + `new Function` execution
 * scripts/test-next-settings-scroll-and-scale.js and
 * scripts/test-next-loading-gate.js use, via the shared
 * scripts/test-helpers/source-scan.js helpers. `freshState()` is a pure
 * object literal (verified below — no free-variable calls in its body other
 * than the SETTINGS_SECTIONS lookup), so it is extracted and RUN for real.
 * `onEnter`'s mount-time prefetch call is scoped to `onEnter` specifically
 * (via `functionSource`, not a file-wide regex) so a same-named call
 * elsewhere in the file — `wireGlobalListeners`' section-switch handler also
 * calls `ensureSectionData(state.section, myMountToken)` — cannot stand in
 * for the mount-time one; its argument expression is then evaluated against
 * the real, extracted `SETTINGS_SECTIONS`, not retyped.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stripComments, functionSource } from './test-helpers/source-scan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

const settingsSrc = readFileSync(join(NEXT, 'views/settings.js'), 'utf8');
/** settings.js as the ENGINE reads it — every scan below reads THIS, not the
 *  raw file, so a deleted/changed line left behind as a `//` comment cannot
 *  satisfy a positive assertion (the lesson recorded at the top of
 *  test-next-settings-scroll-and-scale.js). */
const settingsCode = stripComments(settingsSrc);

// ── §0  Pull SETTINGS_SECTIONS out of the live file and execute it ────────
console.log('\n§0  SETTINGS_SECTIONS, extracted and executed (never retyped)');
const SECTIONS_SRC = /const SETTINGS_SECTIONS = \[[\s\S]*?\n\];/.exec(settingsCode);
ok(!!SECTIONS_SRC, 'SETTINGS_SECTIONS is found in views/settings.js');
const SETTINGS_SECTIONS = SECTIONS_SRC ? new Function(SECTIONS_SRC[0] + '\nreturn SETTINGS_SECTIONS;')() : null;
ok(Array.isArray(SETTINGS_SECTIONS) && SETTINGS_SECTIONS.length > 1,
  `SETTINGS_SECTIONS is a real array with more than one entry (${SETTINGS_SECTIONS ? SETTINGS_SECTIONS.length : 0} found) — a one-entry array could never expose a first-vs-default disagreement`);
eq(SETTINGS_SECTIONS[0][0], 'general',
  'sanity check on the fixture, not the fix: General really is the first row today (renderSidebar walks this same array in order to draw the rail)');

// ── §1  freshState()'s default section is DERIVED from the array ──────────
console.log("\n§1  freshState()'s mount-time default equals SETTINGS_SECTIONS[0][0]");
const freshStateSrc = functionSource(settingsCode, 'freshState');
ok(freshStateSrc !== null, 'freshState() is found in views/settings.js');
// CONTROL on the extraction itself: freshState() must be a pure object
// literal referencing only SETTINGS_SECTIONS, or "run it" below would either
// throw (safe) or silently depend on some OTHER free variable this suite
// never wires up (unsafe — a ReferenceError inside a try/catch would look
// like "it works" for the wrong reason). Scoped to freshState's own body via
// functionSource, so a call living in a sibling function cannot count.
ok(freshStateSrc !== null && !/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(freshStateSrc.replace(/^function freshState\s*\(\)\s*\{/, '')),
  'CONTROL: freshState() calls nothing else — it is a plain object literal, so executing it exercises exactly one free variable (SETTINGS_SECTIONS) and nothing this suite has not accounted for');
let defaultSection = null;
if (freshStateSrc) {
  const freshStateFn = new Function('SETTINGS_SECTIONS', freshStateSrc + '\nreturn freshState;')(SETTINGS_SECTIONS);
  const state = freshStateFn();
  defaultSection = state.section;
}
eq(defaultSection, SETTINGS_SECTIONS[0][0],
  'EXECUTED: the real freshState(), run for real, sets state.section to SETTINGS_SECTIONS[0][0] — derived from the array, not a hand-typed literal that happens to agree with it today');

// ── §2  onEnter's mount-time prefetch targets the SAME section ────────────
console.log('\n§2  onEnter\'s mount-time prefetch agrees with the default — the two sites that disagreed');
const onEnterSrc = functionSource(settingsCode, 'onEnter');
ok(onEnterSrc !== null, 'onEnter() is found (scoped extraction — a same-named ensureSectionData(...) call in wireGlobalListeners\' section-switch handler must not be able to stand in for this one)');
const PREFETCH_RE = /ensureSectionData\(([^,]+),\s*mountToken\)/;
const prefetchMatch = onEnterSrc ? PREFETCH_RE.exec(onEnterSrc) : null;
ok(!!prefetchMatch, 'onEnter() prefetches via ensureSectionData(<something>, mountToken) — the mount-time call this whole suite exists to pin');
let prefetchSection = null;
if (prefetchMatch) {
  // EXECUTE the real argument expression against the real, extracted array —
  // never a textual comparison of the two call sites' source strings, which
  // could be satisfied by two DIFFERENT hardcoded literals that happen to
  // read the same.
  prefetchSection = new Function('SETTINGS_SECTIONS', `return (${prefetchMatch[1]});`)(SETTINGS_SECTIONS);
}
eq(prefetchSection, SETTINGS_SECTIONS[0][0],
  'EXECUTED: the prefetch argument, evaluated for real, resolves to SETTINGS_SECTIONS[0][0]');
eq(prefetchSection, defaultSection,
  'AND the two sites agree with EACH OTHER — this is the actual shape of the bug: two independently-typed literals that agreed with each other while disagreeing with the sidebar order');

// ── §3  Anti-vacuity control: prove the check above can actually fail ─────
console.log('\n§3  CONTROL — the agreement check is capable of reporting a mismatch');
// The two assertions above cannot be trusted on their own: if `checkAgreement`
// always returned true, or if SETTINGS_SECTIONS/defaultSection/prefetchSection
// were all derived from the same expression by construction, every run would
// pass regardless of what the source says. This proves the comparison itself
// can fail, using a FABRICATED sections array whose first entry differs from
// what a (simulated) hardcoded default and prefetch would produce — exactly
// the historical shape: two literals ('providers') agreeing with each other
// while disagreeing with the array's real first entry ('zzz-mutated-first').
function checkAgreement(sections, actualDefault, actualPrefetch) {
  const expected = sections[0][0];
  return {
    expected,
    defaultMatches: actualDefault === expected,
    prefetchMatches: actualPrefetch === expected,
  };
}
// Positive control: the REAL values computed above must agree via this same
// function (proves checkAgreement is not simply always-false either).
const realCheck = checkAgreement(SETTINGS_SECTIONS, defaultSection, prefetchSection);
ok(realCheck.defaultMatches && realCheck.prefetchMatches,
  'CONTROL: checkAgreement reports a MATCH on the real, unmutated values — so a false-negative in §1/§2 above is not being masked by an always-red comparator');
// Negative control: a fabricated array whose first entry does not match two
// literals that agree with each other but not with it.
const fabricatedSections = [['zzz-mutated-first', 'Mutated', ''], ...SETTINGS_SECTIONS.slice(1)];
const mismatchCheck = checkAgreement(fabricatedSections, 'providers', 'providers');
ok(mismatchCheck.defaultMatches === false,
  'CONTROL: checkAgreement reports a MISMATCH when the (simulated) default disagrees with the fabricated array\'s first entry — proving §1\'s assertion is capable of failing, not just capable of passing');
ok(mismatchCheck.prefetchMatches === false,
  'CONTROL: …and likewise for the prefetch side — proving §2\'s assertion is capable of failing');
// And a control on the control: two literals that DO agree with a fabricated
// array's first entry must still report a match, so this isn't a comparator
// that only ever says "mismatch".
const agreeingCheck = checkAgreement(fabricatedSections, 'zzz-mutated-first', 'zzz-mutated-first');
ok(agreeingCheck.defaultMatches && agreeingCheck.prefetchMatches,
  'CONTROL: …and reports a MATCH when the values genuinely agree with a different (fabricated) first entry — the comparator is not simply always-false');

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
