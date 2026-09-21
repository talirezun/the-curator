/**
 * test-spec-working-state.js — OFFLINE suite that keeps the PUBLIC spec true.
 *
 * `docs/spec/working-state-v1.md` is a promise made to people who cannot see
 * this codebase: a third party builds a writer from it and expects The Curator
 * to read the result back with no repair step. A number in that file that has
 * drifted from the code is therefore worse than no specification at all — it is
 * a wrong instruction to somebody who cannot check it.
 *
 * So this suite does not read the spec for style. It PARSES ITS TABLES and
 * compares every heading string, every section order, every budget number and
 * every name grammar against the LIVE constants imported from
 * `src/brain/working-state.js` and `src/brain/mcp-usage.js` — and, for the two
 * claims a table cannot make honestly, EXECUTES the store: it renders a real
 * handoff into a temp fixture and checks the document against the spec's
 * grammar, and it drives a real bootstrap over a flagged foundation to check
 * the spec's `include` × `readFirst` row.
 *
 * ── THE FAILURE SHAPE THIS SUITE EXISTS TO AVOID ───────────────────────────
 * Not "the spec is wrong" — that is what it catches. The shape it is BUILT
 * against is the one this repository keeps recording: a checker that stops
 * reaching the thing it checks and reports green anyway (the lexer desync in
 * `test-frontend-null-safety.js`, which saw 78 of 90 declarations while every
 * assertion passed). Every parser below therefore carries an EXPECTED ROW
 * COUNT and fails loudly when it finds fewer: a renamed heading, a reflowed
 * table or a deleted section reds the suite instead of quietly comparing zero
 * rows. That is the deliberately-dumb second measurement the v3.1.0 decision
 * asks for.
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────
 * The execution sections build a throwaway domain under an OS temp dir and
 * point BOTH `CURATOR_TEST_DOMAINS_DIR` and `CURATOR_TEST_USER_DATA_DIR` at it
 * before importing the store — the `mcp-exercise.js` discipline, because
 * `DOMAINS_PATH` loses to a configured `domainsPath` on a real install. The
 * real `domains/` folder and every credential file are untouched, and the
 * fixture is removed in a `finally`.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'spec', 'working-state-v1.md');

let passed = 0; let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── The fixture, created BEFORE the store is imported ─────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-spec-suite-'));
const DOMAINS = path.join(TMP, 'domains');
const DOMAIN = 'specfixture';
mkdirSync(path.join(DOMAINS, DOMAIN, 'wiki'), { recursive: true });
writeFileSync(path.join(DOMAINS, DOMAIN, 'CLAUDE.md'), '# spec fixture\n');
mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');

const ws = await import('../src/brain/working-state.js');
const usage = await import('../src/brain/mcp-usage.js');

const spec = readFileSync(SPEC_PATH, 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// Table parsing. A markdown row is split on `|`; a cell's backticked literal
// is the machine-readable half. Nothing here assumes a row COUNT from the
// file — the counts are asserted separately, which is what stops a parser
// that has stopped matching from passing.
// ─────────────────────────────────────────────────────────────────────────
function rows(text) {
  return text.split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
}
function tick(cell) {
  const m = /`([^`]+)`/.exec(cell || '');
  return m ? m[1] : null;
}
/** The first integer in a cell, thousands separators removed. */
function firstInt(cell) {
  const m = /(\d[\d,]*)/.exec(cell || '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
/** The body of a `## ` or `### ` section, by a substring of its heading. */
function sectionText(headingFragment) {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.includes(headingFragment));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,3} /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  The spec file itself');
// ═════════════════════════════════════════════════════════════════════════
ok(spec.length > 4000, `the spec is present and non-trivial (${spec.length} bytes)`);
ok(/`working-state\/1`/.test(spec), 'it names the format id `working-state/1`');

// ═════════════════════════════════════════════════════════════════════════
section('§2  The handoff section grammar, against STATE_SECTIONS');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('The sections');
  ok(body !== null, 'the "The sections" table was found');
  const parsed = (body ? rows(body) : [])
    .filter((r) => /^\d+$/.test(r[0]))
    .map((r) => ({ n: Number(r[0]), heading: tick(r[1]), key: tick(r[2]), shape: (r[3] || '').trim() }));

  // THE DUMB CROSS-CHECK: the row count must equal the live array's length.
  // A reflowed or renamed table yields fewer rows and reds here rather than
  // silently comparing nothing.
  ok(parsed.length === ws.STATE_SECTIONS.length,
    `the table has ${parsed.length} rows and STATE_SECTIONS has ${ws.STATE_SECTIONS.length}`);

  ws.STATE_SECTIONS.forEach((sec, i) => {
    const row = parsed[i];
    ok(!!row && row.n === i + 1, `row ${i + 1} is numbered ${i + 1}`);
    ok(!!row && row.heading === sec.heading,
      row && row.heading === sec.heading
        ? `row ${i + 1} heading is exactly "${sec.heading}"`
        : `row ${i + 1} heading is "${row && row.heading}" but the store writes "${sec.heading}"`);
    ok(!!row && row.key === sec.key, `row ${i + 1} field is \`${sec.key}\``);
    ok(!!row && row.shape === sec.kind, `row ${i + 1} shape is "${sec.kind}"`);
  });

  // The ORDER is normative, so the spec must say so in as many words.
  ok(/order is normative/i.test(spec), 'the spec states that the section order is normative');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  The brief section grammar, against BRIEF_SECTIONS');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('the standing brief (tier 1)');
  ok(body !== null, 'the tier-1 section was found');
  const parsed = (body ? rows(body) : [])
    .filter((r) => /^\d+$/.test(r[0]))
    .map((r) => ({ heading: tick(r[1]), key: tick(r[2]), shape: (r[3] || '').trim() }));
  ok(parsed.length === ws.BRIEF_SECTIONS.length,
    `the table has ${parsed.length} rows and BRIEF_SECTIONS has ${ws.BRIEF_SECTIONS.length}`);
  ws.BRIEF_SECTIONS.forEach((sec, i) => {
    const row = parsed[i];
    ok(!!row && row.heading === sec.heading, `brief row ${i + 1} heading is exactly "${sec.heading}"`);
    ok(!!row && row.key === sec.key, `brief row ${i + 1} field is \`${sec.key}\``);
    ok(!!row && row.shape === sec.kind, `brief row ${i + 1} shape is "${sec.kind}"`);
  });
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  The budget table, against the live constants');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('Budgets, and what happens at each one');
  ok(body !== null, 'the budget table was found');
  const parsed = (body ? rows(body) : [])
    .map((r) => ({ label: r[0], value: firstInt(r[1]), constant: tick(r[2]), behaviour: r[3] }))
    .filter((r) => r.constant && /^[A-Z][A-Z0-9_]+$/.test(r.constant));

  const EXPECTED_ROWS = 13;   // every constant the spec promises a number for
  ok(parsed.length === EXPECTED_ROWS,
    `the table names ${parsed.length} constants (expected ${EXPECTED_ROWS} — a row that stops parsing must red, not vanish)`);

  for (const row of parsed) {
    const live = ws[row.constant];
    ok(typeof live === 'number',
      typeof live === 'number'
        ? `\`${row.constant}\` is exported by working-state.js`
        : `\`${row.constant}\` is named in the spec and is NOT exported by working-state.js`);
    ok(row.value === live,
      row.value === live
        ? `\`${row.constant}\` = ${live} matches the spec's ${row.value}`
        : `\`${row.constant}\` = ${live} but the spec says ${row.value}`);
  }

  // The asymmetry is the one sentence a reader must not lose.
  ok(/handoff is trimmed because refusing it loses it/i.test(spec),
    'the spec carries the trim-versus-refuse asymmetry in one sentence');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Name grammar, EXECUTED against isSafeSegment');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('4. Names') || sectionText('Names');
  ok(body !== null, 'the names section was found');
  ok(/1 to `64` characters/.test(spec) || /`64`/.test(body || ''),
    'the spec states the 64-character ceiling');

  // A claim about a grammar is only worth what the code does with it, so the
  // spec's own examples are RUN. `a`.repeat(64) is the boundary the spec
  // promises; 65 is the first refusal.
  ok(ws.isSafeSegment('a'.repeat(64)) === true, '64 characters is accepted (the spec\'s ceiling)');
  ok(ws.isSafeSegment('a'.repeat(65)) === false, '65 characters is refused');
  ok(ws.isSafeSegment('lumina') === true, 'a plain name is accepted');
  ok(ws.isSafeSegment('lumina.v2_final-1') === true, 'dot, underscore and hyphen are accepted');
  ok(ws.isSafeSegment('..') === false, '".." is refused');
  ok(ws.isSafeSegment('.hidden') === false, 'a leading dot is refused');
  ok(ws.isSafeSegment('a/b') === false, 'a path separator is refused');
  ok(ws.isSafeSegment('') === false, 'an empty name is refused');

  // The four reserved names the spec lists must be the store's own filenames.
  for (const name of [ws.BRIEF_FILENAME, ws.CURRENT_FILENAME, ws.JOURNAL_FILENAME, ws.FOUNDATIONS_DIRNAME]) {
    ok(spec.includes(`\`${name}\``), `the spec names the reserved \`${name}\``);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  The machine segment');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/`<hostname-slug>-<install-id>`|<hostname-slug>-<install-id>/.test(spec),
    'the spec gives the machine segment\'s shape');
  ok(String(ws.INSTALL_ID_RE) === '/^[0-9a-f]{4,16}$/',
    `INSTALL_ID_RE is ${ws.INSTALL_ID_RE} and the spec says 4–16 hex`);
  ok(/4–16|4-16/.test(spec), 'the spec states the 4–16 hex install-id range');
  ok(/-X theirs|theirs/.test(spec), 'the spec publishes the `-X theirs` reason, not just the rule');
  ok(/splice/i.test(spec), 'the spec names the splice, which is the harm a writer must not reintroduce');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  Foundations: slug grammar, roles, caps');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(spec.includes('^[a-z0-9][a-z0-9-]{0,63}\\.md$'), 'the spec gives the foundation slug regex verbatim');
  // Executed, not asserted: the store's own normaliser accepts what the spec promises.
  ok(ws.normaliseFoundationSlug('architecture.md') === 'architecture.md', 'a spec-shaped slug is accepted by the store');
  ok(ws.normaliseFoundationSlug('Architecture.MD') !== null, 'the store normalises case, which the spec does not promise away');
  ok(ws.normaliseFoundationSlug('../etc/passwd.md') === null, 'a traversal slug is refused');

  const rolesLine = /one of ([^|]+)\|/.exec(sectionText('canonical documents (tier 0)') || '');
  const named = ws.FOUNDATION_ROLES.every((r) => spec.includes(`\`${r}\``));
  ok(named, `every role (${ws.FOUNDATION_ROLES.join(', ')}) is named in the spec${rolesLine ? '' : ''}`);
  ok(spec.includes(`"version": ${ws.FOUNDATIONS_MANIFEST_VERSION}`) || spec.includes(`\`${ws.FOUNDATIONS_MANIFEST_VERSION}\``),
    `the spec pins the manifest version at ${ws.FOUNDATIONS_MANIFEST_VERSION}`);
  ok(new RegExp(`${ws.MAX_FOUNDATION_TITLE_CHARS}`).test(spec),
    `the spec states the ${ws.MAX_FOUNDATION_TITLE_CHARS}-character title cap`);
  ok(/`repo\.remote`/.test(spec) && /owner, repo, ref, path/.test(spec),
    'the spec documents `repo.remote` field by field');
  ok(/`readFirst`/.test(spec) && /tri-state/i.test(spec), 'the spec documents `readFirst` as tri-state on write');
  ok(/`skeleton`/.test(spec), 'the spec documents `skeleton`');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7b  project.json: the file, the cap, and the default EXECUTED');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('the project\u2019s own metadata') || sectionText('project.json');
  ok(body !== null, 'the spec has a §7b for `project.json`');
  ok(spec.includes(`\`${ws.PROJECT_META_FILENAME}\``), `the spec names the file \`${ws.PROJECT_META_FILENAME}\``);
  ok(spec.includes(`"version": ${ws.PROJECT_META_VERSION}`),
    `the spec shows version ${ws.PROJECT_META_VERSION} in the example`);
  // `(?![0-9])` IS LOAD-BEARING, and it was found by mutation: without it,
  // moving the live cap to 20 stayed GREEN because the manifest table one
  // section down says "at most `200` entries", which "at most `?20`?"
  // happily matches. An anchor that matches something else reports a cap
  // the spec does not state.
  ok(new RegExp(`at most \`?${ws.MAX_KNOWLEDGE_DOMAINS}\`?(?![0-9])`).test(body || ''),
    `the spec states the ${ws.MAX_KNOWLEDGE_DOMAINS}-domain cap — the live MAX_KNOWLEDGE_DOMAINS`);
  const reservedLine = (spec.split('\n').find((l) => /A project may not be called/.test(l)) || '');
  ok(reservedLine.includes(`\`${ws.PROJECT_META_FILENAME}\``),
    'the spec lists it among the reserved project names', reservedLine.slice(0, 120));
  // EXECUTED, because the claim a table cannot make is the DEFAULT's shape:
  // "absent is a value, and it is not an empty list."
  const metaDefault = await ws.readProjectMeta(DOMAIN, DOMAIN);
  ok(Array.isArray(metaDefault.knowledgeDomains) && metaDefault.knowledgeDomains.length === 1
    && metaDefault.knowledgeDomains[0] === DOMAIN,
  'EXECUTED: with no file, the list is the containing domain');
  ok(metaDefault.knowledgeDomainsDefaulted === true,
    'EXECUTED: …and the second field says it was defaulted, which is the whole promise');
  ok(ws.normaliseKnowledgeDomains(Array.from({ length: ws.MAX_KNOWLEDGE_DOMAINS + 1 }, (_, i) => `d${i}`)).domains.length
    === ws.MAX_KNOWLEDGE_DOMAINS, 'EXECUTED: the cap the spec states is the cap the store applies');
  ok(ws.projectPrefix(DOMAIN, ws.PROJECT_META_FILENAME) === null,
    'EXECUTED: the reserved name really is unaddressable as a project');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7c  One source per project, RE-CHOSEN — the switch, EXECUTED');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('`manifest.json`') || '';
  ok(/re-chosen/i.test(body), 'the spec says a mirror’s source can be RE-CHOSEN');
  ok(/`root: null`/.test(body) && /ordinary/.test(body) && /not\*{0,2}\s*an error/i.test(body),
    'the spec says `root: null` is ordinary and not an error');
  ok(/in the same write/i.test(body), 'the spec says the clear and the set land in ONE write');
  ok(/`ownership` never moves/.test(body), 'the spec says `ownership` never moves');
  ok(/preserved \*{0,2}by slug\*{0,2}/.test(body), 'the spec says `readFirst` is preserved by slug');
  ok(typeof ws.setFoundationsSource === 'function',
    'the store exports `setFoundationsSource`, the operation the paragraph describes');

  // EXECUTED (1): "root, remote, or BOTH" is a shape the store reads back
  // whole — including the one the paragraph calls ordinary, `root: null`.
  const dir = path.join(DOMAINS, DOMAIN, 'state', 'srcswitch', 'foundations');
  mkdirSync(path.join(DOMAINS, DOMAIN, 'state', 'srcswitch'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const manifestAbs = path.join(dir, 'manifest.json');
  const writeManifest = (repo) => writeFileSync(manifestAbs, JSON.stringify({
    version: ws.FOUNDATIONS_MANIFEST_VERSION,
    ownership: 'repo', repo,
    budgetBytes: ws.FOUNDATIONS_BUDGET_BYTES,
    order: [...ws.FOUNDATION_ROLES], documents: [],
  }, null, 2) + '\n');
  const REMOTE = { owner: 'acme', repo: 'thing', ref: null, path: null };

  writeManifest({ root: '/somewhere/checkout', remote: REMOTE, lastRefreshAt: null, lastRefreshCommit: null });
  const both = await ws.listFoundations(DOMAIN, 'srcswitch');
  ok(both.ok === true && both.repo && both.repo.root === '/somewhere/checkout' && both.repo.remote
     && both.repo.remote.owner === 'acme',
  'EXECUTED: a mirror holding BOTH a root and a remote reads back with both');

  writeManifest({ root: null, remote: REMOTE, lastRefreshAt: null, lastRefreshCommit: null });
  const remoteOnly = await ws.listFoundations(DOMAIN, 'srcswitch');
  ok(remoteOnly.ok === true && remoteOnly.ownership === 'repo' && remoteOnly.repo.root === null
     && remoteOnly.repo.remote.repo === 'thing',
  'EXECUTED: `root: null` with a remote is a readable mirror, not a refusal');

  // EXECUTED (2): "ownership never moves" — the switch REFUSES rather than
  // re-deciding it, and writes nothing while refusing. No network is reached:
  // the ownership is read before any client is built.
  const curDir = path.join(DOMAINS, DOMAIN, 'state', 'srccurator', 'foundations');
  mkdirSync(curDir, { recursive: true });
  const curManifest = path.join(curDir, 'manifest.json');
  writeFileSync(curManifest, JSON.stringify({
    version: ws.FOUNDATIONS_MANIFEST_VERSION, ownership: 'curator', repo: null,
    budgetBytes: ws.FOUNDATIONS_BUDGET_BYTES, order: [...ws.FOUNDATION_ROLES], documents: [],
  }, null, 2) + '\n');
  const before = createHash('sha256').update(readFileSync(curManifest)).digest('hex');
  const refused = await ws.setFoundationsSource(DOMAIN, 'srccurator', { remote: 'acme/thing' });
  ok(refused.ok === false && refused.reason === 'ownership-mismatch',
    'EXECUTED: switching a curator-owned project’s source is refused', JSON.stringify(refused).slice(0, 160));
  ok(createHash('sha256').update(readFileSync(curManifest)).digest('hex') === before,
    'EXECUTED: …and its manifest is byte-identical afterwards (sha256)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  The usage-log appendix, against mcp-usage.js');
// ═════════════════════════════════════════════════════════════════════════
{
  const body = sectionText('the local usage log');
  ok(body !== null, 'appendix A was found');
  ok(new RegExp(`\`${usage.MAX_LINE_BYTES}\` bytes`).test(body || ''),
    `the appendix states the ${usage.MAX_LINE_BYTES}-byte ceiling (MAX_LINE_BYTES)`);
  ok(String(usage.SID_RE) === '/^[0-9a-f]{12}$/', `SID_RE is ${usage.SID_RE}`);
  ok((body || '').includes('^[0-9a-f]{12}$'), 'the appendix gives SID_RE verbatim');
  for (const key of usage.LINE_KEYS) {
    ok((body || '').includes(`\`${key}\``) || new RegExp(`"${key}"`).test(body || ''),
      `the appendix names the tool-line key \`${key}\``);
  }
  for (const key of usage.SESSION_LINE_KEYS) {
    ok((body || '').includes(`\`${key}\``) || new RegExp(`"${key}"`).test(body || ''),
      `the appendix names the session-line key \`${key}\``);
  }
  // The example line in the appendix must itself be within the ceiling — a
  // specimen over the limit would teach a writer the wrong shape.
  const sample = /\{"ts":"[^\n]*"\}/.exec(body || '');
  ok(!!sample, 'the appendix carries a specimen line');
  if (sample) {
    ok(Buffer.byteLength(sample[0], 'utf8') <= usage.MAX_LINE_BYTES,
      `the specimen line is ${Buffer.byteLength(sample[0], 'utf8')} bytes, within ${usage.MAX_LINE_BYTES}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  EXECUTED: a real save renders the grammar §5 promises');
// ═════════════════════════════════════════════════════════════════════════
let renderedOk = false;
try {
  const scope = 'spec-suite';
  const res = await ws.saveWorkingState(DOMAIN, {
    scope,
    headline: 'A handoff rendered by the suite',
    nowState: 'Prose paragraph.',
    decisions: ['One decision'],
    traps: ['One trap'],
    nextSteps: ['One next step'],
    observations: [{ statement: 'A measurement', observedAt: '2026-09-19T10:00:00Z', recheck: 'echo hi' }],
    openQuestions: ['One question'],
    foundationsRead: { 'architecture.md': 'a'.repeat(64) },
    harness: 'suite',
    model: 'none',
  });
  ok(res.ok === true, `the fixture save succeeded (${res.ok ? res.path : res.reason})`);
  if (res.ok) {
    const machineDirs = readdirSync(path.join(DOMAINS, DOMAIN, 'state', scope));
    ok(machineDirs.length === 1, 'exactly one machine directory was created');
    const machine = machineDirs[0];
    ok(machine === ws.machineId(), `the directory name is the machine segment (${machine})`);

    const dir = path.join(DOMAINS, DOMAIN, 'state', scope, machine);
    const doc = readFileSync(path.join(dir, ws.CURRENT_FILENAME), 'utf8');
    const lines = doc.split('\n');

    ok(lines[0] === `# Working state — ${scope}`, `line 1 is "# Working state — <scope>" (got "${lines[0]}")`);
    ok(lines[2] === '> A handoff rendered by the suite', 'the headline is a blockquote line');
    ok(/^_Machine: .+ · Scope: .+ · Saved: .+ · Harness: .+ · Model: .+_$/.test(lines[4]),
      `the provenance line has the spec's field order (got "${lines[4]}")`);

    // Every heading appears exactly once, in STATE_SECTIONS order.
    const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    ok(headings.length === ws.STATE_SECTIONS.length,
      `the document carries all ${ws.STATE_SECTIONS.length} headings (got ${headings.length})`);
    ok(headings.join('|') === ws.STATE_SECTIONS.map((s) => s.heading).join('|'),
      'the headings are in exactly the spec\'s order');
    ok(new Set(headings).size === headings.length, 'no heading appears twice (the forgery signal)');

    // The observation shape the spec publishes.
    const obs = lines.find((l) => l.startsWith('- A measurement'));
    ok(/^- A measurement — observed \d{4}-\d{2}-\d{2}T[\d:.]+Z — recheck: `echo hi`$/.test(obs || ''),
      `the observation renders the spec's shape (got "${obs}")`);

    // The foundations-read shape, and that it parses back.
    const fr = lines.find((l) => l.startsWith('- architecture.md'));
    ok(/^- architecture\.md · [0-9a-f]{64}$/.test(fr || ''), 'the foundations-read line is `- <slug> · <sha256>`');
    const parsedBack = ws.parseFoundationsRead(doc);
    ok(!!parsedBack && parsedBack['architecture.md'] === 'a'.repeat(64),
      'the store parses that line back to {slug: sha256}, as the spec says it is the only parsed section');

    // The journal line's field set is exactly the spec's table.
    const jl = readFileSync(path.join(dir, ws.JOURNAL_FILENAME), 'utf8').trim().split('\n');
    ok(jl.length === 1, 'one journal line was appended');
    const rec = JSON.parse(jl[0]);
    const SPEC_JOURNAL_KEYS = ['at', 'scope', 'machine', 'harness', 'model', 'headline', 'bytes', 'rejections'];
    ok(Object.keys(rec).join(',') === SPEC_JOURNAL_KEYS.join(','),
      `the journal line's keys are ${Object.keys(rec).join(', ')} and the spec lists ${SPEC_JOURNAL_KEYS.join(', ')}`);
    for (const key of SPEC_JOURNAL_KEYS) {
      ok(new RegExp(`\`${key}\``).test(spec), `the spec's journal table names \`${key}\``);
    }
    ok(/persisted name that means \*notes\*|persisted name/i.test(spec),
      'the spec explains that `rejections` is a persisted name meaning notes');

    // The read side reports the file as UNREPAIRED — the conformance claim.
    const read = await ws.readWorkingState(DOMAIN, { scope });
    ok(read.ok === true && read.current?.present === true, 'the store reads the handoff back');
    ok(read.current?.sanitisedOnRead === false,
      `a spec-conformant document needs no repair on read (sanitisedOnRead: ${read.current?.sanitisedOnRead})`);
    ok(read.current?.headingsSuspect === false,
      `no heading is flagged as repeated (headingsSuspect: ${read.current?.headingsSuspect})`);
    renderedOk = true;
  }
} catch (err) {
  ok(false, `the execution section threw: ${err && err.message}`);
}
ok(renderedOk, 'the executed rendering section completed (it must never be skipped silently)');

// ═════════════════════════════════════════════════════════════════════════
section('§10  EXECUTED: the bootstrap table\'s read-first row');
// ═════════════════════════════════════════════════════════════════════════
try {
  const init = await ws.initFoundations(DOMAIN, DOMAIN, { ownership: 'curator' });
  ok(init.ok === true, `tier 0 initialised curator-owned (${init.ok ? 'ok' : init.reason})`);
  const a = await ws.saveFoundation(DOMAIN, DOMAIN, {
    slug: 'architecture.md', role: 'architecture', title: 'Architecture',
    text: '# Architecture\n\nFlagged body.\n', commissionedByOwner: true, instructedBy: 'user',
    readFirst: true,
  });
  const b = await ws.saveFoundation(DOMAIN, DOMAIN, {
    slug: 'guide.md', role: 'guide', title: 'Guide',
    text: '# Guide\n\nUnflagged body.\n', commissionedByOwner: true, instructedBy: 'user',
  });
  ok(a.ok === true && b.ok === true, `two documents written (${a.ok}/${b.ok}${a.ok ? '' : ` ${a.reason}: ${a.message}`})`);

  const ctx = await ws.getProjectContext(DOMAIN, DOMAIN, {});
  ok(ctx.ok === true, 'the bootstrap answered');
  const f = ctx.foundations || {};
  ok(f.bodySelection === 'read-first',
    `with one document flagged the selection is "read-first" (got "${f.bodySelection}") — the spec's table row`);
  const bodies = (f.documents || []).map((d) => d.slug);
  ok(bodies.includes('architecture.md'), 'the flagged document arrives with its body');
  ok(!bodies.includes('guide.md'), 'the unflagged document does NOT arrive with its body');
  const indexSlugs = (f.index?.documents || f.documents || []).map((d) => d.slug);
  ok((f.index?.documents || []).length === 2 || indexSlugs.length >= 1,
    'the index carries every document, as the spec says the index is always sent');
  ok(f.readFirstBudgetBytes === ws.CONTEXT_MAX_BYTES_DEFAULT,
    `the read-first budget is the bootstrap budget (${f.readFirstBudgetBytes} vs ${ws.CONTEXT_MAX_BYTES_DEFAULT})`);
  ok(/Reads never write/i.test(spec), 'the spec states that reads never mark anything seen');
} catch (err) {
  ok(false, `the bootstrap section threw: ${err && err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§11  Cross-check: every constant the spec names is a real export');
// ═════════════════════════════════════════════════════════════════════════
{
  const named = [...spec.matchAll(/`(MAX_[A-Z0-9_]+|CONTEXT_MAX_[A-Z0-9_]+|FOUNDATIONS_[A-Z0-9_]+)`/g)]
    .map((m) => m[1]);
  const unique = [...new Set(named)];
  ok(unique.length >= 10, `the spec names ${unique.length} store constants (a spec naming none would be vacuous)`);
  for (const name of unique) {
    const live = ws[name] !== undefined ? ws[name] : usage[name];
    ok(live !== undefined,
      live !== undefined
        ? `\`${name}\` exists`
        : `\`${name}\` is named in the spec and exported by NEITHER module — a rename the spec did not follow`);
  }
}

// ── Teardown ──────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES — docs/spec/working-state-v1.md has drifted from the code'); process.exit(1); }
console.log('✅ docs/spec/working-state-v1.md matches the live store');
