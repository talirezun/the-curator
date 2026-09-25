# The Curator — installing and using the app

## What do I need before I install it?

| Requirement | Detail |
|---|---|
| Computer | macOS, Windows or Linux. The packaged Mac app is macOS only. |
| AI provider key | One key from Google Gemini, Anthropic Claude or OpenRouter. Nothing works without one. |
| Node.js 18 or later | Not needed for the Mac app, which bundles its own. Needed for the browser install; the one-command installer puts it in for you on a Mac. |
| Obsidian | Optional, free, for the visual graph: https://obsidian.md |
| git | Needed for Personal Sync and for updating a browser install. |

There are two ways to run The Curator and they are the same program, one codebase and one release. The **Mac app** is a window around the same local server the **browser install** runs, so every screen looks the same in both. Four things differ: how it launches, how it updates, where its data lives by default, and how it starts the MCP bridge.

## How do I install the Mac app?

1. Open the Releases page: https://github.com/talirezun/the-curator/releases
2. Download the `.dmg` that matches your Mac. `TheCurator-<version>-arm64-AppleSilicon.dmg` for M1 and later, `TheCurator-<version>-x64-Intel.dmg` for Intel. Each is about 140 MB, because the app carries its own runtime.
3. Open the `.dmg` and drag **The Curator** into **Applications**. The disk image includes an Applications shortcut for this.
4. Open it. macOS will refuse the first launch — see the next question.

The app needs no Node.js and no Terminal. Its data lives in `~/Library/Application Support/The Curator/`, and its log in `~/Library/Logs/The Curator/curator.log`.

You only need the Releases page for the first install. After that the app updates itself.

The Intel build comes out of the same automated build but has never been run on Intel hardware, because there is no Intel Mac to run it on.

## Why does macOS say the app is blocked or damaged?

The app is ad-hoc signed: its contents are sealed, so macOS can tell it has not been tampered with, but there is no Apple certificate behind that seal and it is not notarized, so macOS cannot tell you who built it. An Apple Developer enrolment is in progress. Until that completes, macOS refuses the first launch. You allow it once.

| Step | What to do |
|---|---|
| 1 | Open the app. macOS says it cannot verify the developer. Click **Done**. |
| 2 | Go to **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the message about The Curator. |
| 3 | Confirm. It opens normally from then on. |

Do not leave a long gap between steps 1 and 2 — the **Open Anyway** button only appears for a while after a blocked launch. On macOS Ventura and Sonoma, 13 and 14, right-click → **Open** → **Open** still works; on Sequoia, 15, and later it does not.

These steps are what the app's signature state should produce (Apple's own `syspolicy_check` reports notarization as the only remaining problem), but nobody has yet launched a quarantined copy of a current build to watch which dialog macOS actually shows. If you see something different, report it on GitHub.

If macOS instead says the app **"is damaged and can't be opened"** and offers no **Open Anyway** at all, you have a build from v3.30.0 or earlier. Those shipped with a broken signature, which is a different and worse Gatekeeper class. Download v3.31.0 or later.

Later updates do not repeat this. The app fetches its own updates, and macOS only flags files a browser downloaded.

## How do I install it with one command on a Mac?

Open Terminal and paste this single line:

```
curl -fsSL https://raw.githubusercontent.com/talirezun/the-curator/main/install.sh | bash
```

The installer detects and installs Node.js and git if they are missing, downloads the project into `~/the-curator`, installs dependencies, and builds **The Curator.app** for your Dock. When it finishes, the app opens in your browser.

It does not add the app to your Dock for you. Open Finder, go to `~/the-curator/`, and drag **The Curator** into your Dock. From then on one click launches everything. You run the install command once.

## How do I install it on Windows or Linux?

The Mac app is macOS only, so on Windows and Linux you run the browser install. It is the same program.

```
git clone https://github.com/talirezun/the-curator.git
cd the-curator
npm install
node src/server.js
```

On Windows PowerShell, start it as `$env:CURATOR_NO_OPEN=1; node src\server.js`.

Then open **http://localhost:3333** in any browser.

| Setting | What it does |
|---|---|
| `CURATOR_NO_OPEN=1` | Skips the macOS-only automatic browser launch on startup. The server still binds to `localhost:3333`; open it yourself. |
| `DOMAINS_PATH=/path/to/your/knowledge` | Puts your wiki folder somewhere other than `~/the-curator/domains`. The folder-picker button in Settings is macOS only, but this environment variable works everywhere. A folder set in **Settings → Knowledge base** takes priority over it. |
| `PORT=4000` | Changes the port if 3333 is taken. |

To update a browser install on Windows or Linux, run `git pull && npm install` in the `the-curator` folder and restart the server.

## Can my coding agent install it for me?

Yes, and on Windows and Linux it is the easiest route. Any CLI-aware coding agent — Claude Code, Cursor, Cline, Aider, GitHub Copilot CLI — can do the clone, the `npm install`, the Mac app build and the first launch. The user guide on GitHub carries a copy-paste prompt written for exactly this, including the instruction not to ask you for your API key, which you paste into the app's Settings yourself.

## Where do I get an API key, and which provider should I pick?

| Provider | Free tier | Notes | Where |
|---|---|---|---|
| Google Gemini | Yes, with strict daily quotas | Recommended. The lowest pay-as-you-go cost and the app's default. | https://aistudio.google.com/app/apikey |
| Anthropic Claude | No, paid only | Roughly 10 times the Gemini bill for the same workload. Defaults to Claude Haiku 4.5. | https://console.anthropic.com/ |
| OpenRouter | Free `:free` models exist in its catalogue for chat, with a daily request cap; none is currently hand-listed for building the wiki | One key onto many vendors. It can build your wiki on several hand-measured, paid models — the list is live in Settings and grows over time. | https://openrouter.ai/keys |

To create a Gemini key: sign in at the link above, click **Create API key**, and copy it. It starts with `AIza` and is about 40 characters long. Strongly recommended: click **Set up Billing** in the same console. The free tier is enough to try the app on a few articles, but Gemini 2.5 Flash Lite on the free tier is capped at 15 requests per minute, 1,000 requests per day and 250,000 tokens per minute, and a batch of 5 to 10 PDFs can stall mid-run with `429 RESOURCE_EXHAUSTED`. The paid price is low enough that most users pay between 1 and 10 euros a month.

An API key is like a password. Never share it or post it.

## Where are my API keys stored?

In `.curator-config.json` on your own machine, written with file permissions `0600`, which means only your user account can read it. Keys are never committed to git, never synced, and never sent anywhere except the provider you are calling. The app calls the provider directly with your key; nothing passes through any server belonging to the project.

Developers running the browser install can also put `GEMINI_API_KEY=...` in a `.env` file. Keys saved in Settings take priority over `.env`. A `.env`-only key does not tick off the setup checklist, because the checklist reads keys saved through the app. The Mac app's program files are read-only, so `.env` is not an option there — use Settings.

## What happens the first time I open it?

A small **Getting started** panel appears in the corner and asks which of two things you came for. The two doors lead to two different checklists, because the order that is right for one is wrong for the other.

**Build a second brain** — read sources, get a wiki:

| Step | What it means |
|---|---|
| Add an AI key | Opens **Settings**. Needed for ingest and chat; project context and the bridge work without one. |
| Point at a wiki, or start one | Opens **Domains**. Choose the folder your knowledge base already lives in, or create a domain — one subject area with its own wiki. |
| Ingest your first source | Opens **Domains**, on the **Ingest** section. Drop in a PDF, Markdown or text file. |

**Give your agents memory** — your agents read and write project context, and no AI key is needed:

| Step | What it means |
|---|---|
| Point at a wiki, or start one | Opens **Domains**. |
| Start a project | Opens **Domains**. A project is what an agent resumes. |
| Connect your agent | Opens **Settings → MCP bridge**, which hands you the snippet your agent needs. |
| Add an AI key | Marked optional here, because ingest and chat are the halves that need it. |

Every step **points** at the real screen that owns the job; the panel itself never saves anything. It tracks real state rather than clicks: it reads "2 of 3 done", ticks items off as you actually complete them, and stops appearing once they are all done. It never blocks you — it is a panel, not a modal. Dismiss it with the cross in its corner, and bring it back at any time with **Settings → General → Show setup guide**.

An OpenRouter key alone does not tick off step 1; the checklist looks for a Gemini or an Anthropic key specifically. If OpenRouter is your only provider the app works fine and you should just dismiss the panel.

The Mac app behaves identically here. It also starts genuinely empty if you already have a wiki elsewhere, because it never goes looking for one. Point it at your folder under **Settings → Knowledge base** and everything appears.

## How do I connect a provider?

**Settings → Providers & keys** reads top to bottom as four numbered steps, and no step is ever hidden — before you connect anything, steps 2, 3 and 4 say what they are waiting for.

Step 1, **Connect a provider**, gives each provider one row: a coloured dot, its name and vendor, the key masked, and a status reading **Connected** or **Not connected**.

| Button | On which row | What it does |
|---|---|---|
| **Add key** | A provider with no key | Opens the field to paste one in. Click **Save**. |
| **Replace key** | A provider that already has one | The same field, over the existing key. |
| **Disconnect** | A provider that already has one | Removes that key entirely. It is how you drop a provider, not how you pause one. |
| **Test this key** | OpenRouter only | Asks OpenRouter about the credential. Spends nothing. It confirms the key, not any particular model. |

A local model — Ollama, LM Studio, llama.cpp — appears as one sentence at the foot of the block rather than a disabled row. It will connect there once there is a base-URL setting to point it at. It does not exist yet.

## Which model builds my wiki, and how do I change it?

Step 2 of **Settings → Providers & keys** is **Your AI model**. Ingest, Wiki Health and Compile all run on this one model; there is nothing separate to set for each. One model keeps the ingest prompt cache warm and keeps one bill to read.

The block shows the model by name with its provider and id, three chips — what it costs per million tokens, what the measurement found, and who measured it — and one sentence saying where the choice came from:

| The page says | It means |
|---|---|
| follows the app default | Nobody chose it. A Curator update can move you. |
| You chose this one | Your pick. Updates will not move you off it. A **Follow the app default** button undoes it. |
| Set by `LLM_MODEL` | An environment variable outranks anything you click here. |
| not the one running | You chose a model, The Curator refused it on read, and fell back. Choose again to fix it. |

Under a **CHEAPEST MEASURED** heading it names the cheapest measured model for the keys you have connected, with a **Use it** button when that is not the one you are on. It says cheapest measured, never best or recommended, because the first is a fact and the other two would be a guess. **Change…** opens the full list, cheapest first within each provider.

**The rule that surprises people, changed in v3.45.0:** saving a key connects that provider and nothing else. It becomes the one that builds your wiki only if nothing else already does, which in practice means on your first key. After that the build lane moves only when you change it in step 2. Choosing a model from another provider switches to that provider, so the bill moves with it. If you disconnect the provider that was building, the lane falls to the cheapest measured model you have connected, and the app tells you where it went.

Chat is a separate lane, chosen per message in the composer, and is unaffected by any of this.

## How do I start and quit the app?

**The Mac app.** Open it from Applications or the Dock. It opens in its own window, opens no browser tab, and has no `localhost:3333` to bookmark — it picks a free address each launch so it can never fight with a browser install over a port.

| You do | What happens |
|---|---|
| Close the window, red button or Command-W | The window hides. The app keeps running and anything in flight keeps going. |
| Click the Dock icon again | The same window comes back. Nothing restarts. |
| Open The Curator a second time | It refuses with "The Curator is already running" and brings the existing window forward. |
| Quit, Command-Q or Dock icon → **Quit** | If an ingest, compile or update is in flight, a dialog headed **"Quit now?"** offers **Keep working** and **Quit anyway**, naming what is running. **Keep working** is the default. |

**The browser install.** Click **The Curator** in your Dock, or run `node src/server.js`, then open http://localhost:3333.

| You do | What happens |
|---|---|
| Close the browser tab | The server keeps running in the background at near-zero CPU. Nothing is lost. |
| Click the Dock icon again | The tab reopens and reconnects to the running server. No restart. |
| Right-click the Dock icon → **Quit** | The server actually stops. |
| Press Control-C in the terminal | The server stops. |

There is no **Stop server** button in the interface, deliberately. Quitting the browser install does not warn you about work in progress — that check exists only in the Mac app — so do not quit during a long ingest.

## How do I update to a new version?

**The Mac app updates itself.** Use **The Curator → Check for Updates…** in the menu bar, or **Settings → General → Software update → Check for updates**. It downloads the new version, checks it, swaps it in and restarts, with no Gatekeeper prompt to click through. Your knowledge base, keys and sync settings are untouched. If a check fails it says why and the copy you are running keeps working, because the new version is never put in place until every check on it has passed. You do not go back to the Releases page.

**The browser install updates in place.** **Settings → General → Check for updates**; if one is available an install button appears and the confirmation names the versions. It replaces its own program files with the published version, reinstalls dependencies and restarts, and the browser reloads itself. From the terminal, the equivalent is `cd ~/the-curator && git pull && npm install` and then restarting the server.

If your local build is newer than the published one — because you have been working on the code — no install button is offered, deliberately: installing would discard your newer commit.

**Settings → General → Run system check** tells you which install you have in one line: the **Install mode** row reads either "Source install (git checkout)" or "Packaged app".

## How do I find my way around the app?

There are no tabs. Everything is reached from a narrow icon rail down the left edge, and the screen is three columns: the rail, a contextual panel beside it that changes with the view, and the main column. Every rail icon carries its name underneath it. **Since v3.76.0 the layout adapts to the window's width:** at 1100px and wider nothing changes; between 800 and 1099px the contextual panel narrows and the Getting started panel sits across the top of the main column instead of down its right side; under 800px the contextual panel folds away, the main column takes the full width, and a **Sidebar** button at the top of the rail slides it back out (it closes when you pick something in it, click beside it, or press Esc). The Mac app's window has a 960px minimum, so it only ever shows the first two steps.

At the top of the rail, the mark is a button: it takes you **Home**, which is **Domains**.

Since version 3.64.0 the rail is **three** places, read as *ask, knowledge, context*. There is no dividing line.

| Rail item | Caption | The question | What it is for |
|---|---|---|---|
| Chat | Chat | ask | Ask questions of one domain's wiki — and, with a project pinned, that project's context as well. |
| Domains | Domains | knowledge | One subject at a time, and everything that acts on it: counts, ingest, the page list, Projects, Shared Brain and Wiki health. This is Home. |
| Project context | Context | context | Everything one project gives an agent: its canonical documents, and the working state your agents read and write over the MCP bridge. Called Agent memory before v3.62.0. |

At the bottom of the rail, separated by a gap: the sun/moon **theme toggle**, **Sync**, and **Settings**.

**Ingest and Shared Brain left the rail in version 3.64.0 and did not leave the app.** Each acts on exactly one domain, so each is now a section of that domain's page — and each still has its own full-page view, one press from the section, still reachable and still restored if it is where you left off. It is one panel with two hosts, not two copies, so a batch you start in one is live in the other.

The first time you open The Curator it lands on **Domains**. After that it opens wherever you left off, remembered per browser. Two exceptions: a screen that failed to load last time is not restored, and a screen an update has removed or renamed is ignored. You get Domains in both cases.

Four things are not rail destinations. **Reading a wiki page** is an overlay that slides over the main column; close it with Escape, a click outside it, or its cross. **Wiki health**, **Ingest** and **Shared Brain** all live inside a domain, on that domain's page.

## What do the small dots and bars on a row mean?

Five consistent visual channels, none of them a screen of their own, and — since version 3.66.0 — the same five everywhere the app has a reading, including the Mac menu bar widget, because a Windows or Linux user has no widget and must see the same fact in the app.

| Channel | What it shows | Example |
|---|---|---|
| **Identity dot** | Which domain — one of twelve colours, recorded for the domain itself (since v3.76.0, in a small file in its folder), so adding, deleting or renaming another domain never changes it; the same colour wherever that domain is named, and on every Mac that syncs the folder | A domain's dot in the sidebar, a Chat domain chip, a row in "Domains in this folder" |
| **Freshness dot** | How recent a reading is, as a tier | The dot beside "saved 41 min ago" |
| **Clock + age** | How recent, in words | "saved 41 min ago" itself |
| **Depth bar** | Size or share against a named total — never an unnamed one | A document's size against a project's 200 KB budget, issues per category in Wiki health, a project's saved sessions against the busiest project |
| **Tone** | An outcome — ok, warn, danger or quiet — shown only as a mark (a border, a rule, an icon), never as coloured text | A monitor's status line |

None of the twelve identity colours is also used for freshness, danger or a warning, so a domain's dot can never be mistaken for one of those. A depth bar only turns danger-toned when its named budget is actually exceeded, and that fact is always also stated in words, never colour alone.

## What is on a domain's page?

At the top: the folder path in monospace, the display name with an information mark beside it, and **Rename**, **Delete** and **Ask this domain**, the last of which jumps to Chat already scoped to it.

Then an **OVERVIEW** card (the counts, and when the domain was last written to) followed by five numbered sections, in the order the work runs in: 1 **Ingest** (drop a file here), 2 **Pages** (everything readable, behind a Wiki / Context / All lens), 3 **Projects in this domain**, 4 **Shared Brain** (the connections this domain contributes to) and 5 **Wiki health**. The numerals arrived in v3.64.1; as of v3.64.2 all five sit at one fixed position and all five titles are Title case rather than full capitals.

**OVERVIEW** is five figures in one card — PAGES, ENTITIES, CONCEPTS, SUMMARIES and PROJECTS, plus OTHER when pages sit outside the three canonical folders. A figure reads an em dash rather than 0 while it is still loading, because "not known yet" and "none" are different answers. Beside them sit jump buttons — SOURCES, carrying the last ingest, and SHARED when this domain contributes to a Shared Brain — each of which opens the section it names, drawn at the same tile size as the five figures beside them rather than as a separate, smaller row. Since v3.64.2 this is the same card the Project-context page draws its own readings in — one shared component, not two builds of the same idea — and since v3.65.0 the two jump tiles are ordinary tiles in that one grid rather than a second, smaller row.

**Ingest is always open, as of version 3.65.2, and Shared Brain is always open too, as of version 3.65.3.** Neither has a chevron or a remembered open/closed state any more. Ingest's one reading, the last-ingest age, sits at the right of its own heading; pick a `.md` or `.txt` file and a callout appears: "Wanted this kept word for word? Add it as a project document instead," with a button that opens this domain's own project in Context, at step ① Documents. On a read-only Shared Brain mirror there is no Ingest section at all, because an ingest into a mirror has never been possible.

Shared Brain's heading now carries one reading of its own — *contributes to …*, *mirror of …*, *not part of any*, *off on this install* or *no connection* — and, on a contributing domain, one monitor (pushed, pulled, synthesis, pending, mirror, contributes), one row of actions (**Push contributions**, **Pull updates**, and **Run synthesis** when this computer holds the brain's admin token), and folds underneath for the access token, cohort and sharing, skipped pages, admin controls and leaving. A `shared-*` mirror domain has its own **Pull updates**.

**Wiki health's Scan row, since version 3.66.0, opens to two readings**: the scan's totals, and **issues per category** — one line per kind of issue, largest first, each drawn as a depth bar against the largest category. A category with no issues reads 0 with no bar; the largest bar is simply the biggest pile, never itself a warning.

The **Pages** lens is new in version 3.64.0. **Wiki** shows entities, concepts and summaries; **Context** shows standing briefs, handoffs and a project's canonical documents; **All** shows both. Every one of them opens in the same right-side reader. Under the lens row are a **Filter by name…** box and the older type facets — **All**, **Entities**, **Concepts**, **Summaries** and **Memory** — which narrow the wiki reading. The two controls cannot contradict each other: pressing **Memory** puts the list into the **Context** lens and the lens row says so. The type facet **All** means wiki pages only, the same number the PAGES figure reports, so the two can never disagree.

The list loads with the domain, so there is nothing to press. On a large domain the first 150 matching rows are painted, with **"Showing 150 of 3,410"** under the list and a **Show 150 more** row. Press it and the next 150 are added to what is already there; the last press offers only the remainder, and when everything matching is on screen the row and the count both disappear. Typing in the filter, or switching facet, starts the window fresh at 150.

## What is a domain, and how do I create one?

A domain is a focused knowledge silo — a dedicated wiki for one topic area, with its own AI schema, wiki pages, chat conversations and Obsidian graph cluster. Domains are siloed from each other by default.

Click **Domains** in the rail. The panel beside the rail lists every domain under a **KNOWLEDGE** heading with its page count. Markers on a row: **RO** for a read-only Shared Brain mirror; on the right, a small **filled dot** when the domain has open health issues, a small **hollow ring** when its health has **not been checked yet** this session (open the domain and its free scan runs; since v3.76.0), and **no mark** only when a scan found no open issues — no mark never means "not checked". Updating to v3.76.0 may change the domain colours once; after that they stay put. Above the list sit **New domain** and **Use existing folder**.

| Action | What happens |
|---|---|
| **New domain** | Give it a **Name**, an optional **Description**, and pick a **Template**: **Generic** (a balanced starting schema, the good default), **Tech**, **Business** or **Personal**. The template writes the domain's starting schema, which tells the AI how to categorise what you ingest; you can edit it later. Nothing is written until you click **Create domain**. |
| **Rename** | Changes the display name immediately. Wiki pages, conversations and Obsidian links are preserved. A read-only Shared Brain mirror cannot be renamed — its name comes from the Shared Brain it mirrors, and there is no rename control on the Shared Brain page either. |
| **Delete** | The confirmation names the folder and counts what goes with it: pages, the Memory of its projects, saved conversations and raw sources. You type the domain's folder name to confirm; the **Delete domain** button stays disabled until it matches exactly. Since v3.73.0 the domain is moved to The Curator's trash (`.curator-trash/domains/` in the Curator data folder), not erased: to restore it, open **Settings → Trash** and press **Restore** (v3.76.0) — it never overwrites; if the name is taken it offers `<name>-restored` — or move the folder back by hand. **Delete forever** there erases one item for good after you type its name. The trash never syncs; a restored folder does, on the next Sync. Nothing empties the trash automatically. With sync configured, the deletion still reaches GitHub and your other computers on the next Sync. |

If one of these is refused because something else is writing to that domain — an ingest, a sync, an MCP write — you get a clearly marked "Not done — the server refused this." message rather than a silent failure. Wait and try again. Changes appear in the app and in Obsidian instantly, with no restart. If sync is configured, run **Sync now** soon after a rename or delete.

## How do I point The Curator at wiki files I already have?

Two entrances to the same action: **Use existing folder** in the Domains sidebar and on the empty-state card, or **Choose folder** in **Settings → Knowledge base**.

**Pick the folder that CONTAINS your domains, not a domain.** A knowledge folder holds one folder per domain, and each of those holds a `CLAUDE.md` and a `wiki/`.

```
the-curator/
└── domains/          <- pick this one
    ├── articles/     <- not this
    │   ├── CLAUDE.md
    │   └── wiki/
    ├── business/
    └── projects/
```

Pick `articles` and The Curator looks inside it for domains, finds none, and shows an empty list. An empty folder, a folder picked one level too deep, somebody's Pictures folder and an unmounted drive all produce exactly the same answer and are indistinguishable, so rather than guess the app tells you what it looked in: **No domains found there**, with "Looking in `<path>`", and a **Go back to the previous folder** button.

Nothing is copied, moved or converted. Pointing the app at the folder is the whole migration. What you redo once: paste your API key again, reconnect Personal Sync, and re-run the MCP wizard. What never happens: no file is deleted, rewritten or converted, and your browser install is not modified.

The **Choose folder** button greys out while anything is writing to your wiki, because changing the folder mid-ingest would scatter the rest of that document's pages into the new location. There is no field to type a path into; on Linux and Windows use the `DOMAINS_PATH` environment variable instead.

Default knowledge folder: `~/Library/Application Support/The Curator/domains` in the Mac app, and your install folder, for example `~/the-curator/domains`, in the browser install.

## What file types can I ingest?

| Type | Extension | Example |
|---|---|---|
| PDF | `.pdf` | Research papers, book chapters, reports |
| Text | `.txt` | Articles you have copied, lecture notes |
| Markdown | `.md` | Notes from other apps, written summaries |

Only text-based PDFs work. A scanned PDF is an image of a page and has no extractable text; there is no OCR step. Run OCR first — macOS Preview → Tools, or `ocrmypdf` — or copy the text into a `.txt` file.

## How do I ingest a document?

1. Click **Domains** in the rail, pick your destination domain, and open its **Ingest** section. (The full-page Ingest view is still there, one press from the section, and opens on its own if it is where you last left off.)
2. Confirm the destination domain. In the section it is the domain whose page you are on; in the full-page view it comes from the picker above the drop zone or from the destination list in the panel beside it. That list shows one row per domain with its page count and when it was last written to — "last write" rather than "last ingest", because compiling a conversation writes to a domain too.
3. Drag your file onto the drop zone, which reads **"Drop a source here"**, **"or browse your files"**, **"Accepts .txt · .md · .pdf"**, with **"2 or more files at once starts a batch"** underneath. Or click **browse your files**. A cross beside the file name removes it before you ingest.
4. Click **Ingest**. Since version 3.67.0, once a file is picked, a line under Ingest says what it will run on and roughly what it will cost — nothing is uploaded until you press Ingest.
5. A progress bar names the current step with a percentage and a running timer. This usually takes 15 to 60 seconds. Do not close the browser or refresh.
6. You get a specific result — for example "Wrote 7 new pages · updated 4 existing · +6.1 KB" — followed by the full list of pages created or updated. Since version 3.67.0 the result also says what actually ran and what it cost, beside the call count.

Dragging from Finder works anywhere in the full-page Ingest view, not only on the drop zone exactly. In the **Ingest** section of a domain's page the target is the section itself: a file dropped elsewhere on that page is refused rather than opened, because dropping a file on a web page normally navigates away from the app. Dropping two or more files at once starts a batch, exactly as picking several from the file browser does.

What actually happens: the document is saved untouched to `raw/`, its text is extracted, and the AI plans and writes pages into three folders — `entities/` for people, tools, companies and frameworks, `concepts/` for ideas and techniques, and `summaries/` for one page per source document. Existing pages are **merged**, not duplicated: a second document about the same person adds to the one page that exists. Links are then repaired and made two-way, and the domain's index and log are updated.

The drop zone in the chat sidebar is not connected, says so on itself, and sends you here.

## How do I ingest many files at once?

Selecting two or more files switches from the single-file flow into a **batch queue** — one durable, resumable job that ingests every file one at a time and survives you closing the tab or restarting the app. Selections add up across as many drops and folders as you like; adding the same file twice does nothing, because files are matched on name and size.

You see a confirm screen first and nothing is spent until you press **Start batch**. It lists every file largest first, any files it will not accept, and an estimated cost range in dollars and tokens. Its controls: a cross on each file to drop it, **Add more files**, **Clear all**, a **Budget cap (optional)** field, and a checkbox reading **Overwrite existing pages for files already ingested**.

| Control or behaviour | What it does |
|---|---|
| Largest file first | Bigger documents build up the wiki's vocabulary early, so smaller files later in the batch link into a richer wiki. |
| One file at a time | Enforced as a hard guarantee, never parallel. Two files ingesting into one domain at once would each believe the same pages already exist and could create competing versions of the same page. |
| **Pause** | Finishes the file currently ingesting, then stops. Lossless: it never interrupts a file partway. |
| **Cancel** | Stops the batch and the current file right away, at the next AI call. Completed work stays in your wiki; nothing is deleted or rolled back. The interrupted file shows as **Stopped** and can be re-ingested with **Overwrite** ticked. |
| **Resume** | Continues exactly where it left off. |
| **Dismiss** | Clears a finished, cancelled or failed batch from the screen. It deletes nothing, and is unavailable while a batch is live. |
| Budget cap | A dollar ceiling. The batch pauses when the running total reaches it. If the model in use has no published price, a cap is refused rather than accepted unenforceably; the batch itself still runs. |
| Already-ingested files | Marked **Skipped** the moment you create the batch, before anything is uploaded or any AI call is made. The Overwrite checkbox re-includes them. |

**Since version 3.66.0**, with a cap set, spend is drawn as a depth bar against it — "$0.04 spent of the $0.05 cap" — appearing once the first file has been charged (before that the line reads "pending first file"). The cap is checked between files, so the file that crosses it finishes and is charged; the bar then turns red and a line states the overshoot in words: "$0.06 spent, $0.01 over the $0.05 cap." Without a cap there is no bar. The estimate carries the same run line — what it runs on and roughly what it costs — beside its existing figures.

The batch can pause itself. The reasons it gives: the AI provider rate-limited us, the AI provider is temporarily unavailable, budget cap reached, 3 files failed in a row, the app restarted mid-batch, or this domain is locked by another process. In the first two cases The Curator has already retried with backoff and nothing was lost — wait a few minutes and click Resume.

If the app itself restarts mid-batch, the batch is deliberately never resumed automatically, because spending money while you are not there to see it is not a decision the app makes for you. The file that was mid-ingest is reset to waiting, and re-running it is safe.

When the batch finishes you get an aggregate report — completed, failed, skipped, total pages, total warnings, total spent — and then a free local Wiki Health scan across the whole domain. On a cancelled batch the total reads "at least $X", because the AI call in flight when you cancelled cannot be measured.

## Why does the cost estimate depend on my existing wiki?

This is the single most counter-intuitive thing about ingest cost. Every ingest call re-sends the list of your domain's existing pages so the AI can link into what is already there instead of creating duplicates. That overhead is near-fixed per AI call, so it weighs far more heavily on a short note than on a long document.

Measured against a real wiki of about 3,300 pages versus an empty one, the same document costs roughly 39 times more as a 2 KB note, 27 times as a 5 KB short article, 15 times as a 13 KB article, 3.3 times as a 40 KB chapter, and 2.1 times once a document is long enough to hit the per-ingest size cap. The confirm screen does not use a generic multiplier: it computes the real ratio for the files in front of you.

There is also a size where cost jumps rather than tapering. Around 15,000 characters a source crosses from a single AI call to the multi-phase pipeline, which roughly doubles the input tokens — so two similar-looking files either side of that line can show noticeably different estimates, and that is expected.

The estimate is a range, not a ceiling. The low figure assumes prompt caching applies and the high figure assumes it does not. Real spend can land above the high figure; on one measured batch it came in at just over 103 percent of it.

## How large a document can The Curator handle?

The ingest pipeline caps the input at 80,000 characters, about 20,000 tokens, per ingest, to keep latency and cost predictable. If your source is longer you get a red **Attention** entry on the result panel saying exactly how much was processed and how much was dropped; content past the cap is not seen by the AI. For inputs over 15,000 characters a multi-phase pipeline kicks in automatically: an outline pass, then page content written in batches, then a programmatic index merge.

| Document size | Behaviour |
|---|---|
| Up to about 25 pages, 10,000 to 15,000 words | Single-pass ingest, 15 to 60 seconds. The most common case. |
| 25 to 100 pages, book chapters, long papers | Multi-phase pipeline, about 1 to 5 minutes. Works reliably. |
| 200 to 300 pages, full books | Multi-phase still works but is not stress-tested at that scale. Expect 10 to 20 minutes. If it stalls, split by chapter. |
| Scanned, image-only PDFs | Will not work. Convert to text first. |

A still percentage with a moving timer means it is working normally — several steps are a single AI request, and there is no way to show progress partway through one response. A frozen timer with no error message for several minutes is worth refreshing and retrying. If the provider is briefly overloaded the progress label turns amber and says so, for example "Service busy — retrying in 9s… (attempt 2/3)".

## Is it safe to ingest the same file twice?

Yes. The pipeline is idempotent on re-ingest. The summary slug is computed from the source filename, so `report.pdf` always lands on `summaries/report.md` and the second ingest merges into it. Entity and concept pages are deduplicated by three passes at write time, index rows for slugs already present are skipped, and duplicate bullets are removed after every write.

To re-ingest one source: open **Ingest**, pick the same domain, drop the same file in and click **Ingest**. The Curator recognises it and stops before spending anything — "*filename* has already been ingested into this domain." Click **Re-ingest & update wiki** to proceed or **Cancel** to back out. In a batch, the same check happens at the confirm screen and the **Overwrite existing pages for files already ingested** checkbox re-includes the file.

There is no list of previously ingested files in the app. Your originals live in `domains/<domain>/raw/` on the machine you ingested them on.

## What do the entries in the ingest report mean?

Most of them are successes, not problems: they are the safeguards reporting what they caught and fixed. Each entry is categorised, and the banner's border colour matches the most severe one.

| Category | Mark | What it means |
|---|---|---|
| Auto-fixed | tick, green | The Curator detected something the AI did wrong and already fixed it. Nothing to do. |
| For review | warning, amber | Something it cannot auto-resolve. Read the entry; you may want to act in Wiki health or re-ingest. |
| Attention | warning, red | Something material, usually source truncation. Read the entry. |
| Info | information, blue | A contextual note. Usually safe to ignore. |

Typical auto-fixes: an author entity the AI forgot was injected; an honorific slug such as `dr-tali-rezun` was redirected to the canonical one; a near-duplicate concept was merged; a hub page's plain-text mentions were turned into links. Typical review items: some wikilinks do not resolve to an existing page, a page had to be rewritten more briefly, or a stub page was created because the AI failed to write content for it. The two Attention entries you are most likely to see are source truncation at 80,000 characters, and "Could not extract text from *file*", which means the PDF is encrypted, scanned or malformed.

Any issue that happens 3 or more times in one ingest is collapsed into a single summary line. No detail is lost: every page written is still listed individually in the change list above the warnings. Two kinds are deliberately never grouped — semantic near-duplicate redirects and a newly injected parent page — because each names something specific worth looking at.

Below the change list a small footer reports the real usage for that ingest, not an estimate: provider and model, how many calls, input and output tokens, and cached-read and cache-write tokens where they are non-zero.

## How do I get better results out of an ingest?

- **Use descriptive filenames.** `atomic-habits-summary.txt` is better than `notes.txt`, because the filename becomes the summary page's name — `report-2024.pdf` always lands on `summaries/report-2024.md`.
- **One document per file.** Do not combine ten articles into one file; each document should get its own summary page. To add many at once, select them all and use batch ingest.
- **Clean up copy-pasted text.** If you paste an article from a website, remove the navigation menus, cookie banners and footer text first. Cleaner input makes better pages.
- **Mind the free-tier rate limits.** Ingesting five or more documents on Gemini's free tier will often hit a quota partway through.
- **Read the warnings panel after each ingest.** If it says the source was truncated or a stub page was created, the ingest finished but with reduced quality, and the entry tells you what to do. Re-ingesting is always safe.

## How do I open and read a wiki page?

Reading a page is not a place you navigate to. It is an overlay that slides over whatever you were doing. Two ways in: click a citation under a chat answer, or click a row in **Pages** on a domain's page. Close it with **Escape**, a click on the dimmed area outside it, or its cross. It never survives moving to another rail item.

The overlay shows the page's path, its title, a coloured type badge reading `entity`, `concept` or `summary`, its tags, and the body rendered as proper formatted text rather than raw markdown. Below the body is a **BACKLINKS** list of every page that links to this one, and clicking a backlink loads that page in the same overlay, so you can walk the graph without leaving it. Links inside the page body are highlighted but not clickable in the reader today — use the backlinks list, or open Obsidian, to follow links forward.

On a summary page a small bar above the content names the original document it came from, with its size and a **Reveal in Finder** button. Seeing "the original file isn't on this machine" there is normal rather than a problem: raw source files are deliberately never synced, so on any machine other than the one you ingested on, the app tells you the filename, size and ingest date but cannot open the file. Your wiki page is unaffected.

Every page is a plain markdown file on your disk, so you can equally open it in Obsidian or any text editor and edit it there. The app and Obsidian read and write the same files.

## How do I chat with my wiki?

1. Click **Chat** in the rail.
2. Pick a domain from the composer's **Domain** pill. Chat talks to exactly one domain at a time.
3. Click **New chat**, or just start typing — a new conversation is created automatically.
4. Type your question and press **Send**, or Command-Enter on a Mac, Control-Enter on Windows.
5. The answer streams in as the model writes it. On some models you see the model thinking first.

**Since v3.72.0** the conversation list beside the rail spans every domain at once, not just the one you are in — each row carries its own domain's colour dot, and, when the last answer recorded one, a small hollow grey square plus the project's name. Rows group by when they were last used: Today, Yesterday, Previous 7 days, Earlier, with a live ticking age; a conversation from before v3.72.0 has no recorded last-use time and reads "started … ago" instead, so it is never mistaken for something you just used. A domain filter narrows the list to one domain. Above the thread, a page header carries the conversation's title, an ⓘ, the **Compile** button, and a line of live facts: domain and its dot, page count, questions and answers on screen, the pinned project if the last answer recorded one, and how long ago the conversation started. Picking the **Domain** pill's other option does not move the current conversation — a conversation lives in one domain's folder, so a different pick starts a fresh conversation there. A turn still in flight when you switch away keeps running, and its answer is still there when you come back.

The AI answers only from your wiki. If you have not ingested anything on a topic it says so rather than inventing an answer. Answers render with real formatting — headings, bold, block quotes, a rule, one level of nested lists — and citations appear as **numbered inline markers** (¹ ² …), assigned in order of first appearance, with one **Sources · N pages** list under the whole answer: one chip per page, numbered to match, coloured by page type — entity, concept or summary, never by domain, since every source in one answer already shares the conversation's domain — and named for the page's own title, for example **Dr Tali Rezun**. Click a marker or a chip to open that page in the reader. No raw file path appears on the answer face; it lives in the reader's header once opened.

Chat adapts its shape to your question without you doing anything: a decision question gets a direct recommendation up front, a list or count question gets a focused de-duplicated list, and everything else gets a synthesised answer.

If an answer ends with "This answer was cut off", the model reached its per-reply length limit on a very long answer. You still get the partial answer. Ask a narrower follow-up for the rest.

A shortcut worth knowing: in **Domains**, the **Ask this domain** button drops you into Chat already scoped to that domain. If you have no domains yet, Chat says so and offers a **Go to Domains** button — there is exactly one place domains are created.

## How do I change the chat model and answer length?

The message box's controls sit along its bottom edge, to the left of **Send**, four pills: **Domain**, **Project**, **Length**, **Model**. Length and Model both open upward, and both choices are remembered in your browser across conversations and restarts until you change them. Domain and Project are picked per conversation and per question respectively — see [How do I chat with my wiki?](#how-do-i-chat-with-my-wiki) above.

| Control | What it does |
|---|---|
| **Length** | **Concise** — a short direct answer, one to three tight paragraphs, leading with the point and the two or three most important sources. **Balanced**, the default — the normal experience. **Detailed** — more depth and more supporting sources. Detailed never dumps your whole domain. |
| **Model** | Picks the exact model that answers your chat messages. Each row shows its id, its price per million tokens, and one plain line: any warning reason first, then how fast it answered when measured. With no key saved there is nothing to choose and the picker is hidden. |

There is no attach button; you cannot ingest a file from the chat box.

When an OpenRouter key puts hundreds of models within reach, the menu shows a working set — the model you are on, any you have starred, ones you have used recently, and every model that has been measured — in the catalogue's order rather than by recency, so position does not move. A **browse** row opens the full catalogue with search, a provider filter and a free-only filter; nothing is hidden, only deferred. Starring works in the browse dialog.

Any answer can be re-asked on another model. Both answers stay in the thread, each labelled with the model that produced it and what it cost. Picking the model sends immediately, so treat the model list as the decision point; it costs one ordinary chat message.

The chat lane is sealed off from the rest of the app: ingest, Compile and Health scans keep using the model set in Settings no matter what you pick here.

## How do I find an old conversation?

Type in the **Filter conversations** box beside the rail. It reads the messages, not just the titles — a conversation's title is only its opening question trimmed, so searching by how a thread ended used to be impossible. A conversation found by its contents rather than its title says so on the row. Press Escape to clear the filter; the conversation you have open stays open.

If you type a question into that box by mistake, the app hands it back. When what you typed matches no conversation and looks like something asked rather than looked up — four words or more, or ending in a question mark — the empty result offers **Ask this in a new chat**. Click it or press Enter and your text moves into the composer of a fresh chat, focused with the caret at the end. It is not sent for you.

To delete: since v3.72.0, every row shows a neutral trash icon, always visible — the same one row-action rule used across the whole app now — click it and confirm. To delete several: press **Select** in the list head, tick the ones you want (or **Select all**), and use the bar that appears, reading "N selected · Delete N · Done". Deletions are confirmed first and run one at a time; if any fail you are told which, and those stay ticked so you can retry.

## What does Compile to Wiki do, and what does it cost?

A chat is a good place to think out loud, but the conversation is not part of your wiki. **Compile to Wiki** turns a conversation into permanent wiki pages. Use it after a focused brainstorm, a research thread, a meeting note or a decision you talked through.

The **Compile** button sits in the page header, beside the conversation's title, as soon as you have asked one question. The header's facts line, underneath the title, names how many questions and answers are on screen — the input Compile is about to save — and says nothing about cost.

1. Click **Compile to Wiki**. The button reads **Checking cost…** for a moment.
2. A dialog opens naming the estimated cost and where the pages will land. Nothing has been spent yet. The estimate itself is free: it makes no AI call and no network request, and only reads the conversation, the domain schema and the list of pages you already have.
3. Click **Compile**. Now the paid work starts; a progress bar shows each step.
4. After 15 to 45 seconds a result card appears inline in the conversation: how many pages were created and how many updated, with byte sizes and per-section bullet deltas. Unchanged pages are hidden behind **Show unchanged**.

The cost is shown as a range because half of it is knowable and half is not. The input — the prompt sent to the AI — is measured character by character, and that character count is exact; the input **token** count derived from it is an estimate (±15%), not counted by a real tokenizer. The output — how many pages the AI decides to write — cannot be known in advance; three runs on identical input produced 19, 18 and 18 pages. The range is deliberately generous on the high side, and across eleven measured compiles every actual bill landed inside it.

The number that surprises people here too: it is your wiki's size, not your chat's length. The same four-turn conversation measured 5,740 prompt characters on a fresh domain and 12,431 on one holding 180 pages. A long conversation on a small domain is often cheaper than a short one on a large domain.

The dialog never renders an unknown cost as $0.00. It says one of four things: a normal range; that the model is genuinely free; that no published price is on file so the cost cannot be shown in dollars while your provider will still bill you; or that no AI provider is configured. **Since v3.72.0**, when a fallback model exists, the dialog also names it and its price before you confirm — "If gemini-2.5-flash-lite is unavailable, The Curator may fall back to gemini-2.5-flash, priced $0.30 / $2.50 per 1M input / output tokens" — never a silent substitution after the spend.

**Since version 3.67.0** the dialog leads with the same "Runs on …" line every AI action shows, and — Compile always runs on your one AI model (Settings → Providers & keys), never the model this particular chat happens to be on — a second line appears whenever those two differ, saying so plainly. The result card, after the compile, adds a "Ran on … · $…" line with what it actually cost, even when a compile that already called the model then failed.

What gets written: one summary page under `summaries/` named `<conversation-title>-<YYYY-MM-DD>-<short-hash>.md`, entity and concept pages for anything central to the discussion, cross-links between them all, and an entry in the domain's log. Compiling the same conversation twice with nothing changed is refused with a clear message — send another message in the conversation and compile again to extend it. The conversation itself stays in the sidebar after a compile.

## How do I see my knowledge graph in Obsidian?

Obsidian is a free note-taking app that reads the exact markdown files The Curator writes. The Curator does the decomposition into entities, concepts and summaries; Obsidian draws the network.

1. Install Obsidian from https://obsidian.md
2. On the welcome screen click **Open folder as vault**.
3. Navigate to your knowledge folder — the one that contains your domain folders, the same folder rule as above — and open it. The path is shown in **Settings → Knowledge base**, with a **Copy** button.
4. In Obsidian's left sidebar click the **graph icon** to open Graph View. Each dot is a page, each line a link, bigger dots have more connections. Click a dot to open the page, scroll to zoom, drag to pan.

To colour the graph, once and for all time:

1. Open Graph View and click the gear icon at its top right.
2. Find the **Groups** section and click **New Group** three times.
3. Set each one up:

| Group | Query | Colour |
|---|---|---|
| Entities | `tag:#type/entity` | Blue |
| Concepts | `tag:#type/concept` | Green |
| Summaries | `tag:#type/summary` | Purple |

Every future ingest colours new nodes automatically. In the same gear panel, setting **Node size** to **Linked mentions** makes your most-connected pages visually larger.

If new pages do not appear after an ingest, press Command-R or Control-R in Obsidian to force a refresh, or close and reopen the vault — Obsidian does not always notice new files.

## What does Wiki health check and fix?

Wiki health lives inside a domain, as the last section on that domain's page. Selecting a domain runs the free local scan by itself, so there is nothing to press. The panel then shows the open-issue total with "scanned N ago", the entity, concept, summary and dismissed counts, and a row of chips, one per issue type with its count. The button reads **Rescan** once a scan has produced a result, and **Scan wiki health** when a scan failed and there is no result at all.

| Issue | What it means | Action |
|---|---|---|
| Broken links | A link points to a page that does not exist — a typo, hyphen drift, or a page the AI has not written. | Per row, **Apply** rewrites it to a matched target, or **Ask AI** proposes one. In bulk, **Fix N broken links**. |
| Orphan pages | An entity or concept page nothing links to. Not necessarily an error — future ingests often connect it. | **Rescue N orphans** in bulk, or **Ask AI** per row for up to five pages that should link to it. |
| Folder-prefix links | Links like `[[concepts/rag]]` instead of `[[rag]]`. Obsidian treats these as separate pages, breaking the graph. | **Fix** strips the prefix. |
| Cross-folder duplicates | The same page in both `entities/` and `concepts/`. | **Fix** merges the concept into the entity version, keeping all bullets. |
| Hyphen variants | Files for the same thing differing in hyphenation or an honorific — `tali-rezun`, `talirezun`, `dr.-tali-rezun`. | **Fix** merges all variants into the canonical slug and repoints every link that pointed at a variant. |
| Missing backlinks | A summary lists an entity but the entity does not link back. | **Fix** injects the missing backlink. |

A **QUICK MAINTENANCE** block holds one button per batch tool, each with a live count, each appearing only when it has work to do:

| Button | AI | Cost |
|---|---|---|
| **Fix N safe issues** — every deterministic fix at once, no preview needed because these are unambiguous | No | Free |
| **Fix N broken links** — free formatting fixes first, then the AI matches the rest to real pages or removes brackets pointing at nothing | Yes | Shown on the button |
| **Rescue N orphans** — the AI finds the page that should most naturally link to each orphan and writes a short relationship note into it | Yes | Shown on the button |
| **Find duplicate pages** — the semantic-duplicate scan | Yes | Shown when you open it |

The pattern is always the same: click, a confirm card names exactly what will happen and what it costs, you confirm, the AI plans with a progress bar, you see a preview, you click **Apply**, and the wiki re-scans so you watch the counts drop. Without an API key you still get **Fix N safe issues**; **since version 3.67.0** the three AI buttons stay visible with no key too, disabled rather than hidden, with a line underneath linking to Providers & keys, and a second line naming the one model they all run on. The first time you use any AI action, a one-time notice explains what leaves your machine, and it now names all three supported providers — Google Gemini, Anthropic or OpenRouter.

Run it after a large batch of ingests, when a wiki starts to feel messy, or about once a month on an active domain. A scan is always safe and idempotent, and never touches your source files or conversations.

On a read-only Shared Brain mirror the scan runs but no fix buttons appear, because a fix there would be overwritten on the next Pull. Fix it in the personal domain you contribute from.

## What does the duplicate-page scan cost, and is it safe?

The semantic-duplicate scan finds pages the algorithm cannot catch — `rag` and `retrieval-augmented-generation`, `email` and `e-mail`, `neural-network` and `neural-networks`. It is opt-in, user-gated and cost-gated: nothing happens until you click and then confirm.

It typically costs between $0.005 and $0.03 per scan on Gemini Flash Lite. A confirm card shows the estimate and the candidate-pair count before it runs, and if there turn out to be no likely duplicates it tells you that instead of charging you.

Each candidate comes back as its own card showing `remove-slug → keep-slug`, a confidence level and the AI's reasoning, with four buttons: **Preview diff**, which opens the exact paths, the link rewrites and the first 4 KB of the merged page inline; **Flip**, which swaps which side is kept; **Merge**, disabled until you have previewed that specific pair; and **Skip**, which dismisses the pair permanently. The preview gate is per pair and resets when you re-scan, switch domains or flip a pair.

There is a batch option for high-confidence pairs only, naming the count and what will happen first. Medium and low-confidence pairs are deliberately one at a time, because those are the ones most likely to be genuinely distinct.

You can tune **Cost ceiling per scan** and **Maximum candidate pairs per scan** in **Settings → Health & scan limits**. The defaults, 200,000 tokens (raised from 50,000 in v3.72.1) and 500 pairs, suit domains up to about 5,000 pages — 200,000 tokens is enough for a full scan at the 500-pair default, about $0.03 on Gemini Flash Lite. A scan estimates its own cost first and refuses to start, before you can click Scan, when the estimate is over the ceiling.

## Can I undo a health fix or a merge?

Not inside the app. There is no Undo button and no revert screen. A merge deletes the duplicate page and rewrites every link to it, and the confirmation says so before you commit: it names how many pages will be deleted, and the button on the two destructive fix types — hyphen variants and cross-folder duplicates — reads **Merge and delete**, not "Fix now".

The safety net is git. Every sync is a real git commit, so if you use Personal Sync a git client pointed at your knowledge base folder can browse and revert today. Without sync, a merge cannot be undone.

A middle option exists for things you do not want to act on: **Dismiss** on any review-only row, or **Skip** on a duplicate pair, marks the issue as not a problem so it stops appearing on future scans. Dismissals are reversible from a collapsible **Dismissed (N)** list with a **Restore** button on each row, they live inside the wiki folder so your sync carries them between computers, and they self-clean when a page they refer to is renamed or deleted.

## How do I back my wiki up to GitHub?

**Sync** is the refresh icon in the rail footer. It keeps your wiki and chat history in sync across your computers using a free, private GitHub repository. No subscription, no third-party service, nothing on a server you do not control. Setup takes about three minutes and you do it once.

**Step 1 — create a private repository.** Go to github.com/new, name it anything, make sure **Private** is selected, and leave it empty — do not tick "Add a README", ".gitignore" or "license", because a pre-filled repo makes the first push fail. Create it and copy the URL.

**Step 2 — create a Personal Access Token.** Either token type works. A fine-grained token is more secure and is the recommendation: under GitHub's developer settings, create one, name it, pick an expiration, set **Repository access** to **Only select repositories** and pick the repo, then under **Repository permissions** set **Contents** to **Read and write** — that is the critical one; Metadata read-only is added automatically. Generate it and copy it immediately; it starts with `github_pat_`. A classic token with the top-level `repo` scope also works and can be set never to expire; it starts with `ghp_`.

**Step 3 — connect in the app.** Click **Sync** in the rail footer. The **Connect a GitHub repository** card has three fields on one screen: **Repository URL**, **Personal access token**, and **Starting direction** — either **Push my wiki**, for the machine that has the knowledge, or **Pull an existing wiki**, if you have already synced elsewhere. Click **Connect**. It takes about 30 seconds.

Daily, the golden rule is to click **Sync now** at the start and end of each work session. It pulls anything new from GitHub, then pushes anything new from this machine, so you never have to remember which computer is ahead. Next to it sit **Push only** and **Pull only**, for when you know exactly what you need.

If a button is greyed out, something else is writing to your wiki — an ingest, a health fix, a Shared Brain push. Hover it and it tells you what. This is deliberate: a sync mid-write would commit a half-written wiki.

## What does the number on the Sync badge mean?

It is the count of files whose current version has not reached GitHub yet — this includes files sitting in a commit made here that was never pushed (for example right after **Pull only**, which commits but never pushes, or after a push that failed partway), not only uncommitted edits. The same number appears twice: as a small badge on the **Sync** icon in the rail, refreshed in the background so you can see there is something to push without opening the view, and as a chip beside the buttons in the Sync view reading, for example, "7 local changes not pushed".

Chat conversations are synced deliberately, so sending one chat message legitimately ticks the count to 1 even with no ingest and no compile. That is not a bug.

**"Last synced"** (shown in the Sync view) is the time this computer last completed a sync with GitHub — a push that reached it, a pull, or a connect that finished — not the date of your newest change. An install connected before v3.72.1 reads "not recorded yet" until its next sync.

## What is synced and what stays on my computer?

| Synced | Local only |
|---|---|
| All wiki pages | Original source files — your PDFs and text files in `raw/` |
| Chat conversations | Your AI provider API keys |
| Domain schemas | The app's own code |
| Working state written by your agents | |
| Health dismissals | |

## How do I set up a second computer?

Install the app, add your API key, then click **Sync** in the rail footer and enter the **same repository URL** and the **same token** as before, with **Starting direction** set to **Pull an existing wiki**. Click **Connect**. Everything downloads. You do not need to create a domain first — they arrive with the pull.

If you worked on two machines without syncing, **Sync now** on either one commits your local changes, merges the remote in, then pushes, and in most cases resolves cleanly because the two machines touched different parts of the wiki. The one case worth knowing: if the same part of the same page was edited on both machines, the merge does not stop to ask — it silently keeps the GitHub version for the conflicting section and drops the local one, while still reporting success. Your pre-merge local version is committed to local git history first, so it is recoverable with a git client. The reliable habit is to sync at the start and the end of every session.

## How do I disconnect sync?

Open **Sync** in the rail footer, scroll to the bottom and click **Disconnect this repository**, then confirm. Your local wiki files stay exactly as they are; only the connection is removed, and your GitHub repository is not changed. You can reconnect any time.

## What is Shared Brain, and how do I join one?

Shared Brain is an opt-in beta, and a different feature from Personal Sync. Personal Sync backs up your full wiki to your own private repository. Shared Brain lets a group of people contribute to one shared wiki without merging private data — an educational cohort, a research team, a company. Solo users do not need it.

| | Personal Sync | Shared Brain |
|---|---|---|
| People | Just you | Many |
| What is synced | Your full wiki | Only the domains you opt in |
| Repository | Yours | The cohort's |
| Direction | Both ways | Push to contribute, Pull to mirror |
| What appears in your app | Your own pages | A new `shared-<slug>` domain, read-only |

**Two primitives that are easy to confuse.** An **invite token**, starting `sbi_`, is created once by the admin, contains metadata only — repository, brain name, branch, folder — grants no access at all, and is safe to share with the whole cohort over Slack or email. A **Personal Access Token**, starting `github_pat_`, is a GitHub credential and is your identity: each contributor creates their own and shares it with nobody. The admin never shares theirs.

**To join.** Open the **Shared Brain** section of any domain's page and press through to the full Shared Brain view (through version 3.63.0 it was a rail item of its own). On a fresh install it says "Shared Brain is off on this install" — click **Enable Shared Brain (beta)**. Turning it on connects you to nothing; it only unlocks the view. Then choose **I have an invite token → Join**, paste the token your admin sent, and create your own GitHub Personal Access Token when the wizard asks. Invite tokens are GitHub-only; a token describing any other backend is refused at the first step with an explanation.

**To start one.** Choose **I'm starting a new Shared Brain → Set up** and follow the wizard. The admin token it shows you is shown once and never again, so save it then.

Each brain appears as a card in the Shared Brain view with **Push contributions** and **Pull updates** buttons and at-a-glance state: how many pages are ready to push, when the collective was last synthesised, and any pages skipped after repeated failures with a one-click retry. An **Advanced** area on each card holds the admin tools — generate or rotate an admin token, run synthesis, revoke a contributor — and **Leave**.

A brain you join arrives in **Domains** as a `shared-<slug>` domain marked **RO**, read-only. You can read it and chat with it like any other domain, but you cannot ingest into it, compile into it or fix its health, because the next Pull would overwrite whatever you changed. Fix things in the personal domain you contribute from, then push.

Shared Brain pushes are managed in the Shared Brain view, not in Sync. The Sync view only reports them, with an **Open** button that brings you back.

## How do I connect The Curator to Claude Desktop?

The MCP bridge lets an AI client read and write your wiki directly. Setup takes under two minutes and lives in **Settings → MCP bridge**.

| Step | What to do |
|---|---|
| 1 | Click **Set up Claude Desktop**. If a bridge is already connected the same button reads **Re-run setup**, or **Re-connect**. |
| 2 | Wizard step 1, *Copy the Curator entry*: choose **Just the Curator entry**, which is safe if you already run other MCP servers, or **The whole file, with Curator added**. Click **Copy the Curator entry & continue →**. |
| 3 | Wizard step 2, *Paste it into Claude Desktop's config*: click **Show it in Finder** to open the folder containing `claude_desktop_config.json`. **Copy the path** is there too, and where it can do so safely the wizard offers **Write it for me**. |
| 4 | Open that file in any text editor. If it does not exist, create one containing just `{}`. Paste the snippet inside the `mcpServers` key — the wizard shows you what "before" and "after" look like — save, and click **I've saved the file →**. |
| 5 | Wizard step 3, *Restart Claude Desktop, then check it*: fully quit and reopen Claude Desktop, Command-Q, because closing the window is not enough. Then click **Test the bridge**. **Re-read the config file** separately checks what Claude Desktop now has saved. |
| 6 | Close the wizard. The section shows a green **Connected** line, and **Run self-test** re-runs the check any time. **View config** and **Copy snippet** sit alongside it. |

If your `claude_desktop_config.json` already exists but contains a JSON syntax error, the wizard will not show an "After" preview and the copy button on that pane disappears. That is deliberate: a file that cannot be parsed cannot be merged into, and the only payload the app could invent would contain the Curator entry alone, which would delete every other MCP server you have configured. Fix the syntax error first. The entry-only **Copy snippet** is unaffected.

The same section holds **Default domain for MCP writes**. Pick a domain, or leave it on "— none (require an explicit domain) —". If it is unset, the AI must ask you which domain to write to every time, which is the safer default for multi-domain users.

The bridge works with any MCP client that runs local servers — Claude Desktop, Claude Code, Cursor and others. ChatGPT's web app cannot run a local server, so it cannot connect.

The bridge itself costs you nothing in API fees. It is a local bridge to your own markdown files and never calls an AI model. The frontier model you connect to it bills you on its own plan.

If you move your knowledge folder, re-run the wizard in the browser install — the entry names an absolute path, and the wizard detects a stale one and shows a banner. In the Mac app the bridge starts through a launcher the app writes for itself, so moving the folder no longer makes the entry go stale.

## What does the MCP bridge's tool map show?

**Settings → MCP bridge**, below the setup wizard and the default domain, is a small local log of
what your agents have actually done over the bridge — kept on your machine only, never synced,
never uploaded. Each line records a tool's name, the domain it touched, whether the call
succeeded, and how long it took. It never records what you asked or what came back.

Tools are shown in two groups, read and write, each with a freshness dot and word for when it was
last called, and a **writes** chip on the tools that can change something on disk. A tool that has
never been called reads "not used since this log began" with the log's own age, rather than
"never" — the log rotates once it passes 1 MB, so it always has a start date, and a silent tool
might simply predate it.

Two readings above the tiles speak to your agent's habits: **Last session start** is the last time
a session opened by reading where things stood, and **Last save** is the last time one wrote a
handoff before stopping.

**Since version 3.66.0** the tool map also shows **Busiest · last 7 days · agents only** — up to eight tools your agents called most, each drawn as a depth bar scaled to the busiest one and named as such ("8 calls · bar scaled to get_project_context's 151"); when the usage log is younger than a week, the heading, the note and each tile's *uses · N days* state the span it really covers ("last 5 days — the log begins 20 Sep", since v3.76.0). A run of *Test all N tools* is excluded from this count, though it still counts in a tile's own *uses* — and a fourth block, **Across projects**: one line per project, the dot in that domain's own colour, the figure how many of the project's **agent connections** saved a handoff in the window the log actually covers (worded "last 30 days," or "last N days — the log begins `<date>`" when the log is younger than that), against the busiest project, with a **Saves by tool** breakdown underneath as its own reading (since v3.74.0; since v3.76.0 the connections' window note sits under the connections, and the saves — counted from the handoff journals over 7 days — have their own; one line per normalised tool, "at least N" when a count is a floor, "none · last seen `<date>`" for a tool with nothing in the window). **A connection is one MCP bridge process, not a conversation** — Claude Desktop can hold many conversations inside one connection — so this is not a count of chats. With no usage log on this computer, the block says so instead of drawing zeros.

## What is in Settings?

**Settings** is the gear icon at the bottom of the rail. Its sections are listed in the panel beside it, ordered by how often you come back to them.

| Section | What is in it |
|---|---|
| **General** | **Software update**, first on the page. Then **Appearance** (Dark / Light), **Text size** (four steps from compact to largest), **Menu bar**. Then **System check**, then **Show setup guide**. |
| **Providers & keys** | Four numbered steps: connect a provider, choose what builds your wiki, read which model chat starts on, browse the whole catalogue. |
| **Knowledge base** | Where your `domains/` folder lives, with **Choose folder** and **Copy**; your Obsidian vault folder; and, since version 3.65.2, a **GitHub read-only token** field — see the next question. |
| **MCP bridge** | The setup wizard, **Run self-test**, **View config**, **Copy snippet**, the default write domain, the tool map, and a note naming any bridge process still running older code. |
| **Health & scan limits** | Cost ceilings and candidate-pair caps for the AI health scans. |

Since version 3.65.0 an **Updates** button sits at the TOP of that sidebar, under the title, and switches to General and runs the check; the version — for example `The Curator v3.68.0` — sits alone at the foot of the list, because a version string is a reading and not an action.

**Since version 3.67.0, Providers & keys' second block is "Your AI model"** — the one model every AI job runs on: ingest, compile, wiki health, Shared Brain and reading plans. Its **Used by** row lists each of those jobs, where you start it, and whether its cost is shown yet (a job whose cost reporting has not shipped reads "not yet"). Chat is separate — you still pick any connected model per message, in the composer.

The theme switch in the rail footer and the **Appearance** control in General are the same setting and stay in step. Text size applies across the whole app, including button and text-box labels, and is remembered in this browser; control heights and icons deliberately stay put so buttons do not grow into each other.

The app honours your operating system's **Reduce motion** setting. Movement is removed and the shade change on a press stays, so every control still confirms your click. Two things keep animating on purpose: the ingest progress ring, because it is the only sign a paid multi-minute write is still running, and the accent bar marking your place in a list, because it is a position marker rather than an animation.

## How do I add a GitHub read-only token, for mirroring documents?

**Settings → Knowledge base → GitHub read-only token.** This is the credential a project's Documents step reads with when you press **Add from GitHub** (since version 3.68.0; through v3.67.x it was a separate "Mirror from GitHub" control) instead of adding documents from this computer. Paste a token and press Save; the field then shows only its last four characters, never the value again. **Test** reads one repository with the saved token, to confirm it can see it, before you rely on it. **Disconnect** removes it.

**Creating the token.** In GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token. Resource owner: the account or organisation that owns the repository. Repository access: only the repository or repositories you want to mirror — several can share one token. Permissions, repository permissions: Contents, Read-only; metadata read-only is added automatically, nothing else is needed. Fine-grained tokens require an expiry of up to a year — set a reminder to renew it.

A classic token (`ghp_…`) also works, but it can read every repository your account owns, not just the ones you intend to mirror — which is why a fine-grained token is recommended, and why Personal Sync's own token (used for push, not for a read-only mirror) is never the default.

**Choosing which saved token to read with, since version 3.65.3.** When a project's Documents step opens the **Add from GitHub** checklist, a **READ WITH** control offers up to two saved tokens, each named by where it lives: the read-only token above (shown by its last four characters) and Personal Sync's own token (which, if it is a classic token, can read every repository its account can see — which is why it is never the default). Whichever a read-only token is saved, it is selected automatically; when none is saved, nothing is selected and **Add one in Settings** takes you to this field. Nothing ever falls back to Personal Sync's token without you pressing it.

## How do I check that everything is working?

**Settings → General → System check**.

**Run system check** is free and instant. It makes no network call, costs nothing, and never touches your wiki content. It checks your installed version; which install you are running and how updates reach it; whether an AI key is configured; that your knowledge folder is writable; that your credential files are locked down at `0600`; whether `git` is available; your sync status; and your application log file. Each row reads OK, needs attention, failed or info.

**Verify AI connection** makes one tiny real request to your provider. Since version 3.67.0 its confirm no longer shows a fixed placeholder price — it names the model that will run and the estimated real cost before anything runs, the same "Runs on … · ≈cost" line every other AI action shows. With no provider key the button is disabled and says why. On success it reports the provider, the model and the response time; on failure it reports the exact error, so you can tell a bad key from a provider outage in one click.

One gap worth knowing: in the Mac app the **Git** row reports "Not required by this build" and does not warn you if `git` is missing — but Personal Sync still needs `git`.

System check answers "is the app working?". A domain's **Wiki health** panel answers "is my wiki clean?". They are different things.

## How do I turn on the Mac menu bar icon?

**Settings → General → Menu bar**, with three choices: **Off**, which is the default; **On**, which puts a small icon in the macOS menu bar alongside your Dock icon; and **On, and hide the Dock icon**. It takes effect immediately with nothing to restart. It applies to the Mac app only, and the control says so in a browser install rather than hiding itself.

The icon answers one question in about a second without leaving what you are doing: whether your agent has actually written its handoff, and how long ago. What each row in its menu means belongs to the agent memory material, not here.

**Since version 3.74.0 ("Layout A")** the menu leads with a **pulse strip** (saves over the last 7 days, with a **Saves by tool** submenu, one strip per tool), then an **Active · last 24 h** section — one row per project and harness that saved in that window, each with the app's own freshness dot (filled hot with a halo under a minute, filled hot under an hour, filled mid under a day, filled cold under a week, hollow cold beyond that) in place of the old pie-chart glyph, and up to five projects shown before an **"+N more active projects"** line. Notices (stale docs, two tools writing one handoff, a GitHub handoff waiting, another machine's newer save) sit directly under the Active rows. Below that, **Idle · N projects** and **Knowledge · N domains** each fold into a submenu — the domains one still drawing each domain's page-count bar against the largest domain, in that domain's own colour. **Dropped from this release: the "Working on" headline, the "Session start" line, the documents line, and the "N of M saved" bars** — those bars counted MCP bridge connections, not real sessions, and are gone for that reason; the app's own Context screen still shows the fuller picture.

**"On, and hide the Dock icon" does not hide the Dock icon yet.** The setting is remembered and the app deliberately does the safe half of it, because the macOS call that hides a Dock icon has a return path that is reported broken and could not be tested.

If you turn it on and nothing appears, three separate things can swallow a new menu bar icon on a modern Mac and macOS gives the app no way to find out which, so check all three: it may be pushed off the edge behind the notch — quit some other menu bar apps and look again; a menu bar organiser such as Bartender or Ice may have filed it into a hidden section; or the menu bar items permission in System Settings → Privacy & Security may be withholding it.

## Why does the Mac app open completely empty?

That is the expected first-launch state, not a fault. The app never goes looking for a wiki you already have; it starts empty and waits for you to say where yours is. Go to **Settings → Knowledge base** and point it at your existing `domains/` folder — everything appears at once. Nothing is copied, moved or converted.

## Why does it say "The Curator is already running"?

One copy at a time, on purpose. The existing window is brought forward — check your other Spaces, or click the Dock icon. Closing the window with Command-W or the red button only hides it; the app is still running. To actually stop it, quit with Command-Q.

## Why does my agent see old tools, or miss a new one?

Because it is still talking to a bridge it started before you updated. An MCP client launches the bridge as a child process and keeps it alive until the client itself is restarted, so a bridge started last week carries on serving the tools it was launched with, whatever is now on disk. Measured on one machine: a bridge running for two days across five updates, offering 22 tools while the files beside it offered 24. **Settings → MCP bridge** reports any it finds, with how old it is and the remedy — restart the app that launched it, usually Claude Desktop. Nothing in The Curator can restart it for you, because the process belongs to the client. The self-test cannot see it either: it spawns a fresh bridge, which is why it passes while your agent is served by the old one.

## Why can't Claude Desktop see the MCP tools after I set it up from the Mac app?

The most likely cause is App Translocation: macOS runs an unsigned app that is still sitting where it was downloaded from a randomised read-only location, and from there the app cannot write the small launcher Claude Desktop needs. Drag The Curator into `/Applications` — the disk image includes a shortcut for exactly this — then quit and reopen it, then re-run **Settings → MCP bridge**. Running the app straight out of `~/Downloads` has the same problem for the same reason.

## Why does Personal Sync fail in the Mac app with a git error?

Personal Sync uses `git` and the app does not bundle one. On a Mac that has never had developer tools installed there may not be one. Run `xcode-select --install` in Terminal once, then try Sync again. The Git row in System check does not warn you about this in the Mac app.

## Why do I get "command not found: node"?

Node.js is not installed, or your terminal cannot find it. Install the LTS version from nodejs.org and then close and reopen your terminal. This applies to the browser install only; the Mac app bundles its own runtime.

## Why does "No LLM API key found" appear when I start the server?

No API key is configured. Open the app and use **Settings → Providers & keys → Add key → Save**; the Getting started panel links you straight there. If you prefer a file, check that `.env` exists in the `the-curator` folder with `GEMINI_API_KEY=your_key_here`.

## Why does localhost:3333 say "This site can't be reached"?

The server stopped or crashed. Go back to your terminal and run `node src/server.js` again. If you use the Dock launcher, click it again.

## Why does it say "Port 3333 is already in use"?

Browser install only; the Mac app picks a free address each launch and cannot hit this. Another process is using port 3333. Close that process, or set `PORT=4000` in your `.env` file, restart the server and use http://localhost:4000 instead.

## Why did the app stop working when I closed the terminal?

If you are running the server manually from Terminal, the server stops when the terminal closes. Open a new terminal, `cd the-curator`, and run `node src/server.js`. If you use the Dock launcher instead this is handled for you — just click the icon.

## Why does clicking the Dock icon give me "The Curator could not start"?

Browser install with the macOS Dock launcher only. Check the log with `cat "$HOME/Library/Logs/The Curator/curator.log"`, or, if the app never started at all, `cat /tmp/the-curator.log`. The most common cause is `nohup: node: No such file or directory`, which means Node.js was upgraded or moved since the app was built. Rebuild it with `cd ~/the-curator && bash scripts/build-app.sh`, then click the Dock icon again.

## Why does the app open to a blank page or say "could not finish loading"?

Rare, and usually an update where a file did not download completely. Your knowledge is not affected — every page is a plain markdown file on your disk, and you can open your domains folder in Obsidian or a text editor while the app is broken. Reload the page first; a partly-downloaded file usually fixes itself. If it keeps happening, quit The Curator and open it again. If it still fails, report the error shown at the bottom of the panel.

## Why does "Updates" say there is a new version but show no install button?

Three different causes that look the same. You are running an older Mac app build with no updater engine attached, in which case you see "Open the download page" instead of **Download and install** — use the link. Or your local build is newer than the published one, in which case no install button is offered on purpose, because installing would discard your newer commit. Or the update itself failed with a `git` or `npm` error, which the banner names; run `git pull && npm install` by hand to see the full message.

## Why does an ingest spin for a long time and then fail?

Check your internet connection, since the app needs to reach the provider's API. Check that your key is still valid in the provider's console. Try a smaller file first to confirm the setup works. If the failure mentions `log.md`, your pages were written safely and only the last step — recording the ingest in the domain's log file — failed because that file is missing; this only happens on a domain whose folders were created by hand. Create an empty `domains/<your-domain>/wiki/log.md` and re-ingest.

## Why do I get 429 or "Rate limit exceeded" during ingest?

You are on Gemini's free tier and have hit a per-minute or daily quota. Either wait for the limits to reset, spread your ingests across days, or enable billing in Google AI Studio to move to the paid tier. The paid tier is still very cheap.

## What will this cost me in practice?

Ingest is where the money goes. Chat is a fraction of it, the structural Wiki health scan is free, and the MCP bridge costs nothing.

A heavy solo month on Gemini Flash Lite — about 50 articles of ten pages or more, plus daily chat — came to roughly 5 euros, which is about 10 cents an article. Most casual users pay between 1 and 3 euros a month. The same workload on Anthropic Haiku 4.5 would be roughly 40 to 60 euros, because Anthropic is about 10 times the input cost and 12 and a half times the output cost.

Practical guidance: start on the Gemini free tier to decide whether the app is for you, and enable billing in Google AI Studio as soon as you want to ingest a batch or a book. Set a budget alert on your Google Cloud project. Do not worry about chat cost — multi-turn conversations on a 2,000-page wiki cost cents. Use Anthropic only if you specifically need it.

The overview file in this knowledge base carries the full per-model price table.
