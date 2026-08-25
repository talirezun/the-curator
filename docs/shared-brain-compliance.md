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
| Real display name (`fellow_display_name`) | `contributions/<fellow_id>/*.json` — **on every push, unconditionally**. Also copied into each delta as `contributor_name`. NOT on synthesised wiki pages (see §3). | Whatever the contributor typed as their display name in the connection wizard. It is read back to build the admin member directory. | **Personal data** under Article 4(1) if the contributor entered a real name. Readable by every collaborator on the private repo. |
| Contribution timestamps | `contributions/<fellow_id>/<submission_id>.json` (the `contributed_at` field) | Used by synthesis for chronological ordering | Metadata; combinable with UUID to infer activity patterns |
| Synthesis state | `meta/state/last-synthesis.json` | Tracks when the last synthesis ran across the whole brain | Not contributor-specific |
| Revocation audit log | `state/revocations.jsonl` | Records each revocation event (UUID + timestamp) for admin accountability | Pseudonymous; no real names |

**What's never in shared storage:**

- Email addresses
- IP addresses
- Each contributor's full personal wiki (only their opted-in domains)
- Each contributor's chat conversations
- Each contributor's API keys, PATs, or any credential
- LLM prompt/response data (synthesis runs locally on each contributor's machine, never in shared storage)

> **The display name is not in that list, and that is a real disclosure obligation.**
> Whatever a contributor types as their display name is written to the shared repo on every
> single push, with no flag governing it, and every collaborator on the repo can read it.
> Tell contributors this before they fill in the field. A contributor who wants to stay
> pseudonymous should enter a pseudonym, not their legal name — the field is free text and
> nothing downstream depends on it being real.
>
> The **synthesised wiki pages** are a different matter and the pseudonymity claim there does
> hold: `## Provenance` sections and conflict markers carry only the first 8 hex characters of
> the fellow UUID. The display name is never rendered onto a collective page.

---

## 2 — Right to erasure (GDPR Article 17)

The Curator implements Article 17 ("right to be forgotten") as a **first-class operation** with a dedicated admin endpoint. Documentation, technical detail, and the admin procedure follow.

### 2a — Who can trigger a revocation

Only the **cohort admin** can revoke a contributor. Two-factor gate prevents accidental or malicious revocation:

1. The admin must possess the connection's `admin_token` (only the admin has it — generated at brain setup, never shared).
2. The admin must type a literal confirmation string `REVOKE-<fellow_id>` in the request body. This is the same pattern GitHub uses for repo deletion — it forces the admin to consciously target a specific UUID.

### 2b — What the revocation does

When `POST /api/sharedbrain/:connection_id/revoke` runs with valid credentials and confirmation, the system:

1. **Attempts to delete the contributor's submission payloads** — it lists `contributions/<fellow_id>/` and deletes each file in turn. ⚠️ **A per-file delete failure is logged to the server console and otherwise swallowed**: the loop continues, the operation does not fail, and the final message can still read "Revocation complete". The only signal you get is a count. **The admin MUST verify erasure** — see the box below.
2. **Deletes the contributor's digest** — `digests/<fellow_id>/latest.json` (the per-fellow synthesis input cache) is removed. A failure here is likewise only logged.
3. **Rebuilds every affected collective page** — every page that referenced the revoked fellow's UUID in its Provenance section is regenerated from the remaining contributors' contributions only. Their facts no longer appear in the unified content. Pages with no remaining contributors are deleted entirely.
4. **Updates the synthesis state** — `meta/state/last-synthesis.json` is rebuilt to reflect the post-revocation state.
5. **Appends an audit entry** — `state/revocations.jsonl` gains one line: `{"revoked_at": "<ISO>", "fellow_id": "<uuid>", "by_admin_token_hash": "<sha256>", "contributions_deleted": N, "pages_deleted": M, "pages_rebuilt": R, "rebuild_ok": true|false, "revocation_id": "<uuid>"}`. The audit log contains only the UUID — no real names, no contribution content. Admins can review revocation history without exposing PII.

> ### ⚠️ Verify the erasure — "Revocation complete" is not proof
>
> Individual delete failures (a transient GitHub 5xx, a rate-limit, a SHA conflict) are caught and
> written to the server console only. They do not fail the operation and they do not appear in the
> progress stream. A revocation that erased 9 of 11 payloads reports success.
>
> **After every revocation, do this:**
>
> 1. Note the *"Found N contributions to delete"* line in the progress stream.
> 2. Compare it against `contributions_deleted` in the audit record (also returned in the response
>    body). **They must be equal.**
> 3. If they differ — or if you want independent confirmation — check the repo directly:
>    `contributions/<fellow_id>/` should be gone, as should `digests/<fellow_id>/`.
> 4. If anything remains, **re-run the revocation**. It is idempotent: already-deleted files are
>    simply absent, and the rebuild recomputes from whatever survives.
>
> Also check `rebuild_ok`. If it is `false`, the erasure happened but the collective pages were not
> rebuilt; the in-progress marker stays set, ordinary synthesis keeps refusing, and you must re-run
> the revocation to finish. That state is reported, not silent.
>
> If you are answering a formal Article 17 request, step 3 is the evidence — record it.

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
> - You can disconnect anytime from the Sync tab — your local wiki is unaffected.
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
> - You can disconnect anytime from the Sync tab — your local wiki is unaffected.
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

### 4b — Cloudflare R2-backed Shared Brains (Phase 5+, not in v3.0.0-beta.1)

Cloudflare R2 supports per-bucket jurisdiction tagging. The Worker configuration enables EU residency via:

```toml
[[r2_buckets]]
binding = "SHARED_BRAIN"
bucket_name = "my-shared-brain"
jurisdiction = "eu"
```

Data stays in EU data centres regardless of where your contributors or admins are located. This is the recommended path for EU-based deployments once Phase 5 ships.

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
| 4 | **Do you have an admin procedure for revocation requests?** When a contributor leaves (graduates, changes jobs, requests removal), someone needs to run the revoke operation. The Curator UI surfaces this on the **Sync** tab → the connection's card → **Advanced** → **"Revoke a contributor…"** (visible only when the connection holds an admin token). Document who in your org has the `admin_token` and the procedure. |
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
