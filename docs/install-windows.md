# Install The Curator on Windows

Three steps. It takes about 5 minutes. You do not need to be an administrator.

## 1. Open PowerShell

Click **Start**, type **PowerShell**, and click **Windows PowerShell**. A blue window opens.
Do **not** use "Command Prompt" (the black window): the line below does not work there.

## 2. Copy this line, paste it, press Enter

Paste with a **right-click** in the blue window (or **Ctrl + V**), then press **Enter**.

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
| **The Curator** | Starts the app and opens it in your browser |
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
