// shared/sidebar-drawer.js — the contextual sidebar as a DRAWER on narrow
// windows (v3.76.0).
//
// Below 800px shell.css takes #sidebar out of the grid and positions it over
// the main column (the RESPONSIVE SHELL block at the end of shell.css). This
// module owns the one piece of state that mode needs — open or closed, as
// `sidebar-open` on <body> — and every way in and out of it:
//
//   in   the rail's "Sidebar" button (aria-expanded / aria-controls="sidebar")
//   out  the same button · Escape · a click on the scrim beside the drawer ·
//        choosing something in the drawer (a sidebar row or its primary
//        button — the choice shows up in the main column, which the drawer
//        is covering) · the window widening out of drawer mode
//
// Nothing here renders the sidebar or knows what any view puts in it: the
// drawer is the SAME #sidebar element with the same content, so the one
// sidebar component stays one. Above 800px the class is inert (every rule
// that reads it is inside the media query) and the toggle is display:none.
//
// DOM access goes through the `env` argument so scripts/test-next-sidebar-
// drawer.js can drive the real functions against a recording fake.

export const DRAWER_OPEN_CLASS = 'sidebar-open';
/** Must match the drawer band in shell.css — the suite asserts the pair. */
export const DRAWER_MEDIA = '(max-width: 799px)';

/**
 * Does a click on `target` (inside the sidebar) choose something, so the
 * drawer should get out of the way? A ROW or the sidebar's PRIMARY button
 * does. A row's own trash or checkbox, a row in Chat's Select mode (a click
 * there ticks a box, it does not open anything), a filter field, a listbox
 * trigger — none of those do.
 */
export function isChoosingClick(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('.row-act, input, select, textarea, .row-select-mode')) return false;
  return !!target.closest('.cur-sb-row, .btn-primary');
}

/**
 * Wire the drawer. Returns { isOpen, setOpen, bindToggle } — bindToggle is
 * called again whenever the rail is re-rendered (renderRail replaces its
 * innerHTML, and the toggle with it).
 *
 * @param {{ document: Document, window: Window, sidebar: HTMLElement,
 *           scrim: HTMLElement|null, main: HTMLElement|null }} env
 */
export function createSidebarDrawer(env) {
  const doc = env.document;
  const win = env.window;
  const mq = win && typeof win.matchMedia === 'function' ? win.matchMedia(DRAWER_MEDIA) : null;
  let toggle = null;
  let open = false;

  const inDrawerMode = () => !!(mq && mq.matches);

  function paintToggle() {
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const label = open ? 'Hide sidebar' : 'Show sidebar';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
  }

  /**
   * @param {boolean} next
   * @param {{ focus?: 'drawer'|'toggle'|'main'|null }} [opts]
   */
  function setOpen(next, opts) {
    open = !!next && inDrawerMode();
    doc.body.classList.toggle(DRAWER_OPEN_CLASS, open);
    paintToggle();
    const focus = opts && opts.focus;
    if (focus === 'drawer' && open) {
      const first = env.sidebar.querySelector(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
      if (first && typeof first.focus === 'function') first.focus();
    } else if (focus === 'toggle' && toggle) {
      toggle.focus();
    } else if (focus === 'main' && env.main && typeof env.main.focus === 'function') {
      env.main.focus({ preventScroll: true });
    }
  }

  function bindToggle(el) {
    toggle = el || null;
    if (!toggle) return;
    toggle.setAttribute('aria-controls', 'sidebar');
    paintToggle();
    toggle.addEventListener('click', () => setOpen(!open, { focus: open ? null : 'drawer' }));
  }

  // Escape closes the drawer — and ONLY the drawer. It is the top layer
  // below the menus and dialogs, so:
  //   · an open popup (a listbox — Chat's domain filter lives IN the
  //     drawer) or a confirm dialog owns the Escape. This listener runs in
  //     the capture phase, BEFORE theirs, so it cannot wait for their
  //     preventDefault; it yields on their open state instead — an expanded
  //     [aria-haspopup] trigger, or an aria-modal surface;
  //   · the page reader (z 40) sits UNDER the drawer (z 45), so one Escape
  //     must close the drawer and leave the reader. Capture phase plus
  //     stopPropagation keeps app.js's bubbling reader handler from also
  //     firing; the reader panel's own aria-modal is not a reason to yield.
  doc.addEventListener('keydown', (e) => {
    if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
    if (doc.querySelector('[aria-haspopup][aria-expanded="true"], [aria-modal="true"]:not(.reader-panel)')) return;
    e.stopPropagation();
    setOpen(false, { focus: 'toggle' });
  }, true);

  if (env.scrim) env.scrim.addEventListener('click', () => setOpen(false));

  env.sidebar.addEventListener('click', (e) => {
    if (!open) return;
    if (isChoosingClick(e.target)) setOpen(false, { focus: 'main' });
  });

  // Widening out of drawer mode drops the state, so narrowing again later
  // starts closed rather than reopening a drawer nobody asked for.
  if (mq) {
    const onChange = () => { if (!mq.matches && open) setOpen(false); else paintToggle(); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
  }

  return { isOpen: () => open, setOpen, bindToggle };
}
