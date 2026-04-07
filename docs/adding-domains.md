# Adding Domains

A domain is a directory under `domains/` with a specific structure. You can add as many as you like, and the app will discover them automatically — no code changes required.

---

## Step 1: Create the directory structure

Replace `my-domain` with a lowercase, hyphenated slug (e.g. `history`, `health-fitness`, `legal`):

```bash
mkdir -p domains/my-domain/raw
mkdir -p domains/my-domain/wiki/entities
mkdir -p domains/my-domain/wiki/concepts
mkdir -p domains/my-domain/wiki/summaries
```

## Step 2: Create the wiki index and log

```bash
# index.md
cat > domains/my-domain/wiki/index.md << 'EOF'
# Wiki Index — My Domain
Last updated: 2026-04-07

| Page | Type | Summary |
|------|------|---------|
EOF

# log.md
cat > domains/my-domain/wiki/log.md << 'EOF'
# Ingest Log — My Domain

EOF
```

## Step 3: Write the CLAUDE.md schema

This is the most important step. Create `domains/my-domain/CLAUDE.md` and fill in each section. Use the template below as a starting point:

```markdown
# Domain: My Domain

This is a dedicated second brain for [describe the topic].

## Scope
[What topics belong here. Include an "Out of scope" line if adjacent
domains exist that could overlap.]

## Wiki Conventions

### Page Types
- **entities/** — [What counts as an entity in this domain]
- **concepts/** — [What counts as a concept in this domain]
- **summaries/** — One page per ingested source

### Page Format

**Entity page:**
\```
# [Entity Name]
Type: [type options relevant to this domain]
Tags: [comma-separated]

## Summary
One-paragraph description.

## Key Facts
- Bullet facts

## Related
- [[concept-name]] — why related
\```

**Concept page:**
\```
# [Concept Name]
Tags: [comma-separated]

## Definition
Clear, concise definition.

## [Domain-specific section]
[Add a section that makes sense for your domain]

## Related
- [[entity-or-concept]] — why related
\```

**Summary page:**
\```
# [Source Title]
Source: [filename or description]
Date Ingested: [YYYY-MM-DD]
Tags: [comma-separated]

## Key Takeaways
- Bullet list of main points

## Concepts Introduced or Referenced
- [[concept-name]]

## Entities Mentioned
- [[entity-name]]

## Notes
Any additional commentary.
\```

## Cross-Referencing Rules
- Always use [[page-name]] syntax for internal links (without folder prefix).
- When you create or update a summary, update the corresponding entity and
  concept pages to reference it.
- Every entity or concept mentioned in a source gets a new or updated page.

## index.md Format
\```
# Wiki Index — My Domain
Last updated: [YYYY-MM-DD]

| Page | Type | Summary |
|------|------|---------|
| [[page-name]] | concept/entity/summary | One-line description |
\```

## log.md Format
Append one entry per ingest:
\```
## [YYYY-MM-DD] ingest | [Source Title]
Pages created or updated: list them
\```

## Instructions for the AI
When ingesting a source:
1. Write a summary page under summaries/.
2. Create or update entity pages for every [relevant entity type] mentioned.
3. Create or update concept pages for every key idea or technique.
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using [source: path/to/page.md] format.
- Synthesise across multiple pages rather than quoting verbatim.
```

## Step 4: Verify

Restart the server (or it picks up the new domain on the next API call — `listDomains` reads the filesystem each time):

```bash
node src/server.js
```

Open the app and check that your new domain appears in the dropdowns. Ingest a source to confirm the schema works as expected.

---

## Removing a domain

Delete its directory:

```bash
rm -rf domains/my-domain
```

The app will stop listing it on the next request. There is no database entry to clean up.

---

## Renaming a domain

Domains are identified only by their directory name. To rename:

```bash
mv domains/old-name domains/new-name
```

Any existing wiki pages, index, and log are preserved. The slug changes immediately.

---

## Checklist

- [ ] `domains/<slug>/CLAUDE.md` — schema written with all sections
- [ ] `domains/<slug>/raw/` — directory exists (can be empty)
- [ ] `domains/<slug>/wiki/index.md` — initialised with header and empty table
- [ ] `domains/<slug>/wiki/log.md` — initialised with header
- [ ] `domains/<slug>/wiki/entities/` — directory exists
- [ ] `domains/<slug>/wiki/concepts/` — directory exists
- [ ] `domains/<slug>/wiki/summaries/` — directory exists
