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
| Real display name | Provenance sections on pages **only when both attribution flags are on** (see §3) | Optional human-readable attribution | **Personal data** under Article 4(1) when present |
| Contribution timestamps | `contributions/<fellow_id>/<submission_id>.json` (the `contributed_at` field) | Used by synthesis for chronological ordering | Metadata; combinable with UUID to infer activity patterns |
| Synthesis state | `meta/state/last-synthesis.json` | Tracks when the last synthesis ran across the whole brain | Not contributor-specific |
| Revocation audit log | `state/revocations.jsonl` | Records each revocation event (UUID + timestamp) for admin accountability | Pseudonymous; no real names |

**What's never in shared storage:**

- Real names (unless both attribution flags are explicitly enabled — see §3)
- Email addresses
- IP addresses
- Each contributor's full personal wiki (only their opted-in domains)
- Each contributor's chat conversations
- Each contributor's API keys, PATs, or any credential
- LLM prompt/response data (synthesis runs locally on each contributor's machine, never in shared storage)

---

## 2 — Right to erasure (GDPR Article 17)

The Curator implements Article 17 ("right to be forgotten") as a **first-class operation** with a dedicated admin endpoint. Documentation, technical detail, and the admin procedure follow.

### 2a — Who can trigger a revocation

Only the **cohort admin** can revoke a contributor. Two-factor gate prevents accidental or malicious revocation:

1. The admin must possess the connection's `admin_token` (only the admin has it — generated at brain setup, never shared).
2. The admin must type a literal confirmation string `REVOKE-<fellow_id>` in the request body. This is the same pattern GitHub uses for repo deletion — it forces the admin to consciously target a specific UUID.

### 2b — What the revocation does

When `POST /api/sharedbrain/:connection_id/revoke` runs with valid credentials and confirmation, the system:

1. **Deletes the contributor's submission payloads** — every `contributions/<fellow_id>/*.json` file is removed from the shared storage.
2. **Deletes the contributor's digest** — `digests/<fellow_id>/latest.json` (the per-fellow synthesis input cache) is removed.
3. **Rebuilds every affected collective page** — every page that referenced the revoked fellow's UUID in its Provenance section is regenerated from the remaining contributors' contributions only. Their facts no longer appear in the unified content. Pages with no remaining contributors are deleted entirely.
4. **Updates the synthesis state** — `meta/state/last-synthesis.json` is rebuilt to reflect the post-revocation state.
5. **Appends an audit entry** — `state/revocations.jsonl` gains one line: `{"revoked_at": "<ISO>", "fellow_id": "<uuid>", "by_admin_token_hash": "<sha256>", "pages_rebuilt": N, "pages_deleted": M}`. The audit log contains only the UUID — no real names, no contribution content. Admins can review revocation history without exposing PII.

### 2c — What revocation does NOT remove

- **Git history.** GitHub retains commit history. Old commits still contain the revoked contributor's data. The admin can prune git history via `git filter-repo` if absolute erasure is required — see §2d.
- **Local copies on other contributors' machines.** Each contributor's Curator pulls a local mirror of the shared brain. Those local mirrors are NOT automatically purged on revoke. Contributors with stale mirrors will see the revoked content until they next pull, which will reflect the post-revocation state.
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

GitHub and Cloudflare R2 have different residency profiles. Choose the right adapter for your jurisdiction.

### 4a — GitHub-backed Shared Brains (v3.0.0+)

GitHub's default storage location depends on your account plan:

| Plan | Default residency | EU residency option |
|---|---|---|
| Free, Pro | United States | Not available — use Enterprise Cloud |
| Team | United States | Not available — use Enterprise Cloud |
| **Enterprise Cloud with EU data residency** | **European Union** | **✓ Required for EU compliance** |

For **EU-regulated deployments** (universities, EU businesses, public sector), you must use **GitHub Enterprise Cloud with the EU data residency add-on**. Confirm with GitHub Support that your specific repository is in the EU region — it's set at the organisation level when the account is provisioned.

If you're on a Free/Pro/Team plan and need EU residency: the GitHub Shared Brain adapter is not the right choice. Wait for the Cloudflare R2 adapter (Phase 5+) or self-host using an alternative.

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

- **United Kingdom**: GitHub Free/Pro stores data in US — same as EU. Use Enterprise Cloud for UK residency.
- **United States**: Default GitHub plans work.
- **China, Russia, restricted regions**: Use Cloudflare R2 with the appropriate jurisdiction tag (when Phase 5 ships), or self-host.

---

## 5 — Self-assessment checklist

Before deploying Shared Brain for a real cohort or team, answer these five yes/no questions:

| | Question |
|---|---|
| 1 | **Do you understand which contributors will write what data into their personal wikis?** Your contributors' personal wikis are private — only their explicitly opted-in domains push to the shared brain. But contributors control what they write into their own opted-in domains. If they write PII (real names, emails, sensitive personal data) into wiki pages they then opt-in to contribute, that PII lands in the shared repo. Train your contributors on this. |
| 2 | **Have you confirmed your GitHub plan's data residency matches your legal jurisdiction?** Check §4a above. Default GitHub plans store data in the US. If you're in the EU, UK, or any region with data-residency requirements, you need GitHub Enterprise Cloud with the matching residency option. |
| 3 | **Have you chosen the right `data_handling_terms` mode?** §3 covers the two modes. Pick deliberately at brain setup — it's encoded in the invite token. |
| 4 | **Do you have an admin procedure for revocation requests?** When a contributor leaves (graduates, changes jobs, requests removal), someone needs to run the revoke operation. The Curator UI surfaces this in Settings → Advanced → Revoke contributor. Document who in your org has the `admin_token` and the procedure. |
| 5 | **Do you understand the absolute-erasure procedure?** Standard revocation removes the contributor's data from the live brain but git history retains it. For absolute erasure see §2d. If your contributors might invoke this right, make sure someone in your org knows how. |

If any answer is "no" — pause the deployment and resolve the gap before inviting contributors.

---

## 6 — What this document is not

- It's not legal advice. Your organisation may have specific compliance obligations (HIPAA, FERPA, SOC 2, sector-specific regulations) that go beyond GDPR. Consult your legal team.
- It's not a complete data-protection impact assessment (DPIA). If your jurisdiction requires a DPIA for tools that process personal data, this document is an input to that process, not a substitute for it.
- It's not a vendor agreement. The Curator is open-source software with no warranty — see `LICENSE` in the root of the repository. There is no service-level agreement, no support contract, no data processing agreement (DPA) you can sign with anyone. You are the operator of your Shared Brain.
- It's not a substitute for asking questions. If something is unclear, raise an issue on the project's GitHub or talk to your organisation's privacy officer before deploying.

---

**Document version**: aligns with Curator v3.0.1-beta.20. Updated when the operational truth changes.
