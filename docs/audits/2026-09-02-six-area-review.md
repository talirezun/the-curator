# Curator September Review

**Date:** 2026-09-02
**Version reviewed:** v3.39.0 (main `755a9b5`)
**Scope:** Seven read-only audits of The Curator, folded into one proposal. Every code claim marked
**verified** was re-checked against the file by the orchestrator; the rest is the auditing agent's
reading, cited by file and line so you can check it too.

**Snapshot at review time:** main `755a9b5` · v3.39.0 · `npm test` 160 / 160 green · tree clean ·
nothing edited by the review itself.

---

## Verdict in one screen

| Area | Headline number | Reading |
|---|---|---|
| Correctness | 3 | Verified defects that can lose or mislead: a cross-process lock that does not exclude, an MCP graph cache whose invalidation cannot run, and an MCP save response that still raises the false "content lost" alarm v3.39.0 fixed elsewhere. |
| Public-repo hygiene | 0 secrets | None in the tree, none in history, private plans all ignored. One real finding: the maintainer's own hostname and install-id fragment in about 13 public files. |
| Documentation | 0 / 781 broken links | Four stale claims. The gap is teachability: a 3,892-line user guide with no ten-minute path, and the memory-layer doc has no diagrams. |
| UI | 1.03 : 1 | Sidebar-to-content contrast, both themes. Token discipline is excellent; what is missing is macOS chrome: title bar, materials, focus ring, switches, sheets, shortcuts. |

**Overall:** the engineering is more disciplined than most projects this size, and the audits say so
explicitly. The work ahead is mostly polish and adoption, plus a short list of correctness fixes
that should ship first because the app auto-updates real machines.

---

## 1 · Framework audit

Twenty-four findings. The ones below change what a user experiences or what a contributor can
trust. The full table stays with the agent report; ask for it if you want every P3.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| P0 (verified) | `src/brain/write-registry.js:193` | The cross-process lock is `existsSync` then an atomic rename. Two processes both see no lock, both write, both get a token; the catch arm claiming to handle the race is unreachable because rename never fails on an existing target. MCP compile and web ingest can interleave on one domain and `writePage` is read-merge-write. | Open the lock with `'wx'`; correct the docblock and `architecture.md:2056`. | S |
| P1 (verified) | `mcp/graph.js:21` | The TTL early return fires before files are listed, so the file-count invalidation never runs for ten minutes. No write tool invalidates. After an MCP compile, reads serve a stale graph. CLAUDE.md's claim that an ingest forces a rebuild is false. | Always list; export `invalidateGraph(domain)` and call it from compile and health tools. | S |
| P1 | `src/brain/chat.js:1024` | Every chat turn reads every wiki file in full (3,418 files on `articles`) before retrieval narrows to 60 KB. | One cached page-index module keyed on file count and max mtime; also the natural home for the duplicated frontmatter parser. | M |
| P1 (verified) | `scripts/run-tests.js` | `test-next-asset-paths.js` exists, passes, and is registered in no array. The manifest is hand-typed and unchecked. | Enumerate `scripts/test-*.js` from disk and fail on any file in neither list. | S |
| P1 (verified) | `scripts/test-beta8-stress.js:566` | The only suite that writes into the real domains folder with no isolation seam. It is offline, and a timeout kill would leave a git-tracked write behind. | `__setDomainsDirOverride()`. | S |
| P2 | `src/brain/sync.js:192` | The last shell-string subprocess in the tree: `exec` with the domains path and a user-typed repo URL interpolated inside quotes; the PAT is on the command line. | `execFile('git', argv)`. | M |
| P2 | `src/brain/logger.js` | Five logger calls against 170 console writes and 249 empty catches. In the packaged app, console output goes nowhere a user can reach, so the advertised log file captures almost nothing. | Route brain and route diagnostics through the logger. | M |
| P2 | `src/public/app.js` | The pre-cutover shell: 8,445 lines, 386 KB, served on every install thirty releases after "2 to 3 releases", with about twenty suites still scanning it as text. | Retire `/old`. | M |
| P2 | `package.json` | Zero dev dependencies by rule, so no linter over ~95k lines. The stated reason (the updater runs `npm install`) is already solved by `--omit=dev`, which the DMG workflow uses. Also: 0.x SDK carets that can never update, no `engines`, CI on Node 22 only while docs claim 18+. | Add `--omit=dev` to the update path, then ESLint; add `engines` and Dependabot. | M |
| P2 | `src/brain/llm.js` · `src/routes/config.js` | 5,036 and 3,617 lines. A model catalogue table inside a network client; an update engine inside a settings router. | Split into catalogue, catalogue store, and a config-update router. | L |
| P3 (verified) | `mcp/tools/index.js:82` | Cap is 400 KB; three model-read strings say "1 MB limit". | Interpolate the constant. | S |
| P3 | `mcp/storage/local.js:115` | Path guard is lexical only, no realpath or lstat. Same shape as the v3.2.0 critical in health.js, which was fixed there and not here. | Reuse `resolveInsideWiki`. | S |

**What the audit says to leave alone.** The health.js path-scanner enforcement, the synchronous
ingest-queue claim, the deliberate no-lock in working-state, the MCP write caps, the deep pdf-parse
import, and the trailing-default test seams. None of these should be "simplified".

---

## 2 · Feature recommendations

The strategist's read: layer 3, portable agent state, is the only thing here nobody else ships,
and it is the layer with the weakest activation story. So switch it on first, then widen capture,
then make bad writes fixable.

| Rank | Feature | Why, in one line | Effort |
|---|---|---|---|
| 1 | One-command activation (`npx curator init` or a Homebrew formula) | Every piece exists (launcher, config generation, skill build, brief template); none of it is one action. | S |
| 2 | Opt-in save hook on context compaction, via a `curator save` CLI | The recorded "no hooks" reason was reach, not safety; the near-empty-save guard already covers the hazard. Default off, silent on failure. | S/M |
| 3 | Decisions carried on journal lines plus a derived cross-scope registry | Decisions are the field that measurably binds a model and the one most easily lost on overwrite. Derived, never stored, so it cannot rot. | M |
| 4 | Browser clipper that extracts in the browser and posts text to localhost | Keeps the server-side URL-fetch refusal (SSRF) while opening the capture path most reading actually uses. | M |
| 5 | Source ledger and re-compile a source on a better model | Answers compilation's one real criticism. Needs 6 first, or pages get fatter rather than better. | M |
| 6 | Page-level provenance frontmatter (sources, updated, model) | Cheap; unlocks 5, staleness checks and per-claim citations. | S |
| 7 | First-run, dismissible offer when a project first accumulates state | Discovery today is one Settings toggle. | S |
| 8 | Index-rot and staleness checks in Health | Deterministic, free, zero-model; the scan already has five such checks. | S |
| 9–11 | Cross-domain chat · Curate mode (skip Dictate) · opt-in automatic push only | All three rest on primitives that already exist and touch no firm decision. | M |
| 12–14 | Contributor onboarding for cohorts · S3 backend with offline licence · a public working-state spec | The commercial track, after a real cohort pilot. The spec costs a weekend and only pays if adopted. | M–L |

Explicitly not recommended: embeddings, automatic pull, an app write path to state, on-disk
cross-domain links, a stored roll-up page, a hosted tier, bundled OCR, blocking save enforcement,
the menubar popover panel.

---

## 3 · Native macOS UI

Measured live on the running app at 1280×860 in both themes. The good news is structural: eleven
stylesheets resolve every colour through tokens, native chrome is already purged, light and dark
are at parity, and the motion vocabulary is right. What reads as "web app" is the chrome around it.

| # | Where | Measured now | Native pattern | Layer |
|---|---|---|---|---|
| 1 | `desktop/main.js:1463` | Default title bar; zero `-webkit-app-region` rules anywhere, which is why `hiddenInset` was reverted in v3.30.0. | Drag strip and 40px rail inset in CSS first, then flip to `hiddenInset`. This is the single biggest native signal. | Electron + CSS · L |
| 2 | `main.js:1464`, `shell.css` | No vibrancy; launch background `#12121a` matches neither theme; sidebar vs content 1.03:1, and in light the sidebar is lighter than content. | `vibrancy: 'sidebar'`, transparent sidebar column, sidebar as the recessed plane. | Electron + CSS · M |
| 3 | `main.js:248` | `themeSource` pinned dark, so the light theme ships a dark title bar. | Theme-color meta written by `applyTheme()`, `themeSource = 'system'`. | Electron + JS · S |
| 4 | `tokens/shape.css:24` | Global focus ring measures 1.28:1 dark and 1.25:1 light against a 3:1 floor. | Solid accent at 55% with a 1px inner separator: 3.4 to 3.6:1. | CSS · S |
| 5 | `views/chat.css` | 662 monospace elements vs 284 sans in the chat column. It reads as a terminal. | Mono only for code and raw source; citation chips in SF with a leading glyph. | CSS + JS · M |
| 6 | app-wide | Only two `tabular-nums` sites; the largest numerals (domain stats) have none. | Tabular numerals on every metric, age, cost and clock. | CSS · S |
| 7 | `views/settings.css` | Stacked web-form flow, label above control, no container. | System Settings inset grouped list: 10px radius groups, label left, control right, inset hairline separators. | CSS + JS · M |
| 8 | app-wide | No switch control; on/off settings use segmented pairs. | An NSSwitch-style 38×22 toggle for Menu bar, Shared Brain enable, privacy flags. | CSS + JS · M |
| 9–10 | tokens | No hairline (1px everywhere on 2× displays); elevation is border-only, shadows unused. | 0.5px hairline token under 2dppx; cards and popovers get a real shadow. | CSS · S |
| 11 | five modals | All centred dialogs. Onboarding, MCP wizard and Shared Brain wizard are flows. | Sheets that slide from under the title bar on Apple's sheet curve; centred dialogs only for confirms. | CSS + JS · M |
| 12–13 | `listbox.css`, `motion.css` | Menus have no material blur, selection is a tint; two keyframes have zero consumers, every load state is the word "Loading…". | Blur-and-saturate menu material with a filled selected row; skeleton rows for lists. | CSS + JS · S/M |
| 14 | `desktop/lib/menu.js` | Keyboard surface is Cmd-, and Escape. | Cmd-1 through Cmd-7 views, Cmd-N per view, Cmd-F search, Cmd-K palette over views and domains. | Electron + JS · M |
| 15 | chat | 120 interactive elements under 28px in Chat alone. | Keep the glyph, give it a 28px hit box. | CSS · S |
| 16–17 | `main.js:46`, type ramp | macOS accent colour ignored; five type sizes crammed between 10 and 12.3px then a jump from 14 to 27. | System accent drives selection and focus only, violet stays the brand; collapse to SF's ramp and add a 17px section rung. | Electron + CSS · M |

**Three quick wins** (about two hours total): fix the focus-ring token; add material blur to menus
and a gradient fade plus shadow to the composer; tabular numerals plus making the sidebar the
recessed plane. The agent report carries the full token block, a control kit with exact CSS, and
the Electron window options.

---

## 4 · Skills

Both descriptions are uploader-safe and the five continuity caps match the code. The gaps are
things an agent following the skill will still get wrong, plus one code defect the skill
faithfully documents.

| Sev | Skill | Gap | Change |
|---|---|---|---|
| code (verified) | MCP save response | `mcp/tools/working-state.js:416` keeps its own regex and never calls `classifySaveNotes`, so a clipped headline still returns "DROPPED, OMITTED or TRUNCATED, re-save what matters". Six of eight headlines clipped yesterday; that is a wasted full re-save on most real saves. | Import the store's classifier; give `clipped` its own sentence. |
| P1 | my-curator | Compile caps appear nowhere: 10 pages including the summary, 50 KB per page, title 200, summary 60k chars. Atomic decomposition routinely exceeds nine pages, and splitting across two calls with one title creates two summary pages. | State the caps and the split rule in §5. |
| P1 | my-curator §2 | Teaches dotted slugs (`express.js`) that the create regex refuses. | "Readable, not creatable." |
| P2 | my-curator | Reserved `index`/`log`/`CLAUDE.md` and the `file_lock` conflict (correct response: wait and retry) are unmentioned; example 5 files a concept under entities. | Add a Don't; fix the example. |
| P2 | continuity | `scope_not_found` plus `did_you_mean`, `journal_limit`, the 80-char harness/model cap, the 60/50/20 index caps and the 32 KB brief cap are all undocumented. | Short additions to §2, §6, §8. |
| P2 | continuity description | Missing "compact", "wrap up", "pick up where we left off", and an apply-unprompted clause for the two moments with no user utterance. | Replacement description drafted (994 chars, uploader-safe). |
| P3 | both | 38 KB and 47 KB loaded whole on every activation. | Progressive disclosure: move brief-authority detail, per-field examples and Shared Brain sub-sections to on-demand files. Roughly 21 KB and 26 KB after; about 9,500 tokens saved per pair of activations. |

Also in code: the over-10-pages refusal gives no recovery path; `fix_wiki_issue.type` has no
schema enum; `build.mjs` only cross-checks tools for my-curator; the skills README size table is
stale by 10 KB. Any skill change is inert until both skills are re-uploaded by hand.

---

## 5 · Documentation

The corpus is unusually accurate: 781 relative links, zero broken; the tool count, mutator count,
default models, ingest cap, tray rows and gitignore rules all match the code. What it is not yet
is teachable at first contact.

### Stale claims (all small)

- `docs/user-guide.md:447` and `:1800` say "Settings → API Keys"; the section is Providers & keys.
- `docs/README.md:98` says "Settings → System Check"; the path is Settings → General → System check.
- `docs/product-overview.md` is dated v3.38.1; the app is 3.39.0.

### Teachability scorecard

| Doc | Lines | Diagrams | Screens | Numbered steps | Prose walls |
|---|---|---|---|---|---|
| user-guide.md | 3,892 | 14 | 5 | 156 | 3 (one is 73 lines) |
| working-state.md | 898 | 0 | 0 | 0 | 10 |
| mcp-user-guide.md | 628 | 0 | 0 | 22 | 0 |
| sync.md | 446 | 0 | 0 | 34 | 0 |
| shared-brain-user-guide.md | 388 | 0 | 0 | 29 | 0 |
| mac-app.md | 505 | 1 | 0 | 20 | 1 |

### Proposed reorganisation

- Add "Your first 10 minutes" at the top of the user guide, six numbered steps ending at a first
  ingest, with screenshots of the Gatekeeper dialog, the Getting started panel and the MCP wizard.
- Split the user guide into getting-started, using-the-curator, settings-and-models and
  troubleshooting, keeping `user-guide.md` as a routing index so no inbound link breaks.
- Diagrams: the three tiers and the state path for the memory layer; push, pull and the `-X theirs`
  merge for sync; the stdio bridge topology for MCP; contributor → push → synthesis → mirror for
  Shared Brain.
- Rename `working-state.md` to `agent-memory.md`, matching the label the UI and menu bar use.
- Archive `docs/audits/` (three unindexed reports, 35 releases stale) and the two design-system
  patch notes; decide whether `shared-brain-monetization.md` belongs in a public repo.

---

## 6 · README

- **The demo GIF is from 18 April;** the redesign landed 25 August. It shows the old interface. It
  is also 11.9 MB, the largest tracked file.
- No visual above the fold: logo, badges, then text. Proposed: a light/dark hero screenshot
  directly under the badges, the new demo lower.
- The Mac install block is 84 lines; keep the download table and the three-step Open Anyway
  sequence, move the rest to `docs/mac-app.md`.
- Two overlapping licence sections; merge.
- Badges: switch the version badge to GitHub Releases, add DMG build status, downloads, last
  commit, open issues, platform and MCP-ready. Only `test.yml` and `desktop-dmg.yml` exist, so
  only those two workflow badges are valid.
- No issue templates, no SECURITY.md, no Discussions link, no changelog or roadmap link;
  `package.json` has no `engines` field.
- Keep the three-layer headline but put a plain-English sentence above it. Suggested About line:
  "Local, privacy-first knowledge wiki + agent memory — plain markdown, your own GitHub repo,
  MCP-ready."
- Video: a 20–30 second storyboard (ingest → Obsidian graph → cited chat → agent memory), encoded
  with gifski under 8 MB, or an MP4 attached through GitHub. Interim: screenshot now, video later.

---

## Proposed release plan

Ordered by risk to real machines first, then visibility per hour, then the largest surface. Each
release is one session of parallel worktree-isolated agents with the changelog row and docs in the
same commit.

**v3.40.0 — Truth and locks**
- Real cross-process lock (`'wx'`); MCP graph invalidation; MCP save response gets the `clipped`
  verdict; 400 KB wording; test manifest enumerated from disk; beta8 isolation; realpath in the
  MCP storage guard.
- Hostname scrub across the 13 files; the three stale doc paths; product-overview version stamp;
  MCP wizard two-installations copy (owed from yesterday).
- Both skills corrected and restructured, with the new descriptions. Re-upload afterwards.
- Archive the v3.35.0 changelog row first (ratchet is at 6 of 6).

**v3.41.0 — Front door**
- README restructure, badge block, hero screenshot pair from a synthetic demo domain, Community
  section, issue templates, SECURITY.md, `engines`.
- User guide split with the ten-minute path and three setup screenshots; the four missing
  diagrams; docs archive move; agent-memory rename with redirects.

**v3.42.0 — Mac chrome, phase 1**
- Focus ring, hairlines, shadows, materials on menus and composer, tabular numerals, sidebar as
  recessed plane, 8pt grid snap, 28px hit targets, mono-to-sans in chat, type ramp.
- CSS drag region and rail inset landed and verified before the title bar is touched.

**v3.43.0 — Mac chrome, phase 2**
- `hiddenInset`, sidebar vibrancy, system theme source, system accent for selection and focus,
  switches, inset grouped Settings, sheets for the three wizards, skeleton loading, Cmd shortcuts
  and a View menu.

**v3.44.0 — The memory layer switches itself on**
- One-command activation, the opt-in compaction save hook, the first-run offer, the public
  working-state spec. Then provenance, index rot and the clipper in the release after.

Deliberately deferred to their own later releases: retiring `/old`, splitting llm.js and
config.js, the page-index cache, ESLint. Each is a large diff with its own verification story.

---

## Decisions taken

- **Sequence approved** — correctness and locks first, then the front door, then UI in two
  phases, then features.
- **Hostname scrubbed everywhere**, including `CHANGELOG-ARCHIVE.md` — no carve-out for the
  byte-for-byte archive; personal data does not get an exemption from that rule.
- **`shared-brain-monetization.md` stays public** — it is linked from the use-cases documentation
  on purpose, as a way to attract users.
- **The three old audit files are replaced by this one** — `docs/audits/2026-04-14.md`,
  `2026-04-20.md` and `2026-04-21.md` (35 releases stale, never indexed from `docs/README.md`)
  are removed; this review is the current audit of record.
- **`/old` is retired in the following release**, not this one — it is a large diff with its own
  verification story and does not belong in the correctness-and-locks release.
- **The zero-dev-dependencies rule is to be lifted**, with `--omit=dev` added to the update path
  first so the updater's `npm install` stays clean, opening the door to ESLint.
- **Skills restructured** — both `my-curator` and `curator-continuity` get the progressive-
  disclosure split and the corrected descriptions from §4, to be re-uploaded by hand afterwards.
