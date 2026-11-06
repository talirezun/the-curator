/**
 * The real review desk (views/health-review.js) over a stand-in for what domains.js
 * gives it. The stand-ins hold the same rules as the gate functions they replace, in a
 * few lines, so a suite can drive the walk with no browser. The real gate is held to its
 * own suite (test-next-semantic-gate.js) and the two meet in the browser walk
 * (e2e-wiki-health.mjs S16).
 */
import { createReviewDesk } from '../../src/public/next/views/health-review.js';

export const WARN = 'There is no Undo button in the app. If you use GitHub Sync this is recoverable with a git client; otherwise it cannot be undone.';

export const pair = (remove, keep, over) => ({
  removeFolder: 'concepts', removeSlug: remove, keepFolder: 'concepts', keepSlug: keep,
  confidence: 'high', rationale: 'Both pages describe one thing.', nameRelation: 'different-names', status: 'open', ...over,
});

const side = (slug, folder, links) => ({
  slug, folder, text: '---\ntype: concept\n---\n\n# ' + slug + '\n\nText of ' + slug + '.\n', length: 1100, truncated: false,
  linksIn: { files: links, links, from: [] },
});

export function comparison(p, over) {
  return {
    basis: 'basis:' + p.keepSlug + '<' + p.removeSlug, nameRelation: p.nameRelation,
    originals: { keep: side(p.keepSlug, p.keepFolder, 11), remove: side(p.removeSlug, p.removeFolder, 4) },
    mergeOutcome: { lostLines: 0, movedUnder: 'Merged from ' + p.removeSlug, mergedPreviewTruncated: false },
    ...over,
  };
}

export function deskFixture(pairs, over = {}) {
  const key = (p) => p.keepFolder + '/' + p.keepSlug + '||' + p.removeFolder + '/' + p.removeSlug;
  const scan = { slug: 'alpha', pairs: pairs.map((p) => ({ ...p })), previewed: new Set(), preview: null, bases: {}, coverage: over.coverage || null };
  const state = { review: null, expandedGroups: new Set(), busyKey: null, healthLive: '' };
  const calls = { merge: [], keep: [], back: [], read: [], compare: [], closed: [], render: 0 };
  const fx = { state, scan, calls, nextCompare: null, nextMerge: { merged: true, alsoResolved: 0 }, nextKeep: { kept: true }, nextBack: null, holdCompare: null };
  const scanNow = () => (fx.gone ? null : scan);
  fx.desk = createReviewDesk({
    state,
    scan: scanNow,
    slug: () => fx.activeSlug || 'alpha',
    pairKey: key,
    gate: (p) => {
      const k = scan.pairs.find((x) => key(x) === key(p));
      if (!k) return { allowed: false, reason: 'gone' };
      if (k.status !== 'open') return { allowed: false, reason: 'handled' };
      return scan.previewed.has(key(k)) ? { allowed: true, reason: null } : { allowed: false, reason: 'Read the comparison for this pair before merging it.' };
    },
    arm: (p) => { if (!scan.preview || scan.preview.key !== key(p) || !scan.preview.data) return false; scan.previewed.add(key(p)); return true; },
    armed: (p) => scan.previewed.has(key(p)),
    disarm: (s) => { s.previewed.clear(); s.preview = null; },
    flip: (p) => {
      const i = scan.pairs.findIndex((x) => key(x) === key(p));
      const o = scan.pairs[i];
      scan.pairs[i] = { ...o, keepSlug: o.removeSlug, keepFolder: o.removeFolder, removeSlug: o.keepSlug, removeFolder: o.keepFolder };
      scan.previewed.clear(); scan.preview = null;
    },
    status: (p, st) => { const i = scan.pairs.findIndex((x) => key(x) === key(p)); scan.pairs[i] = { ...scan.pairs[i], status: st }; },
    compare: async (slug, p) => {
      calls.compare.push(key(p));
      if (fx.holdCompare) await fx.holdCompare;
      const next = fx.nextCompare; fx.nextCompare = null;
      if (next && next.error) { scan.preview = { key: key(p), error: next.error }; return next; }
      if (next && next.settled) { const i = scan.pairs.findIndex((x) => key(x) === key(p)); scan.pairs[i] = { ...scan.pairs[i], status: 'resolved' }; return next; }
      const data = (next && next.data) || comparison(p);
      scan.preview = { key: key(p), data }; scan.bases[key(p)] = data.basis;
      return { data };
    },
    merge: async (slug, p, cb) => {
      calls.merge.push(key(p));
      const out = fx.nextMerge;
      if (out.merged || out.gone) { const i = scan.pairs.findIndex((x) => key(x) === key(p)); scan.pairs[i] = { ...scan.pairs[i], status: out.merged ? 'merged' : 'resolved' }; }
      if (out.error) { const i = scan.pairs.findIndex((x) => key(x) === key(p)); scan.pairs[i] = { ...scan.pairs[i], error: out.error, errorAction: 'merge' }; }
      cb(out);
    },
    keepBoth: async (slug, p, cb) => {
      calls.keep.push(key(p));
      const out = fx.nextKeep;
      if (out.kept) { const i = scan.pairs.findIndex((x) => key(x) === key(p)); scan.pairs[i] = { ...scan.pairs[i], status: 'skipped' }; }
      if (out.error) { const i = scan.pairs.findIndex((x) => key(x) === key(p)); scan.pairs[i] = { ...scan.pairs[i], error: out.error, errorAction: 'skip' }; }
      cb(out);
    },
    bringBack: async (slug, p) => { calls.back.push(key(p)); if (fx.nextBack) throw new Error(fx.nextBack); },
    readPage: (path, title) => { calls.read.push(path + '|' + title); },
    markdown: (t) => '<p>' + String(t).replace(/[&<>]/g, '').trim() + '</p>',
    render: () => { calls.render++; },
    warn: () => WARN,
    coverageLeft: () => (scan.coverage ? scan.coverage.left : 0),
    onClosed: (merged) => calls.closed.push(merged),
    headIntoView: () => { calls.head = (calls.head || 0) + 1; },
    // The Merge button's box: where the pointer is, a suite says directly.
    mergeRect: () => (fx.overMerge ? { left: 0, right: 10, top: 0, bottom: 10 } : { left: 100, right: 110, top: 100, bottom: 110 }),
    ...(over.deps || {}),
  });
  /** A paint: the desk fetches what it is missing. */
  fx.paint = async () => { for (let i = 0; i < 4; i++) { fx.desk.afterPaint(); await new Promise((r) => setTimeout(r, 0)); } };
  /** The comparison has been on screen for 500 ms: what the browser's watcher does. */
  fx.seen = () => { const p = scan.pairs[state.review.index]; return scan.preview && scan.preview.key === key(p) && scan.preview.data ? (scan.previewed.add(key(p)), true) : false; };
  fx.press = (id, data) => fx.desk.onClick({ id, dataset: data || {} });
  fx.key = key;
  fx.html = () => fx.desk.html();
  return fx;
}
