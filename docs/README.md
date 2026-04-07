# Second Brain — Documentation

> A domain-specific, AI-powered knowledge system based on the Karpathy/Spisak llm-wiki concept.

## Contents

| Document | Description |
|----------|-------------|
| [architecture.md](architecture.md) | System design, data flow, and module reference |
| [user-guide.md](user-guide.md) | How to use the app day-to-day |
| [domain-schemas.md](domain-schemas.md) | How domain CLAUDE.md schemas work and how to write your own |
| [adding-domains.md](adding-domains.md) | Step-by-step guide to adding new domains |
| [api-reference.md](api-reference.md) | Full REST API reference |

## Quick start

```bash
# 1. Set your Anthropic API key
cp .env.example .env && open .env

# 2. Start the server
node src/server.js

# 3. Open the app
open http://localhost:3333
```

## Core concept

The problem with a general-purpose second brain is that one system trying to cover everything ends up good at nothing. This system uses **dedicated wikis per domain** — each one stays focused, compounds knowledge from every source you add, and can be queried like a domain specialist.

Each domain is an isolated, self-referencing wiki of markdown files. Claude reads your sources, extracts entities and concepts, writes interlinked pages, and synthesises answers with citations on demand.
