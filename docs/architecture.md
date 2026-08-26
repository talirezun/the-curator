# Architecture

> This document is intended for developers who want to understand how the system works internally.

## Overview

The Curator is a local Node.js web application. It has no external database — all knowledge is stored as plain markdown files on disk. An LLM (Google Gemini or Anthropic Claude, selected by which API key is configured) is the only external dependency at runtime.

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

A second, complete frontend has lived at `src/public/next/**` since v3.1.3. It was built in parallel at `/next` while the original frontend (`src/public/app.js`) served `/`. **In v3.9.0 that flipped: the redesigned shell now answers `/` and the SPA catch-all, and the original frontend is the escape hatch at `/old`.** It is kept for two or three releases and then removed, so `/old` is a bridge, not a supported second interface.

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
- **`/old` is served without a trailing slash, and `/old/` is redirected to it.** The old frontend's asset references are *bare-relative* (`src="app.js"`), which resolve against the directory of the serving URL. At `/old` that directory is `/`, so `app.js` resolves correctly. At `/old/` it would request `/old/app.js`, which does not exist, so the catch-all would answer with the *redesigned* shell's HTML at `200 text/html` and the browser would parse HTML as JavaScript — the v3.6.1 asset-path landmine in mirror image. The trailing-slash test lives **inside** the one handler rather than as a second `app.get('/old/')` route: Express's router is non-strict by default, so a `/old/` route also matches `/old`, and a separate route redirected `/old` to itself in an endless loop.

`/next` and `/next/` keep working as an alias for bookmarks and for every link written during the redesign; the route serves the same single file as `/`, not a copy.

### View registry, `navigate()`, and the mount-token contract

`src/public/next/app.js` is the shell — a hand-rolled router, not a library. Each of the (currently seven) views lives in its own file under `views/`, registering itself via `registerView(name, { onEnter, onExit })` at that file's own top level. `navigate(name)` switches the active view and enforces two hard rules from the design spec **before** any view's `onEnter` runs, so no individual view can opt out of them:

1. The wiki reader overlay must never survive a view change — closed unconditionally on every `navigate()` call.
2. Rail navigation always clears the reader and closes the chat composer's model/length picker.

`onEnter` receives a `mountToken`. Any async work started inside it (a `fetch`, an SSE stream) must capture that token as a plain local variable at the point it's still known-fresh, then pass it to `setSidebar`/`setMain`/`openReader` (which each independently refuse to touch the DOM for a stale token) or check it via `isCurrentMount(token)` before doing further work. `navigate()` bumps the token on **every** call, including re-entering the same view by name, specifically so a still-pending fetch from an abandoned mount can never paint its result over a newer one.

This was hardened over three internal audit rounds, and the history is worth keeping because it's a real "looked equivalent, wasn't" case: the first two views built with real async work (Chat, Domains) used the token from the start; Settings and Sync, added later, predated the primitive and used a hand-rolled `let mounted = false` module-level boolean instead. A third audit round found this was **not** actually equivalent — a boolean can only answer "is *some* mount of this view still current," not "is *this specific* mount still current," which is the entire distinction the token exists to make — and reproduced the failure live: mount A's abandoned Sync push/pull result surfaced under mount B. Both views were migrated to the same token discipline every other view already used; there is no longer a second mechanism anywhere in the shell.

### The cross-view write gate (`beginDomainWrite` / `isDomainWriteBusy` / `isAnyWriteBusy` / `getDomainWriteLabel` / `onWriteGateChange`)

Destructive operations (ingest, a batch-queue item, a Sync push/pull, a Shared Brain pull) need to be visible to views *other than the one that started them* — Sync, Domains, and Settings all need to disable their own Push/Pull/Delete/Update controls while a write against a domain is in flight, mirroring the backend's own write-registry (`src/brain/write-registry.js`), which already 409s those endpoints mid-write. This is exactly the `/old` frontend's `window.__curatorIngestStart`/`__curatorIngestEnd` pattern, but rebuilt as a **shell primitive** rather than a global pair, specifically to structurally close a real bug in that pattern: `app.js`'s own `_queueBusyDomain` comment documents that its "enter" call was keyed on `job.domain` while its "exit" call re-read whatever the `#ingest-domain` dropdown happened to hold at a *later* moment — often empty on a page-reload resume, since two un-awaited loads can race the dropdown being populated — decrementing the wrong domain's count and leaving the right one's buttons disabled forever.

`beginDomainWrite(domain, opLabel?)` closes over the domain at the call site and returns a **release function**, not a domain string for the caller to re-supply later — there is no second call site holding its own copy of the key to drift from the first. Calling the returned handle twice is a harmless no-op; losing it entirely just leaks that one write as permanently "busy" for its domain (loud — a button stays disabled — rather than silent). Counts are ref-counted per domain (so two writes on different domains never block each other, and two on the same domain both have to release before it reads as free), and the state lives in the shell module, not inside any one view, so it survives navigating away from and back to the view that started the write — the same "shell state, not view state" treatment as `mountToken` and the reader overlay. `onWriteGateChange(fn)` lets any mounted view subscribe to re-render its own controls on any begin/release, anywhere; a subscribing view must unsubscribe in its own teardown.

**The gate's "survives navigating away and back" guarantee needed a second, shell-level holder for exactly one write kind: a batch-ingest job.** `views/ingest.js`'s own `onEnter` teardown releases the handle it holds the moment the user leaves the Ingest view, even though a batch job it started keeps running server-side — the batch is SERVER-owned and reattachable (`GET /api/ingest-queue/active`, `/:jobId`, `/:jobId/stream`), so the server, not whichever view happens to be mounted, is the authority on whether it's still running. `app.js` closes that gap with its own always-on watcher (`reportPossibleActiveJob()`, called from `boot()` and from `views/ingest.js` after starting or resuming a batch): it polls `GET /api/ingest-queue/active` every 4 seconds *only* while a job is genuinely `running`, and holds an independent `beginDomainWrite` handle of its own for that domain — composing safely with whatever handle `views/ingest.js` holds while it happens to be mounted, since the gate is a plain per-domain refcount. The one thing it must get right is what counts as "busy": a `paused` or `pending` job holds no backend write-registry entry (`src/brain/ingest-queue.js` only calls `registerWrite()` inside the per-item ingest call itself), and a paused job is the *routine* case for a crash-recovered job (v3.3.0's "never auto-start spend" rule) and for the queue's own rate-limit circuit breaker — so the watcher's transition logic treats only `running` as busy, never "not yet terminal."

### The shared batch-ingest logic module and its drift tripwire

`src/public/next/shared/ingest-queue-logic.js` holds 13 pure helper functions (plus one shared regex constant) for the batch-ingest queue UI, copied **byte-identically** from `src/public/app.js`. This isn't a refactor-later shortcut — the maintainer actively used the original frontend in production and found and fixed three real batch-queue defects there. A fix landing only in `app.js` would silently re-ship the same bug to the redesigned shell, with both frontends' own tests staying green because each only knows about its own copy.

`scripts/test-next-ingest-logic-drift.js` is the guard: it does not evaluate or run the functions — it extracts each one's **source text** from both files with a plain regex and string-compares it, byte for byte, on the reasoning that a behavioral test can pass while two implementations diverge in a way that only matters for an input nobody happened to sample, but a source comparison cannot miss any textual difference. It also independently scans `ingest-queue-logic.js`'s own top-level declarations and asserts the set matches a hardcoded name list exactly, so adding a 14th helper there without updating that list fails loudly too. If a bug is found in one of the 13 shared functions while working on `/next`, the fix goes into `app.js` first (which otherwise stays byte-untouched, but a genuine bug fix is exactly the kind of change that goes through normal review there) and is then copied down verbatim.

**This test is deliberately temporary — but its moment has not arrived yet.** It becomes meaningless when `app.js` is *deleted*, not when the cutover happened: the v3.9.0 cutover changed which shell answers `/` and left `app.js` in place at `/old`, so there are still two copies to drift and this guard is still required. Delete the file and its `OFFLINE` entry in `scripts/run-tests.js` when `app.js` is actually removed; do not repoint it at some other pair of files or repurpose it as a coverage test for the survivor. Note the direction of the copy rule still holds while both exist: a fix goes into `app.js` first, then is copied down verbatim.

### The shared Markdown renderer

`src/public/next/shared/markdown.js` holds the redesigned shell's single `renderMarkdown()`. It renders **both** chat answers (`views/chat.js`) and wiki page bodies in the reader overlay (`views/domains.js`). Until v3.8.0 it lived inside `views/chat.js`, which is why the wiki reader shipped escaped Markdown *source* in a `<pre>` — the second surface could not reach it without importing another view's internals, and duplicating an escape-first security guard was the worse of the two available answers.

Unlike `shared/ingest-queue-logic.js` above, this is **not** a byte-identical copy of the `/old` frontend's `src/public/markdown.js` and is not asserted to be: that one is a `window`-attaching IIFE loaded by a `<script>` tag, this one is an ES module. Both are maintained, and they have also **deliberately diverged on the ReDoS bound below** — the reason is recorded at the regexes in `src/public/markdown.js` itself, not here, because the person who widens that renderer's input is the person who needs to read it.

The cardinal rule is the same one `src/public/markdown.js` has carried since v3.0.10 — escape the whole string **first**, then insert only a fixed allow-list of tags by matching Markdown syntax in the already-escaped text; no input is ever interpolated into an attribute or a URL, and the renderer emits no `href`/`src` sink at all. That matters more here than it did in `views/chat.js`, because the lift **widened the input surface**: it now also sees wiki page bodies, which are LLM-authored, hand-editable in Obsidian, and delivered over Personal Sync and Shared Brain mirrors from other people's machines.

`scripts/test-next-markdown.js` (**OFFLINE**) is the guard. It was written and made green *before* the lift, against the renderer in its original home, and re-run unchanged after — which is what proves the move was behaviour-preserving rather than merely asserting it. Its §0 walks the whole `src/public/next` tree and fails if a second declaration named `renderMarkdown` reappears anywhere; that guard is deliberately **name-scoped, not algorithm-scoped**, and its own header says so — a copy pasted under a different name, a class method, or an aliased re-export all evade it. Its wikilink and citation passes carry measured `{1,512}` length bounds rather than `+`, pinned by §4b as a ReDoS bound.

### Status: what's real, what's a stub

This shell **is** the user-facing app as of v3.9.0. The pieces below are at different levels of completeness and this should not be overstated in either direction:

- **Chat, Ingest, Settings, Sync** — real, wired to pre-existing backend endpoints (no new server-side capability was added for any of them; each view's own top comment names the exact routes it calls). Ingest includes the full batch-ingest queue, not just the single-file path. Chat's composer model/length pickers, the reader-overlay content, and — newly — **Compile to Wiki** (streams `POST /api/compile/conversation`, rendered as an inline thread card exactly like the `/old` chat tab has since v3.0.14) are real, not placeholder.
- **Domains** (`views/domains.js`) — the Health panel described in its own top comment is real, and this release adds three more pieces. **Domain lifecycle** (create/rename/delete) is wired to the pre-existing `POST`/`PUT`/`DELETE /api/domains[/:domain]` routes — see [api-reference.md](api-reference.md) for the exact contract, including the display-name-only rename case where the slug does not change. **A wiki browse list** is the one place this release adds real server-side surface: `GET /api/wiki/:domain/list` (`src/brain/wiki-read.js` + `src/routes/wiki.js`, new) is a readdir-only inventory built on health.js's `listMd` rather than a fresh readdir — see [api-reference.md](api-reference.md) for the full contract and its deliberate title-from-slug trade-off. **The browse reader renders rich markdown**, through the same single renderer chat answers use (`shared/markdown.js` — see above). Until v3.8.0 it showed the page's escaped markdown SOURCE in a `<pre>` block instead, because the renderer lived inside `views/chat.js` and copying a security-sensitive escape-first renderer into a second file is exactly the "two hand-maintained copies of a guard" shape that produced the v3.2.0 CRITICAL; lifting it into a module both views import removed the dilemma rather than picking a side of it. Finally, the semantic-duplicate scan gained **per-pair Preview / Flip / Skip** actions alongside the pre-existing batch "merge all high-confidence pairs" bar, which was previously the only semantic-dupe action this shell offered — parity with the `/old` Health tab.
- **Shared Brain** (`views/shared.js`) — the connected state and the enabled/disabled flag states are real, and the five-step setup wizard now exists too, in its own module (`views/shared-brain-wizard.js`): a port of the shipping app's `#sharedbrain-wizard` (both the admin "start a new brain" and contributor "join with an invite token" paths, including the GitHub PAT and Shared Brain admin-token steps — the highest-risk credential surface in this shell), restyled to the `/next` design system under the rule "port the FLOW verbatim, restyle the CHROME only." This release adds the admin-only GDPR Article 17 **revoke-a-contributor** flow and **admin-token generate/rotate** to the connected card — both ported from the shipping app (CLAUDE.md's v3.0.5 entry) and previously entirely absent from this shell. Its own header cross-references the specific `/old`-frontend bugs each behavioural rule exists to keep from regressing. It has no test coverage of its own yet — the offline suite that exercises this behaviour (`test-sharedbrain-hardening.js`) still asserts only against the `/old` frontend's `app.js`. One real gap remains, and it's about an *existing* connection rather than initial setup: `views/shared.js`'s own copy says changing which domains an already-connected brain contributes from needs the access token re-entered, which this shell doesn't handle outside the setup wizard yet.
- **First-run guidance** (`views/onboarding.js`, v3.8.0) — real, and deliberately **not** a port of the `/old` frontend's blocking 4-step modal. It is a non-blocking, dismissible panel: no scrim, no `role="dialog"`, no focus trap, and it never steals focus on the automatic path. `app.js`'s `boot()` calls `maybeShowOnboarding()` (not awaited, and wrapped in `try/catch`, because `boot()` returning is what sets the `window.__curatorBooted` sentinel the `<head>` guard treats as proof of a healthy load). Every step **points** at the surface that already owns the job — API key → first domain → first ingest, in that order — and embeds no input and `POST`s nothing; step 2 navigates to Domains rather than adding a second `POST /api/domains` call site, which `test-next-chat-compile.js` pins at exactly one for the whole tree. Dismissal is `localStorage` (`curator-next-onboarding-dismissed-v1`) and **fails safe by showing** — a storage throw re-shows the guidance rather than silently hiding first-run setup — which is the opposite direction from the AI-disclosure consent gate, on purpose. It is re-findable from Settings ("Show setup guide"). It is **not** a registered view: like `views/mcp-wizard.js` and `views/shared-brain-wizard.js`, it calls no `registerView()` and owns no rail slot.
- **Agent memory** (`views/memory.js`) — a genuine stub. There is no backend for it at all. It renders a "this feature doesn't exist yet" card describing the intended design (read-only Done/Decided/Blocked rollups composed from MCP write scopes) so the rail's shape — your brain → your team's brain → your agents' brain — is honest about what's coming without implying any of it is built.

### The cutover happened in v3.9.0 — what is still outstanding

The swap is done: the redesigned shell answers `/`. The one thing that did **not** happen is the deletion — `src/public/app.js`, `src/public/markdown.js`, `index.html` and `styles.css` are all still present and still served at `/old`, byte-untouched, for two or three releases.

So the drift tripwire above is **still live and still required**, because there are still two copies to drift. Delete `scripts/test-next-ingest-logic-drift.js` and its `OFFLINE` entry in `scripts/run-tests.js` at the point `app.js` is actually removed — not now, and do not repoint it at some other pair of files or repurpose it as a coverage test for the survivor.

`scripts/test-cutover.js` guards the routing itself. Read its header before trusting it: **it issues no HTTP request** — it validates the cutover by reading the source text of `src/server.js`, so its guarantee is "these strings are present", not "the server serves the right shell". It caught all three reverts thrown at it, so it is not decoration, but it is not an end-to-end check either.

Known leftovers of the pre-cutover era, recorded rather than implied away:

- The pre-cutover vocabulary ("preview", "preview shell", escape hatches pointing at `/`) was swept out of user-facing strings in v3.9.0 and a class invariant now fails on it. The boot-recovery panel in `src/public/next/index.html` reads *"The Curator could not finish loading"* and points at `/old`, which is correct — a user whose shell failed to boot must not be sent to `/`, because post-cutover that is the shell that just failed.
- The old frontend's blocking 4-step onboarding wizard — the one modal with no `role="dialog"`, no Escape, no backdrop close and no Skip on step 1 — survives at `/old` for the escape-hatch window. It is a live defect until `app.js` is deleted, not a theoretical one.

---

## Directory structure

```
the-curator/
├── src/
│   ├── server.js               Express entry point (port 3333, auto-opens browser)
│   ├── routes/
│   │   ├── domains.js          GET/POST/PUT/DELETE /api/domains[/:domain]
│   │   ├── ingest.js           POST /api/ingest (single file)
│   │   ├── ingest-queue.js     /api/ingest-queue — batch ingest job (create/list/start/pause/cancel/delete) (v3.3.0+)
│   │   ├── chat.js             GET/POST/DELETE /api/chat/:domain[/:id]
│   │   ├── wiki.js             GET /api/wiki/:domain, GET .../page (v3.2.0+), GET .../source + POST .../source/reveal (v3.5.0)
│   │   ├── health.js           GET/POST /api/health[/:domain][/fix|/fix-all|/dismiss|/undismiss|/dismissed]
│   │   ├── compile.js          POST /api/compile/conversation (v2.5.0)
│   │   ├── diagnostics.js      GET /api/diagnostics/quick, POST /api/diagnostics/live (System Check)
│   │   └── config.js           GET/POST /api/config (settings, API keys, updates)
│   ├── brain/
│   │   ├── paths.js            Where user data lives — repo vs (future) bundle install (v3.1.0)
│   │   ├── llm.js              LLM abstraction (Gemini + Claude)
│   │   ├── files.js            Filesystem helpers (wiki + conversations)
│   │   ├── ingest.js           Ingest pipeline (single-pass + multi-phase)
│   │   ├── ingest-queue.js     Batch-ingest queue: disk-persisted, sequential worker, pause/cancel/resume (v3.3.0+)
│   │   ├── raw-store.js        Raw-source resolution/extraction — the `resolveRawSource` chokepoint (v3.5.0)
│   │   ├── wiki-read.js        Single-page read + backlinks (`getWikiPage`) for the reader panel (v3.2.0+)
│   │   ├── chat.js             Chat pipeline (multi-turn, persistent)
│   │   ├── compile.js          Conversation → wiki pages (v2.5.0)
│   │   ├── health.js           Wiki health scanner + auto-fix logic
│   │   ├── health-ai.js        AI suggestions for broken links (v2.4.3+), orphans (v2.4.4+), semantic duplicates (v2.4.5+) — READ-ONLY
│   │   ├── health-dismissed.js Persistent skip-store for Health issues (v2.5.1+) — wiki/.health-dismissed.jsonl
│   │   └── config.js           Persistent config (API keys, domains path) — resolves through paths.js
│   └── public/
│       ├── index.html          PREVIOUS UI shell — served at /old since the v3.9.0 cutover
│       ├── app.js              Previous vanilla JS frontend (Settings tab + blocking onboarding wizard).
│       │                       Kept for 2-3 releases as the /old escape hatch, then deleted.
│       ├── styles.css          Dark-theme styles for the /old shell
│       └── next/                THE PRIMARY frontend since v3.9.0 — serves / and the SPA catch-all
│           │                    (and still /next as an alias). See "The redesigned shell" section above.
│           ├── index.html      Shell HTML (served for /, /next, /next/ and every SPA path)
│           ├── app.js          Shell: view registry, navigate()/mount-token contract, cross-view write gate
│           ├── shell.css       Shared layout (rail, sidebar, main grid, reader overlay, tokens wiring)
│           ├── tokens/         Design-system CSS custom properties (color, space, type, motion, shape, fonts)
│           ├── shared/         Modules used by more than one view:
│           │                    ingest-queue-logic.js — 13 batch-ingest helpers, byte-identical copy of app.js's
│           │                    own (guarded by scripts/test-next-ingest-logic-drift.js — see above)
│           │                    markdown.js — the ONE Markdown renderer of this shell, used by chat.js + domains.js
│           │                    (v3.8.0; guarded by scripts/test-next-markdown.js — see above)
│           └── views/          One file + one same-named CSS file per rail item (chat, domains, ingest,
│                                settings, shared, sync — real; memory — stub, no backend yet). views/README.md
│                                documents the contract for adding a new one.
├── mcp/                        My Curator MCP — read+write surface to the wiki for Claude Desktop / any MCP client
│   ├── server.js               stdio entry point (spawned as child process by the MCP client)
│   ├── graph.js                Wiki parser: frontmatter, [[wikilinks]], backlinks, tag inventory (cached)
│   ├── util.js                 Slug + domain validators, resolveDomainArg shared helper
│   ├── storage/local.js        Filesystem adapter (resolveInsideBase chokepoint, audit-log writer)
│   └── tools/                  Tool modules (11 read + 7 write = 18 tools as of v3.5.0)
│       ├── index.js            Registration hub + response-size guard (400 KB)
│       ├── domains.js, index-tool.js, search.js, nodes.js, connected.js,
│       │   summary.js, cross.js, overview.js, tags.js, backlinks.js, raw-source.js
│       │                       Read tools (11): list_domains, get_index, search_wiki, get_node, get_connected_nodes,
│       │                       get_summary, search_cross_domain, get_graph_overview, get_tags, get_backlinks,
│       │                       get_raw_source (v3.5.0 — the original document behind a summary, text-extracted only)
│       ├── compile.js          Write tool (v2.5.2): compile_to_wiki — research → wiki pages
│       ├── health.js           Write tools (v2.5.2): scan_wiki_health, fix_wiki_issue, scan_semantic_duplicates
│       └── dismissed.js        Write tools (v2.5.2): get_health_dismissed, dismiss_wiki_issue, undismiss_wiki_issue
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
├── package.json
├── .env                        API key — developer fallback (never committed)
├── .curator-config.json        API keys + settings from UI (never committed)
└── .gitignore
```

`.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`, `.knowledge-git/`, and `domains/` are drawn here at the project root because that is where they resolve **today** — every install is a repo install. They are user data, not code; see the next section for the module that now owns that resolution and the one condition under which it would move them elsewhere.

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
3. `.curator-config.json`'s `domainsPath`, if set (the UI's "change knowledge base location" writes here).
4. `DOMAINS_PATH` env var (developer fallback in `.env`).
5. The default: `getDefaultDomainsDir()` in `paths.js` — `<user-data dir>/domains`, which in a repo install is `<APP_ROOT>/domains`, identical to every version before v3.1.0.

Rungs 1–2 are test-only and always `null` in production, so production's real behaviour is unchanged: config beats the env var, exactly as before this release. `paths.js` only changed what rung 5 resolves *relative to* — from a hardcoded `path.join(PROJECT_ROOT, 'domains')` computed inline to `getUserDataDir()`'s output, which is `APP_ROOT` until a bundle exists.

The same file (`config.js`) resolves `.curator-config.json` itself via `getCuratorConfigFile()` — called **per read/write, not cached at module load**, so both test seams stay effective for any module that imports `config.js` before a test sets them.

### App ↔ MCP: one resolver, not two

Before v3.1.0, `mcp/storage/local.js` re-derived the config file's location independently — its own `path.resolve(<its own directory>, '../..')` plus a literal `.curator-config.json`. That happened to agree with `config.js`'s computation because both were doing the same "walk up from my own file" arithmetic, but they were two *separate* pieces of logic that merely produced the same answer by construction. Nothing forced them to keep agreeing.

As of v3.1.0, `mcp/storage/local.js` imports `getCuratorConfigFile()` and `getDefaultDomainsDir()` directly from `src/brain/paths.js` — the exact functions `config.js` calls. There is now one place that decides "where is `.curator-config.json`," used by both the web app and the MCP child process Claude Desktop spawns. This matters because a silent divergence here is a *silent* failure mode with no error to surface: if the MCP resolved a different absolute path than the UI, Claude Desktop would read and write a wiki the user never sees in the browser — no crash, no warning, just two different "second brains" that happen to share a name. Routing both through one module removes that possibility by construction rather than by convention.

**Update:** for one release after v3.1.0 landed, one divergence remained — `config.js`'s `getDomainsDir()` ranked `.curator-config.json`'s `domainsPath` **above** the `DOMAINS_PATH` env var, while `mcp/storage/local.js`'s own `resolveDomainsPath()` ranked `DOMAINS_PATH` **above** config. It was flagged (not fixed) at the time: both files' header comments cross-referenced it explicitly so it couldn't be "fixed" by accident while touching either one, and CLAUDE.md's v3.1.0 entry called the split out as pre-existing and increasingly urgent. Investigating the git history turned up no functional reason for the MCP's ordering — `config.js`'s config-first precedence has been the app's rule since `getDomainsDir()` was first written (April 2026); `mcp/storage/local.js` was written later, independently, and simply never got reconciled with it. The two resolvers now agree end-to-end: **`--domains-path` CLI arg → `.curator-config.json`'s `domainsPath` → `DOMAINS_PATH` env var → default**, in both the app and the MCP. Config outranks the env var in both places because `.curator-config.json`'s `domainsPath` is what the Settings UI's "change knowledge base location" panel actually writes — a user's explicit, current choice — while `DOMAINS_PATH` is a `.env` fallback documented for developers and non-macOS users who haven't touched Settings. A user who somehow has both set now gets the same folder from Claude Desktop as they see in their own browser. The CLI arg still sits above both — it's supplied explicitly by the generated Claude Desktop config, so it represents even more specific intent than either. Blast radius of the old bug was narrow in practice (the generated config always passes `--domains-path` explicitly, so only a hand-edited config with that flag removed, plus both `DOMAINS_PATH` and a *different* `domainsPath` set, could have hit it) but the fix removes a real, if rare, "the MCP reads a different wiki than the app shows" failure mode. See the header comment at the top of `mcp/storage/local.js` for the full reasoning.

### Named user-data locations and the credential-file list

`paths.js` exports one accessor per user-data file — `getCuratorConfigFile()`, `getSyncConfigFile()`, `getSyncGitDir()`, `getSharedBrainConfigFile()`, `getDefaultDomainsDir()` — each a thin `userDataPath(...)` join, each previously a `path.join(PROJECT_ROOT, <name>)` computed independently inside `config.js`, `sync.js`, and `sharedbrain-config.js`. In a repo install every one of these resolves to the exact same absolute string as before.

`getCredentialFiles()` returns the five files that must be owner-only (0600) as `{rel, abs}` pairs — `.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`, `.env` (anchored to `APP_ROOT`, since it's a developer file that lives with the source, not user data), and `.knowledge-git/config` (git embeds the sync PAT in the remote URL there). This single list now backs **both** the startup `chmod` sweep in `src/server.js` and the System Check credential-permission probe in `src/brain/diagnostics.js` — previously two independently-maintained lists that had to be kept in sync by hand.

### The migration seam (not yet wired to anything)

`getUserDataDirState()` returns one of `'ready' | 'empty' | 'missing' | 'blocked'` rather than a boolean, because "does the folder exist" isn't the question a future bundle install needs answered. A fresh bundle install finds an *empty* `~/Library/Application Support/The Curator` while the user's real wiki still sits in their old checkout — a bundle has no way to infer where that checkout is. `'empty'` (the directory exists but holds neither a config file nor a `domains/` folder) is the intended trigger for a future one-time "import your existing wiki" prompt, to be shown *before* onboarding rather than letting the user believe their second brain is gone. `'blocked'` distinguishes a genuinely broken path (a regular file where a directory should be, a broken symlink, an unreadable directory, a failed `mkdir`) from `'missing'`, because every subsequent write would fail and the caller needs to know that rather than proceed as if empty. **Nothing in v3.1.0 calls this yet** — it ships now, unwired, so the seam is settled before the packaging work that will need it.

### Test seams

Two independent overrides, both checked before any real detection logic runs, both `null`/unset in production:

| Seam | Scope | Crosses process boundaries? |
|---|---|---|
| `__setDomainsDirOverride(dir)` (`config.js`) | `domains/` only | No — in-process only |
| `CURATOR_TEST_DOMAINS_DIR` (env) | `domains/` only | Yes |
| `__setUserDataDirOverride(dir)` (`paths.js`) | All of it: config, sync, Shared Brain, `.knowledge-git/`, and `domains/` (unless something higher in `getDomainsDir()`'s own chain overrides it — see the CONTRIBUTING.md guidance) | No — in-process only |
| `CURATOR_TEST_USER_DATA_DIR` (env) | Same as above | Yes |

See [CONTRIBUTING.md § Test seams](../CONTRIBUTING.md#test-seams-domains-vs-user-data) for which one to reach for and why the distinction is a real safety boundary, not a style choice.

---

## LLM provider selection (`src/brain/llm.js`)

The app selects a provider based on which keys are available and which one the user last activated. Keys are resolved by `config.js` with this priority: `.curator-config.json` (set via Settings UI) takes precedence over `.env` (developer fallback).

With **both** keys stored, the winner is **not** Gemini-by-default — it is `activeProvider` in `.curator-config.json`, which is **last-saved-wins** (v2.4.2+): saving a key in Settings activates that provider, and the Settings provider toggle flips it without re-pasting a key. `getProviderInfo()` reads it via `getActiveProvider()`.

```
Only one key set            →  that provider
Both keys set               →  config.activeProvider  (last saved / toggled)
Both set, legacy config      →  Gemini  (no activeProvider field → Gemini-first fallback)
activeProvider set but its
  key missing               →  falls through to whichever provider still has a key
Neither set                 →  Error on first LLM call

default models (DEFAULTS in llm.js):  gemini-2.5-flash-lite  /  claude-haiku-4-5
```

The table above describes the **effective** key (config *or* `.env`). The **onboarding
wizard's trigger does not**: `checkFirstRun()` reads `hasGeminiKey`/`hasAnthropicKey`,
which come from `getApiKeys()` — `.curator-config.json` only. A `.env`-only install
therefore makes working LLM calls *and* shows the first-run wizard on every load.

Chat additionally supports a **per-chat provider override** (v3.0.11+) — `getProviderInfo(preferProvider)` honours it only when that provider has a key saved in Settings, and the model id is always `DEFAULTS[provider]`, never client-supplied.

The optional `LLM_MODEL` env var overrides the default model for whichever provider is active.

`generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text', onWait = null, opts = {})` is the single function every LLM caller in the app goes through — `ingest.js`, `query.js`, `chat.js`, `compile.js`, `health-ai.js`, the Shared Brain modules. It handles the provider-specific API differences internally, plus retry/backoff (429/503) and the model-not-found fallback chain (see [model-lifecycle.md](model-lifecycle.md)). `onWait(message)` is an optional callback fired before each retry wait, used to stream a "Service busy — retrying in 9s…" message to the UI. `opts` carries four additive, optional fields:

- `onUsage(payload)` (v3.0.16) — fired once per completed provider call with normalised `{provider, model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens}`, so a caller can track real spend without changing the function's bare-string return type.
- `cachePrefixChars` (v3.0.16) — Anthropic-only, the length of a stable leading portion of `userPrompt` to mark with a `cache_control` breakpoint (ignored by the Gemini branch, which caches implicitly; see [ingestion-pipeline.md §7.2](ingestion-pipeline.md#72--anthropic-claude)).
- `provider` (v3.0.11) — a per-call provider override for the chat model selector, honoured only when that provider has a key **saved in Settings**; the model id is always `DEFAULTS[provider]`, never client-supplied.
- `signal` (v3.4.0) — **an `AbortSignal`, and the entire mechanism behind "Cancel" on a batch ingest.** It is threaded queue → `ingestFile` → `generateText` → both provider SDKs; abort is checked *before* the retry ladder, the 429/503 backoff (`sleep()` is itself abortable) and the model-not-found fallback chain, so a cancel stops spending immediately rather than walking up to five more calls. Measured: 334 s → 63 ms. Omitting it leaves every code path byte-identical to the pre-v3.4.0 behaviour.

For ingest calls, `responseFormat: 'json'` is passed, which enables Gemini's native `responseMimeType: 'application/json'` — this forces the model to produce structurally valid JSON even when the content contains markdown characters (backticks, quotes, backslashes) that would otherwise break parsing.

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

**Pause vs. Cancel — deliberately not the same "stop" (v3.4.0+).** Pause is lossless: it only ever stops between files. Cancel means "stop spending right now": an `AbortController` is threaded from the queue worker through `ingestFile` down to the `generateText` call and both provider SDKs, so a click aborts the file that's *currently* in flight rather than waiting for it to finish. Measured on a real multi-phase 150 KB source: cancel acknowledged in single-digit milliseconds and the job reached a terminal state in ~63–74 ms, versus the ~334 s and up to 17 further paid provider calls the same run would otherwise have made. The interrupted item gets its own terminal status, `cancelled` ("Stopped"), distinct from `failed`; nothing already written is rolled back, and re-ingesting that one file (with Overwrite ticked, since it's already recorded in `raw/`) completes it. The abort check is placed FIRST in every one of `ingest.js`'s LLM-reachable recovery catches (Phase 1 outline retry, Phase 2 batch → page-by-page → stub, single-pass → multi-phase) — a cancel caught by one of those ladders instead of honoured would silently keep spending, the exact inverse of what Cancel is for.

## Data flow: Chat

```
User sends message
      │
      ▼
POST /api/chat/:domain  { message, conversationId? }
      │
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
      ├─ 7. Call LLM via llm.js  (text mode, 8 192 max output tokens; on
      │     truncation, returns the partial answer + a note — never hard-fails)
      │     Returns: markdown answer with [source: path] citation tags
      ├─ 8. stripCatalogueEcho() — remove any residual bare-file-path blob
      ├─ 9. Parse [source: ...] tags → deduplicated citation list
      ├─ 10. Append user + assistant messages to conversation
      └─ 11. Save conversation JSON to domains/<domain>/conversations/<id>.json

HTTP response → { conversationId, isNew, title, answer, citations: [...] }

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
    { "role": "assistant", "content": "RAG stands for…", "citations": ["concepts/rag.md"] }
  ]
}
```

Conversations are gitignored — they are personal to each user's machine.

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

**`get_raw_source` (MCP, v3.5.0)** returns extracted plain text, byte-capped well under the MCP response budget — never raw bytes. PDFs are text-extracted first; anything that doesn't decode as text comes back as `text: null` with `text_unavailable: "binary"` rather than mangled bytes or a corrupted JSON-RPC stream (the same class of failure the v2.5.3 stdout-pollution fix closed). See [§ Module reference](#module-reference) below and the MCP section that follows for where this sits among the other 17 tools.

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
      ├─ createStorageAdapter({ domainsPath })   storage/local.js
      ├─ registerTools(server, storage)          tools/index.js
      └─ StdioServerTransport.connect()

Tool call (any of 18 tools):
      │
      ▼
tools/index.js — CallToolRequestSchema handler
      ├─ Look up tool by name → invoke handler(args, storage)
      ├─ Stringify result → enforceSizeLimit (400 KB cap; trims heavy arrays)
      └─ Return { content: [{ type: 'text', text }] }

Read tools (v2.3.0+ through v3.5.0, 11 tools)
      ├─ Walk markdown via storage.listWikiFiles / readFile
      │    Cached per-process graph (mcp/graph.js, 10-min TTL)
      └─ get_raw_source (v3.5.0) is the one exception: it does NOT go
           through storage.readFile (which forces utf8 and would mangle a
           PDF) — it calls raw-store.js's resolveRawSource + text extractor
           directly, and returns extracted text only, never binary bytes.

Write tools (v2.5.2+, 7 tools)
      ├─ resolveDomainArg(args, storage, getDefaultDomain)
      │     Explicit domain → user's defaultDomain → error
      │     Validated via isValidDomain + storage.listDomains()
      ├─ Per-tool guards (caps, slug regex, REFUSED_FILES, preview gate)
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

### `src/brain/config.js`

Persistent app configuration stored in `.curator-config.json` in the user-data directory (`src/brain/paths.js`; the project root for a repo install — the only install type that exists today).

| Export | Description |
|--------|-------------|
| `getDomainsDir()` | Resolved absolute path to the domains folder. Precedence: in-process test override → `CURATOR_TEST_DOMAINS_DIR` (env, test-only) → `.curator-config.json`'s `domainsPath` → `DOMAINS_PATH` env var → default (`paths.js`'s `getDefaultDomainsDir()`). The two test rungs are always inert in production, so production behaviour is unchanged from before v3.1.0: config beats the env var. |
| `setDomainsDir(newPath)` | Persists a new domains path to `.curator-config.json` |
| `getConfig()` | Returns `{ domainsPath, domainsPathSource }` for the UI |
| `getApiKeys()` | Returns `{ geminiApiKey, anthropicApiKey }` from the config file |
| `setApiKeys({ geminiApiKey, anthropicApiKey })` | Saves API keys to the config file (partial update) |
| `getEffectiveKey(provider)` | Returns the active key for a provider: config file takes priority over `.env` |

### `src/brain/llm.js`

| Export | Description |
|--------|-------------|
| `getProviderInfo()` | Returns `{ provider, model }` based on effective keys (via `config.js`) |
| `generateText(system, user, maxTokens, responseFormat, onWait, opts)` | Single LLM call; handles Gemini and Claude API differences, retry/fallback, and (v3.0.16) `opts.onUsage`/`opts.cachePrefixChars` |

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
| `acquireFileLock(domainDir, opts)` | Cross-process advisory lock at `<domain>/.write-lock` (JSON: pid, op, startedAt). Returns a `release()` function on success, `null` if another process holds a fresh lock. 30-minute stale-lock TTL + `process.kill(pid, 0)` liveness probe; stale or unparseable locks are silently cleared on the next acquire. |
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
sendMessage(domain, conversationId, userMessage)
  → Promise<{ conversationId, isNew, title, answer, citations[] }>

listConversations(domain)   → Promise<ConversationMeta[]>
readConversation(domain, id) → Promise<Conversation | null>
deleteConversation(domain, id) → Promise<void>
```

### `src/routes/config.js`

Settings and configuration endpoints.

```
GET  /api/config               → current app configuration
POST /api/config/domains-path  → set domains folder path
POST /api/config/pick-folder   → macOS native folder picker (osascript)
GET  /api/config/api-keys      → masked keys + active provider info
POST /api/config/api-keys      → save API keys (partial update)
POST /api/config/api-keys/disconnect → clear one provider's saved key (v2.4.2+)
POST /api/config/api-keys/active     → switch the active provider without re-saving a key (v3.0.1-beta.24+)
GET  /api/config/update-check  → compare local vs GitHub version
POST /api/config/update        → git fetch + git reset --hard origin/main + npm install + rebuild .app (build-app.sh) (v2.3.2+)
POST /api/restart               → spawn new server process, exit current one
```

---

## Frontend binding hardening (`src/public/app.js`, v3.1.0)

`app.js` is one roughly 8,200-line ES module with roughly 90 top-level `const x = document.getElementById(...)` / `document.querySelector(...)` declarations (the exact count a new suite now pins is reported by `scripts/test-frontend-null-safety.js` on every run). `getElementById`/`querySelector` never throw — a missing element just returns `null` — but *dereferencing* that `null` does. If the dereference happens at module scope (not inside a function body), the resulting `TypeError` aborts evaluation of the rest of the module: every listener below that point never binds, every tab past that point is dead, and the auto-updater ships that blank/broken page to every user on their next check-for-updates.

An audit ahead of this release found this shape live in several places — most notably two bare `document.querySelector('[data-tab="…"]').addEventListener(...)` calls (an absent tab button, e.g. from a future markup typo, would have blanked the whole app) plus a dozen `getElementById(...)` siblings of the same shape, plus a handful of module-scope consts (`dropZone`, `fileInput`, `chatInputEl`, and others) dereferenced unguarded at module scope. The fix is exactly 33 `?.` guards added at each dereference point — the same idiom the file already used consistently elsewhere — plus the three most heavily-reused helpers (`showEl`, `hideEl`, `showStatus`) now log via `console.error` and return instead of throwing when passed a missing element.

**Scope, stated precisely so this isn't over-read:** this closes the *load-time* failure mode — a missing element can no longer blank the entire app during module evaluation. It does **not** make every runtime dereference in the file null-safe. Two known examples remain deliberately unfixed: `chatSendBtn.click()` inside `chatInputEl`'s own (now-guarded) `keydown` listener, and `chatInputEl.focus()` inside `newChatBtn`'s own (now-guarded) `click` listener — both bare references to a *different* element than the one whose listener just fired. If that inner element were ever missing while the outer one was present, that specific handler would still throw when triggered. Closing every cross-element reference inside every handler body is restructuring work (a tab-navigation registry, splitting the file into modules) explicitly out of scope for this release; `scripts/test-frontend-null-safety.js`'s header documents both known instances by name so the gap isn't silently forgotten.

`scripts/test-frontend-null-safety.js` is a dependency-free scanner (no parser dependency, in the spirit of `scripts/test-css-tokens.js`) that verifies every top-level-equivalent dereference is `?.`-guarded or provably narrowed by an earlier guard. It deliberately carries a second, independent, "dumb" recount of the same declarations, cross-checked for exact agreement with the main scanner — see [CONTRIBUTING.md § Writing a good test](../CONTRIBUTING.md#writing-a-good-test) for why that redundancy is load-bearing rather than decorative.

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
The UI is a left rail (Chat · Domains · Shared Brain · Agent memory · Ingest, with Sync and Settings in the footer); Wiki is an Esc-dismissible reader overlay and Health is a panel inside a domain. The `/old` frontend still has the original seven tabs (Chat · Ingest · Wiki · Health · Domains · Sync · Settings) and a handful of fetch calls. A framework adds build complexity and bundle size with no meaningful benefit for a local personal tool.

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
