# `desktop/` — Electron packaging scaffold

**Nothing in this folder has ever been installed, built, or run.**

There is no `node_modules/`, no `package-lock.json`, and Electron is not on
this machine. Every claim in these files was established by **reading the
app's source**, not by executing anything. Read that sentence again before
trusting a line of it.

This is the *structure and configuration* for a future desktop build. It is
committed unbuilt on purpose, so the reasoning is reviewable before anyone
downloads 200 MB of toolchain.

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

The three `lib/` modules import **nothing** from Electron and nothing from
`src/`, which is what lets `scripts/test-desktop-packaging.js` run them for
real. `main.js` itself can only be source-scanned — Electron is not installed —
and the suite says so in its own NOT ENFORCED block rather than implying
otherwise.

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

## What is NOT done

Do not read this folder as "nearly a DMG".

- **Nothing is installed.** No `npm install` has been run here. The declared
  versions (`electron ^43`, `electron-builder ^26`) are **unverified** — they
  come from the plan, not from a resolution. The first install may need to move
  them.
- **Nothing has been built or launched.** `main.js` has never been executed by
  Electron. The `files` mapping in `electron-builder.yml` is the most likely
  thing to be wrong.
- **No signing.** No Apple Developer enrolment, no Developer ID certificate, no
  hardened runtime, no entitlements. `mac.identity: null` forces an explicitly
  unsigned build so electron-builder cannot silently produce a locally-signed
  artifact that runs on exactly one Mac.
- **No notarization.** Requires paid enrolment. There is no `afterSign` hook.
- **No `electron-updater`.** Not installed, not wired, `publish: null`. The
  first DMG is a local artifact by design.
- **No first-launch adoption of an existing repo install.** A user with a
  checkout and a DMG would end up with two installs pointing at one
  `domains/` folder and no migration story.
- **No app icon**, no menu, no About panel, no crash reporting.
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

### Known changes needed in `src/` (not made here — out of this change's scope)

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
- **The desktop manifest's version is `0.0.0`.** The DMG's version has to come
  from somewhere; `.github/workflows/desktop-dmg.yml` injects the tag via
  `--config.extraMetadata.version`. If that ever changes, the two manifests
  need a real sync rule.

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
