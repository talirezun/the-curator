#!/usr/bin/env node
/**
 * test-next-press-rule.js — OFFLINE. The press rule's logic, run for real.
 *
 * Wiki health answers where you pressed (views/domains.js, "THE PRESS RULE";
 * shared/row-motion.js). The browser half (a frame-by-frame sampler over real
 * mouse events) is scripts/e2e-wiki-health.mjs, which needs Chrome. This suite is
 * everything that can be proved without one: which press asks and which runs, how
 * an outcome is filed, that a failure has no timer, where a question lives when
 * its row has gone, what a held key does, and the scroll floor's arithmetic.
 *
 * It lifts the REAL functions out of the view and executes them. No line of source
 * is asserted for its own sake, except the two absences at the end: the section
 * has no banner, and nothing waits on `transitionend`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScrollFloor } from '../src/public/next/shared/row-motion.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');
const MOTION = readFileSync(path.join(REPO, 'src/public/next/shared/row-motion.js'), 'utf8');

let passed = 0; let failed = 0;
const ok = (c, name, detail) => {
  if (c) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
};
const section = (t) => console.log('\n' + t);

function fnSource(name) {
  const start = VIEW.search(new RegExp('^(async )?function ' + name + '\\b', 'm'));
  if (start === -1) throw new Error('not found in domains.js: ' + name);
  const open = VIEW.indexOf('{', VIEW.indexOf(')', start));
  let depth = 0; let q = null;
  for (let i = open; i < VIEW.length; i++) {
    const c = VIEW[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && VIEW[i + 1] === '/') { i = VIEW.indexOf('\n', i); continue; }
    if (c === '/' && VIEW[i + 1] === '*') { i = VIEW.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (!depth) return VIEW.slice(start, i + 1); }
  }
  throw new Error('unterminated ' + name);
}

const FNS = ['readHealthBeforeAsking', 'healthTraceText', 'beforeHealthPaint', 'resetHealthPressRule', 'confirmFixAllOfType', 'confirmFixSafe', 'safeFixDeletedPages', 'deletedPageCount', 'takeHealthNote',
  'dropIssuesLocally', 'placeHealthStack', 'healthStackHome', 'onHealthKeydown', 'liveBatchPairs', 'heldOutcome', 'healthRowHold'];

function world() {
  const timers = [];
  const ran = [];
  const body = `
    const state = { rowNote: null, rowOutcomes: {}, rowLines: {}, confirm: null, pendingPlan: null, pressAnchor: null, ringAnchor: null,
      activeSlug: 'a', healthSlug: 'a', health: null, healthLive: '', healthTrace: null, rowAway: {}, rowNoteFrom: null, rowBusy: new Set(), pressLocks: {}, pressOpener: null, flipFlash: null, busyKey: null, expandedGroups: new Set(), dismissedRecords: null, semanticScan: null };
    const HEALTH_CATEGORIES = [{ key: 'missingBacklinks', label: 'Missing backlinks' }, { key: 'crossFolderDupes', label: 'Cross-folder duplicates' }, { key: 'brokenLinks', label: 'Broken links' }];
    const AUTO_FIX_TYPES = new Set(['missingBacklinks', 'crossFolderDupes', 'hyphenVariants', 'brokenLinks']);
    const DESTRUCTIVE_FIX_TYPES = new Set(['crossFolderDupes', 'hyphenVariants']);
    const GIT_UNDO_WARN = 'WARN'; const GIT_UNDO_NOTE = 'NOTE';
    const HEALTH_HOLD_MS = 1000; const HEALTH_TRACE_MAX = 24;
    let confirmOnScreen = null;
    const healthFloor = { reset() {} };
    const document = { getElementById() { return null; } };
    const onQuickAction = () => {};
    let fetchResult = null; let fetchFails = null; let fetchCalls = 0;
    const fetchJSON = async () => { fetchCalls++; if (fetchFails) throw new Error(fetchFails); return fetchResult; };
    let healthPressY = null; let planLeaving = false;
    const pluralize = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    const countSafeFixable = (r) => (r.missingBacklinks || []).length + (r.crossFolderDupes || []).length;
    const fixAllOfType = (slug, type) => { __ran.push('fixAll ' + type); };
    const runFixSafe = () => { __ran.push('fixSafe'); };
    const render = () => { __ran.push('render'); };
    const isCurrentMount = () => true;
    const healthRowCollapseMs = () => 240;
    const activeSemanticScan = () => state.semanticScan;
    const pageY = (r) => r.y; const myMountToken = 1;
    const setTimeout = (fn, ms) => { __timers.push({ fn, ms }); return 0; };
    ${FNS.map(fnSource).join('\n')}
    return { state, ${FNS.join(', ')}, setPress(y) { healthPressY = y; }, setFetch(r, f) { fetchResult = r; fetchFails = f; }, fetchCount() { return fetchCalls; } };`;
  const api = new Function('__ran', '__timers', body)(ran, timers);
  return { ...api, ran, timers };
}

// ─────────────────────────────────────────────────────────────────────────────
section('§1 Free repairs run on the press; anything deleting a page asks');
{
  const w = world();
  w.state.health = { missingBacklinks: [{ summary: 's', entity: 'e' }], crossFolderDupes: [{ keep: 'a', remove: 'b' }] };
  await w.confirmFixAllOfType('a', 'missingBacklinks');
  ok(!w.state.confirm && w.ran.includes('fixAll missingBacklinks'), 'Fix all on a free repair runs at once, with no question');
  ok(w.fetchCount() === 0, 'and reads nothing first: there is no count to get wrong');
  w.ran.length = 0;
  w.setFetch({ missingBacklinks: [{}], crossFolderDupes: [{ keep: 'a', remove: 'b' }] });
  await w.confirmFixAllOfType('a', 'crossFolderDupes');
  ok(w.state.confirm && !w.ran.some((r) => r.startsWith('fixAll')), 'Fix all on a type that deletes only asks');
  ok(/1 page will be deleted/.test(w.state.confirm.body) && /WARN/.test(w.state.confirm.body), 'and the question counts the pages and carries the undo warning');
  ok(w.state.confirm.confirmLabel === 'Merge and delete', 'its button says what it does');

  // The count in a delete warning is read at the moment of asking.
  const st = world();
  st.state.health = { crossFolderDupes: [{ keep: 'a', remove: 'b' }, { keep: 'c', remove: 'd' }, { keep: 'e', remove: 'f' }, { keep: 'g', remove: 'h' }] };
  st.setFetch({ crossFolderDupes: [{ keep: 'g', remove: 'h' }] });
  await st.confirmFixAllOfType('a', 'crossFolderDupes');
  ok(st.fetchCount() === 1 && /1 page will be deleted/.test(st.state.confirm.body), 'four on screen, one on disk: it says one', st.state.confirm && st.state.confirm.body);
  const nil = world();
  nil.state.health = { crossFolderDupes: [{ keep: 'a', remove: 'b' }] };
  nil.setFetch({ crossFolderDupes: [] });
  await nil.confirmFixAllOfType('a', 'crossFolderDupes');
  ok(!nil.state.confirm && nil.state.rowNote && /Nothing left/.test(nil.state.rowNote.text), 'none left: no question, and it says so');
  ok(nil.state.health.crossFolderDupes.length === 0, 'and the row goes with it');
  const down = world();
  down.state.health = { crossFolderDupes: [{ keep: 'a', remove: 'b' }] };
  down.setFetch(null, 'the disk went away');
  await down.confirmFixAllOfType('a', 'crossFolderDupes');
  ok(!down.state.confirm && down.state.rowNote.tone === 'error', 'cannot read: no question at all, rather than one with an old number');
  ok(down.state.busyKey === null, 'and nothing is left waiting');

  const v = world();
  v.state.health = { missingBacklinks: [{}], crossFolderDupes: [], hyphenVariants: [] };
  await v.confirmFixSafe('a');
  ok(!v.state.confirm && v.ran.includes('fixSafe'), 'Fix N safe issues with nothing to delete runs at once');
  const d = world();
  d.state.health = { missingBacklinks: [{}], crossFolderDupes: [{ keep: 'a', remove: 'b' }], hyphenVariants: [{ files: ['x', 'y', 'z'] }] };
  d.setFetch(d.state.health);
  await d.confirmFixSafe('a');
  ok(d.state.confirm && !d.ran.includes('fixSafe'), 'with pages to delete it asks');
  ok(/3 pages will be deleted/.test(d.state.confirm.body), 'and counts them: a pair and a three-page group is 3');
  const stale = world();
  stale.state.health = { missingBacklinks: [{}], crossFolderDupes: [{ keep: 'a', remove: 'b' }], hyphenVariants: [] };
  stale.setFetch({ missingBacklinks: [{}], crossFolderDupes: [], hyphenVariants: [] });
  await stale.confirmFixSafe('a');
  ok(!stale.state.confirm && stale.ran.includes('fixSafe'), 'and if what it would delete has gone by now, it no longer asks');
}

section('§1b An outcome belongs to the domain it ran on');
{
  const w = world();
  w.state.activeSlug = 'b';
  w.state.health = { missingBacklinks: [{ summary: 'on b' }] };
  w.state.rowNoteFrom = { slug: 'a', token: 1 };
  w.state.rowNote = { key: 'group:missingBacklinks', held: true, tone: 'success', text: 'Repaired 400', drop: { type: 'missingBacklinks' } };
  w.beforeHealthPaint(1);
  ok(!Object.keys(w.state.rowOutcomes).length && !Object.keys(w.state.rowLines).length, 'domain a finished while b is on screen: b shows nothing of it');
  ok(w.state.health.missingBacklinks.length === 1, 'and b\'s own rows are untouched by a\'s repair');
  ok(w.state.healthLive === '' && !w.state.healthTrace, 'nor is it announced as if it were b\'s');
  w.state.activeSlug = 'a';
  w.state.health = { missingBacklinks: [] };
  w.beforeHealthPaint(1);
  ok(w.state.rowLines.quick && w.state.rowLines.quick.text === 'Repaired 400', 'back on a, it says what happened there');

  // Leaving the view while it runs.
  const l = world();
  l.state.health = { crossFolderDupes: [] };
  l.state.rowNoteFrom = { slug: 'a', token: 1 };
  l.state.rowNote = { key: 'group:crossFolderDupes', held: true, tone: 'success', text: 'Merged 4', drop: { type: 'crossFolderDupes' } };
  l.resetHealthPressRule();
  ok(l.state.rowNote, 'leaving does not lose an outcome still on its way');
  l.beforeHealthPaint(2);
  ok(l.state.rowLines.quick && l.state.rowLines.quick.text === 'Merged 4', 'on return, from a newer mount, it is a line: its row has gone');

  const kept = world();
  kept.state.rowOutcomes = { quick: { slug: 'a', tone: 'error', text: 'Could not repair', key: 'quick' } };
  kept.resetHealthPressRule();
  ok(!Object.keys(kept.state.rowOutcomes).length && kept.state.rowAway.a.quick, 'a failure waits with its domain across a switch');
  kept.beforeHealthPaint(1);
  ok(kept.state.rowLines.quick && kept.state.rowLines.quick.tone === 'error', 'and is still there on return: a failure stays until acted on');
}

section('§1c The trace is never cut off');
{
  const w = world();
  ok(w.healthTraceText({ text: 'Repaired 2' }) === 'Repaired 2', 'a short outcome is its own trace');
  ok(w.healthTraceText({ text: 'Repointed 4 occurrences, removed the brackets from 2 occurrences, across 3 files.' }) === '', 'a long one leaves no trace, rather than half a sentence');
  ok(w.healthTraceText({ text: 'Merged a-very-long-page-name-indeed into another-long-one.', trace: 'Merged a pair' }) === 'Merged a pair', 'unless it names a short one');
  w.state.rowNoteFrom = { slug: 'a', token: 1 };
  w.state.rowNote = { tone: 'success', text: 'Repointed 4 occurrences, removed the brackets from 2 occurrences, across 3 files.' };
  w.takeHealthNote(1);
  ok(w.state.rowOutcomes.quick.text.endsWith('across 3 files.'), 'the whole sentence is on the line');
}

section('§1d A page writing one link twice is one row');
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const root = mkdtempSync(path.join(os.default.tmpdir(), 'press-rule-'));
  process.env.CURATOR_TEST_DOMAINS_DIR = root;
  process.env.CURATOR_TEST_USER_DATA_DIR = mkdtempSync(path.join(os.default.tmpdir(), 'press-rule-u-'));
  const wiki = path.join(root, 'd', 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(root, 'd', 'CLAUDE.md'), '# d\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Wiki Index — d\n');
  writeFileSync(path.join(wiki, 'concepts', 'one.md'), '---\ntype: concept\n---\n\n# One\n\nSee [[mac-os]] and again [[mac-os]], and [[entities/two]] and [[entities/two]].\n\n[[two]]\n');
  writeFileSync(path.join(wiki, 'concepts', 'three.md'), '---\ntype: concept\n---\n\n# Three\n\nAlso [[mac-os]].\n\n[[one]]\n');
  writeFileSync(path.join(wiki, 'entities', 'two.md'), '---\ntype: entity\n---\n\n# Two\n\n[[three]]\n');
  const { scanWiki, collapseRepeatedLinks } = await import('../src/brain/health.js');
  const { keyForIssue } = await import('../src/brain/health-dismissed.js');
  const raw = await scanWiki('d');
  ok(raw.brokenLinks.filter((i) => i.linkText === 'mac-os').length === 3, 'CONTROL: the scan itself, and so the MCP, still lists each occurrence');
  const r = collapseRepeatedLinks(raw);
  ok(raw.brokenLinks.filter((i) => i.linkText === 'mac-os').length === 3, 'and collapsing for the screen does not change it');
  const mac = r.brokenLinks.filter((i) => i.linkText === 'mac-os');
  ok(mac.length === 2, 'on screen, the same link on two pages is two rows, and the same link twice on one page is not', JSON.stringify(mac));
  const twice = mac.find((i) => i.sourceFile.endsWith('one.md'));
  ok(twice && twice.occurrences === 2, 'that row says how many times the page writes it');
  const once = mac.find((i) => i.sourceFile.endsWith('three.md'));
  ok(once && once.occurrences === undefined, 'a link written once carries nothing extra');
  ok(new Set(mac.map((i) => keyForIssue('brokenLinks', i))).size === mac.length, 'so one Dismiss hides exactly the one row it was pressed on');
  const { fixIssue } = await import('../src/brain/health.js');
  const all = await fixIssue('d', 'folderPrefixLinks');
  ok(all.fixed === 1 && all.total === 2 && all.distinct === 1, 'a repair of a link written twice is one fix of one link, not 1 of 2', JSON.stringify(all));
  ok(r.folderPrefixLinks.filter((i) => i.linkText === 'entities/two').length === 1, 'folder-prefix links likewise');
}

section('§2 An outcome is filed on the row; a failure has no timer');
{
  const w = world();
  w.state.pressAnchor = 'group:missingBacklinks';
  w.state.health = { missingBacklinks: [{ summary: 's', entity: 'e' }] };
  w.state.rowNote = { key: 'group:missingBacklinks', held: true, tone: 'success', text: 'Repaired 1', drop: { type: 'missingBacklinks' } };
  w.takeHealthNote(1);
  ok(w.state.rowNote === null, 'the note is consumed once');
  ok(w.state.rowOutcomes['group:missingBacklinks'].text === 'Repaired 1', 'the outcome is on its row');
  ok(w.state.healthLive === 'Repaired 1', 'the live region says it');
  ok(w.state.healthTrace && w.state.healthTrace.text === 'Repaired 1', 'and the section head keeps the trace');
  ok(w.state.health.missingBacklinks.length === 0, 'the row left the figures at once, ahead of the rescan');
  const held = w.timers.filter((t) => t.ms === 1000);
  ok(held.length === 1, 'a held outcome has one timer, about a second');
  held[0].fn();
  ok(!w.state.rowOutcomes['group:missingBacklinks'], 'and it clears when that runs');

  const f = world();
  f.state.pressAnchor = 'group:missingBacklinks';
  f.state.rowNote = { key: 'group:missingBacklinks', tone: 'error', text: 'Could not repair: disk', retry: () => {} };
  f.takeHealthNote(1);
  ok(f.timers.length === 0, 'a failure starts no timer at all: nothing can take it off the screen');
  ok(f.state.rowOutcomes['group:missingBacklinks'].retry, 'it keeps its Try again');
  ok(!f.state.healthTrace, 'and a failure is not left as the trace of something done');
  f.state.health = { missingBacklinks: [{ summary: 's', entity: 'e' }] };
  f.placeHealthStack();
  ok(f.state.rowLines['group:missingBacklinks'], 'it draws as a line under its row');

  const c = world();
  c.state.confirm = { busy: true, title: 'q' };
  c.state.rowNote = { tone: 'success', text: 'Merged 2' };
  c.takeHealthNote(1);
  ok(c.state.confirm === null, 'an outcome closes the question it answers');
  ok(c.state.rowOutcomes.confirm && c.state.rowOutcomes.confirm.held, 'and the answered card says so while it leaves, where the pointer is');
  const line = c.state.rowOutcomes.quick;
  ok(line && line.notBefore > line.at, 'the line that stays takes over as the card goes, not on top of it');
  const n = world();
  n.state.confirm = { busy: false, title: 'q' };
  n.state.rowNote = { tone: 'info', text: 'x' };
  n.takeHealthNote(1);
  ok(n.state.confirm && !n.state.confirm.busy, 'an outcome does not close a question nobody has answered');
}

section('§3 Nothing is stranded: a row that has gone gives its question a home');
{
  const w = world();
  w.state.health = { missingBacklinks: [] };
  ok(w.healthStackHome('group:missingBacklinks') === 'quick', 'a group with no rows left has no row to draw under');
  w.state.health = { missingBacklinks: [{ a: 1 }] };
  ok(w.healthStackHome('group:missingBacklinks') === 'group:missingBacklinks', 'CONTROL: with rows, it stays under its row');
  ok(w.healthStackHome(null) === 'quick', 'no anchor is Quick maintenance, where a chip opened it');
  ok(w.healthStackHome('issue:missingBacklinks:{"a":1}') === 'issue:missingBacklinks:{"a":1}', 'an issue row still there keeps its line');
  ok(w.healthStackHome('issue:missingBacklinks:{"a":2}') === 'quick', 'one that has gone hands it to Quick maintenance');
  ok(w.healthStackHome('sem-batch') === 'quick', 'with no scan, the batch row has no home');
  w.state.semanticScan = { batchShown: true, coverage: {}, pairs: [] };
  ok(w.healthStackHome('sem-batch') === 'sem-batch', 'with the bar still shown, it stays there');
  w.state.rowOutcomes = { 'group:gone': { slug: 'a', tone: 'error', text: 'x', key: 'group:gone' } };
  w.placeHealthStack();
  ok(w.state.rowLines.quick && w.state.rowLines.quick.text === 'x', 'a failure whose row has gone is still on screen');
  w.state.rowOutcomes = { quick: { slug: 'other', tone: 'error', text: 'x', key: 'quick' } };
  w.placeHealthStack();
  ok(!w.state.rowLines.quick && !w.state.rowOutcomes.quick, 'another domain\'s outcome is dropped, never drawn');
}

section('§4 What leaves when, and what stays put');
{
  const w = world();
  w.state.rowOutcomes.a = { held: true, slug: 'a', at: Date.now(), tone: 'success', text: 'x' };
  const h = w.healthRowHold('a', { y: 0, getBoundingClientRect: () => ({ height: 10 }) });
  ok(h > 900 && h <= 1000, 'a row with an outcome is held about a second', String(h));
  w.setPress(500);
  const above = { y: 100, getBoundingClientRect: () => ({ height: 50 }) };
  const below = { y: 700, getBoundingClientRect: () => ({ height: 50 }) };
  ok(w.healthRowHold('issue:x', above) === Infinity, 'a settled row above the press waits: it may not move what you pressed');
  ok(w.healthRowHold('issue:x', below) === 0, 'one below it leaves now');
  ok(w.healthRowHold('confirm', above) === 0, 'a closing question is not such a row');
  w.setPress(120);
  ok(w.healthRowHold('issue:x', above) === 0, 'a row the press is inside is not above it');
  w.state.rowOutcomes['pair:p'] = { held: true, slug: 'a', at: Date.now(), tone: 'success', text: 'x' };
  w.setPress(null);
  const settled = w.healthRowHold('pair:q', below);
  ok(settled > 900, 'a pair another merge settled is held with it, so the two leave together', String(settled));
}

section('§5 Figures change before the rescan, and only for what was fixed');
{
  const w = world();
  w.state.health = { brokenLinks: [{ a: 1, suggestedTarget: 't' }, { a: 2 }], missingBacklinks: [{}], crossFolderDupes: [{}], counts: { dismissed: 2 }, dismissedRecords: 2, orphans: [{ p: 1 }, { p: 2 }] };
  w.dropIssuesLocally({ type: 'brokenLinks' });
  ok(w.state.health.brokenLinks.length === 1 && w.state.health.brokenLinks[0].a === 2, 'Fix all on broken links keeps the ones with no target: it never touched them');
  w.dropIssuesLocally({ type: 'orphans', issue: { p: 1 }, dismissed: true });
  ok(w.state.health.orphans.length === 1 && w.state.health.orphans[0].p === 2, 'a dismissal takes exactly its own row');
  ok(w.state.health.dismissedRecords === 3 && w.state.health.counts.dismissed === 3, 'and the Dismissed count ticks');
  w.state.dismissedRecords = [{ p: 9 }, { p: 8 }];
  w.dropIssuesLocally({ restored: { p: 9 } });
  ok(w.state.dismissedRecords.length === 1 && w.state.health.dismissedRecords === 2, 'a restore takes its own record');
  w.dropIssuesLocally({ safe: true });
  ok(w.state.health.missingBacklinks.length === 0 && w.state.health.brokenLinks.length === 1, 'Fix N safe issues clears what it covers, and not the links it cannot fix');
  ok(w.state.health.orphans.length === 1, 'and never orphans, which it does not touch');
}

section('§6 A held key is not a second press; Escape closes a question');
{
  const w = world();
  let prevented = 0;
  const button = { closest: () => ({}) };
  w.onHealthKeydown({ repeat: true, key: 'Enter', target: button, preventDefault() { prevented++; } });
  ok(prevented === 1, 'a repeating Enter on a control is refused, since focus moves to the next row');
  w.onHealthKeydown({ repeat: true, key: ' ', target: button, preventDefault() { prevented++; } });
  ok(prevented === 2, 'and a repeating Space');
  w.onHealthKeydown({ repeat: false, key: 'Enter', target: button, preventDefault() { prevented++; } });
  ok(prevented === 2, 'CONTROL: a real press is not');
  w.state.confirm = { busy: false };
  w.onHealthKeydown({ repeat: false, key: 'Escape', target: button, preventDefault() {} });
  ok(w.state.confirm === null, 'Escape closes an open question');
  const busy = { busy: true };
  w.state.confirm = busy;
  w.onHealthKeydown({ repeat: false, key: 'Escape', target: button, preventDefault() {} });
  ok(w.state.confirm === busy, 'but not one already answered and running');
}

section('§7 The scroll floor, with a dumb page');
{
  // A page: `content` px tall, a viewport, and the browser's clamp.
  const page = {
    content: 2000, clientHeight: 800, top: 1200, floor: 0, listeners: [], moved: 0,
    get scrollHeight() { return Math.max(this.content + this.floor, this.clientHeight); },
    get scrollTop() { return Math.min(this.top, this.scrollHeight - this.clientHeight); },
    set scrollTop(v) { this.top = v; this.moved++; },
    style: { setProperty(n, v) { page.floor = parseFloat(v); }, removeProperty() { page.floor = 0; } },
    addEventListener(t, f) { this.listeners.push(f); }, removeEventListener() {},
  };
  let userScrolls = 0;
  const f = createScrollFloor(() => page, '--x', () => { userScrolls++; });
  const top = f.position();
  ok(top === 1200, 'starts at the very end of the page');
  page.content = 1900;                 // a row left in one frame
  f.hold(top);
  ok(page.scrollTop === 1200, 'a shrink at the page end does not clamp the scroll', String(page.scrollTop));
  ok(f.value === 100, 'the floor is exactly what the position needs', String(f.value));
  // A dumb cross-check: without the floor the same page does clamp.
  ok(Math.min(1200, 1900 - 800) === 1100, 'CONTROL: the same page with no floor would have dropped 100 px');

  f.reserve(150);
  ok(f.value === 250, 'before a row collapses, the floor covers it, so nothing clamps during it', String(f.value));
  f.reserve(50);
  ok(f.value === 300, 'two rows in one paint are both covered', String(f.value));
  page.content = 1700;
  f.release(); f.release();
  ok(f.value === 300 && page.scrollTop === 1200, 'when they have gone the position still holds', String(f.value));

  page.top = 600;                      // the user scrolls up
  for (const l of page.listeners) l();
  ok(f.value === 0, 'scrolling up gives the empty space back', String(f.value));
  ok(userScrolls === 1, 'and the caller hears about it, to let waiting rows go');
  ok(page.scrollTop === 600, 'without moving what the user just scrolled to');

  const before = userScrolls;
  page.top = 500;                      // the scroll position is not the one asked for
  f.hold(600);
  ok(page.moved > 0 && page.scrollTop === 600, 'a position that did slip is put back');
  for (const l of page.listeners) l(); // the browser reports that move
  ok(userScrolls === before, 'and that correction is not mistaken for the user scrolling');
  f.reset();
  ok(f.value === 0 && page.floor === 0, 'a new domain starts with no floor');
}

section('§8 Two absences, on purpose');
{
  const panel = fnSource('renderHealthPanel');
  ok(!/renderBanner|state\.banner/.test(panel), 'the Health section draws no banner: an outcome is on its row');
  for (const name of ['runFixSafe', 'fixAllOfType', 'runBrokenLinksPlan', 'runOrphansPlan', 'runIndexRebuildPlan', 'applyIndexRebuildPlan',
    'applyPendingPlan', 'runSemanticScan', 'runSemanticReset', 'mergeOneSemanticPair', 'skipSemanticPair', 'runMergeSemanticDuplicates', 'dismissIssue', 'undismissIssue']) {
    ok(!/state\.banner\s*=/.test(fnSource(name)), name + ' files on the row, not in a banner');
  }
  ok(!/transitionend/.test(MOTION.replace(/\/\*[\s\S]*?\*\//g, '')), 'nothing in row-motion waits on transitionend, which never fires under reduced motion');
  ok(/prefers-reduced-motion/.test(MOTION) && /--dur-slow/.test(MOTION) && /--ease-out/.test(MOTION), 'it asks about reduced motion and takes its timing from the tokens');
  ok(!/\b\d{2,}ms\b/.test(MOTION.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'and no duration is written into it');
  for (const gate of ['canMergeSemanticPair', 'flipSemanticPair', 'liveBatchPairs', 'markSemanticPreviewed', 'activeSemanticScan', 'loadHealth', 'resetDomainScopedHealthState']) {
    ok(new RegExp('^(async )?function ' + gate + '\\b', 'm').test(VIEW), gate + ' stays in domains.js, where the merge gate\'s suite lifts it');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Press rule assertions FAILED'); process.exit(1); }
console.log('Press rule assertions OK');
