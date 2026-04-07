# User Guide

## Setup

### 1. Add your API key

Copy the example environment file and fill in your Anthropic API key:

```bash
cp .env.example .env
```

Open `.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=3333
```

Get a key at [console.anthropic.com](https://console.anthropic.com).

### 2. Start the server

```bash
node src/server.js
```

You should see:

```
Second Brain running at http://localhost:3333
```

For automatic restarts during development:

```bash
node --watch src/server.js
```

### 3. Open the app

Navigate to `http://localhost:3333` in your browser. You'll see three tabs: **Ingest**, **Query**, and **Wiki**.

---

## Ingesting a source

The **Ingest** tab is how you feed knowledge into your brain.

### Supported file types

| Type | Extension | Notes |
|------|-----------|-------|
| Plain text | `.txt` | Articles, notes, transcripts, anything you've copied |
| Markdown | `.md` | Existing notes, research write-ups |
| PDF | `.pdf` | Papers, reports, books (text-based PDFs; scanned PDFs are not supported) |

### Steps

1. Select a **domain** from the dropdown.
2. Drag a file onto the drop zone, or click it to browse.
3. Click **Ingest**.
4. Wait — Claude reads the entire source and updates the wiki. This typically takes 15–45 seconds depending on the length of the document.
5. When done, you'll see a list of every wiki page that was created or updated.

### What happens behind the scenes

Claude reads your source and produces:

- A **summary page** — key takeaways from the document.
- **Entity pages** — one page per notable person, tool, company, framework, or dataset mentioned.
- **Concept pages** — one page per key idea or technique.
- **Cross-references** — every page links to related pages using `[[page-name]]` syntax.
- An updated **index** — the master catalog of everything in the wiki.
- A **log entry** — a timestamped record of the ingest.

On subsequent ingests, Claude reads the existing index and updates existing pages rather than duplicating them. Knowledge compounds.

### Tips for better ingests

- **Clean up your source first.** Remove boilerplate (navigation menus, footers, email headers) before saving to a `.txt` file. The cleaner the input, the sharper the wiki pages.
- **Use descriptive filenames.** `atomic-habits-chapter-5.txt` is more useful than `doc1.txt` — the filename appears in the log and summary page.
- **One source at a time.** Ingest documents one by one so each gets a proper summary page. Concatenating ten articles into one file makes it harder for Claude to write focused pages.
- **PDF caveat.** `pdf-parse` extracts raw text from PDFs. Complex layouts (multi-column, heavy graphics) may produce garbled text. For those, copy-paste the text into a `.txt` file instead.

---

## Querying your brain

The **Query** tab lets you ask questions and get synthesised answers with citations.

### Steps

1. Select a **domain**.
2. Type your question in the text area.
3. Click **Ask** (or press `Cmd/Ctrl + Enter`).
4. Claude reads the entire wiki for that domain and returns a structured answer.

### What a good answer looks like

```
RAG (Retrieval-Augmented Generation) works by combining a retrieval step with
a generation step [source: concepts/rag.md]. Rather than relying purely on the
model's parametric memory, it fetches relevant documents first and conditions
the generation on them [source: summaries/rag-survey.md].

The key advantage over fine-tuning is that the knowledge base can be updated
without retraining the model [source: concepts/fine-tuning.md].

## Sources
- concepts/rag.md
- summaries/rag-survey.md
- concepts/fine-tuning.md
```

### Query tips

- **Be specific.** "What are the tradeoffs between RAG and fine-tuning?" yields a better answer than "Tell me about AI."
- **Ask comparative questions.** "How does X relate to Y?" — Claude can synthesise across multiple wiki pages in ways a keyword search can't.
- **Ask for lists.** "What entities are mentioned in my notes about transformers?" works well.
- **Ask follow-up questions.** Re-run the query with a more specific question based on the previous answer.
- **The wiki must have relevant content.** If you haven't ingested any sources about a topic, Claude will say so honestly rather than hallucinating.

---

## Browsing the wiki

The **Wiki** tab gives you a read-only view of everything in a domain.

1. Select a **domain**.
2. Click **Load**.
3. The sidebar shows all pages grouped by type (summaries, concepts, entities).
4. Click any page to read it.

For a richer experience with graph view and backlinks, open the `domains/` directory in [Obsidian](https://obsidian.md) — the `[[page-name]]` cross-references render as native links.

---

## Domain selection strategy

Each domain is an isolated wiki. Keep domains **focused and mutually exclusive**:

| Good domain definition | Too broad |
|------------------------|-----------|
| AI / Tech | Science and Technology |
| Business / Finance | Career and Money |
| Personal Growth | Life |

A focused domain with 40 pages about one topic is more useful than a sprawling domain with 200 pages across 15 topics. When you query a focused domain, Claude has a tighter, more coherent knowledge graph to reason over.

The three built-in domains are:

| Domain slug | What to put here |
|-------------|-----------------|
| `ai-tech` | AI papers, developer tools, engineering articles, tech company analysis |
| `business-finance` | Business books, investing frameworks, startup analysis, market research |
| `personal-growth` | Self-improvement books, productivity systems, mental models, psychology |

To add a new domain, see [adding-domains.md](adding-domains.md).

---

## Managing your wiki files

All wiki files are plain markdown under `domains/<domain>/wiki/`. You can:

- **Read them in any text editor** or open the folder in Obsidian.
- **Edit them manually** if you want to add personal notes or correct something Claude got wrong.
- **Delete a page** by removing the file — the index will become stale until the next ingest updates it.
- **Search across them** with `grep` or any editor's global search.

### Key files in every domain

| File | Purpose |
|------|---------|
| `wiki/index.md` | Master catalog — every page with a one-line summary. Start here when browsing. |
| `wiki/log.md` | Chronological history of every ingest. Tells you what was added when. |
| `wiki/summaries/` | One file per source you've ingested. |
| `wiki/concepts/` | Key ideas extracted from your sources. |
| `wiki/entities/` | People, tools, companies, and other named things. |
| `raw/` | Your original uploaded files. Never modified by the system. |

---

## Troubleshooting

**The server won't start**

Check that `.env` exists and contains a valid `ANTHROPIC_API_KEY`. Run:
```bash
node -e "require('dotenv/config'); console.log(!!process.env.ANTHROPIC_API_KEY)"
```

**Ingest fails with a JSON parse error**

Claude occasionally wraps its response in markdown code fences despite instructions not to. The ingest code strips these, but very long documents may hit the API token limit. Try splitting the document into smaller files.

**PDF text looks garbled**

The document is likely scanned (image-based) rather than text-based. Copy the text manually and save it as a `.txt` file.

**The query answer references pages that don't exist**

Claude may cite a page slug that hasn't been created yet (it was mentioned in another page's cross-references but not yet the subject of its own ingest). Add a source about that topic to populate the page.

**Port 3333 is already in use**

Set a different port in `.env`:
```
PORT=4000
```
