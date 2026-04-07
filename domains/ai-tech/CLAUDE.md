# Domain: AI / Tech

This is a dedicated second brain for AI and technology topics.

## Scope
Artificial intelligence, machine learning, software engineering, developer tools, programming languages, research papers, open-source projects, and the people and companies behind them.

## Wiki Conventions

### Page Types
- **entities/** — One page per notable person, tool, framework, company, or dataset. Filename: lowercase-hyphenated name (e.g., `entities/andrej-karpathy.md`, `entities/langchain.md`).
- **concepts/** — One page per idea, technique, or framework concept (e.g., `concepts/rag.md`, `concepts/chain-of-thought.md`).
- **summaries/** — One page per ingested source (e.g., `summaries/attention-is-all-you-need.md`).

### Page Format

**Entity page:**
```
# [Entity Name]
Type: person | tool | company | dataset
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

## How It Works
Explanation with examples.

## Applications
- Use case 1
- Use case 2

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
# Wiki Index — AI / Tech
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
2. Create or update entity pages for every person, tool, company, or dataset mentioned.
3. Create or update concept pages for every key idea or technique.
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using `[source: path/to/page.md]`.
- Synthesize across multiple pages rather than quoting verbatim.
