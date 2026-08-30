/**
 * test-next-sync-spin.js — OFFLINE suite for the Sync view's "Sync now"
 * refresh icon.
 *
 * Reported directly: clicking "Sync now" changes the button LABEL to
 * "Syncing…" but the refresh icon beside it stayed perfectly still — no
 * signal that anything was in flight beyond the text. Fixed in
 * views/sync.js (renderConfigured) + views/sync.css by wrapping the icon
 * in a `.sync-now-icon` span and toggling an `.is-spinning` class on it
 * from the SAME `acting === 'sync'` condition that already drives the
 * label text, reusing tokens/motion.css's `curator-spin` keyframe at the
 * same 1.15s cadence as shared/progress-ring.css's `.pring-orbit` (one
 * spin speed in the app, not two nearly-identical ones).
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM test-next-reduced-motion.js ────
 * That suite already covers, MECHANICALLY, that `.sync-now-icon.is-spinning
 * svg`'s hardcoded `1.15s` duration is neutralized by a same-file, same-
 * selector `prefers-reduced-motion: reduce` rule that itself sets
 * `animation` — it walks the whole /next tree and would fail if this rule
 * were ever removed or defeated. What it does NOT check is the JS half:
 * that the class is actually wired to the real in-flight state, on the
 * right button, and only while genuinely syncing. That is what this file
 * behaviourally verifies, by extracting and running the REAL functions
 * from views/sync.js (brace-matched, `new Function`, the technique
 * scripts/test-next-onboarding.js and scripts/test-next-progress-ring.js
 * already use) rather than re-reading the source with a regex.
 *
 * `icon` and `escapeHtml` are ALSO extracted from the real app.js (not
 * hand-written stand-ins), so the HTML this suite inspects is the exact
 * markup the button would carry in the running app, byte for byte.
 *
 * ── COVERED, behaviourally ────────────────────────────────────────────
 *   §1 idle: no `.sync-now-icon` class, no `is-spinning`, label "Sync now".
 *   §2 mid-sync (`state.acting = 'sync'`): `is-spinning` present, label
 *      "Syncing…", and the icon is INSIDE the #btn-sync-now button (never
 *      a sibling element that merely looks adjacent).
 *   §3 mid-push / mid-pull (`state.acting = 'push'|'pull'`): the "Sync now"
 *      icon does NOT spin — this button's icon reflects THIS button's own
 *      in-flight request, never another button's.
 *   §4 after settling (`state.acting = null`, mirroring onAction()'s
 *      finally-block reset): spinning stops — the class is DERIVED from
 *      state on every render, not a one-way flag some other code has to
 *      remember to clear.
 *   §5 the icon SVG itself still renders (never swallowed by the wrapper).
 *
 * ── COVERED as a source-level guard, stated as such ──────────────────
 *   §6 `onAction()` calls `render(token)` immediately after setting
 *      `state.acting = kind` and again after clearing it in `finally` — so
 *      the spin both starts and stops through the same repaint path this
 *      suite exercises, on every exit (success AND error), not just the
 *      happy path. Verified by reading the real onAction() source rather
 *      than re-running it (it performs a real fetch()).
 *
 * Zero dependencies — node: builtins only, no browser, no DOM, no network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const syncSrc = readFileSync(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
const syncCss = readFileSync(path.join(ROOT, 'src/public/next/views/sync.css'), 'utf8');
const appSrc = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Brace-matched extraction (same technique as test-next-onboarding.js
// and test-next-progress-ring.js) ─────────────────────────────────────────
function extractFunction(src, name, fileLabel) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${fileLabel}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced (${fileLabel})`);
  }
  return extracted;
}

// Brace-matched, for `const X = { ... };` and simple `const X = '...';`
// alike — icon() depends on app.js's ICON_BODY table (no line-ending-`;`
// extractor can cross that many lines safely) and MISSING_ICON_BODY.
function extractObjectOrSimpleConst(src, name, fileLabel) {
  const marker = new RegExp(`(?:^|\\n)const ${name} =\\s*`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractObjectOrSimpleConst: "${name}" not found in ${fileLabel}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const valueStart = start + (m[0].length - (m[0].startsWith('\n') ? 1 : 0));
  if (src[valueStart] === '{') {
    let depth = 0, i = valueStart;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const semi = src.indexOf(';', i);
    if (semi === -1) throw new Error(`extractObjectOrSimpleConst: "${name}" object has no terminating ";" (${fileLabel})`);
    return src.slice(start, semi + 1);
  }
  // Simple value: up to the first line-ending ';'.
  const re = new RegExp(`(?:^|\\n)const ${name} =[\\s\\S]*?;[ \\t]*\\n`, 'm');
  const mm = re.exec(src);
  if (!mm) throw new Error(`extractObjectOrSimpleConst: simple "${name}" not found in ${fileLabel}`);
  return mm[0].trim();
}

// ── Assemble a sandbox from REAL views/sync.js functions + REAL app.js
// helpers. Everything renderConfigured() can reach at runtime — including
// `state` itself — is the genuine implementation; nothing here is a
// hand-written stand-in for view logic. ───────────────────────────────────
const SYNC_FNS = [
  'freshState', 'renderConfigured', 'renderSharedBrainRow', 'renderDisconnect',
  'formatSyncTime', 'crossWriteBusy', 'activeWriteInfo', 'crossWriteTitle',
];
const APP_FNS = ['icon', 'escapeHtml'];

const sandboxSrc =
  // Stand-ins ONLY for things renderConfigured's dependency graph reaches
  // that are genuinely out of scope for this suite (an imported write-gate
  // reader from app.js's OTHER half, and shared/text.js's renderStatus,
  // which is exercised by its own suite). Both are held at their "nothing
  // is busy" / "never called" values so §1-§5's real path never touches
  // them — crossWriteBusy() returns false via isAnyWriteBusy() alone,
  // so activeWriteInfo()/crossWriteTitle() are dead code on every render
  // this suite performs, matching the fixture's `disabled: false` intent.
  `function isAnyWriteBusy() { return false; }\n` +
  `function getDomainWriteLabel() { return null; }\n` +
  `function renderStatus() { return '<div class="stub-status"></div>'; }\n` +
  extractObjectOrSimpleConst(appSrc, 'ICON_BODY', 'app.js') + '\n' +
  extractObjectOrSimpleConst(appSrc, 'MISSING_ICON_BODY', 'app.js') + '\n' +
  APP_FNS.map((n) => extractFunction(appSrc, n, 'app.js')).join('\n\n') + '\n' +
  SYNC_FNS.map((n) => extractFunction(syncSrc, n, 'views/sync.js')).join('\n\n') + '\n' +
  `let state = freshState();\n` +
  `return { state, renderConfigured, freshState };\n`;

const sandbox = new Function(sandboxSrc)();
const { state, renderConfigured, freshState } = sandbox;

// A minimal, realistic `status` payload — the same shape GET /api/sync/status
// returns, per this view's own header comment.
const statusFixture = { repoUrl: 'https://github.com/example/knowledge-base', lastSync: null, changesCount: 3 };

function extractButton(html, id) {
  // The button is self-closing-free HTML built by string concatenation, so
  // a simple "from <button ... id="X" to the matching </button>" slice is
  // exact for this markup (no nested <button> anywhere in this view).
  const openIdx = html.indexOf('id="' + id + '"');
  ok(openIdx !== -1, `#${id} is present in the rendered markup`);
  if (openIdx === -1) return '';
  const tagStart = html.lastIndexOf('<button', openIdx);
  const closeIdx = html.indexOf('</button>', openIdx);
  return html.slice(tagStart, closeIdx + '</button>'.length);
}

section('1. Idle — nothing in flight');
{
  Object.assign(state, freshState());
  const html = renderConfigured(statusFixture);
  const btn = extractButton(html, 'btn-sync-now');
  ok(btn.includes('sync-now-icon') && !btn.includes('is-spinning'), 'the icon wrapper is present without is-spinning');
  ok(btn.includes('Sync now') && !btn.includes('Syncing…'), 'label reads "Sync now"');
}

section('2. Mid-sync — state.acting = "sync"');
{
  Object.assign(state, freshState());
  state.acting = 'sync';
  const html = renderConfigured(statusFixture);
  const btn = extractButton(html, 'btn-sync-now');
  ok(btn.includes('sync-now-icon is-spinning'), 'is-spinning is present on the icon wrapper');
  ok(btn.includes('Syncing…'), 'label reads "Syncing…"');
  ok(/<span class="sync-now-icon is-spinning">[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?<\/span>/.test(btn), 'the spinning wrapper CONTAINS the icon <svg> — not a sibling element');
  ok(btn.indexOf('sync-now-icon') < btn.indexOf('Syncing…'), 'the icon precedes the label, inside the same button');
}

section('3. Mid-push / mid-pull — this button never spins for another button’s action');
for (const kind of ['push', 'pull']) {
  Object.assign(state, freshState());
  state.acting = kind;
  const html = renderConfigured(statusFixture);
  const btn = extractButton(html, 'btn-sync-now');
  ok(!btn.includes('is-spinning'), `acting="${kind}": the Sync-now icon is NOT spinning`);
  ok(btn.includes('Sync now'), `acting="${kind}": the Sync-now label is unchanged ("Sync now")`);
}

section('4. Settling — a real onAction()-shaped transition (sync -> null) stops the spin');
{
  Object.assign(state, freshState());
  state.acting = 'sync';
  ok(extractButton(renderConfigured(statusFixture), 'btn-sync-now').includes('is-spinning'), 'spinning while acting');
  state.acting = null; // mirrors onAction()'s finally-block reset, both on success AND on a caught error
  const settled = extractButton(renderConfigured(statusFixture), 'btn-sync-now');
  ok(!settled.includes('is-spinning'), 'is-spinning is gone once acting is cleared — same render() call path, no leftover flag');
  ok(settled.includes('Sync now'), 'label reverts to "Sync now"');
}

section('5. The icon itself is never swallowed by the wrapper');
{
  Object.assign(state, freshState());
  const btn = extractButton(renderConfigured(statusFixture), 'btn-sync-now');
  ok(/<svg[^>]*viewBox="0 0 24 24"/.test(btn), 'a real <svg viewBox="0 0 24 24"> renders inside the button (icon() was not stubbed for this assertion — it is the real app.js function)');
}

section('6. Source-level guard — onAction() repaints on BOTH the start and the settle of every action, success and error alike');
{
  const onAction = extractFunction(syncSrc, 'onAction', 'views/sync.js');
  ok(/state\.acting\s*=\s*kind;[\s\S]{0,80}render\(token\)/.test(onAction), 'render(token) is called immediately after state.acting is set — the spin starts on click, not on response');
  ok(/finally\s*\{[\s\S]*state\.acting\s*=\s*null;[\s\S]*render\(token\)/.test(onAction), 'a finally block clears state.acting and repaints — reached on success AND on a caught error, never left spinning after a failed sync');
}

// ── The CSS half, from disk (test-next-reduced-motion.js already proves
// the reduce-escape MECHANICALLY across the whole /next tree; this is a
// named, file-specific confirmation that the exact selectors this suite
// exercised above actually exist in views/sync.css). ──────────────────────
section('7. views/sync.css carries the animation and its reduce escape for this exact class');
{
  ok(/\.sync-now-icon\.is-spinning\s+svg\s*\{[^}]*animation:\s*curator-spin\s+1\.15s\s+linear\s+infinite/.test(syncCss),
    '.sync-now-icon.is-spinning svg animates with curator-spin at 1.15s (same cadence as .pring-orbit)');
  ok(/prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.sync-now-icon\.is-spinning\s+svg\s*\{[^}]*animation:\s*none/.test(syncCss),
    'a prefers-reduced-motion: reduce rule in the SAME file disables it (animation: none) for the same selector');
}

console.log('\n' + '─'.repeat(62));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ Sync "Sync now" spin-icon assertions failed');
  process.exit(1);
} else {
  console.log('✅ All Sync spin-icon assertions green');
}
