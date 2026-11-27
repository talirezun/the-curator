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
| Obsidian Bases and Untitled notes (`*.base`, `Untitled.md`, `Untitled 1.md`) | No | Added for the empty stubs Obsidian creates when a wikilink resolves to nothing (v3.5.1). A `.base` file you made yourself is skipped too, so keep your own copy. The Sync page lists them |
| Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `secrets.yaml`, `.npmrc`, `.ssh/` and similar) | No | Refused by name, in any folder, however the folder was chosen. See "Secrets" below |
| Obsidian plugin settings that hold a key (`.obsidian/plugins/*/data.json`) | No | AI plugins keep your API key there in plain text. Only a settings file that actually holds a key value stays behind; other plugin settings still sync |
| A folder with its own git history (a `.git` inside it) | No | Sync cannot copy it. See "A folder with its own git history" below |
| Other folders and files that are not domains | **Yes** | See "Folders that are not domains" below |

> The authoritative list is `DOMAINS_GITIGNORE_RULES` in [`src/brain/sync.js`](../src/brain/sync.js), with the secret patterns in [`src/brain/sync-safety.js`](../src/brain/sync-safety.js). The app adds any missing rule to `domains/.gitignore` on every push and pull, and keeps your own lines.

**You can see all of this.** The Sync page has a section called "What Sync does not back up", which names the files in each group above. Connecting shows the same list first when there is something to decide.

### Secrets

A file that looks like a secret stays on your computer, and the Sync page names it. This goes by the file's **name**. A key pasted into a note is not detected, and a page called `credentials.md` is treated as an ordinary page. A Keynote deck also ends in `.key`, so it is left out too; rename it or export a PDF if you want it backed up.

**If a secret is already in your repository**, because an earlier version sent it, the Sync page warns you. Sync no longer sends changes to that file, but The Curator never rewrites history, so:

1. Replace the key or password with a new one. The old one stays in the repository's history.
2. Move the file out of your knowledge folder, Sync once, and move it back. It then stays on this computer only. Your other computers lose their copy on their next Sync, so copy it first.
3. To remove the history as well, make a new empty private repository, Disconnect, connect to the new one with **Push my wiki**, then delete the old repository on GitHub.

### Folders that are not domains

A folder without a `CLAUDE.md`, and any loose file at the top of your knowledge folder, **is backed up**. That is deliberate: this folder is often an Obsidian vault, and pasted images live in an attachments folder there. Stopping the backup of a folder that is already in the repository would also delete it from your other computers on their next Sync.

Before the first push you are shown these folders and can choose **Connect, and leave out those folders**. Later on, add a line such as `/Private Journal/` to the `.gitignore` file in your knowledge folder before that folder's first sync. A line added after that does not remove what is already in the repository.

### A folder with its own git history

Sync cannot copy a folder that has its own `.git`. It leaves that folder out, backs up everything else, and says so on the Sync page and in every result. Nothing in that folder is touched. Your options:

- Keep it as it is, if its own repository pushes somewhere.
- Choose that folder itself as your knowledge folder (Domains, **Use existing folder**). A `.git` at the top of the knowledge folder is fine.
- Delete its `.git` folder if you do not need its history, then Sync. The files are then backed up like any others.

If that folder is the only thing there, connecting is refused, because nothing could be backed up.

**If an earlier version already connected such a folder**, your repository holds an empty link in its place and every Sync failed with a long git message. The next Sync removes the link. Nothing is lost, because the link held no content, and the files in the folder are not changed. They are still not on GitHub until you choose one of the options above.

### Working state and why its path has a machine name in it

Sync resolves any conflicting hunk with `git pull --no-rebase -X theirs` — on a genuine content conflict it keeps the incoming (origin) version and discards your local edit **silently**: no conflict markers, no warning, nothing to resolve by hand. That's fine for a wiki page, where the usual failure is two machines editing the *same* page, which is rare. It would be a real problem for working state, whose entire job is to be overwritten on every save — if two machines both wrote a handoff to the same file between syncs, one machine's session context would vanish without a trace.

That's why the handoff and its journal live at `state/[<project>/]<scope>/<machine>/current.md` and `…/journal.jsonl` — a real path segment for the machine, not decoration. Two machines never write the same file, so there's never a conflicting hunk to silently resolve away, and each machine's handoff survives independently.

**And losing an edit is the *milder* of the two things that can happen — which is worth knowing before you decide to hand-edit a state file on two machines.** `-X theirs` isn't "take their whole file"; it's a preference that only applies where both sides changed the *same lines*. Where one side left a section untouched, the other side's edit merges in cleanly. So instead of one version winning, you can get a **splice** — a single tidy file containing one machine's heading and timestamp with another machine's section dropped into it. Git reports a clean, successful merge, because as far as git is concerned it was one. The result reads as a perfectly normal document that neither machine actually wrote, and nothing in The Curator flags it, because the checks that exist look for a *malformed* file and a spliced one isn't malformed.

**The one exception:** `state/project.md`, the standing project brief, has *no* machine segment — one file per project, because the brief belongs to the project rather than to any one machine. Edit it from two machines between syncs and you're back in the conflicting-hunk case above: the loser's edit is dropped with no warning. In practice this is a small risk — the brief changes on the order of weeks — but it is a real one rather than a theoretical one, and it grew in v3.48.0: the brief gained the app's own editor and the `save_project_brief` MCP tool beside hand-editing, so three routes now reach one file with no machine segment. If you edit it in the app or in Obsidian, sync soon after — the same advice this guide already gives for any wiki page.

**Foundations (v3.59.0) share the same carve-out, and for a project's canonical documents the
mitigation that covers the brief — "it changes rarely, and only one function writes it" — doesn't
hold quite as cleanly.** `state/<project>/foundations/` has no machine segment either, by design:
a repo-owned mirror is meant to be identical bytes on every machine, so there is normally nothing
for two copies to disagree about. But a mirror *can* be refreshed independently on several
machines at different commits of the same repository, and when that happens on two machines
between syncs, it is the same conflicting-hunk case as the brief — the loser's refresh is dropped
silently. The rule this release ships is to treat that as acceptable rather than to add a second
mechanism: a repo-owned mirror **converges to whichever machine saved last**, and that is a safe
place to land *because the repository, not the mirror, is the source of truth*. Any machine can
re-assert its own checkout's state on its next save (passing `repo_root` to `save_working_state`,
or pressing **Refresh from repo** in the app) — the refresh is a cheap, idempotent byte comparison,
so "just refresh again" is a real fix rather than a workaround. The Foundations block shows the
stored commit beside your local checkout's `HEAD` when it's reachable, so a mirror that has drifted
behind is visible rather than silent. Curator-owned foundations — written for you by an agent, or
(v3.61.0) by you directly, in the app's own editor — are lower-traffic still, and share the brief's
carve-out exactly: edit rarely, sync soon after.

#### Foundations, and the no-machine-segment bargain, again

**v3.61.0 gave a curator-owned foundation a second, human writer** — the Foundations block's own
editor, described in [working-state.md](working-state.md#the-human-edit-surface-a-second-reader-and-writer-and-why-it-is-still-one-writer-per-file)
— and it is worth stating plainly that this does **not** change anything about the paragraph above.
The bargain was never "only one *process* may touch this file" — a browser and an MCP-connected
agent are always two processes, and were before this release too. It was "one **ownership** per
project, and whichever writer touches a document stamps it with the truth about who wrote it": a
human edit through the app is stamped `authoredBy: {kind: 'human'}`, an agent's through
`save_foundation` stamped with its own harness and model, and neither can land on a repo-owned
mirror at all — that ownership check happens in the store, before any write reaches disk, the same
gate that already refused a mismatched `save_foundation` call. What is genuinely new is only that
you, personally, are now one more source of edits sharing this file's no-machine-segment risk: edit
a curator-owned foundation on your laptop, edit the *same* one on your desktop before syncing either,
and you are in the ordinary conflicting-hunk case two paragraphs up — the loser's edit dropped with
no warning. The advice does not change either: edit it, then sync soon after.

#### Mirroring from GitHub, and the token that does *not* get reused (v3.63.0)

A mirror can now be refreshed from the **repository** as well as from a checkout on this disk, so
*"source not on this computer"* is no longer a permanent state on every machine but one. Two things
about it belong in *this* guide rather than only in the technical one, because both are about a
credential you created for something else.

**Your Personal Sync token is not silently reused.** A refresh names **which file** its token comes
from, and the default is a *different* one:

| Where the token comes from | What you should know |
|---|---|
| **`githubReadToken` in `.curator-config.json`** — the default, and the recommended path | A second token, **fine-grained and read-only** (Contents: **Read**, nothing else), scoped to the repository you are mirroring. It can do nothing but read that one repository |
| **Personal Sync's token** — only when explicitly asked for | It was granted for **sync**. If you created a **classic** token, that grants access to **every repository you own** (see the two-options table above), so using it to read a *different* repository spends a permission you granted for one purpose on another. That is why it is never the default and never happens without being named |

**Where you set the read-only one.** This is a different token from the one you created above for
Personal Sync — that one needs read *and* write, this one needs read only. As of v3.65.2 it has its
own field: **Settings → Knowledge base → GitHub read-only token**. Before that release the only way
to add one was to hand-edit `.curator-config.json`; that is no longer necessary or the recommended
path.

**A refresh only ever reads.** The client the mirror uses can issue no HTTP verb but `GET` — there
is no `PUT`, no `DELETE` and no path to one — so a mirror refresh cannot write to the repository it
is mirroring, whatever token it is holding. The token itself is never written to a log, never put in
a URL, and never included in an error message; when something goes wrong the message names **which
file** the token came from, which is the part you can act on.

**What it does not change.** Everything in the two sections above still holds: foundations have no
machine segment, a mirror refreshed on two machines between syncs still converges to whichever saved
last, and the repository is still the source of truth. The remote arm makes *"refresh from the
source"* possible from any machine — it does not make two machines agree without one.

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

> **This section was rewritten for the v3.9.0 interface.** It previously described a multi-step wizard with a *Get started* welcome screen and **Next** / **Finish** buttons — that was the `/old` shell, which v3.41.0 deleted outright; `/old` now redirects to `/`. There is one form, and it is the one described here.

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

> Your token is stored in a file called `.sync-config.json` in your project folder, and in the sync history's own settings. Both are gitignored — the token never leaves your computer. To change it later, use [Replace token](#replacing-the-token); you do not need to disconnect.

### Step 5 — Choose your starting direction

Under **Starting direction**, pick one:

| Option | Use it when | What it does to the folder on this computer |
|---|---|---|
| **Push my wiki** | This is the first computer you're setting up, and the repository is empty | **Nothing.** It sends this folder up to GitHub |
| **Merge — keep both** | Both sides have content — a second computer that has already been used, or a folder another install has been syncing | **Adds** what's in the repository. Nothing here is deleted |
| **Pull an existing wiki** | This computer is new or empty and you want to download an existing wiki | **Replaces** files that exist on both sides with the repository's version |

Click **Connect**.

Before it changes anything, The Curator checks the repository against your folder
and tells you what it found. If **Pull** would replace files that are here with a
different version, it stops and says **how many, and which ones**, and offers
**Merge — keep both** instead. You can still choose to overwrite — it is your
folder — but you will see the count first, and you have to say so.

> **Why this exists.** Before v3.32.0 there was no third option and no count. A
> user connected a second install to a folder that already had a morning's work
> in it, was correctly told that "Push my wiki" could not proceed, and the only
> other control on the screen checked the repository out over his folder. Four
> working-state handoffs and an append-only journal were destroyed. The count and
> the Merge option are the fix.

**If a connect does not finish (v4.1.2), nothing is left behind.** A wrong token, a mistyped address,
no network, or a refused push: the half-made sync history folder is removed (or, if one was there
before, put back as it was), the token is not left in it, and the `.gitignore` the connect wrote into
your folder is taken out again. Fix what the message says and press **Connect** again. The address and
the token are checked before anything is written, and the message names which one is wrong.

**One thing Merge does that is worth knowing:** because the two sides have no
shared history yet, every file in the repository looks new to it. So a page you
**deleted** on this computer since its last push **comes back**. That is the
direction chosen on purpose — a page reappearing is visible and one click to
remove, a page vanishing is not. Delete it again after the first sync.

### If another install already syncs this folder

If you point a second install of The Curator — say the Mac app — at a domains
folder that another install is already syncing, The Curator notices, and **joins
the existing sync history instead of starting a second one**. Nothing in your
folder is changed, and you'll see a note saying so before you click Connect.

This matters more than it sounds. Two sync setups over one folder means two
independent histories over the same files: each one's changes reach the other as
a *merge*, and merges can silently replace an edited page. One folder should have
exactly one sync history.

If the other install is connected to a **different** repository, The Curator
refuses rather than creating that situation. Disconnect sync in the other install
first, or point this one at a different folder.

**If you are already in that state** — you connected both before v3.32.0 — the
Sync view shows a banner headed *"Two sync histories over one folder"*. The fix is
two clicks: **Disconnect**, then **Connect** again with the same repository. The
reconnect joins the existing history, and nothing in your folder is touched. It is
deliberately not done for you: silently switching a working install onto a
different repository would orphan its commits, which is the same class of
unrequested decision that caused the data loss in the first place.

> ⚠️ **Sync is now safe to share; *writing* is not.** Joining one history stops the
> two installs building conflicting versions of your wiki. It does **not**
> coordinate them while they run — two servers writing one folder at the same
> moment is not a case either of them guards against. **Run one at a time.**
>
> **And the part people get caught by: closing the browser tab does not stop the
> browser install's server.** It keeps running in the background at near-zero CPU
> — that is deliberate, and it is why clicking the Dock icon reopens instantly —
> so closing the tab and then opening the Mac app leaves **both** running. To
> actually stop it: right-click its Dock icon → **Quit**, or `Ctrl + C` in the
> terminal you started it from.

---

## Setting up on a second computer

Once sync is working on your first computer, adding a second one takes about 2 minutes.

1. Install the The Curator app on the second computer (follow the [User Guide](user-guide.md) steps 1–6)
2. Open `http://localhost:3333` and go to **Sync**
3. Fill in the setup card — same repo URL, same PAT (or create a new one if you lost the original)
4. At Step 5, choose **Pull an existing wiki** to download the knowledge from GitHub — or **Merge — keep both** if this computer's domains folder already has anything in it

Once it connects, all your wiki pages and conversations will appear on the new computer.

**If you left Step 5 on Push my wiki** (the default), the push is refused because GitHub already holds
a wiki, and the screen offers **Merge — keep both** or **Pull an existing wiki**. Choose either; both
work. Before v4.1.2 they did not: Merge then failed every time ("a branch named 'main' already
exists") and Pull said it "would overwrite 0 files", so only **Overwrite my local files** got through.
If an older version left such a half-finished connect behind, the next Merge or Pull keeps that
commit on a branch of its own (`curator-before-connect-…`, never pushed) and goes ahead.

## Changing the knowledge folder while Sync is connected

**You can't, and that is on purpose (v4.1.2).** Sync backs up exactly one folder. Before v4.1.2,
choosing another folder in Settings while connected made the next Sync treat the new folder as your
whole wiki: it removed every domain the old folder held from GitHub, and every other computer would
have removed them on its next pull. Now:

| You do | What happens |
|---|---|
| Settings › Knowledge base › **Choose folder**, a pasted path, or Domains › **Use existing folder** | Refused before anything changes: *"Disconnect Sync before you change the folder"* |
| The folder changes another way (an edited settings file, **Start fresh** on a damaged settings file, `--domains-path`, an older version) | **Sync now**, **Push only** and **Pull only** stop before sending or receiving anything: *"Your knowledge folder is not the one Sync backs up on this computer…"*, naming the folder Sync backs up |
| Then you choose that folder again in Settings (or paste its path) | Accepted while Sync is connected: it is the way back. Any other folder is still refused |

To move to another folder: open **Sync → Disconnect**, change the folder, then connect Sync again.
Connecting shows what it would change before it changes anything. To keep syncing the folder you had,
set it back in Settings: the message names it. The folder Sync backs up is recorded on this computer
only, inside its sync history, exactly as written (a name ending in a space included); it is never
pushed. An install connected before v4.1.2 records it on its first sync; until then, if the folder
holds none of the domains Sync backs up, the message names only Disconnect, because there is no
recorded folder to go back to.

---

## Daily workflow

Once sync is set up, the habit is simple — one button, both directions:

**Click **Sync now** at the start and end of every work session.**

That's it. It pulls remote changes from GitHub first, then pushes your local changes — so both machines reconcile in one click.

This is the Sync view once a repository is connected:

![The Sync view on the demo workspace. Down the left, the icon rail — Chat, Domains and Context, with the theme toggle, Sync (a badge reading 15) and Settings at the foot. The sidebar lists DOMAINS BACKED UP: early-computing and night-sky. The main column reads WHERE IT ALL LIVES over the title Sync. A recessed monitor reads CONNECTED, REPO github.com/example/my-brain and LAST SYNCED today at a time. Under it the buttons Sync now (filled), Push only and Pull only, an amber chip '15 local changes not pushed' — the same 15 as the rail badge — and the line 'The Curator has no revert control. A git client pointed at your knowledge folder can undo a sync.' Below, a row reads 'Shared Brain pushes are managed in Shared Brain. This tab only reports them.' with 'Not connected to any Shared Brain' and Open, and at the foot a 'Disconnect this repository' link.](images/curator-sync.png)

### Sync now (pull + push, the everyday button)

The **Sync now** button is what you use 95% of the time. It pulls anything new from GitHub, then pushes anything new from this machine. You don't have to remember which computer is "ahead" — the button handles both directions.

A sync keeps running until it finishes when you leave the Sync page (since v3.89.2): the Sync icon in the rail spins while it runs, and the Sync page shows the result when you come back. Only one sync runs at a time — a second click while one runs starts nothing.

### Advanced — one-way operations

**Push only** and **Pull only** sit beside **Sync now**. Use them only when you're certain about direction:

- **Push only** — uploads your local changes to GitHub without pulling first. Use when you're sure no other machine has new changes.
- **Pull only** — downloads remote changes to this computer without pushing yours. Use when you're sure this computer has nothing new to share.

For everyday use, prefer **Sync now**.

> **Where these buttons sit has changed twice.** In v2.5.x the Sync tab had three coequal buttons labelled *Sync Up*, *Sync Down* and *Sync*. v2.6.0 renamed them to **Sync now** / **Push only** / **Pull only** and tucked the two one-way buttons into a collapsible **Advanced** section. Since the v3.9.0 cutover all three are inline, with **Sync now** as the primary, and the shell that had the Advanced section was deleted in v3.41.0. The underlying behaviour has never changed.

> **There is no revert or discard control.** Every sync is a real git commit, so your history exists on disk — but listing or reverting individual commits from the app is not built, and the Sync view says so. To undo local changes before pushing, use git directly; [ai-health.md § How to actually undo a Health fix](ai-health.md#how-to-actually-undo-a-health-fix) has the exact commands, and they apply to any local change, not just Health fixes.

---

## When Sync asks before deleting

*(Since v4.2.1.)* Sync backs up the whole knowledge folder, so a page that is missing from the folder is a page deleted from your GitHub backup at the next push, and a pull deletes the pages another computer removed. That is right when you deleted pages on purpose. It is a disaster when a drive was not mounted, a cloud folder had not finished downloading, or a shortcut now points somewhere else. So before a push or a pull, Sync counts what it would delete, and when the number is large it stops and asks. **Nothing is changed while it asks.**

| What the sync would delete | Does Sync ask? |
|---|---|
| One or two pages | No. Ordinary editing never sees the question. |
| 3, 4 or 5 files, under 10% of everything Sync tracks | No. |
| 3 to 5 files that are over 10% of everything Sync tracks (a small wiki losing a big share of itself) | Yes. |
| More than 5 files | Yes. |
| A whole domain: every file it has goes and none stays on the other side | Yes, even if it is a handful of files. |
| Housekeeping files such as `.DS_Store` or `.write-lock` | Never counted. |

It checks both directions: **push** (what your GitHub backup would lose) and **pull** (what this computer would lose because the backup no longer has it).

The question reads, for example: "This sync would delete 41 pages from your GitHub backup (articles 38 · research 3)." with three buttons:

- **Cancel** changes nothing. Your pages and your GitHub backup stay exactly as they are. When the question was about pages on **this computer** (another computer removed them from GitHub, and you want them kept), every later sync asks again until GitHub has them back. To put them back: **Disconnect this repository**, then connect to the same repository again and choose **Merge — keep both**. The Sync page says so after Cancel.
- **Show the pages** lists the files that would be deleted, so you can tell a clean-up you meant from a loss.
- **Delete them** carries out the sync, deleting exactly that list. If the list has changed since you looked (another page went, or a page's content changed), Sync asks again instead of acting on the old answer.

**Examples.** You delete 40 old pages on purpose and press Sync now: it asks once, you look at the list and press Delete them. You move the knowledge folder to a drive that is not plugged in and press Sync now: the folder is empty, so it would delete everything from GitHub; you press Cancel, plug the drive in and nothing was lost. Another computer reorganised a domain and removed 12 pages: your pull asks before deleting them here.

**What passes without a question.** The count is per sync. Five deletions at a time, sync after sync, never ask, and a small domain emptied while another file stays in its folder is counted as files, not as a whole domain. Moving pages counts as deleting them: moving 4 pages from `concepts/` to `entities/` in a small wiki, or renaming a domain, asks once ("would delete 13 files"), and the same pages arrive under their new names when you press Delete them. A change of letter case only (`Page.md` to `page.md`) is not seen by git on a Mac at all, so GitHub keeps the old spelling.

A sync you start away from the Sync page (for example the Sync button on the Context page, or something that calls Sync automatically) is stopped with the same sentence and changes nothing; open the **Sync** page and the same question is waiting there with the three buttons.

Sync also records where the knowledge folder really is on disk, links followed, and refuses to run when that is a different place from the one it was connected with. A shortcut that has been re-pointed at another folder is refused rather than backed up as if it were your wiki. If the folder Sync recorded is no longer there at all (it was moved or removed, or a link now stands in its place, as when a cloud provider moves its folder), Sync says so and stops; when the drive or cloud folder is only unavailable, make it available and sync again, and when you moved it yourself, Disconnect and connect again. The folder is recorded only after a sync has gone through, so a sync that was stopped records nothing. A connection made before v4.1.2 that has never synced since has no record yet; while it is connected the knowledge folder can be set back to any folder that still holds every file Sync backs up.

Both checks read what GitHub has at that moment, fetched for the purpose, not git's remembered copy of it, so a git folder set up by hand (one whose `origin` does not keep a remembered copy of `main`) is checked the same way. A pull merges exactly the version it counted, not a newer one that arrived in between, and the push half of the same Sync checks that same version.

---

## Replacing the token

Since v3.99.2 you can give Sync a new GitHub token **without disconnecting**. Your sync history, your repository and your wiki files all stay as they are; only the token changes.

**When to use it**

| Situation | What you see |
|---|---|
| The token expired, or you deleted or revoked it on GitHub | Sync stops with *"GitHub rejected the token saved for Sync…"*, and the **Replace the GitHub token** panel opens right under the message. If the run finished while you were on another page, the notice says *"…then open Sync and use Replace token."*, and when the background check finds it, the Sync icon's tooltip says the same |
| The token is valid but cannot write to the repository | Sync stops with *"GitHub rejected the token. For a fine-grained token, make sure it has "Contents: Read and write"…"*, and the panel opens under it |
| You want to renew a token before it expires, or switch between a classic and a fine-grained token | Nothing is wrong yet: press the small **Replace token** button under the Sync buttons |

**How**

1. Create the new token on GitHub exactly as in [Step 4](#step-4--create-and-enter-a-personal-access-token): **Contents: Read and write** on this repository (fine-grained), or the **`repo`** scope (classic).
2. On the **Sync** page, paste it into **New personal access token** (the panel is already open if Sync just refused the old token; otherwise press **Replace token**).
3. Press **Check and save**. While it checks, the button reads *Checking with GitHub…*.

**What Check and save does**

- **It checks the new token with GitHub first.** For a repository on github.com, The Curator asks GitHub what the new token may do on the repository Sync already uses, and goes on only if the token can **read and write** it. (Asking git alone would not be enough: GitHub lets anyone read a public repository, so even a mistyped token would pass.) If the repository was renamed or moved to another owner, GitHub points the check to the repository's new address on its own API, and The Curator follows that; it never sends the token to any other address. For a repository on another host, it asks git to list the repository with the new token, which proves the token can read it; a token that cannot write is then caught by the next push. If the check fails for any reason, nothing is changed and Sync keeps the token it had.
- **It saves the token in both places Sync keeps it**, together: the sync history's own settings (what Push and Pull use) and `.sync-config.json`. If the second write fails, the first is put back, and the message says nothing was changed. In the rare case that putting it back fails too, the message says so instead (*"…could save it in only one of the two places…"*): use Replace token again with the same new token.
- **It keeps your sync history.** Nothing is deleted, nothing is pulled or pushed. The next **Sync now** simply uses the new token.
- It answers *"Token replaced. Sync uses the new token from now on."* The new token is never shown again, never logged, and never sent back to the page.
- It does not run while a sync or another change to your wiki is running. Wait for that to finish, then press it again.

**When it refuses**

Every refusal says what to do, and all but one (*"…could save it in only one of the two places…"*) change nothing. The codes are in the [error catalogue](errors.md#sync-replacing-the-token).

| What you see starts with | What it means |
|---|---|
| *"Paste the new token from GitHub first."* | The field was empty |
| *"That doesn't look like a GitHub token."* | What was pasted is not shaped like a token (for example only part of it was copied) |
| *"GitHub didn't accept the new token."* | GitHub refused it: wrong, incomplete or already expired |
| *"GitHub accepted the token, but it cannot open the repository Sync uses…"* | The token is valid but has no access to this repository. Give it the repository with Contents: Read and write, or tick `repo` |
| *"GitHub accepted the token, but the organisation that owns the repository Sync uses… doesn't let it in yet"* | github.com only: the repository belongs to an organisation whose rules keep the token out. If the organisation uses single sign-on (SAML), open your token settings on GitHub, press **Configure SSO** next to the token and authorise it for that organisation. A fine-grained token may first need an organisation owner's approval |
| *"GitHub didn't answer the check of the new token itself…"* | github.com only: GitHub answered with a redirect to an address outside its own API (or one redirect after another), which The Curator does not follow, so the token was not sent there. Check that the repository still exists on GitHub; if it keeps happening, the Technical detail line is for support |
| *"GitHub accepted this token, but it can only read this repository…"* | github.com only: the token can read the repository but not write to it, so Sync could not push with it. Create one with Contents: Read and write (or the `repo` scope) |
| *"GitHub is limiting requests right now…"* | GitHub did not answer the check because of its request limit. Wait a few minutes and try again |
| *"The Curator couldn't reach GitHub to check the new token…"* | No connection to GitHub (no network, the name could not be looked up, the connection was refused or timed out). Check the internet and try again |
| *"The new token couldn't be checked…"* | The check failed for another reason. The Technical detail line under it is for support |
| *"The new token works, but The Curator couldn't save it…"* | GitHub accepted it, but writing it to this computer failed. Try again |
| *"The Curator couldn't read which repository Sync uses…"* | Sync's own settings file is unreadable. This is the one case where you need **Disconnect this repository** and **Connect** again with the new token (your wiki files stay as they are) |
| *"The new token works, but The Curator could save it in only one of the two places…"* | The settings file could not be written AND putting the sync history's address back failed, so the two places may disagree and Sync may fail until they match. Use Replace token again with the same new token; if that fails too, send the Technical detail line to support |
| *"Sync is not connected on this computer…"* | There is no Sync connection yet. Connect one first |

> **For a repository on another host, a token that can only READ passes the check.** There the check asks git to *read* the repository, so a token that can only read it is accepted and saved. (On github.com it is refused with *"…it can only read this repository…"*, above.) The next push is then refused with *"GitHub rejected the token. For a fine-grained token, make sure it has "Contents: Read and write"…"*, and the panel opens again: create a token with **Read and write** and replace it once more. Nothing is lost in between; your changes wait on this computer.

> **Before v3.99.2** the only way to change Sync's token was to edit `.sync-config.json` by hand, or to **Disconnect** and connect again. Disconnecting deletes this computer's sync history folder (unless it joined another install's), so it is no longer the way to change a token.

---

## What if you forget to sync?

If you forget to **Sync now** on one machine and then do new work on another machine, you'll have changes in two places. The app handles this gracefully:

- When you click **Sync now**, the app automatically commits any uncommitted local changes first (as an *"Auto-save before sync"* commit), then **merges** the GitHub version in, then pushes
- In most cases this works cleanly — edits from both machines land in the same file, because they touched different parts of it

⚠️ **What happens when both machines edited the same part of the same page.** The merge runs as `git pull --no-rebase -X theirs` ([`src/brain/sync.js`](../src/brain/sync.js), `pull()`). The `-X theirs` flag means git does **not** stop and ask you — for any section that genuinely conflicts, it silently keeps the **GitHub (remote)** version and drops the local one from the file on disk. Sync reports success; nothing in the UI tells you a local edit was overridden.

Read precisely, because the scope matters:

- **Record files keep both machines' records.** The ingest record (`wiki/.raw-manifest.jsonl`), Health dismissals, `wiki/log.md` and working-state journals are merged record by record: something added on either machine is kept, and something removed on either machine (an undismissed Health row) stays removed. Before this, one machine's new lines were dropped.
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

Every Sync message is a plain sentence, and under it a smaller **Technical detail (for support)** line keeps git's own text for support. The full list of messages, with what each means and what to do, is the [error catalogue](errors.md#sync). The sections below are the common ones in more depth.

### "GitHub rejected the token saved for Sync" (or, on older versions, "403 Forbidden" / "authentication failed")

GitHub no longer accepts the token: it has expired, or it was deleted or revoked. Nothing is lost; your changes stay on this computer. Create a new token on GitHub and use [**Replace token**](#replacing-the-token) on the Sync page; the panel opens right under the message.

If the message is *"GitHub rejected the token. For a fine-grained token, make sure it has "Contents: Read and write"…"*, the token is valid but may not write here. This is the most common setup mistake:

- **Fine-grained token**: make sure **Contents** is set to **Read and write** (not Read-only), and that the token's **Repository access** actually includes this repository. Re-create the token if either is wrong.
- **Classic token**: make sure you ticked the top-level **`repo`** scope when creating the token.
- **A repository owned by an organisation that uses single sign-on (SAML)**: the scopes can be right and GitHub still refuses until the token is authorised for that organisation. On your token settings page on GitHub, press **Configure SSO** next to the token and authorise it. A fine-grained token for an organisation may also need an owner's approval.
- Then put the new token in with [**Replace token**](#replacing-the-token). Fine-grained tokens are managed at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens); classic tokens at [github.com/settings/tokens](https://github.com/settings/tokens).
- A **classic token set to "No expiration"** will never expire — use this option if you want to avoid re-doing this step.

On the **Connect** form the same refusal reads *"GitHub rejected this token. Check that you copied all of it and that it has not expired, then press Connect again."*: there is nothing to replace yet, so fix the token and press **Connect** again.

### "Git is not available to The Curator, so syncing cannot run"

Personal Sync drives the real `git` command, so it needs git on the machine
**and** on the PATH the app was launched with. The message tells you what to do:

- **macOS** — open Terminal and run `xcode-select --install`, then try again.
- **Git installed somewhere unusual?** Launch The Curator from a terminal
  (`npm start`) instead of the Dock icon, so it picks up your shell's PATH.

The same missing `git` also stops **Settings → Check for updates**, where it says
*"Git is not available to The Curator, so it cannot update itself…"* — a separate
sentence for a separate action, with the same remedy. Seeing one and then the
other is expected, not a second fault.

> **If you're on a version older than v3.26.0, this same fault reported itself
> as "Repository not found. Check the URL — it must be a private repo you own."**
> That was a confidently wrong diagnosis: the URL was fine, git was missing. If
> you have been chasing a repository URL that you are sure is correct, update
> the app and try again — you will get the message above instead.

### "Repository not found" (or "404 Not Found")

The repository URL is wrong, the repository doesn't exist yet, or the token cannot see it.

- Check the URL in `.sync-config.json` — it should end in `.git`
- Make sure the repository exists on GitHub (visit the URL in your browser)
- Make sure the repository is not owned by an organisation that blocks PAT access

### "Cannot reach GitHub" (or "Network error" / "could not resolve host")

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

**Since the Windows app release (2026-11-20) this should not happen in a current version.** On Windows
The Curator now runs every one of its own git commands with the credential helper switched off
(`-c credential.helper= -c core.askPass=`, `GCM_INTERACTIVE=never`), in the Windows app and in the
browser install alike, because its token already travels with the request. A rejected token is then
the plain *"GitHub rejected the token saved for Sync"* message with **Replace token**, not a window.
The Windows app also brings its own git (MinGit), so it needs no Git for Windows at all
([windows-app.md § Sync works out of the box](windows-app.md#sync-works-out-of-the-box)). If you still
see a sign-in window (an older version, or a git started outside The Curator), the advice below applies.

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

### Connect messages added in v4.1.2

| Message | What it means | What to do |
|---|---|---|
| *"That repository address is not one Sync can use…"* | Not a repository address, or spaces in it | Paste the repository's own address, such as `https://github.com/your-name/your-wiki` |
| *"That token is not in a shape GitHub issues…"* | Part of a token, or spaces | Copy the whole token again (`ghp_…` or `github_pat_…`) |
| *"Sync is already connected on this computer…"* | Connect on an install that is connected | **Disconnect** first to use another repository; **Replace token** to change only the token |
| *"Your knowledge folder is not the one Sync backs up…"* | The folder changed after connecting | See [Changing the knowledge folder while Sync is connected](#changing-the-knowledge-folder-while-sync-is-connected) |
| *"Sync could not start because git left a lock file behind…"* | A git command was stopped part-way, so `index.lock` stayed | Quit every Curator window, delete `index.lock` inside `.knowledge-git`, sync again. The app never deletes it itself: another program may be using it |

Before v4.1.2 a malformed address or token read *"Cannot reach GitHub"* or *"Repository not found"*,
and a stale lock file read like a temporary error. The lock-file message is in [errors.md → Sync](errors.md#sync) as `sync-index-locked`, with every older Sync message; the other four are complete sentences with no catalogue code.

### "Push rejected" or "non-fast-forward update"

Someone pushed new changes to GitHub (from another computer) that you haven't pulled yet. The fix is just one click:

- Click **Sync now** — it pulls remote changes first, then pushes yours.

(If you previously used *Push only* and got this error, that's why. **Sync now** handles both directions and avoids the problem entirely.)

### "That repository already has a wiki in it" — while connecting

You chose **Push my wiki**, but the repository is not empty. That is not an
error in your setup; it just means the repository already holds a wiki, so
sending this folder up on top of it would throw that wiki away.

- If both sides have content you want, choose **Merge — keep both**.
- If this computer is the one you want to start from, choose **Pull an existing
  wiki** — and read the count it shows you first.

### "This sync would delete N pages" (or "...on this computer that are no longer in your GitHub backup")

*(Since v4.2.1.)* Sync stopped before changing anything because it would delete a lot: more than 5 files, a whole domain, or at least 3 files that are over 10% of what it tracks. Open **Sync**, choose **Show the pages**, and read the list. If you removed those pages on purpose, press **Delete them**. If you did not, press **Cancel**: check that the knowledge folder is the right one and fully present (a drive plugged in, a cloud folder finished downloading), then sync again. If the pages are on this computer and another computer removed them from GitHub, press **Cancel**, then **Disconnect this repository** and connect again with **Merge — keep both** to put them back on GitHub. See [When Sync asks before deleting](#when-sync-asks-before-deleting).

### "Pulling would overwrite N files in your domains folder"

Exactly what it says: those files are here with different content from the
repository's version, and Pull replaces them. The versions currently on this
machine are **not recoverable** afterwards — they have never been committed
anywhere.

- **Merge — keep both** is almost always what you want. It combines the two
  sides and commits this folder first, so nothing is lost either way.
- **Overwrite my local files** is there if you genuinely mean it — for example
  this computer's folder is a stale copy you want to discard.

### "Another sync check was running at the same time, so this one stopped early"

Two things reached git at once. **Nothing was changed** — wait a moment and click Sync again.

The Curator serialises its *own* fetches, so this is normally another **process** on the same machine: the MCP server your AI client spawned, or a second copy of the app. It is a normal outcome, not damage.

### "Pull found local files that would be overwritten by incoming changes"

Stop and read this one. It means a file that exists on your disk but is **not tracked by sync** would be destroyed by the incoming version, and at least one of them does not look like a routine sync file — so The Curator refused the pull rather than guessing.

- Nothing has been changed yet.
- **Back up your domains folder** (copy it somewhere safe) before doing anything else.
- Then ask for help. This needs a look at which files are involved, and there is no safe one-click answer.

Note this message never uses the word *conflict* — it is a different fault from the one below, and searching for "conflict" will not find it.

### Merge conflict — "Pull hit a real content conflict that couldn't be resolved automatically"

If two computers edited the same wiki page in incompatible ways, git cannot automatically merge them. The app's message is the sentence in the heading; the same advice applies — back up your domains folder first.

This is uncommon but can happen. To fix it:
1. Open a terminal in your project folder
2. Run `git --git-dir=.knowledge-git --work-tree=domains status` to see which files are conflicted
3. Open the conflicted file — it will contain markers like `<<<<<<< HEAD` and `>>>>>>> origin/main`
4. Edit the file to keep the version you want, removing the conflict markers
5. Run the command shown to complete the merge

If this feels complicated, the easiest recovery is to decide which machine has the "correct" version, and overwrite the other machine by using **Pull only** — inline beside **Sync now** — after discarding local changes.

### Stale `.write-lock` or `.DS_Store` files showing up in your changes

`.write-lock` and `.DS_Store` are machine-local bookkeeping files, not knowledge, and are excluded from sync (see the table above). If either was already committed before those exclusion rules existed, it would otherwise keep re-appearing in every sync forever. Since v3.0.16, both **Push only/Sync now** and **Pull only** automatically clean these up before doing anything else: any already-committed `.write-lock` or `.DS_Store` is untracked from git (removed from what's synced, left alone on your own disk), and any `.write-lock` file on your own machine that's genuinely dead (older than 30 minutes, or left behind by a process that's no longer running) is deleted outright. This is automatic — you don't need to do anything. If you notice one of these files disappear from your "pending changes" count after an update, that's this cleanup running, not something going wrong.

---

## Privacy note

Your repository is **private**. GitHub employees do not read private repository contents. Only you (and anyone you explicitly invite as a collaborator) can see your knowledge.

Your Personal Access Token is stored only on this computer, in `.sync-config.json` and in the sync history's own settings (`.knowledge-git/config`), both readable by your user account only. Neither is ever uploaded. When Sync shows a Technical detail line, the token is removed from it first.

Files that look like secrets inside your knowledge folder are refused as well (see "Secrets" above). Your AI provider API keys are also never synced — whichever providers you use. They live in `.curator-config.json` when you save them in Settings (or in `.env` if you use the developer fallback), both of which are gitignored and stay on the machine you entered them on.

---

## Token expiry

Expiry options depend on which token type you chose:

- **Classic tokens** offer 30 days, 60 days, 90 days, 1 year, or **No expiration**. For this set-and-forget use case, **No expiration** is the lowest-maintenance choice — sync is meant to be a quiet background habit, and since the token only has access to your repositories, the risk is low.
- **Fine-grained tokens** must have an expiry date (custom, up to **1 year**). They cannot be truly permanent. The upside is they're scoped to a single repository, so the security tradeoff favours fine-grained even though you'll renew it occasionally.

Whichever you choose, if the token has an expiry date, **make a calendar reminder to renew it** before it expires. Renewing is two minutes: create the new token on GitHub, then [**Replace token**](#replacing-the-token) on the Sync page. If you forget, Sync stops with *"GitHub rejected the token saved for Sync…"* and opens the same panel for you; nothing is lost in the meantime. If you'd rather never deal with renewals, use a classic token set to "No expiration".
