/**
 * Patch a live element until it matches a freshly composed one, keeping every
 * node that can be kept.
 *
 * WHY THIS EXISTS. The Domain page paints by composing the whole column as a
 * string and swapping any top-level section whose markup moved. Wiki health is
 * one section, so any change there replaced all of it: measured on v3.91.0,
 * focus landed on <body> after 22 of 22 actions and one merge was 7 paints of
 * 5 whole-section replacements. A node that is replaced cannot keep focus and
 * cannot run a CSS transition. This keeps the nodes.
 *
 * WHAT IT PROMISES. `patchInPlace(live, next)` returns true only when `live`
 * is `isEqualNode` to `next` afterwards. It never moves anything out of `next`
 * (inserted nodes are clones), so a caller that gets false, or catches a throw,
 * still holds an intact `next` and can fall back to replacing the node whole.
 * That is the failure path: a whole-section replacement, which is what the
 * page did before this file existed, never a half-patched screen.
 *
 * HOW A CHILD FINDS ITS OLD SELF, strongest match first:
 *   1. `keyOf(el)`, for anything with an identity the caller knows.
 *   2. Exactly the same markup, so an unkeyed row that merely moved up one
 *      place when the row above it left is the same node.
 *   3. Position among siblings of the same tag and first class.
 * An unkeyed control (button, link, form field) is never reused under rule 3:
 * focus on a button must not silently become focus on a different action.
 *
 * Pure DOM. No imports, no state, nothing specific to Health.
 */

const ELEMENT = 1;
const NEVER_REPURPOSE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
const FORM_VALUE = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function signature(el) {
  const cls = el.getAttribute('class');
  return el.nodeName + '|' + (el.namespaceURI || '') + '|' + (cls ? cls.trim().split(/\s+/)[0] : '');
}

function sameKind(a, b) {
  return a.nodeName === b.nodeName && a.namespaceURI === b.namespaceURI;
}

function syncAttributes(live, next) {
  const stale = [];
  for (const attr of Array.from(live.attributes)) {
    if (!next.hasAttribute(attr.name)) stale.push(attr.name);
  }
  for (const name of stale) live.removeAttribute(name);
  for (const attr of Array.from(next.attributes)) {
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
  }
}

// A form field's value lives in a property, which markup does not reach once
// the user has typed. Replacing the node used to reset it, so a field the user
// is not in still resets. The field they are in is left alone.
function syncFormValue(live, next, active) {
  if (!FORM_VALUE.has(live.nodeName) || live === active) return;
  if (live.value !== next.value) live.value = next.value;
  if (live.nodeName === 'INPUT' && live.checked !== next.checked) live.checked = next.checked;
}

// moveBefore keeps focus, transitions and scroll on a connected node where the
// browser has it. Where it does not, patchInPlace puts focus back afterwards.
function place(parent, node, ref) {
  if (typeof parent.moveBefore === 'function') {
    try { parent.moveBefore(node, ref); return; } catch { /* fall through */ }
  }
  parent.insertBefore(node, ref);
}

function syncChildren(parent, nextParent, keyOf, active) {
  const liveKids = Array.from(parent.childNodes);
  const nextKids = Array.from(nextParent.childNodes);

  const byKey = new Map();
  const byMarkup = new Map();
  const byPosition = new Map();
  const liveKeyOf = new Map();
  for (const kid of liveKids) {
    if (kid.nodeType !== ELEMENT) {
      const q = byPosition.get(kid.nodeType) || [];
      q.push(kid);
      byPosition.set(kid.nodeType, q);
      continue;
    }
    const key = keyOf(kid);
    if (key && !byKey.has(key)) {
      byKey.set(key, kid);
      liveKeyOf.set(kid, key);
      continue;
    }
    const q = byMarkup.get(kid.outerHTML) || [];
    q.push(kid);
    byMarkup.set(kid.outerHTML, q);
  }

  const claimed = new Set();
  const plan = new Array(nextKids.length).fill(null);

  // Rules 1 and 2. Both run across the whole list before rule 3 runs at all, so
  // a position-matched row can never take a node a later exact match needed.
  nextKids.forEach((kid, i) => {
    if (kid.nodeType !== ELEMENT) return;
    const key = keyOf(kid);
    if (key) {
      const hit = byKey.get(key);
      if (hit && sameKind(hit, kid) && !claimed.has(hit)) { plan[i] = hit; claimed.add(hit); }
      return;
    }
    const q = byMarkup.get(kid.outerHTML);
    if (q && q.length) { const hit = q.shift(); plan[i] = hit; claimed.add(hit); }
  });

  // Rule 3. Unkeyed live elements left over, by tag and first class.
  for (const q of byMarkup.values()) {
    for (const kid of q) {
      if (NEVER_REPURPOSE.has(kid.nodeName)) continue;
      const sig = signature(kid);
      const list = byPosition.get(sig) || [];
      list.push(kid);
      byPosition.set(sig, list);
    }
  }
  nextKids.forEach((kid, i) => {
    if (plan[i]) return;
    if (kid.nodeType === ELEMENT) {
      if (keyOf(kid) || NEVER_REPURPOSE.has(kid.nodeName)) return;
      const q = byPosition.get(signature(kid));
      if (q && q.length) { const hit = q.shift(); plan[i] = hit; claimed.add(hit); }
      return;
    }
    const q = byPosition.get(kid.nodeType);
    if (q && q.length) { const hit = q.shift(); plan[i] = hit; claimed.add(hit); }
  });

  // Whatever nobody claimed leaves first, so the walk below moves as little as
  // possible: in the common case of a row leaving, it moves nothing at all.
  for (const kid of liveKids) {
    if (!claimed.has(kid)) parent.removeChild(kid);
  }

  let cursor = parent.firstChild;
  nextKids.forEach((kid, i) => {
    const node = plan[i];
    if (!node) {
      parent.insertBefore(kid.cloneNode(true), cursor);
      return;
    }
    if (node === cursor) cursor = cursor.nextSibling;
    else place(parent, node, cursor);
    if (node.nodeType === ELEMENT) syncElement(node, kid, keyOf, active);
    else if (node.nodeValue !== kid.nodeValue) node.nodeValue = kid.nodeValue;
  });
}

function syncElement(live, next, keyOf, active) {
  syncAttributes(live, next);
  syncFormValue(live, next, active);
  syncChildren(live, next, keyOf, active);
}

/**
 * @param {Element} live   the node on screen; it stays on screen
 * @param {Element} next   the freshly composed node; it is read, never changed
 * @param {{ keyOf?: (el: Element) => (string|null|undefined) }} [opts]
 * @returns {boolean} true when `live` now equals `next`
 */
export function patchInPlace(live, next, opts = {}) {
  if (!sameKind(live, next)) return false;
  const keyOf = opts.keyOf || ((el) => (el.id ? '#' + el.id : null));
  const doc = live.ownerDocument;
  const active = doc && doc.activeElement;
  const inside = active && active !== live && live.contains(active) ? active : null;
  // A BUTTON THAT WAITS GETS ITS FOCUS BACK. The page disables a control while
  // its action runs, and the browser drops focus from a disabled element, so
  // Rescan pressed from the keyboard would otherwise end on <body> even though
  // it is still there. It is remembered across paints while it waits. If focus
  // has since gone anywhere else, that was the user, and the memory is dropped.
  const waiting = inside || (!active || active === doc.body ? live.__morphWaiting : null) || null;
  live.__morphWaiting = null;
  syncElement(live, next, keyOf, active);
  if (waiting && waiting.isConnected && live.contains(waiting)) {
    if (waiting.disabled) live.__morphWaiting = waiting;
    else if (doc.activeElement !== waiting) waiting.focus({ preventScroll: true });
  }
  return live.isEqualNode(next);
}
