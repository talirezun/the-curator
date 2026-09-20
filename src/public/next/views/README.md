# Adding a view

Each view under `/next` is one file here, plus one same-named CSS file,
plus one entry in the rail registry over in `../app.js`.

**To add or edit a view:**

1. **Import what you need from the shell API** — `import { registerView,
   setSidebar, setMain, ... } from '../app.js';`. The full exported API and
   its contract (`onEnter`/`onExit`) is documented in the docblock at the
   top of `app.js`. Import only what your view actually calls.
2. **Call `registerView(name, { onEnter, onExit })` at your file's own top
   level** — see any existing view file for the shape. `onEnter` may
   return a teardown function; `navigate()` calls it right before the next
   view mounts.
3. **Own your own CSS file** — `views/<name>.css`, already linked from
   `index.html` after `shell.css`. Put every rule specific to your view's
   markup there. If a rule is genuinely shared layout (rail, sidebar
   shell, main grid, reader overlay, buttons, tokens wiring), it belongs
   in `shell.css` instead — ask before adding new shared rules there.
4. **Never reach into another view's DOM.** The rail, sidebar, main
   column, and reader overlay are the only shared surfaces, and all of
   them are reached only through the shell functions (`setSidebar`,
   `setMain`, `openReader`, etc.) — never via `document.getElementById`
   on an element another view owns.

   **The one exception is a HOSTED view, and it is an exception about
   IMPORTS, not about the DOM** (v3.64.0). A view that hosts another
   imports a named trio from it — `mount<Name>Section(el, opts)`,
   `unmount<Name>Section()` and `<name>SectionBusy()` — and hands it an
   element to own; `views/domains.js` does exactly this for
   `views/ingest.js` and `views/shared.js`. The host still never touches
   what it mounted: it owns the container, the hosted view owns
   everything inside it, and the host asks `…SectionBusy()` rather than
   inspecting the panel to find out whether it may repaint. Adding a
   host seam is additive by rule — several offline suites brace-match
   named functions out of those files, so nothing in a hosted view may be
   renamed or moved. See each file's own host-seam header before widening
   one.

   One other import crosses this line and is not a host seam: a
   **self-clearing request**, which a view exports so another can ask it
   to open on something — `requestProject` in `views/memory.js`, and
   `requestDomain` / `requestDomainFold` / `requestChatScope` in the
   shell. A request is recorded once and spent by reading it; it is not a
   call into the other view's DOM.
5. **New view (not just editing one)**: add its name to `NAV_VIEWS` (a rail
   button), `HOSTED_VIEWS` (registered and navigable, but reached from
   inside another view) or `FOOTER_VIEWS`, and its
   `{ label, caption, icon, title }` to `VIEW_META` in `app.js`, add its
   `<link>` to `index.html`, and add its `import './views/<name>.js';` line
   to app.js's "View registration" section. All three arrays feed
   `ALL_VIEWS`, which is the set `pickStartView` restores a stored last view
   from and the set `VIEW_META`'s keys are checked against — a name in one
   collection and not the other is the failure
   `scripts/test-next-shell-rail.js` §3b and §6 exist to catch, and every
   way it can go wrong is silent.

**Why the shell functions are safe to call at your file's own top level:**
`app.js` imports every `views/*.js` file, and every `views/*.js` file
imports back from `app.js` — a real ES-module cycle. `registerView` (the
only shell function views call at top level, inside `registerView(...)`
itself) is written to tolerate running before `app.js`'s own top-level
code has executed, precisely so this works. See the comment on `registry`
in `app.js` before changing anything about how registration works.
