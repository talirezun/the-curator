# Roadmap — Chat UI Modes 3 & 4 (planned, not yet implemented)

> Moved out of `CLAUDE.md` so it stops costing context in every session. It is
> **design context for features that have never been built** — as of v3.24.1 the
> Chat tab still ships Modes 1 (Discover) and 2 (Compile) only. Nothing here
> describes shipped behaviour, so it changes nothing a session does today; read
> it when you are about to implement Dictate or Curate, and update it in place.
> Content below is unchanged from `CLAUDE.md`.

> This section is the **persistent design context** for a future session that
> will implement Modes 3 (Dictate) and 4 (Curate) of the Chat tab. It captures
> what we've decided so the implementing session can start coding without
> re-deriving the architecture. Update this section as decisions firm up.

### The four-mode model

The Chat tab is evolving from a single-purpose Q&A surface into a four-mode
authoring environment that mirrors the natural lifecycle of working with a
second brain:

| Mode | Status | What it does | Direction |
|------|--------|--------------|-----------|
| 1. **Discover** | ✅ shipped (v1.0) | Multi-turn Q&A against the wiki — answers cite specific pages. | read |
| 2. **Compile** | ✅ shipped (v2.5.0) | After a Discover conversation, click "Compile to Wiki" to turn it into a permanent summary + new entity/concept pages. | read → write |
| 3. **Dictate** | 🔮 planned | Stream-of-thought capture. User types or speaks raw thoughts; the chat UI structures them and writes to the wiki immediately without requiring a multi-turn conversation. | write-first |
| 4. **Curate** | 🔮 planned | Review-and-refine an existing wiki page or batch of pages in the chat UI. Conversational editorial dialogue (different from Health, which is rule-based). | rewrite |

The progression reads coherently: **Discover (read) → Compile (write a summary
of a thought process) → Dictate (capture raw thought directly) → Curate (refine
what's already in the wiki).**

### Mode 3 — Dictate

**Use case.** *"I just had an idea I want to capture quickly. I don't want a
conversation, I just want to dump what I'm thinking and have it land in the
wiki properly structured."*

Compile (Mode 2) requires a multi-turn conversation first. Dictate is for the
single-shot case — paste a paragraph, click Save, done.

**Proposed UI.**
- Mode-switcher in the chat-tab header (segmented control: `Discover · Compile · Dictate · Curate`).
- In Dictate mode, the chat input becomes a "Dictate" box with a **Save to wiki** button instead of Send.
- Optional **target page hint** (entity / concept / summary auto-detected from content, user can override).
- After save: the existing v2.5.0 change-record panel renders the result.

**Backend reuse.**
- `compileConversation()` is too multi-turn-shaped — Dictate gets its own thin wrapper:
  `dictateNote(domain, { text, kind?, hint? })` → builds a one-shot LLM prompt that asks for *one* page (entity / concept / summary) with proper structure, then runs through `writePage` + `syncSummaryEntities` + index merge — same chokepoint.
- Lives in `src/brain/dictate.js` (new), parallels `src/brain/compile.js`.
- Route: `POST /api/dictate/note` (SSE-streamed, mirrors compile route).
- File-existence idempotency guard like compile uses.
- v2.5.5 link grounding inherited automatically (same pre-write resolution path used by `compile_to_wiki`).

**Open design questions.**
1. Voice input — should the input box accept speech-to-text via Web Speech API, or stay text-only? The user mentioned "dictate" literally; voice is the headline UX win.
2. Auto-detection of page type (entity vs concept vs summary) — is the LLM reliable enough to pick automatically, or always show a chooser?
3. Should Dictate write directly, or always show a preview / confirm step first? Compile has dry-run; Dictate probably doesn't need one because the input is the user's own raw text — they wrote it, they can re-read it.

### Mode 4 — Curate

**Use case.** *"I'm looking at this entity page and it's a mess. Let me chat
with Claude to clean it up — restructure sections, merge with a related page,
suggest what's missing — without leaving the chat tab."*

Health is rule-based. Curate is editorial. Different action, different surface.

**Proposed UI.**
- Mode 4 surfaces a **page picker** alongside the message thread: pick an entity, concept, or summary; its content loads into a side panel.
- Dialogue with Claude is grounded in that page (and optionally its connected pages — pulled via the existing `get_connected_nodes` MCP-style logic but inline in the app).
- Suggested actions Claude can offer:
  - "Restructure this page into Summary / Key Facts / Related"
  - "Pull bullets from these three related pages and consolidate them here"
  - "Suggest five concept pages this entity should link to"
  - "Rewrite the Definition section to be clearer"
- Apply button on each suggestion → routes through `writePage` (additive merge handles non-destructive updates) or `fixIssue` for structural ones.

**Backend reuse.**
- Probably no new tools required — composes existing primitives: `readWikiPage`, `writePage`, the chat pipeline, and (if AI-suggested edits target other pages) `injectRelatedLink` from `files.js`.
- New module if needed: `src/brain/curate.js` — but might just live inside the chat route as additional context-injection logic.
- Route: extend `POST /api/chat/:domain` with an optional `curateContext: { pagePath }` field, OR a separate `POST /api/curate/:domain/:pagePath`. Decision pending.

**Open design questions.**
1. Should Curate mode lock the user into editing **one page at a time**, or support multi-page sessions (e.g. merging two entities)? The risk with multi-page is destructive edits — merge has the v2.4.5 preview-gate pattern that we'd need to mirror.
2. Diff visualisation — should every Claude-suggested edit show a before/after diff before the user clicks Apply? Probably yes for prose changes; bullet additions can apply silently.
3. Cross-domain Curate — refuse (consistent with the v2.5.6 siloing principle), or special-case for users who want to refactor across domains? Default: refuse.
4. AI Health overlap — at what point does "Curate suggested merging these two pages" become "use the v2.4.5 semantic-dupe scan instead"? Probably the line is: Curate is for one-page authoring, semantic-dupe is for cross-domain detection. Document the boundary.

### Files that would change (rough estimate)

```
NEW:
  src/brain/dictate.js                — single-shot note capture
  src/brain/curate.js (maybe)         — only if logic outgrows chat route
  src/routes/dictate.js               — POST /api/dictate/note (SSE)
  docs/chat-modes.md (maybe)          — single-page deep-dive on the four modes

MODIFIED (updated for v3.41.0's retirement of the pre-redesign shell — the
only frontend now is src/public/next/**):
  src/public/next/index.html          — mode-switcher segmented control + page-picker for Curate
  src/public/next/views/chat.js       — mode state machine + per-mode UI logic
  src/public/next/views/chat.css      — mode-switcher styles
  src/server.js                       — register dictate route
  src/routes/chat.js                  — optional curate-context support
  docs/user-guide.md §9               — describe all four modes
  docs/mcp-user-guide.md              — note that compile_to_wiki is the MCP equivalent of Mode 2
  CLAUDE.md                           — version history entry, design decisions
```

### Reusable primitives already in place

- v2.5.0 change-record shape (used by ingest, compile, MCP writes) — Dictate + Curate inherit.
- v2.5.5 link grounding (`buildSlugInventory`, `tryResolveLink`) — Dictate's writes pass through it for free; Curate's edits should too.
- v2.5.1 dismissal store — irrelevant to Modes 3/4 directly, but Curate could surface "you previously dismissed this issue, want to un-dismiss?" prompts.
- v2.5.2 default-domain config — Dictate should respect it (just like MCP `compile_to_wiki` does).

### Pre-implementation checklist

Before the implementing session starts coding:
1. Confirm whether voice (Web Speech API) is in scope for Dictate v1, or text-only.
2. Decide page-type auto-detection vs explicit chooser for Dictate.
3. Decide single-page vs multi-page scope for Curate v1.
4. Decide per-suggestion diff vs silent-apply for Curate prose edits.
5. Mode-switcher UI: segmented control vs tab-row vs sidebar — small visual decision.
