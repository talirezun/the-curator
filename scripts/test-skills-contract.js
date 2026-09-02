/**
 * test-skills-contract.js — OFFLINE suite pinning the two agent skills in
 * skills/ to the code they describe.
 *
 * These files are read by MODELS. A wrong number in them does not merely
 * misinform a reader — it changes what an agent does with the user's data, and
 * it does so silently. Three classes of rot have actually happened here:
 *
 *   1. THE UPLOAD VALIDATOR. Claude Desktop refuses a skill whose YAML
 *      `description` carries an XML-shaped `<placeholder>` (v2.5.8 hotfix), and
 *      an unquoted YAML scalar containing a colon-space is not one scalar at
 *      all. A refused upload means the skill is simply absent, which looks
 *      exactly like a skill that never fires.
 *   2. TOOL DRIFT. `allowed-tools` names tools by hand. A tool renamed or
 *      removed in mcp/tools/ leaves the skill instructing an agent to call
 *      something that does not exist.
 *   3. CAP DRIFT. v3.39.0 records the shape precisely: every save in a real
 *      session overran the 200-character headline and was silently clipped, by
 *      an agent following a skill that never mentioned the number. The numbers
 *      are now IN the skills — which means they can now be WRONG in the skills.
 *      Section 3 reads each constant out of the source and fails if the prose
 *      and the code disagree, so changing a cap reds this suite.
 *
 * Everything is read off disk; nothing is executed except the MCP tool registry
 * import, which is what makes section 2 a measurement of the REGISTERED set
 * rather than of a hand-typed list. No network, no credentials, no writes.
 *
 * Section 5 is the anti-vacuity control: synthetic frontmatter with each known
 * defect planted in turn must be REJECTED by the same checkers section 1 uses.
 * A validator that cannot fail is not a validator.
 */

import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SKILLS_DIR = path.join(REPO, 'skills');

// Isolate anything the imported MCP modules might resolve. They are not
// expected to touch user data on import, and this makes that a guarantee
// rather than an expectation.
process.env.CURATOR_TEST_USER_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'skills-contract-'));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── shared helpers ─────────────────────────────────────────────────────────

/** Same strict rule build.mjs uses: a leading, properly-closed block only. */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  return { yaml: text.slice(4, end + 1), body: text.slice(end + 5) };
}

function yamlScalar(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

const DESCRIPTION_MAX = 1024;   // Claude Desktop's own limit on the field.
const XML_SHAPED = /<[a-z]+>/i; // v2.5.8: the validator reads this as a tag.

/**
 * The three ways a `description:` breaks the upload, as one function so
 * section 1 and the section 5 control provably run the SAME checker. Returns
 * a list of problems; empty means valid.
 */
function describeProblems(desc) {
  const out = [];
  if (desc === null) { out.push('no description field at all'); return out; }
  if (desc.length > DESCRIPTION_MAX) out.push(`description is ${desc.length} chars, over the ${DESCRIPTION_MAX} cap`);
  if (XML_SHAPED.test(desc)) out.push(`description contains an XML-shaped placeholder (${XML_SHAPED.exec(desc)[0]})`);
  // An unquoted YAML scalar cannot contain ": " — the parser reads it as a
  // nested mapping and the description silently becomes something else.
  if (!/^["']/.test(desc) && desc.includes(': ')) out.push('description contains a colon-space inside an unquoted YAML scalar');
  return out;
}

function bareToolName(name) {
  const m = name.match(/^mcp__.+?__(.+)$/);
  return m ? m[1] : name;
}

const SKILLS = ['my-curator', 'curator-continuity'];
const skill = {};
for (const name of SKILLS) {
  const file = path.join(SKILLS_DIR, name, 'SKILL.md');
  const raw = readFileSync(file, 'utf8');
  const fm = splitFrontmatter(raw);
  skill[name] = { file, raw, fm };
}

// ── 1. Frontmatter contract ────────────────────────────────────────────────

console.log('\n§1 — Frontmatter is uploadable and correctly named');

for (const name of SKILLS) {
  const s = skill[name];
  ok(s.fm !== null, `${name}: has a properly-closed leading YAML frontmatter block`);
  if (!s.fm) continue;

  // The `name` is the skill's identity — an install path, an upload record and
  // (in a neutral build) the document's own heading all derive from it. It must
  // not drift from the folder it lives in.
  ok(yamlScalar(s.fm.yaml, 'name') === name,
    `${name}: frontmatter name is "${name}", matching its folder`);

  const desc = yamlScalar(s.fm.yaml, 'description');
  const problems = describeProblems(desc);
  ok(problems.length === 0,
    problems.length === 0
      ? `${name}: description is uploadable (${desc.length} chars, no XML shape, no colon-space)`
      : `${name}: description would be REJECTED — ${problems.join('; ')}`);

  ok(yamlScalar(s.fm.yaml, 'allowed-tools') !== null,
    `${name}: declares allowed-tools`);
}

// The activation phrases the maintainer asked for by name. A skill that never
// fires is indistinguishable from one that is not installed, and the continuity
// skill in particular must be reachable with NO user utterance at all.
const REQUIRED_PHRASES = {
  'curator-continuity': ['compact', 'wrap up', 'end of session', 'pick up where we left off',
                         'what were we working on', 'hand off'],
  'my-curator': ['remember this', 'add this to my second brain', 'what do I know about X',
                 'search my notes'],
};
for (const [name, phrases] of Object.entries(REQUIRED_PHRASES)) {
  const desc = yamlScalar(skill[name].fm.yaml, 'description') || '';
  const missing = phrases.filter(p => !desc.includes(p));
  ok(missing.length === 0,
    missing.length === 0
      ? `${name}: description carries all ${phrases.length} required activation phrases`
      : `${name}: description is missing activation phrase(s): ${missing.join(', ')}`);
}

// Firing with no user utterance is a behaviour, not a phrase list — the
// description has to SAY so, or the harness only ever activates on a match.
{
  const desc = yamlScalar(skill['curator-continuity'].fm.yaml, 'description') || '';
  ok(/without waiting to be asked|unprompted/i.test(desc),
    'curator-continuity: description tells the agent to apply it unprompted');
}

// ── 2. Tools declared vs tools registered ──────────────────────────────────

console.log('\n§2 — Declared tools match the MCP registry');

const { tools } = await import(path.join(REPO, 'mcp', 'tools', 'index.js'));
const registered = new Set(tools.map(t => t.definition.name));
ok(registered.size >= 15, `mcp/tools/index.js registers ${registered.size} tools (sanity floor)`);

const declaredBySkill = {};
for (const name of SKILLS) {
  const declared = new Set((yamlScalar(skill[name].fm.yaml, 'allowed-tools') || '')
    .split(/\s+/).filter(Boolean).map(bareToolName));
  declaredBySkill[name] = declared;
  const unknown = [...declared].filter(t => !registered.has(t));
  ok(unknown.length === 0,
    unknown.length === 0
      ? `${name}: all ${declared.size} declared tools are registered`
      : `${name}: declares unregistered tool(s): ${unknown.join(', ')}`);
}

// my-curator documents the WHOLE surface, so the reverse direction binds there.
{
  const missing = [...registered].filter(t => !declaredBySkill['my-curator'].has(t));
  ok(missing.length === 0,
    missing.length === 0
      ? `my-curator: declares every registered tool (${registered.size})`
      : `my-curator: omits registered tool(s): ${missing.join(', ')}`);
}

// The MUTATORS are the ones that matter most, and the authoritative definition
// of "mutator" is the refuseIfReadonly call site — never a list in prose
// (CLAUDE.md records a count that was wrong through a whole release). Derive
// them from the source, then require my-curator to declare every one.
{
  const modules = ['compile.js', 'health.js', 'dismissed.js', 'working-state.js'];
  const mutators = new Set();
  for (const mod of modules) {
    const src = readFileSync(path.join(REPO, 'mcp', 'tools', mod), 'utf8');
    // Each handler that refuses on a read-only mirror is a mutator. Walk back
    // from the call site to the enclosing exported handler, then forward from
    // that handler's Definition to its `name:`.
    for (const m of src.matchAll(/refuseIfReadonly\(/g)) {
      const before = src.slice(0, m.index);
      const fn = [...before.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_$]+)/g)].pop();
      if (!fn) continue;
      const defIdent = fn[1].replace(/Handler$/, 'Definition');
      const at = src.indexOf(`${defIdent} = {`);
      if (at === -1) continue;
      const nm = /name:\s*'([^']+)'/.exec(src.slice(at, at + 4000));
      if (nm) mutators.add(nm[1]);
    }
  }
  ok(mutators.size === 5,
    `refuseIfReadonly call sites identify ${mutators.size} mutating tools (expected 5): ${[...mutators].sort().join(', ')}`);
  const undeclared = [...mutators].filter(t => !declaredBySkill['my-curator'].has(t));
  ok(undeclared.length === 0,
    undeclared.length === 0
      ? 'my-curator declares every mutating tool'
      : `my-curator does not declare mutating tool(s): ${undeclared.join(', ')}`);
  // Anti-vacuity: the derivation must be capable of finding a name at all.
  ok(mutators.has('compile_to_wiki') && mutators.has('save_working_state'),
    'the mutator derivation really resolved names (compile_to_wiki + save_working_state found)');
}

// ── 3. Numbers in the prose vs constants in the code ───────────────────────

console.log('\n§3 — Every cap quoted in a skill equals the constant in the code');

// Working state exports its caps, so read the real values.
const ws = await import(path.join(REPO, 'src', 'brain', 'working-state.js'));

// compile.js keeps its caps module-private, so they are read out of the source
// text. A regex, deliberately: importing would not expose them, and a wrong
// number here is exactly what this section exists to catch.
const compileSrc = readFileSync(path.join(REPO, 'mcp', 'tools', 'compile.js'), 'utf8');
function compileConst(name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(compileSrc);
  if (!m) return null;
  // Values are simple arithmetic literals (`50 * 1024`, `60_000`, `10`).
  const expr = m[1].split('//')[0].trim().replace(/_/g, '');
  return /^[\d\s*+]+$/.test(expr) ? Function(`return (${expr})`)() : null;
}

const continuityText = skill['curator-continuity'].raw;
const myCuratorText = skill['my-curator'].raw;

/**
 * Assert a number is quoted in a body, in any of the shapes the prose uses
 * (`200`, `8,000`, `48 KB`). The point is that the NUMBER appears, so a cap
 * change reds this suite and forces the prose to be re-read.
 */
function quotes(text, value, ...forms) {
  const candidates = [String(value), String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','), ...forms];
  return candidates.some(c => text.includes(c));
}

const capChecks = [
  ['headline cap', ws.MAX_HEADLINE_CHARS, continuityText, []],
  ['now_state cap', ws.MAX_PROSE_CHARS, continuityText, []],
  ['per-list-item cap', ws.MAX_ITEM_CHARS, continuityText, []],
  ['items per list', ws.MAX_ITEMS_PER_LIST, continuityText, []],
  ['harness/model cap', ws.MAX_META_CHARS, continuityText, []],
  ['whole-document budget', ws.MAX_STATE_BYTES / 1024, continuityText, ['48 KB']],
  ['brief read budget', ws.MAX_BRIEF_BYTES / 1024, continuityText, ['32 KB']],
  ['scope index cap', ws.MAX_INDEX_ENTRIES, continuityText, []],
  ['journal entries cap', ws.MAX_JOURNAL_ENTRIES, continuityText, []],
  ['notes cap', ws.MAX_NOTES, continuityText, []],
  ['pages per compile call', compileConst('MAX_PAGES'), myCuratorText, []],
  ['title cap', compileConst('MAX_TITLE_LENGTH'), myCuratorText, []],
  ['summary_content cap', compileConst('MAX_SUMMARY_LENGTH'), myCuratorText, ['60,000']],
  ['per-page byte cap', compileConst('MAX_PAGE_BYTES') / 1024, myCuratorText, ['50 KB']],
];

for (const [label, value, text, forms] of capChecks) {
  ok(value !== null && value !== undefined && quotes(text, value, ...forms),
    value === null || value === undefined
      ? `${label}: could not read the constant out of the source — the check has stopped checking`
      : `${label}: ${value} is stated in the skill`);
}

// The MCP layer owns journal_limit's default and cap, not the store.
{
  const wsToolSrc = readFileSync(path.join(REPO, 'mcp', 'tools', 'working-state.js'), 'utf8');
  const def = /JOURNAL_LIMIT_DEFAULT\s*=\s*(\d+)/.exec(wsToolSrc);
  const cap = /JOURNAL_LIMIT_CAP\s*=\s*Math\.min\((\d+)/.exec(wsToolSrc);
  ok(def && continuityText.includes(`default ${def[1]}`),
    `journal_limit default (${def ? def[1] : '?'}) is stated in curator-continuity`);
  ok(cap && continuityText.includes(`maximum ${cap[1]}`),
    `journal_limit maximum (${cap ? cap[1] : '?'}) is stated in curator-continuity`);
}

// The compile slug regex is the reason a dotted slug cannot be CREATED. If the
// regex ever widens, the skill's §2 asymmetry becomes a lie.
{
  const hasHyphenOnly = /\/\^\[a-z0-9\]\[a-z0-9\\-\]\*\$\/i\.test\(slug\)/.test(compileSrc);
  ok(hasHyphenOnly,
    'compile.js still validates additional_pages slugs as alphanumerics + hyphens only (the dotted-slug asymmetry the skill states)');
  ok(myCuratorText.includes('cannot be CREATED'),
    'my-curator states that a dotted slug can be read but not created');
}

// The five save outcomes. `clipped` is the one a reader is most likely to
// mishandle — it needs NO re-save — so the store's verdict set is pinned.
{
  const wsSrc = readFileSync(path.join(REPO, 'src', 'brain', 'working-state.js'), 'utf8');
  const hasClipped = /return allMetadataOnly \? 'clipped' : 'trimmed';/.test(wsSrc);
  ok(hasClipped, "classifySaveNotes still distinguishes 'clipped' from 'trimmed'");
  ok(/Clipped metadata/.test(continuityText) && /no re-save is needed/i.test(continuityText),
    'curator-continuity documents the clipped verdict as needing no re-save');
}

// ── 4. On-demand companion files exist ─────────────────────────────────────

console.log('\n§4 — Every companion file a SKILL.md links to exists');

let linkChecks = 0;
for (const name of SKILLS) {
  const body = skill[name].fm.body;
  const linked = [...new Set([...body.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map(m => m[1]))];
  ok(linked.length > 0, `${name}: SKILL.md links ${linked.length} companion file(s)`);
  for (const file of linked) {
    linkChecks++;
    ok(existsSync(path.join(SKILLS_DIR, name, file)), `${name}: ${file} exists`);
  }
  // A companion file's own links must resolve too — a dead link inside a file
  // the agent was told to open is the same defect one level down.
  for (const file of linked) {
    const abs = path.join(SKILLS_DIR, name, file);
    if (!existsSync(abs)) continue;
    const inner = [...new Set([...readFileSync(abs, 'utf8').matchAll(/\]\(([a-z0-9-]+\.md)\)/gi)].map(m => m[1]))];
    const dead = inner.filter(f => !existsSync(path.join(SKILLS_DIR, name, f)));
    ok(dead.length === 0,
      dead.length === 0
        ? `${name}/${file}: its own ${inner.length} sibling link(s) all resolve`
        : `${name}/${file}: dead sibling link(s): ${dead.join(', ')}`);
  }
}
ok(linkChecks >= 3, `companion-link check really ran (${linkChecks} links examined)`);

// ── 5. Anti-vacuity control ────────────────────────────────────────────────

console.log('\n§5 — Control: a bad description must be REJECTED');

const BAD = [
  ['over the length cap', 'Use when '.padEnd(DESCRIPTION_MAX + 40, 'x')],
  ['XML-shaped placeholder', 'Use when the user says save to my <domain> wiki.'],
  ['colon-space in an unquoted scalar', 'Use when reading the wiki. Activates on: save, resume, continue.'],
  ['missing entirely', null],
];
for (const [label, desc] of BAD) {
  const problems = describeProblems(desc);
  ok(problems.length > 0, `control rejected (${label}): ${problems.join('; ') || 'NOT REJECTED — the checker is vacuous'}`);
}
// …and a good one must pass, or the checker is merely always-red.
ok(describeProblems('Use when the user asks about their wiki. Activates on "save to my wiki".').length === 0,
  'control accepted a valid description (the checker is not always-red)');

// A cap check that can never fail is the same defect one layer up.
ok(!quotes('nothing here', 200) && quotes('the cap is 200 characters', 200),
  'the cap-quoting check can both find and miss a number');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All skills-contract assertions green');
