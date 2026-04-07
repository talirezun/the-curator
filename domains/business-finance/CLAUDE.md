# Domain: Business / Finance

This is a dedicated second brain for business, finance, and investing topics.

## Scope
Startups, venture capital, investing, markets, macroeconomics, business strategy, company analysis, financial instruments, and the people and organizations shaping the business world.

## Wiki Conventions

### Page Types
- **entities/** — One page per notable person, company, fund, or institution (e.g., `entities/sam-altman.md`, `entities/sequoia.md`).
- **concepts/** — One page per idea, framework, or strategy (e.g., `concepts/unit-economics.md`, `concepts/moat.md`).
- **summaries/** — One page per ingested source (e.g., `summaries/zero-to-one.md`).

### Page Format

**Entity page:**
```
# [Entity Name]
Type: person | company | fund | institution
Tags: [comma-separated]

## Summary
One-paragraph description.

## Key Facts
- Bullet facts

## Related
- [[concept-name]] — why related
- [[other-entity]] — why related
```

**Concept page:**
```
# [Concept Name]
Tags: [comma-separated]

## Definition
Clear, concise definition.

## Why It Matters
Business significance and applications.

## Examples
- Example 1
- Example 2

## Related
- [[entity-or-concept]] — why related
```

**Summary page:**
```
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
```

## Cross-Referencing Rules
- Always use `[[page-name]]` syntax for internal links (without the folder prefix).
- When you create or update a summary, update the corresponding entity and concept pages to reference it.
- Every entity or concept mentioned in a source gets either a new page or an update to an existing page.

## index.md Format
```
# Wiki Index — Business / Finance
Last updated: [YYYY-MM-DD]

| Page | Type | Summary |
|------|------|---------|
| [[page-name]] | concept/entity/summary | One-line description |
```

## log.md Format
Append one entry per ingest:
```
## [YYYY-MM-DD] ingest | [Source Title]
Pages created or updated: list them
```

## Instructions for the AI
When ingesting a source:
1. Write a summary page under `summaries/`.
2. Create or update entity pages for every person, company, fund, or institution mentioned.
3. Create or update concept pages for every key business idea or financial concept.
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using `[source: path/to/page.md]`.
- Synthesize across multiple pages rather than quoting verbatim.
