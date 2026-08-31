# `desktop/` — Electron shell

**Installed, built and launched on 2026-08-31.** Before that date nothing in
this folder had ever been run, and the file said so; that sentence is gone
because it is no longer true.

What was actually done, and on one machine only (macOS 15, arm64):

| | |
|---|---|
| `npm install` in `desktop/` | electron **43.5.0**, electron-builder **26.15.3**, both now pinned EXACTLY |
| `electron .` | a real window, the app's own UI, a real domain rendered |
| a mutating `POST` from the renderer | **201** — the server's origin guards accept a `BrowserWindow` on a dynamic loopback port |
| `electron-builder --mac` | one `.app` and two `.dmg`s (arm64 and x64), unsigned |
| the `.app` run from `/Applications` | works |

**One thing was wrong, and it is the thing this file predicted would be
wrong:** the `files` mapping. See *The `files` bug* below — it is worth reading
even if you never touch this folder, because the broken build **passed every
obvious test**.

Still true: `git diff package.json package-lock.json` at the repo root is
**0 lines**. The root manifest gained nothing.

---

## The `files` bug, and why building it was not enough to catch it

The scaffold listed `node_modules/**/*` in the `files` filter. **That line did
nothing.** electron-builder does not treat `node_modules` as ordinary files —
it computes the production dependency tree from the app manifest's
`dependencies` and copies that, ignoring the glob. `desktop/package.json`
deliberately declares no `dependencies`, so the computed tree was empty, the
build logged

```
no node modules returned while searching directories
```

and shipped `Contents/Resources/app/` **with no `node_modules` at all**.

Here is the part that matters. **That build launched perfectly.** Node resolves
a bare specifier by walking *up* the directory tree, so from

```
desktop/dist/mac-arm64/The Curator.app/Contents/Resources/app/src/server.js
```

it climbed out of the bundle, out of `dist/`, out of `desktop/`, and found the
**repo root's** `node_modules`. The app started, served, rendered the wiki and
accepted writes. Copy the same bundle to `/Applications` and it dies on
`ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`.

So: **"I built it and it ran" is not evidence.** The only test that catches
this class is launching a *copy* of the `.app` from a directory with no
`node_modules` above it. Nothing automated does that today.

The fix is an explicit `extraResources` entry placing `../node_modules` at
`app/node_modules`; `scripts/test-desktop-packaging.js` §11 refuses both the
old shape and its absence.

---

## Why a second `package.json`

The root manifest has **8 runtime dependencies and zero devDependencies**, and
the in-app auto-updater runs `npm install` on **every user's machine** on every
update. Adding `electron` + `electron-builder` to the root manifest would push
hundreds of megabytes to every existing browser user for a feature they do not
have. This project has already refused a browser driver as a devDependency four
times for exactly that reason.

So `desktop/` carries its own manifest. **The root `package.json` and
`package-lock.json` must stay byte-identical.**
`scripts/test-desktop-packaging.js` asserts it, by enumerating the dependency
names out of both files rather than from a hardcoded list.

---

## Layout

| Path | What it is |
|---|---|
| `package.json` | Separate manifest. `private: true`, no `dependencies`, Electron + electron-builder as devDependencies. |
| `main.js` | Electron main process. Starts `src/server.js` **in-process**, opens one `BrowserWindow`. |
| `preload.js` | Deliberately exposes nothing. The reason is written in the file. |
| `electron-builder.yml` | Build config. `asar: false`, unsigned, `publish: null`. |
| `lib/port.js` | Picks a free loopback port; builds the app URL. Pure enough to test. |
| `lib/write-status.js` | Asks `GET /api/write-status`. Never rejects. |
| `lib/quit-decision.js` | Turns that answer into `quit` / `ask`. Pure; the suite executes it. |
| `lib/window-state.js` | Remembers the window's size and position; refuses an off-screen restore. |
| `lib/app-version.js` | The app's version, and the About panel. See *Version identity* below. |
| `lib/dist.js` | `npm run dist`. Injects the root manifest's version into the build. |
| `lib/verify-version.mjs` | electron-builder `afterPack` hook. **Fails the build** on a wrong version. |
| `lib/adhoc-sign.mjs` | The other `afterPack` half. Applies and **proves** a valid ad-hoc signature. |
| `lib/update-plan.js` | Every DECISION the in-app updater makes, and no I/O. Includes the swap script's text. |
| `lib/update-release.js` | "Which release, which .dmg?" — delegates every version question to `src/routes/config.js`. |
| `lib/update-engine.js` | Download, verify, stage, swap, relaunch. Every effect injected. |
| `lib/update-client.js` | The shell as a CLIENT of the app's own update route — the menu's download/install path, the SSE reader, and the menu label. Never touches the engine hooks. |
| `lib/tray-model.js` | The menubar widget's ROW MODEL: order, ages, the harness-vs-machine slot, caps, notices, the glyph state. Pure. |
| `lib/tray-menu.js` | Row model → `Menu.buildFromTemplate` template. Pure. |
| `lib/tray-icon.js` | Generates the template-image glyph as PNG bytes. No binary is checked in. Pure. |
| `lib/background-mode.js` | Resolves `backgroundMode` and the 3x3 live transition between modes. Pure. |
| `lib/state-watch.js` | The refresh strategy: `/state/` path filter, 150 ms debounce, 5-minute fallback, one-shot glyph expiry. Every timer injected. |

The `lib/` modules import **nothing** from Electron and nothing from
`src/`, which is what lets `scripts/test-desktop-packaging.js` and
`scripts/test-desktop-version-identity.js` run them for
real. `main.js` itself can only be source-scanned from the offline suite —
Electron is not an offline-suite dependency and never will be — and the suite
says so in its own NOT ENFORCED block rather than implying otherwise.

---

## Version identity

**The first shipped DMG's About panel read `0.0.0 (0.0.0)`.** That was not a
display bug. The packaged `Info.plist` genuinely carried
`CFBundleShortVersionString=0.0.0` and `CFBundleVersion=0.0.0`, because
electron-builder derives both from the app manifest's `version` and
`desktop/package.json` is pinned at `0.0.0`. The DMGs were then **renamed by
hand** at upload time, so the filename said `3.30.0` and the app inside said
`0.0.0`.

### A claim in v3.30.0's changelog row that was half wrong

> desktop/package.json … version pinned `0.0.0` so the DMG version can only
> come from the git tag

`.github/workflows/desktop-dmg.yml` really does pass
`--config.extraMetadata.version="${GITHUB_REF_NAME#v}"`, and that path was
never broken. What was false is **"can only"**. `npm run dist` was

```
electron-builder --mac --config electron-builder.yml
```

with no version anywhere in it — and that is the command that built the DMGs
that shipped. The pin turned a missing value into a plausible-looking one.

### The rule

**The root `package.json` version is the only source of truth.** It is the
field `scripts/release.js` already moves in lockstep with `package-lock.json`
and `CLAUDE.md`'s `- **Version:**` line.

`desktop/package.json` stays at `0.0.0` **forever**. It is a *sentinel*, not a
number to maintain — two manifests that must agree by hand is exactly how this
broke, so the second one is never allowed to be right. (npm still needs a
parseable version there, and `desktop/package-lock.json` records `0.0.0`.)

### Two mechanisms, doing two different jobs

| | |
|---|---|
| `lib/dist.js` (`npm run dist`) | makes the version **correct** — reads the root manifest and passes `--config.extraMetadata.version`. |
| `lib/verify-version.mjs` (`afterPack`) | makes a wrong version **impossible to ship** — reads the real `Info.plist` off disk after packing and **throws** if either key disagrees with the root manifest or is still `0.0.0`. |

The second is the one that matters, because `npm run dist` is only one of the
ways this gets built. The hook fires for `npm run dist`, for the CI workflow,
and for a hand-typed `npx electron-builder --mac` — electron-builder
auto-discovers `electron-builder.yml` in the working directory even with no
`--config`.

Verified by reading electron-builder 26.15.3's own source rather than recalled:
`macPackager.applyCommonInfo` writes both version keys during `doPack`;
`platformPackager.pack` emits `afterPack` after `doPack` returns;
`AsyncEventEmitter.emit` awaits user hooks with **no try/catch**, so the throw
aborts the build — before any `.dmg` exists.

### Measured, by actually building

| Invocation | Result |
|---|---|
| `electron-builder --mac --dir` (no injection) | **BUILD REFUSED** at `afterPack`, non-zero exit, no DMG |
| `npm run dist` equivalent | exit 0; `Info.plist` reads `3.30.0` for **both** keys |
| injected `--config.extraMetadata.version=9.9.9` | **BUILD REFUSED**, mismatch named (`9.9.9` vs `3.30.0`) |
| the built `.app`, launched under test isolation | boots, serves, window opens |

### What it does NOT close, stated plainly

- A **deliberate** bypass still works: a different `--config`, an explicit
  `--config.afterPack=null`, or packaging by hand. What is closed is the path
  that actually shipped — forgetting the version entirely.
- **The root manifest and the git tag are still two sources.** CI derives the
  version from the tag; the hook then checks it against the root manifest, so a
  tag that disagrees now *fails the build* rather than shipping. That is a
  cross-check, not a single source. `scripts/release.js` is what keeps them
  equal, and nothing in `desktop/` owns that.
- The workflow's `--config.extraMetadata.version` line is now **redundant**
  with `npm run dist`, but it is not wrong and the workflow does not call
  `npm run dist`. Left alone.

### The About panel

`app.setAboutPanelOptions()`, wired in `boot()`. The reported complaint was
literally *"it doesn't have any data"*, so it carries the version plus the
identity a user can read back in a support conversation:

```
Version 3.30.0
Electron 43.5.0   ·   Chromium 140.0.0.0
Node 22.20.0   ·   V8 14.0.x
macOS 15.6 (arm64)
```

Nothing there is invented. Three things are **deliberately absent** —
`applicationName`, `copyright` and the parenthesised build field — because all
three already exist authoritatively in the bundle (`CFBundleName`,
`NSHumanReadableCopyright`, `CFBundleVersion`), and a second copy of a fact is
the class of defect this whole section is about.

The OS line says `macOS 15.6` only because Electron's
`process.getSystemVersion()` returns the marketing version. Without it the
fallback prints `darwin 24.6.0` — `os.release()` is the **Darwin kernel**
version, and calling that number "macOS" would be a fabricated field.

The implementation lives in `lib/app-version.js`, not in `main.js`, so
`scripts/test-desktop-version-identity.js` can execute it against a stub `app`.
`main.js` keeps one call site, which is source-scanned and labelled as such.

---

## The load-bearing facts `main.js` is built on

All four were verified against the source in this repo.

1. **The window loads `http://127.0.0.1:<port>`, and must keep doing so.**
   `src/server.js` builds `ALLOWED_ORIGINS` and `ALLOWED_HOSTS` from the same
   `PORT` value it binds, and every frontend fetch is relative — so a loopback
   `BrowserWindow` passes both guards with no change in `src/`.
   A `file://` page or a custom scheme sends `Origin: null`; the guard tests
   `if (origin && !ALLOWED_ORIGINS.has(origin))` and the **string** `"null"` is
   truthy, so it is *present and disallowed* → **403 on every POST**. The app
   would load and do nothing.

2. **`CURATOR_NO_OPEN=1`.** Otherwise `startListen()`'s callback runs
   `exec('open http://localhost:' + PORT)` and every launch opens the user's
   browser beside the app window.

3. **A dynamic port, not 3333.** The maintainer runs a repo checkout on 3333
   permanently. Today the loser of that race retries ~6 s and `process.exit(1)`
   with the reason only in a log — a window that never appears and explains
   nothing. `lib/port.js` records what the dynamic port *costs*: EADDRINUSE was
   accidentally preventing two copies writing to one `domains/` folder.

4. **`GET /api/write-status` before quitting.** ⌘Q is one keystroke; an ingest
   is a paid, multi-minute write. `safeToQuit` can be `null` when the registry
   throws — `lib/quit-decision.js` treats that as its own case and **asks**,
   because treating it as safe truncates paid work and treating it as busy makes
   the app permanently un-quittable.

---

## The menubar widget (Phase 1) — and NO TRAY ICON HAS EVER BEEN RENDERED

Stated first, because two features in this project have shipped in exactly this
condition (the update UI and the sync UI) and it must not be implied away:
**`new Tray()` has never been called, on this machine or any other.** Electron
is not an offline-suite dependency, so `main.js` cannot be executed by
`npm test`; and the maintainer was at his own computer while this was written,
so nothing was launched. Every claim about how macOS behaves here comes from
Electron's and Apple's documentation.

What IS proven, by execution rather than by scan, in
`scripts/test-tray-shell.js` (200 assertions, OFFLINE):

- the row model, including that a `null` age renders as *time unknown* and
  never as *just now*, and that an `ageSource: 'file'` row says **changed**
  rather than **written** — git rewrites mtime on checkout, so an unqualified
  age on a pulled handoff is the reading that stops someone looking;
- the menu template: the headline answer is the first item, *Open The Curator*
  exists in every state, *Quit* is always last and is `role: 'quit'` with **no
  click handler**, so there is structurally no path that could call `app.exit()`
  and walk past the `before-quit` write guard;
- the glyph's actual pixels, decoded back out of the PNG the encoder produced —
  greyscale with every grey value 0 (a template image carries everything in
  alpha), hollow when idle, filled when live, and differing in **zero** pixels
  outside the centre;
- the mode resolution and all nine mode-to-mode transitions, including that a
  same-mode "change" is a no-op — an atomic config write fires the watch more
  than once, and re-creating a status item moves it in the menu bar;
- the watch's filter, its debounce (three events per save collapse to one
  refresh), and the fallback interval.

**What is NOT proven, beyond the fact that nothing has been rendered:** that
Electron accepts these `role` and `sublabel` values; that macOS tints the
generated image as a template (that needs `setTemplateImage(true)` at runtime,
which is source-scanned only); that `tray.on('mouse-enter')` fires; and that the
data layer's `getTraySummary()` exists or returns the documented shape — the
model is only proven to survive it not doing so.

**`tray-only` is recognised and deliberately half-applied.** It turns the tray
on and leaves the Dock icon alone. Hiding it needs
`app.setActivationPolicy('accessory')`, and the reported bug is in exactly the
direction the mode depends on — the *accessory → regular* transition, which is
what happens the moment the user opens the window from the tray. That cannot be
tested from here. `resolveTrayPlan()` returns `hedged: true` and a reason rather
than pretending.

**One coordination point with `src/`:** the shell cannot be told the setting
changed. `registerDesktopHost()` **throws** on an unknown hook name and its
frozen list is `pickFolder, relaunch, prepareUpdate, installUpdate`, so there is
no channel to add without a change in `src/`. The shell therefore watches
`.curator-config.json`'s **directory** (not the file — the config is written
atomically, and a watch on an inode that gets renamed over stops delivering
events silently) and re-reads the mode itself.

---

## What is NOT done

It builds and it runs. It is still not a shippable product.

- **It has been built and launched exactly once, by hand, on one machine.**
  macOS 15, arm64, Node 22. The x64 DMG was produced but **never executed** —
  no Intel Mac was available. Nothing about the build is covered by
  `npm test`, which cannot install a 130 MB toolchain.
- **The MCP launcher escapes the usual test isolation.** `getMcpLauncherDir()`
  has its own seam, `CURATOR_TEST_MCP_LAUNCHER_DIR`; the documented pair
  (`CURATOR_TEST_USER_DATA_DIR` + `CURATOR_TEST_DOMAINS_DIR`) does **not**
  cover it, so a bundle-mode test run writes into the real
  `~/Library/Application Support/The Curator/bin`. Set all three. Electron's
  own Chromium profile goes to `~/Library/Application Support/<productName>`
  regardless and no Curator seam can move it.
- **The busy-quit path has never run against a real write.** `decideQuit`'s
  `quit` branch was exercised end to end (⌘Q with `safeToQuit: true` exits
  cleanly); the `ask` branches have only ever been exercised as pure
  functions.
- **No signing.** No Apple Developer enrolment, no Developer ID certificate, no
  hardened runtime, no entitlements. `mac.identity: null` forces an explicitly
  unsigned build so electron-builder cannot silently produce a locally-signed
  artifact that runs on exactly one Mac.
- **No notarization.** Requires paid enrolment. There is no `afterSign` hook.
- **No `electron-updater`, and it is not a choice — see *In-app updating*
  below.** Squirrel.Mac validates a downloaded build against the running app's
  designated code requirement, which for an ad-hoc signature is a bare
  `cdhash` that only the installed build can satisfy. It would reject every
  update. The app updates itself with its own downloader instead.
- **No first-launch adoption of an existing repo install.** A user with a
  checkout and a DMG would end up with two installs pointing at one
  `domains/` folder and no migration story.
- **No crash reporting.**
- **The About panel is not verified as RENDERED.** macOS draws it as a native
  `NSPanel` with no read-back API, and driving the menu item needs assistive
  access — attempted, refused (`-1719`). The suite proves the exact options
  object handed to Electron, not what appears on screen.
- **The menu is now a real one** — see *The application menu* below — but
  **nothing has ever displayed it.** Electron is not installed, so
  `Menu.buildFromTemplate` has never seen the template and
  `Menu.setApplicationMenu` has never been called. A role name Electron
  rejects, or an accelerator string it cannot parse, passes every assertion in
  `scripts/test-desktop-menu.js` and fails at launch.
- **No keystroke in this repo is pressed by a test.** The menu is built and
  inspected, not driven, and nothing proves the window drags — a native title
  bar is dragged by the OS rather than by app code, which is the argument for
  choosing it, but it is an argument and not a measurement.
- **No Windows, no Linux.**

### The existing-user first run, and the one thing that fails silently

An existing user needs **no migration flow**: they point the app at the
knowledge folder they already have, paste an API key, run the MCP wizard, and
the wiki appears — it is plain markdown. That path already exists
(`POST /api/config/domains-path`, `POST /api/config/pick-folder`).

But the folder picker is the one part of it that a hardened runtime can break
**without saying so**, and it is the *first* thing an existing user touches.

`POST /api/config/pick-folder` shells out to
`osascript -e 'POSIX path of (choose folder …)'`. Three findings, in order of
how confident they are:

1. **Confirmed by reading the route: a permission failure is misreported as a
   user cancellation.** The catch block treats `err.code === 1` as Cancel and
   answers `{cancelled: true}`. `osascript` exits 1 on *any* script error,
   including a TCC or entitlement refusal. So the failure does not merely go
   quiet — it actively claims the user changed their mind.
2. **Confirmed by construction: `NS*FolderUsageDescription` strings are
   mandatory** once the app is hardened and notarized, if the knowledge folder
   lives in Documents / Desktop / Downloads. Without them macOS *kills* the
   process rather than denying the read. Set in `electron-builder.yml`'s
   `mac.extendInfo`.
3. **Inferred, not measured: whether `choose folder` needs
   `com.apple.security.automation.apple-events`.** It is a StandardAdditions
   command that my reading says runs in the `osascript` process rather than
   being sent to another app — on which reading the entitlement is not
   required. The entitlement is granted **defensively anyway**, because it
   costs one key and being wrong costs the first-run experience. This must be
   measured on a real signed build.

**The better route, recommended and deliberately not implemented:** Electron's
`dialog.showOpenDialog({ properties: ['openDirectory'] })`. It is in-process,
window-modal, needs no child process, no Apple Event, no entitlement and no
consent prompt, and it returns the path directly. That makes the picker
mode-aware, which is exactly the shape `src/brain/install-mode.js` already
ships — the capability key to add is:

```
folderPickerStyle: 'osascript' | 'native-dialog'
```

`'osascript'` for `repo`, `'native-dialog'` for `bundle`, sitting alongside
`mcpLaunchStyle` and `restartStyle` and following the same "a named string,
not a boolean" convention. `src/routes/config.js` and `src/brain/install-mode.js`
are outside this change's scope, so this is a recommendation.

---

## The window: why there is a real title bar

The first packaged build shipped `titleBarStyle: 'hiddenInset'` and produced
three defects at once, all reported from real use on the very first install:
the traffic lights were drawn **on top of** the rail's logo, the window could
not be **dragged**, and it was hard to **grab to resize**.

They are one defect. `hiddenInset` removes the title bar and hands the app the
job of replacing it — and the app never took the job. Measured in the running
renderer: a sweep of every element for `-webkit-app-region: drag` returned
**zero**, and the rail is `(0, 0, 60x860)` with its logo mark at
`(17, 12, 26x26)` — the exact rectangle macOS puts the buttons in.

**Every frameless option was ruled out on evidence, not taste:**

| Option | Why not |
|---|---|
| `trafficLightPosition` | Fixes the overlap only if there is somewhere free to put the buttons. The Curator's nav is a **vertical rail** spanning the full height; there is no empty horizontal strip. Move them down → the rail's own buttons; right → the view header. And it fixes neither dragging nor resizing. |
| `titleBarStyle: 'hidden'` + `titleBarOverlay` | Checked against the installed Electron's typings, not from memory: `TitleBarOverlay.color` / `.symbolColor` are `@platform win32,linux`. On macOS the option only enables the Window Controls Overlay **CSS env vars** and JS API. It paints nothing and creates no drag region. |
| `webContents.insertCSS` from `main.js` | Stays inside this folder, and was still rejected. It must key on `src/public/next` selectors that this change does not own, and a guard could only ever assert a **string was inserted** — never that the selector **matched**. `-webkit-app-region: drag` also makes every descendant unclickable unless individually walked back with `no-drag`, and the zone contains the app's whole primary nav. It would not fix the overlap either, which needs the app's content pushed down. |

So the title bar does all three jobs immediately and for free, and
`nativeTheme.themeSource = 'dark'` pays its one real cost — a light grey strip
above a near-black app on a light-mode Mac. That is safe for the app's own
theming because the `/next` stylesheets carry an explicit **prohibition** on
`prefers-color-scheme` and stamp `data-theme` instead.

**A frameless design is the right long-term answer** and belongs with the app
CSS that has to carry it. See the `src/` recommendation below.

### Remembered geometry

`lib/window-state.js` — pure, Electron-free, and **executed** by
`scripts/test-desktop-packaging.js` §12. The file lives at
`app.getPath('userData')/window-state.json`, i.e.
`~/Library/Application Support/The Curator/`. Not in `desktop/` (read-only in an
installed `.app`, and a git working tree in repo mode) and not under
`src/brain/paths.js` (Personal Sync travels that tree; this is shell chrome).

The rule that matters is not the size — it is that a saved **position** is
adopted only when the rectangle still overlaps a real display. Close the app on
a second monitor, unplug it, relaunch: a naive restore puts the window
off-screen with no menu item, keystroke or Dock gesture that recovers it.
Verified against a real window: a poisoned state at `x=99000` relaunches with
the size kept and the position discarded.

Full screen is deliberately **not** persisted. `maximized` is.

---

### Known changes needed in `src/` (not made here — out of this change's scope)

- **The app's CSS should declare a drag region, so the frameless design can
  come back.** Two rules in `src/public/next/shell.css`, plus a top inset so
  the traffic lights do not land on the logo:

  ```css
  /* the strip macOS draws the traffic lights into */
  #rail { -webkit-app-region: drag; padding-top: 34px; }
  /* MANDATORY: without this every rail button stops receiving clicks */
  #rail button, #rail a, #rail input, #rail [role="button"] { -webkit-app-region: no-drag; }
  ```

  Both rules are **inert in a browser**, so they are safe to ship to the web
  app unchanged. Only once they exist should `desktop/main.js` go back to
  `titleBarStyle: 'hiddenInset'` — and the assertion in
  `scripts/test-desktop-packaging.js` §10 that currently forbids it is written
  to be the place that gets revisited. A drag region without the `no-drag`
  companion is worse than no drag region at all.

- **A `<meta name="theme-color">` that `applyTheme()` updates** would let the
  native title bar track the app's own light/dark choice, through
  `webContents`' standard `did-change-theme-color` event rather than through a
  private selector. Today `main.js` forces dark unconditionally, so a user who
  switches the app to its light theme keeps a dark title bar.

- **`POST /api/config/pick-folder` misclassifies permission errors as Cancel**,
  and should branch on a `folderPickerStyle` capability — see above.
- **`POST /api/restart` is wrong under Electron.** It spawns
  `process.execPath` + a script path; under Electron `process.execPath` is the
  *app binary*, so that launches a second window rather than a server.
  `main.js` intercepts the request at the HTTP layer as a stopgap. The durable
  fix is for the route to branch on `install-mode.js`'s existing
  `restartStyle: 'app-relaunch'` capability, which today has no consumer.
- **`appPath('mcp','server.js')`** is written into Claude Desktop's config.
  Under a bundle, `process.execPath` moves under App Translocation and that
  path goes stale — the plan's answer is a launcher script the app rewrites on
  each launch (`mcpLaunchStyle: 'launcher-script'`, also unwired).
- **`scripts/build-app.sh` must be retired before any signed build ships.** It
  ends with `codesign --force --deep --sign -` and
  `xattr -rd com.apple.quarantine`, which would **destroy a Developer ID
  signature**. It is load-bearing for repo mode today and is deliberately
  untouched by this change. `install-mode.js` already names the capability
  (`canRebuildAppleScriptApp: false` in bundle mode); nothing enforces it in
  the script itself.
(The version item that used to sit here is fixed — see *Version identity*
above.)

---

## The application menu

Reported from the running packaged app: *"There is no button in the menu that
you would check if there are any updates. I think we need a button, Check for
updates. Also the update process should be really fluent."*

Both halves were true. The app shipped **Electron's default menu**, dumped from
a running Electron 43.5.0 rather than recalled: the File menu held exactly one
item, "Close Window" (⌘W, `role: close`), and **nothing in the entire menu
created a window**. There was no Check for Updates, no Settings, and no route
back to a window ⌘W had taken away.

The structure lives in **`lib/menu.js`** as plain data, for the same reason
`quit-decision.js` and `app-version.js` are separate modules:
`Menu.buildFromTemplate` consumes ordinary objects, so every label,
accelerator, role and ordering decision is something `npm test` can build and
inspect for real. `main.js` keeps two Electron calls and five handlers.

```
The Curator   About · Check for Updates… · Settings… (⌘,) · Services ·
              Hide / Hide Others / Show All · Quit
Edit          Undo Redo · Cut Copy Paste Paste-and-Match-Style Delete
              Select All · Speech
View          Reload · Force Reload · Toggle DevTools ·
              Actual Size Zoom In Zoom Out · Toggle Full Screen
Window        Minimize · Zoom · Close (⌘W) · Bring All to Front ·
              The Curator
Help          User Guide · Release Notes · Show Logs
```

### Check for Updates… answers in a dialog. What that rejected, and why

**Chosen: run the check in the shell and show a native dialog.** "Check for
Updates…" is a macOS idiom with a fixed meaning — Sparkle's, and Apple's — and
the ellipsis promises a dialog. It works with no window open, it cannot be
missed, and the one action it offers is the one the user came for.

**Rejected: navigate to Settings ▸ General and start the check there.** The
panel renders all five outcomes well, and reusing it is the obvious move. It
loses on two counts. A menu item that silently swaps the visible view has no
way to *say* the most common answer — "you are up to date"; the user is left
looking for what changed. And it needs two renderer couplings landing in order
(mount the view, then click a button that does not exist until that view has
rendered), which is a race across a re-render rather than one click.

**Rejected: both.** Two things happening from one click is how a menu item
comes to feel unpredictable.

### …and then it installs the update. What that rejected, and why (v3.36.0)

**The defect first, because it is the reason this section exists.** v3.33.0
shipped the in-app updater and this menu in the same release, built by two
agents. The engine worked. The menu went on saying, in a native dialog,

> This build does not install updates by itself. Download opens the release
> page in your browser; you then replace The Curator in your Applications
> folder.

That was true of v3.31.0, when it was written, and false from the moment the
engine landed beside it. Nobody rewired the menu; the maintainer hit it on the
shipped v3.35.0, having already updated 3.33.0 → 3.34.0 through Settings.
`scripts/test-desktop-menu.js` was green throughout and even asserted that
sentence was **present** — which is the lesson: a guard on a string cannot tell
you the string has become a lie.

**Chosen: the shell becomes a second CLIENT of the app's own update route.**
`lib/update-client.js` POSTs `/api/config/update` (SSE), reads the stream, and
POSTs `/api/config/update/apply` when it reaches `staged` — the same two
endpoints, in the same order, that Settings ▸ General posts.

**Rejected: call the engine hooks directly.** `main.js` holds the engine — it
built it — so `updater.prepareUpdate()` would have been two lines. It is wrong
for reasons that are observable rather than stylistic:

- `src/routes/config.js` owns the **job record**. A download that bypassed the
  route would leave `GET /update-progress` reporting `job: null` while 140 MB
  came down, so Settings ▸ General would say *no update running* during an
  update. Two surfaces disagreeing is the same defect in a new place.
- The route owns the refusals that come **before** the engine — a write in
  flight, an update already running, no engine attached — in the app's shared
  `conflictResponse` shape. A second entry point needs its own copies.
- The route sets the `beginUpdate()` marker, which is what makes the shell's
  own quit dialog say *an update is being applied*.

And because the work is the server's job, **opening Settings ▸ General while a
menu-started update downloads shows the five-phase ring already running** —
`probeInAppUpdate()` there adopts the job. Nothing in the shell draws that; not
starting a second, invisible updater is what allows it.

### Where the download's progress goes

| Option | Verdict |
|---|---|
| A native dialog that updates as it goes | **Rejected, and not on taste.** Electron has no API to change or close a `showMessageBox` once it is on screen. Faking it means closing and reopening a dialog per tick — flicker, and repeated focus theft. |
| Switch the window to Settings ▸ General | **Rejected as the mechanism.** It needs a window (the menu is reachable with none) and the two ordered renderer couplings the check already rejected. And the auto-continue to the restart lives in the client that *started* the stream, so a panel that merely adopted the job would stop at "downloaded" and wait for a second click nobody mentioned. It happens anyway, for free, as a *view* — see above. |
| The Dock icon's progress bar | **Rejected.** `setProgressBar` is a `BrowserWindow` method, so it needs a window, and it cannot say which phase is running or what failed. Two indicators that can disagree is worse than one that cannot. |
| The menu item's own label | **Chosen.** The only surface that exists with no window open — the state ⌘W leaves behind — and the mechanism this shell already uses for the check. Determinate: `Downloading Update… 43%`. |

`updateMenuLabel()` composes it from the server's own progress record; the label
carries a **whole** percent, so the ~550 progress events of a 140 MB download
produce **103 menu rebuilds**, measured by driving 550 real events.

### What the dialog says now, and what it must never claim

`INSTALL_EXPLAINER` in `lib/update-verdict.js` is **byte-identical** to the
sentence `onInstallInApp()` in `src/public/next/views/settings.js` puts in front
of the same decision, and `scripts/test-desktop-menu.js` pins the two by reading
that file. Duplicated rather than imported because every module in `desktop/lib`
is `src`-free so the suite can execute it — the same trade `RELEASES_URL` makes.

It says the genuinely good news: **no security warning to click through.** That
is a statement about *quarantine*, measured with a control — a DMG carrying
`com.apple.quarantine` (what a browser download stamps) yields a quarantined
app; the same DMG fetched by the app's own `fetch()` does not. It is **not** a
claim that Apple vouched for anything, and the suite asserts the string never
mentions notarization or Apple approval. The pre-release sentence beside it says
the opposite out loud: the build is *not yet signed by Apple*.

The old sentence was **not deleted**. It is conditioned on the server's own
`updaterAttached`, because it remains exactly true for a build with no engine
attached.

### One source of truth, stated precisely

`GET /api/config/update-check` is the only side that read the release list, and
it already decided everything: `pickInstallableRelease()` chose *which*
release, and `decideInstallerUpdate()` set `updateAvailable`, `localAhead`,
`comparable` and `noInstallableRelease`. **`lib/update-verdict.js` contains no
version comparator, no semver parser and no numeric coercion** — it reads those
flags and picks a sentence.

The suite proves that behaviourally rather than by reading the file: it feeds a
payload whose *numbers contradict its flags* (`current: 9.9.9`,
`latest: 1.0.0`, `updateAvailable: true`) and asserts the shell answers
**available**. A shell that compared versions would answer *local-ahead*. The
reverse payload is asserted too, so the test cannot be satisfied by a function
that ignores everything and always says the same thing.

**What IS duplicated, named rather than hidden:** four short headline sentences
that also exist in `src/public/next/views/settings.js`
(`classifyInstallerUpdate`), plus `INSTALL_EXPLAINER`, which is pinned to its
other copy by a cross-file assertion. Every failure sentence comes from the
route verbatim — `classifyReleaseFailure()` already authored one per check
failure, and the engine's `UPDATE_FAILURES` table authors one per install
failure. Those are the sentences a user only ever reads when something is
wrong, and the ones it would be worst to have two versions of.

**One divergence from Settings ▸ General:** the menu does not fetch
`GET /api/version`, so it cannot report `restart-required` (files on disk newer
than the running process). That state is unreachable in a packaged build — a
DMG replaces the app and relaunches it — and reachable only in a source
checkout, where Settings is one click away. A second network call on every menu
click was not worth it.

### "Really fluent", as a UX requirement

Auto-install without asking is still not done, and that is a decision: an
update that restarts the app on its own timetable can truncate a paid ingest,
and the user has to be able to say *later*. But **an update the user has agreed
to is now performed by the app**, which is the half v3.31.0's copy said was
impossible and v3.33.0 quietly made possible.

`scripts/test-desktop-menu.js` used to assert *the menu never issues a POST* —
an invariant that encoded the bug. It now asserts the property actually worth
having: `main.js` builds no URL and issues no request itself, so every call site
lives in `desktop/lib/`, where the suite executes it.

What "fluent" was taken to mean, and how each part is met:

| Requirement | How |
|---|---|
| Something happens *immediately* | The item relabels to "Checking for Updates…" and disables. The menu bar **is** the progress indicator — no window needed, nothing painted by the renderer. The check is a live GitHub call with a 12-second ceiling; an item that looked unchanged for ten seconds is the "nothing happens, then suddenly something happens" complaint of v3.11.0. |
| One click to the thing | When an update exists **and this build can install it**, the default button is **Download and Install** and it does exactly that. Where no engine is attached it is **Download…** and opens the release page the route chose. Every other dialog defaults to dismiss. |
| Progress on a long operation | The same menu item carries `Downloading Update… 43%` through five named phases, then `Installing Update…`. |
| Never two dialogs | An in-flight check refuses a second one, same shape as `quitCheckInFlight`. An in-flight **install** refuses one too, and refuses a second download with it. |
| Never an invisible dialog | The message box is window-modal **only when the window is actually on screen**. ⌘W leaves a hidden window behind; a sheet attached to it would be invisible and the app would look frozen with a permanently disabled menu item. |
| A dead end is never a dead end | Every failure carries the route's own actionable sentence plus an *Open Releases Page* button. |
| It works before the app is ready | The menu goes up before the port scan. `baseUrl` is still null, and `fetchUpdateCheck(null)` resolves to "wait a moment and try again" — which is exactly true. |

### The one coupling to the app's own markup

⌘, has to reach a view that lives in the renderer. There is no URL for it
(`src/public/next/app.js` restores its view from `localStorage` and reads
neither a hash nor a query string), and no IPC channel — `preload.js` exposes
nothing, and adding a `navigate` channel would need the renderer to listen for
it, which is a change in `src/`.

So the shell clicks the rail button the user would have clicked, through
`webContents.executeJavaScript`, keyed on `[data-view="settings"]`.

**This is not the case `main.js` rejects for `insertCSS`.** That rejection
turns on one property: an injected stylesheet cannot report whether its
selector matched, so the guard could only ever prove a *string* was inserted.
`executeJavaScript` **resolves with a value** — `main.js` checks it and shows a
named error pointing at the gear button when the element is not found. The
failure is loud and recoverable, not silent.

`data-view` is also the app's own routing primitive rather than a styling hook:
it is what the rail's click handler reads and what `renderRailActive()` matches
on. `scripts/test-desktop-menu.js` §10 carries a read-only tripwire that fails
if `src/public/next/app.js` stops emitting it, and the failure message says
what to change.

### Decisions worth not re-litigating

- **There is no File menu.** A File menu implies documents; The Curator has
  none. A File menu whose only member closes a window is the empty shell the
  default menu already was. ⌘W lives in Window.
- **⌘O was rejected** for "Add a source". It would navigate to the Ingest view,
  and a ⌘O that does not open a file picker is a lie about the shortcut.
- **Quit is `role: 'quit'`, never a hand-rolled `app.exit()`.** The role goes
  through Electron's normal shutdown, which is what fires `before-quit` — where
  `main.js` asks `GET /api/write-status` whether a paid, multi-minute ingest is
  in flight. A hand-rolled exit walks past that guard.
- **The Edit menu is function, not decoration.** Its roles are what install the
  ⌘X/⌘C/⌘V accelerators. Replace the default menu without them and clipboard
  actions stop working in the renderer — including the API-key fields, where
  pasting a key is the first thing anyone does.
- **DevTools stays.** In a packaged build there is no other way to answer
  "what does the console say?".
- **Help ▸ Show Logs** reads `getLogsDir()` from `src/brain/paths.js` rather
  than re-typing `~/Library/Logs/The Curator`. The app grew its own log file in
  v3.29.0 and the frontend button that reveals it was never wired, so until now
  nothing in the shipped product could open it.
- **The reveal item in Window has no accelerator.** The first draft claimed ⌘0,
  which `role: 'resetZoom'` already owns. §2 of the suite now walks the whole
  template — including the accelerators a *role* implies, which are invisible
  in the template — and fails on any collision.

---

## In-app updating

Two hooks on `src/brain/desktop-host.js`, `prepareUpdate` and `installUpdate`.
They belong to the `updateStyle: 'download-installer'` capability, which before
them could only open a release page in the user's browser and leave them to
drag a `.dmg` over their own application.

### electron-updater cannot be used, and this is what was measured

Read off the shipped v3.32.0 bundle, in `/Applications`:

```
$ codesign -d -r- "/Applications/The Curator.app"
# designated => cdhash H"…"

$ codesign -dv --verbose=4 "/Applications/The Curator.app"
flags=0x2(adhoc)   Signature=adhoc   TeamIdentifier=not set
```

On macOS `electron-updater`'s `MacUpdater` is a driver over Electron's own
`autoUpdater`, which is Squirrel.Mac. Squirrel.Mac takes the **running** app's
designated requirement and validates the downloaded bundle against it. An
ad-hoc signature has no certificate and no team, so `codesign` has nothing to
build a requirement out of except the code directory hash — the hash of *this
exact build*. Every genuine update has a different cdhash by definition, so the
check fails 100% of the time, deterministically. The check lives in Squirrel.Mac
inside Electron's binary, not in electron-updater's JavaScript, so no
configuration reaches it.

Two further blockers, each sufficient on its own:

- Squirrel.Mac installs from a **ZIP**. The releases publish two `.dmg` files
  and nothing else.
- electron-updater reads `latest-mac.yml`, which electron-builder emits only
  when `publish` is configured. `publish: null`.

### The design

1. **Resolve.** One unauthenticated GET to `RELEASES_API_URL` — *config.js's own
   exported constant* — then `pickInstallableRelease()` and
   `decideInstallerUpdate()`, *config.js's own exported functions*. There is no
   version comparator anywhere in `desktop/lib/`, and the suite asserts it. The
   only thing `update-release.js` adds is re-associating the chosen release's
   **assets** by tag, because the route's projection drops them.
2. **Download** with real byte progress, hashed as it streams.
3. **Verify** the byte length against the asset's declared `size` **and** the
   sha256 against the `digest` GitHub publishes on the asset (real, and
   populated: both DMGs of v3.31.0 and v3.32.0 carry `sha256:…`). Then, after
   staging, the bundle's own `CFBundleShortVersionString` and
   `codesign --verify --deep --strict`.
4. **Stage** beside the installed app. Creating that directory *is* the
   writability probe — `access(W_OK)` is not reliable under ACLs, so the engine
   creates the real directory in the real place and reports the real errno.
5. **Swap**, in a detached `/bin/sh` helper that waits for this process to exit.

### The swap, and what power loss leaves behind

`rename(2)` onto an existing non-empty directory fails with `ENOTEMPTY`, and
macOS's atomic directory swap — `renamex_np(…, RENAME_SWAP)` — is not reachable
from Node or from any shipped command-line tool. So the swap is two renames,
back to back, on paths that are siblings by construction (proved same-device
with `stat -f %d` first, so `mv` cannot fall back to a copy):

```
rename(TARGET -> BACKUP)     atomic, metadata only
rename(STAGED -> TARGET)     atomic, metadata only
```

| When power is lost | What is on disk |
|---|---|
| before the first rename | the old app, complete. Nothing changed. |
| **between the two renames** | `The Curator.app` is **absent**. Both complete bundles sit beside it as `.the-curator-backup-…app` and `.the-curator-update-…/`. Neither is half-written — both were fully written and verified before the app quit, and `rename` moves no bytes. Recovery is one `mv`. |
| after the second rename | the new app, complete. A leftover backup may survive; the next update sweeps it. |

That middle window is two syscalls wide and is the only state in the design
that needs a human. It buys the property that a **half-replaced bundle is
impossible** — an app that exists at the right path and will not launch is a
much worse outcome than a missing one, because the user cannot tell what
happened and has nothing to drag back. Every other failure rolls back and
reopens the old app.

### Quarantine: a real benefit, measured with a control

`com.apple.quarantine` is applied by the *downloading application* through
LaunchServices, not by the kernel. Measured:

| Source | Extracted bundle |
|---|---|
| a `.dmg` stamped with `com.apple.quarantine` (what a browser download is) | **quarantined** |
| a `.dmg` fetched by this app's `fetch()` | **not quarantined** |

So the swapped-in app opens with no Gatekeeper prompt and is never App
Translocated — the thing that makes a hand-installed unsigned build unpleasant.
Both arms are asserted in `scripts/test-desktop-update-macos.js`; the first is
the control that stops the second being vacuous.

### What changes the day a Developer ID exists

Everything, and that is why the surface is two functions. Enrol; set
`mac.identity`; add a `zip` target beside `dmg`; set `publish: github` so
`latest-mac.yml` is emitted; add `electron-updater` to `desktop/package.json`;
register the two hooks against `autoUpdater` instead of against
`lib/update-engine.js`. `lib/adhoc-sign.mjs` already turns **itself** off the
moment a real identity appears. **Nothing in `src/` changes**, because nothing
in `src/` knows how an update is performed — only that a hook exists.

### Not proven

- **No application has ever been replaced by an automated run.** Both suites
  work on fixture bundles in temp directories. The macOS suite really does swap
  a real, ad-hoc-signed bundle — but it is a fixture, not an install, and its
  relaunch step is stubbed so nothing is ever launched.
- **The download has never run against GitHub.** The suites serve the `.dmg`
  from disk through an injected fetch. Streaming, hashing, truncation,
  cancellation and every refusal are proven; the 140 MB round trip is not.
- **The two-syscall window is not measured**, only reasoned about. The suite
  asserts that no statement sits between the two renames, which is the part
  under this code's control.
- **`main.js` is source-scanned, never executed.** Electron is not an
  offline-suite dependency, so the wiring — `runCommand`, `spawnDetached`,
  `quitApp`, and the `buildUpdateEngine()` imports — has never run.
- **Rosetta is not accommodated.** An arm64 Mac running the x64 build reports
  `process.arch === 'x64'` and stays on the x64 build forever. Detecting
  translation and silently installing a different architecture from a progress
  bar is an architecture migration wearing an update's clothes; it belongs in
  an explicit, one-time offer in the UI.

---

## Credentials

The repository is **public**. No signing certificate, notarization credential,
App Store Connect key, Apple ID or app-specific password may enter this folder,
the build config, the workflow, or a comment — not even as an example value.
They are referenced by **GitHub Actions secret name only**, and
`scripts/test-desktop-packaging.js` scans everything added here for
credential-shaped literals.

`.gitignore` covers the local credential and build-output paths **before**
anything can produce one.
