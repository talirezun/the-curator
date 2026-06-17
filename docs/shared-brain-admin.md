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

### v3.0.0-beta.1 — API-only

The revoke admin UI ships in v3.0.0 GA. For now, run the operation via curl:

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
- `<your-admin-token>` — the admin-only token stored in your local `.sharedbrain-config.json` under `admin_token` for this connection. (If your wizard didn't ask you to set one, the current beta defaults to using your local connection's stored admin_token field — if absent, the revoke endpoint refuses with 403.)
- `<contributor-uuid-to-revoke>` — the contributor's `fellow_id` (UUID). Get it from their Provenance section in any collective page they contributed to, or ask them to share their UUID from their Sync tab connection card.
- `confirmation` — literal string `"REVOKE-<contributor-uuid-to-revoke>"`. The brittle confirmation is a GitHub-style accident-prevention gate.

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
- **Other contributors' local mirrors** — revoke doesn't reach their machines. The revoked content stays in their `shared-<slug>/` domain until they next Pull (which will reflect the post-revoke state).
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

### Re-generating the invite token

If you ever need a fresh invite token (e.g. the old one was leaked publicly — though it grants no access, you may still want a fresh one):

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

Returns `{"token": "sbi_..."}`. Same format; can be shared with anyone.

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

The collective wiki is read-only for direct edits — that's by design. You resolve conflicts upstream (in someone's personal domain), not downstream.

---

## 8 — When things go wrong (admin edition)

### Synthesis reported "0 pages written" but I see contributions in storage
The contributions' `contributed_at` timestamps are earlier than `state.last-synthesis.at`. Synthesis only processes contributions newer than the last run. To force-reprocess everything: temporarily edit `meta/state/last-synthesis.json` in the repo, set `at` to `"1970-01-01T00:00:00Z"`, then trigger Run synthesis again. Restore the timestamp afterward if needed.

### A contributor pushed but their pages don't appear in collective
Verify:
1. Their push completed without errors (check their SSE stream events at the time)
2. You've run synthesis after their push (synthesis is when contributions become pages)
3. Pull updates on your end so your local mirror reflects the new pages

### Rate-limited by GitHub
Fine-grained PATs get 5000 REST API requests/hour. Synthesis on a 500-page brain with 50 contributions uses around 600 requests (tree listing + per-file reads + writes). You can run it 8x/hour at that scale before hitting the limit. The adapter emits a stderr warning at <50 remaining and throws a typed error at 0.

### Invite token says "uses version 2; this Curator install supports up to v1"
Your contributor's Curator is older than the one that generated the token. The wizard's error includes the version mismatch. Have them update to v3.0.0-beta.1 or later, then retry.

### "Domain 'shared-cohort' is a read-only Shared Brain mirror"
A contributor tried to use MCP write tools (`compile_to_wiki`, `fix_wiki_issue`) on the shared-<slug>/ mirror directly. That's correctly refused — direct writes to a mirror don't propagate. Tell them to use the MCP tools on their personal opted-in domain instead, then Push.

---

## 9 — Admin-token security

The `admin_token` is the one privileged credential in your Shared Brain. It gates the revoke endpoint. You should:

- **Keep it secret.** Don't share it with contributors. Don't commit it to anywhere.
- **Generate a long random one** — at least 32 chars. The Curator stores it locally in `.sharedbrain-config.json`.
- **Rotate it** if you suspect compromise — just `POST /api/sharedbrain/save` with the connection record carrying a new `admin_token` value. (UI for this lands in v3.0.0 GA.)
- **Hash before logging.** The Curator itself only ever logs a sha256 hash of the admin_token (in `state/revocations.jsonl`). Don't log raw tokens yourself.

---

## 10 — Quick reference

| Action | Where |
|---|---|
| Initial setup | Sync tab → **⚙ I'm starting a new Shared Brain** → Set up |
| Add a contributor mid-cohort | GitHub repo → Settings → Collaborators → Add people |
| Run synthesis | Sync tab → connection card → Advanced → Run synthesis |
| Revoke a contributor | `POST /api/sharedbrain/:id/revoke` (UI coming v3.0.0 GA) |
| Regenerate invite token | `POST /api/sharedbrain/generate-invite` |
| Check synthesis stats | `meta/state/last-synthesis.json` in the repo |
| Read the audit log | `state/revocations.jsonl` in the repo |
| Compliance / GDPR ref | [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) |
| Engineering decisions + architecture | [`docs/shared-brain.md`](shared-brain.md) |
| User-facing guide | [`docs/shared-brain.md`](shared-brain.md) |
