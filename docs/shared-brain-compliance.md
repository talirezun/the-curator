# Shared Brain — Compliance reference

**Audience**: cohort admins, IT, professors, small-business owners evaluating Shared Brain for a real deployment. Plain English, not legal advice — but the operational truth of what the system does with your contributors' data.

**Companion docs**: [`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md) (step-by-step user guide) · [`docs/shared-brain.md`](shared-brain.md) (concept & architecture, engineering decisions) · [`docs/shared-brain-admin.md`](shared-brain-admin.md) (advanced admin operations)

---

## 1 — What PII (personal data) is stored, and where

The Curator's Shared Brain is **fundamentally decentralised**. Each contributor's Curator runs on their own computer; only opted-in domains get pushed to the shared repo. Most of a contributor's data never leaves their machine.

The table below covers everything that DOES leave a contributor's machine and ends up in shared storage (your private GitHub repo).

| Data | Where it's stored | Why it's there | Per GDPR Article 4 |
|---|---|---|---|
| Wiki page text (entities, concepts, summaries) | `collective/<domain>/wiki/` in shared repo | The contributor explicitly chose to contribute this domain. Pages are LLM-synthesised summaries of their facts, not raw drafts. | Content — not directly PII unless contributors write PII into their wiki pages themselves |
| Fellow UUID (random 128-bit identifier) | `contributions/<fellow_id>/*.json` + Provenance sections on every page | Identifies which contributor authored which facts so synthesis can attribute provenance | **Pseudonymous identifier** under Article 4(5) — not directly identifying unless mapped to a real name |
| Real display name (`fellow_display_name`) | `contributions/<fellow_id>/*.json`, and copied into each delta as `contributor_name` — **only when the contributor opted in** via `attribute_by_name` (v3.6.2+; the default is off, and an absent or non-boolean flag suppresses). When they did **not** opt in, the payload key is omitted entirely and the delta key is present but empty (`""`) — no name is stored either way; the reason the two routes differ is in [`shared-brain.md` §6a](shared-brain.md). NOT on synthesised wiki pages, even for opted-in contributors (see §3). | Whatever the contributor typed as their display name in the connection wizard. It is read back to build the admin member directory, which shows a name for **any** contributor whose stored payloads carry one — including payloads pushed before v3.6.2, when the name was written unconditionally — and the 8-character short fellow-ID for everyone else. | **Personal data** under Article 4(1) if the contributor entered a real name. Readable by every collaborator on the private repo. **Before v3.6.2 it was written unconditionally on every push** — the gate is not retroactive, so names already published remain in shared storage and in that repository's git history; revoke is the only removal path. **Withdrawing this consent has no in-place toggle — see §1a.** |
| Contribution timestamps | `contributions/<fellow_id>/<submission_id>.json` (the `contributed_at` field) | Used by synthesis for chronological ordering | Metadata; combinable with UUID to infer activity patterns |
| Synthesis state | `meta/state/last-synthesis.json` | Tracks when the last synthesis ran across the whole brain | Not contributor-specific |
| Revocation audit log | `state/revocations.jsonl` | Records each revocation event (UUID + timestamp + a sha256 hash of the admin token + success/failure counts) for admin accountability. Only for runs that reach the audit step — see §2b step 5. | Pseudonymous; no real names |

**What's never in shared storage:**

- Email addresses
- IP addresses
- Each contributor's full personal wiki (only their opted-in domains)
- Each contributor's chat conversations
- Each contributor's API keys, PATs, or any credential
- LLM prompt/response data (synthesis runs locally on each contributor's machine, never in shared storage)

> **The display name is not in that list, and it is governed by consent — not by absence.**
> Since **v3.6.2** a contributor's display name is written to the shared repo only when they
> ticked *"Show my name in my contribution records (default: anonymous UUID)"* in the join
> wizard (`attribute_by_name`); the default is off, and an
> absent or non-boolean flag suppresses. When they did opt in, the name is written on **every
> push** and every collaborator on the repo can read it. Tell contributors this before they
> fill in the field. A contributor who wants to stay pseudonymous should leave the box
> unticked — and should still enter a pseudonym rather than their legal name, since the field
> is free text and nothing downstream depends on it being real.
>
> **Before v3.6.2 the name was written unconditionally, with no flag governing it.** The gate
> is not retroactive: names already in `contributions/<fellow_id>/*.json` remain in shared
> storage and in that repository's git history. Revocation (§2) is the only removal path.
>
> **Which means the admin member directory is not changed by upgrading, and you must not tell a
> data subject otherwise.** The directory is built by reading *every* contribution payload ever
> stored (`groupMembers`, `src/brain/sharedbrain.js`) and displays a name for anyone whose
> payloads carry one, whenever it was written. On a cohort that existed before v3.6.2, every
> contributor who entered a real name is **still listed by that name** after the upgrade, opted
> in or not. Only someone who has never had a name written — a joiner on a post-v3.6.2 cohort
> who left the box unticked, or someone whose payloads have all been revoked — shows as a bare
> short-ID. Check the directory before making any statement about it.
>
> The **synthesised wiki pages** are a different matter and the pseudonymity claim there does
> hold, for opted-in and opted-out contributors alike: `## Provenance` sections and conflict
> markers carry only the first 8 hex characters of the fellow UUID. The display name is never
> rendered onto a collective page.

### 1a — Withdrawing name-attribution consent (Article 7(3)) — current limitation

`attribute_by_name` is a **consent** in the Article 7 sense: it is opt-in, it defaults to off,
and it governs whether personal data (a real name, if the contributor entered one) is published
to shared storage. Article 7(3) expects withdrawal to be as easy as giving it. **Today it is
not**, and this is stated plainly rather than implied:

| | How it works today |
|---|---|
| **When it is chosen** | Once, in the join wizard (step 4). It is saved with the connection. |
| **How to change it** | There is **no attribution toggle on the connection card**. The contributor must **leave the Shared Brain on that machine** (connection card footer → **"Leave this Shared Brain"**) **and re-join** with the box in the other state. |
| **Is it retroactive?** | **No.** Un-ticking (or re-joining without it) stops *future* pushes from carrying the name. Names already written into `contributions/<fellow_id>/*.json` stay in shared storage and in that repository's git history — and the admin member directory keeps displaying the old name for as long as any payload carrying it survives. |
| **How to remove names already published** | A **full revocation** (§2). That is the only mechanism that deletes a contributor's submission payloads from shared storage — and even then, see §2c on git history. |

**What this means in practice.** A withdrawal request that only needs to affect future pushes is
satisfied by leaving and re-joining, and a contributor can do it themselves. A withdrawal request
that must also remove names already published is an **erasure** request and should be handled
under §2 — route it to the cohort admin as an Article 17 revocation. Do not describe the wizard
setting as a way to remove a name that has already been pushed.

A first-class attribution toggle on the connection card (changeable without disconnecting) is a
**known follow-up**, not a shipped capability.

---

## 2 — Right to erasure (GDPR Article 17)

The Curator implements Article 17 ("right to be forgotten") as a **first-class operation** with a dedicated admin endpoint. Documentation, technical detail, and the admin procedure follow.

### 2a — Who can trigger a revocation

Only the **cohort admin** can revoke a contributor. Two-factor gate prevents accidental or malicious revocation:

1. The admin must possess the connection's `admin_token` (only the admin has it — generated at brain setup, never shared).
2. The admin must type a literal confirmation string `REVOKE-<fellow_id>` in the request body. This is the same pattern GitHub uses for repo deletion — it forces the admin to consciously target a specific UUID.

### 2b — What the revocation does

When `POST /api/sharedbrain/:connection_id/revoke` runs with valid credentials and confirmation, the system:

1. **Deletes the contributor's submission payloads** — it lists `contributions/<fellow_id>/` and deletes each file in turn. A per-file failure does **not** stop the run (the remaining payloads are still erased) but since **v3.6.2** it is recorded in `contributions_failed` and forces `erasure_complete: false`.
2. **Deletes the contributor's digest** — `digests/<fellow_id>/latest.json` (the per-fellow synthesis input cache, which would hold their facts) is removed. A failure is recorded in `digest_failed` and is likewise an erasure failure. **On a real deployment today this step is a defensive no-op**: nothing in the shipped code ever *writes* a digest (`storeDigest` has no callers outside the storage adapters), so the file does not exist, the delete reports "nothing to remove", and `digest_failed` stays `null`. The step and its erasure-failure classification are in place for when digests are wired up — see the Deferred table in [`docs/shared-brain.md`](shared-brain.md).
3. **Scans and rebuilds every affected collective page** — every page that referenced the revoked fellow in its Provenance section is deleted (matched on the 8-character short fellow-ID, which is what Provenance actually writes; a full UUID is matched too), then regenerated from the remaining contributors' contributions only. Their facts no longer appear in the unified content. Pages with no remaining contributors stay deleted. Per-page failures are recorded in `pages_failed`. **If the page listing itself cannot be read the run ABORTS** without rebuilding — not knowing *what* to erase is an unattempted erasure, not a partial one.
4. **Updates the synthesis state** — `meta/state/last-synthesis.json` is rebuilt to reflect the post-revocation state.
5. **Appends an audit entry** — `state/revocations.jsonl` gains one line: `{"revoked_at": "<ISO>", "fellow_id": "<uuid>", "by_admin_token_hash": "<sha256>", "contributions_deleted": N, "pages_deleted": M, "pages_rebuilt": R, "rebuild_ok": true|false, "erasure_complete": true|false, "contributions_failed": N, "pages_failed": N, "digest_failed": true|false, "pages_rebuild_failed": N, "state_reset_failed": true|false, "revocation_id": "<uuid>"}`. Failures are recorded as **counts and booleans only** — the audit log still contains no real names and no contribution content, and deliberately no provider error text either. Admins can review revocation history — including attempts that *recorded* failures — without exposing PII. **Note the limit, because it matters for an audit trail:** this line is written near the end of the run, so it exists only for revocations that got that far. A run that aborts earlier writes **no** audit line at all — that covers an unreadable collective-page listing (step 3), and a failure to initialise storage, to write the in-progress marker, or to list the contributor's submissions. Those attempts leave `state/revocations.jsonl` looking as if they never happened; record them yourself from the API response.

> ### ⚠️ Read `erasure_complete` before certifying an erasure
>
> **Up to v3.6.1 this section described a manual duty, because the operation could not be trusted
> to report its own failures.** Individual delete failures (a transient GitHub 5xx, a rate-limit,
> a SHA conflict) were caught and written to the server console only: they did not fail the
> operation and did not appear in the progress stream, so a revocation that erased 9 of 11
> payloads reported success. An admin could certify an Article 17 erasure that had not happened.
>
> **Since v3.6.2 the operation is self-reporting.** Every erasure step records what failed:
>
> - `erasure_complete: false` whenever any contribution, the digest, or any provenance-tainted
>   page survived. This is the single field to read before answering a data subject.
> - `contributions_failed`, `digest_failed`, `pages_failed` name exactly what survived and why.
> - `ok: false`, with one of **two** headlines on `summary` — they mean different things and the
>   distinction is deliberate:
>   - **"⚠ ERASURE INCOMPLETE — this contributor's data has NOT been fully removed"** — some of
>     their data survived. `erasure_complete` is `false`. Do not certify.
>   - **"Erasure completed (…), but the revocation did NOT finish cleanly"** — the erasure itself
>     succeeded (`erasure_complete: true`) and a *later* step failed: the rebuild, some rebuilt
>     pages, the audit write, the watermark reset, or clearing the marker. The data subject's
>     request has been honoured; the collective and/or your audit trail still need the re-run.
>
>   The words *"Revocation complete"* are produced only when nothing at all failed.
> - **When the erasure itself is incomplete the revocation-in-progress marker is not cleared**, so
>   ordinary synthesis refuses for every contributor in the cohort until a clean re-run. A partial
>   erasure cannot be quietly walked away from. The marker is held only by things that leave the
>   collective mid-erasure: a surviving contribution, digest or page; a failed rebuild; pages the
>   rebuild could not write; or the case where the clear itself failed to write. A failed
>   **audit** write and a failed **watermark** reset are reported as problems and set `ok: false`
>   but do **not** hold the marker — neither says anything about whether the collective is
>   half-erased, and taking a whole cohort offline for a bookkeeping failure was judged the worse
>   outcome. **So do not infer the marker from the fact that something failed — read the result.**
>   `marker_active` answers "is cohort synthesis blocked right now?" directly; `marker_cleared`
>   says whether this run cleared it. See
>   [`shared-brain-admin.md` §3](shared-brain-admin.md#3--revoking-a-contributor-article-17) for
>   the field table and the recovery paths.
> - When the run reaches the audit step, the audit line records the failure counts, so an
>   incomplete attempt is visible in `state/revocations.jsonl` afterwards rather than looking like
>   a clean run. **A run that aborts before that step writes no line at all** — see step 5 above.
>
> **After every revocation:**
>
> 1. Confirm `erasure_complete` is `true`. If it is `false`, read the numbered problems in
>    `summary`, fix the cause, and **re-run the revocation** — it is idempotent, and it will
>    erase whatever is left.
> 2. For a formal Article 17 response, take independent evidence from the repo itself:
>    `contributions/<fellow_id>/` and `digests/<fellow_id>/` should both be gone. **Record it** —
>    a self-report is a strong signal, but the repository state is the evidence.
> 3. `rebuild_ok: false` (or `pages_rebuild_failed > 0`) means the erasure happened but the
>    collective was not fully rebuilt. The data subject's request is honoured; the collective
>    still needs the re-run.

### 2c — What revocation does NOT remove

- **Git history.** GitHub retains commit history. Old commits still contain the revoked contributor's data. The admin can prune git history via `git filter-repo` if absolute erasure is required — see §2d.
- **Local copies on other contributors' machines.** Each contributor's Curator pulls a local mirror of the shared brain. Those local mirrors are NOT automatically purged on revoke. Contributors with stale mirrors will see the revoked content until they next pull. Since v3.0.3, Pull is a true mirror operation: pages are written with `{ replace: true }` (no union-merge), so facts removed from a surviving page genuinely disappear locally, and pages deleted from the collective are pruned from the mirror. Contributors must be on v3.0.3+ for erasure to propagate at all. **One caveat that matters for erasure: the prune step only runs when the pull processed *every* remote page.** If any page is skipped (a read error, an unwritable path), the cleanup is deliberately skipped rather than risk deleting live content, and the pull reports *"N page(s) could not be processed this pull — skipping stale-page cleanup to be safe."* A contributor who sees that warning still holds the deleted pages and should pull again until it is gone.
- **Backups.** If your cohort takes external backups of the shared repo (e.g. a CI mirror to another git host), revocation does not propagate to those backups. The admin must manually purge backups if absolute erasure is required.

### 2d — Absolute erasure procedure (for high-compliance scenarios)

For deployments where GDPR Article 17 must be honored absolutely (e.g. EU enterprise), follow these steps after the standard revocation:

1. Run the standard revocation via the Curator admin UI or `POST /api/sharedbrain/:id/revoke`.
2. From a local clone of the shared repo, run `git filter-repo --path 'contributions/<fellow_id>/' --invert-paths --force` to scrub all commits containing the revoked fellow's contribution payloads.
3. Force-push the rewritten history: `git push --force origin main`. All collaborators will need to re-clone the repo.
4. Notify each contributor that their local mirror must be discarded and re-pulled.
5. Purge any external backups (CI mirrors, organisational archives) that retain pre-revocation history.

### 2e — Revocation is irreversible

Once a revocation runs, the contributor's contributions cannot be reconstructed from shared storage. If the contributor's local wiki is also gone (e.g. they uninstalled The Curator), the data is unrecoverable. **The admin UI shows a typed-confirmation prompt before triggering revoke** to prevent accidents.

---

## 3 — Copyright & IP — two modes

Shared Brain supports two `data_handling_terms` modes, set by the admin at brain setup. The mode is **encoded in the invite token** so every contributor's wizard shows the consent text that matches.

### 3a — `contributor_retains` (default)

**Use this for:** educational cohorts, research groups, voluntary contribution networks, open-source style collaborations.

**Consent text shown to every contributor in the wizard:**

> By clicking Save & Connect you agree:
> - Only pages from the domains you selected will be pushed to the Shared Brain.
> - **You retain copyright in your original content.** The cohort owns the synthesised collective output.
> - You can disconnect anytime — your local wiki is unaffected.
> - Your access token is stored locally on this computer only.

**What this means in practice:**

- Each contributor keeps copyright in the wiki pages they originally authored. They can use those pages elsewhere, publish them, re-share them.
- The synthesised collective output (the result of merging multiple contributors' facts into unified pages) is owned by the cohort/organisation.
- Revocation removes a contributor's facts from the collective; they keep their local content unchanged.

### 3b — `organisational` (IP transfer)

**Use this for:** enterprise deployments where employee contracts already cover IP transfer (e.g. employment agreements with assignment clauses).

**Consent text shown to every contributor in the wizard:**

> By clicking Save & Connect you agree:
> - Only pages from the domains you selected will be pushed to the Shared Brain.
> - **By contributing, you assign copyright in contributed pages to the organisation per your employment agreement.**
> - You can disconnect anytime — your local wiki is unaffected.
> - Your access token is stored locally on this computer only.

**What this means in practice:**

- Once a page is contributed, the organisation owns it for all purposes.
- The contributor still keeps their local wiki — they can still see and use it themselves — but they cannot legally re-publish the contributed content without permission.
- This mode requires your organisation's employment contracts to actually contain an IP-assignment clause. The Curator does NOT verify this; it's your legal responsibility.

### 3c — Choosing between modes

- **In doubt?** Pick `contributor_retains`. It's the safer default and the only legally valid choice when contributors are NOT bound by an IP-assignment clause.
- **The mode is locked after invites go out.** Changing it would require generating new invite tokens and asking every contributor to re-consent. Choose deliberately.

---

## 4 — EU data residency

> ## ⛔ There is no EU-resident deployment of Shared Brain today.
>
> The shipped GitHub adapter has `const GITHUB_API = 'https://api.github.com'` written into it
> ([`src/brain/sharedbrain-github-adapter.js`](../src/brain/sharedbrain-github-adapter.js)) with
> **no configurable endpoint**. It therefore cannot reach GitHub Enterprise Cloud with data
> residency, and it cannot reach GitHub Enterprise Server either. The repo's own
> [`LICENSES/LICENSE-ENTERPRISE.txt`](../LICENSES/LICENSE-ENTERPRISE.txt) §1.6 states this
> explicitly.
>
> **Do not buy the EU data residency add-on expecting Shared Brain to work with it.** It will
> not connect. Buying it on the strength of an earlier version of this document was a real
> possibility, and that is the error this box exists to prevent.
>
> If your deployment is EU-regulated: Shared Brain is **not currently a compliant option**, and no
> configuration or plan upgrade makes it one. The R2 path in §4b would change that, but it has not
> shipped. Treat §4a and §4c below as a description of GitHub's plans, not as a route The Curator
> can take you down.

### 4a — GitHub-backed Shared Brains: where your data actually lands

Shared Brain talks to `api.github.com` — the public GitHub service — for every account plan.
GitHub's storage location for repositories on those plans is the United States:

| Plan | Where a Shared Brain repo lives | Reachable by the shipped adapter? |
|---|---|---|
| Free, Pro | United States | Yes |
| Team | United States | Yes |
| Enterprise Cloud **with EU data residency** | European Union | **No** — different API host; the adapter cannot connect |
| Enterprise Server (self-hosted) | Wherever you host it | **No** — different API host; the adapter cannot connect |

So in practice: **every working Shared Brain today stores its data in the United States.** If that
is acceptable for your jurisdiction and data, you are fine. If it is not, there is no supported
configuration — see the box above.

### 4b — Cloudflare R2-backed Shared Brains (planned, not shipped)

Cloudflare R2 supports per-bucket jurisdiction tagging. The Worker configuration enables EU residency via:

```toml
[[r2_buckets]]
binding = "SHARED_BRAIN"
bucket_name = "my-shared-brain"
jurisdiction = "eu"
```

Data stays in EU data centres regardless of where your contributors or admins are located. This is the intended path for EU-based deployments once it ships. It is scheduled after Shared Brain GA — see the [roadmap in `shared-brain.md`](shared-brain.md#7--roadmap) for where it sits relative to everything else, rather than relying on a milestone name repeated here.

### 4c — Other jurisdictions

- **United States**: the shipped adapter works and your data stays in the US.
- **United Kingdom, EU, and anywhere else with a residency requirement**: not supported today, for
  the reason in the box at the top of §4 — the adapter can only reach `api.github.com`. Enterprise
  Cloud with residency and Enterprise Server are both unreachable, so a plan upgrade does not help.
  The R2 path in §4b is the intended answer and has not shipped.

---

## 5 — Self-assessment checklist

Before deploying Shared Brain for a real cohort or team, answer these five yes/no questions:

| | Question |
|---|---|
| 1 | **Do you understand which contributors will write what data into their personal wikis?** Your contributors' personal wikis are private — only their explicitly opted-in domains push to the shared brain. But contributors control what they write into their own opted-in domains. If they write PII (real names, emails, sensitive personal data) into wiki pages they then opt-in to contribute, that PII lands in the shared repo. Train your contributors on this. |
| 2 | **Is US data residency acceptable for this deployment?** It has to be. Every working Shared Brain stores its data in the US, because the adapter can only reach `api.github.com` — see §4. If you are in the EU, UK, or any region with a residency requirement, the honest answer to this question is "no" and there is no configuration that changes it. |
| 3 | **Have you chosen the right `data_handling_terms` mode?** §3 covers the two modes. Pick deliberately at brain setup — it's encoded in the invite token. |
| 4 | **Do you have an admin procedure for revocation requests?** When a contributor leaves (graduates, changes jobs, requests removal), someone needs to run the revoke operation. The Curator UI surfaces this in the **Shared Brain** rail view → the connection's card → **"Admin controls — admin token & contributor revocation"** (visible only when the connection holds an admin token). Document who in your org has the `admin_token` and the procedure. |
| 5 | **Do you understand the absolute-erasure procedure?** Standard revocation removes the contributor's data from the live brain but git history retains it. For absolute erasure see §2d. If your contributors might invoke this right, make sure someone in your org knows how. |

If any answer is "no" — pause the deployment and resolve the gap before inviting contributors.

---

## 6 — What this document is not

- It's not legal advice. Your organisation may have specific compliance obligations (HIPAA, FERPA, SOC 2, sector-specific regulations) that go beyond GDPR. Consult your legal team.
- It's not a complete data-protection impact assessment (DPIA). If your jurisdiction requires a DPIA for tools that process personal data, this document is an input to that process, not a substitute for it.
- It's not a vendor agreement. The Curator is open-source software with no warranty — see `LICENSE` in the root of the repository. There is no service-level agreement, no support contract, no data processing agreement (DPA) you can sign with anyone. You are the operator of your Shared Brain.
- It's not a substitute for asking questions. If something is unclear, raise an issue on the project's GitHub or talk to your organisation's privacy officer before deploying.

---

**Document version**: aligns with the Shared Brain feature set on the Curator v3.0.x beta line. Updated when the operational truth changes.
