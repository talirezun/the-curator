// Every explainer's COPY, in one file (v3.71.0). Pure data: no imports, no DOM.
//
// ── WHAT AN EXPLAINER IS ──────────────────────────────────────────────────
//
// The body of an ⓘ panel, written for someone who has never read the guide
// and never will. It answers three questions in order: what is this, what do
// I do here, where does it sit in the whole. Anything longer is in the user
// guide, one click away, through the link card every entry carries.
//
// shared/explainer.js renders these; scripts/test-explainers.js enforces the
// model over EVERY entry, so the rules below are checked, not hoped for:
//
//   lead    ≤ 20 words, at most two sentences, starts with the thing itself
//   points  0–3, each ≤ 12 words, one icon each (a name in explainer.js's
//           glyph table)
//   try     optional, ≤ 14 words — a sentence naming a control on the page
//   visual  optional, one of frame · flow · meter · table · steps
//   guide   required — { key: a DOCS_LINKS key, heading: the section's
//           heading as the guide prints it, minus any leading "12. " }
//   total   ≤ 90 words (lead + points + try + the words of a table / steps /
//           flow). The frame and the meter are the KIT's fixed drawings —
//           the same words in every entry — so they are not charged to one.
//
// Banned in copy (case-insensitive, test-enforced): internals (state/, .md,
// manifest, slug, scope, tier, checksum, JSON, bytes, endpoint, route, store,
// bridge process, provenance, supersede, accumulate, verbatim, canonical,
// foundations, working state, capture, tokenizer, synthesis, SHA, a version
// number, a function_name( ) — a warning, cost or outcome (warning, cost, $,
// refused, error, failed, danger) — and state-dependent wording (yet,
// "nothing has been", "Start here"). An explainer reads true in every state.
//
// MICRO-MARKUP, AND NOTHING ELSE: `**screen word**` renders <b>, `` `typed` ``
// renders <code>. Everything is escaped FIRST, so this file can never inject
// markup. A bold word must be a word the screen shows (the test holds the
// list); code is only for something the user types.
//
// `title` is the name in the panel's head (the thing, as the screen names
// it); `label` is the ⓘ button's accessible name.

const E = {
  // ── Context (views/memory.js) ──────────────────────────────────────────
  'context.page': {
    label: 'About Project context',
    title: 'Project context',
    lead: 'This page is your agents’ memory for one project: what they read first, and where work stopped.',
    visual: { type: 'frame', here: 'agent-memory' },
    points: [
      { icon: 'layers', text: 'Four steps, top to bottom, add up to what an agent gets.' },
      { icon: 'pencil', text: 'You write **the brief** and choose the **Documents**.' },
      { icon: 'agent', text: 'Your agents save **Handoffs** and the **Journal** as they work.' },
    ],
    try: 'Press **Copy agent instructions** and paste it into your agent once.',
    guide: { key: 'context.page', heading: 'Project context — what the screen shows' },
  },

  'context.overview': {
    label: 'About the readings on this page',
    title: 'Overview',
    lead: 'Five readings, one per part of this page. Press one to jump to its step.',
    visual: {
      type: 'table',
      caption: 'The five readings',
      rows: [
        ['DOCUMENTS', 'how many, and whether they’re current'],
        ['MEMORY', 'when an agent last saved'],
        ['KNOWLEDGE', 'pages in the domains it searches'],
        ['AGENT SESSIONS', 'did agents read first, and save?'],
        ['SESSION START', 'what an agent starts with'],
      ],
    },
    points: [
      { icon: 'clock', text: 'Times are when the agent saved, or when the file arrived here.' },
      { icon: 'dot', text: 'A dot shows a real check; a dashed ring shows none.' },
    ],
    guide: { key: 'context.overview', heading: 'The freshness dot, one scale everywhere' },
  },

  'context.documents': {
    label: 'About Documents',
    title: 'Documents',
    lead: '**Documents** are the files your agents read word for word: your decisions, conventions and plans.',
    visual: {
      type: 'table',
      caption: 'The three start states',
      rows: [
        ['read first', 'handed over at every start'],
        ['on request', 'listed; opened by name when needed'],
        ['not at start', 'kept, but not listed'],
      ],
    },
    points: [
      { icon: 'folder', text: 'Add them from this computer or GitHub, or write one here.' },
      { icon: 'refresh', text: 'A **mirrored** document follows its original; change it there.' },
      { icon: 'pencil', text: 'Documents you write or copy in are yours to edit here.' },
    ],
    try: 'Mark one or two documents **read first** — most projects need no more.',
    guide: { key: 'context.documents', heading: 'Documents — the files that travel with a project' },
  },

  'context.memory': {
    label: 'About Memory',
    title: 'Memory',
    lead: '**Memory** is where the last session stopped, plus your standing instructions. Each save replaces the last.',
    visual: {
      type: 'table',
      caption: 'What Memory holds',
      head: ['', 'Who writes it', 'What it holds'],
      rows: [
        ['The brief', { icon: 'pencil', text: 'you' }, 'your goal and firm decisions'],
        ['Handoffs', { icon: 'agent', text: 'agents' }, 'where each piece of work stopped'],
        ['Journal', { icon: 'agent', text: 'agents' }, 'one line per save; only grows'],
        ['Agent sessions', { icon: 'search', text: 'a reading' }, 'did agents read first, and save?'],
      ],
    },
    points: [
      { icon: 'computer', text: 'Each computer keeps its own Handoffs, so syncing never overwrites them.' },
      { icon: 'search', text: '**Agent sessions** counts agents that connected through the MCP tools.' },
    ],
    guide: { key: 'context.memory', heading: 'Memory — the brief, Handoffs and the Journal' },
  },

  'context.knowledge': {
    label: 'About Knowledge',
    title: 'Knowledge',
    lead: '**Knowledge** is the wiki your agents search when a task needs it. None of it loads at the start.',
    points: [
      { icon: 'grow', text: 'A domain grows: each new source deepens the pages already there.' },
      { icon: 'search', text: 'Agents search it by topic; they never read it all.' },
      { icon: 'folder', text: 'This project’s own domain stays chosen, even after you add others.' },
    ],
    guide: { key: 'context.knowledge', heading: 'The three layers, and the one rule that separates them' },
  },

  'context.session-start': {
    label: 'About Session start',
    title: 'Session start',
    lead: 'What an agent is handed the moment it starts: **the brief**, the latest Handoff, and **read first** documents.',
    visual: { type: 'meter' },
    points: [
      { icon: 'window', text: '**Window** — how much your model can hold. Set per computer.' },
      { icon: 'gauge', text: '**Reading budget** — the most The Curator sends. Standard suits most.' },
      { icon: 'harness', text: '**Harness** — your agent’s own setup, estimated. See `/context` in Claude Code.' },
    ],
    try: 'In **Documents at start**, change a start state — the meter previews it.',
    guide: { key: 'context.session-start', heading: 'Session start and the context window' },
  },

  'context.drafting-request': {
    label: 'About the drafting request',
    title: 'The drafting request',
    lead: 'Copies one sentence that asks your agent to draft this project’s Documents from its own code.',
    points: [
      { icon: 'agent', text: 'Your agent writes the drafts; The Curator sends nothing to a model.' },
      { icon: 'check', text: 'Nothing is kept until you approve each document.' },
    ],
    try: 'Paste it into Claude Code, Claude Desktop or Cursor.',
    guide: { key: 'memory.foundations-edit', heading: 'Start a project' },
  },

  'context.read-with': {
    label: 'How to create a read-only token',
    title: 'A read-only token',
    lead: 'A GitHub token that can only read the repositories you pick. You create it once.',
    visual: {
      type: 'steps',
      caption: 'Create the token on GitHub',
      steps: [
        'GitHub → Settings → Developer settings → Fine-grained tokens',
        'Repository access: Only select repositories',
        'Permissions → Contents: Read-only',
        'Choose an expiry, and note when to renew',
      ],
    },
    points: [
      { icon: 'lock', text: 'Save it in Settings → Knowledge base; it is never typed here.' },
    ],
    guide: { key: 'settings.github-token', heading: 'GitHub read-only token' },
  },

  // ── Framing tops and the gaps (P4 adopts these) ─────────────────────────
  'onboarding.frame': {
    label: 'How The Curator fits together',
    title: 'How it fits together',
    lead: 'Build a second brain from what you read, share it with a team, and give it to your agents.',
    visual: { type: 'frame' },
    points: [
      { icon: 'file', text: 'Start with one door; the other works whenever you want it.' },
      { icon: 'folder', text: 'Everything is plain files in one folder on this computer.' },
      { icon: 'agent', text: 'Agents need no AI key here — ingest and Chat do.' },
    ],
    guide: { key: 'app.what-is-this', heading: 'What is this app?' },
  },

  'domains.page': {
    label: 'About Domains',
    title: 'Domains',
    lead: 'A **domain** is one subject you read about. Everything you add to it becomes one growing wiki.',
    visual: { type: 'frame', here: 'second-brain' },
    points: [
      { icon: 'grow', text: 'New sources deepen the pages already there, not copy them.' },
      { icon: 'agent', text: '**Projects** inside a domain give your agents memory.' },
      { icon: 'folder', text: 'Pages are plain files — Obsidian opens the same folder.' },
    ],
    try: 'Press **New domain**, then drop a PDF into **Ingest**.',
    guide: { key: 'domains.page', heading: 'Manage your domains' },
  },

  // The domain-page header on a read-only Shared Brain mirror (COPY.md §3:
  // "keeps its own lead instead of the domain lead … same frame visual with
  // here: shared-brain"). COPY.md names only the lead; the two points are
  // shared.page's own, both true on a mirror, so no new claim is introduced.
  'domains.page-mirror': {
    label: 'About this Shared Brain',
    title: 'Shared Brain',
    lead: 'A read-only copy of your team’s Shared Brain. **Pull** brings in their latest pages.',
    visual: { type: 'frame', here: 'shared-brain' },
    points: [
      { icon: 'refresh', text: '**Push** sends your changes; **Pull** brings the team’s wiki back.' },
      { icon: 'lock', text: 'The team’s wiki arrives as a read-only domain.' },
    ],
    guide: { key: 'shared.page', heading: 'Shared Brain' },
  },

  'chat.page': {
    label: 'About Chat',
    title: 'Chat',
    lead: 'Ask questions and get answers written from your own wiki pages, with links to them.',
    visual: { type: 'frame', here: 'second-brain' },
    points: [
      { icon: 'search', text: 'The domain chips choose which wikis an answer reads.' },
      { icon: 'pencil', text: '**PROJECT** adds a project’s brief and Documents to the answer.' },
      { icon: 'window', text: '**Length** sets how long answers are; **Model** picks who answers.' },
    ],
    try: 'Ask “What do I know about …?” about something you ingested.',
    guide: { key: 'chat.page', heading: 'Chat with your brain' },
  },

  'domains.pages': {
    label: 'About Pages',
    title: 'Pages',
    lead: 'Every page in this domain’s wiki. Press one to read it.',
    visual: {
      type: 'table',
      caption: 'The three kinds of page',
      rows: [
        ['Entity', 'a person, tool or organisation'],
        ['Concept', 'an idea or method'],
        ['Summary', 'one source, summarised'],
      ],
    },
    points: [
      { icon: 'layers', text: '**Wiki**, **Context** and **All** switch what the list shows.' },
      { icon: 'grow', text: 'Links between pages are what Obsidian draws as the graph.' },
    ],
    guide: { key: 'domains.pages', heading: 'The PAGES lens — Wiki · Context · All' },
  },

  'domains.health': {
    label: 'About Wiki health',
    title: 'Wiki health',
    lead: 'Finds broken links, orphan pages and duplicates in this wiki, and helps you fix them.',
    points: [
      { icon: 'search', text: '**Scan** checks the whole wiki on this computer.' },
      { icon: 'agent', text: 'AI actions use your model; each shows what it costs first.' },
      { icon: 'check', text: 'Nothing changes until you press a fix.' },
    ],
    guide: { key: 'domains.health', heading: 'Wiki Health' },
  },

  'settings.general': {
    label: 'About Settings',
    title: 'Settings',
    lead: 'Set up The Curator here. Start with **Providers & keys** — ingest and Chat need one AI key.',
    visual: { type: 'flow', caption: 'Set up in this order', steps: ['Providers & keys', 'Knowledge base', 'MCP bridge'] },
    points: [
      { icon: 'folder', text: '**Knowledge base** is the folder your wiki lives in.' },
      { icon: 'agent', text: '**MCP bridge** connects Claude Code, Claude Desktop or Cursor.' },
    ],
    guide: { key: 'app.first-run', heading: 'First run — the Getting started panel' },
  },

  'shared.page': {
    label: 'About Shared Brain',
    title: 'Shared Brain',
    lead: 'A **Shared Brain** is one wiki a team writes together. Each person keeps their own domains.',
    visual: { type: 'frame', here: 'shared-brain' },
    points: [
      { icon: 'refresh', text: '**Push** sends your changes; **Pull** brings the team’s wiki back.' },
      { icon: 'lock', text: 'The team’s wiki arrives as a read-only domain.' },
      { icon: 'folder', text: 'It is optional; nothing leaves this computer until you push.' },
    ],
    guide: { key: 'shared.page', heading: 'Shared Brain' },
  },

  // ── v3.71.1: every remaining ⓘ, in the same model ───────────────────────
  //
  // Each entry names, above it, the ⓘ it replaces (view · DOM id). Where one
  // entry serves several marks, or a mark was cut, the note says so. Nothing
  // below claims a count, a state, a cost or an outcome: those stay on the
  // page, unfolded (v3.16.1).

  // ── Domains (views/domains.js) ──────────────────────────────────────────
  // D3 · the domain page's OVERVIEW card — `threeLayersInfoHtml()`.
  'domains.overview': {
    label: 'About this domain’s figures',
    title: 'Overview',
    lead: 'This domain in figures: the wiki pages it holds, and the projects that give agents memory.',
    visual: {
      type: 'table',
      caption: 'Three kinds of context, one folder',
      head: ['', 'What it is', 'How it changes'],
      rows: [
        ['Knowledge', 'the wiki pages ingest writes', 'grows with each source'],
        ['Memory', 'a project’s brief and Handoffs', 'each save replaces the last'],
        ['Documents', 'a project’s decisions and plans', 'read word for word'],
      ],
    },
    points: [
      { icon: 'search', text: 'Press a page type to filter the list below; **PAGES** shows all.' },
      { icon: 'agent', text: '**PROJECTS** jumps to the projects kept in this domain.' },
    ],
    guide: { key: 'domains.three-layers', heading: 'The three kinds of context it carries' },
  },

  // D4 · the domain page's ① Ingest — `dm-ingest-info` (INGEST_INFO); ALSO
  // the Ingest view's own header, replacing the sidebar-title ⓘ
  // `tx-vh-info-ingest-sidebar` (both hint variants), which broke the
  // "no ⓘ on a sidebar title" rule.
  'ingest.page': {
    label: 'About Ingest',
    title: 'Ingest',
    lead: '**Ingest** reads a PDF, Markdown or text file and turns it into pages of your wiki.',
    points: [
      { icon: 'file', text: 'Each source becomes entity, concept and summary pages.' },
      { icon: 'grow', text: 'New sources deepen the pages already there, not copy them.' },
      { icon: 'refresh', text: 'Files run one at a time; a paused batch picks up again.' },
    ],
    try: 'Drop a PDF on the drop zone, or press browse your files.',
    guide: { key: 'ingest.page', heading: 'Ingest a source' },
  },

  // D5 · ③ Projects in this domain — `dm-proj-info` (PROJECTS_INFO_HTML).
  // Its second paragraph (the two copy buttons) is dropped here: each button
  // carries its own ⓘ, below.
  'domains.projects': {
    label: 'About projects',
    title: 'Projects',
    lead: 'A project is one piece of work inside this domain, with its own memory for your agents.',
    points: [
      { icon: 'pencil', text: 'You write **the brief**: the goal and the firm decisions.' },
      { icon: 'agent', text: 'Agents save **Handoffs**, so each session starts where the last stopped.' },
      { icon: 'layers', text: 'Open a project in **Context** to see what an agent gets.' },
    ],
    guide: { key: 'domains.projects', heading: 'Projects inside a domain' },
  },

  // D6 + D9 · every project row's, and the "created" card's, marker ⓘ —
  // `dm-proj-marker-info-*`, `dm-proj-done-marker-info` (MARKER_INFO_TEXT).
  'domains.marker-line': {
    label: 'About Copy marker line',
    title: 'Copy marker line',
    lead: '**Copy marker line** copies one line naming this project, so an agent knows where it is.',
    visual: {
      type: 'steps',
      caption: 'Once per project folder',
      steps: [
        'Press **Copy marker line**',
        'Save it in a file named `.curator-project`',
        'Put that file at the top of the project’s folder',
      ],
    },
    points: [
      { icon: 'agent', text: 'An agent that starts in that folder resumes this project unasked.' },
    ],
    guide: { key: 'domains.marker-line', heading: 'Resuming — the one line to learn' },
  },

  // D7 + D10 · every project row's, and the "created" card's, instructions
  // ⓘ — `dm-proj-agent-info-*`, `dm-proj-done-agent-info` (AGENT_INFO_TEXT).
  'domains.agent-instructions': {
    label: 'About Copy agent instructions',
    title: 'Copy agent instructions',
    lead: '**Copy agent instructions** copies a short paragraph telling your agent to use this project’s memory.',
    points: [
      { icon: 'file', text: 'Paste it into the file your agent loads every session.' },
      { icon: 'agent', text: 'Your agent then reads the project’s memory first, and saves before stopping.' },
    ],
    try: 'Press **Copy agent instructions**, then paste it into your agent’s instructions file.',
    guide: { key: 'domains.agent-instructions', heading: 'Making sure your agent actually does it' },
  },

  // D8 · the New project card — `dm-proj-new-info` (CREATE_INFO_HTML).
  'domains.new-project': {
    label: 'About creating a project',
    title: 'New project',
    lead: '**New project** starts one piece of work in this domain, with memory your agents keep.',
    points: [
      { icon: 'folder', text: 'Use a lowercase name; nothing in the wiki moves or changes.' },
      { icon: 'pencil', text: '**The brief** is optional here; you can write it later in **Context**.' },
      { icon: 'file', text: 'Add **Documents** later, from this computer or from GitHub.' },
    ],
    guide: { key: 'memory.foundations-edit', heading: 'Start a project' },
  },

  // D11 · the create form's Documents chooser — `dm-proj-fnd-info`
  // (FOUNDATIONS_INFO_HTML). Lives only as long as that chooser does; when the
  // form drops it, this entry goes with it.
  'domains.new-project-documents': {
    label: 'About a new project’s Documents',
    title: 'Documents',
    lead: '**Documents** are the files your agents read word for word: your decisions, conventions and plans.',
    points: [
      { icon: 'folder', text: 'Choose where they come from, or press **Decide later**.' },
      { icon: 'refresh', text: 'A **mirrored** document follows its original; change it there.' },
      { icon: 'pencil', text: 'Documents you write or copy in are yours to edit.' },
    ],
    guide: { key: 'context.documents', heading: 'Documents — the files that travel with a project' },
  },

  // D12 · ④ Shared Brain on the domain page — `dm-shared-info`.
  'domains.shared-brain': {
    label: 'About this domain in a Shared Brain',
    title: 'Shared Brain',
    lead: 'This domain can take part in a **Shared Brain**: one wiki a team writes together.',
    visual: {
      type: 'table',
      caption: 'Two ways a domain takes part',
      rows: [
        ['Push', 'sends the pages you changed'],
        ['Pull', 'brings the team’s wiki back, read-only'],
      ],
    },
    points: [
      { icon: 'agent', text: '**Push** summarises your changed pages with your AI model.' },
      { icon: 'lock', text: 'Which domains take part is chosen when you join.' },
      { icon: 'folder', text: 'Nothing leaves this computer until you push.' },
    ],
    guide: { key: 'shared.page', heading: 'Shared Brain' },
  },

  // ── Settings (views/settings.js) ─────────────────────────────────────────
  // SECTION_INFO.providers · the Providers & keys header.
  'settings.providers': {
    label: 'About Providers & keys',
    title: 'Providers & keys',
    lead: '**Providers & keys** connects the AI that builds your wiki and answers your questions.',
    visual: { type: 'flow', caption: 'Four steps, in order', steps: ['Connect a provider', 'Your AI model', 'Chat', 'All models'] },
    points: [
      { icon: 'lock', text: 'Paste a key from Gemini, Anthropic or OpenRouter.' },
      { icon: 'agent', text: '**Your AI model** runs ingest, compile and **Wiki health**.' },
    ],
    guide: { key: 'settings.api-key', heading: 'Get your API key (Gemini, Claude or OpenRouter)' },
  },

  // Block 1 · Connect a provider — `settings-block-info-connect`.
  'settings.connect': {
    label: 'About Connect a provider',
    title: 'Connect a provider',
    lead: '**Connect a provider** by pasting its key. Connect as many providers as you like.',
    points: [
      { icon: 'lock', text: 'The Curator calls the provider directly; your key stays on this computer.' },
      { icon: 'search', text: 'Any connected provider can answer in **Chat** straight away.' },
      { icon: 'agent', text: 'Building your wiki needs a measured model: see **Your AI model**.' },
    ],
    guide: { key: 'settings.connect', heading: '1 · Connect a provider' },
  },

  // Block 2 · Your AI model — `settings-block-info-build`.
  'settings.build': {
    label: 'About Your AI model',
    title: 'Your AI model',
    lead: '**Your AI model** is the one model every AI job uses: ingest, compile, Wiki health and more.',
    points: [
      { icon: 'check', text: 'Nothing to set per job: one choice covers them all.' },
      { icon: 'refresh', text: 'A model from another provider makes that provider the active one.' },
      { icon: 'search', text: '**Chat** is separate: pick any model per message, in the composer.' },
    ],
    guide: { key: 'settings.build', heading: '2 · Your AI model' },
  },

  // Block 3 · Chat — `settings-block-info-chat`.
  'settings.chat': {
    label: 'About Chat models',
    title: 'Chat',
    lead: 'In **Chat**, any model you have connected can answer. Pick one per message, in the composer.',
    points: [
      { icon: 'check', text: 'Your Chat choice never changes the model that builds your wiki.' },
    ],
    guide: { key: 'settings.chat', heading: 'The composer — Length and Model selectors' },
  },

  // Block 4 · All models — `settings-block-info-all`.
  'settings.all-models': {
    label: 'About All models',
    title: 'All models',
    lead: '**All models** lists every model from the providers you connected, with search and filters.',
    points: [
      { icon: 'search', text: 'Every model here can answer in Chat.' },
      { icon: 'check', text: 'A badge marks the ones measured to build your wiki.' },
      { icon: 'file', text: 'Each column is a published fact or a measurement, not advice.' },
    ],
    guide: { key: 'settings.all-models', heading: '4 · All models' },
  },

  // Block 2's measurement badge — `settings-build-chip-info` (was the
  // dynamic `chip.title`). One entry for every badge: a table of all three,
  // so the panel reads true whichever one is showing.
  'settings.measured': {
    label: 'About the measurement badge',
    title: 'Measurement badge',
    lead: 'The badge says whether anyone has measured this model building a wiki.',
    visual: {
      type: 'table',
      caption: 'The three badges',
      rows: [
        ['measured for the build lane', 'tested by The Curator on prose'],
        ['measured on your wiki', 'you tested it on your pages'],
        ['not measured', 'nobody has tested it here'],
      ],
    },
    points: [
      { icon: 'search', text: 'An untested model may be fine; nobody can say how it builds.' },
    ],
    guide: { key: 'settings.measured', heading: 'What a model row tells you' },
  },

  // Every provider's fetched-model lane — `settings-fetched-lane-info-<id>`.
  'settings.fetched-models': {
    label: 'About fetched models',
    title: 'Fetched models',
    lead: 'Fetched models come straight from the provider’s own list, and answer in Chat only.',
    points: [
      { icon: 'search', text: 'The price is published; only a real run shows how it builds.' },
      { icon: 'check', text: 'To build with one, test it on your own pages first.' },
    ],
    try: 'Open **Worth testing for this job** and test one on your wiki.',
    guide: { key: 'settings.fetched-models', heading: 'Test a model on your own wiki' },
  },

  // General · Software update — `settings-block-info-updates` (all three
  // install modes: the words below are true of each).
  'settings.update': {
    label: 'About Software update',
    title: 'Software update',
    lead: '**Software update** installs the newest version of The Curator over this copy.',
    points: [
      { icon: 'lock', text: 'Your wiki, keys and sync settings are never touched.' },
      { icon: 'refresh', text: 'There is one channel: whatever is published right now.' },
    ],
    guide: { key: 'settings.software-update', heading: 'Version and updates' },
  },

  // General · "Going back to an earlier version" — `settings-update-recovery-info`,
  // the git-checkout arm (UPDATE_RECOVERY_INFO).
  'settings.update-recovery': {
    label: 'How to go back to an earlier version',
    title: 'Going back',
    lead: 'Updates only move forward. Going back to an earlier version is a Terminal step.',
    visual: {
      type: 'steps',
      caption: 'In Terminal',
      steps: [
        'Open the app folder, `~/the-curator` by default',
        'Run `git fetch --depth 1 origin tag VERSION`',
        'Run `git checkout VERSION`, then `npm install`',
      ],
    },
    points: [
      { icon: 'search', text: 'VERSION is a tag from the project’s tags page on GitHub.' },
      { icon: 'refresh', text: 'Checking for updates again returns you to the newest version.' },
    ],
    guide: { key: 'settings.update-recovery', heading: 'Going back to an earlier version' },
  },

  // The same mark on a packaged install — UPDATE_RECOVERY_INFO_INSTALLER.
  'settings.update-recovery-installer': {
    label: 'How to go back to an earlier build',
    title: 'Going back',
    lead: 'This copy came from a downloaded installer. Going back means installing an older build.',
    points: [
      { icon: 'search', text: 'Only releases with a download can be reinstalled; see the releases page.' },
      { icon: 'lock', text: 'Your wiki, keys and sync settings live outside the app.' },
    ],
    guide: { key: 'settings.update-recovery-installer', heading: 'Going back to an earlier version' },
  },

  // General · Appearance — `settings-block-info-appearance`.
  'settings.appearance': {
    label: 'About Appearance',
    title: 'Appearance',
    lead: '**Appearance** sets the theme, the text size and the Mac menu bar icon.',
    points: [
      { icon: 'search', text: '**Text size** scales every word; controls and layout keep their size.' },
      { icon: 'computer', text: '**Menu bar** shows what your agents just saved. Mac app only.' },
    ],
    guide: { key: 'settings.text-size', heading: 'Appearance and the setup guide' },
  },

  // General · System check — `settings-block-info-system-check`.
  'settings.system-check': {
    label: 'About System check',
    title: 'System check',
    lead: '**System check** confirms the app is set up. It never opens a wiki page.',
    points: [
      { icon: 'check', text: 'It checks your AI key, the knowledge folder, key files and sync.' },
      { icon: 'search', text: 'To fix broken links or duplicates, use a domain’s **Wiki health**.' },
    ],
    guide: { key: 'settings.system-check-guide', heading: 'System check' },
  },

  // SECTION_INFO.mcp · the MCP bridge header.
  'settings.mcp': {
    label: 'About MCP bridge',
    title: 'MCP bridge',
    lead: 'The **MCP bridge** lets your agents read and write your wiki and your projects’ memory.',
    visual: { type: 'flow', caption: 'Four steps', steps: ['Connect a client', 'Default domain for MCP writes', 'Tool map', 'Across projects'] },
    points: [
      { icon: 'agent', text: 'It works with Claude Code, Claude Desktop and Cursor.' },
      { icon: 'lock', text: 'A read-only Shared Brain domain is never written to.' },
    ],
    guide: { key: 'settings.mcp', heading: 'Three ways to talk to your knowledge (Chat · Obsidian · MCP)' },
  },

  // MCP block 1 · Connect a client — `settings-block-info-mcp-connect`.
  'settings.mcp-connect': {
    label: 'About Connect a client',
    title: 'Connect a client',
    lead: '**Connect a client** sets up one agent app to use your wiki. Do it once per app.',
    points: [
      { icon: 'computer', text: 'The Curator need not be running; your agent app starts the bridge.' },
      { icon: 'refresh', text: 'Run it again if the knowledge folder or the app moves.' },
      { icon: 'search', text: 'ChatGPT’s web app cannot connect: it cannot run local servers.' },
    ],
    guide: { key: 'settings.mcp-connect', heading: 'MCP bridge — connect a client' },
  },

  // MCP block 2 · Default domain for MCP writes — `settings-block-info-mcp-domain`.
  'settings.mcp-domain': {
    label: 'About Default domain for MCP writes',
    title: 'Default domain',
    lead: '**Default domain for MCP writes** is where an agent saves when it names no domain.',
    points: [
      { icon: 'check', text: 'Left unset, each agent must name a domain: safest with several.' },
    ],
    guide: { key: 'settings.mcp-default-domain', heading: 'Default domain for MCP writes' },
  },

  // MCP block 3 · Tool map — `settings-block-info-mcp-tool-map`.
  'settings.mcp-tool-map': {
    label: 'About Tool map',
    title: 'Tool map',
    lead: 'The **Tool map** shows which tools your agents used, and when. It stays on this computer.',
    points: [
      { icon: 'lock', text: 'It keeps tool names and times, never what agents read or wrote.' },
      { icon: 'computer', text: 'It is never synced; deleting it only restarts the map.' },
      { icon: 'check', text: 'A test run from this page never counts as a session.' },
    ],
    guide: { key: 'settings.mcp-tool-map', heading: 'The tool map — what your agents used' },
  },

  // MCP block 4 · Across projects — `settings-block-info-mcp-across`.
  'settings.mcp-across': {
    label: 'About Across projects',
    title: 'Across projects',
    lead: '**Across projects** shows which projects’ agent sessions saved a Handoff in the last 30 days.',
    points: [
      { icon: 'agent', text: 'A session is one run of an agent through the MCP bridge.' },
      { icon: 'search', text: 'A project that never saves reads 0, so gaps stand out.' },
      { icon: 'clock', text: 'The last line counts every save in the last 7 days.' },
    ],
    guide: { key: 'settings.mcp-tool-map', heading: 'The tool map — what your agents used' },
  },

  // SECTION_INFO.health · the Health & scan limits header. ALSO replaces the
  // one block's own ⓘ (`settings-block-info-health-limits`): the section holds
  // that block alone, and the two said the same thing.
  'settings.health': {
    label: 'About Health & scan limits',
    title: 'Health & scan limits',
    lead: 'Limits for the AI duplicate scan you run from a domain’s **Wiki health**.',
    points: [
      { icon: 'gauge', text: 'The first limit caps how many tokens one scan may use.' },
      { icon: 'search', text: '**Maximum candidate pairs per scan** caps the pairs the model checks.' },
      { icon: 'check', text: 'The free structural scan is never limited here.' },
    ],
    guide: { key: 'settings.health', heading: 'Health & scan limits' },
  },

  // SECTION_INFO.storage · the Knowledge base header.
  'settings.storage': {
    label: 'About Knowledge base',
    title: 'Knowledge base',
    lead: 'The **Knowledge base** is the folder on this computer that holds every domain you have.',
    points: [
      { icon: 'folder', text: '**Vault folder** — where your wiki lives. Obsidian opens it too.' },
      { icon: 'repo', text: '**GitHub read-only token** — lets Documents mirror from GitHub.' },
    ],
    guide: { key: 'settings.knowledge-base', heading: 'Knowledge base folder' },
  },

  // Knowledge base · Vault folder — `settings-block-info-storage-folder`.
  'settings.vault-folder': {
    label: 'About Vault folder',
    title: 'Vault folder',
    lead: 'The **Vault folder** holds every domain as plain files, with no database behind them.',
    points: [
      { icon: 'folder', text: 'In Obsidian, use Open folder as vault to see the graph.' },
      { icon: 'refresh', text: '**Choose folder** points The Curator elsewhere; it moves nothing itself.' },
    ],
    guide: { key: 'settings.knowledge-base', heading: 'Knowledge base folder' },
  },

  // Knowledge base · GitHub read-only token — `settings-block-info-storage-github-token`.
  // The same four steps as context.read-with; the points differ, because
  // this IS the place the token is typed.
  'settings.github-token': {
    label: 'About the GitHub read-only token',
    title: 'GitHub read-only token',
    lead: 'A GitHub token that can only read the repositories you pick, so Documents can mirror them.',
    visual: {
      type: 'steps',
      caption: 'Create the token on GitHub',
      steps: [
        'GitHub → Settings → Developer settings → Fine-grained tokens',
        'Repository access: Only select repositories',
        'Permissions → Contents: Read-only',
        'Choose an expiry, and note when to renew',
      ],
    },
    points: [
      { icon: 'lock', text: 'It stays on this computer and is never shown again.' },
      { icon: 'check', text: 'Press **Test** to try one read of a repository.' },
    ],
    guide: { key: 'settings.github-token', heading: 'GitHub read-only token' },
  },

  // ── Shared Brain (views/shared.js, views/shared-brain-wizard.js) ─────────
  // "Shared Brain is off on this install" — `sb-enable-info`.
  'shared.enable': {
    label: 'What enabling does',
    title: 'Turning it on',
    lead: 'Turning **Shared Brain** on only unlocks this section. By itself it connects you to nothing.',
    points: [
      { icon: 'folder', text: 'Nothing leaves this computer until you push a domain.' },
    ],
    guide: { key: 'shared.getting-started', heading: 'Getting started' },
  },

  // Each connection's Access token row — `sb-sec-token-info-<id>`.
  'shared.token-check': {
    label: 'Why check the token',
    title: 'Access token',
    lead: 'The **Access token** is the GitHub token you pasted when you joined. **Check now** tests it.',
    points: [
      { icon: 'clock', text: 'Fine-grained tokens expire on the date you chose.' },
      { icon: 'search', text: 'The check reads the team’s records; it uses no AI.' },
    ],
    guide: { key: 'shared.security', heading: 'The two-primitives security model (read this before you start)' },
  },

  // Wizard, admin step 1 — `sbw-admin-repo-info`.
  'shared.wizard-repo': {
    label: 'What a repository and a collaborator are',
    title: 'Repository and collaborators',
    lead: 'A repository is a folder GitHub keeps for you, with the history of every change.',
    points: [
      { icon: 'repo', text: 'Any name works; you paste its full name below.' },
      { icon: 'pencil', text: 'Adding someone as a collaborator lets them write to it.' },
      { icon: 'file', text: 'The brain name is the label every member sees.' },
    ],
    guide: { key: 'shared.getting-started', heading: 'Getting started' },
  },

  // Wizard step 3 — `sbw-pat-info`.
  'shared.wizard-token': {
    label: 'What this token is',
    title: 'Your GitHub token',
    lead: 'A GitHub token is a password-like key that lets The Curator read and write the team’s repository.',
    points: [
      { icon: 'lock', text: 'It is yours alone; nobody else in the team sees it.' },
      { icon: 'pencil', text: 'It marks which contributions are yours.' },
      { icon: 'check', text: 'Checking it proves the repository exists and you can write to it.' },
    ],
    guide: { key: 'shared.security', heading: 'The two-primitives security model (read this before you start)' },
  },

  // Wizard step 4 — `sbw-attribution-info`.
  'shared.wizard-attribution': {
    label: 'What name attribution changes',
    title: 'Name attribution',
    lead: 'Name attribution decides whether your name is stored with your contributions. It is off by default.',
    points: [
      { icon: 'lock', text: 'Pages credit a short random ID either way.' },
      { icon: 'search', text: 'Everyone with access to the repository can read those records.' },
    ],
    guide: { key: 'shared.attribution', heading: 'Step 4 — Domains + display name + attribution' },
  },

  // ── Sync (views/sync.js) ─────────────────────────────────────────────────
  // The main header — `tx-vh-info-sync`. ALSO replaces the sidebar-title ⓘ
  // (`tx-vh-info-sync-sidebar`), which broke the no-ⓘ-on-a-sidebar-title rule.
  'sync.page': {
    label: 'About Sync',
    title: 'Sync',
    lead: '**Sync** keeps your knowledge folder in a private GitHub repository, so every computer has the same brain.',
    points: [
      { icon: 'file', text: 'Pages, chats and project memory travel; source files and keys stay here.' },
      { icon: 'refresh', text: '**Sync now** sends your changes and brings in the other computers’.' },
      { icon: 'clock', text: 'Each sync is a git commit that a git client can undo.' },
    ],
    guide: { key: 'sync.page', heading: 'Sync across computers' },
  },

  // ── Chat (views/chat.js) ─────────────────────────────────────────────────
  // The PROJECT pin's ⓘ — `chat-project-info` (was a literal "ⓘ" character
  // with its own panel; the wiring moves it onto the shared mark).
  'chat.project': {
    label: 'What a pinned project adds',
    title: 'A pinned project',
    lead: 'Pin a project and answers also read its brief, its latest Handoff and its **read first** Documents.',
    points: [
      { icon: 'search', text: 'Chat treats them as notes to check, never as orders.' },
      { icon: 'lock', text: 'Chat never writes to your project.' },
    ],
    guide: { key: 'chat.project', heading: 'Pin a project, and the answer reads its context too' },
  },
};

/**
 * THE FRAMING (MODEL.md §1). One sentence and three nodes, reused by the top
 * ⓘ of every place. Always all three, always in this order; the kit marks the
 * current one "you are here". ② and ③ say *optional* so a beginner knows the
 * first node works alone.
 */
export const FRAMING = {
  sentence: 'Build a second brain from what you read, share it with a team, and give it to your agents.',
  caption: 'One knowledge folder on this computer',
  nodes: [
    { id: 'second-brain', name: 'Second brain', places: 'Domains · Chat', line: 'Your reading, turned into a wiki.' },
    { id: 'shared-brain', name: 'Shared Brain', places: 'optional', line: 'The same wiki, written with a team.' },
    { id: 'agent-memory', name: 'Agent memory', places: 'Context · optional', line: 'What your agents read and save.' },
  ],
};

/**
 * Every word a `**bold**` may carry, exactly as the screen prints it
 * (MODEL.md §3 rule 3). A bold word is a pointer at something the reader can
 * find on the page — a word the screen does not show is not bold.
 */
export const SCREEN_WORDS = [
  'the brief', 'The brief', 'Documents', 'Memory', 'Knowledge', 'Handoffs', 'Journal',
  'Agent sessions', 'Session start', 'read first', 'on request', 'not at start', 'mirrored',
  'Window', 'Reading budget', 'Harness', 'Documents at start', 'Copy agent instructions',
  'domain', 'Projects', 'New domain', 'Ingest', 'PROJECT', 'Length', 'Model',
  'Wiki', 'Context', 'All', 'Scan', 'Providers & keys', 'Knowledge base', 'MCP bridge',
  'Shared Brain', 'Push', 'Pull',
  // The overview's tile names, printed as the tiles print them, and the
  // Pages list's three kinds — a table's row names are screen words too.
  'DOCUMENTS', 'MEMORY', 'KNOWLEDGE', 'AGENT SESSIONS', 'SESSION START',
  'Entity', 'Concept', 'Summary',
  // v3.71.1 — the rest of the app's screen words, each as printed: domain
  // page figures and buttons, Settings block titles and fields, the model
  // badges, Shared Brain and Sync controls.
  'PAGES', 'PROJECTS', 'Copy marker line', 'New project', 'Decide later',
  'Connect a provider', 'Your AI model', 'Chat', 'All models', 'Wiki health',
  'measured for the build lane', 'measured on your wiki', 'not measured', 'Worth testing for this job',
  'Software update', 'Appearance', 'Text size', 'Menu bar', 'System check',
  'Connect a client', 'Default domain for MCP writes', 'Tool map', 'Across projects',
  'Maximum candidate pairs per scan', 'Vault folder', 'GitHub read-only token', 'Choose folder', 'Test',
  'Access token', 'Check now', 'Sync', 'Sync now',
];

// Frozen DEEPLY: a caller that could assign into this map would be a second,
// invisible source of copy — the thing this file exists to prevent.
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
export const EXPLAINERS = deepFreeze(E);
deepFreeze(FRAMING);
deepFreeze(SCREEN_WORDS);
