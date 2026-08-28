#!/usr/bin/env node
/**
 * OFFLINE — end-to-end MCP contract, spoken over real stdio JSON-RPC.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Everything else that touches the MCP tests it IN-PROCESS: a handler is
 * imported and called with a fake storage adapter. That is useful, and it is
 * blind to the two properties that actually decide whether Claude Desktop
 * works, because both are properties of the CHILD PROCESS and its transport,
 * not of any one handler:
 *
 *   1. STDOUT PURITY (§0). The MCP protocol reserves stdout for JSON-RPC
 *      frames. A single `console.log` anywhere on the transitive import graph
 *      — 33 files, 19 under mcp/ and 14 under src/brain/ — poisons the stream.
 *      That is the real v2.5.3 bug: it surfaced in Claude Desktop as
 *      `Unexpected token 's', "[syncSummar"... is not valid JSON`. Until this
 *      suite existed the only coverage was three source regexes over 4 of
 *      those 33 files, and a source regex cannot see `process.stdout.write`,
 *      an aliased `console.log`, or a dependency that prints. MEASURED: adding
 *      `console.log('[files] module loaded')` at module scope in
 *      src/brain/files.js corrupts MCP stdout and leaves `npm test` green.
 *
 *   2. GRAPH SEMANTICS (§4). `mcp/graph.js` had ZERO coverage of any kind — no
 *      suite in any manifest imported it — while CLAUDE.md calls the
 *      graph-native tools "the reason MCP exists". MEASURED: replacing
 *      `extractOutgoingLinks()` with `return []` makes every graph tool report
 *      an empty graph (every page an orphan, 0 edges) and leaves `npm test`
 *      green.
 *
 * WHY OFFLINE, NOT LIVE
 * ─────────────────────
 * 19 of the 20 tools make no LLM call, so this needs no credentials. OFFLINE
 * gates every push AND every fork PR; the LIVE job runs only on push-to-main.
 * Gating the MCP contract on the weaker of the two would be a downgrade.
 * Precedent for an OFFLINE suite that spawns a child: test-mcp-setup-contract,
 * test-paths, test-repair-wiki-args.
 *
 * WHAT THIS SUITE DOES NOT GUARANTEE
 * ──────────────────────────────────
 *  - It does not prove Claude Desktop's own config is correct; that is
 *    test-mcp-setup-contract's job (which now carries an independent stdout
 *    purity assertion, so a refactor of either leaves one standing).
 *  - §0 proves stdout is clean along the code paths THIS SUITE EXERCISES. A
 *    `console.log` on a branch no tool here reaches is still invisible. The
 *    mitigation is coverage breadth: §3 calls every read tool and §8 drives
 *    all four mutating tools, which is what pulls src/brain/files.js,
 *    health.js and raw-store.js onto the executed graph.
 *  - §2 compares the tool NAME SET, not each tool's schema.
 *
 * SAFETY — this suite never touches real user data. It seeds a throwaway
 * fixture under os.tmpdir() and pins the child to it with BOTH
 * CURATOR_TEST_DOMAINS_DIR (which outranks --domains-path for reads AND is the
 * only rung getDomainsDir() honours above config, which is what MCP *writes*
 * resolve through) and CURATOR_TEST_USER_DATA_DIR (credential isolation).
 * Provider and GitHub credentials are stripped from the child env.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp', 'server.js');

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── Fixture wiki ────────────────────────────────────────────────────────────
// Topology is exact and asserted on, so it is written out here rather than
// generated: every §4 count below is derived from this graph by hand.
//
//   alpha (entity)          → beta-concept, summaries/seed-doc,
//                             claude-sonnet-3.5, industry-5.0
//   seed-doc (summary)      → alpha
//   claude-sonnet-3.5 (ent) → report-v2.1          ← DOT SLUG
//   report-v2.1 (summary)   → claude-sonnet-3.5    ← DOT SLUG, raw source on disk
//   industry-5.0 (concept)  → (none)               ← DOT SLUG
//   beta-concept (concept)  → (none)
//   lonely (concept)        → (none), and nothing links to it → the ONE orphan
//
// 7 nodes. Only `lonely` has zero edges in both directions, which is exactly
// the definition get_graph_overview uses.
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-mcp-e2e-'));
const DOMAINS_DIR = path.join(ROOT, 'domains');
const USER_DATA_DIR = path.join(ROOT, 'userdata');
mkdirSync(USER_DATA_DIR, { recursive: true });

const D = 'zz-mcp-e2e';          // the ordinary fixture domain
const MIRROR = 'shared-zz-e2e';  // a read-only Shared Brain mirror (§8)
const BIG = 'zz-mcp-big';        // oversized-response fixture (§7)
const FIX = 'zz-mcp-fix';        // WRITEABLE fixture for §9 — kept separate from
                                 // D so the §4 topology assertions cannot be
                                 // perturbed by a fix that actually applies.

const page = (dir, name, body) =>
  writeFileSync(path.join(DOMAINS_DIR, ...dir, `${name}.md`), body);

for (const dom of [D, MIRROR, BIG, FIX]) {
  for (const f of ['entities', 'concepts', 'summaries']) {
    mkdirSync(path.join(DOMAINS_DIR, dom, 'wiki', f), { recursive: true });
  }
}
mkdirSync(path.join(DOMAINS_DIR, D, 'raw'), { recursive: true });

writeFileSync(path.join(DOMAINS_DIR, D, 'CLAUDE.md'), '# zz-mcp-e2e\n\nThrowaway fixture domain.\n');
writeFileSync(
  path.join(DOMAINS_DIR, D, 'wiki', 'index.md'),
  '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n' +
  '| entities/alpha | entity | Seed entity |\n' +
  '| entities/claude-sonnet-3.5 | entity | Dot slug |\n' +
  '| summaries/report-v2.1 | summary | Dot slug summary |\n',
);
writeFileSync(path.join(DOMAINS_DIR, D, 'wiki', 'log.md'), '## [2026-01-01] fixture seeded\n');

page([D, 'wiki', 'entities'], 'alpha',
  '---\ntype: entity\ntags: [type/entity, topic/testing]\n---\n' +
  '# Alpha\n\n## Related\n- [[beta-concept]]\n- [[summaries/seed-doc]]\n' +
  '- [[claude-sonnet-3.5]]\n- [[industry-5.0]]\n');
page([D, 'wiki', 'concepts'], 'beta-concept',
  '---\ntype: concept\ntags: [type/concept]\n---\n# Beta Concept\n\n## Definition\nA concept.\n');
page([D, 'wiki', 'concepts'], 'lonely',
  '---\ntype: concept\ntags: [type/concept]\n---\n# Lonely\n\n## Definition\nNothing links here.\n');
page([D, 'wiki', 'summaries'], 'seed-doc',
  '---\ntype: summary\nsource: seed-doc.md\ntags: [type/summary]\n---\n' +
  '# Seed Doc\n\n## Entities Mentioned\n- [[alpha]]\n');

// ── The three dot-slug pages, one of each type (the §6 regression) ──────────
page([D, 'wiki', 'entities'], 'claude-sonnet-3.5',
  '---\ntype: entity\ntags: [type/entity, topic/models]\n---\n' +
  '# Claude Sonnet 3.5\n\n## Related\n- [[summaries/report-v2.1]]\n');
page([D, 'wiki', 'concepts'], 'industry-5.0',
  '---\ntype: concept\ntags: [type/concept]\n---\n# Industry 5.0\n\n## Definition\nA concept with a version number.\n');
page([D, 'wiki', 'summaries'], 'report-v2.1',
  '---\ntype: summary\nsource: report-v2.1.txt\ntags: [type/summary]\n---\n' +
  '# Report v2.1\n\n## Entities Mentioned\n- [[claude-sonnet-3.5]]\n');
// …with its raw source actually PRESENT, so get_raw_source is exercised on the
// success path. Per the orchestrator's live measurement, both real dot-slug
// summaries have their source on disk — i.e. get_raw_source was broken for
// 100% of the documents where it could have worked.
const RAW_MARKER = 'CURATOR-E2E-RAW-SOURCE-MARKER';
writeFileSync(path.join(DOMAINS_DIR, D, 'raw', 'report-v2.1.txt'),
  `${RAW_MARKER}\nThe original document behind report-v2.1.\n`);

// ── Read-only Shared Brain mirror (§8) ─────────────────────────────────────
writeFileSync(path.join(DOMAINS_DIR, MIRROR, 'CLAUDE.md'),
  '---\nreadonly: true\n---\n\n# shared-zz-e2e\n\nCollective mirror. Do not write here.\n');
page([MIRROR, 'wiki', 'entities'], 'mirror-page',
  '---\ntype: entity\ntags: [type/entity]\n---\n# Mirror Page\n\n## Related\n- [[alpha]]\n');

// ── Writeable fixture for §9 (fix_wiki_issue refusal signalling) ───────────
// Topology chosen so each §9 case has a natural trigger:
//   home        — a real page, the only legitimate orphanLink target here
//   stray       — nothing links to it ⇒ the orphan
//   caller      — carries `[[nowhere]]` (broken, NO scanner target: normKey
//                 finds no match) and `[[dr-tali-rezun]]` TWICE (broken WITH a
//                 scanner target, because `tali-rezun` exists and normalises
//                 to the same key). The doubled link is the §9d probe.
//   tali-rezun  — the canonical page the doubled link normalises onto.
writeFileSync(path.join(DOMAINS_DIR, FIX, 'CLAUDE.md'), '# zz-mcp-fix\n\nWriteable fixture.\n');
writeFileSync(path.join(DOMAINS_DIR, FIX, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n');
writeFileSync(path.join(DOMAINS_DIR, FIX, 'wiki', 'log.md'), '## [2026-01-01] fixture seeded\n');
page([FIX, 'wiki', 'concepts'], 'home',
  '---\ntype: concept\ntags: [type/concept]\n---\n# Home\n\n## Definition\nA real page.\n\n## Related\n- [[caller]]\n');
page([FIX, 'wiki', 'concepts'], 'stray',
  '---\ntype: concept\ntags: [type/concept]\n---\n# Stray\n\n## Definition\nNothing links here.\n');
page([FIX, 'wiki', 'entities'], 'tali-rezun',
  '---\ntype: entity\ntags: [type/entity]\n---\n# Tali Rezun\n\n## Related\n- [[home]]\n');
page([FIX, 'wiki', 'concepts'], 'caller',
  '---\ntype: concept\ntags: [type/concept]\n---\n# Caller\n\n## Related\n' +
  '- [[nowhere]] — broken, and no deterministic match exists\n' +
  '- [[dr-tali-rezun]] — broken, scanner CAN normalise this one\n' +
  '- [[dr-tali-rezun]] — the SAME link a second time (see §9d)\n');

// ── Oversized-response fixture (§7) ────────────────────────────────────────
// 40 pages × ~20 KB of body ⇒ ~800 KB once get_graph_overview enumerates with
// include_body, which is comfortably over the 400 KB cap and forces the
// progressive-trim loop on the `nodes` array.
writeFileSync(path.join(DOMAINS_DIR, BIG, 'CLAUDE.md'), '# zz-mcp-big\n\nOversized fixture.\n');
const FILLER = 'lorem ipsum dolor sit amet '.repeat(760); // ~20 KB
for (let i = 0; i < 40; i++) {
  page([BIG, 'wiki', 'concepts'], `bulk-${i}`,
    `---\ntype: concept\ntags: [type/concept]\n---\n# Bulk ${i}\n\n## Body\n${FILLER}\n`);
}

// ── stdio JSON-RPC client ──────────────────────────────────────────────────
const env = { ...process.env };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) {
  delete env[k];
}
// Reads resolve through mcp/storage/local.js (rung 1 = CURATOR_TEST_DOMAINS_DIR).
// MCP *writes* do NOT go through that adapter — they resolve via
// src/brain/config.js's getDomainsDir(), whose only override above config is
// the same env var. Setting it pins BOTH onto the fixture; --domains-path is
// passed as well so the CLI-arg rung is exercised rather than bypassed.
env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;

const t0 = Date.now();
const child = spawn(process.execPath, [MCP_SERVER, '--domains-path', DOMAINS_DIR], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
});
const CHILD_PID = child.pid;

let stdoutBuf = '';
let stderrText = '';
const rawStdoutLines = [];   // every non-empty stdout line, VERBATIM, pre-parse
const pending = new Map();

child.stderr.on('data', (d) => { stderrText += d; });
child.stdout.on('data', (d) => {
  stdoutBuf += d;
  let i;
  while ((i = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line.trim()) continue;
    // Recorded BEFORE any parse attempt. test-mcp-setup-contract's reader used
    // to be `try { frames.push(JSON.parse(line)); } catch {}` — which silently
    // DISCARDS exactly the evidence §0 exists to find.
    rawStdoutLines.push(line);
    let frame = null;
    try { frame = JSON.parse(line); } catch { /* §0 reports it */ }
    if (frame && pending.has(frame.id)) {
      pending.get(frame.id)(frame);
      pending.delete(frame.id);
    }
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
/** The tool payload as a string, exactly as the model would receive it. */
const rawText = (f) => f?.result?.content?.[0]?.text ?? '';
/** …and parsed, when the tool returns JSON. */
const asJson = (f) => { try { return JSON.parse(rawText(f)); } catch { return rawText(f); } };

// ─────────────────────────────────────────────────────────────────────────────
section('§1  HANDSHAKE — the child speaks MCP');
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'curator-e2e', version: '1' },
});
ok(!!init?.result?.serverInfo, 'initialize returns serverInfo');
ok(init?.result?.serverInfo?.name === 'my-curator',
  `serverInfo.name === "my-curator" (got ${JSON.stringify(init?.result?.serverInfo?.name)})`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// ─────────────────────────────────────────────────────────────────────────────
section('§2  tools/list IS the real registry (name SET, not a count)');
const { tools: registry } = await import(path.join(REPO_ROOT, 'mcp/tools/index.js'));
const listed = await rpc('tools/list');
const wireNames = (listed?.result?.tools || []).map((t) => t.name).sort();
const srcNames = registry.map((t) => t.definition.name).sort();
ok(wireNames.length > 0, `tools/list returned tools (${wireNames.length})`);
ok(JSON.stringify(wireNames) === JSON.stringify(srcNames),
  'tools/list NAME SET === the `tools` array in mcp/tools/index.js (catches add/remove/rename; a count would not)');
// The count is a separate, weaker check kept only because CLAUDE.md and the
// /next wizard both quote a number at users; if it moves, those must move too.
ok(srcNames.length === 20,
  `registry holds 20 tools (got ${srcNames.length}) — if this moves, CLAUDE.md and the /next MCP wizard copy must move with it`);

// ─────────────────────────────────────────────────────────────────────────────
section('§3  Every read tool answers over the wire');
const READ_CALLS = {
  list_domains:        {},
  get_index:           { domain: D },
  get_graph_overview:  { domain: D },
  get_tags:            { domain: D },
  search_wiki:         { domain: D, query: 'alpha' },
  search_cross_domain: { query: 'alpha' },
  get_node:            { domain: D, slug: 'alpha' },
  get_connected_nodes: { domain: D, slug: 'alpha' },
  get_backlinks:       { domain: D, slug: 'beta-concept' },
  get_summary:         { domain: D, slug: 'seed-doc' },
  get_raw_source:      { domain: D, slug: 'seed-doc' },
};
const R = {};
for (const [name, args] of Object.entries(READ_CALLS)) {
  const f = await callTool(name, args);
  R[name] = f;
  ok(!!f?.result && !f.__timeout && !f.error, `${name} returned a result (not an error, not a timeout)`);
}
ok(rawText(R.list_domains).includes(D), `list_domains sees the fixture domain "${D}"`);

// ─────────────────────────────────────────────────────────────────────────────
section('§4  GRAPH SEMANTICS — mcp/graph.js is load-bearing and was uncovered');
const node = asJson(R.get_node);
ok(node?.slug === 'alpha', 'get_node: slug resolved');
ok(node?.type === 'entity', `get_node: frontmatter \`type\` parsed (got ${JSON.stringify(node?.type)})`);
ok(Array.isArray(node?.tags) && node.tags.includes('topic/testing'),
  'get_node: frontmatter `tags` parsed (parseFrontmatter)');
ok(JSON.stringify(node?.outgoing_links || []).includes('beta-concept'),
  'get_node: a forward [[wikilink]] edge was extracted (extractOutgoingLinks)');
ok((node?.outgoing_links || []).some((l) => l.section === 'Related'),
  'get_node: the edge carries the ## section it appeared under');

const back = asJson(R.get_backlinks);
ok(JSON.stringify(back).includes('alpha'),
  'get_backlinks(beta-concept) finds alpha — the REVERSE edge is computed, not just stored');

const ov = asJson(R.get_graph_overview);
ok(ov?.node_count === 7, `get_graph_overview: node_count === 7 (got ${ov?.node_count}) — index.md and log.md excluded`);
ok(ov?.edge_count >= 5, `get_graph_overview: edge_count >= 5 (got ${ov?.edge_count})`);
ok(ov?.orphans?.count === 1 && ov?.orphans?.sample?.[0] === 'lonely',
  `get_graph_overview: EXACTLY the unlinked page is an orphan (got ${JSON.stringify(ov?.orphans)})`);
ok(JSON.stringify(asJson(R.get_connected_nodes)).includes('beta-concept'),
  'get_connected_nodes traverses an edge out of alpha');
ok(JSON.stringify(asJson(R.get_tags)).includes('topic/testing'),
  'get_tags inventories a real frontmatter tag');

// ─────────────────────────────────────────────────────────────────────────────
section('§5  Path containment still refuses, and leaks nothing');
const TRAVERSAL = [
  ['domain ../../etc',       'get_node',       { domain: '../../etc', slug: 'passwd' }],
  ['slug ../../../../etc',   'get_node',       { domain: D, slug: '../../../../etc/passwd' }],
  ['slug ..',                'get_node',       { domain: D, slug: '..' }],
  ['slug a/../../b',         'get_node',       { domain: D, slug: 'a/../../b' }],
  ['absolute slug',          'get_node',       { domain: D, slug: '/etc/passwd' }],
  ['dotfile slug',           'get_node',       { domain: D, slug: '.curator-config.json' }],
  ['summary traversal',      'get_summary',    { domain: D, slug: '../../../../etc/passwd' }],
  ['raw-source traversal',   'get_raw_source', { domain: D, slug: '../../../../etc/passwd' }],
  ['raw-source path escape', 'get_raw_source', { domain: D, slug: 'summaries/../../../../etc/passwd' }],
  ['percent-encoded ..',     'get_node',       { domain: D, slug: '%2e%2e%2f%2e%2e%2fetc%2fpasswd' }],
  ['unicode dot look-alike', 'get_node',       { domain: D, slug: 'a․․/b' }],
];
for (const [label, tool, args] of TRAVERSAL) {
  const f = await callTool(tool, args);
  const text = rawText(f);
  const leaked = /root:x:|\/bin\/(ba)?sh\b|geminiApiKey|anthropicApiKey|github_pat|BEGIN [A-Z ]*PRIVATE KEY/.test(text);
  ok(!!f?.result && !leaked, `${tool} refuses ${label} with no content leak`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('§6  DOT-SLUG REGRESSION — 77 real pages were discoverable but unreadable');
// Before v3.9.1 `isValidSlug` refused every dot, so `search_wiki`/`get_index`
// advertised slugs that every slug-taking sibling then rejected. This section
// goes RED on the shipping mcp/util.js.
const dotSearch = await callTool('search_wiki', { domain: D, query: 'claude sonnet' });
ok(rawText(dotSearch).includes('claude-sonnet-3.5'),
  'search_wiki ADVERTISES the dot slug (this half always worked — it is the contradiction)');

const dotNode = await callTool('get_node', { domain: D, slug: 'claude-sonnet-3.5' });
const dotNodeJson = asJson(dotNode);
ok(dotNodeJson?.slug === 'claude-sonnet-3.5',
  `get_node reads an ENTITY with a dot slug (got ${JSON.stringify(rawText(dotNode)).slice(0, 120)})`);

const dotConcept = await callTool('get_node', { domain: D, slug: 'industry-5.0' });
ok(asJson(dotConcept)?.slug === 'industry-5.0',
  `get_node reads a CONCEPT with a dot slug (got ${JSON.stringify(rawText(dotConcept)).slice(0, 120)})`);

const dotBack = await callTool('get_backlinks', { domain: D, slug: 'claude-sonnet-3.5' });
ok(rawText(dotBack).includes('alpha') && rawText(dotBack).includes('report-v2.1'),
  'get_backlinks resolves a dot slug and returns both inbound edges');

const dotConn = await callTool('get_connected_nodes', { domain: D, slug: 'claude-sonnet-3.5' });
ok(rawText(dotConn).includes('report-v2.1'),
  'get_connected_nodes traverses out of a dot slug');

const dotSummary = await callTool('get_summary', { domain: D, slug: 'report-v2.1' });
ok(rawText(dotSummary).includes('Report v2.1') && !/^Invalid slug/.test(rawText(dotSummary)),
  `get_summary reads a SUMMARY with a dot slug (got ${JSON.stringify(rawText(dotSummary)).slice(0, 120)})`);

// The sharpest case: get_raw_source. Both real dot-slug summaries have their
// source on disk, so the feature was broken for 100% of the documents where it
// could actually have worked — and its refusal told the caller to "pass a slug
// from get_index", which is precisely where the slug came from.
const dotRaw = await callTool('get_raw_source', { domain: D, slug: 'report-v2.1' });
const dotRawJson = asJson(dotRaw);
ok(dotRawJson?.ok === true && dotRawJson?.found === true,
  `get_raw_source SUCCEEDS on a dot slug (got ${JSON.stringify(rawText(dotRaw)).slice(0, 160)})`);
ok(rawText(dotRaw).includes(RAW_MARKER),
  'get_raw_source returns the real original document text, not just metadata');
// And the path-shaped input form documented in its own schema.
const dotRawPath = await callTool('get_raw_source', { domain: D, slug: 'summaries/report-v2.1.md' });
ok(asJson(dotRawPath)?.found === true,
  'get_raw_source accepts the documented "summaries/<slug>.md" form of a dot slug');

// Widening must not have widened DOMAINS. `isValidDomain` was an alias of
// `isValidSlug`; it is now a deliberate split (see mcp/util.js).
const util = await import(path.join(REPO_ROOT, 'mcp/util.js'));
ok(util.isValidSlug('claude-sonnet-3.5') === true, 'isValidSlug permits an interior dot');
ok(util.isValidDomain('a.b') === false,
  'isValidDomain REFUSES a dot — domains are the outer path segment and the app cannot produce one');
ok(util.isValidSlug('..') === false && util.isValidSlug('a..b') === false,
  'isValidSlug refuses `..` anywhere');
ok(util.isValidSlug('.hidden') === false && util.isValidSlug('trailing.') === false,
  'isValidSlug refuses a leading dot (dotfiles) and a trailing dot (Windows strips it)');
ok(util.isValidSlug('a/b') === false && util.isValidSlug('a\\b') === false && util.isValidSlug('a\0b') === false,
  'isValidSlug refuses path separators and NUL');
ok(util.isValidSlug('abc\n') === false,
  'isValidSlug refuses a trailing newline (JS `$` has no Python-style newline quirk — asserted, not assumed)');
ok(util.isValidSlug('ſoo') === false && util.isValidSlug('Kelvin') === false,
  'isValidSlug refuses U+017F / U+212A — /[a-z]/i without the `u` flag does not case-fold them to ASCII');

// ─────────────────────────────────────────────────────────────────────────────
section('§7  RESPONSE BUDGET — the v2.3.1 context-blowout fix, behaviourally');
const CAP = 400 * 1024;
// Source-level cross-check first (MAX_RESPONSE_BYTES is a module-private const,
// so it cannot be imported). This is the weak half; the behavioural bracket
// below is what actually holds the guarantee.
const indexSrc = readFileSync(path.join(REPO_ROOT, 'mcp/tools/index.js'), 'utf8');
ok(/const\s+MAX_RESPONSE_BYTES\s*=\s*400\s*\*\s*1024\s*;/.test(indexSrc),
  'mcp/tools/index.js still declares MAX_RESPONSE_BYTES = 400 * 1024 (~100k tokens)');

// A response that is genuinely oversized must come back TRIMMED and under cap.
const bigOv = await callTool('get_graph_overview', { domain: BIG, include_nodes: true, include_body: true });
const bigText = rawText(bigOv);
const bigBytes = Buffer.byteLength(bigText, 'utf8');
ok(bigBytes <= CAP, `an ~800 KB response is capped at or below 400 KB (got ${bigBytes} bytes)`);
ok(bigBytes > CAP / 4,
  `…and is trimmed NEAR the cap, not far under it (got ${bigBytes}) — brackets the constant from below, so lowering it 10x goes RED`);
const bigJson = asJson(bigOv);
ok(typeof bigJson?._truncated === 'string' && /nodes:\s*40\s*→/.test(bigJson._truncated),
  `the progressive-trim loop ran and said so (_truncated: ${JSON.stringify(bigJson?._truncated || null).slice(0, 140)})`);
ok(Array.isArray(bigJson?.nodes) && bigJson.nodes.length < 40,
  `the heavy array really was halved (nodes: ${bigJson?.nodes?.length} of 40)`);
// …and a comfortably-sized response must NOT be trimmed. Together these two
// bracket MAX_RESPONSE_BYTES: raise it 1000x and the first goes RED, lower it
// and this one does.
const smallOv = await callTool('get_graph_overview', { domain: D, include_nodes: true, include_body: true });
ok(!asJson(smallOv)?._truncated,
  'a small domain enumerated with bodies is NOT trimmed (the guard is a cap, not a blanket)');

// ─────────────────────────────────────────────────────────────────────────────
section('§8  READ-ONLY MIRROR — all five mutating tools refuse, over the wire');
// test-sharedbrain-mcp-guard.js covers refuseIfReadonly IN-PROCESS. This
// exercises the same contract through the transport, which is also what pulls
// src/brain/files.js and health.js onto the executed import graph — so §0's
// stdout guarantee covers them too.
const MUTATORS = [
  // `summary_content`, not `summary_markdown` — this arg was wrong until the
  // §9 field-by-field audit, and the suite stayed green because the read-only
  // refusal fires BEFORE any argument validation. A test that passes an
  // invalid payload proves less than it appears to.
  ['compile_to_wiki',      { domain: MIRROR, title: 'E2E', summary_content: '# E2E\n\nBody.\n' }],
  ['fix_wiki_issue',       { domain: MIRROR, type: 'folderPrefixLinks', issue: { file: 'entities/mirror-page.md', link: 'alpha' } }],
  ['dismiss_wiki_issue',   { domain: MIRROR, type: 'orphans', issue: { slug: 'mirror-page' } }],
  ['undismiss_wiki_issue', { domain: MIRROR, type: 'orphans', issue: { slug: 'mirror-page' } }],
  // v3.17.0's mutator. Added because this array was the ONLY place the
  // over-the-wire mirror refusal is exercised, and a new mutating tool that
  // is simply absent from a hand-listed array is the guard-goes-blind shape
  // this repo keeps re-hitting — the count says four, the truth is five, and
  // nothing goes red. `headline` is required by the tool, but the readonly
  // refusal fires BEFORE argument validation, which is exactly why the
  // comment above about `summary_content` matters: supply a VALID payload so
  // this proves the refusal, not an argument error wearing its clothes.
  ['save_working_state',   { project: MIRROR, scope: 'e2e', headline: 'E2E probe' }],
];
// NOT ENFORCED HERE, measured rather than assumed: this loop proves the tool
// REFUSES, not WHICH layer refused. Removing mcp/tools/working-state.js's
// refuseIfReadonly entirely (0 call sites) leaves every assertion below GREEN,
// because src/brain/working-state.js refuses mirrors too and its message also
// matches /read-only Shared Brain mirror/ — only the wording differs
// ("Domain 'x' is..." from the MCP layer vs '"x" is...' from the store).
// The MCP-layer guard is pinned by WHICH guard answered in
// scripts/test-mcp-working-state.js; do not read this section as covering it.
for (const [name, args] of MUTATORS) {
  const f = await callTool(name, args);
  const text = rawText(f);
  ok(/read-only Shared Brain mirror/i.test(text),
    `${name} refuses the mirror with the steer message (got ${JSON.stringify(text).slice(0, 110)})`);
}
// The refusal must be a refusal, not a silent no-op that also wrote something.
const mirrorFiles = await import('node:fs').then((fs) =>
  fs.readdirSync(path.join(DOMAINS_DIR, MIRROR, 'wiki', 'summaries')));
ok(mirrorFiles.length === 0,
  `no page was written into the mirror despite four write attempts (summaries/: ${JSON.stringify(mirrorFiles)})`);
// A read tool on the same mirror must still WORK — the guard is scoped to
// writes, and a mirror the user cannot read would be a different bug.
const mirrorRead = await callTool('get_node', { domain: MIRROR, slug: 'mirror-page' });
ok(asJson(mirrorRead)?.slug === 'mirror-page',
  'a READ tool still serves the mirror (the guard is on writes only)');

// ─────────────────────────────────────────────────────────────────────────────
section('§9  MODEL-READ SURFACES — strings that change what Claude DOES');
// Three defects lived here, and they share one shape: the tool did the right
// thing and TOLD the model something else. That is worse than a plain bug —
// v3.6.1's `fix_wiki_issue` example passed a field that does not exist, so
// every fix in the documented loop was silently rejected and nothing surfaced
// it. These assertions drive the real tools over the wire wherever they can.

// ── §9a  The slug refusal must not contradict the validator it describes ────
const badSlug = rawText(await callTool('get_node', { domain: D, slug: 'a..b' }));
ok(/^Invalid slug/.test(badSlug), 'get_node still refuses a `..` slug');
ok(!/lowercase alphanumerics, hyphens, or underscores/.test(badSlug),
  'the refusal no longer states the pre-v3.9.1 rule — that sentence is wrong on TWO counts (the regex carries /i, and interior dots are now legal), and it is the release note\'s own quoted symptom');
ok(/dot/i.test(badSlug),
  'the refusal mentions dots, so a model cannot conclude the dot was what it got wrong');
ok(/get_index|search_wiki/.test(badSlug) && /not\s+"?page not found"?|SHAPE/i.test(badSlug),
  'it names the recovery (get_index / search_wiki) and distinguishes SHAPE from not-found, instead of leaving retry-with-a-guess as the obvious next move');
// The message must stay TRUE of the validator, not merely different from the
// old one. Every shape it calls legal must be legal, and vice versa.
ok(util.isValidSlug('claude-sonnet-3.5') === true && util.isValidSlug('a..b') === false
   && util.isValidSlug('foo bar') === false && util.isValidSlug('.x') === false
   && util.isValidSlug('x.') === false,
  'every claim the new refusal makes is true of isValidSlug (dots legal; "..", spaces, leading/trailing dot refused)');

// ── §9b  fixed:0 must distinguish "refused" from "already resolved" ─────────
const invented = await callTool('fix_wiki_issue', {
  domain: FIX, type: 'brokenLinks',
  issue: { sourceFile: 'concepts/caller.md', linkText: 'nowhere', suggestedTarget: 'a-page-that-does-not-exist' },
});
const inventedJson = asJson(invented);
ok(inventedJson?.fixed === 0, 'an invented suggestedTarget still writes nothing (the v3.9.1 existence check holds)');
ok(inventedJson?.reason === 'target-not-found',
  `…and now SAYS why, machine-readably (reason: ${JSON.stringify(inventedJson?.reason)})`);
ok(!/may already have been resolved/.test(inventedJson?.report || ''),
  'the refusal is NOT reported as "the issue may already have been resolved" — a model reads that as "the wiki is fine" and moves on with the link still broken');
ok(/get_index|search_wiki/.test(inventedJson?.report || '') && /still there/i.test(inventedJson?.report || ''),
  'the refusal tells the model what to do next AND that the issue is still outstanding');

// The genuine no-op must still read as a no-op, or the fix would have traded
// one wrong signal for another.
const genuineNoop = await callTool('fix_wiki_issue', {
  domain: FIX, type: 'brokenLinks',
  issue: { sourceFile: 'concepts/caller.md', linkText: 'not-in-this-file-at-all', suggestedTarget: 'home' },
});
const noopJson = asJson(genuineNoop);
ok(noopJson?.fixed === 0 && noopJson?.reason === 'link-not-present',
  `a real no-op reports link-not-present (got ${JSON.stringify(noopJson?.reason)})`);
ok(/already resolved/.test(noopJson?.report || ''),
  '…and IS allowed to say "already resolved", because here that is true');
ok(inventedJson?.report !== noopJson?.report,
  'THE POINT: the two reports are no longer byte-identical — before this change a refusal and a no-op were indistinguishable to the model');

// ── §9c  The skill files must document the REAL fix_wiki_issue enum ─────────
// Behavioural half: every type the code accepts really is accepted over the
// wire (a bad `type` is rejected before any handler runs, so this exercises
// FIXABLE_TYPES itself).
const health = await import(path.join(REPO_ROOT, 'src/brain/health.js'));
const codeFixable = [...health.AUTO_FIXABLE].sort();
for (const t of codeFixable) {
  const probe = asJson(await callTool('fix_wiki_issue', { domain: FIX, type: t, issue: { __probe: true }, preview: true }));
  const err = String(probe?.error || '');
  ok(!/cannot be fixed via this tool/.test(err),
    `fix_wiki_issue accepts type="${t}" (it is in AUTO_FIXABLE, so the skill may document it)`);
}
// …and a scan CATEGORY that is not a fixable type is rejected, which is
// precisely what the skill used to send.
const orphansAsType = asJson(await callTool('fix_wiki_issue', {
  domain: FIX, type: 'orphans', issue: { path: 'concepts/stray.md', type: 'concept', slug: 'stray' } }));
ok(orphansAsType?.ok === false && /cannot be fixed via this tool/.test(String(orphansAsType?.error || '')),
  'type="orphans" is REJECTED — it is a scan category and a dismissal type, never a fixable type');

// SOURCE SCAN (labelled). The skill files are markdown; there is no way to
// execute them, so the enum they print is compared to the code's.
// NOT ENFORCED by this assertion: that the surrounding prose is *correct*, only
// that the enum list and its count word match AUTO_FIXABLE. A skill that names
// the right seven types in a misleading sentence still passes here.
const skillMd = readFileSync(path.join(REPO_ROOT, 'claude-skills/my-curator/SKILL.md'), 'utf8');
const examplesMd = readFileSync(path.join(REPO_ROOT, 'claude-skills/my-curator/examples.md'), 'utf8');
const NUMBER_WORDS = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const enumSentence = skillMd.match(/takes exactly (\w+) types — (.+?) — and passing/);
ok(!!enumSentence, 'SKILL.md states the fix_wiki_issue enum explicitly (source scan)');
if (enumSentence) {
  const listed = [...enumSentence[2].matchAll(/`([A-Za-z]+)`/g)].map(m => m[1]).sort();
  ok(JSON.stringify(listed) === JSON.stringify(codeFixable),
    `SKILL.md's enum EQUALS AUTO_FIXABLE (source scan). skill=${JSON.stringify(listed)} code=${JSON.stringify(codeFixable)}`);
  ok(NUMBER_WORDS[enumSentence[1]] === codeFixable.length,
    `…and its count word matches (${enumSentence[1]} vs ${codeFixable.length}) — a tool count in prose has been wrong twice in this repo`);
}
// The specific string whose absence WAS the defect: `orphanLink` appeared zero
// times in either skill file while `orphans` was documented in its place.
ok(/\borphanLink\b/.test(skillMd), 'SKILL.md names the real orphan fix type `orphanLink` (it appeared 0 times before)');
ok(/\borphanLink\b/.test(examplesMd), 'examples.md names `orphanLink` too — its 47-orphan walkthrough is where the wrong type led');
// …and the argument shape, which is the second half of the defect: the right
// type with the scanner's object still fixes nothing.
for (const [name, md] of [['SKILL.md', skillMd], ['examples.md', examplesMd]]) {
  ok(/orphanSlug/.test(md) && /targetSlug/.test(md),
    `${name} documents the {orphanSlug, targetSlug} shape fixOrphanLink actually requires (source scan) — the scanner emits {path, type, slug}, so "pass it through unchanged" cannot work here`);
}

// Behavioural proof that the newly-documented shape is the one that works, and
// the previously-documented one is not.
const orphanScanShape = asJson(await callTool('fix_wiki_issue', {
  domain: FIX, type: 'orphanLink', issue: { path: 'concepts/stray.md', type: 'concept', slug: 'stray' } }));
ok(orphanScanShape?.fixed === 0 && orphanScanShape?.reason === 'orphan-fields-missing',
  `forwarding the SCAN shape to orphanLink is refused and says so (reason: ${JSON.stringify(orphanScanShape?.reason)})`);
ok(/orphanSlug/.test(orphanScanShape?.report || '') && !/may already have been resolved/.test(orphanScanShape?.report || ''),
  '…and the refusal teaches the correct shape rather than implying the orphan was handled — this is the case that silently reported a clean sweep over 47 untouched orphans');
const orphanRealShape = asJson(await callTool('fix_wiki_issue', {
  domain: FIX, type: 'orphanLink',
  issue: { orphanSlug: 'stray', targetSlug: 'home', description: 'a rescued orphan' } }));
ok(orphanRealShape?.fixed === 1,
  `the shape the skill now documents DOES apply (fixed: ${orphanRealShape?.fixed})`);
ok(readFileSync(path.join(DOMAINS_DIR, FIX, 'wiki', 'concepts', 'home.md'), 'utf8').includes('[[stray]]'),
  '…verified on disk: the orphan is now linked from the target page');

// ── §9d  fixed:0 must not become fixed:N in the fix-all loop ───────────────
// `fixBrokenLink` returns an OBJECT now, and `{ok: false}` is truthy. A bare
// `if (raw)` in the fix-all loop would count every refusal as a fix. The probe
// is natural rather than forged: `caller` carries the SAME broken link twice,
// the scanner emits one issue per occurrence, and the first fix's global regex
// rewrites both — so the second issue legitimately reports link-not-present.
//
// This is the ONE part of §9 that cannot go over the wire: `fix_wiki_issue`
// requires an `issue`, so the fix-all branch of fixIssue() is unreachable from
// MCP (it belongs to the app's /fix-all route). It is covered here anyway
// because THIS change is what put an object on that code path.
//
// Running it in-process means the PARENT resolves the domains dir, and the
// parent is not the child — it has no CURATOR_TEST_DOMAINS_DIR, so without an
// override `wikiPath(FIX)` resolves against the developer's REAL
// .curator-config.json. `__setDomainsDirOverride` is the documented in-process
// seam for exactly this and outranks every other rung; the assertion below
// then PROVES the redirection took effect before anything is written, rather
// than trusting it.
const cfg = await import(path.join(REPO_ROOT, 'src/brain/config.js'));
cfg.__setDomainsDirOverride(DOMAINS_DIR);
ok(cfg.getDomainsDir() === path.resolve(DOMAINS_DIR),
  'in-process domains dir is pinned to the tempdir BEFORE any local write (a failure here means the next lines would touch real user data)');
const fixAll = await import(path.join(REPO_ROOT, 'src/brain/health.js'));
const beforeScan = await fixAll.scanWiki(FIX);
const dupIssues = beforeScan.brokenLinks.filter(b => b.linkText === 'dr-tali-rezun');
ok(dupIssues.length === 2 && dupIssues.every(b => b.suggestedTarget),
  `the scanner emits ONE issue PER OCCURRENCE, both with a target (got ${dupIssues.length}) — this is what makes the over-count reachable`);
const allRes = await fixAll.fixIssue(FIX, 'brokenLinks', null);
ok(allRes.total === 2 && allRes.fixed === 1,
  `fix-all counts ONE write for two issues over one doubled link (fixed=${allRes.fixed} total=${allRes.total}) — a truthiness read of the new object return would report ${allRes.total}, a clean sweep over work not done`);
const callerAfter = readFileSync(path.join(DOMAINS_DIR, FIX, 'wiki', 'concepts', 'caller.md'), 'utf8');
ok(!callerAfter.includes('[[dr-tali-rezun]]') && (callerAfter.match(/\[\[tali-rezun\]\]/g) || []).length === 2,
  '…and on disk BOTH occurrences really were retargeted by that single write (so `fixed: 1` is the honest number, not an undercount)');
ok(callerAfter.includes('[[nowhere]]'),
  'the broken link with no scanner target is untouched by fix-all — it is review-only, exactly as the skill says');
// Release the override so nothing after this point can resolve to the fixture.
cfg.__setDomainsDirOverride(null);

// ─────────────────────────────────────────────────────────────────────────────
// §0 is asserted LAST, on purpose: it must cover every byte the child emitted
// across every section above, not just the handshake.
child.stdin.end();
child.kill();
await new Promise((r) => setTimeout(r, 200));

section('§0  STDOUT PURITY — the v2.5.3 gate (stdout is JSON-RPC, nothing else)');
const poison = rawStdoutLines.filter((l) => {
  try { JSON.parse(l); return false; } catch { return true; }
});
ok(rawStdoutLines.length > 0,
  `the child actually spoke on stdout across all sections (${rawStdoutLines.length} lines — an empty stream would make this section vacuous)`);
ok(poison.length === 0,
  poison.length === 0
    ? `all ${rawStdoutLines.length} stdout lines parse as JSON-RPC`
    : `NON-JSON ON STDOUT — this is the v2.5.3 bug: the MCP protocol reserves stdout for JSON-RPC frames, so a stray console.log anywhere on the 33-file import graph reaches Claude Desktop as "Unexpected token ... is not valid JSON" and kills the session. ${poison.length} offending line(s); first: ${JSON.stringify(poison[0].slice(0, 160))}. Diagnostics belong on stderr (console.error).`);
ok(Buffer.byteLength(stderrText, 'utf8') === 0,
  Buffer.byteLength(stderrText, 'utf8') === 0
    ? 'stderr is empty too (CLAUDE.md\'s "0 stderr bytes" claim, now gated)'
    : `stderr carried ${Buffer.byteLength(stderrText, 'utf8')} bytes: ${JSON.stringify(stderrText.slice(0, 200))}`);

// ── Cleanup ────────────────────────────────────────────────────────────────
try { if (CHILD_PID && !child.killed) process.kill(CHILD_PID, 'SIGKILL'); } catch { /* already gone */ }
rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`Passed: ${passed}   Failed: ${failed}   (${Date.now() - t0}ms)`);
process.exit(failed ? 1 : 0);
