/**
 * buildTrayMenuTemplate() — the menubar menu, as plain data.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  PHASE 1 IS A MENU, NOT A POPOVER, AND THAT IS DECIDED.                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Electron's `Tray` exposes no way to attach a rendered view — it can show a
 * `Menu` and nothing else — and Apple's HIG says a menu bar extra should
 * "display a menu, not a popover … unless the functionality is too complex for
 * a menu". Phase 1 is not. A richer popover panel is a deliberate later phase;
 * nothing here is half-built toward it.
 *
 * The consequence is that `Menu.buildFromTemplate` consumes ordinary objects,
 * so the ENTIRE menu — every label, every ordering decision, which items are
 * actionable, which are statements, what the empty state says — is plain data
 * that `scripts/test-tray-shell.js` builds and inspects for real. main.js keeps
 * the two Electron calls it cannot give away. This is the same split, and the
 * same reason, as `lib/menu.js` and `lib/quit-decision.js`.
 *
 * ── THE ORDER OF THE MENU IS THE DESIGN (Layout A, v3.74.0) ────────────────
 *
 *   1  the save pulse               a drawn strip + "7 days · 192 saves ·
 *                                   Claude Code" › SAVES BY TOOL — one strip
 *                                   per harness (a plain item when the data
 *                                   layer supplies no per-tool lanes)
 *   -  separator
 *   -  header                       "Active · last 24 h"
 *   2  one row per (project ×       "ott · Claude Code · 8 min ago"
 *      harness) saved in 24 h       sublabel "opus-5.5 — v1.3.0 shipped…"
 *                                   the app's freshness dot in the gutter;
 *                                   › the four actions + OTHER WORK-STREAMS
 *                                   (each › the same four actions)
 *   2b the overflow, when capped    "+2 more active projects" › the same rows
 *   3  notices, only when true,     handoffs waiting on GitHub; a machine that
 *      between separators           saved after this one; "Two tools are
 *                                   writing ott / main" (ONE per work-stream,
 *                                   enabled: opens the project); stale docs
 *   4  the Idle fold                "Idle · 4 projects" / "field-notes 1 wk ·
 *                                   lumina 2 wk · +2 more" › one row per project
 *   5  "Knowledge · 6 domains"      › every domain's page bar, in its identity
 *                                   colour (design rule 5, unchanged)
 *   -  separator
 *   6  Open Project Context…  ·  Open The Curator  ·  Settings…
 *   -  separator
 *   7  "Updated 14:32"              when the figures were READ
 *   -  separator
 *   8  Quit The Curator
 *
 * REMOVED FROM THE MENU, KEPT IN THE APP (the maintainer's decision): the
 * "Working on" headline and its grey harness · model line (the first Active
 * row says it once, with a noun for each fact; the icon's hover keeps the
 * fast answer), the Session start line, the Documents line, and the
 * "N of M saved" capture bars (D5: they counted MCP process ids, not
 * sessions).
 *
 * A click opens the menu on the snapshot the last read produced and refreshes
 * afterwards (main.js); the filesystem watch keeps that snapshot close. So the
 * menu is NOT "fresh on click", and nothing here says it is — the Updated
 * stamp says when the figures were read.
 *
 * ── QUIT IS `role: 'quit'`, AND THAT IS A SAFETY PROPERTY ──────────────────
 *
 * Not a `click` handler. The role goes through Electron's normal shutdown,
 * which fires `before-quit`, which is where main.js asks
 * `GET /api/write-status` whether a paid, multi-minute ingest is in flight and
 * runs `lib/quit-decision.js` over the answer. A hand-rolled handler could call
 * `app.exit()` and walk straight past that guard — the single most likely way
 * to break the guard while adding a tray. Structuring it as a role means the
 * item has NO code path to get that wrong, and the suite asserts the tray's
 * Quit carries the role and carries no click handler at all.
 *
 * That guard also becomes MORE load-bearing here, not less: an app that keeps
 * running with no window is more likely to be alive when a write is in flight.
 *
 * ── WHAT THE TRAY TITLE CARRIES: NOTHING. ──────────────────────────────────
 *
 * `tray.setTitle()` can put text beside the icon, and the tempting text is the
 * last-save age. It is refused, for three reasons:
 *
 *  1. A relative age in the bar is either STALE or it ticks. Keeping "4m"
 *     honest means a wake-up every minute for the life of the process, for a
 *     number nobody reads to the minute — the count-up this design already
 *     refuses inside the menu, promoted to somewhere it can never be closed.
 *  2. Menu bar width is the scarcest resource on a Mac, and items past the
 *     notch simply VANISH with no notification and no overflow section. A
 *     permanently wider item is a permanently more disappearable one — on the
 *     feature whose main risk is already that its icon silently is not there.
 *  3. The bit worth carrying is presence plus one state, and the template
 *     glyph carries it (see lib/tray-icon.js).
 *
 * So the answer to "what just happened" is the first Active row, one click
 * away, beside the absolute stamp that says how fresh the reading is.
 */

/** Item ids, so a caller can address an item without matching on its label.
 *  Labels are user-visible copy and will change; ids are a contract. */

/**
 * ── THE PER-ROW SUBMENU: THE ROUTE THE MENU ACTUALLY HAS ───────────────────
 *
 * Clicking a row opens the app on the row's PROJECT — from v3.48.0 addressed as
 * `<domain>/<project>`, which is the string `row.route` carries and the value
 * the memory view's `data-mem-project` attribute holds. It still cannot open the
 * row's SCOPE: the scope picker carries no routing attribute, and `data-view` /
 * `data-mem-project` remain the only two dispatch attributes there are. That
 * limit has been recorded since v3.35.0 and is not fixed here.
 *
 * So the submenu offers the route the menu DOES have — THE CLIPBOARD. Two of
 * its four items put the work-stream into a form an agent can act on:
 * `Copy resume prompt` for an agent that can reach the MCP or the filesystem,
 * and `Copy handoff as Markdown` for one that can reach neither and needs the
 * document itself pasted in.
 *
 * These are SUFFIXES appended to the row's own id, never bare constants, so a
 * handler is told which row it was invoked from by the id it receives — the
 * template is plain data and a caller must be able to address one item without
 * matching on a label a release will reword.
 */
export const ID_ROW_OPEN = 'open';
export const ID_ROW_RESUME = 'resume';
export const ID_ROW_HANDOFF = 'handoff';
export const ID_ROW_REVEAL = 'reveal';

/** Every action a row's submenu offers, in the order it offers them. Exported
 *  so the shell and the suite enumerate the same list rather than two lists
 *  that agree today. */
export const ROW_ACTIONS = [
  [ID_ROW_OPEN, 'Open in The Curator'],
  [ID_ROW_RESUME, 'Copy resume prompt'],
  [ID_ROW_HANDOFF, 'Copy handoff as Markdown'],
  [ID_ROW_REVEAL, 'Reveal current.md in Finder'],
];

/** A submenu item's id: `<row id>:<action>`. One place, so the shell's parser
 *  and the builder cannot drift. */
export function rowActionId(rowId, action) {
  return String(rowId) + ':' + String(action);
}
export const ID_PULSE = 'tray-pulse';
export const ID_HEADER_PULSE_TOOLS = 'tray-header-pulse-tools';
export const ID_HEADER_ACTIVE = 'tray-header-active';
export const ID_NO_ACTIVE = 'tray-no-active';
export const ID_OVERFLOW = 'tray-overflow';
export const ID_IDLE = 'tray-idle';
export const ID_IDLE_MORE = 'tray-idle-more';
export const ID_KNOWLEDGE = 'tray-knowledge';
export const ID_HEADER_STREAMS = 'streams-header';
export const ID_STREAMS_MORE = 'streams-more';
/** The EMPTY state's caption — a store with no project context at all. An
 *  empty menu whose "nothing yet" line sits under no heading reads as a
 *  broken menu rather than an empty one. */
export const ID_HEADER_ROWS = 'tray-header-rows';
export const ID_OPEN_MEMORY = 'tray-open-memory';
export const ID_OPEN_APP = 'tray-open-app';
export const ID_SETTINGS = 'tray-settings';
export const ID_UPDATED_STAMP = 'tray-updated-stamp';
export const ID_EMPTY = 'tray-empty';
export const ID_QUIT = 'tray-quit';
export const ID_HEADER_DOMAINS = 'tray-header-domains';

/** The empty state is the first thing a new user sees, and it must not read
 *  like an error. It says what the surface is for and how something gets into
 *  it — nothing else. It is also why the whole feature is off by default: on a
 *  fresh install this is the only thing it can ever show. */
export const EMPTY_LABEL = 'No project context yet';
export const EMPTY_HINT = 'A coding agent writes here through the my-curator MCP';

/** Shown instead of the hint when the read itself failed. A failure to READ is
 *  a different sentence from "nothing has been saved", and collapsing the two
 *  would tell a user with a full store that their store is empty. */
export const UNREADABLE_HINT = 'Open The Curator to see what went wrong';

/**
 * ── SECTION HEADERS, AND THE ONE THING THAT IS NOT PROVEN ABOUT THEM ───────
 *
 * `type: 'header'` renders as a proper macOS section header — small, quiet,
 * non-interactive — and it is what turns this from a list of items into
 * something shaped like the widgets the maintainer pointed at. It was verified
 * to be in Electron's accepted `type` union (`'normal' | 'separator' |
 * 'submenu' | 'checkbox' | 'radio' | 'header' | 'palette'`) on 43.5.0.
 *
 * ── macOS BELOW 14 ────────────────────────────────────────────────────────
 *
 * `header` is a macOS 14+ affordance. Electron's own type CHECK is JavaScript
 * and runs the same on every macOS, so `Menu.buildFromTemplate` cannot throw on
 * macOS 13 for a type this Electron accepts — the risk is not a crash, it is
 * that AppKit draws an ordinary item instead of a header.
 *
 * SO THE FALLBACK IS BUILT INTO THE ITEM RATHER THAN BRANCHED AROUND: a header
 * here carries `enabled: false` and NO click handler, so its worst case is a
 * dimmed, inert caption line — which is what a section heading looks like
 * anyway, and is the same idiom the notices and the freshness stamp already
 * use. There is no arrangement of macOS versions in which one of these becomes
 * a clickable item that does nothing, which is the failure worth preventing.
 *
 * THIS HAS NOT BEEN RENDERED ON ANY SCREEN. Electron is not an offline
 * dependency, no menu has been built, and neither the header drawing on macOS
 * 14 nor the degraded drawing below it has been observed.
 */
export const MENU_HEADER_TYPE = 'header';

/** Section captions. Nouns, not sentences — a header that explains is a header
 *  that costs a line of a surface with no vertical space. The Active header's
 *  words live on the model (`HEADER_ACTIVE`), beside the rule that fills it. */
export const HEADER_ROWS = 'Project context';
export const HEADER_STREAMS = 'Other work-streams';

/**
 * One image spec through the injected seam, or null.
 *
 * Guarded because a menu item that throws WHILE BEING BUILT takes the whole
 * menu with it, and a menubar with no menu is indistinguishable from one that
 * was never installed. A missing picture must never cost the reading beside it.
 */
function image(makeIcon, spec) {
  if (typeof makeIcon !== 'function' || !spec) return null;
  try { return makeIcon(spec) || null; } catch { return null; }
}

function header(id, label) {
  return { id, type: MENU_HEADER_TYPE, label, enabled: false };
}

const sep = { type: 'separator' };

/**
 * The four actions on one work-stream, under a header naming it.
 *
 * The header names the work-stream (`domain / project · scope`) because a
 * submenu that opens beside several near-identical rows has to say which one
 * it belongs to — and the row's own label is off to the left.
 *
 * `Reveal current.md in Finder` is offered on EVERY row including a foreign
 * one: a handoff pulled from another computer is a real file in this
 * checkout's own `state/` folder. The shell decides what to do when the path
 * is not there.
 */
function actionItems(row, onOpenScope, onRowAction) {
  const items = [header(rowActionId(row.id, 'header'), row.submenuHeader || row.scopeShort || row.scope || '')];
  for (const [action, label] of ROW_ACTIONS) {
    items.push({
      id: rowActionId(row.id, action),
      label,
      // `Open` keeps its own dedicated handler rather than being routed through
      // `onRowAction`: it is the one action that existed before this submenu
      // did, and a string-dispatched channel would make it depend on a switch.
      click: action === ID_ROW_OPEN
        ? () => onOpenScope(row)
        : () => onRowAction(row, action),
    });
  }
  return items;
}

/**
 * One drawn row as a menu item: label, sublabel, the freshness dot in the
 * gutter, and a submenu. A submenu parent carries NO `click` — on macOS a
 * click on it opens the submenu, and a handler beside it fires or not
 * depending on the AppKit path. `Open in The Curator` is the first action.
 */
function rowItem(row, makeIcon, submenu) {
  const dot = image(makeIcon, row.dot);
  return {
    id: row.id,
    label: row.label,
    ...(row.sublabel ? { sublabel: row.sublabel } : {}),
    ...(dot ? { icon: dot } : {}),
    ...(row.toolTip ? { toolTip: row.toolTip } : {}),
    submenu,
  };
}

/**
 * A primary row's submenu: its four actions, then — only when there are any —
 * OTHER WORK-STREAMS, each a row of its own with the same four actions.
 *
 * TWO LEVELS OF SUBMENU (row › stream › actions). Submenus on a tray menu
 * have been photographed (v3.42.0); a second level has NOT. It is ordinary
 * NSMenu nesting and Electron's template takes it as data, but it is listed
 * among the things to photograph before tagging.
 */
function rowSubmenu(row, onOpenScope, onRowAction, onOpenMemory, makeIcon) {
  const items = actionItems(row, onOpenScope, onRowAction);
  const streams = Array.isArray(row.streams) ? row.streams : [];
  const more = typeof row.streamsMoreLabel === 'string' && row.streamsMoreLabel ? row.streamsMoreLabel
    : (row.streamsHidden > 0 ? row.streamsHidden + ' more in Project Context…' : null);
  if (streams.length || more) {
    items.push(sep);
    items.push(header(rowActionId(row.id, ID_HEADER_STREAMS), HEADER_STREAMS));
    for (const s of streams) {
      items.push(rowItem(s, makeIcon, actionItems(s, onOpenScope, onRowAction)));
    }
    if (more) {
      // ENABLED: it is the only route to the streams the cap hid. The count
      // is the model's, taken against the project's true total (F5).
      items.push({
        id: rowActionId(row.id, ID_STREAMS_MORE),
        label: more,
        click: onOpenMemory,
      });
    }
  }
  return items;
}

/**
 * @param {object} model  a `buildTrayModel()` result.
 * @param {object} o
 * @param {string}   [o.appName]
 * @param {Function} o.onOpenScope   (row) => void   — open the app on that project
 * @param {Function} o.onOpenMemory  () => void      — open Project Context
 * @param {Function} o.onOpenApp     () => void      — reveal the window
 * @param {Function} o.onOpenSettings () => void
 * @param {Function} o.onRowAction   (row, action) => void
 * @param {Function} [o.makeIcon]  (spec) => NativeImage|null — the ONE Electron
 *   call the drawn images need, injected rather than imported, so every
 *   decision about the menu stays in a module `npm test` executes.
 * @returns {Array} a `Menu.buildFromTemplate` template
 */
export function buildTrayMenuTemplate(model, o = {}) {
  const {
    appName = 'The Curator',
    onOpenScope, onOpenMemory, onOpenApp, onOpenSettings, onRowAction, makeIcon,
  } = o;

  // Every handler is required. A menu item wired to `undefined` throws at
  // CLICK time — in front of the user, weeks later — so it is refused here,
  // at build time, where the suite sees it. Same rule as lib/menu.js.
  for (const [name, fn] of Object.entries({
    onOpenScope, onOpenMemory, onOpenApp, onOpenSettings, onRowAction,
  })) {
    if (typeof fn !== 'function') {
      throw new Error(`buildTrayMenuTemplate: ${name} must be a function, got ${typeof fn}`);
    }
  }

  const m = model && typeof model === 'object' ? model : null;
  const notices = m && Array.isArray(m.notices) ? m.notices : [];
  const active = m && m.active && Array.isArray(m.active.rows) ? m.active : null;
  const overflow = m && m.overflow && Array.isArray(m.overflow.rows) && m.overflow.rows.length ? m.overflow : null;
  const idle = m && m.idle && Array.isArray(m.idle.rows) ? m.idle : null;
  const empty = !m || m.empty === true || (!active && !idle);
  const template = [];
  const primary = (row) => rowItem(row, makeIcon, rowSubmenu(row, onOpenScope, onRowAction, onOpenMemory, makeIcon));

  // ── 1. The save pulse, on top, with SAVES BY TOOL ───────────────────────
  //
  // ENABLED: a disabled item is drawn at reduced contrast and macOS greys its
  // icon — the "barely visible" strip the maintainer reported at v3.47. With
  // per-tool lanes it is a submenu parent (no click); without them it opens
  // Project Context, as before.
  const pulse = m && m.pulse ? m.pulse : null;
  if (pulse && pulse.label) {
    const icon = image(makeIcon, pulse.strip);
    const tools = Array.isArray(pulse.tools) ? pulse.tools.filter((t) => t && t.label) : [];
    const item = {
      id: ID_PULSE,
      label: pulse.label,
      enabled: true,
      ...(icon ? { icon } : {}),
      ...(pulse.toolTip ? { toolTip: pulse.toolTip } : {}),
    };
    if (tools.length) {
      item.submenu = [header(ID_HEADER_PULSE_TOOLS, pulse.toolsHeader || 'Saves by tool')];
      for (const t of tools) {
        const s = image(makeIcon, t.strip);
        item.submenu.push({
          id: t.id,
          label: t.label,
          // Enabled for the strip's sake (a disabled item's icon is greyed);
          // it opens Project Context, where the saves it counts are listed.
          enabled: true,
          click: onOpenMemory,
          ...(s ? { icon: s } : {}),
          ...(t.toolTip && t.toolTip !== t.label ? { toolTip: t.toolTip } : {}),
        });
      }
    } else {
      item.click = onOpenMemory;
    }
    template.push(item);
    template.push(sep);
  }

  // ── 2. Active · last 24 h, the overflow, and the Idle fold ──────────────
  if (!empty) {
    template.push(header(ID_HEADER_ACTIVE, (active && active.header) || 'Active'));
    const rows = active ? active.rows : [];
    for (const row of rows) template.push(primary(row));
    if (!rows.length) {
      // A MEASURED nothing: projects exist, none saved in 24 hours. Said,
      // rather than an empty header over the Idle row.
      template.push({ id: ID_NO_ACTIVE, label: (active && active.emptyLabel) || 'No saves in the last 24 h', enabled: false });
    }
    if (overflow) {
      template.push({
        id: overflow.id || ID_OVERFLOW,
        label: overflow.label,
        submenu: overflow.rows.map(primary),
      });
    }
    // ── 3. Notices — only when true, DIRECTLY UNDER THE ACTIVE ROWS ───────
    //
    // They were below the domains, greyed and clipped, where the maintainer's
    // own photograph showed a collision said twice and missed both times.
    // They are about the work above them, so they sit under it, set off by a
    // separator on each side. A notice that names a PROJECT (a collision)
    // is ENABLED and opens that project in Project Context; the rest are
    // statements and stay disabled.
    if (notices.length) {
      pushNotices();
      if (idle && idle.rows.length) template.push(sep);
    }
    if (idle && idle.rows.length) {
      const dot = image(makeIcon, idle.dot);
      const sub = idle.rows.map(primary);
      if (idle.moreLabel) {
        // ENABLED: the only route to the projects the cap hid.
        sub.push({ id: ID_IDLE_MORE, label: idle.moreLabel, click: onOpenMemory });
      }
      template.push({
        id: idle.id || ID_IDLE,
        label: idle.label,
        ...(idle.sublabel ? { sublabel: idle.sublabel } : {}),
        ...(dot ? { icon: dot } : {}),
        ...(idle.toolTip ? { toolTip: idle.toolTip } : {}),
        submenu: sub,
      });
    }
  } else {
    template.push(header(ID_HEADER_ROWS, HEADER_ROWS));
    template.push({ id: ID_EMPTY, label: EMPTY_LABEL, enabled: false });
    template.push({
      label: (m && m.ok === false) ? UNREADABLE_HINT : EMPTY_HINT,
      enabled: false,
    });
    // A failed read's own reason is a notice, and an empty menu still says it.
    if (notices.length) pushNotices();
  }
  function pushNotices() {
    template.push(sep);
    for (const n of notices) {
      // NOTHING A BUDGET REMOVED BECOMES UNREACHABLE: a clipped notice
      // carries its whole sentence on the tooltip; one that fits, none.
      const full = n.full && n.full !== n.text ? { toolTip: n.full } : {};
      if (n.kind === 'collision' && n.route) {
        template.push({ id: 'tray-notice-' + n.route + ':' + n.scope, label: n.text, enabled: true,
          click: () => onOpenScope(n), ...full });
      } else {
        template.push({ label: n.text, enabled: false, ...full });
      }
    }
    if (m && m.noticesHidden > 0) {
      template.push({ label: '…and ' + m.noticesHidden + ' more', enabled: false });
    }
  }

  // ── 4. Knowledge · N domains ────────────────────────────────────────────
  //
  // Every domain's pages against the largest domain's, in the domain's
  // identity colour (design rule 5), unchanged — only folded into one row,
  // which gives the one surface with no vertical space five lines back. The
  // rows are ENABLED so their bars are drawn at full colour; a click opens
  // Settings, where the Vault folder monitor lists every domain against the
  // same denominator (the app twin).
  const domains = m && m.domains && Array.isArray(m.domains.rows) && m.domains.rows.length
    ? m.domains : null;
  if (domains) {
    const sub = [header(ID_HEADER_DOMAINS, domains.header || 'Domains')];
    for (const d of domains.rows) {
      const icon = image(makeIcon, d.bar);
      sub.push({
        id: d.id,
        label: d.label,
        enabled: true,
        click: onOpenSettings,
        ...(icon ? { icon } : {}),
        ...(d.toolTip ? { toolTip: d.toolTip } : {}),
      });
    }
    template.push(sep);
    template.push({
      id: domains.id || ID_KNOWLEDGE,
      label: domains.label || 'Knowledge',
      ...(domains.toolTip ? { toolTip: domains.toolTip } : {}),
      submenu: sub,
    });
  }

  // ── 5. The commands ─────────────────────────────────────────────────────
  //
  // "Open The Curator" is always present and "Quit" is always last, whatever
  // the state above them: there is no arrangement of data in which the menu
  // stops offering a way back to the app or a way to quit it.
  template.push(sep);
  template.push({ id: ID_OPEN_MEMORY, label: 'Open Project Context…', click: onOpenMemory });
  template.push({ id: ID_OPEN_APP, label: 'Open ' + appName, click: onOpenApp });
  template.push({ id: ID_SETTINGS, label: 'Settings…', click: onOpenSettings });

  // ── 6. How fresh this reading is ────────────────────────────────────────
  //
  // ABSOLUTE, and distinct from the rows' RELATIVE ages: how old is this
  // event, versus how old is this reading. v3.72.1 (F7): the time the figures
  // were READ (`readAtText`), not the time of this render.
  const stampText = m && (m.readAtText || m.renderedAtText);
  if (stampText) {
    template.push(sep);
    template.push({ id: ID_UPDATED_STAMP, label: 'Updated ' + stampText, enabled: false });
  }

  // ── 7. Quit ─────────────────────────────────────────────────────────────
  template.push(sep);
  template.push({ id: ID_QUIT, role: 'quit', label: 'Quit ' + appName });

  return template;
}

/**
 * The menu as TEXT — a static render, for review and for the suites.
 *
 * Electron is not an offline dependency, so no suite can draw the menu. This
 * prints the TEMPLATE — the exact data `Menu.buildFromTemplate` receives —
 * one item per line: submenus indented, headers as `── Header ──`, disabled
 * items in parentheses, a sublabel on the line below, the gutter picture in
 * the margin (a freshness dot with its tier named at the end of the line,
 * `▂▅▇` a pulse strip, `▬` a depth bar), a submenu parent marked `›`. Pass a `makeIcon` of `(spec) => spec` when
 * building the template so the pictures reach this function as specs.
 */
export function renderTrayMenuText(template, depth = 0) {
  const pad = '      '.repeat(depth);
  const lines = [];
  const mark = (icon) => {
    if (!icon || typeof icon !== 'object') return '   ';
    if (icon.kind === 'dot') return ({ live: '◉', recent: '●', today: '◐', week: '◑', dormant: '○', unknown: '◌' }[icon.tier] || '•') + '  ';
    if (Object.prototype.hasOwnProperty.call(icon, 'frac')) return '▬  ';
    if (icon.heightPoints === 15) return '▂▅▇';
    return '▫  ';
  };
  for (const item of template || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'separator') { lines.push(pad + '────────────'); continue; }
    if (item.type === MENU_HEADER_TYPE) { lines.push(pad + '── ' + String(item.label || '') + ' ──'); continue; }
    const icon = mark(item.icon);
    const tier = item.icon && item.icon.kind === 'dot' ? '   [' + item.icon.tier + ']' : '';
    const label = item.role === 'quit' ? (item.label || 'Quit') + '   ⌘Q' : (item.label || item.role || '');
    const body = item.enabled === false ? '(' + label + ')' : label;
    lines.push(pad + icon + ' ' + body + (Array.isArray(item.submenu) ? '  ›' : '') + tier);
    if (item.sublabel) lines.push(pad + '    ' + item.sublabel);
    if (Array.isArray(item.submenu)) lines.push(renderTrayMenuText(item.submenu, depth + 1));
  }
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * Walk a template and yield every item, flattened, with its path.
 *
 * Copied from lib/menu.js rather than imported, deliberately: that file is
 * another feature's and a shared helper is a shared blast radius. It is small,
 * and the suite carries its own positive control that the walker recurses.
 */
export function flattenTrayMenu(template, trail = []) {
  const out = [];
  for (const item of template || []) {
    if (!item || typeof item !== 'object') continue;
    const label = item.label || item.role || item.type || '(unnamed)';
    const path = [...trail, label];
    out.push({ ...item, path: path.join(' › ') });
    if (Array.isArray(item.submenu)) out.push(...flattenTrayMenu(item.submenu, path));
  }
  return out;
}

/**
 * The icon's own tooltip — what hovering the glyph says before anything is
 * clicked. It carries the LAST SAVE (`Last save: ott · Claude Code · 8 min
 * ago`), because a hover is cheaper than a click and, since Layout A removed
 * the menu's headline, this is the one place that answer is one line.
 *
 * It is NOT the tray TITLE (see this file's header for why the title is
 * empty): a tooltip costs no menu bar width and appears only on demand.
 *
 * ── WHY THE STANDING BRIEF IS HERE AND NOT IN THE MENU ─────────────────────
 *
 * The maintainer's stated need is two questions, not one: "I'm always
 * wondering if we have updated the scope, AND if the standing brief is up to
 * date." The first Active row answers the first. The second has a computed
 * answer — `getTraySummary()` pays a `stat` for it on every read — and until
 * now nothing rendered it, so the app was paying for a fact it threw away.
 *
 * The brief is TIER C: it changes on the order of weeks, so it does not earn a
 * menu row, and the rendered panel that would give it one is a later phase.
 * That ranking is not overturned here. What changes is only WHERE a Tier C
 * fact goes, and the tooltip is the one surface in this widget with no
 * scarcity — it costs no menu row, no menu-bar width, and no extra I/O,
 * because the value is already in the model. Tier C means subordinate, and a
 * second clause on a hover is subordinate.
 *
 * It is stated as an AGE and never as a judgement. "Brief · 6 weeks ago" is a
 * measurement; "brief is stale" would be the widget deciding something about
 * the user's own hand-authored document, which is not its business. When there
 * is no brief the clause is simply absent — a project with no standing brief
 * is the ordinary case, not a problem to report in a menu bar.
 */
export function trayToolTip(model, appName = 'The Curator') {
  const headline = model && model.headline ? model.headline : null;
  if (!headline) return appName;
  // `Last save: ott · Claude Code · 8 min ago` — the newest save in the store,
  // worded as what it is (v3.74.0). The scope is not repeated here: the menu
  // one click away names it on the row's submenu header.
  const brief = model && model.brief ? model.brief : null;
  // Only when the age is actually known. The clause is composed by the model
  // (`brief.text`), which also says when an agent wrote the brief.
  const briefPart = brief && brief.text && brief.ageSeconds !== null
    ? ' · ' + brief.text
    : '';
  return appName + ' — ' + headline.text + briefPart;
}
