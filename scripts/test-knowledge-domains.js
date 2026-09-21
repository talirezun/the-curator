#!/usr/bin/env node
/**
 * test-knowledge-domains.js — OFFLINE. v3.65.0, package P10: WHICH WIKIS a
 * project's knowledge lives in.
 *
 * ── WHAT THE FEATURE IS, IN ONE LINE ─────────────────────────────────────
 * A project carries `knowledgeDomains: [<slug>, …]` in
 * `state/[<project>/]project.json`. Absent reads as `[<containing domain>]`
 * with `knowledgeDomainsDefaulted: true`, so every project that existed
 * before this release reads exactly as it behaved.
 *
 * ── THE FIVE DEFECTS THIS SUITE EXISTS TO STOP, AND THEY ARE ALL SILENT ──
 *
 *   1. THE DEFAULT COLLAPSING INTO A CHOICE. "This project searches its own
 *      domain because nobody said otherwise" and "the owner chose exactly
 *      this domain" are different facts, and a single list cannot tell them
 *      apart. `knowledgeDomainsDefaulted` is the second half, and §2/§4 pin
 *      that every reader carries BOTH.
 *   2. A CONSUMER DROPPING THE FIELD. This module's recorded defect class
 *      (v3.17.1's `unlistedEntries`): the store computes a fact honestly and
 *      a layer above it forwards its payload field by field and omits it.
 *      §4 and §5 drive the store, both MCP handlers, the CLI envelope and
 *      the HTTP read, and require the same two values out of each.
 *   3. THE WRONG WRITER. Tiers 2 and 3 are agent-only and tier 1 is the
 *      human's; this is CURATOR METADATA about the project, so the app
 *      writes it and no agent does. §6 proves a `save_working_state`-shaped
 *      save neither writes nor disturbs `project.json`.
 *   4. A ROUTE COLLISION. `PATCH /:domain/projects/:project` matches any
 *      three-segment PATCH whose second segment is literally `projects`, and
 *      a domain's own project is named after the domain — so the
 *      maintainer's own `projects/projects` would have had this write
 *      swallowed by the rename handler. §7 drives that exact URL.
 *   5. A MALFORMED FILE TAKING A PROJECT DOWN. `project.json` is hand-
 *      editable and syncs. An unreadable one must read as the DEFAULT with
 *      the defect named, never as a refusal and never as an empty list (§3).
 *
 * SAFETY — never touches real user data. `CURATOR_TEST_USER_DATA_DIR` and
 * `CURATOR_TEST_DOMAINS_DIR` are set to a fresh tempdir BEFORE anything
 * imports the store, `__setDomainsDirOverride` belt-and-braces on top; the
 * server listens on an ephemeral port on 127.0.0.1 and is closed in
 * `finally`. No network, no LLM call, no credential file.
 *
 * Run with:  node scripts/test-knowledge-domains.js   (exit 0 = all green)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-knowledge-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-knowledge-')) {
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

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);

const WS = await import('../src/brain/working-state.js');
const {
  readProjectMeta, setKnowledgeDomains, normaliseKnowledgeDomains, readWorkingState,
  getProjectContext, saveWorkingState, createProject, listProjects,
  MAX_KNOWLEDGE_DOMAINS, PROJECT_META_FILENAME,
} = WS;

function makeDomain(slug, frontmatter) {
  mkdirSync(path.join(DOMAINS, slug, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, slug, 'CLAUDE.md'), `${frontmatter || ''}# ${slug}\n`);
  writeFileSync(path.join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
}
const metaPath = (domain, project) => (project === domain
  ? path.join(DOMAINS, domain, 'state', PROJECT_META_FILENAME)
  : path.join(DOMAINS, domain, 'state', project, PROJECT_META_FILENAME));

makeDomain('alpha');
makeDomain('beta');
makeDomain('gamma');
makeDomain('shared-mirror', '---\nreadonly: true\n---\n\n');
// The maintainer's own shape: a domain called `projects`, whose OWN project
// is therefore called `projects` too (§7's collision control).
makeDomain('projects');
await createProject('alpha', 'proj1', {});
await createProject('alpha', 'proj2', {});

// ═════════════════════════════════════════════════════════════════════════
section('1. normaliseKnowledgeDomains — pure, and it names what it dropped');
{
  eq(JSON.stringify(normaliseKnowledgeDomains(['a', 'b']).domains), '["a","b"]', 'order is the caller\'s');
  const dup = normaliseKnowledgeDomains(['a', 'b', 'a']);
  eq(JSON.stringify(dup.domains), '["a","b"]', 'a duplicate collapses to its FIRST position');
  eq(dup.dropped[0].reason, 'duplicate', '...and is named as dropped, not silently gone');
  const bad1 = normaliseKnowledgeDomains(['../etc', 'ok']);
  eq(JSON.stringify(bad1.domains), '["ok"]', 'a path-shaped entry is dropped');
  eq(bad1.dropped[0].reason, 'invalid-domain', '...under its own reason');
  eq(normaliseKnowledgeDomains('beta').dropped[0].reason, 'not-a-list', 'a bare string is not a list');
  eq(JSON.stringify(normaliseKnowledgeDomains(null).domains), '[]', 'null is empty, not an error');
  const over = normaliseKnowledgeDomains(Array.from({ length: MAX_KNOWLEDGE_DOMAINS + 3 }, (_, i) => `d${i}`));
  eq(over.domains.length, MAX_KNOWLEDGE_DOMAINS, `the cap is ${MAX_KNOWLEDGE_DOMAINS}`);
  eq(over.dropped.filter((d) => d.reason === 'over-cap').length, 3, '...and every entry past it is reported');
  eq(over.domains[0], 'd0', '...applied LAST, so the first twelve are the first twelve');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. The default is a FACT, and a choice is a different one');
{
  const d = await readProjectMeta('alpha', 'proj1');
  eq(JSON.stringify(d.knowledgeDomains), '["alpha"]', 'a project with no project.json reads as its own domain');
  eq(d.knowledgeDomainsDefaulted, true, '...and SAYS it was defaulted');
  eq(d.metaError, null, '...with nothing wrong');
  assert(!existsSync(metaPath('alpha', 'proj1')), '...having written no file to read it');

  const set = await setKnowledgeDomains('alpha', 'proj1', ['beta', 'shared-mirror']);
  assert(set.ok, 'the owner can point a project at other domains', set.message);
  eq(JSON.stringify(set.knowledgeDomains), '["beta","shared-mirror"]', '...including a shared-* MIRROR, which is read-only knowledge and fine');
  eq(set.knowledgeDomainsDefaulted, false, '...and the answer says it is a choice now');
  const onDisk = JSON.parse(readFileSync(metaPath('alpha', 'proj1'), 'utf8'));
  eq(onDisk.version, 1, 'the file carries a version');
  eq(JSON.stringify(onDisk.knowledgeDomains), '["beta","shared-mirror"]', '...and the list, in order');
  eq(Object.keys(onDisk).length, 2, '...and nothing else');
  assert(!JSON.stringify(onDisk).includes('alpha'), 'the containing domain is NOT forced into the list — pointing only elsewhere is the case this exists for');

  // A field this release does not know about SURVIVES a write.
  writeFileSync(metaPath('alpha', 'proj1'), JSON.stringify({
    version: 1, knowledgeDomains: ['beta'], somethingLater: { kept: true },
  }, null, 2));
  await setKnowledgeDomains('alpha', 'proj1', ['gamma']);
  const merged = JSON.parse(readFileSync(metaPath('alpha', 'proj1'), 'utf8'));
  eq(JSON.stringify(merged.somethingLater), '{"kept":true}', 'a write is read–modify–write: a future field is not deleted by this one');
  eq(JSON.stringify(merged.knowledgeDomains), '["gamma"]', '...and the list is replaced whole');

  // CLEARING is not the same as an empty list.
  const cleared = await setKnowledgeDomains('alpha', 'proj1', null);
  assert(cleared.ok, 'null clears the choice', cleared.message);
  eq(cleared.cleared, true, '...saying so');
  eq(JSON.stringify(cleared.knowledgeDomains), '["alpha"]', '...and the project reads as its own domain again');
  eq(cleared.knowledgeDomainsDefaulted, true, '...defaulted');
  // Read DEFENSIVELY: a store that stopped merging would have removed this
  // file entirely, and a crash here would report the defect as a broken
  // suite rather than as the assertion it is.
  const afterClearRaw = existsSync(metaPath('alpha', 'proj1')) ? readFileSync(metaPath('alpha', 'proj1'), 'utf8') : null;
  assert(afterClearRaw !== null, 'the file SURVIVES a clear when it still holds another field');
  const afterClear = afterClearRaw ? JSON.parse(afterClearRaw) : {};
  assert(!('knowledgeDomains' in afterClear), 'the field is gone from the file');
  eq(JSON.stringify(afterClear.somethingLater), '{"kept":true}', '...and the unknown field is STILL kept');

  // …and when nothing else is in the file, the file goes too.
  await setKnowledgeDomains('alpha', 'proj2', ['beta']);
  assert(existsSync(metaPath('alpha', 'proj2')), '(fixture) proj2 has a file');
  await setKnowledgeDomains('alpha', 'proj2', null);
  assert(!existsSync(metaPath('alpha', 'proj2')), 'a file with nothing left in it is REMOVED, so "defaulted" is a shape on disk too');

  // The domain's OWN project keeps its metadata at the state root, exactly
  // where its brief is — no `<domain>/` segment invented for it.
  const own = await setKnowledgeDomains('alpha', 'alpha', ['alpha', 'gamma']);
  assert(own.ok, 'the domain\'s own project can choose too', own.message);
  assert(existsSync(path.join(DOMAINS, 'alpha', 'state', PROJECT_META_FILENAME)),
    '...at state/project.json, beside its brief');
  assert(!existsSync(path.join(DOMAINS, 'alpha', 'state', 'alpha')),
    '...and NOT in a folder named after the domain');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. Every refusal names what it refused, and writes nothing');
{
  const before = existsSync(metaPath('alpha', 'proj2'));
  eq((await setKnowledgeDomains('alpha', 'proj2', 'beta')).reason, 'not-a-list', 'a bare string is refused');
  eq((await setKnowledgeDomains('alpha', 'proj2', [])).reason, 'empty-list',
    'an EMPTY list is refused — a project that searches nothing has no knowledge, and nobody means that');
  eq((await setKnowledgeDomains('alpha', 'proj2', ['../etc/passwd'])).reason, 'invalid-domain', 'a path-shaped name is refused');
  const unknown = await setKnowledgeDomains('alpha', 'proj2', ['beta', 'nope']);
  eq(unknown.reason, 'unknown-domain', 'a domain that is not on this computer is refused');
  eq(JSON.stringify(unknown.domains), '["nope"]', '...naming which one, so the owner can fix it');
  eq((await setKnowledgeDomains('alpha', 'proj2',
    Array.from({ length: MAX_KNOWLEDGE_DOMAINS + 1 }, () => 'beta').map((d, i) => (i ? `${d}${i}` : d)))).reason,
  'too-many-domains', `more than ${MAX_KNOWLEDGE_DOMAINS} is refused`);
  eq((await setKnowledgeDomains('alpha', 'ghost', ['beta'])).reason, 'unknown-state-project', 'an unknown project is refused');
  eq((await setKnowledgeDomains('shared-mirror', 'shared-mirror', ['beta'])).reason, 'readonly',
    'a read-only Shared Brain mirror is refused, through the store\'s own project gate');
  eq(existsSync(metaPath('alpha', 'proj2')), before, 'after seven refusals nothing on disk changed');

  // A DOMAIN FOLDER WITH NO SCHEMA IS NOT A DOMAIN — the allow-list is
  // `listDomains()`, and a ghost folder left by a sync deletion is not one.
  mkdirSync(path.join(DOMAINS, 'ghostdir', 'wiki'), { recursive: true });
  eq((await setKnowledgeDomains('alpha', 'proj2', ['ghostdir'])).reason, 'unknown-domain',
    'a directory with no CLAUDE.md schema is not a domain, so it cannot be chosen');

  // ── A MALFORMED FILE READS AS THE DEFAULT, WITH THE DEFECT NAMED ──────
  writeFileSync(metaPath('alpha', 'proj2'), '{not json at all');
  const broken = await readProjectMeta('alpha', 'proj2');
  eq(JSON.stringify(broken.knowledgeDomains), '["alpha"]', 'a malformed project.json reads as the DEFAULT');
  eq(broken.knowledgeDomainsDefaulted, true, '...defaulted');
  assert(/not valid JSON/.test(broken.metaError || ''), '...with the defect named rather than swallowed', broken.metaError);
  const stillReads = await readWorkingState('alpha', { project: 'proj2' });
  eq(stillReads.ok, true, '...and the whole project still reads — a hand-broken metadata file takes nothing down with it');
  eq(stillReads.knowledgeDomainsError !== undefined, true, '...carrying the error to the envelope');

  writeFileSync(metaPath('alpha', 'proj2'), JSON.stringify({ version: 1, knowledgeDomains: ['../x', 42] }));
  const allBad = await readProjectMeta('alpha', 'proj2');
  eq(JSON.stringify(allBad.knowledgeDomains), '["alpha"]', 'a list with no usable entry reads as the default');
  assert(/no usable knowledge domain/.test(allBad.metaError || ''), '...and says so', allBad.metaError);

  writeFileSync(metaPath('alpha', 'proj2'), JSON.stringify({ version: 1, knowledgeDomains: ['beta', 42] }));
  const partly = await readProjectMeta('alpha', 'proj2');
  eq(JSON.stringify(partly.knowledgeDomains), '["beta"]', 'a list with one usable entry keeps it');
  eq(partly.knowledgeDomainsDefaulted, false, '...as a choice');
  assert(/dropped/.test(partly.metaError || ''), '...disclosing the entry it dropped', partly.metaError);
  rmSync(metaPath('alpha', 'proj2'));

  // The READ does not probe the domains folder, deliberately — a domain
  // deleted after the choice still reads here, and the surfaces say so.
  writeFileSync(metaPath('alpha', 'proj2'), JSON.stringify({ version: 1, knowledgeDomains: ['beta', 'deleted-later'] }));
  eq(JSON.stringify((await readProjectMeta('alpha', 'proj2')).knowledgeDomains), '["beta","deleted-later"]',
    'a read costs no domains listing, so a domain deleted afterwards still reads (recorded, not fixed)');
  rmSync(metaPath('alpha', 'proj2'));
}

// ═════════════════════════════════════════════════════════════════════════
section('4. EVERY READER carries both fields — the drop class');
{
  await setKnowledgeDomains('alpha', 'proj1', ['beta', 'gamma']);
  const state = await readWorkingState('alpha', { project: 'proj1' });
  eq(JSON.stringify(state.knowledgeDomains), '["beta","gamma"]', 'readWorkingState carries the list');
  eq(state.knowledgeDomainsDefaulted, false, '...and whether it was chosen');
  const ctx = await getProjectContext('alpha', 'proj1', {});
  eq(JSON.stringify(ctx.knowledgeDomains), '["beta","gamma"]', 'getProjectContext carries the list');
  eq(ctx.knowledgeDomainsDefaulted, false, '...and the flag');
  const defaulted = await getProjectContext('alpha', 'proj2', {});
  eq(JSON.stringify(defaulted.knowledgeDomains), '["alpha"]', 'an unchosen project reads as its own domain');
  eq(defaulted.knowledgeDomainsDefaulted, true, '...flagged as the default');

  // THE CLI's `--json` is the store envelope VERBATIM, so the field rides —
  // and its MARKDOWN rendering, which is what a session-start hook injects,
  // has to say it too or the harness that never sees JSON never learns it.
  const { renderContextMarkdown } = await import('../src/cli/context.js');
  const md = renderContextMarkdown(ctx);
  assert(/beta/.test(md) && /gamma/.test(md), 'the CLI\'s markdown rendering names the knowledge domains', md.slice(0, 200));
  assert(/Knowledge/i.test(md), '...under a heading a reader can find');
  const mdDefault = renderContextMarkdown(defaulted);
  assert(/default/i.test(mdDefault), '...and says when the list is the default rather than a choice', mdDefault.slice(0, 400));
}

// ═════════════════════════════════════════════════════════════════════════
section('5. BOTH MCP handlers carry it, and the report says where to search');
{
  const tools = await import('../mcp/tools/working-state.js');
  const storage = {
    listDomains: async () => ['alpha', 'beta', 'gamma', 'projects', 'shared-mirror'],
    getDefaultDomain: async () => 'alpha',
  };
  const gws = await tools.getWorkingStateHandler({ domain: 'alpha', project: 'proj1' }, storage);
  eq(JSON.stringify(gws.knowledgeDomains), '["beta","gamma"]', 'get_working_state forwards the list');
  eq(gws.knowledgeDomainsDefaulted, false, '...and the flag');
  const gpc = await tools.getProjectContextHandler({ domain: 'alpha', project: 'proj1' }, storage);
  eq(JSON.stringify(gpc.knowledgeDomains), '["beta","gamma"]', 'get_project_context forwards the list');
  eq(gpc.knowledgeDomainsDefaulted, false, '...and the flag');
  assert(/knowledge/i.test(gpc.report), 'the report tells the agent where the knowledge is', gpc.report.slice(-200));
  assert(/'beta'/.test(gpc.report) && /'gamma'/.test(gpc.report), '...naming the domains', gpc.report.slice(-200));
  assert(/search_wiki/.test(gpc.report), '...and the tool to search them with', gpc.report.slice(-200));
  const gpc2 = await tools.getProjectContextHandler({ domain: 'alpha', project: 'proj2' }, storage);
  assert(/not chosen/.test(gpc2.report), 'a defaulted list is named as the default, never dressed up as a choice', gpc2.report.slice(-200));
  // THE SPELLING IS THE STORE'S, on both tools. Two spellings of one fact
  // across two tools of one server is the drift this pins shut.
  assert(!('knowledge_domains' in gws) && !('knowledge_domains' in gpc),
    'neither tool invents a snake_case second spelling');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. NO AGENT WRITES IT — save_working_state cannot reach this file');
{
  await setKnowledgeDomains('alpha', 'proj1', ['beta']);
  const before = readFileSync(metaPath('alpha', 'proj1'), 'utf8');
  const saved = await saveWorkingState('alpha', {
    project: 'proj1', scope: 'main', headline: 'a handoff',
    nowDoing: 'checking that a save cannot choose a project\'s knowledge',
    knowledgeDomains: ['gamma'],                     // planted: must be ignored
    harness: 'test', model: 'test',
  });
  assert(saved.ok, '(fixture) an ordinary handoff saves', saved.message);
  eq(readFileSync(metaPath('alpha', 'proj1'), 'utf8'), before,
    'a save carrying `knowledgeDomains` leaves project.json BYTE-IDENTICAL — an agent does not choose a project\'s knowledge');
  eq(JSON.stringify((await readProjectMeta('alpha', 'proj1')).knowledgeDomains), '["beta"]', '...and the choice is unchanged');
  const src = readFileSync(new URL('../src/brain/working-state.js', import.meta.url), 'utf8');
  const saveFn = src.slice(src.indexOf('export async function saveWorkingState'), src.indexOf('export async function saveProjectBrief'));
  assert(!/knowledgeDomains/.test(saveFn), '...and the save path does not mention the field at all', 'saveWorkingState names it');
  const cliSave = readFileSync(new URL('../src/cli/save.js', import.meta.url), 'utf8');
  assert(!/knowledgeDomains/i.test(cliSave), 'the CLI\'s save does not write it either');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. THE ROUTE — a strict body, and no collision with the rename');
{
  const express = (await import('express')).default;
  const routerMod = await import('../src/routes/memory.js');
  const app = express();
  app.use(express.json());
  app.use('/api/memory', routerMod.default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}/api/memory`;
  const req = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = {}; }
    return { status: res.status, body: parsed || {} };
  };

  try {
    // THE READ carries both fields, through the detail route's spread.
    const read = await req('GET', '/alpha/proj1');
    eq(read.status, 200, 'the project detail read answers 200');
    eq(JSON.stringify(read.body.knowledgeDomains), '["beta"]', '...carrying the list');
    eq(read.body.knowledgeDomainsDefaulted, false, '...and whether it was chosen');
    const readDefault = await req('GET', '/alpha/proj2');
    eq(JSON.stringify(readDefault.body.knowledgeDomains), '["alpha"]', 'an unchosen project reads as its own domain over HTTP');
    eq(readDefault.body.knowledgeDomainsDefaulted, true, '...flagged');

    // THE WRITE.
    const patched = await req('PATCH', '/alpha/proj1/knowledge/domains', { knowledgeDomains: ['gamma', 'beta'] });
    eq(patched.status, 200, 'the PATCH answers 200');
    eq(JSON.stringify(patched.body.knowledgeDomains), '["gamma","beta"]', '...with the list it stored, in order');
    eq(patched.body.knowledgeDomainsDefaulted, false, '...and the flag, so a view repaints without a second read');
    eq(patched.body.cap, MAX_KNOWLEDGE_DOMAINS, '...and the cap, named rather than hard-coded in a view');
    eq(JSON.stringify((await readProjectMeta('alpha', 'proj1')).knowledgeDomains), '["gamma","beta"]', '...and the store really changed');

    const nulled = await req('PATCH', '/alpha/proj1/knowledge/domains', { knowledgeDomains: null });
    eq(nulled.status, 200, 'null clears over HTTP too');
    eq(nulled.body.cleared, true, '...saying so');
    eq(nulled.body.knowledgeDomainsDefaulted, true, '...and reading as the default again');

    // A STRICT BODY.
    const extra = await req('PATCH', '/alpha/proj1/knowledge/domains', { knowledgeDomains: ['beta'], rename: 'x' });
    eq(extra.status, 400, 'an unknown field is a 400');
    eq(extra.body.reason, 'unexpected_fields', '...under v3.62.0\'s own reason');
    assert((extra.body.fields || []).includes('rename'), '...naming the field', JSON.stringify(extra.body.fields));
    eq((await req('PATCH', '/alpha/proj1/knowledge/domains', {})).body.reason, 'invalid_knowledge_domains',
      'an empty body is a 400');
    eq((await req('PATCH', '/alpha/proj1/knowledge/domains', { knowledgeDomains: 'beta' })).body.reason,
      'invalid_knowledge_domains', 'a bare string is a 400');
    eq((await req('PATCH', '/alpha/proj1/knowledge/domains', { knowledgeDomains: [] })).status, 400,
      'an empty list is a 400');

    // REFUSALS, AND THEIR STATUSES.
    const unknownDomain = await req('PATCH', '/alpha/proj1/knowledge/domains', { knowledgeDomains: ['nope'] });
    eq(unknownDomain.status, 400, 'a domain that is not here is a 400');
    eq(unknownDomain.body.reason, 'unknown_domain', '...in this router\'s underscored spelling');
    assert((unknownDomain.body.domains || []).includes('nope'), '...naming which one', JSON.stringify(unknownDomain.body.domains));
    const ghost = await req('PATCH', '/alpha/ghost/knowledge/domains', { knowledgeDomains: ['beta'] });
    eq(ghost.status, 404, 'an unknown project is a 404');
    eq(ghost.body.reason, 'project_not_found', '...under the name the sibling reads use');
    eq((await req('PATCH', '/no-such-domain/p/knowledge/domains', { knowledgeDomains: ['beta'] })).status, 404,
      'an unknown domain is a 404, through requireDomain');
    const mirror = await req('PATCH', '/shared-mirror/shared-mirror/knowledge/domains', { knowledgeDomains: ['beta'] });
    eq(mirror.status, 403, 'a Shared Brain mirror is refused with a 403, through refuseMirror');

    // ── THE COLLISION CONTROL ────────────────────────────────────────────
    // `PATCH /:domain/projects/:project` is registered ABOVE this route and
    // matches any three-segment PATCH whose second segment is `projects`. A
    // domain's own project is named after the domain, so the maintainer's own
    // `projects/projects` is exactly the case a three-segment knowledge route
    // would have lost to the rename handler.
    const collide = await req('PATCH', '/projects/projects/knowledge/domains', { knowledgeDomains: ['alpha'] });
    eq(collide.status, 200, 'a project named after a domain called `projects` CAN set its knowledge domains');
    eq(JSON.stringify(collide.body.knowledgeDomains), '["alpha"]', '...and it takes');
    eq(collide.body.project, 'projects', '...about the project, not about a project called "knowledge"');
    // …and the rename route it sits beside is untouched.
    const rename = await req('PATCH', '/alpha/projects/proj2', { brief: '# a brief\n\nBody.\n' });
    eq(rename.status, 200, 'the neighbouring brief/rename route still answers');
    eq(rename.body.briefSaved, true, '...and did its own job');
  } finally {
    server.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('8. `project.json` is a RESERVED project name, and not a project');
{
  eq(WS.projectPrefix('alpha', 'project.json'), null,
    'a project cannot be called project.json — it would have to be a directory where the domain\'s own metadata file is');
  const made = await createProject('alpha', 'project.json', {});
  eq(made.ok, false, '...so creating one is refused');
  const listed = await listProjects('alpha');
  const names = (listed.projects || []).map((p) => p.project);
  assert(!names.includes('project.json'), 'the metadata FILE is never listed as a project', JSON.stringify(names));
  const layout = await WS.scanStateLayout('alpha');
  assert(!(layout.defaultScopeDirs || []).includes(PROJECT_META_FILENAME),
    'nor as a work-stream of the domain\'s own project');
  const scopes = await WS.listWorkingScopes('alpha', {});
  assert(!JSON.stringify(scopes.scopes || []).includes(PROJECT_META_FILENAME),
    'nor anywhere in the scope index');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. Nothing outside the tempdir was touched');
{
  assert(statSync(DOMAINS).isDirectory(), 'the isolated domains folder is the one that was used');
  const real = path.join(process.env.HOME || '/nonexistent', 'second-brain', 'domains');
  assert(!DOMAINS.startsWith(real), 'the suite never resolved the developer\'s own domains folder', DOMAINS);
}

console.log('\n' + '═'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
console.log('═'.repeat(60));
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    └─ ${f.err}`);
  process.exit(1);
}
console.log('All knowledge-domain assertions green.');
