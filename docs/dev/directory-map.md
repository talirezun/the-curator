# Directory map (full)

> Moved out of the auto-loaded `CLAUDE.md` on 2026-09-23 **verbatim** — each bullet, table and code block below is the text `CLAUDE.md` carried, copied by line range; only root-relative link targets were rebased by `../../` because this file lives two folders down. Nothing was reworded or shortened. `CLAUDE.md` keeps a one-line rule per bullet that points here.

`CLAUDE.md` carries a condensed map; this is the annotated one.

## Directory Structure

```
bin/
  curator.js      — `my-curator`, the neutral command (v3.63.0). argv → a subcommand module; works
                    with the app NOT running, no network, no credential. ONE bin name, namespaced —
                    `curator` is Elastic's elasticsearch-curator (~57k dl/week, /usr/bin/curator on
                    Debian) and is NEVER linked, only offered as an opt-in alias that refuses when
                    shadowed.
src/
  cli/            — the subcommands (v3.63.0). A SECOND LOCAL CLIENT of the store, never an Express
                    caller: no route calls it and src/routes/** imports neither bin/ nor this dir.
    resolve.js    — argv, output discipline, exit codes (0 fine · 1 the STORE refused · 2 usage, an
                    ambiguous project, or the stop hook's deliberate block), and the ONE project
                    resolver: --project → .curator-project in cwd or any parent → the configured
                    default domain's own project → refuse with candidates. SHORT_FLAGS (v3.64.0):
                    exactly `-f`→`--file`, `-h`→`--help`, nothing else — before this a bare `-f`
                    fell through to the positionals and `my-curator save -f <file>` HUNG on stdin
    context.js    — `my-curator context`: getProjectContext() to stdout; --json is the envelope
                    verbatim; --for-hook is that harness's session-start envelope
    save.js       — `my-curator save`: a COMPLETE handoff as JSON on stdin (no markdown parser
                    exists on the read side, so a second grammar is refused)
    hook.js       — `my-curator hook`: the capture POLICY and HARNESS_HOOKS, the per-harness
                    envelopes. An unknown --harness emits NOTHING and exits 0
    install-hooks.js— hook CONFIG only, idempotent, merges and preserves foreign entries; NEVER an
                    instruction file (--print-instructions prints instead); refuses an unparseable
                    file
    doctor.js     — prints, writes nothing, exits 0 ALWAYS; derives its harness list and hook
                    state from `harness-adapters.js` rather than a second table (v3.63.0, restated
                    v3.64.0 when it also gained the BRIDGE PROCESSES section)
  brain/
    ingest.js     — main ingest pipeline (single-pass + multi-phase for large docs)
    files.js      — all filesystem logic: writePage (returns change records v2.5.0+), mergeWikiPage, syncSummaryEntities, injectSummaryBacklinks
    compile.js    — conversation compilation (v2.5.0): turns a chat thread into wiki pages via the same writePage pipeline
    llm.js        — LLM abstraction (Gemini or Claude, auto-detected via config.js)
    chat.js       — multi-turn chat against the wiki
    sync.js       — GitHub sync (git --git-dir / --work-tree)
    health.js     — wiki health scanner + auto-fix (broken links, orphans, folder-prefix, cross-folder dedup, hyphen variants, missing backlinks)
    config.js     — persistent config (.curator-config.json): getApiKeys, setApiKeys, getEffectiveKey, getDomainsDir;
                    setGithubReadToken/clearGithubReadToken/getGithubReadTokenStatus (v3.65.2) — the first writer
                    `githubReadToken` ever had; refuses (`config_unreadable`) rather than overwriting an unparseable
                    config, unlike the older setters
    working-state.js— the memory layer STORE (v3.17.0; tier 0 `foundations/` v3.59.0): four tiers under domains/<project>/state/ —
                    project.md (standing brief, human-authored), <scope>/<machine>/current.md
                    (OVERWRITTEN each save), journal.jsonl (append-only). Deliberately NOT routed
                    through writePage: the wiki ACCUMULATES, state must SUPERSEDE.
    diagnostics.js— self-diagnostics (v3.0.1-beta.23): runQuickDiagnostics (free local checks) + runLiveApiCheck (opt-in LLM ping)
    mcp-clients.js— clientInfo.name → a canonical harness id (v3.63.0). PURE DATA, imports NOTHING
                    (it is on the MCP child's import graph). MANY-to-one, allow-listed, read from
                    BOTH protocol eras; a miss is `other` and the caller's string never reaches disk
    harness-adapters.js— the per-harness table (v3.63.0): 14 entries, each fact carrying `source` +
                    `verified`, `hooks.state` in FOUR words (verified · unverified · present-useless
                    · none), `measured: null` on EVERY row. Pure data + pure functions, no Node
                    builtin, so a view can import it exactly as agent-instructions.js does
    github-read-client.js— READ-ONLY GitHub plumbing (v3.63.0), EXTRACTED from
                    sharedbrain-github-adapter.js so there is one implementation; GET only, the
                    token read from a FILE and never logged. MIT by ENTERPRISE-FILES.txt's own rule
                    (it is not on that list) — the maintainer's call to change
    mcp-usage.js  — the content-free usage log (v3.60.0; sid/project/client + the session line in
                    v3.63.0, moved to server.oninitialized in v3.64.0 so a bridge that never
                    receives a tool call still writes one). Aggregation lives in
                    `scripts/measure-harness.js`, not here — it parses the log on its own
    context-framing.js— the MCP's injection-defence framing (v3.64.0): 15 bindings moved
                    byte-identical out of `mcp/tools/working-state.js` — CAVEAT_BODY, the BRIEF_*
                    constants, briefAuthorityNote, FOUNDATIONS_ARE_DATA and the rest. ZERO imports
                    of its own; imported by `mcp/tools/working-state.js` (which still owns
                    `classifyBriefAuthority`, since that calls `isDomainReadonly`) AND by
                    `src/brain/chat.js`, which is how Chat's project-context prompt and the MCP
                    bootstrap render the same caveats byte-for-byte
    mcp-bridge-status.js— read-only stale-bridge detection (v3.64.0): lists processes via
                    `execFile('ps', …)` (no shell) whose command line names this install's own
                    `mcp/server.js`, and calls one STALE when its start time predates the newer of
                    `mcp/server.js`'s and `package.json`'s mtime. `checked: false` on any refusal
                    (non-macOS, `ps` missing) — never rendered as a clean bill
  routes/
    ingest.js     — POST /api/ingest (SSE streaming)
    compile.js    — POST /api/compile/conversation (SSE streaming, v2.5.0)
    domains.js    — domain CRUD
    chat.js       — chat endpoints
    wiki.js       — GET /api/wiki/:domain
    health.js     — GET /api/health/:domain, POST /api/health/:domain/fix[-all]
    sync.js       — sync endpoints
    config.js     — Settings/config endpoints (API keys, updates, domains path); GET|PUT|DELETE
                    /api/config/github-read-token + POST …/test (v3.65.2) — the only HTTP path a GitHub read-only
                    token value arrives on; it never leaves the server again
    memory.js     — GET /api/memory (one row per PROJECT), GET|POST /api/memory/:domain/projects
                    (`?as=project` v3.62.0 makes the LIST handler decline so the detail route can
                    answer about a project literally called `projects`; an unrecognised value is a
                    400, unlike `?open=`, because `as` picks WHICH RESOURCE),
                    PATCH|DELETE …/projects/:project, GET /api/memory/:domain/:project (v3.48.0);
                    …/foundations/init, PUT|DELETE …/foundations/:slug, GET /api/memory/repo-scan
                    (v3.61.0; v3.65.0 — init also takes `remote`+`tokenSource` so a mirror can be
                    BORN REMOTE with no local checkout, and `repo-scan?source=remote` lists a
                    GitHub repo's candidates in two requests with zero blobs fetched); PATCH
                    …/foundations/:slug {readFirst} on EITHER ownership (v3.62.0 — manifest-only,
                    body is one field and a second key is a 400); POST …/foundations/source
                    {remote, tokenSource?, files?} (v3.65.1 — "Mirror from GitHub instead": re-points
                    an existing REPO-OWNED mirror at a repository, clearing `repo.root` and setting
                    `repo.remote` in the SAME write, preserving every `readFirst` flag by slug;
                    refuses a curator-owned project `ownership_mismatch` 409 — deliberately not the
                    shared table's `repo_owned` 400, which means the opposite thing here); PATCH
                    …/knowledge/domains
                    {knowledgeDomains} (v3.65.0 — FOUR segments, not three, because
                    `PATCH /:domain/projects/:project` already matches any three-segment PATCH
                    whose second segment is `projects`; writes `state/[<project>/]project.json`
                    ONLY — curator metadata about which wikis a project draws on, never tiers 2/3).
                    Writes TIER 1 (the
                    standing brief) AND CURATOR-OWNED TIER 0 (v3.61.0) ONLY — one ownership per
                    project enforced in the store, a repo-owned document's CONTENT never written
                    here, only mirrored; tiers 2/3 stay agent-only over MCP — a browser writer there
                    would be a SECOND writer (see the invariants below)
    mcp.js        — My Curator MCP wizard endpoints (config, claude-config, self-test, reveal-config)
    diagnostics.js— GET /api/diagnostics/quick (free), POST /api/diagnostics/live (opt-in AI ping)
  public/         — vanilla JS frontend (no build step; Settings tab hosts the MCP wizard, System Check panel, Health tab, onboarding wizard)
    next/shared/overview.js — renderOverview() (v3.64.2): the ONE overview card, rendered by BOTH
                    the Domains page's OVERVIEW and the Context page's three-layer readings; kit
                    classes `cur-ov-*` carry every rule, the domain page's nine historical `dm-*`
                    tokens ride the same elements as opt-in ALIASES (`alias: 'dm'`), never the
                    kit's own names
    next/shared/sidebar.js — renderSidebarHead/Group/Row() (v3.65.0): the ONE sidebar, rendered by
                    Domains, Context and Settings; `cur-sb-*` classes carry every rule, Domains'
                    historical `dm-row-*` tokens ride as an opt-in ALIAS (`alias: 'dm'`), matched
                    byte-for-byte after three normalisations, each proved inert by execution
    next/shared/monitor.js — renderMonitor() (v3.65.0): the ONE live-state reading you go and
                    read — a recessed mono block, key left value right, the app's `.fresh-dot` on
                    every time-based line — distinct from a fold row's `<summary>` (an incidental
                    reading) and from a `loud` entry (v3.16.1: a warning/cost/outcome, never
                    behind a chevron, always rendered outside `lines`). `renderDepthCell()`
                    (v3.65.1, additive) draws the app's THIRD visual channel — SIZE/SHARE, beside
                    TIME (the freshness dot) and WHICH DOMAIN (the identity dot) — as a cell
                    decoration inside a monitor line or a table cell only: never a time, never a
                    `<summary>`, never a sidebar row. Its length is `value ÷ budget` or
                    `value ÷ max(visible)`, always a NAMED denominator, in `shared/depth-bar.css`
    next/shared/depth-bar.css — the depth bar's rules (v3.65.1): three tones (neutral/identity/
                    danger) at an alpha anchored below the app's own `--mat-row-active` fill, never
                    louder than the row-selection state it sits beside; the value printed on top
                    keeps the ordinary 4.5:1 text floor even where the bar itself does not
mcp/              — My Curator: local read+write MCP server bridging the wiki AND working state to any MCP client
  server.js       — stdio-transport entry point (spawned by Claude Desktop as a child process)
  graph.js        — wiki parser: frontmatter, [[wikilinks]], backlinks, tag inventory (cached in-process)
  storage/
    local.js      — filesystem adapter; resolves domains path from arg/env/.curator-config.json/default
  util.js         — shared helpers: isValidDomain, isValidSlug, normaliseSlug, resolveNodeSlug
  tools/
    index.js      — tool registration hub (the `tools` array is the authoritative
                    tool list) + response-size guard (MAX_RESPONSE_BYTES = 400 KB,
                    ~100 k tokens, with progressive trim)
    domains.js, index-tool.js, search.js, nodes.js, connected.js, summary.js,
    cross.js, overview.js, tags.js, backlinks.js, raw-source.js   — read tools
    compile.js, health.js, dismissed.js, working-state.js         — write tools
scripts/
  measure-harness.js            — the MEASURING INSTRUMENT for harness reach (v3.63.0). Read-only;
                                  its header comment IS the operator protocol (arms A/B/C, N=4, one
                                  task that never mentions saving, an isolated fixture). Verdicts:
                                  not-measured | measured-no | measured-partial | measured-yes
                                  against --min-sessions (default 4). Same aggregation as the
                                  capture route — one function, two callers
  inject-summary-backlinks.js   — retroactive backlink repair for existing summaries
  fix-wiki-duplicates.js        — one-time entity/concept deduplication
  fix-wiki-structure.js         — one-time migration from non-canonical folders
  bulk-reingest.js              — re-ingest all raw files in a domain
  repair-wiki.js                — comprehensive wiki repair (cross-folder dedup, link normalization, backlinks)
  build-app.sh                  — rebuild The Curator.app from the AppleScript template
domains/
  <domain>/
    CLAUDE.md         — domain schema (system prompt for LLM)
    raw/              — uploaded source files (gitignored, local only)
    wiki/
      entities/       — people, tools, companies, frameworks
      concepts/       — ideas, techniques, principles
      summaries/      — one page per ingested source
      index.md        — master page catalog
      log.md          — chronological ingest history
    state/            — working state (v3.17.0). SYNCED, unlike raw/: project.md +
                        <scope>/<machine>/current.md + journal.jsonl +
                        [<project>/]foundations/manifest.json + <slug>.md (tier 0, v3.59.0:
                        verbatim canonical documents, replaced whole, sha256 freshness; ownership
                        set once via init, v3.61.0 — ready-made skeletons when curator-owned,
                        mirrored byte-for-byte when repo-owned, edited by the human in the app
                        only on the curator-owned side; born REMOTE since v3.65.0 — init takes a
                        GitHub `remote` + `tokenSource`, the read runs first, nothing is written
                        unless every document is in hand) +
                        [<project>/]project.json (v3.65.0: `knowledgeDomains` — which wikis a
                        project's knowledge lives in; curator metadata written by the app only,
                        absent = the containing domain with `knowledgeDomainsDefaulted: true`, at
                        most 12)
    conversations/    — saved chat threads (gitignored)
docs/               — user-facing documentation
  spec/working-state-v1.md — the PUBLIC on-disk format (v3.63.0), versioned `working-state/1`: a
                    promise to people who cannot read this source, and therefore pinned to the live
                    constants BY EXECUTION in scripts/test-spec-working-state.js. Change the store's
                    grammar or a budget and that suite reds until the spec follows.
```
