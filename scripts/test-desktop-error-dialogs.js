/**
 * test-desktop-error-dialogs.js — OFFLINE guard for the Mac app's native error dialogs.
 *
 * `fatal()` used to put `err.stack` in a native dialog; other dialogs showed a raw
 * `err.message`. Electron is not installed in the offline suite, so main.js cannot
 * be imported. What IS executed: `desktop/lib/error-dialog.js` (the words), and
 * `fatal()` itself, cut out of main.js and run against a fake `dialog`/`app`. The
 * source scan of every `showErrorBox(...)` call is WEAK BY NATURE and is only a
 * cross-check on the executed part.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'desktop/lib/error-dialog.js')).href);
const { dialogText, firstLine, loadSanitizer, composeSanitizer, minimalScrub, FATAL_MAIN, DETAIL_LABEL } = mod;
const shared = await import(pathToFileURL(path.join(ROOT, 'src/brain/user-errors.js')).href);

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.log(`  FAIL: ${l}`); } }

const HOME = '/Users/jane';
const TOKEN40 = 'a'.repeat(20) + '1b2c3d4e5f'.repeat(2);
const SK = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-'); // built at run time: no credential-shaped literal in the source
function stacky() {
  const e = new Error(`Cannot find module '${HOME}/app/src/server.js' with ${SK} and https://x-access-token:${TOKEN40}@github.com/o/r.git`);
  e.stack = `${e.message}\n    at boot (${HOME}/Library/app/main.js:10:5)\n    at async ${HOME}/x.js:3:1`;
  return e;
}
function clean(text, label) {
  ok(!/\n\s+at /.test(text) && !/\bat\s+\S+\s*\(/.test(text), `${label}: no stack frames`);
  ok(!text.includes(HOME) && !/\/Users\//.test(text), `${label}: no home path`);
  ok(!text.includes(SK) && !text.includes(TOKEN40), `${label}: no token`);
}

// ── the words ────────────────────────────────────────────────────────────────
for (const [label, sanitize] of [
  ['shared sanitizer', shared.sanitizeDetail],
  ['local fallback', undefined],
  ['sanitizer that throws', () => { throw new Error('boom'); }],
  ['sanitizer that does nothing', (t) => t],
]) {
  const t = dialogText(FATAL_MAIN, stacky(), sanitize);
  clean(t, label);
  ok(t.startsWith(FATAL_MAIN), `${label}: plain sentence first`);
  ok(t.includes(DETAIL_LABEL), `${label}: detail line present`);
  ok(t.split('\n').length === 3, `${label}: exactly sentence + blank + one detail line`);
}
ok(FATAL_MAIN.includes('Help › Show Logs'), 'main sentence names the menu item');
ok(dialogText('X.', new Error(''), undefined) !== 'X.' || true, 'empty message tolerated');
ok(dialogText('X.', null, undefined) === 'X.', 'no error: no detail line');
ok(firstLine('line one\n    at foo (bar.js:1:1)') === 'line one', 'string error: first line');
ok(firstLine({ message: '    at a (b.js:1:1)\nreal' }) === 'real', 'a leading frame line is skipped');

// ── the import failure falls back ────────────────────────────────────────────
const s1 = await loadSanitizer(async () => { throw new Error('Cannot find module user-errors.js'); });
clean(dialogText(FATAL_MAIN, stacky(), s1), 'import rejected');
const s2 = await loadSanitizer(async () => ({}));
clean(dialogText(FATAL_MAIN, stacky(), s2), 'import without sanitizeDetail');
const s3 = await loadSanitizer(() => { throw new Error('sync throw'); });
ok(typeof s3 === 'function' && s3('/Users/bob/x') === '~/x', 'importer that throws synchronously still yields a scrub');
const s4 = await loadSanitizer(async () => shared);
clean(dialogText(FATAL_MAIN, stacky(), s4), 'import succeeded');

// ── fatal() itself, cut out of main.js and EXECUTED ──────────────────────────
const main = readFileSync(path.join(ROOT, 'desktop/main.js'), 'utf8');
const m = main.match(/\nfunction fatal\(err\) \{[\s\S]*?\n\}\n/);
ok(!!m, 'fatal() found in main.js');
function runFatal(err, sanitizer) {
  const shown = []; const logged = []; let exited = null;
  const f = new Function('dialog', 'app', 'console', 'dialogText', 'dialogSanitizer', 'FATAL_MAIN',
    `${m[0]}\nreturn fatal;`)(
    { showErrorBox: (t, b) => shown.push([t, b]) },
    { exit: (c) => { exited = c; } },
    { error: (...a) => logged.push(a.join(' ')) },
    dialogText, sanitizer, FATAL_MAIN);
  f(err);
  return { shown, logged, exited };
}
for (const [label, san] of [['minimal', minimalScrub], ['shared', composeSanitizer(shared.sanitizeDetail)]]) {
  const r = runFatal(stacky(), san);
  ok(r.shown.length === 1 && r.exited === 1, `fatal ${label}: one dialog, exit 1`);
  clean(r.shown[0][1], `fatal ${label}`);
  ok(r.shown[0][1].startsWith(FATAL_MAIN), `fatal ${label}: plain text`);
  ok(r.logged.join('\n').includes('at boot ('), `fatal ${label}: full stack still goes to the log`);
}

// ── cross-check: no showErrorBox call in main.js passes a stack or a raw message ──
const calls = [];
for (const mm of main.matchAll(/showErrorBox\(/g)) {
  let i = mm.index + mm[0].length, depth = 1;
  while (i < main.length && depth) { const c = main[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
  calls.push(main.slice(mm.index, i));
}
ok(calls.length >= 8, 'found the showErrorBox calls');
for (const c of calls) {
  ok(!/\.stack\b/.test(c), `no .stack in: ${c.slice(0, 50).replace(/\s+/g, ' ')}`);
  ok(!/\.message\b|String\(err\)|\$\{err\}/.test(c), `no raw message in: ${c.slice(0, 50).replace(/\s+/g, ' ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
