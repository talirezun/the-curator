# Shared Brain — User Guide

**For**: anyone joining or running a Shared Brain — contributors and admins. Step-by-step setup, daily workflow, and troubleshooting.
**Companions**: [`docs/shared-brain.md`](shared-brain.md) (concept & architecture) · [`docs/shared-brain-admin.md`](shared-brain-admin.md) (advanced admin operations) · [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) (GDPR / IP / residency) · [`docs/user-guide.md`](user-guide.md#15b-shared-brain) (main app user guide)

> 📚 **New to The Curator?** Read the [main user guide](user-guide.md) first — install, ingest, chat, personal sync. Shared Brain is an opt-in feature on top of the basic app, still in beta as of v3.17.2. You won't need it if you're a solo user.

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

1. Open The Curator — a browser install serves it at `http://localhost:3333`; the packaged Mac app opens in its own window.
2. Click **Shared Brain** in the left rail.
3. Click **"Enable Shared Brain (beta)"**.

> **Where this lives has moved twice — this guide describes the current interface.**
> Since the v3.9.0 cutover, Shared Brain is its own rail item and **everything**
> — enabling, joining, setting up, pushing, pulling, synthesis and admin actions
> — happens there. The **Sync** view covers Personal Sync only; it reports Shared
> Brain activity but no longer hosts any of its controls.
>
> The previous interface — where the enable toggle lived in **Settings → Shared
> Brain (beta)** and day-to-day operations were a **"Shared Brains"** block in
> the **Sync** tab — was deleted in v3.41.0 along with the rest of the
> pre-redesign shell (`/old`, which now just redirects to `/`). There is only
> one interface to follow these steps in now.

Once enabled, the Shared Brain view shows two cards:

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

In the **Shared Brain** rail view, on the **📨 I have an invite token** card, click **Join →**. A modal wizard appears with a 5-step progress bar (Token → Access → PAT → Domains → Save).

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
| **⚠ Token is read-only** (yellow) | Token works but lacks Contents: Read AND write | **Two valid options (v3.0.4+):** click **Continue →** to join as a **read-only member** (you can Pull the collective wiki but never Push — some brains offer exactly this as a free/lower tier), or re-create the token with Contents: Read AND write and paste again to become a full contributor |
| **✗ Token rejected** (red) | GitHub said no | Likely causes: (a) you didn't ACCEPT the collaborator invitation email yet → see Step 2 (this is the most common one), (b) token mis-copied → re-create and re-paste, (c) token scoped to wrong repo → re-create |

#### Step 4 — Domains + display name + attribution

- **Contributing domains**: tick which of YOUR personal domains push to this Shared Brain. The list filters out any `shared-*` mirrors (you can't contribute from one shared brain to another). Read-only members (yellow verdict in Step 3) can leave this empty — they don't push. Your ticks are remembered if you navigate Back and return.
- **Your display name**: stored on your own machine, in your connection. Whether it *leaves* your machine is decided entirely by the attribution checkbox below — leave that unticked (the default) and your name is never written to the shared repo at all. It never appears on the synthesised wiki pages either way; those always credit a short UUID. Defaults to "Anonymous Fellow" if you leave it blank — **and a pseudonym is a perfectly valid entry** if you would rather not be named.
- **Show my name in my contribution records (default: anonymous UUID)**: **off by default, and it does something real.** This is the one setting on this screen that decides whether your name leaves your computer, so read it before you tick it.

  **If you leave it unticked** (the default), your display name is never written to the shared repository. `contributorNameForStorage` in `src/brain/sharedbrain.js` returns `null`, and both routes out of your machine are suppressed: the `fellow_display_name` key is **omitted** from your contribution payload, and each per-page delta carries an empty `contributor_name`. The admin's member directory then shows you by your short UUID. Nothing identifies you but that UUID.

  **If you tick it**, that same function returns your display name and it is written on **every push** into `contributions/<your-uuid>/*.json` in the shared repository, plus into each per-page delta inside that payload. Concretely:

  - **Who can read it** — everyone with access to the repository: every current collaborator, anyone the admin adds later, and anyone who has already cloned it. It is in git history, so it is readable in every past commit even after a later change.
  - **Where it does *not* appear** — the synthesised collective wiki pages. Provenance sections and conflict markers show the first 8 characters of your UUID whether this is on or off; that has never carried names.
  - **It is not retroactive in either direction.** Ticking it later does not add your name to pushes you already made. Un-ticking it later does not remove your name from pushes already in the repository — the gate is forward-looking only, and there is no scrub. The only way to remove already-published names is a full [Article 17 revocation](shared-brain-compliance.md#2--right-to-erasure-gdpr-article-17), which erases **all** of your contributions, not just your name.
  - **You cannot change it in place.** The setting is fixed when you join; changing it means leaving the brain on this machine (**"Leave this Shared Brain"** on the connection card) and re-joining. See [`shared-brain-compliance.md` §1a](shared-brain-compliance.md#1a--withdrawing-name-attribution-consent-article-73--current-limitation).

  If you are unsure, leave it unticked. You can always join again later with it on; you cannot take a published name back without erasing your whole contribution history.

Click **Continue →**.

#### Step 5 — Review + consent + save

The wizard summarises your choices: brain name, repo, contributing domains, display name, attribution.

The consent block contains 4 bullet points about how data flows. **Read them carefully** — the second bullet changes based on the admin's data-handling-terms choice:

- **"You retain copyright in your original content"** (educational cohorts, research groups — default)
- **"You assign copyright in contributed pages to the organisation per your employment agreement"** (enterprise IP transfer mode)

If the consent doesn't match your understanding of the cohort, **stop and check with the admin**. Once you click Save & Connect, you're committed.

Tick the consent checkbox → **Save & Connect** activates → click it.

The wizard closes. You'll see a new connection card in the **Shared Brain** view showing:

- 🧠 **Brain name** with link to the GitHub repo (read-only members get a **read-only member** pill)
- Last pushed: never · Last pulled: never · **Last synthesis** (v3.0.4+ — "never — ask your admin to run synthesis" until the first one) · Domains: (your selection)
- A **pending line** when you have pages waiting to push ("⏳ N pages ready to push")
- **Push contributions** · **Pull updates** buttons (read-only members see only Pull)
- A note telling you pulled content appears as the `shared-<slug>` domain in **Domains**
- **Run synthesis (admin)** alongside them in the same action row, with a confirm step explaining the cost before it runs
- A **Cohort & sharing details** disclosure: contributor count, your share of the collective, and how many pages your mirror holds
- An **Admin controls — admin token & contributor revocation** disclosure (admins only — read-only members get no admin surface at all) with: Generate/Rotate admin token · Show invite token · Revoke a contributor…
- Your fellow-ID pill and a **Leave this Shared Brain** link in the card footer

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

In the Curator → **Shared Brain** rail view → on the **⚙ I'm starting a new Shared Brain** card → click **Set up →**. The same 5-step wizard appears, but the progress bar labels change to admin mode: **Setup → Invite → PAT → Domains → Save**.

#### Step 1 — Setup

Fill in the form:

- **Repository (owner/name)**: paste `<owner>/<name>` from Step A
- **Brain name**: a friendly label your contributors will see (e.g. "Spring 2026 ML Cohort"). NOT a URL or slug — humans-only.
- **Folder inside the repo**: auto-fills from the brain name. Where collective pages live in the repo (`collective/<folder>/wiki/`). Each contributor's machine sees this domain as `shared-<folder>/`. Override only if you want a specific slug.
- **Branch**: almost always `main`.
- **Data handling terms**: pick `contributor_retains` (educational/cohort default) or `organisational` (enterprise IP transfer). **Cannot be changed after invites go out** — re-issuing would require everyone to re-consent.

Click **Continue →**.

#### Step 2 — Invite token + admin token

The wizard generates the invite token and displays it in a copy-to-clipboard box. Click **Copy** → token is in your clipboard.

Send it to every cohort member via Slack, email, or any channel — the token contains no credentials, so it's safe to share. The wizard also gives you a link to the repo's **Settings → Collaborators** page so you can invite everyone if you haven't yet.

Below the invite token, the wizard shows your **admin token** (`sbat_…`, v3.0.5+). This one is the opposite of the invite token: it is a **secret credential** that authorises contributor revocation (GDPR erasure), it is shown **only here, only once**, and you must NOT share it with contributors. Store it in your password manager now — the revoke panel will ask you to paste it. (Lost it? On the connection card, **Admin controls — admin token & contributor revocation** → **Rotate token** issues a new one and invalidates the old.)

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

After setup, the **Shared Brain** view's connection card has two main buttons:

| Action | When to use it |
|---|---|
| **Push contributions** | After ingesting new sources into your contributing domains. Pushes the changed pages from **every opted-in domain** (v3.0.2+; older versions pushed only the first one) as Delta summaries to the shared repo. |
| **Pull updates** | Before reading the collective wiki. Refreshes your local `shared-<slug>/` mirror with the latest synthesised pages. Since v3.0.3 the pull is a **true mirror**: pages deleted from the collective (e.g. after a contributor revocation) are removed locally, and facts removed upstream actually disappear instead of lingering. |

A typical work session:

1. Open The Curator
2. (Optional) **Pull updates** to see what the cohort produced since you last looked
3. Read / chat / explore the `shared-<slug>/` domain
4. Ingest new sources into your **personal opted-in domain** (e.g. `work-ai/`) — NOT the shared mirror
5. **Push contributions** at the end of your session

Both Push and Pull are SSE-streamed: you'll see live progress as the operation runs. The connection card status box shows messages like *"Synthesizing entities/context-engineering.md (2 contributions)"* during synthesis. Since v3.0.4 the final summary **stays on the card** after the operation (surviving tab switches), only one operation can run per connection at a time, and **Leave this Shared Brain** is blocked while an operation runs.

**Card at-a-glance state (v3.0.4+):**

- **⏳ N pages ready to push** — pages changed since your last push (plus any queued retries). The same count feeds the navbar **Sync badge**, so from any tab you can see you have un-pushed Shared Brain contributions.
- **Last synthesis: …** — when the collective was last synthesised (learned from your own synthesis run, or from the repo on every Pull). *"never — ask your admin to run synthesis"* explains the classic "Pull pulled 0 pages" confusion.
- **⚠ N pages skipped after repeated failures** — expandable list of pages in `permanent_skip`, with a **Retry these pages on next push** button that re-queues them with a fresh strike counter (no page editing needed).

### For admins

Same as contributors, plus periodic synthesis (recommended weekly):

| Action | When |
|---|---|
| **Run synthesis (admin)** — in the card's main action row, beside Push and Pull | Weekly, or after a batch of pushes from your cohort. This is what merges contributions into the collective wiki. Since v3.0.5 a confirm step explains what it does before running (contributors who click it by accident can cancel). |
| **Revoke a contributor…** — under **Admin controls — admin token & contributor revocation** | When someone requests GDPR erasure or must be fully removed. Opens the member directory, asks for your admin token + a typed confirmation, then streams the irreversible erasure + rebuild. |

Detailed admin operations (synthesis cadence, contributor management, admin-token security, revocation) are in [`docs/shared-brain-admin.md`](shared-brain-admin.md).

### Using the collective wiki

Once a Shared Brain is set up, the `shared-<slug>/` domain appears in your Curator alongside your personal domains. You can:

- **Read** it from **Domains** — pick the `shared-<slug>` domain and open a page (the reader opens as an overlay; Esc closes it)
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
- You created the PAT with **Contents: Read-only**. If you intend to contribute, regenerate with **Contents: Read AND write** and paste again. If you're joining a Pull-only (read-only) tier, this is expected — since v3.0.4 you can click **Continue** and save; your card shows a **read-only member** pill and only the Pull button.

**"Repository not found"**
- Check the repo URL the admin gave you (typo in owner/name).
- Check that you accepted the GitHub collaborator invitation email.
- **On versions older than v3.26.0, a missing `git` also produced this message.** If the URL is definitely right, update the app; it now says *"Git is not available to The Curator"* instead and tells you how to install it ([sync.md](sync.md#git-is-not-available-to-the-curator-so-syncing-cannot-run)).

**Can't see the GitHub invitation email**
- Check spam folder.
- Ask the admin to look at the repo's Settings → Collaborators page — your name should appear with status "Pending invite". They can re-send.

**The "Open GitHub to create my token" button does nothing**
- A browser extension may be blocking it. Try in a private/incognito window, or right-click → Open in new tab.

### Daily-workflow problems

**Push says "0 of 0 pages" but I added new content**
- Your contributing domain's pages were ingested before your `last_push_at` timestamp. Either edit one page (touches mtime) to force re-push, OR ask the admin to run synthesis — they may have synced after your last push without you knowing.

**A page was "marked permanent_skip" — is it gone forever?**
- No. A page moves to permanent_skip after 3 genuine pre-processing failures. Since v3.0.4 the connection card shows a **"⚠ N pages skipped"** block — expand it and click **Retry these pages on next push** to re-queue them with a fresh strike counter. (The older recovery also still works: **edit the page** — any change updates its timestamp — and it retries automatically, v3.0.2+.) Temporary provider outages (503 / rate limits) never count toward the 3-failure limit — those pages just retry next time.

**Push/Pull button says another operation is in progress**
- Shared Brain operations now coordinate with ingest, app updates, and Personal Sync (v3.0.2+): you can't start a Pull while an ingest is writing, and you can't update/restart the app mid-Pull. Wait for the running operation to finish; the buttons re-enable automatically.

**A failed push used to show "push completed."**
- Fixed in v3.0.2 — failures (e.g. GitHub write errors) now show as errors with the real message, and successful operations show the real summary ("Pushed 7 pages. 3 will retry next time.").

**Pull pulls 0 pages but the collective wiki has content**
- The admin hasn't run synthesis since contributions arrived. Pull only fetches the synthesised collective pages, not raw contribution payloads. Ask the admin to run synthesis. Since v3.0.4 the connection card's **Last synthesis** stat makes this state visible directly — if it says "never", that's your answer.

**`shared-<slug>` domain appears in my domain list but I can't compile to it from Claude**
- That's by design — the mirror is read-only. Direct writes wouldn't propagate. Use the MCP write tools on your personal opted-in domain instead, then Push.

**Wiki Health "Fix" refuses to run on the `shared-<slug>` domain**
- Same reason — fixes to the mirror would be overwritten. Scanning a mirror is allowed (useful for spotting conflict markers), but every fix action returns a clear refusal (v3.0.2+). To fix a Health issue in the collective wiki, fix it upstream in your personal contributing domain, then Push. The mirror also no longer appears in the Ingest tab's domain dropdown.

**Status shows "GitHub rate limit is running low"**
- GitHub fine-grained PATs get 5000 REST requests/hour. Heavy synthesis on a large brain can approach this. Since v3.0.4 the warning appears directly in the operation's progress stream (previously it only went to the server log). Wait an hour and retry; for cohort-scale brains this is rare.

**SSE stream shows "SHARED_BRAIN_RATE_LIMIT"**
- You've exhausted the per-hour limit. Wait for the reset (check `x-ratelimit-reset` in browser DevTools network tab, or wait ~1 hour).

### Admin-specific

**Synthesis is asking the LLM and slow**
- Synthesis only invokes the LLM for **contradiction candidates** detected by the Jaccard heuristic. Each contradiction is ~200 tokens. On a 100-page brain with 5 contradictions, total is well under a minute.

**A contributor asks "where do I send my PAT?"**
- They don't. Each contributor creates their own PAT and pastes it into their own Curator. Never share PATs. See [`shared-brain.md` §4](shared-brain.md#4--the-two-primitives--invite-token-vs-pat).

**Conflicting facts in the collective wiki**
- After synthesis, look for `## CONFLICTING SOURCES` markers when reading the mirror's pages from **Domains**. Since v3.0.4 the synthesis summary on the connection card names the affected pages directly ("2 unresolved contradictions flagged in concepts/x.md, entities/y.md"). Each marker shows the contributors who disagreed (UUIDs or names). To resolve: discuss with the cohort. The contributor whose fact is correct edits their personal opted-in domain, then Push + Run synthesis again. The marker disappears once consensus is reached.

**Want to remove a contributor**
- See [`docs/shared-brain-admin.md` §6](shared-brain-admin.md#6--removing-a-contributor-without-revoking) — typically remove them as GitHub collaborator (stops future pushes but keeps past contributions). For full GDPR Article 17 erasure, see [§3 Revoking a contributor](shared-brain-admin.md#3--revoking-a-contributor-article-17).

---

## 6 — Quick reference

| Action | Where in the Curator app |
|---|---|
| Enable Shared Brain (beta) | **Shared Brain** rail view → Enable button |
| Join a cohort (contributor) | **Shared Brain** → **📨 I have an invite token** → Join → paste invite token |
| Start a new cohort (admin) | **Shared Brain** → **⚙ I'm starting a new Shared Brain** → Set up |
| Push your contributions | **Shared Brain** → connection card → "Push contributions" |
| Pull collective updates | **Shared Brain** → connection card → "Pull updates" |
| Run synthesis (admin) | **Shared Brain** → connection card → "Run synthesis (admin)" (main action row, beside Push and Pull) |
| See cohort size / your share | **Shared Brain** → connection card → **"Cohort & sharing details"** |
| Revoke a contributor (admin) | **Shared Brain** → connection card → **"Admin controls — admin token & contributor revocation"** (shown only when the connection has an admin token). The curl equivalent is in [`shared-brain-admin.md` §3](shared-brain-admin.md#3--revoking-a-contributor-article-17) |
| Leave the brain on this machine | **Shared Brain** → connection card footer → **"Leave this Shared Brain"** (removes the connection only; your local files, including the read-only mirror, stay) |

> Through v3.40.0 the same actions lived in **Settings → Shared Brain (beta)** (enable) and the **Sync** tab's "Shared Brains" block (everything else), in the pre-redesign shell at `/old`. That shell was deleted in v3.41.0.

## 7 — Terminology

These terms appear in the wizard, in the docs, and in audit logs. Confusing two of them —
**invite token vs. Personal Access Token** — is the single most common setup mistake.

| Term | Definition | ⚠️ Don't confuse it with… |
|------|-----------|---------------------------|
| **Shared Brain** | A collective Curator wiki shared with a cohort, team, or research group. Each contributor's personal Curator stays private; only opted-in domains push to a shared private GitHub repo | Personal Sync, which backs up YOUR full wiki to YOUR own private repo |
| **Contributor** | Anyone in the cohort who joins and pushes contributions. There are N contributors per cohort | The Admin (just one per cohort) |
| **Admin** | The one person who creates the GitHub repo, generates the invite token, invites collaborators, and runs synthesis | A contributor — though the admin is also a contributor with their own data |
| **Invite token** (`sbi_…`) | **Metadata-only** label that tells the wizard which repo to connect to. Contains NO credentials. Safe to share with the whole cohort via Slack or email | A PAT — they are completely different things |
| **Personal Access Token** (`github_pat_…`) | **Credential** issued by GitHub. Each contributor creates their OWN. Never shared with anyone. Stays on the contributor's machine only | The invite token. Sharing your PAT is a security disaster |
| **Opted-in domain** | A personal Curator domain that the contributor explicitly chose to push to the Shared Brain. Other personal domains stay private | A `shared-<slug>` mirror domain (which is the pull destination, not the push source) |
| **Mirror domain** (`shared-<slug>/`) | The local read-only copy of the synthesised collective wiki, pulled to every contributor's machine | An opted-in domain. The Curator app, MCP write tools, and Health fixes refuse direct writes to mirror domains by design |
| **Delta summary** | The LLM-pre-processed payload that gets pushed to shared storage — `{new_facts, removed_links, …}` for each changed page. Not a raw markdown file | The wiki page itself — a Delta is the structured *change*, not the page |
| **Synthesis** | The admin-triggered process that merges all contributions into the collective wiki, applies the merge rules (union facts, resolve contradictions, attribute provenance, rebuild index) | Push (which sends contributions) or Pull (which fetches synthesised pages) |
| **Provenance** | The auto-appended section on every collective page listing contributor UUIDs (or names, where the admin enabled that) | Authorship of a personal opted-in page — that stays purely on the contributor's machine |
| **Conflict marker** | The block synthesis inserts when two contributors disagree and the LLM can't unify their facts | A Wiki Health broken-link issue. Conflict markers are specific to Shared Brain synthesis |
| **Data handling terms** | The admin's IP-mode choice at brain setup: `contributor_retains` (default; educational/cohort) or `organisational` (enterprise IP transfer). **Locked once invites go out** | Privacy controls. This is specifically about *copyright in contributed content*, not about who sees what |
| **Revocation** (GDPR Article 17) | Admin-triggered operation that permanently deletes a contributor's submissions, removes their facts from collective pages, and appends an audit log entry. Irreversible | Removing a contributor as a GitHub collaborator (which stops future pushes but doesn't erase past contributions) |

> The Curator's own core vocabulary — Atomic Decomposition, Entities / Concepts / Summaries,
> Network Compounding — is in [Domains § 6](domains.md#6-terminology).

---

## 8 — Related documentation

- [`docs/shared-brain.md`](shared-brain.md) — the architecture & design decisions behind Shared Brain
- [`docs/shared-brain-admin.md`](shared-brain-admin.md) — advanced admin operations (synthesis cadence, contributor management, revocation, health monitoring)
- [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) — GDPR, IP modes, EU residency for orgs evaluating deployment
- [`docs/user-guide.md`](user-guide.md) — main Curator app user guide (install, ingest, chat, personal sync)
- [`docs/use-cases.md`](use-cases.md) — example use cases including cohort/team patterns
