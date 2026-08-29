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
| Working state (`state/`) | Yes | Deliberate, not an oversight — the whole point of a session handoff is that it follows you to your next machine, harness, or model. See below for the one thing to know about how it stays safe from a silent overwrite |
| Raw source files (`raw/`) | No | These can be large; re-ingest from the original file if needed. A per-domain manifest of what was ingested (filename, size, ingest date) DOES sync inside `wiki/`, so on a second machine a summary page can still tell you what its source was called and when it arrived, even though the file itself isn't there — see the reader overlay's "Reveal in Finder" bar or [mcp-user-guide.md](mcp-user-guide.md)'s `get_raw_source` section |
| AI provider API keys (`.curator-config.json`, or `.env` if you use the developer fallback) | No | Never synced — they stay on each machine only, for every provider. Add your key again on each computer |
| App code (`src/`, `package.json`, etc.) | No | The app is installed separately on each computer |
| Sync config (`.sync-config.json`) | No | Contains your PAT — stays local only |
| Write locks (`.write-lock`) | No | Machine-local state, not knowledge. Syncing one meant a crash on machine A could block writes on machine B for up to 30 minutes (fixed in v3.0.15) |
| Finder metadata (`.DS_Store`) | No | macOS drops these into any folder Finder browses. They carry zero wiki content but, if already committed from before this rule existed, would re-sync to every machine on every push/pull and inflate the "pending changes" badge for nothing (fixed in v3.0.16) |
| MCP write log (`.mcp-write-log.jsonl`) | No | A per-domain record of what Claude wrote through the MCP. Machine-private by design |
| Batch-ingest queue (`.ingest-queue/`) | No | Mid-batch operational state plus staged source files. It normally lives outside your knowledge folder entirely; the rule is a safety net |
| Obsidian workspace state (`.obsidian/workspace.json`) | No | Obsidian rewrites it on essentially every pane move or tab switch, so tracking it makes the sync badge tick constantly. Deliberately narrow — the rest of `.obsidian/` (appearance, graph and plugin settings) **does** sync, since whether those follow you between machines is your preference, not ours (v3.5.1) |
| Obsidian leftovers (`*.base`, `Untitled.md`, `Untitled 1.md`) | No | Empty stub notes Obsidian auto-creates when a wikilink resolves to nothing or the vault root is pointed at the wrong folder (v3.5.1) |

> The authoritative list is `DOMAINS_GITIGNORE_RULES` in [`src/brain/sync.js`](../src/brain/sync.js). The app rewrites `domains/.gitignore` from it on every push and pull, so an install configured before a rule was added picks it up automatically.

### Working state and why its path has a machine name in it

Sync resolves any conflicting hunk with `git pull --no-rebase -X theirs` — on a genuine content conflict it keeps the incoming (origin) version and discards your local edit **silently**: no conflict markers, no warning, nothing to resolve by hand. That's fine for a wiki page, where the usual failure is two machines editing the *same* page, which is rare. It would be a real problem for working state, whose entire job is to be overwritten on every save — if two machines both wrote a handoff to the same file between syncs, one machine's session context would vanish without a trace.

That's why the handoff and its journal live at `state/<scope>/<machine>/current.md` — a real path segment for the machine, not decoration. Two machines never write the same file, so there's never a conflicting hunk to silently resolve away, and each machine's handoff survives independently.

**And losing an edit is the *milder* of the two things that can happen — which is worth knowing before you decide to hand-edit a state file on two machines.** `-X theirs` isn't "take their whole file"; it's a preference that only applies where both sides changed the *same lines*. Where one side left a section untouched, the other side's edit merges in cleanly. So instead of one version winning, you can get a **splice** — a single tidy file containing one machine's heading and timestamp with another machine's section dropped into it. Git reports a clean, successful merge, because as far as git is concerned it was one. The result reads as a perfectly normal document that neither machine actually wrote, and nothing in The Curator flags it, because the checks that exist look for a *malformed* file and a spliced one isn't malformed.

**The one exception:** `state/project.md`, the standing project brief, has *no* machine segment — one file per project, because the brief belongs to the project rather than to any one machine. Edit it from two machines between syncs and you're back in the conflicting-hunk case above: the loser's edit is dropped with no warning. In practice this is a small risk (the brief changes rarely, and only one function ever writes it), but if you hand-edit it in Obsidian, sync soon after — the same advice this guide already gives for any wiki page.

Because `state/` syncs, an agent saving working state adds to your pending-changes count exactly like an ingest or a chat message does. If you see the Sync badge tick up between sessions with no ingest to explain it, a saved handoff is a normal cause, not a bug — see [`working-state.md`](working-state.md) for what's actually being written.

---

## Prerequisites

Before you start, you need:

1. **A free GitHub account** — sign up at [github.com](https://github.com) if you don't have one
2. **The The Curator app installed** on at least one computer (see the [User Guide](user-guide.md) for installation steps)
3. **An internet connection** when you sync (not required for normal use)

That's it. No developer tools, no command line, no extra software.

---

## First-time setup (about 3 minutes)

The **Sync** view has a setup form that collects everything at once. Here's what to expect.

> **This section was rewritten for the v3.9.0 interface.** It previously described a multi-step wizard with a *Get started* welcome screen and **Next** / **Finish** buttons — that is the `/old` interface, and if you are following these steps there you will get a wizard rather than one form. The information you need is identical either way; only the number of clicks differs.

> 🤖 **Using a coding agent?** If you have Claude Code, Cursor, opencode, Aider, or a similar agent wired to your machine and GitHub, you can skip the manual steps entirely — paste one prompt and it does all of this for you. See **[sync-via-coding-agent.md](sync-via-coding-agent.md)**.

### Step 1 — Open Sync

Start your server (`node src/server.js`) and open `http://localhost:3333`. Click **Sync** in the left rail (it sits in the footer, below the main rail items). Because nothing is connected yet you'll see a **Connect a GitHub repository** card with three things to fill in — repository URL, access token, and a starting direction. Steps 2–5 below are how to fill them.

### Step 2 — Create a private GitHub repository

Before you can fill that in, you need to create a repository on GitHub to store your knowledge. Do this now:

1. Go to [github.com/new](https://github.com/new)
2. Give it a name — something like `my-curator-brain` or `curator-knowledge`
3. Set visibility to **Private** (this is important — keeps your notes private)
4. Leave "Initialize this repository" unchecked (The Curator will do this)
5. Click **Create repository**
6. Copy the repository URL — it looks like `https://github.com/yourusername/my-curator-brain.git`

Now go back to The Curator.

### Step 3 — Enter the repository URL

Paste the URL you just copied into the **Repository URL** field.

### Step 4 — Create and enter a Personal Access Token

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

Paste whichever token you created into the **Personal access token** field.

> Your token is stored in a file called `.sync-config.json` in your project folder. This file is gitignored — it never leaves your computer.

### Step 5 — Choose your starting direction

Under **Starting direction**, pick one:

- **Push my wiki** — if this is the first computer you're setting up (this sends your existing knowledge up to GitHub)
- **Pull an existing wiki** — if you've already set up another computer and want to download its knowledge

Click **Connect**. The app initialises the repository and performs the first sync, then the card is replaced by the connected view showing your repository, when you last synced, and how many local changes are waiting.

---

## Setting up on a second computer

Once sync is working on your first computer, adding a second one takes about 2 minutes.

1. Install the The Curator app on the second computer (follow the [User Guide](user-guide.md) steps 1–6)
2. Open `http://localhost:3333` and go to **Sync**
3. Fill in the setup card — same repo URL, same PAT (or create a new one if you lost the original)
4. At Step 3, choose **Pull** to download the knowledge from GitHub

Once it connects, all your wiki pages and conversations will appear on the new computer.

---

## Daily workflow

Once sync is set up, the habit is simple — one button, both directions:

**Click **Sync now** at the start and end of every work session.**

That's it. It pulls remote changes from GitHub first, then pushes your local changes — so both machines reconcile in one click.

### Sync now (pull + push, the everyday button)

The **Sync now** button is what you use 95% of the time. It pulls anything new from GitHub, then pushes anything new from this machine. You don't have to remember which computer is "ahead" — the button handles both directions.

### Advanced — one-way operations

**Push only** and **Pull only** sit beside **Sync now**. Use them only when you're certain about direction:

- **Push only** — uploads your local changes to GitHub without pulling first. Use when you're sure no other machine has new changes.
- **Pull only** — downloads remote changes to this computer without pushing yours. Use when you're sure this computer has nothing new to share.

For everyday use, prefer **Sync now**.

> **Where these buttons sit has changed twice.** In v2.5.x the Sync tab had three coequal buttons labelled *Sync Up*, *Sync Down* and *Sync*. v2.6.0 renamed them to **Sync now** / **Push only** / **Pull only** and tucked the two one-way buttons into a collapsible **Advanced** section — which is what you still see at `/old`. In the current interface all three are inline, with **Sync now** as the primary. The underlying behaviour has never changed.

> **There is no revert or discard control**, in either interface. Every sync is a real git commit, so your history exists on disk — but listing or reverting individual commits from the app is not built, and the Sync view says so. To undo local changes before pushing, use git directly; [ai-health.md § How to actually undo a Health fix](ai-health.md#how-to-actually-undo-a-health-fix) has the exact commands, and they apply to any local change, not just Health fixes.

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

### Setup says "Something went wrong" / "Failed to fetch" with no other detail

This means the browser couldn't get a reply from The Curator — almost always because **the server process stopped or crashed during setup**, not because of GitHub.

1. Check that The Curator is still running. The window/terminal that launched it (on Windows, the PowerShell window running `node src/server.js`; on Mac, the Dock app) should still be open. If it closed or shows an error, that's the cause.
2. Restart The Curator, reload `http://localhost:3333`, and try connecting again.
3. If it keeps happening, start the server in a visible terminal so you can read the crash:
   - **Windows:** `cd` into the project folder, then `node src/server.js` — watch the window when setup fails; the real error prints there.
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

Then create a **fresh, empty** private repo (no README/.gitignore/license) and connect again with **Push my wiki** as the starting direction.

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

Your AI provider API keys are also never synced — whichever providers you use. They live in `.curator-config.json` when you save them in Settings (or in `.env` if you use the developer fallback), both of which are gitignored and stay on the machine you entered them on.

---

## Token expiry

Expiry options depend on which token type you chose:

- **Classic tokens** offer 30 days, 60 days, 90 days, 1 year, or **No expiration**. For this set-and-forget use case, **No expiration** is the lowest-maintenance choice — sync is meant to be a quiet background habit, and since the token only has access to your repositories, the risk is low.
- **Fine-grained tokens** must have an expiry date (custom, up to **1 year**). They cannot be truly permanent. The upside is they're scoped to a single repository, so the security tradeoff favours fine-grained even though you'll renew it occasionally.

Whichever you choose, if the token has an expiry date, **make a calendar reminder to renew it** before it expires — otherwise sync will start failing with a `403` and you'll need to generate a fresh token and paste it into `.sync-config.json`. If you'd rather never deal with renewals, use a classic token set to "No expiration".
