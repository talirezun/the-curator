# System Check

**System Check** is a one-click way to confirm **the app itself** is set up
correctly — your API key works, your knowledge folder is writable, your
credentials are secured, and (optionally) your AI provider is actually
responding right now.

It lives in **Settings → System Check**.

> **Three "health"-ish surfaces, three jobs** — don't mix them up:
>
> | Surface | Where | Checks |
> |---|---|---|
> | **Health** tab | top navigation | your **wiki content** (broken links, orphans, duplicate pages) |
> | **Wiki Health — Scan Limits** | Settings | the **cost limits** for the Health tab's AI scans |
> | **System Check** | Settings | the **app & your setup** (key, folder, credentials, sync, connectivity) |
>
> Rule of thumb: **System Check = is the app working?** · **Health tab = is my wiki clean?**

---

## The two checks

### 1. Run system check (free, instant)

Click **Run system check**. It runs a handful of local checks — no network call,
no API cost — and shows a result for each:

| Check | What it confirms |
|-------|------------------|
| **Installed version** | Which version of The Curator you're running. |
| **AI provider key** | That a Gemini or Anthropic key is configured (and which model is active, including a fallback model if one is in use). |
| **Knowledge folder** | That your `domains/` folder exists and is writable. The check writes a tiny throwaway file and immediately deletes it — **it never touches your wiki content.** |
| **Credential file permissions** | That your credential files (`.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`, `.env`, and the sync git config) are owner-only (`0600`) so other accounts on the machine can't read your keys. |
| **GitHub sync** | Whether sync is configured, and how many local changes are waiting to be pushed. |

Each result is marked:

- ✅ **OK** — all good.
- ⚠️ **Review** — not broken, but worth a look (e.g. no API key yet, or a
  credential file isn't locked down — restart the app to auto-harden it).
- ❌ **Problem** — something needs fixing (e.g. the knowledge folder isn't
  writable).
- ℹ️ **Info** — neutral information (e.g. the version number).

### 2. Verify AI connection (optional, ~$0.0001)

This is the only part that costs anything. Click **Verify AI connection**, and
you'll get a confirmation prompt explaining that it makes **one small request**
to your AI provider — roughly **a hundredth of a cent**. Confirm, and The Curator
sends a tiny "reply OK" request to your configured model.

It then reports:

- ✅ **AI connection works** — with the provider, model, and how long it took to
  respond (e.g. *"gemini · gemini-2.5-flash-lite · responded in 773 ms"*).
- ❌ **AI connection failed** — with the exact error, so you can tell whether
  it's a bad/expired key, a provider outage (e.g. an HTTP 503 "overloaded"),
  or a rate limit.

This is the fastest way to answer *"is it my key, or is the provider having a bad
day?"* — for example, when ingest fails with a 503, this test tells you in one
click whether your key is fine and the provider is just busy.

---

## When to use it

- **Right after installing or updating** — confirm everything is wired up.
- **After changing your API key** — verify the new key works (use the AI test).
- **When ingest or chat fails** — the AI connection test distinguishes a
  provider problem from a setup problem.
- **After moving your knowledge folder** — confirm the new location is writable.
- **On a new machine / after syncing** — a quick all-clear before you start.

---

## Privacy & safety

- The quick check is **entirely local** — nothing leaves your machine, and your
  wiki content is never read or written (the folder-writable probe uses a
  self-deleting temp file).
- The AI connection test sends only a fixed 2-word prompt ("reply OK") — none of
  your wiki content is transmitted.
- The AI test is **opt-in and cost-confirmed** every time — it never runs on its
  own.

---

## Related

- [user-guide.md](user-guide.md) — the master guide.
- [ai-health.md](ai-health.md) — the **Health tab** (wiki content cleanup) and
  its **Wiki Health — Scan Limits** settings.
- [model-lifecycle.md](model-lifecycle.md) — what happens when a model is retired
  and how fallback models work.
- [sync.md](sync.md) — Personal Sync setup and troubleshooting.
