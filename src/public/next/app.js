// The Curator — Phase 1 UI redesign shell.
//
// This is a parallel, standalone shell served at /next. It shares nothing
// with src/public/app.js (the shipping app) — no imports, no globals, no
// shared state. Vanilla JS, no build step, matching the constraint the
// design components (React, but hookless/stateless-beyond-props) were
// chosen under: port the PATTERN, not the framework.
//
// This file owns exactly one piece of real infrastructure for this phase:
// a view registry + navigate() that enforces two hard rules from the
// design spec (README.md "Interactions & behaviour" + screen 7):
//   1. An overlay (the wiki reader) must never survive a view change.
//   2. Rail navigation always clears the reader AND closes the model
//      picker, unconditionally, before the new view mounts.
// Every view stub is deliberately thin; the registry is the point of this
// file, not the stub content.

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────

  const THEME_KEY = 'curator-next-theme';
  const VIEW_KEY = 'curator-next-view';

  // Rail order matches ARCHITECTURE.md's rail table exactly: your brain
  // (Domains) -> your team's brain (Shared Brain) -> your agents' brain
  // (Agent memory) -> the way material gets in (Ingest), with Chat as the
  // way in to all three ahead of them, then the footer pair.
  const NAV_VIEWS = ['chat', 'domains', 'shared', 'memory', 'ingest'];
  const FOOTER_VIEWS = ['sync', 'settings'];
  const ALL_VIEWS = [...NAV_VIEWS, ...FOOTER_VIEWS];

  const VIEW_META = {
    chat:     { label: 'Chat',          icon: 'messageSquare', title: 'Chat' },
    domains:  { label: 'Domains',       icon: 'grid',          title: 'Domains' },
    shared:   { label: 'Shared Brain',  icon: 'users',         title: 'Shared Brain' },
    memory:   { label: 'Agent memory',  icon: 'cpu',           title: 'Agent memory' },
    ingest:   { label: 'Ingest',        icon: 'upload',        title: 'Ingest' },
    sync:     { label: 'Sync',          icon: 'refresh',       title: 'Sync' },
    settings: { label: 'Settings',      icon: 'settings',      title: 'Settings' },
  };

  // ── Icons ──────────────────────────────────────────────────────────────
  // Hand-drawn, Lucide-style (24x24 viewBox, round stroke caps/joins,
  // currentColor, stroke-width 1.7) — no icon library dependency, no CDN.
  // Each key stands in for a specific real Lucide icon (lucide.dev), named
  // here so a later phase can swap in the real path data without having to
  // re-derive intent from a hand-drawn approximation:
  //   messageSquare -> message-square   grid    -> grid-2x2
  //   users         -> users            cpu     -> cpu
  //   refresh       -> refresh-cw       settings -> settings
  //   upload        -> upload           sun      -> sun
  //   moon          -> moon             close    -> x
  //   book          -> book-open        layers   -> layers
  //   dot           -> (not a Lucide icon; a plain filled circle used as a
  //                     small status/marker glyph, e.g. the reader's
  //                     "PREVIEW" note)

  const ICON_BODY = {
    messageSquare: '<path d="M4 4.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.6 3.68A.5.5 0 0 1 3.6 20.3V17H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"/>',
    grid: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.4"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.4"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.4"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.4"/>',
    users: '<circle cx="8.5" cy="8" r="3"/><path d="M2.5 20a6 6 0 0 1 12 0"/><circle cx="16.7" cy="9" r="2.4"/><path d="M15 12.2a5 5 0 0 1 6.5 4.8"/>',
    cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/><path d="M9 3v2.3M15 3v2.3M9 18.7V21M15 18.7V21M3 9h2.3M3 15h2.3M18.7 9H21M18.7 15H21"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4.5V9h4.5"/><path d="M4 13a8 8 0 0 0 14.5 4.5M20 19.5V15h-4.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V19.7a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06A2 2 0 1 1 4.16 15.6l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H2.9a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.55 7.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 6.98 2.84l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V1.55a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.04h.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.46z" opacity="0"/><path d="M12 4.2v1.9M12 17.9v1.9M4.2 12h1.9M17.9 12h1.9M6.7 6.7l1.3 1.3M16 16l1.3 1.3M6.7 17.3 8 16M16 8l1.3-1.3"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/>',
    moon: '<path d="M20 13.6A8.5 8.5 0 1 1 10.4 4a6.6 6.6 0 0 0 9.6 9.6z"/>',
    close: '<path d="M5 5l14 14M19 5 5 19"/>',
    book: '<path d="M4 4.8A1.8 1.8 0 0 1 5.8 3H12v18H5.8A1.8 1.8 0 0 1 4 19.2z"/><path d="M20 4.8A1.8 1.8 0 0 0 18.2 3H12v18h6.2a1.8 1.8 0 0 0 1.8-1.8z"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5"/>',
    upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 16v2.8A1.7 1.7 0 0 0 6.2 20.5h11.6a1.7 1.7 0 0 0 1.7-1.7V16"/>',
    dot: '<circle cx="12" cy="12" r="3.2"/>',
  };

  function icon(name, size) {
    const body = ICON_BODY[name] || ICON_BODY.dot;
    const px = size || 19;
    return (
      '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + body + '</svg>'
    );
  }

  // ── State ──────────────────────────────────────────────────────────────

  const state = {
    view: null,
    theme: 'dark',
    reader: null,          // { slug, title } or null — overlay open/closed
    modelPickerOpen: false,
  };

  // ── View registry ──────────────────────────────────────────────────────
  //
  // Each view registers { onEnter, onExit }. onEnter may return a teardown
  // function; navigate() calls it before the next view mounts. This is the
  // generic replacement for an `if (target === 'x') { ... } else if (...)`
  // chain — views are self-contained and don't know about each other.

  const registry = new Map();
  let currentTeardown = null;

  function registerView(name, def) {
    registry.set(name, def || {});
  }

  function navigate(name) {
    if (!registry.has(name)) return;

    // Hard rule (design spec, "Interactions & behaviour"): rail selection
    // clears the reader and closes the model picker. This runs on EVERY
    // navigation, unconditionally, before anything else — a view is never
    // given the chance to leave either open behind it.
    closeReader();
    closeModelPicker();

    if (currentTeardown) {
      try { currentTeardown(); } catch (err) { console.error('[next] view teardown failed', err); }
      currentTeardown = null;
    }
    const prev = state.view;
    if (prev && registry.has(prev) && typeof registry.get(prev).onExit === 'function') {
      try { registry.get(prev).onExit(); } catch (err) { console.error('[next] onExit failed', err); }
    }

    state.view = name;
    try { localStorage.setItem(VIEW_KEY, name); } catch { /* private mode etc. */ }

    renderRailActive();

    const def = registry.get(name);
    const result = typeof def.onEnter === 'function' ? def.onEnter() : null;
    if (typeof result === 'function') currentTeardown = result;
  }

  // ── Reader overlay (global — any view can open it) ─────────────────────

  function openReader(page) {
    state.reader = page;
    renderReader();
  }

  function closeReader() {
    if (state.reader === null) return;
    state.reader = null;
    renderReader();
  }

  function renderReader() {
    const root = document.getElementById('reader-root');
    if (!state.reader) {
      root.innerHTML = '';
      return;
    }
    const p = state.reader;
    root.innerHTML =
      '<div class="reader-scrim open" id="reader-scrim">' +
        '<div class="reader-panel" role="dialog" aria-modal="true" aria-label="Page reader">' +
          '<div class="reader-header">' +
            icon('book', 14) +
            '<span class="reader-path mono">' + escapeHtml(p.slug) + '</span>' +
            '<span class="reader-keycap">esc</span>' +
            '<button class="reader-close" id="reader-close-btn" title="Close" aria-label="Close">' + icon('close', 15) + '</button>' +
          '</div>' +
          '<div class="reader-body">' +
            '<span class="reader-note">' + icon('dot', 10) + ' PREVIEW — REGISTRY DEMO</span>' +
            '<div class="reader-title">' + escapeHtml(p.title) + '</div>' +
            '<p>This is the wiki reader overlay described in the design spec (screen 7): it slides over the ' +
            'main column only, the rail and sidebar stay live, and it closes on Esc, the scrim, the close ' +
            'button, or any rail navigation. No wiki data is wired into this shell yet — this preview exists ' +
            'to prove the mechanism works before real citation chips open real pages.</p>' +
            '<p>Try switching rail views right now without closing this panel — the registry’s ' +
            '<code>navigate()</code> closes it for you.</p>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('reader-scrim').addEventListener('click', (e) => {
      if (e.target.id === 'reader-scrim') closeReader();
    });
    document.getElementById('reader-close-btn').addEventListener('click', closeReader);
  }

  // ── Model picker (demo) ──────────────────────────────────────────────
  // Real composer doesn't exist in Phase 1; this is a minimal stand-in so
  // the "rail navigation closes the model picker" rule has something real
  // to close, and so it's verifiable in the browser.

  function toggleModelPicker() {
    state.modelPickerOpen = !state.modelPickerOpen;
    renderModelPickerDemo();
  }

  function closeModelPicker() {
    if (!state.modelPickerOpen) return;
    state.modelPickerOpen = false;
    renderModelPickerDemo();
  }

  function renderModelPickerDemo() {
    const el = document.getElementById('model-picker-demo');
    if (!el) return; // only present while the Chat stub is mounted
    el.style.display = state.modelPickerOpen ? '' : 'none';
  }

  // ── Theme ──────────────────────────────────────────────────────────────

  function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    // Dark is the unconditional default at bare :root in color.css — there
    // is no [data-theme="dark"] block, so setting the attribute to "dark"
    // is harmless (nothing selects on it) and setting it to "light" is what
    // actually redefines every semantic token. We still set it explicitly
    // both ways so the attribute always reflects the real current state.
    document.documentElement.setAttribute('data-theme', state.theme);
    try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* ignore */ }
    renderRail(); // mark swap is theme-dependent
    renderThemeToggleIcon();
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  function renderThemeToggleIcon() {
    const btn = document.getElementById('rail-theme-toggle');
    if (!btn) return;
    btn.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon', 15);
    btn.title = state.theme === 'dark'
      ? 'Switch to light theme (temporary control — Settings owns this later)'
      : 'Switch to dark theme (temporary control — Settings owns this later)';
  }

  // ── Rail ───────────────────────────────────────────────────────────────

  function renderRail() {
    const rail = document.getElementById('rail');
    const markSrc = state.theme === 'light' ? 'assets/mark-small-on-light.svg' : 'assets/mark-small-on-dark.svg';

    const navBtns = NAV_VIEWS.map((id) => {
      const meta = VIEW_META[id];
      const badge = id === 'sync' ? '' : ''; // sync badge is in the footer button below
      return (
        '<button class="rail-btn" data-view="' + id + '" title="' + meta.title + '" aria-label="' + meta.title + '">' +
          icon(meta.icon, 19) + badge +
        '</button>'
      );
    }).join('');

    const syncMeta = VIEW_META.sync;
    const settingsMeta = VIEW_META.settings;
    const pendingCount = 0; // no backend wiring in Phase 1 — badge hides at zero, per spec

    rail.innerHTML =
      '<img class="rail-mark" src="' + markSrc + '" alt="The Curator" width="26" height="26">' +
      navBtns +
      '<div class="rail-spacer"></div>' +
      '<button class="rail-theme-toggle" id="rail-theme-toggle" title="Toggle theme"></button>' +
      '<button class="rail-btn rail-btn-sm" data-view="sync" title="' + syncMeta.title + '" aria-label="' + syncMeta.title + '">' +
        icon(syncMeta.icon, 18) +
        (pendingCount > 0 ? '<span class="rail-badge">' + pendingCount + '</span>' : '') +
      '</button>' +
      '<button class="rail-btn rail-btn-sm" data-view="settings" title="' + settingsMeta.title + '" aria-label="' + settingsMeta.title + '">' +
        icon(settingsMeta.icon, 18) +
      '</button>' +
      '<div class="rail-avatar" aria-hidden="true"></div>';

    rail.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.dataset.view));
    });
    document.getElementById('rail-theme-toggle').addEventListener('click', toggleTheme);
    renderThemeToggleIcon();
    renderRailActive();
  }

  function renderRailActive() {
    document.querySelectorAll('.rail-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    });
  }

  // ── Sidebar + main render helpers shared by view stubs ─────────────────

  function setSidebar(html) {
    document.getElementById('sidebar').innerHTML = '<div class="sidebar-inner">' + html + '</div>';
  }

  function setMain(html) {
    document.getElementById('view-root').innerHTML = '<div class="main-inner">' + html + '</div>';
  }

  function eyebrow(text) {
    return '<div class="view-eyebrow cur-eyebrow">' + escapeHtml(text) + '</div>';
  }

  function emptyCard({ title, body, actionHtml }) {
    return (
      '<div class="empty-card">' +
        '<div class="empty-title">' + escapeHtml(title) + '</div>' +
        '<div class="empty-body">' + body + '</div>' +
        (actionHtml ? '<div class="empty-action">' + actionHtml + '</div>' : '') +
      '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── View: Chat ───────────────────────────────────────────────────────
  // The default view. Also hosts the reader + model-picker demo controls,
  // since both concepts (citation chips, the composer's model picker)
  // belong to Chat in the real design.

  registerView('chat', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Chat</div>' +
        '<div class="sidebar-hint">One conversation across every domain in scope. No conversations exist in this shell yet.</div>' +
        '<div class="sidebar-note">New chat · search · TODAY / EARLIER groups land here once the chat backend is wired to this shell.</div>'
      );
      setMain(
        eyebrow('the default view') +
        '<h1 class="view-title">Chat</h1>' +
        '<div class="view-body">This will be the centre of the app: one continuous thread across every domain in scope, ' +
        'with a scope bar of domain pills above it and a live "N pages in scope" readout. Assistant answers cite the ' +
        'pages they came from — clicking a citation opens that page in the reader overlay to the right, without losing ' +
        'your place in the conversation.</div>' +
        emptyCard({
          title: 'No conversation is wired up yet',
          body: 'This shell has the layout, the theme system, and the navigation registry, but no chat backend ' +
                'connection. The two controls below are structural previews of mechanisms this view depends on — ' +
                'the reader overlay and the composer’s model picker — so their close-on-navigate behaviour can ' +
                'be verified before real data exists.',
        }) +
        '<div class="demo-row">' +
          '<button class="btn btn-secondary" id="demo-open-reader">' + icon('book', 13) + ' Preview the reader overlay</button>' +
          '<button class="btn btn-secondary" id="demo-toggle-model-picker">' + icon('layers', 13) + ' Preview the model picker</button>' +
        '</div>' +
        '<div class="model-picker-demo" id="model-picker-demo" style="display:none">' +
          modelPickerRow('#E0A33A', 'Claude Sonnet 4.5', 'Anthropic · best reasoning', '$3/M') +
          modelPickerRow('#79C752', 'GPT-5.1', 'OpenAI · strong synthesis', '$2.5/M') +
          modelPickerRow('#3FBFD8', 'Gemini 2.5 Flash Lite', 'Google · cheapest, default for ingest', '$0.10/M') +
          modelPickerRow('#A8A8BC', 'Qwen 3 32B', 'Local · nothing leaves this machine', 'free') +
        '</div>'
      );

      document.getElementById('demo-open-reader').addEventListener('click', () => {
        openReader({ slug: 'concepts/retrieval-augmented-generation', title: 'Retrieval-augmented generation' });
      });
      document.getElementById('demo-toggle-model-picker').addEventListener('click', toggleModelPicker);
      renderModelPickerDemo();

      // onExit / teardown: nothing to clean up yet (no timers, no
      // listeners outside this view's own root, which gets overwritten by
      // the next view's setMain/setSidebar call). Returning nothing is
      // correct here — the teardown hook exists for views that need it.
    },
  });

  function modelPickerRow(dot, name, meta, price) {
    return (
      '<div class="mp-row">' +
        '<span class="mp-dot" style="background:' + dot + '"></span>' +
        '<span style="flex:1">' + escapeHtml(name) + '<br><span class="mono" style="font-size:10px;color:var(--text-3)">' + escapeHtml(meta) + '</span></span>' +
        '<span class="mono" style="font-size:10px;color:var(--text-3)">' + escapeHtml(price) + '</span>' +
      '</div>'
    );
  }

  // ── View: Domains ──────────────────────────────────────────────────────

  registerView('domains', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Domains</div>' +
        '<div class="cur-eyebrow" style="margin-top:2px">KNOWLEDGE</div>' +
        '<div class="sidebar-hint">No domains exist in this shell yet.</div>'
      );
      setMain(
        eyebrow('your brain') +
        '<h1 class="view-title">Domains</h1>' +
        '<div class="view-body">A domain is one compounding wiki — a subject you read about often. Everything ingested ' +
        'into it updates the pages already there, so the graph gets denser rather than just bigger. This view will list ' +
        'every domain with its page count, an entity/concept/summary breakdown, a health badge, and an ' +
        '“Ask this domain” shortcut back into Chat.</div>' +
        emptyCard({
          title: 'No domains are wired into this shell',
          body: 'Domain creation, stats and the health panel all depend on the domains API that the shipping app ' +
                'already talks to — this Phase 1 shell doesn’t call it yet. That wiring is Phase 2 work.',
          actionHtml: '<button class="btn btn-primary" disabled title="Domain creation is not wired up in this phase">' +
                      icon('grid', 13) + ' New domain</button>',
        })
      );
    },
  });

  // ── View: Shared Brain ──────────────────────────────────────────────────

  registerView('shared', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Shared Brain <span style="font:var(--weight-medium) 10px/1.6 var(--font-mono);' +
        'color:var(--accent-text);background:var(--accent-tint);border:1px solid var(--accent-border);' +
        'border-radius:999px;padding:2px 7px;margin-left:4px;vertical-align:middle">beta</span></div>' +
        '<div class="sidebar-hint">A collective wiki a cohort writes together.</div>' +
        '<div class="sidebar-note">Not connected to any Shared Brain in this shell.</div>'
      );
      setMain(
        eyebrow('your team’s brain') +
        '<h1 class="view-title">Shared Brain</h1>' +
        '<div class="view-body">A Shared Brain is a collective wiki a cohort writes together. Contributors push ' +
        'synthesised summaries of the domains they opt in; the merged wiki comes back as a read-only mirror. Nothing ' +
        'else on your machine moves.</div>' +
        emptyCard({
          title: 'Not connected — this shell doesn’t wire either path yet',
          body: 'The real view has two entry points here: “I have an invite token” to join a cohort someone ' +
                'already set up, and “Start a new Shared Brain” to create one. Both open the existing five-step ' +
                'wizard from the shipping app, restyled — that reuse, and the connected-state maintenance surface ' +
                '(contributors, your attribution share, per-domain opt-in), is Phase 2 work.',
        })
      );
    },
  });

  // ── View: Agent memory ──────────────────────────────────────────────────

  registerView('memory', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Agent memory</div>' +
        '<div class="sidebar-hint">Written by your agents through MCP. Read-only here.</div>' +
        '<div class="sidebar-note">No memory domains in this shell yet.</div>'
      );
      setMain(
        eyebrow('your agents’ brain') +
        '<h1 class="view-title">Agent memory</h1>' +
        emptyCard({
          title: 'This feature doesn’t exist yet',
          body: 'Agent memory will show read-only rollups — Done, Decided, Blocked — composed from every active MCP ' +
                'scope a coding agent has written for a project, plus an Active scopes list showing which sessions are ' +
                'still live. It is rewritten on each compose rather than appended to, so it reflects current state, not ' +
                'a log. Distinguished from knowledge domains everywhere in the app by a square marker instead of a ' +
                'round one. None of the read side exists yet — this slot is here so the rail’s shape (your brain → ' +
                'your team’s brain → your agents’ brain) is honest about what’s coming, not just what’s built.',
        })
      );
    },
  });

  // ── View: Ingest ─────────────────────────────────────────────────────────

  registerView('ingest', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Ingest queue</div>' +
        '<div class="sidebar-hint">Files are meant to be processed one at a time so a failure never costs you the ' +
        'whole batch. That queue isn’t wired into this shell yet.</div>' +
        '<div class="sidebar-note">No batch is running in this shell.</div>'
      );
      setMain(
        eyebrow('the way material gets in') +
        '<h1 class="view-title">Ingest</h1>' +
        '<div class="view-body">Drop a folder or a stack of files. Each one is decomposed into entity, concept and ' +
        'summary pages, and merged into what is already there.</div>' +
        emptyCard({
          title: 'Single-file ingest already exists — the batch queue this view is for does not, yet',
          body: 'The shipping app can ingest one source today (PDF, MD, TXT) through its own Ingest tab. What this ' +
                'design specifically adds is a resumable batch queue: drop a folder or a stack of files, they process ' +
                'one at a time so a single failure costs one file instead of the whole batch, a paused or interrupted ' +
                'queue picks back up where it left off, and a failed row states the cause — “no text layer”, not just ' +
                '“failed”. None of that queue exists in this shell. It’s Track 3 on the roadmap; no date is set.',
        })
      );
    },
  });

  // ── View: Sync ──────────────────────────────────────────────────────────

  registerView('sync', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Sync</div>' +
        '<div class="sidebar-hint">Your whole wiki, backed up to a private GitHub repository you own. Pages, chats ' +
        'and schemas travel; source files and keys stay here.</div>' +
        '<div class="cur-eyebrow" style="margin-top:2px">PER DOMAIN</div>' +
        '<div class="sidebar-note">No domains to report on in this shell yet.</div>'
      );
      setMain(
        eyebrow('where it all lives') +
        '<h1 class="view-title">Sync</h1>' +
        '<div class="view-body">Your wiki lives on disk and backs up to a private repository you own. Every sync is a ' +
        'git commit, so anything can be reverted. This is a footer item rather than a rail peer deliberately — you need ' +
        'to know at a glance that changes are unpushed (the rail badge), but rarely need to come here on purpose.</div>' +
        emptyCard({
          title: 'Not wired to the sync backend in this shell',
          body: 'The shipping app already has a working Personal Sync (push/pull/status, per-domain state, commit ' +
                'history with revert). This view will host the same status here, plus the one-line reporting row for ' +
                'Shared Brain pushes (“you configure sharing in Shared Brain, you observe it in Sync”) — ' +
                'connecting to the real endpoints is Phase 2 work.',
        })
      );
    },
  });

  // ── View: Settings ───────────────────────────────────────────────────────

  const SETTINGS_SECTIONS = [
    ['General', 'Appearance, updates'],
    ['Providers & keys', 'Gemini, Anthropic, OpenAI, local'],
    ['MCP bridge', 'My Curator, default write domain'],
    ['Health & scan limits', 'Cost ceilings, candidate pairs'],
    ['Knowledge base', 'Vault folder, Obsidian'],
  ];

  registerView('settings', {
    onEnter() {
      setSidebar(
        '<div class="sidebar-title">Settings</div>' +
        '<div class="sidebar-section-list">' +
        SETTINGS_SECTIONS.map(([name, hint]) => (
          '<div class="sidebar-section-row"><span class="row-label">' + name + '</span>' +
          '<span class="row-hint">' + hint + '</span></div>'
        )).join('') +
        '</div>'
      );
      setMain(
        eyebrow('configuration') +
        '<h1 class="view-title">Settings</h1>' +
        '<div class="view-body">There is too much configuration for a modal, so this is a real view with its own ' +
        'sub-navigation (listed in the sidebar): General, Providers &amp; keys, MCP bridge, Health &amp; scan limits, ' +
        'Knowledge base.</div>' +
        emptyCard({
          title: 'The theme toggle lives in the rail for now',
          body: 'General’s real Dark/Light control is a segmented control in this section — this phase only has ' +
                'the small toggle above the avatar in the rail, added just so both themes can be exercised before ' +
                'Settings itself is wired up. It writes to the same localStorage key, so switching it here later ' +
                'won’t reset anyone’s existing choice.',
        })
      );
    },
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────
  // Esc closes, in priority order: reader → model picker (matches the
  // design spec's stated priority for the real composer's picker).

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.reader) { closeReader(); return; }
    if (state.modelPickerOpen) { closeModelPicker(); return; }
  });

  // ── Boot ───────────────────────────────────────────────────────────────

  function boot() {
    let savedTheme = 'dark';
    let savedView = 'chat';
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark') savedTheme = t;
      const v = localStorage.getItem(VIEW_KEY);
      if (v && ALL_VIEWS.includes(v)) savedView = v;
    } catch { /* private mode / disabled storage — defaults are fine */ }

    applyTheme(savedTheme);
    renderRail();
    navigate(savedView);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
