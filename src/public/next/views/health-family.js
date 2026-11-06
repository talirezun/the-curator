// ═══════════════════════════════════════
//  views/health-family.js — WHAT A FAMILY IS, AND ITS WORDS (Wiki health)
// ═══════════════════════════════════════
//
// When pairs share pages the review desk offers them as one family: press the page that
// stays, then the others come up one at a time in the same desk (views/health-review.js,
// which owns the walk and every call). This file is the part with no state of its own:
// the grouping, what may be said about two pages, and the markup. It imports nothing that
// needs a browser, so a suite can read every arm.
//
// A~B AND B~C NEVER MEAN A~C. A family is only "these pages are connected by answers".
// `relationOf` is the one place a statement about two pages is decided, and it looks up
// that exact pair or answers `never`. There is no path through this file by which an answer
// about one page reaches another.
//
// THE FACTS ARE A SNAPSHOT, taken once when the family opens and kept. A merge closes every
// pair naming the page it deleted (resolvePairsTouching) and usually changes the kept page's
// opening, so its other answers lapse on the server. Neither may take a page out of the walk
// or change what the screen says about a comparison that did happen.

import { renderFoldRow, renderFoldItem, renderFoldRows } from '../shared/section.js';

/** The row of small page marks: awaiting the owner's look. False removes it and nothing else. */
export const SHOW_MARKS = true;
/** The choosing list shows this many before "Show the other {m}". */
export const CHOOSE_FIRST = 8;
const PAGE_STEP = 50;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (v) => (Number(v) || 0).toLocaleString('en-US');
const name = (s) => '<span class="mono">' + esc(s) + '</span>';
const plural = (n, one, many) => n0(n) + ' ' + (n === 1 ? one : (many || one + 's'));
const btn = (id, label, extra) => '<button type="button" class="btn btn-secondary btn-xs"' + (id ? ' id="' + id + '"' : '') + (extra || '') + '>' + label + '</button>';

export const slugOf = (page) => String(page).slice(String(page).indexOf('/') + 1);
export const folderOf = (page) => String(page).slice(0, String(page).indexOf('/'));
export const keepOf = (p) => p.keepFolder + '/' + p.keepSlug;
export const removeOf = (p) => p.removeFolder + '/' + p.removeSlug;
const edgeKey = (a, b) => (a < b ? a + '||' + b : b + '||' + a);

// ── THE GROUPING ──────────────────────────────────────────────────────────
/** Connected pages among these pairs. Each group: { pages, first } (first = its first pair's position). */
export function connectedGroups(entries) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  for (const { pair } of entries) parent.set(find(keepOf(pair)), find(removeOf(pair)));
  const groups = new Map();
  for (const page of parent.keys()) {
    const root = find(page);
    if (!groups.has(root)) groups.set(root, { pages: [], first: Infinity, members: [] });
    groups.get(root).pages.push(page);
  }
  for (const entry of entries) {
    const g = groups.get(find(keepOf(entry.pair)));
    g.first = Math.min(g.first, entry.at);
    g.members.push(entry);
  }
  for (const g of groups.values()) g.pages.sort();
  return [...groups.values()].sort((a, b) => a.first - b.first);
}

let familySerial = 0;
export function newFamily(pages, relation) {
  return { id: 'family-' + (++familySerial), pages: [...pages].sort(), relation: relation || 'different-names',
    facts: null, factsError: null, view: 'choose', stays: null, order: [], i: 0, dec: {}, pre: {}, mergedOrder: [],
    keptReal: {}, baseline: null, kept: null, keptAt: -1, shown: CHOOSE_FIRST, q: '', foldCount: PAGE_STEP, retired: false, keptAll: null };
}

/** One word for a family: its pairs' own fact from the server when they agree, else the broadest. */
function familyRelation(members) {
  const seen = new Set(members.map((m) => m.pair.nameRelation).filter(Boolean));
  return seen.size === 1 ? [...seen][0] : 'different-names';
}

export const undecidedCount = (f) => f.order.filter((p) => !f.dec[p]).length;
export const familyWaiting = (f) => !f.retired && !f.keptAll && (f.view === 'choose' || undecidedCount(f) > 0);

/**
 * The desk's list of decisions, from the pairs and any family already under way. A family under
 * way holds every pair between its pages, so the same pages do not come up twice. With no family
 * at all this returns null and the desk is the plain pair desk it always was.
 */
export function planDecisions(scan) {
  const started = (scan.families || []).filter((f) => !f.retired && f.stays && undecidedCount(f) > 0);
  const inStarted = (p) => started.find((f) => f.pages.includes(keepOf(p)) && f.pages.includes(removeOf(p)));
  const open = [];
  const items = [];
  scan.pairs.forEach((pair, at) => {
    if (pair.status === 'open' && !inStarted(pair)) open.push({ at, pair });
  });
  const groups = connectedGroups(open);
  const fresh = groups.filter((g) => g.pages.length >= 3).map((g) => ({ at: g.first, fam: newFamily(g.pages, familyRelation(g.members)) }));
  if (fresh.length === 0 && started.length === 0) return null;
  scan.families = [...started, ...fresh.map((x) => x.fam)];
  const inFamily = new Set(groups.filter((g) => g.pages.length >= 3).flatMap((g) => g.members.map((m) => m.at)));
  const familyAt = new Map(fresh.map((x) => [x.at, x.fam]));
  scan.pairs.forEach((pair, at) => {
    if (familyAt.has(at)) { items.push({ kind: 'family', fam: familyAt.get(at) }); return; }
    if (pair.status !== 'open' || inFamily.has(at) || inStarted(pair)) return;
    items.push({ kind: 'pair', at });
  });
  // A FAMILY YOU LEFT COMES LAST. Inside a walk Next moves through its pages, and Done goes back to
  // the lanes, so if it came first Review would open on it every time and nothing else could be
  // reached. Next and Previous still reach it, and with nothing else left it opens by itself.
  for (const fam of started) items.push({ kind: 'family', fam });
  return items;
}

/** Pages waiting on a walk under way that no open pair names, so nothing else would list them. */
export function walkPagesWithNoPair(scan) {
  const named = new Set();
  for (const p of scan.pairs) if (p.status === 'open') { named.add(keepOf(p)); named.add(removeOf(p)); }
  let n = 0;
  for (const f of scan.families || []) {
    if (f.retired || !f.stays) continue;
    for (const p of f.order) if (!f.dec[p] && !named.has(p)) n++;
  }
  return n;
}

// ── THE FACTS ─────────────────────────────────────────────────────────────
/**
 * What the server read, kept for as long as the family is open. A pair the desk holds as open
 * that the server has no answer for (its cache could not be written) still counts as compared.
 */
export function applyFacts(fam, res, pairs) {
  const info = new Map();
  for (const p of res.pages || []) if (p.exists !== false) info.set(p.page, p);
  const answers = new Map();
  for (const a of res.answers || []) answers.set(edgeKey(a.a, a.b), { compared: a.compared, reason: a.rationale || null });
  for (const p of pairs) {
    const k = edgeKey(keepOf(p), removeOf(p));
    const had = answers.get(k);
    if (p.status === 'open' && info.has(keepOf(p)) && info.has(removeOf(p))) {
      if (!had) answers.set(k, { compared: 'same', reason: p.rationale || null });
      else if (had.compared === 'same' && !had.reason) had.reason = p.rationale || null;
    }
  }
  fam.pages = fam.pages.filter((p) => info.has(p));
  const counts = new Map(fam.pages.map((p) => [p, 0]));
  let total = 0;
  for (const [k, v] of answers) {
    if (v.compared !== 'same' && v.compared !== 'different') continue;
    const [a, b] = k.split('||');
    if (!counts.has(a) || !counts.has(b)) continue;
    counts.set(a, counts.get(a) + 1); counts.set(b, counts.get(b) + 1); total++;
  }
  fam.facts = { info, answers, counts, total, kept: new Set((res.kept || []).map(([a, b]) => edgeKey(a, b))) };
  fam.factsError = null;
}

/** The ONLY place a statement about two pages is decided: their own answer, or never. */
export function relationOf(fam, page, other) {
  const a = fam.facts && fam.facts.answers.get(edgeKey(page, other));
  return a ? { kind: a.compared, reason: a.reason } : { kind: 'never', reason: null };
}

/** The page the AI did match this one with, if any: never the page that stays. */
export function matchedWith(fam, page, stays) {
  for (const other of fam.pages) {
    if (other === page || other === stays) continue;
    if (relationOf(fam, page, other).kind === 'same') return other;
  }
  return null;
}

const RANK = { same: 0, never: 1, stale: 2, different: 3 };
/** The strongest first, so stopping early leaves the strongest done. */
export function orderFor(fam, stays) {
  const links = (p) => fam.facts.info.get(p).links || 0;
  return fam.pages.filter((p) => p !== stays).sort((a, b) =>
    (RANK[relationOf(fam, a, stays).kind] - RANK[relationOf(fam, b, stays).kind]) || (links(b) - links(a)) || (a < b ? -1 : 1));
}

export function counts(fam) {
  let m = 0; let k = 0;
  for (const p of fam.order) { if (fam.dec[p] === 'merged') m++; else if (fam.dec[p] === 'both') k++; }
  return { m, k, left: fam.order.length - m - k };
}

/** Before the first decision the page that stays can still change. A pair kept apart earlier is not one. */
export function isFresh(fam) {
  return fam.mergedOrder.length === 0 && Object.keys(fam.dec).every((p) => fam.pre[p]);
}

/** Pages left over that still match one another. Open pairs only, so a kept pair never counts. */
export function leftovers(fam, pairs) {
  const rest = new Set(fam.pages.filter((p) => p !== fam.stays && fam.dec[p] !== 'merged'));
  const entries = [];
  pairs.forEach((pair, at) => { if (pair.status === 'open' && rest.has(keepOf(pair)) && rest.has(removeOf(pair))) entries.push({ at, pair }); });
  return connectedGroups(entries);
}

// ── THE WORDS ─────────────────────────────────────────────────────────────
export function evidence(fam, page, fact, assumeMerged) {
  const stays = fam.stays;
  const r = relationOf(fam, page, stays);
  const staysName = name(slugOf(stays));
  let line1; let line2; let amber = true;
  if (r.kind === 'same' || r.kind === 'different') {
    amber = false;
    line1 = r.kind === 'same' ? 'The AI compared these two pages and said they are the same.' : 'The AI compared these two pages and said they are not the same.';
    line2 = r.reason ? 'The AI says: "' + esc(r.reason) + '"' : 'The reason it gave was not kept.';
  } else if (r.kind === 'stale') {
    line1 = 'The AI compared older versions of these two pages.';
    line2 = 'Its answer no longer applies. Only your reading decides this one.';
  } else {
    line1 = 'The AI never compared these two pages.';
    const other = matchedWith(fam, page, stays);
    if (!other) line2 = 'Only your reading decides this one.';
    else {
      const since = assumeMerged || fam.dec[other] === 'merged';
      line2 = 'It is here because the AI matched it with ' + name(slugOf(other)) + (since ? ', which you have since merged in' : '') +
        '. That says nothing about ' + staysName + '. Only your reading decides this one.';
    }
  }
  return { line1, amber,
    html: '<div class="hr-ev' + (amber ? ' hr-ev-never' : '') + '"><span class="hr-ev-line">' + (fact ? '<span class="hr-fact">' + esc(fact) + '</span> ' : '') +
      '<strong>' + line1 + '</strong></span><span class="hr-ev-line">' + line2 + '</span></div>' };
}

export function countLine(fam) {
  const c = counts(fam);
  return 'Page ' + n0(fam.i + 1) + ' of ' + n0(fam.order.length) + ' · ' + n0(c.m) + ' merged · ' + n0(c.k) + ' kept · ' + n0(c.left) + ' left';
}

function groupsOf(fam) {
  const g = { same: [], never: [], stale: [], different: [] };
  for (const p of fam.order) g[relationOf(fam, p, fam.stays).kind].push(p);
  return g;
}

export function marksWords(fam) {
  const g = groupsOf(fam);
  const parts = [];
  if (g.same.length) parts.push(n0(g.same.length) + ' the AI said ' + (g.same.length === 1 ? 'is' : 'are') + ' the same');
  if (g.never.length) parts.push(n0(g.never.length) + ' it never compared');
  if (g.stale.length) parts.push(n0(g.stale.length) + ' it compared in older versions');
  if (g.different.length) parts.push(n0(g.different.length) + ' it said ' + (g.different.length === 1 ? 'is' : 'are') + ' not the same');
  return parts.join(' · ');
}

/** One small mark per page. Beside its words; to a screen reader, the same counts in a sentence. */
export function renderMarks(fam, onWalk) {
  const c = counts(fam);
  const g = groupsOf(fam);
  const here = onWalk ? fam.order[fam.i] : null;
  const mark = (p, kind) => '<span class="hr-mark' + (kind === 'never' || kind === 'stale' ? ' hr-mark-never' : '') +
    (fam.dec[p] === 'merged' ? ' hr-mark-merged' : fam.dec[p] === 'both' ? ' hr-mark-kept' : '') + (p === here ? ' hr-mark-here' : '') + '"></span>';
  const row = !SHOW_MARKS ? '' : '<div class="hr-marks" role="img" aria-label="' + esc(n0(fam.order.length) + ' pages to go through: ' + n0(c.m) + ' merged, ' + n0(c.k) + ' kept, ' + n0(c.left) + ' left') + '">' +
    ['same', 'never', 'stale', 'different'].filter((k) => g[k].length).map((k) => '<span class="hr-marks-group">' + g[k].map((p) => mark(p, k)).join('') + '</span>').join('') + '</div>';
  return '<div class="hr-marks-row">' + row + '<span class="hr-marks-words">' + marksWords(fam) + '</span></div>';
}

export function renderRunning(fam) {
  const c = counts(fam);
  return '<p class="hr-running"><span>' + name(slugOf(fam.stays)) + ' stays.' + (c.m ? ' It has taken in ' + plural(c.m, 'page') + ' so far.' : '') + '</span>' +
    (isFresh(fam) ? btn('hr-fam-rechoose', 'Choose again') : '') + '</p>';
}

export function afterLineWalk(goes, stays, links) {
  const count = Number(links) || 0;
  const moved = count === 0 ? 'No links move, because nothing links here.' : count === 1 ? '1 link moves to it.' : n0(count) + ' links move to it.';
  return 'After the merge there is one page, ' + name(stays) + '. Lists from ' + name(goes) + ' join the sections of the same name, and everything else moves under "Merged from ' + name(goes) + '". ' + moved;
}

const FOLD_HEADS = {
  same: 'The AI said these are the same as ',
  never: 'The AI never compared these with ',
  stale: 'The AI compared older versions of these and ',
  different: 'The AI said these are not the same as ',
};

function moreRows(id, count) {
  return '<div class="hr-fold-more">' + btn(id, 'Show ' + n0(count) + ' more') + '</div>';
}

export function renderWalkFold(fam, open, busy) {
  const g = groupsOf(fam);
  const body = [];
  if (open) {
    let left = fam.foldCount;
    for (const kind of ['same', 'never', 'stale', 'different']) {
      if (!g[kind].length || left <= 0) continue;
      body.push('<div class="hr-fam-group">' + FOLD_HEADS[kind] + name(slugOf(fam.stays)) + ' (' + n0(g[kind].length) + ')</div>');
      for (const p of g[kind].slice(0, left)) {
        const here = p === fam.order[fam.i];
        body.push('<button type="button" class="hr-fam-jump" data-fam-jump="' + esc(p) + '"' + (here ? ' aria-current="true"' : '') + (busy ? ' disabled' : '') + '>' +
          name(slugOf(p)) + '<span class="hr-fam-jump-state">' + (here ? 'this page' : fam.dec[p] === 'merged' ? 'merged' : fam.dec[p] === 'both' ? 'kept both' : 'waiting') + '</span></button>');
      }
      left -= g[kind].length;
    }
    if (fam.foldCount < fam.order.length) body.push(moreRows('hr-fam-fold-more', Math.min(fam.order.length - fam.foldCount, PAGE_STEP)));
  }
  return renderFoldRows(renderFoldRow({ key: 'reviewFamily', label: 'All ' + n0(fam.order.length) + ' pages', open: !!open, alias: 'dm', hostClass: 'hr-fold', bodyHtml: body.join('') }), { alias: 'dm' });
}

// ── STEP 1: WHICH PAGE STAYS ──────────────────────────────────────────────
export function chooseRows(fam) {
  const info = fam.facts ? fam.facts.info : null;
  const all = [...fam.pages].sort((a, b) => info ? ((info.get(b).links - info.get(a).links) || (info.get(b).length - info.get(a).length) || (a < b ? -1 : 1)) : (a < b ? -1 : 1));
  const q = String(fam.q || '').trim().toLowerCase();
  const found = q ? all.filter((p) => slugOf(p).toLowerCase().includes(q)) : all;
  const shown = q ? found : found.slice(0, fam.shown);
  return { total: all.length, found, shown, rest: q ? 0 : found.length - shown.length };
}

/** A page's opening as a sentence to read: no markdown, none of the next section. */
export function firstWords(opening) {
  const first = String(opening || '').split(/\n\s*\n|\n#{1,6}\s|\s#{2,6}\s/)[0];
  return first.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim();
}

export function renderChoose(fam, ctx) {
  const n = fam.pages.length;
  const f = fam.facts;
  const summary = !f ? '' : (() => {
    let links = 0; let size = 0;
    for (const p of fam.pages) { links += f.info.get(p).links || 0; size += f.info.get(p).length || 0; }
    const possible = n * (n - 1) / 2;
    return n0(n) + ' pages, ' + plural(links, 'link') + ' pointing to them, ' + ctx.size(size) + ' of text. The AI compared ' + n0(f.total) + ' of the ' + n0(possible) + ' possible pairs here. A match between two pages says nothing about a third.';
  })();
  const r = chooseRows(fam);
  const row = (p) => {
    const i = f ? f.info.get(p) : null;
    const meta = i ? plural(i.links || 0, 'link') + ' · ' + ctx.size(i.length) + ' · AI compared it with ' + n0(f.counts.get(p)) + ' of the other ' + n0(n - 1) : '';
    return '<div class="hr-fam-row"><button type="button" class="hr-fam-pick" data-fam-pick="' + esc(p) + '"' + (f && !ctx.busy ? '' : ' disabled') + '>' +
        '<span class="hr-fam-pick-top"><span class="mono hr-fam-pick-name">' + esc(slugOf(p)) + '</span><span class="hr-fam-pick-meta">' + meta + '</span></span>' +
        '<span class="hr-fam-pick-open">' + esc(i ? firstWords(i.opening) : '') + '</span>' +
      '</button><button type="button" class="hr-fam-read" data-fam-read="' + esc(p) + '" aria-label="' + esc('Read full page: ' + slugOf(p)) + '">Read</button></div>';
  };
  const showing = fam.shown > CHOOSE_FIRST;
  const more = r.rest <= 0 ? '' : showing ? btn('hr-fam-show', 'Show ' + n0(Math.min(r.rest, PAGE_STEP)) + ' more') : btn('hr-fam-show', 'Show the other ' + n0(r.rest));
  return '<div class="hr-fam-summary"><p class="hr-fam-sum-line">' + (ctx.fact ? '<span class="hr-fact">' + esc(ctx.fact) + '</span> ' : '') + (f ? summary : esc(ctx.loading ? 'Loading…' : '')) + '</p></div>' +
    '<h5 class="hr-fam-q">Which page stays?</h5>' +
    '<p class="hr-fam-sub">Press it. Nothing is merged yet: the others then come up one at a time, beside it, for you to decide.</p>' +
    '<div class="hr-fam-list">' + (r.shown.length ? r.shown.map(row).join('') : '<p class="hr-fam-none">No page in this family has that in its name.</p>') + '</div>' +
    (n > CHOOSE_FIRST ? '<div class="hr-fam-more">' + more + '<input type="search" id="hr-fam-find" class="hr-fam-find" placeholder="Find a page in this family" aria-label="Find a page in this family" value="' + esc(fam.q || '') + '"></div>' : '') +
    '<div class="hr-fam-apart"><span>Different things that only look alike?</span>' +
      '<button type="button" class="btn btn-secondary btn-xs" id="hr-fam-apart"' + (ctx.saving ? ' aria-busy="true" aria-disabled="true">Saving…' : ((f && !ctx.busy ? '' : ' disabled') + '>Keep all ' + n0(n) + ' apart')) + '</button></div>';
}

// ── THE END OF A WALK ─────────────────────────────────────────────────────
function resultFold(key, label, meta, open, line, rows, count) {
  const shown = rows.slice(0, count);
  return renderFoldRow({ key, label, meta, open: !!open, alias: 'dm', hostClass: 'hr-fold',
    bodyHtml: open ? '<p class="hr-fam-res-line">' + line + '</p>' + shown.join('') + (rows.length > count ? moreRows('hr-fam-res-more-' + key, Math.min(rows.length - count, PAGE_STEP)) : '') : '' });
}

export function renderFinish(fam, ctx) {
  const c = counts(fam);
  const stays = slugOf(fam.stays);
  const merged = fam.mergedOrder;
  const keptPages = fam.order.filter((p) => fam.dec[p] === 'both');
  const notDecided = fam.order.filter((p) => !fam.dec[p]);
  const never = merged.filter((p) => relationOf(fam, p, fam.stays).kind === 'never');
  const row = (p, right) => '<div class="hr-fam-res-row">' + name(slugOf(p)) + (right || '') + '</div>';
  const b = fam.baseline;
  const k = fam.kept;
  const grew = !c.m ? 'Nothing was merged into it.'
    : 'Took in ' + plural(c.m, 'page') + '.' + (b && k && !k.failed ? ' Links pointing to it went from ' + n0(b.links) + ' to ' + n0(k.links) + ', its text from ' + ctx.size(b.length) + ' to ' + ctx.size(k.length) + '.' : '');
  let neverLine = '';
  if (never.length) {
    const names = never.length <= 2 ? ': ' + never.map((p) => name(slugOf(p))).join(' and ') : '';
    neverLine = '<p class="hr-ev hr-ev-never hr-fam-never">You merged ' + plural(never.length, 'page') + ' the AI never compared with ' + name(stays) + names + '. Only your reading decided ' + (never.length === 1 ? 'it' : 'them') + '.</p>';
  }
  const note = (p) => { const kind = relationOf(fam, p, fam.stays).kind; return kind === 'never' ? '<span class="hr-fam-res-note">the AI never compared it</span>' : kind === 'stale' ? '<span class="hr-fam-res-note">the AI compared older versions</span>' : ''; };
  const folds = [
    merged.length ? resultFold('reviewFamMerged', 'Merged in', plural(merged.length, 'page') + ' deleted', ctx.open('reviewFamMerged'), 'Their text is on ' + name(stays) + ', each under "Merged from" and its name.', merged.map((p) => row(p, note(p))), fam.foldCount) : '',
    keptPages.length ? resultFold('reviewFamKept', 'Kept both', plural(keptPages.length, 'page') + ' kept', ctx.open('reviewFamKept'), 'These stay separate from ' + name(stays) + ', and that pair will not come back.',
      keptPages.map((p) => row(p, btn('', 'Undo', ' data-fam-undo="' + esc(p) + '" aria-label="' + esc('Undo: ' + slugOf(p)) + '"'))), fam.foldCount) : '',
    notDecided.length ? resultFold('reviewFamLeft', 'Not decided', plural(notDecided.length, 'page') + ' waiting', ctx.open('reviewFamLeft'), 'Nothing happened to these.', notDecided.map((p) => row(p)), fam.foldCount) : '',
  ].join('');
  const groups = ctx.leftovers;
  const nLeft = groups.reduce((a, g) => a + g.pages.length, 0);
  return (SHOW_MARKS ? renderMarks(fam, false) : '') +
    '<div class="hr-fam-card"><div class="hr-fam-card-text"><div>Stays</div><div class="mono hr-fam-card-name">' + esc(stays) + '</div><div>' + grew + '</div></div>' + btn('hr-read-stays', 'Read full page', ' aria-label="' + esc('Read full page: ' + stays) + '"') + '</div>' +
    neverLine + renderFoldRows(folds, { alias: 'dm' }) +
    (nLeft ? '<div class="hr-fam-left"><p>' + plural(nLeft, 'page') + ' left over still match one another, so they may be a smaller family of their own.</p>' + btn('hr-fam-residue', 'Review those ' + n0(nLeft)) + '</div>' : '') +
    '<p class="hr-note hr-fam-foot">' + esc(ctx.note) + '</p>';
}
