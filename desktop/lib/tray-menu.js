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
 * ── THE ORDER OF THE MENU IS THE DESIGN ────────────────────────────────────
 *
 *   1  the headline answer          "Last save · 4 min ago"
 *   2  where that save was          "curator · main"
 *   2b the save pulse               a drawn strip + "7 days · 65 saves"
 *   -  separator
 *   3  up to eight rows             newest first, flat, not grouped
 *   -  separator
 *   4  notices, only when true      waiting handoffs; harness collisions
 *   -  separator
 *   5  Open Agent memory…  ·  Open The Curator  ·  Settings…
 *   -  separator
 *   6  "Updated 14:32"              the reading's own freshness
 *   -  separator
 *   7  Quit The Curator
 *
 * The headline is FIRST because it is the question the maintainer actually
 * asks — "am I approaching the end of the context window, and did we update the
 * scope?" — and it must be answerable without reading past the first line.
 *
 * ── WHY THE HEADLINE IS AN ENABLED ITEM AND NOT A DIMMED ONE ───────────────
 *
 * A disabled menu item is drawn at reduced contrast. Putting the one line the
 * whole widget exists for into the least legible style available would be the
 * exact shape of defect this project has already fixed twice in its own CSS
 * (nested opacities compounding to 2.05:1). It is enabled, drawn at full
 * contrast, and clicking it does the obvious thing — opens the app on that
 * project. Items that are genuinely statements rather than actions (the
 * notices, the freshness stamp) ARE disabled, which is the standard menu idiom
 * for a status line and keeps the actionable items distinguishable.
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
 * So the headline answer lives at the TOP OF THE MENU, one click away, at full
 * contrast, beside the absolute stamp that says how fresh the reading is.
 */

/** Item ids, so a caller can address an item without matching on its label.
 *  Labels are user-visible copy and will change; ids are a contract. */
export const ID_HEADLINE = 'tray-headline';
export const ID_HEADLINE_WHERE = 'tray-headline-where';
export const ID_PULSE = 'tray-pulse';
export const ID_OPEN_MEMORY = 'tray-open-memory';
export const ID_OPEN_APP = 'tray-open-app';
export const ID_SETTINGS = 'tray-settings';
export const ID_UPDATED_STAMP = 'tray-updated-stamp';
export const ID_TRUNCATED = 'tray-truncated';
export const ID_EMPTY = 'tray-empty';
export const ID_QUIT = 'tray-quit';

/** The empty state is the first thing a new user sees, and it must not read
 *  like an error. It says what the surface is for and how something gets into
 *  it — nothing else. It is also why the whole feature is off by default: on a
 *  fresh install this is the only thing it can ever show. */
export const EMPTY_LABEL = 'No agent memory yet';
export const EMPTY_HINT = 'A coding agent writes here through the my-curator MCP';

/** Shown instead of the hint when the read itself failed. A failure to READ is
 *  a different sentence from "nothing has been saved", and collapsing the two
 *  would tell a user with a full store that their store is empty. */
export const UNREADABLE_HINT = 'Open The Curator to see what went wrong';

const sep = { type: 'separator' };

/**
 * @param {object} model  a `buildTrayModel()` result.
 * @param {object} o
 * @param {string}   [o.appName]
 * @param {Function} o.onOpenScope   (row) => void   — open the app on that scope
 * @param {Function} o.onOpenMemory  () => void      — open the Agent memory view
 * @param {Function} o.onOpenApp     () => void      — reveal the window
 * @param {Function} o.onOpenSettings () => void
 * @param {Function} [o.makeIcon]  (strip) => NativeImage — the ONE Electron
 *   call the pulse strip needs, injected rather than imported. See the pulse
 *   block below for why it is a parameter and not a build step in main.js.
 * @returns {Array} a `Menu.buildFromTemplate` template
 */
export function buildTrayMenuTemplate(model, o = {}) {
  const {
    appName = 'The Curator',
    onOpenScope, onOpenMemory, onOpenApp, onOpenSettings, makeIcon,
  } = o;

  // Every handler is required. A menu item wired to `undefined` throws at
  // CLICK time — i.e. in front of the user, weeks later — so it is refused
  // here, at build time, where the suite sees it. Same rule as lib/menu.js.
  for (const [name, fn] of Object.entries({
    onOpenScope, onOpenMemory, onOpenApp, onOpenSettings,
  })) {
    if (typeof fn !== 'function') {
      throw new Error(`buildTrayMenuTemplate: ${name} must be a function, got ${typeof fn}`);
    }
  }

  const m = model && typeof model === 'object' ? model : null;
  const rows = m && Array.isArray(m.rows) ? m.rows : [];
  const notices = m && Array.isArray(m.notices) ? m.notices : [];
  const headline = m && m.headline ? m.headline : null;

  const template = [];

  // ── 1 + 2. The headline answer ──────────────────────────────────────────
  template.push({
    id: ID_HEADLINE,
    label: headline ? headline.text : 'Agent memory could not be read',
    // Enabled even in the empty state: it is the route to the screen that
    // explains the emptiness, and a dimmed first line reads as a broken app.
    enabled: true,
    click: onOpenMemory,
  });
  if (headline && headline.where) {
    template.push({
      id: ID_HEADLINE_WHERE,
      label: '    ' + headline.where,
      // A statement about the line above it, not a second action.
      enabled: false,
    });
  }

  // ── 2b. The save pulse ──────────────────────────────────────────────────
  //
  // ONE item, directly under the headline pair it elaborates, carrying a drawn
  // strip in its icon gutter and the reading in words on its label.
  //
  // ── WHY ONE STRIP AND NOT ONE PER ROW ──────────────────────────────────
  //
  // A per-row sparkline was considered and REFUSED on legibility: eight to
  // eleven independent bands, each a few points tall, in a menu that this same
  // release is trying to make NARROWER, and each drawn from a single scope's
  // handful of saves — most would be one mark and a lot of empty. One strip
  // over the whole store is a reading somebody can take at a glance, which is
  // the only thing a menu bar surface is for.
  //
  // ── WHY IT IS DISABLED ─────────────────────────────────────────────────
  //
  // It is a STATEMENT, not an action, and a disabled item is this menu's
  // existing idiom for a status line — the notices and the freshness stamp are
  // both disabled for the same reason. That does mean reduced contrast, which
  // is the right trade HERE and the wrong one for the headline: the headline is
  // the ANSWER and stays enabled at full contrast, and clicking a picture of
  // the last seven days would have no obvious destination anyway.
  //
  // ── WHY `makeIcon` IS INJECTED ─────────────────────────────────────────
  //
  // `nativeImage.createFromBuffer` is an Electron call, and this module must
  // stay importable by `npm test`, where Electron does not exist. Passing it in
  // keeps EVERY decision here — whether there is a strip at all, what it says,
  // where it sits, whether it is actionable — inside a module the suite runs
  // for real, and leaves main.js the two lines it cannot give away. Same split,
  // and the same reason, as lib/menu.js and lib/quit-decision.js.
  //
  // With no `makeIcon` the item still appears with its label and its tooltip
  // and simply carries no picture: a missing image must not cost the reading.
  const pulse = m && m.pulse ? m.pulse : null;
  if (pulse && pulse.label) {
    const icon = typeof makeIcon === 'function' ? makeIcon(pulse.strip) : null;
    template.push({
      id: ID_PULSE,
      label: pulse.label,
      enabled: false,
      ...(icon ? { icon } : {}),
      ...(pulse.toolTip ? { toolTip: pulse.toolTip } : {}),
    });
  }

  // ── 3. The rows ─────────────────────────────────────────────────────────
  //
  // FLAT AND NEWEST FIRST, not grouped by project. The audience is watching an
  // agent, and an agent works in one scope at a time — "what has just
  // happened" is a recency question. Grouping answers a different one, spends
  // the one surface with no vertical space on headings, and the app's own
  // Agent memory view already answers it better. The project survives as a
  // prefix on every row, so nothing is lost but the ordering.
  //
  // The cost, stated rather than mitigated: one busy project can monopolise
  // all eight rows. A per-project quota inside an eight-row list is the kind of
  // cleverness that produces two behaviours and one bug, and the overflow item
  // below reaches everything.
  if (rows.length) {
    template.push(sep);
    for (const row of rows) {
      template.push({
        id: row.id,
        label: row.label,
        // macOS draws `sublabel` as a dimmer second line. A platform that does
        // not simply drops it, which is exactly why every fact a person needs
        // is on the LABEL and the sublabel carries only the agent's own prose.
        ...(row.sublabel ? { sublabel: row.sublabel } : {}),
        ...(row.toolTip ? { toolTip: row.toolTip } : {}),
        click: () => onOpenScope(row),
      });
    }
    if (m.truncatedNote) {
      template.push({ id: ID_TRUNCATED, label: m.truncatedNote, enabled: false });
    }
  } else {
    template.push(sep);
    template.push({ id: ID_EMPTY, label: EMPTY_LABEL, enabled: false });
    template.push({
      label: (m && m.ok === false) ? UNREADABLE_HINT : EMPTY_HINT,
      enabled: false,
    });
  }

  // ── 4. Notices — only when they have something to say ───────────────────
  if (notices.length) {
    template.push(sep);
    for (const n of notices) {
      template.push({ label: n.text, enabled: false });
    }
    if (m.noticesHidden > 0) {
      template.push({ label: '…and ' + m.noticesHidden + ' more', enabled: false });
    }
  }

  // ── 5. The commands ─────────────────────────────────────────────────────
  //
  // "Open The Curator" is always present and "Quit" is always last, whatever
  // the state above them. That is what makes the tray safe to opt into: there
  // is no arrangement of data in which the menu stops offering a way back to
  // the app or a way to quit it.
  template.push(sep);
  template.push({ id: ID_OPEN_MEMORY, label: 'Open Agent Memory…', click: onOpenMemory });
  template.push({ id: ID_OPEN_APP, label: 'Open ' + appName, click: onOpenApp });
  template.push({ id: ID_SETTINGS, label: 'Settings…', click: onOpenSettings });

  // ── 6. How fresh this reading is ────────────────────────────────────────
  //
  // ABSOLUTE, and distinct from the rows' RELATIVE ages: they answer different
  // questions — how old is this event, versus how old is this reading — and
  // conflating them is how a widget comes to display a confidently stale list.
  // It also makes a silently-dead filesystem watch visible rather than
  // invisible, which is the one failure this design cannot otherwise detect.
  if (m && m.renderedAtText) {
    template.push(sep);
    template.push({ id: ID_UPDATED_STAMP, label: 'Updated ' + m.renderedAtText, enabled: false });
  }

  // ── 7. Quit ─────────────────────────────────────────────────────────────
  template.push(sep);
  template.push({ id: ID_QUIT, role: 'quit', label: 'Quit ' + appName });

  return template;
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
 * clicked. It carries the headline, because a hover is cheaper than a click
 * and this is the one place the answer can arrive without one.
 *
 * It is NOT the tray TITLE (see this file's header for why the title is
 * empty): a tooltip costs no menu bar width and appears only on demand.
 *
 * ── WHY THE STANDING BRIEF IS HERE AND NOT IN THE MENU ─────────────────────
 *
 * The maintainer's stated need is two questions, not one: "I'm always
 * wondering if we have updated the scope, AND if the standing brief is up to
 * date." The menu's first line answers the first. The second has a computed
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
  const where = headline.where ? ' (' + headline.where + ')' : '';
  const brief = model && model.brief ? model.brief : null;
  // Only when the age is actually known. A brief whose age could not be
  // derived contributes nothing rather than "Brief · time unknown", which
  // would spend the clause to say we do not know something nobody asked.
  const briefPart = brief && brief.ageText && brief.ageSeconds !== null
    ? ' · Brief · ' + brief.ageText
    : '';
  return appName + ' — ' + headline.text + where + briefPart;
}
