/**
 * Rows that open and leave instead of appearing and vanishing.
 *
 * WHY THIS EXISTS. A paint composes the section from state, so a row that has
 * left the state is simply absent from the next paint, and shared/morph.js
 * removes it in one frame: whatever was under it jumps, and the sentence saying
 * what just happened goes with it. Measured on v3.91.0, a merge moved the rows
 * under it by 640 px in a frame.
 *
 * WHAT IT DOES. Before a patch, `holdLeavingRows` copies every row the next
 * paint dropped back into that paint, marked `data-row-leaving`, so the patch
 * keeps the live node. The row is held so its outcome can be read, then its
 * height runs to 0 and it is removed. A paint that lands meanwhile gets the same
 * treatment, so it cannot cut the row short. After the patch, `startRowMotion`
 * opens any row that is new.
 *
 * NO `transitionend`, NO INLINE STYLE. The motion is the Web Animations API, so
 * a patch (which strips attributes the composed markup lacks) cannot interrupt
 * it, and under reduced motion nothing waits on an event that will never fire:
 * the row is still held, then removed at once. Durations and the curve are read
 * from the tokens in tokens/motion.css.
 *
 * Pure DOM. Nothing specific to any one section: the caller says what a row is,
 * what its key is, how long to hold it and what it should say while held.
 */

const LEAVING = 'data-row-leaving';
const DEFERRED = 'data-row-deferred';
const MAX_OPENING = 60;

function motionState(section) {
  if (!section.__rowMotion) section.__rowMotion = { ghosts: new Map(), hidden: new Set(), seen: null };
  return section.__rowMotion;
}

function reducedMotion() {
  try { return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function tokenMs(name, fallback) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    return /ms$/.test(raw) ? n : n * 1000;
  } catch { return fallback; }
}

function tokenEase() {
  try { return getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out'; }
  catch { return 'ease-out'; }
}

function signature(el) {
  const cls = el.getAttribute('class');
  return el.nodeName + '|' + (cls ? cls.trim().split(/\s+/)[0] : '');
}

/** The element in `next` standing where `el` stands in `live`, or null. */
function counterpartOf(el, live, next, keyOf, nextByKey) {
  if (el === live) return next;
  const key = keyOf(el);
  if (key) return nextByKey.get(key) || null;
  const parent = el.parentElement;
  if (!parent) return null;
  const nextParent = counterpartOf(parent, live, next, keyOf, nextByKey);
  if (!nextParent) return null;
  const sig = signature(el);
  const index = Array.from(parent.children).filter((c) => signature(c) === sig).indexOf(el);
  return Array.from(nextParent.children).filter((c) => signature(c) === sig)[index] || null;
}

/**
 * Put every row the next paint dropped back into it, so the patch keeps it.
 * Only `next` changes. Returns `undo`, for a caller whose patch then fails and
 * who is about to replace the section with `next` whole.
 *
 * @param {Element} live
 * @param {Element} next
 * @param {{ selector: string, keyOf: (el: Element) => string|null,
 *   holdFor?: (key: string, row: Element) => number, decorate?: (clone: Element, key: string, row: Element) => void }} opts
 */
export function holdLeavingRows(live, next, opts) {
  const { selector, keyOf } = opts;
  const motion = motionState(live);
  const nextByKey = new Map();
  for (const el of next.querySelectorAll(selector)) {
    const k = keyOf(el);
    if (k) nextByKey.set(k, el);
  }
  const inserted = [];
  for (const row of live.querySelectorAll(selector)) {
    const key = keyOf(row);
    if (!key || nextByKey.has(key)) continue;
    // The row around it is leaving too, and carries this one with it.
    const parentRow = row.parentElement && row.parentElement.closest(selector);
    if (parentRow && live.contains(parentRow) && !nextByKey.has(keyOf(parentRow))) continue;
    const wasLeaving = row.hasAttribute(LEAVING);
    // A row with no height is not on screen, so there is nothing to see leave.
    if (!wasLeaving && row.getBoundingClientRect().height === 0) continue;
    const parent = counterpartOf(row.parentElement, live, next, keyOf, nextByKey);
    if (!parent) continue;
    const clone = row.cloneNode(true);
    if (!wasLeaving) {
      clone.setAttribute(LEAVING, '1');
      const hold = opts.holdFor ? Math.max(0, opts.holdFor(key, row) || 0) : 0;
      // Held until the caller says otherwise: see releaseHeldRows.
      if (hold === Infinity) clone.setAttribute(DEFERRED, '1');
      if (opts.decorate) opts.decorate(clone, key, row);
      for (const b of clone.querySelectorAll('button')) {
        b.disabled = true;
        b.removeAttribute('aria-busy');
        b.removeAttribute('aria-disabled');
      }
      // A row inside it may be what was pressed, with an outcome to show. The row
      // around it leaves with it, so the two are held for the longer time.
      let longest = hold;
      const liveInner = row.querySelectorAll(selector);
      clone.querySelectorAll(selector).forEach((inner, i) => {
        const k = keyOf(inner);
        if (!k || !liveInner[i]) return;
        if (opts.holdFor) {
          const h = opts.holdFor(k, liveInner[i]) || 0;
          if (h !== Infinity) longest = Math.max(longest, h);
        }
        if (opts.decorate) opts.decorate(inner, k, liveInner[i]);
      });
      motion.ghosts.set(key, { holdUntil: Date.now() + longest, started: false });
    }
    let ref = null;
    // Right after the neighbour it had above it, keyed or not (a line with no key
    // still holds its place), so anything new in this paint lands under the row,
    // not over it. With nothing above it, it stays first.
    let placed = !row.previousElementSibling;
    if (placed) ref = parent.firstChild;
    for (let s = row.previousElementSibling; s && !placed; s = s.previousElementSibling) {
      const hit = counterpartOf(s, live, next, keyOf, nextByKey);
      if (hit && hit.parentNode === parent) { ref = hit.nextSibling; placed = true; }
    }
    for (let s = row.nextElementSibling; s && !placed; s = s.nextElementSibling) {
      const hit = counterpartOf(s, live, next, keyOf, nextByKey);
      if (hit && hit.parentNode === parent) { ref = hit; placed = true; }
    }
    parent.insertBefore(clone, ref);
    // The rows inside it came with it, so they are in this paint now too.
    nextByKey.set(key, clone);
    for (const inner of clone.querySelectorAll(selector)) {
      const k = keyOf(inner);
      if (k) nextByKey.set(k, inner);
    }
    inserted.push(clone);
  }
  return { undo() { for (const c of inserted) c.remove(); } };
}

function collapseFrames(el) {
  const cs = getComputedStyle(el);
  const parent = el.parentElement;
  const gap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
  const from = {
    height: cs.height, minHeight: '0px', overflow: 'hidden',
    marginTop: cs.marginTop, marginBottom: cs.marginBottom,
    paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
    borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth,
  };
  // A gap does not shrink with its row, so the row gives it back as a negative
  // margin; otherwise the column jumps by the gap when the row is removed.
  const to = {
    height: '0px', minHeight: '0px', overflow: 'hidden',
    // The top margin stays, so the row's own top edge does not move as it closes.
    marginTop: cs.marginTop, marginBottom: (-(parseFloat(cs.marginTop) || 0) - gap) + 'px',
    paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
  };
  return [from, to];
}

function collapse(el, key, motion, hooks) {
  const entry = motion.ghosts.get(key);
  if (!entry) return;
  entry.started = true;
  if (hooks.beforeCollapse) hooks.beforeCollapse(el);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (entry.timer) clearTimeout(entry.timer);
    motion.ghosts.delete(key);
    // The row came back while it was collapsing: it stays, at its full height.
    if (el.hasAttribute(LEAVING)) {
      // Gone from the screen, so if the state brings it back it opens again.
      if (motion.seen) {
        motion.seen.delete(key);
        for (const inner of el.querySelectorAll(hooks.selector)) motion.seen.delete(hooks.keyOf(inner));
      }
      el.remove();
    }
    if (hooks.afterRemove) hooks.afterRemove(el);
  };
  const dur = tokenMs('--dur-slow', 240);
  if (reducedMotion() || dur <= 0 || typeof el.animate !== 'function') { finish(); return; }
  const height = el.animate(collapseFrames(el), { duration: dur, easing: tokenEase(), fill: 'forwards' });
  const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenMs('--dur-fast', 120), easing: tokenEase(), fill: 'forwards' });
  entry.animations = [height, fade];
  height.onfinish = finish;
  // A hidden page throttles its timelines. The row still goes.
  entry.timer = setTimeout(finish, dur + 200);
}

function open(el) {
  const dur = tokenMs('--dur-mid', 180);
  if (reducedMotion() || dur <= 0 || typeof el.animate !== 'function') return;
  const [full, closed] = collapseFrames(el);
  const gap = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).rowGap) || 0 : 0;
  // From nothing at all, its margins included, so the opening never starts by
  // pulling what is under it upward.
  const zero = Object.assign({}, closed, { marginTop: '0px', marginBottom: (-gap) + 'px' });
  try {
    el.animate([zero, full], { duration: dur, easing: tokenEase() });
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: tokenEase() });
  } catch { /* a row that cannot animate still opens */ }
}

/**
 * After the patch: arm the held rows, open the new ones.
 *
 * @param {Element} section
 * @param {{ selector: string, keyOf: (el: Element) => string|null,
 *   beforeCollapse?: (el: Element) => void, afterRemove?: (el: Element) => void,
 *   onOpen?: (el: Element, height: number) => void }} opts
 */
export function startRowMotion(section, opts) {
  const { selector, keyOf } = opts;
  const motion = motionState(section);
  motion.hooks = opts;
  const now = new Set();
  const opening = [];
  for (const el of section.querySelectorAll(selector)) {
    const key = keyOf(el);
    if (!key) continue;
    now.add(key);
    if (el.hasAttribute(LEAVING)) {
      const entry = motion.ghosts.get(key);
      if (entry && !entry.started && !entry.armed && entry.holdUntil !== Infinity) {
        entry.armed = true;
        const wait = Math.max(0, entry.holdUntil - Date.now());
        if (wait === 0) collapse(el, key, motion, opts);
        else setTimeout(() => { if (el.isConnected && el.hasAttribute(LEAVING)) collapse(el, key, motion, opts); else motion.ghosts.delete(key); }, wait);
      }
      continue;
    }
    const held = motion.ghosts.get(key);
    if (held) {
      // The state brought it back before it finished leaving.
      for (const a of held.animations || []) { try { a.cancel(); } catch { /* gone */ } }
      if (held.timer) clearTimeout(held.timer);
      motion.ghosts.delete(key);
      continue;
    }
    if (motion.hidden.has(key)) { el.style.display = 'none'; el.setAttribute('data-row-waiting', '1'); continue; }
    if (motion.seen && !motion.seen.has(key)) opening.push(el);
  }
  motion.seen = now;
  for (const k of Array.from(motion.hidden)) { if (!now.has(k)) motion.hidden.delete(k); }
  const topmost = opening.filter((el) => {
    const p = el.parentElement && el.parentElement.closest(selector);
    return !(p && opening.includes(p));
  });
  if (topmost.length > MAX_OPENING) return;
  for (const el of topmost) {
    const h = el.getBoundingClientRect().height;
    if (h === 0) continue;
    // A new row above what was pressed cannot open now without moving it.
    if (opts.waitToOpen && opts.waitToOpen(el, h)) {
      motion.hidden.add(keyOf(el));
      el.style.display = 'none';
      el.setAttribute('data-row-waiting', '1');
      continue;
    }
    if (opts.onOpen) opts.onOpen(el, h);
    open(el);
  }
}

/**
 * Let go of rows that were held without a time limit. A row above whatever was
 * pressed cannot leave while the user is looking at that press, because it would
 * move it, and a new row there cannot open. Each waits for a press above it, for
 * its own fold to be touched, or for the user to scroll.
 *
 * @param {Element} section
 * @param {(el: Element) => boolean} which
 * @param {(el: Element) => string|null} keyOf
 */
export function releaseHeldRows(section, which, keyOf) {
  const motion = motionState(section);
  for (const el of Array.from(section.querySelectorAll('[' + DEFERRED + ']'))) {
    if (!which(el)) continue;
    const key = keyOf(el);
    const entry = motion.ghosts.get(key);
    if (!entry || entry.started) continue;
    collapse(el, key, motion, motion.hooks || {});
  }
  // And rows that were waiting to open.
  for (const el of Array.from(section.querySelectorAll('[data-row-waiting]'))) {
    const key = keyOf(el);
    // Measured for `which` at the place it will take.
    el.style.removeProperty('display');
    if (!key || !motion.hidden.has(key) || !which(el)) { el.style.display = 'none'; continue; }
    motion.hidden.delete(key);
    el.removeAttribute('data-row-waiting');
    open(el);
  }
}

/**
 * Keeps a scroll position valid while the content under it shrinks.
 *
 * Wiki health is the last section of its page, so when it gets shorter the
 * browser clamps `scrollTop` and the whole page drops: 87 to 126 px, measured,
 * the only true scroll jumps on v3.91.0. So the section keeps a floor under
 * itself, as a CSS variable on the scroller (a patch never touches the scroller,
 * and would strip a style off the section). The floor grows exactly as much as
 * the scroll position needs and gives the space back as soon as the user scrolls
 * up, so the empty space is only ever under what they are looking at.
 *
 * @param {() => HTMLElement|null} scrollerOf
 * @param {string} varName
 * @param {() => void} [onUserScroll]  the scroll position moved, and not by this
 */
export function createScrollFloor(scrollerOf, varName, onUserScroll) {
  let floor = 0;
  let inFlight = 0;
  let pending = 0;
  let bound = null;
  const set = (el, v) => {
    if (v === floor) return;
    floor = v;
    el.style.setProperty(varName, v + 'px');
  };
  const content = (el) => el.scrollHeight - floor;
  let ownMove = false;
  const onScroll = () => {
    if (ownMove) { ownMove = false; return; }
    if (onUserScroll) onUserScroll();
    relax();
  };
  const relax = () => {
    const el = bound;
    if (!el || inFlight > 0) return;
    set(el, Math.max(0, Math.ceil(el.scrollTop + el.clientHeight - content(el))));
  };
  const bind = () => {
    const el = scrollerOf();
    if (!el) return null;
    if (el !== bound) {
      if (bound) bound.removeEventListener('scroll', onScroll);
      bound = el;
      el.addEventListener('scroll', onScroll, { passive: true });
    }
    return el;
  };
  return {
    /** Read before anything shrinks. */
    position() { const el = bind(); return el ? el.scrollTop : 0; },
    /** After content changed: the position read before still holds. */
    hold(top) {
      const el = bind();
      if (!el) return;
      set(el, Math.max(floor, Math.ceil(top + el.clientHeight - content(el))));
      if (Math.abs(el.scrollTop - top) >= 1) { ownMove = true; el.scrollTop = top; }
    },
    /** Before a row of this height collapses, so nothing clamps during it. */
    reserve(height) {
      const el = bind();
      if (!el) return;
      inFlight++;
      // Several rows can start collapsing in one paint; the floor covers them all.
      pending += height;
      set(el, Math.max(floor, Math.ceil(el.scrollTop + el.clientHeight - (content(el) - pending))));
    },
    /** A row that reserved has gone. */
    release() {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) pending = 0;
      relax();
    },
    /** The page changed under it: a new domain, or the view left. */
    reset() {
      const el = bound;
      inFlight = 0;
      pending = 0;
      floor = 0;
      if (el) {
        el.removeEventListener('scroll', onScroll);
        el.style.removeProperty(varName);
      }
      bound = null;
    },
    get value() { return floor; },
  };
}
