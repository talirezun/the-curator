# Contributing to The Curator

This is the practical reference for working on The Curator's code: how to set up,
run the app, run the tests, add a test, and cut a release. For the deep
architecture and the full release history, see [CLAUDE.md](CLAUDE.md) (the
canonical development guide) and [docs/](docs/) (technical references such as
[architecture.md](docs/architecture.md) and
[ingestion-pipeline.md](docs/ingestion-pipeline.md)).

---

## Setup

```bash
# 1. Clone and install
git clone https://github.com/talirezun/the-curator.git
cd the-curator
npm install

# 2. Add an API key (either works; Settings UI takes priority over .env)
#    Create .env with:  GEMINI_API_KEY=your_key_here
#    or set it later in the app's Settings tab.

# 3. Run
npm start          # serves http://localhost:3333 (binds 127.0.0.1 only)
npm run dev        # same, with --watch auto-restart
npm run mcp        # run the MCP server standalone (stdio)
```

Node.js 18+ is required (the code uses native `fetch`, `node:test`-era APIs, and
ESM). The app is loopback-only by design — see the Security note in
[README.md](README.md).

### The root manifest has zero `devDependencies`, and that is a rule

`package.json` carries eight runtime dependencies and **no `devDependencies`
key at all**. Keep it that way.

The reason is not tidiness. `POST /api/config/update` runs
`npm install --silent --no-audit --no-fund` **on every user's machine** as step 4
of an update, so anything in the root manifest — a `devDependency` included — is
downloaded by every user, for every update, whether or not they can use it. This
project has already refused Playwright on exactly this ground, and the
browser-driven visual harness talks to an already-installed Chrome over the
DevTools Protocol specifically so that `git diff package.json` stays **0 lines**.

Practically:

- **Tooling you need for one investigation** (a Mermaid parser, a link checker, a
  DOM shim) is installed in a scratchpad **outside the repository**. Several
  releases record this and re-verify the 0-line diff afterwards.
- **A packaging toolchain gets its own manifest.** When the desktop shell is
  built it lives in `desktop/` with a separate `package.json`, so Electron never
  reaches a browser-install user — see
  [docs/desktop-app-decisions.md § D2](docs/desktop-app-decisions.md#d2--desktop-gets-its-own-packagejson).

**Nothing automated enforces this.** No suite asserts the root manifest is free
of `devDependencies`; it rests on this rule plus the per-release diff check. A
guard would close it.

### Git hooks (v3.17.2)

This is a public repo, so the hooks guard the two mistakes that cannot be undone
once pushed. They live in **`.githooks/`** and are tracked — before v3.17.2 they
existed only in each machine's untracked `.git/hooks/`, which meant a fresh clone
had no protection at all, at the one moment protection matters most.

```bash
git config core.hooksPath .githooks
```

Two guards run for everyone:

- **No credential-shaped string** may enter a commit. Scans staged *content*, not
  the worktree. Synthetic fixtures are allow-listed by EXACT value in
  `.githooks/secret-allowlist` — a new token *shape* is refused even inside
  `scripts/`. If you add a fixture, assemble the prefix from parts or rename it
  rather than allow-listing it; allow-listing teaches the next person to
  allow-list.
- **No internal working document** may be staged. These are gitignored, but
  `git add -f` and a stray `git add <path>` both bypass gitignore, which is
  exactly what this backstops.

A third guard is **opt-in and off by default**, so that enabling `core.hooksPath`
never stops you committing to your own fork:

```bash
# maintainer only
git config curator.enforceAuthor "talirezun@users.noreply.github.com"
```

Unset, the authorship check is skipped entirely. `commit-msg` separately refuses a
`Co-Authored-By` trailer or a tooling byline — every commit here is attributed to
the single maintainer.

`pre-merge-commit` is a one-line shim that execs `pre-commit`. It used to be a
byte-identical 63-line copy, which is the two-hand-maintained-copies shape that
produced this repo's v3.2.0 CRITICAL.

Escape hatch, rarely the right answer: `git commit --no-verify`.

---

## Running the tests

The Curator has an extensive battle-test suite (182 suites total — 160 OFFLINE
+ 15 LIVE_CI + 7 LIVE_LOCAL — thousands of assertions). One command runs them
all and prints a single pass/fail report. **This count is CHECKED, not hand-maintained.**
`scripts/check-doc-suite-counts.js` (an OFFLINE suite) parses the
`OFFLINE`/`LIVE_CI`/`LIVE_LOCAL` arrays at the top of
[scripts/run-tests.js](scripts/run-tests.js) and fails `npm test` if the
numbers above disagree with them — naming the stale number and the correct
value. Those arrays remain the authoritative source; the difference since
v3.6.1 is that the prose here can no longer drift away from them silently.
**Consequence when you add a suite: you must update the count above in the
same commit, or `npm test` goes red.**

```bash
npm test            # OFFLINE suites only — fast (a few seconds), free, no
                    # network, no API key. Run this before every commit.

npm run test:live   # OFFLINE + LIVE suites. LIVE suites make real
                    # Gemini / Anthropic / GitHub calls and need keys in .env
                    # (or the environment). Each LIVE suite self-skips (exit 0)
                    # when its key is absent, so this is safe to run without
                    # keys — it just skips the paid parts. Costs a few cents
                    # when keys are present.
```

**Safety net:** in the default (offline) mode the runner spawns each child suite
with `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `GITHUB_TEST_*` **stripped from its
environment**, so even a mis-classified suite physically cannot make a paid API
call. `npm test` is always free.

You can still run a single suite directly while iterating:

```bash
node scripts/test-beta8-stress.js
```

**Two new OFFLINE suites landed with v3.0.16** (the ingest prompt-slimming +
sync/lock hygiene release): `test-ingest-prompt-slimming.js` (grew to 488
assertions in v3.0.17 — see below) covering the existing-page-inventory safety
valve, the cache-ordered batch prompt, `opts.onUsage`, and the Phase-2
result-reconciliation fixes in `src/brain/ingest.js` (see
[docs/ingestion-pipeline.md §1b](docs/ingestion-pipeline.md) for the behaviour
they cover) and `test-sync-hygiene.js` (covering `.DS_Store` untracking,
stale-lock self-heal on `pull()`, and the non-ASCII-domain NUL-delimited
`git ls-files` fix in `src/brain/sync.js`).

**`test-ingest-prompt-slimming.js` grew 204 → 488 assertions in v3.0.17**
(the ingest-report and orchestration-hardening release). The new section
(§20 in the suite, +284 assertions) drives `ingestMultiPhase` through a
**scripted fake LLM** instead of asserting against prompt text — its header
comment states the rule this exists to enforce: *"a source guard can confirm
a line exists, it cannot confirm the line runs."* `ingestMultiPhase` takes a
trailing `llm` parameter (defaulted to the real `generateText`), the same
test-only injection pattern `compile.js` already used via `opts.generateText`
— see *Test-only LLM injection seams* below. Driving the real orchestration
this way is what caught two real defects that had shipped with passing
source-level assertions next to them: a dead-assignment bug that made the
Phase 1 budget-sizing instrument silently report the FAILED attempt's spend
instead of the recovered retry's (implying a ~10× wrong per-page cost, in
the one case the instrument exists to measure), and a Phase 2 batch-response
gate that let `{"pages": []}` silently drop every planned page with no
warning while a non-array `"pages"` threw `TypeError: … is not iterable` and
killed the entire ingest. See
[docs/ingestion-pipeline.md §9.7](docs/ingestion-pipeline.md) for the full
list of what the new section covers, and Stage 1c / Stage 7b for the
underlying behaviour.

**Two new OFFLINE suites landed with v3.1.0** (Track 1 Foundation — the
`src/brain/paths.js` path-resolution module + `src/public/app.js` frontend
binding hardening; the release is designed to be invisible to users, and
these two suites are what prove that): `test-paths.js` (**127 assertions**)
covers repo-mode path-by-path byte equivalence against the pre-`paths.js`
computation, `isBundleInstall()`/`isRepoInstall()` in both directions against
a synthetic app tree, the TCC-avoidance rationale for
`~/Library/Application Support` over `~/Documents`, both test seams and their
precedence, `getUserDataDirState()`'s four-way migration seam, and — the
premise the whole bundle-detection design rests on — that a shipped tree
contains a tracked `domains/.gitkeep` but never a `.git` directory (see
[docs/architecture.md § Where user data lives](docs/architecture.md#where-user-data-lives-srcbrainpathsjs)
for why that premise sank an earlier detection design).
`test-frontend-null-safety.js` (**63 assertions**) was a dependency-free
scanner that verified
every top-level-equivalent `getElementById`/`querySelector` dereference in
`app.js` was `?.`-guarded or provably narrowed; deleted alongside `app.js`
in v3.41.0, with no successor — `src/public/next/app.js` carries the same
load-time-failure risk today with no equivalent guard over it (see
[docs/architecture.md § Frontend binding hardening](docs/architecture.md)).
See [§ Writing a good test](#writing-a-good-test) below for the design lesson it
exists to demonstrate.

**Two OFFLINE suites cover the batch-ingest queue** (Track 3 —
`src/brain/ingest-queue.js` + `src/routes/ingest-queue.js`, the durable
multi-file ingest job described in
[docs/ingestion-pipeline.md §10g](docs/ingestion-pipeline.md#10g-batch-ingest-queue-track-3)).
Both grew substantially across two adversarial audit rounds that each found
and closed a real bug before either shipped: a CRITICAL where concurrent
`/start` requests (a double-clicked Resume, two open tabs) could spawn more
than one worker loop for the same job — reproduced at 3 items ingesting
simultaneously, one document written to `log.md` three times — fixed by
taking the sequentiality claim in one synchronous turn instead of a
check-then-act sequence with `await`s in between (see §10g.1); and an H1
where a job could report `done` while an item was still silently `running`,
in none of the done/failed/skipped buckets (see §10g.1b).

`test-ingest-queue.js` (**317 offline assertions**) drives the real worker
end-to-end against a fake `ingestFile` via the module's own
`opts.ingestFile` test seam (the same pattern `compile.js` and
`ingestMultiPhase` established with `opts.generateText` / a trailing `llm`
param). Beyond the original coverage — sequential execution, largest-first
ordering, crash resume (including the specific regression where a per-item
duplicate check at run time would misclassify a crash-interrupted item as
already-ingested), transient-vs-permanent error classification (pinning that
ingest.js's genuine, unrelated `"…yielded only 429 characters of text"`
error is never misread as an HTTP 429 rate limit), the consecutive-failure
circuit breaker, the budget cap under both real and estimate-fallback
charging, the full pause/cancel/delete state machine, atomic-manifest
resilience to a corrupt sibling job, `toWire()`'s allow-list rewrite (it no
longer merely deletes `stagedPath` from a spread — it names every field
explicitly, scrubs absolute paths out of every string, and bounds the items
array), the `.gitignore`/`DOMAINS_GITIGNORE_RULES`/directory-nesting
invariants that keep the queue directory out of Personal Sync's work-tree,
and path-traversal defenses on job ids and staged filenames — it now issues
four `startOrResumeJob` calls in the SAME synchronous turn against one job
and asserts peak concurrent `ingestFile` calls is exactly 1 (via both the
fake's own tracker and the module's internal `getMaxIngestInFlight()`), and
runs a seeded pseudo-random sequence of start/pause/cancel/simulated-crash
across six batches whose items randomly succeed, fail, or rate-limit,
asserting that every file always lands in exactly one terminal bucket no
matter what sequence of control actions hit it.

**Historical — `test-ingest-queue-frontend.js` and the `app.js` it tested were
both deleted in v3.41.0; kept as a record of what the H1/H2 audit fixes
below were, not as current coverage.** `/next`'s own ingest-view frontend
(destination sidebar, drop zone, budget input, queue-mode gating) is now
covered by `scripts/test-next-ingest-view.js` (358 offline assertions), which
is not a line-for-line port of this suite. `test-ingest-queue-frontend.js`
(**225 offline assertions**) covered the
`src/public/app.js` side — extracted via the same `new Function` pattern as
`test-chat-compile-card.js`. Beyond the original coverage — the single-file
flow is provably byte-unchanged when only one file is selected,
cost/estimate formatting never fabricates a number, the shared ingest
busy-gate refcount balances across every status-transition sequence, there
is no `alert()`/`confirm()` anywhere in the new UI, every rendered filename
is HTML-escaped — it now covers the H1 done-summary accounting (every item
lands in a labelled bucket, so an unrecognised status can never silently
vanish from the totals), `job.failReason` rendering when a batch fails, the
H2 busy-gate domain-key pairing fix (the domain key recorded when the busy
gate was *entered* is what releases it, never a value re-read from the
dropdown later — closing a real leak where a resumed batch across a page
reload could hold the gate open forever), the visible custom `<select>`
control actually honouring its underlying native element's `disabled` state,
and — the other half of the concurrency story — that the single-file
**Ingest** button is disabled for a domain a batch is actively running
against, and NOT for any other domain, with a RED-confirmed check proving
the guard being bypassed really does leave the button clickable.

**A new OFFLINE suite, `test-ingest-abort.js` (84 offline assertions),
responds to live-production feedback that Cancel didn't actually stop
anything — it only stopped the *next* file, so a large batch kept spending
on paid LLM calls for minutes after the click.** The fix threads a real
`AbortSignal` from the queue's per-item `AbortController`, through
`ingestFile()`, into `generateText()`, and from there into both provider
SDKs — see
[docs/ingestion-pipeline.md §10g.1c](docs/ingestion-pipeline.md#10g1c--real-mid-item-cancellation-cancel-aborts-pause-does-not)
for the full design (including why Pause deliberately does NOT get the same
treatment). The suite's own load-bearing section (2) drives a scripted
multi-phase ingest through an abort mid-Phase-2 and asserts ZERO LLM calls
happen after the abort; section 3 ("THE TRAP") pairs every one of ingest's
recovery ladders with a control proving it still fires on an ordinary
failure and a case proving it must NOT fire on a cancellation (recovering
from a cancel would cost more than doing nothing); section 6 is the
queue-level integration test asserting the interrupted item settles as the
new `cancelled` status, not `failed` and not stuck `running`.

**Sections 7 and 7b are worth knowing about on their own: they are the
FIRST offline suite in this codebase to bind an ephemeral loopback HTTP
server and point a provider's base URL at it**, so the REAL 429 retry-and-
backoff ladder inside `generateText()` runs end-to-end against synthetic
rate-limit responses — no real API key, no paid call, no network beyond
`127.0.0.1` — while still proving that a cancel arriving mid-backoff (or
mid-request) interrupts promptly instead of waiting out the delay. If
you're adding a test that needs to exercise real retry/backoff/timeout
logic in `llm.js` without hitting a real provider, this is the pattern to
copy rather than reinventing an HTTP mock.

**Two new OFFLINE suites cover raw-source retrieval** (Track 7 Part II —
`src/brain/raw-store.js`, the module that gets from a wiki summary back to
the original document it was built from; see
[docs/ingestion-pipeline.md §10h](docs/ingestion-pipeline.md#10h-raw-source-retrieval-track-7-part-ii)
for the full design). `test-raw-store.js` (**191 offline assertions**) is
almost entirely a security suite, because the feature reduces to "open the
file this untrusted string names." Its most important lesson is
methodological, not just a list of cases: §2 exercises real symlinks on disk
(a symlinked file, a symlinked directory, a dangling symlink, an in-bounds
symlink) against `resolveRawSource()` and all were correctly refused — but
disabling the physical (`realpath`) containment check left every one of
those assertions green anyway, because earlier layers (the sanitiser's
separator refusal, then `lstat().isFile()` on the symlink leaf) fire first.
That is the v3.2.0 failure mode — a check that LOOKS like it's testing
containment while passing for unrelated reasons — reproduced inside the
test meant to catch it. §2b was rebuilt to mutate and probe each layer
independently (verified by literally swapping in the pre-v3.2.0
lexical-only implementation and confirming it lets all three real symlink
escapes through, canary file included), and only then did the mutations
go red. If you're writing a security regression test for a layered guard,
this is the shape to copy: prove each layer's necessity by disabling it
alone, not just that the whole stack together happens to refuse your
fixture. The suite also covers the sanitiser/traversal corpus, benign
real-world filenames (spaces, parentheses, multiple dots), `sourceForSummary`
across every reason shape, the manifest's append/tolerant-read/best-effort
contract, the MCP tool's binary refusal against a real binary fixture,
`hashRawSource` streaming instead of buffering, and that neither
`raw-store.js` nor the MCP tool imports any HTTP client (the `external-source`
case is classified, never fetched — fetching an LLM-authored, sync-delivered
string would be an SSRF primitive).

**`test-raw-source-ui.js` was deleted alongside `app.js` in v3.41.0.** Its
successor, `scripts/test-next-raw-source.js` (**185 offline assertions**),
covers the pure
`describeRawSource()`/`renderReaderSourceHtml()` functions in
`src/public/next/app.js`, extracted the same way — every backend `reason`
maps to the
right UI state, an unrecognised reason degrades to rendering nothing rather
than something confidently wrong, the `external-source` URL renders as inert
escaped text (never a link, never fetched, and the request is gated to
`summaries/` paths so it never fires on every entity/concept page open), and
no code path ever references `absPath` — the server never sends one for the
client to leak.

**A suite that is deliberately temporary must be deleted, not adapted, once
its reason for existing is gone — and that is exactly what happened here.**
`src/public/next/**` was a parallel redesign frontend served at `/next` (see
[docs/architecture.md § The redesigned shell](docs/architecture.md#the-redesigned-shell-srcpublicnext--the-primary-frontend-since-v390)
for what it is and why it exists) alongside `src/public/app.js`, until the
latter was retired outright in v3.41.0.
`src/public/next/shared/ingest-queue-logic.js` holds 13 pure batch-ingest
helper functions that were copied byte-identically from `app.js`, because a
batch-queue bug fixed only in the shipping app would otherwise have silently
re-shipped to `/next` while both existed. `test-next-ingest-logic-drift.js`
(**OFFLINE**) enforced
that byte-identity: it did not run or evaluate the functions, it extracted
each one's source text from both files with a plain regex and string-compared
it — a behavioral test can pass while two copies diverge in a way that only
matters for an untested input; a source comparison cannot miss any textual
difference. It also independently scanned `ingest-queue-logic.js`'s own
top-level declarations and checked the set matched a hardcoded name list
exactly, so a 14th helper added without updating that list would also fail.
**Its own header instructed deleting the file and its `OFFLINE` entry in
[scripts/run-tests.js](scripts/run-tests.js) once `app.js` was gone — never
repointing it at some other pair of files or turning it into a coverage test
for the survivor — and v3.41.0's retirement did exactly that.** The
comparison it performed is meaningless with only one copy left, so there is
no successor suite: `ingest-queue-logic.js` in `next/` is now the only copy
of these helpers (see [docs/architecture.md](docs/architecture.md)).

**A new OFFLINE suite pins the write-registry guard on `/api/config`, `/api/sync/setup`, and domain-rename** — `test-route-write-guards.js`. These routes (API-key save/disconnect/switch, the knowledge-folder path, sync setup, domain rename) mutate state that a running ingest reads live (`getDomainsDir()` and `getProviderInfo()` both resolve fresh on every call), so changing them mid-ingest can split a document's pages across two folders or finish it on a different model. Every "the guard fires" assertion is paired with a "the guard does NOT fire while idle" assertion against the same route — a guard that always blocks is exactly as broken as one that never does, and only the negative half tells those two apart. A dedicated section also pins the routes deliberately left **unguarded** (`POST /api/config/default-domain` — it only selects which domain an unnamed MCP write assumes, and can't affect a write already in flight), so a future blanket sweep shows up as a failing assertion rather than shipping silently. It spins up the real router in-process against isolated tempdirs (`CURATOR_TEST_USER_DATA_DIR` + `CURATOR_TEST_DOMAINS_DIR`, set before any app module is imported) and never calls `POST /api/config/update` or exercises `POST /pick-folder` outside its refused state, for the same reasons any suite in this repo avoids them (see the sections above).

---

## How tests are classified

The offline-vs-live split is an explicit manifest at the top of
[scripts/run-tests.js](scripts/run-tests.js):

- **OFFLINE** — pure, deterministic, no network, no API key. These define the
  green bar for `npm test` and CI.
- **LIVE** — hit a real provider/GitHub, or stand up the server. Gated behind
  `--live` / `RUN_LIVE=1` and self-skip without their key.

A suite passes iff it exits `0` **and** its output shows no failure marker
(`Failed: <n>` / `<n> failed` / a bare `✗`).

**Live suites additionally get flake tolerance (v3.0.1-beta.26+)** so a provider
outage can't red the build — see the *Flakiness* subsection below. Offline suites
are deterministic and are never retried.

---

## Continuous Integration (GitHub Actions)

Every push and pull request is checked automatically by
[.github/workflows/test.yml](.github/workflows/test.yml) on GitHub's servers.
Two jobs:

| Job | When it runs | API keys | Cost |
|-----|--------------|----------|------|
| **Offline tests** | every push (any branch) + every PR (incl. forks) | none | free |
| **Live API tests** | push to `main` + manual "Run workflow" only | `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` from repo Secrets | a few cents per run |

**Docs-only pushes are skipped (v3.0.1-beta.27+).** The `push` trigger has a
`paths-ignore` for `**.md` and `docs/**`, so a push whose changed files are *all*
documentation does **not** run the workflow — no Actions minutes, no paid live
job. A push that touches any non-doc file runs normally. Pull requests are not
path-filtered, so a docs PR still gets the free offline check.

The offline job runs `npm ci` + `npm test` on a clean Ubuntu machine — which also
catches the "works-on-my-machine" class of bug that hid on configured dev
machines before v3.0.1-beta.21.

**Why the live job never costs the community money:** GitHub withholds repository
secrets from fork-PR workflows, and the live job is additionally gated to
`push`-to-`main` / manual only. So a contributor's PR gets the **free** offline
checks; the **paid** live checks only ever run when a maintainer pushes to
`main`. The live job also `needs: offline`, so no API money is spent if the free
tests already failed.

**CI runs only the CI-safe live suites.** GitHub sets `CI=true`, and
[scripts/run-tests.js](scripts/run-tests.js) uses that to run the `LIVE_CI` set
(self-contained, deterministic) and skip the `LIVE_LOCAL` set (real-data
benchmarks like `test-beta13-chat-live` and `test-ingest-real-llm`, the
quality-threshold `test-ingest-deep`, and the two browser sweeps —
`test-visual-regression` and `test-info-panel-reachability` — which cost \$0 and
need no key but do need a browser GitHub's runners do not reliably have). Those local-only suites still run in a
full local `npm run test:live`. A CI-safe live suite must not read a file
outside the repo: use a committed fixture (e.g. `docs/ingestion-pipeline.md`
as a large source, or `scripts/test-ingest-deep-inputs/`) rather than anything
under `domains/`.

Since v3.0.6 (Phase 5 of the Shared Brain hardening plan) the `LIVE_CI` set
also includes the three Shared Brain integration suites, so the
`GITHUB_TEST_*` secrets are actually consumed when present:

- `test-sharedbrain-github-live` — the REAL GitHub adapter end-to-end:
  contributions, synthesis, **revoke E2E (GDPR Article 17)**, and true
  concurrent-writer races. Self-skips without `GITHUB_TEST_REPO`/`_PAT`;
  every run uses fresh slugs and cleans up exhaustively.
- `test-sharedbrain-routes` — spawns the real server on port 3334 and drives
  every `/api/sharedbrain/*` endpoint over HTTP, including the revoke
  success path. Isolated via `CURATOR_TEST_USER_DATA_DIR` (v3.1.0+) — the
  child never reads or writes the maintainer's real `.curator-config.json`,
  `.sync-config.json`, or `.sharedbrain-config.json` at all, so there's
  nothing left to back up and restore. Instead the suite fingerprints
  (size + sha256 — deliberately NOT mtime, since the maintainer's own live
  app on :3333 legitimately rewrites `.curator-config.json` during ordinary
  use and a same-bytes rewrite must not fail the guard) those three files
  plus `.env` once before spawning the child and once after the run, and
  asserts content-identity as a permanent regression guard — see the header
  comment in the suite and the table below.
- `test-sharedbrain-llm-live` — the delta-generation and conflict-resolution
  prompts against every configured REAL provider (Gemini + Anthropic),
  through the GitHub adapter when the secrets are present (local adapter
  otherwise).

`LIVE_CI` also carries the OpenRouter suite, which is the only one keyed on
`OPENROUTER_API_KEY`:

- `test-openrouter-live` — the third provider end-to-end on four real requests:
  text mode, JSON mode through a real `ingestFile`, the SSE streaming path, and
  a model id that does not exist. It runs on
  `ibm-granite/granite-4.0-h-micro`, the cheapest HAND-MEASURED model in the
  catalogue, and never syncs the runtime catalogue — so it cannot reach a model
  nobody has measured. It also re-checks live what
  `MODEL_PRICES_USD_PER_MTOK`'s own comment claims: the hand-typed rate
  reproduces OpenRouter's reported bill to the last decimal. Measured spend
  ~$0.00014 per run, printed at the end, and the suite fails if a run exceeds
  one cent. **Unlike its siblings it does NOT read a key out of
  `.curator-config.json`** — it isolates `CURATOR_TEST_USER_DATA_DIR` and
  `CURATOR_TEST_DOMAINS_DIR` to tempdirs before importing a single app module
  and asserts that isolation before spending anything, so the key must be in
  the environment (or `.env`). That is deliberate: the alternative is moving the
  maintainer's real config aside for the duration of a run, which is a
  data-loss hazard the moment the runner SIGKILLs the suite on timeout.

To run the GitHub-backed suites locally without minting a fine-grained PAT,
the `gh` CLI token works (it has `repo` scope):

```bash
GITHUB_TEST_REPO=<you>/<throwaway-private-repo> \
GITHUB_TEST_PAT=$(gh auth token) \
npm run test:live
```

**Flakiness — transient-error tolerance (v3.0.1-beta.26+).** Live tests call real
providers, so a transient outage (Gemini HTTP 503 "overloaded", an Anthropic
"Premature close" dropped stream, a 429 rate-limit, a network blip) used to red
the live job even though the code was fine. The runner now distinguishes a
provider outage from a real defect, so the live gate stays useful (**red == real
bug**) and you almost never need to re-run it manually:

- A failed live suite whose **first attempt already shows a transient marker**
  (the provider is in a storm) is **not** retried — a retry would just grind
  through the same backoffs — and is reported **inconclusive** (⚠ flake), which
  does **not** fail the build.
- A failed live suite with **no** transient marker is **retried once** (an
  intermittent blip or a non-deterministic LLM-quality miss often passes on a
  second look). If the retry passes → pass; if it fails with a transient marker →
  inconclusive; if it fails again with **no** transient marker → genuine **FAIL**.
- Offline suites are deterministic and are **never** retried. A suite **timeout**
  is never retried and stays a FAIL.

The transient-marker list and the `pass`/`fail`/`inconclusive` decision live in
[scripts/ci-flake.js](scripts/ci-flake.js) (pure, unit-tested by
`test-ci-flake.js`); the retry/inconclusive orchestration in
[scripts/run-tests.js](scripts/run-tests.js) is integration-tested by
`test-runner-integration.js` (which drives the real runner via the test-only
`RUN_TESTS_LIVE_ONLY` seam against deterministic fixtures in
`scripts/test-fixtures/`). **When a provider emits a new transient error string,
add it to `TRANSIENT_MARKERS` in `ci-flake.js`.**

Accepted trade-off: a real failure that coincides with a transient error in the
same run is reported inconclusive rather than fail — acceptable for a live-API
gate, because the deterministic offline suite + a local `npm run test:live` still
catch real regressions, and a real bug recurs on the next healthy-provider run.

A **quality assertion that depends on the LLM's subjective judgment** (e.g. "did
the model choose to link this orphan?") should not be a hard CI gate at all —
the retry only helps if it's intermittent. Assert the *correctness and safety* of
whichever choice the model makes (as `test-beta17-production.js` does), or move
the suite to `LIVE_LOCAL`.

### Adding the API-key secrets (one-time, maintainer)

The live job self-skips every suite until these repo secrets exist. To add them:

1. On GitHub, open the repo → **Settings** (top tab) → in the left sidebar,
   **Secrets and variables** → **Actions**.
2. Click **New repository secret**.
3. **Name:** `GEMINI_API_KEY` — **Secret:** paste your Gemini key → **Add secret**.
4. Repeat for **Name:** `ANTHROPIC_API_KEY` — **Secret:** your Anthropic key.
5. (Optional) `GITHUB_TEST_REPO` (e.g. `you/curator-ci-throwaway`) +
   `GITHUB_TEST_PAT` to also run the GitHub-backed Shared Brain live suite;
   otherwise it self-skips.

Secret **values** are encrypted and never shown again or printed in logs (GitHub
auto-masks them). Anyone can see a secret's *name* exists, but not its value. To
run the live suite on demand without pushing: repo → **Actions** → **Tests** →
**Run workflow**.

### Test seams: domains vs. user data

The Curator has **two** test-isolation env vars, and they isolate different
things. Reaching for the narrower one when your test starts a real server is
the mistake this section exists to prevent.

| Seam | Isolates | Does NOT isolate |
|---|---|---|
| `CURATOR_TEST_DOMAINS_DIR` (env) / `__setDomainsDirOverride()` (`config.js`, in-process) | `domains/` only | `.curator-config.json`, `.sync-config.json` (your real GitHub PAT), `.sharedbrain-config.json`, `.knowledge-git/`, `.env` |
| `CURATOR_TEST_USER_DATA_DIR` (env) / `__setUserDataDirOverride()` (`src/brain/paths.js`, in-process) | `.curator-config.json`, `.sync-config.json` (your real GitHub PAT), `.sharedbrain-config.json`, `.knowledge-git/` — unconditionally — **plus** `domains/`, unless something higher in `getDomainsDir()`'s own precedence chain overrides it (a `DOMAINS_PATH` env var, or `--domains-path` for the MCP) | **`.env`** — see below. This is a real, verified gap, not a hypothetical one. |

**The safety rule, stated plainly: if your test starts a server (spawns
`src/server.js`, or `mcp/server.js`), set `CURATOR_TEST_USER_DATA_DIR`, not
just `CURATOR_TEST_DOMAINS_DIR` — or the server holds the developer's real
GitHub PAT and Shared Brain tokens for the duration of the test.** This is
not theoretical: before `CURATOR_TEST_USER_DATA_DIR` existed,
`CURATOR_TEST_DOMAINS_DIR` isolated only the wiki content a test wrote to —
the same server process still read and could write
`.curator-config.json`/`.sync-config.json` from the maintainer's real
`APP_ROOT`. A test-suite bug that clicked Sync (or called the sync route
directly) on that server would have pushed to the maintainer's real GitHub
repository. Use `CURATOR_TEST_DOMAINS_DIR` alone only for in-process,
no-server tests that exclusively touch `domains/` content and never construct
a `sync`/`sharedbrain` code path.

**`CURATOR_TEST_USER_DATA_DIR` isolates the dangerous credential file — it
does not make a test server free to run.** `.env` is deliberately excluded:
`src/brain/paths.js`'s `getCredentialFiles()` anchors it to `appPath('.env')`
(`APP_ROOT`, the real checkout) rather than `getUserDataDir()`, because it is
"a developer-only fallback that lives with the SOURCE" (its own docblock's
words) — dotenv reads it relative to `cwd` at process start
(`src/server.js`'s `import 'dotenv/config'`), regardless of which override is
set. And `getEffectiveKey()`/`getApiKeys()` in `src/brain/config.js` fall
through to `process.env.GEMINI_API_KEY`/`ANTHROPIC_API_KEY` whenever the
(isolated, empty) config file has no key of its own. The practical
consequence, verified directly rather than inferred: **a test server started
with `CURATOR_TEST_USER_DATA_DIR` set can still resolve the maintainer's real
API keys from the repo's `.env` and make real, billed LLM calls** — isolation
covers the credential *files* (crucially including the GitHub PAT that could
push to the maintainer's real repository, which is what the seam exists to
protect), not API spend. If a test must guarantee it spends no money, it has
to avoid exercising any LLM-calling code path — `CURATOR_TEST_USER_DATA_DIR`
alone does not guarantee that, and no env var currently does.

**Worked example:** `scripts/test-sharedbrain-routes.js` is the reference
implementation — it spawns `src/server.js` on port 3334 with BOTH
`CURATOR_TEST_USER_DATA_DIR` (a fresh tempdir, isolating the credential
files + `.knowledge-git`) and `CURATOR_TEST_DOMAINS_DIR` (a second, separate
tempdir) set on the child's env, then proves the isolation two ways rather
than trusting the code: (1) an HTTP round-trip — `GET /api/config` on the
running child must report `domainsPath` as the tempdir, not the real
`domains/` folder; (2) a filesystem check — after the child persists a
Shared Brain connection, `.sharedbrain-config.json` must exist inside the
tempdir. It also fingerprints (size + sha256 — deliberately NOT mtime, for
the same live-app-rewrite reason above) the maintainer's real
`.curator-config.json` / `.sync-config.json` / `.sharedbrain-config.json` /
`.env` before spawning the child and again after the run, and fails loudly
if any of their CONTENT changed — a permanent regression guard in case isolation is
ever silently broken later (e.g. a future module re-deriving a config path
without going through `paths.js`). Copy this shape for any new test that
spawns a server.

### `CURATOR_TEST_LAUNCH_APP` — the opt-in launch gate

Not an isolation seam. The two above answer *which files may this test touch*;
this one answers *may this test start a real macOS `.app`*, and the default is
no.

`scripts/test-desktop-version-identity.js` carries a load probe that runs a
packaged bundle's own Mach-O with `ELECTRON_RUN_AS_NODE=1`. It is the only
check in the repo that catches the **hardened-runtime-over-ad-hoc** failure —
a bundle that passes `codesign --verify --deep --strict`, passes `spctl`, and
still dies at dyld time with a library-validation error before a line of app
code runs. Every static check goes green on an app that is dead on arrival, so
the probe genuinely earns its place and must not be deleted.

But `ELECTRON_RUN_AS_NODE` only suppresses the app's *own* window. When the
binary fails to load, the process really did start and really was killed, and
macOS's crash reporter puts **"The Curator cannot be opened because of a
problem"** on the desktop of whoever is sitting at the machine. The probe is
therefore dialog-free exactly when it finds nothing and dialog-popping exactly
when it finds something — and the hardened-runtime *control* manufactures a
bundle that is guaranteed not to load, so it fired one on every run, including
during an ordinary `npm test`. A suite in the `OFFLINE` array must not do that
on a contributor's machine; that is how a check gets disabled instead of fixed.

```bash
npm test                              # no bundle is ever launched (default)
CURATOR_TEST_LAUNCH_APP=1 npm test    # …and now the load probe runs
```

Two properties keep the default honest:

- **A skip always says so, and names the variable.** A silent skip is how a
  check quietly stops existing.
- **Everything that does not launch still runs unconditionally** — including
  the real bundle's signature flags, read with `codesign -dv` and parsed. The
  hardened-runtime defect is visible in `flags=0x10002(adhoc,runtime)` with no
  launch at all, so the gate does not blind the suite to the bug it was
  written for. The `afterPack` hook also runs the same probe on every real
  build, so a release cannot ship without it.

The suite additionally **skips rather than fails** when the bundle in
`desktop/dist/` is stale — its `Info.plist` version disagreeing with the root
`package.json`. `dist/` is gitignored build output and not a property of the
commit under test, and a version-mismatched bundle cannot have come from a
hook-enforced build (the hook refuses that build and emits nothing). The skip
costs no coverage: the version refusal is proven non-vacuously on a fabricated
bundle, on every platform. A bundle that *is* current is held to every check
and is allowed to go red.

Both `CURATOR_TEST_DOMAINS_DIR` and `CURATOR_TEST_USER_DATA_DIR` beat
`.curator-config.json`'s `domainsPath`/config values respectively (that's the
point — they need to win on a maintainer's fully-configured machine, not just
a clean CI runner), work across a spawned child process (env vars are
inherited; the in-process overrides are not), and are always unset/`null` in
production. Do **not** use plain `process.env.DOMAINS_PATH` for isolation: it
*loses* to a configured `domainsPath` in `getDomainsDir()`'s precedence chain,
so on a real install it silently no-ops and the test writes into the user's
actual wiki — this exact trap broke four suites before v3.0.1-beta.21 (see
CLAUDE.md's history for that release) and is precisely why the override seams
exist instead of reusing `DOMAINS_PATH`.

See [docs/architecture.md § Where user data lives](docs/architecture.md#where-user-data-lives-srcbrainpathsjs)
for the full precedence chain both seams sit in front of, and why
`CURATOR_TEST_USER_DATA_DIR` had to be a new, separate seam rather than an
extension of the domains-only one.

---

## Adding a test

1. Create `scripts/test-<subsystem>.js`. Follow an existing suite's shape (a
   small `ok` / `fail` / `assert` harness + a printed `Passed: N  Failed: M`
   summary, and `process.exit(1)` on any failure).
2. **Add the filename to the `OFFLINE` or `LIVE` array in
   [scripts/run-tests.js](scripts/run-tests.js).** A suite not in either array
   is never run by the aggregator.
2b. **Bump the suite count near the top of this file in the SAME commit.**
   `scripts/check-doc-suite-counts.js` compares that prose against the arrays
   and fails `npm test` when they disagree. This is deliberate coupling — the
   count had gone stale three times before it was checked — but it does mean
   step 2 alone leaves the suite red until you do this.
3. If the test needs to point the domains directory at a throwaway tempdir, use
   **`__setDomainsDirOverride(dir)` from `src/brain/config.js`** (and clear it
   with `__setDomainsDirOverride(null)` at cleanup). Do **not** set
   `process.env.DOMAINS_PATH` for this purpose — it loses to a configured
   `domainsPath` in `.curator-config.json` and silently no-ops on any real
   install (this exact trap broke four suites before v3.0.1-beta.21). The
   override is checked before config and is `null` in production. **If your
   test spawns a real server rather than calling functions in-process, use
   `CURATOR_TEST_USER_DATA_DIR` instead** — see
   [§ Test seams: domains vs. user data](#test-seams-domains-vs-user-data)
   above for why the domains-only seam isn't enough there.

Run `npm test` and confirm your suite shows up and passes.

### Test-only LLM injection seams (`opts.generateText` / `ingestMultiPhase`'s `llm` param)

**The rule this pattern exists to enforce: assert behaviour, not the presence
of a line of source.** A `grep`-shaped assertion ("does this string appear in
`ingest.js`?") can confirm a line exists; it cannot confirm the line *runs*,
still less that it runs *correctly* on every input shape that reaches it.
v3.0.17 found this the hard way: a source-regex assertion for the Phase 1
budget-sizing instrument gave positive assurance for a value that was
**always wrong** — a dead-assignment bug meant the "which attempt does this
measurement report?" question was never actually exercised, because nothing
drove the code path that would have shown the bug. The fix wasn't a smarter
regex; it was making the real orchestration function runnable offline.

**The pattern**, first shipped in `compile.js` (`opts.generateText`, v3.0.1-
beta.27) and reused by `ingestMultiPhase` in `ingest.js` (a trailing `llm`
parameter, v3.0.17): the orchestration function that drives an LLM through a
retry/fallback ladder accepts the LLM-calling function itself as a parameter,
**defaulted to the real one** so every production call site is unaffected.
A test then passes a small scripted fake — a list of
`{out: '...', tokens: N}` / `{throw: () => new Error(...), tokens: N}` steps,
returned in order — and asserts on what the *real* function does with those
responses: which pages get written, which warnings get pushed, what the
`console.error`/`console.warn` sizing lines actually say. See
`scripts/test-ingest-prompt-slimming.js` §20 (`makeFakeLLM`,
`runMultiPhase`) for the concrete shape, and
[docs/ingestion-pipeline.md §9.7](docs/ingestion-pipeline.md) for what it
caught.

**When to reach for this:** the function under test (a) touches no
filesystem/network itself — only the injected LLM call does — and (b) has a
retry, fallback, or recovery ladder whose FAILURE paths are exactly the ones
a source-regex or a single happy-path live-API call won't reliably exercise.
Both `compile.js` and `ingest.js`'s multi-phase path fit: their defects live
in "what happens when the second attempt also comes back malformed" territory,
which is expensive and non-deterministic to hit against a real provider but
trivial to script.

### Writing a good test

Two lessons this repo has now learned the hard way, twice each — worth
internalising before adding your own suite:

**1. Assert behaviour, not the presence of a line of source.** A `grep`-
shaped assertion ("does string X appear in file Y?") can confirm a line
exists; it cannot confirm the line *runs*, still less that it runs correctly
on every input shape that reaches it. The v3.0.17 budget-instrument bug
described above is the canonical case: a source-regex assertion gave positive
assurance for a measurement that was **always wrong**, because nothing in the
test actually drove the code path that would have exposed it. Prefer driving
the real function (via a test-only injection seam like the ones above, or by
calling it directly against a tempdir) and asserting on its output over
asserting that some string is present in the file that defines it.

**2. If a test's own correctness depends on a clever heuristic — a hand-
rolled scanner, a regex-based lexer, a "does this pattern match" classifier —
give it an independent, deliberately DUMB cross-check, and assert the two
agree exactly.** Both of the source-scanning suites in this repo were fooled
this way, and both incidents are worth knowing about because a plausible-
looking scanner is exactly the kind of test that stays green while quietly
missing the thing it exists to catch: `test-css-tokens.js` had silently
**baselined away** two real undefined-CSS-variable bugs (`--font-mono`,
`--text-1`) as "already known," so a *third* occurrence of either would have
passed silently — fixed in v3.0.15 by turning those two into named, positive
regression assertions instead of a blanket baseline (see CLAUDE.md's v3.0.15
history entry). `test-frontend-null-safety.js`'s string/regex-vs-division
stripper was found blind twice during its own construction — once on a
nested template literal, once on a `return /regex containing "quotes"/` —
with every one of its assertions passing both times, because the assertions
only checked what the sophisticated scanner *thought* it saw, never whether
that view of the file was complete. Its fix is the pattern to copy: a second,
independently-implemented, much simpler counting pass
(`dumbColumnZeroDeclCount` — no string/comment stripping, no
regex-vs-division judgment calls, just "does this line start at column 0 and
look like a declaration") that has
no way to share the sophisticated scanner's blind spots, cross-checked for
**exact set equality** (same count, same line numbers) against the real
scanner's output on the actual file, every run. A silent desync between the
two — even one line — fails loudly with both lists printed. The dumb check
doesn't need to be *right* in some absolute sense; it needs to be *wrong in a
different way* than the clever one, so the two disagreeing is itself the
signal.

### Tempdir hygiene (v3.9.1)

A suite that creates a temp directory **per section** and tracks it in a single
variable cleans up **only the last one**. That is not hypothetical: it left
**37,353** stale directories on the maintainer's machine. `test-ingest-queue.js`
called `freshEnv()` 34 times per run and remembered **0 of 34** (no cleanup at
all); `test-ingest-abort.js` called it 6 times and remembered **1 of 6** — it
*had* a cleanup line, but the pointer had already been overwritten five times.
A bare pointer used as a cleanup mechanism forgets everything except what it
currently points to.

If your suite creates more than one temp root per run:

- Track **every** root in a `Set` registry, added at the same site that creates
  it, so a future section gets cleanup for free. Do **not** add an `rm` at each
  call site — that is the guard-applied-to-a-site-not-a-class shape this
  codebase keeps re-learning.
- Wrap the whole run in `try { … } finally { await cleanup(); }` so cleanup runs
  before `process.exit()`, **and** add a `process.on('exit', …)` fallback using
  **`rmSync`** — an exit handler cannot await, so an async cleanup there is a
  no-op.
- Before removing anything, assert the path is exactly one segment below
  `os.tmpdir()` and carries your suite's own prefix. A cleanup routine with a
  path bug is far worse than a leak.
- Prove it: force a throw immediately after you create a root, and confirm the
  directory is still gone. Cleanup that only runs on the success path is the
  common case, not the rare one.

Two smaller instances are recorded and unfixed: `curator-cfgguard-*`
(`test-route-write-guards.js`) cleans up in a bare top-level statement rather
than a `finally`, and `curator-wikilist-*` (`test-wiki-list.js`) is correctly
guarded but had one stale dir from a killed process. Same class, blast radius of
1–3 directories rather than tens of thousands.

### CSS custom-property hygiene (`scripts/test-css-tokens.js`)

CSS custom properties (`var(--name)`) fail **silently** — an undefined name
just falls back to the inherited/UA color with no error, anywhere in the
browser or build. That's exactly what shipped in v3.0.12: `styles.css`
referenced `var(--text-dim)`, a variable that didn't exist, and the dropdown
text rendered near-black on a dark menu until a user reported it. There was
no CSS test at all at the time. `test-css-tokens.js` is a small,
dependency-free scanner (offline, in the `OFFLINE` manifest) that reads every
local stylesheet `index.html` links, extracts every `--name: value;`
definition (wherever it appears — `:root`, a media query, a `[data-theme]`
block) and every `var(--name)`/`var(--name, fallback)` reference (including
nested ones inside a fallback), and fails if a referenced name has no
definition anywhere. It also scans `src/public/app.js` for `var(--name)`
references embedded in JS string/template literals (e.g. an inline
`style="color:var(--x)"` snippet built at runtime for a status banner) and
checks those against the same set of stylesheet-defined tokens — a CSS-in-JS
reference is just as capable of going stale as one written directly in a
`.css` file, and it isn't visible to a plain stylesheet scan. If you add a new theme token, define it in `:root` (or
wherever appropriate) before referencing it — the test catches the typo
class of bug (`--font-mono` vs. the real `--mono`), not just missing new
tokens: `var(--font-mono)` and `var(--text-1)` were exactly that typo, and
are now locked in by a dedicated regression assertion (section 3b of the
suite) rather than being folded into the generic "undefined variable"
check, so a reintroduction fails with an unmistakable, name-specific
message. Three other pre-existing undefined references (all carrying a
working hex fallback, so they render correctly today — dead token names,
not rendering bugs) are intentionally baselined by name at the top of the
file so the suite stays honest without silently forgetting them; fixing one
of those in `styles.css` just means deleting its baseline entry.

---

## Cutting a release

**A push to `main` IS the deploy.** `main` has no branch protection and no
rulesets — verified, not assumed:

```bash
gh api repos/talirezun/the-curator/branches/main/protection
# → {"message":"Branch not protected","status":"404"}
gh api repos/talirezun/the-curator/rulesets
# → []
```

and the in-app auto-updater (`POST /api/config/update`) runs `git fetch origin
main` + `git reset --hard origin/main` + `npm install` + a `.app` rebuild. So
whatever lands on `main` reaches every user's machine on their next update
check, green or red.

That is why the release is a script with refusals, and why it releases through
a **gate** rather than pushing straight to `main`.

### The gate

```
release/vX.Y.Z  ──push──▶  CI (~8 min)  ──green?──▶  main fast-forwards to it
                                │
                                └── red ──▶ main untouched. Nothing deployed.
```

`main` only ever receives a commit CI has already validated. Three properties
fall out of that, and each is asserted in `scripts/test-release-preconditions.js`:

- **The merge is `--ff-only`, and that is load-bearing rather than stylistic.**
  A merge commit would make `main` a SHA that no CI run ever executed on, which
  is precisely the property the gate exists to provide. `main` is always the
  exact verified commit, byte for byte. `assertSafeCommand()` refuses a
  non-`--ff-only` merge structurally, so no code path can construct one.
- **The tag is created AFTER the merge**, on the commit `main` points at. A tag
  can therefore never name a commit that failed CI.
- **A red gate leaves `main` untouched and the release branch in place**, so the
  fix is a commit ON TOP of that branch. The script refuses to release over an
  existing release branch (`release-branch-exists`) precisely so a re-cut cannot
  quietly bury a failed attempt.

**The gate is the `offline` job.** `.github/workflows/test.yml` gates `live` to
push-`main` plus manual dispatch, so it does not run on a release branch at all
— and that is the right split rather than a gap. `live` spends real money, can
take 20 minutes, and is deliberately flake-tolerant through
`scripts/ci-flake.js`; a required check designed to tolerate its own transient
failures is the wrong thing to block a green tree on. `live` still runs on
`main` after the merge, exactly as before. `--watch-main` waits for it and
reports it, and never changes the exit code.

**The gate reports what it did NOT see.** A job that was skipped is named in the
output rather than silently counted as a pass, so "green" never quietly means
"green on the two checks that happened to run".

> **`.github/workflows/test.yml`'s push trigger must stay unfiltered.** A bare
> `push:` fires on every branch, which is what gives the release branch a run at
> all. Restricting it to `main` would not break loudly — the branch would simply
> get no run, and a gate waiting for a run that never starts is worse than no
> gate, because it looks like one. `release.js` refuses (`ci-not-reachable`) if
> it finds a `branches:` or `branches-ignore:` key there, and the suite asserts
> the same thing against the real file.

### The three commands

```bash
# 1. Land the work on main and write the release's row into CLAUDE.md's
#    full-row changelog table. Leave the "- **Version:**" line ALONE —
#    release.js moves it together with package.json and package-lock.json,
#    so the three cannot disagree.

# 2. Rehearse. Every check runs; nothing is written, created or pushed.
node scripts/release.js 3.29.0 --dry-run

# 3. Release.
node scripts/release.js 3.29.0            # prompts for the version to confirm
node scripts/release.js 3.29.0 --yes      # non-interactive (agents; CI)
```

Options: `--dry-run`/`-n`, `--yes`/`-y`, `--no-push` (commit on the release
branch locally, push nothing), `--no-watch` (push the branch but don't wait —
`main` is left untouched and you finish the merge yourself), `--keep-branch`,
`--watch-main`, `-m "subject"` (the default subject is derived from the
changelog row's first bolded run and clipped to 72 chars — pass `-m` for the
longer hand-written style the history actually uses), `--skip-tests`, `--help`.

Exit codes, so an agent can branch on the outcome: **0** released, **1** refused
before anything irreversible, **2** the gate went red — `main` untouched and
nothing deployed, **3** the gate's outcome could not be observed — `main`
untouched. **An unobservable gate fails CLOSED**, because the whole point is
that `main` only ever receives a verified commit.

### What happens to the release branch

**It is deleted after a successful merge, and that is the recommendation.** Its
commit is reachable from both `main` and the annotated tag, so nothing is
orphaned and the branch carries no history of its own — the tag is the durable
record of that exact SHA. Keeping them would accumulate a `release/*` namespace
that makes GitHub's branch list useless within a year, for no recoverable
information. Pass `--keep-branch` to keep one.

The deletion uses `git branch -d` (never `-D`), which refuses an unmerged
branch, so the local delete is itself a last check that the merge really
happened; if it refuses, the remote delete is not attempted. `assertSafeCommand()`
permits this one deletion and nothing else: the branch name must match
`release/vX.Y.Z` exactly. **A red gate never deletes the branch** — that is
where the fix goes.

### What it refuses, and why each one is there

**This table is the notable subset, not the full list.** `scripts/release.js`
declares its refusal ids in one frozen `REFUSALS` object — **derive the list from
there, never from prose.** The only automated check on it is an anti-vacuity
floor in `scripts/test-release-preconditions.js` (`declared.length >= 20`), so
nothing goes red when a number written down somewhere drifts, and at least one
already has: `CLAUDE.md`'s v3.29.0 row says 25, and the object declares 30.

| Refusal | Fires when |
|---|---|
| `bad-version` | not plain `X.Y.Z` — the `-beta` line was retired in v3.0.2 after 27 "previews" shipped straight to production |
| `wrong-branch` | not on `main` |
| `dirty-tree` | any modified or untracked file outside `package.json`, `package-lock.json`, `CLAUDE.md`, `CHANGELOG-ARCHIVE.md`, `CONTRIBUTING.md` — unfinished work must not be swept into a release commit |
| `behind-remote` / `diverged` | `origin/main` moved; a release must be a fast-forward |
| `version-not-forward` | the target is not greater than `package.json`'s current version |
| `tag-exists` | `vX.Y.Z` already exists locally or on `origin` — the script never moves or deletes a tag |
| `release-branch-exists` | `release/vX.Y.Z` already exists — an earlier attempt is open, quite possibly one whose CI went red. Fix it with a commit on top; a re-cut would hide it |
| `ci-not-reachable` | the workflow would not run on a release branch, so the gate would wait on a run that never starts |
| `changelog-row-missing` | `CLAUDE.md` has no FULL row for the version (an index line is a pointer, never the record) |
| `version-fields-disagree` | `package.json`, **both** `package-lock.json` fields and `CLAUDE.md`'s `**Version:**` line do not all read one version. Two starting states are accepted and nothing between them: all on the old version (the script bumps all three), or all on the target (someone pre-bumped). A half-bumped tree is what makes `npm test` go red mid-release for a reason that reads like a test failure. v3.24.1 found the lock six releases stale in both fields |
| `leanness-cap-exceeded` | more full changelog rows than `test-changelog-completeness.js`'s cap. At the cap it **warns** — *"the next release must archive first"* — rather than letting someone discover it mid-release |
| `suite-counts-stale` | `scripts/check-doc-suite-counts.js` fails. Correct the **doc** to the measured numbers; never do that arithmetic by hand and never edit `run-tests.js` to match the doc |
| `lock-diff-too-large` | the bump changed more of `package-lock.json` than the two version lines, i.e. npm re-resolved the tree. v3.24.1 hand-edited the lock for exactly this reason |
| `claude-rewrite-failed` | the `CLAUDE.md` version-line rewrite did not produce exactly a one-line change, or did not survive a read-back |
| `tests-failed` | `npm test` went red |
| `commit-message-refused` | the subject would be bounced by `.githooks/commit-msg` — reported up front rather than halfway through |
| `not-confirmed` | no `--yes` and not a TTY. An unattended script cannot release by omission |
| `branch-create-failed` | the release branch could not be created — nothing is committed |
| `remote-moved` | `origin/main` advanced **while CI ran**, so `main` can no longer fast-forward to the verified commit. Rebasing would produce a SHA CI never saw, which destroys the gate's guarantee — so it refuses and tells you to merge `origin/main` *into* the release branch and re-gate |
| `ff-failed` | the fast-forward refused, or reported success and landed on a different SHA than CI verified (the SHA is re-read, never assumed) |
| `push-failed` | a push was rejected. The remedy printed is `git pull --rebase` or a re-gate, never a force |

### What `release.js` will not do

- Never `git push --force`, never `--force-with-lease`, never a `+refspec`,
  never delete a tag, never delete any branch but a merged `release/vX.Y.Z`,
  never a merge that is not `--ff-only`, never `git reset --hard` your checkout.
  `assertSafeCommand()` refuses those argv shapes structurally, so no code path
  can construct one by accident, and the suite proves the check is *wired into*
  every command rather than merely present.
- Never `git add -A`. It names the release files explicitly.
- No flag makes a **failing** check pass. There is exactly one override,
  `--skip-tests`, and it is loud: a banner, a warning in the summary, and a
  permanent line in the annotated tag message saying the local gate was
  bypassed. Note it does **not** bypass the CI gate — nothing does.
- It does not write the changelog row. A generated one would be worthless.
- It does not publish the GitHub Release **itself** — the DMG workflow does,
  on the tag this script pushes. See *[How the installers get published](#how-the-installers-get-published)*
  below; the closing banner says so too, so a green run is never read as
  "the installers are out".

### How the installers get published

`release.js` finishes at the tag. **The installers are not out yet**, and the
gap between those two facts used to be silent and expensive.

`.github/workflows/desktop-dmg.yml` triggers on the `v*` tag push and does five
things, in this order:

1. Builds both DMGs on a macOS runner, with the version injected from the tag.
2. Runs `node scripts/publish-dmg-assets.js --dir desktop/dist --version <v>`,
   which **renames** them and then feeds the final names through the app's own
   `archFromAssetName()` — the imported function, not a copied regex — and
   fails the job if either name does not resolve to the architecture it claims.
3. Mounts each image and reads the real binary architecture with
   `lipo -archs`, failing if the contents disagree with the name.
4. Uploads the pair as a 14-day workflow artifact, as a fallback.
5. Creates the GitHub Release for that tag with both DMGs attached, marked
   latest. `--verify-tag` makes `gh` abort rather than create a tag.

**The rename is not cosmetic.** electron-builder writes
`The Curator-3.37.0-arm64.dmg` and — the dangerous one —
`The Curator-3.37.0.dmg` for x86_64, with no architecture in the name at all.
`archFromAssetName()` splits the stem on `-` and looks for a whole token
`arm64` or `x64`, so the raw x64 name resolves to **null** and a release
published unrenamed offers nothing to any Intel Mac. The published names are

```
TheCurator-<version>-arm64-AppleSilicon.dmg
TheCurator-<version>-x64-Intel.dmg
```

**Why this matters more than it looks.** The in-app updater resolves *the
newest release carrying an installer* from the Releases API. A tag with no
release is not a neutral state: every installed copy then reports **"You're up
to date"** while running the previous version. Between v3.31.0, when the
updater shipped, and v3.38.0, when this workflow started publishing, that is
exactly what happened — the DMGs were built and left in a workflow artifact,
and renaming and publishing them was a manual step nobody had written down.
`scripts/release.js` carried a comment saying a release workflow would be "an
unwired parameter"; that reasoning had expired six releases earlier.

Guarded by `scripts/test-release-publish.js` (the naming rule and the rename,
driven as real code) and `scripts/test-release-preconditions.js` §6b (the
closing banner). Neither runs a GitHub Action, so the publish path itself is
covered by structure, not by execution.

### When a release is bad

The gate catches anything `npm test` can see, so this is now the narrower case:
a defect CI cannot detect that reached `main` anyway.

**Rollback is forward-only.** There is no downgrade path and no second release
channel; clients pull `origin/main` and hard-reset to it. So the answer is
always another release, never an undo:

> **Corrected.** This paragraph previously read *"no release channel … and no
> `releaseChannel` setting"*. A `releaseChannel` key **does** exist as of
> v3.29.0 — `resolveReleaseChannel()` / `getReleaseRef()` in
> `src/brain/config.js`, surfaced on `GET /api/config` and as `channel` /
> `branch` on `GET /api/config/update-check`. What is true is that **`stable` is
> its only valid value**, anything else resolves to `stable`, and nothing writes
> it. A second channel is not a config edit: `install.sh` clones with
> `--depth 1`, which implies `--single-branch`, so on a real install
> `git fetch origin beta` **reports success** and the following
> `git reset --hard origin/beta` dies with `fatal: ambiguous argument` — the
> fetch succeeds and the reset kills the update. Measured; see
> [docs/desktop-app-decisions.md § D10](docs/desktop-app-decisions.md#d10--releasechannel-ships-with-stable-as-its-only-valid-value).

```bash
# 1. Revert the release commit. A NEW commit — never a force-push, and never
#    delete the tag. The bad release is history now.
git revert --no-edit <sha-of-the-bad-release>

# 2. Write a CLAUDE.md row for the patch release saying what was reverted and
#    why. The row is the only durable record of why a version was skipped.

# 3. Cut it — through the gate, like any other release.
node scripts/release.js <next-patch> --dry-run
node scripts/release.js <next-patch>
```

Users who already updated get the fix on their next update check — there is no
push. If the damage is in `domains/` rather than in code, the wiki is
git-tracked and a user with Personal Sync configured recovers with a git
client; there is no in-app revert and never has been (see CLAUDE.md's
semantic-duplicate note).

**If the gate went red instead**, nothing was deployed and there is nothing to
revert. Fix it with a commit on top of `release/vX.Y.Z`, push, and re-run — the
branch is deliberately left in place for exactly that.

### Branch protection — the recommendation

**Recommended: protect `main` against force-push and deletion only. Do not add
a required status check.**

Changing a repository setting is the maintainer's call, so nothing here has been
applied. The reasoning, including the case against:

- **The release-branch gate already provides what a required check would.**
  `main` only receives commits CI has validated, and the gate runs before the
  push rather than after it. A required status check would re-verify the same
  `offline` job on the same SHA, and cost a PR to do it.
- **A required check cannot gate a direct push.** A status check can only run
  after the commit exists somewhere, so requiring one on `main` forces a PR for
  every release — and the maintainer is the only reviewer. The alternative is an
  admin bypass, which makes the protection theatre.
- **The flake argument is weaker than it looks, and is stated here corrected.**
  `scripts/ci-flake.js` tolerates transient failures for **LIVE** suites, which
  are not part of the gate and could not be a PR check anyway. The offline
  suites are deterministic and the runner never retries them, so
  `offline`-as-required-check would not be flaky. The case against a required
  check rests on latency and ceremony, not flake.
- **Force-push and deletion are the genuinely irrecoverable mistakes, and
  blocking them costs nothing.** The maintainer never force-pushes `main`; but
  because the auto-updater hard-resets to `origin/main`, a force-push that
  rewrote history would propagate that rewritten history to every user machine.

**The trade-off, stated plainly:** the gate lives in a script, so someone can
still bypass it with a bare `git push` to `main`, and `--skip-tests` still skips
the *local* test run. What the gate buys is that the *default* path cannot ship
a commit CI has not validated; what the ruleset buys is that the *irreversible*
class is blocked server-side. Neither buys enforcement against a determined
operator, and the honest framing is that this is a solo maintainer protecting
himself from his own hurry, not a repo defending against a hostile committer.

If you agree, this is the whole change — one copy-paste:

```bash
gh api -X POST repos/talirezun/the-curator/rulesets --input - <<'JSON'
{
  "name": "main: no force-push, no deletion",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" }, { "type": "deletion" } ]
}
JSON

# Verify it took:
gh api repos/talirezun/the-curator/rulesets
```

Note this ruleset targets `refs/heads/main` only, so it does not touch
`release/*` branches — `release.js` still deletes a merged one, which is
intended.

No `bypass_actors` is set on purpose — including for admins. The point is to
guard against your own irreversible mistake, and deleting the ruleset takes ten
seconds if you ever genuinely need to force-push:

```bash
gh api repos/talirezun/the-curator/rulesets            # find the id
gh api -X DELETE repos/talirezun/the-curator/rulesets/<id>
```

**If you later decide you want the CI gate enforced server-side too**, add
`offline` as a required check and **explicitly exclude `Dependency audit
(advisory)`** — the workflow's own comment says so, and including it would make
a lagging advisory feed block releases:

```bash
gh api -X PUT repos/talirezun/the-curator/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["Offline tests (free)"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

`"enforce_admins": false` is what keeps direct pushes to `main` possible; with
it `true`, every release needs a PR. Be aware this interacts with the gate: a
required check on `main` means the fast-forward push must ALSO carry a green
check for that SHA, which it will, since the release branch's run is on the same
commit — but a `strict: true` ("branches must be up to date") setting adds a
second way for the same race `remote-moved` already covers to surface.

### Does any of this belong in CI instead?

The *checks* mostly already are in CI — `npm test` runs there on every push, and
with the gate, CI is now what actually decides whether `main` moves. The
*sequencing* cannot be: the release commit does not exist until after the
sequence has run, so something local has to create it. The natural end-state,
once `electron-updater` needs GitHub Releases, is that `release.js` keeps
creating the tag and a new `on: push: tags: 'v*'` workflow builds and publishes
the Release from it. That is a real next step, not a rewrite of this one.

---

## Project layout (quick map)

```
src/brain/    core logic — ingest, files (writePage), llm, chat, sync, health,
              compile, config, sharedbrain-*
src/routes/   Express route handlers (one file per /api/* group)
src/public/   vanilla-JS frontend (no build step)
mcp/          local read+write MCP server for Claude Desktop / IDEs
scripts/      battle tests (test-*.js) + maintenance scripts + run-tests.js
docs/         user + technical documentation
CLAUDE.md     the canonical, detailed development guide
```

See [CLAUDE.md](CLAUDE.md) for the full module reference, the ingest pipeline
walkthrough, known LLM-compliance failure modes, and active design decisions.
