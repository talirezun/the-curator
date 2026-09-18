/**
 * Exercise EVERY MCP tool once, against a throwaway copy (v3.61.0).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * v3.60.0 put a map of all 24 tools on the MCP bridge page and a content-free
 * usage log behind it. Two gaps shipped with it, both recorded in that
 * release's own KNOWN AND UNFIXED:
 *
 *   1. The map was driven by FIXTURES and a STUB route, never by the real route
 *      end to end. So the one surface that observes the bridge had never been
 *      shown a row the bridge itself produced.
 *   2. A user has no way to make every tile carry a real reading. Twenty-four
 *      dashed rings is not an observation, and waiting for an agent to happen
 *      to call `get_backlinks` is not a plan.
 *
 * This module answers both with ONE driver, used by two callers that must not
 * be allowed to disagree:
 *
 *   - `scripts/test-mcp-all-tools.js`, which drives it offline into an
 *     ISOLATED usage log and pins that every catalogue tool answered; and
 *   - `POST /api/mcp/exercise`, the app's "Test all N tools" button, which
 *     drives the SAME code into the REAL log with `via: 'self-test'` so the
 *     map lights up with readings that are honestly marked as the user's own
 *     test rather than as agent use.
 *
 * A second implementation for the button would be the v3.6.1 shape exactly:
 * the self-test route used to construct its own launch line, drifted from the
 * one the wizard prescribes, and gave a green pass against a folder the user
 * was not configured for. Hence one driver, and hence the launch line below is
 * `buildCuratorEntry`'s and nothing else.
 *
 * ── WHY `buildCuratorEntry` ARRIVES BY DYNAMIC IMPORT ───────────────────────
 *
 * It lives in `src/routes/mcp.js`, which imports THIS module to register the
 * route. A static import here would be a cycle. An injected `buildEntry`
 * parameter would be worse than a cycle: it is a seam through which a second
 * launch line can be supplied, which is the thing this file exists not to
 * have. So the import is dynamic, taken once per run, inside the function —
 * the same call `test-tray-summary.js` forced on the tray's `child_process`
 * import for a different reason.
 *
 * ── ZERO PAID CALLS, AND HOW THAT IS PROVED RATHER THAN CLAIMED ────────────
 *
 * Every one of the 24 tools is driven on an arm that makes no LLM and no
 * network request. The only tool with a paid arm at all is
 * `scan_semantic_duplicates`, and it is driven through its `estimate_only`
 * arm, which reads the wiki and prices the scan locally. The suite does not
 * take that on trust: it runs the whole driver with a network SPY preloaded
 * into the child (`--import`, patching fetch/http/https/net) and requires zero
 * attempts — once with provider credentials stripped, and once with a
 * fake-shaped key seeded in an isolated config, because "no key was present"
 * is not the same proposition as "no call was made".
 *
 * ── SAFETY: WHAT THE RUN TOUCHES ───────────────────────────────────────────
 *
 * The fixture domain is written under an OS temp dir and removed in `finally`.
 * The child is pinned to it by BOTH `--domains-path` (rung 2 of
 * `mcp/storage/local.js`, which serves READS) and `CURATOR_TEST_DOMAINS_DIR`
 * (the only rung of `src/brain/config.js`'s `getDomainsDir()` above
 * `.curator-config.json`, and MCP WRITES resolve through that one). The env
 * var carries `TEST` in its name and this is shipping code: that is stated
 * rather than hidden, because it is the only correct pin — `DOMAINS_PATH`
 * LOSES to a configured `domainsPath`, so on the ordinary configured install
 * the child would write into the user's real wiki. A run is a test; the
 * variable says so.
 *
 * TWO WRITES LAND OUTSIDE THE FIXTURE in the app's run, and only there:
 *
 *   - the usage log itself, which is the entire point; and
 *   - `<user-data>/.curator-install-id` and `.curator-machine-id`, minted by
 *     `save_working_state` if they do not exist yet. Idempotent, four bytes
 *     each, and byte-for-byte what the user's first real handoff would have
 *     created. Named here so nobody has to discover it.
 *
 * Provider and GitHub credentials are stripped from the child environment in
 * every run, app included.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VIA_SELF_TEST, VIA_ENV_VAR } from './mcp-usage.js';
import { TOOL_CATALOGUE } from '../../mcp/tools/catalogue.js';

/** The whole run's wall clock. The route's own budget is 60 s; this sits under it. */
export const EXERCISE_WALL_MS = 50_000;

/** No single tool may hold the run. `fix_wiki_issue` on a fresh fixture is ~30 ms. */
export const EXERCISE_CALL_MS = 12_000;

/**
 * The throwaway domain's slug.
 *
 * `zz-` so it sorts last anywhere it is ever seen, and it is only ever seen
 * inside a temp dir that outlives the run by no time at all. It must satisfy
 * `isValidDomain` (no dots) and stay inside `mcp-usage.js`'s 48-character
 * domain bound so the log records it rather than dropping it to null — which
 * the suite asserts, because a fixture domain recorded as `null` would make
 * every `domain` assertion in the log vacuous.
 */
export const EXERCISE_DOMAIN = 'zz-curator-self-test';

/** Environment keys stripped from the child in every run. */
const STRIPPED_ENV = [
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
  'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL',
];

/** A marker the suite can find in `get_raw_source`'s answer. */
export const RAW_MARKER = 'CURATOR-EXERCISE-RAW-MARKER';

// ── THE FIXTURE ─────────────────────────────────────────────────────────────
//
// Small, and every shape in it is there because a specific tool needs it:
//
//   alpha (entity)     → beta-concept, summaries/exercise-source, and
//                        [[dr-alpha-two]] — BROKEN, and `alpha-two` exists and
//                        normalises to the same key, so the scanner emits it
//                        with a `suggestedTarget` and `fix_wiki_issue` has a
//                        real auto-fixable issue to apply.
//   alpha-two (entity) → alpha
//   beta-concept       → alpha              (so get_backlinks has an edge)
//   lonely (concept)   → nothing, and nothing links to it: the ORPHAN, which is
//                        what dismiss_wiki_issue / undismiss_wiki_issue pair on.
//   exercise-source    → alpha, with `source:` naming a file that is really in
//     (summary)          raw/, so get_raw_source answers on its SUCCESS path.
//
// The working-state tiers are NOT hand-seeded. `save_project_brief`,
// `save_working_state` and `save_foundation` run BEFORE the three state reads
// in the plan below, so the reads answer against output the store itself
// produced — which is a stronger thing to have exercised than a hand-built
// directory that happens to parse, and it removes the one place a hand fixture
// would have had to reproduce the `<hostname>-<install-id>` machine segment.

async function seedFixture(domainsRoot) {
  const dom = path.join(domainsRoot, EXERCISE_DOMAIN);
  const wiki = path.join(dom, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) {
    await mkdir(path.join(wiki, f), { recursive: true });
  }
  await mkdir(path.join(dom, 'raw'), { recursive: true });

  const w = (rel, body) => writeFile(path.join(dom, rel), body, 'utf8');

  await w('CLAUDE.md', '# zz-curator-self-test\n\nThrowaway fixture for the app\'s tool self-test. Deleted when the run ends.\n');
  await w(path.join('wiki', 'index.md'),
    '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n' +
    '| entities/alpha | entity | Seed entity |\n' +
    '| entities/alpha-two | entity | Its canonical sibling |\n' +
    '| concepts/beta-concept | concept | Seed concept |\n' +
    '| summaries/exercise-source | summary | Seed summary |\n');
  await w(path.join('wiki', 'log.md'), '## [2026-01-01] fixture seeded\n');

  await w(path.join('wiki', 'entities', 'alpha.md'),
    '---\ntype: entity\ntags: [type/entity, topic/self-test]\n---\n' +
    '# Alpha\n\n## Related\n- [[beta-concept]]\n- [[summaries/exercise-source]]\n' +
    '- [[dr-alpha-two]] — broken on purpose; the scanner can normalise it\n');
  await w(path.join('wiki', 'entities', 'alpha-two.md'),
    '---\ntype: entity\ntags: [type/entity]\n---\n# Alpha Two\n\n## Related\n- [[alpha]]\n');
  await w(path.join('wiki', 'concepts', 'beta-concept.md'),
    '---\ntype: concept\ntags: [type/concept]\n---\n# Beta Concept\n\n## Definition\nA concept.\n\n## Related\n- [[alpha]]\n');
  await w(path.join('wiki', 'concepts', 'lonely.md'),
    '---\ntype: concept\ntags: [type/concept]\n---\n# Lonely\n\n## Definition\nNothing links here.\n');
  await w(path.join('wiki', 'summaries', 'exercise-source.md'),
    '---\ntype: summary\nsource: exercise-source.txt\ntags: [type/summary]\n---\n' +
    '# Exercise Source\n\n## Entities Mentioned\n- [[alpha]]\n');
  await w(path.join('raw', 'exercise-source.txt'),
    `${RAW_MARKER}\nThe original document behind the fixture summary.\n`);
  return dom;
}

// ── THE PLAN ────────────────────────────────────────────────────────────────
//
// ONE CASE PER CATALOGUE TOOL, in a FIXED order, with DETERMINISTIC arguments.
// Nothing here depends on a clock, a random value or the machine.
//
// The order is an argument, not the catalogue's:
//
//   1–11  the wiki READS, against the seeded pages.
//   12    compile_to_wiki, which WRITES two pages — after the reads, so the
//         §4-style topology the reads see is the seeded one.
//   13–15 the health block: scan, then the auto-fix on the seeded broken link,
//         then the semantic-duplicate ESTIMATE (the unpaid arm).
//   16–18 dismiss → get_health_dismissed → undismiss, in that order, so the
//         middle read has a record to find and the run leaves nothing dismissed.
//   19–21 the state WRITES: brief (tier 1), handoff (tier 2/3), foundation
//         (tier 0). `commissioned_by_owner` is true because the user pressed
//         the button that started this run — which is the literal condition
//         that flag states, and the only run in which it is honest.
//   22–24 the state READS, which therefore answer against real store output.
//
// `project` is the DOMAIN'S OWN project (`project === domain`), which resolves
// to the state root and always exists — a named project would need creating
// first and would test the driver's sequencing rather than the tools.
export const EXERCISE_PLAN = [
  { tool: 'list_domains', args: () => ({}) },
  { tool: 'get_index', args: (c) => ({ domain: c.domain }) },
  { tool: 'get_graph_overview', args: (c) => ({ domain: c.domain }) },
  { tool: 'get_tags', args: (c) => ({ domain: c.domain }) },
  { tool: 'search_wiki', args: (c) => ({ domain: c.domain, query: 'alpha' }) },
  { tool: 'search_cross_domain', args: () => ({ query: 'alpha' }) },
  { tool: 'get_node', args: (c) => ({ domain: c.domain, slug: 'alpha' }) },
  { tool: 'get_connected_nodes', args: (c) => ({ domain: c.domain, slug: 'alpha' }) },
  { tool: 'get_backlinks', args: (c) => ({ domain: c.domain, slug: 'beta-concept' }) },
  { tool: 'get_summary', args: (c) => ({ domain: c.domain, slug: 'exercise-source' }) },
  { tool: 'get_raw_source', args: (c) => ({ domain: c.domain, slug: 'exercise-source' }) },
  {
    tool: 'compile_to_wiki',
    args: (c) => ({
      domain: c.domain,
      title: 'Curator tool self-test',
      summary_content:
        '## Key Takeaways\n- The bridge answered every tool once.\n\n'
        + '## Entities Mentioned\n- [[alpha]]\n\n'
        + '## Notes\nWritten by the app\'s own tool self-test into a throwaway copy.\n',
      additional_pages: [{
        path: 'concepts/self-test-note.md',
        content: '# Self-test note\n\n## Definition\nA page the self-test wrote.\n\n## Related\n- [[alpha]]\n',
      }],
    }),
  },
  { tool: 'scan_wiki_health', args: (c) => ({ domain: c.domain }) },
  {
    tool: 'fix_wiki_issue',
    args: (c) => ({
      domain: c.domain,
      type: 'brokenLinks',
      issue: { sourceFile: 'entities/alpha.md', linkText: 'dr-alpha-two', suggestedTarget: 'alpha-two' },
    }),
  },
  {
    // THE ONE TOOL WITH A PAID ARM, driven on the arm that has none.
    // `estimate_only` reads the wiki, counts candidate pairs and prices them
    // from the local table; it makes no request. `max_pairs` is at the
    // schema's floor so the estimate is over the smallest legal candidate set.
    tool: 'scan_semantic_duplicates',
    args: (c) => ({ domain: c.domain, estimate_only: true, max_pairs: 10 }),
  },
  {
    tool: 'dismiss_wiki_issue',
    args: (c) => ({
      domain: c.domain,
      type: 'orphans',
      issue: { path: 'concepts/lonely.md', type: 'concept', slug: 'lonely' },
    }),
  },
  { tool: 'get_health_dismissed', args: (c) => ({ domain: c.domain }) },
  {
    tool: 'undismiss_wiki_issue',
    args: (c) => ({
      domain: c.domain,
      type: 'orphans',
      issue: { path: 'concepts/lonely.md', type: 'concept', slug: 'lonely' },
    }),
  },
  {
    tool: 'save_project_brief',
    args: (c) => ({
      domain: c.domain, project: c.domain,
      text: '# Self-test project\n\n## What this is\nA throwaway brief written by the app\'s tool self-test.\n',
      harness: 'The Curator', model: 'self-test',
    }),
  },
  {
    tool: 'save_working_state',
    args: (c) => ({
      domain: c.domain, project: c.domain, scope: 'self-test',
      headline: 'Every MCP tool answered once against a throwaway copy.',
      now_state: 'The self-test run wrote this handoff so the state reads have something to read.',
      next_steps: ['Nothing — this project is deleted when the run ends.'],
      harness: 'The Curator', model: 'self-test',
    }),
  },
  {
    tool: 'save_foundation',
    args: (c) => ({
      domain: c.domain, project: c.domain,
      slug: 'architecture.md', role: 'architecture', title: 'Self-test architecture',
      text: '# Self-test architecture\n\nOne canonical document, written by the self-test run.\n',
      // TRUE, and only in this run: the user pressed "Test all N tools", which
      // IS an explicit instruction to write this document. Every other caller
      // of this tool has to be instructed by a person too.
      commissioned_by_owner: true,
      harness: 'The Curator', model: 'self-test',
    }),
  },
  { tool: 'get_working_state', args: (c) => ({ domain: c.domain, project: c.domain, scope: 'latest' }) },
  { tool: 'list_projects', args: (c) => ({ domain: c.domain }) },
  { tool: 'get_project_context', args: (c) => ({ domain: c.domain, project: c.domain }) },
];

/** Catalogue tools with no case in the plan. MUST be empty; the suite pins it. */
export function planCoverage(catalogue = TOOL_CATALOGUE, plan = EXERCISE_PLAN) {
  const planned = plan.map((p) => p.tool);
  const names = catalogue.map((t) => t.name);
  return {
    covered: names.filter((n) => planned.includes(n)),
    missing: names.filter((n) => !planned.includes(n)),
    // A case for a tool that no longer exists. Not in the contract, and it is
    // the OTHER direction of the same drift: a tool renamed in the catalogue
    // would otherwise leave a plan entry firing against a name the bridge has
    // never heard of and reporting it as an ordinary failure.
    extra: planned.filter((n) => !names.includes(n)),
  };
}

/**
 * A note for one row: short, and never the raw answer.
 *
 * Every string that reaches here came out of the FIXTURE — the child cannot
 * see the user's wiki — so this is a length bound rather than a privacy one.
 * It is still a bound: a health scan's refusal can name a temp path, and a row
 * is rendered in the app.
 */
function noteOf(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 240 ? `${one.slice(0, 237)}…` : one;
}

/**
 * Run every tool once. Resolves; never rejects.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.domainsDir]  Root to seed the fixture domain under.
 *   Omitted → a fresh `mkdtemp`, removed WHOLE in `finally`. Supplied → the
 *   caller owns the root and only the fixture DOMAIN is removed.
 * @param {string}  [opts.userDataDir] Isolate the child's user-data dir (and
 *   with it the usage log). Omitted → the child writes the REAL log, which is
 *   what the app's run is for.
 * @param {string}  [opts.via]         `'self-test'` to mark every line the
 *   child writes. Anything else is ignored, by `mcp-usage.js`, not here.
 * @param {number}  [opts.timeoutMs]   The whole run's wall clock.
 * @param {object}  [opts.__childEnv]  TEST-ONLY: extra child environment. The
 *   suite uses it for `NODE_OPTIONS=--import <net spy>`. The route passes
 *   nothing; the double underscore is the marker this repo uses for a seam
 *   that must never be reachable from a request.
 * @returns {Promise<{ok, ranAt, durationMs, results, covered, missing, extra,
 *   spawn_command, spawn_args, transport, error}>} — `transport` is
 *   diagnostic (stdout line count, any non-JSON line, stderr bytes) and is
 *   read by the suite, never forwarded to the app.
 */
export async function exerciseAllTools(opts = {}) {
  const startedAt = Date.now();
  const ranAt = new Date(startedAt).toISOString();
  const wall = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.min(opts.timeoutMs, 10 * 60_000) : EXERCISE_WALL_MS;
  const cov = planCoverage();

  let ownedRoot = null;
  let domainsRoot = opts.domainsDir || null;
  let fixtureDomainDir = null;
  let child = null;
  const results = [];
  let fatal = null;
  let entry = { command: null, args: [] };
  let transport = { stdoutLines: 0, nonJsonStdout: [], stderrBytes: 0, stderrSample: '' };

  try {
    if (!domainsRoot) {
      ownedRoot = await mkdtemp(path.join(os.tmpdir(), 'curator-tool-self-test-'));
      domainsRoot = path.join(ownedRoot, 'domains');
      await mkdir(domainsRoot, { recursive: true });
    }
    fixtureDomainDir = await seedFixture(domainsRoot);

    // THE LAUNCH LINE, and there is only one in the product. See the docblock.
    const { buildCuratorEntry } = await import('../routes/mcp.js');
    entry = buildCuratorEntry(domainsRoot);

    const env = { ...process.env };
    for (const k of STRIPPED_ENV) delete env[k];
    env.CURATOR_TEST_DOMAINS_DIR = domainsRoot;
    if (opts.userDataDir) env.CURATOR_TEST_USER_DATA_DIR = opts.userDataDir;
    if (opts.via === VIA_SELF_TEST) env[VIA_ENV_VAR] = VIA_SELF_TEST;
    else delete env[VIA_ENV_VAR];
    if (opts.__childEnv) Object.assign(env, opts.__childEnv);

    child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'], env });

    let spawnError = null;
    child.on('error', (err) => { spawnError = err; });

    let stdoutBuf = '';
    const stdoutLines = [];
    let stderrText = '';
    const pending = new Map();
    child.stderr.on('data', (d) => { stderrText += d; });
    child.stdout.on('data', (d) => {
      stdoutBuf += d;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line.trim()) continue;
        stdoutLines.push(line);
        let frame = null;
        try { frame = JSON.parse(line); } catch { /* the suite's purity check reports it */ }
        if (frame && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); }
      }
    });

    let nextId = 1;
    const remaining = () => wall - (Date.now() - startedAt);
    const rpc = (method, params, cap) => {
      const id = nextId++;
      const budget = Math.max(0, Math.min(cap ?? EXERCISE_CALL_MS, remaining()));
      return new Promise((resolve) => {
        if (budget <= 0) { resolve({ __timeout: true }); return; }
        const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: true }); }, budget);
        pending.set(id, (f) => { clearTimeout(timer); resolve(f); });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch (err) { clearTimeout(timer); pending.delete(id); resolve({ __writeError: err.message }); }
      });
    };

    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'curator-tool-self-test', version: '1' },
    }, 8_000);
    if (!init?.result?.serverInfo) {
      // THE SAME OUTCOME /self-test GIVES on a machine with no usable node:
      // the launch failed, and that is the answer rather than 24 timeouts.
      fatal = spawnError
        ? `The bridge could not be started: ${spawnError.message}`
        : 'The bridge did not answer the MCP handshake.';
    } else {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const ctx = { domain: EXERCISE_DOMAIN, domainsDir: domainsRoot };
      for (const step of EXERCISE_PLAN) {
        const t0 = Date.now();
        if (remaining() <= 0) {
          results.push({
            tool: step.tool, ok: false, refused: false, ms: 0,
            note: 'the run\'s time budget expired before this tool was called',
          });
          continue;
        }
        const frame = await rpc('tools/call', { name: step.tool, arguments: step.args(ctx) });
        const ms = Date.now() - t0;
        if (frame?.__timeout) {
          results.push({ tool: step.tool, ok: false, refused: false, ms, note: 'no answer within the call budget' });
          continue;
        }
        if (frame?.__writeError) {
          results.push({ tool: step.tool, ok: false, refused: false, ms, note: `the bridge closed its input (${frame.__writeError})` });
          continue;
        }
        if (frame?.error) {
          results.push({ tool: step.tool, ok: false, refused: false, ms, note: noteOf(frame.error.message || 'JSON-RPC error') });
          continue;
        }
        const text = frame?.result?.content?.[0]?.text;
        if (frame?.result?.isError === true) {
          results.push({ tool: step.tool, ok: false, refused: false, ms, note: noteOf(typeof text === 'string' ? text : 'the tool threw') });
          continue;
        }
        // The structured envelope, where a tool has one. `{ok:false}` is a
        // REFUSAL — the same reading `mcp/tools/index.js`'s usage hook takes,
        // so a row here and the log line beside it cannot disagree. The ten
        // older read tools answer a plain string and are recorded as answered,
        // which is that hook's named limit and therefore this one's too.
        let body = null;
        if (typeof text === 'string') { try { body = JSON.parse(text); } catch { body = null; } }
        if (body && typeof body === 'object' && body.ok === false) {
          results.push({
            tool: step.tool, ok: false, refused: true, ms,
            note: noteOf(body.reason ? `${body.reason}: ${body.message || body.error || ''}` : (body.error || body.message || 'refused')),
          });
          continue;
        }
        results.push({ tool: step.tool, ok: true, refused: false, ms, note: null });
      }
    }

    // Wound down BEFORE the fixture is removed, so nothing is mid-write when
    // the tree goes. The child has no work left; `stdin.end()` is how it is
    // told, and the kill is the backstop for a child that ignores it.
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise((r) => setTimeout(r, 150));
    try { child.kill(); } catch { /* already gone */ }

    // ── STDOUT PURITY, AS A MEASUREMENT RATHER THAN AN ASSUMPTION ─────────
    // The MCP protocol reserves stdout for JSON-RPC frames, and this run puts
    // the whole tool surface on the child's executed import graph in one go —
    // which is the broadest single exercise of it anywhere. So the run counts
    // what it saw. NOT forwarded by the route: the child's own bytes are the
    // child's, and the app has nothing to do with them; the SUITE reads this.
    transport = {
      stdoutLines: stdoutLines.length,
      nonJsonStdout: stdoutLines
        .filter((l) => { try { JSON.parse(l); return false; } catch { return true; } })
        .slice(0, 3)
        .map((l) => l.slice(0, 200)),
      stderrBytes: Buffer.byteLength(stderrText, 'utf8'),
      // A SAMPLE, not the stream: "the child wrote 127 bytes to stderr" is a
      // failure message nobody can act on, and the first thing anyone reading
      // it does is go looking for the text. Bounded, and never forwarded to
      // the app.
      stderrSample: stderrText.slice(0, 300),
    };
  } catch (err) {
    fatal = `The self-test run failed: ${err.message}`;
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    try {
      if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true });
      else if (fixtureDomainDir) await rm(fixtureDomainDir, { recursive: true, force: true });
    } catch { /* a temp dir that will not go is not worth failing a run over */ }
  }

  // Every planned tool gets a row even on a fatal, so a caller never has to
  // tell "the run did not happen" from "this tool is missing from the map".
  if (results.length < EXERCISE_PLAN.length) {
    const seen = new Set(results.map((r) => r.tool));
    for (const step of EXERCISE_PLAN) {
      if (seen.has(step.tool)) continue;
      results.push({ tool: step.tool, ok: false, refused: false, ms: 0, note: fatal || 'not called' });
    }
  }

  const answered = results.filter((r) => r.ok || r.refused).length;
  return {
    ok: !fatal && cov.missing.length === 0 && answered === results.length,
    ranAt,
    durationMs: Date.now() - startedAt,
    results,
    covered: cov.covered,
    missing: cov.missing,
    extra: cov.extra,
    spawn_command: entry.command,
    spawn_args: entry.args,
    transport,
    error: fatal,
  };
}
