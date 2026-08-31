/**
 * test-next-confirm-dialog.js — OFFLINE suite for the /next in-design
 * confirm dialog (src/public/next/shared/confirm.js) and the Updates flow
 * it gates (src/public/next/views/settings.js).
 *
 * No network, no API key, no server, no browser. Nothing in this file ever
 * calls POST /api/config/update, /api/update or /api/restart: every fetch
 * reaching the code under test is a local stub, and §7 asserts that the
 * suite's own stub recorded the call rather than a real one being made.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the REAL source is executed):
 *   - The whole confirm dialog, against a purpose-built minimal DOM (§3):
 *     open, cancel, confirm, Escape, scrim identity test, focus restore on
 *     BOTH paths, refusal to stack a second dialog, and the teardown path
 *     resolving WITHOUT running the action.
 *   - deleteConversationRow() extracted from the real views/chat.js and
 *     driven with a cancelling stub: the DELETE must not fire (§4). This is
 *     the assertion that stands in for `window.confirm`'s lost synchrony.
 *   - compareSemver() and classifyUpdate() from the real views/settings.js,
 *     including the local-AHEAD-of-remote branch and the precedence order
 *     (§5).
 *   - runUpdate()'s partial-success and failure branches (§6, §7).
 *
 * COVERED as source-level guards (stated as such, not as behaviour):
 *   - No native dialog CALL survives anywhere in src/public/next (§1). This
 *     is a class-level scan of every .js file, comment-stripped —
 *     shared/markdown.js legitimately writes `alert(` inside prose about
 *     XSS vectors, and confirm.js's own header quotes `window.confirm`.
 *   - The API carries no decision value, and no call site drops the
 *     promise or truth-tests it (§2).
 *   - a11y attributes, capture-phase Escape, offsetParent filtering, the
 *     scrim identity test, and the "user text only ever reaches
 *     textContent" rule (§2, §8).
 *   - CSS token/theming hygiene for the .cfd-* block (§8).
 *
 * NOT COVERED here (stated rather than implied):
 *   - Real rendering, real focus rings, real pointer events. The shim in
 *     §3 is a model of a DOM, not a browser; visual placement, z-index
 *     stacking against the shell, and actual keyboard traversal were
 *     verified in a real browser and that verification is not reproducible
 *     from here.
 *   - The update endpoints themselves. Applying an update is destructive
 *     to a real checkout and is deliberately never invoked.
 *   - pollForRestart()'s timing loop (it owns a setInterval and a
 *     location.reload; the branch it guards is asserted structurally).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');

const confirmSrc = readFileSync(path.join(NEXT, 'shared/confirm.js'), 'utf8');
const chatSrc = readFileSync(path.join(NEXT, 'views/chat.js'), 'utf8');
const settingsSrc = readFileSync(path.join(NEXT, 'views/settings.js'), 'utf8');
const sharedCss = readFileSync(path.join(NEXT, 'views/shared.css'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping ────────────────────────────────────────────────────
// Every ABSENCE check below has to run against CODE. This module's own
// header, chat.js's rewritten doc comment and settings.js's header all
// deliberately QUOTE the strings being asserted absent — run against raw
// text those guards would be reading a comment, which is this repo's named
// failure shape ("a check that stopped reaching the thing it protects").
//
// ORDER IS LOAD-BEARING and matches scripts/test-next-onboarding.js: line
// comments FIRST. These files contain prose like `folder/*` inside `//`
// comments, and stripping blocks first turns such a `/*` into a fake block
// comment that runs on until the next `*/`, swallowing real code whole.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// Sanity anchors are STRUCTURAL and deliberately do not overlap anything an
// assertion below also checks — a mutation must produce a red assertion,
// never a thrown tripwire (a red for the wrong reason proves nothing).
const confirmCode = assertStrippedSane(stripComments(confirmSrc), 'confirm.js', [
  'export function confirmThen(opts)',
  'export function closeConfirmIfOpen()',
  'function accept(onConfirm)',
  'function onKeydown(e)',
]);
const chatCode = assertStrippedSane(stripComments(chatSrc), 'chat.js', [
  'async function deleteConversationRow(id, title, mountToken)',
]);
const settingsCode = assertStrippedSane(stripComments(settingsSrc), 'settings.js', [
  'function classifyUpdate(check, versionInfo)',
  'function compareSemver(a, b)',
  'function updateStyleOf(check)',
  'function classifyInstallerUpdate(check)',
  'async function runUpdate(token)',
]);

// ── Extraction, brace-matched (technique from test-next-onboarding.js) ───
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
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
  const extracted = src.slice(start, i);
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather
  // than later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  No native dialog survives anywhere in /next (class-level)');
// ═════════════════════════════════════════════════════════════════════════
// A per-file check would only ever look where somebody remembered to look.
// This walks the whole tree, so a dialog introduced in a view nobody
// thought about fails here.

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}
const nextJsFiles = walkJs(NEXT);
ok(nextJsFiles.length >= 15,
  `sanity: the walk found ${nextJsFiles.length} .js files under /next (a broken walk would pass every absence check vacuously)`);
ok(nextJsFiles.some((f) => f.endsWith('shared/confirm.js')) &&
   nextJsFiles.some((f) => f.endsWith('views/chat.js')) &&
   nextJsFiles.some((f) => f.endsWith('views/settings.js')),
  'sanity: the walk reaches the three files this change actually touched');

// `window.` forms and BARE forms, the latter with a leading boundary so
// `state.confirm`, `confirmThen(` and `renderConfirmCard(` are not matched.
const DIALOG_PATTERNS = [
  /\bwindow\s*\.\s*(?:confirm|alert|prompt)\s*\(/,
  /(?:^|[^.\w$])(?:confirm|alert|prompt)\s*\(/m,
];
const offenders = [];
for (const file of nextJsFiles) {
  const code = stripComments(readFileSync(file, 'utf8'));
  code.split('\n').forEach((line, idx) => {
    for (const re of DIALOG_PATTERNS) {
      if (re.test(line)) offenders.push(`${path.relative(ROOT, file)}:${idx + 1}: ${line.trim().slice(0, 110)}`);
    }
  });
}
ok(offenders.length === 0,
  offenders.length === 0
    ? 'no window.confirm / window.alert / window.prompt call in any /next .js file'
    : `native dialog call(s) found in /next:\n      ${offenders.join('\n      ')}`);

// Negative control: the detector must actually be able to fire. Without
// this, a regex that matches nothing would report a clean tree forever.
ok(DIALOG_PATTERNS.some((re) => re.test("  const ok = window.confirm('x');")),
  'negative control: the detector matches a real window.confirm call');
ok(DIALOG_PATTERNS.some((re) => re.test('  alert(msg);')),
  'negative control: the detector matches a bare alert() call');
ok(!DIALOG_PATTERNS.some((re) => re.test('  await confirmThen({ title: "x" });')),
  'negative control: the detector does NOT match confirmThen() (otherwise the fix itself would fail the guard)');
ok(!DIALOG_PATTERNS.some((re) => re.test('  renderConfirmCard(state.confirm);')),
  'negative control: the detector does NOT match domains.js\'s inline renderConfirmCard()');

// The two dialogs the cutover left behind are named explicitly, so a
// regression at either exact site is reported by name and not merely as a
// count.
ok(!/window\.confirm\s*\(/.test(chatCode), 'views/chat.js no longer calls window.confirm (the screenshotted one)');
ok(!/window\.alert\s*\(/.test(settingsCode), 'views/settings.js no longer calls window.alert (the update check)');

// ═════════════════════════════════════════════════════════════════════════
section('§2  The API carries no decision value, and no call site drops it');
// ═════════════════════════════════════════════════════════════════════════
// The failure this guards is specific: port `const ok = window.confirm()`
// to a promise-returning `openConfirm(): Promise<boolean>` and a caller who
// forgets `await` holds a PROMISE OBJECT, which is truthy, so `if (!ok)
// return` never fires and the conversation is deleted on Cancel. Silent,
// unlogged data loss in the exact path being improved.

ok(!/resolve\s*\(\s*(?:true|false)\s*\)/.test(confirmCode),
  'confirm.js never resolves a boolean — there is no decision value in its public surface to mis-test');
ok(/onConfirm/.test(confirmCode) && /function accept\(onConfirm\)/.test(confirmCode),
  'the action is passed IN as onConfirm rather than a decision being handed back');

const acceptBody = extractFunction(confirmSrc, 'accept', 'confirm.js');
const closeBody = extractFunction(confirmSrc, 'close', 'confirm.js');
ok(/onConfirm\s*\(\s*\)/.test(acceptBody),
  'accept() — the confirm-button path — is the only place onConfirm is invoked');
ok(!/onConfirm/.test(closeBody),
  'close() — the cancel / Escape / scrim / teardown path — holds no reference to the action at all');
const onConfirmCallSites = (confirmCode.match(/onConfirm\s*\(\s*\)/g) || []).length;
eq(onConfirmCallSites, 1, 'the action has exactly ONE invocation site in the whole module');

// Class-level: every confirmThen() call in /next either awaits it, returns
// it, or attaches a .catch — a dropped promise silently swallows whatever
// the destructive action threw.
// The defining module is excluded: it declares confirmThen, it never calls
// it. stripComments only removes WHOLE-LINE // comments (deliberately —
// distinguishing an end-of-line // from one inside a string needs a real
// lexer, and for an absence check the safe direction is to leave too much
// in), so confirm.js's own `// resolves the confirmThen() promise` note
// would otherwise be scanned as a call site: a false FAILURE, which is the
// harmless direction, but a pointless one.
const callSites = [];
for (const file of nextJsFiles) {
  if (file.endsWith(path.join('shared', 'confirm.js'))) continue;
  const code = stripComments(readFileSync(file, 'utf8'));
  code.split('\n').forEach((line, idx) => {
    if (/\bconfirmThen\s*\(/.test(line) && !/^\s*(?:import|export)\b/.test(line)) {
      callSites.push({ file: path.relative(ROOT, file), line: idx + 1, text: line.trim() });
    }
  });
}
ok(callSites.length >= 3,
  `sanity: found ${callSites.length} confirmThen() call sites (chat delete + update install + restart)`);
const dropped = callSites.filter((c) => !/\b(?:await|return)\s+confirmThen\s*\(/.test(c.text));
ok(dropped.length === 0,
  dropped.length === 0
    ? 'every confirmThen() call site is awaited or returned — none drops the promise'
    : `confirmThen() promise dropped at:\n      ${dropped.map((d) => `${d.file}:${d.line}: ${d.text}`).join('\n      ')}`);

// And nobody treats the result as a decision.
const truthTested = callSites.filter((c) => /(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?confirmThen\s*\(/.test(c.text));
ok(truthTested.length === 0,
  truthTested.length === 0
    ? 'no call site binds confirmThen()\'s result to a variable — there is nothing to truth-test'
    : `confirmThen() result bound to a variable at:\n      ${truthTested.map((d) => `${d.file}:${d.line}`).join('\n      ')}`);

// a11y mechanism, copied from views/mcp-wizard.js and living here once.
ok(/role="dialog"/.test(confirmCode), 'the card carries role="dialog"');
ok(/aria-modal="true"/.test(confirmCode), 'the card carries aria-modal="true"');
ok(/aria-labelledby="cfd-title"/.test(confirmCode), 'the card is labelled by its own title node');
ok(/addEventListener\('keydown',\s*onKeydown,\s*true\)/.test(confirmCode),
  'the Escape/Tab handler is registered in the CAPTURE phase, so a view that stops keydown propagation cannot trap the user in the dialog');
ok(/removeEventListener\('keydown',\s*onKeydown,\s*true\)/.test(confirmCode),
  'and it is removed with the SAME capture flag (a mismatched flag leaves the listener attached forever)');
ok(/offsetParent\s*!==\s*null/.test(confirmCode),
  'the focus trap filters on offsetParent !== null — a hidden button must not swallow a Tab');
ok(/e\.target\s*===\s*scrimEl/.test(confirmCode),
  'backdrop dismissal uses an identity test, not contains() — a drag that starts inside the card and releases on the backdrop must not dismiss');
ok(/scrimEl\.addEventListener\('mousedown'/.test(confirmCode),
  'backdrop dismissal is bound on mousedown (matching the wizards), not click');

// Focus restore: read into a LOCAL before the root is detached.
const teardownBody = extractFunction(confirmSrc, 'teardown', 'confirm.js');
const iLocal = teardownBody.indexOf('const returnTo = prevFocus');
const iRemove = teardownBody.indexOf('root.remove()');
const iRestore = teardownBody.indexOf('returnTo.focus()');
ok(iLocal !== -1 && iRemove !== -1 && iRestore !== -1, 'teardown() captures, detaches, and restores focus');
ok(iLocal < iRemove, 'the launcher is read into a local BEFORE the root is detached');
ok(iRemove < iRestore, 'focus is restored AFTER the dialog nodes are gone, so the browser cannot bounce it back');

// User text never touches innerHTML.
const openBody = extractFunction(confirmSrc, 'confirmThen', 'confirm.js');
const innerHtmlStmt = /root\.innerHTML\s*=([\s\S]*?);\n/.exec(openBody);
ok(!!innerHtmlStmt, 'sanity: found the single innerHTML assignment');
for (const field of ['title', 'message', 'detail', 'confirmLabel', 'cancelLabel']) {
  ok(!new RegExp(`o\\.${field}\\b`).test(innerHtmlStmt[1]),
    `o.${field} never reaches innerHTML — a conversation title is user content`);
  ok(new RegExp(`\\.textContent\\s*=[^\\n]*o\\.${field}\\b`).test(openBody) ||
     new RegExp(`o\\.${field}[^\\n]*\\)\\s*;`).test(openBody),
    `o.${field} is written through textContent`);
}
eq((openBody.match(/\.innerHTML\s*=/g) || []).length, 1,
  'exactly one innerHTML assignment in the whole open path');

// ═════════════════════════════════════════════════════════════════════════
section('§3  The dialog, executed against a minimal DOM');
// ═════════════════════════════════════════════════════════════════════════
// The module is executed for real (imports stripped, exports collected) on
// a purpose-built DOM model. The model is a MODEL — see this file's header
// for what that does and does not prove — but it is enough to exercise
// every branch of open/cancel/confirm/Escape/scrim/teardown, and its own
// parse is tripwired below so a shim desync fails loudly.

function makeDom() {
  const capturedKeydown = [];
  let activeElement = null;

  function el(tag, attrs) {
    const node = {
      tagName: tag.toUpperCase(),
      attrs: attrs || {},
      children: [],
      parentNode: null,
      _text: '',
      _listeners: {},
      get className() { return node.attrs.class || ''; },
      set className(v) { node.attrs.class = v; },
      classList: {
        add(c) { node.attrs.class = ((node.attrs.class || '') + ' ' + c).trim(); },
        contains(c) { return (node.attrs.class || '').split(/\s+/).includes(c); },
      },
      get textContent() {
        if (node.children.length === 0) return node._text;
        return node.children.map((c) => c.textContent).join('');
      },
      set textContent(v) { node.children = []; node._text = String(v); },
      get innerHTML() { return '(not modelled)'; },
      set innerHTML(html) { node.children = parseHtml(html, node); },
      get offsetParent() { return node.parentNode ? node.parentNode : null; },
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      remove() {
        if (!node.parentNode) return;
        const i = node.parentNode.children.indexOf(node);
        if (i >= 0) node.parentNode.children.splice(i, 1);
        node.parentNode = null;
      },
      contains(other) {
        if (other === node) return true;
        return node.children.some((c) => c.contains(other));
      },
      addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        const l = node._listeners[type]; if (!l) return;
        const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
      },
      focus() { activeElement = node; },
      descendants() { return node.children.flatMap((c) => [c, ...c.descendants()]); },
      querySelectorAll(sel) { return node.descendants().filter((d) => matches(d, sel)); },
      querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    };
    return node;
  }

  function matches(node, selector) {
    return selector.split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
      // Supports exactly the forms confirm.js uses: `.class`, `tag`,
      // `tag:not([disabled])`, `a[href]`, `[tabindex]:not([tabindex="-1"])`.
      if (/:not\(\[disabled\]\)$/.test(part)) {
        const tag = part.replace(/:not\(\[disabled\]\)$/, '');
        return node.tagName === tag.toUpperCase() && !('disabled' in node.attrs);
      }
      if (part === 'a[href]') return node.tagName === 'A' && 'href' in node.attrs;
      if (part.startsWith('[tabindex]')) return 'tabindex' in node.attrs && node.attrs.tabindex !== '-1';
      if (part.startsWith('.')) return node.classList.contains(part.slice(1));
      return node.tagName === part.toUpperCase();
    });
  }

  // Minimal tokenizer over the FIXED template confirm.js emits: open tags
  // with quoted attributes, close tags, no text nodes.
  function parseHtml(html, parent) {
    const stack = [{ node: parent, children: [] }];
    const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      const ar = /([a-zA-Z-]+)="([^"]*)"/g;
      let a;
      while ((a = ar.exec(m[2])) !== null) attrs[a[1]] = a[2];
      const node = el(m[1], attrs);
      const top = stack[stack.length - 1];
      node.parentNode = top.node;
      top.children.push(node);
      if (top.node !== parent) top.node.children = top.children;
      stack.push({ node, children: node.children });
    }
    return stack[0].children;
  }

  const body = el('div', {});
  body.parentNode = { children: [body], contains: () => true }; // body is always "attached"
  const document = {
    get activeElement() { return activeElement; },
    set activeElement(v) { activeElement = v; },
    body,
    createElement: (tag) => el(tag, {}),
    addEventListener(type, fn, capture) { if (type === 'keydown' && capture) capturedKeydown.push(fn); },
    removeEventListener(type, fn, capture) {
      if (type !== 'keydown' || !capture) return;
      const i = capturedKeydown.indexOf(fn); if (i >= 0) capturedKeydown.splice(i, 1);
    },
  };
  return {
    document,
    fireKey(key, shiftKey) {
      const e = { key, shiftKey: !!shiftKey, preventDefault() { e.defaultPrevented = true; }, defaultPrevented: false };
      capturedKeydown.slice().forEach((fn) => fn(e));
      return e;
    },
    fire(node, type, event) { (node._listeners[type] || []).slice().forEach((fn) => fn(event || {})); },
    keydownCount: () => capturedKeydown.length,
    setActive(node) { activeElement = node; },
  };
}

function loadConfirmModule(dom) {
  const body = confirmSrc.replace(/^export\s+/gm, '');
  const factory = new Function('document', 'Promise',
    body + '\nreturn { confirmThen, closeConfirmIfOpen, isConfirmOpen };');
  return factory(dom.document, Promise);
}

{
  // Shim tripwire: if the parse produces the wrong node set, every
  // behavioural assertion below would pass or fail for reasons that have
  // nothing to do with confirm.js.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  const launcher = dom.document.createElement('button');
  dom.document.body.appendChild(launcher);
  dom.setActive(launcher);

  mod.confirmThen({ title: 'T', message: 'M', detail: 'D', confirmLabel: 'Go', cancelLabel: 'Stop' });
  const root = dom.document.body.children[dom.document.body.children.length - 1];
  const card = root.querySelector('.cfd-card');
  ok(!!card, 'shim sanity: the dialog card parsed out of the template');
  ok(!!root.querySelector('.cfd-scrim') && !!root.querySelector('.cfd-title') &&
     !!root.querySelector('.cfd-cancel') && !!root.querySelector('.cfd-confirm'),
    'shim sanity: scrim, title, cancel and confirm nodes all parsed');
  eq(card.attrs.role, 'dialog', 'the rendered card really carries role="dialog"');
  eq(card.attrs['aria-modal'], 'true', 'the rendered card really carries aria-modal="true"');
  eq(root.querySelector('.cfd-title').textContent, 'T', 'the title is set');
  eq(root.querySelector('.cfd-detail').textContent, 'D', 'the detail line is set');
  eq(root.querySelector('.cfd-confirm').textContent, 'Go', 'the confirm label is set');
  ok(dom.document.activeElement === root.querySelector('.cfd-cancel'),
    'initial focus lands on CANCEL for a destructive dialog — Enter dismisses rather than destroys');
  mod.closeConfirmIfOpen();
}

{
  // Cancel: the action must NOT run, and focus must go home.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  const launcher = dom.document.createElement('button');
  dom.document.body.appendChild(launcher);
  dom.setActive(launcher);
  let ran = 0;
  const p = mod.confirmThen({ title: 'T', message: 'M', onConfirm: () => { ran++; } });
  const root = dom.document.body.children[dom.document.body.children.length - 1];
  dom.fire(root.querySelector('.cfd-cancel'), 'click');
  await p;
  eq(ran, 0, 'Cancel: the destructive action never ran');
  eq(mod.isConfirmOpen(), false, 'Cancel: the dialog is closed');
  ok(dom.document.activeElement === launcher, 'Cancel: focus returned to the element that opened it');
  eq(dom.document.body.children.includes(root), false, 'Cancel: the dialog root is detached from the document');
  eq(dom.keydownCount(), 0, 'Cancel: the capture-phase keydown listener was removed');
}

{
  // Confirm: the action runs exactly once, and focus still goes home.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  const launcher = dom.document.createElement('button');
  dom.document.body.appendChild(launcher);
  dom.setActive(launcher);
  let ran = 0;
  const p = mod.confirmThen({ title: 'T', message: 'M', onConfirm: async () => { ran++; } });
  const root = dom.document.body.children[dom.document.body.children.length - 1];
  dom.fire(root.querySelector('.cfd-confirm'), 'click');
  await p;
  eq(ran, 1, 'Confirm: the action ran exactly once');
  eq(mod.isConfirmOpen(), false, 'Confirm: the dialog is closed before the action runs (its own surface is the feedback)');
  ok(dom.document.activeElement === launcher, 'Confirm: focus returned to the element that opened it');
}

{
  // Escape and the scrim both take the CANCEL path.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  let ran = 0;
  const p1 = mod.confirmThen({ title: 'T', message: 'M', onConfirm: () => { ran++; } });
  const ev = dom.fireKey('Escape');
  await p1;
  eq(ran, 0, 'Escape: the destructive action never ran');
  eq(ev.defaultPrevented, true, 'Escape: the key event is consumed');
  eq(mod.isConfirmOpen(), false, 'Escape: the dialog is closed');

  const p2 = mod.confirmThen({ title: 'T', message: 'M', onConfirm: () => { ran++; } });
  const root2 = dom.document.body.children[dom.document.body.children.length - 1];
  const scrim = root2.querySelector('.cfd-scrim');
  dom.fire(scrim, 'mousedown', { target: root2.querySelector('.cfd-card') });
  eq(mod.isConfirmOpen(), true, 'scrim: a mousedown whose target is the CARD does not dismiss');
  dom.fire(scrim, 'mousedown', { target: scrim });
  await p2;
  eq(ran, 0, 'scrim: the destructive action never ran');
  eq(mod.isConfirmOpen(), false, 'scrim: a mousedown on the backdrop itself dismisses');
}

{
  // Tab trap: wraps within the dialog, never escapes to the background.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  const bgBtn = dom.document.createElement('button');
  dom.document.body.appendChild(bgBtn);
  const p = mod.confirmThen({ title: 'T', message: 'M' });
  const root = dom.document.body.children[dom.document.body.children.length - 1];
  const cancel = root.querySelector('.cfd-cancel');
  const confirm = root.querySelector('.cfd-confirm');
  confirm.focus();
  dom.fireKey('Tab');
  ok(dom.document.activeElement === cancel, 'Tab from the last control wraps to the first, inside the dialog');
  dom.fireKey('Tab', true);
  ok(dom.document.activeElement === confirm, 'Shift+Tab from the first control wraps to the last');
  dom.setActive(bgBtn);
  dom.fireKey('Tab');
  ok(dom.document.activeElement === cancel, 'Tab while focus is OUTSIDE the dialog is pulled back inside');
  mod.closeConfirmIfOpen();
  await p;
}

{
  // Stacking, teardown, and a throwing action.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  let firstRan = 0, secondRan = 0;
  const p1 = mod.confirmThen({ title: 'A', message: 'M', onConfirm: () => { firstRan++; } });
  const p2 = mod.confirmThen({ title: 'B', message: 'M', onConfirm: () => { secondRan++; } });
  await p2;
  eq(secondRan, 0, 'a second confirmThen() while one is open resolves WITHOUT running its action');
  eq(mod.isConfirmOpen(), true, 'and it does not disturb the dialog already on screen');
  mod.closeConfirmIfOpen();
  await p1;
  eq(firstRan, 0, 'closeConfirmIfOpen() (the view-teardown path) takes the CANCEL branch — a teardown can never fire the action');

  let rejected = null;
  const p3 = mod.confirmThen({ title: 'C', message: 'M', onConfirm: () => { throw new Error('boom'); } });
  const root3 = dom.document.body.children[dom.document.body.children.length - 1];
  dom.fire(root3.querySelector('.cfd-confirm'), 'click');
  await p3.catch((e) => { rejected = e; });
  ok(rejected && rejected.message === 'boom',
    'a throwing action rejects the returned promise (so the .catch(reportAsyncActionFailure) at the call sites is not decorative)');
  eq(mod.isConfirmOpen(), false, 'and the dialog is still torn down');
}

{
  // User content is stored verbatim as text, never parsed as markup.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  const hostile = '<img src=x onerror=alert(1)>"><script>bad()</script>';
  const p = mod.confirmThen({ title: 'T', message: hostile });
  const root = dom.document.body.children[dom.document.body.children.length - 1];
  const msg = root.querySelector('.cfd-message');
  eq(msg.textContent, hostile, 'a hostile conversation title survives verbatim as TEXT');
  eq(msg.children.length, 0, 'and produced no element children — it was never parsed as markup');
  mod.closeConfirmIfOpen();
  await p;
}

{
  // The optional detail line is removed, not left as an empty node.
  const dom = makeDom();
  const mod = loadConfirmModule(dom);
  const p = mod.confirmThen({ title: 'T', message: 'M' });
  const root = dom.document.body.children[dom.document.body.children.length - 1];
  ok(root.querySelector('.cfd-detail') === null, 'with no detail supplied the detail node is removed entirely');
  eq(root.querySelector('.cfd-confirm').textContent, 'Confirm', 'the confirm label defaults');
  eq(root.querySelector('.cfd-cancel').textContent, 'Cancel', 'the cancel label defaults');
  ok(root.querySelector('.cfd-card').classList.contains('cfd-danger'),
    'tone defaults to danger — the safe default for a dialog that exists to gate destruction');
  mod.closeConfirmIfOpen();
  await p;
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  deleteConversationRow: Cancel really cancels');
// ═════════════════════════════════════════════════════════════════════════
// The real function from views/chat.js, executed with every dependency
// injected. This is the assertion that replaces the safety `window.confirm`
// used to provide by being synchronous.

function makeDeleteHarness(confirmBehaviour) {
  const calls = [];
  const state = { activeDomain: 'articles', activeConversationId: 'c1', thread: [{ role: 'user' }] };
  const refreshes = [];
  const factory = new Function(
    'confirmThen', 'fetch', 'state', 'isCurrentMount', 'loadDomainConversations',
    extractFunction(chatSrc, 'deleteConversationRow', 'chat.js') + '\nreturn deleteConversationRow;');
  const fn = factory(
    confirmBehaviour,
    async (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return { ok: true, json: async () => ({}) }; },
    state,
    () => true,
    async (...a) => { refreshes.push(a); },
  );
  return { fn, calls, state, refreshes };
}

// Cancel: the dialog resolves without ever calling onConfirm.
{
  const h = makeDeleteHarness(async () => { /* user cancelled — action never invoked */ });
  await h.fn('c1', 'My conversation', 7);
  eq(h.calls.length, 0, 'Cancel: no fetch of any kind was issued');
  eq(h.calls.filter((c) => c.method === 'DELETE').length, 0, 'Cancel: no DELETE reached the server');
  eq(h.state.activeConversationId, 'c1', 'Cancel: the active conversation is untouched');
  eq(h.refreshes.length, 0, 'Cancel: the list was not refreshed');
}

// Confirm: the DELETE fires, at the right URL, and state is cleaned up.
{
  let seenOpts = null;
  const h = makeDeleteHarness(async (opts) => { seenOpts = opts; await opts.onConfirm(); });
  await h.fn('c1', 'My conversation', 7);
  eq(h.calls.length, 1, 'Confirm: exactly one request was issued');
  eq(h.calls[0].method, 'DELETE', 'Confirm: it is a DELETE');
  eq(h.calls[0].url, '/api/chat/articles/c1', 'Confirm: at the conversation\'s own URL');
  eq(h.state.activeConversationId, null, 'Confirm: the deleted conversation is deselected');
  eq(h.refreshes.length, 1, 'Confirm: the sidebar list was refreshed');
  eq(seenOpts.tone, 'danger', 'the dialog is opened in the danger tone');
  eq(seenOpts.message, 'My conversation', 'the conversation title is passed through verbatim (the dialog escapes it, not the caller)');
  ok(typeof seenOpts.onConfirm === 'function', 'the destructive work is handed in as onConfirm');
}

// A missing title must not produce a dialog that says "Delete ""?".
{
  let seenOpts = null;
  const h = makeDeleteHarness(async (opts) => { seenOpts = opts; });
  await h.fn('c1', '', 7);
  eq(seenOpts.message, 'this conversation', 'an untitled conversation gets a readable fallback');
}

// The mount guard still holds after the (now much longer) await window.
{
  const calls = [];
  const state = { activeDomain: 'articles', activeConversationId: 'c1', thread: [{ role: 'user' }] };
  const refreshes = [];
  const factory = new Function(
    'confirmThen', 'fetch', 'state', 'isCurrentMount', 'loadDomainConversations',
    extractFunction(chatSrc, 'deleteConversationRow', 'chat.js') + '\nreturn deleteConversationRow;');
  const fn = factory(
    async (opts) => { await opts.onConfirm(); },
    async (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return { ok: true, json: async () => ({}) }; },
    state,
    () => false, // the view re-mounted while the dialog was up
    async (...a) => { refreshes.push(a); },
  );
  await fn('c1', 'T', 7);
  eq(calls.length, 1, 'a stale mount still lets the DELETE complete (the server-side effect is wanted either way)');
  eq(state.activeConversationId, 'c1', 'but a stale mount never writes to the NEW mount\'s state');
  eq(refreshes.length, 0, 'and never re-renders a view it no longer owns');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Updates: the decision, including local-ahead-of-remote');
// ═════════════════════════════════════════════════════════════════════════

// `classifyUpdate` now delegates two things it used to not have: which update
// MECHANISM a payload describes, and the verdicts for the download-installer
// path. Both are pulled in so the assertions below still exercise the REAL
// function rather than a version of it that never took the fork. Behavioural
// coverage of the installer verdicts themselves is NOT here — it belongs to
// scripts/test-update-installer.js, which owns that feature. What this file
// keeps proving is that the GIT path is untouched, which is exactly what every
// payload below (none of which carries `updateStyle`) exercises.
const updateSandbox = new Function(
  extractFunction(settingsSrc, 'compareSemver', 'settings.js') + '\n' +
  extractFunction(settingsSrc, 'updateStyleOf', 'settings.js') + '\n' +
  extractFunction(settingsSrc, 'classifyInstallerUpdate', 'settings.js') + '\n' +
  extractFunction(settingsSrc, 'classifyUpdate', 'settings.js') + '\n' +
  'return { compareSemver, classifyUpdate, updateStyleOf };')();
const { compareSemver, classifyUpdate, updateStyleOf } = updateSandbox;

// The default that keeps every payload below on the unchanged path: a check
// result with no `updateStyle` is the git flow, which is what the repo arm has
// always returned and still returns byte-identically.
eq(updateStyleOf(undefined), 'git-pull', 'an absent check resolves to the git flow');
eq(updateStyleOf({}), 'git-pull', 'a payload with no updateStyle resolves to the git flow');
eq(updateStyleOf({ updateStyle: 'download-installer' }), 'download-installer', 'and the installer flow is opt-in by an explicit field');

eq(compareSemver('3.9.0', '3.8.0'), 1, 'compareSemver: 3.9.0 is newer than 3.8.0');
eq(compareSemver('3.8.0', '3.9.0'), -1, 'compareSemver: 3.8.0 is older than 3.9.0');
eq(compareSemver('3.9.0', '3.9.0'), 0, 'compareSemver: equal versions');
eq(compareSemver('3.10.0', '3.9.0'), 1, 'compareSemver: 3.10.0 > 3.9.0 (numeric, not lexicographic — the classic bug)');
eq(compareSemver('4.0.0', '3.99.99'), 1, 'compareSemver: major wins');
eq(compareSemver('3.9', '3.9.0'), 0, 'compareSemver: a missing segment counts as 0');
eq(compareSemver('3.0.1-beta.27', '3.0.1'), 0, 'compareSemver: a pre-release suffix collapses to its numeric core');
// Fail-safe direction: unparseable must NOT be read as "local is newer",
// because a positive result SUPPRESSES the update button.
eq(compareSemver('main', '3.9.0'), 0, 'compareSemver: an unparseable version collapses to 0, never to "local is newer"');
eq(compareSemver(null, '3.9.0'), 0, 'compareSemver: null collapses to 0');
eq(compareSemver(undefined, undefined), 0, 'compareSemver: undefined collapses to 0');
eq(compareSemver('1.2.3.4.5', '1.0.0'), 0, 'compareSemver: an absurd segment count collapses to 0 rather than guessing');

eq(classifyUpdate(null, null).kind, 'idle', 'no check yet -> idle (nothing is rendered)');
eq(classifyUpdate({ error: 'Could not reach GitHub' }, null).kind, 'error', 'a failed check -> error');
eq(classifyUpdate({ error: 'x' }, null).message, 'x', 'and it carries the server\'s message');

// THE branch this release exists to add: local ahead of published.
{
  const v = classifyUpdate(
    { current: '3.9.0', latest: '3.8.0', localCommit: 'aaaaaaa', remoteCommit: 'bbbbbbb', updateAvailable: true },
    { version: '3.9.0', onDiskVersion: '3.9.0', restartRequired: false });
  eq(v.kind, 'local-ahead',
    'local 3.9.0 vs published 3.8.0 -> local-ahead, NOT "update available" (the route reports updateAvailable for a difference in EITHER direction)');
  eq(v.current, '3.9.0', 'local-ahead reports the running version');
  eq(v.latest, '3.8.0', 'local-ahead reports the published version');
}

eq(classifyUpdate({ current: '3.8.0', latest: '3.9.0', updateAvailable: true }, null).kind, 'available',
  'local 3.8.0 vs published 3.9.0 -> available');
eq(classifyUpdate({ current: '3.8.0', latest: '3.9.0', updateAvailable: true }, null).versionsDiffer, true,
  'and the label reads as a version bump');
{
  const v = classifyUpdate(
    { current: '3.9.0', latest: '3.9.0', localCommit: 'aaaaaaa', remoteCommit: 'bbbbbbb', updateAvailable: true }, null);
  eq(v.kind, 'available', 'same version, different commits -> still available');
  eq(v.versionsDiffer, false, 'but flagged so the label reads "v3.9.0 (aaaaaaa -> bbbbbbb)", not "v3.9.0 -> v3.9.0"');
  eq(v.localCommit, 'aaaaaaa', 'the local sha is carried through');
}
eq(classifyUpdate({ current: '3.9.0', latest: '3.9.0', updateAvailable: false }, null).kind, 'current',
  'nothing to do -> current');

// Precedence: restart-required beats every remote comparison.
{
  const v = classifyUpdate({ current: '3.8.0', latest: '3.9.0', updateAvailable: true },
    { version: '3.8.0', onDiskVersion: '3.9.0', restartRequired: true });
  eq(v.kind, 'restart-required',
    'files already newer on disk -> restart-required, not another pull (re-pulling is not the fix)');
  eq(v.running, '3.8.0', 'it reports the RUNNING version');
  eq(v.onDisk, '3.9.0', 'and the on-disk version');
}
eq(classifyUpdate({ error: 'boom' }, { version: '1', onDiskVersion: '2', restartRequired: true }).kind, 'error',
  'a failed check beats restart-required — nothing else is actually known');

// ═════════════════════════════════════════════════════════════════════════
section('§6  Updates: applying is wired, gated, and never auto-fires');
// ═════════════════════════════════════════════════════════════════════════

ok(/fetch\('\/api\/config\/update',\s*\{\s*method:\s*'POST'\s*\}\)/.test(settingsCode),
  'the install action POSTs /api/config/update — the same route the shipping frontend uses');
ok(/fetch\('\/api\/restart',\s*\{\s*method:\s*'POST'\s*\}\)/.test(settingsCode),
  'and restarts afterwards via POST /api/restart');
ok(/location\.reload\(\)/.test(settingsCode),
  'and reloads the page once the new server answers, so the UI survives the restart');
ok(!/preview shell/.test(settingsCode) && !/shipping app’s Settings tab/.test(settingsCode),
  'the cutover-stale "use the shipping app\'s Settings tab" copy is gone from the code');

// The destructive POST is reachable ONLY from inside a confirm callback.
{
  const applyBody = extractFunction(settingsSrc, 'onApplyUpdate', 'settings.js');
  const runBody = extractFunction(settingsSrc, 'runUpdate', 'settings.js');
  ok(/confirmThen\(/.test(applyBody), 'onApplyUpdate() opens the confirm dialog');
  ok(/onConfirm:\s*\(\)\s*=>\s*runUpdate\(token\)/.test(applyBody),
    'and the POST only ever runs from inside onConfirm — clicking "Install update" alone cannot start it');
  ok(!/fetch\(/.test(applyBody),
    'onApplyUpdate() itself issues no request at all');
  ok(/\/api\/config\/update/.test(runBody), 'runUpdate() is where the POST lives');

  const restartBody = extractFunction(settingsSrc, 'onRestartOnly', 'settings.js');
  ok(/confirmThen\(/.test(restartBody) && /onConfirm:/.test(restartBody),
    'the restart-only path is behind the same dialog');
  ok(!/\/api\/config\/update\b/.test(restartBody),
    'and it never re-pulls — the files on disk are already the newer ones');
}

// The install button is gated on the cross-view write gate.
//
// The gate now resolves into a NAMED local (`updBusy`) instead of being called
// inline in the attribute, because the same predicate also decides whether the
// REASON renders. It used to be `disabled title="Wait for the running ingest
// or sync to finish"` — and a disabled button is out of the tab order, so that
// sentence was reachable only by hovering with a mouse. It is now box()'s
// warningText, i.e. visible text, for everyone.
//
// So this is asserted as a CHAIN rather than one regex: the button is gated on
// `updBusy`, `updBusy` IS `crossWriteBusy()`, and the reason is no longer a
// tooltip. Breaking any link fails.
ok(/const updBusy = crossWriteBusy\(\);/.test(settingsCode),
  'the update box resolves the cross-view write gate once, into a named local');
ok(/id="btn-apply-update"[\s\S]{0,200}updBusy \? ' disabled'/.test(settingsCode),
  'the Install button is disabled while an ingest or sync holds the write gate (the route 409s in that state anyway)');
ok(/box\('upd-attention'[\s\S]{0,300}updBusy \? 'Wait for the running ingest or sync to finish/.test(settingsCode),
  'and the REASON is box()s visible warning text, not a tooltip on a button no keyboard user can reach');
ok(!/disabled title="Wait for the running ingest/.test(settingsCode),
  'the hover-only form of that reason is gone and cannot come back unnoticed');

// ═════════════════════════════════════════════════════════════════════════
section('§7  runUpdate: partial success and failure, with a stubbed fetch');
// ═════════════════════════════════════════════════════════════════════════
// Every fetch below is this suite's own stub. The assertions on `calls`
// double as proof that no real request escaped.

function makeRunHarness(responses) {
  const calls = [];
  const state = { updatePhase: 'idle', updateResult: null, updateError: null, updateRestartHint: false };
  const polls = [];
  const factory = new Function(
    'state', 'isCurrentMount', 'render', 'fetch', 'pollForRestart',
    extractFunction(settingsSrc, 'runUpdate', 'settings.js') + '\nreturn runUpdate;');
  const fn = factory(
    state,
    () => true,
    () => {},
    async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET' });
      const r = responses[url];
      if (!r) return { ok: true, status: 200, json: async () => ({}) };
      if (r.throws) throw new Error(r.throws);
      return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
    },
    (t) => { polls.push(t); },
  );
  return { fn, calls, state, polls };
}

{
  // Clean success.
  const h = makeRunHarness({ '/api/config/update': { body: { ok: true, from: 'aaaaaaa', to: 'bbbbbbb' } } });
  await h.fn(1);
  eq(h.state.updatePhase, 'restarting', 'a clean update moves to the restarting phase');
  eq(h.state.updateResult.to, 'bbbbbbb', 'the after-sha is kept for the progress line');
  eq(h.calls.map((c) => c.url).join(' -> '), '/api/config/update -> /api/restart',
    'the order is update THEN restart, and nothing else is called');
  eq(h.polls.length, 1, 'the restart poll is started');
}

{
  // Partial: git succeeded, npm install did not.
  const h = makeRunHarness({ '/api/config/update': {
    body: { ok: true, partial: true, from: 'aaaaaaa', to: 'bbbbbbb', warning: 'npm could not be found under the running app’s PATH.' } } });
  await h.fn(1);
  eq(h.state.updatePhase, 'restarting',
    'a PARTIAL success still restarts — the restart is what loads the fixed updater');
  eq(h.state.updateResult.partial, true, 'the partial flag is preserved for the UI');
  eq(h.state.updateResult.warning, 'npm could not be found under the running app’s PATH.',
    'and the server’s warning text is preserved verbatim — dropping it presents a half-applied update as a clean one');
  eq(h.state.updateError, null, 'a partial success is NOT reported as a failure');
}

{
  // Hard failure: the route 500s. Nothing must restart.
  const h = makeRunHarness({ '/api/config/update': { ok: false, status: 500, body: { error: 'git fetch failed' } } });
  await h.fn(1);
  eq(h.state.updatePhase, 'failed', 'a failed update lands in the failed phase');
  eq(h.state.updateError, 'git fetch failed', 'and surfaces the server’s own message');
  eq(h.calls.length, 1, 'nothing was restarted after a failed update');
  eq(h.polls.length, 0, 'and no restart poll was started');
}

{
  // 409 from the write-registry guard.
  const h = makeRunHarness({ '/api/config/update': { ok: false, status: 409, body: {
    error: 'Cannot update the app while a write operation is running: articles (ingest). Please wait for it to finish, then try again.',
    conflict: 'write_in_progress' } } });
  await h.fn(1);
  eq(h.state.updatePhase, 'failed', 'a 409 refusal is a failure, not a silent no-op');
  ok(/articles \(ingest\)/.test(h.state.updateError),
    'and the refusal names what is actually blocking it');
  eq(h.calls.length, 1, 'a refused update never reaches /api/restart');
}

{
  // The network drops mid-POST.
  const h = makeRunHarness({ '/api/config/update': { throws: 'Failed to fetch' } });
  await h.fn(1);
  eq(h.state.updatePhase, 'failed', 'a transport failure is reported, not swallowed');
  eq(h.state.updateError, 'Failed to fetch', 'with the transport’s own message');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  CSS hygiene for the .cfd-* block');
// ═════════════════════════════════════════════════════════════════════════

// COMMENTS ARE STRIPPED BEFORE ANY OF THIS IS PARSED, and that is not
// tidiness. The first run of the assertions below went red on a PROSE
// COMMENT that names `var(--scrim, …)` while explaining why the code no
// longer uses it — the guard reported the very thing the comment says was
// removed. That is the same false positive v3.24.2's button scanner hit
// (a comment above a rule read as part of the selector, hiding three of
// five real bugs), reproduced here within one release of being recorded.
// Blanking to spaces of equal length keeps every index and line number
// intact, so nothing downstream has to know.
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
const cfdBlock = stripCssComments(sharedCss.slice(sharedCss.indexOf('.cfd-scrim {')));
ok(sharedCss.includes('.cfd-scrim {'), 'the dialog styles live in views/shared.css, which index.html already links');
// POSITIVE CONTROL for that strip: prove it actually removes a reference
// that is present in the raw text, so a strip that silently stopped
// working could not pass as "no findings".
{
  const probe = '.x { color: red; } /* mentions var(--not-a-real-token) in prose */';
  ok(/var\(--not-a-real-token\)/.test(probe) && !/var\(--not-a-real-token\)/.test(stripCssComments(probe)),
    'control: stripCssComments removes a var() written inside a comment, and the raw text really contained one');
  ok(stripCssComments(probe).length === probe.length,
    'control: …and it preserves length, so offsets and line numbers downstream stay correct');
  ok(/color:\s*red/.test(stripCssComments(probe)),
    'control: …while leaving real declarations intact — it is not just blanking everything');
}
ok(!/\bvar\(--scrim\b/.test(cfdBlock),
  'the retired `--scrim` name is not referenced — it was never defined anywhere, and its "exactly ONE reference" baseline is what forced five surfaces to each inline their own copy');

// ── THREE ASSERTIONS INVERTED, NOT DELETED ───────────────────────────────
// They read, in order:
//   'the scrim darkness is an INLINE rgba literal, never var(--scrim, …)'
//   'and it matches the darkness the two wizards already use'   [rgba(5,5,10,0.68)]
//   'the light theme is handled via [data-theme]'               [a .cfd-scrim override]
// All three were true and all three encoded the DUPLICATION as the
// invariant. `--scrim` was an undefined name carrying a hex fallback, and
// test-css-tokens.js asserted it had exactly one reference — so the rule
// "never var(--scrim)" was correct while the conclusion drawn from it
// ("inline the literal") gave five surfaces five private copies, which
// then drifted: dark agreed at 0.68, LIGHT split 0.42 / 0.5 three-to-two.
// `--modal-scrim` is a REAL definition in shell.css, so the token baseline
// shrinks to zero rather than growing, and the per-block [data-theme]
// override is gone because the TOKEN carries the theme now — one
// definition, one place for the light value to be right.
ok(/background:\s*var\(--modal-scrim\)/.test(cfdBlock),
  'the scrim reads the shared --modal-scrim token (was: an inline rgba literal, one of five copies)');
ok(!/rgba\(5,5,10/.test(cfdBlock) && !/rgba\(20,20,31/.test(cfdBlock),
  'and no rgba scrim literal survives in this block (was: asserted the literal was PRESENT and matched the wizards)');
ok(!/\[data-theme="light"\]\s*\.cfd-scrim/.test(cfdBlock),
  'no per-block light override — the token is themed at its definition (was: asserted this override existed)');
ok(/backdrop-filter:\s*blur\(6px\)/.test(cfdBlock),
  'the scrim carries backdrop-filter: blur(6px) — the design system scopes blur to exactly two places and the modal scrim is one of them; this dialog and chat-browse were the two that omitted it');
ok(/border-radius:\s*var\(--radius-xl\)/.test(cfdBlock),
  'the card is at --radius-xl (14px) — the bundle says "Modals 14px" in the readme, labels the 14px swatch "xl · modal" in the radius guideline, and sets it in Modal.jsx');
ok(!/prefers-color-scheme/.test(cfdBlock),
  'and never via prefers-color-scheme — the "system" default stamps no attribute, so a media query would disagree with the toggle');

// Every var() the new blocks reference must be a real token. This is a
// local echo of scripts/test-css-tokens.js, kept because an undefined
// custom property fails SILENTLY at computed-value time (the declaration is
// simply dropped) — there is no console error to notice.
const tokenDir = path.join(NEXT, 'tokens');
const definedTokens = new Set();
for (const f of readdirSync(tokenDir)) {
  const t = readFileSync(path.join(tokenDir, f), 'utf8');
  for (const m of t.matchAll(/(--[a-z0-9-]+)\s*:/g)) definedTokens.add(m[1]);
}
for (const m of sharedCss.matchAll(/(--[a-z0-9-]+)\s*:/g)) definedTokens.add(m[1]);
// shell.css too: it is linked globally by next/index.html and defines the
// app-level custom properties that are NOT design-system tokens —
// --app-sidebar-w, --prov-*, and (since the modal pass) --modal-scrim.
// Without it this local echo reports a false undefined for a property that
// resolves perfectly at runtime.
const shellCss = readFileSync(path.join(NEXT, 'shell.css'), 'utf8');
for (const m of shellCss.matchAll(/(--[a-z0-9-]+)\s*:/g)) definedTokens.add(m[1]);
ok(definedTokens.has('--modal-scrim'),
  'anti-vacuity: --modal-scrim really is defined in shell.css, so the undefined-ref check below is testing the right universe');
ok(definedTokens.size > 100, `sanity: ${definedTokens.size} tokens collected (an empty set would pass every check below)`);
const undefinedRefs = [];
for (const m of cfdBlock.matchAll(/var\((--[a-z0-9-]+)/g)) {
  if (!definedTokens.has(m[1])) undefinedRefs.push(m[1]);
}
ok(undefinedRefs.length === 0,
  undefinedRefs.length === 0
    ? 'every var() in the new .cfd-* / .upd-* CSS resolves to a defined token'
    : `undefined custom properties: ${[...new Set(undefinedRefs)].join(', ')}`);
ok(!/var\(--mono\b/.test(cfdBlock),
  'no var(--mono) — that name does not exist in this theme (the real one is --font-mono; the same slip shipped a live bug in v3.0.15)');

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
