# Domain Schemas

Every domain has a `CLAUDE.md` file that acts as the **system prompt** for all Claude operations in that domain. It is the single most important configuration file in the system.

Claude reads this file before every ingest and every query. It controls:
- What topics belong in this domain
- How pages are structured and named
- How cross-references are formatted
- What instructions Claude follows when processing sources

---

## Schema anatomy

A well-formed `CLAUDE.md` has five sections:

```
# Domain: <Name>

[One-sentence description of the domain's scope]

## Scope
[What topics belong here. Be specific about inclusions and exclusions.]

## Wiki Conventions
[Page types, naming rules, markdown templates]

## Cross-Referencing Rules
[How to link between pages]

## index.md Format
[Template for the master catalog]

## log.md Format
[Template for the ingest log]

## Instructions for the AI
[Step-by-step instructions for ingest and query behaviour]
```

---

## Scope section

The scope section tells Claude what to include and what to ignore. Without it, Claude will create pages for tangentially related topics and dilute the domain.

**Example — too vague:**
```markdown
## Scope
Technology topics.
```

**Example — well-defined:**
```markdown
## Scope
Artificial intelligence, machine learning, software engineering, developer
tools, programming languages, research papers, open-source projects, and
the people and companies behind them.

Out of scope: business strategy, investing, self-improvement (these have
their own domains).
```

The `Out of scope` note is especially useful when you have multiple domains with adjacent topics. It prevents duplication.

---

## Wiki Conventions section

This section defines the three page types and their markdown templates.

### Page types

Every domain should have at minimum:

| Type | Folder | One page per |
|------|--------|--------------|
| Summary | `summaries/` | Ingested source |
| Entity | `entities/` | Person, tool, company, dataset, book |
| Concept | `concepts/` | Idea, technique, framework, principle |

### Naming convention

Filenames should be lowercase and hyphenated. They become the slug used in `[[links]]`.

```
entities/andrej-karpathy.md     → [[andrej-karpathy]]
concepts/chain-of-thought.md   → [[chain-of-thought]]
summaries/attention-paper.md   → [[attention-paper]]
```

### Page templates

Define a markdown template for each page type. Claude will follow it consistently:

**Entity template:**
```markdown
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

**Concept template:**
```markdown
# [Concept Name]
Tags: [comma-separated]

## Definition
Clear, concise definition.

## How It Works
Explanation with examples.

## Applications
- Use case 1

## Related
- [[entity-or-concept]] — why related
```

**Summary template:**
```markdown
# [Source Title]
Source: [filename]
Date Ingested: [YYYY-MM-DD]
Tags: [comma-separated]

## Key Takeaways
- Bullet list of main points

## Concepts Introduced or Referenced
- [[concept-name]]

## Entities Mentioned
- [[entity-name]]

## Notes
Additional commentary.
```

---

## Cross-Referencing Rules section

Cross-references are what make a wiki useful as a knowledge graph instead of a flat file dump. This section tells Claude the syntax and the obligation:

```markdown
## Cross-Referencing Rules
- Always use [[page-name]] syntax for internal links (without folder prefix).
- When you create or update a summary, update the corresponding entity and
  concept pages to reference it.
- Every entity or concept mentioned in a source gets either a new page or
  an update to an existing page.
```

The second and third rules ensure the graph grows bidirectionally — a summary page links to its concepts/entities, and those pages link back.

---

## Instructions for the AI section

This section is the most critical for ingest quality. It tells Claude exactly what to produce:

```markdown
## Instructions for the AI
When ingesting a source:
1. Write a summary page under summaries/.
2. Create or update entity pages for every person, tool, company, or
   dataset mentioned.
3. Create or update concept pages for every key idea or technique.
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using [source: path/to/page.md] format.
- Synthesise across multiple pages rather than quoting verbatim.
```

Step 5 ("Return as JSON") is technically enforced by the ingest prompt, but stating it in the schema reinforces the expected output format.

---

## Customising for a domain

Different domains call for different entity and concept hierarchies. Here are examples for domains beyond the three built-in ones:

### History domain

```markdown
## Wiki Conventions
- entities/ — Historical figures, nations, empires, events, treaties
- concepts/ — Political systems, economic models, military strategies, ideologies
- summaries/ — One page per book, article, or documentary ingested

Entity page additions:
## Era
[Time period, e.g. "Ancient Rome, 27 BC – 476 AD"]

## Impact
[Why this entity matters historically]
```

### Health & Fitness domain

```markdown
## Wiki Conventions
- entities/ — Studies, researchers, protocols, supplements, equipment
- concepts/ — Training principles, nutrition frameworks, physiological mechanisms
- summaries/ — One page per study, book, or podcast episode ingested

Concept page additions:
## Evidence Level
[Strong / Moderate / Weak / Anecdotal]

## Practical Application
[How to actually apply this]
```

### Legal domain

```markdown
## Scope
Contract law, intellectual property, startup legal structures, employment
law. Out of scope: criminal law, family law.

## Wiki Conventions
- entities/ — Laws, regulations, court cases, jurisdictions, legal concepts
  with a specific name
- concepts/ — Legal principles, frameworks, doctrines
- summaries/ — One page per article, case study, or document ingested

Entity page additions:
## Jurisdiction
[Which legal system applies]

## Status
[Current / Superseded / Varies by jurisdiction]
```

---

## Schema iteration

As you ingest more sources, you'll notice gaps or inconsistencies in your wiki. Update `CLAUDE.md` to fix them — the schema change will take effect on the next ingest.

Common improvements over time:
- Add a `Status` or `Last updated` field to entity pages when facts change frequently.
- Add a domain-specific tag taxonomy to make filtering easier.
- Add an `Out of scope` section if off-topic pages keep appearing.
- Refine concept templates to capture domain-specific attributes (e.g. `Evidence Level` for health, `Time Complexity` for algorithms).
