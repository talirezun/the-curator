# Install The Curator on Windows

There are two ways. Both need no administrator rights, and both are the same program.

| | **The Windows app** (recommended) | **The one-line browser installer** (this page) |
|---|---|---|
| You | Download one `.exe` and double-click it | Paste one line into PowerShell |
| You get | The Curator in its own window, with an optional tray icon | The Curator in a tab of your browser |
| Guide | **[The Windows app](windows-app.md)** | The three steps below |

**For the app:** download `TheCurator-<version>-x64-Windows-Setup.exe` from the newest release on the
[Releases page](https://github.com/talirezun/the-curator/releases), double-click it, and on the blue
**"Windows protected your PC"** screen click **More info → Run anyway** (the app is not code-signed
yet). Then **Next**, wait, and **Finish** with **Run The Curator** ticked: the app opens. Everything
else, including updating and uninstalling, is in [windows-app.md](windows-app.md).

The rest of this page is the browser installer. It takes about 5 minutes.

## 1. Open PowerShell

Click **Start**, type **PowerShell**, and click **Windows PowerShell**. A window opens whose title says **PowerShell**.
Do **not** use "Command Prompt" (its title says Command Prompt): the line below does not work there.

## 2. Copy this line, paste it, press Enter

Paste with a **right-click** in that window (or **Ctrl + V**), then press **Enter**.

```powershell
irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 | iex
```

## 3. Wait 2 to 5 minutes

Do not close the window. When it says **"Done. The Curator is installed."**, your browser opens
The Curator. Follow the **Getting started** panel there. You will need an API key (a password for
the AI service): see [how to get one](user-guide.md#4-get-your-api-key-gemini-claude-or-openrouter).

## Every day after that

You now have two icons on your Desktop (and in the Start menu, in the folder **The Curator**):

| Icon | What it does |
|---|---|
| **The Curator** (named **The Curator (browser)** if the Windows app is installed too) | Starts the app and opens it in your browser |
| **Stop The Curator** | Stops the app (do not do this in the middle of adding a document) |

## If something goes wrong

| What you see | What to do |
|---|---|
| `irm : The term 'irm' is not recognized` | You are in Command Prompt. Close it and open **Windows PowerShell** (step 1) |
| A red box: **"The installation stopped."** | Run the same line again. If it stops again, copy the text between "copy from here" and "copy to here" and send it to your teacher |
| The page does not open | Double-click **The Curator** on your Desktop and wait up to a minute |
| A security or antivirus message | Wait, and do not close the window. If your antivirus removes a file, allow the folder `%LOCALAPPDATA%\TheCurator` and run the line again. On a school PC, ask your IT department |
| "Port 3333 is already used by another program" | Close the program it names, or double-click **Stop The Curator** and then **The Curator** |

More help: [the full troubleshooting table](user-guide.md#windows-one-line-installer).

## Updating

Press **Update** in the app's Settings, or run the same line from step 2 again. Your notes are never touched.

## Where your notes live

In the folder `%USERPROFILE%\the-curator\domains` (type it into the address bar of File Explorer).

## Uninstalling

| Install | How to remove it | What stays |
|---|---|---|
| Browser install | Double-click **Stop The Curator**, then delete the folder `%USERPROFILE%\the-curator` (your notes are in its `domains` folder: copy them out first if you want to keep them) and the shortcuts. Its private Node.js and git are in `%LOCALAPPDATA%\TheCurator\runtime`; delete that folder too if the Windows app is not installed. | Nothing, once deleted |
| Windows app | **Settings → Apps → Installed apps → The Curator → Uninstall** ([details](windows-app.md#uninstalling)) | Your notes, keys and settings, in `%LOCALAPPDATA%\TheCurator\App` |

Never delete the whole `%LOCALAPPDATA%\TheCurator` folder while the Windows app is installed: its
notes are in `App` inside it.

Switching from this install to the app, with your notes: [windows-app.md § Switching from the browser install](windows-app.md#switching-from-the-browser-install).
