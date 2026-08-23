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

The Curator has an extensive battle-test suite (50 suites total — 33 OFFLINE
+ 14 LIVE_CI + 3 LIVE_LOCAL — thousands of assertions). One command runs them
all and prints a single pass/fail report:

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
| `CURATOR_TEST_DOMAINS_DIR` (env) / `__setDomainsDirOverride()` (`config.js`, in-process) | `domains/` only | `.curator-config.json`, `.sync-config.json` (your real GitHub PAT), `.sharedbrain-config.json`, `.knowledge-git/` |
| `CURATOR_TEST_USER_DATA_DIR` (env) / `__setUserDataDirOverride()` (`src/brain/paths.js`, in-process) | All of the above, unconditionally — **plus** `domains/`, unless something higher in `getDomainsDir()`'s own precedence chain overrides it (a `DOMAINS_PATH` env var, or `--domains-path` for the MCP) | Nothing, when used alone and nothing else is set |

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
