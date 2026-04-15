# Mac App — The Curator

The Curator includes a native macOS app wrapper that lives in your Dock. Double-click to launch — no Terminal needed.

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

You click **Check for Updates** in the Settings tab and apply an update.

1. The frontend calls `/api/config/update` which runs `git pull`, `npm install`, and `bash scripts/build-app.sh` (rebuilds the .app with the current node path)
2. The frontend then calls `/api/restart`
3. The server spawns a new process using `process.execPath` (the absolute path to the running Node binary) and exits
4. The frontend polls for the new server and reloads automatically

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
| View logs (if something goes wrong) | `cat /tmp/the-curator.log` |

> **Closing the browser tab does not stop the server.** The server continues running in the background using virtually no CPU. This is normal and intentional — click the Dock icon to reopen.

---

## Rebuilding the app

If the app gets corrupted, or you moved the project folder, rebuild it from Terminal:

```bash
cd ~/the-curator
bash scripts/build-app.sh
```

This regenerates the AppleScript with the correct project path and node path, compiles it, applies the icon, and code-signs the bundle.

The build script also runs automatically during updates (via the Settings tab).

---

## Troubleshooting

**"The Curator could not start" dialog appears**

Check the log first:
```bash
cat /tmp/the-curator.log
```

The most common causes:

| Log message | Cause | Fix |
|-------------|-------|-----|
| `nohup: node: No such file or directory` | Node.js path changed (e.g. after an upgrade or nvm switch) | Rebuild the app: `bash scripts/build-app.sh` |
| `Error: No LLM API key found` | No API key configured | Open `http://localhost:3333` manually — the onboarding wizard will prompt for your key |
| `EADDRINUSE: address already in use :::3333` | Another process is using port 3333 | Run `lsof -ti :3333 \| xargs kill -9` then try again |

**The Dock icon bounces but nothing happens**

The app is waiting for the server to start (up to 20 seconds). If the server can't start, a dialog appears after the timeout. Check `/tmp/the-curator.log` for the error.

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
