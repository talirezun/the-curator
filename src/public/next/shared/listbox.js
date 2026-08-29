// shared/listbox.js — the /next tree's ONE replacement for the OS-native
// <select> menu.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// `appearance: none` + a CSS-drawn chevron gets the CLOSED control on-design.
// It does nothing for the OPEN one: the popup a native <select> paints is an
// OS-level surface, outside the document, and no stylesheet in this repo can
// reach it. Three view stylesheets said exactly that in a comment and left it
// there, which was honest and still left six controls dropping out of the
// design system the moment a user clicked one.
//
// The only way to own the open menu is to stop using the native popup. That
// means giving up, and owing back, everything the platform control did for
// free — which is the whole substance of this file, and the reason it is one
// component rather than six hand-rolled menus:
//
//   • Keyboard: Up/Down/PageUp/PageDown/Home/End, Enter to commit, Escape to
//     cancel AND restore, Tab to leave without committing, and TYPE-AHEAD.
//   • Screen readers: the APG "select-only combobox" pattern — a `combobox`
//     trigger that keeps focus, `aria-expanded`, `aria-controls`,
//     `aria-activedescendant`, and a `listbox` of `option`s with
//     `aria-selected`.
//   • A real disabled state. A `<button disabled>` cannot be clicked or
//     focused; it is not a CSS lookalike that still fires handlers.
//
// ── WHY THE MENU IS APPENDED TO <body> ───────────────────────────────────
//
// Two independently sufficient reasons, and one trap it is avoiding.
//
//   1. CLIPPING. `.main` is `overflow-y: auto`, Settings scrolls inside its
//      own panes, and the composer sits in a flex column. An in-flow
//      `position: absolute` menu is clipped by the first scrolling ancestor,
//      and a 193-row model list is taller than most of them.
//
//   2. THE TRANSFORM TRAP, which is the reason this is `position: fixed` on
//      BODY and not `position: fixed` in place. A CSS `transform` makes an
//      element the containing block for every `position: fixed` DESCENDANT.
//      shell.css carries that warning already, and v3.10.0 measured a fixed
//      probe moving 340px because of it. `#view-root` is transformed on every
//      navigation by the view-enter animation (`translateX(8px)`), so a fixed
//      menu rendered inside a view would be mispositioned for the duration of
//      that animation. <body> is never transformed. This is the same reason
//      every other fixed surface in /next (confirm, onboarding, both wizards,
//      the cutover bar) is `document.body.appendChild`ed.
//
// The cost of leaving the view's subtree is that an `innerHTML` repaint of the
// view — which settings.js does wholesale on every render — no longer removes
// the menu. A menu that survived one would be a detached-trigger orphan with
// live document listeners: the exact leak this repo keeps re-shipping. So the
// open menu runs a `requestAnimationFrame` loop (ONLY while open) that
// closes it the moment `document.contains(trigger)` goes false, and
// repositions it whenever the trigger's rect moves. One loop covers scroll,
// resize, layout shift and detachment; there is no second mechanism to forget.
//
// ── NOT ENFORCED (stated rather than implied away) ───────────────────────
//
//   • Type-ahead matches on an option's `typeahead` text (its label by
//     default), NOT on any detail/price/note text also shown in the row.
//   • Only ONE listbox is open at a time, process-wide. Opening a second
//     closes the first. That matches the native control and is what the
//     single-`openInstance` module variable enforces.
//   • This does not implement multi-select, option groups as *focusable*
//     rows, or `optgroup`-style keyboard skipping. Group headings are inert
//     text and are skipped by arrow navigation because they are not
//     `[role="option"]`.
//   • A caller that renders the trigger markup and never calls
//     `mountListbox` gets an inert button. `renderListboxHtml` and
//     `mountListbox` are deliberately given the SAME cfg object by every
//     call site so the two cannot describe different controls.

import { icon, escapeHtml } from '../app.js';

// ── Module state ─────────────────────────────────────────────────────────
// One open menu at a time, process-wide. Native <select> behaves this way and
// two open menus is never a state a user asked for.
let openInstance = null;
let uid = 0;

// How long a type-ahead buffer survives without a keystroke. 800ms is what
// Windows/macOS list controls use; long enough to type "busi", short enough
// that walking away and coming back starts a fresh search.
const TYPEAHEAD_MS = 800;

/**
 * Close whatever is open. Called from every adopting view's teardown, so a
 * rail navigation can never leave a menu behind — navigate() closes the
 * reader itself but explicitly does NOT reach into view-owned popovers (see
 * its comment), so each view owes this call.
 */
export function closeAllListboxes() {
  if (openInstance) openInstance.close({ focusTrigger: false });
}

/** True when a menu is open. Exported for tests and for busy-state gating. */
export function isListboxOpen() {
  return openInstance !== null;
}

// ── Option normalisation ─────────────────────────────────────────────────

/**
 * Accepts the shorthand every adopting view actually has to hand — a list of
 * `{ value, label }` — and fills in the rest. `typeahead` defaults to the
 * label because that is the text the user can see and is therefore the text
 * they will type at.
 */
function normaliseOptions(options, actionValues) {
  // ── AN ACTION ROW MUST BE DECLARED TWICE, AND THE SECOND ONE IS THE cfg ──
  // `action: true` on an option is a REQUEST, not a grant: it takes effect only
  // for a value the control's cfg also names in `actionValues`.
  //
  // Why the second gate exists, MEASURED not anticipated: adding `action: true`
  // to Ingest's real domain-picker options turned every domain row into an
  // action row — selecting a domain fired `onChange` and never became the
  // control's value — and THREE suites stayed green over it. With this gate the
  // same edit is inert, because `ingest.js` declares no `actionValues`, so the
  // defect is not merely detectable, it is inexpressible on the seven controls
  // that have no action row at all. On the one that does (the composer's model
  // menu) the allow-list is a single sentinel, so marking a MODEL as an action
  // is inert too.
  //
  // Absent/garbage `actionValues` yields an EMPTY allow-list, which is the
  // fail-safe direction: a caller that cannot say which row is an action gets
  // ordinary rows, never a menu whose every row silently declines to be chosen.
  const allowed = actionValues instanceof Set
    ? actionValues
    : new Set(Array.isArray(actionValues) ? actionValues.filter((v) => typeof v === 'string') : []);
  const out = [];
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (!o || typeof o !== 'object') continue;
    const value = typeof o.value === 'string' ? o.value : String(o.value == null ? '' : o.value);
    const label = typeof o.label === 'string' ? o.label : value;
    out.push({
      value,
      label,
      detail: typeof o.detail === 'string' ? o.detail : '',
      group: typeof o.group === 'string' ? o.group : '',
      disabled: o.disabled === true,
      // ── AN OPTION THAT DOES SOMETHING RATHER THAN SELECTING SOMETHING ────
      // `action: true` marks a row that runs the caller's handler and closes,
      // WITHOUT becoming the control's value or relabelling the trigger. The
      // composer's model menu needs exactly one: "Browse all 213 models…",
      // which opens a search dialog.
      //
      // Why this is a first-class flag rather than something the handler
      // papers over: without it, `commit()` writes the sentinel into
      // `state.value` and stamps "Browse all 213 models…" onto the trigger,
      // and the caller's only recovery is to re-render the whole control
      // afterwards to undo a label it never wanted. That leaves the picker
      // briefly claiming a model that does not exist — on the surface whose
      // entire job is naming the model that will answer.
      //
      // It cannot affect the seven adoptions that declare no `actionValues`:
      // every option there takes the identical `action === false` path, whatever
      // its own flag says. scripts/test-next-listbox.js §8 drives both branches,
      // and the "commits normally without it" half is the regression guard.
      action: o.action === true && allowed.has(value),
      // `html` lets a caller own the whole row body (badges, prices, notes)
      // while this file still owns the row ELEMENT and therefore all of the
      // keyboard and ARIA behaviour. That split is what lets the composer's
      // rich model rows and Ingest's plain domain rows be one component.
      html: typeof o.html === 'string' ? o.html : null,
      typeahead: typeof o.typeahead === 'string' ? o.typeahead : label,
    });
  }
  return out;
}

function findOption(options, value) {
  for (const o of options) if (o.value === value) return o;
  return null;
}

/** The text the closed trigger shows. */
function triggerLabelFor(cfg, options) {
  if (typeof cfg.triggerText === 'string') return cfg.triggerText;
  const sel = findOption(options, cfg.value);
  if (sel) return sel.label;
  return typeof cfg.placeholder === 'string' ? cfg.placeholder : 'Select…';
}

// ── Markup ───────────────────────────────────────────────────────────────

/**
 * The CLOSED control only. The menu does not exist until the control is
 * opened, and when it does it is created on <body> — so a view's render
 * string never contains it and a view's repaint never has to clean it up.
 *
 * Call this and `mountListbox` with the SAME cfg object. Building two cfg
 * literals is the two-hand-maintained-copies shape this repo keeps paying
 * for; one `const cfg = {...}` used twice cannot drift.
 */
export function renderListboxHtml(cfg) {
  const options = normaliseOptions(cfg.options, cfg.actionValues);
  const id = String(cfg.id);
  const disabled = cfg.disabled === true;
  const label = triggerLabelFor(cfg, options);
  const isPlaceholder = !findOption(options, cfg.value);
  const cls = ['lb-btn'];
  if (cfg.triggerClass) cls.push(String(cfg.triggerClass));
  if (cfg.mono === true) cls.push('mono');
  if (isPlaceholder) cls.push('is-placeholder');

  // The ROOT's class is separate from the trigger's, and that is not
  // tidiness: `.lb` is inline-flex so it shrinks to its content, and a
  // full-width FIELD control needs the block behaviour on the root — putting
  // `width: 100%` on the trigger inside a shrink-wrapped root measured 51px
  // wide in a browser. Expressed as an explicit class rather than a
  // `:has(> .lb-field)` rule, because settings.css already records the house
  // position that `:has()` is acceptable for cosmetics and not for layout.
  const rootCls = 'lb' + (cfg.rootClass ? ' ' + String(cfg.rootClass) : '');

  return (
    '<span class="' + escapeHtml(rootCls) + '" data-lb-root="' + escapeHtml(id) + '">' +
      '<button type="button" class="' + escapeHtml(cls.join(' ')) + '"' +
        ' id="' + escapeHtml(id) + '"' +
        ' data-lb-trigger="' + escapeHtml(id) + '"' +
        ' role="combobox" aria-haspopup="listbox" aria-expanded="false"' +
        ' aria-controls="' + escapeHtml(id) + '-menu"' +
        (cfg.ariaLabel ? ' aria-label="' + escapeHtml(cfg.ariaLabel) + '"' : '') +
        (disabled ? ' disabled' : '') + '>' +
        '<span class="lb-btn-text" data-lb-text>' + escapeHtml(label) + '</span>' +
        '<span class="lb-chevron" aria-hidden="true">' + icon('chevronDown', 12) + '</span>' +
      '</button>' +
    '</span>'
  );
}

function optionRowHtml(id, opt, index, selectedValue) {
  const selected = opt.value === selectedValue;
  const cls = ['lb-opt'];
  if (selected) cls.push('is-selected');
  if (opt.disabled) cls.push('is-disabled');
  // Marked in the MARKUP, not only in the JS, so a caller can style an action
  // row apart from the models beside it without a `:has()` on its own body
  // content — settings.css records the house position that `:has()` is for
  // cosmetics and not for layout, and a rule that adds a border and padding is
  // layout. It is an attribute rather than a class so it cannot collide with a
  // caller's own class names.
  if (opt.action) cls.push('is-action');
  return (
    '<div class="' + escapeHtml(cls.join(' ')) + '"' +
      ' id="' + escapeHtml(id) + '-opt-' + index + '"' +
      ' role="option"' +
      (opt.action ? ' data-lb-action="1"' : '') +
      ' aria-selected="' + (selected ? 'true' : 'false') + '"' +
      (opt.disabled ? ' aria-disabled="true"' : '') +
      ' data-lb-value="' + escapeHtml(opt.value) + '">' +
      (opt.html !== null
        ? opt.html
        : '<span class="lb-opt-label">' + escapeHtml(opt.label) + '</span>' +
          (opt.detail ? '<span class="lb-opt-detail mono">' + escapeHtml(opt.detail) + '</span>' : '')) +
      '<span class="lb-opt-check" aria-hidden="true">' + (selected ? icon('check', 13) : '') + '</span>' +
    '</div>'
  );
}

function menuHtml(id, options, selectedValue, footHtml) {
  let html = '';
  let lastGroup = null;
  options.forEach((opt, i) => {
    if (opt.group && opt.group !== lastGroup) {
      html += '<div class="lb-group">' + escapeHtml(opt.group) + '</div>';
      lastGroup = opt.group;
    }
    html += optionRowHtml(id, opt, i, selectedValue);
  });
  if (footHtml) html += '<div class="lb-foot">' + footHtml + '</div>';
  return html;
}

// ── The instance ─────────────────────────────────────────────────────────

/**
 * Hydrate the trigger `renderListboxHtml(cfg)` produced. Returns an instance,
 * or null when the trigger is not in the document (a view that rendered a
 * different branch this pass — an expected, silent no-op, not an error).
 */
export function mountListbox(cfg) {
  const id = String(cfg.id);
  const trigger = document.getElementById(id);
  if (!trigger || trigger.dataset.lbTrigger !== id) return null;

  // Idempotent. Views re-render and re-wire freely; hydrating twice must not
  // stack a second set of listeners on the same button. The element is
  // replaced by innerHTML on a real repaint, so a fresh element hydrates
  // normally — this only catches a double-wire within one paint.
  if (trigger.dataset.lbWired === '1') return null;
  trigger.dataset.lbWired = '1';

  const options = normaliseOptions(cfg.options, cfg.actionValues);
  const state = {
    id,
    trigger,
    cfg,
    options,
    value: cfg.value,
    menu: null,
    active: -1,
    raf: 0,
    lastRect: '',
    typeBuf: '',
    typeAt: 0,
    instanceId: ++uid,
  };

  function enabledIndexes() {
    const out = [];
    state.options.forEach((o, i) => { if (!o.disabled) out.push(i); });
    return out;
  }

  function setActive(i, { scroll = true } = {}) {
    if (!state.menu) return;
    const prev = state.menu.querySelector('.lb-opt.is-active');
    if (prev) prev.classList.remove('is-active');
    state.active = i;
    if (i < 0) { state.trigger.removeAttribute('aria-activedescendant'); return; }
    const el = state.menu.querySelector('#' + CSS.escape(id + '-opt-' + i));
    if (!el) { state.trigger.removeAttribute('aria-activedescendant'); return; }
    el.classList.add('is-active');
    state.trigger.setAttribute('aria-activedescendant', el.id);
    if (scroll) scrollRowIntoView(el);
  }

  /**
   * Bring the active row into view, ARITHMETICALLY.
   *
   * NOT `scrollIntoView({block:'nearest'})`, and the reason was MEASURED: at
   * open() time the menu has just been appended and had its max-height set,
   * and on a 193-row list scrollIntoView did nothing — the menu opened with
   * the selected row 6,514px above the fold, which is exactly the "loses your
   * place" failure that opening on the selection exists to prevent. The same
   * call works perfectly a tick later (verified: it moved scrollTop 0 ->
   * 6,174), so it is a layout-timing dependency, not a broken API. `offsetTop`
   * forces a synchronous layout read and gives an exact answer whenever it is
   * called.
   *
   * `offsetParent` is the menu itself (it is `position: fixed`), so offsetTop
   * is already menu-relative — verified in a browser rather than assumed.
   */
  function scrollRowIntoView(el) {
    const menu = state.menu;
    if (!menu) return;
    const PAD = 4;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < menu.scrollTop + PAD) menu.scrollTop = Math.max(0, top - PAD);
    else if (bottom > menu.scrollTop + menu.clientHeight - PAD) {
      menu.scrollTop = bottom - menu.clientHeight + PAD;
    }
  }

  function position() {
    if (!state.menu) return;
    const r = state.trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const GAP = 6;
    const EDGE = 8;

    // Measure the menu's natural height with the cap lifted, so the flip
    // decision is made against what the menu WANTS rather than against a cap
    // computed from the side we have not chosen yet.
    //
    // LIFTING THE CAP RESETS scrollTop, and that cost a real defect: the rAF
    // loop calls this again on the frame after open(), so a menu that had
    // correctly scrolled to the selected row snapped back to the top — on a
    // 193-row list, measured, every single time. The saved offset is restored
    // below. Reading scrollTop first is also what forces the layout flush the
    // measurement needs.
    const keepScroll = state.menu.scrollTop;
    state.menu.style.maxHeight = 'none';
    const natural = state.menu.scrollHeight;

    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    // Prefer down unless it genuinely does not fit AND up is roomier. A
    // caller may state a preference (the composer sits at the bottom of the
    // viewport and has always opened upward), which wins whenever that side
    // can hold the menu at all.
    const wantUp = cfg.prefer === 'up';
    const up = (wantUp && above >= Math.min(natural, 160)) || (natural > below && above > below);

    const space = up ? above : below;
    state.menu.style.maxHeight = Math.max(120, Math.floor(space)) + 'px';

    const width = Math.max(r.width, Number(cfg.minWidth) || 0);
    state.menu.style.minWidth = width + 'px';
    const mw = Math.min(state.menu.offsetWidth || width, vw - EDGE * 2);
    let left = r.left;
    if (left + mw > vw - EDGE) left = vw - EDGE - mw;
    if (left < EDGE) left = EDGE;

    state.menu.style.left = Math.round(left) + 'px';
    if (up) {
      state.menu.style.top = 'auto';
      state.menu.style.bottom = Math.round(vh - r.top + GAP) + 'px';
    } else {
      state.menu.style.bottom = 'auto';
      state.menu.style.top = Math.round(r.bottom + GAP) + 'px';
    }
    state.menu.dataset.lbSide = up ? 'up' : 'down';
    state.menu.scrollTop = keepScroll;
  }

  // The ONE loop. Runs only while open. Closes on detachment (a view repaint
  // removed the trigger out from under us) and repositions whenever the
  // trigger has moved (scroll, resize, layout shift, a sibling growing).
  function tick() {
    if (!state.menu) return;
    if (!document.contains(state.trigger)) { close({ focusTrigger: false }); return; }
    const r = state.trigger.getBoundingClientRect();
    const sig = r.top + ':' + r.left + ':' + r.width + ':' + r.height;
    if (sig !== state.lastRect) { state.lastRect = sig; position(); }
    state.raf = requestAnimationFrame(tick);
  }

  function open() {
    if (state.menu) return;
    if (state.trigger.disabled) return;
    if (openInstance && openInstance !== api) openInstance.close({ focusTrigger: false });

    const menu = document.createElement('div');
    menu.className = 'lb-menu' + (cfg.menuClass ? ' ' + cfg.menuClass : '');
    menu.id = id + '-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    if (cfg.ariaLabel) menu.setAttribute('aria-label', String(cfg.ariaLabel));
    menu.innerHTML = menuHtml(id, state.options, state.value, cfg.footHtml || '');
    document.body.appendChild(menu);
    state.menu = menu;

    state.trigger.setAttribute('aria-expanded', 'true');
    state.trigger.classList.add('is-open');

    // POSITION BEFORE setActive, and the order is load-bearing. setActive
    // scrolls the active row into view, and until the menu has been sized and
    // placed there is nothing to scroll WITHIN — measured on a 193-row list:
    // with these two the other way round the menu opened with the selected
    // row off-screen, which is precisely the "loses your place" failure the
    // open-on-selection rule below exists to prevent.
    position();

    // Open ON the current value, the way a native menulist does — not on the
    // first row. Landing on row 1 of a 193-row model list loses the user's
    // place every single time they glance at the menu.
    const cur = state.options.findIndex(o => o.value === state.value && !o.disabled);
    const first = enabledIndexes()[0];
    setActive(cur >= 0 ? cur : (first === undefined ? -1 : first));

    menu.addEventListener('pointerdown', (e) => {
      // Keep focus on the trigger. Without this the mousedown blurs the
      // button, the blur handler closes the menu, and the click never lands
      // on a row — the classic "the menu closes before my click" defect.
      e.preventDefault();
    });
    menu.addEventListener('click', (e) => {
      const row = e.target.closest('[data-lb-value]');
      if (!row || !state.menu.contains(row)) return;
      if (row.getAttribute('aria-disabled') === 'true') return;
      commit(row.getAttribute('data-lb-value'));
    });
    menu.addEventListener('mousemove', (e) => {
      const row = e.target.closest('[data-lb-value]');
      if (!row || row.getAttribute('aria-disabled') === 'true') return;
      const m = /-opt-(\d+)$/.exec(row.id);
      if (m) setActive(Number(m[1]), { scroll: false });
    });

    state.lastRect = '';
    state.raf = requestAnimationFrame(tick);

    document.addEventListener('pointerdown', onDocPointer, true);
    openInstance = api;
  }

  function close({ focusTrigger = true } = {}) {
    if (!state.menu) return;
    document.removeEventListener('pointerdown', onDocPointer, true);
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    state.menu.remove();
    state.menu = null;
    state.active = -1;
    state.typeBuf = '';
    state.trigger.setAttribute('aria-expanded', 'false');
    state.trigger.removeAttribute('aria-activedescendant');
    state.trigger.classList.remove('is-open');
    if (openInstance === api) openInstance = null;
    // Focus never LEFT the trigger (APG select-only combobox), so this is a
    // restore after a pointer interaction stole it, not a focus move.
    if (focusTrigger && document.contains(state.trigger)) {
      try { state.trigger.focus(); } catch { /* detached mid-teardown */ }
    }
  }

  function onDocPointer(e) {
    if (!state.menu) return;
    if (state.menu.contains(e.target)) return;
    if (state.trigger.contains(e.target)) return;
    close({ focusTrigger: false });
  }

  function commit(value) {
    const opt = findOption(state.options, value);
    if (!opt || opt.disabled) return;
    // An ACTION row (see `action` in normaliseOptions): run the handler, close,
    // and change NOTHING about the control. `state.value` and the trigger text
    // are untouched, so a menu that offers "Browse all…" beside real models
    // cannot end up claiming that a browse is the selected model.
    //
    // Fired after close() for the same reason the ordinary path is: the handler
    // routinely opens a dialog or re-renders the view, and neither should be
    // racing a live menu it does not know about.
    if (opt.action) {
      close();
      if (typeof cfg.onChange === 'function') {
        cfg.onChange(value, opt);
        restoreFocusAfterRerender();
      }
      return;
    }
    const changed = value !== state.value;
    state.value = value;
    const textEl = state.trigger.querySelector('[data-lb-text]');
    if (textEl) textEl.textContent = opt.label;
    state.trigger.classList.remove('is-placeholder');
    close();
    // Fired AFTER the menu is gone, so a handler that re-renders the whole
    // view is not racing a live menu it does not know about.
    if (changed && typeof cfg.onChange === 'function') {
      cfg.onChange(value, opt);
      restoreFocusAfterRerender();
    }
  }

  /**
   * ── FOCUS SURVIVES THE HANDLER'S OWN REPAINT ────────────────────────────
   * MEASURED, not anticipated: committing with Enter left focus on <body>.
   * close() focuses the trigger correctly, and then onChange re-rendered the
   * view via innerHTML, destroying the very element that had just been
   * focused. That is v3.17.1 finding 8 in a new place — a control that works
   * and silently strands the keyboard user who used it.
   *
   * Restored BY ID, because the node itself is gone (the pattern
   * views/onboarding.js established in v3.8.0 and views/memory.js reuses).
   *
   * GATED ON FOCUS HAVING BEEN LOST TO <body>. If the handler deliberately
   * moved focus somewhere else, that is a decision and this must not
   * override it; only the "dropped on the floor" case is repaired. A
   * handler that re-renders synchronously is already done by the time this
   * runs, and one that re-renders after an await is covered by the second
   * attempt on the next frame.
   */
  function restoreFocusAfterRerender() {
    const tryOnce = () => {
      if (typeof document === 'undefined') return;
      if (document.activeElement && document.activeElement !== document.body) return;
      const again = document.getElementById(id);
      if (again) { try { again.focus(); } catch { /* detached again */ } }
    };
    tryOnce();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tryOnce);
  }

  function move(delta) {
    const idx = enabledIndexes();
    if (!idx.length) return;
    const at = idx.indexOf(state.active);
    let next;
    if (at === -1) next = idx[0];
    else next = idx[Math.min(idx.length - 1, Math.max(0, at + delta))];
    setActive(next);
  }

  /**
   * How many rows PageUp / PageDown move, DERIVED from what is on screen rather
   * than a fixed number — the native popup pages by what you can see, and a
   * hardcoded 10 would overshoot a short menu and crawl a tall one.
   *
   * `visible - 1` keeps one row of context across the jump, which is what every
   * platform list control does and what makes paging readable rather than
   * teleporting. Falls back to 10 when there is nothing to measure (an empty
   * menu, or a row whose height reads 0 mid-layout) — a fallback that pages too
   * far is still bounded by move()'s clamp, so the worst case is End/Home.
   *
   * APPROXIMATE BY CONSTRUCTION, stated rather than implied away: the divisor is
   * one option row's height, while the menu may also contain group headings and
   * a footer, so on a grouped list a page moves slightly less than a screenful.
   * Erring short is the right direction — it never skips past content unseen.
   */
  function pageStep() {
    const menu = state.menu;
    if (!menu) return 10;
    const row = menu.querySelector('.lb-opt');
    const h = row ? row.offsetHeight : 0;
    if (!h) return 10;
    const visible = Math.floor(menu.clientHeight / h);
    return Math.max(1, visible - 1);
  }

  function typeAhead(ch) {
    const now = Date.now();
    if (now - state.typeAt > TYPEAHEAD_MS) state.typeBuf = '';
    state.typeAt = now;
    const repeat = state.typeBuf.length === 1 && state.typeBuf === ch;
    state.typeBuf = repeat ? ch : state.typeBuf + ch;

    const q = state.typeBuf.toLowerCase();
    const idx = enabledIndexes();
    if (!idx.length) return;
    // A repeated single character cycles through the options starting with
    // it, which is what every platform list control does and what makes
    // "press d three times" work on a long list.
    const startAt = idx.indexOf(state.active);
    const order = repeat && startAt >= 0
      ? idx.slice(startAt + 1).concat(idx.slice(0, startAt + 1))
      : idx;
    for (const i of order) {
      const t = String(state.options[i].typeahead || '').toLowerCase();
      if (t.startsWith(q)) { setActive(i); return; }
    }
    // No prefix hit — fall back to a substring match before giving up, so a
    // model id like "claude-opus-5" is reachable by typing "opus".
    for (const i of order) {
      const t = String(state.options[i].typeahead || '').toLowerCase();
      if (t.includes(q)) { setActive(i); return; }
    }
  }

  function onKeyDown(e) {
    if (state.trigger.disabled) return;
    const isOpen = !!state.menu;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) open(); else move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) open(); else move(-1);
        return;
      // ── PAGING, THE OTHER HALF OF THE DEBT THE NATIVE POPUP WAS PAYING ────
      // A native <select> pages through its options; this component shipped
      // with no case for either key, so on a 193-row model list the only way
      // down was 193 presses of ArrowDown or a type-ahead guess. Measured with
      // real key events before the fix: `aria-activedescendant` did not move.
      //
      // ONLY WHILE OPEN, exactly like Home/End directly below — and without
      // preventDefault when closed, so a closed trigger does not swallow the
      // page scroll the user was asking the document for. That also keeps the
      // house rule this file states for printable keys: nothing commits blind
      // from a control whose list the user cannot see.
      //
      // move() clamps to the ends, so PageDown near the bottom lands on the
      // last enabled row rather than running off it — the native behaviour.
      case 'PageDown':
        if (!isOpen) return;
        e.preventDefault();
        move(pageStep());
        return;
      case 'PageUp':
        if (!isOpen) return;
        e.preventDefault();
        move(-pageStep());
        return;
      case 'Home':
        if (!isOpen) return;
        e.preventDefault();
        { const i = enabledIndexes(); if (i.length) setActive(i[0]); }
        return;
      case 'End':
        if (!isOpen) return;
        e.preventDefault();
        { const i = enabledIndexes(); if (i.length) setActive(i[i.length - 1]); }
        return;
      case 'Enter':
        e.preventDefault();
        if (!isOpen) { open(); return; }
        if (state.active >= 0) commit(state.options[state.active].value);
        else close();
        return;
      case ' ':
        // Space opens, and while open it is a type-ahead character (a model
        // label can contain one). It never commits — Enter does.
        if (!isOpen) { e.preventDefault(); open(); return; }
        e.preventDefault();
        typeAhead(' ');
        return;
      case 'Escape':
        if (!isOpen) return;
        e.preventDefault();
        e.stopPropagation();
        // CANCEL. `state.value` is only ever written by commit(), so there is
        // nothing to roll back — arrow keys move the ACTIVE row and never the
        // selected one. That is the property, not an accident of ordering.
        close();
        return;
      case 'Tab':
        // Close and let the browser move focus. Deliberately NOT committing:
        // Tab means "I am done here", and a native menulist does not commit a
        // merely-highlighted row on the way out either.
        if (isOpen) close({ focusTrigger: false });
        return;
      default:
        break;
    }

    if (e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // A printable key on the CLOSED trigger opens and seeds the search
      // rather than committing blind. Several of these controls start a
      // network load on change; committing a row the user never saw is a
      // worse trade than one extra keystroke.
      if (!isOpen) { open(); }
      typeAhead(e.key.toLowerCase());
    }
  }

  trigger.addEventListener('keydown', onKeyDown);
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.menu) close(); else open();
  });
  trigger.addEventListener('blur', () => {
    // Focus genuinely left the control (Tab, or a click elsewhere). The menu
    // keeps focus on the trigger by preventing its own pointerdown default,
    // so reaching here while open means the user has moved on.
    if (state.menu) close({ focusTrigger: false });
  });

  const api = {
    id,
    get value() { return state.value; },
    get isOpen() { return !!state.menu; },
    open,
    close,
    /** Replace the options without re-rendering the trigger. */
    setOptions(next, nextValue) {
      state.options = normaliseOptions(next, cfg.actionValues);
      if (arguments.length > 1) state.value = nextValue;
      const opt = findOption(state.options, state.value);
      const textEl = state.trigger.querySelector('[data-lb-text]');
      if (textEl) textEl.textContent = opt ? opt.label : triggerLabelFor(cfg, state.options);
      state.trigger.classList.toggle('is-placeholder', !opt);
      if (state.menu) {
        state.menu.innerHTML = menuHtml(id, state.options, state.value, cfg.footHtml || '');
        setActive(state.options.findIndex(o => o.value === state.value && !o.disabled));
        position();
      }
    },
    destroy() { close({ focusTrigger: false }); },
  };

  return api;
}

/**
 * Render + hydrate in one place for callers that can defer their markup — the
 * common shape in this tree is `setMain(html)` then a wiring pass, so most
 * views call the two halves separately with one shared cfg. This helper
 * exists for the case where the container is already in the document.
 */
export function replaceWithListbox(containerEl, cfg) {
  if (!containerEl) return null;
  containerEl.innerHTML = renderListboxHtml(cfg);
  return mountListbox(cfg);
}
