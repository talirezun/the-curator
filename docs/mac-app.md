# Mac App — The Curator

The Curator includes a macOS app wrapper that lives in your Dock. Double-click to launch — no Terminal needed.

> **What this page describes is what ships today: an AppleScript wrapper around a
> normal checkout**, built on your own machine by the installer. It is not a
> downloadable, signed application, and **there is no `.dmg` to download.**
>
> A properly packaged Mac app is being worked on. Nothing on this page describes
> it, and nothing here is deprecated by it — the decisions taken so far, and
> exactly which of them have code behind them, are recorded in
> [desktop-app-decisions.md](desktop-app-decisions.md). If you want to know what
> will change for *you*, that is
> [§ Migration](desktop-app-decisions.md#4-migration-for-existing-users).

**In one line:** the thing in your Dock is a small launcher. Your knowledge lives
in the `domains/` folder as plain markdown, completely independent of it — which
is why replacing the launcher later costs you nothing.

---

## How it gets built

The **installer** (`install.sh`) builds The Curator.app automatically as part of installation. You do not need to create it manually. The app is a compiled AppleScript applet that manages the Node.js server behind the scenes.

If you used the one-command installer, the app is already at `~/the-curator/The Curator.app`.

---

## How it works

The app is a "stay-open" AppleScript applet. It handles three scenarios:

### Scenario 1 — Fresh start (app is not running)

You double-click **The Curator** in your Dock or Finder.

1. The `on run` handler checks if the server is already running (via `curl`)
2. If not running, it calls `doStart()`:
   - Kills any stale process on port 3333
   - Launches Node.js using its **absolute path** (resolved at build time)
   - Polls `http://localhost:3333` every second (up to 20 attempts)
   - Once the server responds, opens your browser
3. If already running, it simply opens the browser

### Scenario 2 — Reopen (browser tab was closed)

You closed the browser tab but the server is still running in the background. You click the Dock icon.

1. The `on reopen` handler checks if the server is responding
2. If yes, opens the browser — that's it
3. If the server has stopped for any reason, it calls `doStart()` to restart it

### Scenario 3 — Update and restart

You click **Check for updates** in the **Settings** view (reached from the left rail's footer) and apply an update.

1. The frontend calls `/api/config/update` which runs `git fetch origin main` + `git reset --hard origin/main`, then `npm install`, then `bash scripts/build-app.sh` (rebuilds the .app with the current node path). It hard-resets rather than pulling because `npm install` regenerates `package-lock.json` with machine-specific diffs, which makes a plain `git pull` abort — the reasoning is in the `POST /api/config/update` docblock in `src/routes/config.js`
2. The frontend then calls `/api/restart`
3. The server spawns a new process using `process.execPath` (the absolute path to the running Node binary) and exits
4. The frontend polls for the new server and reloads automatically

---

## Updates in the packaged app

A checkout replaces its own files (`git fetch` + `git reset --hard` + `npm install`
+ a restart). **A packaged app cannot**, and does not pretend to: it is read-only,
has no `.git` and no `node_modules` to install into, and re-running
`scripts/build-app.sh` would destroy a real code signature. The capability record
in `src/brain/install-mode.js` says so by name — `canSelfUpdateViaGit: false` —
and `POST /api/config/update` refuses with a `501`.

So **Settings → Software update** does something different there, and the section
says which before you click anything:

1. **Check for updates** calls `GET /api/config/update-check`, which — because the
   install's `updateStyle` is `download-installer` — reads GitHub's public release
   list instead of a git branch. One unauthenticated `GET`, no credentials, no
   personal data, an 8-second timeout.
2. It selects **the newest release that actually carries an installer** and
   compares that version with the one you are running.
3. If yours is older you get **Update available**, the release name, and a link
   that opens the download page in your own browser. You download the disk image
   and run it; it replaces the app in `/Applications`. Nothing is downloaded or
   installed for you.
4. If yours is current, or newer than anything published, or nothing installable
   has been published at all, or the check could not reach GitHub — you get four
   **different** messages. "You're up to date" and "we couldn't check" never share
   wording.

**Automatic download and install are deliberately not built.** `electron-updater`
needs a signed, notarized app and a paid Apple Developer enrolment; until those
exist, an updater that silently swaps an unsigned binary is worse than a link.

### Why a pre-release can be offered

GitHub's `/releases/latest` means *newest release that is neither a draft nor a
pre-release*. Measured against this repository on 2026-08-31:

| Query | Answer | Carries an installer? |
|---|---|---|
| `/releases/latest` | `v3.9.0` | **No** — zero assets |
| `/releases` | 5 releases; exactly one has a `.dmg` | `v3.30.0`, flagged **pre-release** |

Excluding pre-releases would therefore have told every packaged user they were
*ahead of the published version*, permanently, and — if it had ever offered
anything — pointed them at a page with nothing to download. The rule is instead
**newest release with an installer**, and the pre-release status is shown in the
status box rather than hidden. Today the only way to have the Mac app at all is an
unsigned preview build, so hiding that would be the dishonest half of the trade.
When signed stable builds start shipping they become the newest installable
release with no code change.

### Going back to an earlier version

There is no in-app rollback, and the panel behind the ⓘ next to *Software update*
does not claim one. Going back means installing an older build the same way you
installed this one — and **only releases that carry a download can be
reinstalled**. Check
[the releases page](https://github.com/talirezun/the-curator/releases) to see which
ones do before relying on it. Your knowledge base, API keys and sync settings are
stored outside the app and are untouched by installing, reinstalling or deleting
it.

---

## Adding to Dock

After installation:

1. Open **Finder**
2. Press `Cmd + Shift + G` and type: `~/the-curator`
3. Drag **The Curator** to your Dock

---

## How to use it

| Action | How |
|--------|-----|
| Start the app | Click the Dock icon |
| Reopen after closing the tab | Click the Dock icon again |
| Fully quit | Right-click the Dock icon → **Quit** |
| View logs (if something goes wrong) | `cat "$HOME/Library/Logs/The Curator/curator.log"` |

> **Closing the browser tab does not stop the server.** The server continues running in the background using virtually no CPU. This is normal and intentional — click the Dock icon to reopen.

---

## Rebuilding the app

If the app gets corrupted, or you moved the project folder, rebuild it from Terminal:

```bash
cd ~/the-curator
bash scripts/build-app.sh
```

This regenerates the AppleScript with the correct project path and node path, compiles it, applies the icon, and signs the bundle **ad-hoc** (`codesign --sign -`, an identity-less signature that satisfies macOS locally). It is **not** a Developer ID signature, which is why a rebuild is safe here and would be destructive in a properly signed app.

The build script also runs automatically during updates (via the **Settings** view).

---

## What changes when the packaged app arrives

**Not yet — none of this exists today.** It is here so the answer to "will I lose
my wiki?" is written down rather than guessed at. The reasoning behind each row
is in [desktop-app-decisions.md](desktop-app-decisions.md).

| | Today (this page) | Packaged app (planned) |
|---|---|---|
| **What you install** | The installer clones the repo and builds a `.app` **on your machine** | A signed application you download |
| **Where your knowledge lives** | Inside the checkout, at `~/the-curator/domains/` | Anywhere you point it — the app cannot write inside itself |
| **Updates** | Settings → Check for updates runs `git` against the checkout | Settings → Check for updates reads GitHub's **release list** and, if a newer downloadable build exists, opens its page — **you** run the installer. The git route still refuses with a `501`. See [§ Updates in the packaged app](#updates-in-the-packaged-app) |
| **Rebuilding the `.app`** | `bash scripts/build-app.sh`, as above | Never — the ad-hoc `codesign` above would destroy a real signature |
| **Your files** | Plain markdown in `domains/` | **Identical.** Same files, same folder, same Obsidian vault |

**What you would have to redo, and what you would not:**

| ✅ Comes across untouched | ⚠️ You redo it once |
|---|---|
| Every wiki page, domain and summary | Paste your API key again |
| Chat history and working state | Reconnect Personal Sync, if you use it |
| Your Obsidian vault and graph settings | Re-run the MCP wizard, if you use it |

The one thing that must work is that **your existing wiki appears**, and that
needs no new code at all — the wiki is plain markdown, and Settings → Knowledge
base folder already points the app at any folder you choose. **Credentials are
deliberately not migrated**; that decision, and why re-typing a key beats writing
a one-shot importer for three secret files, is
[D11](desktop-app-decisions.md#d11--credentials-do-not-migrate).

---

## Troubleshooting

**"The Curator could not start" dialog appears**

Check the log first:
```bash
cat "$HOME/Library/Logs/The Curator/curator.log"
```

The most common causes:

| Log message | Cause | Fix |
|-------------|-------|-----|
| `nohup: node: No such file or directory` | Node.js path changed (e.g. after an upgrade or nvm switch) | Rebuild the app: `bash scripts/build-app.sh` |
| `Error: No LLM API key found` | No API key configured | Open `http://localhost:3333` manually and paste a key into **Settings → API Keys**. The first-run panel points you there; it is dismissible and never blocks the app |
| `EADDRINUSE: address already in use :::3333` | Another process is using port 3333 | Run `lsof -ti :3333 \| xargs kill -9` then try again |

**The Dock icon bounces but nothing happens**

The app is waiting for the server to start (up to 20 seconds). If the server can't start, a dialog appears after the timeout.

**Two logs exist and they answer different questions.** The app writes its own log at
`~/Library/Logs/The Curator/curator.log` — startup facts, provider and model, update outcomes,
and errors it could catch. But a failure that happens *before* the server is running
never reaches it, because nothing is there to write it yet. For that case check
`/tmp/the-curator.log`, which is the launcher's raw stdout capture.

**I moved the project folder**

The app has the old path embedded. Rebuild it from the new location:
```bash
cd /new/path/to/the-curator
bash scripts/build-app.sh
```

**I upgraded Node.js (or switched versions with nvm/fnm)**

The app has the old Node.js path embedded. Rebuild it:
```bash
cd ~/the-curator
bash scripts/build-app.sh
```

The build script resolves the current `node` path and embeds it in the app.

**The icon doesn't appear in the Dock**

macOS caches icons. Force a refresh:
```bash
killall Dock
```
