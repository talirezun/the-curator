# Domain: Personal Growth

This is a dedicated second brain for personal development, habits, and productivity topics.

## Scope
Self-improvement, mental models, habits, learning techniques, decision-making, books, psychology, philosophy, productivity systems, and the thinkers behind them.

## Wiki Conventions

### Page Types
- **entities/** — One page per notable person, book, or framework (e.g., `entities/james-clear.md`, `entities/atomic-habits.md`).
- **concepts/** — One page per mental model, habit, or principle (e.g., `concepts/habit-loop.md`, `concepts/second-order-thinking.md`).
- **summaries/** — One page per ingested source (e.g., `summaries/deep-work.md`).

### Page Format

**Entity page:**
```
# [Entity Name]
Type: person | book | framework
Tags: [comma-separated]

## Summary
One-paragraph description.

## Key Ideas
- Bullet list of main ideas

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
How this applies to personal growth.

## How to Apply It
Practical steps or examples.

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
Any additional commentary or personal reflections to record.
```

## Cross-Referencing Rules
- Always use `[[page-name]]` syntax for internal links (without the folder prefix).
- When you create or update a summary, update the corresponding entity and concept pages to reference it.
- Every person, book, or concept mentioned in a source gets either a new page or an update to an existing page.

## index.md Format
```
# Wiki Index — Personal Growth
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
2. Create or update entity pages for every person, book, or notable framework mentioned.
3. Create or update concept pages for every key idea, mental model, or principle.
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using `[source: path/to/page.md]`.
- Synthesize across multiple pages rather than quoting verbatim.
