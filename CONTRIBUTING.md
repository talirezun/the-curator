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

---

## Running the tests

The Curator has an extensive battle-test suite (25 suites, hundreds of
assertions). One command runs them all and prints a single pass/fail report:

```bash
npm test            # OFFLINE suites only — fast (~1.3s), free, no network,
                    # no API key. Run this before every commit.

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

---

## Continuous Integration (GitHub Actions)

Every push and pull request is checked automatically by
[.github/workflows/test.yml](.github/workflows/test.yml) on GitHub's servers.
Two jobs:

| Job | When it runs | API keys | Cost |
|-----|--------------|----------|------|
| **Offline tests** | every push (any branch) + every PR (incl. forks) | none | free |
| **Live API tests** | push to `main` + manual "Run workflow" only | `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` from repo Secrets | a few cents per run |

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
quality-threshold `test-ingest-deep`, the GitHub-repo-needing
`test-sharedbrain-github-live`, and the server-spawning
`test-sharedbrain-routes`). Those local-only suites still run in a full local
`npm run test:live`. A CI-safe live suite must not read a file outside the repo:
use a committed fixture (e.g. `docs/ingestion-pipeline.md` as a large source, or
`scripts/test-ingest-deep-inputs/`) rather than anything under `domains/`.

**Flakiness:** live tests call real providers, so a transient outage (e.g. a
Gemini HTTP 503 "overloaded") can make the live job go red even though the code
is fine. Just re-run the job from the **Actions** tab.

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

### Test domains-dir isolation (important when writing live tests)

Live suites must **never** touch the real `domains/` folder. Use the
`CURATOR_TEST_DOMAINS_DIR` env var (set it to a tempdir) — it beats
`.curator-config.json`'s `domainsPath`, works across a spawned child process, and
is read by `getDomainsDir()`. Do **not** use `process.env.DOMAINS_PATH` for
isolation: it *loses* to a configured `domainsPath`, so on a real install it
silently no-ops and the test writes into the user's actual wiki. (In-process
offline tests may instead use `__setDomainsDirOverride()` from `config.js`; both
are test-only seams checked before config and unset in production.)

---

## Adding a test

1. Create `scripts/test-<subsystem>.js`. Follow an existing suite's shape (a
   small `ok` / `fail` / `assert` harness + a printed `Passed: N  Failed: M`
   summary, and `process.exit(1)` on any failure).
2. **Add the filename to the `OFFLINE` or `LIVE` array in
   [scripts/run-tests.js](scripts/run-tests.js).** A suite not in either array
   is never run by the aggregator.
3. If the test needs to point the domains directory at a throwaway tempdir, use
   **`__setDomainsDirOverride(dir)` from `src/brain/config.js`** (and clear it
   with `__setDomainsDirOverride(null)` at cleanup). Do **not** set
   `process.env.DOMAINS_PATH` for this purpose — it loses to a configured
   `domainsPath` in `.curator-config.json` and silently no-ops on any real
   install (this exact trap broke four suites before v3.0.1-beta.21). The
   override is checked before config and is `null` in production.

Run `npm test` and confirm your suite shows up and passes.

---

## Cutting a release

The Curator releases by pushing to `main`; the in-app auto-updater pulls it via
`git fetch` + `git reset --hard origin/main` + `npm install` + a `.app` rebuild.

1. Make the change on a branch (or `main` for the maintainer's own flow).
2. `npm test` green. For anything touching the LLM/sync/GitHub paths, also run
   `npm run test:live` with keys present.
3. Bump `version` in [package.json](package.json) (e.g. `3.0.1-beta.N`).
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
