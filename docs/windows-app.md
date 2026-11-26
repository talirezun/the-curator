# The Windows app — The Curator

## Download

**[Download The Curator for Windows](https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe)** (Windows 10 or 11, 64-bit)

1. **Open the downloaded file** (`TheCurator-Windows-Setup.exe`, in your Downloads folder).
2. **A blue screen appears: "Windows protected your PC".** Click **More info** (the small link under
   the text), then **Run anyway**. Windows shows this because the app is not code-signed yet.
3. **Click Next, wait a moment, then click Finish.** The Curator opens in its own window.

That is the whole install: no administrator rights, no folder to choose, nothing else to download.
The app's [Getting started panel](user-guide.md#5-first-run--the-getting-started-panel) then helps
you add a key from an AI company. From then on **the app updates itself** ([§ Updating](#updating)).

*The download link always gives you the newest version. It works from version 4.1.0 on; every
file of every version is also on the [Releases page](https://github.com/talirezun/the-curator/releases).*

---

## What it is

The Curator for Windows is a normal Windows program in its own window. It carries everything it
needs, including its own copy of git for Sync, so there is nothing else to install and no terminal
to open.

| | |
|---|---|
| **Works on** | Windows 10 or Windows 11, 64-bit (x64). There is no ARM build yet, and the x64 build has not been tried on an ARM PC. |
| **Administrator rights** | Not needed. It installs for your Windows account only. |
| **Also needs** | An API key from an AI provider ([how to get one](user-guide.md#4-get-your-api-key-gemini-claude-or-openrouter)). Nothing else: no Node.js, no Git for Windows. |
| **Code signing** | Not signed yet, so Windows warns you once, on the first install ([below](#the-blue-windows-protected-your-pc-screen)). |

**Which Windows install should I use?** There are two, and they are the same program:

| | **The Windows app** (this page, recommended) | **The one-line browser installer** ([install-windows.md](install-windows.md)) |
|---|---|---|
| How you install it | [Download the installer](https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe) and open it | Paste one line into PowerShell |
| Where it appears | Its own window | A tab in your browser at `http://localhost:3333` |
| Tray icon | Optional ([§ The tray icon](#the-tray-icon)) | None |
| Updates | From inside the app: it downloads and installs the new version and reopens | Settings → Update, or the same PowerShell line again |
| Your notes live in | `%LOCALAPPDATA%\TheCurator\App\domains` (or any folder you choose) | `%USERPROFILE%\the-curator\domains` (or any folder you choose) |

You can have both on one PC; see [§ Switching from the browser install](#switching-from-the-browser-install).
On a Mac, use [the Mac app](mac-app.md). On Linux, use the [manual install](user-guide.md#manual-setup-alternative--linux-or-technical-users-on-mac-and-windows)
or [let your coding agent do it](user-guide.md#20-install-with-a-coding-agent).

---

## The install, screen by screen

1. [Download the installer](https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe) and open it. Windows shows a blue screen first: see the next
   section.
2. The installer has three pages:

| Page | What you do |
|---|---|
| **Welcome** | Click **Next** |
| **Installing** | Wait. There is no folder to choose and no administrator prompt. |
| **Finish** | Leave **Run The Curator** ticked and click **Finish**. The app opens. |

The app's own [Getting started panel](user-guide.md#5-first-run--the-getting-started-panel) takes over from there.

You get a **The Curator** shortcut on the Desktop and in the Start menu, and the app is listed in
**Settings → Apps → Installed apps** (Windows 10: **Apps & features**) as **The Curator**.
**You only download it once:** after that the app updates itself.

### The blue "Windows protected your PC" screen

The installer does not carry a paid code-signing certificate yet, so Windows cannot tell you who
made it and SmartScreen stops it the first time:

| You see | You do |
|---|---|
| **Windows protected your PC** · *Microsoft Defender SmartScreen prevented an unrecognized app from starting* | Click **More info** (the small link under the text) |
| The same screen, now naming the file and *Publisher: Unknown publisher* | Click **Run anyway** |

That is the whole of it. A signature is a statement about who built the file, not a verdict on
it. Some antivirus products are also wary of unsigned installers; if yours removes the file, allow
it and download it again.

---

## Where everything is

| What | Where | Removed by an update or an uninstall? |
|---|---|---|
| The program | `%LOCALAPPDATA%\Programs\The Curator` | Replaced by every update, removed by uninstall |
| Your knowledge (domains), API keys, settings, Sync's history | `%LOCALAPPDATA%\TheCurator\App` (the knowledge itself in `…\App\domains`, unless you chose another folder) | **No, never** |
| Logs (`curator.log`, `update-install.log`) | `%LOCALAPPDATA%\TheCurator\logs` | No |
| Downloaded updates | `%LOCALAPPDATA%\TheCurator\updates` | Tidied by the app itself |
| Window size and position | `%APPDATA%\The Curator` | No |

Type any of these into the address bar of File Explorer to open it. Your knowledge is plain
markdown, so you can also open the `domains` folder in [Obsidian](user-guide.md#12-see-your-knowledge-graph-in-obsidian).

**Why your data is not in the program folder.** Windows lets you write into your own program
folder, and the installer replaces that folder on every update and deletes it on uninstall.
So the app keeps nothing of yours there, and it refuses a knowledge folder inside it
(`folder-inside-app` in [the error catalogue](errors.md#choosing-a-folder-on-windows)). It also
refuses one inside its own working folders, which it tidies itself: `%LOCALAPPDATA%\TheCurator`
anywhere outside `App`, the `App` folder itself (its `domains` folder is fine), and
`%APPDATA%\The Curator`. The check follows every spelling of a folder: a short name such as
`THECUR~1`, a junction or link that leads there, and `\\localhost\C$\…` all count. The update
tidy-up deletes only the update files it downloaded itself, never a folder. The installer also
refuses to install into, or uninstall from, the data folder.

**If the folder already set breaks these rules** (set before this check existed, or by hand), the
app reads and writes nothing in it, and the Domains page says why. Nothing is moved or deleted:
move the folder with File Explorer to one in your user folder, then choose it again. A folder
setting that is not a full path (no drive letter) is treated the same way.

**If the program files are incomplete,** the app does not start at all. It shows *The Curator
could not start* and exits, because without them it could not tell your notes apart from the
program and might keep them inside the program folder. Nothing is read or changed: download the
installer again and run it, and the new copy finds your notes and settings.

**How your keys are protected.** Your API keys and GitHub token are in files inside
`%LOCALAPPDATA%`, which Windows lets only your own account (and administrators) read. That is the
same protection the browser install has. One known gap, on every platform: while Sync connects,
or saves a replaced token, the token is on git's command line for a moment, where another program
running under your own account could read it.

---

## Simple and Pro

*Since v4.2.0.* The app opens in the **simple** view. The **Pro** switch on the left rail, directly
above **Settings** (also **Settings › General › Pro mode**), shows every detail and control. It is
free, it only reveals (no warning, cost or result is ever hidden in the simple view), it is saved on
this PC only (in `%LOCALAPPDATA%\TheCurator\App`, with your other settings), and today it changes the
Context page's steps 4 and 5. Full description: [user guide §7c](user-guide.md#7c-simple-and-pro).

---

## Updating

The app updates itself. There are two ways in, and they run the same update:

- **Settings → General → Software update → Check for updates**
- **Help → Check for Updates…** in the menu

| Step | What happens |
|---|---|
| **Update available** | Both version numbers. Click **Download and install** and confirm. |
| **Downloading and checking** | The installer goes to `%LOCALAPPDATA%\TheCurator\updates`. Its size and SHA-256 must equal what GitHub publishes for the file, and its version must be the one offered; a download that fails a check is never run. |
| **Update ready to install** | Nothing has changed yet. Click **Restart and finish**. |
| **Installing** | The app starts a small helper and closes only once the helper is running. The helper checks the installer's size and SHA-256 once more, runs it without any pages, and The Curator opens again on the new version. |

Your notes, keys and settings are not in the program folder, so an update never touches them.

**If Claude Desktop is connected to The Curator.** Claude Desktop keeps a copy of The Curator
running as its connection to your knowledge (the MCP bridge), and Windows cannot replace a program
that is running. The update then stops before changing anything and offers:

| Choice | What it does |
|---|---|
| **Close the connection and update** | The Curator ends that connection itself, then installs. Quit Claude Desktop and open it again afterwards to reconnect. |
| Quit Claude Desktop (tray icon → Quit), then **Restart and finish** again | The same result, done by you |

If the helper cannot start, the app stays open, keeps the downloaded installer and says so; nothing
has changed. If the helper itself fails before the installer runs, the old version opens again and a
message box says the update did not finish. Every step is written to `%LOCALAPPDATA%\TheCurator\logs\update-install.log`,
which is the file to send us if an update fails.

**If an update does not finish**, The Curator says so in a message box and again when it next
opens, in words, with what to do ([all the messages](errors.md#updating-the-windows-app)). The
verified installer stays in `%LOCALAPPDATA%\TheCurator\updates`; running it again from there
repairs the app. An
update replaces the program's files in one step and cannot be rolled back halfway, so a power cut
in the middle can leave the program incomplete. Your data is untouched in that case too: download
[the installer](https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe) again and run it, and the app is back with everything in it. Before
it runs a downloaded installer again, the app checks its SHA-256 again.

**Known limits, so you can avoid them:**

| Situation | What can happen | What to do |
|---|---|---|
| You sign out of Windows, or run the installer by hand, while The Curator is saving (an ingest, a compile, a Sync) | Windows closes the app without waiting, so that one save can be cut short. Your other pages are not affected. | Let the save finish first. If one was cut short, run the ingest again. |
| **Close the connection and update** while your agent harness is saving to your wiki | Ending the connection stops that save part-way | Wait until the agent harness has finished saving, then update |
| Your Windows user folder has an apostrophe in its name (`C:\Users\O'Brien`) and you run the installer **by hand** | The installer may not notice that The Curator is still open | Quit The Curator (tray icon → Quit, or **File → Exit**) before running the installer. Updates from inside the app are not affected: the app closes itself first. |

> **Seen on a real PC:** an update from inside the app, 4.0.0 → 4.0.1, was confirmed on a real
> PC on 2026-11-21, with no security prompt (no SmartScreen screen). Every release also rehearses
> an update in CI (install, check, close, silent install, reopen; your data byte-identical). If you
> do see the SmartScreen screen, choose **More info → Run anyway** and please
> [tell us](https://github.com/talirezun/the-curator/issues).

---

## The tray icon

The app can show an icon in the notification area (by the clock) that answers one question without
opening the window: **has my agent actually saved, and how long ago?** It carries the same facts as
the Mac app's menu bar icon ([User Guide § 6b](user-guide.md#6b-the-menu-bar-icon-mac-app)): the
save pulse, the last 24 hours' active work, your domains, and Open The Curator · Settings · Quit.

| | |
|---|---|
| Turn it on | **Settings → General → Tray icon → Show the tray icon**. It is off by default. |
| The icon | A ring, as on the Mac: **empty** while The Curator is running, with a **filled centre** while an agent is saving working state on this PC (within the last two minutes). White on a dark taskbar, black on a light one. |
| **Left-click** the icon | Opens the **popover**: a small panel above the clock with everything the Mac menu shows, in the same order, with the same pictures (the save pulse at twice its size, the coloured freshness dots, each domain's bar in its own colour) and each item's second line under it. An item with a **›** opens its own page inside the panel (a project's actions and its details, the saves by tool, your domains); **‹** goes back. Click the icon again, press **Esc**, or click anywhere else to close it. It follows Windows' light or dark mode. **Open The Curator** opens the window. |
| Keyboard | **Win+B** then the arrow keys reach the icon; **Enter** opens the popover. **↑ ↓** move, **→** or **Enter** opens a page, **←** or **Backspace** goes back, **Esc** goes back or closes. |
| **Right-click** the icon | Opens the classic Windows menu with the same facts (as in 4.0.1). Windows menus cannot show a second line or hover text, so a second line follows the label after " — ", and the details the Mac shows on hover open in a submenu when you point at the item (or are listed at the end of the submenu the item is in). |
| If the popover cannot open | That click opens the classic menu instead (a click always opens one or the other), and one line is written to `curator.log`. If that happens twice in a row, the left click opens the classic menu for the rest of the session; a popover that opened in between starts the count again. |
| Can't see it? | Windows often puts a new icon with the hidden ones. Click the **^** arrow beside the clock, and drag the icon onto the taskbar to keep it in view. |
| Close the window (X) **with the tray icon on** | The window hides; the app keeps running in the tray. Quit from the popover or the tray menu (**Quit The Curator**), or **File → Exit**. Quitting from the popover asks first if a write is running, as every quit does. |
| Close the window (X) **with the tray icon off** | The app quits. If an ingest or another write is running, it asks first (**Quit now?**), with the window still open; **Keep working** keeps it open. |

The taskbar button always stays. The Mac app has an extra choice to hide its Dock icon; Windows
has no such setting, because Windows often hides a new tray icon and an app with neither would be
hard to get back to. (A copy of that choice saved by an earlier test build simply shows the tray
icon.)

---

## Connecting Claude Desktop (one click)

The app can write its own entry into Claude Desktop's settings for you:

1. **Quit Claude Desktop fully**: right-click its icon by the clock → **Quit** (closing its window is not enough).
2. In The Curator: **Settings → MCP bridge**, section **Agent harnesses**. Tick Claude Desktop and click **Install for me**, then **Apply**.
3. Open Claude Desktop again, then click **Check again** in The Curator; the row should read **connected**.

**Context → a project → Setup agrees (v4.1.2).** The project Setup check reads Claude Desktop's Windows
settings file from every place the installer looks (under `%APPDATA%` and `%LOCALAPPDATA%`), and
shows paths in those words, such as `%APPDATA%\Claude\claude_desktop_config.json`. Before v4.1.2 it
looked only for the Mac's file and said "no config file found" after a successful install. On Windows
there is no **Reveal** button (it opens Finder, a Mac-only window); open the path the row names in File
Explorer instead. The **my-curator.zip** and **curator-continuity.zip** skill downloads work on
Windows too.

The entry starts The Curator's own program (`The Curator.exe`) as the bridge, with the setting
`ELECTRON_RUN_AS_NODE=1` that makes it run as a background helper instead of opening a second
window. You never need to type it. Install for me refuses, with the reason, when the app runs from
Downloads or a temporary folder (a path that would later disappear): install it with the installer
and open it from the Start menu. All of the reasons, and what each row can say, are in
[the MCP guide § Setup](mcp-user-guide.md#setup-under-2-minutes).

**Every other AI tool** (Claude Code, Cursor, Codex, Gemini CLI and the rest) is copy and paste on
Windows: **Copy the setup text** on that tool's row, and paste it into the file the row names. The
copied text already includes the `ELECTRON_RUN_AS_NODE` setting.

> **Not measured yet:** an automated test that runs on Windows starts the entry and checks that it answers, but
> Claude Desktop itself starting it has not yet been watched on a real PC. If **Test connection**
> fails, please [tell us](https://github.com/talirezun/the-curator/issues).

---

## Sync works out of the box

Personal Sync (backing your knowledge up to a private GitHub repository, [User Guide § 15](user-guide.md#15-sync-across-computers))
needs git, and the Windows app brings its own: **MinGit 2.56.1** from the
[Git for Windows](https://gitforwindows.org/) project, inside the program folder at
`resources\git`. You do not need to install Git for Windows. If you have it anyway, the app still
uses its own copy first, and so does everything else in the app that runs git (Shared Brain, the
setup check, the agents' working state and the `my-curator` command line).

- It does not open a sign-in window: the app's token travels with each request, so a rejected token
  is a plain message with **Replace token**, not a Windows sign-in window.
- It trusts the certificates Windows trusts, so a company network's own certificates work.
- It handles file paths longer than Windows' old 260-character limit.
- If the copy is damaged or removed, Sync and **Run system check** say so; running the latest
  installer again puts it back and keeps your notes and settings.
- No console window flashes while Sync runs git (v4.1.2).
- Line endings are never converted: a repository Sync creates from v4.1.2 on is set so that a page
  pushed from a Mac arrives with the same bytes. A repository connected before v4.1.2 is left as it
  was, because changing it would make every page look changed.
- Folder names with `%`, `$`, quotes or a network share root no longer break Sync (v4.1.2).
- **The knowledge folder can't change while Sync is connected** (v4.1.2): disconnect Sync, change the
  folder, then connect again. See [User Guide § 16 → Knowledge base folder](user-guide.md#knowledge-base-folder).

---

## Choosing a folder

The knowledge folder is set in **Settings → Knowledge base → Choose folder** (Windows' own folder
dialog), or by pasting a path. The app checks the folder before it uses it, and says in words what
is wrong. Every message is in [the error catalogue → Choosing a folder on Windows](errors.md#choosing-a-folder-on-windows).

| Situation | What the app does | What to do |
|---|---|---|
| A folder in **OneDrive** | Works. When OneDrive, an antivirus scan or the search indexer holds a file for a moment, the save waits and tries again for up to about 3 seconds (v4.1.2). While OneDrive is syncing, or not running, a save can still be refused with a OneDrive message. | Wait until OneDrive shows the folder up to date, or keep it **Always on this device** |
| **Controlled folder access** (Windows Security) is on, and the folder is in Documents, Desktop, Pictures, Music or Videos | Windows blocks the save; the app says so | Choose a folder outside those, or allow The Curator in **Windows Security → Virus & threat protection → Manage ransomware protection → Allow an app through Controlled folder access** |
| A **long path** | Over 120 characters: accepted with a warning. Over 247: refused. | Choose a folder near the top of the drive, for example `C:\Users\<you>\Curator` |
| A **reserved name** (CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9) or a name ending in a dot or a space | Refused | Rename the folder, or choose another |
| A **whole drive** (`D:\`) | Refused | Make a folder on it (`D:\Curator`) and choose that |
| A **network folder** | Works while it can be reached; otherwise refused with a network message | Check the connection to the share |
| A folder inside the **program folder**, or inside the app's own working folders (`%LOCALAPPDATA%\TheCurator` outside `App\domains`, `%APPDATA%\The Curator`), however it is spelled | Refused (updates replace or tidy them) | Choose a folder in your user folder |
| A path with **no drive letter** (`notes\wiki`) | Refused | Choose the folder in the dialog, or paste the full path |
| A **read-only** folder | Refused | Choose a folder you can change |
| The same folder typed in **another case** (`c:\users\ana\wiki`) | Used under its real name | Nothing |

Spaces and letters such as é, č and ž are allowed in folder names. A new domain whose name Windows reserves, or that differs from an existing one only in case (`Notes` beside `notes`), gets a folder with a number added (`con-2`, `notes-2`).

---

## Uninstalling

**Settings → Apps → Installed apps → The Curator → Uninstall** (Windows 10: **Apps & features**).
This removes the program and its shortcuts and nothing else. Your knowledge, keys and settings
stay in `%LOCALAPPDATA%\TheCurator\App`, so installing again later brings everything back.

To remove your data as well, delete `%LOCALAPPDATA%\TheCurator\App` after uninstalling (and your
knowledge folder, if you chose one elsewhere). **Do not delete the whole `%LOCALAPPDATA%\TheCurator`
folder if you also have the browser install:** its private Node.js and git live there, in `runtime`.

---

## Switching from the browser install

The two installs can live side by side. Each keeps its own settings, and they do not copy anything
from each other.

| | Windows app | Browser install |
|---|---|---|
| Shortcut names | **The Curator** | **The Curator (browser)** and **Stop The Curator (browser)** when the app is installed (otherwise without "(browser)") |
| Knowledge folder | `%LOCALAPPDATA%\TheCurator\App\domains` | `%USERPROFILE%\the-curator\domains` |
| API keys and settings | `%LOCALAPPDATA%\TheCurator\App` | `%USERPROFILE%\the-curator` |
| Remove it | Installed apps → Uninstall | Delete `%USERPROFILE%\the-curator` |

**To use the knowledge you already have in the app:**

1. Double-click **Stop The Curator (browser)**, so the browser install is not running.
2. Open the app. In **Settings → Knowledge base → Choose folder**, pick `%USERPROFILE%\the-curator\domains`.
   Nothing is copied or moved: the app now works on the same files.
3. Paste your API key again in **Settings** (keys are never copied between installs).
4. If you used Personal Sync: connect Sync in the app to the **same** repository, with a GitHub
   token. The app finds the browser install's sync history next to that folder and carries on with
   it, instead of starting a second history over the same files. If you later replace the token in
   one install, replace it in the other too.
5. Press **Install for me** in **Settings → MCP bridge**, so Claude Desktop starts the app's bridge
   instead of the browser install's (Claude Desktop holds one My Curator entry).

**Run one of them at a time.** Two installs writing into one knowledge folder at once can get in
each other's way; the app shows *"Another Curator is running over this same knowledge folder"* if
you forget.

---

## Third-party software

The app is open source under the MIT licence. The Windows app also contains third-party software,
listed in `THIRD-PARTY-NOTICES.txt` in `%LOCALAPPDATA%\Programs\The Curator\resources`:

| Component | Licence | Where |
|---|---|---|
| **MinGit** (Git for Windows), unmodified | git: GNU General Public License, version 2. Its 65 components each have their own licence (GPL, LGPL, MPL, MIT, BSD, Apache 2.0, zlib, curl and others) | `resources\git`. `THIRD-PARTY-NOTICES.txt` lists every component with its licence and where its source is, and carries every licence text in full |
| Electron, Chromium and Node.js | Their own licences | `LICENSE.electron.txt` and `LICENSES.chromium.html` in the program folder |
| The JavaScript packages | Their own licences | Each package's folder in `resources\app\node_modules` |

**The source code.** Every part of MinGit under the GPL, the LGPL or the MPL has its complete
source attached to the same [GitHub release](https://github.com/talirezun/the-curator/releases) as
the installer: GitHub's archive of git's `v2.56.1.windows.1` tag plus 28 source packages (the
build recipe, every patch and the original source of each), named in section 3 of the notices
file. Before the release is published, each file is checked against its pinned size (and SHA-256,
where Git for Windows publishes one); the installer is published only after all of them passed,
and the release is then checked for every one by its exact name. The
permissive components name their source package in the notices. Git for Windows also publishes
its sources and build recipes at its [v2.56.1 release](https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1)
and [build-extra](https://github.com/git-for-windows/build-extra).

---

## If something goes wrong

| What you see | What to do |
|---|---|
| **Windows protected your PC** | **More info → Run anyway** ([above](#the-blue-windows-protected-your-pc-screen)) |
| *The Curator could not start* … *its program files are incomplete* | [Download the installer](https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe) again and run it; your notes and settings are safe ([§ Where everything is](#where-everything-is)) |
| *The Curator cannot be installed in …* | Run the installer again without choosing a folder |
| The Domains page says your knowledge folder is inside The Curator's own folders | Move that folder with File Explorer into your user folder, then choose it again; nothing was moved or deleted |
| The app is running but no window shows | The tray icon is on: click it and choose **Open The Curator**, or look under the **^** by the clock |
| *The Curator is already running* | Only one copy may run. Switch to the open window (or the tray icon). |
| An update stops because an agent harness is using The Curator | **Close the connection and update**, or quit Claude Desktop first ([§ Updating](#updating)) |
| Sync says its git is missing or damaged | [Download the installer](https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe) again and run it; your data is kept |
| A folder is refused | The message says why; see [§ Choosing a folder](#choosing-a-folder) |
| *Disconnect Sync before you change the folder* | Sync is connected, and it backs up the folder you have now. Open **Sync → Disconnect**, change the folder, then connect again |
| A red banner: *The Curator can't read its settings file* | The file in `%LOCALAPPDATA%\TheCurator\App` is damaged and nothing is saved over it. Fix it by hand, or press **Start fresh** ([User Guide § 18](user-guide.md#everything-else)) |
| Anything else | **Settings → General → Run system check**, and the log at `%LOCALAPPDATA%\TheCurator\logs\curator.log` |

How the app is built, and the decisions behind it, are in [desktop/README.md](../desktop/README.md)
and [docs/dev/decisions-app.md](dev/decisions-app.md#app-lifecycle-install-and-update).
