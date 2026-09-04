# Architecture

> This document is intended for developers who want to understand how the system works internally.

## Overview

The Curator is a local Node.js web application. It has no external database — all knowledge is stored as plain markdown files on disk. An LLM is the only external dependency at runtime, reached through one of three providers — Google Gemini, Anthropic Claude, or OpenRouter — selected by which API key is configured.

### Core design philosophy: Curation, not retrieval

The Curator implements the "compiling wiki" pattern rather than standard RAG. When a source is ingested, the LLM does not merely index it for later retrieval — it integrates the knowledge into persistent wiki pages. On every subsequent ingest, existing entity and concept pages are updated rather than duplicated. The result is a knowledge base that compounds over time: cross-references are pre-built, contradictions are flagged at write time, and the synthesis already reflects the full corpus when a query arrives. This is why the chat pipeline can answer from the compiled wiki rather than relying on embedding-based chunk retrieval. On small domains that means the whole wiki fits in one context window; on large ones the chat selects the pages most relevant to the query (entity-pivot + keyword scoring within a fixed budget) plus a compact catalogue of everything else, then routes the answer to a decision / list / synthesis shape based on the question (see [ingestion-pipeline.md §10b–§10c](ingestion-pipeline.md)).

```
Browser (http://localhost:3333)
        │
        │  HTTP
        ▼
┌─────────────────────────────────────┐
│           Express server            │
│           src/server.js             │
│                                     │
│  /api/domains      /api/ingest      │
│  /api/ingest-queue /api/query       │ ← batch ingest, v3.3.0+
│  /api/wiki/:domain /api/chat        │ ← +page/+source, v3.2.0+/v3.5.0
│  /api/sync         /api/config      │
│  /api/health       /api/mcp         │
│  /api/compile      /api/sharedbrain │ ← v3.0.0-beta+ (gated by flag)
│  /api/diagnostics  /api/restart     │
│  /api/version                       │
└───────────────┬─────────────────────┘
                │
        ┌───────┴──────────┐
        │                  │
        ▼                  ▼
┌──────────────┐   ┌──────────────┐
│  brain/      │   │  brain/      │
│  ingest.js   │   │  chat.js     │
└──────┬───────┘   └──────┬───────┘
       │                  │
       └─────────┬─────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│           brain/llm.js              │
│  Provider abstraction layer         │
│  (Gemini or Claude, auto-detected)  │
└─────────────────────────────────────┘
                 │
                 │  API call (key from config.js)
                 ▼
┌─────────────────────────────────────┐
│  Google Gemini  OR  Anthropic Claude│
│  (key priority: config file → .env) │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│           brain/files.js            │
│  read / write markdown on disk      │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  domains/<domain>/                  │
│  ├── CLAUDE.md       (schema)       │
│  ├── raw/            (source files) │
│  ├── wiki/           (knowledge)    │
│  └── conversations/  (chat history) │
└─────────────────────────────────────┘
```

Obsidian (a separate desktop app) reads the same `domains/` folder directly — no sync or export required.

### Shared Brain layer (v3.0.0-beta+, opt-in)

When the `sharedBrainEnabled` feature flag is on, an additional layer becomes active. Routes under `/api/sharedbrain/*` orchestrate push/pull/synthesize/revoke against a pluggable storage backend:

```
┌─────────────────────────────────────────┐
│         brain/sharedbrain.js             │
│   pushDomain  pullCollective             │
│   ensureSharedDomainExists               │
└───────┬─────────────────────────────────┘
        │
        │   SharedBrainStorageAdapter (abstract)
        │   src/brain/sharedbrain-storage.js
        ▼
┌─────────────────────────────────────────┐
│  createStorageAdapter(connection)        │
│  src/brain/sharedbrain-storage-factory   │
└───────┬─────────────────────────────────┘
        │ dispatched by connection.storage_type
        ├──────────────────┬───────────────────┐
        ▼                  ▼                   ▼
 ┌────────────┐    ┌─────────────────┐  ┌──────────────────┐
 │ Local      │    │ GitHub          │  │ Cloudflare R2    │
 │ Folder     │    │ Storage         │  │ (planned ⏳)     │
 │ Adapter    │    │ Adapter (v3.0)  │  │                  │
 │            │    │ REST + PAT      │  │ Worker + R2      │
 │ (battle    │    │ + SHA           │  │ (jurisdiction:eu)│
 │ testing)   │    │ concurrency     │  │                  │
 └────────────┘    └─────────────────┘  └──────────────────┘
```

Synthesis (`brain/sharedbrain-synthesis.js`) and revoke (`brain/sharedbrain-revoke.js`) operate against the same adapter interface — backend-agnostic. See [`docs/shared-brain.md`](shared-brain.md) for the concept, architecture, and engineering decisions; [`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md) for the step-by-step user-facing flows.

---

## The redesigned shell (`src/public/next/**`) — the primary frontend since v3.9.0

A second, complete frontend has lived at `src/public/next/**` since v3.1.3. It was built in parallel at `/next` while the original frontend (`src/public/app.js`) served `/`. **In v3.9.0 that flipped: the redesigned shell answered `/` and the SPA catch-all, and the original frontend became the escape hatch at `/old`.** It was kept there for a run of releases far longer than the "two or three" originally planned, then **deleted outright in v3.41.0** — `src/public/{app,markdown}.js`, `index.html` and `styles.css` are gone, and `/old` now 302-redirects to `/`.

The two share nothing — no imports, no globals, no shared module state — with one deliberate exception (the byte-identical batch-ingest helper module described below, which exists precisely so a bug fixed in one cannot silently survive in the other).

> **Terminology, because this section pre-dates the cutover and the old names are still all over the tree.** The directory is `next/`, the URL alias `/next` still works, and the test suites are named `test-next-*.js` — none of that means "preview" any more. When you read "`/next`" below, read it as *the shell in `src/public/next/`*, which is what a user gets at `/`.

**This section originally existed because the route was undocumented anywhere in `docs/`, `CONTRIBUTING.md`, or `README.md` — discoverable only by reading the file tree.** That gap matters in this specific project: the v3.2.0 incident (see that release's CLAUDE.md entry) is a recorded case where an undocumented route contributed to how a destructive bug went unnoticed.

### Why a parallel shell instead of rewriting `app.js` in place

`app.js`/`index.html`/`styles.css` were held byte-identical for the whole build-out, so redesign work could never blank the interface users were actually running. That held until v3.6.0, which made a deliberate 26-line change to four `app.js` handler bodies (a refused destructive write was rendering underneath an opaque modal). `index.html` and `styles.css` remain byte-untouched, and the rule that nothing is added at **module scope** — the failure mode that blanks the app for every user — is unchanged.

The design source is a set of React components (hookless, stateless-beyond-props — see `src/public/next/app.js`'s own docblock), but the shell itself is vanilla JS ES modules with no build step, matching the rest of this app's "no framework" design decision (see [§ Design decisions](#design-decisions) below). The intent was explicitly to port the original frontend's proven interaction *patterns*, not the framework the design was handed off in.

### How it's served (rewritten at the v3.9.0 cutover)

Static assets under `src/public/next/**` (CSS, JS, SVGs) need no special route — the same `express.static()` mount that serves the old frontend's assets covers them, since `next/` is just a subdirectory of `src/public/`. Three things about the routing in `src/server.js` are load-bearing, and each was a live trap before it was closed:

- **`express.static(..., { index: false })`.** `express.static` defaults to `index: 'index.html'`, so `/` was answered **by the static mount** from `src/public/index.html` and never reached the catch-all at all. Flipping the catch-all alone would have left the old app at `/` with every cutover guard reporting success. Turning the directory index off is what lets `/` fall through — and it also puts `/` behind the DNS-rebinding `Host` guard for the first time (it previously answered `200` to a forged `Host`). Directory *redirects* are a separate option and stay on.
- **`app.get('*')` serves `src/public/next/index.html`.** The redesigned shell's asset references are all root-absolute and `/next/`-prefixed (pinned by `scripts/test-next-asset-paths.js`), so it loads the same `/next/app.js` whichever path served the HTML — `/`, `/next/` and a deep SPA path are interchangeable.
- **`/old` 302-redirects to `/` (v3.41.0)** — the old shell itself (`src/public/{app,markdown}.js`, `index.html`, `styles.css`) is deleted, so there is nothing left to serve there. `app.get(['/old', '/old/'], ...)` answers both forms with a single handler that redirects to `/`, a **third** path distinct from either `/old` or `/old/`, which is what makes a self-redirect loop inexpressible: v3.9.0's first attempt at a `/old/` route redirected to `/old`, and because Express's router is non-strict by default a `/old/` route also matches `/old`, so that handler redirected to itself in an endless loop — reproduced live at the time. It is 302, not 301: a permanently-cached redirect on a path with no recovery story is worse than a temporary one, which can simply stop being registered.

`/next` and `/next/` keep working as an alias for bookmarks and for every link written during the redesign; the route serves the same single file as `/`, not a copy.

### View registry, `navigate()`, and the mount-token contract

`src/public/next/app.js` is the shell — a hand-rolled router, not a library. Each of the (currently seven) views lives in its own file under `views/`, registering itself via `registerView(name, { onEnter, onExit })` at that file's own top level. `navigate(name)` switches the active view and enforces two hard rules from the design spec **before** any view's `onEnter` runs, so no individual view can opt out of them:

1. The wiki reader overlay must never survive a view change — closed unconditionally on every `navigate()` call.
2. Rail navigation always clears the reader and closes the chat composer's model/length picker.

`onEnter` receives a `mountToken`. Any async work started inside it (a `fetch`, an SSE stream) must capture that token as a plain local variable at the point it's still known-fresh, then pass it to `setSidebar`/`setMain`/`openReader` (which each independently refuse to touch the DOM for a stale token) or check it via `isCurrentMount(token)` before doing further work. `navigate()` bumps the token on **every** call, including re-entering the same view by name, specifically so a still-pending fetch from an abandoned mount can never paint its result over a newer one.

This was hardened over three internal audit rounds, and the history is worth keeping because it's a real "looked equivalent, wasn't" case: the first two views built with real async work (Chat, Domains) used the token from the start; Settings and Sync, added later, predated the primitive and used a hand-rolled `let mounted = false` module-level boolean instead. A third audit round found this was **not** actually equivalent — a boolean can only answer "is *some* mount of this view still current," not "is *this specific* mount still current," which is the entire distinction the token exists to make — and reproduced the failure live: mount A's abandoned Sync push/pull result surfaced under mount B. Both views were migrated to the same token discipline every other view already used; there is no longer a second mechanism anywhere in the shell.

### The cross-view write gate (`beginDomainWrite` / `isDomainWriteBusy` / `isAnyWriteBusy` / `getDomainWriteLabel` / `onWriteGateChange`)

Destructive operations (ingest, a batch-queue item, a Sync push/pull, a Shared Brain pull) need to be visible to views *other than the one that started them* — Sync, Domains, and Settings all need to disable their own Push/Pull/Delete/Update controls while a write against a domain is in flight, mirroring the backend's own write-registry (`src/brain/write-registry.js`), which already 409s those endpoints mid-write. This is exactly the pre-redesign shell's `window.__curatorIngestStart`/`__curatorIngestEnd` pattern (that shell — `src/public/app.js` et al. — was deleted in v3.41.0 when `/old` was retired), but rebuilt as a **shell primitive** rather than a global pair, specifically to structurally close a real bug in that pattern: the old `app.js`'s `_queueBusyDomain` comment documented that its "enter" call was keyed on `job.domain` while its "exit" call re-read whatever the `#ingest-domain` dropdown happened to hold at a *later* moment — often empty on a page-reload resume, since two un-awaited loads can race the dropdown being populated — decrementing the wrong domain's count and leaving the right one's buttons disabled forever.

`beginDomainWrite(domain, opLabel?)` closes over the domain at the call site and returns a **release function**, not a domain string for the caller to re-supply later — there is no second call site holding its own copy of the key to drift from the first. Calling the returned handle twice is a harmless no-op; losing it entirely just leaks that one write as permanently "busy" for its domain (loud — a button stays disabled — rather than silent). Counts are ref-counted per domain (so two writes on different domains never block each other, and two on the same domain both have to release before it reads as free), and the state lives in the shell module, not inside any one view, so it survives navigating away from and back to the view that started the write — the same "shell state, not view state" treatment as `mountToken` and the reader overlay. `onWriteGateChange(fn)` lets any mounted view subscribe to re-render its own controls on any begin/release, anywhere; a subscribing view must unsubscribe in its own teardown.

**The gate's "survives navigating away and back" guarantee needed a second, shell-level holder for exactly one write kind: a batch-ingest job.** `views/ingest.js`'s own `onEnter` teardown releases the handle it holds the moment the user leaves the Ingest view, even though a batch job it started keeps running server-side — the batch is SERVER-owned and reattachable (`GET /api/ingest-queue/active`, `/:jobId`, `/:jobId/stream`), so the server, not whichever view happens to be mounted, is the authority on whether it's still running. `app.js` closes that gap with its own always-on watcher (`reportPossibleActiveJob()`, called from `boot()` and from `views/ingest.js` after starting or resuming a batch): it polls `GET /api/ingest-queue/active` every 4 seconds *only* while a job is genuinely `running`, and holds an independent `beginDomainWrite` handle of its own for that domain — composing safely with whatever handle `views/ingest.js` holds while it happens to be mounted, since the gate is a plain per-domain refcount. The one thing it must get right is what counts as "busy": a `paused` or `pending` job holds no backend write-registry entry (`src/brain/ingest-queue.js` only calls `registerWrite()` inside the per-item ingest call itself), and a paused job is the *routine* case for a crash-recovered job (v3.3.0's "never auto-start spend" rule) and for the queue's own rate-limit circuit breaker — so the watcher's transition logic treats only `running` as busy, never "not yet terminal."

### The shared batch-ingest logic module and its (now-retired) drift tripwire

`src/public/next/shared/ingest-queue-logic.js` holds 13 pure helper functions (plus one shared regex constant) for the batch-ingest queue UI. Through v3.40.0 these were kept **byte-identical** to a copy in the pre-redesign shell's `src/public/app.js` — not a refactor-later shortcut, since the maintainer actively used that original frontend in production and found and fixed three real batch-queue defects there, and a fix landing only in `app.js` would otherwise have silently failed to reach the redesigned shell.

`scripts/test-next-ingest-logic-drift.js` was the guard: it extracted each function's **source text** from both files and string-compared it byte for byte, rather than evaluating behaviour, on the reasoning that a behavioral test can pass while two implementations diverge in a way that only matters for an input nobody happened to sample. **v3.41.0 deleted `src/public/app.js` (and the rest of the pre-redesign shell) along with this suite** — exactly the trigger its own header named in advance ("becomes meaningless when `app.js` is deleted"), so this is not a drift risk needing a new guard; `ingest-queue-logic.js` in `next/` is now the only copy of these helpers.

### The shared Markdown renderer

`src/public/next/shared/markdown.js` holds the redesigned shell's single `renderMarkdown()`. It renders **both** chat answers (`views/chat.js`) and wiki page bodies in the reader overlay (`views/domains.js`). Until v3.8.0 it lived inside `views/chat.js`, which is why the wiki reader shipped escaped Markdown *source* in a `<pre>` — the second surface could not reach it without importing another view's internals, and duplicating an escape-first security guard was the worse of the two available answers.

Unlike `shared/ingest-queue-logic.js` above, this was never a byte-identical copy of the pre-redesign shell's `src/public/markdown.js` (deleted in v3.41.0 along with the rest of that shell) and was never asserted to be: that one was a `window`-attaching IIFE loaded by a `<script>` tag, this one is an ES module. The two had also **deliberately diverged on the ReDoS bound below** while both existed — the reasoning that used to be recorded at the old file's regexes is preserved in this project's git history, not reproduced here.

The cardinal rule is the same one the deleted `src/public/markdown.js` carried since v3.0.10 — escape the whole string **first**, then insert only a fixed allow-list of tags by matching Markdown syntax in the already-escaped text; no input is ever interpolated into an attribute or a URL, and the renderer emits no `href`/`src` sink at all. That matters more here than it did in `views/chat.js`, because the lift **widened the input surface**: it now also sees wiki page bodies, which are LLM-authored, hand-editable in Obsidian, and delivered over Personal Sync and Shared Brain mirrors from other people's machines.

`scripts/test-next-markdown.js` (**OFFLINE**) is the guard. It was written and made green *before* the lift, against the renderer in its original home, and re-run unchanged after — which is what proves the move was behaviour-preserving rather than merely asserting it. Its §0 walks the whole `src/public/next` tree and fails if a second declaration named `renderMarkdown` reappears anywhere; that guard is deliberately **name-scoped, not algorithm-scoped**, and its own header says so — a copy pasted under a different name, a class method, or an aliased re-export all evade it. Its wikilink and citation passes carry measured `{1,512}` length bounds rather than `+`, pinned by §4b as a ReDoS bound.

### The shared SSE frame reader

`src/public/next/shared/sse.js` exports `readSseFrames(stream)` — an **async generator** yielding one parsed JSON payload per `data: ` line off a `fetch` response body. It is this frontend's single SSE frame reader; chat-turn streaming is its first adopter.

It exists for the same reason `shared/ingest-queue-logic.js` and `shared/markdown.js` do. The `reader.read()` loop it replaces was copy-pasted at **five** call sites (`views/ingest.js` ×2, `views/chat.js`'s `runCompile`, `views/domains.js`'s `streamSSE`, and the pre-redesign shell's `src/public/app.js`'s `submitIngest` — that shell was deleted in v3.41.0, leaving four), and chat streaming would have been a sixth. Two hand-maintained copies of a parsing loop is this project's named cause of the v3.2.0 CRITICAL; five copies of a network-framing loop is the same risk at a larger multiple.

**An async generator rather than an `onEvent` callback**, because the five real call sites split into two different termination disciplines and a generator serves both with no extra plumbing: ingest `break`s (or throws) on a terminal frame, while `runCompile` deliberately reads to the *actual end of the stream* and only decides afterwards — the "a later chunk can carry the REAL terminal frame after an earlier progress-shaped one" trap `views/shared.js`'s `runRevoke` documents at length. A `for await` loop supports both, and `reader.cancel()` runs in the generator's `finally` on every exit path (stream end, an early `break`, an uncaught throw).

It takes **no imports** and touches no `document`/`window`, so — like `shared/text.js` and `shared/format-usd.js` — it can be `import()`ed directly under plain Node and driven for real by `scripts/test-next-sse.js`, rather than falling back to source-text scanning the way `app.js` and `shared/listbox.js` must.

It deliberately does **not** call `fetch`, inspect `res.status`/`res.headers`, or fall back to `res.json()` for a non-SSE error response — every real caller does something structurally different with that case, so the decision stays at the call site. Its header carries an explicit NOT-ENFORCED list: no multi-line `data:` continuation, no `event:`/`id:`/`retry:` support, an unparseable `data:` payload silently skipped, and no trailing no-argument `decoder.decode()` flush. Each is safe **only** because every producer in this codebase writes `data: ${JSON.stringify(x)}\n\n`, whose payload can never contain a raw newline. See [chat-streaming.md](chat-streaming.md#36-reading-frames).

### Status: what's real, what's a stub

This shell **is** the user-facing app as of v3.9.0. The pieces below are at different levels of completeness and this should not be overstated in either direction:

- **Chat, Ingest, Settings, Sync** — real, wired to backend endpoints that (with one later exception, below) already existed; each view's own top comment names the exact routes it calls. **The exception is chat-turn streaming**, which added a content-negotiated SSE branch to `POST /api/chat/:domain` — additively, so the same route still answers with the same JSON object when a caller does not ask for a stream (see [chat-streaming.md](chat-streaming.md)). Ingest includes the full batch-ingest queue, not just the single-file path. Chat's composer model/length pickers, the reader-overlay content, and — newly — **Compile to Wiki** (streams `POST /api/compile/conversation`, rendered as an inline thread card the same way the pre-redesign shell's chat tab did since v3.0.14, before that shell was deleted in v3.41.0) are real, not placeholder.
- **Domains** (`views/domains.js`) — the Health panel described in its own top comment is real, and this release adds three more pieces. **Domain lifecycle** (create/rename/delete) is wired to the pre-existing `POST`/`PUT`/`DELETE /api/domains[/:domain]` routes — see [api-reference.md](api-reference.md) for the exact contract, including the display-name-only rename case where the slug does not change. **A wiki browse list** is the one place this release adds real server-side surface: `GET /api/wiki/:domain/list` (`src/brain/wiki-read.js` + `src/routes/wiki.js`, new) is a readdir-only inventory built on health.js's `listMd` rather than a fresh readdir — see [api-reference.md](api-reference.md) for the full contract and its deliberate title-from-slug trade-off. **The browse reader renders rich markdown**, through the same single renderer chat answers use (`shared/markdown.js` — see above). Until v3.8.0 it showed the page's escaped markdown SOURCE in a `<pre>` block instead, because the renderer lived inside `views/chat.js` and copying a security-sensitive escape-first renderer into a second file is exactly the "two hand-maintained copies of a guard" shape that produced the v3.2.0 CRITICAL; lifting it into a module both views import removed the dilemma rather than picking a side of it. Finally, the semantic-duplicate scan gained **per-pair Preview / Flip / Skip** actions alongside the pre-existing batch "merge all high-confidence pairs" bar, which was previously the only semantic-dupe action this shell offered — parity with the Health tab of the pre-redesign shell (deleted in v3.41.0).
- **Shared Brain** (`views/shared.js`) — the connected state and the enabled/disabled flag states are real, and the five-step setup wizard now exists too, in its own module (`views/shared-brain-wizard.js`): a port of the pre-redesign shell's `#sharedbrain-wizard` (both the admin "start a new brain" and contributor "join with an invite token" paths, including the GitHub PAT and Shared Brain admin-token steps — the highest-risk credential surface in this shell), restyled to the `/next` design system under the rule "port the FLOW verbatim, restyle the CHROME only." This release adds the admin-only GDPR Article 17 **revoke-a-contributor** flow and **admin-token generate/rotate** to the connected card — both ported from the pre-redesign shell (CLAUDE.md's v3.0.5 entry) and previously entirely absent from this shell. Its own header cross-references the specific pre-redesign-frontend bugs each behavioural rule exists to keep from regressing (that frontend was deleted in v3.41.0). It has no test coverage of its own yet — the offline suite that exercises this behaviour (`test-sharedbrain-hardening.js`) still asserts only against the deleted `app.js`'s implementation. One real gap remains, and it's about an *existing* connection rather than initial setup: `views/shared.js`'s own copy says changing which domains an already-connected brain contributes from needs the access token re-entered, which this shell doesn't handle outside the setup wizard yet.
- **First-run guidance** (`views/onboarding.js`, v3.8.0) — real, and deliberately **not** a port of the pre-redesign frontend's blocking 4-step modal (that frontend, and its modal, were deleted in v3.41.0). It is a non-blocking, dismissible panel: no scrim, no `role="dialog"`, no focus trap, and it never steals focus on the automatic path. The `next/` shell's `app.js`'s `boot()` calls `maybeShowOnboarding()` (not awaited, and wrapped in `try/catch`, because `boot()` returning is what sets the `window.__curatorBooted` sentinel the `<head>` guard treats as proof of a healthy load). Every step **points** at the surface that already owns the job — API key → first domain → first ingest, in that order — and embeds no input and `POST`s nothing; step 2 navigates to Domains rather than adding a second `POST /api/domains` call site, which `test-next-chat-compile.js` pins at exactly one for the whole tree. Dismissal is `localStorage` (`curator-next-onboarding-dismissed-v1`) and **fails safe by showing** — a storage throw re-shows the guidance rather than silently hiding first-run setup — which is the opposite direction from the AI-disclosure consent gate, on purpose. It is re-findable from Settings ("Show setup guide"). It is **not** a registered view: like `views/mcp-wizard.js` and `views/shared-brain-wizard.js`, it calls no `registerView()` and owns no rail slot.
- **Agent memory** (`views/memory.js`) — **a real, read-only view over the working-state store, since v3.17.0.** The store (`src/brain/working-state.js`) is written by agents through the MCP's `get_working_state` / `save_working_state` tools; the view reads it over `GET /api/memory` and `GET /api/memory/:project` (`src/routes/memory.js`, mounted in `src/server.js`) and renders the standing brief, the current handoff for a chosen scope and machine, and the journal tail. **Read-only is a design decision, not an unfinished write path:** a browser writer would make the app a *second* writer and break the single-writer property the whole sync-safety argument rests on, and it would stamp a human edit with the last agent's provenance. What is still not built is the rollup UI (Done/Decided/Blocked composed across scopes) that a pre-v3.17.0 version of this line described — nothing composes across scopes or projects. The rail's shape — your brain → your team's brain → your agents' brain — is now backed by something on all three. See [working-state.md](working-state.md), [api-reference.md](api-reference.md) and the store's own section below.

### The cutover happened in v3.9.0 — the retirement happened in v3.41.0

The swap happened in v3.9.0: the redesigned shell answered `/`, and the original frontend became the escape hatch at `/old`. The deletion followed much later — v3.41.0 removed `src/public/app.js`, `src/public/markdown.js`, `index.html` and `styles.css` outright, along with the tests that existed only to guard the two-shell period: `scripts/test-frontend-null-safety.js`, `test-chat-markdown.js`, `test-chat-compile-card.js`, `test-raw-source-ui.js`, `test-ingest-queue-frontend.js`, `test-next-ingest-logic-drift.js` and `test-cutover.js` (which guarded the routing itself by reading `src/server.js`'s source text, not by issuing an HTTP request). `/old` now 302-redirects to `/` instead of serving anything.

The boot-recovery panel in `src/public/next/index.html` (`"The Curator could not finish loading"`) no longer points at `/old` — v3.41.0 rewrote its "what to do" list to drop that step deliberately, because sending the user to `/old` would now just redirect them back to `/`, the very page that failed to load. The panel's own comment records the reasoning so a future editor doesn't reintroduce the loop.

The old frontend's blocking 4-step onboarding wizard — the one modal with no `role="dialog"`, no Escape, no backdrop close and no Skip on step 1 — no longer exists anywhere in the app; it was deleted along with the rest of `app.js`.

---

## Directory structure

```
the-curator/
├── src/
│   ├── server.js               Express entry point (port 3333 unless PORT is set — the desktop shell
│   │                           sets a dynamic one; auto-opens the browser unless CURATOR_NO_OPEN=1)
│   ├── routes/
│   │   ├── domains.js          GET/POST/PUT/DELETE /api/domains[/:domain]
│   │   ├── ingest.js           POST /api/ingest (single file)
│   │   ├── ingest-queue.js     /api/ingest-queue — batch ingest job (create/list/start/pause/cancel/delete) (v3.3.0+)
│   │   ├── chat.js             GET/POST/DELETE /api/chat/:domain[/:id]; POST streams SSE on `stream: true`
│   │   ├── wiki.js             GET /api/wiki/:domain, GET .../page (v3.2.0+), GET .../source + POST .../source/reveal (v3.5.0)
│   │   ├── health.js           GET/POST /api/health[/:domain][/fix|/fix-all|/dismiss|/undismiss|/dismissed]
│   │   ├── compile.js          POST /api/compile/conversation (v2.5.0)
│   │   ├── diagnostics.js      GET /api/diagnostics/quick, POST /api/diagnostics/live (System Check)
│   │   ├── write-status.js     GET /api/write-status — is it safe to quit? (v3.26.0; consumed by the
│   │   │                       desktop shell's before-quit handler, not by any repo-mode caller)
│   │   └── config.js           GET/POST /api/config (settings, API keys, updates)
│   ├── brain/
│   │   ├── paths.js            Where user data lives — repo vs (future) bundle install (v3.1.0)
│   │   ├── install-mode.js     What this copy may do to its OWN code — getInstallMode() + a frozen
│   │   │                       capability record. Imports isBundleInstall from paths.js; nothing
│   │   │                       imports it back. Routes fork on a CAPABILITY, never on the mode (v3.26.0)
│   │   ├── desktop-host.js     The hooks a DESKTOP SHELL may install into this process — pickFolder,
│   │   │                       relaunch. A plain module registry, which is a real channel only because
│   │   │                       the shell imports src/server.js into its OWN realm. Null hook ⇒ REFUSE,
│   │   │                       never fall back (v3.30.0+)
│   │   ├── restart.js          planRestart() — pure decision for POST /api/restart; forks on restartStyle
│   │   ├── llm.js              LLM abstraction (Gemini + Claude)
│   │   ├── files.js            Filesystem helpers (wiki + conversations)
│   │   ├── ingest.js           Ingest pipeline (single-pass + multi-phase)
│   │   ├── ingest-queue.js     Batch-ingest queue: disk-persisted, sequential worker, pause/cancel/resume (v3.3.0+)
│   │   ├── raw-store.js        Raw-source resolution/extraction — the `resolveRawSource` chokepoint (v3.5.0)
│   │   ├── wiki-read.js        Single-page read + backlinks (`getWikiPage`) for the reader panel (v3.2.0+)
│   │   ├── working-state.js    Portable working state — domains/<project>/state/ (v3.17.0). Never renders
│   │   │                       a prompt, never calls an LLM. Two callers: mcp/tools/working-state.js
│   │   │                       (read + write) and routes/memory.js (READ-ONLY — agents are the sole writer).
│   │   ├── chat.js             Chat pipeline (multi-turn, persistent)
│   │   ├── compile.js          Conversation → wiki pages (v2.5.0)
│   │   ├── health.js           Wiki health scanner + auto-fix logic
│   │   ├── health-ai.js        AI suggestions for broken links (v2.4.3+), orphans (v2.4.4+), semantic duplicates (v2.4.5+) — READ-ONLY
│   │   ├── health-dismissed.js Persistent skip-store for Health issues (v2.5.1+) — wiki/.health-dismissed.jsonl
│   │   └── config.js           Persistent config (API keys, domains path) — resolves through paths.js
│   └── public/
│       │                       (the pre-redesign shell — index.html, app.js, styles.css — was deleted
│       │                       in v3.41.0 along with its /old escape hatch; /old now 302-redirects to /)
│       └── next/                THE PRIMARY frontend since v3.9.0, and the ONLY frontend since v3.41.0 —
│           │                    serves / and the SPA catch-all (and still /next as an alias). See
│           │                    "The redesigned shell" section above.
│           ├── index.html      Shell HTML (served for /, /next, /next/ and every SPA path)
│           ├── app.js          Shell: view registry, navigate()/mount-token contract, cross-view write gate
│           ├── shell.css       Shared layout (rail, sidebar, main grid, reader overlay, tokens wiring)
│           ├── tokens/         Design-system CSS custom properties (color, space, type, motion, shape, fonts)
│           ├── shared/         Modules used by more than one view:
│           │                    ingest-queue-logic.js — 13 batch-ingest helpers, the only surviving copy
│           │                    since v3.41.0 deleted the pre-redesign shell's app.js and the
│           │                    byte-identity guard that pinned them to it (test-next-ingest-logic-drift.js)
│           │                    markdown.js — the ONE Markdown renderer of this shell, used by chat.js + domains.js
│           │                    (v3.8.0; guarded by scripts/test-next-markdown.js — see above)
│           └── views/          One file + one same-named CSS file per rail item (chat, domains, ingest,
│                                memory, settings, shared, sync — all real; memory is READ-ONLY over the
│                                working-state store, which agents write over MCP — see routes/memory.js).
│                                views/README.md documents the contract for adding a new one.
├── mcp/                        My Curator MCP — read+write surface to the wiki for Claude Desktop / any MCP client
│   ├── server.js               stdio entry point (spawned as child process by the MCP client)
│   ├── graph.js                Wiki parser: frontmatter, [[wikilinks]], backlinks, tag inventory (cached)
│   ├── util.js                 Slug + domain validators, resolveDomainArg shared helper
│   ├── storage/local.js        Filesystem adapter (resolveInsideBase chokepoint, audit-log writer)
│   └── tools/                  Tool modules (12 read + 8 write = 20 tools as of v3.17.0)
│       ├── index.js            Registration hub + response-size guard (400 KB)
│       ├── domains.js, index-tool.js, search.js, nodes.js, connected.js,
│       │   summary.js, cross.js, overview.js, tags.js, backlinks.js, raw-source.js
│       │                       Read tools (11): list_domains, get_index, search_wiki, get_node, get_connected_nodes,
│       │                       get_summary, search_cross_domain, get_graph_overview, get_tags, get_backlinks,
│       │                       get_raw_source (v3.5.0 — the original document behind a summary, text-extracted only)
│       ├── compile.js          Write tool (v2.5.2): compile_to_wiki — research → wiki pages
│       ├── health.js           Write tools (v2.5.2): scan_wiki_health, fix_wiki_issue, scan_semantic_duplicates
│       ├── dismissed.js        Write tools (v2.5.2): get_health_dismissed, dismiss_wiki_issue, undismiss_wiki_issue
│       └── working-state.js    v3.17.0: get_working_state (read) + save_working_state (write) — wraps
│                               src/brain/working-state.js. Reads/writes domains/<project>/state/, NOT wiki/.
├── domains/
│   └── <domain>/
│       ├── CLAUDE.md           Domain schema (system prompt for the LLM)
│       ├── raw/                Immutable uploaded source files (gitignored)
│       ├── .mcp-write-log.jsonl Per-domain MCP audit log (v2.5.2+, gitignored, machine-local)
│       ├── wiki/
│       │   ├── index.md        Content catalog
│       │   ├── log.md          Chronological ingest + compile log
│       │   ├── entities/       People, tools, companies, datasets
│       │   ├── concepts/       Ideas, techniques, frameworks
│       │   ├── summaries/      One page per ingested source or compiled conversation
│       │   ├── .health-dismissed.jsonl  Persistent Health-issue dismissals (v2.5.1+); git-tracked, syncs across machines
│       │   └── .raw-manifest.jsonl      Append-only record of ingested source filenames/size/sha256 (v3.5.0); git-tracked so a second machine can name a missing raw file even though raw/ itself never syncs
│       └── conversations/      Saved chat threads (JSON, gitignored)
├── <user-data dir>/.ingest-queue/   Batch-ingest job manifests + staged uploads (v3.3.0+) — deliberately OUTSIDE domains/, since that directory is Personal Sync's git work-tree; see src/brain/paths.js
├── docs/                       This documentation
│   ├── user-guide.md           End-to-end guide for non-technical users
│   ├── architecture.md         This file — system internals
│   └── sync.md                 Step-by-step guide to the GitHub sync feature
├── scripts/
│   ├── fix-wiki-duplicates.js  One-time deduplication: merges near-duplicate entity/concept files
│   ├── fix-wiki-structure.js   One-time migration: moves non-canonical folders → entities/
│   ├── bulk-reingest.js        Re-ingests all raw files in a domain to rebuild the wiki
│   ├── inject-summary-backlinks.js  Retroactively injects [[summaries/...]] backlinks into all entity pages
│   ├── repair-wiki.js         Comprehensive wiki repair (cross-folder dedup, link normalization, backlinks)
│   └── build-app.sh           Rebuild The Curator.app from the AppleScript template
├── desktop/                    macOS Electron shell — see "The macOS desktop shell" below
│   ├── package.json            SEPARATE manifest. private, no dependencies, Electron + electron-builder
│   │                           as its own devDependencies. The root manifest must gain nothing.
│   ├── main.js                 Electron main process. Imports src/server.js into THIS process.
│   ├── preload.js              Deliberately exposes nothing (the reason is written in the file)
│   ├── electron-builder.yml    Build config — asar: false, identity: null (ad-hoc signed by afterPack), publish: null
│   ├── build/                  entitlements.mac.plist (written, inert until signing exists)
│   └── lib/                    port.js · write-status.js · quit-decision.js · window-state.js
│                               — Electron-free and src/-free, so the suite can EXECUTE them
├── package.json
├── .env                        API key — developer fallback (never committed)
├── .curator-config.json        API keys + settings from UI (never committed)
└── .gitignore
```

`.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`, `.knowledge-git/`, and `domains/` are drawn here at the project root because that is where they resolve in a **repo install** — a git checkout, which is what the browser install and the AppleScript Dock launcher both are. In the packaged Mac app they resolve under `~/Library/Application Support/The Curator/` instead, because an installed bundle is read-only. They are user data, not code; the next section is the module that owns that resolution and the exact condition that moves them.

**One consequence is worth stating here rather than leaving to be discovered**, because it produced a real data loss: `getUserDataDir()` forks on install mode, but the sync **work tree** does not — it is always `getDomainsDir()`. So pointing the packaged app at a folder a repo install already syncs would, before v3.32.0, have produced two independent git histories over one set of files. `setup()` now adopts the sibling repository instead; see [sync.md](sync.md).

---

## Where user data lives (`src/brain/paths.js`)

Everything above the divider is code — `src/`, `mcp/`, `scripts/`, `package.json` — checked into the checkout the auto-updater operates on. Everything a user actually owns — API keys, the domains folder, GitHub sync credentials, Shared Brain tokens — is a different category, and as of v3.1.0 exactly one module decides where it lives: `src/brain/paths.js`.

**Why this exists now, with nothing yet consuming the interesting half.** An installed macOS `.app` bundle is code-signed and therefore read-only; writing anything inside it invalidates the signature and macOS refuses to launch it. Today The Curator only ships as a repo checkout (`git clone` + `npm install`, or the AppleScript-wrapper `.app` built by `scripts/build-app.sh`, which still runs the checkout — see below), so this has never mattered. It will matter the moment a real packaged bundle exists, so `paths.js` draws the line once, a full release ahead of any packaging work, specifically so the no-op mode — the only mode that exists today — can be proven before the interesting mode is ever exercised in production.

The module exports two roots:

- **`APP_ROOT`** — where the CODE is. `path.resolve(<paths.js's own directory>, '../..')`, i.e. exactly what every `src/brain/*` module used to compute for itself before this module existed. Read-only in a bundle. Used for `package.json`, `mcp/server.js`, `src/public/`, and as the auto-updater's checkout root.
- **`getUserDataDir()`** — where USER DATA goes. Always writable.

```
repo install    → getUserDataDir() === APP_ROOT       (byte-identical to every prior version; nothing moves, ever)
bundle install  → getUserDataDir() === ~/Library/Application Support/The Curator/
```

### The detection is a positive test for "bundle", never a test for "repo"

This is the load-bearing decision in the module, and the reasoning is worth carrying forward because it is not the design a first pass would reach for. The two ways detection can be wrong are not symmetric:

| Wrong guess | Consequence |
|---|---|
| Decides **bundle** for a real checkout | Catastrophic and silent. Every user-data path relocates at once. The user's wiki is still safe on disk in the old folder, but nothing in the running app points at it — they see onboarding, no API key, no domains. It presents as "the update deleted my second brain." |
| Decides **repo** for a real bundle | Loud and immediate. The first write fails on the read-only bundle with a clear OS error. No data lost or orphaned. |

Given that asymmetry, the default has to be "repo," and only an unambiguous positive signal may move data — an unrecognised layout must fall to the safe side, not the convenient one. Hence `isBundleInstall()` is the only function that inspects the filesystem; `isRepoInstall()` is simply `!isBundleInstall()`. The two accepted bundle signals are (a) `BUNDLE_MARKER_FILE` (`.curator-bundle`), a file only a future packager would write into a shipped tree — nothing in this repo creates it — and (b) the literal macOS bundle path shape, some path component ending in `.app` immediately followed by `Contents`.

**Two earlier designs were tried and rejected, for real reasons worth recording so they aren't tried a third time:**

1. `existsSync(APP_ROOT/.git)` alone. A checkout that loses `.git` — GitHub's "Download ZIP," a user deleting it to save space, a dotfile-dropping copy, an interrupted clone — would silently flip to bundle mode and relocate a *live* install. That's the catastrophic direction.
2. Adding data markers (`.curator-config.json`, `domains`) as additional evidence for "repo." This fixes (1) but breaks the forward case: `domains/*` is gitignored except a tracked `domains/.gitkeep`, so **every shipped tree — anything built by archiving the source, i.e. any bundle built the obvious way — contains a `domains/` directory.** Bundle mode became unreachable by construction, which means a packaged app built this way would have quietly tried to write inside its own read-only bundle. `test-paths.js` §1 pins this exact premise (a shipped tree has `domains/` but not `.git`) precisely so this trap can't be reintroduced without a red test.

Inverting the question to "is this positively a bundle?" removes both failure modes, and removes the dependency on which files happen to be tracked at any given moment.

**`scripts/build-app.sh` was deliberately left untouched.** Today's `.app` is an AppleScript wrapper that launches the checkout — the code stays in the repo, so that `.app` genuinely *is* a repo install and must keep resolving to `APP_ROOT`. Writing `BUNDLE_MARKER_FILE` from that script now would flip every existing user into bundle mode on their next update. The marker belongs to a future build that actually copies the code into a bundle's Resources.

**Why `~/Library/Application Support` and not `~/Documents`:** the three visible user folders (`~/Documents`, `~/Desktop`, `~/Downloads`) are TCC-protected on macOS — first access triggers a permission prompt attributed to the *accessing process*. The My Curator MCP server is spawned by Claude Desktop as a headless stdio child with no UI session; a TCC prompt attributed to Claude Desktop for a background child might never render, and the MCP would simply fail to read the wiki with no visible explanation. `~/Library/Application Support` is not TCC-protected and is the Apple-documented location for exactly this kind of data.

### Precedence: `getDomainsDir()` (`src/brain/config.js`)

Verified in source, in the order the code actually checks:

1. `__setDomainsDirOverride(dir)` — in-process test override, highest precedence.
2. `CURATOR_TEST_DOMAINS_DIR` env var — cross-process test override (needed because `__setDomainsDirOverride` can't reach a spawned child, e.g. `test-sharedbrain-routes.js`'s server-on-3334).
3. `setCliDomainsDir(dir)` — the `--domains-path` this *process* was launched with. **v3.17.0; production, not a test seam** — a deliberately separate mechanism from rung 1, called exactly once, only by `mcp/server.js`, before the storage adapter is built. It is `null` in the web app, which never imports the setter, so every app caller short-circuits past it and resolves byte-identically to before.
4. `.curator-config.json`'s `domainsPath`, if set (the UI's "change knowledge base location" writes here).
5. `DOMAINS_PATH` env var (developer fallback in `.env`).
6. The default: `getDefaultDomainsDir()` in `paths.js` — `<user-data dir>/domains`, which in a repo install is `<APP_ROOT>/domains`, identical to every version before v3.1.0.

Rungs 1–2 are test-only and always `null` in production; rung 3 is null in the app. So the web app's real behaviour is unchanged: config beats the env var, exactly as before this release.

**Rung 3 closes a live bug, and it is the bug this section previously described as already fixed.** MCP *reads* have honoured `--domains-path` since v3.1.0 — `mcp/storage/local.js` ranks it at rung 2 of its own resolver. MCP *writes* never did: they go through `writePage`/`domainPath`/`wikiPath` in `files.js`, which resolve **here**, and until v3.17.0 this function had no rung for the arg at all. One process therefore resolved two different trees. Measured before the fix: `compile_to_wiki` returned `ok: true` with a `summary_path`, wrote the page under whatever this function resolved on its own, wrote `.mcp-write-log.jsonl` under the CLI path (the audit log goes through the read adapter), and a follow-up `get_node` on the very path just returned reported **not found**. Three trees, one operation, and a success report over it. The new rung sits **exactly** where the read adapter already puts the same argument — below the test seams, above the stored setting — because reads and writes must agree, and the only correct answer was to copy the resolver that already ships rather than invent a ranking. Placing it below the stored setting instead would leave the two disagreeing whenever a user has both, which is the exact live case that produced the report.

⚠️ **Two descriptions of one fact had drifted, in this file, fifteen lines apart.** The "Update" paragraph below has claimed since v3.1.1 that the CLI arg outranks config "in both the app and the MCP" — while the numbered list directly above it, headed *"verified in source, in the order the code actually checks"*, listed no CLI rung at all, correctly. The list was right and the prose was wrong, and the prose was the half people read. The claim is true only as of v3.17.0; the paragraph is left standing below because its reasoning about the *config-vs-env* ordering is still correct and still load-bearing. `paths.js` only changed what rung 5 resolves *relative to* — from a hardcoded `path.join(PROJECT_ROOT, 'domains')` computed inline to `getUserDataDir()`'s output, which is `APP_ROOT` until a bundle exists.

The same file (`config.js`) resolves `.curator-config.json` itself via `getCuratorConfigFile()` — called **per read/write, not cached at module load**, so both test seams stay effective for any module that imports `config.js` before a test sets them.

### App ↔ MCP: one resolver, not two

Before v3.1.0, `mcp/storage/local.js` re-derived the config file's location independently — its own `path.resolve(<its own directory>, '../..')` plus a literal `.curator-config.json`. That happened to agree with `config.js`'s computation because both were doing the same "walk up from my own file" arithmetic, but they were two *separate* pieces of logic that merely produced the same answer by construction. Nothing forced them to keep agreeing.

As of v3.1.0, `mcp/storage/local.js` imports `getCuratorConfigFile()` and `getDefaultDomainsDir()` directly from `src/brain/paths.js` — the exact functions `config.js` calls. There is now one place that decides "where is `.curator-config.json`," used by both the web app and the MCP child process Claude Desktop spawns. This matters because a silent divergence here is a *silent* failure mode with no error to surface: if the MCP resolved a different absolute path than the UI, Claude Desktop would read and write a wiki the user never sees in the browser — no crash, no warning, just two different "second brains" that happen to share a name. Routing both through one module removes that possibility by construction rather than by convention.

**Update:** for one release after v3.1.0 landed, one divergence remained — `config.js`'s `getDomainsDir()` ranked `.curator-config.json`'s `domainsPath` **above** the `DOMAINS_PATH` env var, while `mcp/storage/local.js`'s own `resolveDomainsPath()` ranked `DOMAINS_PATH` **above** config. It was flagged (not fixed) at the time: both files' header comments cross-referenced it explicitly so it couldn't be "fixed" by accident while touching either one, and CLAUDE.md's v3.1.0 entry called the split out as pre-existing and increasingly urgent. Investigating the git history turned up no functional reason for the MCP's ordering — `config.js`'s config-first precedence has been the app's rule since `getDomainsDir()` was first written (April 2026); `mcp/storage/local.js` was written later, independently, and simply never got reconciled with it. The two resolvers agree end-to-end on **`--domains-path` CLI arg → `.curator-config.json`'s `domainsPath` → `DOMAINS_PATH` env var → default** — the config-vs-env half from v3.1.1, and the CLI-arg half only from **v3.17.0**, when `setCliDomainsDir()` gave `getDomainsDir()` a rung for it (see the ⚠️ note above: this paragraph asserted the CLI half a release-and-a-half before it was true). Config outranks the env var in both places because `.curator-config.json`'s `domainsPath` is what the Settings UI's "change knowledge base location" panel actually writes — a user's explicit, current choice — while `DOMAINS_PATH` is a `.env` fallback documented for developers and non-macOS users who haven't touched Settings. A user who somehow has both set now gets the same folder from Claude Desktop as they see in their own browser. The CLI arg still sits above both — it's supplied explicitly by the generated Claude Desktop config, so it represents even more specific intent than either. Blast radius of the old bug was narrow in practice (the generated config always passes `--domains-path` explicitly, so only a hand-edited config with that flag removed, plus both `DOMAINS_PATH` and a *different* `domainsPath` set, could have hit it) but the fix removes a real, if rare, "the MCP reads a different wiki than the app shows" failure mode. See the header comment at the top of `mcp/storage/local.js` for the full reasoning.

### Named user-data locations and the credential-file list

`paths.js` exports one accessor per user-data file — `getCuratorConfigFile()`, `getSyncConfigFile()`, `getSyncGitDir()`, `getSharedBrainConfigFile()`, `getDefaultDomainsDir()` — each a thin `userDataPath(...)` join, each previously a `path.join(PROJECT_ROOT, <name>)` computed independently inside `config.js`, `sync.js`, and `sharedbrain-config.js`. In a repo install every one of these resolves to the exact same absolute string as before.

`getCredentialFiles()` returns the five files that must be owner-only (0600) as `{rel, abs}` pairs — `.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`, `.env` (anchored to `APP_ROOT`, since it's a developer file that lives with the source, not user data), and `.knowledge-git/config` (git embeds the sync PAT in the remote URL there). This single list now backs **both** the startup `chmod` sweep in `src/server.js` and the System Check credential-permission probe in `src/brain/diagnostics.js` — previously two independently-maintained lists that had to be kept in sync by hand.

### The migration seam (not yet wired to anything)

`getUserDataDirState()` returns one of `'ready' | 'empty' | 'missing' | 'blocked'` rather than a boolean, because "does the folder exist" isn't the question a future bundle install needs answered. A fresh bundle install finds an *empty* `~/Library/Application Support/The Curator` while the user's real wiki still sits in their old checkout — a bundle has no way to infer where that checkout is. `'empty'` (the directory exists but holds neither a config file nor a `domains/` folder) is the intended trigger for a future one-time "import your existing wiki" prompt, to be shown *before* onboarding rather than letting the user believe their second brain is gone. `'blocked'` distinguishes a genuinely broken path (a regular file where a directory should be, a broken symlink, an unreadable directory, a failed `mkdir`) from `'missing'`, because every subsequent write would fail and the caller needs to know that rather than proceed as if empty. **Nothing in v3.1.0 calls this yet** — it ships now, unwired, so the seam is settled before the packaging work that will need it.

### Test seams — for the USER-DATA paths above, not for the install mode

Two independent overrides, both checked before any real detection logic runs, both `null`/unset in production. They belong to `paths.js` / `config.js`; **there is no test seam of any kind for the install mode** — see the Install modes section below for how a suite reaches the bundle arm.

| Seam | Scope | Crosses process boundaries? |
|---|---|---|
| `__setDomainsDirOverride(dir)` (`config.js`) | `domains/` only | No — in-process only |
| `CURATOR_TEST_DOMAINS_DIR` (env) | `domains/` only | Yes |
| `__setUserDataDirOverride(dir)` (`paths.js`) | All of it: config, sync, Shared Brain, `.knowledge-git/`, and `domains/` (unless something higher in `getDomainsDir()`'s own chain overrides it — see the CONTRIBUTING.md guidance) | No — in-process only |
| `CURATOR_TEST_USER_DATA_DIR` (env) | Same as above | Yes |

See [CONTRIBUTING.md § Test seams](../CONTRIBUTING.md#test-seams-domains-vs-user-data) for which one to reach for and why the distinction is a real safety boundary, not a style choice.

> **This section moved back up in v3.27.0's doc sweep.** v3.26.0 inserted the `## Install modes` heading between it and the `paths.js` section it belongs to, leaving it rendering as a subsection of Install modes — where it read as though these seams could switch the mode. They cannot.

---

## Install modes (`src/brain/install-mode.js`)

`paths.js` answers **where does user data live**. `install-mode.js` answers a different question — **what may this copy of The Curator do to its own code** — and the two are deliberately separate modules.

> **There is a bundle now, and this checkout is still not it.** `desktop/` exists, and an arm64 `.app` has been built and run from `/Applications` once (2026-08-31, one machine) — so the `bundle` arms are no longer unreachable *in principle*. They remain unreachable **here**: a git checkout is `repo` mode, and `scripts/test-install-mode.js` opens with a control asserting exactly that, so every fork below takes the unchanged arm when you run the suite. What is still true is that **no bundle arm has been proven end to end in a signed, notarized build** — the MCP launcher path in particular has never run. See [The macOS desktop shell](#the-macos-desktop-shell-desktop) below for what the shell is, and [desktop-app-decisions.md](desktop-app-decisions.md) for why each choice was made.

The dependency runs one way only: `install-mode.js` imports `isBundleInstall` from `paths.js`, and `getInstallMode()` is literally `isBundleInstall() ? 'bundle' : 'repo'`. `paths.js` knows nothing about `install-mode.js`.

### Why a capability, not an install form

The auto-updater does not actually want to know whether it is running from a checkout. It wants to know whether it can run `git reset --hard` against its own source. Those coincide today (every install is a repo install and every repo install has a `.git`) and will not coincide forever: a Homebrew cask is a **git-less non-bundle**, and so is a `.pkg` that lands in a read-only prefix. Branching on the install *form* puts both of those on the repo arm, which then runs `git fetch` against a directory with no `.git` and fails with git's own text instead of a refusal that says why.

There is a sharper reason too. `isRepoInstall()` is literally `!isBundleInstall()`, so branching on it at several call sites means branching on a negation-of-a-negation in several places — and the day a third mode exists, every one of those sites silently inherits the repo arm, the arm that runs destructive commands. A named capability makes that a decision someone has to write into one table.

| Capability | Question it answers | `repo` | `bundle` |
|---|---|---|---|
| `canSelfUpdateViaGit` | Can I run git against my own source tree? | ✅ | ❌ |
| `canRunNpmInstall` | Can I write into my own `node_modules`? | ✅ | ❌ |
| `canRebuildAppleScriptApp` | Can I re-run `scripts/build-app.sh`? (it ends in an ad-hoc `codesign --force --deep --sign -`, which would destroy a Developer ID signature) | ✅ | ❌ |
| `canWriteBesideCode` | Can I drop a file next to my code and expect it to persist? | ✅ | ❌ |
| `mcpLaunchStyle` | How Claude Desktop should launch the MCP child | `node-script` | `launcher-script` |
| `restartStyle` | What "restart" means here | `respawn-node` | `app-relaunch` |
| `folderPickerStyle` | How `POST /api/config/pick-folder` asks the user for a directory | `osascript` | `native-dialog` |

**Stated honestly:** today all four booleans are perfectly correlated with `mode === 'repo'`. They are not four independent measurements — they are four distinct *questions* that happen to share an answer in the only two modes that exist. The value is the naming and the single table. `scripts/test-install-mode.js` enforces the half that is not aspirational: **no route may branch on the mode**, only on a capability.

`mcpLaunchStyle` and `restartStyle` shipped with **no branch behind them**, as declared-only fields — the same posture `getUserDataDirState()` took in v3.1.0. Both now have one. Two keys remain deliberately declared-only, and the reason is that a check would be *unreachable*, not that one was forgotten:

- **`canRebuildAppleScriptApp`** is subsumed. `scripts/build-app.sh` is invoked at exactly one place — inside `updateHandler`, below its `canSelfUpdateViaGit` early return — so a build that cannot reach the updater cannot reach the rebuild, and a second check there would be dead code. It stays as a named *fact* for the day something else wants to run that script.
- **`canWriteBesideCode`** is subsumed and deliberately so. `src/brain/mcp-launcher.js` writes its shim into the user-data directory precisely so it never writes beside the code. Branching on the flag would invite the opposite reading — that writing beside the code is a supported mode when the flag is true. It states an invariant; it is not a switch.

### The asymmetry is inherited verbatim

`getInstallMode()` is `isBundleInstall() ? 'bundle' : 'repo'`, so **anything unrecognised is `repo`** — which means an unrecognised layout gets the *permissive* arm. That is correct here for the same reason it is correct in `paths.js`: a checkout wrongly refused an update is an annoyance the user routes around with `git pull`, while a bundle wrongly permitted one fails on the first write with an OS error naming the read-only path. The catastrophic-and-silent direction is the other one.

Capability records are **exhaustive by construction**: `defineCapabilities()` throws at module load if a record is missing a key or carries an unknown one. A missing key would read as `undefined`, which is falsy, which would route a repo install onto the refusing arm — "your app can no longer update itself", with no error anywhere. The throw is deterministic (it reads a literal in the same file, no I/O), so it is a red test on the first `npm test`, never a field surprise.

### What forks on it today

Five capabilities are read across six files. **The list below is not maintained by hand:** `scripts/test-install-mode.js` §4 enumerates every route file, every `src/brain/*.js` file and `src/server.js` **from disk**, treats any file that reads `getCapabilities()` as a fork site, and fails if a discovered site is not mapped to an owning suite that exists on disk, is registered in `run-tests.js`, and names every capability key that fork reads. A scan that cannot see a whole directory reports "all clear" over it forever — which is what happened before the scan was widened past `src/routes/`.

| Capability | Read by |
|---|---|
| `canSelfUpdateViaGit` | `src/routes/config.js` (`update`, `update-check`), `src/brain/diagnostics.js` (skips the git row) |
| `canRunNpmInstall` | `src/brain/diagnostics.js` (same row) |
| `mcpLaunchStyle` | `src/routes/mcp.js`, `src/brain/mcp-launcher.js` |
| `restartStyle` | `src/brain/restart.js` (`POST /api/restart`) |
| `folderPickerStyle` | `src/routes/config.js` (`pick-folder`) |

The two update routes are the original fork and remain the clearest illustration:

- **`GET /api/config/update-check`** — the bundle arm returns 501 with `updateAvailable: false`. A build that cannot self-update must not report an update as available; the button behind that verdict cannot work.
- **`POST /api/config/update`** — the bundle arm returns 501 and runs **zero** subprocesses. Every step of the repo arm (`git fetch`, `git reset --hard`, `npm install`, `bash scripts/build-app.sh`) is impossible or actively destructive in a signed bundle.

Three later forks differ in shape, and the difference is worth noting: a capability arm is not always a refusal. `planRestart()` in `src/brain/restart.js` treats the bundle arm as a **success** — restarting is a legitimate action there — and refuses only when `restartStyle` says `app-relaunch` and no shell has registered a `relaunch` hook, which is a state in which the process genuinely cannot restart the application. `pickFolderHandler` in `src/routes/config.js` keeps **one** closure holding every post-pick rule (existence check, concurrency re-check, mutation, response shape) shared by both arms, so the bundle arm cannot acquire a different set of rules by being written separately. Both refuse rather than falling back — see [the desktop shell](#the-macos-desktop-shell-desktop) for why a silent fallback is worse than a 501.

In both update routes, the capability check is an **early return above the pre-fork body**, which is otherwise unchanged — `git diff -w` on the forking commit shows five deleted lines, all of them route-registration wrappers, and zero lines of either body. The bodies were additionally sha256-compared before and after.

Both handlers are exported as `updateCheckHandler(req, res, deps)` / `updateHandler(req, res, deps)`. `deps` is a **test-only seam, null in production** — the same shape as `compile.js`'s `opts.generateText` and `ingestMultiPhase`'s trailing `llm`. Inside each handler, function-scoped `const execAsync` / `const fetch` shadow the module binding and the global, so every call site in the moved body is byte-identical while an offline suite can still drive `POST /update` without running `git reset --hard` against the developer's own checkout.

**`scripts/build-app.sh` is still untouched.** Today's `.app` is an AppleScript wrapper that launches the checkout, so it genuinely *is* a repo install. Writing `BUNDLE_MARKER_FILE` from it would flip every existing user into bundle mode on their next update.

### Observing the mode

- `GET /api/version` returns `installMode`, `installModeLabel` and the full `capabilities` record alongside the existing `version` / `onDiskVersion` / `restartRequired` (purely additive).
- System Check gains an `install-mode` row (always `info` — neither mode is an error) and a `git` row.

### Forcing bundle mode (there is no override)

Because there is no test seam, the only way into the bundle arm is to satisfy `paths.js`'s real detection: drop the `BUNDLE_MARKER_FILE` (`.curator-bundle`) at `APP_ROOT`, or run from a path carrying an `<x>.app/Contents/` component. `scripts/test-install-mode.js` takes the second route — it materialises a fake `*.app/Contents`-shaped tree, copies `paths.js` and `install-mode.js` into it, and imports that copy **in a child process**, because the mode is decided by where the module is on disk.

### `GET /api/write-status` — built a release ahead of its only consumer

`hasActiveWrites()` had existed since v3.0.1-beta.8 and was reachable only as an internal route guard: a route could be *refused* because of it, but nothing could *ask* it. `GET /api/write-status` (v3.26.0) exposes it as `{ok, safeToQuit, activeWrites, updateInProgress, operations[], operationsTotal}` behind an explicit allow-list.

It is a plain `GET`, **deliberately not behind `guardConcurrent`** — a 409 there would fire precisely when something is asking whether a write is in progress — and it registers no write of its own, which would make it report itself. On a registry throw it answers `200` with `safeToQuit: null` rather than a 500, because a quit handler that cannot get an answer must be *told* so, not handed an exception it will read as "busy".

**Nothing in repo mode consumes it** — a browser install has no quit to intercept. Its callers now exist and there are two: `desktop/main.js`'s `before-quit` handler, via `desktop/lib/write-status.js` and `desktop/lib/quit-decision.js`; and, since v3.33.0, the update engine, which re-checks `hasActiveWrites()` at the swap so an ingest begun *during* a download parks the update at `staged` rather than being truncated by a relaunch authorised before it started. See [The macOS desktop shell](#the-macos-desktop-shell-desktop) for why `safeToQuit: null` is kept as its own case there rather than collapsed into safe or busy. Full response shape: [api-reference.md](api-reference.md#get-apiwrite-status).

---

## The macOS desktop shell (`desktop/`)

The Install modes section above describes a seam built a release ahead of its consumer. `desktop/` is that consumer: an Electron shell that wraps the *same* `src/server.js` a browser install runs, in one window, on one Mac.

It is a **shell, not a second product**. The decisions that shaped it — and what was traded away for each — are the decision record in [desktop-app-decisions.md](desktop-app-decisions.md). This section is the other half: what the thing *is*, how it relates to `src/`, and what happens when you build it.

> **What has actually been run, stated before anything else.** `desktop/` was installed, built and launched for the first time on 2026-08-31, on **one machine** — macOS 15, arm64, Node 22. The arm64 `.app` runs from `/Applications`. **The x64 DMG was produced but has never been executed** (no Intel Mac was available), and **the bundle-mode MCP launcher path has never run end to end**. Nothing in `desktop/` is exercised by `npm test`, which cannot install a ~130 MB toolchain — `scripts/test-desktop-packaging.js` executes the pure `lib/` modules and *source-scans* `main.js`, and says so in its own NOT ENFORCED block. Treat a green suite as proof about the **config**, never about the app.

### One codebase, two shells

`src/` and `mcp/` are shared verbatim. There is no second copy of the server, no fork of a route, and no desktop-only business logic. The window is a `BrowserWindow` pointed at the app's own frontend over loopback, so it reaches the server through exactly the HTTP surface a browser tab does — and therefore through exactly the same guards.

```mermaid
flowchart TB
    subgraph shared["Shared — one copy, serving both shells"]
        SRV["src/server.js<br/>Express + every route"]
        BRAIN["src/brain/**<br/>ingest · chat · health · sync"]
        MCPSRV["mcp/**<br/>stdio MCP server"]
    end

    BROWSER["Browser install<br/>node src/server.js"] --> SRV
    SHELL["desktop/main.js<br/>Electron main process"] -->|"await import()"| SRV
    SHELL --> WIN["BrowserWindow"]
    WIN -->|"HTTP on 127.0.0.1 — the same<br/>Origin and Host guards a tab passes"| SRV

    SRV --> BRAIN
    BRAIN --> CAPS["src/brain/install-mode.js"]
    CAPS -->|"repo"| REPOARM["git self-update · osascript picker<br/>respawn node · node-script MCP"]
    CAPS -->|"bundle"| BUNDARM["501 refusal · native dialog<br/>app relaunch · launcher-script MCP"]
```

What differs between the two shells is not code paths hand-written per shell — it is which arm of the **capability record** the shared code takes. A packaged `.app` satisfies `paths.js`'s bundle detection (its app root is `…/The Curator.app/Contents/Resources/app`, which carries a `.app` path component immediately followed by `Contents`), so it resolves to `bundle`; a checkout resolves to `repo`. Same routes, same modules, different capabilities.

### Why `desktop/` has its own `package.json`

This is measurable rather than stylistic, and it is the reason the shell is a subdirectory with its own manifest instead of two entries in the root one.

The root manifest has **8 runtime dependencies and no `devDependencies` key at all** — verified by reading `package.json`, not by grep. That matters because step 4 of the in-app updater is:

```js
// src/routes/config.js — POST /api/config/update
await execAsync('npm install --silent --no-audit --no-fund', execOpts({ timeout: 120000 }));
```

That runs **on every user's machine, on every update**. Anything in the root manifest — a `devDependency` included — is downloaded by every browser-install user. Electron and `electron-builder` are hundreds of megabytes, for a feature browser users do not have and cannot run. This project has already refused a browser driver on the same ground more than once; the standing rule is that `git diff package.json package-lock.json` stays **0 lines** for desktop and harness work.

So `desktop/package.json` is `private: true`, declares **no `dependencies`** (see the build section — that emptiness has a consequence), and carries `electron` and `electron-builder` as its own pinned devDependencies. `scripts/test-desktop-packaging.js` §2 asserts the root manifest gained nothing, by enumerating dependency names out of **both** files rather than comparing against a hardcoded list.

`desktop/package.json`'s `version` is a permanent `0.0.0` **sentinel**, not a number anyone maintains — two manifests that must agree by hand is how `v3.30.0` came to ship a bundle reporting `0.0.0` inside assets named `3.30.0`. The real version is injected at build time from the root manifest (`npm run dist`) or from the git tag (CI), and `lib/after-pack.mjs` re-reads the packed `Info.plist` off disk and throws on disagreement.

### The server is *imported*, not spawned — and that is load-bearing

`desktop/main.js` does not fork a child process. It does:

```js
await import(pathToFileURL(SERVER_ENTRY).href);
```

`src/server.js` is a script with side effects — it calls `startListen()` at module scope (`src/server.js:504`), so **importing it is starting it**. There is one Node process, one realm, and no second runtime.

Two consequences follow, and neither is obvious from the outside.

**First, ordering is a correctness property, not a style choice.** `src/server.js` reads `process.env.PORT` (line 102) and `process.env.CURATOR_NO_OPEN` (line 443) at module scope. Anything the shell needs to tell the server has to be in `process.env` *before* the import, which is why those writes sit above `await import(...)` in `boot()` and not next to the window code. Move them down and the server binds 3333 and opens the user's browser beside the app window.

**Second, a module registry becomes a real channel.** Node's ESM loader keys modules by resolved URL, so a shell that imports `src/brain/desktop-host.js` gets the very object the routes import. That is what makes `desktop-host.js` possible at all — no IPC, no port, no re-serialisation of a decision already made.

```mermaid
sequenceDiagram
    participant M as desktop/main.js
    participant S as src/server.js
    participant H as src/brain/desktop-host.js
    participant R as a route handler

    M->>M: requestSingleInstanceLock()
    M->>M: pickFreePort() — bind 127.0.0.1:0, read, close
    M->>M: set process.env.PORT and CURATOR_NO_OPEN
    Note over M,S: these writes MUST precede the import — server.js reads both at module scope
    M->>S: await import(SERVER_ENTRY)
    S->>S: startListen() runs at module scope — importing IS starting
    M->>H: registerDesktopHost({ pickFolder, relaunch })
    Note over H: same Node realm, so the registry is a real channel
    M->>M: new BrowserWindow, loadURL(http://127.0.0.1:PORT)
    R->>H: getDesktopHook('pickFolder')
    H-->>R: the shell's dialog function, or null
    Note over R: null means REFUSE with a 501 — never fall back
```

The rule `desktop-host.js` is built on, and the one that must not be traded away: **if a capability says `native-dialog` or `app-relaunch` and nothing is registered, the consumer refuses.** It does not quietly run `osascript`, and it does not quietly `spawn(process.execPath)`. Both fallbacks are the exact behaviour the bundle arm exists to prevent — an `osascript` a hardened runtime may kill outright, and a spawn of the app binary that opens a second *window* instead of a server. A refusal names what is missing and is recoverable; a wrong fallback is a route claiming one contract and honouring another.

The registry also fails in the safe direction if the shape ever changes. Should a future packaging move the server into a `utilityProcess` or a real child, the shell's registration simply never reaches this realm, every hook reads `null`, and every consumer refuses with a named reason.

### The port is dynamic, and the guards move with it

The browser install binds a fixed 3333. The shell asks the OS for an ephemeral loopback port instead (`lib/port.js` binds `127.0.0.1:0`, reads the assigned port, closes) and sets `PORT` before the import.

That works with no change in `src/` because `src/server.js` builds `ALLOWED_ORIGINS` and `ALLOWED_HOSTS` from the same `PORT` value it binds (lines 145–162). Overriding `PORT` moves the CSRF and DNS-rebinding guards with it; there is no second place to update.

**Why not 3333:** the maintainer runs a repo checkout on 3333 permanently. The loser of that race today retries for ~6 s and exits 1, with the reason written only to a log — a desktop app whose window never appears and explains itself nowhere.

**What that costs, because it is a reduction and not a neutral change:** port collision was accidentally doing a second job — stopping two copies of The Curator writing into one `domains/` folder. `requestSingleInstanceLock()` in `main.js` now guards that explicitly, and it is taken *before* the window and before the server import so the losing instance never binds a port, never touches the wiki and never paints. But that lock covers two copies of the **desktop app**; it does not cover "desktop app + `npm start` checkout", which are different executables holding different locks and will now coexist over one `domains/` folder.

**Why the window must load `http://127.0.0.1:<port>` and never `file://` or a custom scheme:** a page loaded from `file://` or `curator://` sends `Origin: null`. The server's cross-origin guard tests `if (origin && !ALLOWED_ORIGINS.has(origin))`, and the **string** `"null"` is truthy — so `Origin: null` is not *absent*, it is *present and not allow-listed*, and every `POST`/`PUT`/`DELETE`/`PATCH` is refused with 403. Ingest, chat, compile, sync and settings would all break, presenting as "the UI loads and nothing works" rather than as a header problem.

### What the shell adds that a browser tab has no equivalent for

| Concern | Where it lives | Note |
|---|---|---|
| Quit while a paid write is in flight | `lib/write-status.js` + `lib/quit-decision.js`, wired to `before-quit` | Asks `GET /api/write-status`. This is the caller that endpoint was built for. |
| Remembered window size and position | `lib/window-state.js` → `<userData>/window-state.json` | A saved **position** is adopted only if the rectangle still overlaps a real display. Full screen is deliberately not persisted; `maximized` is. |
| Native folder chooser | `pickFolder` hook → `folderPickerStyle` | Replaces the `osascript` shell-out that a hardened runtime can kill. |
| Restart | `relaunch` hook → `restartStyle` | Killing the node process alone would leave a windowless app. |
| A menu bar icon over agent memory | `lib/tray-model.js`, `lib/tray-menu.js`, `lib/tray-icon.js`, `lib/state-watch.js`, `lib/background-mode.js`, over `src/brain/tray-summary.js` | **Off by default** (`backgroundMode: 'window'`). See [§ The menu bar widget](#the-menu-bar-widget-desktoplibtray-js--srcbraintray-summaryjs). |
| Replacing the application itself | `prepareUpdate` / `installUpdate` hooks → `lib/update-plan.js`, `lib/update-release.js`, `lib/update-engine.js` | `electron-updater` is unusable while the app is ad-hoc signed — Squirrel.Mac validates against the *running* build's cdhash, so every real update fails. `installUpdate` takes an **opaque token, never a path**: its caller is a renderer, and a hook taking `{stagedPath, targetPath}` would be a replace-any-directory primitive reachable from a page. |

`lib/quit-decision.js` is the one worth reading. `GET /api/write-status` answers `safeToQuit: null` when the write registry throws, and that third state is kept as its own case rather than collapsed, because **both collapses are wrong**: treating `null` as safe truncates a paid, multi-minute ingest; treating it as busy makes the app permanently un-quittable, because a throwing registry does not heal — and the user then reaches for Force Quit, which truncates the write anyway *and* skips every other shutdown step. So `null` returns `ask`. There is deliberately no `block` action at all; what changes between cases is the sentence and which button is the default, and **both defaults point at the safe option**, because a dialog that defaults to the destructive button turns "⌘Q, Return" into data loss.

Every `lib/` module here imports nothing from Electron and nothing from `src/` (`quit-decision.js` and `write-status.js` import nothing at all), and the same rule holds for the three update modules added in v3.33.0. That is a shape decision, not an accident: it is what lets `scripts/test-desktop-packaging.js` **execute** them offline rather than grep them.

`preload.js` deliberately exposes nothing. The renderer is the app's own frontend over loopback and already has everything it needs; an IPC bridge would be a second way into the app's capabilities that bypasses the cross-origin guard, the Host guard, the write registry's 409s and every route-level validation, for no capability the HTTP API lacks. The window runs with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.

### The build

`npm run dist` in `desktop/` runs `electron-builder --mac --config electron-builder.yml`. It produces one `.app` and **two `.dmg`s — arm64 and x64 as separate artifacts, not a universal binary**, because a universal build doubles every user's download to carry the other half's chip.

#### The packaged layout must be flat

```
The Curator.app/Contents/Resources/app/
  package.json        ← desktop/package.json  (main: "main.js")
  main.js  preload.js  lib/
  src/**  mcp/**  LICENSE  LICENSES/**
  node_modules/**     ← placed by extraResources, not by the files glob
```

This is not cosmetic. **Two independent derivations have to land on the same directory**, and nothing forces them to agree except this layout:

- `desktop/main.js` probes for `src/server.js` beside itself: `existsSync(path.join(__dirname, 'src', 'server.js')) ? __dirname : path.resolve(__dirname, '..')` — one answer in a dev checkout (`desktop/` is one level down), another when packaged (flat).
- `src/brain/paths.js` computes `APP_ROOT = path.resolve(__dirname, '../..')` (line 194) with no knowledge of Electron at all.

In the flat layout both resolve to `Contents/Resources/app`. **Nest `src/` one level deeper and they disagree — and that presents as an empty wiki, not as an error**, because `paths.js` would be resolving user data relative to a root the shell never uses. The root manifest is also explicitly excluded from the copy (`'!package.json'`): overwriting `desktop/package.json` with it would produce an app whose entry point is `src/server.js` — a headless server with no window and no explanation.

#### Two things that will look like mistakes and are not

**`asar: false`.** The obvious move is to enable asar and add `asarUnpack: mcp/**`. That addresses one of three hazards and not the worst one. Inside an archive, `__dirname` for `src/brain/sync.js` is `…/Resources/app.asar/src/brain`, so `APP_ROOT` resolves to `…/Resources/app.asar` — **a file on the real filesystem**. `sync.js:125` passes `cwd: ROOT` to every Personal Sync git call (its own comment says the explicit `cwd` prevents `getcwd: Operation not permitted`), and `src/routes/config.js` does the same for the updater's git calls (`cwd: PROJECT_ROOT`, itself `APP_ROOT`, at lines 2326 and 2426 — `electron-builder.yml`'s comment cites `:2322` for this, which has since rotted onto a blank line). Electron patches `fs` inside its own process; it does **not** patch the kernel, and a child process gets its cwd from a real `chdir`. So those calls fail before git is even reached.

`asarUnpack` does not fix this. It moves the *bytes* to `app.asar.unpacked/`, but the module is still **resolved through the `app.asar` path**, so `__dirname` — and therefore `APP_ROOT`, and therefore the cwd handed to a child — is unchanged. Fixing it under asar means teaching `APP_ROOT` to rewrite `.asar` → `.asar.unpacked`, i.e. making the app's most depended-on path constant conditional on packaging. Two further hazards ride along: `appPath('mcp','server.js')` is written into Claude Desktop's config, and Claude Desktop is an external process with no asar support; and `src/brain/ingest.js:268` does a **dynamic ESM import** of `pdf-parse/lib/pdf-parse.js`, which Electron's CommonJS-oriented asar support does not cover. `asar: false` removes all three at once, for some startup milliseconds and a larger bundle — and the source is MIT in a public repository, so "readable inside the app" costs nothing that `git clone` does not already give away.

**`node_modules` is copied via `extraResources`, not by the `files` glob.** This one produced a build that **launched perfectly while being broken**, and it is the failure mode most worth a reader's attention.

The scaffold listed `node_modules/**/*` in the `files` filter. That line did nothing. electron-builder does not treat `node_modules` as ordinary files — it computes the **production dependency tree from the app manifest's `dependencies`** and copies that, ignoring the glob. `desktop/package.json` deliberately declares no `dependencies`, so the computed tree was empty, the build logged `no node modules returned while searching directories`, and shipped an app root with **no `node_modules` at all**.

The app started anyway, served, rendered a real wiki and accepted writes:

```mermaid
flowchart TD
    START["src/server.js inside the .app<br/>imports a bare specifier: 'dotenv'"] --> Q{"node_modules/dotenv<br/>present in the app root?"}
    Q -->|"yes — extraResources copied it there"| OK["resolves inside the bundle<br/>works from any location"]
    Q -->|"no — the shape that shipped"| WALK["Node resolves a bare specifier<br/>by walking UP the directory tree"]
    WALK --> W1["…/Contents/Resources/"]
    W1 --> W2["…/The Curator.app/"]
    W2 --> W3["desktop/dist/mac-arm64/"]
    W3 --> W4["the REPO ROOT's node_modules — found"]
    W4 --> FOOL["LAUNCHES PERFECTLY<br/>but only while it sits inside the checkout"]
    W3 -.->|"copy the same bundle to /Applications"| DIE["ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'"]
```

So **"I built it and it ran" is not evidence.** The only test that catches this class is launching a *copy* of the `.app` from a directory with no `node_modules` above it, and nothing automated does that today. The fix is an explicit `extraResources` entry placing `../node_modules` at `app/node_modules` (`to` is relative to `Contents/Resources`); `scripts/test-desktop-packaging.js` §11 refuses both the old shape and its absence.

The tree comes from the **repo root** rather than a second install under `desktop/`, because the runtime deps belong to the app rather than to the shell, and duplicating eight dependency ranges into a second manifest is how the two drift. That is safe here only because the root manifest has zero `devDependencies` — there is no dev tree to ship by accident. The suite asserts that property; if it ever stops being true, this line starts shipping a dev tree to users.

#### Signing, notarization and updates

The state here changed twice in one day, so read it as three separate facts rather than one:

- **Ad-hoc signed, deliberately, and that is not the same as unsigned.** `mac.identity: null` is set on purpose — without it, electron-builder auto-discovers any identity in the developer's own keychain and silently produces a locally-signed artifact that works on exactly one Mac. But `identity: null` makes electron-builder **skip signing entirely**, which leaves Electron's linker-signed stub declaring resources the bundle does not have: `Sealed Resources=none`, `codesign --verify --deep --strict` **failing**, and macOS showing *"The Curator is damaged and can't be opened"* — a Gatekeeper class with **no Open Anyway button at all**, whose only escape is a terminal `xattr` command. `desktop/lib/adhoc-sign.mjs`, run from the `afterPack` hook, therefore produces a real ad-hoc signature: `Sealed Resources version=2 rules=13 files=5563`, verify exit 0, and `syspolicy_check` down to **one** fatal finding (notarization) instead of two. **A valid signature and a working app are different claims and no static check separates them** — the first hardened attempt passed `--verify --deep --strict` and still died at dyld time on `Library not loaded: @rpath/Electron Framework`.
- **`hardenedRuntime: true`, an entitlements file, and four `NS*UsageDescription` strings are present and entirely inert**, because electron-builder skips signing and `adhoc-sign.mjs` omits `--options runtime`. `assertAdhocOnly` **refuses the build** if that flag ever appears, having measured exactly the dyld failure above. Hardened runtime must return when Developer ID signing lands, because notarization requires it — this is a temporary inversion recorded as one, not a setting.
- **No notarization.** Requires paid Apple Developer enrolment; there is no `afterSign` hook. A first launch still needs the Privacy & Security exception. **Which dialog macOS actually shows has never been observed** — it is inferred from the signature state.
- **Auto-update exists, and it is not `electron-updater`.** `electron-updater` is not installed and not wired; `publish: null`. That is not a gap to close later by configuration: `MacUpdater` drives Squirrel.Mac, which validates each download against the **running** app's designated requirement — and for an ad-hoc signature `codesign` derives that from the code-directory hash of that exact build, so every genuine update fails deterministically, inside Electron's own binary where no config reaches. The app instead downloads, verifies and swaps itself through `desktop/lib/update-{plan,release,engine}.js`, exposed as the `prepareUpdate` / `installUpdate` hooks. Full reasoning: [desktop-app-decisions.md § D16](desktop-app-decisions.md#d16--the-app-updates-itself-and-electron-updater-cannot-be-the-mechanism).
- **Version identity is enforced at pack time.** `npm run dist` reads the **root** manifest and injects `--config.extraMetadata.version`; the CI workflow injects the git tag instead. `desktop/package.json` stays at `0.0.0` as a permanent sentinel rather than a number anyone maintains. `desktop/lib/after-pack.mjs` then reads the packed `Info.plist` **back off disk** and throws on disagreement, so a wrong version cannot produce a `.dmg` at all — verified by building with an injected `9.9.9`, which is refused. This exists because `v3.30.0` shipped assets named `TheCurator-3.30.0-*` around a bundle reporting `0.0.0`.
- **No certificate, Apple ID, team ID or app-specific password may enter `desktop/`, the build config, the workflow or a comment — not even as an example value.** The repository is public. They are referenced by GitHub Actions secret name only, and `scripts/test-desktop-packaging.js` §9 scans for credential-shaped literals. `adhoc-sign.mjs` additionally **refuses to run** if any real signing credential is present in the environment, so a machine that *can* sign properly never gets an ad-hoc signature by accident.

The DMG workflow (`.github/workflows/desktop-dmg.yml`) is **tag-gated** — never `main`, never a pull request, and deliberately **no `workflow_dispatch`**. That last absence is the non-obvious one: `scripts/release.js`'s CI gate finds its run by branch and SHA, and a manual dispatch runs against a *branch*, so its run would carry `head_branch: main` and could collide on SHA with the very run the gate is waiting for. A tag push produces a run whose `head_branch` is the tag name, which every `--branch` query excludes.

### The menu bar widget (`desktop/lib/tray-*.js` + `src/brain/tray-summary.js`)

**Off by default.** `backgroundMode` in `.curator-config.json` is `window` unless the user changes it, and a `window` install creates no `Tray`, starts no watch and reads nothing. What follows describes what happens when someone turns it on.

> **Nothing in the redesigned menu has ever been rendered.** An earlier arrangement was driven through a real `Tray` and `Menu.buildFromTemplate` once, and the screenshot came back black; nothing since has been seen at all. The row model, the menu template, the submenus, the mode transitions and every drawn pixel are *executed* by `scripts/test-tray-shell.js`, `scripts/test-tray-paint.js`, `scripts/test-tray-pulse-strip.js`, `scripts/test-tray-resume-prompt.js`, `scripts/test-tray-summary.js` and `scripts/test-background-mode.js`. Unproven: that Electron draws a **submenu** on a tray menu, that `clipboard.writeText` lands from a menu handler while the menu is dismissing, that macOS tints the template glyph correctly, that `type: 'header'` and `sublabel` draw (they are macOS 14 and 14.4 affordances), and that `mouse-enter` fires. `desktop/main.js` and `desktop/README.md` carry the same statement.

#### One data call, one model, one template

```mermaid
flowchart LR
    W["fs.watch on domainsDir<br/>recursive"] -->|"path contains /state/<br/>no dot-prefixed segment"| DB["debounce 150 ms"]
    FB["fallback interval<br/>5 min"] --> RF
    DB --> RF["refreshTraySummary()"]
    CLICK["tray click"] --> RF
    RF -->|"plain function call,<br/>same Node realm"| TS["src/brain/tray-summary.js<br/>getTraySummary({limit: 5})"]
    TS --> LWS["listWorkingScopes()<br/>— the same function<br/>the app view and the MCP call"]
    RF --> SNAP[("traySnapshot<br/>in memory")]
    HOVER["mouse-enter"] --> REN
    SNAP --> REN["buildTrayModel()<br/>desktop/lib/tray-model.js"]
    REN --> TPL["buildTrayMenuTemplate()<br/>desktop/lib/tray-menu.js"]
    TPL --> SUB["per-row submenu<br/>Open · Copy prompt · Copy handoff · Reveal"]
    SUB -->|"Copy handoff"| GHM["getHandoffMarkdown()<br/>src/brain/tray-summary.js<br/>— the store's SANITISED read"]
    GHM --> RPM["composeHandoffMarkdown()<br/>desktop/lib/resume-prompt.js"]
    REN --> STR["renderPulseStrip()<br/>desktop/lib/pulse-strip.js"]
    STR -->|"colour RGBA PNG<br/>1x + 2x"| TPL
    REN --> DOT["renderRecencyDot()<br/>desktop/lib/menu-dots.js"]
    DOT -->|"colour RGBA PNG<br/>1x + 2x, one per row"| TPL
    REN --> GLY["trayIconPngs()<br/>desktop/lib/tray-icon.js"]
    TPL --> MENU["Menu.buildFromTemplate"]
```

**Hover renders from memory; a click re-reads the index.** There is no *menu will open* event on an Electron `Tray`, so the menu has to be kept current from outside. A click is a deliberate act, so that is where the one disk read belongs; `mouse-enter` costs no I/O because it only re-renders the snapshot already held.

**Ages are re-derived at the render clock, not copied out of the snapshot.** `effectiveAgeSeconds(at, fallback, nowMs)` re-runs the producer's own arithmetic against the model's `now`, so re-rendering one snapshot forty minutes later moves the ages, which is what makes the free `mouse-enter` re-render worth having. Precedence is deliberate and threefold: a parseable `writtenAt` wins, else the snapshot's own number is passed through **unchanged**, else `null` — **an unknown age stays unknown** rather than becoming 0. The `Math.max(0, …)` clamp is load-bearing: without it a handoff from a machine three seconds ahead reads *time unknown* instead of *just now*. It re-times the reading; it never changes **which clock** the reading came from, and `ageSource` still says which that was. The same function times the rows (`:614`), the headline (`:906`) and the standing brief (`:1005`), so the three cannot disagree about what *2 min ago* means.

> **The pulse strip is the one thing on the menu a hover does not re-time.** Its buckets are anchored to the `now` of the read that produced them, so a strip rendered from a held snapshot is a still frame of that moment. That is bounded by the same 5-minute fallback and by the fact that any real save re-reads the store; at a 6-hour bucket width it is not a distinction a reader can see. The absolute *"Updated HH:MM"* stamp is what makes an old frame visible as old.

**`getTraySummary()` is a projection, not a second inventory.** It calls `listWorkingScopes()`, the same function `GET /api/memory` and the MCP's `get_working_state` call, so the tray and the Agent memory view cannot disagree about what is on disk. It is its own module rather than part of `working-state.js` for three reasons stated in its docblock, of which the load-bearing one is import-graph hygiene: `remote` is a Personal Sync fact, and dragging `sync.js` into a module the MCP child loads on every spawn would put a `git fetch` inside the stdout-discipline graph.

**`TRAY_DEFAULT_LIMIT` is 8 and the shell asks for 5, and that is not a disagreement.** The producer's default is what a caller gets when it expresses no opinion; `desktop/main.js` expresses one — `const TRAY_ROW_LIMIT = MAX_ROWS`, imported from `tray-model.js` — so the shell asks for exactly what it can display and the index read stays as small as the contract allows. `buildTrayModel()` caps again at `MAX_ROWS` independently, so a caller that asked for more cannot widen the menu. **The counts stay honest across both caps** because `total` and `pairsOnDisk` are taken before the slice: `getTraySummary({limit: 5})` on the maintainer's store returns 5 rows with `total: 11`, and `More in Agent Memory… (6)` is that subtraction rather than a cap being reported as a measurement.

#### Why it is a `Menu` and not a panel

Electron's `Tray` exposes no way to attach a rendered view — it can show a `Menu` and nothing else — and Apple's HIG says a menu bar extra should display a menu unless the functionality is too complex for one. So the whole surface is a `Menu.buildFromTemplate` template, which is **ordinary data**: labels, ordering, which items are actionable and which are statements are all asserted offline. `main.js` keeps only the Electron calls it cannot give away. Same split, and the same reason, as `lib/menu.js` and `lib/quit-decision.js`.

**A menu is not, however, text-only.** `MenuItemConstructorOptions.icon` exists and was checked against the installed Electron 43.5.0 type definitions rather than assumed, so an item can carry a picture drawn in its icon gutter. What is genuinely absent is `NSMenuItem.setView:` — the API iStat Menus and Stats use to put a live, animating multi-band graph in a menu — and an `NSMenu` is frozen at the AppKit level once it is open regardless. **So a live trace is impossible and a still frame per menu open is not**, and the still frame is what shipped. See [§ The save pulse](#the-save-pulse) below.

`tray.setTitle()` is deliberately left empty. A relative age in the bar is either stale or it ticks — a wake-up every minute for the life of the process, for a number nobody reads to the minute — and menu bar width is the scarcest resource on a Mac: items past the notch vanish with no notification and no overflow. The headline rides in the tooltip and at the top of the menu instead.

#### Two rules the model exists to enforce

**A null age is never a zero.** An unknown age renders as *"time unknown"*, never *"just now"*. An age that came from a filesystem timestamp renders as *"changed 4 min ago"*, never *"4 min ago"*, because `written` is a claim about the agent's clock and `changed` is a claim about this disk's — and git rewrites mtime on checkout, so on a second machine every pulled handoff would otherwise read as brand new. `ageSource` (`'agent' | 'file'`) is what carries that distinction from the store to the label. Sorting uses the same chosen clock, and a row with no usable clock sorts **last**: putting an unknown first asserts it is the newest.

**Line one is identity and time; everything else is line two.** A row's label is `scope-topic · age` and nothing may push either out; the `sublabel` carries `[handoff trimmed · ][harness[ ← previous]][ · machine][ · project][ · model] — headline`. That ordering replaced one where the TAIL was composed at full length and the identity got the remainder with a floor of 8 — which is how a photographed row came to read `project… — alices-macbook-pro·9f3c · 18 hr ago`: a 12-character harness survived because it was in the tail, and the scope was annihilated because it was not. Measured over the same rows, the widest label went **46 → 35 characters**, and all five had been clipped to the 8-character floor.

**Line two drops tokens WHOLE, lowest priority first** — model, project, machine, harness — until the headline keeps `MIN_HEADLINE_CHARS` (14). A fragment (`son…` for `sonnet-4`) is a different string rather than a shorter one, and a reader cannot tell which. Two tokens are **not droppable** because both are warnings about whether context survived: `handoff trimmed` (only for `lastSaveKind === 'trimmed'` — a `clipped` one-line summary over a handoff stored in full stays silent, which is the distinction v3.39.0 exists to preserve) and the handover mark `harness ← previousHarness`. The handover mark also **ignores the drop-constant rule**, and that is load-bearing: two rows can both END on the same harness while one changed hands, so `showHarness` is false and the token would be dropped, taking the only evidence of the handover with it.

**The provenance slot's two meanings survive, decided on `isThisHost`.** A row from THIS COMPUTER shows the harness; a row from another shows the machine. A foreign row may now show **both** — `opencode · studio` — where it used to show only the machine: line two is a list rather than a single slot, so the computer stands beside the tool and the old ambiguity (*that tool is running here*) cannot arise. `isThisHost` and not `isThisMachine`, because a second **installation** on this Mac is this Mac.

**One laptop is one row, and the match is on the installation id alone.** A `<machine>` folder is `<hostname-slug>-<install-id>`, and macOS re-derives the hostname from DHCP, so `mac-9f3c1a` and `alices-macbook-pro-9f3c1a` are the **same computer** with two folders on disk — working-state.js's own D10 finding, and half the maintainer's history. An exact string comparison classified that half as a remote machine and put a machine name in the slot that shows a harness for local rows. `machineIdentity()` therefore compares the trailing installation id and **never the hostname half**, so `buildbox-a1b2c3` cannot become "this machine" unless it literally carries this installation's id. Both sides must have one: `installIdOf` returns `null` for a degraded install with no id, and two nulls must never compare equal, or every id-less machine in a synced store would claim to be this one. `machineMatch` (`'exact' | 'install-id' | 'none'`) records **how** it matched, because a derived answer nobody can question is one nobody can debug — and it is a diagnostic that is never displayed.

**And the MENU asks that question with its own key, for a reason worth stating.** `machineIdentity()` above answers *is this row from this computer* for the producer. The menu needs a second answer — *do these two rows come from one computer* — and it takes it from `machineIdentityKey(scope, localIds)` in `desktop/lib/tray-model.js`, which **compares the trailing installation id and never the raw `<machine>` folder string**: `machineIdentityKey('alices-macbook-pro-9f3c1a')` and `machineIdentityKey('mac-9f3c1a')` both return `id:9f3c1a`, so the DHCP hostname flap is one computer. `localIds` — computed once per render by `localInstallIds(shown)` — is the set of installation ids that are **this Mac**, and any id in it resolves to one shared key instead, which is what collapses a second installation on this computer into the first. Only when neither side carries a parseable id does it fall back to the producer's two identity facts and then to the folder name (`name:<folder>`), which cannot collapse two genuinely different machines because a bare name is compared against a bare name. **The same key does both jobs** — deciding whether to DROP the machine token, and deciding whether a label collision is one computer or two — deliberately, because a pair grouped for one purpose and split for the other would drop the name and then print it. It is **not** `machineMatch`, which stays a diagnostic: a diagnostic that silently governs what is displayed is worse than one that is merely unused.

> **The design sketch for `localIds` had the ordering the other way round, and it was wrong.** It proposed preferring `isThisHost` *above* the id, arguing that a DHCP-flapped hostname was "still caught by the id arm underneath". It is not: only ONE of the two folders matches today's host slug, so the flapped one takes the host arm and its twin falls to the id arm, and the pair lands in two buckets — the phantom second computer v3.37.0 removed, reasserted by the fix meant to remove a different one, on the maintainer's own store. The id arm therefore comes FIRST, and `isThisHost` marks an id as local rather than bypassing it. `localInstallIds` unions `isThisHost` and `isThisMachine` because the two fail in opposite directions: the first misses a folder written before the hostname flapped, the second misses a second installation.

**`<machine> saved after this Mac` is derived from AGENT clocks only.** `newerElsewhereNotice(rows)` fires when a row from a genuinely different host has an age newer than every local row, and it discards any row whose age came from the file clock on **both** sides — a file-clock notice would announce that another computer had just saved at the exact moment you pulled, every time, forever, because `git` rewrites mtime on checkout. Both sides must exist: with no local agent-clock row there is no *after*, and the notice renders nothing rather than a degraded sentence.

**`isThisMachine` is the wrong question for a WIDTH decision, and that is what the reader's view exposed.** On the maintainer's own setup that field is **false on every row**, because the installed `.app` and his repo checkout are two different *installations* on one computer — the app runs under one install id and his agents write state under another. A rule that dropped the machine token when `isThisMachine` was true therefore never fired for him, printed a 17-character machine name on every line, and produced the 74-character label above while every suite, taking the writer's view, measured 54. The width rule now asks whether the token **varies across the visible rows**, which is the same rule that already governs the project token and the harness. `isThisMachine` keeps its other job — deciding whether the provenance slot holds a harness or a machine — untouched.

**The menu's width is now a MEASUREMENT, and so is the budget it is spent through.** The redesigned menu was photographed for the first time on 2026-09-02 — a throwaway probe building the real template on a real `Tray`, captured at 2×. **Measured from that 2× capture: the menu is 363.5 points wide** (727 device pixels at scale 2), the leading inset is 14.5, and the widest text ink ends at 293.5 — so **84.5 points of every item is width the title never gets** (the leading inset plus the trailing accessory column that carries a row's submenu chevron and Quit's ⌘Q). The model had said 36. It had also said a `sublabel` advances 5.0 points per glyph, where three rendered 46-character sublabels measured **5.54, 5.58 and 5.64**. Both errors ran the same way — the arithmetic believed the menu narrower than it is — which is why a budget computed from them still produced a menu the maintainer called well proportioned. The figures still come from one formula rather than from eye: `labelBudgetChars(iconPoints, charPoints)` spends `MENU_WIDTH_POINTS` (363.5) minus `MENU_CHROME_POINTS` (84.5) minus the icon and its `MENU_ICON_GAP_POINTS` (4) bearing, at `MENU_CHAR_POINTS` (6.5) per glyph — which is why a row carrying a 13-point recency dot gets **40** characters where a plain label gets **42**, and why a `sublabel`, drawn smaller at 5.65 points per glyph, gets **46**. **The corrected constants reproduce that 46 exactly**, which is the check on the whole decomposition: three separately measured terms landing on the cap the photograph shows was already being rendered. No budget narrowed — the row cap went 35 → 40 and the plain cap 38 → 42 — because the widest thing on a row is its sublabel and that cap did not move. `MENU_CHAR_POINTS` is now **corroborated rather than assumed** (ink width over character count on nine rendered labels ran 5.78–7.39, mean 6.33, so 6.5 sits just above the mean); `MENU_ICON_GAP_POINTS` is the one term still assumed, because a photograph cannot separate the layout gap from the following glyph's left side bearing. The suite therefore still asserts the **arithmetic** and reports the **sensitivity** across the plausible advance range rather than pinning a character count as a fact. **One label is deliberately exempt from the width's authority:** `pulseLabelBudget()` gives the save-pulse row the larger of its width allowance and the longest reading `pulseLabel()` can actually emit, because the photograph caught the width budget cutting `· 2 tools` off a complete reading — and two of that sentence's three clauses are its honesty caveats. Four levers sit on top of the budget, each decided from the data at render time rather than hardcoded: the project token is dropped when only one project has state; a leading `session-` is stripped; a harness shared by every shown local row is dropped; and the machine is dropped when every shown row resolves to one computer. Each comes straight back the moment it distinguishes something — a second project, a scope that does not share the prefix, a second harness — because a hardcoded strip would be a lie waiting for the day the user's setup changes, and a silent one. **The absolute rule on top of all of them: every fact removed from a label is still in that row's tooltip, in full**, which is why the tooltip is built from the raw values.

**Compaction that makes two rows read identically is worse than the width it saved**, so labels are composed, checked against each other, and collisions separated. The order matters and the first attempt got it wrong: it restored a **machine folder name** whenever colliding rows sat in different folders, which on the maintainer's own store reasserted the phantom second computer the identity fix had just removed — and did it on the only two lines still over the width target. Now, if the colliding rows are the same computer, the **age precision escalates** (day → hour → minute) until the labels differ: *"1 day ago"* becomes *"34 hr ago"* and *"36 hr ago"*, which is the same fact at a finer resolution, costs no width, and makes no claim about hardware at all. Genuinely different computers still get their machine label — there the machine **is** the distinguishing fact and the news. Only if one computer saved twice inside a minute does escalation run out and the folder names come back, and the finer age is **handed back** first rather than left paying width for a distinction that failed.

#### The order of the menu, and where the separators went

`buildTrayMenuTemplate()` emits one flat template and the order is the design:

| # | Item | Enabled | Notes |
|---|---|---|---|
| 1 | `Last save · 44 min ago` | **yes** | the headline answer; clicking opens Agent memory |
| 2 | `    claude-code · opus-4` | no | `harness · model` — a statement about the line above. It used to repeat `project · scope`, which the first row below already shows; that pair is now the item's `toolTip`. Falls back to `project · scope` when neither tool nor model is known, rather than vanishing |
| – | **header** `Save pulse` | no | `type: 'header'` |
| 2b | `5 days known · 79 saves · 2 tools` | **yes** | the strip in the icon gutter, the reading on the label |
| – | **header** `Recent scopes` | no | `type: 'header'` |
| 3 | up to **five** rows | — | newest first, flat, each with a recency mark in its icon gutter and a **four-item submenu**. A submenu parent carries **no `click`**: on macOS a click on it opens the submenu, and a handler beside that fires unpredictably — `Open in The Curator` is the first submenu item instead |
| 3b | `More in Agent Memory… (6)` | **yes** | the overflow, and a real destination |
| – | separator | | **only when there are notices** |
| 4 | notices | no | at most `MAX_NOTICES` (4), then `…and N more`. Remote handoffs waiting; `<machine> saved after this Mac`; harness collisions |
| – | separator | | always |
| 5 | `Open Agent Memory…` · `Open The Curator` · `Settings…` | yes | |
| – | separator | | only when there is a `renderedAtText` |
| 6 | `Updated 12:42` | no | |
| – | separator | | always |
| 7 | `Quit The Curator` | yes | `role: 'quit'` |

**The notices sit BELOW the rows and below the truncation line, not above them**, in their own separator-fenced block. That ordering is deliberate: a notice is a caveat about the list, and a caveat placed above the thing it qualifies pushes the answer the widget exists for further down the menu.

**Four separators survive, and two were spent to buy the headers.** `Save pulse` and `Recent scopes` replaced the separators that used to sit in exactly those two places, so the menu gained structure without gaining height — which is what turns it from a list of items into something shaped like a widget, the maintainer's verdict on the version before it. What remains is the fence above the notices (conditional), the fence above the commands (unconditional), the fence above the freshness stamp (conditional on there being one), and the fence above Quit (unconditional).

**`type: 'header'` is a macOS 14+ affordance and the fallback is built into the item rather than branched around.** It was verified to be in Electron 43.5.0's accepted `type` union, and Electron's own type check is JavaScript that runs identically on every macOS — so `Menu.buildFromTemplate` cannot throw on macOS 13. The risk is only that AppKit draws an ordinary item. A header therefore carries `enabled: false` and **no** click handler, so its worst case is a dimmed inert caption, which is what a section heading looks like anyway. There is no arrangement of macOS versions in which one becomes a clickable item that does nothing.

**A truncation line is never a measurement.** `truncatedNote` counts against `total`, which `getTraySummary()` takes **before** the display slice, so `More in Agent Memory… (6)` is 11 minus 5 and not a cap reported as a figure — the defect this project recorded of `distinctScopeCount`. The item is **enabled**, because a disabled line naming a place you cannot go from it is worse than no line at all.

#### The per-row submenu, and why the clipboard is the route

A tray row cannot open a **work-stream**. It opens the app on the row's PROJECT, because `data-view` and `data-mem-project` are the memory view's only routing attributes and its scope picker has none — a limit recorded since v3.35.0 and not fixed here. So each row carries a submenu offering the route the menu does have.

| Id suffix | Label | Wiring |
|---|---|---|
| `ID_ROW_OPEN` | `Open in The Curator` | its own `onOpenScope` handler — it predates the submenu and has a shell function of its own |
| `ID_ROW_RESUME` | `Copy resume prompt` | `onRowAction(row, action)` → `composeResumePrompt()` → `clipboard.writeText` |
| `ID_ROW_HANDOFF` | `Copy handoff as Markdown` | `onRowAction` → `getHandoffMarkdown()` → `composeHandoffMarkdown()` → `clipboard.writeText` |
| `ID_ROW_REVEAL` | `Reveal current.md in Finder` | `onRowAction` → `shell.showItemInFolder` |

Item ids are `rowActionId(rowId, action)` = `<row id>:<action>`, composed in one place so the builder and any consumer cannot drift. `onRowAction` is **required** like every other handler and refused at build time: an optional one is a submenu that silently does nothing.

**`desktop/lib/resume-prompt.js` imports nothing** — no Electron, no `node:fs`, no `path` — and the suite asserts that structurally. It is not tidiness: `getHandoffMarkdown()` in `src/brain/tray-summary.js` delegates to `readWorkingState`, which is where `neutraliseProtocol` runs on the way **out**. A `readFile` on `current.md` here would be four obvious lines and a path from a stored file to a **clipboard**, and therefore to a model's context, with the read-side sanitiser bypassed. `scripts/test-tray-resume-prompt.js` §3 drives that behaviourally: it seeds a store, then **overwrites `current.md` with raw markup** — the shape a `git pull` from another machine leaves — and requires the composed document to carry the escaped form. Its first version planted the markup through `saveWorkingState` and was **vacuous**, because the write side sanitises too, so the bytes on disk were already defanged and a bypassing reader would have passed.

**Neither composer caps anything.** The store already bounds `current.md` at `MAX_STATE_BYTES` (48 KB) and the brief at `MAX_BRIEF_BYTES` (32 KB); a second, smaller cap on the way to a clipboard would silently truncate a document the user asked for in full. `handoffByteNote()` discloses the size for the item's tooltip instead.

**Both composers carry the same `TRUST_FRAMING` constant**, verbatim: the handoff and the journal are recorded data to VERIFY, the standing brief is the owner's instructions and is FOLLOWED. The two tiers stay separate `##` sections in the Markdown rather than being concatenated, because that distinction is the whole of the store's tier model and joining them makes it unrecoverable to the model reading the paste.

#### The recency dot — a calculation that was already being made, drawn

`ageBucket()` has always resolved a row's age into five named states plus `unknown`, and until `desktop/lib/menu-dots.js` existed exactly one of those distinctions reached a screen. Nothing new is measured; a measurement already made is drawn. The bucket names and thresholds are **read from `tray-model.js`** and not restated, because a second opinion about what *warm* means is the drift this project keeps recording.

| Bucket | Age | Ink | Mark | Ink area |
|---|---|---|---|---|
| `live` | under **2 min** (`LIVE_WINDOW_SECONDS` 120) | **teal** | full disc, r 5.0pt | 78.5pt² |
| `warm` | 2 min – **30 min** | **teal** | ¾ disc + face ring | 61.4 |
| `today` | 30 min – **12 h** | **amber** | ½ disc + face ring | 44.2 |
| `cool` | 12 h – **7 days** | **grey** | ¼ disc + face ring | 27.1 |
| `cold` | over 7 days | **grey** | r 2.0pt dot + face ring | 22.5 |
| `unknown` | no usable clock | — | **no mark at all** | 0 |

**Every mark is drawn inside a faint FACE RING, and the first photograph of the menu is why.** The sector ladder shipped without one, and the 2× capture taken on 2026-09-02 showed what that costs: three of the five rows carried the `cool` quarter, and a quarter-disc with nothing around it read as a sliver rather than as a quarter of anything — a fraction needs a whole to be a fraction *of*. `FACE_RADIUS` (5.0), `RIM_POINTS` (1.0) and `RIM_ALPHA` (0.35) put a 1-point ring at the face radius on **every** state, in the mark's own hue at 35% of its alpha. `live`'s ring is invisible because its full disc covers it, which is the correct reading of a full clock; `cold`'s dot sits entirely inside the ring's inner edge, so the coldest state reads as a clock drained to its hub rather than as a dot floating in an empty box. The ring is drawn by resolving each pixel's alpha as the **maximum** of its sector coverage and its rim coverage before anything is written — not by painting one over the other, because `paintPixel` replaces rather than composites and a sector's antialiased edge would cut a pale seam through the rim underneath it.

**The ring adds ink in inverse proportion to what the sector already covers**, which compresses the bottom of the ladder without inverting it: `cold` goes 12.6 → 22.5 and `live` gains nothing at all, so the `cold`-to-`live` ratio moves 0.16 → 0.286 and the suite's bound moved with it, bracketed on **both** sides so a change in either direction reds. **The ring's own contrast is 1.50–2.32:1 and is reported rather than floored** — 3:1 is the floor for a graphic a viewer must DETECT to get the information, and nobody is asked to detect the ring: it is the ground the sector is read against, and the sector clears the floor at 3.79–6.43:1. The ring introduces no colour, so those figures still describe every pixel drawn.

**A DRAINING CLOCK replaced a disc and three rings, and the reason is arithmetic.** The rings were separated by 0.5pt of radius — **one device pixel at 1x** between three of the five states — so the ladder existed in `dotInkArea()` and not on the screen. A sector drains a whole quadrant at a time, which is a difference visible in a thumbnail, and `inSector()` tests the SIGNS of `dx`/`dy` rather than an angle: every shipped value is a whole quarter, and a sign test is exact where a floating-point comparison against a boundary makes a half-disc's straight edge wobble. `cold` is the one state that is not a sector — a one-eighth wedge reads as a rendering fault rather than as a quantity — so the coldest mark returns to a solid shape at 16% of `live`'s area.

**Five buckets onto three colours, with the boundaries where the ANSWER changes rather than where the numbers are round.** Green covers `warm` as well as `live` because the live window is 120 seconds and a menu opened by hand will essentially never land inside it — a green reserved for `live` alone would spend the strongest colour in the palette on the state the user almost never sees, and every row would be amber or grey in practice. **30 minutes is the point at which the handoff stops being in your head**, which is the thing the colour is being asked about. Grey covers both `cool` and `cold` because three days ago and three weeks ago prompt the same action — read it properly before you touch it — so a third shade would be a distinction with no consequence. The collapse costs nothing because the **exact figure is printed on the same row**: the dot is the pre-attentive band and the words are the number, the same split v3.34.0 recorded for the save-status pip.

**Colour is never the only signal.** Teal and amber are a confusion pair for the commonest colour vision deficiencies, so the five states are also a **strictly decreasing ladder in ink** — 78.5 > 61.4 > 44.2 > 27.1 > 22.5 square points — asserted by the suite from the shipped geometry and again by **summing the DECODED ALPHA channel** of the emitted PNGs at both 1× and 2×, which is the ink a viewer actually meets rather than the ink the arithmetic claims; the centre pixel's coverage additionally drains 255 → 191 → 128 → 64 across the four sectors. `live` is the only complete disc, so the one state that changes what a person does next is separable with the colour removed entirely. `dotToolTipLine()` additionally states the band in words.

> **The palette's requirement is a FLOOR, not an ordering, and that is a deliberate weakening.** This module used to require `hot > mid > cold` in contrast so a warmer row was a heavier mark. That was right when all five marks were nearly the same SIZE and colour was doing the ladder's work; the sector geometry now carries weight explicitly and in the alpha channel, where it survives a viewer who cannot resolve the colours at all. Keeping the luminance ordering on top would be a second, far weaker ladder pointed at the same fact — and it rules out the design system's own hues for a reason that has stopped applying: in dark, `summary-400` (6.43) is brighter than `teal-400` (6.05), and nothing about that makes `today` read heavier than `warm` when `warm` is drawn with 50% more ink.

**`unknown` is absent from `DOT_INK` and checked FIRST, and `renderRecencyDot('unknown')` returns `null` — the row gets no mark at all.** An age we do not have is not an old one. Were the case merely missing, the natural fallback would be the coldest dot, which would assert *old* about a row whose own label says the time is unknown: this repo's fact-versus-absence collapse, in the direction that manufactures a fact. It is listed in `NO_DOT_BUCKETS`, and an unrecognised bucket name returns `null` for the same reason.

**The canvas is 13pt and odd on purpose.** A circle centred at `size / 2` on an EVEN canvas is centred on a pixel *corner*, so at 1x the smallest mark has no fully-covered pixel anywhere and a `cold` dot that should be solid renders as a soft blur. On an odd canvas the centre is the middle of a pixel and the smallest filled dot has a solid core. The first draft was 10pt and the suite caught it; 11 → **13** came with the sectors, because at r 3.0 a quarter-disc is a 3×3-point wedge — nine square points at 1x, which is a smudge — and at r 5.0 it is 19.6.

#### The menu follows the SYSTEM appearance, which is not what this app themes its window as

The strip and the dots are PNG bytes chosen for a light or a dark menu, and `tray-model.js` is a pure module that cannot notice a switch — it is handed `dark` and has no way to ask again. So `main.js` reads the appearance and passes it in, and **which value it reads was measured rather than assumed**.

`boot()` sets `nativeTheme.themeSource = 'dark'` so the window's native title bar matches the app's near-black theme. That setter is **exactly what `nativeTheme.shouldUseDarkColors` reports**, so it reads `true` on every Mac regardless of the system appearance — and the menu it would paint is drawn by AppKit against the *system menu bar*, not against this app's window. Measured on a light-appearance Mac by running Electron 43.5.0 and reading all three values before and after the override:

| | system default | after `themeSource = 'dark'` |
|---|---|---|
| `nativeTheme.shouldUseDarkColors` | `false` | **`true`** |
| `getEffectiveAppearance()` | light | **dark** |
| `getUserDefault('AppleInterfaceStyle', 'string')` | light | light |

`getEffectiveAppearance()` follows the override too and is no better. **`AppleInterfaceStyle` is the only one immune to it**, and it is the one that answers the question being asked, so `menuAppearanceIsDark()` reads it and treats absent or empty as light — macOS's own encoding, and the safe direction, because the light palette on a dark bar is a legibility loss while the dark palette on a light bar is the defect being fixed. This is **not two opinions about one fact**: `themeSource` is a fact about *this app's window* and `AppleInterfaceStyle` is a fact about *the system menu bar*, and they are allowed to disagree.

**The rebuild is driven by `AppleInterfaceThemeChangedNotification`** — `systemPreferences.subscribeNotification` — for the same reason: with `themeSource` pinned, `nativeTheme.on('updated')` does not fire for a system appearance change. Both are wired, the notification as the real signal and `updated` as a belt; both are torn down in `stopTray()`, because `nativeTheme` is a process-level singleton and a listener per tray toggle accumulates. The re-render is the same no-I/O path `mouse-enter` uses: no index read, no filesystem, no network.

#### The save pulse

One menu item, under its own `Save pulse` section header, carrying a drawn strip in its icon gutter and the reading in words on its label — `4 days known · 70 saves`. **The producer still counts 28 buckets of 6 hours across a 7-day window; the strip DRAWS 14 cells of 12 hours, oldest on the left.** The label drops the words *Save pulse ·* precisely because the header above it now carries the noun — `stripPulseNoun()` removes the prefix rather than a second formatter composing a second sentence, so the two can never disagree about what the strip is called.

**It costs zero additional file I/O, and that is the whole reason it exists.** `listWorkingScopes()` already read and parsed every journal in full on every call; the index then kept the newest timestamp and discarded the rest — 54 of 65 entries on the maintainer's own store. The pulse is those numbers kept rather than thrown away. `withSaveTimes` is a strict opt-in with exactly one caller, so the MCP index payload is byte-identical.

**Only the journal's own `at` is counted. There is no mtime fallback, and no `'mixed'` clock.** git rewrites mtime on checkout, so an mtime-fed chart would draw a second machine's pulled history as a single spike at the moment of the pull — v3.34.0's defect redrawn as a picture.

**Three cell states plus a baseline and a ruler, separated by SHAPE rather than opacity.**

| Mark | Drawn as | Means |
|---|---|---|
| **axis** | a 1pt baseline at `AXIS_Y` (12), running the full width, **solid** under a known cell and **dotted** under an unknown one | the timeline, and whether the store existed |
| **active** | a violet bar standing on the axis, height by `BAR_HEIGHTS[activeLevel(count) - 1]` = 3 / 5 / 7 / 9 / 12pt | saves landed in this cell |
| **empty** | the axis, and nothing above it | this cell existed and nothing happened |
| **unknown** | the axis, DOTTED, and nothing above it | before the store existed at all |
| **cap** | the top `CAP_POINTS` (2) of a bar, in amber | the harness CHANGED inside this cell |
| **ruler** | one 1pt tick per day at `RULER_Y` (14), today's double width, with row 13 left blank | the scale |

**The axis is what makes this a timeline rather than a column chart**, and it carries the third state in TEXTURE rather than in tint: two similar greys do not read at 3pt of width, and a dash does. Both sides use the SAME ink, so the distinction survives with the palette discarded — asserted in the alpha channel by `scripts/test-tray-paint.js` §11. The dash is one **device** pixel on and one off at both scales, deliberately: a point-based dash becomes 2-on-2-off at 2x, which at this size reads as a slightly lighter solid line. That is the one place where the 2x image is not the 1x image doubled, and the suite measures the exception rather than waving it through.

**`cellsPerDay()` is DERIVED from `drawnBucketSeconds()`, never hardcoded to 2.** The strip falls back to drawing the producer's buckets unfolded when no exact divisor is available (see `mergeFactor`), and a ruler assuming twelve-hour cells would then mark every twelve hours as a day — a scale wrong by a factor of two. A span that does not divide the day draws **no ruler at all**, because a scale nobody can trust is worse than none.

**The handover cap is a BOOLEAN, never a count.** Two handovers in twelve hours and one prompt the same action. `harnessChanges[]` comes from `computePulse`, which walks each pair's `saveHarnesses` — index-aligned with `saveTimes` by construction in `journalFacts` — with a **per-pair** cursor: a global one would see two scopes alternating in the merged timeline and mark a handover in each, a baton passed that nobody passed. A flag on a cell with no bar is dropped rather than drawn on nothing.

Empty and unknown must not render identically — that is this repo's fact-versus-absence rule, and it is not a corner case: on a store 3.5 days old against the 7-day window **half the strip is unknown** — 13 of the producer's 28 buckets, which fold to 6 of the 14 drawn cells, and on the maintainer's real store today it is exactly 6 of 14. Two similar greys do not read at 3pt of width, so the distinction is carried in **shape and height**, not in tint. Unknown is deliberately *not* fainter than empty; making "no data" the faintest mark would encode it as *even less than nothing*. Every cell is drawn, empties included — a strip that omits them stops being a timeline and becomes a scatter of marks with no scale.

**The HEIGHT REFUSAL was lifted, and the argument for lifting it is that the shipped alternative broke it in substance.** v3.37.0 refused to put the save count in the bar height on the ground that a rising and falling column chart reads as a productivity graph. That ground is real and still respected — but the shipped alternative was a five-rung COLOUR RAMP encoding the identical quantity in the one channel illegible at three points of width, so the number was being drawn either way, just invisibly. Worse, `activeLevel` capped at **five** while real twelve-hour cells hold **3 to 18**, so the ramp sat pinned at saturation and every active cell was the same dark green — the fence the maintainer reported. The ladder is now **log-ish** (1 / 2–3 / 4–6 / 7–12 / 13+) because a linear scale over 1–20 spends four of its five rungs above 15 saves, where nothing interesting happens.

**The progress-bar reading is defeated STRUCTURALLY rather than by refusal**: the baseline and the day ruler make the picture a time series, and the label says *saves per 12 hours*, never *activity* and never *progress*. **The refusal on RANKING survives verbatim.** An agent told to *save early and often* — which is exactly what `claude-skills/curator-continuity` asks for — produces more marks than one told to save twice, so a taller bar means *different instructions* and never *more progress*. No legend anywhere ranks a tall column above a short one, and the suite asserts that as copy with an anti-vacuity control.

**`· N tools` appears only when more than one harness wrote inside the window.** One is silent (a token on every row of every single-tool store distinguishes nothing) and **zero is silent too**, because zero is the ABSENCE of a measurement rather than a measurement of none. Per-harness LANES were refused on geometry: two lanes inside 15pt give 7pt each and the bar ladder needs 12, and a legend in an NSMenu is another disabled row on the surface with the least vertical space in the product.

**The label states only what the data can support**, and both honesty fields change the label rather than hiding in the tooltip, because a caveat you have to hover to find arrives after you have already believed the picture: `coversWholeWindow: false` names the span actually covered (*"4 days known"*) instead of the window, and `pairsTruncated > 0` makes the count a floor (*"at least 65 saves"*). `clock: 'none'` replaces the sentence entirely rather than qualifying it — *"no save times recorded"* — and a strip whose every cell is unknown is captioned *"nothing recorded yet"*, never *"7 days · no saves"*.

**Geometry, and why these numbers.** 3pt bars at a 4pt pitch, **15pt tall — 55 × 15 points**, emitted as a colour RGBA PNG at 1x and 2x from one drawing (`stripCanvas(cells, scale, palette, perDay)`), so a retina asset cannot drift from its low-resolution twin. It was **83 × 11 with 2pt bars at a 3pt pitch**, and every one of those numbers moved: width **83 → 55pt** (34% narrower), height **11 → 14 → 15pt**, bar **2 → 3pt**, which is twice the ink in a full active cell. The fifteenth point is the day ruler, and it costs zero width — a macOS menu row accommodates a 16pt icon without growing. A strip that is more present and smaller at once is the only honest answer to *make it more visible* inside a shrinking width budget. Electron performs **no scaling** on a menu icon, so the image draws at its declared size and **widens the menu** — which is why the strip is the only lever available: a per-row character budget cannot shrink a fixed-width image. **The 28 points came out of the drawn RESOLUTION and not out of the producer's contract.** `PULSE_WINDOW_SECONDS` (7 days) and `PULSE_BUCKET_SECONDS` (6 hours) in `src/brain/tray-summary.js` are untouched and still produce 28 buckets; `mergeCells(cells, mergeFactor(28))` folds them two-to-one at draw time, so one drawn cell is **twelve hours** — morning and evening of each of seven days, which is a timeline a person can read. Seven daily cells were considered and refused on the **ramp** rather than the picture: counts per six hours run about 1–9, which five rungs discriminate, while counts per day run 5–40 and would pin the ramp at saturation permanently, destroying the only reading the colour carries. `drawnBucketSeconds()` is what the tooltip's legend quotes, never `bucketSeconds`, because a legend must describe the picture in front of the reader.

**It is NOT a template image, and the constraint it inherited from the glyph was false.** The tray GLYPH must be a template because macOS tints a menu-bar icon; a MENU ITEM icon is drawn as authored, so the strip and the recency marks ship as full colour with `template: false`, and the consumer must not call `setTemplateImage(true)` on them. That is what makes the contrast measurable at all: the alpha-only version's heaviest bar was alpha 1.0 of the *disabled-text* tint, roughly a quarter of the label colour's opacity, which put it under 2:1 against the menu — the maintainer's *"barely visible"*.

**The palette is now THREE colours per theme rather than seven**, because the count left the ramp: `bar` (violet-700 light / violet-400 dark), `axis` (neutral) and `cap` (attention). Violet, because the design system reserves it for identity and action and forbids it as a DATA TYPE — a save is The Curator's own activity rather than a data type — and because it stops the strip reading as the wiki's green *concept* marker. Every value clears **3:1** (WCAG 2.2 1.4.11, the non-text floor — 4.5:1 is the text floor and citing it here would cite the wrong rule) against all three backgrounds of its theme's `MENU_BG_BAND`; worst case 6.66 for the light bar, 3.72 for the dark one, 3.43 for the dark axis. `scripts/test-tray-paint.js` recomputes every ratio from the shipped values, over a COUNT derived from the palette objects rather than typed, and carries four controls that must FAIL: Apple's `systemGreen` on light, a colour equal to the dark background, and each theme's bar colour used on the other theme. **Two assertions were REMOVED with their reasons rather than quietly dropped** — *unknown is heavier than empty* and *the active ramp rises monotonically* — because both were about palette entries that no longer exist; what replaced them is that the axis clears the floor on its own, so the known/unknown reading survives even if every bar were invisible.

**The item is ENABLED, and it shipped disabled first.** The reasoning for disabling it was this menu's ordinary idiom — a statement rather than an action, the same idiom the notices and the freshness stamp use — and the outcome was the known bad one: a disabled menu item is drawn at **reduced contrast**, so the one piece of graphics the maintainer asked for went into the dimmest style macOS offers, which is the compounding-opacity defect this repo has already fixed twice in its own CSS. Enabling it needs a destination and it has the same one as the headline above it: the Agent memory view, where the saves this strip counts are actually listed. A picture of the last seven days that opens the list of the last seven days is not a stretch. `nativeImage.createFromBuffer` is **injected** as `makeIcon` rather than imported, so every decision — whether there is a strip at all, what it says, where it sits, whether it is actionable — stays inside a module `npm test` executes for real. With no `makeIcon` the item still appears with its label and tooltip and simply carries no picture: a missing image must not cost the reading.

**One strip over the whole store, not one per row.** A per-row sparkline was refused on legibility — five to eleven independent bands a few points tall, in a menu this same release was making narrower, each drawn from a single scope's handful of saves, most of which would be one mark and a lot of empty. What each row carries instead is a single **recency dot**, which is one state and not a series.

#### Quit is `role: 'quit'`, and that is a safety property

Not a `click` handler. The role goes through Electron's normal shutdown, which fires `before-quit`, which is where `main.js` asks `GET /api/write-status` and runs `lib/quit-decision.js` over the answer. A hand-rolled handler could call `app.exit()` and walk straight past that guard — the single most likely way to break it while adding a tray. The suite asserts the item carries the role and **no** click handler at all, so no code path exists that could skip the check. That guard also becomes more load-bearing here, not less: an app that keeps running with no window is more likely to be alive when a write is in flight.

#### What it costs while nobody is looking

The MCP writes state in a **separate process**, so there is no in-process event to subscribe to. That leaves polling or a watch, and the research measured both against synthetic trees mirroring the real layout: one recursive `fs.watch` over a 10,000-file tree idles at **0.0044% of a core**, a 20-second poll over the same tree costs **0.31%** — 70×.

| While the menu is closed | Cost |
|---|---|
| Recursive `fs.watch` on the domains folder | 0.0044% of a core |
| Fallback interval, 5 minutes | 0.02% |
| Debounce timer | Zero when idle — armed only after an event |
| Glyph expiry timer | Zero when idle — armed only while the glyph is `live` |
| Index read per real save | 1.4–61 ms, a few times an hour |
| **Total** | **~0.025% of one core, no additional memory** |

Three details make that hold. The **debounce** is 150 ms because one save produces three events in the same millisecond (the `.tmp-…` file, `current.md`, `journal.jsonl`). The **filter** requires a `state` path segment and rejects any dot-prefixed segment, which removes the atomic write's temp file, `.DS_Store`, `.git/**` and the write lock in one rule — 30 wiki writes produced 32 events and none of them matched. The **glyph expiry** is a one-shot `setTimeout` armed at exactly the live-window boundary, not a tick: `live` has to become `idle` two minutes after the last local save even though nothing happens on disk at that moment, and when the glyph is `idle` there is no timer at all. Nothing branches on the event **type** — on the recursive macOS path every event arrives as `rename`.

The design that would ruin this, refused explicitly: re-reading the index on a short interval so the menu is "instant" when opened. Push-on-change already gives instant opening, because the main process is holding the snapshot when the click arrives.

#### `remote` is an observation, and the shell is what asks

`getTraySummary()` **does not import `src/brain/sync.js`** — not the constants, nothing — so no edit to that file can reach `getRemoteStatus()` without adding an import a reviewer will see. That is a stronger guarantee than "we only call it when the cache is warm", and it is the only one available: `getRemoteStatus()` is *cache hit ? return : `git fetch`* with no peek, and `maxAgeMs: 0` does not help because `remoteCacheTtl` returns 0 for a successful payload. A second fetch site is not theoretical — v3.9.1 put one behind the sync badge and it aborted the user's own pull in 11 runs out of 12 over a ref lock.

So `noteRemoteStatus()` records whatever a completed check last reported. The observation expires after 5 minutes, and a stale one is **dropped** rather than shown with an age, because a menu line saying *"2 waiting"* is read as current and there is no room beside it to say it is not. `null` renders as nothing, never as "up to date".

**There are two feeders, and the second exists because the first was inert exactly where it was needed.** `GET /api/sync/remote-status` calls it on every request — the endpoint the sync badge already polls, adding no fetch of its own — which keeps the observation warm for free *while the window is open*. But `refreshSyncRemoteBadgeIfVisible()` in `src/public/next/app.js` declines to fetch while `document.hidden` is true, and a hidden window is the tray's **normal** state, so the multi-machine signal could essentially never fire. Nothing rendered wrongly; the line simply never appeared.

The second feeder is `maybeCheckRemote()` in `desktop/lib/tray-remote.js`, on a tray **menu open only** — never on hover, never on a watch, never on a timer — through `brain/sync.js`'s own `getRemoteStatus()`, inheriting its TTL cache, in-flight memo and fetch gate rather than creating a parallel set. Attempts are stamped **before** the await, so a slow failing check cannot leave the window open. `getTraySummary()` still imports no `sync.js` and still makes no network call: the shell does the asking and hands the answer back through the same function feeder 1 already used.

The honest limit is narrower than a clean claim of safety. `gitFetch()` serialises every fetch **that module** issues; `git pull`'s own internal fetch is git's subprocess and is outside the gate and cannot be inside it. 60 concurrent runs against real git 2.48.1 — including the fetch-vs-fetch shape that *is* the v3.9.1 incident — produced zero failures on either side, and that was reported as **inconclusive** rather than as safety: a harness that cannot reproduce the known failure cannot certify its absence. The decision rests instead on this reaching the same function, through the same gate, as a call the app already makes on a 10-minute timer whenever the window is open — one rarer, human-initiated trigger for a shipped call.

**`ok` is the third state, and without it the first two collapse.** `runRemoteCheck` distinguishes *we could not ask* from *there is nothing waiting*, but the only consumer — `remoteNotice()` — branches on `remote.ok === false`, and the store emitted no `ok` at all. So a failed check reached the menu as `{behindFiles: null}`, took the no-number exit, and rendered as **nothing, byte-identical to never having checked**. The distinction survived the store and died at the model. That was tolerable while nothing ever triggered a check, because absence is honest when the normal state is *nobody asked*; it stops being tolerable the moment the tray asks on its own, because then silence is read as an answer.

#### The mode, and turning it on and off without a restart

`backgroundMode` is a **named string, not two booleans** — `window` · `tray` · `tray-only` — following `install-mode.js` and `releaseChannel`, which makes the illegal fourth combination (no tray *and* no Dock, an app with no affordance at all) unrepresentable. It sits top-level in `.curator-config.json` beside `sharedBrainEnabled` and deliberately **not** in v3.28.0's `ui.*` allow-list: every field in that table is `monotonic`, `writeOnce` or a one-way `clearable` dismissal, because its purpose is that a **consent** cannot be silently downgraded, and a preference the user may flip repeatedly has no shape there.

The read is lenient and the write is strict, and the asymmetry is deliberate. `resolveBackgroundMode()` answers `window` for absent, unrecognised, or a value a newer build wrote — the same fail-safe direction `paths.js` takes for install-mode detection. `setBackgroundMode()` **refuses** an unrecognised value rather than coercing it, because coercing would let Settings report *"tray-only saved"* while the file holds `window`.

`tray-only` is recognised and **does not hide the Dock icon.** `resolveTrayPlan()` returns `hedged: true` with a reason. Hiding the Dock means `app.setActivationPolicy('accessory')`, and the *return* transition — accessory back to regular, which is what happens the moment the user opens the window from the tray — is community-reported buggy in exactly the direction this depends on, and cannot be tested without Electron and a launch. Shipping it would risk no Dock icon, no menu bar, no window, for a mode nobody has asked for yet.

Flipping the setting takes effect without a restart, so every pair of modes is a live transition and there are nine of them. `planModeTransition()` is a pure function over two strings — the suite drives the whole 3×3 matrix — and `main.js` applies the difference. **Idempotence is the property that matters**: a config file watch fires more than once for a single save (an atomic write is a create plus a rename), so `from === to` must produce no action, or one Settings click destroys and recreates the tray icon, which on macOS moves it to a new position and, with a menu bar manager installed, can file it somewhere the user cannot see.

The shell notices the flip by watching the config file's **directory**, not the file: `writeFileAtomic` renames over the inode, and a watch on an inode that gets renamed over stops delivering events silently. It runs in **every** mode, including `window`, because it is what notices the mode being turned on. A channel would be better and is not available — `registerDesktopHost()` throws on an unknown hook name and its frozen list is `pickFolder, relaunch, prepareUpdate, installUpdate`; adding a fifth is a change in `src/`, which the shell does not own.

#### The click, and its honest limit

There is deliberately **no second reader in the widget**. A row click reveals the window on the Agent memory view and on that **project** — it does *not* select the scope. `data-view` and `data-mem-project` are the app's own dispatch attributes; the scope picker inside the memory view has no routing attribute to address. The coupling is the same one `lib/menu.js` already accepts for Settings, with the same property that makes it acceptable: `executeJavaScript` resolves with a value, so the shell learns when the coupling has rotted and shows an error naming the rail button, instead of offering a menu item that silently does nothing. The project name is passed as a JSON string and compared against `dataset.memProject` — never interpolated into a selector, because a project name is user-supplied text and building a CSS selector from it would be an injection into the app's own origin.

### Known gaps in the shell itself

Beyond signing, and beyond the "run once on one machine" caveat at the top of this section:

- **`scripts/build-app.sh` must be retired before any signed build ships.** It ends in an ad-hoc `codesign --force --deep --sign -` and `xattr -rd com.apple.quarantine`, which would destroy a Developer ID signature. It is load-bearing for repo mode today. `install-mode.js` names the capability (`canRebuildAppleScriptApp: false` in bundle mode); nothing enforces it in the script.
- **The window has a native title bar, and a frameless design cannot return until the app's CSS carries a drag region.** An earlier build shipped `titleBarStyle: 'hiddenInset'` and produced three defects at once — the traffic lights drawn *over* the rail's logo, nothing draggable (a sweep of the live renderer found `-webkit-app-region: drag` on **zero** elements), and a window hard to grab to resize. They are one defect: `hiddenInset` hands the app the job of replacing the title bar and the app never took it. The fix belongs in `src/public/next/**`, not in `desktop/`.
- **The native title bar is forced dark** (`nativeTheme.themeSource = 'dark'`), so a user who switches the app to its light theme keeps a dark strip. Making it track the app needs a `<meta name="theme-color">` that `applyTheme()` updates — an app-CSS/JS change.
- **The menu is a real one now**, built from `desktop/lib/menu.js` — App (About, **Check for Updates…**, Settings ⌘,), Edit, View, Window and Help (**Show Logs**). It shipped because Electron's default menu has **nothing in it that creates a window**, which is why ⌘W had to become hide-not-close, and why Window carries an explicit item naming the app: macOS's own window list cannot show a *hidden* window. **Nothing has ever displayed it** — Electron is not an offline dependency, `Menu.buildFromTemplate` has never seen the template, and a role name Electron rejects would pass every assertion and fail at launch.
- **The busy-quit path has never run against a real write.** The `quit` branch was exercised end to end; the `ask` branches have only ever been exercised as pure functions.
- **The MCP launcher escapes the usual test isolation.** `getMcpLauncherDir()` has its own seam, `CURATOR_TEST_MCP_LAUNCHER_DIR`; the documented pair (`CURATOR_TEST_USER_DATA_DIR` + `CURATOR_TEST_DOMAINS_DIR`) does **not** cover it, so a bundle-mode test run writes into the real user-data `bin/` directory unless all three are set.
- **No first-launch adoption of an existing repo install.** The app starts empty and waits to be pointed at a folder; the affordance for that is Domains → **Use existing folder**. What v3.32.0 *did* add is one level down: `setup()` **adopts** a sibling sync repository governing the same domains folder rather than creating a second one over it. Two servers writing that folder at once is still unguarded — `requestSingleInstanceLock()` covers desktop-vs-desktop only.
- **No tray icon has ever been rendered.** `new Tray()` has never been called on any machine, so nothing about how macOS actually treats the glyph, the `sublabel`, the tooltip or `mouse-enter` is proven — only the data those calls would be handed. `tray-only` recognises the mode and deliberately does **not** hide the Dock icon, because the accessory→regular return transition is reported buggy and cannot be tested here.
- **The pulse strip and the recency dots have now been drawn by AppKit — once, in light appearance.** A 2× capture on 2026-09-02 settled that Electron accepts a `MenuItemConstructorOptions.icon` of these dimensions, that it does **no scaling whatsoever** (the strip measured 55.0 points against its declared `widthPoints: 55`, which is what makes the width arithmetic above a measurement), and that macOS leaves a **non-template colour** image alone. What that capture did **not** settle: the **dark** palette, the inverted highlighted row, and whether the 2× representation is picked on a retina display. It is one capture of one fixture in one appearance, and the empty-store and truncation states have still never been seen. `main.js`'s wiring of them is source-scanned only, and the suite says so in its own headings.
- **Neither section header has ever been drawn, and neither has the appearance switch.** `type: 'header'` is in Electron 43.5.0's accepted `type` union, so `Menu.buildFromTemplate` cannot throw for it on any macOS — but whether macOS 14 draws a real section header, and whether macOS 13 degrades it to the dimmed inert caption the fallback is designed around, are both unobserved. So is whether `subscribeNotification('AppleInterfaceThemeChangedNotification')` fires on a real appearance change; what *is* measured is only that the two `nativeTheme` answers cannot be trusted while `themeSource` is pinned.
- **A hover does not re-time the pulse strip.** Row ages are re-derived at the render clock; the strip's buckets are anchored to the read that produced them, so a strip rendered from a held snapshot is a still frame of that moment. Invisible at a 6-hour bucket width and bounded by the 5-minute fallback, but it is a real asymmetry between two things drawn on the same menu.
- **The menu bar setting is discoverable only in Settings.** The design pass recommended offering it once, in the Agent memory view, at the moment a project has accumulated work, with a `ui.*` dismissal field. Neither the offer nor the field exists, so a user who never opens Settings never learns the feature is there.
- **The standing brief's age reaches only the hover tooltip.** `trayToolTip()` appends *"· Brief · 6 weeks ago"* to the icon's tooltip, and only when the age is actually known — a brief whose age could not be derived contributes nothing rather than *"Brief · time unknown"*. It gets no menu row, which follows the design's Tier-C ranking; the richer surface is still Phase 2. A user who never hovers still has to open Agent memory for it.
- **A row click still lands on the project, not the scope**, because the scope picker inside the memory view carries no routing attribute to address.
- No crash reporting, no Windows and no Linux. An About panel now exists (`lib/app-version.js`).

---

## LLM provider selection (`src/brain/llm.js`)

The app selects a provider based on which keys are available and which one the user last activated. Keys are resolved by `config.js` with this priority: `.curator-config.json` (set via Settings UI) takes precedence over `.env` (developer fallback).

With **both** keys stored, the winner is **not** Gemini-by-default — it is `activeProvider` in `.curator-config.json`, read by `getProviderInfo()` via `getActiveProvider()`.

**Who may WRITE that field changed in v3.45.0.** It was *last-saved-wins* (v2.4.2–v3.44.0): every key save took the build lane, so pasting a key to try a model in chat silently moved the user's ingests — and their bill — onto a different vendor. It is now **derived**: a key save sets `activeProvider` only when nothing is active yet (the first key), and after that the only writer is `POST /api-keys/build-model`. Disconnecting the active provider hands the lane to the cheapest **measured** provider still connected, and says which. Nothing on disk changed — same field, same resolver — and the policy is one constant, `ACTIVE_PROVIDER_DERIVED` in `src/brain/config.js`, whose `false` value restores the old behaviour exactly.

```
Only one key set            →  that provider
Several keys set            →  config.activeProvider  (last saved / toggled)
Legacy config, no
  activeProvider field      →  first provider with a key, in provider order
                               (gemini → anthropic → openrouter)
activeProvider set but its
  key missing               →  falls through to whichever provider still has a key
Neither set                 →  Error on first LLM call

default models (DEFAULTS in llm.js):  gemini-2.5-flash-lite  /  claude-haiku-4-5  /  (none)
```

**The legacy ladder is append-only, and that is load-bearing.** It re-resolves configs written before `activeProvider` existed, so its order decides *retroactively* which provider an existing user is billed to. `openrouter` therefore sits **last**, reached only after both original providers have failed — i.e. only in cases that previously resolved to nothing at all. A pre-OpenRouter config cannot contain an OpenRouter key field, so every such config resolves byte-identically to before. Inserting anywhere earlier would silently move real users onto a different provider, and therefore a different bill, with no on-screen signal.

**Last-saved-wins had one exception: a provider that cannot build** — and that exception outlived the policy it was written against, so read this as the rule that survives rather than as how a key save behaves today. Under last-saved-wins (v2.4.2–v3.44.0) saving a non-empty key activated that provider *unless* it had no build-lane model, in which case the key was saved and the activation skipped, with the reason returned so the UI could explain why the active provider did not move. Under the derived policy (v3.45.0+, the note above) a key save reaches the activation question at all only on the **first** key, and every later move comes from `build-model` — but the guard itself is unchanged and still gates both paths. This closes a reproduced P0: a user with a working Gemini install who merely *saved* an OpenRouter key lost ingest, Health and Compile, because activation flipped to a provider with no resolvable model and the route that would have reported it swallows the throw in a `catch` commented "no key configured yet" — when a key *is* configured. The rule is deliberately the **class**, not the instance: **the app never activates a provider that cannot serve the build lane.**

**That class-scoping is now load-bearing rather than hypothetical, and the outcome is worth stating precisely.** OpenRouter gained measured build-lane models in this release, so the predicate it is asked now answers *yes* and **the exception no longer fires for OpenRouter** — an OpenRouter key is treated exactly as the other two are. (Since v3.45.0 that means it is SAVED and does not take the build lane unless nothing else holds it; see the note above.) Not one line of the guard needed editing to produce that, which is the payoff for writing it as a class. What remains is a live guard for the next provider wired up before its models are measured, and the `skippedActivation` array it returns is correspondingly **empty for every provider that ships today** — a consumer must treat it as a signal that may legitimately never arrive, not as a channel it can assume is exercised. **The predicate lives in the route layer and is INJECTED into storage, not computed there.** The question — *does a model resolve for this provider, and may it build?* — is `llm.js`'s to answer, and `llm.js` imports `config.js`, so computing it in `config.js` would need a cycle that a standing offline invariant forbids. `src/routes/config.js` already namespace-imports `llm.js`, so the predicate is defined there and passed to the two storage **mutators** as a callback. Two consequences of that shape are deliberate:

- **With no predicate supplied, nothing is activated.** The failure directions are wildly unequal: a skipped activation that should have happened is mildly annoying, *visible*, and undone by one click on the existing set-active control; an activation that should not have happened breaks the entire build lane with nothing on screen saying so. Defaulting to *activate* would make the P0 the default behaviour. A predicate that **throws** is treated as a refusal for the same reason.
- **Its own degradation is asymmetric on purpose.** The hard requirement is only that a non-empty model id resolves — precisely the mechanism that broke — which a long-standing export decides. The newer lane predicate is consulted when present; when absent, the answer falls back to *a model resolved, therefore it can build*, which is exactly the truth for Gemini and Anthropic. Making a missing export mean *cannot build* would silently stop either provider ever taking the build lane, a far worse regression than the bug being fixed.

The table above describes the **effective** key (config *or* `.env`). The **onboarding
wizard's trigger does not**: `checkFirstRun()` reads `hasGeminiKey`/`hasAnthropicKey`,
which come from `getApiKeys()` — `.curator-config.json` only. A `.env`-only install
therefore makes working LLM calls *and* shows the first-run wizard on every load.

Chat additionally supports a **per-chat provider override** (v3.0.11+) — `getProviderInfo(preferProvider)` honours it only when that provider has a key saved in Settings. Since v3.13.0 a per-chat **model** override rides alongside it (`getProviderInfo(preferProvider, preferModel)`), allow-listed the same way; see [Model selection](#model-selection-the-router-v3120--v3130) below.

The optional `LLM_MODEL` env var overrides the default model for whichever provider is active. It sits between the per-call override and the user's stored Settings choice in the precedence chain — see below.

`generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text', onWait = null, opts = {})` is the single function every LLM caller in the app goes through — `ingest.js`, `query.js`, `chat.js`, `compile.js`, `health-ai.js`, the Shared Brain modules. It handles the provider-specific API differences internally, plus retry/backoff (429/503) and the model-not-found fallback chain (see [model-lifecycle.md](model-lifecycle.md)). `onWait(message)` is an optional callback fired before each retry wait, used to stream a "Service busy — retrying in 9s…" message to the UI. **The return type is a bare string and must stay that way** — every `generateText` call site across `src/` and `mcp/` depends on it (enumerate them rather than trusting a count in prose; the function's own docblock puts the figure at ~18), which is why token usage and live deltas are both delivered out-of-band through `opts` instead. `opts` carries six additive, optional fields:

- `onUsage(payload)` (v3.0.16) — fired once per completed provider call with normalised `{provider, model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens}`, so a caller can track real spend without changing the function's bare-string return type.
- `cachePrefixChars` (v3.0.16) — Anthropic-only, the length of a stable leading portion of `userPrompt` to mark with a `cache_control` breakpoint (ignored by the Gemini branch, which caches implicitly; see [ingestion-pipeline.md §7.2](ingestion-pipeline.md#72--anthropic-claude)).
- `provider` (v3.0.11) — a per-call provider override for the chat model selector, honoured only when that provider has a key **saved in Settings**.
- `model` (v3.13.0) — a per-call model override (the chat composer's model dropdown). Narrowed to a non-empty string here and then allow-listed inside `getProviderInfo()`; anything not in `OFFERABLE_MODELS` for the resolved provider falls back to that provider's default rather than throwing. See [Model selection](#model-selection-the-router-v3120--v3130).
- `signal` (v3.4.0) — **an `AbortSignal`, and the entire mechanism behind "Cancel" on a batch ingest.** It is threaded queue → `ingestFile` → `generateText` → every provider client (both SDKs and the OpenRouter adapter, which additionally links it to its own request timeout); abort is checked *before* the retry ladder, the 429/503 backoff (`sleep()` is itself abortable) and the model-not-found fallback chain, so a cancel stops spending immediately rather than walking up to five more calls. Measured: 334 s → 63 ms. Omitting it leaves every code path byte-identical to the pre-v3.4.0 behaviour.
- `onDelta({type, text})` — **live output as the model produces it**, `type` being exactly `'content'` or `'reasoning'`. Chat is its only production consumer. Two rules make it safe, and both are documented rather than enforced: **the return value is authoritative and complete, and deltas are a preview of it** (a consumer *replaces* its draft with the return value and never appends — appending doubles the answer and loses the truncation note, which exists only in the return value), and **once one delta has been emitted the attempt is committed** — no retry, no fallback walk, because a second model's tokens appended to a first model's half-sentence is two voices in one answer. Every provider branch is a two-arm `if (emit)`, so a caller that passes no `onDelta` reaches byte-identical transports, request bodies and error handling. Full contract: [chat-streaming.md](chat-streaming.md).

For ingest calls, `responseFormat: 'json'` is passed, which enables Gemini's native `responseMimeType: 'application/json'` — this forces the model to produce structurally valid JSON even when the content contains markdown characters (backticks, quotes, backslashes) that would otherwise break parsing.

### Provider dispatch has a terminating `else`, and adding the third branch is what forced it

`callProvider` used to be a Gemini `if` followed by an **unconditional** Anthropic client construction reading a hardcoded Anthropic key. That was safe only because the provider resolution could not return a third value. The moment it could, an OpenRouter request would have been sent to Anthropic's API on the user's Anthropic key, returned a model-not-found, been classified as retryable by `isModelNotFound`, and **walked the Anthropic fallback chain — spending real Anthropic money while the user believed they were on a different provider.**

Dispatch is now `if / else if / else { throw }`, and the third branch and the terminating throw landed in the same change. The same binary-with-no-third-arm shape existed in the output-cap lookup (`provider === 'gemini' ? GEMINI_CAPS : ANTHROPIC_CAPS`, with `provider` unvalidated, so every unknown provider silently resolved to the Anthropic map) and was replaced by a `switch` returning `null` for a provider we do not dispatch to. This is the v3.10.1 finding — a two-armed conditional has no third arm, and the fall-through arm is whichever one happened to be written second.

The OpenRouter branch is an adapter over the provider's OpenAI-compatible endpoint. Two request-level preferences are sent on **every** call and both are load-bearing:

- **Provider fallback is off.** The aggregator's upstream fallback is on by default, so without this the model the user picked could be served by an upstream they did not pick, at a price the app did not quote.
- **Required parameters are enforced.** This is what stops an upstream **silently dropping** the JSON-mode request. A dropped structured-output request does not error — it returns prose, which surfaces as a parse failure several layers away with no indication of the real cause.

The request never carries a model-substitution list, which would be the same class of silent swap one rung up. Error classification is **structural** — on the numeric status, which the provider also mirrors into its error body — never a substring match, because this repo's own `/\b429\b/` once matched its own prose about "429 characters". Note that a `503` under these preferences means *no upstream met the required parameters*, an expected outcome of our own strictness rather than necessarily an outage, and it is named as such so a user is not sent to a status page for a request that will never succeed as written.

**Usage normalisation differs by provider and getting it wrong double-counts silently.** OpenRouter's prompt-token count **includes** cached tokens — the Gemini convention, not Anthropic's — so its normaliser subtracts, exactly as the Gemini one does. This is the same trap documented for Gemini in v3.0.16; it is restated here because the two providers it resembles disagree with each other.

### Per-provider transports, and the one emitter above them

`callProvider` opens by building **one** `emit = makeDeltaEmitter(opts.onDelta, opts.streamCommit)` and threading it into all three branches, rather than letting each branch build its own. That is what makes the commit marker inside it mean *"this logical call has shown the user something"* rather than *"this branch has"* — and it is where `type` is normalised to exactly `content`/`reasoning` and where empty deltas are dropped. `emit` is `null` when the caller passed no `onDelta`, and every branch is a two-arm test on exactly that.

| Provider | Non-streaming transport | Streaming transport | Content deltas | Reasoning deltas |
|---|---|---|---|---|
| **Gemini** | `generateContent` | `generateContentStream`, whose `{stream, response}` aggregate promise is rebuilt into the same `{response}` shape the non-streaming arm produces — so the truncation check, the usage report and the return below all read it identically | Yes | **No — impossible.** `@google/generative-ai` 0.24.1 has no notion of a thought part (the string `thought` appears **zero** times in its bundle) and the app never requests thoughts, so none arrive to be mislabelled as content. `@google/genai` is the successor and is where they are addressable; swapping it is its own release. |
| **Anthropic** | `client.messages.stream(...).finalMessage()` — **already streaming, unconditionally, since v3.0.1-beta.14** for an unrelated reason (see [model-lifecycle.md](model-lifecycle.md#anthropic-specific-notes)) | The same call, with additive `.on('text')` / `.on('thinking')` listeners attached *before* `.finalMessage()` starts draining. The transport does not change; `.finalMessage()` is still the only thing awaited | Yes | **Wired, but zero in practice.** Measured over 4 runs on `claude-sonnet-5`: a thinking block is genuinely returned, but `delta.thinking` is the **empty string** and the assembled block carries only a signature — Anthropic returns the deliberation *encrypted*. |
| **OpenRouter** | `createChatCompletion` | `createChatCompletion` with `stream: true` + `onDelta`; the adapter parses the SSE body itself and reassembles it into a non-streaming-shaped body for the same `parseChatCompletion` | Yes | **Yes — the only provider that delivers them today** |

The Anthropic row is why `makeDeltaEmitter`'s empty-delta drop is **load-bearing rather than defensive**: without it, every Anthropic call carrying a thinking block would emit a zero-length reasoning delta that shows the user nothing and **commits the call**, silently disabling the retry ladder and the fallback walk on the app's main Anthropic path. Full treatment in [chat-streaming.md](chat-streaming.md).

---

## Model selection: the router (v3.12.0 + v3.13.0)

Until v3.12.0 the app could run exactly one model per provider. v3.12.0 added the data layer — a measured catalogue, persistence and validation — and v3.13.0 wired the two UI surfaces onto it. This section describes how the router is built.

> **User-facing counterpart:** [user-guide.md §16b](user-guide.md#16b-choosing-your-ai-model). **Catalogue contents, measurements and the release checklist:** [model-lifecycle.md](model-lifecycle.md). This section deliberately does not repeat either.

### Two lanes: one model builds the wiki, chat chooses per call

The design principle the router implements, stated once:

> **One model builds your brain; you choose freely when talking to it.**

- **The build lane** — ingest, AI Wiki Health and Compile — runs on the **active provider** and that provider's resolved default model (its pinned selection, or `DEFAULTS[provider]` when nothing is pinned). It is **one setting, not three**, and not separately configurable per feature.
- **The chat lane** — a per-message provider *and* model override, honoured only when that provider has a key saved in Settings and the id is offerable for that provider. It has **no effect on the build lane**: it travels on one request body and is never written to config.

**The two lanes now also have two admission standards**, which is what adding an aggregator forced into the open. The build lane admits only models hand-measured against the real ingest outline prompt; the chat lane admits what a provider's live catalogue offers, after structural filtering, labelled as unmeasured. The reason is asymmetric consequence — a bad chat answer costs one visible answer, a bad ingest writes pages into the wiki permanently and was already paid for. Since v3.16.0 there is a **third** admission state between them: a user may promote an eligible chat-only OpenRouter model into the build lane by measuring it against their own wiki — badged apart from the hand-measured lane, and invalidated the moment the model leaves the eligible catalogue. See [the third lane](#the-third-lane-on-wiki-qualification-v3160) below. The full argument, including which parts of the original case against on-demand qualification still hold, is in [model-lifecycle.md → OpenRouter](model-lifecycle.md#openrouter--a-third-provider-whose-catalogue-moves-without-us).

**Where the chat lane's larger list comes from: `POST /api/config/openrouter/sync`.** OpenRouter is an aggregator whose catalogue changes without a release of ours, so the chat-lane overlay is **fetched on demand** rather than shipped. One route is the whole join, and the pipeline is:

```
POST /api/config/openrouter/sync   (guardConcurrent)
  └─ getApiKeys().openrouterApiKey ── absent ─> 400
     │  (read for truthiness only; OpenRouter's /models endpoint is public and
     │   unauthenticated, so no credential enters this path at all)
     ▼
  syncOpenRouterCatalogue()                                     [llm.js]
     ├─ fetchOpenRouterCatalogue()                 → records    [openrouter-adapter.js]
     │     zero records ⇒ throw OPENROUTER_EMPTY_CATALOGUE (see below)
     ├─ inject opts.now = new Date()               ← the impure boundary
     ├─ buildOpenRouterCatalogue()                              [openrouter-adapter.js]
     │     ├─ filterCatalogue()                    → eligible + funnel
     │     │                                                    [openrouter-eligibility.js]
     │     └─ openRouterRecordToSpec() per record  → specs (per-entry refusal)
     ├─ verify built.clockSupplied === true        ⇒ else throw, change nothing
     ├─ setOpenRouterCatalogue(specs)              → admitted / refused / superseded
     │     └─ defineOfferableModel({dynamic:true}) per spec
     └─ persistOpenRouterCatalogue()               → <user-data>/.openrouter-catalogue.json
```

Five properties of that path are load-bearing:

- **`guardConcurrent` is not copied for symmetry.** A successful sync replaces the catalogue and rebuilds the dynamic price and free registries wholesale, so mid-ingest it changes what `getProviderInfo` resolves for the next call and what `chargeForItem` prices the last one at. The route **409s while any write is running** — the same reasoning that guards `/api-keys/model` and `/api-keys/active`. The client-side disable is fail-open; the 409 is the real guarantee.
- **The key gate is config-scoped** (`getApiKeys()`, never `getEffectiveKey()`) — the v3.0.13 rule. A provider Disconnected in Settings must not be usable, whatever lingers in `.env`.
- **A failed sync leaves the previous catalogue intact.** `setOpenRouterCatalogue` is reached only after fetch *and* build have both succeeded, so a network error, a timeout, a cancel or an unreadable eligibility report all throw with the user's existing models still selectable. Clearing on failure would let one transient 503 read as *"OpenRouter no longer offers anything"*, on the screen where a user chooses what to spend money through.
- **An empty fetch is a failure, not an answer.** `fetchOpenRouterCatalogue` returns `[]` rather than throwing when the response body is not the shape it expects — correct there, since reporting what the provider said is its job. But an empty array flowing on into admission would wipe a working catalogue on an HTTP 200 with a changed body shape, and every layer would report success. OpenRouter publishing genuinely zero models is not a state that exists; a body we cannot read is.
- **The clock must be injected, and the injection is verified.** `openrouter-eligibility.js` is pure — no network, no filesystem, no `Date.now()` — so with no `opts.now` the expiry rule **abstains silently** rather than rejecting. Measured on the live catalogue: **194 eligible with no clock, 193 with one**, and the differing model expired three days later. Options are passed by string name, and a misspelt one degrades instead of erroring (this module has been bitten twice already: a misspelt `contextField` silently selected the *optimistic* field, and a malformed `expiration_date` raised zero risk flags). So `syncOpenRouterCatalogue` reads the module's own `clockSupplied` report back and **refuses the whole sync** if it is not `true` — tri-state, where a report that does not say is `null`, never `true`.

**Two-lane enforcement lives in three places, and only the first two are guarantees.** (1) `defineOfferableModel` **refuses** — never silently coerces — any `{dynamic: true}` spec whose `suitability` is not `'chat-only'`; refusal is per entry and counted, so a builder that mis-declares 300 entries finds out, where coercion would have admitted all 300 quietly demoted. (2) `setOpenRouterCatalogue` re-asserts the same property on the *built* entries and throws if one slips through. (3) The Settings row renders no *Use this* button on a chat-only model, so a user never clicks a control whose only outcome is the 400 that `POST /api/config/api-keys/model` would return. The third is a courtesy; the first two are why *"BUILD: hand-measured only"* is a structural claim rather than a convention.

**Persistence, and why boot is not a trusted load.** The admitted **specs** (not the built entries — those carry price getters that `JSON.stringify` would flatten into today's number, freezing a promotional price past its expiry) are written atomically to `<user-data>/.openrouter-catalogue.json`, resolved through `paths.js` and never inside `domains/` (Personal Sync's git work-tree — the v3.3.0 rule). It is a sidecar rather than a field in `.curator-config.json` because that file is the credential store: 538 bytes, `0600`, rewritten on every Settings save, and `sha256`-verified across live test runs precisely because it should not move for reasons unrelated to credentials. `restoreOpenRouterCatalogue()` runs once at module load of `src/routes/config.js` (imported by `server.js` during boot), wrapped in a `try` — a throw at module scope in a route file takes down every route in it, and a corrupt cache must cost a re-sync, never a boot. It feeds every stored spec **back through `setOpenRouterCatalogue`**, i.e. through the same admission with the same chat-only constraint, so a model that has since become inadmissible is dropped rather than grandfathered and a hand-edited file cannot promote itself into the build lane.

### The third lane: on-wiki qualification (v3.16.0)

A fetched entry is `chat-only` by construction, and the sync above can never promote one. The one route out of that lane is the **user measuring the model against their own wiki** — `src/brain/openrouter-qualify.js`, driven by `POST /api/config/openrouter/qualify`.

```
GET  /api/config/openrouter/qualify/estimate     (free, read-only, NOT guardConcurrent)
POST /api/config/openrouter/qualify              (guardConcurrent, SSE: start|run|done|stored|error)
  └─ preflightQualify()                                      [routes/config.js]
     ├─ getApiKeys().openrouterApiKey ── absent ─> 400
     ├─ isOfferableModel()            ── no ────> 400   (must be eligible NOW)
     ├─ isBuildLaneModel() && !isLocallyQualified() ──────> 400 (nothing to measure)
     └─ domain ── absent ─> largestDomainByIndex()  ── not a listed domain ─> 404
  └─ assembleProbePrompt(domain)                   READ-ONLY  [openrouter-qualify.js]
     ├─ pickProbeSource()  ── nothing readable ──> 400 QUALIFY_NO_SOURCE
     └─ < MIN_REALISTIC_PROMPT_CHARS ────────────> 400 QUALIFY_DOMAIN_TOO_THIN
  └─ qualifyModel()  → N × OpenRouterAdapter.createChatCompletion()
     └─ classifyResponse() → summariseRuns() → record
  └─ recordLocalQualification(record)  → <user-data>/.openrouter-qualifications.json
```

**Six decisions carry it.**

1. **The prompt is real or there is no measurement.** `assembleProbePrompt` builds the actual Phase-1 `buildOutlinePrompt` from the user's own domain — index, entity/concept inventory, and a source document from `raw/` — and **refuses** below `MIN_REALISTIC_PROMPT_CHARS`. The fixed scaffold is ~3,500 chars of a ~341,000-char prompt, so the realism lives entirely in the user's own material. It is assembled **once** and reused byte-identically across runs, so the runs are comparable to each other; re-assembling per run would let the date or a concurrent edit move the prompt underneath the measurement.
2. **It does not go through `generateText`, and that is load-bearing.** `getProviderInfo()` enforces the offerable allow-list and the build-lane gate, so a chat-only candidate — the only kind worth qualifying — would be silently demoted to the provider default, and the run would measure `DEFAULTS.openrouter` nine times under the candidate's name. `generateText` would also fold in the 429/503 retry loop and the fallback chain (confounding latency, spend *and* model identity) and convert `finish_reason: "length"` into a throw. So it drives the production adapter directly, first attempt only.
3. **Two traps decide whether the classifier is a measurement or a rubber stamp.** `parseJSON` erases the distinction being measured — it tries raw parse, fence-strip, then `jsonrepair`, and returns no provenance — so `classifyResponse` calls bare `JSON.parse` **itself** first and only then falls back. And *parses* is not *usable*: `jsonrepair` turns the bare text `not json at all` into a truthy string, so usability is decided by ingest's own `usablePageArray`, **imported** rather than re-implemented, and applied independently of the parse class.
4. **`isPassingRecord` (evidence) and `isRecordShaped` (persistence) are deliberately two functions.** The evidence rule is a measurement question and lives with the lane in `llm.js`; the shape rule is a persistence question and lives with the store. `openrouter-qualify.js` **re-exports** the predicate rather than redefining it — two copies of a money-relevant gate is the v3.2.0 shape, and the import direction is forced anyway (`openrouter-qualify.js` → `ingest.js` → `llm.js`, so defining it in the qualifier would close a cycle).
5. **`isBuildLaneModel` gains a second, separate disjunct.** The hand-measured clause (`suitability !== 'chat-only'`) is byte-unchanged; `isLocallyQualified` is its own clause. Widening one can never silently widen the other, and a locally-qualified model still reports `suitability: 'chat-only'` on the wire so the UI can badge *you measured this* apart from *we measured this*. `isLocallyQualified` additionally requires OpenRouter, still-offerable (**a live check, not a prune** — invalidation with no cleanup step that could be skipped), still `chat-only`, and `jsonRaw === null`: a local run may fill a gap in our knowledge, never overturn a negative finding of ours.
6. **`guardConcurrent` yes, `registerWrite` no.** A completed run can change what `resolveProviderDefault` returns for every subsequent ingest, Health scan and Compile — the same hazard `/api-keys/model` is guarded for, through a different door. But the probe writes no wiki page, and registering it would hold the process-wide write gate for up to an hour, blocking Sync, Update and Delete. The accepted consequence is named: a catalogue refresh started **during** a running qualification is not refused, and a concurrent ingest may 429 a run — which is recorded as `NOT_MEASURED`, neither a defect nor a pass.

**Cancellation is the connection.** There is no cancel endpoint and no run id: `req.on('close')` aborts the in-flight call. A cancel must be recognised **before** the error classifier runs (both our own `QUALIFY_CANCELLED` and the transport's `AbortError`, checked alongside `signal.aborted` because this repo has a recorded finding that an SDK abort error can carry `name: 'Error'`), or an aborted fetch is filed as a model *failure*. A cancelled run is never stored — persisting it would overwrite a real earlier measurement with a stub.

**Persistence mirrors the catalogue sidecar.** `<user-data>/.openrouter-qualifications.json`, atomic, through `paths.js`, never inside `domains/`. One record per model — a re-run **replaces** its predecessor, because keeping both and taking the best would let a user re-roll until a failing model passed. A **defect** record is stored too, deliberately. `restoreLocalQualifications()` runs at boot in its **own** `try/catch`, separate from the catalogue restore, so one corrupt cache cannot cost the user the other; malformed records are dropped rather than repaired, and every survivor still has to clear the live predicate. One consequence follows from the ordering: **if the catalogue sidecar is missing at boot, a pin to a locally-qualified model is no longer offerable, so the lane predicate answers no and the pin falls back to a hand-measured model** — the fail-safe direction, restored by a refresh.

**One ordering consequence worth recording.** `listOfferableModels(provider)` is the documented accessor, and for OpenRouter it merges the static table with the dynamic overlay. Both halves are internally cheapest-first, but *a concatenation of two ordered lists is not ordered* — after a sync, ~190 entries sat behind the static three in the provider's arbitrary API order, which made the picker's `cheapest` badge (computed as index 0) correct only by accident. The merge therefore sorts, and it sorts **here** rather than at admission, because `setOpenRouterCatalogue` only ever sees the dynamic half and a second sort would be the v3.2.0 two-hand-maintained-copies shape.

**The coupling is structural, not conventional.** The build-lane call sites do not merely decline to pass an override — most of them have no parameter to pass it through. Every LLM call in the app enters `generateText(systemPrompt, userPrompt, maxTokens, responseFormat, onWait, opts)`, and only the sixth parameter can carry `provider` / `model`:

| Entry point | Arity at the call site | Can it express a model override? |
|---|---|---|
| `health-ai.js` — **five** calls | 4 positional args (no `onWait`, no `opts`) | **No — inexpressible.** There is no argument to pass. |
| `compile.js` — via the `opts.generateText` test seam | 5 positional args | **No — inexpressible.** |
| `query.js` | 3 positional args | **No — inexpressible.** |
| `diagnostics.js` (live API check) | 4 positional args | **No — inexpressible.** |
| `sharedbrain-delta.js` / `sharedbrain-synthesis.js` | 4 args via an `llmFn` wrapper | **No — inexpressible.** |
| `ingest.js` — two calls | `opts` present, carrying `onUsage` + `signal` only | Expressible, **not passed**. |
| `chat.js` | `opts` carrying `provider`, `model`, `onUsage` | **Yes — the only site that does.** |

So **Health cannot diverge from ingest**, and no future edit inside `health-ai.js` can make it diverge without first adding two arguments that do not exist there today. Compile resolves identically and for the same structural reason. Ingest is the one build-lane site where an override is *syntactically* possible, and it is the site where a mid-run change is most harmful — which is why the protection there is the route-level `guardConcurrent` described below, not a call-site convention.

`health-ai.js` also calls `getProviderInfo()` with **no arguments**, six times, purely to price its cost estimates. That is the same resolution the call it is estimating will perform, so the estimate and the call can never disagree about which model is being paid for.

### The build-lane resolution chain

With no override passed, every build-lane call resolves identically:

```
generateText(sys, user, maxTokens, format)          // opts absent → no provider/model
  └─ callLLM(..., providerOverride = null, opts)
       └─ getProviderInfo(null, null)
            ├─ resolveProviderDefault(null)
            │    └─ getActiveProvider()             // config.activeProvider (derived; v3.45.0)
            │         └─ defaultModelFor(provider, process.env.LLM_MODEL)
            │              ├─ envModel  →  return it                     (dev escape hatch)
            │              └─ applyModelOverride(provider,
            │                     DEFAULTS[provider],
            │                     storedSelection(provider))             (the user's pin)
            └─ applyModelOverride(provider, <that>, preferModel = null)  // no-op on first line
```

Two details this makes visible that the flat precedence line below does not:

- **`applyModelOverride` is applied twice**, at two different rungs — once inside `defaultModelFor` against the *stored* selection, once inside `getProviderInfo` against the *per-call* one. Both applications enforce `isOfferableModel`, which is why a stored id that later stops being offerable is refused on **read** and falls back, rather than being honoured forever because it was valid when written.
- **The provider is decided before the model.** `resolveProviderDefault` picks the active provider, and only then is *that* provider's stored selection consulted via `storedSelection(provider)`. A pin recorded against the **other** provider is therefore inert until that provider becomes active — it is stored per provider, not globally, and `selectedModels` is a map keyed by provider for exactly this reason. This is the single most likely user-facing surprise in the whole router, and it is documented as such in [user-guide.md §16b](user-guide.md#16b-choosing-your-ai-model).

### The lane is a predicate, and it used to be only a badge

`isBuildLaneModel(provider, modelId)` answers *may this model be the one that builds the wiki*. It derives from `suitability` and nothing else, so exactly one place decides a model's lane, and it shares `findOfferableModel` with `isOfferableModel` so the allow-list still has exactly **one** scan — a second `list(...).find(...)` here would be a hand-maintained copy of the membership test.

It exists because `suitability: 'chat-only'` was, until this release, **read in exactly three places, all badge rendering**. Nothing enforced it. The pin route gated on `isOfferableModel` plus a saved key, so a model measured as emitting unrepairable JSON in 2 of 9 real ingest runs could be pinned as the build model, and the app accepted the click while the badge on the same screen said not to. Enforcement is at two layers, and both are needed:

- **The pin route refuses** (`400`, naming the model, saying it stays available in chat) — so the user gets an actionable reason rather than a silent no-op that reads as a broken control.
- **`defaultModelFor` refuses on read**, via `applyModelOverride(..., requireBuildLane = true)` — because a chat-only pin may already be on disk from before enforcement existed, and because a model can be re-classified `chat-only` *after* it was validly pinned. Write-time validation alone leaves both cases honoured forever.

The per-call chat override passes no such flag and is unaffected. Failure is closed and cheap: unknown provider, unknown id or non-offerable id all return `false`, and `false` resolves to the provider default — the cheapest model on that provider — so a false negative can only ever spend *less*.

### `OFFERABLE_MODELS` is a frozen capability record, and it cannot be incomplete

`OFFERABLE_MODELS` (in [`llm.js`](../src/brain/llm.js)) is a frozen per-provider table, ordered cheapest-first on the **standard** price within each provider. For a provider whose catalogue is fetched at runtime it is a **partial view** — see [the overlay](#the-live-catalogue-is-an-additive-overlay-never-a-mutation-of-the-frozen-table) below — so consumers read `listOfferableModels(provider)`, never the table directly. Entries are not written as object literals — they are built by `defineOfferableModel(provider, spec)`, which **throws at module load** if:

- any measured field is missing or the wrong type (`thinks`, `tokenizerFactor`, `suitability`, `note`, `label`, `id`);
- it has **no known price posture** — meaning neither a price nor an explicit free-model declaration (see below);
- it has no resolvable output ceiling — either an entry in its provider's output-cap map (`ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS` / `GEMINI_MODEL_MAX_OUTPUT_TOKENS`) or one carried on the entry itself;
- it is `'general'` or `'caution'` and is missing a measured `jsonRaw`, or has tiered pricing (both **lane-scoped** — see the two notes below).

**A model that is not fully specified therefore does not merely fail a test — it fails to exist.** That is the structural half of "a model may not be offered for a feature it has never been measured against": a convention can be forgotten, a module-load throw cannot. For the static tables the throw is a developer-time tripwire, unreachable in production by construction; for a dynamically-admitted entry it is a live per-entry refusal (below).

**Two requirements are lane-scoped, and the scoping is the point.** `jsonRaw` records whether a raw parse of the *ingest outline* succeeds without the repair pass. It is a measurement of JSON-mode ingest behaviour and is **meaningless for chat**, which is text mode — so requiring it of a chat-only entry would force whoever admits one to invent a boolean about something they never measured, the precise failure the factory exists to prevent. A chat-only entry may omit it and carries `null`, meaning *not measured*, never `false`, which would read as *measured bad*. Everything a build-lane entry had to carry before, it still carries. Likewise a model whose rate changes above a prompt-size threshold is refused as `'general'`/`'caution'` **structurally**, and may only be admitted chat-only (see [Tiered pricing](#tiered-pricing-and-free-models-two-shapes-a-single-price-pair-cannot-express) below).

For statically-admitted entries, price and ceiling are **derived** from those tables rather than re-typed into the entry, so there is no second copy to drift — two hand-maintained copies of one fact is this repo's named cause of the v3.2.0 CRITICAL, and here the fact is a number a user makes a spending decision from. `input`/`output` are defined as **getters**, not snapshots, so a promotional price that expires mid-process resolves correctly on the next read (`JSON.stringify` invokes them, so the route serialises plain numbers).

### The live catalogue is an additive overlay, never a mutation of the frozen table

An aggregator's catalogue is hundreds of models and moves without a release of ours, so its chat-lane entries are admitted **at runtime** from the provider's public API rather than hand-typed. Three properties keep that from weakening anything:

- **The frozen table stays frozen.** The runtime catalogue is a separate list, and `listOfferableModels(provider)` is the accessor that concatenates them. The hand-measured build-lane entries can therefore never be replaced by something fetched over the network; the overlay can only **add** chat-lane offers.
- **Every fetched entry goes through the same admission function** as a hand-measured one, so it must still carry a label, a `thinks` verdict, a price posture, an output ceiling and a note, or it does not become an offer.
- **Refusal is per entry, not all-or-nothing.** One malformed record in a large response is dropped with a stderr line and the rest are admitted — refusing the lot would hand a third party a switch that disables the feature. (stderr, never stdout: this module is imported by the MCP child process, which reserves stdout for JSON-RPC frames.)

Empty until something populates it, so the module's default state is *this provider offers nothing*, which is what makes a partially-wired provider harmless. Two things populate it today, and both go through the same admission: `POST /api/config/openrouter/sync` on a user's explicit refresh, and `restoreOpenRouterCatalogue()` at boot from the persisted sidecar.

**Every consumer must read the accessor, not the frozen table.** `src/routes/config.js` routes both its call sites — the picker serialiser *and* the build-lane check — through one helper for this reason. The two could defensibly differ (reading the static table fails **closed** for a build pin but fails by **hiding** for the picker), and they deliberately do not: an accidental asymmetry and a deliberate one are indistinguishable six months later, which is how this repo's comment-contradicts-code defects start.

### Tiered pricing and free models: two shapes a single price pair cannot express

The app's price model is one `{input, output}` pair per model, and every consumer assumes it — the estimator, `chargeForItem`, `compareModelCost`, and the composer's mirrored copy of the charge formula that a 126-case suite pins to exact-dollar equality. Two real shapes in an aggregator's catalogue break that assumption in opposite directions, and both are handled by refusing to encode them as a number rather than by threading a new one through the whole money path.

**Tiered (long-context) pricing.** Some models change rate above a prompt-token threshold — a common case doubles both rates above 200,000 prompt tokens. This resembles the promotional-price trap and is arithmetically worse: a promotion expires on a **date**, which is knowable in advance and resolvable by clock, whereas a tier fires on the **size of the request** — and the requests that cross it are precisely this app's large ingests, where a user spends most. A flat entry would quote half the real rate there, on a spend surface, and **no ordering assertion would notice**, because array order survives a doubling: this project's named "green over a wrong number" shape. So such a model is admitted **chat-only, structurally**. That is safe for a specific measured reason rather than by hope: chat's prompt is bounded (60 KB of content plus a 12 KB catalogue, on the order of 20k tokens) — an order of magnitude below the lowest threshold observed — so the flat rate quoted for chat is the rate billed. The build lane, the only lane that can cross a threshold, cannot reach these models.

**Free models.** `{input: 0, output: 0}` is the natural-looking encoding and the single most dangerous one available, because zero is **truthy**: `getModelPrice()` would return an object rather than `null`, the estimator's high bound would become 0, and `createJob`'s budget guard would **accept a `budgetUsd` it believes it can enforce** and then track spend at zero forever while every flag reported success — v3.3.0's inert-cap defect re-armed, and worse, because there the number at least moved. `compareModelCost` would answer `'similar'` where it has established nothing.

So a free model is recorded by **membership**, never by a price, and `getModelPrice()` keeps returning **`null`** for it. Every downstream consequence of that null is already implemented and already correct: `createJob` refuses a dollar cap it cannot price (a dollar cap on a free model is meaningless), `chargeForItem` flips its estimated flag, and cost readouts render **nothing** rather than `$0.00` — the v3.14.0 rule that a figure is reported or absent, never inferred. The dynamic price registry enforces the same rule from the other side: it refuses a non-positive or non-finite figure outright, and refuses to shadow a statically-priced id, so the two price sets are disjoint by construction and a fetched number can never override a hand-verified one.

**Identify free by the id, never by the price being zero.** In the live catalogue the sets do not coincide — a small number of zero-priced ids are not free-tier models, and one is a router whose real price is unknown until it has routed. `test-chat-model.js`'s assertion that every entry in the static price table is strictly positive on both axes is what makes the zero-price encoding structurally unavailable; it must not be weakened.

The entry shape is a **public contract**: `src/routes/config.js` serialises entries verbatim onto `GET /api/config/api-keys` → `offerable`. Fields may be added; renaming or removing one is a wire-format change.

### The allow-list has exactly one application point

`isOfferableModel(provider, modelId)` is the predicate. It is applied **inside `getProviderInfo()`** — the single producer of the model string every SDK and adapter receives — and nowhere else.

That placement is deliberate and load-bearing. There are seven other entry points into `generateText` (ingest, compile, chat, query, health-AI, shared-brain, diagnostics); validating at a route would leave every other one open **and** create a second hand-maintained copy of the guard, which is exactly the shape that produced the v3.2.0 CRITICAL. The route (`POST /api/config/api-keys/model`) does call the predicate, but as a **read of the same function** to give the user an actionable 400 — not as a second implementation, and not as the only gate.

The lookup is an array scan comparing with `===`, so `'__proto__'`, `'constructor'` and `'toString'` are structurally unable to resolve to anything: no object is ever indexed by the caller's string. `normalizeChatModel` in `chat.js` deliberately adds **no** object lookup of its own so it inherits that property by construction rather than by remembering an `Object.hasOwn` call.

### Five model-producing sites, and they are not uniform

`getProviderInfo(preferProvider, preferModel)` delegates the provider decision to `resolveProviderDefault(preferProvider)` and then applies `applyModelOverride` to the result. Between them, five sites produce a default model id:

| Site | How it treats `LLM_MODEL` |
|---|---|
| `resolveProviderDefault` → `getDefaultModel(preferProvider)` (per-call provider override branch) | **Gated on the active provider** — `LLM_MODEL` is only used when `getActiveProvider() === provider`, so Gemini is never labelled with a Claude id. |
| `resolveProviderDefault` → `defaultModelFor(provider, process.env.LLM_MODEL)` × 4 (active-Gemini, active-Anthropic, and the two defensive key-present fallbacks) | **Ungated** — the raw env value is passed through regardless of which provider resolved. |

This asymmetry **pre-dates** the multi-model work and is deliberately *not* fixed by it. The entire safety claim of v3.12.0 is that nothing moves for a user with nothing stored, and `applyModelOverride` returns `defaultModel` on its first line when there is no stored selection — so every call site is byte-identical to the pre-v3.12.0 expression for such a user. Changing the `LLM_MODEL` semantics here would break that claim in the same change that makes it.

### Resolution precedence

```
per-call preferModel  >  LLM_MODEL  >  stored selection  >  DEFAULTS[provider]
```

- **`preferModel` first** — it is applied by `applyModelOverride` *last* inside `getProviderInfo`, so an explicit user choice in the composer outranks everything. A developer who set `LLM_MODEL` would be surprised to find it silently overriding a selection just made in the UI.
- **`LLM_MODEL` beats the stored selection** because the two occupy the *same slot*: both reshape the provider default. `LLM_MODEL` is the unrestricted developer escape hatch — it deliberately bypasses the allow-list — and letting a Settings click override it would remove the escape hatch and make it untestable.
- **Stored selection beats `DEFAULTS`** — that is the whole feature.
- **`DEFAULTS` last** — and `DEFAULTS[provider]` is the head of `OFFERABLE_MODELS[provider]`, i.e. the cheapest model on that provider. This is what makes every fallback direction below safe on money.

### Refusal is a fall-back, never a throw

`applyModelOverride` returns the provider default — never throws — when the requested id is not offerable. Three distinct cases resolve that way:

| Case | Result |
|---|---|
| Stored selection names a model that is no longer offerable (we pulled it after a bad live probe) | Provider default. Throwing would hard-fail every chat *and* every ingest for that user until they noticed a picker somewhere. |
| Stored selection belongs to a provider whose key is no longer **saved in config** | `storedSelection()` returns `null` before the allow-list is even consulted → provider default. |
| Per-call override is invalid | **Falls back to the user's STORED selection**, not to `DEFAULTS` — because `applyModelOverride` is applied on top of the already-resolved provider default, which has the stored pick baked in. Dropping to `DEFAULTS` would silently demote a user who deliberately paid for a better model. |

A fourth case was added by the build-lane predicate: a **stored `chat-only` pin** resolves to the provider default when the build lane asks, and is honoured unchanged when chat asks.

Every one of these resolves toward the **cheapest** model at worst, so a refusal can only ever spend *less* than the user asked for.

**The one case that throws instead is a provider with no default at all.** Falling back presumes there is something to fall back *to*. Every provider now carries a pinned default — OpenRouter included, as of this release — so this branch is **unreachable in the shipping configuration**, and it is kept deliberately as the guard that makes wiring a fourth provider safe: if one is ever added before a build-lane model has been measured for it, resolving it for the build lane with no per-call override produces no model to send. `getProviderInfo` refuses there — the only correct place, since it is the single producer of the model string — rather than putting an empty model on the wire and converting a configuration problem into an opaque provider error several layers away. The message is worded to avoid **every** substring the recovery classifiers key on (no *output token limit*, no *not found*, no 429/503/overloaded), so it cannot be mistaken for a recoverable condition, retried four times with backoff, or used to walk a fallback chain. This mirrors `normalizeChatProvider` (invalid provider → `null` → global) and `anthropicMaxOutputTokens` (unknown id → conservative cap). A caller that needs to know a refusal happened compares: `getProviderInfo` returns the model it actually resolved, so `result.model !== requested` is the signal. The return shape is unchanged — `{provider, model}` is destructured at roughly 15 call sites across `src/` and `mcp/`.

`chat.js` goes one step further and reports the model that **answered** rather than the one requested, taken from the last `onUsage` payload. That covers both an allow-list refusal *and* a fallback-chain walk; re-resolving through `getProviderInfo` would see the first and be blind to the second, and the walk is where the number matters most because it can move the user onto a *costlier* model.

### Three lists, three meanings

| List | Meaning | Consequence |
|---|---|---|
| `RETIRED` (in `scripts/test-chat-model.js` §9) | The id **404s**. | Banned everywhere. Shipping it does nothing at all. |
| `DOMINATED_MODELS` | The id **works** and is honestly priced, but a **same-priced** sibling measured better on every axis tested. | Banned from `FALLBACK_CHAINS`. **Allowed** in `OFFERABLE_MODELS`, flagged. |
| `AWAITING_MEASUREMENT` | A real, documented, priced-by-the-provider model that has **never been probed** against the real ingest prompt. | Not offerable, not a default, not a rung, and carries **no** price entry. All four asserted. |

`AWAITING_MEASUREMENT` exists because the measurements are genuinely not predictable from a model's lineage: `claude-opus-5` was released *after* `claude-sonnet-5` and runs no hidden reasoning at all (0/3), while `claude-sonnet-5` ran adaptive thinking on every call (7/7). Two models one release apart, opposite behaviour — so for any unprobed id, `thinks` is unknown, and guessing there is guessing about billed output tokens.

### `FALLBACK_CHAINS` and `OFFERABLE_MODELS` are different lists with different rules

This is the reason `DOMINATED_MODELS` exists as a separate concept rather than a single ban:

- **A fallback chain picks *for* the user, silently, on the worst possible day** — their pinned default has just been retired. A dominated rung there is indefensible: nobody chose it, nobody was told, and the chain's documented promise is *"the cheapest model that still works"*.
- **The offerable catalogue is the user choosing deliberately, with the measured reason on screen.** Hiding a working model there would be deciding for someone what they may spend their own API key on.

So `DOMINATED ∩ FALLBACK_CHAINS = ∅` (asserted), while `DOMINATED ⊆ OFFERABLE` is fine. The founding entry, `gemini-3.5-flash-lite`, is *in* the catalogue (flagged `chat-only`) and *out* of the Gemini chain, for exactly this reason.

### Promotional pricing: two tables, resolved by date

`MODEL_PRICES_USD_PER_MTOK` holds the **standard (post-promotional)** price. `PROMOTIONAL_PRICES` holds the discount with an **inclusive, UTC-pinned** expiry (`untilMs`) — a promotion is a published calendar fact, not a local-time one, so parsing it in the machine's timezone would make two users disagree about the price for up to a day.

`resolveModelPrice(id, atMs)` applies the discount only while it is live; `getModelPrice(id)` is that at `Date.now()`, so every pre-existing consumer (health-AI estimates, the ingest queue's spend arithmetic, the fallback cost banner) became date-correct with no signature change. `resolveModelPrice` is exported specifically so the offline suite can assert **both** sides of a boundary today — a guard that can only be exercised on the day it matters is a comment, not a guard.

**The structure makes the standard price the base and a promotion a narrowing exception applied on top**, so the ways this can break degrade to the HIGHER figure: a dropped promotional record, an id typo'd in `PROMOTIONAL_PRICES`, or a clock that has run past the expiry all yield the standard price. (A non-finite `atMs` is the one input that resolves to *now* rather than to standard — deliberately, because a bad clock must not take down an LLM call.) This matches the direction the repo already takes on money (v3.9.0: an unrecognised cost tier resolves to `unknown`, never `similar`). A user quoted *more* than they are billed picks a cheaper model than they needed; a user quoted *less* was lied to.

### Persistence: `selectedModels` in `.curator-config.json`

`src/brain/config.js` owns storage and does **no** validation against `OFFERABLE_MODELS` — deliberately, and for two reasons. First, `llm.js` imports `config.js`, so importing back would be a cycle. Second, and more important: **a stored id can stop being offerable *after* it was validly written** (we pull a model after a bad live probe), so validating only at write time would leave the stale value honoured forever. The allow-list is applied on the **read** side, which is where it has to be anyway.

- `getSelectedModel(provider)` → the stored id or `null`, read **fresh per call** through a sanitiser that drops non-string / prototype-shaped entries.
- `setSelectedModel(provider, modelId)` → persists, or **clears** on empty/null. It rebuilds the stored map from the sanitised view rather than mutating what was on disk, and deletes the key entirely when nothing is selected — so a user who never picks a model keeps a config file byte-identical to before the feature existed. Writes through the same `writeFileAtomicSync` at mode `0600` that every other field in that file uses (it holds the API keys; a second writer that forgot the mode would silently widen them).

**Nothing is snapshotted at module load.** `storedSelection()` in `llm.js` and `getSelectedModel()` in `config.js` both resolve per call, so a Settings change takes effect on the *next LLM call* without a restart — and a module-level snapshot would additionally defeat the `paths.js` test seams for anything importing the module early.

### Config-scoped key gating, at both ends

Both the read side (`storedSelection()` in `llm.js`) and the write side (`POST /api/config/api-keys/model`) gate on `getApiKeys()` — the **saved Settings keys** — and never on `getEffectiveKey()`, which also sees `.env`.

This is the **v3.0.13 rule**, and it is not cosmetic here. `resolveProviderDefault` selects a *provider* off `getEffectiveKey`, so a provider whose key the user Disconnected in Settings can still resolve from a lingering `.env` key. Honouring the model they picked *before* Disconnecting would be the v3.0.13 bug in a new place — a setting the user believes they removed still steering their spend.

Because both ends gate the same way, the contract is closed: you can only *store* a selection for a provider whose key is saved, and it is only *honoured* while that key remains saved. A Disconnect cannot leave a live orphaned selection. `GET /api/config/api-keys` applies the same gate to `offerable` and `selectedModels`, so a Disconnected provider reports an empty catalogue and a `null` selection — the UI must never show a selection the engine has stopped obeying.

### `guardConcurrent` on the model route

`POST /api/config/api-keys/model` carries `guardConcurrent('change the AI model')`. This is not symmetry with its `/active` sibling — it is the sharpest instance yet of v3.6.0's "config mutation mid-write" class. Because the stored selection is consulted **fresh on every LLM call**, and a multi-phase ingest makes 20+ calls over several minutes, an unguarded click mid-ingest would:

1. plan the outline on one model and write Phase-2 batches 3..11 on another — v3.6.0's *"silently finish it on a different model"*, verbatim;
2. **invalidate Anthropic's prompt cache mid-run** — a different model is a different cache namespace, so every cached prefix READ becomes a WRITE at 1.25×, inverting the v3.0.16 saving into a surcharge;
3. make the ingest queue's per-item spend arithmetic wrong, since price is looked up per model.

The `/next` Settings UI disables the pick buttons while any write is running, but that is the **second** layer — the 409 is the real guarantee. Note the chat composer's dropdown needs no guard at all: it writes no config, it only adds `model` to one request body.

### The two surfaces

| Surface | Mechanism | Scope |
|---|---|---|
| `views/settings.js` → `renderModelPicker` / `renderModelOption` | `POST /api/config/api-keys/model` | Durable, server-side. Governs ingest, Health AI, Compile and chat. |
| `views/chat.js` → `renderModelMenuHtml` / `renderModelOptionHtml` | `model` field on the `POST /api/chat/:domain` body → `normalizeChatModel` → `generateText(..., { model })` | Chat only. Persisted in `localStorage` (`curator-next-chat-model`), so it is per-browser and sticky across conversations — **not** per-conversation. |

**Stickiness is a decision, and it is only defensible because of the per-message model label.** A selection restored on load and never reset is a selection a user can forget they made; unlabelled, that is silent overspend. It is tolerable here on two grounds. First, magnitude: the chat lane bills cents per message, where a forgotten *build-lane* pin bills across a whole ingest — which is precisely why the build lane makes its pin visible in Settings with a marker rather than restoring it invisibly. Second, and load-bearing: **the model of record is stamped on the message, taken from the provider's own usage payload** (see [Refusal is a fall-back](#refusal-is-a-fall-back-never-a-throw) above), so the thread itself reports what ran on every turn. A message with no recorded model renders the neutral provider name and **never** the composer's current selection — falling back to the live selection there would re-create precisely the dead-data shape the recorded field exists to remove, and would relabel historical answers with a model that never saw them. Removing the label would therefore also remove the argument for keeping the selection sticky; the two ship together.

`note` — the measured finding, required on every offerable entry — is never paraphrased anywhere it appears. Settings still renders it **verbatim**, one click inside each model's own `<details>` rather than inline, since the OpenRouter overlay made nearly every fetched row flagged and an inline `note` on every row turned the picker into a wall of prose. The composer dropped it entirely: a `<details>` cannot legally nest inside its `role="option"` button, so there is no disclosure to put it behind. Both escape every interpolated field — the payload originates in `llm.js` but arrives over HTTP, and "the payload is ours" is not a property a render function can verify.

Both gate on the saved key **client-side as well**, via a lookup table rather than a `p.id === 'gemini' ? … : …` binary — that binary shape is what made a provider row render another provider's masked key in v3.10.1. An id absent from the table resolves to `undefined` and the whole list disappears, which is the safe direction.

The chat composer's localStorage key is deliberately **not** shared with the provider key (`curator-chat-model-provider`): one holds `'gemini'|'anthropic'` and the other a model id like `'claude-sonnet-5'`, and two different value *formats* sharing one key is how a stale value from the other writer gets applied as if it were ours. A restored model implies its provider, so the two can never be sent disagreeing.

### The one-line summary (`shared/model-summary.js`), and why it is derived, not hand-written

Both surfaces' collapsed rows carry a short line built by one function, `modelSummaryClauses`/`formatModelSummary` in `src/public/next/shared/model-summary.js` — the only place either surface composes a sentence about a model, so the two cannot drift the way `dominated`/`out-performed` once did. Every clause reads a structured field (`outlinePagesLow/High/Median`, `medianLatencyMs`) rather than parsing `note` prose, except `cautionReason`: a short hand-written string `defineOfferableModel` requires on any flagged entry, because the reason for a flag is a judgement, not a number, and it is the one clause that is never dropped — a warning behind a click is not a warning. A missing measurement omits its clause; it is never rendered as zero (`speedClause` treats anything under 1000ms as absent, since `formatDurationMs` would otherwise print "0s" for a measurement that was never taken).

The two call sites differ by one flag: Settings calls it plain (adds the outline-coverage clause), the composer calls it `{compact: true}` (drops coverage, keeps the warning and the per-call speed). Settings and the composer are different densities for the same data by design — a screen opened to manage models can afford more than a menu opened mid-turn — and the two are still tied to one vocabulary because they share this one builder.

### Search, sort and a measured-only filter (Settings only, above ~12 rows)

`filterModels`/`orderModels` in `views/settings.js` add a per-provider, session-only (never persisted) search box, a sort control (the shared `shared/listbox.js` component — the native `<select>` it replaced went in v3.18.0), and a "measured" checkbox (the shared `shared/checkbox.css` component since the checkbox pass), rendered only once a provider's list passes `MODEL_FILTER_MIN_ROWS` (12) — below that a filter bar is furniture. `MODEL_SORTS` is exactly `['cheapest', 'dearest', 'newest', 'largest-context']`; cheapest/dearest reuse the server's own price-sorted delivery order (reversed for dearest) rather than re-deriving a price comparison client-side, and newest/largest-context rank `createdUnixSec`/`contextLength` where present. There is deliberately no capability or "most capable" sort: `isCuratorMeasured` (reads `jsonRaw === boolean`, the marker for "we ran this against the real ingest prompt") covers roughly 19 of the catalogue's ~190+ entries, and a second qualification session on 2026-08-28 measured price, speed, recency and vendor each predicting the *opposite* of the real outcome on at least one model — a capability ranking over the unmeasured remainder would be a machine-written verdict dressed as data. A row missing a sort's key is never assigned one (0 and a fabricated date are both explicitly refused by `defineOfferableModel`); it keeps its delivered position and trails the ranked block, and the bar states how many.

### The chat wait clock (now a pre-roll)

**Its role narrowed when streaming landed, and the honesty rule did not.** This used to be the whole waiting state, on the premise that a chat turn is one non-streaming POST so time-to-first-byte *equals* total. That premise is now false: deltas arrive long before the answer is finished. The ring is now a **pre-roll** covering the gap before the first delta of any kind, after which the streamed text itself carries the liveness. What did not change is the rule — still no `stages`, still `value: null`, still activity-only with `role="progressbar"` and **no `aria-valuenow`**. Streaming gives a token *count*, which is not progress: `max_tokens` is a cap, not a forecast, and there is no denominator anywhere. The slow-turn notice below is additionally **suppressed on a streaming turn**, because `medianLatencyMs` is a total call time while the pre-first-delta clock measures time-to-first-byte — a different quantity, for which this project has no corpus. See [chat-streaming.md](chat-streaming.md).

`views/chat.js`'s "thinking…" bubble ticks up an elapsed-time counter (`thinkingBodyHtml`, one-second interval, module-level timer so it survives a re-mount and is provably clearable) — the same pattern `docs/ingestion-pipeline.md` records for ingest's v3.0.17 progress clock, after a maintainer picked the slowest model this app has ever measured (382s for one outline call), watched a bare spinner, and reported the app as hung. Past `SLOW_TURN_NOTICE_AFTER_MS` (20000), if `latencyHintForTurn()` resolves a `medianLatencyMs` for the model serving this turn, the bubble states it once as a measured fact ("measured at about Xm Ys per call in our testing"), never as a promise. For the roughly 176 catalogue entries with no latency figure it says nothing at all — the clock still ticks, because it is timing the real call, but no expectation is invented from price, size or another model's number.

### Per-answer cost: measured, priced by the served model, mirrored rather than shared

Each assistant message in `/next`'s chat carries a small cost fragment beside the model label already documented above (`assistantEyebrowHtml` → `assistantCostHtml`, both in `views/chat.js`).

**Where the token counts come from.** The source is the same `onUsage` callback documented under [LLM provider selection](#llm-provider-selection-srcbrainllmjs) — fired once per completed provider call from inside `callProvider`, carrying the normalised `{provider, model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens}` payload. `sendMessage` (`src/brain/chat.js`) captures that payload into `usedProvider`/`usedModel`/`usedUsage`, and `buildAssistantMessage` persists them onto the assistant message via `normalizeReportedUsage` — an ALL-FOUR-OR-NOTHING gate: any one of the four fields missing, non-finite or negative discards the whole record, because three of four numbers priced as if they were four is a confidently wrong figure that looks exactly like a correct one. The message (four raw token counts and the served model id — never a dollar amount) is written to `domains/<domain>/conversations/<id>.json` in the ordinary `writeConversation` call, so it survives a reload; see [Data flow: Chat](#data-flow-chat) below for the on-disk shape.

**Priced by the model that ACTUALLY answered.** `usedModel`/`usedProvider` are read out of the usage payload itself, never out of `chatModel`/`chatProvider` (what was requested) — the same rule [Refusal is a fall-back](#refusal-is-a-fall-back-never-a-throw) already documents for the label beside it. This is where it matters most: on a fallback-chain walk the requested rung 404s and a costlier rung answers, and pricing the request instead of the outcome would under-report the bill for precisely the turn the user did not choose.

**The formula is a deliberate mirror, not an import.** `messageCostUsd` in `src/public/next/views/chat.js` reproduces `chargeForItem` from `src/brain/ingest-queue.js` — the app's one other "what did these tokens cost" calculation, including both Anthropic cache multipliers (0.1× the input rate for a cached read, 1.25× for a cache write) — term for term. It is mirrored rather than imported because `ingest-queue.js` pulls in `fs` and `llm.js` and cannot run in a browser; a second, independently-written formula is exactly the two-hand-maintained-copies shape that produced the v3.2.0 CRITICAL. So the mirror is pinned rather than trusted: `scripts/test-next-composer-model.js` §11 points the same brace-matching function extractor this suite already uses on `chat.js` at `ingest-queue.js` instead, lifting out the real `chargeForItem`, and asserts the two agree to the last bit across **every entry of the live catalogue** crossed with nine token shapes. The model set is enumerated from the catalogue rather than hardcoded, and the suite reports the case count it actually ran — so a model added or repriced is covered the moment it lands, and this document does not carry a total that can silently go stale. A change to either formula alone goes red naming the case. The all-zero usage shape is deliberately excluded: it is the *provider reported nothing* sentinel, refused before the arithmetic runs, so it is the one input on which the two are expected to differ.

**The `{0,0,0,0}` sentinel, and why the two normalisers treat it differently on purpose.** `normalizeGeminiUsage`/`normalizeAnthropicUsage` (`llm.js`) each coerce a missing field to `0` via a local `num()` helper, so a provider response that carries no usage block at all — not a genuine report of zero — arrives as all four fields zeroed, indistinguishable from a real zero-cost call. `chat.js`'s `normalizeReportedUsage` refuses exactly this shape (`inputTokens === 0 && outputTokens === 0` → discard the record): a completed chat turn cannot have consumed zero input, because the prompt always carries the domain schema plus the selected wiki pages ahead of the user's message, so an all-zero report can only mean "the provider told us nothing." `llm.js`'s own normalisers deliberately do **not** apply that same refusal — those two functions also feed `ingest-queue.js`'s running `spentUsd` total, where `0` is the correct neutral element for an item that has not yet billed anything, and narrowing them here would move real accumulating-spend arithmetic in a change that is otherwise a chat-only label.

**Priced at render time, not frozen onto the record.** `entry.input`/`entry.output` (see `OFFERABLE_MODELS` above) are getters that resolve the live, promotion-aware price on every read; the persisted message stores only the four raw token counts and the served model id, never a dollar figure. The Chat view re-fetches its provider/model catalogue on every view entry, so the figure shown for a given message is priced against whatever that catalogue currently says the served model costs — which means an answer served during a promotion and re-read after the promotion's stated end date renders at the higher, standing price. That is the same fail-safe-upward rule already stated under [Promotional pricing](#promotional-pricing-two-tables-resolved-by-date): every direction a price calculation can fail resolves to the number that costs the user less to have believed, never more.

**One inherited approximation, not introduced here.** `chargeForItem`'s formula applies `price.input * 0.1` — Anthropic's cached-read discount — to `cachedReadTokens` unconditionally. Chat passes no `cachePrefixChars` breakpoint at all (only `ingest.js` does), so Anthropic never reports a cache write or a cache read for a chat call — but Gemini's *implicit* caching can still populate `cachedReadTokens` on a chat call, and Gemini's real implicit-cache discount is not 0.1×. This is a pre-existing approximation in `chargeForItem` itself, not something this feature introduced; fixing it only in the mirror would itself be the drift the mirror exists to prevent, so it is recorded here rather than quietly corrected in one of the two places it lives.

### Coverage

| Suite | What it pins |
|---|---|
| `scripts/test-chat-model.js` | Price/cap coverage for every shipped id and nothing beyond them; `RETIRED` ∩ everything = ∅; `DOMINATED` ∩ `FALLBACK_CHAINS` = ∅; `AWAITING_MEASUREMENT` unreachable four ways; cheapest-first ordering at both the promotional and the standard price; a promotion must be *strictly* cheaper than the standard price it precedes. |
| `scripts/test-selected-model.js` | Storage round-trip, clearing, sanitising, and the byte-identical-with-nothing-stored claim. |
| `scripts/test-offerable-models-route.js` | The wire shape of `offerable` / `selectedModels` and the config-only key gating. |
| `scripts/test-next-model-picker.js` | The Settings surface, including the provider-lookup class invariant. |
| `scripts/test-next-composer-model.js` | The chat composer surface, including §11's 126-case equality check between `messageCostUsd` and the real `chargeForItem`. |
| `scripts/test-next-model-fallback.js` | The fallback banner's three cost states. |
| `scripts/test-openrouter-model-layer.js` | The third provider's model layer: the build-lane predicate, price posture, the runtime catalogue overlay, and the structural refusals. |

---

## Data flow: Ingest

> **For the comprehensive technical deep dive** on the ingestion pipeline — every safeguard, every failure mode the code defends against, the full quality contract, Mermaid flowcharts, and the deep-test harness — see [docs/ingestion-pipeline.md](ingestion-pipeline.md). The summary below is the entry-point overview.

**Single file vs. batch (v3.3.0+):** selecting exactly one file uses the flow below, `POST /api/ingest`, unchanged since before v3.3.0. Selecting **two or more** routes instead to `POST /api/ingest-queue` — a separate, disk-persisted job that ingests each file through this same `ingestFile()` pipeline, one at a time. See [§ Batch ingest queue](#batch-ingest-queue-v330) below for that path.

```
User uploads file
      │
      ▼
POST /api/ingest  (multipart/form-data: file + domain)
      │
      ▼  multer saves to OS temp dir
src/routes/ingest.js  —  validates domain + file type
      │
      ▼
src/brain/ingest.js
      ├─ 0. Compute deterministic summary slug from the source filename     (v3.0.1+)
      │     computeSummarySlugFromSource('report.pdf') → 'report'
      │     summaryPath = 'summaries/report.md'
      │     This slug is FORCED into the LLM prompt, so re-ingesting the
      │     same source always lands on the same summary page → merges via
      │     mergeWikiPage instead of creating a duplicate file.
      ├─ 1. Copy file → domains/<domain>/raw/<filename>
      ├─ 2. Extract text (.txt/.md → readFile, .pdf → pdf-parse)
      │     If fullText.length > 80,000: truncate + push warning into the
      │     result.warnings array + emit a progress message + log it (v3.0.1+).
      ├─ 3. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 4. Load domains/<domain>/wiki/index.md. Sent to the LLM on the
      │     planning step (step 5, below) exactly as before v3.0.16 — an
      │     earlier draft of the v3.0.16 work removed it from those prompts,
      │     but that was reverted before release (see
      │     docs/ingestion-pipeline.md §1b for why). Also still read
      │     separately for the programmatic index merge at step 8.
      │     Also read the existing entity/concept filenames, sent to the LLM
      │     in FULL — capExistingFilesForPrompt (v3.0.16) is an inert safety
      │     valve, not a cost cap: it does not fire on any real domain
      │     measured so far. If a domain ever gets pathologically large, it
      │     drops the zero-overlap tail (by token-overlap with the source)
      │     and pushes a warning into result.warnings — never silent.
      ├─ 5. Call LLM via llm.js  (JSON mode, 65,536 max output tokens;
      │     the Anthropic branch clamps PER MODEL via
      │     anthropicMaxOutputTokens(model) — 64,000 for Haiku 4.5 /
      │     Sonnet 4.5, 128,000 for Sonnet 4.6 / Sonnet 5, and the
      │     conservative 64,000 for any unrecognised id — and always
      │     streams. Gemini is not clamped. See model-lifecycle.md)
      │     Two paths, each with its own prompt shape — see
      │     docs/ingestion-pipeline.md §1b for the full breakdown:
      │
      │     ── Single-pass (input ≤ 15,000 chars) ──
      │        ONE call, buildPrompt(). System: domain CLAUDE.md schema.
      │        User: date + current index.md + source text (≤80,000 chars) +
      │        the existing entity+concept filename lists (full, unless the
      │        rare safety valve above fires) + REQUIRED COVERAGE checklist
      │        (v3.0.1+): forced summary path, originator entity rule,
      │        every-name-mentioned rule, every-key-concept rule,
      │        parent-over-children consolidation, explicit "DO NOT touch
      │        index.md". Returns: { title, pages: [{path, content, summary?}] }
      │        — no `index` field; the app maintains index.md itself (v3.0.1+).
      │        reconcileGeneratedPages() (v3.0.16) runs on the response
      │        first (folds any stray summary path into the canonical one),
      │        THEN validateOutline() (step 5a) runs on the result.
      │        No Anthropic cache breakpoint — one call has nothing to
      │        amortise a cache write against.
      │
      │     ── Multi-phase (input > 15,000 chars OR single-pass parse fails) ──
      │        Phase 1 outline — ONE call, buildOutlinePrompt(). Same inputs
      │        as single-pass (source, current index.md, filename lists,
      │        REQUIRED COVERAGE checklist) but returns PATHS + one-line
      │        summaries only, no page content: { title, pages: [{path,
      │        summary}] } → validated (step 5a below).
      │        Phase 2 batched content — N calls, buildBatchPromptParts(),
      │        BATCH_SIZE=4 pages/call. Each call additionally carries the
      │        outline's own full page-path list ("pages being created in
      │        this ingest" — not capped) so a batch can wikilink to a page a
      │        sibling batch will write. Split into a stable {prefix} (date,
      │        source, filename lists, outline list, instructions — identical
      │        across every batch) and a volatile {suffix} (just this call's
      │        page paths) so the prefix can be cached (v3.0.16): Anthropic
      │        gets an explicit cache_control breakpoint on {prefix} when
      │        totalBatches >= 2; Gemini caches the stable prefix implicitly.
      │        No Phase 3 — index merge moved out of the LLM (v3.0.1+).
      │        On batch parse/token-limit failure: page-by-page retry;
      │        absolute last resort writes a clearly-marked Stub page that
      │        surfaces in Health and in the warnings panel. After all
      │        batches finish, reconcileGeneratedPages() (v3.0.16) folds any
      │        stray summary path the model invented into the canonical one
      │        and flags any page that wasn't on the Phase 1 plan.
      │
      ├─ 5a. validateOutline() — programmatic safety net                       (v3.0.1+)
      │      Runs on BOTH single-pass and multi-phase results.
      │      Invariants enforced:
      │        - exactly one summary page at summaryPath; inject if missing,
      │          redirect if path drifted, drop extras if > 1.
      │        - originator entity present: if extractAuthorHints() detected
      │          an author byline / YAML `author:` / "Author: X" and the
      │          outline omitted that entity, inject it at the FRONT of the
      │          pages list. If the outline contains a variant slug
      │          ("dr-tali-rezun.md" vs canonical "tali-rezun.md"), redirect
      │          it in place — uses the same Pass A + Pass B normalisation
      │          that writePage applies at write time, so the slug Phase 2
      │          generates content for matches the slug used in [[wikilinks]].
      │      Each patch emits a user-visible warning in result.warnings.
      │      Concept coverage is requested by the prompt; not
      │      machine-validated (would require a second LLM call).
      ├─ 5.5 Deduplicate result.pages (multi-phase ingest can return the same
      │     path in multiple batches; keep last occurrence per path)
      ├─ 6. Write each page → domains/<domain>/wiki/<path>
      │     Each writePage() call runs a full post-processing pipeline:
      │       Step 1a: underscore → hyphen slug (two_worlds_of_code → two-worlds-of-code)
      │       Pass A: title-prefix strip (dr-tali-rezun → tali-rezun.md)
      │       Pass B: hyphen-normalised dedup (talirezun → tali-rezun.md)
      │       Step 3b: cross-folder dedup (concepts/google → entities/google)
      │       injectFrontmatter(), mergeWikiPage(), stripBlanksInBulletSections()
      │       deduplicateBulletSections() — safety net for merge edge cases
      │       folder-prefix link cleanup ([[entities/foo]] → [[foo]])
      │       Step 5c: variant link normalization (Pass A+B+C)
      │         Pass A: [[dr-tali-rezun]] → [[tali-rezun]]
      │         Pass B: hyphen-normalised match (entities + concepts)
      │         Pass C: prefix-tolerant match across all wiki files (incl. summaries)
      │     For every summary page written, injectSummaryBacklinks() also fires:
      │       reads "Entities Mentioned", injects [[summaries/<slug>]] into the
      │       Related section of each referenced entity or concept (creates section
      │       if missing; checks entities/ first, falls back to concepts/)
      │     writeRecords[i] is kept aligned 1:1 with result.pages[i] for the
      │     index-merge step below (v3.0.1+).
      ├─ 7. Post-write reconciliation via syncSummaryEntities()
      │     The LLM reliably under-lists entities in "Entities Mentioned"
      │     (writes 5–7 while creating 20–30 entity pages). This step:
      │       a. Derives the full entity + concept list from actual pagesWritten paths
      │       b. Injects all missing [[slug]] bullets into the summary's
      │          "Entities Mentioned" section (dedup-safe + deduplicateBulletSections)
      │       c. Re-fires injectSummaryBacklinks() with the complete list so
      │          every entity/concept page receives [[summaries/<slug>]] — not just
      │          the few the LLM remembered to mention
      ├─ 8. Programmatic index merge via mergeIntoIndex() (shared with compile, v3.0.1+)
      │     Reads existing wikilinks in index.md → skips any slug already there.
      │     Appends rows for newly CREATED pages (not updated/unchanged), pairing
      │     LLM-supplied summaries with canonical post-write paths so cross-folder
      │     dedup redirects keep the correct type column. No LLM call. Sanitises
      │     pipe + newline characters from summary text before insertion.
      └─ 9. Append timestamped entry to log.md (warnings section included if any)

HTTP response → { type: 'done', title, pagesWritten, changes,
                  warnings: [...], truncated: bool, wasOverwrite: bool }
                  (SSE event; warnings + truncated added in v3.0.1+)
```

### Idempotency guarantees on re-ingest (v3.0.1+)

Re-ingesting the same source file produces no duplicates anywhere in the
wiki. The chain that makes this work, in order of where it kicks in:

| Layer | Mechanism | Outcome |
|---|---|---|
| **Summary file** | Deterministic slug from source filename (`computeSummarySlugFromSource`) | Same input file → same `summaries/<slug>.md` → `mergeWikiPage` union-merges bullets. No second summary file possible. |
| **Entity / concept files** | Existing-files list passed to LLM + `writePage` dedup passes (title-prefix, hyphen-norm, cross-folder) | Same entity = same slug = bullets merge. |
| **Bullet sections** (Key Facts, Related, Entities Mentioned) | `mergeWikiPage` union + `deduplicateBulletSections` safety net | Bullets with the same link target collapsed to one. |
| **Summary "Entities Mentioned"** | `syncSummaryEntities` always rebuilds from the ground-truth `pagesWritten` list | List always matches the actual pages written this run. |
| **Backlinks** | `injectSummaryBacklinks` is dedup-safe (`dedupKey()`) | Same `[[summaries/<slug>]]` bullet is never added twice. |
| **`index.md` rows** | `mergeIntoIndex` scans existing wikilinks → skips any slug already mentioned | Re-ingest never adds a duplicate row. Only newly CREATED pages get rows. |

### Batch ingest queue (v3.3.0+)

Selecting two or more files switches the Ingest tab to a **server-owned, disk-persisted queue** (`src/brain/ingest-queue.js`, routed at `POST /api/ingest-queue` and friends) instead of the single-file flow above. It exists so a large batch survives a closed browser tab or an app restart, and so duplicate/partial-failure handling doesn't have to be reasoned about per click.

```
POST /api/ingest-queue          (multipart: files[] + domain) → creates a job, returns a cost estimate; nothing uploads or spends until…
POST /api/ingest-queue/:jobId/start   → begins the strictly-sequential worker
GET  /api/ingest-queue/:jobId/stream  → SSE progress (per-item status, live pause/cancel flags)
POST /api/ingest-queue/:jobId/pause   → stops between files (lossless — never aborts an in-flight call)
POST /api/ingest-queue/:jobId/cancel  → aborts the in-flight file immediately (v3.4.0+; see below)
DELETE /api/ingest-queue/:jobId       → dismiss a finished/cancelled/failed job
```

Properties that are correctness requirements, not conveniences:

- **Strictly sequential, process-wide.** `ingestFile` snapshots a domain's existing entity/concept filenames once per call; two concurrent ingests into the same domain would both see "doesn't exist yet" and both create it. A synchronous mutex claim (not "check a flag, then await, then set it") plus an in-flight counter around the one `ingestFileImpl` call closes the TOCTOU window a same-process double-click or two open tabs can hit.
- **Durable staging.** Each uploaded file is copied into the queue's own directory (see below) at job-creation time, before the create call returns — multer's OS-temp-dir upload does not survive a restart, so "resume after a crash" needs its own copy of the bytes.
- **Duplicates are decided ONCE, at job creation**, against the domain's `raw/` state as it exists before the batch starts — never re-checked at run time. `ingestFile` writes `raw/<name>` as its first internal step, so an item interrupted mid-ingest already looks like a duplicate; a runtime check would mark the resumed item `skipped` and silently drop the very file the crash interrupted.
- **A rate limit pauses the whole batch; a bad file fails alone.** `llm.js` already retries 429/503 with backoff before giving up, so one reaching the queue means the provider said stop, not "this file is bad." A structured `err.curatorTransient` tag (not a substring match — see the module's own docblock for why a bare `\b429\b` regex is unsafe) plus a consecutive-failure circuit breaker (3 in a row → pause) bound the damage either way.
- **Never auto-starts spend.** A job interrupted by a crash or restart recovers to `paused`; nothing calls start on its own.
- **The job directory lives OUTSIDE `domains/`** — `<user-data dir>/.ingest-queue/` via `getIngestQueueDir()` in `src/brain/paths.js` — because `getDomainsDir()` is Personal Sync's git work-tree (`sync.js` passes `--work-tree=getDomainsDir()`). A queue directory inside it would commit and push staged, possibly-large source files to the user's GitHub repo — the same class of bug this project has shipped twice before (`.DS_Store` in v3.0.16, `.write-lock` in v3.0.15).

**Pause vs. Cancel — deliberately not the same "stop" (v3.4.0+).** Pause is lossless: it only ever stops between files. Cancel means "stop spending right now": an `AbortController` is threaded from the queue worker through `ingestFile` down to the `generateText` call and every provider client, so a click aborts the file that's *currently* in flight rather than waiting for it to finish. Measured on a real multi-phase 150 KB source: cancel acknowledged in single-digit milliseconds and the job reached a terminal state in ~63–74 ms, versus the ~334 s and up to 17 further paid provider calls the same run would otherwise have made. The interrupted item gets its own terminal status, `cancelled` ("Stopped"), distinct from `failed`; nothing already written is rolled back, and re-ingesting that one file (with Overwrite ticked, since it's already recorded in `raw/`) completes it. The abort check is placed FIRST in every one of `ingest.js`'s LLM-reachable recovery catches (Phase 1 outline retry, Phase 2 batch → page-by-page → stub, single-pass → multi-phase) — a cancel caught by one of those ladders instead of honoured would silently keep spending, the exact inverse of what Cancel is for.

## Data flow: Chat

The transport half of this — SSE frames, the authoritative-return rule and commit-at-first-delta — has its own document: [chat-streaming.md](chat-streaming.md). Retrieval, prompting and persistence are below and are unchanged by it.

```
User sends message
      │
      ▼
POST /api/chat/:domain  { message, conversationId?, responseStyle?,
                          provider?, model?, stream? }
      │   stream === true  → 200 text/event-stream (frames)
      │   otherwise        → 200 application/json  (one object, as always)
      ▼
src/brain/chat.js
      ├─ 1. Load or create conversation from domains/<domain>/conversations/
      ├─ 2. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 3. Read all .md files under domains/<domain>/wiki/
      ├─ 4. detectQueryIntent(message) → decision | enumerate | synthesis
      │     (classifies the user's ASK via extractAsk; see
      │      docs/ingestion-pipeline.md §10c)
      ├─ 5. selectRelevantPages() — entity-pivot + keyword-scored pages up to a
      │     60 KB budget + a 12 KB enriched catalogue (NOT the whole wiki)
      ├─ 6. Build prompt: selected pages + catalogue + the intent's answer-shape
      │     instruction block, with last 20 messages as conversation history
      ├─ 7. Call LLM via llm.js  (text mode; the output-token budget comes
      │     from the chosen response style — see RESPONSE_STYLES in
      │     src/brain/chat.js, which is the source of truth for the numbers.
      │     On truncation it returns the partial answer + a note — never
      │     hard-fails)
      │     opts.onUsage captures {provider, model, four token counts} for
      │     the provider call that actually answered — see "Per-answer cost"
      │     above.
      │     opts.onDelta (streaming only) receives {type, text} as the model
      │     produces output — a PREVIEW channel. The return value is still
      │     the complete, authoritative answer.
      │     Returns: markdown answer with [source: path] citation tags
      ├─ 8. stripCatalogueEcho() — remove any residual bare-file-path blob
      ├─ 9. Parse [source: ...] tags → deduplicated citation list
      ├─ 9b. buildCitationTitles() — resolve each cited path to the page's own
      │      title (deriveTitle: frontmatter `title:` → first `# Heading` →
      │      humanised slug) from the wiki ALREADY in memory at step 3. No
      │      extra file read; a path with no page behind it is OMITTED, and the
      │      whole map is null when nothing resolves.
      ├─ 10. Append user + assistant messages to conversation (the assistant
      │      message additionally carries `provider`/`model`/`usage` when the
      │      onUsage payload validated, and `citationTitles` when any title
      │      resolved — see Conversation persistence below)
      └─ 11. Save conversation JSON to domains/<domain>/conversations/<id>.json

HTTP response → { conversationId, isNew, title, answer, citations: [...],
                   citationTitles, responseStyle, provider, model, usage }
  // `model` and `usage` describe the model that ANSWERED, not the one
  // requested; both are null when nothing valid was reported. See
  // "Per-answer cost" under Model selection, above.
  //
  // On the streaming path this SAME object is the payload of the terminal
  // `{type:'done', ...result}` frame, spread un-enumerated — so the two
  // surfaces cannot disagree about what a turn produced.

Other chat endpoints:
  GET    /api/chat/:domain        → list conversations (id, title, messageCount)
  GET    /api/chat/:domain/:id    → full conversation (all messages)
  DELETE /api/chat/:domain/:id    → delete conversation
```

### Conversation persistence

Each conversation is a JSON file:

```json
{
  "id": "uuid",
  "title": "First message truncated to 60 chars…",
  "createdAt": "2026-04-09T10:00:00.000Z",
  "domain": "ai-tech",
  "messages": [
    { "role": "user",      "content": "What is RAG?" },
    { "role": "assistant", "content": "RAG stands for…", "citations": ["concepts/rag.md"],
      "provider": "anthropic", "model": "claude-opus-5",
      "usage": { "inputTokens": 998, "outputTokens": 247,
                 "cachedReadTokens": 0, "cacheWriteTokens": 0 },
      "citationTitles": { "concepts/rag.md": "Retrieval-Augmented Generation" } }
  ]
}
```

`provider`/`model`/`usage` on an assistant message are **additive and optional** — `buildAssistantMessage` omits each one it cannot validate rather than writing a guessed or partial value (see "Per-answer cost" under [Model selection](#model-selection-the-router-v3120--v3130) above), and every message written before that field existed simply lacks it. There is deliberately no read-side migration or defaulting: absent means unknown, not zero and not "the current default."

Conversations are **not** gitignored: `domains/.gitignore` (built from `DOMAINS_GITIGNORE_RULES` in `src/brain/sync.js`) excludes `raw/`, a handful of machine-local lock/cache files, and Obsidian junk, but never `conversations/*.json` — so conversation history is tracked and travels with the wiki through Personal Sync, deliberately, so a thread can be continued from any machine. See [Sync](sync.md) and [user-guide.md §15](user-guide.md#15-sync-across-computers).

---

## Data flow: Domain management

```
User clicks Create / Rename / Delete in Domains
      │
      ▼
POST/PUT/DELETE /api/domains[/:slug]
      │
      ▼
src/routes/domains.js  —  validates slug, calls files.js helpers
      │
      ├─ createDomain()
      │    ├─ mkdir raw/, wiki/{entities,concepts,summaries}/, conversations/
      │    ├─ Write wiki/index.md and wiki/log.md (empty scaffold)
      │    └─ Write CLAUDE.md via generateClaudemd() — selects template
      │         (tech / business / personal / generic)
      │
      ├─ renameDomain()
      │    ├─ fs.rename() — atomic on same filesystem
      │    ├─ Patch # Domain: header in CLAUDE.md
      │    ├─ Patch # Wiki Index — header in wiki/index.md
      │    ├─ Patch # Ingest Log — header in wiki/log.md
      │    └─ Update conv.domain field in every conversations/*.json
      │
      └─ deleteDomain()
           └─ rm -rf domain directory

HTTP response → { slug, displayName } or { deleted, syncWarning }

Obsidian sees all changes instantly — it watches the same domains/ folder.
If sync is configured, syncWarning: true is returned so the UI can
prompt the user to sync.
```

---

## Data flow: Wiki Health

```
User clicks Scan in a domain's Wiki health panel
      │
      ▼
GET /api/health/:domain
      │
      ▼
src/routes/health.js  —  validates domain
      │
      ▼
src/brain/health.js  →  scanWiki(domain)  (pure, no writes)
      ├─ Walk wiki/*.md files
      ├─ For every [[wikilink]]: resolve target; record incoming links;
      │   flag folder-prefix violations; flag broken targets with suggestions
      ├─ Orphan pass: entity/concept files with zero incoming links
      ├─ Cross-folder dedup pass: entities/X + concepts/X with same
      │   hyphen-normalised slug
      ├─ Hyphen variant pass: group entity files by normKey (strip hyphens,
      │   article prefix); prefer the form with the most hyphens as canonical
      └─ Missing backlink pass: for each summary's "Entities Mentioned"
          bullet, check the target page's "Related" section for a
          [[summaries/<slug>]] bullet

HTTP response → { counts, brokenLinks, orphans, folderPrefixLinks,
                  crossFolderDupes, hyphenVariants, missingBacklinks }

User clicks Fix / Fix all:

POST /api/health/:domain/fix[-all]    body: { type, issue? }
      │
      ▼
src/brain/health.js  →  fixIssue(domain, type, issue?)
      └─ Dispatch by type:
         brokenLinks       → regex rewrite [[old]] → [[issue.suggestedTarget]]
         folderPrefixLinks → strip [[entities/|concepts/]] prefixes in-place
         crossFolderDupes  → merge bullet sections, delete concept copy,
                             normalise frontmatter type to entity
         hyphenVariants    → union bullets into canonical slug, delete variants
         missingBacklinks  → injectSingleBacklink() into scan-resolved entity
         orphanLink        → injectRelatedLink(): AI orphan-rescue bullet (v2.4.4+)
                             — pseudo-type, never emitted by scanWiki
         semanticDupe      → fixSemanticDuplicate() (v2.4.5+): DESTRUCTIVE
                             merges two pages, rewrites all [[removeSlug]]
                             links across the domain, deletes the duplicate
                             — pseudo-type, never emitted by scanWiki;
                             gated by mandatory Preview-diff in the UI

UI re-scans automatically after every fix so counts drop in real time.

AI-assisted suggestions (v2.4.3+) flow through a separate READ-ONLY module:

POST /api/health/:domain/ai-suggest    body: { type, issue }
      │
      ▼
src/brain/health-ai.js  →  suggestBrokenLinkTarget / suggestOrphanHomes
      │
      └─ generateText() in llm.js  (provider-agnostic, fallback-chain aware)
      └─ Validate all returned slugs against on-disk filenames before response
         (hallucinated slugs are coerced to null / dropped)

This module NEVER writes. Applying an AI suggestion goes back through
the /fix endpoint above — same chokepoint as every other Health write.

Orphans are always Review-only — `scanWiki` never emits an auto-fixable
orphan issue, and the only way an orphan gets a link is the user-initiated
`orphanLink` pseudo-type carrying an AI suggestion the user accepted.

Broken links are SPLIT, and the distinction is the whole safety story:

  brokenLinks WITH issue.suggestedTarget  → auto-fixable. In AUTO_FIXABLE,
      and included in fixAllSafe()'s TYPES list — so one click on
      "Fix N safe issues" rewrites every one of them across the domain.
      The target came from the deterministic scanner, not from an LLM.
  brokenLinks WITHOUT a suggestedTarget   → review-only. fixIssue()'s
      fix-all path filters these out (`issues.filter(i => i.suggestedTarget)`),
      so a bulk fix can never guess a target for them.

See AUTO_FIXABLE and fixAllSafe() in src/brain/health.js.

Persistent dismissals (v2.5.1+):

POST /api/health/:domain/dismiss      body: { type, issue }
POST /api/health/:domain/undismiss    body: { type, issue }
GET  /api/health/:domain/dismissed    → { records: [...] }
      │
      ▼
src/brain/health-dismissed.js
      ├─ keyForIssue(type, issue)
      │   Canonical, deterministic key per issue type. Order-insensitive
      │   identities (semantic-dupe pairs, hyphen-variant groups) are
      │   alphabetised so {a,b} and {b,a} produce one key.
      ├─ loadDismissed(domain)
      │   Reads <wiki>/.health-dismissed.jsonl, parses every line,
      │   silently prunes records whose referenced files/slugs no longer
      │   exist, returns { records, keys: Set<string> }.
      ├─ addDismissal / removeDismissal — append-or-rewrite the JSONL.
      └─ filterDismissed(issues, type, keys)
          O(N) Set-based filter; surfaces dismissed-count for the UI.

scanWiki and findSemanticCandidatePairs filter their results through
filterDismissed before returning. counts.dismissed is exposed in the
scan response so the UI can show "N dismissed" alongside live issues.

The JSONL file lives INSIDE wiki/ so it's already git-tracked by the
existing sync — dismissals propagate across machines automatically.
Line-oriented format makes concurrent dismissals on different machines
merge cleanly through git's standard 3-way merge.
```

---

## Data flow: Raw source retrieval (v3.5.0)

"Which original document was this summary built from, and can I get its actual text back?" — Track 7 Part II. The link already existed (`injectFrontmatter` promotes a summary's `Source:` line into a `source:` frontmatter field at ingest time); this feature makes it *usable and safe* rather than adding a new one.

```
GET /api/wiki/:domain/source?path=summaries/foo.md[&hash=1]   → does the original file still exist on this machine?
POST /api/wiki/:domain/source/reveal   body: { path }         → open it in Finder (macOS only, 501 elsewhere)
```

Both routes, and the MCP's `get_raw_source` tool, funnel through **`src/brain/raw-store.js`**, the single chokepoint for turning an untrusted `source:` value into a path on disk. `source:` is treated as hostile input throughout — it is LLM-written, hand-editable in Obsidian, and arrives over Personal Sync and Shared Brain mirror pulls, i.e. potentially from another machine or another person. `resolveRawSource()` layers a sanitiser (no path separators, no control characters, basename-only, ≤512 chars) → lexical containment inside the domain's `raw/` folder → **physical** `realpath` containment (a symlinked leaf or ancestor, or a dangling symlink, is refused) → `lstat().isFile()` (refuses directories and *any* symlink, even one that resolves back inside `raw/` — a raw source is a file that was ingested, never a link). It deliberately reuses `resolveInsideWiki` from `wiki-read.js` rather than keeping a second hand-maintained copy of the containment check — two independently-maintained copies of the same guard is what produced the v3.2.0 CRITICAL (see that release's CLAUDE.md entry).

`found: false` is a normal `200` response, not an error — it covers four distinct cases (`missing`, `external-source`, `not-a-summary`, `no-source-recorded`; see [api-reference.md](api-reference.md#get-apiwikidomainsource) for the full list) and the most common by far is `missing`: `raw/` is gitignored and never syncs, so any machine that only pulled the wiki reports every summary's source as missing by design. The UI and the MCP tool both say so plainly.

**A summary's `source:` can also name a web page** (`medium.com/@author`) rather than a local file — found in real data, not hypothesised. That value is classified as `external-source` and reported to the caller **as inert text — never fetched**. Turning an LLM-authored, sync-delivered string into an outbound HTTP request would make it an SSRF primitive; neither `raw-store.js` nor the wiki routes import an HTTP client.

**`get_raw_source` (MCP, v3.5.0)** returns extracted plain text, byte-capped well under the MCP response budget — never raw bytes. PDFs are text-extracted first; anything that doesn't decode as text comes back as `text: null` with `text_unavailable: "binary"` rather than mangled bytes or a corrupted JSON-RPC stream (the same class of failure the v2.5.3 stdout-pollution fix closed). See [§ Module reference](#module-reference) below and the MCP section that follows for where this sits among the other 19 tools.

An append-only manifest, `<domain>/wiki/.raw-manifest.jsonl`, records filename/size/sha256/ingest-date for every raw file — deliberately placed *inside* `wiki/` so it syncs even though the blobs themselves never do, mirroring the `.health-dismissed.jsonl` precedent. It leaks nothing new: the filename is already present in the synced `source:` field. A manifest write failure can never fail an ingest.

---

## Data flow: My Curator MCP

The MCP server is a **standalone** Node process spawned by the MCP client
(Claude Desktop or any other) via stdio. It does NOT require the Curator
HTTP server to be running. From v2.5.2+, it is a full read+write surface
to the wiki — the same code path the app's own Compile and Wiki health surfaces use.

Domain-path resolution in `storage/local.js` goes through `src/brain/paths.js`
as of v3.1.0 — the same module the web app's `config.js` uses — so the MCP
and the UI can no longer silently disagree about where `.curator-config.json`
or the default `domains/` folder live. The precedence order is now also
identical between the two resolvers — see
[Where user data lives § App ↔ MCP](#where-user-data-lives-srcbrainpathsjs)
above for the fix that closed the one remaining ordering difference
(`DOMAINS_PATH` vs config).

```
Claude Desktop launches
      │
      ▼
spawn(node, [mcp/server.js, --domains-path <abs>])
      │
      ▼
mcp/server.js
      ├─ setCliDomainsDir(domainsPath)           src/brain/config.js  (v3.17.0)
      │     Makes READS and WRITES resolve one tree. MUST stay above the
      │     adapter: the adapter snapshots its base at construction, and
      │     every tool handler runs later, on a request.
      ├─ createStorageAdapter({ domainsPath })   storage/local.js
      ├─ registerTools(server, storage)          tools/index.js
      └─ StdioServerTransport.connect()

Tool call (any of 20 tools):
      │
      ▼
tools/index.js — CallToolRequestSchema handler
      ├─ Look up tool by name → invoke handler(args, storage)
      ├─ Stringify result → enforceSizeLimit (400 KB cap; trims heavy arrays)
      └─ Return { content: [{ type: 'text', text }] }

Read tools (v2.3.0+ through v3.17.0, 12 tools)
      ├─ Walk markdown via storage.listWikiFiles / readFile
      │    Cached per-process graph (mcp/graph.js, 10-min TTL)
      ├─ get_raw_source (v3.5.0) is one exception: it does NOT go
      │    through storage.readFile (which forces utf8 and would mangle a
      │    PDF) — it calls raw-store.js's resolveRawSource + text extractor
      │    directly, and returns extracted text only, never binary bytes.
      └─ get_working_state (v3.17.0) is the other: it reads state/, not
           wiki/, and goes to the filesystem DIRECTLY — never through
           graph.js, whose cache invalidates on FILE COUNT, which an
           in-place overwrite of current.md never changes. A cached read
           could serve state up to the TTL out of date, and stale state is
           worse than no state. Every file read is byte-capped at the
           source, so a hand-edited or synced 10 MB current.md cannot
           reach enforceSizeLimit.

Write tools (v2.5.2+, 8 tools)
      ├─ resolveDomainArg(args, storage, getDefaultDomain)
      │     Explicit domain → user's defaultDomain → error
      │     Validated via isValidDomain + storage.listDomains()
      ├─ Per-tool guards (caps, slug regex, REFUSED_FILES, preview gate)
      ├─ save_working_state (v3.17.0) does NOT use resolveDomainArg or
      │     writePage: it wraps src/brain/working-state.js, which runs its
      │     own checkProjectWritable (must be a real domain, must not be a
      │     read-only shared-* mirror) and its own resolveInsideState
      │     containment. It writes state/, never wiki/.
      │
      └─ compile_to_wiki:
         │   importsFromBrain: writePage, syncSummaryEntities, appendLog
         │   ├─ Deterministic summary slug = slugify(title)+date+sha4(corpus)
         │   ├─ existsSync(summaryFullPath) → refused (idempotency)
         │   ├─ Per-page 50 KB cap, per-call 10-page cap
         │   ├─ writePage for summary + each additional_page
         │   ├─ syncSummaryEntities (entity backlinks)
         │   ├─ mergeIntoIndex (programmatic — no LLM call)
         │   ├─ appendLog
         │   └─ storage.appendToWriteAudit (machine-private)
         │
         scan_wiki_health, fix_wiki_issue, scan_semantic_duplicates:
         │   importsFromBrain: scanWiki, fixIssue, AUTO_FIXABLE,
         │     previewSemanticDuplicateMerge, scanSemanticDuplicates
         │   ├─ Persistent dismissals (loadDismissed) filter scan results
         │   ├─ semanticDupe REQUIRES preview:true on first call
         │   │     Per-domain in-memory token Set; a successful preview
         │   │     enables the next preview:false call, then is consumed.
         │   └─ fixIssue handlers all gated by resolveInsideWiki (v2.5.2+)
         │     Defense-in-depth path-traversal check on every issue field
         │     so an LLM-crafted issue cannot rm() outside the wiki folder.
         │
         dismiss_wiki_issue / undismiss_wiki_issue / get_health_dismissed:
             importsFromBrain: addDismissal, removeDismissal, listDismissed
             Same JSONL file shared with the app's Wiki health panel.

Audit log (v2.5.2+, write tools only):
      domains/<d>/.mcp-write-log.jsonl
      Sibling to wiki/ — gitignored via */.mcp-write-log.jsonl rule.
      Local only by design: write history is private to the machine that
      produced it; you don't want it spilling to GitHub.

Default domain (v2.5.2+):
      .curator-config.json → defaultDomain
      Set/cleared via /api/config/default-domain (Settings tab dropdown).
      MCP write tools fall back to it when domain is omitted.
```

The MCP and the Curator app are **equally-capable clients** to the same
wiki data. The Curator app provides the install + wizard + manual UI;
the MCP provides conversational read+write from any LLM client. Same
write pipeline (writePage, syncSummaryEntities, fixIssue), same
dismissal store (.health-dismissed.jsonl), same idempotency guards.

---

## Module reference

### `src/brain/paths.js` (v3.1.0)

Single source of truth for where user data lives. See [Where user data lives](#where-user-data-lives-srcbrainpathsjs) above for the full design rationale (repo vs bundle detection, the fail-safe asymmetry, the rejected designs). Pure resolver in repo mode — no filesystem writes, no directory creation. Imported by the MCP stdio child process, so it imports only Node builtins and never writes to stdout.

| Export | Description |
|--------|-------------|
| `APP_ROOT` | Absolute path to the CODE root. Read-only in a bundle; never write here. |
| `getUserDataDir()` | Absolute path to the writable user-data root. `APP_ROOT` in a repo install (today, always); `~/Library/Application Support/The Curator` in a (future) bundle install. Memoised per process; both test seams are re-read on every call. |
| `userDataPath(...segments)` | Joins segments onto `getUserDataDir()`. |
| `appPath(...segments)` | Joins segments onto `APP_ROOT`. Never write to the result. |
| `isBundleInstall()` / `isRepoInstall()` | Positive bundle detection (`BUNDLE_MARKER_FILE` present, or `APP_ROOT` sits inside a `*.app/Contents` path). `isRepoInstall()` is `!isBundleInstall()` — unknown layouts default to repo. |
| `getAppSupportDir()` | The macOS Application Support path bundle mode would use, independent of which mode is actually active. |
| `getCuratorConfigFile()`, `getSyncConfigFile()`, `getSyncGitDir()`, `getSharedBrainConfigFile()`, `getDefaultDomainsDir()` | Named user-data locations — each a thin `userDataPath(...)` join. Call these per-use; don't snapshot into a module-level `const` (defeats both test seams for anything imported before they're set). |
| `getCredentialFiles()` | The 5 files that must be 0600, as `{rel, abs}` pairs. Shared by the `server.js` startup chmod sweep and the `diagnostics.js` System Check probe. |
| `userDataDirExists()` | True only if the path exists **and** is a real directory (a regular file there is not "exists"). |
| `getUserDataDirState()` | `'ready' \| 'empty' \| 'missing' \| 'blocked'` — the seam a future first-launch migration will key off. Not yet called anywhere in v3.1.0. |
| `__setUserDataDirOverride(dir)` | Test-only, in-process. Pass `null` to clear. |

### `src/brain/install-mode.js`

What this copy of The Curator may do to its **own code**, as named capabilities rather than as an install form. See [Install modes](#install-modes-srcbraininstall-modejs) above for the full rationale. Performs no filesystem writes and never writes to stdout.

| Export | Description |
|--------|-------------|
| `getInstallMode()` | `'repo' \| 'bundle'`. Derived from `paths.js`'s `isBundleInstall()`, so the two modules cannot disagree. Anything unrecognised is `'repo'` — the asymmetry is inherited verbatim. Not memoised: the detection is a couple of `existsSync` calls, and memoising would defeat the guard suite's child-process probes. |
| `getCapabilities(mode?)` | The frozen capability record (default: this install's). **Throws** on an unknown mode string — that is a caller bug, not an environment condition; the environment-driven unknown is handled one level up in `getInstallMode()`. |
| `CAPABILITY_KEYS` / `INSTALL_MODES` | The authoritative key and mode lists. Adding a key without adding it to **both** records is a module-load throw. |
| `describeInstall(mode?)` | Wire-safe `{ installMode, installModeLabel, capabilities }`. Explicit allow-list, never a spread of internal state. |
| `capabilityRefusal(capability, action, extra?)` | `{ status: 501, body }` for a forbidden arm. **501, not 403** — the server understood the request and this build genuinely cannot perform it; "forbidden" would send the user looking for a setting to flip. |
| `INSTALL_MODE_LABELS` | Human-readable labels, for System Check and error text. Never for logic. |

### `src/brain/desktop-host.js`

The hooks a **desktop shell** may install into this process. Exists because two capabilities (`folderPickerStyle: 'native-dialog'`, `restartStyle: 'app-relaunch'`) name an action that lives in Electron's main process — and because `desktop/main.js` imports `src/server.js` into that **same Node realm**, so a module-level registry is a real channel rather than a metaphor. Performs no filesystem work, makes no network call, never writes to stdout, and deliberately does **not** read `install-mode.js`: registration and capability are independent facts, and the *consumer* joins them.

| Export | Description |
|--------|-------------|
| `registerDesktopHost(hooks)` | Installs one or more hooks; partial by design. **Throws** on an unknown hook name or a non-function value — a typo'd `pickfolder` would otherwise register nothing, throw nothing, and leave the route refusing forever with the shell author certain they had wired it. Returns the names installed, so a caller can assert on it. |
| `getDesktopHook(name)` | The hook, or `null`. **Consumers must treat `null` as "refuse", never as "fall back."** A silent fallback makes the capability a lie, and both available fallbacks are the exact behaviour the bundle arm exists to stop. Own-property lookup through the frozen name list, on a null-prototype object. |
| `DESKTOP_HOOKS` | Frozen `['pickFolder', 'relaunch']`. |
| `describeDesktopHost()` | Wire-safe `{hooks: {name: bool}, attached: bool}` — booleans only, never the functions. Nothing consumes it yet; it exists because "is a shell attached?" is the first question anyone debugging a refusal will ask. |
| `__resetDesktopHost()` | **Test-only.** Exported rather than env-gated on purpose: an env-gated reset is a second way for production behaviour to depend on a test variable, and the worst this can do in production is cause a refusal — the fail-safe direction. |

### `src/brain/restart.js`

`planRestart(caps?, relaunchHook?)` — the pure decision behind `POST /api/restart`. No spawn, no exit, no I/O: `perform` is handed back for the caller to run *after* the HTTP response has flushed, so the whole decision is testable without a server and without killing the test runner. Both parameters default to the live values and are injectable so a suite can drive either arm.

Returns `{ok: true, style: 'respawn-node', body, perform: null}` (the caller runs its existing spawn block; `body` is byte-identical to what this route has always sent — `restartStyle` is deliberately **not** added there, because the `next/` shell's updater flow polls this response and "byte-identical" is worth being able to claim without an asterisk; the pre-redesign shell's own updater flow at `/old` no longer exists, deleted in v3.41.0), `{ok: true, style: 'app-relaunch', body, perform}`, or a 501 refusal when `restartStyle` is `app-relaunch` and no shell has registered a `relaunch` hook. It does **not** fall back to the spawn: under Electron `process.execPath` is the app binary, so that would open a second window instead of a server — silently, under a response saying everything was fine.

### `src/brain/config.js`

Persistent app configuration stored in `.curator-config.json` in the user-data directory (`src/brain/paths.js`; the project root for a repo install — the only install type that exists today).

| Export | Description |
|--------|-------------|
| `getDomainsDir()` | Resolved absolute path to the domains folder. Precedence: in-process test override → `CURATOR_TEST_DOMAINS_DIR` (env, test-only) → `setCliDomainsDir()`'s value (**v3.17.0**, production, MCP-only) → `.curator-config.json`'s `domainsPath` → `DOMAINS_PATH` env var → default (`paths.js`'s `getDefaultDomainsDir()`). The two test rungs are always inert in production and the CLI rung is null in the web app, so app behaviour is unchanged from before v3.1.0: config beats the env var. |
| `setCliDomainsDir(dir)` | **v3.17.0.** Installs the `--domains-path` this process was launched with. Called once, only by `mcp/server.js`, at module scope on the line above `createStorageAdapter` — it must run before anything resolves a domains path, and before the adapter, which snapshots its base at construction. Deliberately **not** the `__setDomainsDirOverride` test seam: that one is guarded by `test-paths.js` §4 as "production never sets this", and reusing it would destroy the guarantee that assertion exists to make. A missing or blank value is a no-op, so launching the MCP without the arg still falls through to the stored setting exactly as before. |
| `setDomainsDir(newPath)` | Persists a new domains path to `.curator-config.json` |
| `getConfig()` | Returns `{ domainsPath, domainsPathSource }` for the UI |
| `getApiKeys()` | Returns `{ geminiApiKey, anthropicApiKey }` from the config file |
| `setApiKeys({ geminiApiKey, anthropicApiKey })` | Saves API keys to the config file (partial update) |
| `getEffectiveKey(provider)` | Returns the active key for a provider: config file takes priority over `.env` |
| `getSelectedModel(provider)` | The user's stored model choice for a provider, or `null`. Read **fresh per call**; sanitised, and deliberately **not** validated against the catalogue here (that happens on the read side in `llm.js` — see [Model selection](#model-selection-the-router-v3120--v3130)) |
| `setApiKeys(keys, opts)` / `setActiveProvider(provider, opts)` | The two activation mutators. Both take an **injected** `opts.canActivate` predicate and activate nothing without it — see [LLM provider selection](#llm-provider-selection-srcbrainllmjs). The predicate itself lives in `src/routes/config.js`, because answering it needs `llm.js`, which imports this file |
| `setSelectedModel(provider, modelId)` | Persists the choice, or clears it on empty/null. Deletes the key entirely when nothing is selected, so a user who never picks keeps a byte-identical config file |
| `backgroundModeNames()` | `['window', 'tray', 'tray-only']` — the modes **this build** understands, and the sole source of truth for the Settings control and the route's refusal message |
| `resolveBackgroundMode(raw)` | Fail-safe resolver. Absent, null, a non-string, a prototype key, or a mode a newer build wrote all resolve to `window`. Exported separately from the getter so the asymmetry is testable without touching the filesystem |
| `getBackgroundMode()` | The resolved mode for this install. Never throws, never returns null |
| `getBackgroundModeCaps()` | `{ mode, tray, dock }` — what the desktop shell has to decide before it creates anything. Resolves again rather than trusting the getter, so the table lookup is total by construction |
| `setBackgroundMode(mode)` | `{ ok, mode, reason }`. **Refuses** an unrecognised value rather than coercing it, and on refusal `mode` is the mode still **in force** — so a caller that renders the returned value shows the truth even if it ignores `ok` |

### `src/brain/llm.js`

| Export | Description |
|--------|-------------|
| `getProviderInfo(preferProvider?, preferModel?)` | Returns `{ provider, model }` based on effective keys (via `config.js`). **The single application point of the `OFFERABLE_MODELS` allow-list** — see [Model selection](#model-selection-the-router-v3120--v3130) |
| `getDefaultModel(provider)` | The model id a provider resolves to right now (`LLM_MODEL` gated on the active provider, then the stored Settings choice, then `DEFAULTS`). Drives `models` on `GET /api/config/api-keys` |
| `OFFERABLE_MODELS` | Frozen, cheapest-first catalogue of hand-measured user-pickable models per provider. Entries are built by a factory that throws at module load on an incomplete spec (v3.12.0). A **partial view** for a provider whose catalogue is fetched at runtime |
| `listOfferableModels(provider)` | **The accessor every consumer should read** — the frozen table plus whatever the runtime catalogue admitted. Always an array, never `null` |
| `setOpenRouterCatalogue(specs)` | Replaces the runtime chat-lane catalogue, admitting each entry through the same factory. Per-entry refusal, never all-or-nothing; returns `{admitted, refused}` |
| `isOfferableModel(provider, modelId)` | The allow-list predicate. Array scan with `===`, so prototype keys resolve to nothing |
| `isBuildLaneModel(provider, modelId)` | May this model be pinned as the model that **builds the wiki**? Derives from `suitability` alone; fails closed to `false` |
| `isKnownProvider(provider)` / `isFreeModel(modelId)` | The one provider-membership test (no hand-copied string lists), and the free-model membership test — membership, never a price test |
| `DOMINATED_MODELS` / `AWAITING_MEASUREMENT` | Frozen records of models that work-but-are-beaten, and of real models never probed against the real ingest prompt. Different lists, different bans |
| `resolveModelPrice(id, atMs)` / `getModelPrice(id)` | Published price per 1M tokens, promotion-resolved by date. `null` for an id we don't ship |
| `anthropicMaxOutputTokens(modelId)` | Per-model output ceiling; unknown ids resolve to the conservative `ANTHROPIC_MAX_OUTPUT_TOKENS` (64,000) |
| `normalizeOpenRouterUsage(usage)` | Normalises the aggregator's usage block. **Subtracts cached tokens from the prompt count** (its convention includes them) and clamps at 0, so a running spend total can never be double-counted or driven negative |
| `getFallbackStatus()` | `null`, or the active fallback event plus a derived `costTier` (`costlier`/`similar`/`unknown`) |
| `generateText(system, user, maxTokens, responseFormat, onWait, opts)` | Single LLM call; handles the per-provider API differences, retry/fallback, and `opts.onUsage`/`opts.cachePrefixChars` (v3.0.16), `opts.provider` (v3.0.11), `opts.model` (v3.13.0), `opts.signal` (v3.4.0), `opts.onDelta` (streaming). Returns a **bare string** — every other channel is out-of-band |
| `makeDeltaEmitter(onDelta, commit)` | The single funnel every provider's deltas pass through. Normalises `type` to exactly `content`/`reasoning`, **drops empty deltas**, sets the commit marker *before* invoking the callback, and swallows a throwing callback. `null` when not streaming, which is what makes every provider branch fall back to its non-streaming transport |

### `src/brain/openrouter-adapter.js`

The OpenAI-compatible adapter behind the third provider, plus the pure helpers that make its behaviour testable offline with no credential.

| Export | Description |
|--------|-------------|
| `OpenRouterAdapter` | One chat completion, streaming or not. Sends the no-substitution routing preferences on every call, and reports the **resolved** model from the response body — the model that actually answered, not the one requested. With `stream: true` it parses the SSE body in `_consumeStream` and **reassembles it into a non-streaming-shaped body**, handed to the same `parseChatCompletion` — so there is exactly one function producing the result shape and the two modes cannot drift. `stream` is added to the request body only when asked for, so a non-streaming request is byte-identical to before |
| `fetchOpenRouterCatalogue(...)` | Reads the provider's public model catalogue (no auth required) |
| `classifyOpenRouterStatus(status)` | **Structural** error classification on the numeric status, never a substring match on a message |
| `usdPerMtokFromPerTokenString(s)` | Converts the provider's per-token decimal strings into the per-million figures the app quotes |
| `redactOpenRouterSecrets(s)` | Strips key-shaped text before any detail reaches a message |

### `src/brain/files.js`

Pure filesystem helpers. No LLM calls.

| Export | Description |
|--------|-------------|
| `listDomains()` | Names of non-hidden subdirectories under `domains/` **that contain a `CLAUDE.md` schema**. The schema check is load-bearing, not a formality: it is the v2.3.4 ghost-domain rule (a sync-delete leaves empty dirs behind, since git doesn't track them). A directory without `CLAUDE.md` is invisible to Domains, the wiki reader, Health, chat retrieval and the MCP alike — which is exactly how v3.6.0's worst bug hid pages that had been written and paid for. |
| `readSchema(domain)` | Contents of `domains/<domain>/CLAUDE.md` |
| `readWikiPages(domain)` | All `.md` files under `wiki/`, returned as `{path, content}[]` |
| `writePage(domain, relativePath, content)` | Full write pipeline: underscore→hyphen slug fix, dedup passes A+B on filename, cross-folder dedup (step 3b), `injectFrontmatter()`, `mergeWikiPage()`, `stripBlanksInBulletSections()`, `deduplicateBulletSections()`, folder-prefix cleanup, step 5c variant-link normalization (Pass A+B+C across all wiki folders, prefix-tolerant), **atomic write to disk** via `writeFileAtomic()` (v3.0.1-beta.8+), `injectSummaryBacklinks()` for summary pages; **returns the canonical path** so callers use redirected slugs |
| `injectSummaryBacklinks(summarySlug, summaryContent, wikiDir)` | After a summary is written, injects `[[summaries/<slug>]]` into the Related section of every entity listed under "Entities Mentioned"; checks entities/ first, falls back to concepts/; creates the section if it doesn't exist; deduplicates via `dedupKey()` |
| `syncSummaryEntities(domain, summaryPath, writtenPaths)` | Post-ingest reconciliation: uses the ground-truth `pagesWritten` list (not the LLM's truncated output) to fill in all missing entity AND concept slugs in the summary, then re-fires `injectSummaryBacklinks()` so every entity/concept page gets its backlink regardless of LLM compliance |
| `deduplicateBulletSections(content)` | Safety net: removes duplicate bullets from all accumulating sections (Key Facts, Related, Entities Mentioned, etc.) using `dedupKey()`; runs after every write and after `syncSummaryEntities()` |
| `injectBulletsIntoSection(content, sectionName, bullets)` | Dedup-aware bullet injection; creates the section if it doesn't exist (multiline regex for existence check) |
| `appendLog(domain, entry)` | Append a string to `log.md` |
| `readIndex(domain)` | Contents of `index.md` |
| `createDomain(slug, displayName, description, template)` | Scaffold full domain directory + auto-generate CLAUDE.md from template |
| `deleteDomain(slug)` | Recursively delete a domain directory |
| `renameDomain(oldSlug, newSlug, newDisplayName)` | Atomically rename domain folder, patch display name in CLAUDE.md / index.md / log.md, update conversation JSON files |
| `getDomainStats(slug)` | Return `{ slug, displayName, pageCount, conversationCount, lastIngestDate }` |

### `src/brain/files.js` — conversation helpers

| Export | Description |
|--------|-------------|
| `listConversations(domain)` | All conversations for a domain, sorted by date (newest first) |
| `readConversation(domain, id)` | Full conversation object, or `null` if not found |
| `writeConversation(domain, conversation)` | Persist conversation JSON to disk |
| `deleteConversation(domain, id)` | Delete a conversation file |

### `src/brain/atomic-write.js` (v3.0.1-beta.8+)

Single chokepoint for all wiki + config writes. Replaces `fs.writeFile` and `fs.writeFileSync` with a temp-file + rename pattern so a process kill mid-write leaves either the OLD file or the NEW file intact — never a zero-byte truncated file. POSIX `rename(2)` is atomic per-file within a single filesystem.

| Export | Description |
|--------|-------------|
| `writeFileAtomic(targetPath, content, encodingOrOpts?)` | Async atomic write: writes content to `<dir>/.tmp-<base>-<pid>-<counter>`, then `rename`s into place. Refuses to write through a symlink (`lstat` pre-check). Cleans up the orphan tempfile if rename fails. |
| `writeFileAtomicSync(targetPath, content, encodingOrOpts?)` | Sync variant for `.curator-config.json` writes that happen before the async runtime is fully online. |

**The third parameter takes an options object, not just an encoding string** — `{ encoding, mode }` (v3.0.1-beta.20). Passing a bare string still works (legacy form, unchanged). **Any file holding a secret MUST pass `{ mode: 0o600 }`**: the helper `chmod`s the tempfile *before* the rename, so the umask cannot loosen it. Documenting only the encoding form is how the next credentials file ends up world-readable at 0644 — which is exactly what `.sync-config.json` and `.sharedbrain-config.json` were until beta.20. Files currently on that rule: `.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`; a startup sweep in `src/server.js` also hardens them plus `.env` and `.knowledge-git/config` on existing installs, so a new secrets file should be added to that list too.

Used by `files.js` (every wiki + log + index + conversation write), `health.js` (destructive Health fixes), `config.js` (sync writes to `.curator-config.json`), `health-dismissed.js` (JSONL rewrite), `sharedbrain-local-adapter.js` (`_writeFile` chokepoint), and `ingest.js` (raw source save). **NOT used by append-only JSONL audit logs** (MCP write log, sharedbrain audit JSONL) — `appendFile` is already crash-safe at line granularity on local filesystems.

### `src/brain/write-registry.js` (v3.0.1-beta.8+)

In-memory + file-based coordination layer that prevents destructive operations (app update, restart, git sync, domain delete) from racing in-flight writes (ingest, compile-to-wiki, health-fix-all). Same in-process module shared between the web server and (via the file-lock half) the MCP child process spawned by Claude Desktop.

| Export | Description |
|--------|-------------|
| `registerWrite(domain, op)` | Long-running write registers on entry; returns a `release()` token the caller MUST invoke in `finally`. Uses `Map<domain, refcount>` so two ingests on the same domain coexist correctly. |
| `hasActiveWrites()`, `isDomainActive(domain)` | Fast checks used by conflicting endpoints to decide whether to refuse with 409. |
| `conflictResponse(attemptedOp)` | Builds the standard `{ status: 409, body: {...} }` payload — names the active domain + ops, mentions whether an update is in progress. |
| `beginUpdate()` / `endUpdate()` / `isUpdateInProgress()` | Domain-global flag for the `/api/update` flow (git reset + npm install + restart). Ingest + compile routes check this in addition to the per-domain registry to close the millisecond race window. |
| `acquireFileLock(domainDir, opts)` | Cross-process advisory lock at `<domain>/.write-lock` (JSON: pid, op, startedAt). Returns a `release()` function on success, `null` if another process holds a fresh lock. 30-minute stale-lock TTL + `process.kill(pid, 0)` liveness probe; stale or unparseable locks are silently cleared on the next acquire. Exclusive by link(2) since v3.40.0 — until then it was existsSync + rename(2), which double-granted. |
| `isFileLocked(domainDir)` | Non-acquiring check — used by MCP write tools to refuse fast without trying to take the lock themselves. |

The file lock is what lets the MCP server (separate child process spawned by Claude Desktop) coordinate with the Curator web server. The in-memory registry is faster and authoritative for the web server's own routes; the file lock is the cross-process boundary.

### `src/brain/ingest.js`

```js
ingestFile(domain, filePath, originalName, isOverwrite?, onProgress?, opts = {})
  → Promise<{
      title: string,
      pagesWritten: string[],
      changes: ChangeRecord[],   // v2.5.0+: per-file {canonPath, status, bytesBefore, bytesAfter, sectionsChanged, bulletsAdded}
      warnings: string[],        // v3.0.1+: truncation, validator patches, stub pages
      truncated: boolean,        // v3.0.1+: was the source > 80k chars?
    }>
  // opts.signal — AbortSignal (v3.4.0+): checked FIRST in every LLM-reachable
  // recovery catch (Phase 1 retry, Phase 2 → page-by-page → stub, single-pass
  // → multi-phase) so an abort can never be "recovered" into a stub page that
  // keeps spending. Optional; ingest.js's own behaviour is byte-identical
  // when no signal is passed.

computeSummarySlugFromSource(originalName)  → string                    // v3.0.1+
extractAuthorHints(text)  → string[]   // YAML/byline/"Author:" scan    // v3.0.1+
slugifyName(name)  → string            // honorific-stripped slug       // v3.0.1+
validateOutline(outline, summaryPath, originalName, originatorHints?)
  → { outline, warnings: string[] }                                     // v3.0.1+
isOutputTokenLimit(err)  → boolean     // shared token-limit classifier // v3.0.1-beta.27+
parseJSON(raw)  → object   // shared with compile.js
```

Single-pass for small/medium documents (input ≤ 15,000 chars). Falls back to
a two-phase pipeline (outline → batched content) for larger inputs or after
a single-pass parse failure. The index is merged programmatically by
`mergeIntoIndex` (imported from `compile.js`) — no LLM call (v3.0.1+).
A REQUIRED COVERAGE checklist is injected into both prompts (single-pass and
multi-phase outline) so the LLM always produces a summary at the canonical
slug, an originator entity for the source's author/speaker, and applies the
parent-over-children consolidation rule.

### `src/brain/ingest-queue.js` (v3.3.0+)

Batch-ingest job orchestration — see [§ Batch ingest queue](#batch-ingest-queue-v330) above for the design rationale (sequentiality, staging, duplicate handling, why the job directory lives outside `domains/`, and the v3.4.0 Pause-vs-Cancel `AbortSignal` threading). Disk state is one manifest JSON per job under `getIngestQueueDir()` (`paths.js`), written via `writeFileAtomic`.

| Export | Description |
|--------|-------------|
| `createJob(domain, files, opts)` | Stages uploaded files into the queue's own directory, decides duplicate/skip status once against `raw/`'s pre-batch state, returns the job id. |
| `startOrResumeJob(jobId)` | Claims a process-wide mutex synchronously (not check-then-await-then-set) before doing any async work — the TOCTOU window a double-click or two tabs can hit. |
| `requestPause(jobId)` / `requestCancel(jobId)` | Sets a live (never persisted) control flag; cancel additionally aborts the in-flight item's `AbortController` if one is published. |
| `getJob(jobId)` / `listJobs()` / `toWire(job)` | Read the manifest; `toWire` is an explicit allow-list with length caps (not a `...rest` spread) so a raw fs error or an oversized field can't leak an absolute path or blow the wire size. |
| `reclaimStrandedItems(job)` | Runs at the top of every loop iteration and inside the settle chokepoint — a job cannot reach `done` while any item is non-terminal. |
| `estimateIngestQueueCost(domain, files)` | Free, local cost-range estimate shown before any upload — the confirm gate. |

### `src/brain/raw-store.js` (v3.5.0)

Raw-source resolution and text extraction — see [§ Raw source retrieval](#data-flow-raw-source-retrieval-v350) above for the full threat model and containment layering.

| Export | Description |
|--------|-------------|
| `resolveRawSource(domain, sourceName)` | THE chokepoint. Untrusted `source:` string → `{ok:true, absPath, filename, bytes, mtime}` or `{ok:false, reason}`. Never throws. |
| `sourceForSummary(domain, summaryPath)` | Reads a summary's frontmatter, classifies its `source:` value (local file / `external-source` / `not-a-summary` / `no-source-recorded`), and resolves it if it's a local file. |
| `looksLikeExternalSource(value)` | Classification only — a web-page-shaped `source:` is reported as text and never fetched (SSRF avoidance). |
| `readRawSourceText(absPath, maxChars)` | Extracts text (PDF via `pdf-parse`, else `readFile`), byte-capped with character-boundary-safe truncation; refuses anything that doesn't decode as text rather than emitting mojibake. |
| `hashRawSource(absPath)` | Streamed sha256, opt-in (`?hash=1` on the route) since it reads the whole file. |

### `src/brain/working-state.js` (v3.17.0)

Portable working state — the store behind "carry the build context from this session into the next one, on any machine, in any harness, with any model". Full user-facing treatment in [working-state.md](working-state.md); this section covers where it sits in the system and the three decisions that constrain everything else about it.

It is **a store**, in the sense that it exposes plain functions, renders no prompt and calls no LLM — every decision about what to say to a model lives in its callers. It has **two** of those, and they are not symmetric. The MCP tool layer (`mcp/tools/working-state.js`) both reads and writes it; `src/routes/memory.js` (`GET /api/memory`, `GET /api/memory/:project` — mounted in `src/server.js`, and the backing for the Agent memory view described under "The redesigned shell" above) only reads it, and that asymmetry is a design decision rather than an unfinished write path. **The store has exactly one writer: an agent, through `save_working_state`.** That single-writer property is what makes the per-machine layout safe — decision 2 below turns on two machines never touching the same file, and a browser writer would make the app a second writer to files whose whole safety argument assumes there is one. It would also stamp a human's edit with the last agent's harness/model provenance. A human who wants to edit the standing brief opens `state/project.md` in Obsidian; that is the answer, not a gap. (`saveProjectBrief` is exported here and called from nowhere in `mcp/` or `src/routes/`, for the same reason: the brief is human-authored on purpose. The **read** side now depends on that fact as well — see decision 4 below.) It is written to be imported inside the MCP stdio child, so it must keep stdout pure — `console.error` only, per the v2.5.3 stdout-pollution rule. Its reads go to the filesystem directly and deliberately **not** through `mcp/graph.js`, whose cache invalidates on **file count**: an in-place overwrite of `current.md` never changes the count, so a cached read could serve state up to the cache TTL out of date, and stale state is worse than no state.

**Layout is `domains/<project>/state/`** — `project.md` (the standing brief, hand-authored by the owner and returned on every read; see decision 4 for why that authorship is load-bearing on the read side), `<scope>/<machine>/current.md` (the handoff, overwritten each save), `<scope>/<machine>/journal.jsonl` (append-only, one line per save). `state/` is a **sibling** of `wiki/` and is never written through `writePage`: that function redirects non-canonical paths into `entities/`/`concepts/`/`summaries/` and flattens to the basename, so the `(project, scope)` pair is inexpressible there.

**Three decisions, each measured rather than preferred:**

1. **State supersedes; knowledge accumulates.** `mergeWikiPage`'s union merge is correct for knowledge and wrong for state — a resolved blocker would be resurrected by the next write, because a union has no way to express *no longer true*. Hence a separate store with overwrite semantics. The corollary is a boundary users need stated: a failure whose value is the **pattern across incidents** is knowledge and belongs on a wiki page via `compile_to_wiki`, where it compounds and is graphed; only the recent scope-local tail lives in state.
2. **The `<machine>` segment is load-bearing — and it is not a hostname.** `state/` matches none of `DOMAINS_GITIGNORE_RULES`, so it syncs, and `sync.pull()` resolves with `git pull --no-rebase -X theirs`. Two machines writing the same `current.md` would destroy each other's handoff with no error; per-machine paths mean no conflicting hunk ever arises. Proven against real git.

    **It is a guarantee about MERGES, and only about merges — do not read it as "state is safe from sync".** Path uniqueness prevents two writers colliding *inside* one file. It does nothing about an operation that replaces the file wholesale, because there is then nothing to collide with. That gap is not hypothetical: in August 2026 four handoffs and the appended half of an append-only `journal.jsonl` were destroyed on a real machine with this layout working exactly as designed the whole time. The mechanism was not a merge — connecting Personal Sync in *pull* mode ends in a checkout of the remote tree over the work tree, and the ladder behind it ended in `git reset --hard`, which is the one tree-writing git command with **no** untracked-file safety check. A machine's own `state/<scope>/<machine>/` folder sits at a path the remote also has, so it was checked out over *itself* from an older revision. The guards for that class live in `src/brain/sync.js` — a preflight that measures what a checkout would overwrite, a merge mode that commits local work first, and a `confirmOverwrite` gate — **not in the layout**. See [working-state.md § What the per-machine path does not protect against](working-state.md#what-the-per-machine-path-does-not-protect-against).

    **What `-X theirs` actually does is worse than "discards your write", and the milder outcome was the only one recorded here until v3.17.2.** It is not *take their whole file* — it is a conflict **preference** inside an ordinary three-way line merge, so it governs only hunks **both** sides changed. Where one machine re-sends a section unchanged since the merge base, the other side's edit applies cleanly and the merge **splices**: measured on real git, the survivor carried machine A's headline, provenance line and timestamp with machine B's `## Firm decisions` substituted in — `Auto-merging`, exit 0, no conflict marker, clean tree. A well-formed document that existed on neither computer, whose own header attests to a decision its named author never made. Nothing flags it: `headingsSuspect` and `sanitisedOnRead` both detect a *malformed* file and a spliced one is not malformed. The capture discipline makes it **likelier**, not rarer — the skill requires every save to be complete rather than a delta, so unchanged sections are re-sent verbatim, which is exactly the condition for a clean merge instead of a conflict. Reproduced in `scripts/test-working-state-sync.js` §2b.

    **That argument covers tiers 2 and 3 only.** `state/project.md` has **no** machine segment — it is one file per project by design, because the brief belongs to the project rather than the machine. Two machines that both edit the brief therefore *do* produce the conflicting hunk above, and it is the worse place for it: the brief is returned on **every** read, so both machines inherit a standing decision neither owner recorded. Exposure is small today (the brief changes rarely, and `saveProjectBrief` is its only writer), but anyone adding a second frequent writer must revisit this rather than inherit the tier-2 reasoning.

    **The hostname is not a safe way to spell "which machine", and that was measured rather than reasoned about.** Two clones slugified the same default macOS hostname to the same string, so both wrote the same path; the pulling machine's `git pull --no-rebase -X theirs` reported `Merge made by the 'ort' strategy`, left `git status` clean, printed no conflict marker — and that machine's own handoff was gone, `machineCount: 1`. `journal.jsonl` was clobbered in the same merge, so the append-only tier that exists to *be* the recovery path lost the history with it. `git log -S'<lost text>' --all` returns nothing, so the obvious search does not find it; recovery needs `git show HEAD^1:<path>` archaeology inside `.knowledge-git`, and the app has no revert UI. This is not an exotic configuration — default macOS names collide by construction, and the whole per-machine safety argument above rested on an assumption nothing checked. Identity is therefore per-**installation**: the segment is `<hostname-slug>-<install-id>`, where the id is three random bytes generated once and persisted in the user-data dir. That location is the fix, not a detail — an id stored inside `domains/` would sync to the other machine and re-create the collision it exists to prevent. It is composed rather than opaque so the folder stays recognisable in `ls` and in Obsidian, which is what makes a per-machine layout usable by a human at all.

    A folder already written as a bare hostname stays fully readable, is still listed, and is still chosen by the newest-first default; only the *next* save moves. It is deliberately **not** adopted as this installation's own, because proving it is ours is exactly what hostname collision makes impossible. If the id can neither be read nor written (a read-only home), the store falls back to hostname-only rather than failing the save — losing the collision guard costs a merge risk, refusing the save loses the handoff outright, and those are not the same size of loss. **The fallback is reported** (`installIdAvailable()`, surfaced on every save result, on every read reporting machine identity, and as a `note` where the degradation applies); until v3.17.1 it was not, and two docs claimed otherwise while the identifier appeared nowhere in the code.

    Cross-machine handoff is recovered on the **read** side: a scope with no machine named returns the most recently written machine and lists the rest.

    **The hostname half of the segment then had to be pinned too, and the sentence that used to end this paragraph — "which also degrades gracefully when a hostname changes" — was false.** The install id is a persisted file and was stable; `hostSlug()` was resolved fresh on every call, and macOS re-derives the hostname from DHCP. Measured on a real machine: one laptop owning `mac-9f3c1a` **and** `alices-macbook-pro-9f3c1a` under a single scope, same id in both, alternating with the network. Reading the newest machine does not make that graceful — it splits the append-only journal (22 entries in one folder, 4 in the other) and a scope-less read then returns half a workstream's history. So the chosen name is remembered in `.curator-machine-id`, beside the install id and outside `domains/` for the same reason, one level more urgently: the id is only *half* the folder name, whereas a synced remembered name is the whole path segment, leaving two clones nothing to differ by. Nothing is migrated — a machine already holding two folders keeps both, readable and addressable, and only the next save is pinned. Adoption of an existing sibling was considered and **rejected**: the machine segment is nested per scope, so the same installation would resolve differently in different scopes, and adoption keys on the id matching, so two installations that *had* collided on an id would actively merge — this code inventing the collision it exists to prevent.

    **Remembering the name was still not sufficient, because a PROCESS remembers too.** Both identity files are minted lazily and both answers are memoised, since `machineId()` is called on every read and every write of state and a `readFileSync` per call is waste. Two consequences were real, and the second was worse than the first. **(a) A provisional answer outlived its condition.** A process that resolved its identity while the user-data directory could not hold those files cached a hostname-derived name *for its whole life* and never observed the real file appearing beside it, while sibling processes read that file and used the other name — one machine, two folders, arriving through the cache instead of through the hostname; the same shape left `installIdAvailable()` reporting the guard as off long after it was armed. Only a value read from, or successfully written to, disk is cached now; a failure stays provisional and is re-attempted, which costs a syscall per call **only** on the already-degraded path. **(b) Two processes can mint at the same moment** — an MCP server that has been running for a day is the app's peer here, not its successor — and a plain write let both succeed, each clobbering the other and each keeping its own value. Because the install id's candidate is *random*, that splits every time rather than only on a hostname flap: measured with eight concurrent processes against one empty user-data dir, the pre-fix code produced **eight distinct folder names for one installation, in 6 of 6 rounds**, while the fix converged in 6 of 6. Both files are created with an exclusive `wx` open; the loser reads back and **adopts** the winner's value, so the file rather than any process's opinion is the authority. A file that exists but holds rubbish is still overwritten, so self-repair does not become a deadlock. That race is not reachable from an offline single-process suite, so it is guarded by reasoning and a timing-dependent harness rather than by `npm test`, and `scripts/test-working-state.js` §29 says so in its own NOT-ENFORCED block.
3. **Sanitisation runs on write *and* on read, and it defends against two different readers.** The feature's premise is that an agent acts on text a previous agent wrote, so "instruction-ness" cannot be neutralised — that is the product. What the rules do is narrower, and splits in two. Three of them escape a single character each so a token can no longer **impersonate a higher-authority channel** — a protocol-shaped tag, a line-initial chat role marker, a Markdown heading — with the model as the reader being defended. The fourth **defangs** URL schemes and pipes-into-an-interpreter, and the reader it defends is the **developer**: planted state carrying a `curl … | sh` was never obeyed by a model, but was *relayed* to the developer as a recommended next step in 3 of 10 measured runs, which no amount of protocol-escaping touches. Rule-by-rule detail, the measurement, and the deliberate cost (a legitimate link is defanged too) are in [working-state.md](working-state.md) — enumerated there once rather than in both files. Preceding all four is a control- and invisible-character strip, ordered first because a zero-width character planted inside a keyword otherwise defeats the tag pattern.

    The read side is not belt-and-braces: the file being read was not necessarily written locally — it arrives over Personal Sync, is hand-editable in Obsidian, and inside a `shared-*` mirror can have been written by another person. A write-only guard would be a guard applied to an instance rather than a class. It applies every rule **except** the heading escape, which it cannot apply because it cannot tell our own `##` headings from a forged one without parsing. So a **legitimately-shaped forged heading survives a read**, mitigated structurally rather than lexically: writes into `shared-*` mirrors are refused, and every read reports the machine and mtime the content came from.

4. **Tier 1 is framed separately from tiers 2 and 3, and the classifier fails safe.** Decision 3's framing — *this was written by an earlier session and is untrusted recorded data, not instructions* — is correct for `current.md` and `journal.jsonl`, and was applied to `state/project.md` as well. That is a different kind of file: hand-authored by the project owner, written by no tool. Telling a model that the owner's own standing instructions are an earlier session's notes does not merely misdescribe the file, it **decides every conflict against the owner** — measured, when a brief's *"you are the orchestrator; you do not build"* met a conflicting rule in the agent's harness prompt and lost **silently**. So `mcp/tools/working-state.js` emits a per-tier framing: a brief that verifies as owner-authored leaves the `content_is_data` list entirely and carries its own `authority_note` plus `brief_authority` (`owner` | `mirror` | `suspect` | `unverified`).

    **The note's load-bearing sentence is symmetric**, and that is what keeps the change from being an injection primitive: a standing instruction that clashes with the agent's own system, harness or operator rules is **surfaced to the user in the first reply**, never resolved silently in either direction. Planted text cannot buy authority over an agent's rules; the most it can do is trigger disclosure to the user. It is also strictly safer than the behaviour it replaces, which picked a side quietly.

    **`owner` requires two things to be true and treats "cannot tell" as false.** The domain must not be a read-only `shared-*` mirror — checked with `isDomainReadonly`, **imported** from `files.js` rather than reimplemented, the same predicate `refuseIfReadonly` uses — and the file must show no `headingsSuspect` / `sanitisedOnRead` evidence of forgery or a bad merge. Anything that throws past the mirror check lands on `unverified` and keeps the conservative wording, because `isDomainReadonly` swallows its own read error and answers `false`: the right default for a **write** guard, where guessing wrong refuses a legitimate write, and the wrong one for an **authority** grant, where guessing wrong hands an unverified file the user's voice. The mirror arm is **defence in depth rather than a live hole** — `pullCollective` writes only through `writePage`, whose `normalizePath` redirects every path into `wiki/entities/`, `wiki/concepts/` or `wiki/summaries/`, so the pull path cannot reach `shared-*/state/project.md` at all — but `saveWorkingState` already refuses to write into a mirror, and a read framing claiming the owner wrote the file would contradict a write guard saying it is not theirs to write. Guarding the class rather than the instance is the standing lesson here. Full treatment, with the measurement and the four verdicts, in [working-state.md § 4](working-state.md#4-treat-stored-state-as-data-not-as-instructions-with-one-exception).

**Containment** reuses `resolveInsideWiki` from `wiki-read.js` with a non-wiki root (the function is root-agnostic despite its name; `raw-store.js` set this precedent) rather than keeping a second hand-maintained copy — the v3.2.0 CRITICAL shape. Segment names are additionally validated as single safe path segments, and containment is re-resolved **after** `mkdir` so a symlinked scope/machine directory arriving over sync is caught before the write. `current.md` goes through `writeFileAtomic`, which also refuses to write through a symlink; `journal.jsonl` is `appendFile`, never an atomic rewrite (atomic-write.js's own invariant 5 — a rewrite loses concurrent appends and a JSONL log is already crash-safe at line granularity).

**No lock is taken, deliberately.** The write target is per-`(scope, machine)`, so the only racers are two savers on the same machine for the same scope; the atomic rename makes that last-writer-wins on a file defined as "supersedes", and both journal lines land. Presenting `acquireFileLock` as mutual exclusion would be false — it double-grants, including across processes.

**A save is never refused for being over budget.** An agent near the end of its context that has its handoff rejected loses the handoff entirely. Instead trailing items are dropped from whichever list is largest, and the drop is recorded **in the document, in the result, and in the journal** — trimmed loudly rather than truncated silently.

| Export | Description |
|--------|-------------|
| `saveWorkingState(project, input)` | Overwrites `current.md` for `(project, scope, machine)` and appends one journal line. `input` carries a required `headline` plus `nowState`, `nextSteps`, `decisions`, `observations`, `traps`, `openQuestions`, and optional `scope` / `machine` / `harness` / `model`. Returns `{ok:true, …}` or `{ok:false, reason, message}` — **never throws**. The journal append is best-effort and never fails the save. |
| `saveProjectBrief(project, input)` | Overwrites `state/project.md` from `brief` / `decisions` / `workingModel` / `pointers`. Separate from the above on purpose: this tier is deliberate and rare, and it is returned on every read, so it must not churn with sessions. **Nothing in `mcp/` or `src/routes/` calls it** — the brief's only real writer is a human in Obsidian, and that absence is what decision 4 relies on. |
| `readWorkingState(project, opts)` | Always returns the brief. With `opts.scope`, also that scope's `current.md`, the machines holding state under it, and recent journal entries; without one, the scope index. Never throws; every file read is byte-capped at the source. |
| `listWorkingScopes(project)` | Every `(scope, machine)` pair with state, newest first, each with its last write time, age and latest headline. A hard requirement rather than a convenience — an agent told "carry on with the auth work" cannot otherwise resolve that to a scope slug it has never seen. |
| `machineId(override)` | This machine's path segment. **Remembered, not recomputed:** it returns `.curator-machine-id` when that file holds a segment `isSafeSegment` accepts, and otherwise composes `<hostname-slug>-<install-id>` once and writes it there. The file is input, so it is re-validated on read rather than trusted. Still resolved **per call** (a module-scope `const X = getter()` is the v3.1.0 import-order bug this repo has a source guard against) — what is cached is the file, not the answer to a snapshotted path, and that sentence has only recently become true: a name that had been *composed but not successfully written* used to be cached too, which is the whole of the defect below. An explicit `override` neither consults nor overwrites what is remembered, and never has the install id appended — but it is **not** taken verbatim: it goes through the same `slugSegment` normalisation as the hostname path (with a trailing `.local` stripped), so `My Machine.local` resolves to `my-machine`, and a value that cannot be normalised into a safe segment is refused with `null`. An unusable hostname falls back to a literal rather than throwing: losing the machine distinction is a merge risk, refusing to save loses the handoff. |
| `installId()` / `installIdAvailable()` | The per-installation id and whether it could actually be persisted. Cached per **resolved** user-data directory, never at module scope against a snapshotted path — `userDataPath()` is re-resolved per call, so an override installed after import (which every test does) must change the answer. **Only a positive result is cached** — see below. |
| `sanitiseBlock` / `sanitiseLine` / `sanitiseList` / `sanitiseObservations` / `neutraliseProtocol` / `defang` / `escapeHeadings` | The sanitiser surface described above. None throws on any input. `neutraliseProtocol` is idempotent by construction, which matters because it runs on every read; `defang` is called from inside it, so the read path gets the URL/pipe rule without a second call site to keep in step. `escapeHeadings` is the one rule the read path cannot apply. |
| `resolveInsideState(project, relPath)` | The single path chokepoint into `state/`. Nothing else may build one. |

**The read side reports the completeness of its own answer, and the reason is a defect it already had.** `listWorkingScopes` caps the index at `MAX_INDEX_ENTRIES` pairs, so every number derived from the returned array is a count of the *slice*, not of the store. It therefore returns `distinctScopeCount` computed over the **uncapped** pair list — the count must be taken before the slice or it is a measurement of the cap. It also returns `unlistedEntries`, the number of directory entries under `state/` that `isSafeSegment` will not address (an entry the store can see but cannot open is not the same fact as no entry at all), with `unlistedReason` stating the rule so the user can rename to something addressable. A named scope is resolved from **its own directory**, never by filtering the truncated index: past the cap that filter returned "no state saved under scope X" with the file intact on disk, and the agent, told its handoff did not exist, would start cold and overwrite it on the next save. Note that `scopeCount` means one thing on the store's index and another on `GET /api/memory/:project`; both routes carry unambiguous names beside it, and the disambiguation is documented once in [api-reference.md](api-reference.md) rather than restated here.

**Refusal reasons** are returned, not thrown. The full set is enumerated once, in [api-reference.md](api-reference.md) under "The store's own contract" — deliberately not restated here, because a second hand-maintained copy of that list is what let this section run one reason short of the code for a release. Two of them exist for architectural reasons rather than input validation, and belong here: `unknown-project` refuses a name that is not a real domain, because a folder with no `CLAUDE.md` is invisible to `listDomains()` — hidden from the app, the wiki reader, Health, chat retrieval and every MCP tool — so state written there would go unseen (until v3.34.0 the reason given was that `sync.pull()`'s prune would `rm -rf` it, which stopped being true when the prune was narrowed to folders a pull actually deleted); and `would-replace-larger-state` refuses a near-empty save aimed at a scope already holding a substantially larger handoff, which is the shape of a context-starved agent about to erase good state (`replace: true` is the deliberate override — the refusal costs one retry, the overwritten document is not recoverable).

### `src/brain/tray-summary.js`

One cheap call behind the menu bar widget — `getTraySummary({limit, now})` — and the whole data surface of the tray: the shell calls it, renders what comes back, and asks nothing else.

It is a **projection over the working-state store, not a second inventory of it.** It calls `listWorkingScopes()`, the same function `GET /api/memory` and the MCP call, so the tray and the Agent memory view can never disagree about what is on disk. It costs exactly what `GET /api/memory` costs — one `readdir` plus a stat per candidate, then per project one stat per `(scope, machine)` pair and one 16 KB journal-tail read per pair returned. No LLM, no network, no subprocess, and no write to the store.

It is its own module rather than a function inside `working-state.js` for three reasons, of which two are structural: the store has no notion of *how many projects* and deliberately never has (`MAX_PROJECTS` is the consumer's bound, in `src/routes/memory.js`), and this row carries facts the store does not own — `remote` is a Personal Sync fact, and importing `sync.js` here would drag a `git fetch` into the import graph the MCP child loads on every spawn, which is exactly the graph the stdout-discipline rule is stated over. **It imports nothing from `sync.js`**, so no edit to this file can reach `getRemoteStatus()` without adding an import a reviewer will see.

| Export | Description |
|--------|-------------|
| `getTraySummary(opts)` | `{ok, lastSave, scopes[], total, pairsOnDisk, truncated, pulse, brief, remote, warnings[]}`. **Never throws** — a store that cannot be read yields empty arrays and a warning, because a menu that renders an exception is one the user reads as "the app is broken". Rows arrive **ordered, newest first**, on the chosen clock; a consumer must not re-sort |
| `computePulse(pairs, now)` | Pure and **exported**, so bucket boundaries can be driven directly rather than inferred from a tree on disk. 28 buckets of 6 hours over 7 days, oldest first, counted **before** the display slice. `null` only when no journal was read at all — a store with journals but no usable timestamps is a real, drawable state (`clock: 'none'`) and must not collapse into *there is no store*. Costs **no** file I/O: the timestamps were already parsed to age each row and were previously discarded |
| `machineIdentity(machine, self, host, hostRe, selfInstallId)` | Pure and exported, so the degraded `selfInstallId: null` case can be driven directly — a tempdir install always mints an id, so deleting that guard ran green through the whole end-to-end suite. Matches on the **trailing installation id alone**; two `null` ids never compare equal |
| `noteRemoteStatus(payload, now)` | Records the result of a remote check somebody **else** performed. An unconfigured install records nothing — that is not an observation of "0 waiting". A failed check keeps `behindFiles: null` rather than collapsing "we could not ask" into "nothing is waiting" |
| `__resetRemoteObservation()` | Test seam |
| `TRAY_DEFAULT_LIMIT` (8) · `TRAY_MAX_LIMIT` (40) · `TRAY_MAX_PROJECTS` (200) · `REMOTE_OBSERVATION_MAX_AGE_MS` (5 min) | `TRAY_MAX_PROJECTS` is deliberately the same number as `MAX_PROJECTS` in `src/routes/memory.js` and deliberately **not imported** from it (`src/brain/` must not import from `src/routes/`). Matching matters more than the value: a tighter cap here would make the tray say "nothing saved" about a project the Agent memory view lists happily. If one moves, move both |

**Every number is a measurement or a `null`.** An age that is not known arrives as `null`, never `0` and never a string. `total` is counted **before** the slice and `pairsOnDisk` counts every pair the store saw, so a cap can never be read as a measurement — without those a consumer cannot tell "capped at 8" from "there are exactly 8", and the one case where a user most needs telling there is more is the case that renders as a complete list. `lastSave` is `scopes[0]` re-projected from the **same object**, so the headline and the first row can never name different saves.

`ageSource` (`'agent' | 'file'`) is the field the widget's honesty rests on: `writtenAt` is the agent's own clock from the journal line, `lastWriteAt` is this disk's mtime, which git rewrites on checkout. The tray shows one age, so it chooses — and having chosen, it says which. Both raw facts are emitted too, under names that can only mean one thing.

### `src/brain/wiki-read.js` (v3.2.0+)

Single-page read plus backlinks for the reader panel — see `GET /api/wiki/:domain/page` in [api-reference.md](api-reference.md). Deliberately does not import from or get imported by `mcp/` (the MCP is a stdio JSON-RPC child process; see the module's own docblock). `resolveInsideWiki`, its path-containment chokepoint, is also imported by `health.js` and `raw-store.js` — one hardened implementation, not three.

| Export | Description |
|--------|-------------|
| `getWikiPage(domain, requestedPath)` | `{domain, path, folder, slug, title, type, frontmatter, body, backlinks, resolvableTarget}`. Throws with `.status` (404/400) on an unknown or escaping path. |
| `getBacklinks(domain, targetFolder, targetSlug)` | Pages linking to a given target, using the exact same link-resolution rule `health.js`'s `scanWiki()` uses to decide a link is broken — the reader and Wiki health can never disagree. |
| `resolveInsideWiki(wikiDir, candidate)` | Lexical + physical (`realpath`) containment chokepoint; refuses symlink escapes and dangling symlinks. |
| `listWikiInventory(domain)` | New — the data source for `GET /api/wiki/:domain/list` (see [api-reference.md](api-reference.md)). Readdir-only page inventory (`{slug, folder, path, title}` per entry, capped at 20,000), built on `health.js`'s `listMd()` rather than a fresh readdir so it can never list a page `getWikiPage` would refuse to open. This makes `wiki-read.js` and `health.js` import each other — safe here because both symbols crossing the cycle are hoisted function declarations that neither module calls at module-evaluation time; see the import comment at the top of `wiki-read.js` before changing either side. |

### `src/brain/chat.js`

```js
sendMessage(domain, conversationId, userMessage, opts = {})
  // opts: { responseStyle, provider, model, signal, onDelta }
  → Promise<{ conversationId, isNew, title, answer, citations[], citationTitles,
              responseStyle, provider, model, usage }>
  // `model` is the model that ANSWERED (taken from the last onUsage payload),
  // not the one requested — so it is correct across both an allow-list refusal
  // and a fallback-chain walk. `usage` is the same payload's four token counts,
  // or null when nothing valid was reported — see "Per-answer cost" under
  // Model selection, above. Both are also persisted onto the saved assistant
  // message (buildAssistantMessage), so a reloaded conversation carries them.

normalizeChatProvider(provider) → 'gemini' | 'anthropic' | null
normalizeChatModel(provider, model) → '<id>' | null
  // Two gates, both required: isOfferableModel(provider, model), AND that
  // provider having a key SAVED IN SETTINGS (getApiKeys, never getEffectiveKey).
  // Anything else → null → the provider's default model. Never throws.

listConversations(domain)   → Promise<ConversationMeta[]>
readConversation(domain, id) → Promise<Conversation | null>
deleteConversation(domain, id) → Promise<void>
```

### `src/routes/config.js`

Settings and configuration endpoints.

```
GET  /api/config               → current app configuration, including the resolved `backgroundMode`
                                 and `backgroundModes` (the legal set this build understands)
POST /api/config/background-mode → set 'window' | 'tray' | 'tray-only'. NOT guardConcurrent'd — nothing
                                 on any write path reads it, so a 409 would only refuse to let a user
                                 turn off a menu bar icon while the app is busy with something else
POST /api/config/domains-path  → set domains folder path
POST /api/config/pick-folder   → macOS native folder picker (osascript)
GET  /api/config/api-keys      → masked keys + active provider info, plus (v3.12.0+) `offerable`
                                 (the per-provider model catalogue) and `selectedModels`
                                 (the user's explicit pick per provider, or null)
POST /api/config/api-keys      → save API keys (partial update)
POST /api/config/api-keys/disconnect → clear one provider's saved key (v2.4.2+)
POST /api/config/api-keys/active     → switch the active provider without re-saving a key (v3.0.1-beta.24+)
POST /api/config/api-keys/model      → persist the user's model choice for one provider, or clear it (v3.12.0+).
                                       guardConcurrent'd; config-only key gate; validates via isOfferableModel
GET  /api/config/update-check  → compare local vs GitHub version
POST /api/config/update        → git fetch + git reset --hard origin/main + npm install + rebuild .app (build-app.sh) (v2.3.2+)
POST /api/restart               → spawn new server process, exit current one
```

---

## Frontend binding hardening (`src/public/app.js`, v3.1.0 — historical; `app.js` deleted in v3.41.0)

**This whole section describes a file that no longer exists.** `src/public/app.js` (the pre-redesign shell) and its guard, `scripts/test-frontend-null-safety.js`, were both deleted in v3.41.0 when `/old` was retired. The section is kept as a record of the reasoning, because the same failure shape — a missing element dereferenced at module scope blanking the whole app — is a live risk in `src/public/next/app.js` too, and there is no equivalent guard over that file today.

`app.js` was one roughly 8,200-line ES module with roughly 90 top-level `const x = document.getElementById(...)` / `document.querySelector(...)` declarations (the exact count the now-deleted suite pinned on every run). `getElementById`/`querySelector` never throw — a missing element just returns `null` — but *dereferencing* that `null` does. If the dereference happens at module scope (not inside a function body), the resulting `TypeError` aborts evaluation of the rest of the module: every listener below that point never binds, every tab past that point is dead, and the auto-updater ships that blank/broken page to every user on their next check-for-updates.

An audit ahead of this release found this shape live in several places — most notably two bare `document.querySelector('[data-tab="…"]').addEventListener(...)` calls (an absent tab button, e.g. from a future markup typo, would have blanked the whole app) plus a dozen `getElementById(...)` siblings of the same shape, plus a handful of module-scope consts (`dropZone`, `fileInput`, `chatInputEl`, and others) dereferenced unguarded at module scope. The fix is exactly 33 `?.` guards added at each dereference point — the same idiom the file already used consistently elsewhere — plus the three most heavily-reused helpers (`showEl`, `hideEl`, `showStatus`) now log via `console.error` and return instead of throwing when passed a missing element.

**Scope, stated precisely so this isn't over-read:** this closes the *load-time* failure mode — a missing element can no longer blank the entire app during module evaluation. It does **not** make every runtime dereference in the file null-safe. Two known examples remain deliberately unfixed: `chatSendBtn.click()` inside `chatInputEl`'s own (now-guarded) `keydown` listener, and `chatInputEl.focus()` inside `newChatBtn`'s own (now-guarded) `click` listener — both bare references to a *different* element than the one whose listener just fired. If that inner element were ever missing while the outer one was present, that specific handler would still throw when triggered. Closing every cross-element reference inside every handler body is restructuring work (a tab-navigation registry, splitting the file into modules) explicitly out of scope for this release; `scripts/test-frontend-null-safety.js`'s header documents both known instances by name so the gap isn't silently forgotten.

`scripts/test-frontend-null-safety.js` was a dependency-free scanner (no parser dependency, in the spirit of `scripts/test-css-tokens.js`) that verified every top-level-equivalent dereference was `?.`-guarded or provably narrowed by an earlier guard. It deliberately carried a second, independent, "dumb" recount of the same declarations, cross-checked for exact agreement with the main scanner — see [CONTRIBUTING.md § Writing a good test](../CONTRIBUTING.md#writing-a-good-test) for why that redundancy is load-bearing rather than decorative. Deleted alongside `app.js` in v3.41.0.

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | ^0.39 | Anthropic Claude API client |
| `@google/generative-ai` | ^0.24 | Google Gemini API client |
| `express` | ^4 | HTTP server and routing |
| `multer` | ^2 | Multipart file upload handling |
| `pdf-parse` | ^1 | Extract text from PDF files |
| `@modelcontextprotocol/sdk` | ^1.29 | MCP server transport + protocol types for `mcp/server.js` |
| `jsonrepair` | ^3.13 | Last-resort repair of malformed LLM JSON in `parseJSON()` |
| `dotenv` | ^16 | Load `.env` into `process.env` |

`package.json` is authoritative. **There is no `fs-extra` dependency** — it was listed here in error; all filesystem work uses `node:fs/promises` plus `src/brain/atomic-write.js`.

**No Axios.** All HTTP is handled by the Express server or Node's native `fetch`. If Axios is added in future (e.g. for URL ingestion), avoid compromised versions `1.14.1` and `0.30.4`; pin to a safe version such as `1.7.9`.

---

## Design decisions

**Why markdown files instead of a vector database?**
Not because the wiki fits in one context window — a mature domain long ago stopped fitting (the real `articles` wiki is ~4.4 MB against chat's 60 KB content budget). Chat handles scale with **query-driven retrieval** in `src/brain/chat.js` (entity-pivot detection + keyword scoring + a compact slug catalogue, bounded by `CONTENT_BUDGET_CHARS` / `CATALOGUE_BUDGET_CHARS` / `MAX_PAGES_LOADED`), not embeddings. The reason to stay embedding-free is that the `[[wikilink]]` graph is already a hand-curated relevance signal that a vector index would only approximate — and markdown files stay human-readable, portable, and native to Obsidian's graph view.

**Why a provider abstraction layer?**
`llm.js` keeps `ingest.js` and `query.js` free of provider-specific code. Switching between Gemini and Claude requires only changing an env var — no code changes. Adding a third provider (e.g. local Ollama) means only touching `llm.js`.

**Why one CLAUDE.md schema per domain?**
Domain context shapes how the LLM categorises knowledge. An AI/Tech wiki uses different entity types and concept hierarchies than a Personal Growth wiki. Per-domain schemas give each wiki a specialist, not a generalist.

**Why vanilla JS instead of React/Vue?**
The UI is a left rail (Chat · Domains · Shared Brain · Agent memory · Ingest, with Sync and Settings in the footer); Wiki is an Esc-dismissible reader overlay and Health is a panel inside a domain. The pre-redesign frontend (deleted in v3.41.0) had the original seven tabs (Chat · Ingest · Wiki · Health · Domains · Sync · Settings) and a handful of fetch calls. A framework adds build complexity and bundle size with no meaningful benefit for a local personal tool.

**Why JSON mode for ingest but not chat?**
Ingest requires structured output (pages + index as a JSON object) that must be machine-parsed. Chat returns free-form markdown prose; JSON mode would constrain the writing style unnecessarily.

**Why save conversations as JSON files instead of a database?**
Consistent with the project's "no external database" principle. JSON files are human-readable, portable, and trivially backed up or shared. SQLite would add a dependency and binary file for a feature that doesn't need relational queries. Each conversation is a self-contained document.

**Why are conversations gitignored from the app repo but synced through the knowledge repo?**
Conversations are personal knowledge — specific to each user's ingested documents and questions. They are gitignored from the app's own repository (so contributors don't accidentally commit private data), but they live inside `domains/*/conversations/` which is included in the knowledge repository managed by the Sync feature. This means conversations travel with the rest of your knowledge when you sync across computers, while still being invisible to anyone looking at the app's source code on GitHub.

**Why use git with `--git-dir` / `--work-tree` for sync instead of a library or dedicated sync service?**
Git is already a prerequisite for installing the app (`git clone`), so no new dependency is introduced. Using a bare repository at `.knowledge-git/` with `domains/` as the work-tree keeps the knowledge repository completely separate from the app's own git history — users can sync their notes without touching the app's commit log, and developers can work on the app without polluting the knowledge repo. For authentication, a Personal Access Token embedded in the remote URL is the simplest possible mechanism for non-developers: paste once, forget about it. Alternatives considered were rsync (no conflict resolution, no history), a dedicated sync library (new runtime dependency, no offline support), and Dropbox/iCloud folder syncing (platform-specific, unreliable with git-tracked folders, requires a separate account). Plain git gives version history, conflict detection, and works the same way on every platform.

**Why manage domains in the UI instead of only in the filesystem?**
Creating a domain manually requires writing a correctly formatted CLAUDE.md schema, initialising two markdown files, and creating five directories — a process documented step-by-step but easy to get wrong. The Domains view automates all of this with four validated templates (Tech/AI, Business/Finance, Personal Growth, Generic). Each template generates a CLAUDE.md tuned for that domain's entity types and concept structure, eliminating a common source of poor ingest results. Rename and delete operations are also safer through the UI: the rename patches all affected files atomically and warns when sync is configured; the delete shows exact counts before confirming.

**Why YAML frontmatter instead of inline `Type:` / `Tags:` fields?**
Obsidian's Properties system (introduced 2023) and the Dataview plugin both consume YAML frontmatter natively — they do not parse inline body fields. By moving `type` and `tags` into a `---` block at the top of every entity, concept, and summary page, three things become possible without any plugin configuration: (1) the Obsidian Graph View can color-code nodes by tag (`tag:#type/entity`), (2) Dataview can query and table all pages by type, and (3) external AI agents reading the files get structured metadata without parsing prose. The `injectFrontmatter()` post-processor in `writePage()` acts as a safety net — if the LLM skips the instruction, the correct YAML is injected from the file path before the file is written. This means YAML is always present regardless of LLM compliance.

**Why include `type/entity`, `type/concept`, `type/summary` as tag values rather than a separate field?**
Obsidian's Graph View Groups filter operates on tags, not on arbitrary frontmatter fields. Using `tags: [..., type/entity]` means one setting in the graph panel (`tag:#type/entity → Blue`) colors all current and future entity nodes with no further configuration. A separate `nodeColor: blue` field would have no effect on the graph — Obsidian doesn't read custom fields for visual styling. The tag approach is the only mechanism that hooks into Obsidian's native graph coloring.

**Why "Atomic Decomposition" rather than "chunking"?**
Standard RAG pipelines chunk documents by token count or paragraph boundary — a mechanical split with no semantic awareness. The Curator's ingest pipeline performs Atomic Decomposition: the LLM reads the entire source and extracts discrete, named artifacts — Entities (nouns: specific people, tools, companies) and Concepts (verbs/ideas: techniques, frameworks, principles) — and writes a persistent page for each. These are semantically coherent units with cross-references baked in, not arbitrary text fragments. The distinction matters: chunks are retrieval units; atomic pages are knowledge units. They compound.
