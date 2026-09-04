/**
 * test-next-ingest-dropzone.js — OFFLINE suite.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * Reported from the Mac app: dragging files from Finder onto the Ingest drop
 * zone did NOTHING. "browse your files" / "Choose files" worked, including
 * multi-file batches, so the file-handling half of the feature was fine — it
 * was the drag half that never reached it.
 *
 * The cause was in views/ingest.js's own drag block. `dragover` called
 * setDragActive(true), which called render(), which goes renderMain ->
 * setMain -> `#view-root`.innerHTML = … . The element the pointer was holding
 * a file over was therefore DESTROYED by the drag's very first event and
 * replaced by a different node. Chromium then dispatches `dragleave` at the
 * old target when the drag target changes, which flipped the flag back and
 * rendered AGAIN, and the next `dragover` rendered a third time — so every
 * frame of the drag replaced the node under the cursor and the `drop` never
 * landed on an attached element. With no handler taking the drop, the browser
 * falls through to its default action for a file dropped on a page, which is
 * to NAVIGATE to it: in a tab that shows the PDF, in Electron it takes the
 * window off the app with no error and no visible way back. "Nothing
 * happens."
 *
 * ── WHY THE EXISTING SUITE COULD NOT SEE IT ──────────────────────────────
 * scripts/test-next-ingest-view.js §4 asserted, and was GREEN throughout:
 *
 *     "dragover only re-renders when the flag actually CHANGES"
 *
 * which is a statement about how OFTEN the destruction happens. Once is
 * enough. Nothing anywhere dispatched a drag event; the whole of §4 was
 * regexes over source text. This suite is the behavioural half: it builds a
 * DOM, mounts the real view functions against it, and DISPATCHES
 * dragenter / dragover / drop with a fake dataTransfer.
 *
 * ── ENFORCED (behaviourally, by dispatching real events) ─────────────────
 *  §1  SHIM SANITY / POSITIVE CONTROLS. The DOM model parses the real drop
 *      zone markup, event dispatch really bubbles, and setMain really
 *      replaces the subtree — without which every assertion below would pass
 *      for the wrong reason.
 *  §2  NODE IDENTITY SURVIVES THE DRAG. The `#ing-drop-zone` element object
 *      after dragenter + several dragovers is the SAME object, `===`, as
 *      before. This is the assertion the defect fails.
 *  §3  THE HANDSHAKE. dragenter and dragover both preventDefault and set
 *      dropEffect = 'copy'.
 *  §4  ONE FILE DROPPED reaches the single-file state — the same place the
 *      picker's `change` puts it.
 *  §5  THREE FILES DROPPED enter batch mode with all three selected.
 *  §6  THE ACTIVE CLASS IS CLEARED AFTER A DROP, on the live node.
 *  §7  A DROP CARRYING NOTHING still clears the active class (the stale
 *      "Release to add" defect).
 *  §8  THE DOCUMENT-LEVEL GUARDS: a file drop outside the zone is refused
 *      (so Electron cannot navigate to the file) and routed to the zone; a
 *      non-file drag is left alone; the guards come off at teardown.
 *  §9  desktop/main.js registers `will-navigate`. SOURCE-LEVEL and says so —
 *      Electron is not an offline-suite dependency, so main.js cannot be
 *      imported, evaluated or run here.
 * §10  ANTI-VACUITY. Every extraction and every dispatch is proven to have
 *      reached something.
 *
 * ── NOT ENFORCED, named rather than implied away ─────────────────────────
 *  - THIS IS A MODEL, NOT A BROWSER. It cannot prove what Chromium does with
 *    a drag whose target is removed, and it does not try to: it proves the
 *    view no longer removes it. The real-app check is a human with Finder.
 *  - The CSS copy swap (.ing-drop-hot / .ing-drop-idle) is asserted to EXIST
 *    as rules keyed off .ing-drop-zone-active. Which one a browser actually
 *    paints after cascade is not resolved here — no probe in this repo has
 *    ever computed that correctly without a real browser.
 *  - `will-navigate`'s BEHAVIOUR is not exercised. §9 proves the listener is
 *    registered and that the allow-rule compares origins against baseUrl; it
 *    cannot prove Electron delivers the event, or that a file:// drop is what
 *    triggers it. The maintainer's real-app check is the only test of that.
 *  - The OS-level drag cursor is not observable from here. §3 asserts
 *    dropEffect is assigned; whether macOS then draws the copy badge is not
 *    something any offline suite can see.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VIEW = path.join(ROOT, 'src/public/next/views/ingest.js');
const VIEW_CSS = path.join(ROOT, 'src/public/next/views/ingest.css');
const MAIN = path.join(ROOT, 'desktop/main.js');

const viewSrc = readFileSync(VIEW, 'utf8');
const viewCss = readFileSync(VIEW_CSS, 'utf8');
const mainSrc = readFileSync(MAIN, 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}
// `show` never uses JSON.stringify: half the values compared here are DOM
// nodes from the model, which hold parent links and are therefore circular.
// A failure message that THROWS turns a clean red into a crash, and a crash
// says nothing about which assertion failed — found by running the M1
// mutation, which crashed here instead of reporting.
function show(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    if (v.tagName) return `<${v.tagName.toLowerCase()}#${v.__id} class="${v.className}">`;
    return Object.prototype.toString.call(v);
  }
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}
function eq(a, b, label) { ok(a === b, label + (a === b ? '' : ` (got ${show(a)}, want ${show(b)})`)); }
function section(t) { console.log('\n' + t); }

// ═════════════════════════════════════════════════════════════════════════
// THE DOM MODEL
// ═════════════════════════════════════════════════════════════════════════
// Same approach as scripts/test-next-confirm-dialog.js §3: a purpose-built
// model, not jsdom (not a dependency, and this repo ships zero devDeps).
// It models exactly what this feature touches — element identity, parent
// links, class lists, a bubbling dispatch, closest/contains, and an innerHTML
// setter that really REPLACES the subtree, because "the node survived" is the
// whole claim and it is only worth anything against a setMain that genuinely
// destroys things.

function makeDom() {
  const docListeners = Object.create(null);
  const winListeners = Object.create(null);
  let idSeq = 0;

  function el(tag, attrs) {
    const node = {
      __id: ++idSeq,
      tagName: String(tag).toUpperCase(),
      attrs: attrs || {},
      children: [],
      parentNode: null,
      _text: '',
      _listeners: Object.create(null),
      disabled: false,
      get id() { return node.attrs.id || ''; },
      get className() { return node.attrs.class || ''; },
      set className(v) { node.attrs.class = String(v); },
      classList: {
        add(c) { if (!node.classList.contains(c)) node.attrs.class = ((node.attrs.class || '') + ' ' + c).trim(); },
        remove(c) {
          node.attrs.class = (node.attrs.class || '').split(/\s+/).filter((x) => x && x !== c).join(' ');
        },
        contains(c) { return (node.attrs.class || '').split(/\s+/).includes(c); },
        toggle(c, force) {
          const want = force === undefined ? !node.classList.contains(c) : !!force;
          if (want) node.classList.add(c); else node.classList.remove(c);
          return want;
        },
      },
      get textContent() {
        if (node.children.length === 0) return node._text;
        return node.children.map((c) => c.textContent).join('');
      },
      set textContent(v) { node.children = []; node._text = String(v); },
      get innerHTML() { return node._html || ''; },
      set innerHTML(html) {
        // Detach every descendant first, exactly as a real innerHTML write
        // does — a node that keeps its parent link would let a stale
        // reference still answer contains()/closest() and this suite would
        // report "the node survived" about a node the browser had thrown
        // away.
        const detach = (n) => { n.parentNode = null; n.children.forEach(detach); };
        node.children.forEach(detach);
        node._html = String(html);
        node.children = parseHtml(String(html), node);
      },
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      remove() {
        if (!node.parentNode) return;
        const i = node.parentNode.children.indexOf(node);
        if (i >= 0) node.parentNode.children.splice(i, 1);
        node.parentNode = null;
      },
      contains(other) {
        if (!other) return false;
        if (other === node) return true;
        return node.children.some((c) => c.contains(other));
      },
      closest(sel) {
        let n = node;
        while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
        return null;
      },
      descendants() { return node.children.flatMap((c) => [c, ...c.descendants()]); },
      querySelectorAll(sel) { return node.descendants().filter((d) => matches(d, sel)); },
      querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
      addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        const l = node._listeners[type]; if (!l) return;
        const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
      },
      focus() {},
      click() { dispatch(node, 'click', {}); },
      getAttribute(n) { return Object.prototype.hasOwnProperty.call(node.attrs, n) ? node.attrs[n] : null; },
    };
    return node;
  }

  // Supports the selector forms this view's handlers use: `#id`, `.class`,
  // `tag`, and `label`.
  function matches(node, selector) {
    return String(selector).split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
      if (part.startsWith('#')) return node.attrs.id === part.slice(1);
      if (part.startsWith('.')) return node.classList.contains(part.slice(1));
      return node.tagName === part.toUpperCase();
    });
  }

  // Tokenizer over the markup this view emits: open/close tags with quoted
  // attributes, plus text runs (which the model keeps only as a node's own
  // _text so textContent works).
  function parseHtml(html, parent) {
    const roots = [];
    const stack = [{ node: parent, list: roots }];
    const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+(?:="[^"]*")?)*)\s*\/?>/g;
    let last = 0;
    let m;
    const text = (s) => {
      const t = s.replace(/\s+/g, ' ');
      if (!t.trim()) return;
      const top = stack[stack.length - 1];
      if (top.node && top.node.children.length === 0) top.node._text += t;
    };
    while ((m = re.exec(html)) !== null) {
      text(html.slice(last, m.index));
      last = re.lastIndex;
      if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      const ar = /([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = ar.exec(m[2])) !== null) { if (a[1]) attrs[a[1]] = a[2] === undefined ? '' : a[2]; }
      const node = el(m[1], attrs);
      const top = stack[stack.length - 1];
      node.parentNode = top.node;
      top.list.push(node);
      if (top.node) top.node.children = top.list;
      const selfClosing = /\/>$/.test(m[0]) || /^(input|img|br|hr|meta|link|path|circle|source)$/i.test(m[1]);
      if (!selfClosing) stack.push({ node, list: node.children });
    }
    text(html.slice(last));
    return roots;
  }

  // A real bubbling dispatch. `currentTarget` is not modelled (nothing under
  // test reads it); `target` is the deepest node, which is what the drop
  // guard's `e.target.closest(...)` needs.
  function dispatch(target, type, init) {
    const e = Object.assign({
      type,
      target,
      defaultPrevented: false,
      preventDefault() { e.defaultPrevented = true; },
      stopPropagation() { e.__stopped = true; },
    }, init || {});
    let n = target;
    const chain = [];
    while (n) { chain.push(n); n = n.parentNode; }
    for (const node of chain) {
      (node._listeners[type] || []).slice().forEach((fn) => fn(e));
      if (e.__stopped) return e;
    }
    // Then document, then window — the model's stand-in for the rest of the
    // propagation path. installDocumentDragGuards binds on document.
    (docListeners[type] || []).slice().forEach((fn) => fn(e));
    (winListeners[type] || []).slice().forEach((fn) => fn(e));
    return e;
  }

  const root = el('div', { id: 'view-root' });
  const sidebar = el('div', { id: 'sidebar' });
  const body = el('body', {});
  body.appendChild(root);
  body.appendChild(sidebar);

  const document = {
    body,
    hidden: false,
    createElement: (tag) => el(tag, {}),
    getElementById(id) {
      const hit = body.querySelectorAll('#' + id);
      return hit[0] || null;
    },
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = docListeners[type]; if (!l) return;
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
  };
  const window = {
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = winListeners[type]; if (!l) return;
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    localStorage: null,
  };

  return {
    document, window, root, sidebar, body, el, dispatch,
    docListenerCount: (type) => (docListeners[type] || []).length,
    winListenerCount: (type) => (winListeners[type] || []).length,
  };
}

/** A File-like object: the two fields this view actually reads. */
function fakeFile(name, size) { return { name, size, type: '', __isFile: true }; }

/** A DataTransfer-like object. `types` carries 'Files' exactly when files do. */
function fakeTransfer(files, types) {
  const list = files || [];
  const dt = {
    files: Object.assign(list.slice(), { length: list.length, item: (i) => list[i] }),
    types: types || (list.length ? ['Files'] : []),
    dropEffect: 'none',
  };
  return dt;
}

// ═════════════════════════════════════════════════════════════════════════
// LOADING THE REAL VIEW
// ═════════════════════════════════════════════════════════════════════════
// Imports are stripped and every imported name is supplied as a parameter.
// The shared modules are imported FOR REAL where Node can load them, so the
// logic under them (dedupeQueueFiles in particular, which decides what a
// multi-file drop turns into) is the shipping implementation and not a
// stand-in that could agree with a broken view. listbox.js touches `document`
// at module scope and cannot be imported here; its three functions are
// stubbed, and nothing in this suite is about the listbox.

const logic = await import('../src/public/next/shared/ingest-queue-logic.js');
const text = await import('../src/public/next/shared/text.js');
const usd = await import('../src/public/next/shared/format-usd.js');
const ring = await import('../src/public/next/shared/progress-ring.js');
const gate = await import('../src/public/next/shared/loading-gate.js');

let strippedControlDone = false;
function loadView(dom) {
  const stripped = viewSrc.replace(/^import\s[\s\S]*?;$/gm, '');
  // Asserted ONCE — loadView runs per mount, and a control repeated a dozen
  // times inflates the pass count without proving anything a dozen times.
  if (!strippedControlDone) {
    strippedControlDone = true;
    ok(!/^import\s/m.test(stripped), '§1 CONTROL — every import statement was stripped before evaluation');
    ok(/function wireListeners\(/.test(stripped) && /function setDragActive\(/.test(stripped),
      '§1 CONTROL — …and the functions under test survived the strip');
  }

  const registered = {};
  const appStubs = {
    registerView: (name, cfg) => { registered.name = name; registered.cfg = cfg; },
    setSidebar: (html) => { dom.sidebar.innerHTML = '<div class="sidebar-inner">' + html + '</div>'; },
    // THE ONE THAT MATTERS. Modelled on app.js's real setMain, which is
    // `#view-root`.innerHTML = '<div class="main-inner">' + html + '</div>'.
    // If this were a no-op the whole suite would be vacuous: the defect IS
    // this line running mid-drag.
    setMain: (html) => { dom.root.innerHTML = '<div class="main-inner">' + html + '</div>'; },
    eyebrow: (s) => '<div class="eyebrow">' + s + '</div>',
    emptyCard: (o) => '<div class="empty">' + (o && o.title || '') + '</div>',
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    icon: () => '<svg></svg>',
    isCurrentMount: () => true,
    reportAsyncMountFailure: () => {},
    reportAsyncActionFailure: () => {},
    beginDomainWrite: () => () => {},
    isDomainWriteBusy: () => false,
    getDomainWriteLabel: () => null,
    onWriteGateChange: () => () => {},
    reportPossibleActiveJob: () => {},
  };
  const listboxStubs = {
    renderListboxHtml: () => '<div class="lb-block"></div>',
    mountListbox: () => {},
    closeAllListboxes: () => {},
  };

  const provided = {
    ...appStubs, ...listboxStubs,
    ...logic, ...text, ...usd, ...ring, ...gate,
    document: dom.document,
    window: dom.window,
    localStorage: null,
    // Nothing in this suite exercises a network path; a fetch that resolves
    // to a never-ok response keeps the estimate call from throwing at all,
    // and its state lands in an error branch this suite does not read.
    fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) }),
    FormData: class { append() {} },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
  };

  const names = Object.keys(provided);
  const factory = new Function(...names, stripped +
    '\nreturn { registerViewCfg: null, wireListeners, handleSelectedFiles, setDragActive, ' +
    'installDocumentDragGuards, dragCarriesFiles, render, renderDropZoneHtml, ' +
    'getState: () => state, setState: (patch) => { Object.assign(state, patch); } };');
  const api = factory(...names.map((n) => provided[n]));
  api.registered = registered;
  return api;
}

/**
 * Mounts the view into the model DOM with one domain and no job.
 *
 * `guards: false` leaves the DOCUMENT-level drag guards off, so the zone's
 * own listeners can be judged alone. That option is not tidiness — it was
 * added because mutation M2 (delete dragenter's preventDefault) came back
 * GREEN: the document guard cancels dragenter too, so §3 was passing on the
 * strength of a handler it was not testing. A guard standing in for the thing
 * under test is exactly the vacuous shape this repo keeps re-learning.
 */
function mount(opts) {
  const dom = makeDom();
  const view = loadView(dom);
  view.setState({
    loadingDomains: false, domainsError: null,
    domains: [{ slug: 'articles', displayName: 'Articles' }],
    domain: 'articles',
  });
  view.render('t');
  const removeGuards = (opts && opts.guards === false) ? () => {} : view.installDocumentDragGuards('t');
  return { dom, view, removeGuards, zone: () => dom.document.getElementById('ing-drop-zone') };
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  Shim sanity and positive controls');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, zone } = mount();
  const z = zone();
  ok(!!z, '§1 the real renderDropZoneHtml markup parsed into a node with id ing-drop-zone');
  ok(!!dom.document.getElementById('ing-file-input'), '§1 …and the hidden multi-file input is in it');
  ok(z.classList.contains('ing-drop-zone'), '§1 …carrying its class');
  ok(!z.classList.contains('ing-drop-zone-active'), '§1 …idle at rest');

  // The dispatch really bubbles: a listener on the zone hears an event fired
  // at a descendant. Without this, §2's "identity survived" could be true
  // because nothing ever reached a handler.
  let heard = 0;
  z.addEventListener('probe', () => { heard++; });
  const headline = z.querySelector('.ing-drop-headline');
  ok(!!headline, '§1 CONTROL — the headline is a real descendant of the zone');
  dom.dispatch(headline, 'probe', {});
  eq(heard, 1, '§1 CONTROL — dispatch bubbles from a descendant to the zone');

  // setMain really destroys. This is the load-bearing control for §2.
  const before = zone();
  view.render('t');
  const after = zone();
  ok(before !== after,
    '§1 CONTROL — a render REALLY replaces the zone node (before !== after), so ' +
    '§2\'s identity check is capable of failing');
  ok(before.parentNode === null,
    '§1 CONTROL — …and the replaced node is detached, not merely shadowed');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  The drop target survives the drag — THE reported defect');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, zone } = mount();
  const original = zone();
  const dt = fakeTransfer([fakeFile('a.pdf', 1000)]);

  dom.dispatch(original, 'dragenter', { dataTransfer: dt });
  eq(zone(), original, '§2 the zone is the SAME NODE OBJECT after dragenter');

  for (let i = 0; i < 6; i++) dom.dispatch(zone(), 'dragover', { dataTransfer: dt });
  eq(zone(), original, '§2 …and after six dragovers — the defect replaced it on the first');
  ok(original.parentNode !== null, '§2 …and it is still attached to the document');
  ok(original.classList.contains('ing-drop-zone-active'),
    '§2 …with the active class applied to the LIVE node, so the user still gets ' +
    'the "release to add" state the re-render used to buy');

  // A dragleave onto a CHILD is not a leave, and must not reset anything.
  const icon = original.querySelector('.ing-drop-icon');
  dom.dispatch(original, 'dragleave', { dataTransfer: dt, relatedTarget: icon });
  ok(original.classList.contains('ing-drop-zone-active'),
    '§2 a dragleave whose relatedTarget is INSIDE the zone does not clear the state');
  eq(zone(), original, '§2 …and still does not replace the node');

  // A dragleave to outside DOES clear it — still without a render.
  dom.dispatch(original, 'dragleave', { dataTransfer: dt, relatedTarget: dom.sidebar });
  ok(!original.classList.contains('ing-drop-zone-active'),
    '§2 a dragleave to OUTSIDE the zone clears the active class');
  eq(zone(), original, '§2 …by mutation, not by replacement');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  The drag handshake — dragenter and dragover are both cancelled');
// ═════════════════════════════════════════════════════════════════════════
// MOUNTED WITHOUT THE DOCUMENT GUARDS. See mount()'s comment: with them on,
// every assertion in this section passed on the document guard's
// preventDefault rather than the zone's, and deleting the zone's dragenter
// handshake left the suite green.
{
  const { dom, zone } = mount({ guards: false });
  const dt = fakeTransfer([fakeFile('a.pdf', 1000)]);

  // The isolation is real, and this proves it: an event type NOTHING handles
  // comes back un-cancelled. Without this control, a model that silently
  // cancelled everything would make the whole section vacuous.
  const inert = dom.dispatch(zone(), 'dragexit', { dataTransfer: dt });
  ok(!inert.defaultPrevented,
    '§3 CONTROL — with the document guards off, an unhandled drag event is NOT ' +
    'cancelled, so the greens below are the zone\'s own handlers speaking');

  const enter = dom.dispatch(zone(), 'dragenter', { dataTransfer: dt });
  ok(enter.defaultPrevented,
    '§3 dragenter is preventDefault\'d — the drag-and-drop model decides the ' +
    'current target element from whether dragenter was cancelled, and a zone ' +
    'that answers only half the handshake is relying on browser forgiveness');
  eq(dt.dropEffect, 'copy', '§3 …and dragenter sets dropEffect to copy');

  dt.dropEffect = 'none';
  const over = dom.dispatch(zone(), 'dragover', { dataTransfer: dt });
  ok(over.defaultPrevented, '§3 dragover is preventDefault\'d');
  eq(dt.dropEffect, 'copy', '§3 …and sets dropEffect to copy, so the OS draws a copy cursor');

  // Fired at a CHILD, which is what actually happens: the deepest element
  // under the pointer is the headline or the icon, not the zone itself.
  dt.dropEffect = 'none';
  const child = dom.dispatch(zone().querySelector('.ing-drop-headline'), 'dragover', { dataTransfer: dt });
  ok(child.defaultPrevented,
    '§3 a dragover fired at a CHILD of the zone is cancelled too (it bubbles) — ' +
    'the pointer is over the headline or the icon far more often than over the ' +
    'zone\'s own box');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  One file dropped lands in the single-file state');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, zone } = mount();
  const dt = fakeTransfer([fakeFile('paper.pdf', 4096)]);
  dom.dispatch(zone(), 'dragenter', { dataTransfer: dt });
  dom.dispatch(zone(), 'dragover', { dataTransfer: dt });
  const drop = dom.dispatch(zone(), 'drop', { dataTransfer: dt });

  ok(drop.defaultPrevented,
    '§4 drop is preventDefault\'d — an un-cancelled file drop makes the browser ' +
    'navigate to the file, which in Electron takes the window off the app');
  const st = view.getState();
  ok(!!st.file, '§4 a single dropped file reached state.file');
  eq(st.file.name, 'paper.pdf', '§4 …and it is the file that was dropped');
  eq(st.queueModeActive, false, '§4 …on the single-file path, not the batch path');
  eq(st.fileError, null, '§4 …with no validation error for an accepted extension');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Three files dropped start a batch');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, zone } = mount();
  const files = [fakeFile('a.md', 10), fakeFile('b.md', 20), fakeFile('c.pdf', 30)];
  const dt = fakeTransfer(files);
  dom.dispatch(zone(), 'dragenter', { dataTransfer: dt });
  dom.dispatch(zone(), 'drop', { dataTransfer: dt });

  const st = view.getState();
  eq(st.queueModeActive, true, '§5 three files at once enter batch mode');
  eq(st.selectedFiles.length, 3, '§5 …with all three selected (nothing is dropped on the floor)');
  eq(st.selectedFiles.map((f) => f.name).join(','), 'a.md,b.md,c.pdf', '§5 …and they are the three that were dropped');
  eq(st.file, null, '§5 …and the single-file slot is cleared, so the two paths cannot both be live');

  // The confirm gate re-renders a zone, and a SECOND drop must ACCUMULATE
  // onto the batch rather than replace it (the ported defect #1).
  const gateZone = dom.document.getElementById('ing-drop-zone');
  ok(!!gateZone, '§5 the confirm gate renders its own drop zone — "drop more files here"');
  dom.dispatch(gateZone, 'drop', { dataTransfer: fakeTransfer([fakeFile('d.txt', 40)]) });
  eq(view.getState().selectedFiles.length, 4,
    '§5 a second drop ACCUMULATES onto the batch rather than replacing it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  The active class is cleared after a drop');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, zone } = mount();
  const original = zone();
  const dt = fakeTransfer([fakeFile('one.md', 5)]);
  dom.dispatch(original, 'dragenter', { dataTransfer: dt });
  ok(original.classList.contains('ing-drop-zone-active'), '§6 setup: the zone is hot');
  dom.dispatch(original, 'drop', { dataTransfer: dt });
  eq(view.getState().dragActive, false, '§6 the flag is cleared by the drop');
  // A single-file drop DOES re-render (the drag is over by then, so that is
  // safe and correct) — so the assertion is about whatever zone is on screen.
  const now = dom.document.getElementById('ing-drop-zone');
  ok(!!now && !now.classList.contains('ing-drop-zone-active'),
    '§6 …and the zone on screen is not left reading "Release to add"');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  A drop carrying nothing still clears the state');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, zone } = mount();
  const original = zone();
  const empty = fakeTransfer([], ['Files']);
  dom.dispatch(original, 'dragenter', { dataTransfer: empty });
  ok(original.classList.contains('ing-drop-zone-active'), '§7 setup: the zone is hot');
  dom.dispatch(original, 'drop', { dataTransfer: empty });
  eq(view.getState().dragActive, false,
    '§7 a drop that carried no usable file clears the flag — it used to be ' +
    'written directly with no repaint, and handleSelectedFiles then returned ' +
    'early, leaving the zone stuck on "Release to add"');
  eq(zone(), original, '§7 …without replacing the node');
  ok(!original.classList.contains('ing-drop-zone-active'),
    '§7 …and the class is off the LIVE node, not merely off the state object');
  eq(view.getState().file, null, '§7 …and nothing was invented to ingest');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  The document-level guards — a miss must not navigate the window');
// ═════════════════════════════════════════════════════════════════════════
{
  const { dom, view, removeGuards, zone } = mount();
  const dt = fakeTransfer([fakeFile('missed.pdf', 99)]);

  const over = dom.dispatch(dom.sidebar, 'dragover', { dataTransfer: dt });
  ok(over.defaultPrevented,
    '§8 a file dragged over the view but NOT over the zone is still cancelled — ' +
    'an un-cancelled file drop navigates the window to file:///…, which in ' +
    'Electron is indistinguishable from the app breaking');

  const drop = dom.dispatch(dom.sidebar, 'drop', { dataTransfer: dt });
  ok(drop.defaultPrevented, '§8 …and so is the drop');
  eq(view.getState().file && view.getState().file.name, 'missed.pdf',
    '§8 …and the file is routed to the zone anyway, so aiming is not a ' +
    'requirement of the feature');

  // A drop INSIDE the zone must not be counted twice: the zone's own handler
  // takes it, and the document guard sees the same event on the way up.
  const { dom: d2, view: v2, zone: z2 } = mount();
  d2.dispatch(z2(), 'drop', { dataTransfer: fakeTransfer([fakeFile('x.md', 1), fakeFile('y.md', 2)]) });
  eq(v2.getState().selectedFiles.length, 2,
    '§8 a drop inside the zone is handled ONCE — the document guard defers to ' +
    'the zone rather than adding the same files a second time');

  // A non-file drag (a text selection inside the app) is left entirely alone.
  const textDrag = fakeTransfer([], ['text/plain']);
  const textOver = dom.dispatch(dom.sidebar, 'dragover', { dataTransfer: textDrag });
  ok(!textOver.defaultPrevented,
    '§8 a drag carrying NO files is not touched — dragging a text selection ' +
    'inside a field must keep working');

  // Teardown really removes them.
  const before = dom.docListenerCount('drop');
  ok(before > 0, '§8 CONTROL — a document drop guard was installed');
  removeGuards();
  eq(dom.docListenerCount('drop'), 0, '§8 the guards come off at teardown');
  eq(dom.docListenerCount('dragover'), 0, '§8 …all of them');
  eq(dom.winListenerCount('blur'), 0, '§8 …including the window-level one');

  // And the view wires that teardown into its own.
  ok(/removeDocumentDragGuards\(\);\s*removeDocumentDragGuards = null;/.test(viewSrc),
    '§8 the view\'s registerView teardown calls the remover — a guard left ' +
    'behind would keep swallowing drops for the life of the page');
  ok(/installDocumentDragGuards\(mountToken\)/.test(viewSrc),
    '§8 …and it is installed from onEnter, NOT from wireListeners, which runs ' +
    'on every render and would stack a new set of listeners each time');
  ok(!/wireListeners[\s\S]{0,4000}installDocumentDragGuards/.test(
    viewSrc.slice(viewSrc.indexOf('function wireListeners('))),
    '§8 CONTROL — wireListeners does not install them');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  desktop/main.js refuses to navigate away — SOURCE SCAN, weak by nature');
// ═════════════════════════════════════════════════════════════════════════
// Electron is deliberately not an offline-suite dependency, so main.js cannot
// be imported, evaluated or run here — the same limit test-desktop-menu.js §11
// records. This proves the wiring is present and that the allow-rule is
// written against baseUrl's origin; it cannot prove Electron delivers the
// event or that the handler behaves. The maintainer's real-app check is the
// only test of that, and this file says so rather than implying otherwise.
{
  ok(/webContents\.on\('will-navigate'/.test(mainSrc),
    '§9 main.js registers a will-navigate listener — without it, a file drop ' +
    'that no renderer handler cancels takes the window to file:///… with no ' +
    'address bar and no visible way back');
  ok(/webContents\.on\('will-frame-navigate'/.test(mainSrc),
    '§9 …and will-frame-navigate, which covers a frame will-navigate does not');
  const guard = /const staysInApp = \(url\) => \{[\s\S]*?\n  \};/.exec(mainSrc);
  ok(!!guard, '§9 CONTROL — the same-origin predicate was located');
  if (guard) {
    ok(/new URL\(url\)\.origin === new URL\(baseUrl\)\.origin/.test(guard[0]),
      '§9 the allow-rule compares ORIGINS against baseUrl — a substring or ' +
      'prefix test would let http://127.0.0.1:3333.evil.example through');
    ok(/catch \{ return false; \}/.test(guard[0]),
      '§9 …and an unparseable URL is refused rather than allowed');
  }
  const handler = /const refuseForeignNavigation = \([\s\S]*?\n  \};/.exec(mainSrc);
  ok(!!handler, '§9 CONTROL — the handler was located');
  if (handler) {
    ok(/if \(staysInApp\(url\)\) return;/.test(handler[0]),
      '§9 same-origin navigation is allowed through — Settings\' post-update ' +
      'location.reload() and the boot panel\'s reload button both depend on it');
    ok(/event\.preventDefault\(\)/.test(handler[0]), '§9 anything else is refused');
    ok(/shell\.openExternal\(url\)/.test(handler[0]),
      '§9 …and an external http(s) URL is opened in the real browser, matching ' +
      'setWindowOpenHandler so a link behaves the same either way');
  }
  ok(/dropped file/i.test(mainSrc),
    '§9 the comment names the file-drop case, so the next reader knows what ' +
    'this guard is for rather than deleting it as defensive clutter');
  // Window options were NOT touched by this change.
  ok(/titleBarStyle: 'default'/.test(mainSrc),
    '§9 CONTROL — titleBarStyle is untouched by this change');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10  The copy swap is CSS, and the anti-vacuity floor');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/\.ing-drop-hot\s*\{\s*display:\s*none/.test(viewCss),
    '§10 the drag-over sentence is hidden by default');
  ok(/\.ing-drop-zone-active \.ing-drop-idle\s*\{\s*display:\s*none/.test(viewCss),
    '§10 …and the two swap on .ing-drop-zone-active');
  ok(/\.ing-drop-zone-active \.ing-drop-hot\s*\{\s*display:\s*inline/.test(viewCss),
    '§10 …in both directions');
  ok(/\.ing-drop-zone-active \.ing-drop-sub\s*\{\s*visibility:\s*hidden/.test(viewCss),
    '§10 the "browse your files" line is hidden by VISIBILITY, so its box keeps ' +
    'its height and the panel does not reflow the instant a drag arrives — and ' +
    'so the <label> node inside it is never destroyed mid-drag');

  const zoneHtml = /function renderDropZoneHtml\(\{[\s\S]*?\n\}/.exec(viewSrc);
  ok(!!zoneHtml, '§10 CONTROL — renderDropZoneHtml was located');
  if (zoneHtml) {
    ok(/ing-drop-idle/.test(zoneHtml[0]) && /ing-drop-hot/.test(zoneHtml[0]),
      '§10 BOTH sentences are emitted at once, so changing which one shows ' +
      'requires no DOM write at all');
    ok(/Release to add/.test(zoneHtml[0]),
      '§10 the drag-over copy still says what letting go will DO');
  }

  // Anti-vacuity: this suite must still be dispatching real drag events into
  // real handlers. A shim desync that silently stopped reaching them would
  // report zero failures forever.
  const { dom, zone } = mount();
  const z = zone();
  const types = ['dragenter', 'dragover', 'dragleave', 'drop'];
  const wired = types.filter((t) => (z._listeners[t] || []).length > 0);
  eq(wired.length, types.length,
    '§10 ANTI-VACUITY — all four drag listeners are really attached to the ' +
    'parsed zone (' + wired.join(', ') + ')');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed > 0) {
  console.log('❌ ' + failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('✅ all green');
