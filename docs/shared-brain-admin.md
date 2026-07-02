# Shared Brain — Admin Operations

**For**: admins who have already set up a Shared Brain and need to run ongoing operations — periodic synthesis, contributor management, revocation, health monitoring. This is the **post-setup** reference.
**For initial setup**: see [`docs/shared-brain-user-guide.md` §3 — Admin setup](shared-brain-user-guide.md#3--admin-setup-start-a-new-shared-brain).
**Companions**: [`docs/shared-brain.md`](shared-brain.md) (concept & architecture) · [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) (GDPR / IP / residency) · [`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md) (step-by-step user guide).

---

## 1 — Your responsibilities as admin

Running a Shared Brain is mostly turnkey, but a few duties land on you specifically:

1. **Setup** — create the private GitHub repo, run the admin wizard, share the invite token. → [User Guide §3](shared-brain-user-guide.md#3--admin-setup-start-a-new-shared-brain) walks through this.
2. **Collaborator invitations** — add each contributor as a GitHub collaborator on the repo.
3. **Periodic synthesis** — typically weekly. Synthesis runs locally on your machine using your LLM API key (same key as ingest). Other contributors don't need to do anything for this. → [§4 below](#4--running-synthesis-on-a-schedule).
4. **Revocation** — when someone leaves the cohort, you revoke them (right to erasure, GDPR Article 17). → [§3 below](#3--revoking-a-contributor-article-17).
5. **Data handling terms** — picked at brain setup and **frozen after invites go out**. See [compliance §3](shared-brain-compliance.md#3--copyright--ip--two-modes).

---

## 2 — Inviting collaborators

A Shared Brain needs two things for each contributor to be able to push: (1) the **invite token** you generated at setup, and (2) **GitHub collaborator access** to the private repo. The invite token alone is not enough — it carries only metadata (repo coordinates, brain name, data-handling terms), never a credential. Each contributor supplies their own GitHub PAT.

Steps:

1. **Add them as a GitHub collaborator.** On the private repo: *Settings → Collaborators → Add people*, and have them accept the email invitation. Without this, their PAT — however valid — will get a `403`/`repository not found` on the first push.
2. **Send them the invite token.** Paste it to them over any channel; it's safe to share because it contains no token. They paste it into the Sync tab → *Shared Brains → Join a Shared Brain* wizard.
3. **They create their own PAT** during the wizard (fine-grained, *Contents: Read and write* on the repo — or a classic token with `repo` scope). The wizard validates it live.

The full step-by-step from the contributor's side is in [User Guide §2 — Contributor setup](shared-brain-user-guide.md#2--contributor-setup-join-an-existing-shared-brain). For your own initial brain creation, see [User Guide §3 — Admin setup](shared-brain-user-guide.md#3--admin-setup-start-a-new-shared-brain).

---

## 3 — Revoking a contributor (Article 17)

A contributor leaves the cohort, or asks to have their data removed under GDPR Article 17. You revoke them.

### v3.0.5+ — from the connection card (recommended)

1. Sync tab → your connection card → **Advanced → Revoke a contributor…**
2. The panel loads the **member directory** from the shared repo (everyone who ever contributed — name where available, short fellow-ID, submission count, last activity). Pick the person. Your own entry is marked **YOU** (self-revocation is legitimate, e.g. when leaving a brain you administer).
3. Paste your **admin token** (the `sbat_…` credential shown once at brain setup — see §9; if your connection predates v3.0.5, click **Generate admin token** in Advanced first).
4. Type the confirmation exactly as prompted (`REVOKE-<short-id>`) — the deliberate typing is the accident-prevention gate.
5. Click **Permanently revoke this contributor**. Progress streams into the card; on success you get the follow-up checklist (tell contributors to Pull; remove the person as a GitHub collaborator).

If the run ends with *"the rebuild synthesis FAILED"*, the erasure completed but the collective needs rebuilding — re-run the same revocation once the underlying problem (usually a rate limit) clears; every step is idempotent.

### Via the API (scripting / headless)

The same operation via curl:

```bash
curl -X POST http://localhost:3333/api/sharedbrain/<connection_id>/revoke \
  -H 'Content-Type: application/json' \
  -d '{
    "admin_token": "<your-admin-token>",
    "fellow_id": "<contributor-uuid-to-revoke>",
    "confirmation": "REVOKE-<contributor-uuid-to-revoke>"
  }'
```

Where:
- `<connection_id>` — your own Shared Brain connection ID. Find it via `GET /api/sharedbrain/list`.
- `<your-admin-token>` — the `sbat_…` token shown once at brain setup (v3.0.5+) or provisioned via **Advanced → Generate admin token** / `POST /api/sharedbrain/<id>/admin-token/rotate`. The revoke endpoint refuses with 403 if it doesn't match the token stored on the connection.
- `<contributor-uuid-to-revoke>` — the contributor's `fellow_id` (UUID). v3.0.5+: get it from `GET /api/sharedbrain/<id>/members` (or the card's revoke panel); older fallbacks: their Provenance short-id, or ask them to read it off their connection card.
- `confirmation` — literal string `"REVOKE-<contributor-uuid-to-revoke>"` (the FULL UUID). The brittle confirmation is a GitHub-style accident-prevention gate.

The endpoint returns a SSE stream with progress events and a final `done` event containing:

```json
{
  "ok": true,
  "contributions_deleted": <N>,
  "pages_deleted": <M>,
  "pages_rebuilt": <K>,
  "audit_record": { ... }
}
```

### What revoke actually does

1. Deletes every `contributions/<fellow_id>/*.json` from the shared repo.
2. Deletes `digests/<fellow_id>/latest.json` (the per-fellow synthesis cache).
3. Scans every collective page. Pages that mention the revoked fellow's short ID in their Provenance section are deleted.
4. Resets `state/last-synthesis.json` to epoch and re-runs synthesis from scratch. Deleted pages get rebuilt **only if** other contributors still have submissions for them; otherwise they stay deleted (Article 17 erasure).
5. Appends one line to `state/revocations.jsonl` with timestamp + UUID + counts + sha256-hashed admin token. No real names, no contribution content.

The operation is irreversible. If the revoked contributor's local wiki is also gone, the data cannot be reconstructed from shared storage.

### What revoke does NOT do (and what to do if you need it to)

- **Git history retention** — revoke doesn't rewrite git history. Old commits still contain the revoked content. For absolute erasure (e.g. strict GDPR), follow the manual `git filter-repo` procedure in [`docs/shared-brain-compliance.md` §2d](shared-brain-compliance.md#2d--absolute-erasure-procedure-for-high-compliance-scenarios).
- **Other contributors' local mirrors** — revoke doesn't reach their machines. The revoked content stays in their `shared-<slug>/` domain until they next Pull. Since v3.0.3, Pull is a true mirror operation — pages deleted from the collective are **removed** from the local mirror, and facts removed from surviving pages actually disappear (older versions union-merged, which resurrected deleted content indefinitely). Contributors on pre-v3.0.3 versions must update for erasure to propagate.
- **External backups** — revoke doesn't touch backups of the shared repo. Purge those manually if absolute erasure is needed.

---

## 4 — Running synthesis on a schedule

Synthesis aggregates contributions into the collective wiki. It runs locally on your machine via your LLM API key.

### Manual trigger (every time the admin wants to merge)

Sync tab → connection card → **Advanced → Run synthesis (admin)**.

### Frequency recommendations

| Cohort size | Recommended cadence |
|---|---|
| 5-20 contributors, ≤100 pages | Weekly |
| 20-50 contributors, 100-500 pages | Twice weekly |
| 50+ contributors or 500+ pages | Daily (still local — no automation yet in v3.0) |

Automation (cron-triggered or background daemon) is a v3.x roadmap item — see [`docs/shared-brain.md` §7](shared-brain.md#7--roadmap).

### Cost estimate

Synthesis only calls the LLM for **contradiction candidates** flagged by the Jaccard heuristic (similarity 0.5-1.0 between contributions on the same page). Each flagged pair triggers one LLM call (~200 tokens in, ~100 tokens out).

For a 100-page brain with 5-contributors in a typical week:
- Pages processed: ~30 (those with new contributions since last synthesis)
- Contradiction candidates: usually 0-5 per cycle
- LLM cost: under $0.01 per synthesis run with Gemini 2.5 Flash Lite

Cost scales with disagreement, not corpus size.

---

## 5 — Adding new contributors mid-cohort

A new person joins after the brain is already running.

1. **Add as GitHub collaborator** — Settings → Collaborators → Add people.
2. **Share the original invite token** — the token doesn't expire. Send them the same `sbi_…` the rest of the cohort got.
3. **Optionally re-run synthesis** so they pull the latest collective state on their first Pull.

That's it. No new tokens, no admin action in the Curator.

### Re-displaying the invite token

Lost the token? Since v3.0.5 it's one click: Sync tab → connection card → **Advanced → Show invite token**. The token is deterministic (pure metadata), so re-generating from the connection's stored settings reproduces the original — safe to show any time, safe to share with anyone.

> Note for connections created before v3.0.5: the data-handling-terms choice wasn't stored back then, so the re-displayed token defaults to *contributor retains*. If your brain uses the *organisational* IP mode, share your originally generated token instead (the card shows a caution in this case).

Via the API:

```bash
curl -X POST http://localhost:3333/api/sharedbrain/generate-invite \
  -H 'Content-Type: application/json' \
  -d '{
    "repo": "<owner>/<name>",
    "name": "<brain display name>",
    "shared_domain": "<folder slug>",
    "branch": "main",
    "data_handling_terms": "contributor_retains"
  }'
```

Returns `{"token": "sbi_...", "admin_token": "sbat_..."}`. The `token` is the shareable invite; the `admin_token` is a fresh revocation credential generated for the admin wizard — **ignore it here** (it is not stored anywhere by this call; rotation goes through `/admin-token/rotate`).

---

## 6 — Removing a contributor without revoking

If a contributor leaves on good terms and you want to **stop their future contributions** without erasing their past ones:

1. **Revoke their GitHub collaborator access** — Settings → Collaborators → "..." next to their name → Remove. Their PAT now fails on next push.
2. Their past contributions remain. The collective wiki keeps their facts. Provenance still attributes them.

This is the standard departure flow. Use the revoke endpoint (§3) only when GDPR-style erasure is explicitly requested.

---

## 7 — Health monitoring

After synthesis, the collective wiki may grow `CONFLICTING SOURCES` markers where contributors disagreed and the LLM couldn't unify them. Check periodically:

1. Sync tab → connection card → **Pull updates** (so your local mirror is fresh).
2. Open the `shared-<slug>` domain in the Wiki tab or Health tab.
3. Scan for the `## CONFLICTING SOURCES` markers — they look like:
   ```markdown
   ## CONFLICTING SOURCES
   - Coined in 2024 *(per fellow-a3f91234)*
   - Coined in 2023 *(per fellow-b7c1abcd)*
   ```
4. Decide which is correct (sometimes neither — sometimes both). Discuss with the cohort. Resolve manually by editing the **personal** opted-in domain of the contributor whose fact is correct, then **Push contributions** and **Run synthesis** again.

Since v3.0.4 you don't have to hunt: the synthesis summary on your connection card names the affected pages directly (*"2 unresolved contradictions flagged in concepts/x.md, entities/y.md"*), and the API result carries a `conflict_pages` array.

The collective wiki is read-only for direct edits — that's by design. You resolve conflicts upstream (in someone's personal domain), not downstream.

---

## 8 — When things go wrong (admin edition)

### Synthesis warns "N pages failed (see warnings)"
One or more contributions couldn't be processed for those pages (a malformed contribution payload, or a storage write failure). Since v3.0.2 a bad contribution degrades to a per-page warning instead of aborting the whole synthesis run — the rest of the brain still synthesizes. Check the SSE warnings for the page paths, inspect the matching `contributions/<fellow>/*.json` files in the repo, and delete any malformed ones; the pages recover on the next cycle.

### "Cannot update/restart while a write operation is running: shared-… (sharedbrain-…)"
Since v3.0.2, push/pull/synthesize/revoke register with the app's write-coordination layer: app updates, restarts, and Personal Sync return 409 while a Shared Brain operation runs (and vice versa — a Pull can't start mid-ingest on the same mirror). Wait for the running operation to finish and retry.

### Synthesis reported "0 pages written" but I see contributions in storage
Since v3.0.3 synthesis tracks **processed submission IDs** (plus a watermark derived from the contributions' own timestamps), so the classic causes of this — a contributor's clock running behind yours, or a push landing while synthesis was running — no longer silently skip contributions. If it still happens, the likely causes are: (a) the contributions were already processed (check `processed_ids` in `meta/state/last-synthesis.json`), or (b) they target a **different shared domain** than this connection (the SSE stream warns about these). To force-reprocess everything from scratch: edit `meta/state/last-synthesis.json` and set `at` AND `watermark` to `"1970-01-01T00:00:00Z"` **and `processed_ids` to `[]`** (on pre-v3.0.3 state files only `at` exists), then trigger Run synthesis again. Re-processing is idempotent — facts dedup on merge.

### Synthesis or revoke fails with "GitHub returned a TRUNCATED tree listing"
The repo has grown past GitHub's recursive-listing limit (~100k files). Operations that rely on a full listing (synthesis, pull, and especially revoke) **refuse instead of silently missing files** (v3.0.3) — an incomplete Article 17 erasure reported as success would be far worse. Archive or delete old `contributions/<fellow>/*.json` files (e.g. move them to a separate archive repo) to shrink the tree, then retry.

### Revoke failed with "the rebuild synthesis FAILED"
The erasure part completed (contributions + provenance-tainted pages deleted) but the rebuild didn't run — commonly a rate-limit, since the rebuild re-reads every remaining contribution. The collective is missing the deleted pages until the rebuild completes, and an **in-progress marker** (v3.0.3) blocks ordinary synthesis so nothing is rebuilt from half-erased state. **Re-run the same revoke command** once the underlying problem clears (it's idempotent and finishes the job); the marker clears automatically on success.

### A contributor pushed but their pages don't appear in collective
Verify:
1. Their push completed without errors (check their SSE stream events at the time)
2. You've run synthesis after their push (synthesis is when contributions become pages)
3. Pull updates on your end so your local mirror reflects the new pages

### Rate-limited by GitHub
Fine-grained PATs get 5000 REST API requests/hour. Synthesis on a 500-page brain with 50 contributions uses around 600 requests (tree listing + per-file reads + writes). You can run it 8x/hour at that scale before hitting the limit. The adapter warns at <50 remaining — since v3.0.4 the warning appears in the operation's own progress stream/UI (once per operation), not just stderr — and throws a typed error at 0.

### A member's card says "read-only member" and they can't Push
Expected (v3.0.4): their PAT was created with **Contents: Read** only, and they saved the connection as a read-only member — they can Pull but the backend refuses Push/synthesis for that connection. To upgrade them to contributor: have them re-create the PAT with **Contents: Read and write** and re-run the Join wizard with the same invite token.

### A contributor reports "N pages skipped after repeated failures" on their card
That's the `permanent_skip` list (3 genuine LLM pre-processing failures on the same page). They can expand the block and click **Retry these pages on next push** (v3.0.4, `POST /api/sharedbrain/:id/unskip`) — no page editing needed. If the same pages keep striking out, inspect them for unusual content (enormous size, binary-ish text) and consider splitting them.

### Invite token says "uses version 2; this Curator install supports up to v1"
Your contributor's Curator is older than the one that generated the token. The wizard's error includes the version mismatch. Have them update to v3.0.0-beta.1 or later, then retry.

### "Domain 'shared-cohort' is a read-only Shared Brain mirror"
A contributor tried to use MCP write tools (`compile_to_wiki`, `fix_wiki_issue`) on the shared-<slug>/ mirror directly. That's correctly refused — direct writes to a mirror don't propagate. Tell them to use the MCP tools on their personal opted-in domain instead, then Push.

---

## 9 — Admin-token security

The `admin_token` is the one privileged credential in your Shared Brain. It gates the revoke endpoint.

**Provisioning (v3.0.5+):**
- **New brains** — the admin wizard generates a `sbat_…` token (160 bits of entropy) and shows it **once** on step 2, next to the invite token. It's stored on your connection when you finish the wizard; save the plaintext in your password manager immediately.
- **Existing connections** (created before v3.0.5) — Sync tab → connection card → **Advanced → Generate admin token**. Shown once, same rules.
- **Rotation** — **Advanced → Rotate admin token** (or `POST /api/sharedbrain/:id/admin-token/rotate`). The old token stops working immediately; the new one is returned/shown once.

**Handling rules:**
- **Keep it secret.** Don't share it with contributors — it is NOT the invite token. Don't commit it anywhere.
- The Curator stores it locally in `.sharedbrain-config.json` (0600, atomic writes) and masks it in every listing.
- **Hash before logging.** The Curator itself only ever logs a sha256 hash of the admin_token (in `state/revocations.jsonl`). Don't log raw tokens yourself.

---

## 10 — Quick reference

| Action | Where |
|---|---|
| Initial setup | Sync tab → **⚙ I'm starting a new Shared Brain** → Set up |
| Add a contributor mid-cohort | GitHub repo → Settings → Collaborators → Add people |
| Run synthesis | Sync tab → connection card → Advanced → Run synthesis (confirm dialog, v3.0.5+) |
| See who has contributed | Card → Advanced → Revoke panel, or `GET /api/sharedbrain/:id/members` (v3.0.5+) |
| Revoke a contributor | Card → **Advanced → Revoke a contributor…** (v3.0.5+), or `POST /api/sharedbrain/:id/revoke` |
| Generate / rotate the admin token | Card → Advanced → Generate/Rotate admin token (v3.0.5+) |
| Re-display the invite token | Card → Advanced → Show invite token (v3.0.5+), or `POST /api/sharedbrain/generate-invite` |
| Check synthesis stats | `meta/state/last-synthesis.json` in the repo |
| Read the audit log | `state/revocations.jsonl` in the repo |
| Compliance / GDPR ref | [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) |
| Engineering decisions + architecture | [`docs/shared-brain.md`](shared-brain.md) |
| User-facing guide | [`docs/shared-brain.md`](shared-brain.md) |
