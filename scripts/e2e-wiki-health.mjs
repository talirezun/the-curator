#!/usr/bin/env node
/**
 * e2e-wiki-health.mjs — the MEASURING STICK for the Wiki health redesign.
 *
 * LIVE_LOCAL (scripts/run-tests.js). It starts this checkout's server on a
 * spare port with a STUBBED model and drives Domains › Wiki health in headless
 * Chrome over CDP (scripts/visual/), with REAL mouse events, against an
 * ISOLATED world: a synthetic workspace (scripts/demo-domain.mjs plus four
 * generated lab domains), CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR
 * and a FAKE HOME. The stub is a preload that answers the model's calls with
 * canned verdicts and refuses every other non-local host, so no provider call
 * is ever made and the fake key in the fake config is not a credential. The
 * real config files are fingerprinted before and after. Servers and browsers
 * are stopped by signalling only the processes this script spawned.
 *
 * WHAT IT MEASURES. For every Health action the app has today it runs a
 * per-frame sampler (requestAnimationFrame) over NAMED LANDMARKS:
 *   changeMs         ms from the mouse-down until the pressed control's own
 *                    markup changes (a control that vanishes does not count)
 *   aboveMovePx      how far the landmarks ABOVE the pressed row, and the row
 *                    itself, move (viewport coordinates, max over all frames)
 *   belowMovePx      the same for landmarks below it (informational)
 *   scrollDeltaPx    change of scrollTop (#main and the window)
 *   outcomeOffscreen / outcomeDistancePx   is the outcome in the viewport, and
 *                    how far from the press
 *   focusBody        1 when focus ended on <body>
 *   identityLost     marked nodes (.dm-health and every landmark that is not the
 *                    pressed row) no longer in the document after the action
 *   pointerSwap      1 when, within 300 ms, an ENABLED button with another
 *                    label was under the pointer
 *   cardHeightDeltaPx  the pressed pair card's height change (Preview, Flip)
 *   liveMissing      1 when no live region in the section announced anything
 *   overflowPx       how far anything inside the section pokes past its card
 *   pressWidthDeltaPx  how much the pressed control's width changed while it answered
 *   busyMissing      1 when an action that runs never showed aria-busy on its control
 *   belowSnapPx      a landmark below the row that moved its whole distance in ONE frame
 *                    (a jump, not an animated row). Not judged under reduced motion.
 *
 * It does NOT use the browser's `layout-shift`: that entry reads 0 for a
 * replaced node, and read 0 on a 640 px move.
 *
 * STAGES. Every metric has a REQUIRED threshold (REQUIRED below, from
 * health-design PLAN §3). The default stage, `baseline`, requires none of them:
 * each metric is compared with the recorded numbers in
 * scripts/e2e-wiki-health.baseline.json and fails only if it got WORSE.
 * A later stage lists, in STAGES, the metrics (optionally only for named
 * actions) that must now meet REQUIRED. Tightening a stage is a one-line edit.
 *
 * THE SELECTORS are all in SEL, below. A redesign changes them there.
 *
 *   node scripts/e2e-wiki-health.mjs [--stage <name>] [--profiles 1280,375,1280-light,375-light,1280-rm,375-rm,800,big-1280,big-375]
 *        [--only S1,S2,S4,S5,S6,S7,S8,S9,S10] [--record-baseline [--merge-baseline]] [--baseline <file>] [--shots <dir>]
 *
 * SINCE STAGE 1 the default stage is `s1`, the press rule: every metric below is
 * REQUIRED except the review desk's, which belong to a later stage.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const STAGE = arg('--stage', 's1');
const RECORD = argv.includes('--record-baseline');
const MERGE = argv.includes('--merge-baseline');   // keep the WORST value seen across repeated recordings (timing noise)
const BASELINE_FILE = path.resolve(arg('--baseline', path.join(REPO, 'scripts', 'e2e-wiki-health.baseline.json')));
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null;
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const PROFILE_NAMES = (arg('--profiles') || '1280,375,1280-light,375-light,1280-rm,375-rm,800,big-1280,big-375').split(',');

// ═══ 1. THE SELECTOR TABLE — the one place a redesign edits ═════════════════
const SEL = {
  health: '.dm-health',
  main: '#main',
  viewRoot: '#view-root',
  domainRow: '.dm-row[data-domain-slug]',
  healthReady: '.dm-health .cur-action, .dm-health .cur-card',
  rescan: '#dm-rescan-btn',
  fixAll: (key) => `[data-group-key="${key}"] .dm-group-fixall-btn`,
  fixSafe: '.dm-quick-btn[data-action="fixSafe"]',
  findDupes: '.dm-quick-btn[data-action="semanticDupes"]',
  confirmYes: '#dm-confirm-yes',
  confirmNo: '#dm-confirm-no',
  checkNext: '#dm-semantic-next-btn',
  batchMerge: '#dm-semantic-merge-btn',
  card: '.dm-sem-card',                                   // one pair
  cardBtn: (key, action) => `.dm-sem-card[data-sem-key="${key}"] [data-sem-action="${action}"]`,
  preview: '.dm-sem-preview',
  dismissIn: (group) => `[data-group-key="${group}"] .dm-issue-row .dm-dismiss-btn`,
  restore: '.dm-restore-btn',
  fold: (key) => `[data-group-key="${key}"]`,
  // outcomes (first one that exists wins)
  banner: '.dm-health .dm-banner',
  done: '.dm-health .dm-row-done',
  outcome: '.dm-health .dm-outcome',
  plan: '.dm-health .dm-plan-card[data-row-key="plan"]',
  planApply: '#dm-plan-apply-btn',
  indexPlan: '.dm-quick .dm-quick-btn[data-action="indexPlan"]',
  rescue: '.dm-quick-btn[data-action="orphans"]',
  fixLinks: '.dm-quick-btn[data-action="brokenLinks"]',
  retry: '.dm-health .dm-outcome-retry',
  confirmCard: '.dm-confirm-card',
  coverage: '.dm-sem-coverage',
  handled: '.dm-sem-handled',
  // the row a press belongs to (nearest ancestor): used to split "above" from "below"
  rows: '.dm-sem-card, .dm-issue-row, .dm-group, .dm-quick, .dm-confirm-card, .dm-plan-card, .dm-sem-batch, .dm-health-top',
  // landmarks sampled every frame (each: base selector + how many matches)
  landmarks: [
    { base: '.dm-health', max: 1 }, { base: '.dm-health .cur-section-hd', max: 1 }, { base: '.dm-quick', max: 1 },
    { base: '.dm-group-scan', max: 1 }, { base: '.dm-group[data-group-key]', max: 10 }, { base: '.dm-confirm-card', max: 1 },
    { base: '.dm-plan-card', max: 1 }, { base: '.dm-ai-progress', max: 1 }, { base: '.dm-sem-coverage', max: 1 },
    { base: '.dm-sem-card', max: 9 }, { base: '.dm-sem-handled', max: 1 },
  ],
  live: '.dm-health [aria-live]',
};
// the folds the lab domains fill
const FOLDS = ['orphans', 'missingBacklinks', 'brokenLinks', 'folderPrefixLinks'];

// ═══ 2. THRESHOLDS ══════════════════════════════════════════════════════════
// REQUIRED: PLAN §3 "Required" column. All metrics are "lower is better".
const REQUIRED = {
  changeMs: 100, aboveMovePx: 1, scrollDeltaPx: 1, outcomeOffscreen: 0, outcomeDistancePx: 200,
  focusBody: 0, identityLost: 0, pointerSwap: 0, cardHeightDeltaPx: 1, liveMissing: 0, overflowPx: 1,
  pressWidthDeltaPx: 1, busyMissing: 0, belowSnapPx: 0,
};
const UNIT = { changeMs: 'ms', aboveMovePx: 'px', scrollDeltaPx: 'px', outcomeDistancePx: 'px', cardHeightDeltaPx: 'px', overflowPx: 'px', pressWidthDeltaPx: 'px', belowSnapPx: 'px' };
// INFO metrics are recorded, not judged.
const INFO = ['belowMovePx', 'belowFrames', 'paints', 'vanishedFrames'];
// A stage lists the metrics that must now meet REQUIRED: 'all' or an array of action names.
// `baseline` requires none. Later stages tighten here, one line per metric.
const STAGES = {
  baseline: {},
  // S1, the press rule: everything but the desk's card height, which needs the desk.
  s1: Object.fromEntries(Object.keys(REQUIRED).filter((k) => k !== 'cardHeightDeltaPx').map((k) => [k, 'all'])),
  // example for a later stage:  'stage-2': { changeMs: 'all', scrollDeltaPx: 'all' },
  final: Object.fromEntries(Object.keys(REQUIRED).map((k) => [k, 'all'])),
};
if (!STAGES[STAGE]) { console.error(`unknown --stage ${STAGE}; known: ${Object.keys(STAGES).join(', ')}`); process.exit(2); }
// Noise allowance when comparing with the baseline (a metric may not get WORSE than this).
const withinBaseline = (m, v, b) => (UNIT[m] === 'ms' ? v <= Math.max(b * 1.5, b + 60) : UNIT[m] === 'px' ? v <= b * 1.25 + 8 : v <= b);

// ═══ 3. PROFILES ════════════════════════════════════════════════════════════
const ALL_PROFILES = {
  '1280': { name: '1280', w: 1280, h: 900 },
  '375': { name: '375', w: 375, h: 812 },
  '1280-light': { name: '1280-light', w: 1280, h: 900, light: true, only: ['S1', 'S5', 'S6'] },
  '375-light': { name: '375-light', w: 375, h: 812, light: true, only: ['S1', 'S5', 'S6'] },
  '1280-rm': { name: '1280-reduced-motion', w: 1280, h: 900, reduced: true, only: ['S2', 'S5', 'S7'] },
  '375-rm': { name: '375-reduced-motion', w: 375, h: 812, reduced: true, only: ['S1', 'S4', 'S7'] },
  rm: { name: '1280-reduced-motion', w: 1280, h: 900, reduced: true, only: ['S2', 'S5'] },
  '800': { name: '800', w: 800, h: 900, overflowOnly: true },
  // A synthetic domain of thousands of pages and hundreds of pairs. The small
  // demo cannot show what a real wiki does to a list.
  'big-1280': { name: 'big-1280', w: 1280, h: 900, big: true, only: ['S9'] },
  'big-375': { name: 'big-375', w: 375, h: 812, big: true, only: ['S9'] },
};

// ═══ test bookkeeping ═══════════════════════════════════════════════════════
let passed = 0; let failed = 0; const notes = [];
function step(name, ok, detail) {
  if (ok) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); }
  else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? ' — ' + String(detail).slice(0, 600) : '')); }
  return !!ok;
}
const note = (s) => { notes.push(s); console.log('  · ' + s); };

if (!findBrowser()) { console.log('⊘ e2e-wiki-health: no Chrome / Chromium / Edge found — skipped (it needs a real browser).'); process.exit(0); }

// ── the real files, fingerprinted ───────────────────────────────────────────
const REAL_HOME = os.homedir();
const REAL_FILES = [
  path.join(REAL_HOME, 'Library/Application Support/The Curator/.curator-config.json'),
  path.join(REAL_HOME, '.curator-config.json'), path.join(REPO, '.curator-config.json'), path.join(REPO, '.env'),
];
const fingerprint = () => Object.fromEntries(REAL_FILES.map((f) => { try { const b = readFileSync(f); return [f, createHash('sha256').update(b).digest('hex') + ' ' + b.length]; } catch { return [f, 'absent']; } }));
const fpBefore = fingerprint();

// ═══ 4. THE STUB (preload) — local canned model, refuses every other host ═══
const STUB_SRC = String.raw`
import { appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
const LOG = process.env.HEALTH_STUB_LOG;
const log = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify(o) + '\n'); };
const STRONG = {
  'agent|ai-agents': 'Both pages describe the core concept of AI agents.',
  'accountability|ai-accountability': 'The two pages are identical in subject, with B slightly more focused on AI.',
  'context|context-window': 'Both describe the amount of text a model can handle.',
  'data-privacy|privacy-and-data-protection': 'Both pages describe the protection of personal information.',
  'user-documentation|user-guide': 'Both pages describe material that helps users operate a product.',
  'deployment|deployment-fundamentals': 'Both pages describe making software available to users.',
  'llm-instructions|agent-instructions': 'Both pages describe directives given to AI agents.',
  'hand-off|handoff': 'Both pages describe the same thing under two spellings.',
  'handoff|handoffs': 'Both pages describe the same thing, singular and plural.',
  'neural-network|neural-networks': 'The same concept, singular and plural.',
  'e-mail|email': 'The same thing under two spellings.',
  'open-ai|openai': 'The same company under two spellings.',
};
const lookup = (a, b) => STRONG[a + '|' + b] || STRONG[b + '|' + a];
const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 } }), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  let host = ''; try { host = new URL(u).hostname; } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return realFetch(url, opts);
  if (!u.includes('generativelanguage.googleapis.com')) { log({ blocked: host }); return new Response('{}', { status: 503 }); }
  if (!u.includes(':generateContent')) return new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  const body = JSON.parse(opts.body);
  const sys = JSON.stringify(body.systemInstruction || ''); const prompt = JSON.stringify(body.contents);
  await new Promise((r) => setTimeout(r, Number(process.env.HEALTH_STUB_LATENCY_MS || 250)));
  if (/orphan/i.test(sys)) {
    const results = []; const re = /--- ORPHAN (\d+) \[/g; let m;
    while ((m = re.exec(prompt))) results.push({ index: Number(m[1]), home: Number(m[1]) % 2 === 0 ? 'wiki-hub' : null, description: 'Links to a related idea.', confidence: 'high' });
    log({ stubbed: 'orphans' }); return reply(JSON.stringify({ results }));
  }
  if (/PAIR \d+ ---/.test(prompt)) {
    const pairs = []; const re = /--- PAIR (\d+) ---\\nA: \[[a-z]+\/([^\]]+)\][\s\S]*?\\nB: \[[a-z]+\/([^\]]+)\]/g; let m;
    while ((m = re.exec(prompt))) pairs.push({ index: Number(m[1]), a: m[2], b: m[3] });
    log({ stubbed: 'pairs', n: pairs.length });
    return reply(JSON.stringify({ results: pairs.map((p) => {
      const why = lookup(p.a, p.b);
      if (why) return { index: p.index, difference: 'none', relation: 'same', confidence: 'high', canonicalSlug: p.b.length >= p.a.length ? p.b : p.a, rationale: why };
      if (p.a.replace(/-fundamentals$/, '') === p.b.replace(/-fundamentals$/, '')) return { index: p.index, difference: 'none', relation: 'same', confidence: 'high', canonicalSlug: p.a.length >= p.b.length ? p.a : p.b, rationale: 'Both pages describe the same subject.' };
      return { index: p.index, difference: 'different subjects', relation: 'overlap' };
    }) }));
  }
  const results = []; const re = /(?:^|\\n)(?:--- )?(?:LINK )?(\d+)[:\]]/g; let m; let i = 0;
  while ((m = re.exec(prompt)) && i < 200) { results.push({ index: Number(m[1]), target: null, confidence: 'low' }); i++; }
  log({ stubbed: 'other' }); return reply(JSON.stringify({ results }));
};
`;

// ═══ 5. THE LAB DOMAINS (generated, synthetic, nothing personal) ════════════
const para = (t, s) => `---\ntype: concept\ntags: [type/concept]\n---\n\n# ${t}\n\n${s}\n\n## Key Facts\n\n- A fact recorded about ${t}.\n- Another note, from a different source, on ${t}.\n\n## Related\n\n- [[wiki-hub]]\n`;
const OPENINGS = {
  agent: 'A software actor that perceives its environment and acts toward a goal.', 'ai-agents': 'Autonomous systems built on language models that plan and act.',
  accountability: 'Being answerable for decisions and outcomes.', 'ai-accountability': 'Who answers when an AI system causes harm.',
  context: 'The surrounding circumstances that give a statement meaning.', 'context-window': 'The maximum number of tokens a model reads and writes in one call.',
  'data-privacy': 'The right of a person to control how their data is used.', 'privacy-and-data-protection': 'Law and practice for protecting personal data, including GDPR obligations.',
  'user-documentation': 'Reference manuals and help pages shipped with a product.', 'user-guide': 'A task-based walk through of a product for new users.',
  deployment: 'Releasing a specific version of software to an environment.', 'deployment-fundamentals': 'An introduction to pipelines, environments and rollback.',
  'llm-instructions': 'System prompts and how models read them.', 'agent-instructions': 'Files that tell a coding agent how to work in a repository.',
  'hand-off': 'Passing work from one agent or person to the next.', handoff: 'Passing work to the next, with its state attached.', handoffs: 'Patterns for passing work between agents.',
  'neural-network': 'A model built from layers of connected units.', 'neural-networks': 'Models built from layers of units, trained by gradient descent.',
  'e-mail': 'Messages sent over the internet.', email: 'Electronic mail.', 'open-ai': 'The company behind GPT.', openai: 'An AI lab.',
  'claude-code': 'A coding agent that runs in a terminal.', gartner: 'A research and advisory firm.', 'gartner-predictions': 'Yearly forecasts.',
  'gartner-ai-predictions': 'Forecasts about AI adoption.', 'gartner-analysis-ai': 'Analyst notes on AI.', 'gartner-market-analysis': 'Market sizing notes.',
  'prototyping-to-production': 'Moving a prototype into a production system.',
};
function buildLabDomain(root, name, opts = {}) {
  const w = path.join(root, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, f), { recursive: true });
  writeFileSync(path.join(root, name, 'CLAUDE.md'), `# ${name}\n`);
  const concept = (s, body) => writeFileSync(path.join(w, 'concepts', s + '.md'), body ?? para(s, OPENINGS[s] || ('Notes about ' + s + '.')));
  const orphans = ['claude-code', 'gartner', 'gartner-ai-predictions', 'gartner-analysis-ai', 'gartner-market-analysis', 'gartner-predictions'];
  const linked = Object.keys(OPENINGS).filter((s) => !orphans.includes(s));
  for (const s of Object.keys(OPENINGS)) concept(s, orphans.includes(s) ? `---\ntype: concept\ntags: [type/concept]\n---\n\n# ${s}\n\n${OPENINGS[s]}\n\n## Key Facts\n\n- A fact about ${s}.\n` : undefined);
  let x = 7; const rnd = () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
  const WORDS = ['ledger', 'quorum', 'tidal', 'sonar', 'prism', 'cobalt', 'meridian', 'harbor', 'lattice', 'ember', 'vector', 'glacier', 'orbit', 'canopy', 'saffron', 'basalt', 'quartz', 'willow', 'falcon', 'marble', 'onyx', 'juniper', 'aurora', 'cedar', 'delta', 'fjord', 'gantry', 'hollow', 'indigo', 'jasper', 'kelvin', 'lumen', 'mosaic', 'nimbus', 'opal', 'pylon', 'quill', 'rivet', 'summit', 'thistle', 'umbra', 'vellum', 'wharf', 'xenon', 'yarrow', 'zephyr', 'anvil', 'beacon', 'cinder', 'dune'];
  for (let i = 0; i < (opts.topicPairs ?? 45); i++) { const a = opts.distinct ? WORDS[i % WORDS.length] + i : WORDS[i % WORDS.length] + '-method'; linked.push(a, a + '-fundamentals'); concept(a); concept(a + '-fundamentals'); }
  for (let i = 0; i < (opts.filler ?? 150); i++) { let s = ''; for (let k = 0; k < 9; k++) s += 'bcdfghjklmnpqrstvwxz'[Math.floor(rnd() * 20)]; linked.push(s); concept(s); }
  writeFileSync(path.join(w, 'concepts', 'wiki-hub.md'), `---\ntype: concept\n---\n\n# Hub\n\nAn index page.\n\n## Related\n\n${linked.map((s) => `- [[${s}]]`).join('\n')}\n- [[entities/acme-labs]]\n- [[context-windowz]]\n- [[model-trainingx]]\n- [[customer-satisfactionx]]\n`);
  writeFileSync(path.join(w, 'entities', 'acme-labs.md'), `---\ntype: entity\n---\n\n# Acme Labs\n\nA company.\n\n## Related\n\n- [[wiki-hub]]\n- [[concepts/ai-agents]]\n`);
  writeFileSync(path.join(w, 'entities', 'deployment.md'), `---\ntype: entity\n---\n\n# Deployment\n\nA team at Acme.\n\n## Related\n\n- [[wiki-hub]]\n`);
  writeFileSync(path.join(w, 'summaries', 'module-handoff.md'), `---\ntype: summary\n---\n\n# Module handoff\n\nA summary.\n\n## Key Takeaways\n\n- One point.\n\n## Concepts Introduced or Referenced\n\n- [[prototyping-to-production]]\n- [[ai-agents]]\n- [[ai-agents]]\n`);
  writeFileSync(path.join(w, 'index.md'), `# Wiki Index — ${name}\n\n| Page | Summary |\n|---|---|\n| [[wiki-hub]] | hub |\n`);
  writeFileSync(path.join(w, 'log.md'), '# Log\n');
}

// ═══ 6. THE APP ═════════════════════════════════════════════════════════════
const LABS = ['h1', 'h2', 'h4', 'h5', 'h6', 'h7', 'h8', 'h10'];
async function startApp(profile) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-health-'));
  const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
  mkdirSync(ws.home); mkdirSync(ws.userData, { recursive: true });
  const stubFile = path.join(base, 'stub.mjs'); writeFileSync(stubFile, STUB_SRC);
  const stubLog = path.join(base, 'stub.log'); writeFileSync(stubLog, '');
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'demo-domain.mjs'), ws.domains], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, HOME: ws.home, CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_USER_DATA_DIR: ws.userData } });
  for (const d of LABS) buildLabDomain(ws.domains, d);
  if (profile.big) buildLabDomain(ws.domains, 'hbig', { topicPairs: 300, filler: 4000, distinct: true });
  // 40 pairs per scan, so "Check the next" has something left to check.
  writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', domainsPath: ws.domains,
    geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential', aiHealth: { semanticDupeMaxPairs: profile.big ? 500 : 40, costCeilingTokens: 20000000 } }, null, 2), { mode: 0o600 });
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  Object.assign(env, { PORT: String(port), CURATOR_NO_OPEN: '1', HOME: ws.home, CURATOR_TEST_INSTALL_HOME: ws.home, CURATOR_TEST_USER_DATA_DIR: ws.userData,
    CURATOR_TEST_DOMAINS_DIR: ws.domains, HEALTH_STUB_LOG: stubLog });
  const server = spawn(process.execPath, ['--import', stubFile, path.join(REPO, 'src', 'server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/version')).ok) break; } catch { /* not yet */ } await delay(200); }
  const browser = await launchBrowser({ headless: true });
  const conn = await CdpConnection.connect(browser.wsUrl);
  const page = await CdpPage.create(conn);
  await page.setViewport(profile.w, profile.h, 1);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: profile.light ? 'light' : 'dark' }, { name: 'prefers-reduced-motion', value: profile.reduced ? 'reduce' : 'no-preference' }] });
  const stop = async () => {
    try { await conn.close(); } catch { /* gone */ }
    try { await browser.close(); } catch { /* gone */ }
    if (server.exitCode === null) { try { server.kill('SIGTERM'); } catch { /* gone */ } for (let i = 0; i < 30 && server.exitCode === null; i++) await delay(100); if (server.exitCode === null) { try { server.kill('SIGKILL'); } catch { /* gone */ } } }
  };
  return { profile, ws, base, origin, page, conn, browser, server, stop, stubLog, serverLog: () => serverLog, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
async function waitFor(page, fn, label, tries = 400, ...args) {
  for (let i = 0; i < tries; i++) { let v = false; try { v = await page.evaluate(fn, ...args); } catch { /* navigating */ } if (v) return true; await delay(50); }
  note('TIMEOUT waiting for ' + label);
  return false;
}
async function openDomain(app, slug, profile = app.profile) {
  const { page, origin } = app;
  await page.navigate(origin + '/api/version');
  await page.evaluate((theme) => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('curator-next-theme', theme); localStorage.setItem('curator-next-view', 'domains');
    localStorage.setItem('curator-next-onboarding-dismissed-v1', '1'); localStorage.setItem('curator-ai-health-disclosure-seen-v1', 'yes');
    sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1');
  }, profile && profile.light ? 'light' : 'dark');
  await page.navigate(origin);
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);
  await page.evaluate(() => { const b = document.querySelector('#rail .rail-btn[data-view="domains"]'); if (b) b.click(); });
  await delay(500);
  await page.evaluate((s, sel) => { const e = [...document.querySelectorAll(sel)].find((n) => n.dataset.domainSlug === s); if (e) e.click(); }, slug, SEL.domainRow);
  await waitFor(page, (sel) => !!document.querySelector(sel), 'health card', 1200, SEL.rescan);
  await delay(600);
}

// ═══ 7. THE SAMPLER (in the page) ═══════════════════════════════════════════
const SAMPLER = String.raw`(() => {
  const sigOf = (e) => e.id ? '#' + e.id : (e.tagName + JSON.stringify(Object.entries(e.dataset || {}).map(([k, v]) => [k, k === 'semKey' ? v.split('||').sort().join('||') : v]).sort()));
  const keyOf = (e) => { const d = e.dataset || {}; if (d.rowKey) return 'r:' + d.rowKey; if (d.groupKey) return 'g:' + d.groupKey; if (d.semKey) return 's:' + d.semKey; return e.id ? '#' + e.id : null; };
  const desc = (e) => { if (!e || e === document.body || e === document.documentElement) return 'BODY'; const t = (e.innerText || e.value || '').trim().slice(0, 30); return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (t ? ' "' + t + '"' : ''); };
  const label = (e) => (e && (e.innerText || e.value || '') || '').trim();
  window.__hs = {
    begin(cfg) {
      const s = this.s = { cfg, frames: [], done: false, tDown: null, muts: 0 };
      const main = document.querySelector(cfg.main);
      const press = document.querySelector(cfg.press);
      const html = (e) => e.outerHTML.replace(/ style="[^"]*"/, '');
      s.html = html;
      s.pressSig = press ? sigOf(press) : null; s.pressTag = press ? press.tagName.toLowerCase() : 'button'; s.pressHtml = press ? html(press) : null; s.pressLabel = label(press);
      s.pressW0 = press ? press.getBoundingClientRect().width : 0;
      const row = press ? (press.closest(cfg.rows) || press) : null; s.rowEl = row;
      const rowTop = row ? row.getBoundingClientRect().top : 0;
      s.lms = [];
      for (const lm of cfg.landmarks) {
        const list = [...document.querySelectorAll(lm.base)].slice(0, lm.max);
        list.forEach((el, idx) => {
          if (row && row !== el && row.contains(el)) return;                // inside the pressed row
          const r = el.getBoundingClientRect();
          const rel = (row && el === row) ? 'row' : (row && el.contains(row)) ? 'anc' : (r.top <= rowTop + 0.5 ? 'above' : 'below');
          s.lms.push({ base: lm.base, idx, key: keyOf(el), el, rel, top0: r.top, h0: r.height, name: lm.base + '#' + (keyOf(el) || idx) });
        });
      }
      s.root = document.querySelector(cfg.health);
      s.live0 = [...document.querySelectorAll(cfg.live)].map((e) => e.textContent.trim());
      s.mo = new MutationObserver((recs) => { s.muts++; });
      s.mo.observe(document.querySelector(cfg.viewRoot), { childList: true, subtree: true, characterData: true });
      window.addEventListener('mousedown', (e) => { if (s.tDown === null) s.tDown = performance.now(); }, true);
      const resolve = (lm) => { const list = [...document.querySelectorAll(lm.base)]; if (lm.key) return list.find((e) => keyOf(e) === lm.key) || null; return list[lm.idx] || null; };
      s.resolve = resolve;
      const tick = () => {
        if (s.done) return;
        const t = performance.now();
        const f = { t, sc: Math.round(main.scrollTop * 10) / 10, ws: Math.round(window.scrollY * 10) / 10, lm: [], focus: desc(document.activeElement) };
        const p = s.pressSig ? [...document.querySelectorAll(s.pressTag)].find((e) => sigOf(e) === s.pressSig) : null;
        f.p = p ? s.html(p) : null;
        f.pw = p ? p.getBoundingClientRect().width : null;
        f.pt = p ? label(p) : null;
        f.busy = !!(p && p.getAttribute('aria-busy') === 'true');
        for (const sel of cfg.outcome || []) { const e = document.querySelector(sel); if (e) { const r = e.getBoundingClientRect(); if (r.height > 0) { f.out = { top: r.top, bottom: r.bottom }; break; } } }
        for (const lm of s.lms) { const el = resolve(lm); if (!el) { f.lm.push(null); continue; } const r = el.getBoundingClientRect(); f.lm.push([Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10]); }
        f.live = [...document.querySelectorAll(cfg.live)].map((e) => e.textContent.trim()).join('|');
        if (s.tDown !== null && t - s.tDown < 400 && cfg.pointer) {
          const u = document.elementFromPoint(cfg.pointer.x, cfg.pointer.y); const b = u && u.closest('button');
          f.ptr = b ? { label: label(b), disabled: !!b.disabled, sig: sigOf(b), same: p === b } : null;
        }
        s.frames.push(f);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    end() {
      const s = this.s; s.done = true; s.mo.disconnect();
      const resolveAny = (l) => (l.key || l.base === '.dm-health' ? s.resolve(l) : (l.el.isConnected ? l.el : null));
      // A row that left is not lost. A row REPLACED by a new node with its key is:
      // that is the whole-section paint this stage exists to end.
      const lost = s.lms.filter((l) => { const now = resolveAny(l); return now && now !== l.el; }).map((l) => l.name);
      const rootLost = !!s.root && !s.root.isConnected;
      return { frames: s.frames, tDown: s.tDown, muts: s.muts, pressHtml: s.pressHtml, pressLabel: s.pressLabel, pressSig: s.pressSig, pressW0: s.pressW0,
        lms: s.lms.map((l) => ({ name: l.name, rel: l.rel, top0: l.top0, h0: l.h0 })), lost, rootLost, marked: s.lms.filter((l) => l.rel !== 'row').length + 1,
        focusEnd: desc(document.activeElement), live0: s.live0 };
    },
  };
})();`;

// Reduce raw frames to the metrics.
function analyse(raw, ctx) {
  const t0 = raw.tDown ?? raw.frames[0]?.t ?? 0;
  const fr = raw.frames.filter((f) => f.t >= t0 - 1);
  const m = {};
  // An action that runs must answer in its LABEL. An attribute is not an answer
  // anyone can see. A press that only opens a question keeps its words and stays
  // visibly pressed, so for that one the markup is what counts.
  const changed = ctx.runs ? fr.find((f) => f.pt !== null && f.pt !== raw.pressLabel) : fr.find((f) => f.p !== null && f.p !== raw.pressHtml);
  m.changeMs = changed ? Math.round(changed.t - t0) : 9999;
  const gone = fr.find((f) => f.p === null);
  const goneMs = gone ? Math.round(gone.t - t0) : null;
  let above = 0; let aboveWho = ''; let below = 0; let vanished = 0; let belowFrames = 0; let cardH = 0;
  raw.lms.forEach((l, i) => {
    let prev = l.top0;
    for (const f of fr) {
      const v = f.lm[i];
      if (!v) { if (l.rel !== 'below') vanished++; continue; }
      const d = Math.abs(v[0] - l.top0);
      if (l.rel === 'below') { below = Math.max(below, d); if (Math.abs(v[0] - prev) > 0.5) belowFrames++; prev = v[0]; }
      else { if (d > above) { above = d; aboveWho = l.name + ' (' + l.rel + ')' + (l.rel === 'row' ? '' : ''); } above = Math.max(above, d); }
      if (l.rel === 'row') cardH = Math.max(cardH, Math.abs(v[1] - l.h0));
    }
  });
  m.aboveMovePx = Math.round(above); m.belowMovePx = Math.round(below); m.belowFrames = belowFrames; m.vanishedFrames = vanished;
  // A jump: a landmark below that covered its whole distance in a single frame.
  let snap = 0;
  raw.lms.forEach((l, i) => {
    if (l.rel !== 'below') return;
    const tops = fr.map((f) => f.lm[i] && f.lm[i][0]).filter((v) => v != null);
    if (tops.length < 2) return;
    let biggest = 0; let total = 0;
    for (let k = 1; k < tops.length; k++) { const d = Math.abs(tops[k] - tops[k - 1]); biggest = Math.max(biggest, d); }
    total = Math.max(...tops.map((t) => Math.abs(t - tops[0])));
    if (total > 4 && biggest >= total - 0.5 && total > snap) { snap = Math.round(total); ctx.snapWho = l.name; }
  });
  m.belowSnapPx = ctx.reduced ? 0 : snap;
  // While it answers. Afterwards it is a control at rest again, and may have
  // gained a cost it did not have when it was pressed.
  const widths = fr.filter((f) => f.busy).map((f) => f.pw).filter((v) => v != null);
  m.pressWidthDeltaPx = widths.length ? Math.round(Math.max(...widths.map((w) => Math.abs(w - raw.pressW0)))) : 0;
  m.busyMissing = ctx.runs && !fr.some((f) => f.busy) ? 1 : 0;
  const firstOut = ctx.settled ? null : fr.find((f) => f.out);
  if (firstOut) {
    const py = ctx.pressY;
    m.outcomeOffscreen = firstOut.out.bottom > 0 && firstOut.out.top < ctx.viewH ? 0 : 1;
    m.outcomeDistancePx = Math.round(firstOut.out.top > py ? firstOut.out.top - py : firstOut.out.bottom < py ? py - firstOut.out.bottom : 0);
  }
  const sc0 = fr[0]?.sc ?? 0; const ws0 = fr[0]?.ws ?? 0;
  m.scrollDeltaPx = Math.round(Math.max(0, ...fr.map((f) => Math.max(Math.abs(f.sc - sc0), Math.abs(f.ws - ws0)))));
  m.focusBody = raw.focusEnd === 'BODY' ? 1 : 0;
  m.identityLost = raw.lost.length + (raw.rootLost ? 1 : 0);
  m.paints = raw.muts;
  const swap = fr.some((f) => f.ptr && !f.ptr.same && !f.ptr.disabled && f.ptr.sig !== raw.pressSig && f.ptr.label !== raw.pressLabel);
  m.pointerSwap = swap ? 1 : 0;
  const liveNow = fr.map((f) => f.live).filter((x) => x && x !== '');
  const live0 = raw.live0.join('|');
  m.liveMissing = liveNow.some((x) => x !== live0) ? 0 : 1;
  if (ctx.decision) m.cardHeightDeltaPx = Math.round(cardH);
  return { m, goneMs, focusEnd: raw.focusEnd, lostNames: raw.lost, rootLost: raw.rootLost, aboveWho };
}

// ═══ 8. DRIVING AN ACTION ═══════════════════════════════════════════════════
const RESULTS = {};            // profile -> action -> metrics
const DETAIL = {};
const inject = (page) => page.send('Runtime.evaluate', { expression: SAMPLER });
async function place(page, sel, y) {
  await page.evaluate((s, y, mainSel) => {
    const e = document.querySelector(s); const m = document.querySelector(mainSel); if (!e) return;
    const want = Math.min(y, innerHeight * 0.55);
    m.scrollTop += e.getBoundingClientRect().top - want;
    const left = e.getBoundingClientRect().top - want; if (Math.abs(left) > 2) window.scrollBy(0, left);
  }, sel, y, SEL.main);
  await delay(150);
}
async function act(app, profile, name, o) {
  const { page } = app;
  const store = (RESULTS[profile.name] ||= {});
  await inject(page);
  if (o.edge) await page.evaluate((s, mainSel, h) => { const e = document.querySelector(s); const m = document.querySelector(mainSel); m.scrollTop += e.getBoundingClientRect().top - (h - 60); }, o.press, SEL.main, profile.h);
  else if (o.place) await place(page, o.press, o.place);
  // A control the user cannot see is one they scroll to first (setup, before the sampler starts).
  else if (!o.stay && await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.top < 0 || r.bottom > innerHeight; }, o.press)) await place(page, o.press, 300);
  const r = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, disabled: !!e.disabled }; }, o.press);
  if (!r) { step(`[${profile.name}] ${name}: target present (${o.press})`, !!o.optional, 'no element'); return null; }
  let x = Math.round(r.left + Math.min(r.width / 2, 40)); let y = Math.round(r.top + r.height / 2);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });     // hover first, so :hover is not read as a response
  await delay(150);
  // A person aims at where the control is NOW. If it moved during the hover, that
  // is noted: nothing should move a control you are about to press.
  const r2 = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect(); return { left: q.left, top: q.top, width: q.width, height: q.height }; }, o.press);
  if (r2 && Math.abs(r2.top - r.top) > 1) {
    note(`[${profile.name}] ${name}: the control moved ${Math.round(r2.top - r.top)} px while the pointer rested on it`);
    x = Math.round(r2.left + Math.min(r2.width / 2, 40)); y = Math.round(r2.top + r2.height / 2);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await delay(60);
  }
  await page.evaluate((cfg) => window.__hs.begin(cfg), { press: o.press, main: SEL.main, viewRoot: SEL.viewRoot, health: SEL.health, rows: SEL.rows, landmarks: SEL.landmarks, live: SEL.live, pointer: { x, y }, outcome: o.outcome || [] });
  await page.click(x, y, { settleMs: 20 });
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); const sh = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(SHOTS, `${profile.name}-${name}-during.png`), Buffer.from(sh.data, 'base64')); }
  if (o.until) await waitFor(page, o.until, name, o.untilTries || 600, ...(o.args || []));
  await delay(o.settle ?? 600);
  const raw = await page.evaluate(() => window.__hs.end());
  const actx = { ...o, reduced: !!profile.reduced, pressY: y, viewH: profile.h }; const a = analyse(raw, actx); o.snapWho = actx.snapWho;
  // outcome + overflow, measured after the settle
  const out = await page.evaluate((sels, pressY, healthSel) => {
    let found = null;
    for (const s of sels) { const e = document.querySelector(s); if (e) { const r = e.getBoundingClientRect(); if (r.height > 0) { found = r; break; } } }
    const h = document.querySelector(healthSel); const hr = h ? h.getBoundingClientRect() : null;
    let over = 0;
    if (h) for (const e of h.querySelectorAll('*')) {
      let skip = false; for (let p = e.parentElement; p && p !== h; p = p.parentElement) { const ov = getComputedStyle(p).overflowX; if (ov !== 'visible') { skip = true; break; } }
      if (skip) continue; const r = e.getBoundingClientRect(); if (r.width > 0 && r.right - hr.right > over) { over = r.right - hr.right; }
    }
    over = Math.max(over, document.documentElement.scrollWidth - innerWidth);
    if (!found) return { found: false, over: Math.round(over) };
    const inView = found.bottom > 0 && found.top < innerHeight;
    const dist = found.top > pressY ? found.top - pressY : found.bottom < pressY ? pressY - found.bottom : 0;
    return { found: true, inView, dist: Math.round(dist), top: Math.round(found.top), over: Math.round(over) };
  }, o.outcome || [], y, SEL.health);
  // Seen at any moment during the action (a held row has gone by now), else now.
  if (a.m.outcomeOffscreen === undefined) a.m.outcomeOffscreen = (out.found && out.inView) ? 0 : 1;
  if (a.m.outcomeDistancePx === undefined) a.m.outcomeDistancePx = out.found ? out.dist : 9999;
  a.m.overflowPx = out.over;
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); const sh = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(SHOTS, `${profile.name}-${name}-after.png`), Buffer.from(sh.data, 'base64')); }
  store[name] = a.m; (DETAIL[profile.name] ||= {})[name] = { goneMs: a.goneMs, focusEnd: a.focusEnd, outcome: out, lost: a.lostNames.slice(0, 6), rootLost: a.rootLost };
  console.log(`    ${name.padEnd(18)} ${Object.entries(a.m).map(([k, v]) => k.replace(/Px$/, '').replace(/^outcome/, 'out') + '=' + v).join(' ')}  focus=${a.focusEnd.slice(0, 24)}${a.m.aboveMovePx > 1 ? ' above:' + a.aboveWho : ''}${a.m.belowSnapPx ? ' snap:' + o.snapWho : ''}`);
  return a.m;
}
async function openFoldsOn(page, keys) {
  await page.evaluate((ks) => { for (const k of ks) { const d = document.querySelector('[data-group-key="' + k + '"]'); if (d) d.open = true; } }, keys);
  await delay(200);
}
// the n-th pair card (1-based) that still has an enabled Preview, as its data-sem-key
const pickCard = (page, n) => page.evaluate((cardSel, n) => {
  const cards = [...document.querySelectorAll(cardSel)].filter((c) => { const b = c.querySelector('[data-sem-action="preview"]'); return b && !b.disabled; });
  return cards[n - 1] ? cards[n - 1].dataset.semKey : null;
}, SEL.card, n);
// Serialised and called in the page with `args`: it must take the selector itself.
const exists = (s) => !!document.querySelector(s);

// ═══ 9. THE SCENARIOS ═══════════════════════════════════════════════════════
const ON_CONFIRM = '.dm-confirm-card .dm-row-done';
const HAS = (s) => `!!document.querySelector(${JSON.stringify(s)})`;
async function scenarios(app, profile) {
  const { page } = app;
  const run = (id) => !ONLY || ONLY.includes(id);
  const sub = (id) => !profile.only || profile.only.includes(id);
  const OUT_CONFIRM = [SEL.confirmCard];
  const ON_PLAN = '.dm-plan-card .dm-row-done';
  const HELD = 1900;   // held about a second, then collapsed, then a little
  if (profile.overflowOnly) {
    await openDomain(app, 'h4');
    await act(app, profile, 'find-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
    await act(app, profile, 'find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.card], untilTries: 800, settle: 1800, runs: true });
    return;
  }
  // S1 — Fix all: free repairs run on the press; a deleting one asks first.
  if (run('S1') && sub('S1')) {
    await openDomain(app, 'h1'); await openFoldsOn(page, FOLDS);
    for (const key of ['missingBacklinks', 'folderPrefixLinks']) {
      const fb = SEL.fixAll(key);
      if (!(await page.evaluate((s) => !!document.querySelector(s), fb))) { note(`[${profile.name}] no Fix all in "${key}" on this data`); continue; }
      const m = await act(app, profile, `fixall-${key}`, { press: fb, place: 500, outcome: [SEL.done, SEL.outcome], settle: HELD, runs: true });
      step(`[${profile.name}] a free Fix all opens no question`, m && !(await page.evaluate((s) => !!document.querySelector(s), SEL.confirmCard)));
      await openFoldsOn(page, FOLDS);
    }
    for (const key of ['crossFolderDupes', 'hyphenVariants']) {
      const fb = SEL.fixAll(key);
      if (!(await page.evaluate((s) => !!document.querySelector(s), fb))) { note(`[${profile.name}] no Fix all in "${key}" on this data`); continue; }
      await act(app, profile, `fixall-${key}-press`, { press: fb, place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmNo], settle: 300 });
      const f = await page.evaluate(() => document.activeElement && document.activeElement.id);
      step(`[${profile.name}] a deleting Fix all asks, and focus lands on Cancel`, f === 'dm-confirm-no', f);
      await act(app, profile, `fixall-${key}-confirm`, { press: SEL.confirmYes, outcome: [ON_CONFIRM], settle: HELD + 600, runs: true });
    }
    await delay(600);
    if (await page.evaluate((s) => !!document.querySelector(s), SEL.fixSafe)) {
      const m = await act(app, profile, 'fixsafe-free', { press: SEL.fixSafe, place: 300, outcome: [SEL.fixSafe, SEL.outcome], settle: HELD, runs: true });
      step(`[${profile.name}] Fix N safe issues with nothing to delete opens no question`, m && !(await page.evaluate((s) => !!document.querySelector(s), SEL.confirmCard)));
    }
  }
  // S2 — Fix N safe issues that deletes pages asks; Rescan moves nothing.
  if (run('S2') && sub('S2')) {
    await openDomain(app, 'h2'); await openFoldsOn(page, ['orphans', 'brokenLinks']);
    await act(app, profile, 'rescan-1', { press: SEL.rescan, place: 200, outcome: [SEL.rescan], settle: 1000, runs: true });
    await act(app, profile, 'fixsafe-press', { press: SEL.fixSafe, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 400 });
    await act(app, profile, 'fixsafe-confirm', { press: SEL.confirmYes, outcome: [ON_CONFIRM], settle: HELD, runs: true });
  }
  // S5 — Dismiss, Restore
  if (run('S5') && sub('S5')) {
    await openDomain(app, 'h5'); await openFoldsOn(page, ['orphans', 'brokenLinks']);
    const rows = () => page.evaluate((s) => document.querySelectorAll(s).length, `${SEL.fold('orphans')} .dm-issue-row`);
    const before = await rows();
    await act(app, profile, 'dismiss', { press: SEL.dismissIn('orphans'), place: 450, outcome: [SEL.done], settle: HELD, runs: true });
    // Nothing here may depend on an event that reduced motion never fires.
    step(`[${profile.name}] the row has really left, and left nothing behind`, (await rows()) === before - 1 && await page.evaluate(() => !document.querySelector('[data-row-leaving]')), String(await rows()));
    await openFoldsOn(page, ['dismissed']); await delay(500);
    await act(app, profile, 'restore', { press: SEL.restore, place: 450, outcome: [SEL.done], settle: HELD, runs: true });
  }
  // S6 — the paid plans and the free rebuild: Rescue, Apply plan, Rebuild index.
  if (run('S6') && sub('S6')) {
    await openDomain(app, 'h6');
    await act(app, profile, 'rescue-press', { press: SEL.rescue, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300 });
    await act(app, profile, 'rescue-run', { press: SEL.confirmYes, outcome: [SEL.plan, SEL.outcome], until: exists, args: [SEL.planApply], untilTries: 600, settle: 500, runs: true, settled: true });
    await act(app, profile, 'apply-plan', { press: SEL.planApply, outcome: [ON_PLAN], until: exists, args: [SEL.outcome], untilTries: 600, settle: 1200, runs: true });
    await delay(800);
    await act(app, profile, 'rebuild-press', { press: SEL.indexPlan, place: 300, outcome: [SEL.plan, SEL.outcome], until: exists, args: [SEL.planApply], untilTries: 400, settle: 400, runs: true });
    await act(app, profile, 'rebuild-apply', { press: SEL.planApply, outcome: [ON_PLAN], until: exists, args: [SEL.outcome], untilTries: 400, settle: 1200, runs: true });
  }
  // S7 — at the very end of the page, shrinking must not clamp the scroll.
  if (run('S7') && sub('S7')) {
    await openDomain(app, 'h7'); await openFoldsOn(page, ['orphans']); await delay(200);
    const toEnd = () => page.evaluate((m) => { const e = document.querySelector(m); e.scrollTop = e.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); }, SEL.main);
    await toEnd(); await delay(150);
    await act(app, profile, 'end-dismiss', { press: `${SEL.fold('orphans')} .dm-issue-row:last-child .dm-dismiss-btn`, outcome: [SEL.done], settle: HELD, runs: true, stay: true });
    await toEnd(); await delay(150);
    await act(app, profile, 'end-fixall', { press: SEL.fixAll('folderPrefixLinks'), outcome: [SEL.done], settle: HELD, runs: true, stay: true });
    // Pressed at the viewport's bottom edge: the next control is off-screen, and
    // moving focus to it must not scroll the page there.
    await openFoldsOn(page, ['orphans']); await delay(150);
    await act(app, profile, 'edge-dismiss', { press: `${SEL.fold('orphans')} .dm-dismiss-btn`, edge: true, outcome: [SEL.done], settle: HELD, runs: true });
    await toEnd(); await delay(150);
    const floor = await page.evaluate((m) => document.querySelector(m).style.getPropertyValue('--dm-health-floor'), SEL.main);
    note(`[${profile.name}] floor under the section after the end-of-page repairs: ${floor || '0'}`);
    const after = await page.evaluate((m) => { const e = document.querySelector(m); e.scrollTop = 0; return e.scrollTop; }, SEL.main);
    await delay(150);
    const floor2 = await page.evaluate((m) => document.querySelector(m).style.getPropertyValue('--dm-health-floor'), SEL.main);
    step(`[${profile.name}] the floor gives its space back when you scroll up`, after === 0 && (floor2 === '' || floor2 === '0px'), floor2);
  }
  // S8 — a failure stays on the row, with Try again, until you act.
  if (run('S8') && sub('S8')) {
    await openDomain(app, 'h8'); await openFoldsOn(page, FOLDS);
    await page.evaluate(() => { const real = window.fetch; window.__realFetch = real; window.fetch = (u, o) => (/\/fix$/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ error: 'The disk went away' }), { status: 500, headers: { 'content-type': 'application/json' } })) : real(u, o)); });
    const fb = SEL.fixAll('missingBacklinks');
    await act(app, profile, 'failure', { press: fb, place: 400, outcome: [SEL.outcome], until: exists, args: [SEL.retry], settle: 300, runs: true });
    await delay(5000);
    const stays = await page.evaluate((o, r) => { const e = document.querySelector(o); const b = document.querySelector(r); return e && b ? { text: e.innerText, top: e.getBoundingClientRect().top } : null; }, SEL.outcome, SEL.retry);
    step(`[${profile.name}] the failure is still on the row 5 s later, with Try again`, !!stays && /could not repair/i.test(stays.text), JSON.stringify(stays));
    const row = await page.evaluate((s, o) => { const g = document.querySelector(s); const e = document.querySelector(o); return g && e && g.contains(e) || (g && g.nextElementSibling === e); }, SEL.fold('missingBacklinks'), SEL.outcome);
    step(`[${profile.name}] it sits on the row that failed`, !!row);
    await page.evaluate(() => { window.fetch = window.__realFetch; });
    await act(app, profile, 'try-again', { press: SEL.retry, outcome: [SEL.done], settle: HELD, runs: false });
    step(`[${profile.name}] Try again clears it and repairs`, await page.evaluate((o) => !document.querySelector(o), SEL.outcome));
  }
  // S10 — a row above the press is settled by the reading that follows it. It must
  // not move what was pressed: it stays, marked, until the user scrolls.
  if (run('S10') && sub('S10')) {
    await openDomain(app, 'h10'); await openFoldsOn(page, ['orphans', 'missingBacklinks']); await delay(200);
    rmSync(path.join(app.ws.domains, 'h10', 'wiki', 'concepts', 'gartner.md'));
    await act(app, profile, 'row-above-settled', { press: SEL.fixAll('missingBacklinks'), place: 500, outcome: [SEL.done], settle: HELD, runs: true });
    const waiting = await page.evaluate(() => { const e = document.querySelector('[data-row-deferred]'); return e ? e.innerText : null; });
    step(`[${profile.name}] the settled row above the press stays and says so`, !!waiting && /Resolved/.test(waiting), String(waiting));
    await page.evaluate((m) => { document.querySelector(m).scrollTop -= 200; }, SEL.main); await delay(600);
    step(`[${profile.name}] and it goes when you scroll`, await page.evaluate(() => !document.querySelector('[data-row-deferred]')));
  }
  // S4 — duplicate pages: find, next, preview, flip, merge, skip, batch
  if (run('S4') && sub('S4')) {
    await openDomain(app, 'h4');
    await act(app, profile, 'find-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
    await act(app, profile, 'find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.card], untilTries: 800, settle: 1800, runs: true });
    const ncards = await page.evaluate((s) => document.querySelectorAll(s).length, SEL.card);
    note(`[${profile.name}] pair cards after the first scan: ${ncards}`);
    if (await page.evaluate((s) => !!document.querySelector(s), SEL.checkNext)) {
      await act(app, profile, 'next-press', { press: SEL.checkNext, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300 });
      const before = ncards;
      await act(app, profile, 'next-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: (s, n) => document.querySelectorAll(s).length > n || !document.querySelector('#dm-confirm-yes'), args: [SEL.card, before], untilTries: 800, settle: 1800, runs: true });
    } else step(`[${profile.name}] "Check the next" is offered after a partial scan`, false, 'button absent');
    const keyA = await pickCard(page, 2);
    if (keyA) {
      const pv = SEL.cardBtn(keyA, 'preview'); const card = `.dm-sem-card[data-sem-key="${keyA}"]`;
      await act(app, profile, 'preview', { press: pv, place: 300, outcome: [`${card} ${SEL.preview}`], until: exists, args: [SEL.preview], settle: 400, decision: true, runs: true });
      await act(app, profile, 'flip', { press: SEL.cardBtn(keyA, 'flip'), outcome: [card, SEL.card], settle: 400, decision: true });
      const keyA2 = await page.evaluate((cs) => { const c = [...document.querySelectorAll(cs)].find((x) => x.querySelector('[data-sem-action="preview"]:not([disabled])')); return c ? c.dataset.semKey : null; }, SEL.card);
      const keyM = keyA2 || keyA;
      await act(app, profile, 'preview-again', { press: SEL.cardBtn(keyM, 'preview'), place: 300, outcome: [SEL.preview], until: exists, args: [SEL.preview], settle: 400, decision: true, runs: true });
      await act(app, profile, 'merge-one', { press: SEL.cardBtn(keyM, 'merge'), place: 400, outcome: [SEL.done], settle: HELD + 800, runs: true });
    } else step(`[${profile.name}] a pair card with an enabled Preview exists`, false, 'none');
    const keyS = await pickCard(page, 3);
    if (keyS) await act(app, profile, 'skip-one', { press: SEL.cardBtn(keyS, 'skip'), place: 420, outcome: [SEL.done], settle: HELD + 400, runs: true });
    else step(`[${profile.name}] a pair card to Skip exists`, false, 'none');
    await act(app, profile, 'batch-press', { press: SEL.batchMerge, place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, optional: true });
    await act(app, profile, 'batch-confirm', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.outcome], settle: 3000, optional: true, runs: true });
  }
  // S9 — real size: thousands of pages, hundreds of pairs.
  if (run('S9') && profile.big) {
    await openDomain(app, 'hbig'); await openFoldsOn(page, ['orphans', 'missingBacklinks']);
    const pages = await page.evaluate(() => (document.querySelector('.dm-health') ? 1 : 0));
    step(`[${profile.name}] the big domain opens`, pages === 1);
    await act(app, profile, 'big-dismiss', { press: SEL.dismissIn('orphans'), place: 450, outcome: [SEL.done], settle: HELD, runs: true });
    await act(app, profile, 'big-find-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: (a, b) => !!document.querySelector(a) || !!document.querySelector(b), args: [SEL.confirmYes, SEL.outcome], untilTries: 6000, settle: 300, runs: true });
    note(`[${profile.name}] after pressing Find: ${await page.evaluate(() => { const o = document.querySelector('.dm-health .dm-outcome'); return o ? o.innerText : 'no outcome line'; })}`);
    await act(app, profile, 'big-find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.card], untilTries: 2400, settle: 1800, runs: true });
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, SEL.card);
    const key = await pickCard(page, 2);
    step(`[${profile.name}] the big scan lists hundreds of pairs, the first page of them on screen`, n === 50 && !!key && await page.evaluate(() => /[1-9]\d\d likely duplicate/.test(document.querySelector('.dm-plan-card[data-row-key="scan-results"]').innerText)), String(n));
    if (key) {
      await act(app, profile, 'big-preview', { press: SEL.cardBtn(key, 'preview'), place: 300, outcome: [SEL.preview], until: exists, args: [SEL.preview], untilTries: 800, settle: 400, runs: true });
      await act(app, profile, 'big-merge', { press: SEL.cardBtn(key, 'merge'), place: 400, outcome: [SEL.done], settle: HELD + 2000, runs: true });
    }
  }
}

// ═══ 10. SAMPLER CONTROLS — the harness must be able to fail ════════════════
async function samplerControls(app) {
  const { page, origin } = app;
  await page.navigate(origin + '/api/version');
  const html = `<style>body{margin:0}#main{height:700px;overflow:auto}.dm-group{height:80px;border:1px solid #888}.cur-section-hd{height:40px}</style>
    <div id="main"><div id="view-root"><div class="dm-health"><h2 class="cur-section-hd">Title</h2>
    <div class="dm-group" data-group-key="g1"><button id="ctl" data-k="ctl">Go</button></div><div class="dm-group" data-group-key="g2">below</div></div></div></div>`;
  const cfg = { press: '#ctl', main: SEL.main, viewRoot: SEL.viewRoot, health: SEL.health, rows: SEL.rows, landmarks: SEL.landmarks, live: SEL.live, outcome: [] };
  async function trial(behaviour) {
    await page.evaluate((h, b) => {
      document.body.innerHTML = h; const btn = document.getElementById('ctl');
      btn.addEventListener('click', () => setTimeout(() => {
        if (b === 'jump') { const sp = document.createElement('div'); sp.style.height = '100px'; document.querySelector('.dm-health').prepend(sp); }
        if (b === 'replace') { const hh = document.querySelector('.dm-health'); hh.outerHTML = hh.outerHTML; }
        if (b === 'text') btn.textContent = 'Going…';
      }, 30));
    }, html, behaviour);
    await inject(page);
    const r = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.left + 5), y: Math.round(r.top + 5) }; }, '#ctl');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); await delay(100);
    await page.evaluate((c) => window.__hs.begin(c), { ...cfg, pointer: r });
    await page.click(r.x, r.y, { settleMs: 20 }); await delay(500);
    return analyse(await page.evaluate(() => window.__hs.end()), { pressY: r.y, viewH: 900 });
  }
  const none = await trial('none'); const text = await trial('text'); const jump = await trial('jump'); const repl = await trial('replace');
  step('control: a still page reports no movement and no change', none.m.aboveMovePx === 0 && none.m.changeMs === 9999 && none.m.focusBody === 0, JSON.stringify({ above: none.m.aboveMovePx, change: none.m.changeMs, body: none.m.focusBody }));
  step('control: a text change on the pressed control is seen within 100 ms, nothing moves', text.m.changeMs <= 100 && text.m.aboveMovePx === 0 && text.m.focusBody === 0, `changeMs=${text.m.changeMs} above=${text.m.aboveMovePx}`);
  step('control: a 100 px jump above the row is measured as >= 99 px', jump.m.aboveMovePx >= 99 && jump.m.aboveMovePx <= 101, `aboveMovePx=${jump.m.aboveMovePx}`);
  step('control: replacing the whole section loses node identity and drops focus to body', repl.m.identityLost >= 1 && repl.m.focusBody === 1, `identityLost=${repl.m.identityLost} focusBody=${repl.m.focusBody}`);
  step('control: a landmark below jumping 100 px in one frame is a snap', jump.m.belowSnapPx === 0 || jump.m.belowSnapPx >= 99, `belowSnapPx=${jump.m.belowSnapPx}`);
  // the judge itself: a metric over its threshold is refused
  step('control: the judge refuses 154 px against a 1 px requirement and accepts 0', !(154 <= REQUIRED.aboveMovePx) && (0 <= REQUIRED.aboveMovePx));
}

// ═══ 11. JUDGING ════════════════════════════════════════════════════════════
function judge() {
  const required = STAGES[STAGE];
  let baseline = null;
  if (!RECORD) { try { baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { /* handled below */ } }
  if (!RECORD && !baseline) { step('a baseline file exists (run with --record-baseline)', false, BASELINE_FILE); return; }
  if (STAGE !== 'baseline') baseline = baseline || { profiles: {} };
  let better = 0; const judged = [];
  for (const [prof, actions] of Object.entries(RESULTS)) {
    for (const [action, metrics] of Object.entries(actions)) {
      for (const [mt, v] of Object.entries(metrics)) {
        if (INFO.includes(mt)) continue;
        const req = required[mt];
        const must = req === 'all' || (Array.isArray(req) && req.includes(action));
        const label = `[${prof}] ${action} · ${mt} = ${v}`;
        if (must) { judged.push(step(label + ` (required <= ${REQUIRED[mt]})`, v <= REQUIRED[mt])); continue; }
        if (RECORD) continue;
        if (mt === 'cardHeightDeltaPx') continue;   // the review desk's measure: recorded, judged from its own stage
        const b = baseline.profiles?.[prof]?.[action]?.[mt];
        if (b === undefined) { judged.push(step(label + ' (no baseline entry: record again)', false)); continue; }
        const ok = withinBaseline(mt, v, b);
        if (v < b) better++;
        if (!ok) step(label + ` — WORSE than the baseline ${b}`, false); else passed++;
        judged.push(ok);
      }
    }
  }
  if (!RECORD) console.log(`  ${judged.length} metric comparisons against ${path.basename(BASELINE_FILE)}; ${better} better than baseline`);
}

// ═══ 12. MAIN ═══════════════════════════════════════════════════════════════
const apps = [];
try {
  let blocked = [];
  const first = ALL_PROFILES[PROFILE_NAMES[0]] || ALL_PROFILES['1280'];
  console.log('\n● sampler controls'); {
    const app = await startApp(first); apps.push(app);
    try { await samplerControls(app); } finally { await app.stop(); }
  }
  for (const pn of PROFILE_NAMES) {
    const profile = ALL_PROFILES[pn]; if (!profile) { console.log('unknown profile ' + pn); continue; }
    console.log(`\n● profile ${profile.name} (${profile.w}x${profile.h}${profile.reduced ? ', reduced motion' : ''}${profile.overflowOnly ? ', overflow only' : ''})`);
    const app = await startApp(profile); apps.push(app);
    try { await scenarios(app, profile); }
    catch (e) { step(`[${profile.name}] scenario ran to the end`, false, e.stack); }
    finally {
      await app.stop();
      try { blocked.push(...readFileSync(app.stubLog, 'utf8').split('\n').filter((l) => l.includes('blocked'))); } catch { /* none */ }
    }
  }
  console.log('\n● judging, stage "' + STAGE + '"');
  if (RECORD) {
    if (MERGE) {
      try {
        const old = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).profiles || {};
        for (const [pf, acts] of Object.entries(old)) for (const [ac, ms] of Object.entries(acts)) for (const [mt, v] of Object.entries(ms)) {
          const cur = ((RESULTS[pf] ||= {})[ac] ||= {}); cur[mt] = cur[mt] === undefined ? v : Math.max(cur[mt], v);
        }
      } catch { /* first recording */ }
    }
    const out = { _about: 'Recorded by scripts/e2e-wiki-health.mjs --record-baseline on the build before the Wiki health redesign. Lower is better for every metric. 9999 means never.', stage: 'baseline', profiles: RESULTS };
    writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 1) + '\n');
    step('baseline written', true, BASELINE_FILE);
  }
  judge();
  step('no request left the machine except to the local stub (hosts refused: ' + blocked.length + ')', true, blocked.length ? blocked.slice(0, 3).join(' ') : 'none');
  step('no server or browser left running', apps.every((a) => a.server.exitCode !== null || a.server.signalCode !== null));
  const fpAfter = fingerprint();
  step('the real config files are byte-identical before and after', JSON.stringify(fpBefore) === JSON.stringify(fpAfter));
} catch (e) { step('suite ran to the end', false, e.stack); }
finally { for (const a of apps) { try { await a.stop(); } catch { /* */ } try { a.cleanup(); } catch { /* */ } } }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Wiki health e2e FAILED'); process.exit(1); }
console.log('Wiki health e2e OK');
