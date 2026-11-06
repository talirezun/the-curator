#!/usr/bin/env node
/**
 * Wiki health keeps its nodes across a paint (shared/morph.js + the section
 * delegate in views/domains.js).
 *
 * This is the offline half. It runs the REAL patchInPlace and the REAL delegate,
 * lifted by name, over a small DOM written here. What it proves is the logic:
 * which node matches which, that `next` is never consumed, that one click is one
 * action however many paints have happened, that a disabled button never acts.
 * What a small DOM cannot prove (focus fixup on a disabled button, what a real
 * click on a disabled button does, `toggle` timing, real paints) is proved in a
 * real browser by scripts/e2e-health-keyed-patch.mjs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { functionSource } from './test-helpers/source-scan.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');
const { patchInPlace } = await import(pathToFileURL(path.join(REPO, 'src/public/next/shared/morph.js')).href);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ FAILED: ' + msg); }
}
function section(t) { console.log('\n' + t); }

// ── A small DOM ────────────────────────────────────────────────────────────
const DOC = { activeElement: null, body: null, writes: 0 };
class Text {
  constructor(v) { this.nodeType = 3; this.nodeName = '#text'; this._v = v; this.parentNode = null; this.namespaceURI = null; }
  get nodeValue() { return this._v; }
  set nodeValue(v) { this._v = v; DOC.writes++; }
  cloneNode() { return new Text(this._v); }
  isEqualNode(o) { return o.nodeType === 3 && o._v === this._v; }
  get nextSibling() { const k = this.parentNode.childNodes; return k[k.indexOf(this) + 1] || null; }
  get isConnected() { return true; }
}
class El {
  constructor(tag, attrs = {}, kids = [], doc = null) {
    this.nodeType = 1; this.nodeName = tag.toUpperCase(); this.namespaceURI = 'html';
    this._attrs = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
    this.childNodes = []; this.parentNode = null; this.ownerDocument = doc || DOC;
    this.listeners = [];
    for (const k of kids) this.appendChild(typeof k === 'string' ? new Text(k) : k);
  }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  hasAttribute(n) { return this._attrs.has(n); }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n, String(v)); DOC.writes++; }
  removeAttribute(n) { this._attrs.delete(n); DOC.writes++; }
  get id() { return this.getAttribute('id') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get open() { return this.hasAttribute('open'); }
  get classList() { const c = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); return { contains: (x) => c.includes(x) }; }
  get dataset() {
    const out = {};
    for (const [k, v] of this._attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; const k = this.parentNode.childNodes; return k[k.indexOf(this) + 1] || null; }
  get parentElement() { return this.parentNode; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === ROOT || n === DOC.body; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (i < 0) throw new Error('insertBefore: ref is not a child');
    this.childNodes.splice(i, 0, n); n.parentNode = this; DOC.writes++;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1); n.parentNode = null; DOC.writes++;
    if (DOC.activeElement && (DOC.activeElement === n || (n.contains && n.contains(DOC.activeElement)))) DOC.activeElement = DOC.body;
    return n;
  }
  replaceChild(n, old) { this.insertBefore(n, old); this.removeChild(old); }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(tag) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (tag[0] === '.' ? (n.getAttribute('class') || '').split(' ').includes(tag.slice(1)) : n.nodeName === tag.toUpperCase()) return n; return null; }
  focus() { DOC.activeElement = this; }
  cloneNode(deep) { return new El(this.nodeName, Object.fromEntries(this._attrs), deep ? this.childNodes.map((k) => k.cloneNode(true)) : []); }
  isEqualNode(o) {
    if (o.nodeType !== 1 || o.nodeName !== this.nodeName || o._attrs.size !== this._attrs.size) return false;
    for (const [k, v] of this._attrs) if (o._attrs.get(k) !== v) return false;
    return o.childNodes.length === this.childNodes.length && this.childNodes.every((k, i) => k.isEqualNode(o.childNodes[i]));
  }
  get outerHTML() {
    const a = [...this._attrs].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.nodeName}${a}>${this.childNodes.map((k) => (k.nodeType === 3 ? k._v : k.outerHTML)).join('')}</${this.nodeName}>`;
  }
  addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: !!capture }); }
}
const ROOT = new El('main');
DOC.body = new El('body');
const h = (tag, attrs, ...kids) => new El(tag, attrs || {}, kids);
function connect(el) { ROOT.childNodes.length = 0; el.parentNode = null; ROOT.appendChild(el); DOC.activeElement = DOC.body; DOC.writes = 0; return el; }
// The DOM's own test is checked by a dumb reading of the same two trees.
const same = (a, b) => a.outerHTML === b.outerHTML;

const healthKey = new Function(functionSource(VIEW, 'healthMorphKey') + '\nreturn healthMorphKey;')();

// ── §1 ─────────────────────────────────────────────────────────────────────
section('§1 What a paint keeps');
{
  const row = (t) => h('div', { class: 'row' }, h('span', { class: 'main' }, t));
  const build = (names) => h('section', { class: 'dm-health' }, ...names.map(row));
  const live = connect(build(['a', 'b', 'c', 'd']));
  const nodes = [...live.childNodes];
  const unchanged = build(['a', 'b', 'c', 'd']);
  DOC.writes = 0;
  ok(patchInPlace(live, unchanged) === true, 'an unchanged tree reports a clean patch');
  ok(DOC.writes === 0, 'and writes nothing at all (' + DOC.writes + ' writes)');
  ok(patchInPlace(live, build(['a', 'c', 'd'])), 'a row leaving is a clean patch');
  ok(live.childNodes[0] === nodes[0] && live.childNodes[1] === nodes[2] && live.childNodes[2] === nodes[3],
    'an unkeyed row that moved up one place is the SAME node, found by its markup');
  ok(!live.contains(nodes[1]), 'the row that left is gone');
}
{
  const btn = (id, label) => h('button', { id }, label);
  const live = connect(h('div', {}, btn('one', 'One'), btn('two', 'Two'), btn('three', 'Three')));
  const [one, two, three] = live.childNodes;
  ok(patchInPlace(live, h('div', {}, btn('three', 'Three'), btn('one', 'Now one'))), 'a keyed reorder is a clean patch');
  ok(live.childNodes[0] === three && live.childNodes[1] === one, 'keyed nodes keep their identity when they move');
  ok(one.childNodes[0]._v === 'Now one', 'and their new text is written');
  ok(!live.contains(two), 'a key that is gone leaves');
}
{
  const live = connect(h('div', {}, h('button', { class: 'x' }, 'Merge')));
  const old = live.childNodes[0];
  old.focus();
  ok(patchInPlace(live, h('div', {}, h('button', { class: 'x' }, 'Delete'))), 'an unkeyed button with new content is a clean patch');
  ok(live.childNodes[0] !== old, 'an unkeyed button is never reused for a different action');
  ok(DOC.activeElement !== live.childNodes[0], 'so focus never silently becomes focus on something else');
}
{
  const live = connect(h('div', {}, h('div', { class: 'dm-confirm-card' }, 'Sure?')));
  const old = live.childNodes[0];
  patchInPlace(live, h('div', {}, h('div', { class: 'dm-plan-card' }, 'Plan')));
  ok(live.childNodes[0] !== old, 'by position only within the same first class: a confirm never becomes a plan');
  const rowLive = connect(h('div', {}, h('div', { class: 'row a' }, 'old text')));
  const rowOld = rowLive.childNodes[0];
  patchInPlace(rowLive, h('div', {}, h('div', { class: 'row b' }, 'new text')));
  ok(rowLive.childNodes[0] === rowOld && rowOld.getAttribute('class') === 'row b', 'same first class is reused, attributes and text rewritten');
}

{
  // The same key twice among one parent's children cannot claim one node twice.
  const b = () => h('button', { id: 'same' }, 'x');
  const live = connect(h('div', {}, b()));
  const target = h('div', {}, b(), h('p', {}, 'between'), b());
  ok(patchInPlace(live, target) === true && same(live, target), 'a key repeated in the new tree still ends equal to it');
}

section('§2 `next` is never consumed, so a failed patch can still fall back');
{
  const live = connect(h('div', {}, h('p', { id: 'keep' }, 'x')));
  const next = h('div', { class: 'new' }, h('p', { id: 'keep' }, 'y'), h('p', { id: 'added' }, h('b', {}, 'z')));
  const before = next.outerHTML;
  const addedInNext = next.childNodes[1];
  patchInPlace(live, next);
  ok(next.outerHTML === before, '`next` reads the same after the patch');
  ok(next.childNodes[1] === addedInNext && addedInNext.parentNode === next, 'an inserted node is a clone; the one in `next` stayed put');
  ok(live.childNodes[1] !== addedInNext, 'the live tree holds its own copy');
}
{
  const live = connect(h('div', {}, h('p', { id: 'a' }, '1'), h('p', { id: 'b' }, '2')));
  const next = h('div', {}, h('p', { id: 'b' }, '3'), h('p', { id: 'c' }, '4'));
  const snapshot = next.outerHTML;
  let threw = false;
  let calls = 0;
  try { patchInPlace(live, next, { keyOf: (el) => { if (++calls > 3) throw new Error('boom'); return el.id ? '#' + el.id : null; } }); } catch { threw = true; }
  ok(threw && next.outerHTML === snapshot, 'a throw mid-patch propagates and leaves `next` whole for the fallback');
}
ok(patchInPlace(connect(h('div')), h('span')) === false, 'a different element kind is refused, not patched');
{
  const live = connect(h('div', {}, 'x'));
  const realEqual = live.isEqualNode;
  live.isEqualNode = () => false;
  ok(patchInPlace(live, h('div', {}, 'x')) === false, 'the result is the final comparison: if it does not match, the caller hears false');
  live.isEqualNode = realEqual;
}

section('§3 Focus');
{
  const tree = (flag) => h('div', {}, h('button', { id: 'go', ...(flag ? { disabled: '' } : {}) }, 'Go'), h('a', { id: 'other' }, 'x'));
  const live = connect(tree(false));
  const go = live.childNodes[0];
  go.focus();
  patchInPlace(live, tree(true));
  ok(live.__morphWaiting === go, 'a focused control that became disabled is remembered');
  DOC.activeElement = DOC.body; // the browser's focus fixup
  patchInPlace(live, tree(true));
  ok(live.__morphWaiting === go, 'and stays remembered across another paint while it still waits');
  patchInPlace(live, tree(false));
  ok(DOC.activeElement === go, 'when it comes back it gets focus back');
  ok(live.__morphWaiting === null, 'and the memory is spent');
  go.focus();
  patchInPlace(live, tree(true));
  const outside = new El('input'); // the user moved on, out of the section
  DOC.activeElement = outside;
  patchInPlace(live, tree(false));
  ok(DOC.activeElement === outside, 'if focus went anywhere else meanwhile, that was the user: focus is not pulled back');
}
{
  const tree = (kids) => h('div', {}, ...kids);
  const a = () => h('button', { id: 'a' }, 'A');
  const b = () => h('button', { id: 'b' }, 'B');
  const live = connect(tree([a(), b()]));
  const btnB = live.childNodes[1];
  btnB.focus();
  // A plain move drops focus where moveBefore does not exist; emulate it.
  const realRemove = live.removeChild.bind(live);
  const realInsert = live.insertBefore.bind(live);
  live.insertBefore = (n, ref) => { const r = realInsert(n, ref); if (n === btnB) DOC.activeElement = DOC.body; return r; };
  patchInPlace(live, tree([b(), a()]));
  live.insertBefore = realInsert;
  void realRemove;
  ok(DOC.activeElement === btnB, 'a reorder that drops focus from a kept node puts it back');
}
{
  const live = connect(h('div', {}, h('button', { id: 'gone' }, 'x')));
  live.childNodes[0].focus();
  patchInPlace(live, h('div', {}));
  ok(DOC.activeElement === DOC.body, 'a removed control does not leave a dangling focus; choosing a next target is a later stage');
}

section('§4 Fuzz: any tree to any tree, checked by a dumb serialiser');
{
  let x = 12345; const rnd = (n) => { x = (x * 1664525 + 1013904223) >>> 0; return x % n; };
  const TAGS = ['div', 'span', 'button', 'details', 'summary', 'p'];
  const gen = (depth) => {
    const attrs = {};
    if (rnd(3) === 0) attrs.class = ['row', 'card', 'row x', 'a b'][rnd(4)];
    if (rnd(4) === 0) attrs.id = 'i' + rnd(6);
    if (rnd(5) === 0) attrs.open = '';
    if (rnd(6) === 0) attrs['data-k'] = String(rnd(4));
    const kids = [];
    const n = depth > 3 ? 0 : rnd(5);
    for (let i = 0; i < n; i++) kids.push(rnd(3) === 0 ? 't' + rnd(4) : gen(depth + 1));
    return new El(TAGS[rnd(TAGS.length)], attrs, kids);
  };
  const dedupe = (el, seen = new Set()) => { if (el.nodeType !== 1) return; if (el.id) { if (seen.has(el.id)) el._attrs.delete('id'); else seen.add(el.id); } el.childNodes.forEach((k) => dedupe(k, seen)); };
  let bad = 0; let falseResults = 0; let idDupKeptEqual = 0;
  for (let i = 0; i < 2000; i++) {
    const a = h('div', {}, gen(0)); const b = h('div', {}, gen(0));
    dedupe(a); dedupe(b);
    const live = connect(a);
    const snapshot = b.outerHTML;
    let r;
    try { r = patchInPlace(live, b); } catch (e) { bad++; console.log('    threw', e.message, snapshot); continue; }
    if (r !== true) falseResults++;
    if (!same(live, b) || b.outerHTML !== snapshot) { bad++; if (bad < 4) console.log('    mismatch\n     got  ', live.outerHTML, '\n     want ', snapshot); }
    else idDupKeptEqual++;
  }
  ok(bad === 0, '2,000 random pairs end byte-equal to the target by a separate serialiser (' + idDupKeptEqual + ' checked)');
  ok(falseResults === 0, 'and every one of them reported true');
}

section('§5 Keys: the desk keeps its nodes; different things are different');
{
  ok(healthKey(h('button', { id: 'hr-merge' })) !== healthKey(h('button', { id: 'hr-keep' })), 'Merge and Keep both are different buttons');
  ok(healthKey(h('div', { 'data-review-key': 'a||b' })) === healthKey(h('div', { 'data-review-key': 'c||d' })), 'the panes stay the same node from pair to pair, so a decision moves nothing');
  ok(healthKey(h('button', { 'data-review-jump': '3' })) !== healthKey(h('button', { 'data-review-jump': '4' })), 'each row in All N pairs is its own button');
  const dismiss = (issue) => h('button', { 'data-dismiss-type': 'orphans', 'data-dismiss-issue': issue });
  ok(healthKey(dismiss('{"path":"a"}')) !== healthKey(dismiss('{"path":"b"}')), 'each Dismiss belongs to its own issue');
  ok(healthKey(h('details', { 'data-group-key': 'orphans' })) === 'group:orphans', 'a fold is keyed by its category');
  ok(healthKey(h('div', { class: 'row' })) === null, 'a plain row has no key and is matched by markup');
}

section('§6 One click is one action, however many paints have happened');
const CALLS = [];
const STUBS = `
const calls = __calls;
const SEMANTIC_PAGE_SIZE = 50;
const state = { confirm: null, pendingPlan: null, expandedGroups: new Set(), dismissedRecords: null, semanticScan: null, rowOutcomes: {}, pressLocks: {}, rowLines: {} };
const myMountToken = 't';
const document = __doc;
function render() { calls.push('render'); }
function rescan(s) { calls.push('rescan ' + s); }
function reportAsyncActionFailure(e) { calls.push('FAILED ' + e.message); }
function requestSettingsSection(x) { calls.push('settingsSection ' + x); }
function navigate(x) { calls.push('navigate ' + x); }
function applyPendingPlan(s) { calls.push('apply ' + s); }
function mergeSemanticDuplicates(s) { calls.push('batch ' + s); }
function onQuickAction(s, a) { calls.push('quick ' + s + ' ' + a); }
function repairAllFree(s) { calls.push('repairAll ' + s); }
function undoLeftRow(s, k) { calls.push('undo ' + s + ' ' + k); return Promise.resolve(); }
const ISSUE_PAGE = 20;
function confirmSemanticReset(s) { calls.push('reset ' + s); }
function confirmFixAllOfType(s, t) { calls.push('fixall ' + s + ' ' + t); }
function activeSemanticScan() { return state.semanticScan; }
function semanticPairKey(p) { return p.key; }
const compareAll = { onClick: () => false };
function questionJustOpened() { return false; }
function releaseArrivals() {}
const reviewDesk = { open() { calls.push('desk open'); return true; }, onClick(b) { calls.push('desk ' + b.id); } };
function healthHeadIntoView() {}
async function dismissIssue(s, t, i) { calls.push('dismiss ' + s + ' ' + t + ' ' + i.path); }
async function undismissIssue(s, r) { calls.push('restore ' + s + ' ' + r.path); }
async function loadDismissedRecords(s) { calls.push('loadDismissed ' + s); }
const HEALTH_HOLD_MS = 0;
let healthPressY = null;
function pageY() { return 0; }
function releaseHeldRows() {}
function healthRowKey() { return null; }
`;
const FNS = ['bindHealthListeners', 'dispatchHealthAction', 'onHealthClick', 'noteHealthFoldPress', 'onHealthToggle', 'onHealthKeydown', 'noteHealthPress', 'healthMorphKey'];
for (const n of FNS) if (!functionSource(VIEW, n)) throw new Error('not found in domains.js: ' + n);
const docStub = { sec: null, querySelector: () => docStub.sec };
const box = new Function('__calls', '__doc',
  STUBS + FNS.map((n) => functionSource(VIEW, n)).join('\n') + '\nreturn { bindHealthListeners, state };')(CALLS, docStub);
const tick = () => new Promise((r) => setTimeout(r, 0));
// A press, as the browser delivers it: bubbling listeners on the section only.
async function press(sec, target) {
  CALLS.length = 0;
  const evt = { target, currentTarget: sec, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  for (const l of sec.listeners.filter((x) => x.type === 'click')) l.fn(evt);
  await tick();
  return evt;
}
{
  const rescanBtn = h('button', { id: 'dm-rescan-btn' }, 'Rescan');
  const sec = h('section', { class: 'dm-section dm-health' }, rescanBtn);
  docStub.sec = sec;
  const domain = { slug: 'alpha' };
  for (let i = 0; i < 7; i++) box.bindHealthListeners(domain, false); // seven paints, one surviving node
  ok(sec.listeners.filter((l) => l.type === 'click').length === 1, 'seven paints over one surviving section leave one click listener');
  ok(sec.listeners.filter((l) => l.type === 'toggle').length === 1, 'and one toggle listener');
  ok(sec.listeners.find((l) => l.type === 'toggle').capture === true, 'toggle is heard in capture, because it does not bubble');
  await press(sec, rescanBtn);
  ok(CALLS.length === 1 && CALLS[0] === 'rescan alpha', 'one press, one rescan (got: ' + CALLS.join(', ') + ')');
  box.bindHealthListeners({ slug: 'beta' }, false);
  await press(sec, rescanBtn);
  ok(CALLS[0] === 'rescan beta', 'the domain is read at press time, never held in a closure');

  const replaced = h('section', { class: 'dm-section dm-health' });
  docStub.sec = replaced;
  box.bindHealthListeners(domain, false);
  ok(replaced.listeners.filter((l) => l.type === 'click').length === 1, 'a section that was replaced binds itself, once');
  docStub.sec = null;
  box.bindHealthListeners(domain, false);
  ok(true, 'no section on the page is not a crash');
}

section('§7 Every control reaches its own action, once');
{
  const controls = {
    yes: h('button', { id: 'dm-confirm-yes' }),
    no: h('button', { id: 'dm-confirm-no' }),
    settings: h('button', { id: 'dm-confirm-settings' }),
    apply: h('button', { id: 'dm-plan-apply-btn' }),
    discard: h('button', { id: 'dm-plan-discard-btn' }),
    batch: h('button', { id: 'dm-semantic-merge-btn' }),
    repairAll: h('button', { id: 'dm-repair-all-btn' }),
    reset: h('button', { id: 'dm-semantic-reset-btn' }),
    quick: h('button', { class: 'dm-quick-btn', 'data-action': 'orphans' }),
    review: h('button', { class: 'dm-review-btn', 'data-review': '1' }, 'Review'),
    fixall: h('button', { class: 'dm-group-fixall-btn', 'data-fixall': 'orphans' }),
    dismiss: h('button', { class: 'dm-dismiss-btn', 'data-dismiss-type': 'orphans', 'data-dismiss-issue': '{"path":"p.md"}' }),
    restore: h('button', { class: 'dm-restore-btn', 'data-restore-key': '{"path":"r.md"}' }),
    other: h('button', { 'data-tx-info': 'x' }),
  };
  const sec = h('section', { class: 'dm-health' }, ...Object.values(controls));
  docStub.sec = sec;
  box.bindHealthListeners({ slug: 'alpha' }, false);
  const s = box.state;
  s.semanticScan = { pairs: [{ key: 'p1' }], visible: 50 };

  s.confirm = { run: () => { CALLS.push('ran the confirm'); } };
  await press(sec, controls.yes);
  ok(CALLS.filter((c) => c !== 'render').join() === 'ran the confirm' && s.confirm === null, 'Confirm runs the stored action once and clears it');
  await press(sec, controls.yes);
  ok(CALLS.length === 0, 'a second press on Confirm runs nothing');
  s.confirm = { run: () => { CALLS.push('must not run'); } };
  await press(sec, controls.no);
  ok(CALLS.join() === 'render' && s.confirm === null, 'Cancel drops it and repaints');
  s.confirm = { refused: true };
  await press(sec, controls.settings);
  ok(CALLS.join() === 'settingsSection health,navigate settings' && s.confirm === null, 'A refused confirm goes to the setting');
  await press(sec, controls.apply);
  ok(CALLS.join() === 'apply alpha', 'Apply this plan');
  s.pendingPlan = {};
  await press(sec, controls.discard);
  ok(CALLS.join() === 'render' && s.pendingPlan === null, 'Discard');
  await press(sec, controls.batch);
  ok(CALLS.join() === 'batch alpha', 'Merge N spelling variants');
  await press(sec, controls.repairAll);
  ok(CALLS.join() === 'repairAll alpha', 'Repair all');
  await press(sec, controls.reset);
  ok(CALLS.join() === 'reset alpha', 'Forget all comparisons');
  await press(sec, controls.quick);
  ok(CALLS.join() === 'quick alpha orphans', 'A quick action');
  await press(sec, controls.review);
  ok(CALLS.join() === 'desk open', 'Review opens the desk');
  // A press inside the desk is the desk's. Merge, Keep both and the rest are its own suite's.
  const inDesk = h('button', { id: 'hr-merge' }, 'Merge');
  const desk = h('div', { class: 'hr-desk' }, inDesk);
  sec.appendChild(desk);
  await press(sec, inDesk);
  ok(CALLS.join() === 'desk hr-merge', 'a button in the desk goes to the desk, once');
  sec.removeChild(desk);
  const fix = await press(sec, controls.fixall);
  ok(CALLS.join() === 'fixall alpha orphans', 'Fix all');
  ok(fix.defaultPrevented && fix.stopped, 'Fix all, inside a <summary>, neither toggles the fold nor bubbles on');
  await press(sec, controls.dismiss);
  ok(CALLS.join() === 'dismiss alpha orphans p.md', 'Dismiss');
  await press(sec, controls.restore);
  ok(CALLS.join() === 'restore alpha r.md', 'Restore');
  const passBy = await press(sec, controls.other);
  ok(CALLS.length === 0 && !passBy.stopped, 'a button this section does not own passes by, for its own delegate');
}

section('§8 A disabled button never acts');
{
  const icon = h('svg', {});
  const quick = h('button', { class: 'dm-quick-btn', 'data-action': 'semanticDupes', disabled: '' }, icon, 'Find duplicate pages');
  const mergeIcon = h('span', {}, 'Merge');
  const merge = h('button', { id: 'hr-merge', disabled: '' }, mergeIcon);
  const yes = h('button', { id: 'dm-confirm-yes', disabled: '' }, h('span', {}, 'Go'));
  const sec = h('section', { class: 'dm-health' }, quick, merge, yes);
  docStub.sec = sec;
  box.bindHealthListeners({ slug: 'alpha' }, false);
  box.state.semanticScan = { pairs: [{ key: 'p1' }] };
  await press(sec, icon);
  ok(CALLS.length === 0, 'a press on the icon inside a disabled quick action does nothing');
  await press(sec, mergeIcon);
  ok(CALLS.length === 0, 'a press inside a disabled Merge does nothing');
  box.state.confirm = { run: () => { CALLS.push('ran'); } };
  await press(sec, yes.childNodes[0]);
  ok(CALLS.length === 0 && box.state.confirm !== null, 'a press inside a disabled Confirm does nothing and keeps the question');
  box.state.confirm = null; box.state.semanticScan = null;
}

section('§9 Folds');
{
  const label = h('span', {}, 'Orphan pages');
  const summary = h('summary', {}, label);
  const fold = h('details', { class: 'cur-fold dm-group', 'data-group-key': 'orphans' }, summary);
  const dSummary = h('summary', {}, 'Dismissed');
  const dismissed = h('details', { class: 'dm-group', 'data-group-key': 'dismissed', open: '' }, dSummary);
  const stranger = h('details', { class: 'other' }, h('summary', {}, 'x'));
  const sec = h('section', { class: 'dm-health' }, fold, dismissed, stranger);
  docStub.sec = sec;
  box.bindHealthListeners({ slug: 'alpha' }, false);
  const groups = box.state.expandedGroups;
  const toggle = (el) => sec.listeners.find((l) => l.type === 'toggle').fn({ target: el, currentTarget: sec });

  await press(sec, label);
  ok(groups.has('orphans'), 'the press itself records the state, before `toggle` is delivered, so a paint in between cannot undo it');
  fold.setAttribute('open', '');
  toggle(fold);
  ok(groups.has('orphans'), 'and `toggle` confirms it');
  await press(sec, label);
  ok(!groups.has('orphans'), 'closing records the same way');
  fold.removeAttribute('open');
  toggle(fold);
  ok(!groups.has('orphans'), 'and is confirmed');
  CALLS.length = 0;
  toggle(dismissed);
  ok(groups.has('dismissed') && CALLS.join() === 'loadDismissed alpha', 'opening Dismissed loads its list');
  await tick();
  box.state.dismissedRecords = [];
  CALLS.length = 0;
  toggle(dismissed);
  ok(CALLS.length === 0, 'and only while it has not loaded');
  const sizeBefore = groups.size;
  toggle(stranger);
  await press(sec, stranger.childNodes[0]);
  ok(groups.size === sizeBefore, 'a <details> that is not a Health fold is left alone');
}

section('§10 The patch refuses or falls back; it never leaves a broken section');
{
  const morphSrc = functionSource(VIEW, 'morphHealthSection');
  // The row motion is the browser suite's (e2e-wiki-health.mjs): here it is inert,
  // except that a failed patch must take its held rows back out of `next`.
  let undone = 0;
  const motion = { readHealthFocus() { return null; }, healthFloor: { position() { return 0; }, hold() {} }, holdLeavingRows() { return { undo() { undone++; } }; },
    keepHealthFocus() {}, startRowMotion() {}, scheduleHealthSettle() {}, HEALTH_ROW: '', healthRowKey() {}, healthRowHold() {}, decorateLeavingRow() {},
    onHealthRowCollapse() {}, onHealthRowRemoved() {}, onHealthRowOpen() {}, healthPressY: null, pageY() { return 0; } };
  const make = (activeSlug, patch) => new Function('state', 'patchInPlace', 'healthMorphKey', 'console', ...Object.keys(motion),
    morphSrc + '\nreturn morphHealthSection;')({ activeSlug }, patch, healthKey, { warn() {} }, ...Object.values(motion));
  const sec = (cls = 'dm-section dm-health') => h('section', { class: cls });
  const live = sec(); live.__dmHealthDomain = { slug: 'alpha' };
  ok(make('alpha', () => true)(live, sec()) === true, 'same domain and a clean patch: kept');
  let called = 0;
  ok(make('beta', () => { called++; return true; })(live, sec()) === false && called === 0, 'another domain: refused before anything is touched');
  const unbound = sec();
  ok(make('alpha', () => { called++; return true; })(unbound, sec()) === false && called === 0, 'a section nothing has stamped: refused');
  ok(make('alpha', () => { called++; return true; })(sec('dm-section dm-pages'), sec()) === false && called === 0, 'any other section: not this code\'s business');
  ok(make('alpha', () => { called++; return true; })(live, sec('dm-section dm-pages')) === false && called === 0, 'a Health section is never patched into something else');
  undone = 0;
  ok(make('alpha', () => false)(live, sec()) === false, 'a patch that does not match: false, so the caller replaces');
  ok(undone === 1, 'and the rows it held are taken back out of what the caller is about to insert');
  ok(make('alpha', () => { throw new Error('boom'); })(live, sec()) === false, 'a patch that throws: false, so the caller replaces');
}
{
  // The real thing end to end: patchMainAroundHosts' own fallback, driven by the
  // real patchInPlace blowing up half way, must land on the complete new section.
  const src = functionSource(VIEW, 'patchMainAroundHosts');
  const morphSrc = functionSource(VIEW, 'morphHealthSection');
  const html = new Map();
  const col = (body) => { const k = h('div', { class: 'main-inner' }, h('section', { class: 'dm-section dm-health' }, h('p', { id: 'keep' }, body))); return k; };
  const liveCol = col('old');
  const liveSec = liveCol.childNodes[0];
  liveSec.__dmHealthDomain = { slug: 'alpha' };
  const target = col('new');
  const root = h('div', { id: 'view-root' }, liveCol);
  Object.defineProperty(root, 'firstElementChild', { get: () => root.childNodes[0] });
  Object.defineProperty(liveCol, 'children', { get: () => liveCol.childNodes });
  const stubDoc = { getElementById: (id) => (id === 'view-root' ? root : null),
    createElement: () => { const d = { set innerHTML(v) { html.set('last', v); }, children: target.childNodes }; return d; } };
  let boom = true;
  const run = new Function('document', 'isCurrentMount', 'SOURCES_FOLD_ID', 'SHARED_FOLD_ID', 'hostedSectionsBusy', 'programmaticFolds', 'state', 'patchInPlace', 'healthMorphKey', 'console',
    morphSrc + '\n' + src + '\nreturn patchMainAroundHosts;')(
    stubDoc, () => true, 'x-sources', 'x-shared', () => false, [], { activeSlug: 'alpha' },
    (a, b, o) => { if (boom) { a.childNodes[0].setAttribute('data-half', 'done'); throw new Error('boom'); } return patchInPlace(a, b, o); },
    healthKey, { warn() {} });
  const targetSec = target.childNodes[0];
  const r = run('<ignored>', 't');
  ok(r === true, 'a failed patch still delivers the paint');
  const nowOnScreen = liveCol.childNodes[0];
  ok(nowOnScreen !== liveSec && nowOnScreen === targetSec, 'the whole-section replacement ran: the half-patched node is gone');
  ok(!nowOnScreen.outerHTML.includes('data-half') && nowOnScreen.outerHTML.includes('new'), 'and the section on screen is the complete new one');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
