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
