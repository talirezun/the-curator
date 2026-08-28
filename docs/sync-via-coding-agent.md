# Set up GitHub sync with a coding agent (automated)

This is the **third way** to set up sync, alongside the in-app wizard ([sync.md](sync.md)) and the manual route. If you already use a CLI-aware AI coding agent — **Claude Code**, **Cursor**, **opencode**, **Augment**, **Cline**, **Aider**, **GitHub Copilot CLI**, or any agent that can run shell commands and reach your GitHub — you can hand the whole sync setup to the agent and let it do it end-to-end.

It's the fastest path for people who live in a terminal, and it removes every manual step that trips users up: creating an *empty* repo, choosing the right token with the right permissions, and pasting things into the wizard.

> **When to prefer this over the wizard:** you have a coding agent already wired to your machine and GitHub, and you'd rather approve a couple of commands than click through a 3-step UI. If you don't use a coding agent, the [in-app wizard](sync.md) is the right path.

---

## What the agent will do

1. **Create an empty, private GitHub repo** (no README/.gitignore/license — an empty repo is required so the first push isn't rejected).
2. **Obtain a token** the Curator can use:
   - If the GitHub CLI (`gh`) is authenticated, the agent can use `gh auth token` directly — zero browser steps.
   - Otherwise it walks you through creating a **fine-grained token** (Contents: Read and write) and pastes it in for you.
3. **Trigger the first sync** by calling The Curator's own setup endpoint (`POST http://localhost:3333/api/sync/setup`) — this reuses the exact same, tested code path the wizard uses, so nothing is reimplemented.
4. **Verify** the result via `GET /api/sync/status` and report back.

The token lands in `.sync-config.json` (gitignored, local-only) — same as the wizard.

---

## Prerequisites

- The Curator **installed** and ideally **running** (`node src/server.js` → `http://localhost:3333`). The agent can start it if it isn't.
- A coding agent that can **run shell commands** in the Curator project folder and make local HTTP requests.
- **GitHub access**, one of:
  - The **GitHub CLI** (`gh`) installed and authenticated (`gh auth login`) — the smoothest, fully-automatic path, **or**
  - You're willing to create a **Personal Access Token** in the browser when the agent asks (see [sync.md](sync.md#step-4--create-and-enter-a-personal-access-token) for the exact permissions).

---

## Copy-paste prompt — first computer (push)

Use this on the machine that **already has your knowledge** and an **empty** new GitHub repo (or let the agent create the repo).

```
Set up GitHub sync for my local "The Curator" app on this machine.

Context:
- The Curator project folder is the current working directory (it contains src/server.js, domains/, package.json).
- The app exposes a local API at http://localhost:3333.
- Setup guide: https://github.com/talirezun/the-curator/blob/main/docs/sync.md

Do this:
1. Confirm the Curator server is running: GET http://localhost:3333/api/sync/status.
   If it isn't reachable, start it (`node src/server.js`) and wait until the status endpoint responds.
2. Create a NEW PRIVATE GitHub repo named "my-brain" (ask me for a different name if I prefer).
   It MUST be empty — do NOT add a README, .gitignore, or license. Prefer: `gh repo create my-brain --private`.
   Capture the repo's HTTPS URL (https://github.com/<me>/my-brain).
3. Get a token the app can use for git over HTTPS:
   - If `gh auth status` shows I'm logged in, use `gh auth token`.
   - Otherwise, tell me to create a FINE-GRAINED token at
     https://github.com/settings/personal-access-tokens/new with:
       Repository access → Only select repositories → my-brain
       Permissions → Repository permissions → Contents → Read and write
     and wait for me to paste it.
4. Trigger the initial sync by calling the app's own setup endpoint (this reuses the app's tested git logic):
   POST http://localhost:3333/api/sync/setup
   Content-Type: application/json
   { "repoUrl": "<the repo URL>", "token": "<the token>", "mode": "push" }
5. Verify: GET http://localhost:3333/api/sync/status — confirm it reports configured with no error.
6. Report what you did. Do NOT print my token in the summary. Do NOT commit .sync-config.json
   (it's gitignored). Do NOT touch anything outside this project folder.
```

## Copy-paste prompt — second computer (pull)

Use this on an **additional** machine to download a brain you already pushed from another computer. Point it at the **same** repo.

```
Set up GitHub sync for my local "The Curator" app on this SECOND machine — I want to PULL an
existing brain I already pushed from another computer.

Context:
- Curator project folder is the current working directory; local API at http://localhost:3333.
- The existing repo is: https://github.com/<me>/my-brain   (ask me if you don't have it)

Do this:
1. Confirm the Curator server responds at http://localhost:3333/api/sync/status (start it if needed).
2. Get a token for git over HTTPS — use `gh auth token` if `gh` is logged in, otherwise ask me to
   paste a fine-grained token with Contents: Read and write on that repo.
3. Call POST http://localhost:3333/api/sync/setup with
   { "repoUrl": "<repo URL>", "token": "<token>", "mode": "pull" }
4. Verify via GET /api/sync/status and confirm my domains now appear (GET /api/domains).
5. Report. Never print the token. Don't modify anything outside the project folder.
```

---

## Tools & permissions the agent needs

| Capability | Why |
|---|---|
| **Run shell commands** in the project folder | To run `gh` / `git` and start the server |
| **Local HTTP requests** to `localhost:3333` | To call `/api/sync/setup` and `/api/sync/status` |
| **`gh` CLI** (optional but ideal) | Creates the repo and supplies a token with no browser step |
| **Write access to the project folder** | The setup endpoint writes `.sync-config.json` and `.knowledge-git/` there |

The agent does **not** need access to your API keys, your `domains/` content, or anything outside the project folder.

---

## Notes & caveats

- **Empty repo is mandatory.** A repo created with a README/.gitignore/license will reject the first push. If the agent reuses an existing non-empty repo, tell it to use `mode: "pull"` first (to absorb the remote), or create a fresh empty repo.
- **`gh auth token` is broad.** The token the GitHub CLI hands out has the CLI's full scope, not a repo-scoped fine-grained token. It works fine for sync, but if you want the tightest security, have the agent stop at step 3 and create a **fine-grained** token (Contents: Read and write, single repo) instead — see [sync.md](sync.md#step-4--create-and-enter-a-personal-access-token).
- **The token is stored locally.** `.sync-config.json` is gitignored and never leaves your machine — same as the wizard.
- **One write path.** The agent calls the same `/api/sync/setup` endpoint the wizard uses, so there's no parallel or untested logic — the git init/commit/push happens inside The Curator exactly as designed.
- **After setup, daily use is unchanged.** Click **Sync now** in the Sync view (or have your agent `POST /api/sync/sync`). See [sync.md → Daily workflow](sync.md#daily-workflow).

---

## If something fails

The agent surfaces the API's error message verbatim. The most common ones and their fixes are in [sync.md → Troubleshooting](sync.md#troubleshooting) — in particular:

- **403 / authentication failed** → the token lacks **Contents: Read and write** (fine-grained) or `repo` (classic).
- **Push rejected / non-fast-forward** → the repo wasn't empty; pull first or recreate it empty.
- **"Failed to fetch" / server not responding** → the Curator server stopped; restart it and retry.

---

## Related

- [sync.md](sync.md) — the full Personal Sync guide (wizard, tokens, daily workflow, troubleshooting)
- [user-guide.md §20](user-guide.md#20-install-with-a-coding-agent) — installing The Curator itself with a coding agent
