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
 *   toolTip  → the detail lines go into a submenu, as disabled items under a
 *              separator — hovering a Windows submenu parent opens it, which
 *              is the nearest thing a Windows menu has to a hover tooltip:
 *
 *              · an item that already has a submenu gains them at its end;
 *              · a LEAF INSIDE A SUBMENU (a domain's bar, a tool's strip)
 *                STAYS A LEAF with its own click, exactly as on the Mac, and
 *                its lines join the end of the submenu it sits in (v4.0.1:
 *                v4.0.0 turned each one into a parent whose first item was a
 *                generic "Open in The Curator" — on a domain row that opened
 *                Settings, and the menu no longer looked like the Mac's);
 *              · a TOP-LEVEL leaf (the save pulse, a clipped notice) becomes a
 *                parent, and its action becomes the submenu's first item,
 *                worded for what it really does (`actionLabels` by id,
 *                default WIN_OPEN_LABEL), so nothing clickable stops being
 *                clickable.
 *
 *              A line the same submenu already shows (a row's header, its
 *              own second line) is not repeated; when every leaf in one
 *              submenu explains itself with the same sentence after its own
 *              label ("Bar: against the largest domain, …"), that sentence is
 *              shown once.
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

/** A Windows menu is as wide as its widest item, so a detail line longer than
 *  this many characters is wrapped into consecutive disabled rows. */
export const WIN_DETAIL_LINE_CHARS = 60;

/** The action label a leaf's own click moves to when it becomes a parent. */
export const WIN_OPEN_LABEL = 'Open in The Curator';

/** `&` is a mnemonic marker in a Windows menu label; `&&` draws one `&`. */
export function escapeWinMnemonic(label) {
  return typeof label === 'string' ? label.replace(/&/g, '&&') : label;
}

function tipLines(toolTip, writtenAtText) {
  const human = typeof writtenAtText === 'string' && writtenAtText.trim() ? writtenAtText.trim() : null;
  return String(toolTip)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // A row that carries a readable time shows it instead of the ISO text.
    .map((l) => (human && /^written:\s/.test(l) ? 'written: ' + human : l))
    .slice(0, WIN_DETAIL_LINES_MAX);
}

/**
 * Wrap one line at word boundaries into rows of about WIN_DETAIL_LINE_CHARS.
 * A backticked span and an identifier-like word (no spaces) are never split:
 * one longer than the limit simply gets its own, wider row. Every word is
 * kept, in order.
 */
export function wrapDetailLine(line, width = WIN_DETAIL_LINE_CHARS) {
  const text = String(line).trim();
  if (text.length <= width) return [text];
  const tokens = text.match(/`[^`]*`\S*|\S*`[^`]*`\S*|\S+/g) || [text];
  const rows = [];
  let cur = '';
  for (const t of tokens) {
    if (!cur) { cur = t; continue; }
    if ((cur + ' ' + t).length <= width) cur += ' ' + t;
    else { rows.push(cur); cur = t; }
  }
  if (cur) rows.push(cur);
  return rows;
}

function caption(line) {
  return { label: escapeWinMnemonic(line), enabled: false };
}

/** The raw (unescaped) label an item will show on Windows. */
function shownLabel(item) {
  const label = typeof item.label === 'string' ? item.label : '';
  return typeof item.sublabel === 'string' && item.sublabel.trim()
    ? label + ' — ' + item.sublabel.trim() : label;
}

/** An item's own tooltip lines, minus those its own label already says. */
function ownTipLines(item) {
  const tip = typeof item.toolTip === 'string' ? item.toolTip.trim() : '';
  if (!tip) return [];
  const label = (typeof item.label === 'string' ? item.label : '').trim();
  const sub = (typeof item.sublabel === 'string' ? item.sublabel : '').trim();
  // A tooltip that only repeats the label adds no fact.
  if (tip === label) return [];
  return tipLines(tip, item.writtenAtText).filter((l) => l !== label && l !== sub);
}

/** Append caption lines under a separator, skipping any the menu already shows. */
function appendDetails(submenu, lines) {
  const shown = new Set();
  for (const i of submenu) if (i && typeof i.label === 'string') shown.add(i.label);
  const add = [];
  for (const l of lines) {
    const esc = escapeWinMnemonic(l);
    if (shown.has(esc)) continue;
    shown.add(esc);
    for (const row of wrapDetailLine(l)) add.push(caption(row));
  }
  if (add.length) submenu.push({ type: 'separator' }, ...add.slice(0, WIN_DETAIL_LINES_MAX));
}

/**
 * The lines the LEAVES of one submenu move out to its end. A line that starts
 * with the leaf's own label + " · " is that leaf restating itself; when every
 * such leaf's remainder is the SAME sentence, it is said once. Otherwise each
 * restating line is kept whole, so a fact never loses the name it belongs to.
 */
function leafLines(leaves) {
  const entries = [];
  for (const leaf of leaves) {
    const label = (typeof leaf.label === 'string' ? leaf.label : '').trim();
    for (const full of ownTipLines(leaf)) {
      const rem = label && full.startsWith(label + ' · ') ? full.slice(label.length + 3).trim() : null;
      entries.push({ full, rem: rem || null });
    }
  }
  const rems = new Set(entries.filter((e) => e.rem !== null).map((e) => e.rem));
  // One sentence shared by every leaf that restates itself → that sentence
  // applies to each of them, so it is said once; a line with no restated
  // label is kept whole either way.
  const shared = rems.size === 1;
  return entries.map((e) => (shared && e.rem !== null ? e.rem : e.full));
}

function baseItem(item) {
  if (item.type === 'separator') return { type: 'separator' };
  const out = { ...item };
  delete out.sublabel;
  delete out.toolTip;
  delete out.writtenAtText;
  // A section header → the disabled caption the Mac module's own fallback is.
  if (out.type === 'header') delete out.type;
  // `role: 'quit'` keeps whatever label it has; Electron draws it.
  if (typeof item.label === 'string') out.label = escapeWinMnemonic(shownLabel(item));
  return out;
}

/**
 * Adapt one submenu: its leaves stay leaves, their facts collect at its end,
 * then the parent's own facts.
 */
function adaptSubmenu(items, parentLines, actionLabels) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const leaves = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') { out.push(it); continue; }
    if (it.type === 'separator') { out.push({ type: 'separator' }); continue; }
    if (Array.isArray(it.submenu)) { out.push(adaptItem(it, actionLabels)); continue; }
    out.push(baseItem(it));
    leaves.push(it);
  }
  appendDetails(out, [...leafLines(leaves), ...parentLines]);
  return out;
}

function adaptItem(item, actionLabels = {}) {
  if (!item || typeof item !== 'object') return item;
  if (item.type === 'separator') return { type: 'separator' };

  const out = baseItem(item);
  const details = ownTipLines(item);

  if (Array.isArray(item.submenu)) {
    out.submenu = adaptSubmenu(item.submenu, details, actionLabels);
    return out;
  }

  if (details.length && !item.role) {
    const sub = [];
    if (typeof item.click === 'function') {
      const word = (item.id && typeof actionLabels[item.id] === 'string') ? actionLabels[item.id] : WIN_OPEN_LABEL;
      sub.push({ label: escapeWinMnemonic(word), click: item.click });
    }
    appendDetails(sub, details);
    // No action → no separator above the facts.
    if (sub[0] && sub[0].type === 'separator') sub.shift();
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
 * @param {{actionLabels?: Object<string,string>}} [opts]  the words for a
 *   top-level leaf's own action once it becomes a parent, by item id
 * @returns {Array} a new template; the input is not mutated
 */
export function adaptTrayMenuForWindows(template, opts = {}) {
  const actionLabels = opts && opts.actionLabels && typeof opts.actionLabels === 'object' ? opts.actionLabels : {};
  return (Array.isArray(template) ? template : []).map((i) => adaptItem(i, actionLabels));
}
