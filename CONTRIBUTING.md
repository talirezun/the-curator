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

The Curator has an extensive battle-test suite (112 suites total — 95 OFFLINE
+ 14 LIVE_CI + 3 LIVE_LOCAL — thousands of assertions). One command runs them
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
`test-frontend-null-safety.js` (**63 assertions**) is a dependency-free
scanner that verifies
every top-level-equivalent `getElementById`/`querySelector` dereference in
`app.js` is `?.`-guarded or provably narrowed; see
[§ Writing a good test](#writing-a-good-test) below for the design lesson it
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

`test-ingest-queue-frontend.js` (**225 offline assertions**) covers the
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

`test-raw-source-ui.js` (**59 offline assertions**) covers the pure
`describeRawSource()`/`renderWikiSourceHtml()` functions in `src/public/app.js`
extracted via the same `new Function` pattern as `test-chat-compile-card.js`
and the batch-queue frontend suites — every backend `reason` maps to the
right UI state, an unrecognised reason degrades to rendering nothing rather
than something confidently wrong, the `external-source` URL renders as inert
escaped text (never a link, never fetched, and the request is gated to
`summaries/` paths so it never fires on every entity/concept page open), and
`app.js` never references `absPath` — the server never sends one for the
client to leak.

**A new OFFLINE suite is deliberately temporary and must be deleted, not
adapted, once its reason for existing is gone.** `src/public/next/**` is a
parallel redesign frontend served at `/next` (see
[docs/architecture.md § The redesigned shell](docs/architecture.md#the-redesigned-shell-srcpublicnext--the-primary-frontend-since-v390)
for what it is and why it exists) that will eventually replace
`src/public/app.js` outright. In the meantime,
`src/public/next/shared/ingest-queue-logic.js` holds 13 pure batch-ingest
helper functions copied byte-identically from `app.js`, because a batch-queue
bug fixed only in the shipping app would otherwise silently re-ship to
`/next` at cutover. `test-next-ingest-logic-drift.js` (**OFFLINE**) enforces
that byte-identity: it does not run or evaluate the functions, it extracts
each one's source text from both files with a plain regex and string-compares
it — a behavioral test can pass while two copies diverge in a way that only
matters for an untested input; a source comparison cannot miss any textual
difference. It also independently scans `ingest-queue-logic.js`'s own
top-level declarations and checks the set matches a hardcoded name list
exactly, so a 14th helper added without updating that list also fails.
**When `/next` becomes `/` and `app.js` is deleted at cutover, this test's
own header instructs deleting the file and its `OFFLINE` entry in
[scripts/run-tests.js](scripts/run-tests.js) — never repointing it at some
other pair of files or turning it into a coverage test for the survivor.**
The comparison it performs is meaningless once there is only one copy left.

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
benchmarks like `test-beta13-chat-live` and `test-ingest-real-llm`, and the
quality-threshold `test-ingest-deep`). Those local-only suites still run in a
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

The Curator releases by pushing to `main`; the in-app auto-updater pulls it via
`git fetch` + `git reset --hard origin/main` + `npm install` + a `.app` rebuild.

1. Make the change on a branch (or `main` for the maintainer's own flow).
2. `npm test` green. For anything touching the LLM/sync/GitHub paths, also run
   `npm run test:live` with keys present.
3. Bump `version` in [package.json](package.json). Plain semver, PATCH for a normal release (e.g. `3.0.15` → `3.0.16`), MINOR for a feature milestone — no `-beta` pre-release suffixes (see CLAUDE.md's "Versioning policy" note).
4. Add a release entry to the history table in [CLAUDE.md](CLAUDE.md) and update
   the `**Version:**` line at the bottom. Keep the entry specific — what
   changed, why, the blast radius, and how it was verified.
5. Commit (end the message with the `Co-Authored-By` trailer if AI-assisted),
   then push to `main`.

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
