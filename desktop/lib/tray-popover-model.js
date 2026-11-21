/**
 * The Windows tray popover's MODEL — the Mac template, as pages a web page
 * paints (v4.1.0). Pure: no Electron, so `npm test` executes all of it.
 *
 * ── THE ONE IDEA ────────────────────────────────────────────────────────────
 *
 * The popover is a second PAINTER of the menu that already exists. It does not
 * read `buildTrayModel()`'s output and decide what to show; it takes the FULL
 * Mac template from `buildTrayMenuTemplate()` — every label, sublabel,
 * tooltip, header, picture, order and action — built with the Windows words
 * ("Show current.md in File Explorer") but WITHOUT the native Windows menu's
 * adaptation (`adaptForWindows: false`), and turns its tree into pages:
 *
 *   - a submenu parent        → a `drill` row and a page of its own, whose
 *                               Details block holds the parent's tooltip lines
 *                               and each leaf's on that page (D7: hover facts
 *                               are visible on the drill page, never tooltips)
 *   - a ROOT leaf with facts  → a `drill` row to a small page: its action,
 *                               worded as the native Windows menu words it
 *                               (WIN_LEAF_ACTION_LABELS / WIN_OPEN_LABEL),
 *                               then its facts. Root carries no Details block.
 *   - a leaf with a click     → an `action` row; its id goes in the action map
 *   - `role: 'quit'`          → an `action` row whose map entry is the string
 *                               'quit': main runs `app.quit()` (never
 *                               `app.exit()` — `before-quit` holds the
 *                               write-status guard; see tray-menu.js)
 *   - everything else         → a `statement` (or the `stamp`), never pressable
 *
 * So parity (v3.66.0) holds by construction: no fact, wording or ordering
 * decision lives here. `scripts/test-tray-popover-model.js` proves it with a
 * census of `flattenTrayMenu()` against the pages.
 *
 * ── THE GENERATION IS LOAD-BEARING ─────────────────────────────────────────
 *
 * Row ids are a per-build sequence (`'tray-row-' + n` in tray-model.js), and
 * the tray re-renders on every click and every save. An id pressed on an old
 * page can therefore name a DIFFERENT project after a refresh. The gate below
 * stamps each published payload with a generation and refuses any press that
 * does not carry the current one.
 *
 * The contract (payload schema, actions, IPC) is written down for the page and
 * the controller in the Windows-app handoff folder's CONTRACT-tray-popover.md.
 */

import {
  buildTrayMenuTemplate, MENU_HEADER_TYPE, ID_UPDATED_STAMP, WIN_LEAF_ACTION_LABELS,
} from './tray-menu.js';
import { WIN_OPEN_LABEL } from './tray-menu-win.js';

/** The payload's shape version (CONTRACT §1). */
export const POPOVER_PAYLOAD_VERSION = 1;

/** The integer picture scales main.js asks `buildTrayModel` for
 *  (`imageScales`). With the strip drawn at 2x CSS size (D6) these give it
 *  densities 1, 1.5, 2 and 3; the dots and bars, drawn at 1x, get 1, 2 and 3.
 *  Displays at 125 % and 150 % take the next density up. */
export const POPOVER_IMAGE_SCALES = Object.freeze([1, 2, 3, 4, 6]);

/** The pulse strips are painted at twice their point size (D6). */
export const STRIP_CSS_SCALE = 2;

/** No display this ships to is denser than 300 %; a denser source is bytes
 *  the page never uses. */
export const MAX_IMAGE_DENSITY = 3;

/** The longest action id a press may carry (the preload refuses longer). */
export const MAX_ACTION_ID_CHARS = 200;

/** The action-map value for Quit. */
export const QUIT_ACTION = 'quit';

function str(v) {
  return typeof v === 'string' ? v : '';
}

function sublabelOf(item) {
  return typeof item.sublabel === 'string' && item.sublabel.trim() ? item.sublabel.trim() : null;
}

/** The separator a one-line tooltip joins its facts with (tray-model.js). */
export const TIP_CLAUSE_SEPARATOR = ' · ';

/** An item's tooltip as lines, minus lines its own label or sublabel already
 *  says (the same rule the native Windows menu uses, without its line cap:
 *  the popover scrolls). A line that OPENS with the row's own label as its
 *  first clauses ("notes · 687 pages · Bar: …" under the row "notes · 687
 *  pages", the Knowledge page) loses that repeated opening: the Details block
 *  sits under the row's label, so it would say it twice. Nothing else in the
 *  line is touched. */
export function tipLines(item) {
  if (!item || typeof item !== 'object') return [];
  const tip = typeof item.toolTip === 'string' ? item.toolTip.trim() : '';
  if (!tip) return [];
  const label = str(item.label).trim();
  const sub = sublabelOf(item) || '';
  const lead = label ? label + TIP_CLAUSE_SEPARATOR : null;
  return tip.split('\n').map((l) => l.trim())
    .map((l) => (!lead ? l : (l.startsWith(lead) ? l.slice(lead.length).trim() : (l === lead.trim() ? '' : l))))
    .filter((l) => l && l !== label && l !== sub);
}

function dataUrl(buf) {
  if (!(buf instanceof Uint8Array) || buf.length === 0) return null;
  return 'data:image/png;base64,' + Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64');
}

/**
 * One image spec (as tray-model.js's renderers produce it) → the page's
 * picture: CSS size and a density-sorted source list. Null when there is
 * nothing drawable — a missing picture costs the picture, never the row.
 */
export function popoverImage(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const kind = spec.kind === 'dot' ? 'dot'
    : (Object.prototype.hasOwnProperty.call(spec, 'frac') ? 'bar' : 'strip');
  const css = kind === 'strip' ? STRIP_CSS_SCALE : 1;
  const wp = Number(spec.widthPoints), hp = Number(spec.heightPoints);
  if (!(Number.isFinite(wp) && wp > 0 && Number.isFinite(hp) && hp > 0)) return null;
  const raw = Array.isArray(spec.buffers) && spec.buffers.length
    ? spec.buffers.map((b) => (b && typeof b === 'object' ? [b.scale, b.buffer] : [null, null]))
    : [[1, spec.buffer], [2, spec.buffer2x]];
  const all = [];
  for (const [scale, buffer] of raw) {
    if (!Number.isInteger(scale) || scale < 1) continue;
    const url = dataUrl(buffer);
    if (!url) continue;
    const density = scale / css;
    if (!all.some((s) => s.density === density)) all.push({ density, url });
  }
  if (!all.length) return null;
  all.sort((a, b) => a.density - b.density);
  const usable = all.filter((s) => s.density >= 1 && s.density <= MAX_IMAGE_DENSITY);
  // Nothing in range (a 1x-only strip, say): the densest there is, rather than
  // no picture at all.
  const sources = usable.length ? usable : [all[all.length - 1]];
  return {
    kind,
    tier: kind === 'dot' && typeof spec.tier === 'string' ? spec.tier : null,
    w: wp * css,
    h: hp * css,
    sources,
  };
}

/**
 * Template → `{ payload, actions }`. `payload.gen` is 0 until a gate
 * publishes it. Exported for the suite; main.js calls `buildTrayPopover`.
 *
 * @param {Array} template  a buildTrayMenuTemplate() result, built with
 *   `makeIcon: s => s` so the pictures arrive as specs
 * @param {{theme?: 'dark'|'light'}} [o]
 * @returns {{payload: object, actions: Map<string, Function|'quit'>}}
 */
export function popoverFromTemplate(template, o = {}) {
  const theme = o && o.theme === 'dark' ? 'dark' : 'light';
  const pages = {};
  const actions = new Map();
  let keyN = 0, drillN = 0, detailN = 0, synthN = 0;
  const key = () => 'k' + (keyN++);

  const actionable = (item) => item.role === 'quit'
    || (typeof item.click === 'function' && item.enabled !== false);

  /** The id a press carries: the template's own when usable and unique,
   *  else a synthesized one — the map can never hold two rows under one id. */
  const claimId = (item) => {
    let id = typeof item.id === 'string' && item.id.length >= 1 && item.id.length <= MAX_ACTION_ID_CHARS
      && !actions.has(item.id) ? item.id : null;
    while (!id || actions.has(id)) id = 'tray-action-' + (synthN++);
    actions.set(id, item.role === 'quit' ? QUIT_ACTION : item.click);
    return id;
  };

  const actionRow = (item, label = str(item.label)) => ({
    kind: 'action', key: key(), id: claimId(item), label,
    sublabel: sublabelOf(item), img: popoverImage(item.icon),
  });

  function buildPage(id, parent, title, subtitle, items, ownLines) {
    const page = { id, parent, title, subtitle, rows: [], details: [] };
    pages[id] = page;
    const isRoot = parent === null;
    if (ownLines.length) page.details.push({ label: null, lines: ownLines });
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'separator') { page.rows.push({ kind: 'separator', key: key() }); continue; }
      if (item.type === MENU_HEADER_TYPE) { page.rows.push({ kind: 'header', key: key(), label: str(item.label) }); continue; }
      const label = str(item.label);
      const sublabel = sublabelOf(item);
      const lines = tipLines(item);
      if (Array.isArray(item.submenu)) {
        const pid = 'p:' + (drillN++);
        page.rows.push({ kind: 'drill', key: key(), drill: pid, label, sublabel, img: popoverImage(item.icon) });
        buildPage(pid, id, label, sublabel, item.submenu, lines);
        continue;
      }
      if (isRoot && lines.length) {
        // A root leaf with facts: a page of its own, never a Details block on
        // root (D7). Its action, if it has one, is the page's first row,
        // worded as the native Windows menu words it.
        const pid = 'd:' + (detailN++);
        page.rows.push({ kind: 'drill', key: key(), drill: pid, label, sublabel, img: popoverImage(item.icon) });
        const sub = { id: pid, parent: id, title: label, subtitle: sublabel, rows: [], details: [{ label: null, lines }] };
        pages[pid] = sub;
        if (actionable(item)) {
          const word = typeof item.id === 'string' && typeof WIN_LEAF_ACTION_LABELS[item.id] === 'string'
            ? WIN_LEAF_ACTION_LABELS[item.id] : WIN_OPEN_LABEL;
          sub.rows.push({ ...actionRow(item, word), sublabel: null, img: null });
        }
        continue;
      }
      if (actionable(item)) page.rows.push(actionRow(item, label));
      else if (item.id === ID_UPDATED_STAMP) page.rows.push({ kind: 'stamp', key: key(), label });
      else page.rows.push({ kind: 'statement', key: key(), label, sublabel, img: popoverImage(item.icon) });
      if (lines.length) page.details.push({ label, lines });
    }
    return page;
  }

  buildPage('root', null, null, null, template, []);
  return {
    payload: { v: POPOVER_PAYLOAD_VERSION, gen: 0, theme, root: 'root', pages },
    actions,
  };
}

/**
 * The model main.js built → the popover's `{ payload, actions }`.
 *
 * Builds the template ITSELF, so no caller can hand it the native Windows
 * menu's adapted tree (which has lost the sublabels, tooltips and headers):
 * the Windows words, the full Mac structure, the pictures as specs.
 *
 * @param {object} model  a buildTrayModel() result — built by main.js with
 *   `platform: 'win32'`, `imageScales: POPOVER_IMAGE_SCALES` and `dark` set to
 *   the SYSTEM mode (D3), the same mode passed here as `theme`
 * @param {object} o  `theme`, `appName`, and the five handlers the native menu
 *   takes (onOpenScope, onOpenMemory, onOpenApp, onOpenSettings, onRowAction)
 *   — a missing handler throws, as it does for the menu
 */
export function buildTrayPopover(model, o = {}) {
  const {
    theme, appName, onOpenScope, onOpenMemory, onOpenApp, onOpenSettings, onRowAction,
  } = o || {};
  const template = buildTrayMenuTemplate(model, {
    ...(typeof appName === 'string' && appName ? { appName } : {}),
    onOpenScope, onOpenMemory, onOpenApp, onOpenSettings, onRowAction,
    makeIcon: (spec) => spec,
    platform: 'win32',
    adaptForWindows: false,
  });
  return popoverFromTemplate(template, { theme });
}

/**
 * The action map of the generation last SENT, and the only way a press
 * reaches a handler. One per popover controller.
 *
 *   publish(built)        → the payload, stamped gen = previous + 1; the
 *                           previous generation's ids die with it
 *   current()             → the last published payload, or null
 *   resolve(gen, id)      → null (refused) | 'quit' | the item's own click
 *   act(gen, id, {quit})  → boolean; runs what resolve returned ('quit' →
 *                           the injected quit, main's `() => app.quit()`);
 *                           never throws
 *
 * Refused, with no side effect: a gen that is not the current one (STALE), a
 * gen that is not a positive safe integer, nothing published yet, an id that
 * is not a 1..200-character string, or one not in the current map.
 */
export function createPopoverActionGate() {
  let gen = 0;
  let payload = null;
  let actions = new Map();
  function resolve(g, id) {
    if (!payload || !Number.isSafeInteger(g) || g < 1 || g !== gen) return null;
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ACTION_ID_CHARS) return null;
    if (!actions.has(id)) return null;
    const a = actions.get(id);
    return a === QUIT_ACTION || typeof a === 'function' ? a : null;
  }
  return {
    publish(built) {
      if (!built || typeof built !== 'object' || !built.payload || !(built.actions instanceof Map)) {
        throw new Error('createPopoverActionGate.publish: expected a buildTrayPopover() result');
      }
      gen += 1;
      payload = { ...built.payload, gen };
      actions = new Map(built.actions);
      return payload;
    },
    current() { return payload; },
    get gen() { return gen; },
    resolve,
    act(g, id, o = {}) {
      const a = resolve(g, id);
      if (!a) return false;
      const run = a === QUIT_ACTION ? (o && o.quit) : a;
      if (typeof run !== 'function') return false;
      try { run(); return true; } catch { return false; }
    },
  };
}
