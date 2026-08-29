#!/usr/bin/env node
/**
 * skills/build.mjs — render The Curator's agent skills into a
 * harness-neutral form, for hosts that are not Claude Code / Claude Desktop.
 *
 * ── WHY THIS IS A GENERATOR AND NOT A SECOND COPY ──────────────────────────
 * This repository's most reliably recurring defect is two hand-maintained
 * copies of one thing drifting apart (CLAUDE.md records it in most recent
 * releases: the v3.2.0 CRITICAL, the pre-merge-commit hook, the two badge
 * label tables, the four docs that denied a shipped route). A neutral COPY of
 * a 37 KB playbook would be that shape at its worst, because the two copies
 * are read by MODELS: they would not merely disagree, they would instruct two
 * agents to behave differently.
 *
 * So there is no copy. The prose lives in exactly one place —
 * skills/<skill>/SKILL.md — and everything below is derived from it at
 * build time:
 *
 *   - the BODY is that file with its YAML frontmatter stripped, byte for byte;
 *   - the activation triggers are the frontmatter `description`, verbatim;
 *   - the tool list is the frontmatter `allowed-tools`, with the host-specific
 *     `mcp__<server>__` prefix removed;
 *   - only the surrounding scaffolding is new, and it lives once, here, as one
 *     parameterised template.
 *
 * Nothing generated is committed. `--check` re-derives and byte-compares, so a
 * copy a user installed months ago can be told it is stale.
 *
 * ── WHY STRIPPING FRONTMATTER IS SUFFICIENT ────────────────────────────────
 * Measured, not assumed: `mcp__` appears in these files ONLY on the
 * `allowed-tools:` line. Every tool reference in all four bodies is already a
 * bare name (`get_index`, `compile_to_wiki`). The prose was portable all
 * along; only the packaging was not.
 *
 * Zero dependencies. Node >= 18 (uses node: builtins only).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// The skills are this script's SIBLINGS — it lives in skills/ alongside them.
// Deriving that from HERE rather than from a hardcoded directory name means one
// less string to update the next time the directory is renamed, which is exactly
// what has just happened once.
const SKILLS_DIR = HERE;

const SKILLS = ['my-curator', 'curator-continuity'];

// ── Frontmatter -------------------------------------------------------------

/**
 * Split a leading, properly-closed YAML frontmatter block off a document.
 *
 * Deliberately strict, mirroring src/public/app.js's stripFrontmatter rule
 * (v3.5.1): only a block that STARTS the file and is properly closed counts.
 * An unterminated `---` returns null rather than swallowing the document.
 *
 * A missing or unparseable block is an ERROR to the caller, never a silent
 * empty result — a header rendered with no triggers and no tool list is the
 * "guard that cannot fail" shape this repo keeps finding.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  return { yaml: text.slice(4, end + 1), body: text.slice(end + 5) };
}

/** Read one `key: value` scalar out of a frontmatter block (values may not span lines here). */
function yamlScalar(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Strip the host-specific MCP namespace from a tool name.
 * `mcp__my-curator__get_index` -> `get_index`; a bare name passes through.
 */
function bareToolName(name) {
  const m = name.match(/^mcp__.+?__(.+)$/);
  return m ? m[1] : name;
}

// ── Cross-check against the real MCP tool list ------------------------------

/**
 * Count the entries in mcp/tools/index.js's `tools` array by walking bracket
 * depth (the method check-doc-suite-counts.js uses), so a reformat does not
 * fool it.
 *
 * Returns {ok:true,count} or {ok:false,reason}. NEVER returns a silent zero:
 * "could not parse" is reported as loudly as a mismatch, because a check that
 * has quietly stopped checking is worse than no check.
 */
function countMcpTools() {
  const file = path.join(REPO, 'mcp', 'tools', 'index.js');
  let src;
  try { src = readFileSync(file, 'utf8'); }
  catch { return { ok: false, reason: `could not read ${path.relative(REPO, file)}` }; }

  const start = src.indexOf('export const tools = [');
  if (start === -1) return { ok: false, reason: '`export const tools = [` not found — the array was renamed or reshaped' };

  let i = src.indexOf('[', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
    else if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; }
  }
  if (end === -1) return { ok: false, reason: 'the tools array never closed — bracket walk failed' };

  const span = src.slice(start, end);
  const count = (span.match(/\{\s*definition:/g) || []).length;
  if (count === 0) return { ok: false, reason: 'zero `{ definition:` entries found inside the array — the entry shape changed' };
  return { ok: true, count };
}

// ── Rendering ---------------------------------------------------------------

const HOST_NOTE = `**Tool names in this document are bare** — \`get_index\`, \`compile_to_wiki\`, \
\`save_working_state\`. That is what the MCP server itself calls them. Some hosts present MCP \
tools under a namespaced name (Claude Code, for instance, shows \`mcp__my-curator__get_index\`). \
If the tools you were given carry a prefix, match on the part after the final \`__\` and use them \
exactly as this document describes.`;

function renderHeader({ name, description, tools, sourceFiles, includeExamples }) {
  const quoted = [...description.matchAll(/"([^"]{2,90})"/g)].map(m => m[1]);
  const provenance = sourceFiles
    .map(f => `  ${f.rel}  sha256:${f.sha.slice(0, 16)}`)
    .join('\n');

  const triggerBlock = quoted.length
    ? `Phrases the Claude version of this skill activates on — treat any of them, or anything ` +
      `plainly equivalent, as putting you in scope:\n\n` +
      quoted.map(q => `- "${q}"`).join('\n') + '\n\n'
    : '';

  return `<!-- GENERATED FILE — DO NOT EDIT.
     Derived from The Curator's ${name} skill. Edit the source, not this file:
${provenance}
     Regenerate:  node skills/build.mjs ${name}${includeExamples ? ' --examples' : ''} -o <this file>
     Check drift: node skills/build.mjs ${name}${includeExamples ? ' --examples' : ''} --check <this file>
-->

# ${name} — operating instructions (always on)

You have The Curator's **my-curator** MCP server connected. What follows is not background
reading; it is how you are expected to use those tools.

## How to apply this document

In Claude Code and Claude Desktop this playbook ships as a Skill, and the harness loads it only
when the conversation matches its triggers. Here there is no such mechanism: it is in your context
for the whole session, and **you** judge when it is relevant.

${triggerBlock}When the user's request is unrelated to their Curator wiki or working state, this
document does not apply — do not let it steer an unrelated task, and do not call these tools
speculatively.

Its own description, verbatim, is the authoritative statement of scope:

> ${description}

${HOST_NOTE}

**Tools it uses (${tools.length}):** ${tools.map(t => `\`${t}\``).join(', ')}.

If your host did not give you all of these, the missing ones are simply unavailable — work with the
list you actually have rather than the list written here, and say so if the user asks for something
that needs one you lack.

---

`;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

function buildSkill(name, { includeExamples, format }) {
  const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(skillPath)) throw new Error(`no such skill: ${name} (looked in ${path.relative(REPO, skillPath)})`);

  const raw = readFileSync(skillPath, 'utf8');
  const fm = splitFrontmatter(raw);
  if (!fm) {
    throw new Error(
      `${path.relative(REPO, skillPath)} has no properly-closed leading YAML frontmatter.\n` +
      `Refusing to build: the description and tool list are derived from it, and emitting a header ` +
      `with neither would produce a document that looks complete and instructs nothing.`,
    );
  }

  const description = yamlScalar(fm.yaml, 'description');
  const allowed = yamlScalar(fm.yaml, 'allowed-tools');
  if (!description) throw new Error(`${name}: frontmatter has no \`description:\` — cannot derive activation scope.`);
  if (!allowed) throw new Error(`${name}: frontmatter has no \`allowed-tools:\` — cannot derive the tool list.`);

  const tools = allowed.split(/\s+/).filter(Boolean).map(bareToolName);
  const sourceFiles = [{ rel: `skills/${name}/SKILL.md`, sha: sha256(raw) }];

  let out = '';
  let body = fm.body.replace(/^\s+/, '');

  if (includeExamples) {
    const exPath = path.join(SKILLS_DIR, name, 'examples.md');
    if (existsSync(exPath)) {
      const exRaw = readFileSync(exPath, 'utf8');
      sourceFiles.push({ rel: `skills/${name}/examples.md`, sha: sha256(exRaw) });
      // examples.md links back to its sibling with a relative path. Once the two
      // are one document that link is dead, so it becomes an in-document pointer.
      const ex = exRaw
        .replace(/\]\(SKILL\.md\)/g, '](#)')
        .replace(/\[SKILL\.md\]\(#\)/g, 'the playbook above');
      body += `\n\n---\n\n${ex}`;
    }
  }

  if (format === 'body') return body.trimEnd() + '\n';

  out = renderHeader({ name, description, tools, sourceFiles, includeExamples }) + body;
  return out.trimEnd() + '\n';
}

// ── CLI ---------------------------------------------------------------------

const USAGE = `
skills/build.mjs — render a Curator agent skill in harness-neutral form

  node skills/build.mjs <skill|all> [options]

Skills: ${SKILLS.join(', ')}

Options:
  --examples          also append the skill's worked examples (roughly doubles the size)
  --format=agents     neutral header + playbook body            (default)
  --format=body       playbook body only, frontmatter stripped, nothing added
  -o, --out <path>    write to <path> instead of stdout
  --append            append to <path> rather than overwriting it
  --check <path>      re-derive and byte-compare against <path>; exit 1 if it has drifted
  --list              list skills and exit
  -h, --help          this message

Nothing here is committed to the repository. The playbook itself lives in exactly one
place — skills/<skill>/SKILL.md — and this script derives everything from it,
so a generated file can always be checked against its source rather than trusted.

Where each host wants the output: see skills/README.md
`;

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) { console.log(USAGE.trim()); return 0; }
  if (args.includes('--list')) { SKILLS.forEach(s => console.log(s)); return 0; }

  let skill = null, out = null, checkPath = null;
  let includeExamples = false, append = false, format = 'agents';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--examples') includeExamples = true;
    else if (a === '--append') append = true;
    else if (a === '-o' || a === '--out') out = args[++i];
    else if (a === '--check') checkPath = args[++i];
    else if (a.startsWith('--format=')) format = a.slice(9);
    else if (a.startsWith('-')) { console.error(`Unrecognised option: ${a}\n${USAGE}`); return 2; }
    else if (skill === null) skill = a;
    else { console.error(`Unexpected extra argument: ${a}`); return 2; }
  }

  if (!skill) { console.error('No skill named. Try --list.'); return 2; }
  if (!['agents', 'body'].includes(format)) { console.error(`Unknown --format=${format} (agents|body)`); return 2; }
  const targets = skill === 'all' ? SKILLS : [skill];
  if (targets.some(t => !SKILLS.includes(t))) { console.error(`Unknown skill "${skill}". Try --list.`); return 2; }

  // Advisory cross-check: does the skills' declared tool list still match the code?
  const inv = countMcpTools();
  const declared = new Set();
  for (const t of targets) {
    const fm = splitFrontmatter(readFileSync(path.join(SKILLS_DIR, t, 'SKILL.md'), 'utf8'));
    if (fm) (yamlScalar(fm.yaml, 'allowed-tools') || '').split(/\s+/).filter(Boolean).forEach(x => declared.add(bareToolName(x)));
  }
  if (!inv.ok) {
    console.error(`! tool-inventory cross-check COULD NOT RUN: ${inv.reason}. Treat the tool list below as unverified.`);
  } else if (targets.includes('my-curator') && declared.size !== inv.count) {
    console.error(`! the my-curator skill declares ${declared.size} tools; mcp/tools/index.js registers ${inv.count}. ` +
      `One of them is stale — check before installing.`);
  }

  let text = targets.map(t => buildSkill(t, { includeExamples, format })).join('\n\n');

  const dest = out || checkPath;
  if (checkPath) {
    if (!existsSync(checkPath)) { console.error(`--check: ${checkPath} does not exist.`); return 1; }
    const have = readFileSync(checkPath, 'utf8');
    if (have.trimEnd() === text.trimEnd()) { console.log(`up to date: ${checkPath}`); return 0; }
    console.error(`DRIFTED: ${checkPath} no longer matches ${targets.join(', ')} in skills/.\n` +
      `Regenerate it: node skills/build.mjs ${skill}${includeExamples ? ' --examples' : ''} -o ${checkPath}`);
    return 1;
  }

  if (!dest) { process.stdout.write(text); return 0; }

  if (append) {
    const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
    for (const t of targets) {
      if (existing.includes(`# ${t} — operating instructions`)) {
        console.error(`--append: ${dest} already contains the ${t} block. Rebuild the file with -o instead of appending twice.`);
        return 1;
      }
    }
    writeFileSync(dest, (existing ? existing.trimEnd() + '\n\n' : '') + text, 'utf8');
  } else {
    writeFileSync(dest, text, 'utf8');
  }
  console.error(`wrote ${dest} (${targets.join(', ')}${includeExamples ? ' + examples' : ''})`);
  return 0;
}

// NOTE: `process.exitCode`, never `process.exit()`. On a pipe, stdout writes are
// ASYNC, and process.exit() discards whatever has not flushed — measured here at
// exactly 64 KB, so `build.mjs all > AGENTS.md` silently produced a playbook
// truncated mid-sentence. A model reads this file; a silently short one is worse
// than a missing one. Letting the event loop drain is what makes the write whole.
try {
  process.exitCode = main(process.argv);
} catch (err) {
  // A clean refusal, not a stack trace: every throw above is a deliberate
  // "I will not emit a document that looks complete and instructs nothing".
  console.error(`\nbuild.mjs refused: ${err.message}\n`);
  process.exitCode = 1;
}
