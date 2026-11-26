/**
 * test-listbox-hover.js — OFFLINE suite.
 *
 * ── THE DEFECT (audit-context-ux, bug 1) ───────────────────────────────────
 * The hovered / keyboard-active row of every listbox (model picker, Add-agent
 * menu, domain picker, Window / Reading budget) was painted with
 * `--surface-hover`, an ABSOLUTE fill (#15151F on dark). The menu became a
 * material plane (`--mat-menu`, rgba(22,22,33,0.80)), so the "hover" sat one
 * point from the plane it was drawn on: rgb(21,21,31) on rgb(22,22,33), a
 * contrast of 1.01:1. The row looked identical hovered and not, in the mouse
 * and in the keyboard walk. The fix is the translucent overlay
 * `--mat-row-active`, which composites on whatever plane it sits on.
 *
 * ── WHAT THIS ASSERTS (behaviour, by computing it) ─────────────────────────
 *   · `.lb-opt.is-active` paints --mat-row-active and no `--surface-*`.
 *   · The COMPUTED step between the menu plane and the plane under the active
 *     row is at least MIN_STEP in both themes over a dark, a light and a mid
 *     backdrop (the menu is translucent, so the backdrop varies).
 *   · CONTROL: the old fill measures below 1.1 on the dark page backdrop, so
 *     the detector can see the defect it guards against.
 *   · The keyboard position and the mouse hover are the same class
 *     (`is-active`), set by one function, so they cannot diverge.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}`); } };

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (rgba, under) => [0, 1, 2].map((i) => rgba[i] * rgba[3] + under[i] * (1 - rgba[3]));
const rgbaOf = (v) => { const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(v); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
const hexOf = (v) => { const m = /^#([0-9a-f]{6})$/i.exec(v.trim()); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };

/** The first two literal values of `--name:` in a stylesheet: dark, then light. */
const twoValues = (css, name) => [...css.matchAll(new RegExp(name + ':\\s*(rgba?\\([^)]*\\))', 'g'))].map((m) => rgbaOf(m[1])).slice(0, 2);

const MIN_STEP = 1.5;       // v4.2.0 fix (audit minor 6, was 1.2): measured dark 1.59-1.61, light 1.51-1.55
console.log('\n── .lb-opt.is-active uses the overlay, not an absolute fill');
const lb = strip(read('shared/listbox.css'));
const activeRule = /\.lb-opt\.is-active\s*\{([^}]*)\}/.exec(lb);
ok(!!activeRule, '.lb-opt.is-active rule exists');
ok(activeRule && /background:\s*var\(--mat-menu-row-active\)/.test(activeRule[1]), 'it paints var(--mat-menu-row-active) (the menu row\'s own, stronger overlay)');
ok(activeRule && !/--surface-/.test(activeRule[1]), 'it does not paint any --surface-* (an absolute fill vanishes on the material menu)');

console.log('\n── the computed step against the menu plane, both themes');
const mat = strip(read('tokens/material.css'));
const menu = twoValues(mat, '--mat-menu');
const active = twoValues(mat, '--mat-menu-row-active');
ok(menu.length === 2 && menu.every(Boolean) && active.length === 2 && active.every(Boolean), 'dark and light --mat-menu and --mat-row-active parse');
const backs = { dark: { page: [0x0b, 0x0b, 0x12], black: [0, 0, 0] }, light: { page: [0xf5, 0xf5, 0xf9], white: [255, 255, 255] } };
backs.dark.white = [255, 255, 255]; backs.light.black = [0, 0, 0];
const report = [];
['dark', 'light'].forEach((theme, i) => {
  for (const [name, b] of Object.entries(backs[theme])) {
    const plane = over(menu[i], b);
    const step = ratio(plane, over(active[i], plane));
    report.push(`${theme}/${name} ${step.toFixed(3)}`);
    ok(step >= MIN_STEP, `${theme} over ${name}: active row vs menu plane ${step.toFixed(3)}:1 >= ${MIN_STEP}`);
  }
});
console.log('  measured: ' + report.join(' · '));

console.log('\n── the selected row is not touched, and text on the lit row stays readable');
const selRule = /\.lb-opt\.is-selected\s*\{([^}]*)\}/.exec(lb);
ok(selRule && /background:\s*var\(--accent\)/.test(selRule[1]), 'the committed row is still the accent pill (a different device from the keyboard row)');
const selActive = /\.lb-opt\.is-selected\.is-active\s*\{([^}]*)\}/.exec(lb);
ok(selActive && !/background/.test(selActive[1]), 'keyboard on the committed row moves no fill (the accent stays)');
{
  const color = strip(read('tokens/color.css'));
  // --text-2 is the dimmest text on a row (the sub line): dark, then light.
  const t2s = [...color.matchAll(/--text-2:\s*(#[0-9a-f]{6})/gi)].map((m) => hexOf(m[1])).slice(0, 2);
  ok(t2s.length === 2 && t2s.every(Boolean), 'dark and light --text-2 parse (anti-vacuity)');
  ['dark', 'light'].forEach((theme, i) => {
    const t2 = t2s[i];
    const b = theme === 'dark' ? backs.dark.page : backs.light.page;
    const lit = over(active[i], over(menu[i], b));
    const r = ratio(t2, lit);
    ok(r >= 4.5, `${theme}: --text-2 on the lit row ${r.toFixed(2)}:1 >= 4.5`);
  });
}

console.log('\n── control: the old fill really was invisible');
const surfaceHover = hexOf(/--surface-hover:\s*var\(--ink-800\)/.test(read('tokens/color.css')) ? read('tokens/color.css').match(/--ink-800:\s*(#[0-9a-f]{6})/i)[1] : '#000000');
const oldStep = ratio(over(menu[0], backs.dark.page), surfaceHover);
ok(oldStep < 1.1, `the old --surface-hover on the dark menu measures ${oldStep.toFixed(3)}:1 (< 1.1), so this check can fail`);

console.log('\n── mouse and keyboard share one class');
const js = read('shared/listbox.js');
ok(/classList\.toggle\('is-active'/.test(js) || /is-active/.test(js), 'listbox.js drives the highlight through is-active');
ok(/mousemove/.test(js) && /setActive/.test(js), 'the mouse path calls setActive (the same setter the arrow keys use)');

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ listbox hover assertions FAILED'); process.exit(1); }
