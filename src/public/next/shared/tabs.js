/**
 * shared/tabs.js — TABS and SEGMENTED, the two pickers that are not a menu
 * (kit v1). The menu picker stays shared/listbox.js.
 *
 * The 2026-11-27 inventory counted 8 segmented families, 3 hand-built
 * radiogroups, lens chips and browse tabs. From phase 2 on a view switches
 * between panels with tabs() and between 2–4 settings with segmented().
 *
 * ── tabs({ id, label, items, active, pro? }) → HTML ───────────────────────
 *   id      a stable prefix: the tab of item `x` is `<id>-tab-x`, its panel
 *           `<id>-panel-x` (tabPanelAttrs() writes the panel's attributes).
 *   label   the tablist's accessible name.
 *   items   [{ id, label, count?, pro? }] — `count` is a figure (fmtCount).
 *   active  the selected item's id. If it names nothing drawn (a Pro tab
 *           while Pro is off, or a typo) the first drawn tab is selected and
 *           activeTab() tells the view which.
 *   pro     whether Pro is on; defaults to shared/pro.js isPro().
 *
 * ARIA: role="tablist" > role="tab" buttons, aria-selected, aria-controls,
 * ROVING tabindex (only the selected tab is in the tab order). wireTabs()
 * moves with ←/→ (wrapping), Home and End, and ACTIVATES on move — the
 * WAI-ARIA "automatic activation" model, right for panels the view already
 * holds in memory.
 *
 * ── PRO TABS, AND THE LINE THEY MAY NOT CROSS (owner decision D1) ──────────
 * A tab with `pro: true` is DRAWN only while Pro is on (layouts may differ
 * between Simple and Pro: "two layouts, one model"). It is not CSS-hidden; it
 * is absent, so it is out of the roving order and the accessibility tree.
 * NOTHING ON THE NEVER-HIDE LIST MAY LIVE ONLY IN A PRO TAB: a warning, a
 * cost, a refusal, a confirm, the outcome of a press, or anything needed to
 * finish a task must also be reachable with Pro off (scripts/test-pro-guard.js
 * holds that line for views; a Pro tab is Pro-only markup like any other).
 * A view re-renders its tabs on shared/pro.js onProChange.
 *
 * ── segmented({ id, label, items, active }) → HTML ──────────────────────────
 * 2–4 choices of ONE setting (fewer or more THROWS: one choice is a label,
 * five is a menu — use listbox.js). role="radiogroup" > role="radio" buttons,
 * aria-checked, roving tabindex; wireSegmented() moves and selects with the
 * arrow keys, Home and End. Never Pro-only items: a setting's choices are the
 * same in both modes.
 *
 * DOM-free at import; the wire functions touch only the root they are given.
 */

import { isPro } from './pro.js';
import { fmtCount } from './format.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
// A strip's own id starts with a letter (it prefixes DOM ids); an ITEM's id
// may start with a digit ("200k"), since it only ever follows that prefix.
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function checkId(what, v) {
  const re = / item$/.test(what) ? ITEM_RE : ID_RE;
  if (typeof v !== 'string' || !re.test(v)) throw new Error(what + ': "' + v + '" is not a valid id');
  return v;
}

/** The items a tab strip DRAWS for this mode. */
export function drawnTabs(items, pro) {
  const on = pro === undefined ? isPro() : !!pro;
  return (Array.isArray(items) ? items : []).filter((t) => t && (!t.pro || on));
}

/** The id the strip will show as selected. */
export function activeTab(items, active, pro) {
  const drawn = drawnTabs(items, pro);
  if (drawn.some((t) => t.id === active)) return active;
  return drawn.length ? drawn[0].id : null;
}

export function tabs(o) {
  const opts = o || {};
  const id = checkId('tabs', opts.id);
  const drawn = drawnTabs(opts.items, opts.pro);
  if (!drawn.length) return '';
  const sel = activeTab(opts.items, opts.active, opts.pro);
  const btns = drawn.map((t) => {
    const tid = checkId('tabs item', t.id);
    const on = tid === sel;
    const count = t.count === undefined || t.count === null ? null : fmtCount(t.count);
    return '<button type="button" role="tab" class="kit-tab' + (on ? ' is-active' : '') + (t.pro ? ' kit-tab-pro' : '') + '"' +
      ' id="' + id + '-tab-' + tid + '" aria-controls="' + id + '-panel-' + tid + '"' +
      ' aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '"' +
      ' data-kit-tab="' + tid + '">' +
      '<span class="kit-tab-label">' + escapeHtml(t.label) + '</span>' +
      (count !== null ? '<span class="kit-tab-count">' + count + '</span>' : '') +
    '</button>';
  }).join('');
  return '<div class="kit-tabs" role="tablist" data-kit-tabs="' + id + '"' +
    (opts.label ? ' aria-label="' + escapeHtml(opts.label) + '"' : '') + '>' + btns + '</div>';
}

/** The attributes of the panel a tab controls (leading space). */
export function tabPanelAttrs(id, tabId) {
  checkId('tabPanelAttrs', id); checkId('tabPanelAttrs item', tabId);
  return ' role="tabpanel" id="' + id + '-panel-' + tabId + '" aria-labelledby="' + id + '-tab-' + tabId + '" tabindex="0"';
}

/** Where a key moves in a strip of `count`, from `index`; null = not ours. */
export function nextIndex(count, index, key) {
  if (!(count > 0)) return null;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (index + 1) % count;
    case 'ArrowLeft': case 'ArrowUp': return (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** Shared roving wiring for a tablist or a radiogroup. */
function wireRoving(root, groupSel, itemSel, idAttr, stateAttr, onChange) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  const select = (group, btn, focus) => {
    const all = Array.prototype.slice.call(group.querySelectorAll(itemSel));
    for (const b of all) {
      const on = b === btn;
      b.setAttribute(stateAttr, on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '0' : '-1');
      if (b.classList) b.classList.toggle('is-active', on);
    }
    if (focus && typeof btn.focus === 'function') btn.focus();
    if (typeof onChange === 'function') onChange(btn.getAttribute(idAttr), btn, group);
  };
  const click = (e) => {
    const btn = e && e.target && e.target.closest ? e.target.closest(itemSel) : null;
    const group = btn && btn.closest ? btn.closest(groupSel) : null;
    if (!btn || !group) return;
    if (btn.getAttribute(stateAttr) === 'true') return;
    select(group, btn, false);
  };
  const key = (e) => {
    const btn = e && e.target && e.target.closest ? e.target.closest(itemSel) : null;
    const group = btn && btn.closest ? btn.closest(groupSel) : null;
    if (!btn || !group) return;
    const all = Array.prototype.slice.call(group.querySelectorAll(itemSel));
    const to = nextIndex(all.length, all.indexOf(btn), e.key);
    if (to === null) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    select(group, all[to], true);
  };
  root.addEventListener('click', click);
  root.addEventListener('keydown', key);
  return () => { root.removeEventListener('click', click); root.removeEventListener('keydown', key); };
}

/** onChange(tabId, tabEl, tablistEl). Returns an unwire function. */
export function wireTabs(root, onChange) {
  return wireRoving(root, '[role="tablist"]', '[role="tab"]', 'data-kit-tab', 'aria-selected', onChange);
}

export function segmented(o) {
  const opts = o || {};
  const id = checkId('segmented', opts.id);
  const items = Array.isArray(opts.items) ? opts.items : [];
  if (items.length < 2 || items.length > 4) {
    throw new Error('segmented: 2–4 choices (got ' + items.length + '); use shared/listbox.js for more');
  }
  if (items.some((t) => t && t.pro)) throw new Error('segmented: a choice is never Pro-only');
  const sel = items.some((t) => t.id === opts.active) ? opts.active : items[0].id;
  const btns = items.map((t) => {
    const tid = checkId('segmented item', t.id);
    const on = tid === sel;
    return '<button type="button" role="radio" class="kit-seg-opt' + (on ? ' is-active' : '') + '"' +
      ' aria-checked="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '"' +
      ' data-kit-seg="' + tid + '">' + escapeHtml(t.label) + '</button>';
  }).join('');
  return '<div class="kit-seg" role="radiogroup" data-kit-segmented="' + id + '"' +
    (opts.label ? ' aria-label="' + escapeHtml(opts.label) + '"' : '') + '>' + btns + '</div>';
}

/** onChange(choiceId, buttonEl, groupEl). Returns an unwire function. */
export function wireSegmented(root, onChange) {
  return wireRoving(root, '[role="radiogroup"]', '[role="radio"]', 'data-kit-seg', 'aria-checked', onChange);
}
