// test-helpers/kit-dom.js — a SMALL DOM for the kit's own markup (kit v1).
//
// The repo has no jsdom (zero devDeps). The kit's parts return HTML strings
// and wire behaviour through a handful of DOM calls (closest, querySelectorAll,
// get/setAttribute, focus, click, addEventListener). This parses the kit's
// markup into a tree that answers exactly those calls, with bubbling events,
// so scripts/test-kit-parts.js drives the REAL wire functions with real
// event shapes rather than calling handlers directly.
//
// Selector support (all the kit uses): a comma list of compounds made of an
// optional tag, `.class`es and `[attr]` / `[attr="value"]`, and the
// descendant combinator (a space). No other combinators.

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'param', 'track']);

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

class Node {
  constructor(tag, attrs, doc) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.parent = null;
    this.text = '';
    this.doc = doc;
    this._listeners = {};
    const self = this;
    this.classList = {
      contains: (c) => (self.attrs.class || '').split(/\s+/).includes(c),
      toggle: (c, on) => {
        const set = new Set((self.attrs.class || '').split(/\s+/).filter(Boolean));
        const want = on === undefined ? !set.has(c) : !!on;
        if (want) set.add(c); else set.delete(c);
        self.attrs.class = [...set].join(' ');
        return want;
      },
    };
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  removeAttribute(n) { delete this.attrs[n]; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  matches(sel) { return sel.split(',').some((one) => matchChain(this, one.trim().split(/\s+(?![^\[]*\])/))); }
  closest(sel) { let n = this; while (n && n.tagName) { if (n.matches(sel)) return n; n = n.parent; } return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn); }
  focus() { this.doc.activeElement = this; }
  dispatch(type, init = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    let n = this;
    while (n) { for (const fn of (n._listeners[type] || []).slice()) fn(e); n = n.parent; }
    return e;
  }
  click() { return this.dispatch('click'); }
}

/** "A B": the last compound matches the element, the earlier ones its
 *  ancestors, in order (the descendant combinator only). */
function matchChain(el, parts) {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let n = el.parent;
  while (i >= 0 && n && n.tagName) { if (matchCompound(n, parts[i])) i--; n = n.parent; }
  return i < 0;
}

function matchCompound(el, sel) {
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[A-Za-z0-9_-]+)*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) throw new Error('kit-dom: unsupported selector "' + sel + '"');
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const c of (m[2] || '').split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
  for (const a of (m[3] || '').match(/\[[^\]]+\]/g) || []) {
    const am = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(a);
    if (!am) throw new Error('kit-dom: unsupported attribute selector ' + a);
    if (!el.hasAttribute(am[1])) return false;
    if (am[2] !== undefined && el.getAttribute(am[1]) !== am[2]) return false;
  }
  return true;
}

/** Parse kit markup into a root node (a <div>) whose document tracks focus. */
export function parse(html) {
  const doc = { activeElement: null };
  const root = new Node('div', {}, doc);
  doc.root = root;
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag) { stack.length = i; break; }
    } else if (m[2]) {
      const attrs = {};
      for (const a of (m[3] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]] = decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '');
      }
      const n = new Node(m[2], attrs, doc);
      n.parent = top; top.children.push(n);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(n);
    } else if (m[5]) {
      const t = new Node('#text', {}, doc);
      t.tagName = undefined; t.text = decode(m[5]); t.parent = top; t.matches = () => false;
      top.children.push(t);
    }
  }
  return root;
}
