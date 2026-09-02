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
2. **Send them the invite token.** Paste it to them over any channel; it's safe to share because it contains no token. They paste it into the **Shared Brain** rail view → *📨 I have an invite token* → **Join** wizard. (Through v3.40.0, in the pre-redesign shell at `/old`, that block was in the Sync tab instead. That shell was deleted in v3.41.0.)
3. **They create their own PAT** during the wizard (fine-grained, *Contents: Read and write* on the repo — or a classic token with `repo` scope). The wizard validates it live.

The full step-by-step from the contributor's side is in [User Guide §2 — Contributor setup](shared-brain-user-guide.md#2--contributor-setup-join-an-existing-shared-brain). For your own initial brain creation, see [User Guide §3 — Admin setup](shared-brain-user-guide.md#3--admin-setup-start-a-new-shared-brain).

---

## 3 — Revoking a contributor (Article 17)

A contributor leaves the cohort, or asks to have their data removed under GDPR Article 17. You revoke them.

### v3.0.5+ — from the connection card (recommended)

1. **Shared Brain** rail view → your connection card → **Admin controls — admin token & contributor revocation**
2. The panel loads the **member directory** from the shared repo (everyone who ever contributed — name where available, short fellow-ID, submission count, last activity). Pick the person. Your own entry is marked **YOU** (self-revocation is legitimate, e.g. when leaving a brain you administer).
3. Paste your **admin token** — the `sbat_…` credential shown once at brain setup (see §9). **If you do not have it, you cannot revoke, and there is no button that will issue you a new one.** Since v3.43.0 the rotate endpoint requires the CURRENT token; a connection holding no admin token is refused with `403 no_admin_token`. Re-run the brain-setup wizard to issue and save a fresh one.
4. Type the confirmation exactly as prompted (`REVOKE-<short-id>`) — the deliberate typing is the accident-prevention gate.
5. Click **Permanently revoke this contributor** — the red button, which stays disabled until all three of the steps above are satisfied and tells you which one is missing. Progress streams into the card; on success you get the follow-up checklist (tell contributors to Pull; remove the person as a GitHub collaborator).

The panel is laid out as the three numbered steps it enforces — **1 · Who**, **2 · Admin token**, **3 · Confirm** — and the confirmation phrase is deliberately never filled in for you.

The result renders as an **outcome panel inside the card** — not as a one-line
error message. This was written down wrongly before v3.44.0 (it described a
`card.message` prefixed with `Error: `, which is how the *push/pull/synthesise*
actions report and is not how revocation has reported since v3.43.0), so read
what is actually on screen:

- a **headline** in one of four exact wordings (below),
- a **counts row** — *"N contributions deleted · N pages removed · N rebuilt"*,
- a **numbered list** of anything that failed, one line each,
- **notices** where they apply: whether the revocation-in-progress marker is
  still set, whether the audit record was written, and — on a clean run only —
  *"Certifiable: this result is safe to certify to the data subject as a
  completed erasure."*

The follow-up checklist appears **only on a clean run**.

**Read which headline you got — they mean different things.** There are exactly
four, and a run that produced no result at all is one of them:

| Headline | What it means |
|---|---|
| *"Revocation complete."* | Clean. Certifiable. |
| *"Erasure completed, but the revocation did NOT finish cleanly."* | The data IS gone; a later step failed. |
| *"⚠ ERASURE INCOMPLETE — this contributor's data has NOT been fully removed."* | Data survived. Do not certify. |
| *"Erasure completeness was NOT confirmed by the server."* | The run finished without saying whether the erasure completed. Treat as incomplete until re-run. |
| *"Revocation did not report a result — treat this contributor's data as NOT erased."* | The stream ended with no terminal result (a dropped connection, a crash). Re-run it. |

The two that carry a real cost of misreading:

- ***"⚠ ERASURE INCOMPLETE — this contributor's data has NOT been fully
  removed"*** — some of their data survived (`erasure_complete: false`). Do
  **not** certify this erasure. The in-progress marker stays set and ordinary
  synthesis keeps refusing for **every** contributor until a clean re-run —
  deliberately, so a partial erasure cannot be walked away from.
- ***"Erasure completed (…), but the revocation did NOT finish cleanly"*** — the
  contributor's data **is** gone (`erasure_complete: true`); a *later* step
  failed. The data subject's request has been honoured. Whether the cohort is
  blocked now depends on **which** step failed, so do not assume: a failed
  rebuild (or pages the rebuild could not write) holds the marker, while a
  failed audit write or a failed watermark reset deliberately do **not** — see
  the field table below. **From the card**, the message itself tells you: it
  contains the sentence *"The revocation-in-progress marker is still set, so
  ordinary synthesis stays blocked"* only when the marker is genuinely held; its
  absence means the marker was cleared. **From the API**, read `marker_active`.
  Do not certify the *revocation* until you have an audit record, even though
  the *erasure* is done.

In both cases: fix the named problem and re-run the same revocation (every step
is idempotent).

### Via the API (scripting / headless)

The same operation via curl:

> **`$CURATOR` is the app's own address.** A browser install serves it at
> `http://localhost:3333`, so `export CURATOR=http://localhost:3333` and the commands
> below work as written. **The packaged Mac app picks a free port at every launch**, so
> there is no fixed number to hardcode — read the address from the app window, or use the
> UI, which is what these `curl` forms document rather than replace.

```bash
curl -X POST $CURATOR/api/sharedbrain/<connection_id>/revoke \
  -H 'Content-Type: application/json' \
  -d '{
    "admin_token": "<your-admin-token>",
    "fellow_id": "<contributor-uuid-to-revoke>",
    "confirmation": "REVOKE-<contributor-uuid-to-revoke>"
  }'
```

Where:
- `<connection_id>` — your own Shared Brain connection ID. Find it via `GET /api/sharedbrain/list`.
- `<your-admin-token>` — the `sbat_…` token shown once at brain setup. Since v3.43.0 there is no way to provision one from a running app: `/admin-token/rotate` requires the CURRENT token and refuses a connection that has none (see §9). The revoke endpoint refuses with 403 if the supplied token doesn't match the one stored on the connection.
- `<contributor-uuid-to-revoke>` — the contributor's `fellow_id` (UUID). v3.0.5+: get it from `GET /api/sharedbrain/<id>/members` (or the card's revoke panel); older fallbacks: their Provenance short-id, or ask them to read it off their connection card. The directory shows a name for any contributor whose stored payloads carry one, and the **8-character short fellow-ID** otherwise. **The v3.6.2 `attribute_by_name` gate is forward-looking only and changes nothing about this directory on an existing cohort** — it is built by reading every contribution payload ever stored, and pre-v3.6.2 pushes wrote the name unconditionally, so those names are still listed until the contributions are revoked. On a cohort started after v3.6.2, only contributors who opted in will show a name. Either way: if the person you are looking for shows only a short-ID, ask the data subject to read their Fellow ID off their own connection card — a subject identifying themselves is the correct flow for an Article 17 request anyway.
- `confirmation` — literal string `"REVOKE-<contributor-uuid-to-revoke>"` (the FULL UUID). The brittle confirmation is a GitHub-style accident-prevention gate.

> **If a contributor asks to withdraw name attribution only (v3.6.2 limitation).**
> `attribute_by_name` is chosen **once, at join time**, in the connection wizard.
> There is currently **no toggle on the connection card** to change it afterwards.
> If a contributor wants to stop publishing their display name, they must
> **leave the Shared Brain on that machine** (connection card footer → **"Leave this Shared Brain"**) **and re-join** with the box unticked;
> from that point their pushes carry the UUID alone. The change is **not
> retroactive** — names already written into `contributions/<fellow_id>/*.json`
> stay in shared storage and in that repository's git history, and a **full
> revocation is the only way to remove them**. Tell contributors this when they
> ask, and treat a withdrawal request that must also erase past names as an
> Article 17 request (§2 of the compliance doc). A first-class attribution
> toggle is a known follow-up.

The endpoint returns a SSE stream with progress events and a final `done` event containing:

```json
{
  "ok": true,
  "erasure_complete": true,
  "summary": "Revocation complete: 4 contributions deleted, 2 pages removed, 7 rebuilt. …",
  "contributions_deleted": <N>,
  "contributions_failed": [],
  "digest_failed": null,
  "pages_deleted": <M>,
  "pages_failed": [],
  "pages_rebuilt": <K>,
  "pages_rebuild_failed": 0,
  "state_reset_failed": null,
  "audit_failed": null,
  "marker_cleared": true,
  "marker_active": false,
  "audit_record": { ... }
}
```

A failure carries the same shape with `ok: false`, `partial: true`, and an
additional `error` field holding the same text as `summary`.

Since **v3.6.2** the result is **self-reporting**: every step that can fail
per item records what failed instead of only logging it server-side.

| Field | Meaning |
|---|---|
| `erasure_complete` | `true` only when every contribution, the digest, and every provenance-tainted page were actually removed. **This is the field to read before telling a data subject their data is gone.** |
| `contributions_failed` | `[{submission_id, error}]` — payload files still in shared storage. |
| `digest_failed` | `{error}` — the fellow's synthesis cache (which *would* hold their facts) is still there. In practice this stays `null`: nothing in the shipped code writes a digest, so the file does not exist and the delete is a no-op. The step is defensive, for when digests are wired up. |
| `pages_failed` | `[{path, error}]` — collective pages that could not be read or deleted, so they may still carry this contributor's content. |
| `pages_rebuild_failed` | Pages the rebuild could not write. Erasure is fine; the collective is incomplete. |
| `state_reset_failed` | `{error}` — the synthesis watermark could not be reset. Reported for completeness; it is **not** an erasure failure and the rebuild does not depend on it (it takes its baseline directly, and a successful synthesis rewrites the state at the end). |
| `audit_failed` | The revocation was **not** written to `state/revocations.jsonl` — you have no record of it. |
| `marker_cleared` | Did this run clear the in-progress marker? `boolean`, or `null` on an abort where no marker was ever written (nothing to clear — see *Aborts* below). It stays `false` for four reasons, all of which leave the collective in a mid-erasure state: a failed erasure step (`erasure_complete: false`), a failed rebuild (`rebuild_ok: false`), `pages_rebuild_failed > 0`, **or** the clear itself failing to write. A failed audit write or a failed watermark reset do **not** hold the marker — see the note below. |
| `marker_active` | **The field to act on: is cohort synthesis blocked right now?** `true` means every contributor's ordinary synthesis is being refused until a revocation run finishes. `null` means genuinely unknown — the Step-0 marker write threw, so a partial commit cannot be ruled out; if synthesis is refusing, that is why. On a run that got past Step 0 it is simply the inverse of `marker_cleared`. |
| `summary` | The one honest sentence to quote. It says *"Revocation complete"* **only** when nothing failed. |

> **Why an audit-write failure does not block synthesis (v3.6.2).** The
> in-progress marker exists for one thing: to stop ordinary synthesis while
> the collective may be half-erased. A failed `appendAudit` says nothing
> about that — the erasure finished and the collective is consistent — so
> holding the marker for it would take **every contributor's** synthesis
> offline until an admin re-ran the whole revocation, which is itself a full
> re-listing plus a full LLM synthesis and fails the same way under a
> persisting rate limit. It is still reported loudly (`ok: false`,
> `audit_failed`, and a named problem in `summary`) and you should still not
> certify the revocation without a record — it just is not weaponised into
> an outage.

On any failure the endpoint emits an SSE `error` event whose payload carries
this same object, and `ok` is `false`. Re-running the revocation is always
safe — every step is idempotent.

**Aborts — the runs that stop early.** Seven failure paths return before the
ordinary verdict is reached: an invalid `fellow_id`, a connection with no
`shared_domain`, storage-adapter init, a short-ID that cannot be derived, the
Step-0 in-progress-marker write, and the two *scope* failures (listing the
contributor's submissions; listing the collective's pages). All seven return the
**same full result shape** — so `erasure_complete` is always a real `false`,
never absent — with the failed enumeration surfaced as a synthetic `'*'` entry
in `contributions_failed` or `pages_failed` rather than an empty array that
would read as "nothing went wrong".

The first six abort before any deletion, so their counts are all zero and
`partial` is `false`. The seventh — the collective-page listing — happens
*after* the contributions and the digest have been deleted, so it reports
`partial: true` and a real `contributions_deleted`, and its erasure is genuinely
half-done. Two more things to know:

- **The marker may be left active.** If the run got past Step 0 (both scope
  failures do), the marker is set and **cohort-wide synthesis is refused** until
  a revocation run finishes — `marker_active: true`. If it aborted before Step 0
  nothing was written and `marker_cleared` is `null` (not applicable). If the
  Step-0 write itself threw, `marker_active` is `null`: a partial commit cannot
  be ruled out, and the recovery — re-run the revocation — is the same either
  way.
- **No audit line is written.** The append to `state/revocations.jsonl` happens
  near the end of the run, so an aborted attempt leaves the log looking as if it
  never happened. Record it yourself from the API response.

> **Where you can see these fields.** All of them are on the wire, and — since
> the `/next` shell became the only shell in **v3.41.0** — the in-app revoke
> panel reads the structured object rather than the prose. It absorbs the SSE
> stream to the end (the route emits a result-less terminal frame *before* the
> one carrying `result`, so a reader that stopped at the first would get the
> prose and none of the fields), then renders `erasure_complete`,
> `marker_active` / `marker_cleared`, one row per entry in
> `contributions_failed` and `pages_failed`, and the `digest_failed`,
> `pages_rebuild_failed`, `state_reset_failed` and `audit_failed` flags. The
> headline tone comes from those fields, never from the summary string.
>
> **The paragraph this replaces described the OLD shell**, which read only
> `payload.message` off the error frame. That shell was deleted in v3.41.0; the
> claim had been false since the `/next` admin panel shipped.

### What revoke actually does

1. Deletes every `contributions/<fellow_id>/*.json` from the shared repo. A per-file delete failure no longer stops the run — the remaining files are still erased — but since **v3.6.2** each failure is recorded in `contributions_failed`, counted in the audit record, and forces `erasure_complete: false`. (Before v3.6.2 it was written to the server console only, and the run still reported success.)
2. Deletes `digests/<fellow_id>/latest.json` (the per-fellow synthesis cache — it holds *their* facts, so a failure here is an erasure failure). Recorded in `digest_failed`.
3. Lists every collective page and scans it. Pages that mention the revoked fellow's short ID in their Provenance section are deleted; per-page failures are recorded in `pages_failed`. **If the page list itself cannot be read the revocation ABORTS** (v3.6.2) — an unreadable listing means we do not know *what* to erase, which is an unattempted erasure, not a partial one. It does not proceed to the rebuild and does not clear the in-progress marker.
4. Resets the `state.last-synthesis` meta key — stored at **`meta/state/last-synthesis.json`** in the repo — and re-runs synthesis from scratch. Since v3.0.6 the reset writes the full zero-state (`watermark: null`, empty `processed_ids`, `run_number: 0`), not just an epoch timestamp, so no stale processed-id list can cause surviving contributions to be skipped. Deleted pages get rebuilt **only if** other contributors still have submissions for them; otherwise they stay deleted (Article 17 erasure).
5. Appends one line to `state/revocations.jsonl` with timestamp + UUID + counts + `rebuild_ok` + the salted admin-token hash (§9). Since v3.43.0 the append is recomputed from the file's live content inside the write-retry loop; before that a SHA conflict silently re-sent the stale content and discarded a concurrent admin's entry. Since **v3.6.2** the line also carries `erasure_complete` plus the failure summary: **counts** for `contributions_failed`, `pages_failed` and `pages_rebuild_failed`, and **booleans** for `digest_failed` and `state_reset_failed` (note these last two are `{error}` objects in the API result but plain booleans in the log — the log deliberately drops the error text). An erasure audit trail that recorded only successes was not an audit trail. Counts and booleans only: still no real names, no contribution content, and no provider error text (that detail stays in the API response you are reading, not in the permanent log). **A run that aborts before this step writes no line at all** — see *Aborts* above.

The operation is irreversible. If the revoked contributor's local wiki is also gone, the data cannot be reconstructed from shared storage.

> ⚠️ **Read `erasure_complete` before you certify anything.** Up to v3.6.1 this
> was a manual duty — you had to compare the *"Found N contributions to delete"*
> progress line against `contributions_deleted` yourself, because a failed
> delete was written only to the server console and the run still said
> *"Revocation complete"*. Since **v3.6.2** the operation reports its own
> failures: `erasure_complete: false` and a `summary` beginning
> *"⚠ ERASURE INCOMPLETE"* whenever anything survived, `ok: false`, and the
> in-progress marker left set so synthesis stays blocked until you re-run.
> The manual comparison is still a fine belt-and-braces check, but it is no
> longer the only thing standing between a partial erasure and a false
> certification. Full procedure in
> [`shared-brain-compliance.md` §2b](shared-brain-compliance.md#2b--what-the-revocation-does).

### What revoke does NOT do (and what to do if you need it to)

- **Git history retention** — revoke doesn't rewrite git history. Old commits still contain the revoked content. For absolute erasure (e.g. strict GDPR), follow the manual `git filter-repo` procedure in [`docs/shared-brain-compliance.md` §2d](shared-brain-compliance.md#2d--absolute-erasure-procedure-for-high-compliance-scenarios).
- **Other contributors' local mirrors** — revoke doesn't reach their machines. The revoked content stays in their `shared-<slug>/` domain until they next Pull. Since v3.0.3, Pull is a true mirror operation — pages deleted from the collective are **removed** from the local mirror, and facts removed from surviving pages actually disappear (older versions union-merged, which resurrected deleted content indefinitely). Contributors on pre-v3.0.3 versions must update for erasure to propagate.
- **External backups** — revoke doesn't touch backups of the shared repo. Purge those manually if absolute erasure is needed.

---

## 4 — Running synthesis on a schedule

Synthesis aggregates contributions into the collective wiki. It runs locally on your machine via your LLM API key.

### Manual trigger (every time the admin wants to merge)

**Shared Brain** rail view → connection card → **Run synthesis (admin)** — it sits in the card's main action row beside Push and Pull, not inside a disclosure. A confirm step explains the cost before anything runs.

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

Lost the token? Since v3.0.5 it's one click: **Shared Brain** rail view → connection card → **Admin controls — admin token & contributor revocation** → **Show invite token**. The token is deterministic (pure metadata), so re-generating from the connection's stored settings reproduces the original — safe to show any time, safe to share with anyone.

> Note for connections created before v3.0.5: the data-handling-terms choice wasn't stored back then, so the re-displayed token defaults to *contributor retains*. If your brain uses the *organisational* IP mode, share your originally generated token instead (the card shows a caution in this case).

Via the API:

```bash
curl -X POST $CURATOR/api/sharedbrain/generate-invite \
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

1. **Shared Brain** rail view → connection card → **Pull updates** (so your local mirror is fresh).
2. **Read the synthesis result — this is the reliable route.** Since v3.0.4 the synthesis summary on
   your connection card names the affected pages directly (*"2 unresolved contradictions flagged in
   concepts/x.md, entities/y.md"*), and the API result carries a `conflict_pages` array. This is
   where you should look first.
3. To find them in the files, know the real shape. **A conflict marker is a BULLET inside
   `## Key Facts` — it is not a heading**, so searching for a `## CONFLICTING SOURCES` section finds
   nothing on a brain that genuinely has conflicts:

   ```markdown
   ## Key Facts

   - Some ordinary fact
   - ⚠️ CONFLICTING SOURCES — review needed:
     - Coined in 2024 *(per a3f91234)*
     - Coined in 2023 *(per b7c1abcd)*
   ```

   The attribution in parentheses is the contributor's **shortened fellow UUID** (the leading hex
   characters, per `PROVENANCE_UUID_DISPLAY_LEN` in `src/brain/sharedbrain-synthesis.js`) — no
   `fellow-` prefix, and never a name. To grep the mirror:

   ```bash
   grep -rn "CONFLICTING SOURCES" domains/shared-<slug>/wiki/
   ```

4. ⚠️ **The Wiki Health scanner does NOT detect conflict markers.** There is no conflict handling in
   `src/brain/health.js`; a Health scan on a mirror full of unresolved contradictions reports
   nothing about them. It was designed to and never shipped. Use step 2 or step 3 — not the Health
   tab — to find conflicts.
5. Decide which is correct (sometimes neither — sometimes both). Discuss with the cohort. Resolve manually by editing the **personal** opted-in domain of the contributor whose fact is correct, then **Push contributions** and **Run synthesis** again.

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

> Correction (**v3.6.2**): for **revoke** specifically, this had been true of
> the storage adapter and false of the operation. The adapter raised
> `SHARED_BRAIN_TREE_TRUNCATED` as documented, but revoke's page scan caught
> it and substituted an empty list — so it scanned zero pages, deleted none,
> rebuilt, cleared the marker and reported *"Revocation complete"*: exactly the
> outcome the refusal exists to prevent. Revoke now aborts on an unreadable
> page listing and reports `erasure_complete: false`.

### Revoke failed with "the rebuild synthesis FAILED"
The erasure part completed (contributions + provenance-tainted pages deleted) but the rebuild didn't run — commonly a rate-limit, since the rebuild re-reads every remaining contribution. The collective is missing the deleted pages until the rebuild completes, and an **in-progress marker** (v3.0.3) blocks ordinary synthesis so nothing is rebuilt from half-erased state. **Re-run the same revoke command** once the underlying problem clears (it's idempotent and finishes the job); the marker clears automatically on success.

### Revoke's rebuild left pages unwritten (`pages_rebuild_failed > 0`) and synthesis is now stuck

A deliberate trade-off with a sharp edge, so it is written down rather than left
to be discovered. Outside a revocation, a page the synthesis could not write is
a **self-healing** condition: the submissions that touch it are not marked
processed, so the next ordinary synthesis retries them. Inside a revocation it
is not, because `pages_rebuild_failed > 0` holds the in-progress marker — and
while the marker is active there **is no next ordinary run**: synthesis refuses
cohort-wide. The condition that normally clears itself cannot.

The supported recovery is to **re-run the same revocation**. Be aware what that
costs: it re-lists the collective and re-runs a *full* LLM synthesis at real
spend, and if the cause is persistent — a page over GitHub's 1 MB file cap, a
repeating SHA conflict, a rate limit that has not cleared — it fails the same
way. Fix the underlying cause first, then re-run.

If the re-run is not viable and `erasure_complete` was `true`, the marker is a
plain JSON file in the shared repo: `meta/state/revocation-in-progress.json`.
Setting `"active": false` there unblocks synthesis for the cohort. Understand
exactly what you are accepting before you do it:

- **Only ever do this when `erasure_complete: true`.** The marker's entire job
  is to stop synthesis while the collective may be half-erased. Clearing it over
  an incomplete erasure re-creates pages from data that is still mid-removal —
  the precise failure it exists to prevent.
- With the erasure complete, the revoked contributor's data is already gone and
  unblocking cannot bring it back. What you are accepting is that the collective
  is temporarily missing the pages the rebuild could not write — and the next
  ordinary synthesis will retry exactly those, because their submissions were
  never marked processed.
- You still have no audit record if `audit_failed` was set. Record the
  revocation manually.

### Revoke reported "⚠ ERASURE INCOMPLETE"
Some of the contributor's data is **still in shared storage**. Read the numbered problems in the message, then match them to the response fields:

| Problem named | Field | What it means |
|---|---|---|
| *"N contribution files could NOT be deleted"* | `contributions_failed` | Their raw payloads survive. Usually a permissions or rate-limit error on the storage backend. |
| *"the contributor's digest cache could NOT be deleted"* | `digest_failed` | Their synthesis cache survives — it contains their facts. |
| *"N collective pages could NOT be checked or deleted"* | `pages_failed` | Those pages may still carry their content in Provenance or in merged facts. |
| *"could not list the pages"* (run **ABORTED**) | `pages_failed: [{path: "*"}]` | Nothing was scanned at all. See the truncated-tree entry above. |
| *"the erasure was NOT written to the audit log"* | `audit_failed` | The erasure may have happened, but you have no record of it. Since v3.6.2 this alone does **not** keep the in-progress marker set — synthesis stays available cohort-wide while you sort the audit log out. |

Fix the named cause and **re-run the same revocation** — it is idempotent and will finish the remainder. Do not report the erasure as complete until a run comes back with `erasure_complete: true`. Under *this* headline the erasure is incomplete by definition, so the in-progress marker stays set the whole time and ordinary synthesis keeps refusing cohort-wide. (Under the other headline — *"Erasure completed … but did NOT finish cleanly"* — that is not automatic; read `marker_active`.)

### Revoke said "Erasure completed … but the revocation did NOT finish cleanly"
The contributor's data **is** gone (`erasure_complete: true`), but something after the erasure failed — the rebuild, some of the rebuilt pages, the audit write, clearing the marker, or resetting the synthesis watermark. The collective and/or your audit trail need the re-run; the data subject's request has been honoured, and the message says so explicitly rather than telling you the erasure is incomplete.

Check `marker_cleared` to know whether the cohort is affected while you fix it:

- `marker_cleared: false` — check `marker_active`. On this headline the cause is `rebuild_ok: false`, `pages_rebuild_failed > 0`, **or** the marker clear itself failing to write (`problems` names it: *"the revocation-in-progress marker could not be cleared"*). In the first two the collective is genuinely mid-erasure; in the third the collective is fine but the marker is stuck. All three block every contributor's synthesis until you re-run. Treat as urgent.
- `marker_cleared: true` — only bookkeeping failed (`audit_failed` and/or `state_reset_failed`). Nothing is blocked; re-run when convenient, but do not certify the revocation until you have an audit record.

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
Your contributor's Curator is older than the one that generated the token. The wizard's error includes the version mismatch. Have them update to a Curator new enough to understand the token version named in the error — any release from v3.0.0-beta.1 onward supports v1 tokens — then retry.

### "Domain 'shared-cohort' is a read-only Shared Brain mirror"
A contributor tried to use MCP write tools (`compile_to_wiki`, `fix_wiki_issue`) on the shared-<slug>/ mirror directly. That's correctly refused — direct writes to a mirror don't propagate. Tell them to use the MCP tools on their personal opted-in domain instead, then Push.

---

## 9 — Admin-token security

The `admin_token` is the one privileged credential in your Shared Brain. It gates the revoke endpoint.

**Provisioning:**
- **New brains** — the admin wizard generates a `sbat_…` token (160 bits of entropy) and shows it **once** on step 2, next to the invite token. It's stored on your connection when you finish the wizard; save the plaintext in your password manager immediately.
- **Existing connections created before v3.0.5** — re-run the brain-setup wizard against the same repo and shared domain. It mints a fresh admin token and saves it with the connection.
- **Lost token, any vintage** — the same route: re-run the brain-setup wizard. Since v3.43.0 rotation is not a provisioning path (see the box below).
- **Rotation** — connection card → **Admin controls — admin token & contributor revocation** → **Rotate token**, or `POST /api/sharedbrain/:id/admin-token/rotate` with `{"admin_token": "<your CURRENT sbat_… token>"}`. The old token stops working immediately; the new one is returned once and never again.

> **v3.43.0 CLOSED A HOLE HERE, and the old text described it as a feature.**
> Until v3.43.0 this endpoint issued a token to **any** connection that asked,
> with no proof of possession — that was the "Generate token" path the bullet
> above used to recommend. A live end-to-end run showed a plain contributor
> using it to mint an admin token and then revoke the cohort admin. It now
> refuses three ways, all `403` with a machine-readable `code`:
>
> | `code` | Meaning |
> |---|---|
> | `no_admin_token` | This connection stores no admin token. Nothing to rotate; nothing will be issued. |
> | `admin_token_required` | No token in the request body. |
> | `admin_token_mismatch` | A token was supplied and it is not this connection's. |
>
> **The cost is real and is not hidden:** an admin who has genuinely lost their
> token cannot recover it from a running app. Re-run the brain-setup wizard.
>
> **Only ONE membership per brain.** Since v3.43.0, saving a second connection
> to the same `(repo, shared_domain)` is refused. Two memberships meant two
> `fellow_id`s for one person, so an Article 17 revoke of either would erase
> half their contributions while reporting a complete erasure.

**Handling rules:**
- **Keep it secret.** Don't share it with contributors — it is NOT the invite token. Don't commit it anywhere.
- The Curator stores it locally in `.sharedbrain-config.json` (0600, atomic writes) and masks it in every listing.
- **Hash before logging.** The Curator itself only ever logs a hash of the admin_token (in `state/revocations.jsonl`), and since v3.43.0 that hash is **salted per record** — `sha256:<salt>:<digest>`. That file lives in the shared repo and every contributor can read it, so an unsalted digest was an offline oracle against any admin token weak enough to guess. You can still verify a record if you hold the token: recompute `sha256(salt + ":" + token)` using the salt in that same line. Don't log raw tokens yourself.

---

## 10 — Quick reference

| Action | Where |
|---|---|
| Initial setup | **Shared Brain** → **⚙ I'm starting a new Shared Brain** → Set up |
| Add a contributor mid-cohort | GitHub repo → Settings → Collaborators → Add people |
| Run synthesis | **Shared Brain** → connection card → **"Run synthesis (admin)"** in the main action row, beside Push and Pull (confirm dialog) |
| See who has contributed | Card → **Admin controls — admin token & contributor revocation** → Revoke panel, or `GET /api/sharedbrain/:id/members` (v3.0.5+). For counts only, without opening the revoke panel: Card → **"Cohort & sharing details"** |
| Revoke a contributor | Card → **Admin controls — admin token & contributor revocation** → **Revoke a contributor…** (v3.0.5+), or `POST /api/sharedbrain/:id/revoke` |
| Rotate the admin token | Card → **Admin controls — admin token & contributor revocation** → **Rotate admin token** (v3.0.5+; since v3.43.0 the control appears only on a connection that already HOLDS one, and asks for the current token). There is no GENERATE path here any more — see §9. |
| Re-display the invite token | Card → **Admin controls — admin token & contributor revocation** → **Show invite token** (v3.0.5+), or `POST /api/sharedbrain/generate-invite` |
| Check synthesis stats | `meta/state/last-synthesis.json` in the repo |
| Read the audit log | `state/revocations.jsonl` in the repo |
| Compliance / GDPR ref | [`docs/shared-brain-compliance.md`](shared-brain-compliance.md) |
| Engineering decisions + architecture | [`docs/shared-brain.md`](shared-brain.md) |
| User-facing guide | [`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md) |
| Architecture + design decisions | [`docs/shared-brain.md`](shared-brain.md) |
