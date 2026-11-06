// ═══════════════════════════════════════
//  views/health-review.js — THE REVIEW DESK (Wiki health)
// ═══════════════════════════════════════
//
// Possible duplicates → Review swaps the card's content for this: both pages side
// by side at a fixed height, the decision underneath at the same y for every pair.
// Deciding swaps text in place and nothing moves. One decision at a time, because a
// merge deletes a page and the decision needs reading.
//
// WHAT LIVES WHERE. The merge gate stays in views/domains.js (canMergeSemanticPair,
// markSemanticPreviewed, flipSemanticPair, liveBatchPairs, activeSemanticScan), and so
// do the three calls that reach the server. test-next-semantic-gate.js lifts them from
// there, and that suite is the safety's proof. This file owns the words, the markup and
// the walk through the pairs, and takes everything else as `deps`, so it imports nothing
// that needs a browser.
//
// THE GATE'S TRIGGER. Merge opens when the comparison for this exact direction has
// loaded AND been on screen for 500 ms. Fetching is not seeing, so the timer runs only
// while the panes are visible. Every new pair, every flip and every refreshed comparison
// starts it again, which is also what makes a double-click on Merge harmless. The re-check
// at execution (mergeOneSemanticPair) and the server's `basis` check stay under it.
//
// RUBBER-STAMPING. There is no single-key shortcut for Merge or Keep both, and there must
// never be one. After a decision focus lands on the pair's title, never on a button, so a
// held Enter does nothing. Merge names its result, so its label changes on every pair, and
// neither choice is violet, so the page does not lean toward deleting. 500 ms alone did not
// hold: 56 clicks in 6 s on one spot merged 4 pages unread. So a mouse that is still resting
// on Merge when the next pair arrives must leave it and come back before it opens, and by
// touch the wait is longer. A person who moved the pointer to read never meets either.
//
// A FAMILY WALK IS THE SAME DESK. `renderDesk` draws a model and knows nothing about pairs:
// title, count, the two facts lines, two panes, the after line, the two decision buttons, the
// note, the outcome line and the fold. A walk fills in the same slots. Each press is one merge
// through the same gate (seen 500 ms, `basis`, the pointer re-arm). There is no queue and no
// "merge all": the kept page changes with each merge, so a queue would show a page that will no
// longer exist when its turn comes, and its basis would be refused. views/health-family.js holds
// the grouping and the words; what may be said about two pages is decided there, in one place.

import { renderFoldRow, renderFoldItem, renderFoldRows } from '../shared/section.js';
import {
  planDecisions, newFamily, applyFacts, relationOf, orderFor, counts, isFresh, leftovers, evidence, countLine,
  renderMarks, renderRunning, afterLineWalk, renderWalkFold, renderChoose, renderFinish, chooseRows, undecidedCount, familyWaiting,
  slugOf, folderOf, keepOf, removeOf, CHOOSE_FIRST,
} from './health-family.js';

/** How long the comparison must be on screen before Merge opens. */
export const ARM_MS = 500;
/** By touch, where a finger cannot leave and come back: a person who reads takes longer anyway. */
export const ARM_TOUCH_MS = 2000;
/** "All N pairs" draws this many rows at a time, however long the list. */
export const FOLD_PAGE = 50;

export const RELATION_LABELS = Object.freeze({
  'spelling-variant': 'Spelling variant',
  'version-differs': 'Version numbers differ',
  'different-names': 'Different names',
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (v) => (Number(v) || 0).toLocaleString('en-US');
const name = (s) => '<span class="mono">' + esc(s) + '</span>';

/** A page's size, from its length in characters. */
export function formatSize(chars) {
  const v = Number(chars) || 0;
  if (v < 1000) return n0(v) + ' B';
  return (v / 1000).toLocaleString('en-US', { maximumFractionDigits: v < 10000 ? 1 : 0 }) + ' KB';
}

/** The page's own text, without the frontmatter block the reader leaves out too. */
export function pageBody(text) {
  return String(text == null ? '' : text).replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

function linksMeta(linksIn) {
  const links = linksIn ? Number(linksIn.links) || 0 : 0;
  if (links === 0) return 'nothing links here';
  return links === 1 ? '1 link points here' : n0(links) + ' links point here';
}

/** "Pair i of n" counts the list; "d decided · k left" counts what has happened to it. */
export function tally(pairs) {
  const t = { total: pairs.length, open: 0, merged: 0, kept: 0, settled: 0, relations: {} };
  for (const p of pairs) {
    if (p.status === 'open') t.open++;
    else if (p.status === 'merged') t.merged++;
    else if (p.status === 'skipped') t.kept++;
    else if (p.status === 'resolved') t.settled++;
    if (p.nameRelation) t.relations[p.nameRelation] = (t.relations[p.nameRelation] || 0) + 1;
  }
  t.decided = t.total - t.open;
  return t;
}

/** The next waiting pair after `from`, going round; -1 when none waits. */
export function nextWaiting(pairs, from, step) {
  const n = pairs.length;
  const dir = step < 0 ? -1 : 1;
  for (let i = 1; i <= n; i++) {
    const at = (((from + dir * i) % n) + n) % n;
    if (pairs[at] && pairs[at].status === 'open') return at;
  }
  return -1;
}

export function afterLine(goes, stays, links, movedUnder) {
  const count = Number(links) || 0;
  const moved = count === 0 ? 'No links move, because nothing links here.'
    : count === 1 ? '1 link moves to it.' : n0(count) + ' links move to it.';
  return 'After the merge there is one page, ' + name(stays) + '. Lists from ' + name(goes) + ' join the sections of the same name' +
    (movedUnder ? ', and everything else moves under "' + esc(movedUnder) + '". ' : '. ') + moved;
}

// ── THE FOLD ──────────────────────────────────────────────────────────────
// Summary first, then a window of rows. The rows are drawn only while the fold is open
// and never more than a page or two of them, so a list of thousands costs what fifty do.
const ROW_STATE = { merged: 'merged', skipped: 'kept both', resolved: 'settled by another merge' };

export function foldSummary(t) {
  const parts = [];
  if (t.open) parts.push(n0(t.open) + ' waiting');
  if (t.merged) parts.push(n0(t.merged) + ' merged');
  if (t.kept) parts.push(n0(t.kept) + ' kept both');
  if (t.settled) parts.push(n0(t.settled) + ' settled by another merge');
  const relations = Object.keys(RELATION_LABELS).filter((k) => t.relations[k])
    .map((k) => RELATION_LABELS[k] + ' ' + n0(t.relations[k]));
  return '<div class="hr-fold-summary"><span>' + parts.join(' · ') + '</span>' +
    (relations.length ? '<span>' + relations.join(' · ') + '</span>' : '') + '</div>';
}

export function foldWindow(total, index, start, count) {
  const from = Number.isInteger(start) ? start : Math.max(0, Math.floor(index / FOLD_PAGE) * FOLD_PAGE);
  const shown = Number.isInteger(count) ? count : FOLD_PAGE;
  return { from, to: Math.min(total, from + shown) };
}

function moreButton(id, count) {
  return '<div class="hr-fold-more"><button type="button" class="btn btn-secondary btn-xs" id="' + id + '">Show ' + n0(count) + ' more</button></div>';
}

export function renderPairsFold(m) {
  const pairs = m.pairs;
  const body = [];
  if (m.foldOpen) {
    const w = foldWindow(pairs.length, m.index, m.foldStart, m.foldCount);
    body.push(foldSummary(m.tally));
    if (w.from > 0) body.push(moreButton('hr-fold-earlier', Math.min(w.from, FOLD_PAGE)));
    for (let i = w.from; i < w.to; i++) {
      const p = pairs[i];
      const label = name(p.removeSlug) + ' → ' + name(p.keepSlug);
      const here = i === m.index && p.status === 'open';
      const open = p.status === 'open' && !here;
      body.push(renderFoldItem({
        alias: 'dm', hostClass: 'hr-fold-row',
        mainHtml: open ? '<button type="button" class="btn btn-secondary btn-xs hr-jump" data-review-jump="' + i + '"' + (m.busy ? ' disabled' : '') + '>' + label + '</button>' : label,
        meta: here ? 'this pair' : (open ? 'waiting' : (ROW_STATE[p.status] || 'waiting')),
      }));
    }
    if (w.to < pairs.length) body.push(moreButton('hr-fold-more', Math.min(pairs.length - w.to, FOLD_PAGE)));
  }
  return renderFoldRows(renderFoldRow({
    key: 'reviewPairs', label: pairs.length === 1 ? 'All 1 pair' : 'All ' + n0(pairs.length) + ' pairs',
    open: !!m.foldOpen, alias: 'dm', hostClass: 'hr-fold', bodyHtml: body.join(''),
  }), { alias: 'dm' });
}

// ── THE MARKUP ────────────────────────────────────────────────────────────
function navButton(id, label, disabled) {
  return '<button type="button" class="btn btn-secondary btn-xs" id="' + id + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
}

function renderPane(p) {
  const named = p.role === 'Merged' ? 'Merged: ' + p.page : (p.role === 'Stays' ? 'Page that stays: ' : 'Page that goes away: ') + p.page;
  return '<article class="hr-pane hr-pane-' + (p.role === 'Stays' ? 'stays' : p.role === 'Merged' ? 'merged' : 'goes') + '" aria-label="' + esc(named) + '">' +
      '<header class="hr-pane-head">' +
        '<span class="hr-pane-role">' + p.role + '</span>' +
        '<span class="mono hr-pane-name">' + esc(p.page) + '</span>' +
        '<span class="hr-pane-meta">' + esc(p.meta) + '</span>' +
      '</header>' +
      '<div class="hr-pane-body" tabindex="0" role="group" aria-label="' + esc('Text of ' + p.page) + '">' + p.bodyHtml + '</div>' +
      '<div class="hr-pane-foot">' +
        (p.readId ? '<button type="button" class="btn btn-secondary btn-xs" id="' + p.readId + '" aria-label="' + esc('Read full page: ' + p.page) + '">Read full page</button>' : '') +
        (p.flip ? '<button type="button" class="btn btn-secondary btn-xs" id="hr-flip"' + (p.flip.disabled ? ' disabled' : '') + '>Keep this one instead</button>' : '') +
      '</div>' +
    '</article>';
}

/** Draws a model. It holds no state and asks nothing, so a suite can read every arm. */
export function renderDesk(m) {
  const head = '<div class="hr-head">' +
      '<div class="hr-title-line">' +
        '<h4 class="hr-title" id="hr-title" tabindex="-1">' + m.titleHtml + '</h4>' +
        (m.countText ? '<span class="hr-count">' + esc(m.countText) + '</span>' : '') +
      '</div>' +
      '<div class="hr-nav">' +
        (m.navHtml !== undefined ? m.navHtml : (m.end ? '' : navButton('hr-prev', 'Previous', m.navDisabled) + navButton('hr-next', 'Next', m.navDisabled))) +
        navButton('hr-done', 'Done', m.doneDisabled) +
      '</div>' +
    '</div>';
  const middle = m.customHtml !== undefined ? m.customHtml : m.end
    ? '<div class="hr-facts"></div>' +
      '<div class="hr-panes hr-end"><p class="hr-end-line">' + esc(m.end.counts) + '</p>' +
        (m.end.more ? '<p class="hr-end-line">' + esc(m.end.more) + '</p>' : '') + '</div>' +
      '<div class="hr-after"></div>' +
      '<div class="hr-decide"></div>' +
      '<div class="hr-gate"></div>'
    : (m.leadHtml || '') + '<div class="hr-facts">' + m.factsHtml + '</div>' +
      '<div class="hr-panes" data-review-key="' + esc(m.reviewKey) + '">' + renderPane(m.goes) + renderPane(m.stays) + '</div>' +
      '<div class="hr-after">' + (m.afterHtml || '') + '</div>' +
      '<div class="hr-decide">' + (m.decideHtml !== undefined ? m.decideHtml :
        '<div class="hr-decide-btns">' +
          '<button type="button" class="btn btn-secondary" id="hr-keep"' + m.keepAttrs + '>' + m.keepLabel + '</button>' +
          '<button type="button" class="btn btn-danger" id="hr-merge" aria-describedby="hr-gate"' + m.mergeAttrs + ' aria-label="' + esc(m.mergeSpoken) + '"><span class="hr-merge-label">' + m.mergeLabelHtml + '</span></button>' +
        '</div>' +
        '<p class="hr-note">' + m.noteHtml + '</p>') +
      '</div>' +
      '<div class="hr-gate" id="hr-gate">' + esc(m.gateText || '') + '</div>';
  return '<div class="hr-desk' + (m.busy ? ' hr-desk-busy' : '') + (m.familyClass ? ' ' + m.familyClass : '') + '">' + head + middle +
      '<div class="hr-outcome' + (m.outcome && m.outcome.tone === 'error' ? ' hr-outcome-failed' : '') + '">' + (m.outcome ? m.outcome.html : '') + '</div>' +
      m.foldHtml +
    '</div>';
}

// ── ON SCREEN FOR ms ──────────────────────────────────────────────────────
// EVERY element must be seen, each for the whole time: at least half of it, or half of a
// window too short for that. They need not be on screen together, because on a phone two
// stacked pages may not fit. Scrolling one away before its time is up starts it again. On
// a hidden tab nothing runs. No IntersectionObserver means nothing ever counts as seen: the
// safe direction. `onUnseen(true)` says one still to be seen is off screen.
export function watchVisible(els, ms, done, onUnseen) {
  const list = [].concat(els).filter(Boolean);
  if (typeof IntersectionObserver === 'undefined' || list.length === 0) return () => {};
  const items = new Map(list.map((el) => [el, { seen: false, read: false, timer: null, reported: false }]));
  const stop = (it) => { if (it.timer) { clearTimeout(it.timer); it.timer = null; } };
  const run = (it) => {
    stop(it);
    if (it.read || !it.seen || document.hidden) return;
    it.timer = setTimeout(() => {
      it.timer = null;
      it.read = true;
      if ([...items.values()].every((x) => x.read)) { cancel(); done(); }
    }, ms);
  };
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const it = items.get(e.target);
      if (!it) continue;
      it.reported = true;
      const rect = e.intersectionRect || { height: 0 };
      const rootH = e.rootBounds ? e.rootBounds.height : (typeof window !== 'undefined' ? window.innerHeight : 0);
      const now = !!e.isIntersecting && (e.intersectionRatio >= 0.5 || (rootH > 0 && rect.height >= rootH * 0.5));
      if (now === it.seen) continue;
      it.seen = now;
      run(it);
    }
    if (onUnseen && [...items.values()].every((x) => x.reported)) onUnseen([...items.values()].some((x) => !x.read && !x.seen));
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  const onVisibility = () => { for (const it of items.values()) run(it); };
  document.addEventListener('visibilitychange', onVisibility);
  for (const el of list) observer.observe(el);
  function cancel() {
    for (const it of items.values()) stop(it);
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  }
  return cancel;
}

/** With a pointer that can hover, 500 ms. By touch there is no hover to leave, so longer. */
export function armDelay(pointerType, hoverNone) {
  const coarse = pointerType === 'touch' || pointerType === 'pen' || (!pointerType && !!hoverNone);
  return coarse ? ARM_TOUCH_MS : ARM_MS;
}

// ── THE WALK ──────────────────────────────────────────────────────────────
/**
 * @param {object} d  what the desk needs from views/domains.js:
 *   state            the view's state object (holds `review`, `expandedGroups`, `healthLive`)
 *   scan()           activeSemanticScan
 *   pairKey(pair)    semanticPairKey
 *   gate(pair)       canMergeSemanticPair
 *   arm(pair)        opens the gate for a comparison that has been seen; false if it may not
 *   armed(pair)      isSemanticPreviewed
 *   disarm(scan)     empties the previewed set and the held comparison
 *   flip(pair)       flipSemanticPair
 *   status(pair, s)  markSemanticPairStatus
 *   compare(slug, pair)     resolves { data } | { error } | { settled, missing }
 *   merge(slug, pair, cb)   mergeOneSemanticPair
 *   keepBoth(slug, pair, cb) skipSemanticPair
 *   bringBack(slug, pair)   undoes a Keep both: resolves, or throws
 *   readPage(path, title)   opens the right-side reader
 *   markdown(text)   renderMarkdown
 *   render()         a paint
 *   slug()           the active domain
 *   warn             GIT_UNDO_WARN, byte for byte
 *   onClosed(merged) what the lanes do when the desk goes
 *   coverageLeft()   pairs not compared yet
 *   headIntoView()   brings the section's head on screen, when it is off
 */
const NOT_MINE = Symbol('not-mine');
const FOLD_KEYS = ['reviewPairs', 'reviewFamily', 'reviewFamMerged', 'reviewFamKept', 'reviewFamLeft'];

export function createReviewDesk(d) {
  let cancelWatch = null;
  let watchedEl = null;
  let watchedKey = null;
  // Where the pointer is, read from every move, because a disabled button hears nothing.
  const pointer = { x: null, y: null, type: null, stale: false };
  let listening = false;

  const mergeRect = () => {
    if (d.mergeRect) return d.mergeRect();
    const m = typeof document !== 'undefined' ? document.getElementById('hr-merge') : null;
    return m ? m.getBoundingClientRect() : null;
  };
  const overMerge = () => {
    const b = mergeRect();
    return !!b && pointer.x !== null && pointer.x >= b.left && pointer.x <= b.right && pointer.y >= b.top && pointer.y <= b.bottom;
  };
  /** Every move and press. It has left Merge: the next arrival on it is a new press. */
  function onPointer(e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (e.pointerType) pointer.type = e.pointerType;
    if (pointer.stale && !overMerge()) { pointer.stale = false; d.render(); }
  }
  /** A keyboard reaches Merge by walking to it, which is deliberate; the mouse is not in it. */
  function onKey(e) { if (e.key === 'Tab' && pointer.stale) { pointer.stale = false; d.render(); } }
  function listen(on) {
    if (on === listening || typeof document === 'undefined') return;
    listening = on;
    const way = on ? 'addEventListener' : 'removeEventListener';
    document[way]('pointermove', onPointer, true);
    document[way]('pointerdown', onPointer, true);
    document[way]('keydown', onKey, true);
  }

  const review = () => {
    const r = d.state.review;
    if (!r || r.slug !== d.slug()) return null;
    const scan = d.scan();
    return scan && scan === r.scan ? r : null;
  };

  function stopWatch() {
    if (cancelWatch) cancelWatch();
    cancelWatch = null;
    watchedEl = null;
    watchedKey = null;
  }

  const walkPairOf = (r, fam, page) => (r.scan.walkPairs || []).find((p) => p.family === fam.id && removeOf(p) === page) || null;
  /** What the desk is deciding now: a scan's pair, or on a walk the page that stays against this page. */
  const current = (r) => {
    if (!r.family) return r.scan.pairs[r.index] || null;
    const fam = r.family;
    if (fam.view !== 'walk') return null;
    return walkPairOf(r, fam, fam.order[fam.i]);
  };
  const isBusy = (key) => {
    const b = d.state.busyKey || '';
    return b === 'semanticMergeOne:' + key || b === 'semanticSkip:' + key;
  };
  function live(text) { d.state.healthLive = text; }

  function focusTitle() {
    const el = typeof document !== 'undefined' ? document.getElementById('hr-title') : null;
    if (el) el.focus({ preventScroll: true });
  }

  function clearPairMessage(pair) {
    if (!pair) return;
    pair.refusal = null;
    pair.error = null;
    pair.errorAction = null;
  }

  /** Moves the desk to a pair. Nothing is armed on arrival, whichever pair it is. */
  function goTo(r, index) {
    stopWatch();
    r.index = index;
    r.checkHover = true;
    r.unseen = false;
    if (r.outcome && r.outcome.retry) r.outcome = null; // "Try again" belongs to the pair that failed, never the next one
    r.comparison = null;
    r.refreshing = false;
    d.disarm(r.scan);
    const p = current(r);
    if (p && p.status === 'open' && r.foldOpen) {
      const w = foldWindow(r.scan.pairs.length, r.index, r.foldStart, r.foldCount);
      if (r.index < w.from || r.index >= w.to) { r.foldStart = null; r.foldCount = null; }
    }
  }

  // ── A list of decisions, when any pairs share pages ───────────────────
  // Without a family `r.items` is null and everything below is the plain walk through the pairs.
  const itemWaits = (r, it) => (it.kind === 'family' ? familyWaiting(it.fam) : !!(r.scan.pairs[it.at] && r.scan.pairs[it.at].status === 'open'));
  function nextItem(r, from, step) {
    const n = r.items.length;
    const dir = step < 0 ? -1 : 1;
    for (let i = 1; i <= n; i++) {
      const at = (((from + dir * i) % n) + n) % n;
      if (itemWaits(r, r.items[at])) return at;
    }
    return -1;
  }
  const waitingItems = (r) => r.items.filter((it) => itemWaits(r, it)).length;

  function enterItem(r, pos) {
    const it = r.items[pos];
    r.pos = pos;
    r.ended = false;
    if (r.outcome && (r.outcome.undoPage || r.outcome.familyMessage)) r.outcome = null;
    if (it.kind === 'pair') { r.family = null; goTo(r, it.at); return; }
    const fam = it.fam;
    r.family = fam;
    resetForPage(r);
    if (fam.stays && fam.view !== 'choose') {
      const c = counts(fam);
      fam.view = 'walk';
      const first = fam.order.findIndex((p) => !fam.dec[p]);
      fam.i = first === -1 ? 0 : first;
      if (c.m || c.k) {
        const tail = ' earlier. ' + n0(c.m) + ' merged, ' + n0(c.k) + ' kept, ' + n0(c.left) + ' left.';
        r.outcome = { tone: 'info', familyMessage: true, html: 'You chose ' + name(slugOf(fam.stays)) + tail, spoken: 'You chose ' + slugOf(fam.stays) + tail };
      }
    }
  }

  /** A page on the walk, or the walk's own screens: nothing is armed on arrival, whichever it is. */
  function resetForPage(r) {
    stopWatch();
    r.checkHover = true;
    r.unseen = false;
    if (r.outcome && r.outcome.retry) r.outcome = null;
    r.comparison = null;
    r.refreshing = false;
    d.disarm(r.scan);
  }

  function goToWaiting(r, from, step) {
    if (r.items) {
      const pos = nextItem(r, r.pos, step);
      if (pos === -1) { stopWatch(); d.disarm(r.scan); r.comparison = null; r.family = null; r.ended = true; return false; }
      enterItem(r, pos);
      return true;
    }
    const at = nextWaiting(r.scan.pairs, from, step);
    if (at === -1) { stopWatch(); d.disarm(r.scan); r.comparison = null; r.ended = true; return false; }
    r.ended = false;
    goTo(r, at);
    return true;
  }

  function open() {
    const scan = d.scan();
    if (!scan) return false;
    const first = scan.pairs.findIndex((p) => p.status === 'open');
    const items = d.familyFacts ? planDecisions(scan) : null;
    if (first === -1 && !(items && items.some((it) => it.kind === 'family' && familyWaiting(it.fam)))) return false;
    for (const k of FOLD_KEYS) d.state.expandedGroups.delete(k);
    d.state.review = { slug: d.slug(), scan, index: first, comparison: null, outcome: null, foldOpen: false,
      foldStart: null, foldCount: null, ended: false, refreshing: false, mergedAtOpen: tally(scan.pairs).merged,
      items, pos: 0, family: null, familyMerged: 0 };
    const r = d.state.review;
    d.disarm(scan);
    stopWatch();
    pointer.stale = false;
    listen(true);
    if (items) {
      const pos = items.findIndex((it) => itemWaits(r, it));
      if (pos === -1) { d.state.review = null; return false; }
      enterItem(r, pos);
      sayArrival(r);
    } else {
      const t = tally(scan.pairs);
      live('Pair ' + n0(first + 1) + ' of ' + n0(t.total) + '.');
    }
    d.render();
    focusTitle();
    return true;
  }

  function close() {
    const r = review();
    stopWatch();
    listen(false);
    d.state.review = null;
    for (const k of FOLD_KEYS) d.state.expandedGroups.delete(k);
    if (r) {
      d.disarm(r.scan);
      // Finished, it has said what it had to. What is left comes back by itself as pairs.
      for (const f of r.scan.families || []) if (f.stays && undecidedCount(f) === 0) retire(r, f);
    }
    const merged = r ? tally(r.scan.pairs).merged - r.mergedAtOpen + r.familyMerged : 0;
    live('');
    if (d.onClosed) d.onClosed(merged);
  }

  // Everything the desk waits for is decided here, after a paint, from the state alone:
  // a comparison that is missing is fetched, one that has arrived starts the 500 ms.
  function afterPaint() {
    const r = review();
    if (!r) { stopWatch(); listen(false); return; }
    listen(true);
    if (typeof document !== 'undefined') { paintPanes(); fitFacts(r); wireFind(r); }
    if (r.ended) return;
    if (r.family && familyAfterPaint(r)) return;
    // The label has its new width now. Still on Merge when the pair arrived: not a new press.
    if (r.checkHover) { r.checkHover = false; pointer.stale = pointer.type !== 'touch' && pointer.type !== 'pen' && overMerge(); }
    const pair = current(r);
    if (!pair) { close(); return; }
    if (pair.status !== 'open') {
      const moved = goToWaiting(r, r.index, 1);
      d.render();
      if (moved) focusTitle();
      return;
    }
    const key = d.pairKey(pair);
    const held = r.scan.preview;
    if (!(held && held.key === key)) {
      if (r.loadingKey !== key && !isBusy(key)) load(r, pair, key);
      return;
    }
    if (held.error || !held.data || d.armed(pair) || isBusy(key)) return;
    startArm(r, pair, key);
  }

  // ON A PHONE THE AI'S REASON IS NEVER CLIPPED, and the buttons under it still do not move
  // from pair to pair: the line is as tall as the longest reason in this walk needs, measured
  // once, at this width. A wide screen keeps its fixed line and its own scroll.
  function fitFacts(r) {
    const desk = document.querySelector('.hr-desk');
    const box = document.querySelector('.hr-facts');
    if (!desk || !box) return;
    if (r.family) { fitEvidence(r, desk, box); return; }
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 720px)').matches) {
      desk.style.removeProperty('--hr-facts-h');
      r.factsFit = null;
      return;
    }
    const longest = r.scan.pairs.reduce((a, p) => Math.max(a, String(p.rationale || '').length), 0);
    const fit = longest + '|' + box.clientWidth;
    // Set again after every paint: the keyed patch takes back an attribute its markup lacks.
    if (r.factsFit === fit || !box.clientWidth) { if (r.factsPx) desk.style.setProperty('--hr-facts-h', r.factsPx); return; }
    r.factsFit = fit;
    const text = (r.scan.pairs.find((p) => String(p.rationale || '').length === longest) || {}).rationale || '';
    const probe = box.cloneNode(false);
    probe.style.cssText = 'position:absolute;visibility:hidden;height:auto;width:' + box.clientWidth + 'px';
    probe.innerHTML = '<span class="hr-fact">' + RELATION_LABELS['version-differs'] + '</span> <span class="hr-reason">The AI says: "' + esc(text) + '"</span>';
    box.parentNode.appendChild(probe);
    const need = Math.ceil(probe.getBoundingClientRect().height);
    probe.remove();
    r.factsPx = Math.max(need, 40) + 'px';
    desk.style.setProperty('--hr-facts-h', r.factsPx);
  }

  // THE LINE ABOUT WHAT THE AI KNOWS IS ALWAYS WHOLE, and the buttons under it do not move: as tall
  // as the longest of this walk's lines needs, measured once at this width. Only a very long quote
  // on a wide screen scrolls, and the sentence that matters is its first line.
  function fitEvidence(r, desk, box) {
    const fam = r.family;
    const wide = typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 720px)').matches;
    const fit = fam.id + '|' + fam.stays + '|' + box.clientWidth;
    if (r.factsFit === fit || !box.clientWidth) { if (r.factsPx) desk.style.setProperty('--hr-facts-h', r.factsPx); return; }
    r.factsFit = fit;
    let longest = '';
    for (const p of fam.order) { const e = evidence(fam, p, RELATION_LABELS['version-differs'], true).html; if (e.length > longest.length) longest = e; }
    const probe = box.cloneNode(false);
    probe.style.cssText = 'position:absolute;visibility:hidden;height:auto;width:' + box.clientWidth + 'px';
    probe.innerHTML = longest;
    box.parentNode.appendChild(probe);
    const need = Math.ceil(probe.getBoundingClientRect().height);
    probe.remove();
    r.factsPx = Math.max(wide ? Math.min(need, 112) : need, 40) + 'px';
    desk.style.setProperty('--hr-facts-h', r.factsPx);
  }

  function wireFind(r) {
    const input = document.getElementById('hr-fam-find');
    if (!input || input.__wired) return;
    input.__wired = true;
    input.addEventListener('input', () => {
      const now = review();
      if (!now || !now.family) return;
      now.family.q = input.value;
      d.render();
    });
  }

  // ── A family ─────────────────────────────────────────────────────────
  function retire(r, fam) {
    fam.retired = true;
    if (r.scan.walkPairs) r.scan.walkPairs = r.scan.walkPairs.filter((p) => p.family !== fam.id);
  }

  async function loadFacts(r, fam) {
    if (fam.loadingFacts) return;
    fam.loadingFacts = true;
    try {
      const res = await d.familyFacts(r.slug, fam.pages);
      if (review() !== r) return;
      // Taken once and kept. See health-family.js: a merge must not change what this says.
      applyFacts(fam, res, r.scan.pairs);
      if (r.family === fam && r.outcome && r.outcome.retry === 'facts') r.outcome = null;
    } catch (err) {
      if (review() !== r) return;
      fam.factsError = err.message;
      if (r.family === fam) {
        r.outcome = { tone: 'error', retry: 'facts', html: 'Could not load the comparison: ' + esc(err.message) + retryButton(), spoken: 'Could not load the comparison: ' + err.message };
        live(r.outcome.spoken);
      }
    } finally {
      fam.loadingFacts = false;
    }
    if (review() === r) d.render();
  }

  // The page that stays, as it is now: for its figures on the last screen, and to read beside a
  // page already merged, when no comparison exists to carry it.
  async function loadKept(r, fam) {
    const at = fam.mergedOrder.length;
    if (fam.keptAt === at || fam.loadingKept === at) return;
    fam.loadingKept = at;
    try {
      const res = await d.familyFacts(r.slug, [fam.stays], fam.stays);
      if (review() !== r) return;
      const p = (res.pages || [])[0];
      if (!p || p.exists === false) throw new Error(slugOf(fam.stays) + ' no longer exists');
      const text = res.keptText ? res.keptText.text : '';
      fam.kept = { links: p.links || 0, length: p.length || 0, html: d.markdown(pageBody(text)) };
    } catch (err) {
      if (review() !== r) return;
      fam.kept = { failed: err.message };
    } finally {
      fam.keptAt = at;
      fam.loadingKept = -1;
    }
    d.render();
  }

  /** Decides what a family on screen waits for. True when the pair path has nothing to add. */
  function familyAfterPaint(r) {
    const fam = r.family;
    if (!fam.facts) { if (!fam.factsError) loadFacts(r, fam); return true; }
    if (fam.view === 'choose') return true;
    if (fam.view === 'finish') { loadKept(r, fam); return true; }
    if (r.checkHover) { r.checkHover = false; pointer.stale = pointer.type !== 'touch' && pointer.type !== 'pen' && overMerge(); }
    const page = fam.order[fam.i];
    if (fam.dec[page] === 'merged') { loadKept(r, fam); return true; }
    const pair = walkPairOf(r, fam, page);
    if (!pair) return true;
    const key = d.pairKey(pair);
    const held = r.scan.preview;
    if (!(held && held.key === key)) {
      if (r.loadingKey !== key && !isBusy(key)) load(r, pair, key);
      return true;
    }
    if (held.error || !held.data || fam.dec[page] || d.armed(pair) || isBusy(key)) return true;
    startArm(r, pair, key);
    return true;
  }

  /** The page that stays. Nothing is merged by this; each other page gets its own pair. */
  function pickStays(r, fam, page) {
    if (r.scan.walkPairs) r.scan.walkPairs = r.scan.walkPairs.filter((p) => p.family !== fam.id);
    const list = r.scan.walkPairs || (r.scan.walkPairs = []);
    fam.stays = page;
    fam.order = orderFor(fam, page);
    fam.dec = {};
    fam.pre = {};
    fam.mergedOrder = [];
    fam.keptReal = {};
    fam.kept = null;
    fam.keptAt = -1;
    fam.foldCount = 50;
    const info = fam.facts.info.get(page);
    fam.baseline = { links: info.links || 0, length: info.length || 0 };
    for (const other of fam.order) {
      const rel = relationOf(fam, other, page);
      const apart = fam.facts.kept.has(other < page ? other + '||' + page : page + '||' + other);
      if (apart) { fam.dec[other] = 'both'; fam.pre[other] = true; }
      list.push({ walk: true, family: fam.id,
        keepFolder: folderOf(page), keepSlug: slugOf(page), removeFolder: folderOf(other), removeSlug: slugOf(other),
        rationale: rel.reason || '', status: apart ? 'skipped' : 'open' });
    }
    const first = fam.order.findIndex((p) => !fam.dec[p]);
    fam.i = first === -1 ? 0 : first;
    fam.view = first === -1 ? 'finish' : 'walk';
    r.factsFit = null;
    resetForPage(r);
  }

  function factOfPage(r, fam, page) {
    const c = r.comparison;
    const pair = walkPairOf(r, fam, page);
    if (c && pair && c.key === d.pairKey(pair) && c.data && c.data.nameRelation) fam.relations = { ...(fam.relations || {}), [page]: c.data.nameRelation };
    const relation = fam.relations && fam.relations[page];
    return relation ? RELATION_LABELS[relation] : '';
  }

  function nextUndecided(fam, from) {
    for (let j = from + 1; j < fam.order.length; j++) if (!fam.dec[fam.order[j]]) return j;
    return -1;
  }

  function toFinish(r, fam) {
    resetForPage(r);
    fam.view = 'finish';
  }

  /** After a decision: the next page still waiting, or the summary. */
  function advanceWalk(r, fam) {
    const j = nextUndecided(fam, fam.i);
    if (j === -1) toFinish(r, fam);
    else { resetForPage(r); fam.i = j; }
    sayArrival(r);
    d.render();
    focusTitle();
  }

  /** A page gone from under the walk: not a decision, so it leaves the walk. */
  function familySettled(r, fam, missing, page) {
    const gone = missing || page;
    const said = 'This page is settled: ' + slugOf(gone) + ' no longer exists. Moving on.';
    r.outcome = { tone: 'info', familyMessage: true, html: 'This page is settled: ' + name(slugOf(gone)) + ' no longer exists. Moving on.', spoken: said };
    const message = r.outcome;
    if (gone === fam.stays) {
      retire(r, fam);
      goToWaiting(r, 0, 1);
      r.outcome = message;
    } else {
      const at = fam.order.indexOf(gone);
      if (at !== -1) {
        fam.order.splice(at, 1);
        delete fam.dec[gone];
        if (at < fam.i) fam.i--;
      }
      const j = nextUndecided(fam, fam.i - 1);
      if (j === -1) toFinish(r, fam);
      else { resetForPage(r); fam.i = j; }
    }
    sayArrival(r);
    d.render();
    focusTitle();
  }

  /** Keep all apart: the pairs the AI matched, so they do not come back. Nothing half done. */
  async function keepAllApart(r, fam) {
    if (fam.savingApart) return;
    const pairs = r.scan.pairs.filter((p) => p.status === 'open' && fam.pages.includes(keepOf(p)) && fam.pages.includes(removeOf(p)));
    fam.savingApart = true;
    r.outcome = null;
    d.render();
    const done = [];
    try {
      for (const p of pairs) { await d.keepApart(r.slug, p); done.push(p); }
    } catch (err) {
      for (const p of done) { try { await d.bringBack(r.slug, p); } catch { /* the failure below stands */ } }
      fam.savingApart = false;
      if (review() !== r) return;
      r.outcome = { tone: 'error', retry: 'apart', html: 'Could not save: ' + esc(err.message) + retryButton(), spoken: 'Could not save: ' + err.message };
      live(r.outcome.spoken);
      d.render();
      return;
    }
    fam.savingApart = false;
    if (review() !== r) return;
    for (const p of pairs) d.status(p, 'skipped');
    fam.keptAll = pairs;
    const n = fam.pages.length;
    const said = 'Kept these ' + n0(n) + ' pages apart. They will not come back. Pairs the AI has not compared may still come up later.';
    const message = { tone: 'success', undoAll: fam, spoken: said, html: said + ' ' + undoButton() };
    const moved = goToWaiting(r, 0, 1);
    r.outcome = message;
    sayArrival(r);
    d.render();
    if (moved) focusTitle();
    if (d.reload) d.reload(r.slug);
  }

  async function undoAllApart(r, fam) {
    const pairs = fam.keptAll || [];
    r.outcome = { ...r.outcome, html: String(r.outcome.html).replace(undoButton(), undoButton(true)) };
    d.render();
    try {
      for (const p of pairs) await d.bringBack(r.slug, p);
    } catch (err) {
      if (review() !== r) return;
      r.outcome = { tone: 'error', undoAllRetry: fam, html: 'Could not save: ' + esc(err.message) + retryButton(), spoken: 'Could not save: ' + err.message };
      live(r.outcome.spoken);
      d.render();
      return;
    }
    if (review() !== r) return;
    for (const p of pairs) d.status(p, 'open');
    fam.keptAll = null;
    const pos = r.items.findIndex((it) => it.kind === 'family' && it.fam === fam);
    r.outcome = null;
    if (pos !== -1) enterItem(r, pos);
    r.outcome = { tone: 'success', familyMessage: true, html: 'Brought back.', spoken: 'Brought back.' };
    live('Brought back.');
    d.render();
    focusTitle();
    if (d.reload) d.reload(r.slug);
  }

  /** Leftovers: each group of them becomes a decision of its own, right after this one. */
  function reviewLeftovers(r, fam) {
    const groups = leftovers(fam, r.scan.pairs);
    if (!groups.length) return;
    retire(r, fam);
    const made = groups.map((g) => {
      if (g.pages.length >= 3) {
        const nf = newFamily(g.pages, 'different-names');
        (r.scan.families || (r.scan.families = [])).push(nf);
        return { kind: 'family', fam: nf };
      }
      return { kind: 'pair', at: g.first };
    });
    r.items.splice(r.pos + 1, 0, ...made);
    r.outcome = null;
    enterItem(r, r.pos + 1);
    sayArrival(r);
    d.render();
    focusTitle();
  }

  // A new pair fades in over the old one's place. Its text starts at the top by itself:
  // the pane holds "Loading the page…" first, which leaves nothing to be scrolled.
  function paintPanes() {
    const panes = document.querySelector('.hr-panes[data-review-key]');
    if (!panes) return;
    const key = panes.getAttribute('data-review-key');
    if (panes.__shown === key) return;
    if (panes.__shown !== undefined) {
      panes.classList.remove('hr-swap');
      void panes.offsetWidth;
      panes.classList.add('hr-swap');
    }
    panes.__shown = key;
  }

  function startArm(r, pair, key) {
    const el = typeof document !== 'undefined' ? document.querySelector('.hr-panes[data-review-key]') : null;
    if (!el) return;
    if (watchedEl === el && watchedKey === key && cancelWatch) return;
    stopWatch();
    watchedEl = el;
    watchedKey = key;
    const hoverNone = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    cancelWatch = watchVisible([...el.querySelectorAll('.hr-pane')], armDelay(pointer.type, hoverNone), () => {
      cancelWatch = null;
      watchedEl = null;
      watchedKey = null;
      const now = review();
      if (!now) return;
      const p = current(now);
      if (!p || d.pairKey(p) !== key || p.status !== 'open') return;
      now.unseen = false;
      if (d.arm(p)) d.render();
    }, (unseen) => {
      const now = review();
      if (!now || now !== r || !!now.unseen === unseen) return;
      now.unseen = unseen;
      d.render();
    });
  }

  async function load(r, pair, key) {
    r.loadingKey = key;
    const res = await d.compare(r.slug, pair);
    if (r.loadingKey === key) r.loadingKey = null;
    const now = review();
    if (!now || now !== r) return;
    const p = current(r);
    if (res.settled && pair.walk) {
      if (r.family) familySettled(r, r.family, res.missing, removeOf(pair));
      return;
    }
    if (res.settled) {
      const page = res.missing || (pair.removeFolder + '/' + pair.removeSlug);
      r.outcome = { tone: 'info', html: 'This pair is settled: ' + name(page) + ' no longer exists. Moving on.',
        spoken: 'This pair is settled: ' + page + ' no longer exists. Moving on.' };
      const moved = goToWaiting(r, r.index, 1);
      sayArrival(r);
      d.render();
      if (moved) focusTitle();
      return;
    }
    if (!p || d.pairKey(p) !== key) { d.render(); return; }
    if (res.error) {
      // The text already on screen stays, and it cannot be merged on: the gate is shut.
      if (!r.comparison || r.comparison.key !== key) r.comparison = { key, error: res.error };
      r.outcome = { tone: 'error', retry: 'compare',
        html: 'Could not load the comparison: ' + esc(res.error) + retryButton(),
        spoken: 'Could not load the comparison: ' + res.error };
      r.refreshing = false;
      live(r.outcome.spoken);
      d.render();
      return;
    }
    if (!res.data) { d.render(); return; }
    r.comparison = { key, data: res.data, goes: d.markdown(pageBody(res.data.originals && res.data.originals.remove.text)),
      stays: d.markdown(pageBody(res.data.originals && res.data.originals.keep.text)) };
    if (r.refreshing) {
      r.refreshing = false;
      r.outcome = { tone: 'error', html: 'This page changed since you compared it. The comparison has been refreshed.',
        spoken: 'This page changed since you compared it. The comparison has been refreshed.' };
      live(r.outcome.spoken);
    }
    d.render();
  }

  const retryButton = () => ' <button type="button" class="btn btn-secondary btn-xs" id="hr-retry">Try again</button>';

  function sayArrival(r) {
    const t = tally(r.scan.pairs);
    const lead = r.outcome && r.outcome.spoken ? r.outcome.spoken + ' ' : '';
    if (r.items && !r.ended) {
      if (r.family) {
        const fam = r.family;
        if (fam.view === 'walk') {
          const page = fam.order[fam.i];
          live(lead + 'Page ' + n0(fam.i + 1) + ' of ' + n0(fam.order.length) + '. ' + evidence(fam, page, '').line1);
        } else if (fam.view === 'finish') {
          const c = counts(fam);
          live(lead + (c.left ? (c.left === 1 ? '1 page not decided.' : n0(c.left) + ' pages not decided.') : 'All decided.'));
        } else live(lead + 'Family of ' + n0(fam.pages.length) + ' pages. Decision ' + n0(r.pos + 1) + ' of ' + n0(r.items.length) + '.');
        return;
      }
      const solo = soloPairs(r);
      live(lead + 'Pair ' + n0(solo.indexOf(r.scan.pairs[r.index]) + 1) + ' of ' + n0(solo.length) + '.');
      return;
    }
    live(r.ended ? lead + 'All pairs decided.' : lead + 'Pair ' + n0(r.index + 1) + ' of ' + n0(t.total) + '.');
  }

  const soloPairs = (r) => r.items.filter((it) => it.kind === 'pair').map((it) => r.scan.pairs[it.at]);

  function moveOn(r, step) {
    const moved = goToWaiting(r, r.index, step);
    sayArrival(r);
    d.render();
    return moved;
  }

  function merge(r) {
    const pair = current(r);
    if (!pair) return undefined;
    r.outcome = null;
    stopWatch();
    if (pair.walk) live('Merging.');
    return d.merge(r.slug, pair, (out) => {
      const now = review();
      if (now !== r) return;
      const key = d.pairKey(pair);
      if (pair.walk && r.family && (out.merged || out.gone)) {
        const fam = r.family;
        const page = removeOf(pair);
        if (out.gone) { familySettled(r, fam, out.missing, page); return; }
        const links = r.comparison && r.comparison.key === key && r.comparison.data && r.comparison.data.originals
          ? Number(r.comparison.data.originals.remove.linksIn.links) || 0 : 0;
        const moved = links === 0 ? '' : links === 1 ? ' 1 link moved.' : ' ' + n0(links) + ' links moved.';
        fam.dec[page] = 'merged';
        fam.mergedOrder.push(page);
        r.familyMerged++;
        r.outcome = { tone: 'success', familyMessage: true, html: 'Merged ' + name(pair.removeSlug) + ' into ' + name(pair.keepSlug) + '.' + moved,
          spoken: 'Merged ' + pair.removeSlug + ' into ' + pair.keepSlug + '.' + moved };
        advanceWalk(r, fam);
        return;
      }
      if (out.merged) {
        const links = r.comparison && r.comparison.key === key && r.comparison.data && r.comparison.data.originals
          ? Number(r.comparison.data.originals.remove.linksIn.links) || 0 : 0;
        const moved = links === 0 ? '' : links === 1 ? ' 1 link moved.' : ' ' + n0(links) + ' links moved.';
        const also = out.alsoResolved ? (out.alsoResolved === 1 ? ' 1 other pair settled.' : ' ' + n0(out.alsoResolved) + ' other pairs settled.') : '';
        r.outcome = { tone: 'success', html: 'Merged ' + name(pair.removeSlug) + ' into ' + name(pair.keepSlug) + '.' + moved + also,
          spoken: 'Merged ' + pair.removeSlug + ' into ' + pair.keepSlug + '.' + moved + also };
        moveOn(r, 1);
      } else if (out.gone) {
        const page = out.missing || (pair.removeFolder + '/' + pair.removeSlug);
        r.outcome = { tone: 'info', html: 'This pair is settled: ' + name(page) + ' no longer exists. Moving on.',
          spoken: 'This pair is settled: ' + page + ' no longer exists. Moving on.' };
        moveOn(r, 1);
      } else if (out.stale) {
        // THE PAGE CHANGED UNDER THE COMPARISON. The gate shuts, the comparison is read
        // again, and the sentence says "refreshed" only once it has been (load, above).
        d.disarm(r.scan);
        r.refreshing = true;
        d.render();
      } else {
        const held = current(r) || pair;
        const failed = held.refusal || held.error;
        r.outcome = { tone: 'error', retry: 'merge', html: esc(failed) + (held.errorAction ? retryButton() : ''), spoken: failed };
        live(failed);
        d.render();
      }
      focusTitle();
    });
  }

  const undoButton = (saving) => '<button type="button" class="btn btn-secondary btn-xs" id="hr-undo"' + (saving ? ' aria-busy="true" aria-disabled="true">Saving…' : '>Undo') + '</button>';

  /** Undo on a walk: the pair is a question again, and the desk goes to it. */
  async function undoPage(r, fam, page) {
    const pair = walkPairOf(r, fam, page);
    if (!pair) return;
    const o = r.outcome;
    if (o && o.undoPage === page) { r.outcome = { ...o, html: o.html.replace(undoButton(), undoButton(true)) }; d.render(); }
    try {
      await d.bringBack(r.slug, pair);
    } catch (err) {
      if (review() !== r) return;
      r.outcome = { tone: 'error', undoPageRetry: page, family: fam, html: 'Could not save: ' + esc(err.message) + retryButton(), spoken: 'Could not save: ' + err.message };
      live(r.outcome.spoken);
      d.render();
      return;
    }
    if (review() !== r) return;
    delete fam.dec[page];
    delete fam.pre[page];
    d.status(pair, 'open');
    if (fam.keptReal[page]) {
      const real = r.scan.pairs.find((p) => d.pairKey(p) === fam.keptReal[page]);
      if (real && real.status === 'skipped') d.status(real, 'open');
      delete fam.keptReal[page];
    }
    resetForPage(r);
    fam.view = 'walk';
    fam.i = fam.order.indexOf(page);
    r.outcome = { tone: 'success', familyMessage: true, html: 'Brought back ' + name(slugOf(page)) + '.', spoken: 'Brought back ' + slugOf(page) + '.' };
    sayArrival(r);
    d.render();
    focusTitle();
    if (d.reload) d.reload(r.slug);
  }

  const undoLine = (pair, saving) => 'Kept ' + name(pair.removeSlug) + ' and ' + name(pair.keepSlug) + ' apart. They will not come back. ' +
    '<button type="button" class="btn btn-secondary btn-xs" id="hr-undo"' + (saving ? ' aria-busy="true" aria-disabled="true">Saving…' : '>Undo') + '</button>';

  function keepBoth(r) {
    const pair = current(r);
    if (!pair) return undefined;
    r.outcome = null;
    stopWatch();
    const kept = pair;
    return d.keepBoth(r.slug, pair, (out) => {
      if (review() !== r) return;
      if (out.kept && pair.walk && r.family) {
        const fam = r.family;
        const page = removeOf(pair);
        fam.dec[page] = 'both';
        // The AI's own pair for these two, in either direction, is decided too: the lanes count it.
        const real = r.scan.pairs.find((p) => p.status === 'open' && ((keepOf(p) === fam.stays && removeOf(p) === page) || (keepOf(p) === page && removeOf(p) === fam.stays)));
        if (real) { d.status(real, 'skipped'); fam.keptReal[page] = d.pairKey(real); }
        const said = 'Kept ' + pair.removeSlug + ' and ' + pair.keepSlug + ' apart. This pair will not come back.';
        r.outcome = { tone: 'success', familyMessage: true, undoPage: page, family: fam, spoken: said,
          html: 'Kept ' + name(pair.removeSlug) + ' and ' + name(pair.keepSlug) + ' apart. This pair will not come back. ' + undoButton() };
        advanceWalk(r, fam);
        return;
      }
      if (out.kept) {
        r.outcome = { tone: 'success', undo: kept, html: undoLine(kept, false),
          spoken: 'Kept ' + kept.removeSlug + ' and ' + kept.keepSlug + ' apart. They will not come back.' };
        moveOn(r, 1);
      } else {
        const held = current(r) || pair;
        const failed = held.refusal || held.error;
        r.outcome = { tone: 'error', retry: 'keep', html: esc(failed) + retryButton(), spoken: failed };
        live(failed);
        d.render();
      }
      focusTitle();
    });
  }

  async function undo(r) {
    const o = r.outcome;
    if (!o || !o.undo) return;
    const pair = o.undo;
    r.outcome = { tone: 'success', html: undoLine(pair, true), undo: pair, spoken: o.spoken };
    d.render();
    try {
      await d.bringBack(r.slug, pair);
      if (review() !== r) return;
      d.status(pair, 'open');
      const wasEnded = r.ended;
      r.outcome = { tone: 'success', html: 'Brought back.', spoken: 'Brought back.' };
      if (wasEnded && r.items) {
        const at = r.scan.pairs.findIndex((p) => d.pairKey(p) === d.pairKey(pair));
        const pos = r.items.findIndex((it) => it.kind === 'pair' && it.at === at);
        if (pos !== -1) enterItem(r, pos);
      } else if (wasEnded) goToWaiting(r, r.scan.pairs.indexOf(pair) - 1, 1);
      live('Brought back.');
    } catch (err) {
      if (review() !== r) return;
      r.outcome = { tone: 'error', html: 'Could not save: ' + esc(err.message) + retryButton(), undoRetry: pair, spoken: 'Could not save: ' + err.message };
      live(r.outcome.spoken);
    }
    d.render();
    focusTitle();
  }

  function onClick(btn) {
    const r = review();
    if (!r) return undefined;
    if (btn.id === 'hr-undo' && r.outcome && r.outcome.undoAll) return undoAllApart(r, r.outcome.undoAll);
    if (btn.id === 'hr-retry' && r.outcome && r.outcome.undoAllRetry) { const fam = r.outcome.undoAllRetry; r.outcome = { html: '', spoken: '' }; return undoAllApart(r, fam); }
    if (r.family) { const handled = familyClick(r, btn); if (handled !== NOT_MINE) return handled; }
    const pair = current(r);
    const key = pair ? d.pairKey(pair) : null;
    switch (btn.id) {
      case 'hr-done': close(); return undefined;
      case 'hr-next': moveOn(r, 1); return undefined;
      case 'hr-prev': moveOn(r, -1); return undefined;
      case 'hr-flip':
        if (!pair) return undefined;
        stopWatch();
        d.flip(pair);
        r.comparison = null;
        r.refreshing = false;
        clearPairMessage(current(r));
        // flipSemanticPair replaces the pair in place: read it back.
        live('Now ' + r.scan.pairs[r.index].keepSlug + ' stays.');
        d.render();
        return undefined;
      case 'hr-read-goes':
      case 'hr-read-stays': {
        if (!pair) return undefined;
        const goes = btn.id === 'hr-read-goes';
        const folder = goes ? pair.removeFolder : pair.keepFolder;
        const slug = goes ? pair.removeSlug : pair.keepSlug;
        return d.readPage(folder + '/' + slug + '.md', slug);
      }
      case 'hr-keep': return keepBoth(r);
      case 'hr-merge':
        // What the button promised is still on screen, or the press is refused here too.
        if (!r.comparison || r.comparison.key !== key || !r.comparison.data || !d.gate(pair).allowed || pointer.stale) return undefined;
        return merge(r);
      case 'hr-undo': return undo(r);
      case 'hr-retry': {
        const o = r.outcome;
        if (o && o.undoRetry) { r.outcome = { undo: o.undoRetry, spoken: o.spoken }; return undo(r); }
        const what = o && o.retry;
        r.outcome = null;
        if (pair) clearPairMessage(pair);
        if (what === 'merge') return merge(r);
        if (what === 'keep') return keepBoth(r);
        // Try again on a comparison: drop what was held, and the next paint asks again.
        if (r.scan.preview && r.scan.preview.key === key) r.scan.preview = null;
        if (r.comparison && r.comparison.error) r.comparison = null;
        d.render();
        return undefined;
      }
      case 'hr-fold-more':
      case 'hr-fold-earlier': {
        const w = foldWindow(r.scan.pairs.length, r.index, r.foldStart, r.foldCount);
        if (btn.id === 'hr-fold-more') { r.foldStart = w.from; r.foldCount = (w.to - w.from) + FOLD_PAGE; }
        else {
          const from = Math.max(0, w.from - FOLD_PAGE);
          r.foldStart = from;
          r.foldCount = (w.to - from);
        }
        d.render();
        return undefined;
      }
      default: break;
    }
    if (btn.dataset && btn.dataset.reviewJump !== undefined) {
      const at = Number(btn.dataset.reviewJump);
      if (r.items) {
        if (Number.isInteger(at) && r.items[at] && itemWaits(r, r.items[at])) {
          enterItem(r, at);
          sayArrival(r);
          d.render();
          focusTitle();
          if (d.headIntoView) d.headIntoView();
        }
        return undefined;
      }
      if (Number.isInteger(at) && r.scan.pairs[at] && r.scan.pairs[at].status === 'open') {
        r.ended = false;
        goTo(r, at);
        sayArrival(r);
        d.render();
        focusTitle();
        // The row can be thousands of pixels below the pair it brings up.
        if (d.headIntoView) d.headIntoView();
      }
    }
    return undefined;
  }

  function familyClick(r, btn) {
    const fam = r.family;
    const data = btn.dataset || {};
    const page = fam.view === 'walk' ? fam.order[fam.i] : null;
    const go = () => { sayArrival(r); d.render(); focusTitle(); };
    if (data.famPick !== undefined) {
      if (!fam.facts || !fam.pages.includes(data.famPick)) return undefined;
      r.outcome = null;
      pickStays(r, fam, data.famPick);
      go();
      return undefined;
    }
    if (data.famRead !== undefined) return fam.pages.includes(data.famRead) ? d.readPage(data.famRead + '.md', slugOf(data.famRead)) : undefined;
    if (data.famJump !== undefined) {
      const at = fam.order.indexOf(data.famJump);
      if (at === -1) return undefined;
      r.outcome = null;
      resetForPage(r);
      fam.i = at;
      go();
      if (d.headIntoView) d.headIntoView();
      return undefined;
    }
    if (data.famUndo !== undefined) return undoPage(r, fam, data.famUndo);
    switch (btn.id) {
      case 'hr-done':
        if (fam.view === 'walk' && !isFresh(fam)) { r.outcome = null; toFinish(r, fam); go(); return undefined; }
        close();
        return undefined;
      case 'hr-next':
        if (fam.view === 'choose') { moveOn(r, 1); focusTitle(); return undefined; }
        {
          r.outcome = null;
          const j = nextUndecided(fam, fam.i);
          if (j !== -1) { resetForPage(r); fam.i = j; } else if (fam.i < fam.order.length - 1) { resetForPage(r); fam.i += 1; } else toFinish(r, fam);
          go();
        }
        return undefined;
      case 'hr-prev':
        if (fam.view === 'choose') { moveOn(r, -1); focusTitle(); return undefined; }
        if (fam.i > 0) { r.outcome = null; resetForPage(r); fam.i -= 1; go(); }
        return undefined;
      case 'hr-fam-show': {
        const rows = chooseRows(fam);
        fam.shown += fam.shown === CHOOSE_FIRST && rows.rest <= 50 ? rows.rest : 50;
        d.render();
        return undefined;
      }
      case 'hr-fam-apart': return keepAllApart(r, fam);
      case 'hr-fam-rechoose':
        if (!isFresh(fam)) return undefined;
        if (r.scan.walkPairs) r.scan.walkPairs = r.scan.walkPairs.filter((p) => p.family !== fam.id);
        fam.stays = null; fam.view = 'choose'; fam.order = []; fam.dec = {}; fam.pre = {};
        r.outcome = null;
        resetForPage(r);
        go();
        return undefined;
      case 'hr-flip': {
        if (!page || !isFresh(fam)) return undefined;
        const old = fam.stays;
        pickStays(r, fam, page);
        const said = 'Now ' + slugOf(page) + ' stays, and ' + slugOf(old) + ' is one of the pages to go through.';
        r.outcome = { tone: 'info', familyMessage: true, html: 'Now ' + name(slugOf(page)) + ' stays, and ' + name(slugOf(old)) + ' is one of the pages to go through.', spoken: said };
        go();
        return undefined;
      }
      case 'hr-read-goes': return page ? d.readPage(page + '.md', slugOf(page)) : undefined;
      case 'hr-read-stays': return d.readPage(fam.stays + '.md', slugOf(fam.stays));
      case 'hr-keep': return page && !fam.dec[page] ? keepBoth(r) : undefined;
      case 'hr-merge': {
        if (!page || fam.dec[page]) return undefined;
        const pair = walkPairOf(r, fam, page);
        const key = pair ? d.pairKey(pair) : null;
        if (!pair || !r.comparison || r.comparison.key !== key || !r.comparison.data || !d.gate(pair).allowed || pointer.stale) return undefined;
        return merge(r);
      }
      case 'hr-undo': {
        const o = r.outcome;
        if (o && o.undoPage) return undoPage(r, o.family, o.undoPage);
        return page && fam.dec[page] === 'both' ? undoPage(r, fam, page) : undefined;
      }
      case 'hr-retry': {
        const o = r.outcome;
        const what = o && o.retry;
        if (o && o.undoPageRetry) { r.outcome = null; return undoPage(r, o.family, o.undoPageRetry); }
        r.outcome = null;
        if (what === 'facts') { fam.factsError = null; d.render(); return undefined; }
        if (what === 'apart') return keepAllApart(r, fam);
        const pair = page ? walkPairOf(r, fam, page) : null;
        if (pair) clearPairMessage(pair);
        if (what === 'merge') return merge(r);
        if (what === 'keep') return keepBoth(r);
        if (pair && r.scan.preview && r.scan.preview.key === d.pairKey(pair)) r.scan.preview = null;
        if (r.comparison && r.comparison.error) r.comparison = null;
        d.render();
        return undefined;
      }
      case 'hr-fam-fold-more': fam.foldCount += 50; d.render(); return undefined;
      case 'hr-fam-back': {
        const first = fam.order.findIndex((p) => !fam.dec[p]);
        if (first === -1) return undefined;
        r.outcome = null;
        resetForPage(r);
        fam.view = 'walk';
        fam.i = first;
        go();
        return undefined;
      }
      case 'hr-fam-residue': return reviewLeftovers(r, fam);
      default: break;
    }
    if (btn.id && btn.id.startsWith('hr-fam-res-more')) { fam.foldCount += 50; d.render(); return undefined; }
    return NOT_MINE;
  }

  // ── The model ───────────────────────────────────────────────────────────
  function familyModel(r) {
    const fam = r.family;
    const base = { familyClass: 'hr-desk-family', outcome: r.outcome, foldHtml: '', titleHtml: 'Family of ' + n0(fam.pages.length) + ' pages' };
    const stateOpen = (k) => d.state.expandedGroups.has(k);
    if (fam.view === 'choose') {
      const saving = !!fam.savingApart;
      const shut = saving || waitingItems(r) < 2;
      return { ...base, countText: 'Decision ' + n0(r.pos + 1) + ' of ' + n0(r.items.length), doneDisabled: saving, busy: saving,
        navHtml: navButton('hr-prev', 'Previous', shut) + navButton('hr-next', 'Next', shut),
        customHtml: renderChoose(fam, { size: formatSize, busy: saving, saving, fact: RELATION_LABELS[fam.relation], loading: !fam.factsError }) };
    }
    if (fam.view === 'finish') {
      const c = counts(fam);
      const note = typeof d.note === 'function' ? d.note() : d.note;
      return { ...base, countText: c.left ? (c.left === 1 ? '1 page not decided' : n0(c.left) + ' pages not decided') : 'All decided',
        navHtml: c.left ? navButton('hr-fam-back', c.left === 1 ? 'Go back to it' : 'Go back to them', false) : '', doneDisabled: false, busy: false,
        customHtml: renderFinish(fam, { size: formatSize, open: stateOpen, leftovers: leftovers(fam, r.scan.pairs), note: note || '' }) };
    }
    const page = fam.order[fam.i];
    const status = fam.dec[page];
    const pair = walkPairOf(r, fam, page);
    const key = pair ? d.pairKey(pair) : null;
    const merging = !!pair && d.state.busyKey === 'semanticMergeOne:' + key;
    const saving = !!pair && d.state.busyKey === 'semanticSkip:' + key;
    const busy = merging || saving;
    const goes = slugOf(page);
    const stays = slugOf(fam.stays);
    const fresh = isFresh(fam);
    const c = status === 'merged' ? null : (r.comparison && r.comparison.key === key ? r.comparison : null);
    const data = c && c.data ? c.data : null;
    const paneGoes = status === 'merged'
      ? { role: 'Merged', page: goes, meta: 'This page no longer exists', readId: null, flip: null,
          bodyHtml: '<p class="hr-fam-pane-note">Its text is on the page that stays, under Merged from ' + name(goes) + '.</p>' }
      : { role: 'Goes away', page: goes, readId: 'hr-read-goes', flip: fresh && !status ? { disabled: busy } : null,
          meta: data && data.originals ? folderOf(page) + ' · ' + linksMeta(data.originals.remove.linksIn) + ' · ' + formatSize(data.originals.remove.length) : folderOf(page),
          bodyHtml: data && data.originals ? '<div class="hr-pane-text">' + c.goes + '</div>' + (data.originals.remove.truncated ? '<p class="hr-pane-capped">(showing the first ' + n0(String(data.originals.remove.text).length) + ' characters)</p>' : '')
            : (c && c.error ? '' : '<p class="hr-pane-wait">Loading the page…</p>') };
    const kept = fam.kept && !fam.kept.failed && fam.keptAt === fam.mergedOrder.length ? fam.kept : null;
    const paneStays = { role: 'Stays', page: stays, readId: 'hr-read-stays', flip: null,
      meta: status === 'merged'
        ? (kept ? folderOf(fam.stays) + ' · ' + linksMeta({ links: kept.links }) + ' · ' + formatSize(kept.length) : folderOf(fam.stays))
        : (data && data.originals ? folderOf(fam.stays) + ' · ' + linksMeta(data.originals.keep.linksIn) + ' · ' + formatSize(data.originals.keep.length) : folderOf(fam.stays)),
      bodyHtml: status === 'merged'
        ? (kept ? '<div class="hr-pane-text">' + kept.html + '</div>' : '<p class="hr-pane-wait">Loading the page…</p>')
        : (data && data.originals ? '<div class="hr-pane-text">' + c.stays + '</div>' + (data.originals.keep.truncated ? '<p class="hr-pane-capped">(showing the first ' + n0(String(data.originals.keep.text).length) + ' characters)</p>' : '')
          : (c && c.error ? '' : '<p class="hr-pane-wait">Loading the page…</p>')) };
    const gate = pair ? d.gate(pair) : { allowed: false };
    const armedNow = !!(gate.allowed && data);
    const delay = armDelay(pointer.type, typeof matchMedia === 'function' && matchMedia('(hover: none)').matches);
    const decided = status === 'merged'
      ? { afterHtml: 'Merged into ' + name(stays) + '. Nothing more to decide here.', decideHtml: '' }
      : status === 'both'
        ? { afterHtml: 'You kept ' + name(goes) + ' and ' + name(stays) + ' apart.', decideHtml: '<div class="hr-decide-btns">' + undoButton() + '</div>' }
        : { afterHtml: data && data.originals ? afterLineWalk(goes, stays, data.originals.remove.linksIn.links) : '' };
    return { ...base, busy,
      reviewKey: (status === 'merged' ? 'merged:' : '') + (key || page),
      countText: countLine(fam),
      navHtml: navButton('hr-prev', 'Previous', busy || fam.i === 0) + navButton('hr-next', 'Next', busy),
      doneDisabled: busy,
      leadHtml: renderMarks(fam, true) + renderRunning(fam),
      factsHtml: evidence(fam, page, factOfPage(r, fam, page)).html,
      goes: paneGoes, stays: paneStays,
      afterHtml: decided.afterHtml,
      ...(decided.decideHtml !== undefined ? { decideHtml: decided.decideHtml } : {}),
      keepLabel: saving ? 'Saving…' : 'Keep both',
      keepAttrs: saving ? ' aria-busy="true" aria-disabled="true"' : (merging ? ' disabled' : ''),
      mergeLabelHtml: merging ? 'Merging…' : 'Merge ' + name(goes) + ' into ' + name(stays),
      mergeSpoken: merging ? 'Merging' : 'Merge ' + goes + ' into ' + stays,
      mergeAttrs: merging ? ' aria-busy="true" aria-disabled="true"' : ((!armedNow || saving || pointer.stale) ? ' disabled' : ''),
      gateText: status || busy ? '' : (armedNow && pointer.stale) ? 'Move the pointer off Merge and back to press it.'
        : (!armedNow && data && r.unseen) ? 'Merge opens once you have had both pages on screen.'
        : (!armedNow && data && delay !== ARM_MS) ? 'Merge opens in a moment, so both pages can be read.' : '',
      noteHtml: 'Merging deletes ' + name(goes) + '. ' + esc(typeof d.warn === 'function' ? d.warn() : d.warn),
      foldHtml: renderWalkFold(fam, stateOpen('reviewFamily'), busy),
    };
  }

  /** "All N decisions" when a family is in the list: the plain list when there is none. */
  function renderItemsFold(r, m) {
    const body = [];
    if (m.foldOpen) {
      const w = foldWindow(r.items.length, r.pos, m.foldStart, m.foldCount);
      body.push(foldSummary(m.tally));
      if (w.from > 0) body.push(moreButton('hr-fold-earlier', Math.min(w.from, FOLD_PAGE)));
      for (let i = w.from; i < w.to; i++) {
        const it = r.items[i];
        const waits = itemWaits(r, it);
        const here = i === r.pos && !r.ended;
        let label; let state;
        if (it.kind === 'family') {
          label = 'Family of ' + n0(it.fam.pages.length) + ' pages';
          state = waits ? 'waiting' : 'All decided';
        } else {
          const p = r.scan.pairs[it.at];
          label = name(p.removeSlug) + ' → ' + name(p.keepSlug);
          state = here && waits ? 'this pair' : waits ? 'waiting' : (ROW_STATE[p.status] || 'waiting');
        }
        body.push(renderFoldItem({ alias: 'dm', hostClass: 'hr-fold-row',
          mainHtml: waits && !here ? '<button type="button" class="btn btn-secondary btn-xs hr-jump" data-review-jump="' + i + '"' + (m.busy ? ' disabled' : '') + '>' + label + '</button>' : label,
          meta: state }));
      }
      if (w.to < r.items.length) body.push(moreButton('hr-fold-more', Math.min(r.items.length - w.to, FOLD_PAGE)));
    }
    return renderFoldRows(renderFoldRow({ key: 'reviewPairs', label: 'All ' + n0(r.items.length) + ' decisions', open: !!m.foldOpen, alias: 'dm', hostClass: 'hr-fold', bodyHtml: body.join('') }), { alias: 'dm' });
  }

  /** The end's figures: a family's pages count once each, never its pairs settled by a merge. */
  function tallyWithFamilies(r) {
    const t = tally(soloPairs(r));
    for (const it of r.items) {
      if (it.kind !== 'family') continue;
      const c = counts(it.fam);
      t.total += c.m + c.k + c.left; t.merged += c.m; t.kept += c.k; t.open += c.left; t.decided += c.m + c.k;
      if (it.fam.keptAll) { t.total += it.fam.pages.length; t.kept += it.fam.pages.length; t.decided += it.fam.pages.length; }
    }
    return t;
  }

  function model() {
    const r = review();
    if (!r) return null;
    if (r.family && !r.ended) return familyModel(r);
    const pairs = r.scan.pairs;
    const t = r.items ? tallyWithFamilies(r) : tally(pairs);
    const foldOpen = d.state.expandedGroups.has('reviewPairs');
    r.foldOpen = foldOpen;
    const pair = r.ended ? null : current(r);
    const key = pair ? d.pairKey(pair) : null;
    const merging = !!pair && d.state.busyKey === 'semanticMergeOne:' + key;
    const saving = !!pair && d.state.busyKey === 'semanticSkip:' + key;
    const busy = merging || saving;
    const common = { outcome: r.outcome, pairs, index: r.index, tally: t, busy, foldOpen, foldStart: r.foldStart, foldCount: r.foldCount };
    common.foldHtml = r.items ? renderItemsFold(r, common) : renderPairsFold(common);
    if (r.ended || !pair) {
      const left = d.coverageLeft ? d.coverageLeft() : 0;
      return { ...common, end: {
        counts: n0(t.merged) + ' merged · ' + n0(t.kept) + ' kept both · ' + n0(t.settled) + ' settled by another merge',
        more: left > 0 ? (left === 1 ? '1 pair has not been compared yet, shown in AI help.' : n0(left) + ' pairs have not been compared yet, shown in AI help.') : '',
      }, titleHtml: 'All pairs decided.', doneDisabled: false };
    }
    const c = r.comparison && r.comparison.key === key ? r.comparison : null;
    const data = c && c.data ? c.data : null;
    const gate = d.gate(pair);
    const armedNow = !!(gate.allowed && data);
    const relation = (data && data.nameRelation) || pair.nameRelation;
    const fact = RELATION_LABELS[relation];
    const facts = (fact ? '<span class="hr-fact">' + fact + '</span> ' : '') +
      '<span class="hr-reason">' + (pair.rationale ? 'The AI says: "' + esc(pair.rationale) + '"' : 'The AI gave no reason.') + '</span>';
    const pane = (side, role, readId, flip) => {
      const o = data && data.originals ? data.originals[side] : null;
      const page = side === 'remove' ? pair.removeSlug : pair.keepSlug;
      const folder = side === 'remove' ? pair.removeFolder : pair.keepFolder;
      const bodyHtml = o
        ? '<div class="hr-pane-text">' + (side === 'remove' ? c.goes : c.stays) + '</div>' +
          (o.truncated ? '<p class="hr-pane-capped">(showing the first ' + n0(String(o.text).length) + ' characters)</p>' : '')
        : (c && c.error ? '' : '<p class="hr-pane-wait">Loading the page…</p>');
      return { role, page, readId, flip, bodyHtml,
        meta: o ? folder + ' · ' + linksMeta(o.linksIn) + ' · ' + formatSize(o.length) : folder };
    };
    const goesPage = pair.removeSlug;
    const staysPage = pair.keepSlug;
    const outcomeBase = { ...common,
      reviewKey: key,
      titleHtml: r.items ? 'Pair ' + n0(soloPairs(r).indexOf(pair) + 1) + ' of ' + n0(soloPairs(r).length) : 'Pair ' + n0(r.index + 1) + ' of ' + n0(t.total),
      countText: r.items ? (() => { const s = tally(soloPairs(r)); return n0(s.decided) + ' decided · ' + n0(s.open) + ' left'; })() : n0(t.decided) + ' decided · ' + n0(t.open) + ' left',
      navDisabled: busy || (r.items ? waitingItems(r) < 2 : t.open < 2),
      doneDisabled: busy,
      factsHtml: facts,
      goes: pane('remove', 'Goes away', 'hr-read-goes', { disabled: busy }),
      stays: pane('keep', 'Stays', 'hr-read-stays', null),
      afterHtml: data && data.originals ? afterLine(goesPage, staysPage, data.originals.remove.linksIn.links, data.mergeOutcome && data.mergeOutcome.movedUnder) : '',
      keepLabel: saving ? 'Saving…' : 'Keep both',
      keepAttrs: saving ? ' aria-busy="true" aria-disabled="true"' : (merging ? ' disabled' : ''),
      mergeLabelHtml: merging ? 'Merging…' : 'Merge into ' + name(staysPage),
      mergeSpoken: merging ? 'Merging' : 'Merge into ' + staysPage,
      // aria-disabled while it runs, not disabled: a disabled control drops focus.
      mergeAttrs: merging ? ' aria-busy="true" aria-disabled="true"' : ((!armedNow || saving || pointer.stale) ? ' disabled' : ''),
      // Merge shut with no sign why is how a person concludes it is broken. Not said in the
      // ordinary half second, which is over before it could be read.
      gateText: busy ? '' : (armedNow && pointer.stale) ? 'Move the pointer off Merge and back to press it.'
        : (!armedNow && data && r.unseen) ? 'Merge opens once you have had both pages on screen.'
        : (!armedNow && data && armDelay(pointer.type, typeof matchMedia === 'function' && matchMedia('(hover: none)').matches) !== ARM_MS) ? 'Merge opens in a moment, so both pages can be read.' : '',
      noteHtml: 'Merging deletes ' + name(goesPage) + '. ' + esc(typeof d.warn === 'function' ? d.warn() : d.warn),
    };
    return outcomeBase;
  }

  function html() {
    const m = model();
    return m ? renderDesk(m) : '';
  }

  return { open, close, isOpen: () => !!review(), html, model, afterPaint, onClick, focusTitle, onPointer, onKey };
}
