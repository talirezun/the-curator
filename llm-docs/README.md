# llm-docs/ — self-contained markdown written for language models

**This README is for the maintainer. It is not uploaded.** Only the
`curator-*.md` files in this folder go to Lumina.

This folder holds the project's documentation written specifically **for a
language model to read**, not for a person browsing GitHub — each file is
self-contained (no assumed context from the rest of the repo), compact (every
byte is paid for on every answer, see below), and answers the questions a
visitor actually types rather than describing the code. Today the one
consumer is **Lumina**, the support chat assistant on The Curator's website
(mycurator.dev): after a release changes these files, the maintainer
re-uploads the changed `curator-*.md` files to Lumina **by hand** — there is
no pipeline, webhook or auto-sync (see "Uploading to Lumina" below). The
folder was renamed from `public-knowledge/` to `llm-docs/` in v3.65.2 to name
what it is rather than one particular use of it; the on-disk shape, the
budgets and the upload procedure are unchanged.

## The constraints that shape every file here

1. **No search.** Lumina does not retrieve; every document is sent to the model
   **in full before every answer**. A paragraph added here is not paid for once
   — it is paid for on every question every visitor ever asks.
2. **Compact is the requirement**, not a preference. Cut, do not append.
3. **Shape**: one `#` heading at the top, `##` per topic **written as the
   question a visitor would type**, nothing deeper than `##`.
4. **Plain markdown only**: tables for tabular content; no HTML, no front
   matter, no images, no emoji. (`→` is the one allowed symbol.)
5. **No marketing language, and do not invent.** If a fact is not in the
   repository, it does not go in a file here.

## Who owns which fact

A fact is stated **exactly once**, in the file that owns it. Everything is sent
on every answer, so a fact repeated in two files is a fact paid for twice.

| File | Owns |
|---|---|
| `curator-overview.md` | What The Curator is, who it is for, what it costs, licensing, security posture, and the limits — what it does *not* do |
| `curator-user-guide.md` | Installing it, and using every screen: ingest, chat, domains, wiki, Health, sync, settings, Obsidian, troubleshooting |
| `curator-agent-memory.md` | Project context — foundations and the reading plan, working state, projects, standing briefs, the MCP memory tools, the skills, activation, Copy agent instructions, the menu bar icon. **The FILENAME deliberately did not follow v3.62.0's rename**: the set is uploaded by filename, its budget is keyed on that name below, and renaming would break the upload identity for nothing |
| `curator-links.md` | Navigation only. No facts: it says which page in the GitHub docs answers a question, and gives the URL |

When a fact straddles two files, the owning file states it and the other file
says nothing at all rather than summarising it. `curator-links.md` never
explains anything — it points.

## Budgets

Estimated tokens = **characters ÷ 4**.

| File | Budget (tokens) |
|---|---|
| `curator-overview.md` | 12,000 |
| `curator-user-guide.md` | 45,000 |
| `curator-agent-memory.md` | 30,000 |
| `curator-links.md` | 8,000 |
| **Hard ceiling over the set** | **200,000** |

The target for the whole set is roughly **95,000** tokens. The 200,000 ceiling
is the number that must never be crossed; the target is the number to design
against, because the gap is the room later releases need.

## How to measure

```bash
node scripts/test-public-knowledge.js
```

It prints the budget table — file, characters, estimated tokens, budget,
percentage used — on **every** run, passing or failing, so the meter is visible
before a budget is breached rather than after. It also fails on:

- a missing or duplicated `#` title, or a title that is not the first line
- any heading deeper than `##` outside a code fence
- front matter, HTML tags, emoji
- any absolute home path (`/Users/`, `/home/`, `C:\Users`) — **this repository
  is public**
- any file over its budget, or the set over the ceiling
- any `https://github.com/talirezun/the-curator/blob/main/…` link whose file
  does not exist, or whose `#anchor` is not a real heading in that file

A file that is not on disk is skipped with a printed note and the rest of the
set still passes. If none of the four is present the suite fails.

The suite runs as part of `npm test` (it is registered in the `OFFLINE` array in
`scripts/run-tests.js`).

## Maintenance rule

The project brief's rule is that **documentation is current in the same release
as the behaviour change**. This folder is part of that. The wording for the
release checklist:

> Update `llm-docs/` when a user-visible behaviour, price, default
> model, label or URL changes — **and then re-upload the changed files to
> Lumina by hand.**

**Outstanding for v3.69.0** (supersedes the v3.68.0 note below — this documentation sync covers
v3.68.1 and v3.69.0 together): project-wide foundations "ownership" is **retired** — a project may
now hold documents written here, copied in, and mirrored from up to 8 folders and/or GitHub
repositories at once, checked per document rather than once per project; both Add doors stay
enabled on every project; Add from this computer offers **Keep in sync** or **Copy once**; a name
collision lands under a readable suffix rather than overwriting; every row carries a delete icon
(mirrored rows lose the pencil); deleting a mirrored document never comes back on a refresh, and
deleting a source's last document removes that source. A v3.68.1+ app reads a project saved by a
newer version **read-only**, "update The Curator," never suggesting a fix. `curator-agent-memory.md`
and `curator-overview.md` changed — see the budget table below for the current token figures — and
need re-uploading; `curator-user-guide.md` and `curator-links.md` are unchanged in substance for
this release. The website repository's copies (`site/lumina-knowledge/*.md`, `site/llms.txt`) still
need updating to match, and **Lumina's own live knowledge base still needs the manual upload**
described below; remove this note once it is done, and a stale note left here is how this file
stops being read.

*Prior note, v3.68.0* (Context → Documents' step ① head row's two doors, replacing the old
three-control row; the curator-owned editor's button renamed **Write a document**; one app-wide
toast for action confirmations; a document mirrored from GitHub reading **"GitHub · not
checked"**, v3.67.2) — folded into the v3.69.0 note above rather than tracked twice.

**Editing a file here changes nothing on the website.** There is no pipeline, no
webhook and no sync: Lumina serves the copy it was given, so a release that
edits these files and stops there leaves the assistant answering from the
previous version. Re-uploading is a manual step the maintainer performs, per
changed file, using the procedure below. Treat it as part of the release, not
as follow-up.

The failure mode is specific and worth naming: the GitHub docs get updated in
the release, this folder does not, and the website assistant then answers with
last release's price, last release's default model, or a menu label that no
longer exists — confidently, to a stranger, with no way for anyone to notice.
Renamed doc headings are caught by the test; wrong facts are not.

## Uploading to Lumina

In Lumina, go to **Knowledge & sources → Add Document → Upload File** and upload
**one `.md` at a time**. Do not upload this README.

Two notes on the numbers:

- Lumina's own meter, shown after a document is uploaded, is the authority.
  The `chars ÷ 4` figure from the test suite is an estimate to design against,
  and it can be out by a noticeable margin on a table-heavy file.
- Uploading the same filename again does not necessarily replace what is there.
  To update a document, **edit it in place** in Lumina, or **delete it and
  re-add it**. Two copies of one file is the most expensive mistake available
  here: it doubles that file's cost on every single answer, and nothing warns
  you.

After any upload, ask the assistant two or three questions whose answers live in
the file you changed, and check the links it gives back are the ones in
`curator-links.md`.
