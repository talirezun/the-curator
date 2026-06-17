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
