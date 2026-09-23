# docs/dev — the development guide's full text

`CLAUDE.md` at the repo root is auto-loaded into every Claude Code session, so since 2026-09-23 it
carries only what a session needs at the start: what the project is, where working state lives, a
condensed map, one line per standing rule, the ship discipline and the newest changelog rows. The
full text of everything else lives here, moved **verbatim** (only root-relative link targets were
rebased by `../../`). Open a file by name when the task touches it.

| File | Read it before you change… |
|---|---|
| [decisions-app.md](decisions-app.md) | the UI (the six design rules), install/update, models and money, security and user-data paths, tests and CI |
| [decisions-knowledge.md](decisions-knowledge.md) | the wiki write pipeline, Health, ingest, chat, compile, sync or Shared Brain |
| [decisions-agents.md](decisions-agents.md) | anything in `mcp/`, the memory layer (`working-state.js`, `state/`), the CLI, hooks or the agent-instructions block |
| [wiki-pipeline.md](wiki-pipeline.md) | `files.js` / `config.js` key functions, the ingest flow, or the LLM compliance workarounds; also the post-ingest checklist and Obsidian setup |
| [directory-map.md](directory-map.md) | — the full annotated map of the tree |
| [operations.md](operations.md) | environment variables, config files, provider selection, default models, and every script's usage |
| [release-index.md](release-index.md) | — one line per archived release; each full row is in [CHANGELOG-ARCHIVE.md](../../CHANGELOG-ARCHIVE.md) |

These files describe the code; when one disagrees with the code, the code is the fact — fix the
file in the same change.

## Active Development Decisions

Until 2026-09-23 `CLAUDE.md` carried one section of this name: 89 bullets, about 92 KB. Every
bullet now lives, word for word, in one of the three `decisions-*.md` files above, grouped by
theme; `CLAUDE.md` keeps one line per theme's key rules with a link to the group's heading.
