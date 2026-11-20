/**
 * adaptTrayMenuForWindows() — the SAME tray menu, re-expressed for what a
 * Windows menu can draw.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY A SECOND PASS, AND NOT A SECOND MENU                                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The owner's rule for the Windows widget (2026-11-20): the same facts as the
 * Mac menu-bar widget. `lib/tray-menu.js` builds those facts once. On Windows
 * three of the fields it uses do not draw at all — checked against the
 * installed Electron 43.5.0 typings, not recalled:
 *
 *   sublabel   `@platform darwin` (macOS 14.4+). A row's second line —
 *              "opus-5.5 — v1.3.0 shipped…" — would simply vanish.
 *   toolTip    `@platform darwin`. Every hover detail (machine, model, written
 *              at, a clipped notice's whole sentence) would vanish.
 *   'header'   a macOS 14 section header; elsewhere the safe fallback the
 *              Mac module already designed for is a disabled caption.
 *
 * So instead of a second menu (two menus agree today and drift tomorrow), this
 * pass takes the one template and moves each Mac-only field somewhere Windows
 * draws it:
 *
 *   sublabel → appended to the label, after " — ".
 *   toolTip  → the detail lines go INTO a submenu, as disabled items, under a
 *              separator. An item that already has a submenu gains them at the
 *              end; a leaf becomes a submenu parent, and if it had an action,
 *              that action becomes the submenu's first item ("Open in The
 *              Curator"), so nothing that was clickable stops being clickable.
 *   header   → a disabled caption item.
 *
 * And one thing Windows draws that macOS does not: `&` in a label is a
 * MNEMONIC marker (the next letter is underlined and the & disappears), so a
 * project called "R&D" would read "RD". Every label is escaped (`&` → `&&`).
 *
 * Ids, order, click handlers, icons, roles and enabled states are carried over
 * untouched. The Mac template never passes through here.
 */

/** Detail lines added per item, at most. A tooltip is a handful of lines; a
 *  cap keeps a pathological one from growing a menu taller than the screen. */
export const WIN_DETAIL_LINES_MAX = 12;

/** The action label a leaf's own click moves to when it becomes a parent. */
export const WIN_OPEN_LABEL = 'Open in The Curator';

/** `&` is a mnemonic marker in a Windows menu label; `&&` draws one `&`. */
export function escapeWinMnemonic(label) {
  return typeof label === 'string' ? label.replace(/&/g, '&&') : label;
}

function detailItems(toolTip) {
  return String(toolTip)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, WIN_DETAIL_LINES_MAX)
    .map((l) => ({ label: escapeWinMnemonic(l), enabled: false }));
}

function adaptItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.type === 'separator') return { type: 'separator' };

  const out = { ...item };
  delete out.sublabel;
  delete out.toolTip;

  // A section header → the disabled caption the Mac module's own fallback is.
  if (out.type === 'header') delete out.type;

  // `role: 'quit'` keeps whatever label it has; Electron draws it.
  let label = typeof item.label === 'string' ? item.label : undefined;
  if (label !== undefined && typeof item.sublabel === 'string' && item.sublabel.trim()) {
    label = label + ' — ' + item.sublabel.trim();
  }
  if (label !== undefined) out.label = escapeWinMnemonic(label);

  const tip = typeof item.toolTip === 'string' ? item.toolTip.trim() : '';
  // A tooltip that only repeats the label adds no fact.
  const details = tip && tip !== (item.label || '').trim() ? detailItems(tip) : [];

  if (Array.isArray(item.submenu)) {
    out.submenu = item.submenu.map(adaptItem);
    if (details.length) out.submenu.push({ type: 'separator' }, ...details);
    return out;
  }

  if (details.length && !item.role) {
    const sub = [];
    if (typeof item.click === 'function') {
      sub.push({ label: WIN_OPEN_LABEL, click: item.click }, { type: 'separator' });
    }
    sub.push(...details);
    delete out.click;
    // A parent must be enabled or its submenu cannot open; a statement that
    // was disabled stays a statement — its submenu holds only disabled lines.
    out.enabled = true;
    out.submenu = sub;
  }
  return out;
}

/**
 * @param {Array} template  a `buildTrayMenuTemplate()` result
 * @returns {Array} a new template; the input is not mutated
 */
export function adaptTrayMenuForWindows(template) {
  return (Array.isArray(template) ? template : []).map(adaptItem);
}
