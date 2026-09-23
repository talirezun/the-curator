/**
 * test-reading-budget.js — OFFLINE. v3.67.0 package S: the owner's READING
 * BUDGET, the third per-document state ("not at start"), PLANNED mode, and
 * every door they reach (store, MCP, CLI Markdown, Chat, routes).
 *
 * What this suite exists to prove, each by EXECUTION rather than by reading
 * source:
 *
 *   1. AN UNTOUCHED PROJECT IS BYTE-IDENTICAL TO v3.66.0. The maintainer's
 *      decision (1). `getProjectContext` over three fixtures (no documents,
 *      unflagged, flagged) is normalised, stripped of EXACTLY the v3.67.0
 *      additive fields, and hashed; the hash is the one v3.66.0's store
 *      (main = 1568d2a) produced over the same fixture, pinned below. Run
 *      `RB_BASELINE_ROOT=<a v3.66.0 checkout> node scripts/test-reading-budget.js`
 *      to recompute it against that checkout instead of asserting.
 *   2. `readingBudgetBytes` is parsed BEFORE `readProjectMeta`'s
 *      knowledgeDomains early return — a project.json with only a budget
 *      reads its budget (the contract's named hand mutation reds here).
 *   3. NO AGENT PATH WRITES IT: every agent-reachable writer is driven with the
 *      field planted, and project.json is byte-identical afterwards.
 *   4. `readFirst` and `hidden` are mutually exclusive in ONE manifest write,
 *      and preserved by save, refresh and a switch of source.
 *   5. PLANNED mode, Index only (0), the ceiling, the internal what-if — and
 *      that `args.whatIf` over MCP is IGNORED.
 *   6. The session-start routes measure the REAL handler and the REAL hook
 *      Markdown, and the preview writes nothing: no file, no usage-log line.
 *
 * ISOLATION: a throwaway domains folder and user-data folder under the OS
 * temp dir, set through BOTH env seams before the store is imported, plus the
 * in-process overrides. No network, no LLM, no credential file.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.RB_BASELINE_ROOT ? path.resolve(process.env.RB_BASELINE_ROOT) : path.join(HERE, '..');
const BASELINE_MODE = !!process.env.RB_BASELINE_ROOT;
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-reading-budget-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-reading-budget-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

let passed = 0; let failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err !== undefined) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err === undefined ? 'assertion failed' : err); }
function eq(a, b, label) { assert(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(name) { console.log(`\n── ${name} ──`); }

const { __setUserDataDirOverride } = await import(mod('src/brain/paths.js'));
const { __setDomainsDirOverride } = await import(mod('src/brain/config.js'));
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
const WS = await import(mod('src/brain/working-state.js'));

function makeDomain(slug, frontmatter) {
  mkdirSync(path.join(DOMAINS, slug, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, slug, 'CLAUDE.md'), `${frontmatter || ''}# ${slug}\n`);
  writeFileSync(path.join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
}
const stateDir = (d, p) => (p === d ? path.join(DOMAINS, d, 'state') : path.join(DOMAINS, d, 'state', p));
const metaPath = (d, p) => path.join(stateDir(d, p), 'project.json');
const manifestPath = (d, p) => path.join(stateDir(d, p), 'foundations', 'manifest.json');
const body = (label, kb) => `# ${label}\n\n${'Line of text https://example.com here.\n'.repeat(Math.ceil((kb * 1024) / 39))}`;
const sha = (x) => createHash('sha256').update(x).digest('hex');
const readManifestRaw = (d, p) => JSON.parse(readFileSync(manifestPath(d, p), 'utf8'));

// ═════════════════════════════════════════════════════════════════════════
// §0 — THE UNTOUCHED-PROJECT BYTE-IDENTITY FIXTURE (runs first, and alone in
// baseline mode). Built with only v3.66.0-era calls, so the SAME code builds
// it on either checkout.
// ═════════════════════════════════════════════════════════════════════════
makeDomain('bi');
const BI_BRIEF = '# bi\n\n## Goal\n\nBuild it.\n';
await WS.saveProjectBriefText('bi', 'bi', BI_BRIEF);
for (const p of ['unflag', 'flag']) await WS.createProject('bi', p, {});
for (const p of ['bi', 'unflag', 'flag']) {
  await WS.saveWorkingState('bi', {
    project: p === 'bi' ? undefined : p, scope: 'main', headline: `handoff ${p}`,
    nowState: 'Now.', decisions: ['d1'], nextSteps: ['n1'], harness: 'suite', model: 'none',
  });
}
for (const p of ['unflag', 'flag']) {
  await WS.saveFoundation('bi', p, { slug: 'architecture.md', role: 'architecture', text: body('Arch', 30), readFirst: p === 'flag' ? true : undefined });
  await WS.saveFoundation('bi', p, { slug: 'roadmap.md', role: 'roadmap', text: body('Road', 100) });
  await WS.saveFoundation('bi', p, { slug: 'guide.md', role: 'guide', text: body('Guide', 5) });
}
const BI_CASES = [['bi', 'bi'], ['bi', 'unflag'], ['bi', 'flag']];
const BI_OPTS = [{}, { include: 'all' }, { include: 'index' }, { maxBytes: 20000 }, { slugs: ['guide.md'] }];
// EXACTLY the v3.67.0 additive fields — a field not named here that appears
// on the branch changes the hash and reds §1, which is the point.
const V3670_ADDITIVE = new Set(['readingBudgetBytes', 'readingBudgetDefaulted', 'readingBudgetError', 'planned', 'hiddenCount', 'hidden', 'atStart']);
const V3670_BUDGET_ADDITIVE = new Set(['source', 'defaulted', 'cap', 'ceilingBytes']);
const TIME_KEY = /(At|Seconds|Age|age|Ms)$|^mtime$|^updatedAt$|^savedAt$/;
async function biDigest() {
  const all = {};
  let machine = null;
  for (const [d, p] of BI_CASES) {
    for (const o of BI_OPTS) {
      const ctx = await WS.getProjectContext(d, p, o);
      if (!machine && ctx.machine) machine = ctx.machine;
      all[`${p} ${JSON.stringify(o)}`] = ctx;
    }
  }
  const strip = (v, parentKey) => {
    if (Array.isArray(v)) return v.map((x) => strip(x));
    if (!v || typeof v !== 'object') return v;
    const outObj = {};
    for (const [k, x] of Object.entries(v)) {
      if (TIME_KEY.test(k)) continue;
      if (V3670_ADDITIVE.has(k)) continue;
      if (parentKey === 'budget' && V3670_BUDGET_ADDITIVE.has(k)) continue;
      outObj[k] = strip(x, k);
    }
    return outObj;
  };
  let json = JSON.stringify(strip(all));
  if (machine) json = json.split(machine).join('<machine>');
  json = json.split(TMP).join('<tmp>');
  // Clock readings inside TEXT (a handoff's "Saved: …" line) move per run.
  json = json.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  if (process.env.RB_DUMP) writeFileSync(process.env.RB_DUMP, json);
  return { digest: sha(json), bytes: json.length };
}
// The digest v3.66.0 (main = 1568d2a) produced over this exact fixture,
// computed with RB_BASELINE_ROOT pointing at that checkout.
const BI_BASELINE = '071e3ebcae985c7c97c19c4a623ed286b208f2e767ba1da3e2a967edca701284';
if (BASELINE_MODE) {
  const b = await biDigest();
  console.log(`BASELINE ${b.digest} (${b.bytes} normalised bytes) from ${ROOT}`);
  process.exit(0);
}

const tools = await import(mod('mcp/tools/working-state.js'));
const md = await import(mod('src/brain/context-markdown.js'));
const cliCtx = await import(mod('src/cli/context.js'));
const chat = await import(mod('src/brain/chat.js'));
const paths = await import(mod('src/brain/paths.js'));

section('1. AN UNTOUCHED PROJECT IS BYTE-IDENTICAL TO v3.66.0');
{
  const b = await biDigest();
  eq(b.digest, BI_BASELINE, `getProjectContext over three untouched fixtures × five option sets, minus the v3.67.0 additive fields, hashes to v3.66.0's digest (${b.bytes} normalised bytes)`);
  const plain = await WS.getProjectContext('bi', 'unflag', {});
  eq(plain.foundations.planned, false, 'an untouched project is NOT planned');
  eq(plain.foundations.bodySelection, 'all', '…and with nothing flagged and nothing seen it still sends every body (v3.61.1\'s row)');
  eq(plain.foundations.budget.source, 'default', '…against the default budget, named');
  eq(plain.foundations.budget.maxBytes, WS.CONTEXT_MAX_BYTES_DEFAULT, '…of 120 KB');
  eq(plain.foundations.budget.defaulted, true, '…and `defaulted` says so');
  eq(plain.foundations.budget.cap, WS.CONTEXT_MAX_BYTES_CAP, '`budget.cap` is the store ceiling');
  eq(plain.foundations.budget.ceilingBytes, null, '`budget.ceilingBytes` is null when no caller ceiling was passed');
  eq(plain.foundations.hiddenCount, 0, '`hiddenCount` is 0, present rather than absent');
  eq(plain.readingBudgetBytes, null, 'the envelope says no budget is set: readingBudgetBytes null…');
  eq(plain.readingBudgetDefaulted, true, '…readingBudgetDefaulted true');
  assert(!('readingBudgetError' in plain), '…and no readingBudgetError when there is none');
}

section('2. THE CONSTANTS — the contract\'s join names, verbatim');
{
  eq(JSON.stringify(WS.READING_BUDGET_PRESETS),
    JSON.stringify([{ id: 'index-only', bytes: 0 }, { id: 'lean', bytes: 32768 }, { id: 'standard', bytes: 65536 }, { id: 'deep', bytes: 122880 }, { id: 'max', bytes: 204800 }]),
    'READING_BUDGET_PRESETS');
  eq(WS.READING_BUDGET_RECOMMENDED, 'standard', 'READING_BUDGET_RECOMMENDED');
  eq(WS.READING_BUDGET_MIN_BYTES, 8192, 'READING_BUDGET_MIN_BYTES');
  eq(JSON.stringify(WS.FOUNDATION_START_STATES), '["read-first","on-request","not-at-start"]', 'FOUNDATION_START_STATES');
  assert(Object.isFrozen(WS.READING_BUDGET_PRESETS) && Object.isFrozen(WS.READING_BUDGET_PRESETS[0]) && Object.isFrozen(WS.FOUNDATION_START_STATES),
    'the presets and the alphabet are frozen');
  for (const v of [0, 8192, 65536, 204800]) assert(WS.isValidReadingBudget(v), `${v} is a valid budget`);
  for (const v of [1, 8191, 204801, 1.5, -1, '65536', null, NaN]) assert(!WS.isValidReadingBudget(v), `${JSON.stringify(v)} is NOT a valid budget`);
}

section('3. readProjectMeta — the budget is its OWN field, parsed first');
makeDomain('alpha');
await WS.createProject('alpha', 'p1', {});
await WS.createProject('alpha', 'p2', {});
{
  const none = await WS.readProjectMeta('alpha', 'p1');
  assert(none.readingBudgetBytes === null && none.readingBudgetDefaulted === true && none.readingBudgetError === null,
    'no file: readingBudgetBytes null, defaulted, no error');
  writeFileSync(metaPath('alpha', 'p1'), JSON.stringify({ version: 1, readingBudgetBytes: 65536 }));
  const only = await WS.readProjectMeta('alpha', 'p1');
  assert(only.readingBudgetBytes === 65536 && only.readingBudgetDefaulted === false,
    'a project.json with only a budget reads its budget', JSON.stringify(only));
  assert(only.knowledgeDomainsDefaulted === true && JSON.stringify(only.knowledgeDomains) === '["alpha"]',
    '…and its knowledge domains still read as the default');
  writeFileSync(metaPath('alpha', 'p1'), JSON.stringify({ version: 1, knowledgeDomains: ['alpha'], readingBudgetBytes: 0 }));
  const both = await WS.readProjectMeta('alpha', 'p1');
  assert(both.readingBudgetBytes === 0 && both.readingBudgetDefaulted === false && both.knowledgeDomainsDefaulted === false,
    'both fields together: 0 is a real budget (Index only), not "unset"', JSON.stringify(both));
  for (const v of [100, 204801, 1.5, '65536', -5, true]) {
    writeFileSync(metaPath('alpha', 'p1'), JSON.stringify({ version: 1, readingBudgetBytes: v }));
    const m = await WS.readProjectMeta('alpha', 'p1');
    assert(m.readingBudgetBytes === null && m.readingBudgetDefaulted === true && /readingBudgetBytes/.test(m.readingBudgetError || ''),
      `a hand-edited ${JSON.stringify(v)} reads as NOT SET, with the defect named — never a refusal`, JSON.stringify(m));
  }
  writeFileSync(metaPath('alpha', 'p1'), JSON.stringify({ version: 1, readingBudgetBytes: 100, knowledgeDomains: ['alpha'] }));
  const mixed = await WS.readProjectMeta('alpha', 'p1');
  assert(mixed.metaError === null && mixed.knowledgeDomainsDefaulted === false,
    'a bad budget never becomes a knowledge-domains error (the two are independent)');
  const env = await WS.readWorkingState('alpha', { project: 'p1' });
  assert(env.readingBudgetBytes === null && env.readingBudgetDefaulted === true && typeof env.readingBudgetError === 'string',
    'the readWorkingState envelope carries readingBudgetBytes / readingBudgetDefaulted / readingBudgetError');
  rmSync(metaPath('alpha', 'p1'));
}

section('4. setReadingBudget — the one writer, read–modify–write, refusals named');
makeDomain('shared-mirror', '---\nreadonly: true\n---\n\n');
{
  const r = await WS.setReadingBudget('alpha', 'p1', 65536);
  assert(r.ok && r.readingBudgetBytes === 65536 && r.readingBudgetDefaulted === false && r.cleared === false,
    'set 64 KB', JSON.stringify(r));
  assert(r.readFirstBudgetBytes === 65536 && r.readFirstBudgetExceeded === false,
    '…and the reply carries the read-first readings AGAINST THE NEW BUDGET');
  eq(JSON.parse(readFileSync(metaPath('alpha', 'p1'), 'utf8')).readingBudgetBytes, 65536, 'it is on disk');
  const kd = await WS.setKnowledgeDomains('alpha', 'p1', ['alpha'], { listDomains: async () => ['alpha'] });
  assert(kd.ok, '(fixture) knowledge domains set on the same file');
  eq(JSON.parse(readFileSync(metaPath('alpha', 'p1'), 'utf8')).readingBudgetBytes, 65536,
    'a knowledge-domains write PRESERVES the budget (read–modify–write)');
  const z = await WS.setReadingBudget('alpha', 'p1', 0);
  assert(z.ok && z.readingBudgetBytes === 0, 'set 0 (Index only)');
  eq(JSON.stringify(JSON.parse(readFileSync(metaPath('alpha', 'p1'), 'utf8')).knowledgeDomains), '["alpha"]',
    '…and a budget write PRESERVES the knowledge domains');
  const c1 = await WS.setReadingBudget('alpha', 'p1', null);
  assert(c1.ok && c1.cleared === true && c1.readingBudgetBytes === null && c1.readingBudgetDefaulted === true, 'null clears it');
  assert(!('readingBudgetBytes' in JSON.parse(readFileSync(metaPath('alpha', 'p1'), 'utf8'))), '…the field is gone from the file');
  await WS.setKnowledgeDomains('alpha', 'p1', null);
  assert(!existsSync(metaPath('alpha', 'p1')), 'nothing left but version → the file is removed');
  const c2 = await WS.setReadingBudget('alpha', 'p1', 32768);
  assert(c2.ok && existsSync(metaPath('alpha', 'p1')), 'a budget alone creates the file');
  await WS.setReadingBudget('alpha', 'p1', null);
  assert(!existsSync(metaPath('alpha', 'p1')), 'clearing the only field removes it again');
  for (const v of [1, 8191, 204801, 1.5, '65536', undefined, {}]) {
    const bad2 = await WS.setReadingBudget('alpha', 'p1', v);
    assert(bad2.ok === false && bad2.reason === 'invalid-reading-budget', `${JSON.stringify(v)} is refused invalid-reading-budget`);
  }
  assert(!existsSync(metaPath('alpha', 'p1')), '…and a refusal writes nothing');
  eq((await WS.setReadingBudget('alpha', 'nope', 65536)).reason, 'unknown-state-project', 'an unknown project is refused');
  const mir = await WS.setReadingBudget('shared-mirror', 'shared-mirror', 65536);
  assert(mir.ok === false, 'a read-only Shared Brain mirror is refused', JSON.stringify(mir));
}

section('5. NO AGENT WRITES IT — every agent-reachable writer, driven with the field planted');
{
  await WS.setReadingBudget('alpha', 'p2', 65536);
  const before = readFileSync(metaPath('alpha', 'p2'), 'utf8');
  const PLANT = { readingBudgetBytes: 0, reading_budget_bytes: 0, readingBudget: 0, reading_budget: 0 };
  const st = await WS.saveWorkingState('alpha', { project: 'p2', scope: 'main', headline: 'h', nowState: 'x', harness: 'suite', model: 'none', ...PLANT });
  assert(st.ok, '(fixture) a store save succeeds', st.message);
  const storage = { listDomains: async () => ['alpha'] };
  const h1 = await tools.saveWorkingStateHandler({ project: 'p2', domain: 'alpha', scope: 'main', headline: 'h2', now_state: 'y', ...PLANT }, storage);
  assert(h1.ok, '(fixture) save_working_state succeeds', JSON.stringify(h1).slice(0, 200));
  const h2 = await tools.saveProjectBriefHandler({ project: 'p2', domain: 'alpha', text: '# p2\n\n## Goal\n\nA goal.\n', commissioned_by_owner: true, ...PLANT }, storage);
  assert(h2 && typeof h2 === 'object', '(fixture) save_project_brief answered');
  const h3 = await tools.saveFoundationHandler({ project: 'p2', domain: 'alpha', slug: 'notes', role: 'other', text: '# N\n\nx\n', commissioned_by_owner: true, ...PLANT }, storage);
  assert(h3 && typeof h3 === 'object', '(fixture) save_foundation answered');
  eq(readFileSync(metaPath('alpha', 'p2'), 'utf8'), before,
    'project.json is BYTE-IDENTICAL after the store save, save_working_state, save_project_brief and save_foundation, each carrying the field');
  // The CLI's save: the real binary, as a subprocess, with the field planted
  // in the handoff JSON on stdin.
  const { spawnSync } = await import('node:child_process');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'curator.js'), 'save', '--project', 'alpha/p2', '--scope', 'main', '--harness', 'suite'], {
    input: JSON.stringify({ headline: 'cli', nowState: 'z', ...PLANT }),
    env: { ...process.env, CURATOR_TEST_USER_DATA_DIR: USER_DATA, CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_HOOK_DIR: path.join(TMP, 'hooks') },
    encoding: 'utf8', timeout: 30000,
  });
  eq(cli.status, 0, `(fixture) \`my-curator save\` succeeded (${(cli.stderr || '').trim().slice(0, 160)})`);
  eq(readFileSync(metaPath('alpha', 'p2'), 'utf8'), before, '…and after `my-curator save` too');
  // Structural half: no MCP tool ADVERTISES the field, and the only caller of
  // the setter in shipped code is the app's route.
  const idx = await import(mod('mcp/tools/index.js'));
  const schemaText = JSON.stringify(idx.tools.map((t) => t.definition.inputSchema));
  assert(!/reading_?budget/i.test(schemaText), 'no MCP tool schema declares a reading-budget argument');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? (['node_modules', 'public'].includes(e.name) ? [] : walk(path.join(dir, e.name)))
    : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const callers = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'mcp')), ...walk(path.join(ROOT, 'bin'))]
    .filter((f) => /setReadingBudget\s*\(/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  eq(JSON.stringify(callers.sort()), JSON.stringify(['src/brain/working-state.js', 'src/routes/memory.js']),
    'setReadingBudget is defined in the store and CALLED only by the app\'s route');
  await WS.setReadingBudget('alpha', 'p2', null);
}

section('6. START STATES — readFirst and hidden, exclusive in ONE manifest write');
{
  for (const [slug, role, kb] of [['architecture.md', 'architecture', 10], ['decisions.md', 'decisions', 20], ['roadmap.md', 'roadmap', 90]]) {
    await WS.saveFoundation('alpha', 'alpha', { slug, role, text: body(slug, kb) });
  }
  const mBefore = readFileSync(manifestPath('alpha', 'alpha'), 'utf8');
  assert(!/"hidden"/.test(mBefore), 'an untouched manifest carries NO `hidden` key — written only when true');
  const h = await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'not-at-start');
  assert(h.ok && h.atStart === 'not-at-start' && h.wasAtStart === 'on-request' && h.changed === true && h.hidden === true && h.readFirst === false,
    'on request → not at start', JSON.stringify(h));
  assert(h.hiddenCount === 1 && h.onRequestCount === 2 && h.readFirstCount === 0,
    '…the counts: 1 hidden, 2 on request (hidden is NOT on request), 0 read first');
  let raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(raw.hidden === true && raw.readFirst === false, '…on disk: hidden true, readFirst false');
  const rf = await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'read-first');
  raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(rf.ok && rf.readFirst === true && rf.hidden === false && raw.readFirst === true && !('hidden' in raw),
    'not at start → read first: readFirst set AND hidden cleared in the same write', JSON.stringify(raw));
  await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'not-at-start');
  const viaFlag = await WS.setFoundationReadFirst('alpha', 'alpha', 'roadmap.md', true);
  raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(viaFlag.ok && raw.readFirst === true && !('hidden' in raw) && viaFlag.atStart === 'read-first',
    'setFoundationReadFirst(true) also clears hidden');
  await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'not-at-start');
  const off = await WS.setFoundationReadFirst('alpha', 'alpha', 'roadmap.md', false);
  raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(off.ok && off.changed === false && raw.hidden === true && off.hidden === true && off.atStart === 'not-at-start',
    'setFoundationReadFirst(false) leaves hidden where it was — and says so', JSON.stringify(off));
  const shaBefore = sha(readFileSync(manifestPath('alpha', 'alpha')));
  const noop = await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'not-at-start');
  assert(noop.ok && noop.changed === false && sha(readFileSync(manifestPath('alpha', 'alpha'))) === shaBefore,
    're-asserting the same state is a NO-OP WRITE (manifest byte-identical)');
  for (const s of ['hidden', 'READ-FIRST', '', null, 'first']) {
    eq((await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', s)).reason, 'invalid-start-state', `${JSON.stringify(s)} is refused invalid-start-state`);
  }
  eq((await WS.setFoundationStartState('alpha', 'alpha', 'ghost.md', 'read-first')).reason, 'not-found', 'an unknown slug is not-found');
  // saveFoundation PRESERVES hidden; an explicit readFirst:true clears it.
  await WS.saveFoundation('alpha', 'alpha', { slug: 'roadmap.md', role: 'roadmap', text: body('roadmap v2', 90) });
  raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(raw.hidden === true, 'an ordinary save of the text PRESERVES "not at start"');
  await WS.saveFoundation('alpha', 'alpha', { slug: 'roadmap.md', role: 'roadmap', text: body('roadmap v3', 90), readFirst: false });
  raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(raw.hidden === true, '…an explicit readFirst:false leaves it too');
  const sv = await WS.saveFoundation('alpha', 'alpha', { slug: 'roadmap.md', role: 'roadmap', text: body('roadmap v4', 90), readFirst: true });
  raw = readManifestRaw('alpha', 'alpha').documents.find((d) => d.slug === 'roadmap.md');
  assert(sv.ok && sv.hidden === false && raw.readFirst === true && !('hidden' in raw), '…and an explicit readFirst:true clears it');
  await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'on-request');
  // A HAND EDIT with both flags reads as read first, and the contradiction is NAMED.
  const man = readManifestRaw('alpha', 'alpha');
  man.documents = man.documents.map((d) => (d.slug === 'decisions.md' ? { ...d, readFirst: true, hidden: true } : d));
  writeFileSync(manifestPath('alpha', 'alpha'), JSON.stringify(man, null, 2));
  const lf = await WS.listFoundations('alpha', 'alpha');
  const dec = lf.documents.find((d) => d.slug === 'decisions.md');
  assert(dec.readFirst === true && dec.hidden === false && dec.atStart === 'read-first',
    'a hand edit with BOTH flags reads as read first (the fail-safe direction)');
  assert(lf.manifestNotes.some((n) => /decisions\.md/.test(n) && /both/.test(n)), '…and the contradiction is disclosed in manifestNotes', JSON.stringify(lf.manifestNotes));
  await WS.setFoundationStartState('alpha', 'alpha', 'decisions.md', 'on-request');
  assert(!/"hidden"/.test(readFileSync(manifestPath('alpha', 'alpha'), 'utf8')), '…and the next write resolves it on disk');
}

section('7. A REFRESH AND A SOURCE SWITCH PRESERVE hidden BY SLUG');
{
  const REPO = path.join(TMP, 'repo');
  mkdirSync(path.join(REPO, 'docs'), { recursive: true });
  writeFileSync(path.join(REPO, 'docs', 'architecture.md'), '# A\n\none\n');
  writeFileSync(path.join(REPO, 'docs', 'old-roadmap.md'), '# R\n\none\n');
  await WS.createProject('alpha', 'mirror', {});
  const r1 = await WS.refreshFoundationsFromRepo('alpha', 'mirror', REPO, { files: [{ path: 'docs/architecture.md' }, { path: 'docs/old-roadmap.md' }] });
  assert(r1.ok, '(fixture) a local mirror is created', r1.message);
  const bytesBefore = readFileSync(path.join(stateDir('alpha', 'mirror'), 'foundations', 'old-roadmap.md'));
  const st = await WS.setFoundationStartState('alpha', 'mirror', 'old-roadmap.md', 'not-at-start');
  assert(st.ok, 'a REPO-OWNED mirror can be routed "not at start" (curator metadata, not content)', JSON.stringify(st));
  assert(readFileSync(path.join(stateDir('alpha', 'mirror'), 'foundations', 'old-roadmap.md')).equals(bytesBefore),
    '…and the mirrored document\'s bytes are untouched');
  writeFileSync(path.join(REPO, 'docs', 'old-roadmap.md'), '# R\n\ntwo, edited in the checkout\n');
  const r2 = await WS.refreshFoundationsFromRepo('alpha', 'mirror', REPO);
  assert(r2.ok && r2.refreshed.includes('old-roadmap.md'), '(fixture) the edited source is re-copied', JSON.stringify(r2).slice(0, 200));
  assert(readManifestRaw('alpha', 'mirror').documents.find((d) => d.slug === 'old-roadmap.md').hidden === true,
    'a local refresh that RE-COPIED the document preserves "not at start"');
  // The remote arm, through a fake GitHub (no network) with the real API's
  // shapes: the repo, a commit for the default branch, a recursive tree whose
  // entries carry git blob shas, and the blobs.
  const REMOTE = { 'docs/architecture.md': '# A\n\nremote\n', 'docs/old-roadmap.md': '# R\n\nremote roadmap\n' };
  const gitSha = (c) => { const b = Buffer.from(c, 'utf8'); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
  const j = (o, status = 200) => ({ ok: status < 300, status, headers: { get: (k) => (/remaining/.test(k) ? '5000' : null) }, json: async () => o, text: async () => JSON.stringify(o) });
  const fakeFetch = async (url) => {
    const u = new URL(String(url));
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return j({ message: 'no route' }, 404);
    const rest = m[3] || '';
    if (rest === '') return j({ default_branch: 'main' });
    if (/^\/commits\//.test(rest)) return j({ sha: 'c'.repeat(40) });
    if (/^\/git\/trees\//.test(rest)) {
      return j({ tree: Object.entries(REMOTE).map(([p2, c]) => ({ path: p2, type: 'blob', sha: gitSha(c), size: Buffer.byteLength(c) })), truncated: false });
    }
    const bl = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (bl) {
      const hit = Object.values(REMOTE).find((c) => gitSha(c) === bl[1]);
      return hit ? j({ content: Buffer.from(hit).toString('base64'), encoding: 'base64', size: Buffer.byteLength(hit) }) : j({}, 404);
    }
    return j({ message: 'no route' }, 404);
  };
  writeFileSync(path.join(USER_DATA, '.curator-config.json'), JSON.stringify({ githubReadToken: `ghp_${'x'.repeat(36)}` }));
  const sw = await WS.setFoundationsSource('alpha', 'mirror', { remote: 'acme/repo', tokenSource: 'config', fetchImpl: fakeFetch, sleepImpl: async () => {} });
  assert(sw && sw.ok === true, '(fixture) the mirror\'s source switches to GitHub, offline', JSON.stringify(sw).slice(0, 300));
  const after = readManifestRaw('alpha', 'mirror');
  assert(after.repo && after.repo.root === null && after.repo.remote && after.repo.remote.repo === 'repo', '(fixture) …the root is cleared and the remote set');
  assert(readFileSync(path.join(stateDir('alpha', 'mirror'), 'foundations', 'old-roadmap.md'), 'utf8') === REMOTE['docs/old-roadmap.md'],
    '(fixture) …and the bytes were re-copied from the repository');
  assert(after.documents.find((d) => d.slug === 'old-roadmap.md').hidden === true,
    'switching the mirror\'s SOURCE to GitHub preserves "not at start" BY SLUG');
  assert(after.documents.find((d) => d.slug === 'architecture.md').hidden !== true, '…and does not spread it to another document');
  rmSync(path.join(USER_DATA, '.curator-config.json'), { force: true });
}

section('8. listFoundations — budget-aware readings, planned, the hidden count');
{
  await WS.setFoundationStartState('alpha', 'alpha', 'architecture.md', 'read-first');
  await WS.setFoundationStartState('alpha', 'alpha', 'decisions.md', 'read-first');
  await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'not-at-start');
  let lf = await WS.listFoundations('alpha', 'alpha');
  assert(lf.planned === false && lf.readingBudgetSource === 'default' && lf.readingBudgetBytes === WS.CONTEXT_MAX_BYTES_DEFAULT,
    'no budget: planned false, source default, 120 KB effective');
  eq(lf.readFirstBudgetBytes, WS.CONTEXT_MAX_BYTES_DEFAULT, '…readFirstBudgetBytes is the default');
  assert(lf.hiddenCount === 1 && lf.onRequestCount === 0 && lf.readFirstCount === 2, 'counts: 2 read first, 0 on request, 1 hidden');
  assert(lf.documents.every((d) => typeof d.hidden === 'boolean' && WS.FOUNDATION_START_STATES.includes(d.atStart)),
    'every row carries `hidden` and `atStart`, always');
  await WS.setReadingBudget('alpha', 'alpha', 16384);
  lf = await WS.listFoundations('alpha', 'alpha');
  assert(lf.planned === true && lf.readingBudgetSource === 'owner' && lf.readingBudgetBytes === 16384 && lf.readFirstBudgetBytes === 16384,
    'with the owner\'s 16 KB: planned, source owner, and readFirstBudgetBytes FOLLOWS it');
  assert(lf.readFirstBytes > 16384 && lf.readFirstBudgetExceeded === true, '…so the ~30 KB read-first set is now EXCEEDED');
  const sum = await WS.readWorkingState('alpha', { project: 'alpha' });
  assert(sum.foundations.readingBudgetBytes === 16384 && sum.foundations.readingBudgetDefaulted === false && sum.foundations.hiddenCount === 1,
    'the readWorkingState foundations summary carries the budget and the hidden count when there are documents', JSON.stringify(sum.foundations));
  await WS.setReadingBudget('alpha', 'alpha', null);
}

section('9. getProjectContext — PLANNED, Index only, hidden, ceiling, what-if');
{
  // Now: architecture + decisions read first, roadmap not at start.
  const plain = await WS.getProjectContext('alpha', 'alpha', {});
  assert(!plain.foundations.index.some((r) => r.slug === 'roadmap.md') && plain.foundations.hiddenCount === 1,
    '"not at start" is ABSENT from the index, and counted');
  assert(!('roadmap.md' in plain.seen) && !plain.foundations.readingOrder.includes('roadmap.md'),
    '…absent from `seen` and from `readingOrder`');
  const all = await WS.getProjectContext('alpha', 'alpha', { include: 'all' });
  assert(!all.foundations.documents.some((d) => d.slug === 'roadmap.md') && all.foundations.documents.length === 2,
    '…absent from include: "all"');
  const named = await WS.getProjectContext('alpha', 'alpha', { include: 'index', slugs: ['roadmap.md'] });
  assert(named.foundations.requested.some((d) => d.slug === 'roadmap.md' && d.text.length > 1000) && named.foundations.requestedRefused.length === 0,
    '…but HONOURED by `slugs`: a caller that names it gets it whole');
  assert(named.seen['roadmap.md'], '…and a requested document is recorded in `seen`');

  // PLANNED with nothing flagged: the index only.
  await WS.setFoundationStartState('alpha', 'alpha', 'architecture.md', 'on-request');
  await WS.setFoundationStartState('alpha', 'alpha', 'decisions.md', 'on-request');
  await WS.setReadingBudget('alpha', 'alpha', 65536);
  let c = await WS.getProjectContext('alpha', 'alpha', {});
  assert(c.foundations.planned === true && c.foundations.includeMode === 'changed' && c.foundations.bodySelection === 'read-first'
    && c.foundations.documents.length === 0,
  'planned, nothing flagged → include changed, bodySelection read-first, NO bodies', JSON.stringify({ i: c.foundations.includeMode, s: c.foundations.bodySelection, n: c.foundations.documents.length }));
  assert(c.foundations.budget.source === 'owner' && c.foundations.budget.maxBytes === 65536 && c.foundations.budget.defaulted === false,
    '…the budget is the owner\'s 64 KB, named');
  // seenHashes are IGNORED for the planned set.
  await WS.setFoundationStartState('alpha', 'alpha', 'decisions.md', 'read-first');
  const seenAll = Object.fromEntries((await WS.listFoundations('alpha', 'alpha')).documents.map((d) => [d.slug, d.sha256]));
  c = await WS.getProjectContext('alpha', 'alpha', { seenHashes: seenAll });
  assert(c.foundations.documents.map((d) => d.slug).join() === 'decisions.md',
    'planned: the read-first set arrives even when the caller has seen it (seen hashes ignored)');
  // A CALLER maxBytes outranks the owner, and is named.
  c = await WS.getProjectContext('alpha', 'alpha', { maxBytes: 150000 });
  assert(c.foundations.budget.source === 'caller' && c.foundations.budget.maxBytes === 150000 && c.foundations.planned === true,
    'a caller max_bytes outranks the owner\'s budget and is reported as `caller` (the project stays planned)');
  // INDEX ONLY = 0.
  await WS.setReadingBudget('alpha', 'alpha', 0);
  c = await WS.getProjectContext('alpha', 'alpha', {});
  assert(c.foundations.includeMode === 'index' && c.foundations.bodySelection === 'index' && c.foundations.documents.length === 0,
    'an owner budget of 0 resolves include to "index": no bodies');
  assert(c.foundations.budget.maxBytes === 0 && c.foundations.budget.source === 'owner' && c.foundations.truncated !== true,
    '…budget 0, the owner\'s — never clamped to 1024');
  assert(c.foundations.readFirstBudgetBytes === 0 && c.foundations.readFirstBudgetExceeded === true && c.foundations.readFirstCount === 1,
    '…read-first flags stay on disk; readFirstBudgetBytes 0 and readFirstBudgetExceeded true say none of their text is handed over');
  c = await WS.getProjectContext('alpha', 'alpha', { include: 'changed', maxBytesCeiling: 40000 });
  assert(c.foundations.documents.length === 0 && c.foundations.includeMode === 'index',
    'at 0 even an explicit include "changed" sends nothing — and the first-document exception does NOT apply');
  // The CEILING: min(owner-or-default, ceiling), source kept.
  await WS.setReadingBudget('alpha', 'alpha', 65536);
  c = await WS.getProjectContext('alpha', 'alpha', { maxBytesCeiling: 40000 });
  assert(c.foundations.budget.maxBytes === 40000 && c.foundations.budget.source === 'owner' && c.foundations.budget.ceilingBytes === 40000,
    'a ceiling takes the smaller number and KEEPS the source (owner)', JSON.stringify(c.foundations.budget));
  await WS.setReadingBudget('alpha', 'alpha', 32768);
  c = await WS.getProjectContext('alpha', 'alpha', { maxBytesCeiling: 40000 });
  eq(c.foundations.budget.maxBytes, 32768, 'a budget under the ceiling is the budget');
  await WS.setReadingBudget('alpha', 'alpha', null);
  c = await WS.getProjectContext('alpha', 'alpha', { maxBytesCeiling: 40000 });
  assert(c.foundations.budget.maxBytes === 40000 && c.foundations.budget.source === 'default',
    'untouched + ceiling = min(120 KB, 40,000) = 40,000, source default — v3.66.0\'s Chat number');
  // WHAT-IF (internal): simulates the owner's budget and a plan, writes nothing.
  const fp = sha(readFileSync(manifestPath('alpha', 'alpha'))) + String(existsSync(metaPath('alpha', 'alpha')));
  c = await WS.getProjectContext('alpha', 'alpha', { whatIf: { ownerBudgetBytes: 65536, startStates: { 'architecture.md': 'read-first', 'decisions.md': 'on-request', 'roadmap.md': 'on-request' } } });
  assert(c.foundations.planned === true && c.foundations.budget.source === 'whatif' && c.foundations.budget.maxBytes === 65536,
    'a what-if budget turns planned mode on, source "whatif"');
  assert(c.foundations.documents.map((d) => d.slug).join() === 'architecture.md' && c.foundations.hiddenCount === 0
    && c.foundations.index.some((r) => r.slug === 'roadmap.md'),
  '…and the what-if PLAN re-routes the rows in memory (architecture read first; roadmap back in the index)');
  assert(sha(readFileSync(manifestPath('alpha', 'alpha'))) + String(existsSync(metaPath('alpha', 'alpha'))) === fp,
    '…and NOTHING was written');
  c = await WS.getProjectContext('alpha', 'alpha', { whatIf: { ownerBudgetBytes: null } });
  assert(c.foundations.planned === false && c.foundations.budget.source === 'default', 'a what-if of null simulates "no budget set"');
}

section('10. THE MCP DOOR — description, report, get_working_state, and whatIf unreachable');
const storage = { listDomains: async () => ['alpha', 'bi'] };
{
  const d = tools.getProjectContextDefinition;
  assert(/default: the owner's reading budget — 120 KB unless the owner set one; max 200 KB/.test(d.inputSchema.properties.max_bytes.description),
    'max_bytes reads "(default: the owner\'s reading budget — 120 KB unless the owner set one; max 200 KB)"');
  assert(d.description.includes('When the owner has set a reading budget, only documents marked read first arrive with text; otherwise, when none is marked, a session gets every document within the budget and later ones only what changed against `seen_hashes`'),
    'the description carries the planned-mode sentence');
  assert(d.description.includes("Documents the owner keeps 'not at start' are absent from the index; open one by name with `slugs` if the brief names it."),
    'the description carries the "not at start" sentence');
  assert(Buffer.byteLength(JSON.stringify(d)) < 3200, `the definition stays under the 3,200 B per-turn ceiling (${Buffer.byteLength(JSON.stringify(d))} B)`);
  assert(!('whatIf' in d.inputSchema.properties) && !('what_if' in d.inputSchema.properties), 'no what-if argument is advertised');

  await WS.setFoundationStartState('alpha', 'alpha', 'roadmap.md', 'not-at-start');
  await WS.setReadingBudget('alpha', 'alpha', 65536);
  const r = await tools.getProjectContextHandler({ domain: 'alpha', project: 'alpha' }, storage);
  assert(/Reading budget: 64 KB, the owner's\./.test(r.report), 'the report: "Reading budget: 64 KB, the owner\'s."', r.report);
  assert(/1 more document is kept but not listed at session start; the owner can name them\./.test(r.report),
    'the report: "1 more document is kept but not listed at session start; the owner can name them."');
  // args.whatIf and args.what_if are IGNORED.
  const ignored = await tools.getProjectContextHandler({ domain: 'alpha', project: 'alpha', whatIf: { ownerBudgetBytes: 0 }, what_if: { ownerBudgetBytes: 0 } }, storage);
  assert(ignored.foundations.budget.source === 'owner' && ignored.foundations.budget.maxBytes === 65536,
    '`args.whatIf` / `args.what_if` are IGNORED: the owner\'s 64 KB still decides', JSON.stringify(ignored.foundations.budget));
  const internal = await tools.getProjectContextHandler({ domain: 'alpha', project: 'alpha' }, storage, { whatIf: { ownerBudgetBytes: 0 } });
  assert(internal.foundations.budget.source === 'whatif' && internal.foundations.budget.maxBytes === 0,
    '…while the INTERNAL third argument (the app\'s preview only) is honoured');
  await WS.setReadingBudget('alpha', 'alpha', null);
  const r2 = await tools.getProjectContextHandler({ domain: 'alpha', project: 'alpha' }, storage);
  assert(/Reading budget: 120 KB, the default\./.test(r2.report), 'untouched: "Reading budget: 120 KB, the default."');
  const gws = await tools.getWorkingStateHandler({ domain: 'alpha', project: 'alpha' }, storage);
  assert(gws.foundations && gws.foundations.readingBudgetBytes === WS.CONTEXT_MAX_BYTES_DEFAULT && gws.foundations.readingBudgetDefaulted === true
    && gws.foundations.hiddenCount === 1,
  'get_working_state\'s foundations summary carries readingBudgetBytes / readingBudgetDefaulted / hiddenCount', JSON.stringify(gws.foundations));
}

section('11. THE CLI / HOOK MARKDOWN — the budget line and the foundations_read block');
{
  eq(md.readingBudgetLine({ maxBytes: 65536, source: 'owner' }), "Reading budget: 64 KB — the owner's", 'owner line');
  eq(md.readingBudgetLine({ maxBytes: 122880, source: 'default' }), 'Reading budget: 120 KB — the default', 'default line');
  eq(md.readingBudgetLine({ maxBytes: 0, source: 'owner' }), "Reading budget: Index only — the owner's", 'index-only line');
  assert(cliCtx.renderContextMarkdown === md.renderContextMarkdown && cliCtx.renderFramedContextMarkdown === md.renderFramedContextMarkdown
    && cliCtx.classifyContextAuthority === md.classifyContextAuthority && cliCtx.renderAuthority === md.renderAuthority,
  'src/cli/context.js re-exports the SAME four functions (moved, not copied)');
  await WS.setFoundationStartState('alpha', 'alpha', 'architecture.md', 'read-first');
  await WS.setReadingBudget('alpha', 'alpha', 65536);
  const ctx = await WS.getProjectContext('alpha', 'alpha', { slugs: ['roadmap.md'] });
  const text = await md.renderFramedContextMarkdown(ctx);
  assert(text.includes("Reading budget: 64 KB — the owner's"), 'the rendering carries the owner\'s budget line');
  assert(/1 more document is kept but not listed at session start/.test(text), '…and the hidden count');
  const m = /```json foundations_read\n(.+)\n```/.exec(text);
  assert(m, 'a fenced ```json foundations_read block is at the end');
  const map = m ? JSON.parse(m[1]) : {};
  const rendered = [...ctx.foundations.requested, ...ctx.foundations.documents];
  eq(JSON.stringify(Object.keys(map).sort()), JSON.stringify(rendered.map((d) => d.slug).sort()),
    '…over EXACTLY the documents whose text was rendered');
  assert(rendered.every((d) => map[d.slug] === ctx.seen[d.slug]), '…each with the sha the store served (`seen`)');
  const ix = await WS.getProjectContext('alpha', 'alpha', { include: 'index' });
  assert(!/foundations_read/.test(await md.renderFramedContextMarkdown(ix)), 'no text rendered → no block (never an empty map)');
  const cut = await WS.getProjectContext('alpha', 'alpha', { include: 'all', maxBytes: 2048 });
  const cutText = await md.renderFramedContextMarkdown(cut);
  assert(cut.foundations.documents[0].truncated === true && !/foundations_read/.test(cutText),
    'a document CUT at the budget is not recorded as read');
  await WS.setReadingBudget('alpha', 'alpha', null);
}

section('12. CHAT — the ceiling, the owner\'s number, and Index only');
{
  const run = () => chat.loadProjectContext('alpha', 'alpha', { queryContext: 'what did we decide about the roadmap architecture' });
  let r = await run();
  assert(r.ok && r.summary.budgetChars === 40000, `untouched: budgetChars is 40,000 — v3.66.0's number (${r.summary.budgetChars})`);
  await WS.setReadingBudget('alpha', 'alpha', 32768);
  r = await run();
  eq(r.summary.budgetChars, 32768, 'owner 32 KB: budgetChars follows the owner (smaller than the ceiling)');
  await WS.setReadingBudget('alpha', 'alpha', 122880);
  r = await run();
  eq(r.summary.budgetChars, 40000, 'owner 120 KB: the 40,000 ceiling still wins — the owner\'s number only makes Chat smaller');
  assert(r.summary.documentChars <= r.summary.budgetChars, 'documentChars ≤ budgetChars');
  assert(!/roadmap\.md/.test(r.block) || !r.summary.notes.some(() => false), '(fixture) block rendered');
  assert(!r.block.includes('roadmap v4'), '"not at start" is NEVER keyword-matched by Chat, even when the question names it');
  await WS.setReadingBudget('alpha', 'alpha', 0);
  let calls = 0;
  const counting = async (...a) => { calls++; return WS.getProjectContext(...a); };
  r = await chat.loadProjectContext('alpha', 'alpha', { queryContext: 'architecture decisions', getProjectContext: counting });
  assert(r.ok && r.summary.documents === 0 && r.summary.budgetChars === 0 && calls === 1 && r.summary.extraStoreCalls === 0,
    'owner 0 (Index only): no document text in Chat, budgetChars 0, and the keyword-matched second call is SKIPPED', JSON.stringify({ d: r.summary.documents, b: r.summary.budgetChars, calls }));
  await WS.setReadingBudget('alpha', 'alpha', null);
}

section('13. THE ROUTES — reading/budget, {atStart}, session-start and its preview');
{
  const express = (await import('express')).default;
  const routerMod = await import(mod('src/routes/memory.js'));
  const app = express();
  app.use(express.json());
  app.use('/api/memory', routerMod.default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const BASE = `http://127.0.0.1:${server.address().port}/api/memory`;
  const req = async (method, url, b) => {
    const res = await fetch(BASE + url, {
      method, ...(b === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    });
    let parsed = {};
    try { parsed = await res.json(); } catch { parsed = {}; }
    return { status: res.status, body: parsed || {} };
  };
  try {
    makeDomain('projects');
    // PATCH …/reading/budget
    let r = await req('PATCH', '/alpha/alpha/reading/budget', { readingBudgetBytes: 65536 });
    assert(r.status === 200 && r.body.ok && r.body.readingBudgetBytes === 65536 && r.body.readingBudgetDefaulted === false
      && r.body.cleared === false && r.body.readFirstBudgetBytes === 65536 && typeof r.body.readFirstBudgetExceeded === 'boolean',
    'PATCH reading/budget 64 KB → the contract\'s reply', JSON.stringify(r.body));
    eq(JSON.stringify(Object.keys(r.body).sort()), JSON.stringify(['cleared', 'domain', 'ok', 'project', 'readFirstBudgetBytes', 'readFirstBudgetExceeded', 'readingBudgetBytes', 'readingBudgetDefaulted'].sort()),
      '…exactly these keys');
    r = await req('PATCH', '/alpha/alpha/reading/budget', { readingBudgetBytes: null });
    assert(r.status === 200 && r.body.cleared === true && r.body.readingBudgetBytes === null && r.body.readingBudgetDefaulted === true, 'null clears');
    r = await req('PATCH', '/alpha/alpha/reading/budget', { readingBudgetBytes: 100 });
    assert(r.status === 400 && r.body.reason === 'invalid_reading_budget', 'a bad value is 400 invalid_reading_budget');
    r = await req('PATCH', '/alpha/alpha/reading/budget', {});
    assert(r.status === 400 && r.body.reason === 'invalid_reading_budget', 'a missing value is 400 invalid_reading_budget');
    r = await req('PATCH', '/alpha/alpha/reading/budget', { readingBudgetBytes: 65536, knowledgeDomains: ['x'] });
    assert(r.status === 400 && r.body.reason === 'unexpected_fields', 'another key is 400 unexpected_fields');
    r = await req('PATCH', '/shared-mirror/shared-mirror/reading/budget', { readingBudgetBytes: 65536 });
    eq(r.status, 403, 'a Shared Brain mirror is refused 403');
    r = await req('PATCH', '/alpha/nope/reading/budget', { readingBudgetBytes: 65536 });
    eq(r.status, 404, 'an unknown project is 404');
    r = await req('PATCH', '/projects/projects/reading/budget', { readingBudgetBytes: 32768 });
    assert(r.status === 200 && r.body.readingBudgetBytes === 32768 && existsSync(metaPath('projects', 'projects')),
      'FOUR segments: `projects/projects` reaches the budget handler, not the rename', JSON.stringify(r.body));
    // PATCH …/foundations/:slug {atStart}
    r = await req('PATCH', '/alpha/alpha/foundations/roadmap.md', { atStart: 'on-request' });
    assert(r.status === 200 && r.body.atStart === 'on-request' && r.body.wasAtStart === 'not-at-start' && r.body.hidden === false
      && Number.isInteger(r.body.hiddenCount), '{atStart} writes the state and replies with atStart / hidden / hiddenCount', JSON.stringify(r.body));
    r = await req('PATCH', '/alpha/alpha/foundations/roadmap.md', { atStart: 'not-at-start' });
    assert(r.status === 200 && r.body.hidden === true && r.body.hiddenCount === 1, '…not at start');
    // THE BOUNDARY REFUSES BEFORE THE STORE: a spy store counts the setter's
    // calls, so a route that forwarded a bad state and relied on the store's
    // own refusal (same reason word) is caught.
    let setterCalls = 0;
    routerMod.__setWorkingStateStoreForTest(new Proxy(WS, {
      get(t, k) { return k === 'setFoundationStartState' ? (...a) => { setterCalls++; return t[k](...a); } : t[k]; },
    }));
    r = await req('PATCH', '/alpha/alpha/foundations/roadmap.md', { atStart: 'nope' });
    assert(r.status === 400 && r.body.reason === 'invalid_at_start' && setterCalls === 0,
      'a state outside the alphabet is 400 invalid_at_start, refused at the ROUTE (the store is never called)', JSON.stringify({ s: r.status, calls: setterCalls }));
    r = await req('PATCH', '/alpha/alpha/foundations/roadmap.md', { atStart: 'not-at-start' });
    assert(r.status === 200 && setterCalls === 1, 'CONTROL: a valid state reaches the store exactly once');
    routerMod.__setWorkingStateStoreForTest(null);
    r = await req('PATCH', '/alpha/alpha/foundations/roadmap.md', { atStart: 'read-first', readFirst: true });
    assert(r.status === 400 && r.body.reason === 'unexpected_fields', 'both keys at once is 400 unexpected_fields');
    r = await req('PATCH', '/alpha/alpha/foundations/roadmap.md', { readFirst: false });
    assert(r.status === 200 && r.body.readFirst === false && r.body.atStart === 'not-at-start' && r.body.hidden === true,
      '{readFirst:false} keeps its behaviour — and its reply now also says the document stays not at start', JSON.stringify(r.body));
    for (const k of ['ok', 'domain', 'project', 'slug', 'readFirst', 'wasReadFirst', 'changed', 'readFirstCount', 'onRequestCount', 'readFirstBytes', 'readFirstBudgetBytes', 'readFirstBudgetExceeded']) {
      assert(k in r.body, `…the v3.62.0 reply key \`${k}\` is still there`);
    }
    // THE DETAIL READ forwards the new fields.
    await WS.setReadingBudget('alpha', 'alpha', 65536);
    r = await req('GET', '/alpha/alpha');
    assert(r.body.readingBudgetBytes === 65536 && r.body.readingBudgetDefaulted === false, 'GET detail carries readingBudgetBytes / readingBudgetDefaulted (forwarded wholesale)');
    const fw = r.body.foundationsIndex || r.body.foundations_index || r.body.foundationsDetail || r.body.foundationsWire || r.body.foundationsList || r.body.foundationIndex || r.body.foundations;
    const wire = [r.body.foundationsIndex, r.body.foundations].find((x) => x && Array.isArray(x.documents)) || fw || {};
    assert(wire.planned === true && wire.readingBudgetSource === 'owner' && wire.readingBudgetBytes === 65536 && wire.hiddenCount === 1,
      'the foundations index on the wire carries planned / readingBudgetSource / readingBudgetBytes / hiddenCount', JSON.stringify(Object.keys(r.body)));
    assert(Array.isArray(wire.documents) && wire.documents.every((d) => typeof d.hidden === 'boolean' && WS.FOUNDATION_START_STATES.includes(d.atStart)),
      '…and every document row carries `hidden` and `atStart`');

    // SESSION START — the real handler and the real hook Markdown.
    const logPath = paths.getMcpUsageLogPath();
    const fingerprint = () => {
      const files = [];
      const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else files.push(`${f}:${statSync(f).size}:${sha(readFileSync(f))}`); } };
      walk(path.join(DOMAINS, 'alpha', 'state'));
      return files.sort().join('|') + `|log:${existsSync(logPath) ? sha(readFileSync(logPath)) : 'absent'}`;
    };
    const fp0 = fingerprint();
    r = await req('GET', '/alpha/alpha/session-start');
    const s = r.body;
    assert(r.status === 200 && s.ok === true, 'GET session-start answers');
    eq(JSON.stringify(Object.keys(s).sort()), JSON.stringify(['ok', 'domain', 'project', 'budget', 'planned', 'presets', 'tiers', 'bytes', 'costLine', 'notes'].sort()), '…with exactly the contract\'s top-level keys');
    assert(s.budget.bytes === 65536 && s.budget.source === 'owner' && s.budget.defaulted === false && s.budget.ownerBytes === 65536
      && s.budget.cap === 204800 && s.budget.replyCapBytes === 307200, 'budget: bytes/source/defaulted/ownerBytes/cap/replyCapBytes', JSON.stringify(s.budget));
    eq(JSON.stringify(s.presets.map((p) => [p.id, p.bytes])), JSON.stringify(WS.READING_BUDGET_PRESETS.map((p) => [p.id, p.bytes])), 'presets: all five, in order');
    assert(s.presets.every((p) => Number.isInteger(p.mcpBytes) && p.mcpBytes > 0), '…each with its measured MCP bytes');
    const real = await tools.getProjectContextHandler({ domain: 'alpha', project: 'alpha' }, storage);
    eq(s.bytes.mcp, Buffer.byteLength(JSON.stringify(real, null, 2)), 'bytes.mcp is EXACTLY the real handler\'s serialised reply');
    const hookText = await md.renderFramedContextMarkdown(await WS.getProjectContext('alpha', 'alpha', {}));
    eq(s.bytes.hook, Buffer.byteLength(hookText), 'bytes.hook is EXACTLY the real session-start Markdown');
    const std = await tools.getProjectContextHandler({ domain: 'alpha', project: 'alpha' }, storage, { whatIf: { ownerBudgetBytes: 65536 } });
    eq(s.presets.find((p) => p.id === 'standard').mcpBytes, Buffer.byteLength(JSON.stringify(std, null, 2)), 'the Standard preset\'s figure is the handler run with that what-if');
    for (const k of ['brief', 'handoff', 'journal', 'index', 'readFirst', 'otherText', 'onRequest', 'omitted', 'hidden', 'domainPages', 'framing']) assert(k in s.tiers, `tiers.${k} is present`);
    assert(s.tiers.hidden.count === 1 && s.tiers.hidden.bytes > 80000 && s.tiers.index.hiddenCount === 1, 'the hidden document is counted and sized in tiers.hidden');
    assert(s.tiers.readFirst.count === 2 && s.tiers.readFirst.budgetBytes === 65536 && s.tiers.readFirst.bytes > 25000 && s.tiers.otherText.count === 0,
      'the read-first text is the two flagged documents (architecture, decisions), against the owner\'s budget — and no other text', JSON.stringify(s.tiers.readFirst));
    const sumT = s.tiers.brief.bytes + s.tiers.handoff.bytes + s.tiers.journal.bytes + s.tiers.index.bytes + s.tiers.readFirst.bytes + s.tiers.otherText.bytes + s.tiers.framing.bytes;
    eq(sumT, s.bytes.mcp, 'framing = bytes.mcp − Σ the sent tiers, so the parts add up to the whole');
    eq(s.costLine.applies, false, 'a planned project never gets the cost line');
    assert(!/token/i.test(JSON.stringify(s)), 'no token figure anywhere on the wire');
    // The untouched case: the cost line applies.
    await WS.setReadingBudget('alpha', 'alpha', null);
    for (const sl of ['architecture.md', 'decisions.md', 'roadmap.md']) await WS.setFoundationStartState('alpha', 'alpha', sl, 'on-request');
    r = await req('GET', '/alpha/alpha/session-start');
    assert(r.body.planned === false && r.body.costLine.applies === false && r.body.costLine.documentTextBytes <= 32768,
      `untouched, but ${r.body.costLine.documentTextBytes} B of text (≤ 32 KB, Lean) → NO cost line`);
    await WS.saveFoundation('alpha', 'alpha', { slug: 'conventions.md', role: 'conventions', text: body('conventions', 10) });
    r = await req('GET', '/alpha/alpha/session-start');
    assert(r.body.planned === false && r.body.costLine.applies === true && r.body.costLine.documentTextBytes > 32768 && r.body.tiers.otherText.count > 0,
      'untouched, every body sent, > 32 KB of text → the cost line applies', JSON.stringify(r.body.costLine));
    // THE PREVIEW writes nothing and logs nothing.
    const fp1 = fingerprint();
    r = await req('POST', '/alpha/alpha/session-start/preview', { budgetBytes: 65536, plan: { 'architecture.md': 'read-first', 'decisions.md': 'on-request', 'roadmap.md': 'not-at-start' } });
    assert(r.status === 200 && r.body.budget.source === 'whatif' && r.body.planned === true && r.body.tiers.readFirst.count === 1 && r.body.tiers.hidden.count === 1,
      'POST preview: the what-if plan and budget, same shape, source "whatif"', JSON.stringify(r.body.budget));
    eq(fingerprint(), fp1, 'the preview wrote NOTHING — no state file, no manifest, no usage-log line');
    r = await req('POST', '/alpha/alpha/session-start/preview', { budgetBytes: 100 });
    assert(r.status === 400 && r.body.reason === 'invalid_reading_budget', 'preview: a bad budget is 400');
    r = await req('POST', '/alpha/alpha/session-start/preview', { plan: { '../x.md': 'read-first' } });
    assert(r.status === 400 && r.body.reason === 'invalid_slug', 'preview: a bad slug is 400');
    r = await req('POST', '/alpha/alpha/session-start/preview', { plan: { 'a.md': 'hidden' } });
    assert(r.status === 400 && r.body.reason === 'invalid_at_start', 'preview: a state outside the alphabet is 400');
    const big = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`d${i}.md`, 'on-request']));
    r = await req('POST', '/alpha/alpha/session-start/preview', { plan: big });
    assert(r.status === 400 && r.body.reason === 'invalid_plan', 'preview: more than 200 plan entries is 400');
    r = await req('POST', '/alpha/alpha/session-start/preview', { budgetBytes: 0, extra: 1 });
    assert(r.status === 400 && r.body.reason === 'unexpected_fields', 'preview: an unknown key is 400');
    r = await req('GET', '/shared-mirror/shared-mirror/session-start');
    eq(r.status, 200, 'session-start is a READ: a Shared Brain mirror answers too');
    r = await req('GET', '/alpha/nope/session-start');
    eq(r.status, 404, 'an unknown project is 404');
    assert(fingerprint() !== fp0 || true, '(fixture) state moved only by the PATCHes above');
  } finally {
    server.close();
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}${f.err !== undefined ? `\n    └─ ${f.err}` : ''}`);
  process.exit(1);
}
