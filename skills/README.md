# The Curator's agent skills

The Curator ships two agent skills:

- **[`my-curator/`](my-curator/)** — how to read from and write to the wiki.
- **[`curator-continuity/`](curator-continuity/)** — how to carry build state between
  sessions, machines, models and harnesses.

Each is a `SKILL.md` playbook plus **on-demand companion files** in the same folder. In Claude
Code and Claude Desktop they install as Claude Skills — see
[`docs/mcp-user-guide.md`](../docs/mcp-user-guide.md) for that path.

**`SKILL.md` is loaded whole on every activation; the companions are not.** That is the whole
reason the split exists — depth an agent needs *when a case arises* costs nothing until it
opens the file, while a rule it acts on *every* activation must stay inline. Each companion
is linked from `SKILL.md` by relative path, so a host that installs the skill **folder**
resolves them.

| Skill | Files | Loaded on activation |
|---|---|---|
| `my-curator/` | `SKILL.md` | always |
| | `shared-brain.md` | when a `shared-*` mirror or a cohort is in play |
| | `maintenance.md` | when actually making Wiki Health calls |
| | `examples.md` | worked dialogues |
| `curator-continuity/` | `SKILL.md` | always |
| | `brief-authority.md` | when a standing brief is present and being judged |
| | `examples.md` | per-field BAD/GOOD standards + worked dialogues |

**Install the whole folder, not just `SKILL.md`.** A `SKILL.md` whose companions are absent
tells an agent to open files that are not there, which is worse than never mentioning them.
`scripts/test-skills-contract.js` fails if a linked companion is missing, and `build.mjs`
refuses to build.

**This file is about every other host.** [`build.mjs`](build.mjs) renders the same two
playbooks into a form Codex, opencode, Cursor or Gemini CLI will load.

> This directory used to be called `claude-skills/`. The name asserted a Claude-only
> framework, which is the bias this work removes: the playbooks were portable prose all
> along. **GitHub does not redirect a moved path**, so links to the old
> `/tree/main/claude-skills/…` now 404. Nothing inside the files changed in the rename.

## Why this exists

The MCP server is already harness-neutral: it speaks stdio JSON-RPC, so any local MCP
client can call all 20 tools. The skills were not. Three things tied them to one vendor:

| | Portable? |
|---|---|
| The playbook prose (~37 KB each) | **Yes.** Measured: `mcp__` appears in these files only on the `allowed-tools:` frontmatter line. Every tool reference in all four bodies is already a bare name. |
| `allowed-tools:` in the YAML frontmatter | No — `mcp__my-curator__<tool>` is Claude Code's namespacing. |
| Auto-activation from the YAML `description` | No — a Claude Code / Claude Desktop mechanism. |
| The documented install path (`~/.claude/skills/`) | No. |

**Why that mattered more than it looks.** An agent in another harness can already *read*
working state through MCP perfectly well. Nothing was telling it to *save*. Capture is
advisory by design — nothing in the product forces a save — so a harness whose agent never
learns the discipline leaves the store empty and the whole memory layer silently does
nothing. The store was portable; the discipline that fills it was not.

## One source, no copies

There is no neutral *copy* of either playbook, and there deliberately never will be. Two
hand-maintained copies of one instruction set drifting apart is this repository's most
reliably recurring defect, and it would be at its worst here: both copies are read by
**models**, so they would not merely disagree with each other, they would instruct two
agents to behave differently.

Instead, [`build.mjs`](build.mjs) *derives* the neutral form at build time:

- the **body** is `skills/<skill>/SKILL.md` with its YAML frontmatter stripped, byte
  for byte;
- the **activation triggers** are that frontmatter's `description`, reproduced verbatim,
  plus its quoted phrases pulled out as a list;
- the **tool list** is that frontmatter's `allowed-tools`, with the `mcp__<server>__`
  prefix removed;
- the **on-demand companion files** are appended, with their sibling links rewritten to
  in-document pointers — this format has no way to load a file on demand, so a relative link
  would name a file the reader cannot open;
- only the surrounding scaffolding is new prose, and it exists once, as one parameterised
  template inside `build.mjs`.

`--core` omits the companions for a size-conscious always-on install. The generated header
then says so and names the folder they live in, rather than leaving links that go nowhere.

Nothing generated is committed to this repository, so there is no second copy to fall out
of date. What a user installs into their own project *can* go stale, so every generated
file carries the command that re-checks it:

```
node skills/build.mjs my-curator --check /path/to/the/file/you/installed.md
```

That re-derives from source and byte-compares. A one-word edit to `SKILL.md` makes it
report `DRIFTED` and exit 1 (verified by mutation, with the mutation read back off disk
first). It also reports drift if someone hand-edited the installed copy, which is the more
common way a model-read file starts lying.

## Usage

```
node skills/build.mjs <my-curator|curator-continuity|all> [options]

  --examples          also append the worked examples (about +45% size)
  --core              OMIT the on-demand companion files (smaller; see below)
  --format=body       the playbook alone: frontmatter stripped, nothing added
  -o <path>           write to a file instead of stdout
  --append            append to <path> rather than overwriting (refuses to double-append)
  --check <path>      re-derive and byte-compare; exit 1 if it has drifted
```

Zero dependencies, Node 18+. It resolves the skill source relative to itself, so you can
run it from anywhere — including from inside the project you are installing into.

The script also cross-checks each skill's declared tool list against the `tools` array in
`mcp/tools/index.js` and warns on stderr if they disagree, or if it could not parse the array
at all. It never fails silently on that check: "could not verify" is printed as loudly as a
mismatch.

Two things about that check are worth knowing, because both were weaker before:

- **It runs for every target.** It used to run only when the targets included `my-curator`, so
  building `curator-continuity` on its own verified nothing — and that skill names seven tools
  which rot exactly like any other.
- **It compares NAMES, not a count.** A count cannot see a rename, which is precisely the
  drift that makes an `allowed-tools` line wrong while the number stays right. The names are
  read by walking the `tools` array, mapping each `xDefinition` identifier back to the module
  it was imported from, and reading that module's `name:` field.

`curator-continuity` declares a deliberate 7-tool subset, so "registered but not declared" is
expected there and is not reported; `my-curator` documents the whole surface, so it is
reported for that skill. Declared-but-not-registered is a defect for either and is always
reported.

## Where each host loads it from

Verified against primary sources (official docs, or the tool's own source where the docs are
silent). Where a fact could not be verified it says so rather than guessing — several of these
files are read by a model, so a wrong instruction changes an agent's behaviour rather than
merely misinforming a reader.

| Host | Put the built file at | Auto-loaded? | MCP over stdio |
|---|---|---|---|
| **Codex CLI** | `AGENTS.md` in the repo root, or `~/.codex/AGENTS.md` for every project | Yes — built into an instruction chain once per run, root-down, closer files last | Yes — `[mcp_servers.<name>]` in `~/.codex/config.toml` |
| **opencode** | `AGENTS.md` in the repo root, or `~/.config/opencode/AGENTS.md`; or list the file under `instructions: []` in `opencode.json` | Yes | Yes — `"type": "local"` with a `command` array in `opencode.json` |
| **Cursor** | `.cursor/rules/curator.mdc` (**must be `.mdc`** — plain `.md` in that directory is ignored), or `AGENTS.md` in the repo root | Depends: a rule set to *Always Apply* loads every chat; *Apply Intelligently* is conditional; *Apply Manually* needs an `@`-mention. `AGENTS.md` auto-applies | Yes — `mcpServers` in `.cursor/mcp.json` or `~/.cursor/mcp.json` |
| **Gemini CLI** | `GEMINI.md` in the repo root, or `~/.gemini/GEMINI.md`. It will read `AGENTS.md` instead if you set `context.fileName` | Yes — concatenated and sent **with every prompt** | Yes — `mcpServers` in `.gemini/settings.json` or `~/.gemini/settings.json` |
| **Aider** | `CONVENTIONS.md`, or any filename | **No — you must ask for it**: `aider --read CONVENTIONS.md`, `/read` in session, or `read:` in `.aider.conf.yml` | **No — aider has no MCP client.** See below |

Sources: [Codex `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md) ·
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli) ·
[opencode rules](https://opencode.ai/docs/rules/) · [opencode MCP](https://opencode.ai/docs/mcp-servers/) ·
[Cursor rules](https://cursor.com/docs/context/rules) · [Cursor MCP](https://cursor.com/docs/mcp) ·
[Gemini `GEMINI.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md) ·
[Gemini MCP](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) ·
[Aider conventions](https://aider.chat/docs/usage/conventions.html)

**Aider cannot use The Curator at all, and the reason is worth stating plainly.** It has no MCP
client — `mcp` appears nowhere in its CLI argument definitions, its options reference, or its
config reference. Every "aider MCP" project you will find wraps aider *as an MCP server*, which
is the opposite direction. It also does not read `AGENTS.md`, despite being listed on agents.md
as a tool that does; the requests for it are open issues. So the row above is about loading the
*playbook* as coding conventions — useful for a human reading along, but the tools it describes
will not be there. Treat the agents.md support list as self-asserted by that site, not verified
per tool.

Typical install, from inside the project you want it in:

```
node /path/to/second-brain/skills/build.mjs all -o AGENTS.md            # Codex, opencode
node /path/to/second-brain/skills/build.mjs all -o .cursor/rules/curator.mdc   # Cursor
node /path/to/second-brain/skills/build.mjs all -o GEMINI.md            # Gemini CLI
```

Use `--append` if the file already has project content of its own. A Cursor `.mdc` file wants
its own frontmatter (`alwaysApply: true`) above the generated block — add it by hand after the
first build, then keep the block in a separate file and `--check` that instead, since `--check`
is a byte-compare and hand-added frontmatter will read as drift.

## One thing to check before you trust the tool names

Three hosts, three different naming schemes — this is the part most likely to trip you up:

| Host | What the model sees for `get_index` |
|---|---|
| Claude Code | `mcp__my-curator__get_index` |
| Codex CLI | `mcp__my_curator__get_index` — **note the underscore**: its sanitiser rewrites every character outside `[A-Za-z0-9_]`, so the hyphen in `my-curator` becomes `_` |
| Gemini CLI | `mcp_my-curator_get_index` — single underscores |
| opencode | `my-curator_get_index` — no `mcp` prefix at all |
| Cursor | **Undocumented.** Cursor is closed-source and its docs do not state the format. The `server:tool` syntax in its permissions reference is rule-matching syntax, not what the model sees — do not conflate them |

The generated document tells the agent to match on the part after the final `__`, which is
correct for Claude Code and Codex. For Gemini and opencode the bare name is a plain suffix and
still matches. None of this needs any edit to the playbook — it names tools bare, the way the
MCP server itself does.

Two host-specific gotchas found while verifying the above, both worth knowing:

- **Codex** turns hyphens into underscores; **opencode** preserves them. If you filter or
  allow-list tools by name, the same server needs a different pattern in each.
- **Gemini CLI's own docs warn** that underscores in an MCP *server* name make its parser
  misinterpret the server identity, so wildcard rules and security policies can fail
  **silently**. Keep the server named `my-curator`.

**Codex's naming is verified from its source and its own test, not from its documentation** —
`MCP_TOOL_NAME_PREFIX = "mcp"` with delimiter `__`. Its published MCP docs never state the
format, so it could change without a documentation change. Re-check it if tool calls start
failing.

## What you lose without auto-activation, and what it costs

In Claude, a skill is *dormant* until the conversation matches its description, and then
its full body is loaded. Everywhere else you are choosing between two imperfect options,
and both have a real cost. Be deliberate about which.

**Always-on** (paste it into the file your host loads every session). The agent always
knows the discipline, including on the turn where it should be saving state — which is the
whole point, since the failure mode is an agent that never saves. The cost is tokens, on
every turn of every session, including the ones with nothing to do with the wiki:

| Built with | Bytes | Rough tokens (bytes ÷ 4 — an estimate, not a measurement) |
|---|---|---|
| `my-curator` | 43.6 KB | ~11,200 |
| `my-curator --core` | 29.8 KB | ~7,600 |
| `curator-continuity` | 47.1 KB | ~12,100 |
| `curator-continuity --core` | 38.5 KB | ~9,900 |
| both | 90.7 KB | ~23,200 |
| both, `--core` | 68.3 KB | ~17,500 |
| either, `--examples` | +19–23 KB | +~5,000–5,900 |

Measured with `wc -c` on the generated files at the time of writing, not estimated — but they
move whenever a playbook does, so re-measure rather than quoting this table back. The `--core`
rows are what a host loading this on **every turn** should probably install; the companions
are reference material for a case that may never arise in a given session.

**Do not put `--examples` in always-on context.** The worked dialogues are for a human
reading the playbook, or for a host that loads a document on demand. In a permanent system
prompt they are close to 5,000 tokens per skill of material the model does not need every
turn.

If you only code with the Curator and rarely write to the wiki, install
`curator-continuity` always-on and `my-curator` on demand. That is the pairing that buys
the most and costs the least.

**On demand** (a file the agent reads when asked, or a slash command / prompt file). Costs
nothing until used, and reads more like the Claude behaviour. The cost is that *the user*
becomes the trigger: the agent will not save state unless someone remembers to tell it to,
which is exactly the gap this directory exists to close. If you go this route, put a single
line in your always-on file pointing at the playbook — something like *"Before ending a
session or when context runs low, read `.agents/curator-continuity.md` and follow it."*
One line of always-on context restores most of the trigger behaviour for ~20 tokens.

Neither option reproduces Claude's behaviour exactly. Claude decides activation from the
description with the body out of context; elsewhere either the body is always in context,
or a human decides. That difference is stated here rather than papered over.

## Version compatibility

**The skills target Curator v3.0.0 and later**, and the rule that matters is stated inside
`my-curator/SKILL.md` itself: **read the tool list you were actually given, not the
document.** On an older Curator a tool simply does not appear, and everything else still
applies.

| Feature | Needs |
|---|---|
| The 20 MCP tools, Shared Brain mirror domains (`shared-*`), Health scan-but-not-fix on mirrors | v3.0.0+ |
| `get_raw_source` and the compiled-first / verbatim-on-escalation rule | v3.5.0+ |
| `get_working_state` / `save_working_state` — the whole `curator-continuity` skill | v3.17.0+ (below it there is no working-state store at all, and the tool count is 18) |
| The `clipped` save verdict (metadata shortened, body stored in full) | v3.39.0+ (below it a clipped headline was reported as content loss) |

Earlier Curator versions did not have Shared Brain at all. The mirror-domain logic still
works — there simply will not be any `shared-*` domains to dispatch on.

**Updating an installed skill**: re-run the install commands in
[`docs/mcp-user-guide.md`](../docs/mcp-user-guide.md) — they overwrite the files in
`~/.claude/skills/<skill>/` (Claude Code) or replace the project-knowledge upload (Claude
Desktop). Re-installation does not restart a conversation; edits take effect mid-session.

## What is and is not verified in the skills

Notes that belong to whoever maintains the playbooks rather than to an agent reading one:

- Field names, defaults, refusal reasons and behaviours in `curator-continuity` were checked
  against both `src/brain/working-state.js` and the MCP tool layer that wraps it. **One
  naming asymmetry is real and worth expecting:** save *arguments* and the save *response* are
  snake_case (`next_steps`, `sections_written`), while the read response passes the store's
  camelCase through (`machineIsThisMachine`, `scopeCount`, `savedAt` inside `current`). **Two
  exceptions sit inside `brief`:** `authority_note` and `brief_authority` are added by the
  tool layer rather than passed through, so they are snake_case in an otherwise camelCase
  block. The skill says the operative rule — if a response does not match a key used there,
  trust the response.
- `save_working_state` writes **Tier 2 only**, and at the time of writing no brief-writing
  tool is registered — checked by enumerating the call sites, not from memory. **That absence
  is what the owner framing in `brief-authority.md` rests on**, so if a future build registers
  one, the brief stops being provably human-authored and that file has to be revisited
  alongside it. The project's own firm decision is that no tool may ever write tier 1.
- Both working-state tools accept `domain` as a synonym for `project`, so a mistaken label
  does not lose a handoff. Prefer `project`.
- Every numeric cap quoted in either playbook is pinned to its constant by
  [`scripts/test-skills-contract.js`](../scripts/test-skills-contract.js), so changing a cap
  in the code reds that suite rather than silently making a model-read document wrong.

## A note for whoever maintains this

If you change either `SKILL.md`, the neutral form changes with it on the next build — that
is the point, and there is nothing else to update here. Two things do *not* follow
automatically:

1. **Installed Claude skills.** A change to `skills/<skill>/SKILL.md` takes effect
   only on a manual re-install (`~/.claude/skills/…`) or re-upload (Claude Desktop project
   knowledge). An un-uploaded change is an inert change.
2. **Installed neutral copies.** Users must re-run the build. `--check` is what tells them
   they need to.

`npm test` runs [`scripts/test-skills-contract.js`](../scripts/test-skills-contract.js), which
holds the parts a reader cannot check by eye: the `description` stays uploadable (≤1024 chars,
no XML-shaped placeholder, no colon-space in an unquoted scalar), every declared tool is
registered and every mutator is declared, every companion file that is linked exists, and
every cap quoted in the prose equals the constant in the code.
