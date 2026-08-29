# The Curator's agent skills

The Curator ships two agent skills:

- **[`my-curator/`](my-curator/)** — how to read from and write to the wiki.
- **[`curator-continuity/`](curator-continuity/)** — how to carry build state between
  sessions, machines, models and harnesses.

Each is a `SKILL.md` playbook plus an `examples.md` of worked dialogues. In Claude Code and
Claude Desktop they install as Claude Skills — see
[`docs/mcp-user-guide.md`](../docs/mcp-user-guide.md) for that path.

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
- only the surrounding scaffolding is new prose, and it exists once, as one parameterised
  template inside `build.mjs`.

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

  --examples          also append the worked examples (about +50% size)
  --format=body       the playbook alone: frontmatter stripped, nothing added
  -o <path>           write to a file instead of stdout
  --append            append to <path> rather than overwriting (refuses to double-append)
  --check <path>      re-derive and byte-compare; exit 1 if it has drifted
```

Zero dependencies, Node 18+. It resolves the skill source relative to itself, so you can
run it from anywhere — including from inside the project you are installing into.

The script also cross-checks the skill's declared tool list against the `tools` array in
`mcp/tools/index.js` and warns on stderr if they disagree, or if it could not parse the
array at all. It never fails silently on that check: "could not verify" is printed as
loudly as a mismatch.

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
| `my-curator` | 40.6 KB | ~10,100 |
| `curator-continuity` | 39.3 KB | ~9,800 |
| both | 79.9 KB | ~20,000 |
| either, `--examples` | +19–20 KB | +~5,000 |

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

## A note for whoever maintains this

If you change either `SKILL.md`, the neutral form changes with it on the next build — that
is the point, and there is nothing else to update here. Two things do *not* follow
automatically:

1. **Installed Claude skills.** A change to `skills/<skill>/SKILL.md` takes effect
   only on a manual re-install (`~/.claude/skills/…`) or re-upload (Claude Desktop project
   knowledge). An un-uploaded change is an inert change.
2. **Installed neutral copies.** Users must re-run the build. `--check` is what tells them
   they need to.
