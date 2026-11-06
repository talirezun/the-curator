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
// neither choice is violet, so the page does not lean toward deleting.
//
// A FAMILY WALK (Stage 6) IS THE SAME DESK. `renderDesk` draws a model and knows nothing
// about pairs: title, count, the two facts lines, two panes, the after line, the two
// decision buttons, the note, the outcome line and the fold. A walk fills in the same slots.

import { renderFoldRow, renderFoldItem, renderFoldRows } from '../shared/section.js';

/** How long the comparison must be on screen before Merge opens. */
export const ARM_MS = 500;
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
  const named = (p.role === 'Stays' ? 'Page that stays: ' : 'Page that goes away: ') + p.page;
  return '<article class="hr-pane hr-pane-' + (p.role === 'Stays' ? 'stays' : 'goes') + '" aria-label="' + esc(named) + '">' +
      '<header class="hr-pane-head">' +
        '<span class="hr-pane-role">' + p.role + '</span>' +
        '<span class="mono hr-pane-name">' + esc(p.page) + '</span>' +
        '<span class="hr-pane-meta">' + esc(p.meta) + '</span>' +
      '</header>' +
      '<div class="hr-pane-body" tabindex="0" role="group" aria-label="' + esc('Text of ' + p.page) + '">' + p.bodyHtml + '</div>' +
      '<div class="hr-pane-foot">' +
        '<button type="button" class="btn btn-secondary btn-xs" id="' + p.readId + '" aria-label="' + esc('Read full page: ' + p.page) + '">Read full page</button>' +
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
        (m.end ? '' : navButton('hr-prev', 'Previous', m.navDisabled) + navButton('hr-next', 'Next', m.navDisabled)) +
        navButton('hr-done', 'Done', m.doneDisabled) +
      '</div>' +
    '</div>';
  const middle = m.end
    ? '<div class="hr-facts"></div>' +
      '<div class="hr-panes hr-end"><p class="hr-end-line">' + esc(m.end.counts) + '</p>' +
        (m.end.more ? '<p class="hr-end-line">' + esc(m.end.more) + '</p>' : '') + '</div>' +
      '<div class="hr-after"></div>' +
      '<div class="hr-decide"></div>'
    : '<div class="hr-facts">' + m.factsHtml + '</div>' +
      '<div class="hr-panes" data-review-key="' + esc(m.reviewKey) + '">' + renderPane(m.goes) + renderPane(m.stays) + '</div>' +
      '<div class="hr-after">' + (m.afterHtml || '') + '</div>' +
      '<div class="hr-decide">' +
        '<div class="hr-decide-btns">' +
          '<button type="button" class="btn btn-secondary" id="hr-keep"' + m.keepAttrs + '>' + m.keepLabel + '</button>' +
          '<button type="button" class="btn btn-danger" id="hr-merge"' + m.mergeAttrs + ' aria-label="' + esc(m.mergeSpoken) + '"><span class="hr-merge-label">' + m.mergeLabelHtml + '</span></button>' +
        '</div>' +
        '<p class="hr-note">' + m.noteHtml + '</p>' +
      '</div>';
  return '<div class="hr-desk' + (m.busy ? ' hr-desk-busy' : '') + '">' + head + middle +
      '<div class="hr-outcome' + (m.outcome && m.outcome.tone === 'error' ? ' hr-outcome-failed' : '') + '">' + (m.outcome ? m.outcome.html : '') + '</div>' +
      m.foldHtml +
    '</div>';
}

// ── ON SCREEN FOR ms ──────────────────────────────────────────────────────
// Half of the panes, or half of a window too short for that. On a hidden tab nothing
// runs. No IntersectionObserver means nothing ever counts as seen: the safe direction.
export function watchVisible(el, ms, done) {
  if (typeof IntersectionObserver === 'undefined' || !el) return () => {};
  let timer = null;
  let seen = false;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const run = () => {
    stop();
    if (!seen || document.hidden) return;
    timer = setTimeout(() => { timer = null; cancel(); done(); }, ms);
  };
  const observer = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    const rect = e.intersectionRect || { height: 0 };
    const rootH = e.rootBounds ? e.rootBounds.height : (typeof window !== 'undefined' ? window.innerHeight : 0);
    const now = !!e.isIntersecting && (e.intersectionRatio >= 0.5 || (rootH > 0 && rect.height >= rootH * 0.5));
    if (now === seen) return;
    seen = now;
    run();
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  const onVisibility = () => run();
  document.addEventListener('visibilitychange', onVisibility);
  observer.observe(el);
  function cancel() {
    stop();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  }
  return cancel;
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
 */
export function createReviewDesk(d) {
  let cancelWatch = null;
  let watchedEl = null;
  let watchedKey = null;

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

  const current = (r) => r.scan.pairs[r.index] || null;
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
    r.comparison = null;
    r.refreshing = false;
    d.disarm(r.scan);
    const p = current(r);
    if (p && p.status === 'open' && r.foldOpen) {
      const w = foldWindow(r.scan.pairs.length, r.index, r.foldStart, r.foldCount);
      if (r.index < w.from || r.index >= w.to) { r.foldStart = null; r.foldCount = null; }
    }
  }

  function goToWaiting(r, from, step) {
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
    if (first === -1) return false;
    d.state.expandedGroups.delete('reviewPairs');
    d.state.review = { slug: d.slug(), scan, index: first, comparison: null, outcome: null, foldOpen: false,
      foldStart: null, foldCount: null, ended: false, refreshing: false, mergedAtOpen: tally(scan.pairs).merged };
    d.disarm(scan);
    stopWatch();
    const t = tally(scan.pairs);
    live('Pair ' + n0(first + 1) + ' of ' + n0(t.total) + '.');
    d.render();
    focusTitle();
    return true;
  }

  function close() {
    const r = review();
    stopWatch();
    d.state.review = null;
    d.state.expandedGroups.delete('reviewPairs');
    if (r) d.disarm(r.scan);
    const merged = r ? tally(r.scan.pairs).merged - r.mergedAtOpen : 0;
    live('');
    if (d.onClosed) d.onClosed(merged);
  }

  // Everything the desk waits for is decided here, after a paint, from the state alone:
  // a comparison that is missing is fetched, one that has arrived starts the 500 ms.
  function afterPaint() {
    const r = review();
    if (!r) { stopWatch(); return; }
    if (typeof document !== 'undefined') paintPanes(r);
    if (r.ended) return;
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

  // A pair's text starts at its top, and a new pair fades in over the old one's place.
  function paintPanes(r) {
    const panes = document.querySelector('.hr-panes[data-review-key]');
    if (!panes) return;
    const key = panes.getAttribute('data-review-key');
    const shown = r.comparison && r.comparison.key === key && r.comparison.data ? key + '|text' : key + '|wait';
    if (panes.__shown !== shown) {
      if (panes.__shown === undefined || panes.__shown.split('|')[0] !== key || shown.endsWith('|text')) {
        panes.querySelectorAll('.hr-pane-body').forEach((b) => { b.scrollTop = 0; });
      }
      if (panes.__shown !== undefined && panes.__shown.split('|')[0] !== key) {
        panes.classList.remove('hr-swap');
        void panes.offsetWidth;
        panes.classList.add('hr-swap');
      }
      panes.__shown = shown;
    }
  }

  function startArm(r, pair, key) {
    const el = typeof document !== 'undefined' ? document.querySelector('.hr-panes[data-review-key]') : null;
    if (!el) return;
    if (watchedEl === el && watchedKey === key && cancelWatch) return;
    stopWatch();
    watchedEl = el;
    watchedKey = key;
    cancelWatch = watchVisible(el, ARM_MS, () => {
      cancelWatch = null;
      watchedEl = null;
      watchedKey = null;
      const now = review();
      if (!now) return;
      const p = current(now);
      if (!p || d.pairKey(p) !== key || p.status !== 'open') return;
      if (d.arm(p)) d.render();
    });
  }

  async function load(r, pair, key) {
    r.loadingKey = key;
    const res = await d.compare(r.slug, pair);
    if (r.loadingKey === key) r.loadingKey = null;
    const now = review();
    if (!now || now !== r) return;
    const p = current(r);
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
    live(r.ended ? lead + 'All pairs decided.' : lead + 'Pair ' + n0(r.index + 1) + ' of ' + n0(t.total) + '.');
  }

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
    return d.merge(r.slug, pair, (out) => {
      const now = review();
      if (now !== r) return;
      const key = d.pairKey(pair);
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
      if (wasEnded) goToWaiting(r, r.scan.pairs.indexOf(pair) - 1, 1);
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
        if (!r.comparison || r.comparison.key !== key || !r.comparison.data || !d.gate(pair).allowed) return undefined;
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
      if (Number.isInteger(at) && r.scan.pairs[at] && r.scan.pairs[at].status === 'open') {
        r.ended = false;
        goTo(r, at);
        sayArrival(r);
        d.render();
        focusTitle();
      }
    }
    return undefined;
  }

  // ── The model ───────────────────────────────────────────────────────────
  function model() {
    const r = review();
    if (!r) return null;
    const pairs = r.scan.pairs;
    const t = tally(pairs);
    const foldOpen = d.state.expandedGroups.has('reviewPairs');
    r.foldOpen = foldOpen;
    const pair = r.ended ? null : current(r);
    const key = pair ? d.pairKey(pair) : null;
    const merging = !!pair && d.state.busyKey === 'semanticMergeOne:' + key;
    const saving = !!pair && d.state.busyKey === 'semanticSkip:' + key;
    const busy = merging || saving;
    const common = { outcome: r.outcome, pairs, index: r.index, tally: t, busy, foldOpen, foldStart: r.foldStart, foldCount: r.foldCount };
    common.foldHtml = renderPairsFold(common);
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
      titleHtml: 'Pair ' + n0(r.index + 1) + ' of ' + n0(t.total),
      countText: n0(t.decided) + ' decided · ' + n0(t.open) + ' left',
      navDisabled: busy || t.open < 2,
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
      mergeAttrs: merging ? ' aria-busy="true" aria-disabled="true"' : ((!armedNow || saving) ? ' disabled' : ''),
      noteHtml: 'Merging deletes ' + name(goesPage) + '. ' + esc(typeof d.warn === 'function' ? d.warn() : d.warn),
    };
    return outcomeBase;
  }

  function html() {
    const m = model();
    return m ? renderDesk(m) : '';
  }

  return { open, close, isOpen: () => !!review(), html, model, afterPaint, onClick, focusTitle };
}
