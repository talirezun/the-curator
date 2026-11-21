/* tray-popover-paint.js — the PAINTER of the Windows tray popover (v4.1.0).
 *
 * A CLASSIC script, not an ES module: the page is loaded over file:// by
 * desktop/lib/tray-popover.js, and module scripts over file:// are not a path
 * this app trusts (CORS treats the file: origin as opaque). Everything lives in
 * one IIFE; the only global it leaves is `CuratorTrayPaint`, which the offline
 * suite (scripts/test-tray-popover-paint.js) drives against a fake DOM.
 *
 * WHAT IT DECIDES: nothing about facts. Every label, sublabel, order, image
 * and action id comes from the payload that desktop/lib/tray-popover-model.js
 * builds out of the SAME template the native menu is built from (parity by
 * construction). This file only turns that tree into nodes, moves a roving
 * focus, and opens drill pages locally. The payload contract is
 * CONTRACT-tray-popover.md (v: 1).
 *
 * THE ONE CHANNEL: window.curatorTray, exposed by
 * desktop/lib/tray-popover-preload.js — onModel(cb), act(gen, id), size(h),
 * painted(gen, rows), dismiss(). Without it (the page opened in a browser)
 * nothing is drawn: the page is inert.
 *
 * ESCAPE-FIRST: model text is only ever written with `textContent` or as an
 * attribute value through setAttribute. There is no innerHTML anywhere in this
 * file, and the suite proves a label of `<img src=x onerror=…>` stays text.
 */
(function (root) {
  'use strict';

  var CONTRACT_VERSION = 1;
  var MAX_ID_CHARS = 200;
  var DATA_PNG = 'data:image/png;base64,';
  // Rows the roving focus can land on. Headers and stamps are announced as
  // disabled menu items too (a Windows menu highlights disabled items under the
  // arrow keys), so a screen reader walking the menu hears every fact on it.
  var FOCUSABLE_KINDS = { action: 1, drill: 1, statement: 1, header: 1, stamp: 1, back: 1 };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function strOrNull(v) { return isStr(v) && v.length ? v : null; }
  function isGen(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /** A payload this page can paint, or null. Never throws. */
  function validPayload(p) {
    if (!isObj(p) || p.v !== CONTRACT_VERSION || !isGen(p.gen)) return null;
    if (!isObj(p.pages)) return null;
    var rootId = isStr(p.root) ? p.root : 'root';
    if (!hasOwn(p.pages, rootId) || !isObj(p.pages[rootId])) return null;
    return p;
  }

  /** The image sources the page will hand to <img>: data:image/png only. */
  function imgSources(img) {
    if (!isObj(img) || !Array.isArray(img.sources)) return null;
    var out = [];
    for (var i = 0; i < img.sources.length; i++) {
      var s = img.sources[i];
      if (!isObj(s) || !isStr(s.url) || s.url.indexOf(DATA_PNG) !== 0) continue;
      // A srcset URL is a run of non-whitespace; the comma after `base64` is fine
      // inside it, a trailing one would be read as the list separator.
      if (/\s/.test(s.url) || /,$/.test(s.url)) continue;
      var d = Number(s.density);
      if (!(d > 0 && d < 100)) continue;
      out.push({ density: d, url: s.url });
    }
    return out.length ? out : null;
  }

  function dim(v, max) {
    var n = Number(v);
    return n > 0 && n <= max ? Math.round(n) : 0;
  }

  function createTrayPopover(opts) {
    var doc = opts.document;
    var api = opts.api || {};
    var win = opts.window || null;
    var host = opts.host;                          // the element the pages are painted into
    var live = opts.live || null;                  // aria-live region

    var state = {
      payload: null,
      gen: 0,
      pageId: null,
      rows: [],                                    // [{el, kind, row, key}] in the order shown
      focusIndex: -1,
      paints: 0,
    };

    function el(tag, cls) {
      var e = doc.createElement(tag);
      if (cls) e.setAttribute('class', cls);
      return e;
    }
    function text(tag, cls, s) {
      var e = el(tag, cls);
      e.textContent = s;                           // escape-first: text, never markup
      return e;
    }

    function setTheme(theme) {
      var t = theme === 'dark' ? 'dark' : 'light';
      doc.documentElement.setAttribute('data-theme', t);
    }

    function page(id) {
      var p = state.payload;
      if (!p || !isStr(id) || !hasOwn(p.pages, id) || !isObj(p.pages[id])) return null;
      return p.pages[id];
    }

    function rootId() { return isStr(state.payload.root) ? state.payload.root : 'root'; }

    function buildImg(img, rowKind) {
      var sources = imgSources(img);
      if (!sources) return null;
      var kind = img.kind === 'strip' || img.kind === 'bar' ? img.kind : 'dot';
      var w = dim(img.w, 400), h = dim(img.h, 200);
      var im = el('img', 'pop-img pop-img--' + kind);
      im.setAttribute('alt', '');                  // decorative: the label carries the fact
      im.setAttribute('draggable', 'false');
      if (w) im.setAttribute('width', String(w));
      if (h) im.setAttribute('height', String(h));
      im.setAttribute('src', sources[0].url);
      im.setAttribute('srcset', sources.map(function (s) { return s.url + ' ' + s.density + 'x'; }).join(', '));
      return im;
    }

    function rowNode(r, ctx) {
      var kind = r.kind;
      if (kind === 'separator') {
        var sep = el('div', 'pop-sep');
        sep.setAttribute('role', 'separator');
        return { el: sep, kind: kind };
      }
      var label = isStr(r.label) ? r.label : '';
      var sub = strOrNull(r.sublabel);
      var e = el('div', 'pop-row pop-row--' + kind + (sub ? ' pop-row--two' : ''));
      e.setAttribute('role', 'menuitem');
      e.setAttribute('tabindex', '-1');
      if (isStr(r.key)) e.setAttribute('data-key', r.key);
      if (kind === 'header' || kind === 'statement' || kind === 'stamp') {
        e.setAttribute('aria-disabled', 'true');
      }
      if (kind === 'drill') e.setAttribute('aria-haspopup', 'menu');
      e.setAttribute('aria-label', sub ? label + ', ' + sub : label);

      var im = (kind === 'header' || kind === 'stamp') ? null : buildImg(r.img, kind);
      var isStrip = im && r.img.kind === 'strip';
      if (isStrip) {
        e.appendChild(im);
      } else if (ctx.iconSlot) {
        var slot = el('span', 'pop-icon');
        if (im) slot.appendChild(im);
        e.appendChild(slot);
      }
      var t = el('span', 'pop-text');
      t.appendChild(text('span', 'pop-label', label));
      if (sub) t.appendChild(text('span', 'pop-sub', sub));
      e.appendChild(t);
      if (kind === 'drill') e.appendChild(el('span', 'pop-chev'));
      return { el: e, kind: kind };
    }

    function backNode(pg) {
      var title = isStr(pg.title) ? pg.title : '';
      var sub = strOrNull(pg.subtitle);
      var e = el('div', 'pop-row pop-row--back' + (sub ? ' pop-row--two' : ''));
      e.setAttribute('role', 'menuitem');
      e.setAttribute('tabindex', '-1');
      e.setAttribute('data-key', '__back');
      e.setAttribute('aria-label', 'Back' + (title ? ': ' + title : ''));
      e.appendChild(el('span', 'pop-chev pop-chev--back'));
      var t = el('span', 'pop-text');
      t.appendChild(text('span', 'pop-label pop-title', title));
      if (sub) t.appendChild(text('span', 'pop-sub', sub));
      e.appendChild(t);
      return { el: e, kind: 'back' };
    }

    function detailsNode(groups) {
      var box = el('div', 'pop-details');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Details');
      box.appendChild(text('div', 'pop-details-head', 'Details'));
      var n = 0;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (!isObj(g) || !Array.isArray(g.lines)) continue;
        var lines = g.lines.filter(isStr);
        if (!lines.length) continue;
        var ge = el('div', 'pop-details-group');
        if (strOrNull(g.label)) ge.appendChild(text('div', 'pop-details-label', g.label));
        for (var j = 0; j < lines.length; j++) ge.appendChild(text('div', 'pop-details-line', lines[j]));
        box.appendChild(ge);
        n++;
      }
      return n ? box : null;
    }

    /** Paint pages[id] into the host. `focusKey` restores focus to that row. */
    function paintPage(id, focusKey, direction) {
      var pg = page(id);
      if (!pg) { id = rootId(); pg = page(id); }
      var isRoot = id === rootId();
      state.pageId = id;
      state.rows = [];
      state.paints++;

      var menu = el('div', 'pop-page' + (direction ? ' pop-enter-' + direction : ''));
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', isRoot ? (opts.appName || 'The Curator') : (isStr(pg.title) ? pg.title : ''));
      menu.setAttribute('aria-orientation', 'vertical');

      var rows = Array.isArray(pg.rows) ? pg.rows : [];
      // One leading column for every row on the page when any row carries a dot
      // or a bar, as wide as the widest of them, so every label lines up.
      var iconW = 0;
      for (var q = 0; q < rows.length; q++) {
        var rq = rows[q];
        if (isObj(rq) && isObj(rq.img) && rq.img.kind !== 'strip' && rq.kind !== 'header' && rq.kind !== 'stamp') {
          iconW = Math.max(iconW, dim(rq.img.w, 400) || 1);
        }
      }
      var ctx = { iconSlot: iconW > 0 };
      if (iconW > 0 && menu.style && typeof menu.style.setProperty === 'function') {
        menu.style.setProperty('--pop-icon-w', Math.max(iconW, 16) + 'px');   // CSSOM, allowed by the CSP
      }

      if (!isRoot) {
        var b = backNode(pg);
        menu.appendChild(b.el);
        state.rows.push({ el: b.el, kind: 'back', row: null, key: '__back' });
        var bsep = el('div', 'pop-sep');
        bsep.setAttribute('role', 'separator');
        menu.appendChild(bsep);
      }
      var painted = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!isObj(r) || !isStr(r.kind)) continue;
        if (r.kind === 'action' && !(isStr(r.id) && r.id.length && r.id.length <= MAX_ID_CHARS)) continue;
        if (r.kind === 'drill' && !page(r.drill)) continue;
        if (!hasOwn(FOCUSABLE_KINDS, r.kind) && r.kind !== 'separator') continue;
        var n = rowNode(r, ctx);
        menu.appendChild(n.el);
        if (r.kind !== 'separator') {
          bindRow(n.el);
          state.rows.push({ el: n.el, kind: r.kind, row: r, key: r.key });
          painted++;
        }
      }
      var nodes = [menu];
      // D7: details live on drill pages only, visible, never as tooltips.
      if (!isRoot && Array.isArray(pg.details) && pg.details.length) {
        var d = detailsNode(pg.details);
        if (d) nodes.push(d);
      }
      if (state.rows.length && state.rows[0].kind === 'back') bindBack(state.rows[0].el);

      host.replaceChildren.apply(host, nodes);
      if (live) live.textContent = isRoot ? (opts.appName || 'The Curator') : (isStr(pg.title) ? pg.title : '');

      var idx = -1;
      if (isStr(focusKey)) {
        for (var k = 0; k < state.rows.length; k++) if (state.rows[k].key === focusKey) { idx = k; break; }
      }
      if (idx < 0) idx = firstUseful();
      focusAt(idx);
      report(painted);
    }

    /** First row worth landing on: the first pressable row, else the first row. */
    function firstUseful() {
      for (var i = 0; i < state.rows.length; i++) {
        var k = state.rows[i].kind;
        if (k === 'action' || k === 'drill') return i;
      }
      return state.rows.length ? 0 : -1;
    }

    function report(painted) {
      try {
        if (typeof api.size === 'function') {
          // The painted content's own height (never the viewport's, which would
          // stop the window ever shrinking). Rounded UP: a fractional row must
          // not leave a 1 px scrollbar.
          var h = Math.ceil(Number(host.scrollHeight) || 0);
          if (typeof host.getBoundingClientRect === 'function') {
            var rh = Math.ceil(Number(host.getBoundingClientRect().height) || 0);
            if (rh > h) h = rh;
          }
          if (h > 0) api.size(h);
        }
        if (typeof api.painted === 'function') api.painted(state.gen, painted);
      } catch (_) { /* the window survives a dead channel */ }
    }

    function focusAt(i) {
      if (i < 0 || i >= state.rows.length) { state.focusIndex = -1; return; }
      for (var k = 0; k < state.rows.length; k++) state.rows[k].el.setAttribute('tabindex', k === i ? '0' : '-1');
      state.focusIndex = i;
      var e = state.rows[i].el;
      if (typeof e.focus === 'function') e.focus();
      if (typeof e.scrollIntoView === 'function') { try { e.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
    }

    function move(delta) {
      var n = state.rows.length;
      if (!n) return;
      var i = state.focusIndex < 0 ? (delta > 0 ? -1 : n) : state.focusIndex;
      focusAt(((i + delta) % n + n) % n);
    }

    function activate(entry) {
      if (!entry) return;
      if (entry.kind === 'back') { back(); return; }
      var r = entry.row;
      if (entry.kind === 'drill') { drill(r); return; }
      if (entry.kind === 'action') act(r.id);
    }

    function act(id) {
      if (!isGen(state.gen) || typeof api.act !== 'function') return;
      try {
        var p = api.act(state.gen, id);
        if (p && typeof p.then === 'function') p.then(null, function () {});
      } catch (_) { /* refused or dead channel: main repaints */ }
    }

    function drill(r) {
      if (!page(r.drill)) return;
      paintPage(r.drill, null, 'fwd');
    }

    function back() {
      var pg = page(state.pageId);
      if (!pg || state.pageId === rootId()) return false;
      var from = state.pageId;
      var parent = page(pg.parent) ? pg.parent : rootId();
      // Land on the row that opened the page we are leaving.
      var parentPage = page(parent);
      var key = null;
      var prs = parentPage && Array.isArray(parentPage.rows) ? parentPage.rows : [];
      for (var i = 0; i < prs.length; i++) {
        if (isObj(prs[i]) && prs[i].kind === 'drill' && prs[i].drill === from) { key = prs[i].key; break; }
      }
      paintPage(parent, key, 'back');
      return true;
    }

    function indexOfEl(e) {
      for (var i = 0; i < state.rows.length; i++) if (state.rows[i].el === e) return i;
      return -1;
    }

    function bindRow(e) {
      e.addEventListener('click', function () {
        // Every paint replaces every row, so a node that is not in the current
        // list was painted from an OLDER payload: its id may name a different
        // project now (row ids are a per-build sequence). Never act on it.
        var i = indexOfEl(e);
        if (i < 0) return;
        state.focusIndex = i;
        activate(state.rows[i]);
      });
    }
    function bindBack(e) {
      e.addEventListener('click', function () { back(); });
    }

    /** The key map. Returns true when the key was handled. */
    function onKey(ev) {
      if (!ev || ev.ctrlKey || ev.altKey || ev.metaKey) return false;
      var key = ev.key;
      var cur = state.focusIndex >= 0 ? state.rows[state.focusIndex] : null;
      var handled = true;
      switch (key) {
        case 'ArrowDown': move(1); break;
        case 'ArrowUp': move(-1); break;
        case 'Home': focusAt(state.rows.length ? 0 : -1); break;
        case 'End': focusAt(state.rows.length - 1); break;
        case 'ArrowRight':
          if (cur && cur.kind === 'drill') activate(cur); else handled = false;
          break;
        case 'Enter':
        case ' ':
          if (cur) activate(cur); else handled = false;
          break;
        case 'ArrowLeft':
        case 'Backspace':
          if (!back()) handled = key === 'Backspace';   // Backspace on root: swallow (no history)
          break;
        case 'Escape':
          if (!back()) { try { if (typeof api.dismiss === 'function') api.dismiss(); } catch (_) {} }
          break;
        default: handled = false;
      }
      if (handled && typeof ev.preventDefault === 'function') ev.preventDefault();
      return handled;
    }

    /** A new payload from main. Invalid payloads are ignored (the last good paint stays). */
    function render(raw) {
      var p = validPayload(raw);
      if (!p) return false;
      var prev = state.payload;
      var prevPage = state.pageId;
      var prevTitle = prev && page(prevPage) ? page(prevPage).title : null;
      var focusKey = state.focusIndex >= 0 && state.rows[state.focusIndex] ? state.rows[state.focusIndex].key : null;
      state.payload = p;
      state.gen = p.gen;
      setTheme(p.theme);
      var target = rootId();
      // Contract §1: stay only when the page still exists AND its title is unchanged.
      if (prev && prevPage && page(prevPage) && page(prevPage).title === prevTitle) target = prevPage;
      else focusKey = null;
      paintPage(target, focusKey, null);
      return true;
    }

    function onWindowFocus() {
      var a = doc.activeElement;
      if (state.rows.length && (!a || a === doc.body || indexOfEl(a) < 0)) focusAt(state.focusIndex >= 0 ? state.focusIndex : firstUseful());
    }

    return {
      render: render,
      onKey: onKey,
      onWindowFocus: onWindowFocus,
      back: back,
      state: function () {
        return {
          gen: state.gen, pageId: state.pageId, focusIndex: state.focusIndex,
          focusKey: state.focusIndex >= 0 ? state.rows[state.focusIndex].key : null,
          rowKinds: state.rows.map(function (r) { return r.kind; }), paints: state.paints,
        };
      },
    };
  }

  /** Wire the page to window.curatorTray. Inert when the preload is absent. */
  function boot(w) {
    var doc = w && w.document;
    var api = w && w.curatorTray;
    if (!doc || !api || typeof api.onModel !== 'function') return null;
    var host = doc.getElementById('pop');
    if (!host) return null;
    var pop = createTrayPopover({
      document: doc, api: api, window: w, host: host,
      live: doc.getElementById('pop-live'), appName: 'The Curator',
    });
    doc.addEventListener('keydown', function (ev) { pop.onKey(ev); });
    if (typeof w.addEventListener === 'function') w.addEventListener('focus', function () { pop.onWindowFocus(); });
    api.onModel(function (payload) { pop.render(payload); });
    return pop;
  }

  root.CuratorTrayPaint = {
    CONTRACT_VERSION: CONTRACT_VERSION,
    createTrayPopover: createTrayPopover,
    validPayload: validPayload,
    imgSources: imgSources,
    boot: boot,
  };
  root.CuratorTrayPaint.instance = boot(root);
})(typeof window !== 'undefined' ? window : globalThis);
