# Release index — one line per archived release

> The one-line index of every release whose full row lives in [CHANGELOG-ARCHIVE.md](../../CHANGELOG-ARCHIVE.md). Moved out of the auto-loaded `CLAUDE.md` on 2026-09-23 verbatim; `scripts/test-changelog-completeness.js` reads THIS table and proves it equals the archive's rows as a set. When a release archives a row out of `CLAUDE.md`, it adds that row's index line at the TOP of the table below, in the same change.

### Archived releases — one line each

Full rows: **[CHANGELOG-ARCHIVE.md](../../CHANGELOG-ARCHIVE.md)** (`grep` it for the
version string; each row is one long line, so `grep` returns the whole entry).
**This order is the archive's order, and it is not strictly chronological** — it
continues newest-first to `v3.0.7`, then an *ascending* block of early commit SHAs
and `v2.1.0`–`v2.4.1`, then a second descending block from `v3.0.6` to `v2.4.2`.

| Release | Headline (one line — the full row is in the archive) |
|---|---|
| `v3.72.3` | A docs-only release: the user guide, the LLM-facing memory doc and the continuity skill now explain scopes — how to organise work-streams across machines and agent tools, a standing gap since v3.65.1. |
| `v3.72.2` | A lone Handoffs row could not be opened — fixed by binding the whole row, not just its ~56px name button, in `bindWorkStreamRows` and the Documents table's `bindFoundationRows`. |
| `v3.72.1` | The "true numbers" release — every number and state the app shows traces to true current data, an app-wide read-only audit (7 slices, ~85 findings) fixed here package by package: Context, Domains, Ingest, Settings and Sync. |
| `v3.72.0` | Chat — the section left behind for several releases — is overhauled and synced with the rest of the app: one list across all domains, a real page header, row actions and citations, with every number it shows traced to true data. |
| `v3.71.1` | Every remaining ⓘ in the app now uses the v3.71.0 explainer model, through ONE implementation — cutting the words behind them by about half per view app-wide. |
| `v3.71.0` | One explainer model for every ⓘ — treatment B — starting with Context and the six places a beginner lands with none. |
| `v3.70.1` | The per-document planner for the context-window meter, deferred out of v3.70.0 — each read-first document now its own segment on the meter, and a "Documents at start" fold that previews start-state changes before Apply. |
| `v3.70.0` | The context-window meter becomes the control panel of project context — the maintainer's own "key element that makes this app truly useful": people pick their window size, and a bar to scale shows the harness (their own estimate, hatched), The Curator's share, and free space, with The Curator's part enlarged layer by layer in tokens. |
| `v3.69.0` | One project can now hold documents written here, copied from a folder, mirrored from a folder and mirrored from GitHub — up to 8 sources, any mix — the maintainer's own decision after v3.68.0 ("we definitely need an option so we can add sources from local and from GitHub"). Manifest version 2 is written only when version 1 cannot express the mix, with up to 8 source groups per project including several GitHub repositories. |
| `v3.68.1` | A forward-compatible foundations reader ships BEFORE v3.69.0's manifest version 2 (mixed per-document sources), by the maintainer's own decision (D1): a machine one version behind must never corrupt, or be told to remove, a manifest a newer app wrote. `readManifest`/`validateManifest` recognise an integer `version` above 1 and return a new code, `manifest-newer`, with every write and read path refusing with the file's bytes unchanged. |
| `v3.68.0` | Answers the maintainer's own gap report: a project couldn't mirror what was already on GitHub without first adding a local copy, couldn't add a second file once it held one, and had no multi-select. Context step ① gained two doors — Add from this computer and Add from GitHub — each opening a checklist panel with select-all and per-file size limits. |
| `v3.67.2` | The maintainer's own v3.67.1 test feedback (2026-09-24): one app-wide toast, honest copy about where agent instructions go, a false "not on this computer" note removed from Context, and the Context ⓘ that blinked on every auto-refresh. |
| `v3.67.1` | v3.67.0 reached `main` and got tagged although its own release-branch CI had failed — the release chain printed the run's conclusion but never gated on it. |
| `v3.67.0` | "The right context, not all of it" — the maintainer's own principle, and the release's governing rule for every screen and every doc sentence: at the start of a session an agent gets its foundations, the last state and the standing brief; everything else is on demand; the magic is just enough. |
| `v3.66.1` | The menubar widget gets its own depth bars, held out of v3.66.0 until the maintainer could photograph the real menu. |
| `v3.66.0` | "Visual channels everywhere" — the maintainer approved a five-channel reading system for the whole app and the widget: identity dot (WHICH DOMAIN), freshness dot (HOW RECENT, tier), clock + age (HOW RECENT, words), depth bar (SIZE/SHARE vs a NAMED denominator), and TONE, newly named as its own channel — outcome only, never text colour. Binding parity rule: no widget-only fact — anything the menubar widget can show, the app must show too, since Windows and Linux users have no widget. |
| `v3.65.3` | The maintainer's production feedback on v3.65.2 — he saved a real fine-grained token and Test succeeded against a real repository — landed as five findings, answered by `docfix` and `sb` off `main`, with an orchestrator screen review that sent `docfix` back once. |
| `v3.65.2` | The maintainer asked one question — "what token do I need?" — while trying to use v3.65.1's GitHub-mirror arm, and it exposed a false promise: the Documents panel said "Add a read-only token in Settings," and no Settings surface had ever written `githubReadToken`. |
| `v3.65.1` | The maintainer's first hour on v3.65.0's Context view: "five different styles fighting each other, no continuity, no logic." Domains was "more or less polished"; a diagram he called correctly designed became the acceptance picture for this release. |
| `v3.65.0` | The maintainer read v3.64.2 by screenshot and asked one question of five: how are these the same? An ⓘ panel stopped at two thirds of the column; Domains and Context wore two different sidebars, two different overview cards and two different "live-state" treatments; step ③ Knowledge had no way to choose which wiki a project draws on. |
| `v3.64.2` | The maintainer looked at two screenshots and asked one question — how are these the same? The domain page drew its readings as a grid of stat cards under an OVERVIEW eyebrow with an ⓘ; the Project-context page drew the same idea as a three-cell mono strip with a lone ⓘ pushed to the right. |
| `v3.64.1` | The maintainer's first hour on v3.64.0: a chat answer vanished when you left the view, the domain page flickered on every switch and its sections could not be told apart, the Compile button was clipped off the bar and the ⓘ opened somewhere else, the Foundations fold reopened itself, and the capture meter said "no session" beside a save from 47 minutes ago. |
| `v3.64.0` | The rail becomes three places — Chat · Domains · Context — Ingest and Shared Brain move onto the domain page as hosted sections, Chat reads a project's own context, the first real harness measurement lands in the table, and the app learns to see a bridge process still running last week's code. |
| `v3.63.0` | The memory layer stops being asserted and starts being measured: a usage log that knows which harness called, a CLI that reads and writes project context with no MCP client, a GitHub mirror arm for foundations, the instrument that will grade a harness's reach, and an honesty meter admitting nothing has been graded yet. |
| `v3.62.0` | The Context view — the third part of "the right context at the right time": Agent memory becomes Project context, five unnumbered blocks become three numbered steps, and a document can be flagged so an agent is handed it without asking. |
| `v3.61.1` | The maintainer's first hour on v3.61.0: the Foundations chooser was cramped, the Mirror arm could not be used without knowing the trick, a tick threw you to the top of a fifty-row list, and a mirrored document could neither be removed nor its age read. |
| `v3.61.0` | The start-a-project flow: a project chooses where its canonical documents live, existing documents finally have a way in, the owner can write one in the app, every MCP tool can be exercised from the bridge page, and first run opens with two doors — plus the day the app's second audience was named correctly. |
| `v3.60.0` | The MCP became observable: a content-free usage log, a map of all 24 tools on the bridge page, and the menubar widget marks stale foundations. |
| `v3.59.0` | The foundations tier: canonical documents that travel with a project, readable from any harness in one call — the third layer of context, and the piece the context machine was missing. |
| `v3.58.0` | A user's video review: numbered answers that all said "1.", no way to copy an answer, a Compile caption that counted wrong, a Memory page that scrolled for a mile, and two copy controls the maintainer himself could not explain — plus the one rule for headings, ledes and ⓘ the app had been missing. |
| `v3.57.1` | The in-app updater gave up on one transient GitHub error and blamed the user's internet. |
| `v3.57.0` | The app started moving like one piece: a view change got a leaving phase, the reader's slide-in played for the first time, the Domains page list stopped collapsing on every switch, and two server costs nobody had measured with real keys came out. |
| `v3.56.0` | The brief editor's "too long" wall was showing on an 8 KB draft, the work-stream table showed everything, and a handoff was a document printed on the page instead of something you open. |
| `v3.55.0` | The Agent memory page becomes the command dashboard it was meant to be, freshness gets one colour scale across the app, and Ingest and Shared Brain stop sitting in a pocket at the left of a wide column. |
| `v3.54.0` | Settings, Agent memory and the sidebars were four design generations on one screen; now every section is built from one block, every button from one family, the main column uses the window, and the app starts reading as mission control. |
| `v3.53.1` | The redesigned Providers & keys screen closed its own folds and rows while a test ran, said nothing when the test finished, and hid which rows can build. |
| `v3.53.0` | A merge that resolved its siblings kept offering them; a model OpenRouter withdrew stayed "offerable" forever; and the Providers & keys screen was a sea of words the maintainer could not read. |
| `v3.52.0` | Measured first, then built: the saving discipline goes into the file the harness cannot skip, and the app hands it out beside the marker line. |
| `v3.51.0` | The menubar menu was a quarter of the screen again: the display cap had quietly become the data-fetch limit, and two machine copies of one work-stream could fill a whole group. |
| `v3.50.0` | The Domains screen became four sections instead of one page that ran together, the wiki list stopped hiding pages past 150, and memory pages joined the wiki list. |
| `v3.49.1` | The badge went red on a real advisory this time, and the version bump alone would not have closed it. |
| `v3.49.0` | A power user's video review of the redesign: the rail got names, the app got a home, the wiki came out from under the health report, and a search box stopped impersonating the composer. |
| `v3.48.1` | The "New project" action floated below the card it belonged to, and the maintainer's first hour on v3.48.0 reorganised his own domain into projects. |
| `v3.48.0` | A domain can now hold many projects, each with its own standing brief — and assembling it found two adapters that were silently answering about the wrong project. |
| `v3.47.0` | A chosen file could not be un-chosen, and the eighth article joined the research series. |
| `v3.46.0` | Drag-and-drop onto Ingest had never worked in the Mac app, the primary button wore a hairline frame at rest, the README badge had been red for two releases, and a second Curator over the same folder went undetected — five fixes from the maintainer's first days on v3.45.0. |
| `v3.45.0` | The model picker became a page a first-time user can read top to bottom, the context floor moved to the number the app actually needs, and the cohort token step stopped killing cohorts. |
| `v3.44.0` | The app started looking like a Mac app: phase 1 of the native design upgrade, every figure recomputed from the shipped values, and four rendered defects found only by looking. |
| `v3.43.0` | Shared Brain was driven end to end by a human-shaped run for the first time, and a contributor erased the admin in two clicks. |
| `v3.42.0` | The menubar widget became the instrument it was meant to be, the updater got a face, a quarter of the model picker turned out to be dead rows, and the first photograph of the finished menu settled four things nobody could prove offline. |
| `v3.41.0` | The old shell is gone thirty releases after "2 to 3", and taking it out found that 29 of its guards had been certifying a page nobody was served. |
| `v3.40.0` | The cross-process write lock never excluded anything, the MCP graph cache could not invalidate, and the MCP save response still raised the false alarm v3.39.0 fixed everywhere else — the correctness half of a six-area review. |
| `v3.39.0` | A save that lost nothing was being reported as an incomplete handoff, and the foundational document this project never had finally exists. |
| `v3.38.1` | v3.38.0 shipped as a tag with no installers, because the build's own load probe refused twice and could not say why — it reported a stopwatch running out in the same words as a dyld refusal. |
| `v3.38.0` | The widget stopped being a list and became a widget — and the release found that the previous one had been judged in the worst configuration it has, for reasons… |
| `v3.37.0` | The menubar widget got the graphics it was asked for, the menu stopped being a quarter of the screen, and — for the first time in six surfaces — somebody actually LOOKED at it before it shipped. |
| `v3.36.0` | The maintainer chose Check for Updates from the menu bar and was sent to a web browser, while Settings installed the update in place — two update paths that disagreed, both looking deliberate. |
| `v3.35.0` | The menubar widget — and the documentation agent found three defects in it by RUNNING the code, one of which made the feature's whole reason for existing inert. |
| `v3.34.0` | Two defects the maintainer had been living inside without knowing, plus the memory layer finally telling the truth about its own clock. |
| `v3.33.0` | The Mac app updates itself, because the previous release's answer to "update" was to open a web page and the maintainer's verdict on it was one word: *"terrible." |
| `v3.32.0` | Connecting sync destroyed four hours of the maintainer's working state, and the destructive step was a guard being ROUTED AROUND BY ITS OWN ERROR HANDLER. |
| `v3.31.0` | The Mac app stops being a folder and becomes something a person can download, install and run — and the release found that its own signature was worse than no signature at all. |
| `v3.30.0` | The Mac app stops being a plan and becomes a folder — and two agents found real defects in files they did not own, one of them in the release gate shipped hours earlier. |
| `v3.29.0` | Pushing to main WAS the deploy, and CI was a report card that arrived afterwards. This release makes the gate real. |
| `v3.28.0` | This file was costing 58,125 tokens per session again, the docs had drifted across three releases, and the privacy consent was one migration away from being silently forgotten. |
| `v3.27.0` | The app acknowledges a click, and Compile stops spending money silently — the last two findings from the v3.24.2 audit, and both agents refused part of what they were told. |
| `v3.26.0` | Three of this release's findings were WRONG as written, and the corrections are worth more than the fixes. |
| `v3.25.0` | The text ramp had already collapsed to two levels, and the app had spent releases routing around the broken rung rather than fixing it. |
| `v3.24.2` | This file was spending a third of every session before anyone typed, and the fix was to MOVE history rather than edit it. |
| `v3.24.1` | v3.24.0's ingest-continuity feature worked, and it was unreachable unless you already had the right domain selected. |
| `v3.24.0` | Markdown tables render, the Sync tab stops advertising a feature that has no backend and never had one, an ingest you walked away from can still be found… |
| `v3.23.1` | The Agent memory screen showed four-hour-old state while a twelve-minute-old save sat on disk — and the orchestrator's diagnosis of why was WRONG in the… |
| `v3.23.0` | Chat streams, and the model's thinking becomes visible work — and the release that measured it found the DEFAULT chat style returning an EMPTY ANSWER… |
| `v3.22.0` | The floating text under every title is gone — the maintainer's most-repeated complaint, and the previous attempt failed for a reason worth recording. |
| `v3.21.0` | The chat wait becomes a designed state instead of a spinner — asked for five times before it was built. |
| `v3.20.0` | The release that stopped the app rendering a MEASUREMENT and an EXPLANATION in the same voice — and the root cause was structural, not editorial. |
| `v3.19.0` | The release a single screenshot produced — a chat that could not be stopped, a rate limit that waited three minutes in silence because a header was… |
| `v3.18.0` | The release a maintainer's own week of real use produced — and then end-to-end testing found four money and trust defects the offline suite could not see. |
| `v3.17.3` | The release the maintainer's own first hour of real use produced — two UI defects he found, and a documentation sweep that discovered a wrong cost… |
| `v3.17.2` | The hygiene pass that found the merge doing something no document predicted — -X theirs does not discard a file, it SPLICES one. |
| `v3.17.1` | Production acceptance of the memory layer — and the release's own honesty fields were being dropped by every layer above the store. |
| `v3.17.0` | The memory layer — your brain, then your team's brain, then your AGENTS' brain: a working-state store an agent in a new session, harness, model or… |
| `v3.16.1` | The measurements were all correct and none of them reached the user at the moment they were needed. |
| `v3.16.0` | The model list stops being a hand-typed three and becomes the catalogue, filtered — and the user can promote one into the build lane by measuring it on… |
| `v3.15.1` | A money path that was LIVE, not latent — plus a credential guard nobody had supplied, and a test assertion that could not fail. |
| `v3.15.0` | OpenRouter — a third provider, open-weight models from smaller labs, and the discovery that a fact and its ABSENCE had been collapsed into one value in… |
| `v3.14.0` | The polish pass that closes Gemini + Anthropic model choice: which model builds your wiki, what each answer cost, and a promotional warning that would… |
| `v3.13.2` | The chat told you which model you PICKED, not which model answered — and it had been dead data since the picker shipped. |
| `v3.13.1` | The documentation for model choice — and four comments that had started asserting the opposite of their own code within hours of being written. |
| `v3.13.0` | Model choice, end to end — and it can only offer what has been measured. |
| `v3.12.0` | The data layer for multi-model choice — where a model cannot reach a user until it has been MEASURED — plus the composer's box-in-a-box, whose cause… |
| `v3.11.0` | The app froze for 15 seconds behind one button, and the "nothing happens then suddenly something happens" complaint turned out to be the opposite of… |
| `v3.10.1` | Two hazards disarmed BEFORE the release that would arm them — and the discovery that nothing in the suite could tell a live, correctly-priced model… |
| `v3.10.0` | The app stopped feeling flat when you click through it — and the fix is an ADOPTION gap, not a design gap. |
| `v3.9.2` | An accessibility defect on the one path where it is invisible to everyone who does not need it — and a guard for it that was decorative until it was… |
| `v3.9.1` | A P0 that made the safety net itself dead on arrival, two data-integrity defects, and the discovery that the three most-protected features had guards… |
| `v3.9.0` | CUTOVER — / now serves the redesign, with /old as an escape hatch. |
| `v3.8.0` | First-run guidance for /next, the last parity gap closed, a CI flake diagnosed to its mechanism — and a FALSE RETRACTION of a real security finding,… |
| `v3.7.0` | PARITY RELEASE — the six capabilities /next was missing, so cutover cannot ship a version where users LOSE features. |
| `v3.6.2` | Four recorded follow-ups, and what hunting them found: a GDPR erasure the app could certify without performing, a privacy flag that asked a question it… |
| `v3.6.1` | Two destructive defects users could reach today, a cutover landmine defused two releases early, and a documentation pass that found eight false claims… |
| `v3.6.0` | /next Ingest + Shared Brain + credential wizard, and four production bugs the work surfaced. |
| `v3.5.1` | Four fixes from the maintainer using v3.5.0 in production, plus repo hygiene. |
| `v3.5.0` | Track 7 Part II — raw-source retrieval. |
| `v3.4.0` | Cancel now really cancels — 334 s → 63 ms, measured. |
| `v3.3.1` | Batch ingest UX — four defects found by the maintainer in the first ninety seconds of real use, none of which three audit rounds or two live provider… |
| `v3.3.0` | Track 3 — batch ingest queue. |
| `v3.2.0` | Redesign Phase 2 — four real views behind /next, plus a symlink escape that could DELETE files outside the wiki. |
| `v3.1.3` | Redesign groundwork: a parallel /next shell, plus the two backend gaps the new UI needs. |
| `v3.1.2` | Dependency security pass — 10 advisories → 0, plus the one the version bump would have hidden. |
| `v3.1.1` | Shared Brain: a dead delta path revived, the data-loss hole that revival opened closed, and the sharedbrain* relicense. |
| `v3.1.0` | Track 1 Foundation — every user-data path now resolves through one module. |
| `v3.0.17` | Ingest progress honesty + three silent-data-loss fixes, from live use of v3.0.16. |
| `v3.0.16` | Ingest prompt caching + two data-loss fixes + sync hygiene. |
| `v3.0.15` | Housekeeping + safety release — the first of Phase A "quick wins". |
| `v3.0.14` | Compile to Wiki no longer shrinks the chat into a "second window" (community-reported UI bug). |
| `v3.0.13` | Chat model selector now mirrors SAVED Settings keys, not .env (community-reported correctness bug). |
| `v3.0.12` | Chat composer visual polish (two user-reported CSS bugs on the v3.0.11 composer). |
| `v3.0.11` | Chat composer redesign — per-chat model selector + Length dropdown (Claude-style composer, Curator theme). |
| `v3.0.10` | Chat response-style ordering fix + Markdown rendering (two user-reported polish items on the v3.0.9 work). |
| `v3.0.9` | Chat response-style control — Concise / Balanced / Detailed (Tier 2 of the chat-quality work; the user-adjustable "sensitivity" feature). |
| `v3.0.8` | Chat gives a focused answer instead of dumping the whole domain (community-reported; Tier 1 of 2). |
| `v3.0.7` | Chat no longer hard-fails with a misleading ingest error on a long question (community-reported). |
| `7b54fa2` | normalizePath catches any non-canonical folder |
| `a998741` | EISDIR crash + entity title-prefix deduplication (Pass A) |
| `7f0213d` | Existing filenames injected into LLM prompt + deduplication at scale |
| `147d113` | Related dedup by link target + blank-line injection fix |
| `643d3c5` | stripBlanksInBulletSections runs on every write, not just merges |
| `8f77d33` | injectSummaryBacklinks() added — bidirectional backlinks for all entities |
| `c1b6567` | Hyphen-slug dedup Pass B + folder-prefix auto-cleanup + truncation warning |
| `b56b2d3` | Hyphen-normalised resolution in injectSummaryBacklinks (talirezun → tali-rezun) |
| `f4cb825` | syncSummaryEntities() + CLAUDE.md dev guide |
| `7589a15` | Step 5c: normalize [[variant]] links in page content at write time |
| `132b769` | deduplicateBulletSections() safety net + result.pages dedup for multi-phase |
| `b2fa124` | injectBulletsIntoSection creates missing section; multiline regex fix |
| `181157f` | Underscore → hyphen slug normalization in writePage() step 1a |
| `f9665b3` | Cross-folder dedup (3b), expanded step 5c (Pass C prefix-tolerant), backlinks cover concepts/, writePage returns canonPath, ingest uses canonical paths… |
| `1f11c25` | Settings tab, onboarding wizard, auto-update, stop/restart fix, .curator-config.json |
| `v2.1.0` | Remove Stop button + /api/shutdown; server runs until quit; update rebuilds .app; build-app.sh |
| `f80b2db` | Absolute node path in AppleScript — fixes "node: No such file or directory"; process.execPath in restart; CURATOR_NO_OPEN prevents double browser tabs |
| `c5eddef` | Auto-refresh UI state after ingest, sync, and tab switches — domain stats, wiki tab, and dropdowns update without manual browser reload |
| `v2.3.0` | My Curator MCP — local stdio MCP server exposes 10 tools to Claude Desktop (7 retrieval + 3 graph-native: graph_overview, tags, backlinks). |
| `v2.3.1` | MCP response-budget correction. |
| `v2.3.2` | Auto-updater made crash-resilient. |
| `v2.3.3` | "Restart needed" detection across the UI. |
| `v2.3.4` | Ghost-domain fix after sync-delete. |
| `v2.3.5` | Subprocess-PATH fix for auto-updater and sync. |
| `v2.3.6` | Updater partial-success recovery. |
| `v2.3.7` | Accurate sync file counts in UI. |
| `v2.3.8` | Onboarding fixes. (1) install.sh was calling bash start.sh on a file that was removed in commit 6b0889c ("app lifecycle redesign") — fresh installs… |
| `v2.3.9` | Wiki Health "Fix" for missing backlinks now actually writes. |
| `v2.4.0` | Model-lifecycle safety net. |
| `v2.4.1` | Anthropic default switched from claude-sonnet-4-6 to claude-haiku-4-5 — Anthropic's low-cost tier, matching the cost profile of Gemini's… |
| `v3.0.6` | Shared Brain production hardening — Phase 5 (production test program) + two REAL adapter bugs the live tests caught. |
| `v3.0.5` | Shared Brain production hardening — Phase 4 (admin features; plan in the private SHARED-BRAIN-UPGRADE.md). |
| `v3.0.4` | Shared Brain production hardening — Phase 3 (UI/UX upgrade; plan in the private SHARED-BRAIN-UPGRADE.md). |
| `v3.0.3` | Shared Brain production hardening — Phase 2 (data-integrity + trust boundary; plan in the private SHARED-BRAIN-UPGRADE.md). |
| `v3.0.2` | Shared Brain production hardening — Phase 1 of the upgrade plan (surgical bug fixes; full findings + plan in the private SHARED-BRAIN-UPGRADE.md). |
| `v3.0.1-beta.27` | Compile-to-Wiki safety net + compile-specific error (Fix #2 of 2 for the compile-hang report). |
| `v3.0.1-beta.26` | Live-API CI gate made useful — transient provider outages no longer red the build (CI infrastructure; no app-code change). |
| `v3.0.1-beta.25` | Compile-to-Wiki no longer hangs then fails with "Gemini hit the output token limit (65536 tokens)" on large domains (community-reported bug — Fix #1 of 2). |
| `v3.0.1-beta.24` | One-click provider toggle (Settings → API Keys) — switch the active AI provider without re-pasting or deleting a key (community-reported UX gap). |
| `v3.0.1-beta.23` | User-facing System Check panel (Settings) — free local diagnostics + opt-in AI connectivity test + a "health"-wording overhaul. |
| `v3.0.1-beta.22` | Semantic-duplicate scan reachable again on structurally-clean wikis (community-reported regression, NOT from beta.20/21). |
| `v3.0.1-beta.21` | Test aggregator (npm test) + a class of latent test-isolation bugs fixed (audit Tier B, part 1). |
| `v3.0.1-beta.20` | Tier A security + hygiene bundle (from an external GLM-5.2 code audit, verified claim-by-claim before acting). |
| `v3.0.1-beta.19` | Personal Sync robustness + documentation overhaul (from a real cross-machine setup failure on Windows). |
| `v3.0.1-beta.18` | Two Health-UX fixes from first real beta.17 use on the 1000+ broken-link articles domain. |
| `v3.0.1-beta.17` | Health section UX overhaul — unified AI Maintenance for large & shared brains. |
| `v3.0.1-beta.16` | Bulk AI broken-link fixer (Health tab). |
| `v3.0.1-beta.15` | Five-fix bundle from a second community bug report (Anthropic Haiku user). |
| `v3.0.1-beta.14` | Anthropic large-output fix — Compile-to-Wiki + single-pass ingest now work on Haiku (responding to a community bug report). |
| `v3.0.1-beta.13` | Chat retrieval — three-layer upgrade for enumerate queries. |
| `v3.0.1-beta.12` | Ingest-report UX + documentation polish. |
| `v3.0.1-beta.11` | Five-fix bundle responding to a deep community-member bug report. |
| `v3.0.1-beta.10` | Last-ingest-date display bug + actionable updater error classifier. |
| `v3.0.1-beta.9` | In-depth ingest stress test + three pipeline quality fixes + new technical doc. |
| `v3.0.1-beta.8` | Concurrency safety + granularity-inversion fix + LLM truncation detection. |
| `v3.0.1-beta.7` | Phase 1 outline retry + actionable error message on JSON parse failure. |
| `v3.0.1-beta.6` | Accurate per-direction sync file counts. |
| `v3.0.1-beta.5` | Pending-sync badge in the navbar. |
| `v3.0.1-beta.4` | Clearer Curator-vs-upstream error messages. |
| `v3.0.1-beta.3` | Health hyphen-variant scanner hotfix — completes the v3.0.1-beta.2 work. |
| `v3.0.1-beta.2` | Honorific-with-period dedup hotfix. |
| `v3.0.1-beta.1` | Ingestion accuracy fixes (responding to community feedback). |
| `v3.0.0-beta.1` | Shared Brain — Phase 4 (USER-FACING beta). |
| `v2.8.0` | Shared Brain — Phase 3 infrastructure (NOT user-facing). |
| `v2.7.1` | Auto-update restart hotfix. |
| `v2.7.0` | Shared Brain — Phase 2 infrastructure (NOT user-facing). |
| Phase 1 ✅ | Shared Brain — Open Questions resolved. |
| `v2.6.0` | Sync tab UX redesign — Phase 0 of Shared Brain rollout. |
| `v2.5.8` | Skill upload hotfix — strip XML-shaped placeholder from description. |
| `v2.5.7` | My Curator Claude skill — packaged playbook for the MCP. |
| `v2.5.6` | Documentation consolidation. |
| `v2.5.5` | MCP compile_to_wiki link grounding. |
| `v2.5.4` | MCP serverInfo title. |
| `v2.5.3` | MCP stdout pollution hotfix. |
| `v2.5.2` | MCP write tools — read+write surface for Claude Desktop. |
| `v2.5.1` | Health dismissal persistence. |
| `v2.5.0` | Conversation Compounding (Stage 1). |
| `v2.4.5` | Phase 3 of AI Wiki Health — semantic near-duplicate detection. |
| `v2.4.4` | Phase 2 of AI Wiki Health — ✨ Ask AI button on orphan rows. |
| `v2.4.3` | Phase 1 of AI Wiki Health — ✨ Ask AI button on review-only broken-link rows. |
| `v2.4.2` | API-key UX: last-saved-wins + per-field Disconnect. |
