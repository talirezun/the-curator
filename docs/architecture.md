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
- **Agent memory** (`views/memory.js`) — **a stub view over a real backend, since v3.17.0.** The distinction matters and the card itself now draws it: the working-state store (`src/brain/working-state.js`) ships and is live, reached by coding agents through the MCP's `get_working_state` / `save_working_state` tools; what does not exist is any *view* of it in this shell, and there is no HTTP route either. So this screen renders a card saying there is nothing to browse here and pointing at the coding agent instead — which is narrower and more accurate than the pre-v3.17.0 card, which said the feature did not exist and described a rollup UI (Done/Decided/Blocked composed from MCP write scopes) that was never built and is still not built. The rail's shape — your brain → your team's brain → your agents' brain — is now backed by something on all three. See [working-state.md](working-state.md) and the store's own section below.

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
│   │   ├── working-state.js    Portable working state — domains/<project>/state/ (v3.17.0). Store only;
│   │   │                       the MCP tool layer wraps it. Never renders a prompt, never calls an LLM.
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
│                                settings, shared, sync — real; memory — a stub VIEW over a real backend:
│                                the working-state store ships and is reached over MCP, but nothing renders
│                                it here). views/README.md documents the contract for adding a new one.
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

**Last-saved-wins now has one exception: a provider that cannot build.** Saving a non-empty key still activates that provider — *unless* it has no build-lane model, in which case the key is saved and the activation is skipped, with the reason returned so the UI can explain why the active provider did not move. This closes a reproduced P0: a user with a working Gemini install who merely *saved* an OpenRouter key lost ingest, Health and Compile, because activation flipped to a provider with no resolvable model and the route that would have reported it swallows the throw in a `catch` commented "no key configured yet" — when a key *is* configured. The rule is deliberately the **class**, not the instance: **the app never activates a provider that cannot serve the build lane.**

**That class-scoping is now load-bearing rather than hypothetical, and the outcome is worth stating precisely.** OpenRouter gained measured build-lane models in this release, so the predicate it is asked now answers *yes* and **the exception no longer fires for OpenRouter** — saving an OpenRouter key activates it, ordinary last-saved-wins, exactly as for the other two. Not one line of the guard needed editing to produce that, which is the payoff for writing it as a class. What remains is a live guard for the next provider wired up before its models are measured, and the `skippedActivation` array it returns is correspondingly **empty for every provider that ships today** — a consumer must treat it as a signal that may legitimately never arrive, not as a channel it can assume is exercised. **The predicate lives in the route layer and is INJECTED into storage, not computed there.** The question — *does a model resolve for this provider, and may it build?* — is `llm.js`'s to answer, and `llm.js` imports `config.js`, so computing it in `config.js` would need a cycle that a standing offline invariant forbids. `src/routes/config.js` already namespace-imports `llm.js`, so the predicate is defined there and passed to the two storage **mutators** as a callback. Two consequences of that shape are deliberate:

- **With no predicate supplied, nothing is activated.** The failure directions are wildly unequal: a skipped activation that should have happened is mildly annoying, *visible*, and undone by one click on the existing set-active control; an activation that should not have happened breaks the entire build lane with nothing on screen saying so. Defaulting to *activate* would make the P0 the default behaviour. A predicate that **throws** is treated as a refusal for the same reason.
- **Its own degradation is asymmetric on purpose.** The hard requirement is only that a non-empty model id resolves — precisely the mechanism that broke — which a long-standing export decides. The newer lane predicate is consulted when present; when absent, the answer falls back to *a model resolved, therefore it can build*, which is exactly the truth for Gemini and Anthropic. Making a missing export mean *cannot build* would silently kill last-saved-wins for both, a far worse regression than the bug being fixed.

The table above describes the **effective** key (config *or* `.env`). The **onboarding
wizard's trigger does not**: `checkFirstRun()` reads `hasGeminiKey`/`hasAnthropicKey`,
which come from `getApiKeys()` — `.curator-config.json` only. A `.env`-only install
therefore makes working LLM calls *and* shows the first-run wizard on every load.

Chat additionally supports a **per-chat provider override** (v3.0.11+) — `getProviderInfo(preferProvider)` honours it only when that provider has a key saved in Settings. Since v3.13.0 a per-chat **model** override rides alongside it (`getProviderInfo(preferProvider, preferModel)`), allow-listed the same way; see [Model selection](#model-selection-the-router-v3120--v3130) below.

The optional `LLM_MODEL` env var overrides the default model for whichever provider is active. It sits between the per-call override and the user's stored Settings choice in the precedence chain — see below.

`generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text', onWait = null, opts = {})` is the single function every LLM caller in the app goes through — `ingest.js`, `query.js`, `chat.js`, `compile.js`, `health-ai.js`, the Shared Brain modules. It handles the provider-specific API differences internally, plus retry/backoff (429/503) and the model-not-found fallback chain (see [model-lifecycle.md](model-lifecycle.md)). `onWait(message)` is an optional callback fired before each retry wait, used to stream a "Service busy — retrying in 9s…" message to the UI. `opts` carries five additive, optional fields:

- `onUsage(payload)` (v3.0.16) — fired once per completed provider call with normalised `{provider, model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens}`, so a caller can track real spend without changing the function's bare-string return type.
- `cachePrefixChars` (v3.0.16) — Anthropic-only, the length of a stable leading portion of `userPrompt` to mark with a `cache_control` breakpoint (ignored by the Gemini branch, which caches implicitly; see [ingestion-pipeline.md §7.2](ingestion-pipeline.md#72--anthropic-claude)).
- `provider` (v3.0.11) — a per-call provider override for the chat model selector, honoured only when that provider has a key **saved in Settings**.
- `model` (v3.13.0) — a per-call model override (the chat composer's model dropdown). Narrowed to a non-empty string here and then allow-listed inside `getProviderInfo()`; anything not in `OFFERABLE_MODELS` for the resolved provider falls back to that provider's default rather than throwing. See [Model selection](#model-selection-the-router-v3120--v3130).
- `signal` (v3.4.0) — **an `AbortSignal`, and the entire mechanism behind "Cancel" on a batch ingest.** It is threaded queue → `ingestFile` → `generateText` → every provider client (both SDKs and the OpenRouter adapter, which additionally links it to its own request timeout); abort is checked *before* the retry ladder, the 429/503 backoff (`sleep()` is itself abortable) and the model-not-found fallback chain, so a cancel stops spending immediately rather than walking up to five more calls. Measured: 334 s → 63 ms. Omitting it leaves every code path byte-identical to the pre-v3.4.0 behaviour.

For ingest calls, `responseFormat: 'json'` is passed, which enables Gemini's native `responseMimeType: 'application/json'` — this forces the model to produce structurally valid JSON even when the content contains markdown characters (backticks, quotes, backslashes) that would otherwise break parsing.

### Provider dispatch has a terminating `else`, and adding the third branch is what forced it

`callProvider` used to be a Gemini `if` followed by an **unconditional** Anthropic client construction reading a hardcoded Anthropic key. That was safe only because the provider resolution could not return a third value. The moment it could, an OpenRouter request would have been sent to Anthropic's API on the user's Anthropic key, returned a model-not-found, been classified as retryable by `isModelNotFound`, and **walked the Anthropic fallback chain — spending real Anthropic money while the user believed they were on a different provider.**

Dispatch is now `if / else if / else { throw }`, and the third branch and the terminating throw landed in the same change. The same binary-with-no-third-arm shape existed in the output-cap lookup (`provider === 'gemini' ? GEMINI_CAPS : ANTHROPIC_CAPS`, with `provider` unvalidated, so every unknown provider silently resolved to the Anthropic map) and was replaced by a `switch` returning `null` for a provider we do not dispatch to. This is the v3.10.1 finding — a two-armed conditional has no third arm, and the fall-through arm is whichever one happened to be written second.

The OpenRouter branch is an adapter over the provider's OpenAI-compatible endpoint. Two request-level preferences are sent on **every** call and both are load-bearing:

- **Provider fallback is off.** The aggregator's upstream fallback is on by default, so without this the model the user picked could be served by an upstream they did not pick, at a price the app did not quote.
- **Required parameters are enforced.** This is what stops an upstream **silently dropping** the JSON-mode request. A dropped structured-output request does not error — it returns prose, which surfaces as a parse failure several layers away with no indication of the real cause.

The request never carries a model-substitution list, which would be the same class of silent swap one rung up. Error classification is **structural** — on the numeric status, which the provider also mirrors into its error body — never a substring match, because this repo's own `/\b429\b/` once matched its own prose about "429 characters". Note that a `503` under these preferences means *no upstream met the required parameters*, an expected outcome of our own strictness rather than necessarily an outage, and it is named as such so a user is not sent to a status page for a request that will never succeed as written.

**Usage normalisation differs by provider and getting it wrong double-counts silently.** OpenRouter's prompt-token count **includes** cached tokens — the Gemini convention, not Anthropic's — so its normaliser subtracts, exactly as the Gemini one does. This is the same trap documented for Gemini in v3.0.16; it is restated here because the two providers it resembles disagree with each other.

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
            │    └─ getActiveProvider()             // config.activeProvider, last-saved-wins
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

`filterModels`/`orderModels` in `views/settings.js` add a per-provider, session-only (never persisted) search box, a `<select>` sort, and a "measured" checkbox, rendered only once a provider's list passes `MODEL_FILTER_MIN_ROWS` (12) — below that a filter bar is furniture. `MODEL_SORTS` is exactly `['cheapest', 'dearest', 'newest', 'largest-context']`; cheapest/dearest reuse the server's own price-sorted delivery order (reversed for dearest) rather than re-deriving a price comparison client-side, and newest/largest-context rank `createdUnixSec`/`contextLength` where present. There is deliberately no capability or "most capable" sort: `isCuratorMeasured` (reads `jsonRaw === boolean`, the marker for "we ran this against the real ingest prompt") covers roughly 19 of the catalogue's ~190+ entries, and a second qualification session on 2026-08-28 measured price, speed, recency and vendor each predicting the *opposite* of the real outcome on at least one model — a capability ranking over the unmeasured remainder would be a machine-written verdict dressed as data. A row missing a sort's key is never assigned one (0 and a fabricated date are both explicitly refused by `defineOfferableModel`); it keeps its delivered position and trails the ranked block, and the bar states how many.

### The chat wait clock

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
      │     opts.onUsage captures {provider, model, four token counts} for
      │     the provider call that actually answered — see "Per-answer cost"
      │     above. Returns: markdown answer with [source: path] citation tags
      ├─ 8. stripCatalogueEcho() — remove any residual bare-file-path blob
      ├─ 9. Parse [source: ...] tags → deduplicated citation list
      ├─ 10. Append user + assistant messages to conversation (the assistant
      │      message additionally carries `provider`/`model`/`usage` when the
      │      onUsage payload validated — see Conversation persistence below)
      └─ 11. Save conversation JSON to domains/<domain>/conversations/<id>.json

HTTP response → { conversationId, isNew, title, answer, citations: [...],
                   responseStyle, provider, model, usage }
  // `model` and `usage` describe the model that ANSWERED, not the one
  // requested; both are null when nothing valid was reported. See
  // "Per-answer cost" under Model selection, above.

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
                 "cachedReadTokens": 0, "cacheWriteTokens": 0 } }
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
| `generateText(system, user, maxTokens, responseFormat, onWait, opts)` | Single LLM call; handles the per-provider API differences, retry/fallback, and `opts.onUsage`/`opts.cachePrefixChars` (v3.0.16), `opts.provider` (v3.0.11), `opts.model` (v3.13.0), `opts.signal` (v3.4.0) |

### `src/brain/openrouter-adapter.js`

The OpenAI-compatible adapter behind the third provider, plus the pure helpers that make its behaviour testable offline with no credential.

| Export | Description |
|--------|-------------|
| `OpenRouterAdapter` | One non-streaming chat completion. Sends the no-substitution routing preferences on every call, and reports the **resolved** model from the response body — the model that actually answered, not the one requested |
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

### `src/brain/working-state.js` (v3.17.0)

Portable working state — the store behind "carry the build context from this session into the next one, on any machine, in any harness, with any model". Full user-facing treatment in [working-state.md](working-state.md); this section covers where it sits in the system and the three decisions that constrain everything else about it.

It is **the store only**. It exposes plain functions, never renders a prompt and never calls an LLM; the MCP tool layer wraps it, and there is **no HTTP route and no in-app view**. It is written to be imported inside the MCP stdio child, so it must keep stdout pure — `console.error` only, per the v2.5.3 stdout-pollution rule. Its reads go to the filesystem directly and deliberately **not** through `mcp/graph.js`, whose cache invalidates on **file count**: an in-place overwrite of `current.md` never changes the count, so a cached read could serve state up to the cache TTL out of date, and stale state is worse than no state.

**Layout is `domains/<project>/state/`** — `project.md` (the standing brief, returned on every read), `<scope>/<machine>/current.md` (the handoff, overwritten each save), `<scope>/<machine>/journal.jsonl` (append-only, one line per save). `state/` is a **sibling** of `wiki/` and is never written through `writePage`: that function redirects non-canonical paths into `entities/`/`concepts/`/`summaries/` and flattens to the basename, so the `(project, scope)` pair is inexpressible there.

**Three decisions, each measured rather than preferred:**

1. **State supersedes; knowledge accumulates.** `mergeWikiPage`'s union merge is correct for knowledge and wrong for state — a resolved blocker would be resurrected by the next write, because a union has no way to express *no longer true*. Hence a separate store with overwrite semantics. The corollary is a boundary users need stated: a failure whose value is the **pattern across incidents** is knowledge and belongs on a wiki page via `compile_to_wiki`, where it compounds and is graphed; only the recent scope-local tail lives in state.
2. **The `<machine>` segment is load-bearing.** `state/` matches none of `DOMAINS_GITIGNORE_RULES`, so it syncs, and `sync.pull()` resolves with `git pull --no-rebase -X theirs` — which on a **conflicting hunk** keeps origin and discards the local write, silently. Two machines writing the same `current.md` would destroy each other's handoff with no error. Per-machine paths mean no conflicting hunk ever arises. Proven against real git. Cross-machine handoff is recovered on the **read** side instead: a scope with no machine named returns the most recently written machine and lists the rest, which also degrades gracefully when a hostname changes.
3. **Sanitisation runs on write *and* on read.** The feature's premise is that an agent acts on text a previous agent wrote, so "instruction-ness" cannot be neutralised — that is the product. What is neutralised is **impersonation of a higher-authority channel**: a `<` opening a protocol-shaped tag, a `:` closing a line-initial chat role marker, and (write side only) a `#` opening a Markdown heading. The read side is not belt-and-braces — the file read was not necessarily written locally: it arrives over Personal Sync, is hand-editable in Obsidian, and inside a `shared-*` mirror can be written by another person. A write-only guard would be a guard applied to an instance rather than a class. The read side cannot apply the heading rule (it cannot tell our headings from a forged one without parsing), so a **legitimately-shaped forged heading survives a read** — mitigated structurally instead: writes into `shared-*` mirrors are refused, and every read reports the machine and mtime the content came from.

**Containment** reuses `resolveInsideWiki` from `wiki-read.js` with a non-wiki root (the function is root-agnostic despite its name; `raw-store.js` set this precedent) rather than keeping a second hand-maintained copy — the v3.2.0 CRITICAL shape. Segment names are additionally validated as single safe path segments, and containment is re-resolved **after** `mkdir` so a symlinked scope/machine directory arriving over sync is caught before the write. `current.md` goes through `writeFileAtomic`, which also refuses to write through a symlink; `journal.jsonl` is `appendFile`, never an atomic rewrite (atomic-write.js's own invariant 5 — a rewrite loses concurrent appends and a JSONL log is already crash-safe at line granularity).

**No lock is taken, deliberately.** The write target is per-`(scope, machine)`, so the only racers are two savers on the same machine for the same scope; the atomic rename makes that last-writer-wins on a file defined as "supersedes", and both journal lines land. Presenting `acquireFileLock` as mutual exclusion would be false — it double-grants, including across processes.

**A save is never refused for being over budget.** An agent near the end of its context that has its handoff rejected loses the handoff entirely. Instead trailing items are dropped from whichever list is largest, and the drop is recorded **in the document, in the result, and in the journal** — trimmed loudly rather than truncated silently.

| Export | Description |
|--------|-------------|
| `saveWorkingState(project, input)` | Overwrites `current.md` for `(project, scope, machine)` and appends one journal line. `input` carries a required `headline` plus `nowState`, `nextSteps`, `decisions`, `observations`, `traps`, `openQuestions`, and optional `scope` / `machine` / `harness` / `model`. Returns `{ok:true, …}` or `{ok:false, reason, message}` — **never throws**. The journal append is best-effort and never fails the save. |
| `saveProjectBrief(project, input)` | Overwrites `state/project.md` from `brief` / `decisions` / `workingModel` / `pointers`. Separate from the above on purpose: this tier is deliberate and rare, and it is returned on every read, so it must not churn with sessions. |
| `readWorkingState(project, opts)` | Always returns the brief. With `opts.scope`, also that scope's `current.md`, the machines holding state under it, and recent journal entries; without one, the scope index. Never throws; every file read is byte-capped at the source. |
| `listWorkingScopes(project)` | Every `(scope, machine)` pair with state, newest first, each with its last write time, age and latest headline. A hard requirement rather than a convenience — an agent told "carry on with the auth work" cannot otherwise resolve that to a scope slug it has never seen. |
| `machineId(override)` | This machine's path segment, resolved **per call** (a module-scope `const X = getter()` is the v3.1.0 import-order bug this repo has a source guard against). An unusable hostname falls back to a literal rather than throwing — losing the machine distinction is a merge risk, refusing to save loses the handoff. |
| `sanitiseBlock` / `sanitiseLine` / `sanitiseList` / `sanitiseObservations` / `neutraliseProtocol` / `escapeHeadings` | The sanitiser surface described above. None throws on any input. `neutraliseProtocol` is idempotent by construction, which matters because it runs on every read. |
| `resolveInsideState(project, relPath)` | The single path chokepoint into `state/`. Nothing else may build one. |

**Refusal reasons** are returned, not thrown: `invalid-project`, `unknown-project` (the name is not a real domain — a folder with no `CLAUDE.md` is `rm -rf`'d by `sync.pull()`'s ghost-domain prune, so state saved there would be silently deleted), `readonly` (a `shared-*` mirror), `invalid-scope`, `invalid-machine`, `missing-headline`, `empty-brief`, `unsafe-path`, `io`.

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
  // opts: { responseStyle, provider, model }
  → Promise<{ conversationId, isNew, title, answer, citations[],
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
GET  /api/config               → current app configuration
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
