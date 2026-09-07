#!/usr/bin/env node
/**
 * OFFLINE — the v3.48.0 PROJECT tools, spoken over real stdio JSON-RPC.
 *
 * WHY A SECOND MCP SUITE RATHER THAN MORE OF test-mcp-working-state.js
 * ───────────────────────────────────────────────────────────────────
 * That suite's fixture is a set of DOMAINS with no projects inside them, and
 * several of its sections assert emptiness that a project would disturb. The
 * properties here need the opposite fixture — the same project name in two
 * domains, a project with a brief and no saves, a domain whose own project and
 * a named project both have state — so this is its own tree.
 *
 * The three properties that only the CHILD PROCESS can prove, and which an
 * in-process handler test cannot see:
 *
 *   1. THE NEW TOOLS ARE ON THE WIRE, with schemas a client will accept, and
 *      the registry is ADDITIVE — nothing that shipped before is gone.
 *
 *   2. AMBIGUITY SURVIVES SERIALISATION. `resolveProject` refusing to guess is
 *      only worth anything if the refusal, and its candidates, reach the model
 *      as JSON rather than being flattened into a string somewhere on the way
 *      out. §3 reads them off the wire.
 *
 *   3. STDOUT PURITY (§0, asserted LAST so it covers every byte of the
 *      session). `save_project_brief` puts `write-registry.js` and the file
 *      lock on the child's import graph for the first time; one console.log
 *      anywhere on it reaches Claude Desktop as `Unexpected token ... is not
 *      valid JSON` and kills the session (v2.5.3).
 *
 * SAFETY — never touches real user data. Both CURATOR_TEST_DOMAINS_DIR and
 * CURATOR_TEST_USER_DATA_DIR pin a throwaway tree under os.tmpdir(), and
 * provider/GitHub credentials are stripped from the child env.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp', 'server.js');

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); if (detail !== undefined) console.log(`      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── Fixture ────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-proj-mcp-'));
const DOMAINS_DIR = path.join(ROOT, 'domains');
const USER_DATA_DIR = path.join(ROOT, 'userdata');
mkdirSync(USER_DATA_DIR, { recursive: true });

const D1 = 'zz-work';            // hosts two named projects
const D2 = 'zz-side';            // hosts one, sharing a name with D1's
const D3 = 'zz-default';         // the configured default domain
const MIRROR = 'shared-zz-proj'; // read-only Shared Brain mirror

for (const d of [D1, D2, D3, MIRROR]) {
  mkdirSync(path.join(DOMAINS_DIR, d, 'wiki', 'entities'), { recursive: true });
}
writeFileSync(path.join(DOMAINS_DIR, D1, 'CLAUDE.md'), '# zz-work\n');
writeFileSync(path.join(DOMAINS_DIR, D2, 'CLAUDE.md'), '# zz-side\n');
writeFileSync(path.join(DOMAINS_DIR, D3, 'CLAUDE.md'), '# zz-default\n');
writeFileSync(path.join(DOMAINS_DIR, MIRROR, 'CLAUDE.md'),
  '---\nreadonly: true\n---\n\n# shared-zz-proj\n\nRead-only Shared Brain mirror.\n');
writeFileSync(path.join(USER_DATA_DIR, '.curator-config.json'),
  JSON.stringify({ defaultDomain: D3 }, null, 2));

const CURRENT = 'current.md';
const sp = (domain, ...rest) => path.join(DOMAINS_DIR, domain, 'state', ...rest);

/** A named project with a brief and one saved work-stream, written by hand. */
function seedProject(domain, project, { scope = 'main', machine = 'boxa', headline = 'seeded' } = {}) {
  mkdirSync(sp(domain, project, scope, machine), { recursive: true });
  writeFileSync(sp(domain, project, 'project.md'),
    `# ${project}\n\n## Standing brief\n\nHand-typed by the owner.\n`);
  writeFileSync(sp(domain, project, scope, machine, CURRENT),
    `# Working state — ${scope}\n\n> ${headline}\n\n_Machine: ${machine} · Scope: ${scope}_\n\n`
    + '## Where things stand\n\nSeeded fixture body.\n');
  writeFileSync(sp(domain, project, scope, machine, 'journal.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), scope, machine, harness: 'fixture', headline, bytes: 120, rejections: [] })}\n`);
}

seedProject(D1, 'lumina', { headline: 'lumina: adapter half done' });
seedProject(D1, 'atlas', { headline: 'atlas: schema settled' });
seedProject(D2, 'lumina', { headline: 'a DIFFERENT lumina' });
// D3's OWN project, at the state root — the pre-v3.48.0 layout.
mkdirSync(sp(D3, 'main', 'boxa'), { recursive: true });
writeFileSync(sp(D3, 'main', 'boxa', CURRENT),
  '# Working state — main\n\n> default project state\n\n## Where things stand\n\nAt the root.\n');

// ── stdio JSON-RPC client ──────────────────────────────────────────────────
const env = { ...process.env };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
                 'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) {
  delete env[k];
}
env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;

const child = spawn(process.execPath, [MCP_SERVER, '--domains-path', DOMAINS_DIR], {
  stdio: ['pipe', 'pipe', 'pipe'], env,
});

let stdoutBuf = '';
let stderrText = '';
const rawStdoutLines = [];
const pending = new Map();
child.stderr.on('data', (d) => { stderrText += d; });
child.stdout.on('data', (d) => {
  stdoutBuf += d;
  let i;
  while ((i = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line.trim()) continue;
    rawStdoutLines.push(line);
    let frame = null;
    try { frame = JSON.parse(line); } catch { /* §0 reports it */ }
    if (frame && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: true }); }, timeoutMs);
    pending.set(id, (f) => { clearTimeout(timer); resolve(f); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const callTool = (name, args) => rpc('tools/call', { name, arguments: args || {} });
const rawText = (f) => f?.result?.content?.[0]?.text ?? '';
const asJson = (f) => { try { return JSON.parse(rawText(f)); } catch { return rawText(f); } };

// ═════════════════════════════════════════════════════════════════════════
section('§1  REGISTRATION — the two new tools reach the wire, additively');
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'curator-proj', version: '1' },
});
ok(!!init?.result?.serverInfo, 'initialize returns serverInfo');
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const listed = await rpc('tools/list');
const wireTools = listed?.result?.tools || [];
const wireNames = wireTools.map((t) => t.name);
ok(wireNames.includes('list_projects'), 'tools/list carries list_projects');
ok(wireNames.includes('save_project_brief'), 'tools/list carries save_project_brief');

const { tools: registry } = await import(path.join(REPO_ROOT, 'mcp/tools/index.js'));
ok(wireNames.length === registry.length && wireNames.length === 22,
  `the wire holds all ${registry.length} registered tools, and that is 22 (got ${wireNames.length})`);
ok(JSON.stringify(wireNames.slice().sort()) === JSON.stringify(registry.map((t) => t.definition.name).sort()),
  'the wire NAME SET === the `tools` array in mcp/tools/index.js');

// READS BEFORE WRITES. Tool ordering nudges a model to reach for a read first
// when the intent is exploration (v2.5.2's discoverability rule), so the new
// read tool must not land after the write block.
{
  const iRead = wireNames.indexOf('list_projects');
  const iFirstWrite = wireNames.indexOf('compile_to_wiki');
  const iBrief = wireNames.indexOf('save_project_brief');
  ok(iRead >= 0 && iFirstWrite >= 0 && iRead < iFirstWrite,
    'list_projects is registered BEFORE the write block', `${iRead} < ${iFirstWrite}`);
  ok(iBrief > iFirstWrite, 'and save_project_brief inside it', `${iBrief} > ${iFirstWrite}`);
}

// The instruction-only framing is the whole safety story for a tool that
// rewrites the document every future session is told to follow. It has to be
// in the DESCRIPTION, because that is all a model gets before choosing.
{
  const d = wireTools.find((t) => t.name === 'save_project_brief')?.description || '';
  ok(/ONLY CALL THIS WHEN THE USER EXPLICITLY ASKS/i.test(d),
    'save_project_brief says in as many words that it is called only on the user\'s explicit ask');
  ok(/COMPLETE brief/i.test(d) && /replaces the whole/i.test(d),
    '…and that it replaces the whole document, so a delta destroys the rest');
  ok(/save_working_state/.test(d),
    '…and points at the tool the model should have used instead for session state');
  const l = wireTools.find((t) => t.name === 'list_projects')?.description || '';
  ok(/do not guess/i.test(l) || /Do NOT guess/.test(l),
    'list_projects tells the model not to guess a project');
  for (const t of ['list_projects', 'save_project_brief']) {
    const def = wireTools.find((x) => x.name === t);
    const bytes = Buffer.byteLength(JSON.stringify(def), 'utf8');
    ok(bytes > 200 && bytes < 3200,
      `${t} definition is ${bytes} B (tools/list is carried every turn; < 3200 B ceiling)`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  list_projects — the "which project" answer');
{
  const all = asJson(await callTool('list_projects', {}));
  ok(all?.ok === true, 'list_projects with no argument succeeds', JSON.stringify(all).slice(0, 200));
  const names = (all.projects || []).map((p) => `${p.domain}/${p.project}`).sort();
  ok(names.includes('zz-work/lumina') && names.includes('zz-work/atlas')
    && names.includes('zz-side/lumina'),
    'every seeded project across every domain is listed', JSON.stringify(names));
  ok(names.includes('zz-default/zz-default'),
    'including a domain\'s OWN project, whose slug is the domain name', JSON.stringify(names));
  const row = (all.projects || []).find((p) => p.project === 'lumina' && p.domain === 'zz-work');
  ok(row && row.headline === 'lumina: adapter half done' && row.newestScope === 'main'
    && row.hasBrief === true,
    'a row carries the headline, the newest work-stream and brief presence', JSON.stringify(row));
  ok(row && typeof row.ageSeconds === 'number', 'and an age');
  ok(typeof all.content_is_data === 'string' && /recorded data/i.test(all.content_is_data),
    'the payload frames headlines as recorded data, not instructions');
  ok(/does not say which project the user means/i.test(all.content_is_data || ''),
    '…and says the list is not itself an answer');
  ok(typeof all.report === 'string' && /do not guess/i.test(all.report),
    'the report repeats the do-not-guess rule', String(all.report).slice(0, 160));

  const one = asJson(await callTool('list_projects', { domain: D1 }));
  ok(one?.ok === true && (one.projects || []).every((p) => p.domain === D1),
    'a domain argument scopes the list', JSON.stringify((one.projects || []).map((p) => p.domain)));
  ok(one.scope_of_list === `domain '${D1}'`, 'and the payload says what it was scoped to', one.scope_of_list);

  const badDom = asJson(await callTool('list_projects', { domain: 'no-such-domain' }));
  ok(badDom?.ok === false && /Unknown domain/i.test(badDom.error || ''),
    'an unknown domain is refused through the same gate every other tool uses');

  // The wire shape is an ALLOW-LIST, never a spread. Asserted as the KEY SET,
  // not as the absence of a path: found by mutation, a `...r` spread that added
  // one extra field passed a path scan easily, because the store's own rows
  // carry no path to find. What the allow-list actually promises is that
  // NOTHING travels except these names, and only a key-set assertion says that.
  const WIRE_ROW_KEYS = new Set([
    'domain', 'project', 'isDefaultProject', 'hasBrief', 'briefUpdatedAt', 'briefAuthoredBy',
    'scopeCount', 'savedCopies', 'lastWriteAt', 'ageSeconds', 'writtenAt', 'writtenAgeSeconds',
    'headline', 'newestScope', 'newestMachine', 'harness', 'model', 'lastSaveKind',
  ]);
  const stray = [];
  for (const r of all.projects || []) {
    for (const k of Object.keys(r)) if (!WIRE_ROW_KEYS.has(k)) stray.push(k);
  }
  ok(stray.length === 0, 'every key on every project row is on the wire allow-list',
    JSON.stringify([...new Set(stray)]));
  ok((all.projects || []).length > 0 && Object.keys(all.projects[0]).length >= 6,
    'ANTI-VACUITY: the rows really carry fields, so the check above is not over an empty set',
    JSON.stringify(Object.keys(all.projects?.[0] || {})));
  const serialised = JSON.stringify(all.projects || []);
  ok(!serialised.includes(ROOT) && !serialised.includes(os.tmpdir()),
    'and no filesystem path leaks into a project row');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Resolution — explicit, search, default, and NEVER a guess');
{
  const explicit = asJson(await callTool('get_working_state', { domain: D1, project: 'lumina' }));
  ok(explicit?.ok === true && explicit.domain === D1 && explicit.project === 'lumina',
    'domain + project opens exactly that project', JSON.stringify({ d: explicit.domain, p: explicit.project }));
  ok(explicit.resolved_by === 'explicit', 'and reports resolved_by: explicit', explicit.resolved_by);

  const search = asJson(await callTool('get_working_state', { project: 'atlas' }));
  ok(search?.ok === true && search.domain === D1 && search.resolved_by === 'search',
    'a bare, unique project name is found by searching every domain',
    JSON.stringify({ d: search.domain, r: search.resolved_by }));

  const dflt = asJson(await callTool('get_working_state', {}));
  ok(dflt?.ok === true && dflt.domain === D3 && dflt.resolved_by === 'default',
    'no argument falls back to the configured default domain\'s own project',
    JSON.stringify({ d: dflt.domain, r: dflt.resolved_by }));
  ok(dflt.project === D3, '…whose project slug IS the domain name — the pre-v3.48.0 value', dflt.project);

  // A bare DOMAIN name is what every caller has passed as `project` since
  // v3.17.0. It must keep working.
  const legacyStyle = asJson(await callTool('get_working_state', { project: D3, scope: 'main' }));
  ok(legacyStyle?.ok === true && legacyStyle.current?.present === true,
    'passing a DOMAIN slug as `project` still reads the root-level state (the v3.17.0 contract)');

  // AMBIGUITY. Reported with candidates, and nothing opened.
  const amb = asJson(await callTool('get_working_state', { project: 'lumina' }));
  ok(amb?.ok === false && amb.reason === 'project_ambiguous',
    'a project name that exists in two domains is REFUSED', JSON.stringify(amb).slice(0, 200));
  ok(Array.isArray(amb.candidates) && amb.candidates.length === 2,
    'the candidates survive serialisation as structured data', JSON.stringify(amb.candidates));
  const cd = (amb.candidates || []).map((c) => c.domain).sort().join(',');
  ok(cd === `${D2},${D1}`.split(',').sort().join(','), 'and name both domains', cd);
  ok(amb.current === undefined && amb.brief === undefined,
    'NOTHING was opened — no state comes back beside the refusal');

  const missing = asJson(await callTool('get_working_state', { project: 'lumi' }));
  ok(missing?.ok === false && missing.reason === 'project_not_found', 'an unknown name is refused');
  ok(/list_projects/.test(missing.error || ''), 'and the error points at the tool that answers it',
    String(missing.error).slice(0, 160));
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  scope: "latest" over the wire');
{
  // Two work-streams in one project, saved through the real tool so the
  // ordering under test is the store's.
  const s1 = asJson(await callTool('save_working_state', {
    domain: D1, project: 'atlas', scope: 'older', headline: 'older stream', now_state: 'a',
  }));
  ok(s1?.ok === true, 'a save into a named project succeeds over the wire', JSON.stringify(s1).slice(0, 200));
  ok(s1.project === 'atlas' && s1.domain === D1, 'and reports both the project and the domain');
  ok(/state\/atlas\//.test(s1.path || ''), 'writing one level down', s1.path);
  await new Promise((r) => setTimeout(r, 1100));   // distinct mtime, no stamping from outside
  const s2 = asJson(await callTool('save_working_state', {
    domain: D1, project: 'atlas', scope: 'newer', headline: 'newer stream', now_state: 'b',
  }));
  ok(s2?.ok === true, 'and a second work-stream');

  const latest = asJson(await callTool('get_working_state', { domain: D1, project: 'atlas', scope: 'latest' }));
  ok(latest?.ok === true && latest.scope === 'newer',
    '`latest` opens the newest work-stream', JSON.stringify({ s: latest.scope }));
  ok(latest.scopeResolvedBy === 'latest',
    'and the payload SAYS it chose — the model can tell the user which one it opened',
    latest.scopeResolvedBy);
  ok(/newer stream/.test(latest.current?.text || ''), 'the content is that work-stream\'s');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  save_working_state never creates a project');
{
  const r = asJson(await callTool('save_working_state', {
    domain: D1, project: 'not-a-project', headline: 'x', now_state: 'y',
  }));
  ok(r?.ok === false, 'a save into a project that does not exist is refused', JSON.stringify(r).slice(0, 200));
  ok(!existsSync(sp(D1, 'not-a-project')), 'and nothing is created on disk');
  ok(/lumina/.test(r.error || ''), 'the refusal names the projects that DO exist', String(r.error).slice(0, 200));
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  save_project_brief — provenance, wholeness, and the mirror refusal');
{
  const mirror = asJson(await callTool('save_project_brief', {
    domain: MIRROR, project: MIRROR, text: '## Standing brief\n\nnope',
  }));
  ok(mirror?.ok === false && /read-only Shared Brain mirror/i.test(mirror.error || ''),
    'a write into a mirror is refused', JSON.stringify(mirror).slice(0, 180));
  // …BY THE MCP'S OWN GATE, not by the store behind it. Found by mutation:
  // deleting refuseIfReadonly here left the section green, because
  // checkProjectWritable refuses a mirror too and its sentence also contains
  // "read-only Shared Brain mirror". The two guards answer different questions
  // — the store's is a property of one module, refuseIfReadonly is the property
  // the MCP asserts about EVERY tool of its own that mutates, and it is what
  // scripts/test-next-mcp-wizard.js counts to tell the user how many of these
  // tools write. So the assertion keys on wording only refuseIfReadonly emits.
  ok(/Push contributions/i.test(mirror.error || '')
    && /would not propagate to other contributors/i.test(mirror.error || ''),
    '…and it is the MCP\'s OWN refuseIfReadonly that answered, which is what makes the guard load-bearing rather than decorative',
    String(mirror.error).slice(0, 180));
  ok(!existsSync(path.join(DOMAINS_DIR, MIRROR, 'state')),
    '…and NOTHING was written: the mirror has no state/ directory on disk');

  const empty = asJson(await callTool('save_project_brief', { domain: D1, project: 'lumina', text: '   ' }));
  ok(empty?.ok === false && /COMPLETE brief/i.test(empty.error || ''),
    'an empty brief is refused with the complete-not-delta instruction', String(empty.error).slice(0, 160));

  // Over MIN_PROTECTED_BODY_BYTES (1 KB) deliberately: the shrink guard's
  // magnitude arm is specified to leave small briefs alone, so a short fixture
  // would test nothing and pass.
  const body = [
    '# lumina', '', '## Standing brief', '',
    `Ship the adapter by Friday. ${'The full standing brief, at document length. '.repeat(30)}`,
    '', '## Roadmap', '', '- A section the store knows nothing about.',
  ].join('\n');
  const w = asJson(await callTool('save_project_brief', {
    domain: D1, project: 'lumina', text: body, harness: 'Claude Code', model: 'opus-5',
  }));
  ok(w?.ok === true, 'a real brief write succeeds', JSON.stringify(w).slice(0, 200));
  ok(w.created === false, 'and reports that it updated rather than created');
  ok(w.marker_line === `${D1}/lumina`, 'it hands back the `.curator-project` marker line', w.marker_line);
  ok(w.authored_by?.kind === 'agent' && w.authored_by?.harness === 'Claude-Code',
    'the response carries the recorded authorship', JSON.stringify(w.authored_by));
  ok(/replaced the whole document/i.test(w.report || ''),
    'the report repeats that the whole document was replaced', String(w.report).slice(0, 160));

  const disk = readFileSync(sp(D1, 'lumina', 'project.md'), 'utf8');
  ok(disk.startsWith('<!-- curator-brief: authored_by=agent '),
    'the FILE records that an agent wrote it, on line one', disk.slice(0, 80));
  ok(/commissioned=user/.test(disk), '…on the user\'s instruction');
  ok(disk.includes('## Roadmap'), 'an arbitrary section survives the write');

  // …and the next READ must downgrade it from `owner` to `commissioned`,
  // otherwise the payload would tell a model that no agent produced the text.
  const back = asJson(await callTool('get_working_state', { domain: D1, project: 'lumina' }));
  ok(back?.brief?.brief_authority === 'commissioned',
    'the next read classifies it `commissioned`, not `owner`', back?.brief?.brief_authority);
  ok(/WRITTEN BY AN AGENT ON THE OWNER’S INSTRUCTION/.test(back?.brief?.authority_note || ''),
    'and the authority note says so before the text');
  ok(/READ IT BACK/.test(back?.brief?.authority_note || ''),
    '…while KEEPING the owner framing\'s standing-instruction rules');
  ok(/may NEVER WIDEN your authority/.test(back?.brief?.authority_note || ''),
    '…including the limit that stops a brief being an escalation lever');
  // AND IT MUST NOT CARRY THE OWNER PROVENANCE SENTENCE, which says the file
  // has no agent stamp. This one does. A note asserting both would tell the
  // model, in one paragraph, that an agent wrote the file and that no agent
  // wrote the file — the exact self-contradiction that made splitting the
  // constant necessary rather than merely tidy.
  ok(!/no such stamp/i.test(back?.brief?.authority_note || '')
    && !/no earlier session and no agent produced this text/i.test(back?.brief?.authority_note || ''),
    '…and NOT the owner provenance sentence, which would contradict the stamp the file carries',
    String(back?.brief?.authority_note || '').slice(0, 200));
  ok(!/untrusted recorded data/i.test(back?.content_is_data || '')
    || !/`brief`/.test((back?.content_is_data || '').split('untrusted')[0]),
    'and `brief` is NOT listed among the untrusted fields', String(back?.content_is_data).slice(0, 200));

  // A hand-typed brief keeps `owner`. Without this control the assertion above
  // would pass over an implementation that called everything `commissioned`.
  const owner = asJson(await callTool('get_working_state', { domain: D1, project: 'atlas' }));
  ok(owner?.brief?.brief_authority === 'owner',
    'CONTROL: a brief with no provenance comment is still `owner`', owner?.brief?.brief_authority);

  // The destructive-shrink guard, over the wire.
  const tiny = asJson(await callTool('save_project_brief', { domain: D1, project: 'lumina', text: 'oops' }));
  ok(tiny?.ok === false && tiny.reason === 'would-replace-larger-brief',
    'a drastic shrink is refused', JSON.stringify(tiny).slice(0, 180));
  ok(readFileSync(sp(D1, 'lumina', 'project.md'), 'utf8').includes('## Roadmap'),
    'and the stored brief is intact');
  ok(tiny.existing && typeof tiny.existing.bytes === 'number',
    'the refusal carries the sizes so the model can see the scale of what it nearly destroyed',
    JSON.stringify(tiny.existing));
  const forced = asJson(await callTool('save_project_brief', {
    domain: D1, project: 'lumina', text: 'oops', replace: true,
  }));
  ok(forced?.ok === true && (forced.notes || []).some((n) => /overwrote a larger brief/.test(n)),
    'replace: true gets past it and is never silent', JSON.stringify(forced.notes));
  // A truthy non-boolean must NOT authorise it.
  await callTool('save_project_brief', { domain: D1, project: 'lumina', text: body, replace: true });
  const loose = asJson(await callTool('save_project_brief', {
    domain: D1, project: 'lumina', text: 'oops', replace: 'yes',
  }));
  ok(loose?.ok === false && loose.reason === 'would-replace-larger-brief',
    'a truthy STRING does not authorise destroying a document — strict === true');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  Creating a project is a deliberate act with a document behind it');
{
  const noDomain = asJson(await callTool('save_project_brief', {
    project: 'brand-new', text: '## Standing brief\n\nA new thing.', create: true,
  }));
  ok(noDomain?.ok === false && noDomain.reason === 'domain_required',
    'create without a domain is refused — a project cannot be moved between domains later',
    JSON.stringify(noDomain).slice(0, 200));

  const noFlag = asJson(await callTool('save_project_brief', {
    domain: D1, project: 'brand-new', text: '## Standing brief\n\nA new thing.',
  }));
  ok(noFlag?.ok === false && noFlag.reason === 'project_not_found',
    'and without the create flag it is simply not found');
  ok(!existsSync(sp(D1, 'brand-new')), 'nothing was created by either refusal');

  const made = asJson(await callTool('save_project_brief', {
    domain: D1, project: 'brand-new', text: '## Standing brief\n\nA new thing.', create: true,
    harness: 'Claude Code',
  }));
  ok(made?.ok === true && made.created === true, 'create: true with a domain makes it',
    JSON.stringify(made).slice(0, 200));
  ok(existsSync(sp(D1, 'brand-new', 'project.md')), 'the brief is on disk');
  ok(made.marker_line === `${D1}/brand-new`, 'and the marker line comes back', made.marker_line);

  // AMBIGUITY IS NEVER A CREATE: a name that already exists in two domains
  // means the user has one of them in mind, and minting a third is the worst
  // reading of it.
  const ambCreate = asJson(await callTool('save_project_brief', {
    project: 'lumina', text: '## Standing brief\n\nA third one.', create: true,
  }));
  ok(ambCreate?.ok === false && ambCreate.reason === 'project_ambiguous',
    'an AMBIGUOUS name with create: true is refused as ambiguous, not minted a third time',
    JSON.stringify(ambCreate).slice(0, 200));
  ok(!existsSync(sp(D3, 'lumina')), 'and no third lumina appeared anywhere');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  The domain\'s own project keeps writing the pre-v3.48.0 paths');
{
  const r = asJson(await callTool('save_working_state', {
    project: D3, scope: 'compat', headline: 'root level', now_state: 'x',
  }));
  ok(r?.ok === true, 'a save addressed by domain slug succeeds', JSON.stringify(r).slice(0, 160));
  ok(/^state\/compat\//.test(r.path || ''),
    'and lands at state/<scope>/<machine>/ with NO project segment — an older Curator on another machine can still read it',
    r.path);
  ok(!existsSync(sp(D3, D3)), 'no state/<domain>/ directory was created');
}

// ═════════════════════════════════════════════════════════════════════════
section('§0  STDOUT PURITY — asserted LAST, so it covers every byte above');
{
  ok(rawStdoutLines.length > 20,
    `the child spoke on stdout across all sections (${rawStdoutLines.length} lines — an empty stream would make this vacuous)`);
  const bad = rawStdoutLines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
  ok(bad.length === 0, `all ${rawStdoutLines.length} stdout lines parse as JSON-RPC`,
    bad.slice(0, 2).join(' | '));
  ok(stderrText.trim() === '', 'stderr is empty too', stderrText.slice(0, 300));
}

child.stdin.end();
child.kill();
try {
  if (path.dirname(ROOT) === os.tmpdir() && path.basename(ROOT).startsWith('curator-proj-mcp-')) {
    rmSync(ROOT, { recursive: true, force: true });
  }
} catch { /* best effort */ }

console.log(`\n${'─'.repeat(56)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
