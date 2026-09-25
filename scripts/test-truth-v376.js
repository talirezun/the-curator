/**
 * test-truth-v376.js — the v3.76.0 truth-audit fixes that live below the view
 * (the view halves are in test-next-memory-view.js §31, test-next-answer.js §9
 * and test-chat-project-restore in this file's §7), plus the default-scope rule.
 *
 *   §1  F1   the MCP report says "written <writtenAt>", never "saved <file date>";
 *            the file's time is added only when the two clocks differ
 *   §2  F2   the brief's OWN stamp (`writtenAt` / `briefWrittenAt`) beside the
 *            file's mtime, on the store read, the index row, list_projects and
 *            the CLI/hook markdown header
 *   §3  F14  save_foundation's description derives its size from the constant
 *   §4  F15  the delete preview says which machine folders share an install id
 *   §5  —    the default scope: no scope + a harness → that tool's own scope
 *   §6  F13  reopening a conversation restores its own project (pure half)
 *
 * Behaviour, not source lines: every assertion drives the real store, the real
 * MCP handler or the real renderer. Isolated with CURATOR_TEST_USER_DATA_DIR +
 * CURATOR_TEST_DOMAINS_DIR under a temp dir; nothing touches a real install.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

os.hostname = () => 'truth-v376-suite-host';
syncBuiltinESMExports();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-truth-v376-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-truth-v376-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

let passed = 0; let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else {
    failed++; console.log(`  ✗ ${label}`); if (detail !== undefined) console.log(`    └─ ${String(detail).slice(0, 600)}`);
  }
}
function eq(a, b, label) { ok(a === b, `${label}`, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function section(name) { console.log(`\n── ${name} ──`); }

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');
const tools = await import('../mcp/tools/working-state.js');
const CM = await import('../src/brain/context-markdown.js');
// The MCP handlers' storage: the two calls these reach, faithful enough.
const STORAGE = { listDomains: async () => ['acme'], appendToWriteAudit: async () => {} };

function makeDomain(slug) {
  mkdirSync(path.join(DOMAINS, slug, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, slug, 'CLAUDE.md'), `# ${slug}\n`);
  writeFileSync(path.join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
}
makeDomain('acme');
await WS.createProject('acme', 'conduit', {});
const stateDir = (...p) => path.join(DOMAINS, 'acme', 'state', ...p);
const setMtime = (abs, iso) => { const t = new Date(iso); utimesSync(abs, t, t); };

// ═══════════════════════════════════════════════════════════════════════════
section('§1  F1 — "written <writtenAt>", and the file time only when it differs');
{
  eq(tools.handoffWhen({ writtenAt: '2026-09-16T10:00:00.000Z', savedAt: '2026-09-25T08:51:00.000Z' }),
    'written 2026-09-16T10:00:00.000Z (arrived on this disk 2026-09-25T08:51:00.000Z)',
    '★ a restore this morning over a handoff written on the 16th: BOTH clocks, each named');
  eq(tools.handoffWhen({ writtenAt: '2026-09-16T10:00:00.000Z', savedAt: '2026-09-16T10:00:00.000Z' }),
    'written 2026-09-16T10:00:00.000Z', 'the two within the save\'s own moment: one clock');
  eq(tools.handoffWhen({ savedAt: '2026-09-25T08:51:00.000Z' }),
    'no save time recorded; the file arrived on this disk 2026-09-25T08:51:00.000Z',
    'no agent stamp: the file\'s time is named as the FILE\'s, never as the save');

  // THE MEASURED CASE, end to end: a real save, then the file's mtime moved
  // nine days forward (what a restore or a pull does), read through the REAL
  // get_working_state and get_project_context handlers.
  const saved = await WS.saveWorkingState('acme', { project: 'conduit', scope: 'main', headline: 'restored handoff',
    nowState: 'x', harness: 'Claude Code' });
  ok(saved.ok, 'CONTROL: a real save');
  const cur = stateDir('conduit', 'main', saved.machine, 'current.md');
  const later = new Date(Date.now() + 9 * 86400_000).toISOString().replace(/\.\d+Z$/, '.000Z');
  setMtime(cur, later);
  const r = await tools.getWorkingStateHandler({ domain: 'acme', project: 'conduit', scope: 'main' }, STORAGE);
  ok(r.current && r.current.writtenAt && r.current.savedAt === later, 'CONTROL: the file clock moved, the agent clock did not');
  ok(r.report.includes(`, written ${r.current.writtenAt} (arrived on this disk ${later}).`) && !/, saved \d{4}-/.test(r.report),
    '★ get_working_state\'s report: "written <writtenAt> (arrived on this disk <file time>)", never "saved <file time>"', r.report);
  const c = await tools.getProjectContextHandler({ domain: 'acme', project: 'conduit' }, STORAGE);
  ok(c.report.includes(`, written ${c.current.writtenAt} (arrived on this disk ${later}).`) && !/, saved \d{4}-/.test(c.report),
    '★ get_project_context\'s report says the same', c.report.slice(0, 300));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  F2 — the brief\'s own stamp, beside the file\'s mtime');
{
  const w = await WS.saveProjectBriefText('acme', 'conduit', '# conduit\n\n## Goal\n\nShip it.\n', { authoredBy: { kind: 'human' }, allowCreate: true });
  ok(w.ok, 'CONTROL: a brief written through the store');
  const briefAbs = stateDir('conduit', 'project.md');
  const stamp = WS.parseBriefProvenance(readFileSync(briefAbs, 'utf8')).at;
  ok(typeof stamp === 'string', 'CONTROL: the store stamped it (provenance `on=`)');
  const restored = new Date(Date.now() + 7 * 3600_000).toISOString().replace(/\.\d+Z$/, '.000Z');
  setMtime(briefAbs, restored);
  const b = await WS.readProjectBrief('acme', 'conduit');
  eq(b.writtenAt, stamp, '★ readProjectBrief.writtenAt is the brief\'s OWN stamp');
  eq(b.updatedAt, restored, '...and updatedAt stays the file\'s mtime (unchanged contract)');
  const st = await WS.readWorkingState('acme', { project: 'conduit' });
  eq(st.brief.writtenAt, stamp, '★ the project read\'s brief carries the same stamp');
  const lp = await WS.listProjects('acme');
  const row = (lp.projects || []).find((p) => p.project === 'conduit') || {};
  ok(row.briefWrittenAt === stamp && row.briefUpdatedAt === restored, '★ the index row: briefWrittenAt beside briefUpdatedAt',
    JSON.stringify({ w: row.briefWrittenAt, u: row.briefUpdatedAt }));
  const mcp = await tools.listProjectsHandler({ domain: 'acme' }, STORAGE);
  const mrow = (mcp.projects || []).find((p) => p.project === 'conduit') || {};
  eq(mrow.briefWrittenAt, stamp, '★ list_projects carries briefWrittenAt on the wire');

  // The structured door writes `_Updated: <ISO>_` and no provenance comment.
  eq(WS.briefStampOf('# Project brief — x\n\n_Updated: 2026-09-10T08:00:00.000Z_\n\n## Goal\n\ny\n'),
    '2026-09-10T08:00:00.000Z', 'the structured door\'s `_Updated:_` line is the stamp when there is no comment');
  eq(WS.briefStampOf('# Typed by hand\n\nNo stamp anywhere.\n'), null, 'a hand-typed brief has NO stamp — never the mtime');

  // THE CLI / HOOK HEADER (context-markdown): both clocks, named.
  const md = CM.renderContextMarkdown({ project: 'conduit', domain: 'acme',
    brief: { present: true, text: 'x', writtenAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-25T08:51:00.000Z',
      authoredBy: { kind: 'human' } }, current: { present: false } }, { authority: 'owner' });
  ok(/written 2026-09-16T10:00:00\.000Z · changed on this disk 2026-09-25T08:51:00\.000Z/.test(md) && !/· updated 2026/.test(md),
    '★ the markdown header: "written <stamp> · changed on this disk <mtime>", never "updated <mtime>"', md.slice(0, 600));
  const md2 = CM.renderContextMarkdown({ project: 'conduit', domain: 'acme',
    brief: { present: true, text: 'x', writtenAt: null, updatedAt: '2026-09-25T08:51:00.000Z' }, current: { present: false } }, { authority: 'owner' });
  ok(/file last changed on this disk 2026-09-25T08:51:00\.000Z \(no written stamp\)/.test(md2), '...an unstamped brief says the file\'s time as the file\'s');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  F14 — save_foundation\'s size is derived, not typed');
{
  const d = tools.saveFoundationDefinition.description;
  ok(d.includes(`up to ${Math.round(WS.MAX_FOUNDATION_BYTES / 1024)} KB`), '★ the description names the store constant\'s size');
  const text = tools.saveFoundationDefinition.inputSchema.properties.text.description;
  ok(text.includes(`${Math.round(WS.MAX_FOUNDATION_BYTES / 1024)} KB`), '...the same figure its `text` argument names');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  F15 — machine folders sharing an install id are named in the delete preview');
{
  const WSD = await import('../src/public/next/views/ws-delete.js');
  const groups = WSD.sharedInstallIds([{ machine: 'laptop-9a8b7c' }, { machine: 'mac-9a8b7c' },
    { machine: 'studio-9f3c1a' }, { machine: 'no-id-here' }]);
  eq(JSON.stringify(groups), '[{"id":"9a8b7c","machines":["laptop-9a8b7c","mac-9a8b7c"]}]',
    '★ two host names with one install id are grouped; distinct ids and id-less names are not');
  const html = WSD.wsDeleteCardHtml({ scope: 'main', preview: { total: 3, machines: [
    { machine: 'laptop-9a8b7c', hasCurrent: true }, { machine: 'mac-9a8b7c', hasCurrent: true },
    { machine: 'studio-9f3c1a', hasCurrent: true }] } });
  ok(/laptop-9a8b7c and mac-9a8b7c share one install id \(9a8b7c\) — probably the same computer under two names\./.test(html),
    '★ the card says so in words', html.slice(0, 400));
  ok(/This removes 3 saved copies/.test(html), '...and still counts every folder, because every one of them goes');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The default scope — no scope + a harness → that tool\'s own scope');
{
  const s1 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'no scope, Claude Code', nowState: 'a', harness: 'Claude Code' });
  eq(s1.scope, 'claude-code', '★ omitted scope + harness "Claude Code" → claude-code');
  eq(s1.scopeChosenBy, 'harness', '...and the result says why');
  const s2 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'variant', nowState: 'b', harness: 'Claude Code (desktop app)' });
  const s3 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'lowercase', nowState: 'c', harness: 'claude-code' });
  ok(s2.scope === 'claude-code' && s3.scope === 'claude-code', '★ spelling variants of ONE tool land in ONE scope');
  const s4 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'agy', nowState: 'd', harness: 'Antigravity' });
  eq(s4.scope, 'antigravity', '★ a second tool gets its OWN scope — the two no longer overwrite each other');
  const s5 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'unknown tool', nowState: 'e', harness: 'Zeta Agent 2' });
  eq(s5.scope, 'zeta-agent-2', 'an unknown tool gets its own name, slugified');
  const s6 = await WS.saveWorkingState('acme', { project: 'conduit', scope: 'main', headline: 'explicit main', nowState: 'f', harness: 'Claude Code' });
  ok(s6.scope === 'main' && s6.scopeChosenBy === 'given', '★ an EXPLICIT main is honoured, harness or not');
  const s7 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'no harness', nowState: 'g' });
  ok(s7.scope === 'main' && s7.scopeChosenBy === 'default', '★ no scope and no harness → main, as before');
  const s8 = await WS.saveWorkingState('acme', { project: 'conduit', headline: 'reserved', nowState: 'h', harness: 'foundations' });
  eq(s8.scope, 'main', 'a harness that slugs to a RESERVED name falls back to main, never refused');

  // THE MCP REPLY SAYS WHICH SCOPE AND WHY.
  const r = await tools.saveWorkingStateHandler({ domain: 'acme', project: 'conduit', headline: 'via mcp', now_state: 'i', harness: 'Antigravity' }, STORAGE);
  ok(r.ok && r.scope === 'antigravity' && r.scope_chosen_by === 'harness', '★ save_working_state: scope + scope_chosen_by');
  ok(/No scope was given, so it was saved under your tool's own scope `antigravity`/.test(r.report), '...and the report says it in words', r.report);
  const r2 = await tools.saveWorkingStateHandler({ domain: 'acme', project: 'conduit', headline: 'mcp no harness', now_state: 'j' }, STORAGE);
  ok(r2.scope === 'main' && r2.scope_chosen_by === 'default' && /No scope and no harness were given/.test(r2.report), '...and for main by default');
  const r3 = await tools.saveWorkingStateHandler({ domain: 'acme', project: 'conduit', scope: 'main', headline: 'mcp explicit', now_state: 'k', harness: 'Antigravity' }, STORAGE);
  ok(r3.scope === 'main' && r3.scope_chosen_by === 'given' && !/No scope/.test(r3.report), '...and says nothing extra for an explicit scope');
  const desc = tools.saveWorkingStateDefinition.inputSchema.properties.scope.description;
  ok(/your tool's own scope/.test(desc) && !/Default 'main'/.test(desc), 'the scope argument\'s description states the new default');
  ok(Buffer.byteLength(JSON.stringify(tools.saveWorkingStateDefinition), 'utf8') <= 3200,
    'save_working_state stays under the 3,200-byte tool ceiling');

  // READS ARE UNCHANGED: no scope → the newest work-stream.
  const c = await tools.getProjectContextHandler({ domain: 'acme', project: 'conduit' }, STORAGE);
  eq(c.scope, 'main', 'a read that names no scope still opens the NEWEST work-stream (here main, saved last)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  F13 — a reopened conversation\'s project, from its own messages');
{
  const chatSrc = readFileSync(path.join(ROOT, 'src/public/next/views/chat.js'), 'utf8');
  const fnSrc = (name) => {
    const start = chatSrc.search(new RegExp('^(?:export )?function ' + name + '\\(', 'm'));
    let i = chatSrc.indexOf('{', start); let depth = 0;
    for (; i < chatSrc.length; i++) { if (chatSrc[i] === '{') depth++; else if (chatSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
    return chatSrc.slice(start, i).replace(/^export /, '');
  };
  const conversationProject = new Function(fnSrc('conversationProject') + '\nreturn conversationProject;')();
  eq(JSON.stringify(conversationProject([{ role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', project: 'curator' }, { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'b', project: 'conduit' }])), '{"recorded":true,"project":"conduit"}',
  '★ the NEWEST answer\'s recorded project wins');
  eq(JSON.stringify(conversationProject([{ role: 'assistant', content: 'a', project: 'curator' },
    { role: 'assistant', content: 'b', project: null }])), '{"recorded":true,"project":null}',
  '...a recorded "no project" (null) is a record, restored as No project');
  eq(JSON.stringify(conversationProject([{ role: 'assistant', content: 'old' }])), '{"recorded":false,"project":null}',
    '...a conversation from before the field recorded nothing: nothing is guessed');

  // THE WIRING, executed: applyConversationProject + restorePinnedProject over
  // a state object, with the pin in a fake localStorage.
  const mk = (over = {}) => {
    const state = { activeDomain: 'projects', projectsFor: 'projects', projectsState: 'ready',
      projectRows: [{ project: 'curator' }, { project: 'conduit' }], activeProject: 'conduit',
      activeProjectFrom: 'pin', activeProjectScope: null, projectLastUsed: null, projectKnowledge: null, ...over };
    const log = { patched: 0, knowledge: [], pinWrites: 0 };
    const api = new Function('state', 'readPinnedProjects', 'patchProjectPicker', 'ensureProjectKnowledge',
      fnSrc('conversationProject') + '\n' + fnSrc('applyConversationProject') + '\n' + fnSrc('restorePinnedProject')
      + '\nreturn { applyConversationProject, restorePinnedProject };')(
      state, () => ({ projects: 'conduit' }), () => { log.patched++; },
      async (d, p) => { log.knowledge.push(p); });
    return { state, log, api };
  };
  {
    const { state, log, api } = mk();
    api.applyConversationProject('projects', [{ role: 'assistant', content: 'a', project: 'curator' }], 1);
    ok(state.activeProject === 'curator' && state.activeProjectFrom === 'conversation',
      '★ opening a conversation that used `curator` shows `curator`, not the pinned `conduit`');
    ok(log.patched === 1 && JSON.stringify(log.knowledge) === '["curator"]', '...the pill is repainted and its knowledge read');
    api.restorePinnedProject(1);
    ok(state.activeProject === 'conduit' && state.activeProjectFrom === 'pin', '★ a NEW chat goes back to the pin — today\'s behaviour');
  }
  {
    const { state, api } = mk();
    api.applyConversationProject('projects', [{ role: 'assistant', content: 'a', project: 'deleted-project' }], 1);
    ok(state.activeProject === null, 'a project that no longer exists is NOT restored');
  }
  {
    const { state, api } = mk({ activeProject: 'curator', activeProjectFrom: 'conversation' });
    api.applyConversationProject('projects', [{ role: 'assistant', content: 'old answer' }], 1);
    ok(state.activeProject === 'conduit' && state.activeProjectFrom === 'pin',
      'an older conversation (nothing recorded) opens on the pin — even after another thread restored its own');
  }
  {
    const { state, api } = mk();
    api.applyConversationProject('elsewhere', [{ role: 'assistant', content: 'a', project: 'curator' }], 1);
    eq(state.activeProject, 'conduit', 'CONTROL: an answer for a domain that is no longer active changes nothing');
  }
  // A restored project is never written into the per-browser pin: the only
  // pin writer, selectChatProject, is the USER's pick.
  ok(!/writePinnedProject/.test(fnSrc('applyConversationProject')) && !/writePinnedProject/.test(fnSrc('restorePinnedProject')),
    'restoring writes nothing to the pin (the pin stays the user\'s own choice)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  F9 — an answer saved before citedPages: its pages checked on disk at read');
{
  const chat = await import('../src/brain/chat.js');
  mkdirSync(path.join(DOMAINS, 'acme', 'wiki', 'concepts'), { recursive: true });
  writeFileSync(path.join(DOMAINS, 'acme', 'wiki', 'concepts', 'rag.md'), '# RAG\n');
  mkdirSync(path.join(DOMAINS, 'acme', 'wiki', 'foundations'), { recursive: true });
  writeFileSync(path.join(DOMAINS, 'acme', 'wiki', 'foundations', 'architecture.md'), '# not a page folder\n');
  eq(JSON.stringify(chat.citedPagesOnDisk('acme', ['handoff state', 'concepts/rag.md, concepts/ghost.md',
    'CLAUDE.md rows v3.69.0, v3.68.1', 'foundations/architecture.md', '../../etc/passwd.md', 'catalogue'])),
  '["concepts/rag.md"]',
  '★ only an existing file in a PAGE folder is a page — words, a ghost slug, a foundations path and a traversal are not');
  // THROUGH THE REAL ROUTE: the legacy message gains citedPagesNow on the
  // response, and the file on disk is not rewritten.
  const conv = { id: '11111111-2222-4333-8444-555555555555', title: 't', createdAt: new Date().toISOString(),
    messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a [source: concepts/rag.md] [source: catalogue]',
      citations: ['concepts/rag.md', 'catalogue'] }] };
  mkdirSync(path.join(DOMAINS, 'acme', 'conversations'), { recursive: true });
  const convAbs = path.join(DOMAINS, 'acme', 'conversations', conv.id + '.json');
  writeFileSync(convAbs, JSON.stringify(conv, null, 2));
  const before = readFileSync(convAbs, 'utf8');
  const router = (await import('../src/routes/chat.js')).default;
  const layer = router.stack.find((l) => l.route && l.route.path === '/:domain/:id' && l.route.methods.get);
  let body = null;
  await layer.route.stack[0].handle({ params: { domain: 'acme', id: conv.id } },
    { status() { return this; }, json(b) { body = b; return this; } });
  eq(JSON.stringify(body && body.messages && body.messages[1].citedPagesNow), '["concepts/rag.md"]',
    '★ GET /api/chat/:domain/:id annotates a legacy answer with citedPagesNow');
  eq(readFileSync(convAbs, 'utf8'), before, '...and the conversation file is byte-identical — nothing written back');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ v3.76.0 truth assertions FAILED'); process.exit(1); }
console.log('✅ v3.76.0 truth assertions green');
