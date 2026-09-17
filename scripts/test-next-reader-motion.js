/**
 * test-next-reader-motion.js — OFFLINE suite for the /next reader overlay's
 * entrance and dismissal (app.js renderReader() / openReader() /
 * dismissReader() / closeReader() + shell.css's `.reader-scrim` block).
 *
 * ── The bug this exists to stop coming back ─────────────────────────────
 * shell.css has carried a slide-and-fade for `.reader-scrim` and
 * `.reader-panel` since the overlay shipped, gated on an `.open` class. It
 * had NEVER PLAYED — not once, in any release up to and including v3.56.0 —
 * because renderReader() wrote `.open` into the markup string. An element
 * inserted already carrying its end-state class has never had a start state
 * to transition FROM, so the engine has nothing to interpolate and the rule
 * is simply the element's static style.
 *
 * MEASURED in Chrome over CDP, at the first animation frame after clicking a
 * wiki row on the Domains view, BEFORE the fix:
 *     scrim  opacity 1              (expected: 0, rising)
 *     panel  transform matrix(1,0,0,1,0,0)   (expected: translateX(28px))
 * i.e. finished one frame in. The maintainer reported it as "we are missing
 * transitions, it feels buggy".
 *
 * It is a two-sided invariant, and BOTH sides are silent when broken:
 *
 *   A. THE FIRST OPEN must insert WITHOUT `.open`, force a style flush, and
 *      only then add it. Drop the flush and the engine coalesces insertion
 *      and class-add into one style change — no transition, exactly the old
 *      symptom, with `.open` now correctly absent from the markup so the
 *      source reads as fixed.
 *
 *   B. EVERY LATER RENDER WHILE OPEN must patch in place. renderReader() is
 *      re-entered within milliseconds of the first open (loading placeholder
 *      -> fetched page), again from loadReaderSource(), and again on every
 *      backlink. Re-writing `#reader-root`'s innerHTML destroys the panel
 *      mid-transition and rebuilds it at its end state — which truncates the
 *      entrance at whatever fraction had played, and looks like a flicker or
 *      like no animation at all depending on how fast the fetch was. A
 *      LOCALHOST fetch is fast, so on the maintainer's machine it looks like
 *      no animation.
 *
 * And the dismissal has its own: `dismissReader()` (Esc / scrim / ✕) now
 * animates OUT, while `closeReader()` (navigate()) stays instant and
 * focus-neutral. The closing node has to stop being the reader the instant
 * the user asks — shell state closed, id/role/aria-modal stripped — or a
 * re-open mid-fade patches a corpse and two nodes answer to `#reader-scrim`.
 *
 * Sections 2-5 EXTRACT the real functions from app.js and EXECUTE them
 * against an instrumented fake DOM. That is this repo's established pattern
 * for a function whose module cannot be imported in Node (app.js has
 * module-scope `document` access and imports every views/*.js), and it is
 * the only thing that can answer "what does this function DO" rather than
 * "does this line exist" — the distinction v3.0.17 records at cost.
 *
 *   ENFORCED — a first open inserts without `.open` and then adds it, with a
 *              style flush in between; a content swap while open keeps
 *              `.open` from the first paint and does NOT replace the scrim
 *              node; a backlink render likewise; dismiss removes `.open`
 *              before the node leaves the DOM and strips its identity;
 *              dismiss under zero motion clears immediately; closeReader()
 *              stays instant and never animates; the scrim/panel transition
 *              rules still read `--t-enter` and the `.open` gate still
 *              exists in shell.css.
 *
 *   NOT ENFORCED (named, not implied away) —
 *     • That the motion looks good, or that 28px/180ms is the right
 *       amplitude. Browser-verified, numbers in the release notes.
 *     • That a real browser honours the flush. The forced style read is a
 *       documented idiom, not a spec guarantee with a testable signature;
 *       what is asserted here is that the code performs the read between the
 *       insert and the class-add, and the BROWSER measurement is what proves
 *       the transition then runs.
 *     • Cascade resolution, focus order, and anything about the reader's
 *       CONTENT — other suites own those.
 *     • The `transitionend` path. The fake DOM records the listener and the
 *       timer floor; a real transition event is a browser behaviour.
 *
 * Zero dependencies — node: builtins only.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_JS = path.join(ROOT, 'src/public/next/app.js');
const SHELL_CSS = path.join(ROOT, 'src/public/next/shell.css');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const appSrc = readFileSync(APP_JS, 'utf8');
const cssSrc = readFileSync(SHELL_CSS, 'utf8');

/** Brace-matched slice starting at `startIdx` (at or before the first `{`). */
function braceSlice(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
section('1. The pieces exist and can be extracted from app.js');

const NEEDED = [
  'function renderReader(',
  'export function openReader(',
  'export function closeReader(',
  'function dismissReader(',
  'function liveReaderScrim(',
  'function detachReaderScrim(',
];
for (const sig of NEEDED) {
  ok(appSrc.indexOf(sig) !== -1, `app.js declares ${sig.replace('export ', '').replace('(', '()')}`);
}

const closeTokMatch = appSrc.match(/const\s+READER_CLOSE_TOKEN\s*=\s*'(--dur-[a-z]+)'/);
ok(!!closeTokMatch, 'app.js names the close duration as a --dur-* TOKEN (never a number) — the JS wait and the CSS transition must resolve to one value');

// ─────────────────────────────────────────────────────────────────────────
section('2. A fake DOM small enough to be honest, big enough to run the reader');

/** A deliberately dumb element. Everything the reader touches is recorded in
 *  ONE ordered log, so an assertion can ask about SEQUENCE — which is the
 *  whole question here — rather than about end state, which is identical
 *  whether the transition played or not. */
function makeDom() {
  const log = [];
  let nid = 0;

  function makeEl(tag, cls) {
    const el = {
      _tag: tag,
      _id: 'n' + (++nid),
      _classes: new Set((cls || '').split(/\s+/).filter(Boolean)),
      _attrs: new Map(),
      _children: [],
      _listeners: [],
      parentNode: null,
      textContent: '',
      scrollTop: 0,
      get className() { return [...el._classes].join(' '); },
      classList: {
        add: (c) => { log.push({ op: 'class-add', el, c }); el._classes.add(c); },
        remove: (c) => { log.push({ op: 'class-remove', el, c }); el._classes.delete(c); },
        contains: (c) => el._classes.has(c),
      },
      setAttribute: (k, v) => { log.push({ op: 'setAttr', el, k, v }); el._attrs.set(k, v); },
      removeAttribute: (k) => { log.push({ op: 'removeAttr', el, k }); el._attrs.delete(k); },
      getAttribute: (k) => (el._attrs.has(k) ? el._attrs.get(k) : null),
      addEventListener: (t, fn) => { el._listeners.push({ t, fn }); },
      removeEventListener: (t, fn) => {
        log.push({ op: 'removeListener', el, t });
        const i = el._listeners.findIndex((l) => l.t === t && l.fn === fn);
        if (i !== -1) el._listeners.splice(i, 1);
      },
      removeChild: (child) => {
        log.push({ op: 'removeChild', el, child });
        const i = el._children.indexOf(child);
        if (i !== -1) el._children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      // The markup the reader emits is a fixed shape, so a full HTML parser
      // is not needed — and would be a second thing to get wrong. Only the
      // classes and ids the reader queries are modelled.
      set innerHTML(html) {
        log.push({ op: 'innerHTML', el, len: String(html).length, html: String(html) });
        for (const c of el._children) c.parentNode = null;
        el._children = [];
        if (!String(html).trim()) return;
        el._children = parseFixture(String(html), el);
      },
      get innerHTML() { return el._html || ''; },
      querySelector: (sel) => query(el, sel)[0] || null,
      querySelectorAll: (sel) => query(el, sel),
      _log: log,
    };
    return el;
  }

  /** Build the reader's known subtree from the emitted string. Recognises the
   *  four classes and two ids renderReader()/dismissReader() actually use. */
  function parseFixture(html, parent) {
    if (!/class="reader-scrim/.test(html)) {
      // A body fill. One opaque child is enough — nothing queries inside it
      // except the backlink rows, modelled below.
      const chunk = makeEl('div', 'reader-chunk');
      chunk.parentNode = parent;
      const rows = (html.match(/data-reader-backlink-index="(\d+)"/g) || []).map((m, i) => {
        const b = makeEl('button', 'reader-backlink-row');
        b._attrs.set('data-reader-backlink-index', String(i));
        b.dataset = { readerBacklinkIndex: String(i) };
        b.parentNode = chunk;
        return b;
      });
      chunk._children = rows;
      return [chunk];
    }
    const scrimClasses = (html.match(/class="(reader-scrim[^"]*)"/) || [])[1] || 'reader-scrim';
    const scrim = makeEl('div', scrimClasses);
    if (/id="reader-scrim"/.test(html)) scrim._attrs.set('id', 'reader-scrim');
    scrim.parentNode = parent;

    const panel = makeEl('div', 'reader-panel');
    if (/role="dialog"/.test(html)) panel._attrs.set('role', 'dialog');
    if (/aria-modal="true"/.test(html)) panel._attrs.set('aria-modal', 'true');
    panel.parentNode = scrim;

    const header = makeEl('div', 'reader-header');
    header.parentNode = panel;
    const pathEl = makeEl('span', 'reader-path mono');
    pathEl.parentNode = header;
    const closeBtn = makeEl('button', 'reader-close');
    closeBtn._attrs.set('id', 'reader-close-btn');
    closeBtn.parentNode = header;
    header._children = [pathEl, closeBtn];

    const body = makeEl('div', 'reader-body');
    body.parentNode = panel;
    const inner = (html.match(/<div class="reader-body">([\s\S]*)<\/div><\/div><\/div>$/) || [])[1] || '';
    body._children = parseFixture(inner, body);

    panel._children = [header, body];
    scrim._children = [panel];
    return [scrim];
  }

  /** Enough selector support for the five selectors the reader uses. */
  function query(root, sel) {
    const out = [];
    const not = /:not\(\.([\w-]+)\)/.exec(sel);
    const bare = sel.replace(/:not\([^)]*\)/, '').trim();
    const walk = (el) => {
      for (const c of el._children) {
        let hit = false;
        if (bare.startsWith('.')) hit = c._classes.has(bare.slice(1));
        else if (bare.startsWith('[')) {
          const k = bare.slice(1, -1).split('=')[0];
          hit = c._attrs.has(k);
        }
        if (hit && not && c._classes.has(not[1])) hit = false;
        if (hit) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  }

  const readerRoot = makeEl('div', '');
  readerRoot._attrs.set('id', 'reader-root');
  const backTarget = makeEl('button', '');
  backTarget._attrs.set('id', 'mem-ws-active');
  backTarget.focus = () => { log.push({ op: 'focus', el: backTarget }); };

  const byId = (id) => {
    if (id === 'reader-root') return readerRoot;
    if (id === 'mem-ws-active') return backTarget;
    const hits = query(readerRoot, '[' + 'id' + ']').filter((e) => e._attrs.get('id') === id);
    return hits[0] || null;
  };

  const document = { hidden: false, getElementById: byId };
  return { document, log, readerRoot, backTarget, query };
}

/** Extract and run app.js's real reader functions over the fake DOM. */
function buildReader({ durMid = '180ms', hidden = false } = {}) {
  const dom = makeDom();
  dom.document.hidden = hidden;

  const timers = [];
  const setTimeout_ = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const runTimers = () => { const q = timers.splice(0); for (const t of q) t.fn(); };

  const grab = (sig) => {
    const i = appSrc.indexOf(sig);
    if (i === -1) throw new Error('could not find ' + sig);
    return (braceSlice(appSrc, i) || '').replace(/^export\s+/, '');
  };
  const pick = (re, label) => {
    const m = appSrc.match(re);
    if (!m) throw new Error('could not extract ' + label);
    return m[0];
  };
  // A brace-matched object literal declaration (READER_TYPE_* are built with
  // Object.assign(Object.create(null), {...}), so a lazy regex mis-reads them).
  const grabDecl = (head) => {
    const i = appSrc.indexOf(head);
    if (i === -1) throw new Error('could not find ' + head);
    const body = braceSlice(appSrc, i);
    if (!body) throw new Error('could not brace-match ' + head);
    const end = appSrc.indexOf(';', i + body.length - 1);
    return appSrc.slice(i, end + 1);
  };

  const decls = [
    pick(/const\s+READER_CLOSE_TOKEN\s*=\s*'[^']+';/, 'READER_CLOSE_TOKEN'),
    pick(/const\s+READER_CLOSE_SLACK_MS\s*=\s*\d+;/, 'READER_CLOSE_SLACK_MS'),
    grabDecl('const READER_TYPE_CLASS ='),
    grabDecl('const READER_TYPE_DOT ='),
  ].join('\n');

  const fns = [
    'function resolvedMotionMs(',
    'function liveReaderScrim(',
    'function detachReaderScrim(',
    'function dismissReader(',
    'export function closeReader(',
    'function renderReader(',
  ].map(grab).join('\n\n');

  const prelude = `
    let readerEpoch = 0;
    const state = { reader: null };
    function icon() { return '<svg></svg>'; }
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function loadReaderSource() { log.push({ op: 'loadReaderSource' }); }
    function openReader(content) { readerEpoch += 1; state.reader = content || null; renderReader(); return readerEpoch; }
  `;

  const factory = new Function('document', 'getComputedStyle', 'setTimeout', 'console', 'log',
    `${prelude}\n${decls}\n${fns}\n` +
    'return { openReader, closeReader, dismissReader, renderReader, liveReaderScrim, state, epoch: () => readerEpoch };');

  const flushes = [];
  const getComputedStyle = (el) => {
    flushes.push({ el, at: dom.log.length });
    return { opacity: '0', getPropertyValue: () => durMid };
  };

  const api = factory(dom.document, getComputedStyle, setTimeout_, { error() {}, warn() {} }, dom.log);
  return { ...api, dom, log: dom.log, flushes, timers, runTimers };
}

{
  // The harness has to be able to FAIL, or it certifies nothing. Prove the
  // fixture models a scrim at all before asserting anything about one.
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', loading: true });
  const scrims = h.dom.query(h.dom.readerRoot, '.reader-scrim');
  ok(scrims.length === 1, 'the fixture yields exactly one .reader-scrim after an open');
  ok(!!scrims[0] && scrims[0]._children[0]?._classes.has('reader-panel'), '…containing a .reader-panel');
}

// ─────────────────────────────────────────────────────────────────────────
section('3. FIRST OPEN — inserted without `.open`, flushed, then opened');

{
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', loading: true });

  const writes = h.log.filter(e => e.op === 'innerHTML' && /reader-scrim/.test(e.html));
  ok(writes.length === 1, `exactly one overlay write for a first open (got ${writes.length})`);
  ok(writes.length === 1 && !/class="reader-scrim open/.test(writes[0].html),
    'THE FIX: the emitted markup does NOT carry `open` — an element inserted in its end state never transitions');

  const adds = h.log.filter(e => e.op === 'class-add' && e.c === 'open');
  ok(adds.length === 1, `…and `.concat('`open` is added exactly once afterwards (got ' + adds.length + ')'));

  const writeAt = h.log.indexOf(writes[0]);
  const addAt = h.log.indexOf(adds[0]);
  ok(writeAt !== -1 && addAt !== -1 && writeAt < addAt, 'the insert precedes the class-add');
  ok(h.flushes.length >= 1 && h.flushes.some(f => f.at > writeAt && f.at <= addAt),
    'THE FLUSH: a computed style is READ between the insert and the class-add — without it the two coalesce into one style change and nothing transitions');

  const scrim = h.dom.query(h.dom.readerRoot, '.reader-scrim')[0];
  ok(!!scrim && scrim._classes.has('open'), 'the scrim ends the task carrying `open`');
  ok(!!scrim && scrim._attrs.get('id') === 'reader-scrim', '…and carries the id the shell looks it up by');
}

// ─────────────────────────────────────────────────────────────────────────
section('4. CONTENT SWAP WHILE OPEN — patched in place, `.open` never lost');

{
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', loading: true });
  const firstScrim = h.dom.query(h.dom.readerRoot, '.reader-scrim')[0];
  const mark = h.log.length;

  // The real sequence: the loading placeholder is replaced by the fetched
  // page milliseconds later, well inside the 180ms the panel is sliding.
  h.openReader({
    slug: 'entities/a.md', title: 'A', type: 'entity', tags: ['x'],
    bodyHtml: '<p>hello</p>', backlinks: [{ path: 'entities/b.md', title: 'B' }],
    onBacklinkClick: () => {},
  });

  const after = h.log.slice(mark);
  ok(!after.some(e => e.op === 'innerHTML' && e.el === h.dom.readerRoot),
    'THE OTHER HALF: #reader-root is NOT rewritten — replacing the node rebuilds the panel at its end state and cuts the entrance short');
  const scrimNow = h.dom.query(h.dom.readerRoot, '.reader-scrim')[0];
  ok(scrimNow === firstScrim, 'the SAME scrim node survives the swap (identity, not just class equality)');
  ok(scrimNow._classes.has('open'), '…still carrying `open`');
  ok(!after.some(e => e.op === 'class-remove' && e.c === 'open'),
    '…and `open` is never removed and re-added, which would restart the transition from the top');
  ok(after.some(e => e.op === 'innerHTML' && e.el._classes.has('reader-body')),
    'the body IS refilled — the patch is a real update, not a no-op');

  // A backlink navigation is the same path, and must reset the reading
  // position: a fresh element used to start at scrollTop 0.
  const body = h.dom.query(h.dom.readerRoot, '.reader-body')[0];
  body.scrollTop = 420;
  h.openReader({ slug: 'entities/b.md', title: 'B', bodyHtml: '<p>b</p>', backlinks: [] });
  ok(body.scrollTop === 0, 'a backlink render scrolls the body back to the top');
}

// ─────────────────────────────────────────────────────────────────────────
section('5. DISMISS — `.open` off first, identity stripped, node removed after');

{
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', bodyHtml: '<p>a</p>', backlinks: [], returnFocusTo: 'mem-ws-active' });
  const scrim = h.dom.query(h.dom.readerRoot, '.reader-scrim')[0];
  const panel = scrim._children[0];
  const epochBefore = h.epoch();
  const mark = h.log.length;

  h.dismissReader();

  const after = h.log.slice(mark);
  const removeAt = after.findIndex(e => e.op === 'class-remove' && e.c === 'open');
  const gone = after.findIndex(e => e.op === 'removeChild' && e.child === scrim);
  ok(removeAt !== -1, '`open` is removed — the transition runs in reverse off the same gate');
  ok(gone === -1, 'THE NODE IS STILL IN THE DOM at the end of the task — a node removed immediately cannot fade');

  ok(h.state.reader === null, 'shell state is closed IMMEDIATELY — nothing may paint into a reader on its way out');
  ok(h.epoch() > epochBefore, '…and readerEpoch bumped, so isCurrentReader() answers no to every in-flight fetch');

  ok(scrim._classes.has('reader-closing'), 'the ghost is marked `reader-closing`');
  ok(scrim._attrs.get('id') !== 'reader-scrim', '…has lost the id, so nothing looks it up as the reader');
  ok(scrim.getAttribute('aria-hidden') === 'true', '…is hidden from assistive technology');
  ok(panel.getAttribute('role') === null && panel.getAttribute('aria-modal') === null,
    '…and is no longer a dialog, which is what lets focus move back out in the same task');

  ok(h.log.slice(mark).some(e => e.op === 'focus'), 'focus returns to `returnFocusTo` without waiting for the fade');

  // A re-open mid-fade must take the FIRST-OPEN path, not patch the corpse.
  // Asserted through the SHIPPED function, not through the harness's own
  // selector — a query written here proves what this file believes, which is
  // the one thing a guard must never certify.
  ok(h.liveReaderScrim() === null,
    'liveReaderScrim() no longer finds the ghost — a reader re-opened mid-fade must not patch a corpse');

  // …and the ghost leaves when its time is up.
  ok(h.timers.length === 1, `a single removal timer is armed as the floor (got ${h.timers.length})`);
  ok(h.timers[0].ms > 180, `…longer than the transition itself (got ${h.timers[0].ms}ms) — transitionend normally gets there first`);
  h.runTimers();
  ok(h.dom.query(h.dom.readerRoot, '.reader-scrim').length === 0, 'the ghost is gone once the fade is over');
}

{
  // RE-OPENING MID-FADE. The ghost is still in the DOM; the shell must build
  // a fresh overlay from the first-open path rather than patch the one that
  // is leaving, and must not leave two scrims answering to one id.
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', bodyHtml: '', backlinks: [] });
  h.dismissReader();
  const mark = h.log.length;
  h.openReader({ slug: 'entities/c.md', title: 'C', bodyHtml: '<p>c</p>', backlinks: [] });
  const reopen = h.log.slice(mark);
  ok(reopen.some(e => e.op === 'innerHTML' && /reader-scrim/.test(e.html) && !/reader-scrim open/.test(e.html)),
    'a re-open mid-fade rebuilds the overlay from the FIRST-OPEN path (without `open`)');
  ok(h.dom.query(h.dom.readerRoot, '.reader-scrim').length === 1,
    '…and exactly one scrim is left in #reader-root — the innerHTML write takes the ghost with it');
  ok(h.liveReaderScrim() !== null && h.liveReaderScrim()._classes.has('open'),
    '…and the survivor is the live one, opened');
}

{
  // Idempotence: the timer floor and transitionend must not both remove.
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', bodyHtml: '', backlinks: [] });
  const scrim = h.dom.query(h.dom.readerRoot, '.reader-scrim')[0];
  h.dismissReader();
  const end = scrim._listeners.find(l => l.t === 'transitionend');
  ok(!!end, 'a transitionend listener is attached — the accurate signal, with the timer as the floor');
  end.fn({ target: scrim });
  const removals = h.log.filter(e => e.op === 'removeChild' && e.child === scrim).length;
  h.runTimers();
  const removalsAfter = h.log.filter(e => e.op === 'removeChild' && e.child === scrim).length;
  ok(removals === 1 && removalsAfter === 1, 'removal is idempotent — transitionend and the timer cannot both take the node');
  // The `done` latch is what makes the SECOND finish a no-op. Counting the
  // detach is how that is observable: the node-removal count alone cannot
  // see it, because a removed node has no parent for a second attempt to
  // reach — which is a second, independent guard, not this one.
  const detaches = h.log.filter(e => e.op === 'removeListener' && e.t === 'transitionend').length;
  ok(detaches === 1, `the whole cleanup runs exactly ONCE (transitionend detached ${detaches} time(s)) — the second finish is a latched no-op, not an exception swallowed by a try/catch`);
}

{
  // REDUCE / hidden: no fade, no ghost, no timer. The reader just goes.
  for (const [label, opts] of [['reduced motion', { durMid: '0ms' }], ['a hidden document', { hidden: true }]]) {
    const h = buildReader(opts);
    h.openReader({ slug: 'entities/a.md', title: 'A', bodyHtml: '', backlinks: [] });
    h.dismissReader();
    ok(h.dom.query(h.dom.readerRoot, '.reader-scrim').length === 0,
      `under ${label} the overlay is cleared immediately`);
    ok(h.timers.length === 0, `…with no pending timer under ${label}`);
  }
}

{
  // closeReader() — navigate()'s path — must stay instant and must not
  // animate. A reader fading out over a column that is being replaced is the
  // "buggy" reading this release exists to remove.
  const h = buildReader();
  h.openReader({ slug: 'entities/a.md', title: 'A', bodyHtml: '', backlinks: [] });
  const mark = h.log.length;
  h.closeReader();
  ok(h.dom.query(h.dom.readerRoot, '.reader-scrim').length === 0, 'closeReader() clears the overlay in the same task');
  ok(h.timers.length === 0, '…arms no timer');
  ok(!h.log.slice(mark).some(e => e.op === 'focus'), '…and is focus-neutral (navigate() is about to replace that control)');
  ok(h.state.reader === null, '…and closes shell state');
}

// ─────────────────────────────────────────────────────────────────────────
section('6. shell.css still gates the motion on `.open`, via tokens');

{
  const strip = cssSrc.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const ruleFor = (sel) => {
    const re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
    const m = strip.match(re);
    return m ? m[2] : null;
  };

  const scrim = ruleFor('.reader-scrim');
  ok(!!scrim && /transition\s*:\s*opacity\s+var\(\s*--t-enter\s*\)/.test(scrim),
    '.reader-scrim transitions opacity on var(--t-enter)');
  ok(!!scrim && /opacity\s*:\s*0/.test(scrim),
    '…from opacity 0 — the start state the first-open insert depends on existing');

  const panel = ruleFor('.reader-panel');
  ok(!!panel && /transition\s*:[^;]*var\(\s*--t-enter\s*\)/.test(panel),
    '.reader-panel transitions on var(--t-enter)');
  ok(!!panel && /transform\s*:\s*translateX\(\s*-?\d+px\s*\)/.test(panel),
    '…and starts offset on X (a drawer moves on the axis it is attached to)');
  ok(!!panel && !/translateY/.test(panel),
    '…with no Y component — a vertical drift reads as a popover, not a drawer');

  ok(/\.reader-scrim\.open\b/.test(strip), 'the `.open` gate exists for the scrim');
  ok(/\.reader-scrim\.open\s+\.reader-panel\b/.test(strip), 'the `.open` gate exists for the panel');

  // The JS waits on READER_CLOSE_TOKEN; the CSS animates on --t-enter. If
  // those two ever name different durations the ghost is removed early (a
  // visible snap) or late (a dead node lingering).
  const motion = readFileSync(path.join(ROOT, 'src/public/next/tokens/motion.css'), 'utf8');
  const enterDur = (motion.match(/--t-enter\s*:\s*var\(\s*(--dur-[a-z]+)\s*\)/) || [])[1];
  ok(!!enterDur, 'tokens/motion.css defines --t-enter in terms of a --dur-* token');
  ok(!!closeTokMatch && enterDur === closeTokMatch[1],
    `app.js waits on ${closeTokMatch ? closeTokMatch[1] : '?'} and --t-enter resolves to ${enterDur} — they must be the same token`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next reader motion assertions green');
