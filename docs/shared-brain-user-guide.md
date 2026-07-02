# Shared Brain — User Guide

**For**: anyone joining or running a Shared Brain — contributors and admins. Step-by-step setup, daily workflow, and troubleshooting.
**Companions**: [`docs/shared-brain.md`](shared-brain.md) (concept & architecture) · [`docs/shared-brain-admin.md`](shared-brain-admin.md) (advanced admin operations) · [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) (GDPR / IP / residency) · [`docs/user-guide.md`](user-guide.md#15b-shared-brain) (main app user guide)

> 📚 **New to The Curator?** Read the [main user guide](user-guide.md) first — install, ingest, chat, personal sync. Shared Brain is a v3.0.0-beta opt-in feature on top of the basic app. You won't need it if you're a solo user.

---

## What you'll do — pick your path

Shared Brain has two roles. Most cohort members are **contributors**; one person per cohort is the **admin**.

| You are… | Skip to |
|---|---|
| Joining an existing Shared Brain (you received an invite token) | [§2 Contributor setup](#2--contributor-setup-join-an-existing-shared-brain) |
| Starting a new Shared Brain for your team | [§3 Admin setup](#3--admin-setup-start-a-new-shared-brain) |
| Already set up — just want daily workflow | [§4 Daily workflow](#4--daily-workflow) |
| Hit a problem | [§5 Troubleshooting](#5--troubleshooting) |

Before any of these, you need a working Curator install on your computer (Mac/Windows/Linux). Follow the main [User Guide](user-guide.md) §3 if you haven't yet.

---

## 1 — Enable Shared Brain (one-time, both roles)

Shared Brain is an **opt-in beta feature** (introduced in v3.0.0-beta.1). New installs don't see it until you enable it.

1. Open The Curator in your browser (http://localhost:3333).
2. Click the **Settings** tab.
3. Scroll to the **"Shared Brain (beta)"** section and click **"Enable Shared Brain (beta)"**.
4. Open the **Sync** tab (the confirmation links straight to it).

> Since v3.0.2 the enable toggle lives in **Settings** (it's a one-time
> configuration choice); the day-to-day operations stay in the **Sync** tab next
> to Personal Sync. On older versions (v3.0.0-beta.1 → v3.0.1-beta.27) the
> enable button was at the bottom of the Sync tab instead.

Once enabled, the Sync tab shows a **"Shared Brains"** block with two cards:

- **📨 I have an invite token** — *From my cohort, team, or research group.* — `[Join →]` button
- **⚙ I'm starting a new Shared Brain** — *Set one up for my cohort or team.* — `[Set up →]` button

You only do this once per computer. The setting is remembered in `.curator-config.json`.

---

## 2 — Contributor setup (join an existing Shared Brain)

This is the path 95% of users take. You've been invited to contribute to a Shared Brain by an admin. Here's the full flow.

### Prerequisites

Before starting the wizard, make sure:

1. **You have a GitHub account.** (Free is fine.)
2. **You received an invite token** from the admin. It starts with `sbi_`. The admin shares it via Slack, email, etc. The token contains NO credentials — it's safe to share via any channel.
3. **The admin has invited you as a collaborator** on the shared repo. **Check your email** for an invitation from GitHub — subject usually starts with "[GitHub] X invited you to <repo>". Click **View invitation** → **Accept invitation**. If you don't see the email, check spam, or ask the admin to resend.

You CANNOT proceed without accepting the GitHub collaborator invitation. The Curator wizard can't grant you GitHub access — that's GitHub's job.

### Step-by-step wizard

In the Sync tab → Shared Brains section → on the **📨 I have an invite token** card → click **Join →**. A modal wizard appears with a 5-step progress bar (Token → Access → PAT → Domains → Save).

#### Step 1 — Token

Paste your invite token (`sbi_...`) into the field. After ~300ms a green preview appears showing the brain name, repo URL, branch, and shared domain. Click **Continue →**.

#### Step 2 — Access

The wizard reminds you to accept the GitHub email invitation. Click the **Open the repo on GitHub** link to verify you can see the repo. If you can, click **"I've accepted — continue →"**. If you can't (404 or "you don't have access"), go back to your email and accept the invitation, then click the link again.

#### Step 3 — PAT (your personal access token)

This is the most technical step. Take your time.

1. Click the **Open GitHub to create my token →** button. It opens GitHub's fine-grained PAT page in a new tab. The token name is prefilled (`Curator Shared Brain - <Brain Name>`).
2. On the GitHub page:
   - **Resource owner**: your personal account
   - **Repository access**: choose **Only select repositories** → click the dropdown → pick the cohort repo
   - **Repository permissions**: click **+ Add permissions** → search "Contents" → select it → set access to **Read and write** (NOT just read)
   - Leave Metadata: Read-only (GitHub auto-adds this)
   - Scroll to bottom → **Generate token**
3. GitHub shows the token (`github_pat_...`) **once**. Copy it immediately.
4. Switch back to The Curator wizard and paste into the **"Paste your token here"** field.

Within ~400ms the wizard validates the token against the cohort repo. Three possible outcomes:

| Result | What it means | What to do |
|---|---|---|
| **✓ Token verified** (green) | All good — token valid, write access confirmed | Click **Continue →** |
| **⚠ Token is read-only** (yellow) | Token works but lacks Contents: Read AND write | Re-create the token with the correct permission, paste again |
| **✗ Token rejected** (red) | GitHub said no | Likely causes: (a) token mis-copied → re-create and re-paste, (b) you didn't accept the collaborator invitation yet → see Step 2, (c) token scoped to wrong repo → re-create |

#### Step 4 — Domains + display name + attribution

- **Contributing domains**: tick which of YOUR personal domains push to this Shared Brain. The list filters out any `shared-*` mirrors (you can't contribute from one shared brain to another).
- **Your display name**: pick a friendly name for the Provenance section. Defaults to "Anonymous Fellow" if you don't fill it in.
- **Show my name in Provenance sections**: leave unticked (default UUID) unless the admin specifically asked everyone to identify themselves. Even if you tick this, your name only appears if the ADMIN also enabled cohort-side name attribution — defensive double-gate per GDPR.

Click **Continue →**.

#### Step 5 — Review + consent + save

The wizard summarises your choices: brain name, repo, contributing domains, display name, attribution.

The consent block contains 4 bullet points about how data flows. **Read them carefully** — the second bullet changes based on the admin's data-handling-terms choice:

- **"You retain copyright in your original content"** (educational cohorts, research groups — default)
- **"You assign copyright in contributed pages to the organisation per your employment agreement"** (enterprise IP transfer mode)

If the consent doesn't match your understanding of the cohort, **stop and check with the admin**. Once you click Save & Connect, you're committed.

Tick the consent checkbox → **Save & Connect** activates → click it.

The wizard closes. You'll see a new connection card in the Sync tab showing:

- 🧠 **Brain name** with link to the GitHub repo
- Last pushed: never · Last pulled: never · Domains: (your selection)
- **Push contributions** · **Pull updates** buttons
- An "Advanced" disclosure with synthesize + your fellow-ID + disconnect

You're done. Skip to [§4 Daily workflow](#4--daily-workflow).

---

## 3 — Admin setup (start a new Shared Brain)

Only one person per cohort does this. It's a one-time operation.

### Prerequisites

1. **You have a GitHub account** (free works for personal repos; Enterprise Cloud with EU residency if your cohort needs EU compliance — see [`shared-brain-compliance.md` §4](shared-brain-compliance.md#4--eu-data-residency)).
2. **You know your contributors' GitHub usernames or emails** so you can invite them as collaborators.
3. **You've thought about data handling**: cohort/education = `contributor_retains` (default); enterprise with IP-transfer = `organisational`. The choice is **locked once you share the invite token** because contributors consent to the mode at join time. See [`shared-brain-compliance.md` §3](shared-brain-compliance.md#3--copyright--ip--two-modes).

### Step A — Create the private GitHub repo

1. Open https://github.com/new.
2. Repository name: anything descriptive (e.g. `spring-2026-ml-cohort-brain`).
3. **Visibility: Private** — always. Public Shared Brains are not supported.
4. Tick **Add a README file** so the `main` branch exists.
5. **Create repository**.

Note the URL — you'll need `<owner>/<name>` (the part after `github.com/`) for the wizard.

### Step B — Invite contributors as GitHub collaborators

This is the step that **grants write access**. The Curator's invite token alone doesn't.

1. From the new repo page → **Settings → Collaborators**.
2. Click **Add people**. Type each contributor's GitHub username or email. Click **Add**.
3. GitHub sends each one an invitation email. They click Accept on their end.

You can do this before OR after running the admin wizard. Order doesn't matter — contributors just need GitHub access before they can create their own PAT.

### Step C — Run the admin wizard

In the Curator → Sync tab → Shared Brains → on the **⚙ I'm starting a new Shared Brain** card → click **Set up →**. The same 5-step wizard appears, but the progress bar labels change to admin mode: **Setup → Invite → PAT → Domains → Save**.

#### Step 1 — Setup

Fill in the form:

- **Repository (owner/name)**: paste `<owner>/<name>` from Step A
- **Brain name**: a friendly label your contributors will see (e.g. "Spring 2026 ML Cohort"). NOT a URL or slug — humans-only.
- **Folder inside the repo**: auto-fills from the brain name. Where collective pages live in the repo (`collective/<folder>/wiki/`). Each contributor's machine sees this domain as `shared-<folder>/`. Override only if you want a specific slug.
- **Branch**: almost always `main`.
- **Data handling terms**: pick `contributor_retains` (educational/cohort default) or `organisational` (enterprise IP transfer). **Cannot be changed after invites go out** — re-issuing would require everyone to re-consent.

Click **Continue →**.

#### Step 2 — Invite token

The wizard generates the invite token and displays it in a copy-to-clipboard box. Click **Copy** → token is in your clipboard.

Send it to every cohort member via Slack, email, or any channel — the token contains no credentials, so it's safe to share. The wizard also gives you a link to the repo's **Settings → Collaborators** page so you can invite everyone if you haven't yet.

Click **Set up my contribution →** to continue. You're now setting up YOUR own contributor identity (the admin is also a contributor).

#### Steps 3-5 — same as contributor flow

Steps 3-5 of the admin path are identical to the contributor flow's steps 3-5: create your own PAT, pick your contributing domains, consent. Follow [§2 above](#2--contributor-setup-join-an-existing-shared-brain) from "Step 3 — PAT" onward.

### Step D — Brief your contributors

Send each contributor:

1. The invite token (`sbi_...`)
2. A reminder to accept the GitHub collaborator invitation email
3. Optionally a link to this guide ([`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md)) so they can follow the contributor path

You're done with setup. Daily ongoing operations are in [`docs/shared-brain-admin.md`](shared-brain-admin.md).

---

## 4 — Daily workflow

### For contributors

After setup, the Sync tab → Shared Brains → connection card has two main buttons:

| Action | When to use it |
|---|---|
| **Push contributions** | After ingesting new sources into your contributing domains. Pushes the changed pages from **every opted-in domain** (v3.0.2+; older versions pushed only the first one) as Delta summaries to the shared repo. |
| **Pull updates** | Before reading the collective wiki. Refreshes your local `shared-<slug>/` mirror with the latest synthesised pages. |

A typical work session:

1. Open The Curator
2. (Optional) **Pull updates** to see what the cohort produced since you last looked
3. Read / chat / explore the `shared-<slug>/` domain
4. Ingest new sources into your **personal opted-in domain** (e.g. `work-ai/`) — NOT the shared mirror
5. **Push contributions** at the end of your session

Both Push and Pull are SSE-streamed: you'll see live progress as the operation runs. The connection card status box shows messages like *"Synthesizing entities/context-engineering.md (2 contributions)"* during synthesis.

### For admins

Same as contributors, plus periodic synthesis (recommended weekly):

| Action | When |
|---|---|
| **Run synthesis (admin)** in Advanced disclosure | Weekly, or after a batch of pushes from your cohort. This is what merges contributions into the collective wiki. |

Detailed admin operations (synthesis cadence, contributor management, revocation) are in [`docs/shared-brain-admin.md`](shared-brain-admin.md).

### Using the collective wiki

Once a Shared Brain is set up, the `shared-<slug>/` domain appears in your Curator alongside your personal domains. You can:

- **Read** it in the Wiki tab
- **Chat** with it in the Chat tab (it's a domain like any other)
- **Explore** it in Obsidian (open `domains/shared-<slug>/wiki/` as a vault folder)
- **Search** it from Claude Desktop via the My Curator MCP

**Writing directly to the mirror is refused** by the Curator app, MCP write tools, and Health fixes. This is intentional — direct writes wouldn't propagate to other contributors and would be overwritten on the next Pull. To contribute, work in your personal opted-in domain, then Push.

---

## 5 — Troubleshooting

### Wizard problems

**"Token verified ✓" never appears even though the token looks right**
- Most common cause: the admin hasn't added you as a collaborator yet, or you haven't accepted the email invitation.
- Open the repo URL in a new browser tab. If you see 404 or "you don't have access", that's the problem.

**"Token is read-only" warning**
- You created the PAT with **Contents: Read-only**. Regenerate with **Contents: Read AND write** and paste again.

**"Repository not found"**
- Check the repo URL the admin gave you (typo in owner/name).
- Check that you accepted the GitHub collaborator invitation email.

**Can't see the GitHub invitation email**
- Check spam folder.
- Ask the admin to look at the repo's Settings → Collaborators page — your name should appear with status "Pending invite". They can re-send.

**The "Open GitHub to create my token" button does nothing**
- A browser extension may be blocking it. Try in a private/incognito window, or right-click → Open in new tab.

### Daily-workflow problems

**Push says "0 of 0 pages" but I added new content**
- Your contributing domain's pages were ingested before your `last_push_at` timestamp. Either edit one page (touches mtime) to force re-push, OR ask the admin to run synthesis — they may have synced after your last push without you knowing.

**A page was "marked permanent_skip" — is it gone forever?**
- No. A page moves to permanent_skip after 3 genuine pre-processing failures. **Edit the page** (any change — even adding a blank line — updates its timestamp) and it retries automatically on your next Push (v3.0.2+). Temporary provider outages (503 / rate limits) never count toward the 3-failure limit — those pages just retry next time.

**Push/Pull button says another operation is in progress**
- Shared Brain operations now coordinate with ingest, app updates, and Personal Sync (v3.0.2+): you can't start a Pull while an ingest is writing, and you can't update/restart the app mid-Pull. Wait for the running operation to finish; the buttons re-enable automatically.

**A failed push used to show "push completed."**
- Fixed in v3.0.2 — failures (e.g. GitHub write errors) now show as errors with the real message, and successful operations show the real summary ("Pushed 7 pages. 3 will retry next time.").

**Pull pulls 0 pages but the collective wiki has content**
- The admin hasn't run synthesis since contributions arrived. Pull only fetches the synthesised collective pages, not raw contribution payloads. Ask the admin to run synthesis.

**`shared-<slug>` domain appears in my domain list but I can't compile to it from Claude**
- That's by design — the mirror is read-only. Direct writes wouldn't propagate. Use the MCP write tools on your personal opted-in domain instead, then Push.

**Wiki Health "Fix" refuses to run on the `shared-<slug>` domain**
- Same reason — fixes to the mirror would be overwritten. Scanning a mirror is allowed (useful for spotting conflict markers), but every fix action returns a clear refusal (v3.0.2+). To fix a Health issue in the collective wiki, fix it upstream in your personal contributing domain, then Push. The mirror also no longer appears in the Ingest tab's domain dropdown.

**SSE stream shows "rate limit low: N requests remaining"**
- GitHub fine-grained PATs get 5000 REST requests/hour. Heavy synthesis on a large brain can approach this. Wait an hour and retry; for cohort-scale brains this is rare.

**SSE stream shows "SHARED_BRAIN_RATE_LIMIT"**
- You've exhausted the per-hour limit. Wait for the reset (check `x-ratelimit-reset` in browser DevTools network tab, or wait ~1 hour).

### Admin-specific

**Synthesis is asking the LLM and slow**
- Synthesis only invokes the LLM for **contradiction candidates** detected by the Jaccard heuristic. Each contradiction is ~200 tokens. On a 100-page brain with 5 contradictions, total is well under a minute.

**A contributor asks "where do I send my PAT?"**
- They don't. Each contributor creates their own PAT and pastes it into their own Curator. Never share PATs. See [`shared-brain.md` §4](shared-brain.md#4--the-two-primitives--invite-token-vs-pat).

**Conflicting facts in the collective wiki**
- After synthesis, look for `## CONFLICTING SOURCES` markers in the Wiki tab. Each marker shows the contributors who disagreed (UUIDs or names). To resolve: discuss with the cohort. The contributor whose fact is correct edits their personal opted-in domain, then Push + Run synthesis again. The marker disappears once consensus is reached.

**Want to remove a contributor**
- See [`docs/shared-brain-admin.md` §6](shared-brain-admin.md#6--removing-a-contributor-without-revoking) — typically remove them as GitHub collaborator (stops future pushes but keeps past contributions). For full GDPR Article 17 erasure, see [§3 Revoking a contributor](shared-brain-admin.md#3--revoking-a-contributor-article-17).

---

## 6 — Quick reference

| Action | Where in the Curator app |
|---|---|
| Enable Shared Brain (beta) | Settings tab → "Shared Brain (beta)" section → Enable button (v3.0.2+; previously at the bottom of the Sync tab) |
| Join a cohort (contributor) | Sync tab → **📨 I have an invite token** → Join → paste invite token |
| Start a new cohort (admin) | Sync tab → **⚙ I'm starting a new Shared Brain** → Set up |
| Push your contributions | Sync tab → connection card → "Push contributions" |
| Pull collective updates | Sync tab → connection card → "Pull updates" |
| Run synthesis (admin) | Sync tab → connection card → Advanced → "Run synthesis" |
| Revoke a contributor (admin) | API only in v3.0.0-beta.1 — see [`shared-brain-admin.md` §3](shared-brain-admin.md#3--revoking-a-contributor-article-17) |
| Disconnect this machine | Sync tab → connection card → Advanced → "Disconnect" |

## 7 — Related documentation

- [`docs/shared-brain.md`](shared-brain.md) — the architecture & design decisions behind Shared Brain
- [`docs/shared-brain-admin.md`](shared-brain-admin.md) — advanced admin operations (synthesis cadence, contributor management, revocation, health monitoring)
- [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) — GDPR, IP modes, EU residency for orgs evaluating deployment
- [`docs/user-guide.md`](user-guide.md) — main Curator app user guide (install, ingest, chat, personal sync)
- [`docs/use-cases.md`](use-cases.md) — example use cases including cohort/team patterns
