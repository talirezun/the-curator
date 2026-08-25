# Sync across computers

Keep your The Curator in sync across multiple computers — for free, with no subscription, using a private GitHub repository that only you can access.

---

## What sync does and why it's useful

By default, your knowledge base managed by The Curator lives only on one computer. If you use a laptop at home and a desktop at university, your knowledge stays stuck on whichever machine you last used it on.

The Sync feature solves this. It uses a **free, private GitHub repository** as a middleman: you push your knowledge up to GitHub, then pull it down on your other computer. Your notes never leave GitHub's servers (which only you can access — the repository is private), and you never need to pay for a sync subscription.

Compared to alternatives:
- No Obsidian Sync subscription ($10–$25/month)
- No Dropbox or iCloud complications
- No manual copying of folders
- Everything is version-controlled — if you accidentally delete pages, you can recover them

---

## What gets synced (and what doesn't)

| Item | Synced? | Reason |
|------|---------|--------|
| Wiki pages (`wiki/`) | Yes | This is your knowledge — the whole point |
| Chat conversations (`conversations/`) | Yes | So you can continue threads on any machine |
| Domain schemas (`CLAUDE.md`) | Yes | So the AI behaves consistently everywhere |
| Raw source files (`raw/`) | No | These can be large; re-ingest from the original file if needed. A per-domain manifest of what was ingested (filename, size, ingest date) DOES sync inside `wiki/`, so on a second machine a summary page can still tell you what its source was called and when it arrived, even though the file itself isn't there — see the Wiki tab's "Reveal in Finder" panel or [mcp-user-guide.md](mcp-user-guide.md)'s `get_raw_source` section |
| API keys (`.env`) | No | Never synced — stays on each machine only |
| App code (`src/`, `package.json`, etc.) | No | The app is installed separately on each computer |
| Sync config (`.sync-config.json`) | No | Contains your PAT — stays local only |
| Write locks (`.write-lock`) | No | Machine-local state, not knowledge. Syncing one meant a crash on machine A could block writes on machine B for up to 30 minutes (fixed in v3.0.15) |
| Finder metadata (`.DS_Store`) | No | macOS drops these into any folder Finder browses. They carry zero wiki content but, if already committed from before this rule existed, would re-sync to every machine on every push/pull and inflate the "pending changes" badge for nothing (fixed in v3.0.16) |
| MCP write log (`.mcp-write-log.jsonl`) | No | A per-domain record of what Claude wrote through the MCP. Machine-private by design |
| Batch-ingest queue (`.ingest-queue/`) | No | Mid-batch operational state plus staged source files. It normally lives outside your knowledge folder entirely; the rule is a safety net |
| Obsidian workspace state (`.obsidian/workspace.json`) | No | Obsidian rewrites it on essentially every pane move or tab switch, so tracking it makes the sync badge tick constantly. Deliberately narrow — the rest of `.obsidian/` (appearance, graph and plugin settings) **does** sync, since whether those follow you between machines is your preference, not ours (v3.5.1) |
| Obsidian leftovers (`*.base`, `Untitled.md`, `Untitled 1.md`) | No | Empty stub notes Obsidian auto-creates when a wikilink resolves to nothing or the vault root is pointed at the wrong folder (v3.5.1) |

> The authoritative list is `DOMAINS_GITIGNORE_RULES` in [`src/brain/sync.js`](../src/brain/sync.js). The app rewrites `domains/.gitignore` from it on every push and pull, so an install configured before a rule was added picks it up automatically.

---

## Prerequisites

Before you start, you need:

1. **A free GitHub account** — sign up at [github.com](https://github.com) if you don't have one
2. **The The Curator app installed** on at least one computer (see the [User Guide](user-guide.md) for installation steps)
3. **An internet connection** when you sync (not required for normal use)

That's it. No developer tools, no command line, no extra software.

---

## First-time setup (about 3 minutes)

The Sync tab has a built-in wizard that walks you through everything. Here's what to expect at each step.

> 🤖 **Using a coding agent?** If you have Claude Code, Cursor, opencode, Aider, or a similar agent wired to your machine and GitHub, you can skip the manual steps entirely — paste one prompt and it does all of this for you. See **[sync-via-coding-agent.md](sync-via-coding-agent.md)**.

### Step 1 — Open the Sync tab

Start your server (`node src/server.js`) and open `http://localhost:3333`. Click the **Sync** tab. You'll see a welcome screen explaining what sync does. Click **Get started**.

### Step 2 — Create a private GitHub repository

Before the wizard can continue, you need to create a repository on GitHub to store your knowledge. Do this now:

1. Go to [github.com/new](https://github.com/new)
2. Give it a name — something like `my-curator-brain` or `curator-knowledge`
3. Set visibility to **Private** (this is important — keeps your notes private)
4. Leave "Initialize this repository" unchecked (the wizard will do this)
5. Click **Create repository**
6. Copy the repository URL — it looks like `https://github.com/yourusername/my-curator-brain.git`

Now go back to the wizard.

### Step 3 — Enter the repository URL (Wizard Step 1)

Paste the URL you just copied into the field and click **Next**.

### Step 4 — Create and enter a Personal Access Token (Wizard Step 2)

GitHub needs to verify that you have permission to read and write your repository. It does this using a **Personal Access Token (PAT)** — think of it as a password specifically for this app.

GitHub offers two kinds of token. **Either one works** — pick based on the tradeoff below.

| | **Fine-grained token** *(recommended)* | **Classic token** |
|---|---|---|
| Security | Scoped to **one repository** with the **minimum** permissions | Broad — `repo` scope grants access to **all** your repositories |
| Expiration | Must have an expiry date (max 1 year), so you'll re-create it periodically | Can be set to **No expiration** — true set-and-forget |
| GitHub's stance | The modern, recommended option | Legacy, still fully supported |

If you're unsure, use a **fine-grained token** — it's safer because it can only touch the one repository you point it at. If you'd rather never think about this again, a **classic token with "No expiration"** is the lowest-maintenance option.

#### Option A — Fine-grained token (recommended)

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. **Token name**: anything, e.g. `the-curator-sync`
3. **Expiration**: choose the longest option you're comfortable with (up to **1 year** / a custom date). Set a calendar reminder to renew it before it expires, or you can switch to a classic token if you want one that never expires.
4. **Repository access**: select **Only select repositories** → click the dropdown → pick the repository you created in Step 2.
5. **Permissions** → **Repository permissions**: find **Contents** and set it to **Read and write** ← *this is the one that matters; without write access, sync will fail with a 403.*
   - **Metadata: Read-only** is added automatically by GitHub when you pick any repository permission — leave it.
   - You do **not** need any other permission. Leave everything else at "No access".
6. Scroll down and click **Generate token**.
7. **Copy the token immediately** — GitHub only shows it once. It starts with `github_pat_`.

#### Option B — Classic token

1. Go to [github.com/settings/tokens/new?scopes=repo&description=the-curator](https://github.com/settings/tokens/new?scopes=repo&description=the-curator)
2. **Note** (name): anything, e.g. `the-curator-sync`
3. **Expiration**: set to **No expiration** (so you don't have to repeat this every few months)
4. Under **Select scopes**, tick **only** the top-level **`repo`** checkbox (this grants read/write to your private repositories)
5. Scroll down and click **Generate token**
6. **Copy the token immediately** — GitHub only shows it once. It starts with `ghp_`.

> **Two things people get confused about with classic tokens:**
> - **You cannot limit a classic token to one repository.** Ticking `repo` grants access to *all* your repositories — there is no per-repo option on the classic page. That's the inherent tradeoff, and the reason fine-grained is the safer choice. It's not a bug, and it doesn't stop sync from working.
> - **You do not need the `workflow` scope** (or any other scope). The Curator only reads and writes ordinary files — it never touches GitHub Actions. Tick `repo` and nothing else.

Paste whichever token you created into the wizard and click **Next**.

> Your token is stored in a file called `.sync-config.json` in your project folder. This file is gitignored — it never leaves your computer.

### Step 5 — Choose your starting mode (Wizard Step 3)

- Choose **Push** if this is the first computer you're setting up (this will send your existing knowledge up to GitHub)
- Choose **Pull** if you've already set up another computer and want to download its knowledge

Click **Finish**. The wizard processes the connection, initialises the repository, and performs the first sync. You'll see a success screen when it's done.

---

## Setting up on a second computer

Once sync is working on your first computer, adding a second one takes about 2 minutes.

1. Install the The Curator app on the second computer (follow the [User Guide](user-guide.md) steps 1–6)
2. Open `http://localhost:3333` and go to the **Sync** tab
3. Run through the wizard — same repo URL, same PAT (or create a new one if you lost the original)
4. At Step 3, choose **Pull** to download the knowledge from GitHub

After the wizard completes, all your wiki pages and conversations will appear on the new computer.

---

## Daily workflow

Once sync is set up, the habit is simple — one button, both directions:

**Click **Sync now** at the start and end of every work session.**

That's it. It pulls remote changes from GitHub first, then pushes your local changes — so both machines reconcile in one click.

### Sync now (pull + push, the everyday button)

The **Sync now** button is what you use 95% of the time. It pulls anything new from GitHub, then pushes anything new from this machine. You don't have to remember which computer is "ahead" — the button handles both directions.

### Advanced — one-way operations

The Sync tab has a collapsible **Advanced** section containing two one-way buttons. Use these only when you're certain about direction:

- **Push only** — uploads your local changes to GitHub without pulling first. Use when you're sure no other machine has new changes.
- **Pull only** — downloads remote changes to this computer without pushing yours. Use when you're sure this computer has nothing new to share.

For everyday use, prefer **Sync now**.

> **Note for users updating from v2.5.x:** the previous Sync tab had three coequal buttons labelled *Sync Up*, *Sync Down*, and *Sync*. In v2.6.0 these are renamed and reorganised: *Sync* is now **Sync now** (the primary action), and *Sync Up* / *Sync Down* are now **Push only** / **Pull only** inside the collapsible Advanced section. The underlying behaviour is unchanged.

---

## What if you forget to sync?

If you forget to **Sync now** on one machine and then do new work on another machine, you'll have changes in two places. The app handles this gracefully:

- When you click **Sync now**, the app automatically commits any uncommitted local changes first (as an *"Auto-save before sync"* commit), then **merges** the GitHub version in, then pushes
- In most cases this works cleanly — edits from both machines land in the same file, because they touched different parts of it

⚠️ **What happens when both machines edited the same part of the same page.** The merge runs as `git pull --no-rebase -X theirs` ([`src/brain/sync.js`](../src/brain/sync.js), `pull()`). The `-X theirs` flag means git does **not** stop and ask you — for any section that genuinely conflicts, it silently keeps the **GitHub (remote)** version and drops the local one from the file on disk. Sync reports success; nothing in the UI tells you a local edit was overridden.

Read precisely, because the scope matters:

- This affects **only genuinely conflicting sections** of a page edited on both machines since the last sync. Everything else from both sides merges normally.
- **Your local version is not destroyed.** The auto-save commit runs *before* the merge, so the pre-merge content is still in the local git history and can be recovered.
- To recover it, look at the auto-save commit for that page:

  ```bash
  # macOS default location; adjust the work-tree if you moved your knowledge folder
  GITDIR="$HOME/Library/Application Support/The Curator/.knowledge-git"
  git --git-dir="$GITDIR" --work-tree="<your domains folder>" log --oneline -- "<domain>/wiki/<path>.md"
  git --git-dir="$GITDIR" --work-tree="<your domains folder>" show <sha>:"<domain>/wiki/<path>.md"
  ```

  In repo-mode installs (running from a git checkout rather than an installed `.app`) `.knowledge-git` sits in the project folder instead.

This behaviour is deliberate — an unattended local app cannot leave a half-merged wiki with conflict markers sitting in your Obsidian vault — but it means **the safe habit is to Sync now at the start *and* end of every session**, so the same page is never edited in two places between syncs.

---

## Troubleshooting

### "403 Forbidden" or "authentication failed"

Your Personal Access Token is wrong, expired, or doesn't have the right permissions. This is almost always a **missing write permission** — the most common setup mistake.

- **Fine-grained token**: make sure **Contents** is set to **Read and write** (not Read-only), and that the token's **Repository access** actually includes this repository. Re-create the token if either is wrong.
- **Classic token**: make sure you ticked the top-level **`repo`** scope when creating the token.
- If the token has expired, create a new one and update it in `.sync-config.json` (open the file in any text editor and replace the `token` value). Fine-grained tokens are managed at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens); classic tokens at [github.com/settings/tokens](https://github.com/settings/tokens).
- A **classic token set to "No expiration"** will never expire — use this option if you want to avoid re-doing this step.

### "404 Not Found" or "repository not found"

The repository URL is wrong, or the repository doesn't exist yet.

- Check the URL in `.sync-config.json` — it should end in `.git`
- Make sure the repository exists on GitHub (visit the URL in your browser)
- Make sure the repository is not owned by an organisation that blocks PAT access

### "Network error" or "could not resolve host"

The app can't reach GitHub. Check your internet connection. If you're on a university network, try a different connection or hotspot — some networks block git operations.

### The wizard says "Something went wrong" / "Failed to fetch" with no other detail

This means the browser couldn't get a reply from The Curator — almost always because **the server process stopped or crashed during setup**, not because of GitHub.

1. Check that The Curator is still running. The window/terminal that launched it (on Windows, the PowerShell window running `node src/server.js`; on Mac, the Dock app) should still be open. If it closed or shows an error, that's the cause.
2. Restart The Curator, reload `http://localhost:3333`, and run the wizard again.
3. If it keeps happening, start the server in a visible terminal so you can read the crash:
   - **Windows:** `cd` into the project folder, then `node src/server.js` — watch the window when the wizard fails; the real error prints there.
   - **Mac/Linux:** `node src/server.js` in Terminal.

### Setup keeps failing at the commit step — "Command failed: git … commit -m 'Initial The Curator sync'"

If you're on **The Curator v3.0.1-beta.19 or newer**, this is already fixed — update via Settings → Check for Updates.

On **older versions**, this happens when a previous setup attempt committed your files locally but its push to GitHub failed (e.g. the repo had a README, or a token problem). Every retry then trips over an already-committed repo. Reset the local sync state and start clean:

```bash
# from inside the project folder
# macOS / Linux:
rm -rf .knowledge-git .sync-config.json
# Windows PowerShell:
Remove-Item -Recurse -Force .knowledge-git
Remove-Item -Force .sync-config.json -ErrorAction SilentlyContinue
```

> This is safe — it only removes sync bookkeeping. Your actual notes live in the `domains/` folder and are untouched.

Then create a **fresh, empty** private repo (no README/.gitignore/license) and re-run the wizard in **Push** mode.

### Windows: a GitHub sign-in window pops up, or sync hangs forever

Git for Windows ships with **Git Credential Manager**, which can intercept the push and pop up a GitHub login window — if you don't notice it, the whole operation stalls until it times out (which then shows as "Failed to fetch").

- Watch for a **GitHub sign-in popup** during sync and complete or close it.
- Clear any **stale saved credential** that may be conflicting with the token The Curator uses:
  ```powershell
  cmdkey /list | findstr github
  # if you see a github entry:
  cmdkey /delete:git:https://github.com
  ```
- Then retry. With no stale credential, Git for Windows uses the token The Curator already embeds — no popup.

> **Is sync a "Windows problem"?** No. The underlying behaviour is identical on Mac and Windows. The cases above are triggered by *state* (a failed first push, a non-empty repo, a stale Windows credential), not by the operating system — a Mac in the same state behaves the same way.

### "Push rejected" or "non-fast-forward update"

Someone pushed new changes to GitHub (from another computer) that you haven't pulled yet. The fix is just one click:

- Click **Sync now** — it pulls remote changes first, then pushes yours.

(If you previously used *Push only* and got this error, that's why. **Sync now** handles both directions and avoids the problem entirely.)

### Merge conflict

If two computers edited the same wiki page in incompatible ways, git cannot automatically merge them. You'll see an error message mentioning "conflict".

This is uncommon but can happen. To fix it:
1. Open a terminal in your project folder
2. Run `git --git-dir=.knowledge-git --work-tree=domains status` to see which files are conflicted
3. Open the conflicted file — it will contain markers like `<<<<<<< HEAD` and `>>>>>>> origin/main`
4. Edit the file to keep the version you want, removing the conflict markers
5. Run the command shown to complete the merge

If this feels complicated, the easiest recovery is to decide which machine has the "correct" version, and overwrite the other machine by using **Pull only** (in the Advanced section) after discarding local changes.

### Stale `.write-lock` or `.DS_Store` files showing up in your changes

`.write-lock` and `.DS_Store` are machine-local bookkeeping files, not knowledge, and are excluded from sync (see the table above). If either was already committed before those exclusion rules existed, it would otherwise keep re-appearing in every sync forever. Since v3.0.16, both **Push only/Sync now** and **Pull only** automatically clean these up before doing anything else: any already-committed `.write-lock` or `.DS_Store` is untracked from git (removed from what's synced, left alone on your own disk), and any `.write-lock` file on your own machine that's genuinely dead (older than 30 minutes, or left behind by a process that's no longer running) is deleted outright. This is automatic — you don't need to do anything. If you notice one of these files disappear from your "pending changes" count after an update, that's this cleanup running, not something going wrong.

---

## Privacy note

Your repository is **private**. GitHub employees do not read private repository contents. Only you (and anyone you explicitly invite as a collaborator) can see your knowledge.

Your Personal Access Token is stored only in `.sync-config.json` on your local machine — it is gitignored and never uploaded anywhere.

Your Gemini API key (in `.env`) is also never synced.

---

## Token expiry

Expiry options depend on which token type you chose:

- **Classic tokens** offer 30 days, 60 days, 90 days, 1 year, or **No expiration**. For this set-and-forget use case, **No expiration** is the lowest-maintenance choice — sync is meant to be a quiet background habit, and since the token only has access to your repositories, the risk is low.
- **Fine-grained tokens** must have an expiry date (custom, up to **1 year**). They cannot be truly permanent. The upside is they're scoped to a single repository, so the security tradeoff favours fine-grained even though you'll renew it occasionally.

Whichever you choose, if the token has an expiry date, **make a calendar reminder to renew it** before it expires — otherwise sync will start failing with a `403` and you'll need to generate a fresh token and paste it into `.sync-config.json`. If you'd rather never deal with renewals, use a classic token set to "No expiration".
