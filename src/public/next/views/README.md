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
   on an element another view owns, and never by importing another
   `views/*.js` file.
5. **New view (not just editing one)**: also add its name to `NAV_VIEWS`
   or `FOOTER_VIEWS` and its `{ label, icon, title }` to `VIEW_META` in
   `app.js`, add its `<link>` to `index.html`, and add its `import
   './views/<name>.js';` line to app.js's "View registration" section.

**Why the shell functions are safe to call at your file's own top level:**
`app.js` imports every `views/*.js` file, and every `views/*.js` file
imports back from `app.js` — a real ES-module cycle. `registerView` (the
only shell function views call at top level, inside `registerView(...)`
itself) is written to tolerate running before `app.js`'s own top-level
code has executed, precisely so this works. See the comment on `registry`
in `app.js` before changing anything about how registration works.
