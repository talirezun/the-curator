#!/usr/bin/env node
/**
 * test-tray-menu-win-wrap.js — OFFLINE. The native Windows tray menu (the
 * right-click menu and the popover's fallback) wraps each long disabled
 * detail line at about WIN_DETAIL_LINE_CHARS characters into consecutive
 * disabled rows, losing no fact and changing no id, click or picture.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tw = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'tray-menu-win.js')).href);
const { adaptTrayMenuForWindows, wrapDetailLine, WIN_DETAIL_LINE_CHARS: W, WIN_DETAIL_LINES_MAX: MAX } = tw;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}`); } }
const words = (s) => s.split(/\s+/).filter(Boolean);

const LONG = 'The file was written to the project folder on this computer and last changed after the previous save finished, so it is current';
const SHORT = 'machine: studio-mac';
const TICK = 'Open `src/brain/working-state.js` and compare it with `docs/spec/working-state-v1.md` before saving anything';
const click = () => {};
const img = { icon: 'x' };
const tpl = () => [
  { id: 'pulse', label: 'Saved', toolTip: [SHORT, LONG].join('\n'), click, icon: img },
  { id: 'proj', label: 'Projects', submenu: [{ id: 'p1', label: 'Alpha', click, toolTip: TICK, icon: img }], toolTip: SHORT },
  { id: 'q', role: 'quit', label: 'Quit' },
];
const detail = (sub) => sub.filter((i) => i.enabled === false).map((i) => i.label);

// 1. wrapDetailLine itself
const rows = wrapDetailLine(LONG);
ok(rows.length > 1, 'a long line wraps into several rows');
ok(rows.every((r) => r.length <= W), `every row is within ${W} characters`);
ok(words(rows.join(' ')).join(' ') === words(LONG).join(' '), 'every word survives, in order');
ok(wrapDetailLine(SHORT).length === 1 && wrapDetailLine(SHORT)[0] === SHORT, 'a short line is unchanged');
const tick = wrapDetailLine(TICK);
ok(tick.some((r) => r.includes('`src/brain/working-state.js`')) && tick.some((r) => r.includes('`docs/spec/working-state-v1.md`')), 'backticked tokens are never split');
const SPAN = 'Before saving anything always run first `npm run test --silent` please';
ok(wrapDetailLine(SPAN).some((r) => r.includes('`npm run test --silent`')), 'a backticked span containing spaces stays on one row');
const huge = 'x'.repeat(150);
ok(JSON.stringify(wrapDetailLine('see ' + huge + ' now')) === JSON.stringify(['see', huge, 'now']), 'an overlong unbreakable token gets its own row, unsplit');

// 2. through the menu
const out = adaptTrayMenuForWindows(tpl());
const pulse = out[0].submenu;
const lines = detail(pulse);
ok(lines.includes(SHORT), 'a short detail line stays one row');
const wrapped = lines.filter((l) => l !== SHORT);
ok(wrapped.length > 1 && wrapped.every((l) => l.length <= W), 'the long detail becomes consecutive rows within the limit');
ok(words(wrapped.join(' ')).join(' ') === words(LONG).join(' '), 'no fact lost across the wrapped rows');
ok(pulse.filter((i) => i.label && i.enabled === false).every((i) => i.enabled === false), 'wrapped rows are disabled');
const inner = out[1].submenu;
ok(inner[0].id === 'p1' && inner[0].click === click && inner[0].icon === img && !inner[0].submenu, 'a leaf in a submenu stays a clickable leaf');
ok(detail(inner).join(' ').includes('`src/brain/working-state.js`'), 'the leaf\'s long line is wrapped at the submenu end');

// 3. ids, actions, pictures unchanged
ok(out[0].id === 'pulse' && out[0].icon === img && pulse[0].click === click, 'top-level id, picture and click carried over');
ok(out[2].role === 'quit' && out[2].label === 'Quit', 'role items untouched');

// 4. cap
const many = adaptTrayMenuForWindows([{ id: 'm', label: 'M', toolTip: Array.from({ length: 30 }, (_, i) => `line ${i} ` + LONG).join('\n') }]);
ok(many[0].submenu.length <= MAX + 1 && detail(many[0].submenu).length <= MAX, 'the max-lines cap holds on wrapped rows');
const fewLong = adaptTrayMenuForWindows([{ id: 'm', label: 'M', toolTip: LONG + '\n' + LONG.replace('file', 'doc') }]);
ok(detail(fewLong[0].submenu).length > 2, 'two long lines yield more than two rows under the cap');

// 5. writtenAtText
const wt = adaptTrayMenuForWindows([{ id: 'w', label: 'W', writtenAtText: '21 Nov 2026, 13:37', toolTip: 'written: 2026-11-21T12:37:12.345Z' }]);
ok(detail(wt[0].submenu).join('|') === 'written: 21 Nov 2026, 13:37' && !('writtenAtText' in wt[0]), 'writtenAtText is preferred when present');
const nt = adaptTrayMenuForWindows([{ id: 'w', label: 'W', toolTip: 'written: 2026-11-21T12:37:12.345Z' }]);
ok(detail(nt[0].submenu).join('|') === 'written: 2026-11-21T12:37:12.345Z', 'without it today\'s text is kept');

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
