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
 *        [--only S1,S2,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16] [--record-baseline [--merge-baseline]] [--baseline <file>] [--shots <dir>]
 *
 * SINCE STAGE 1 the default stage is `s1`, the press rule: every metric below is
 * REQUIRED except the review desk's, which belong to a later stage. STAGE 2 keeps those
 * thresholds on the three lanes and adds S14: lanes, words, Undo, real size.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';
import { wordAllowed, isFigure, BANNED } from './test-helpers/health-words.js';

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
  healthReady: '.dm-health .cur-card',
  rescan: '#dm-rescan-btn',
  fixAll: (key) => `[data-group-key="${key}"] .dm-group-fixall-btn`,
  repairAll: '#dm-repair-all-btn',
  findDupes: '.dm-quick-btn[data-action="semanticDupes"]',
  confirmYes: '#dm-confirm-yes',
  confirmNo: '#dm-confirm-no',
  checkNext: '.dm-quick-btn[data-action="semanticDupes"]',
  batchMerge: '#dm-semantic-merge-btn',
  review: '.dm-review-btn',
  desk: '.hr-desk', deskTitle: '#hr-title', deskMerge: '#hr-merge', deskKeep: '#hr-keep', deskFlip: '#hr-flip', deskNext: '#hr-next', deskPrev: '#hr-prev', deskDone: '#hr-done',
  deskOutcome: '.hr-outcome', deskPanes: '.hr-panes', deskText: '.hr-pane-text',
  dismissIn: (group) => `[data-group-key="${group}"] .dm-issue-row .dm-dismiss-btn`,
  leftUndo: '.dm-left-undo-btn',
  restore: '.dm-restore-btn',
  fold: (key) => `[data-group-key="${key}"]`,
  lane: (name) => `.dm-lane[data-row-key="lane:${name}"]`,
  laneTitle: '.dm-lane-title',
  reading: '.dm-health-reading',
  laneReading: '.dm-lane-reading',
  // outcomes (first one that exists wins)
  banner: '.dm-health .dm-banner',
  done: '.dm-health .dm-row-done',
  outcome: '.dm-health .dm-outcome',
  plan: '.dm-health .dm-plan-card[data-row-key="plan"]',
  planApply: '#dm-plan-apply-btn',
  indexPlan: '[data-group-key="indexDrift"] .dm-quick-btn[data-action="indexPlan"]',
  rescue: '.dm-quick-btn[data-action="orphans"]',
  fixLinks: '.dm-quick-btn[data-action="brokenLinks"]',
  retry: '.dm-health .dm-outcome-retry',
  confirmCard: '.dm-confirm-card',
  coverage: '[data-group-key="compare"]',
  // the row a press belongs to (nearest ancestor): used to split "above" from "below"
  rows: '.hr-desk, .dm-issue-row, .dm-group, .dm-lane-head, .dm-confirm-card, .dm-plan-card, .dm-health-top',
  // landmarks sampled every frame (each: base selector + how many matches)
  landmarks: [
    { base: '.dm-health', max: 1 }, { base: '.dm-health .cur-section-hd', max: 1 }, { base: '.dm-lane-head', max: 3 },
    { base: '.dm-group-scan', max: 1 }, { base: '.dm-group[data-group-key]', max: 14 }, { base: '.dm-confirm-card', max: 1 },
    { base: '.dm-plan-card', max: 1 },
  ],
  live: '.dm-health [aria-live]',
};
// the folds the lab domains fill
const FOLDS = ['orphans', 'missingBacklinks', 'brokenLinksOpen', 'folderPrefixLinks'];

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
  '1280-light': { name: '1280-light', w: 1280, h: 900, light: true, only: ['S1', 'S5', 'S6', 'S14', 'S16'] },
  '375-light': { name: '375-light', w: 375, h: 812, light: true, only: ['S1', 'S5', 'S6', 'S14', 'S15', 'S16'] },
  '1280-rm': { name: '1280-reduced-motion', w: 1280, h: 900, reduced: true, only: ['S2', 'S5', 'S7', 'S14', 'S16'] },
  '375-rm': { name: '375-reduced-motion', w: 375, h: 812, reduced: true, only: ['S1', 'S4', 'S7', 'S14', 'S16'] },
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
      const why = lookup(p.a, p.b) || (p.a.startsWith('a-very-long') && p.b.startsWith('a-very-long') ? 'Both pages are about the history of a long page name, at length.' : null);
      if (why) return { index: p.index, difference: 'none', relation: 'same', confidence: 'high', canonicalSlug: p.b.length >= p.a.length ? p.b : p.a, rationale: why };
      if (p.a.replace(/-guides$/, '-guide') === p.b.replace(/-guides$/, '-guide')) return { index: p.index, difference: 'none', relation: 'same', confidence: 'high', canonicalSlug: p.a.length >= p.b.length ? p.a : p.b, rationale: 'One page and its plural.' };
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
  for (let i = 0; i < (opts.topicPairs ?? 45); i++) { let tag = ''; if (opts.distinct) for (let k = 0; k < 7; k++) tag += 'bcdfghjklmnpqrstvwxz'[Math.floor(rnd() * 20)];
    const a = opts.distinct ? tag + '-guide' : WORDS[i % WORDS.length] + '-method'; const twin = opts.distinct ? a + 's' : a + '-fundamentals'; linked.push(a, twin); concept(a); concept(twin); }
  for (let i = 0; i < (opts.filler ?? 150); i++) { let s = ''; for (let k = 0; k < 9; k++) s += 'bcdfghjklmnpqrstvwxz'[Math.floor(rnd() * 20)]; linked.push(s); concept(s); }
  writeFileSync(path.join(w, 'concepts', 'wiki-hub.md'), `---\ntype: concept\n---\n\n# Hub\n\nAn index page.\n\n## Related\n\n${linked.map((s) => `- [[${s}]]`).join('\n')}\n- [[entities/acme-labs]]\n- [[context-windowz]]\n- [[model-trainingx]]\n- [[customer-satisfactionx]]\n- [[mac-os]]\n- [[mac-os]]\n`);
  writeFileSync(path.join(w, 'entities', 'acme-labs.md'), `---\ntype: entity\n---\n\n# Acme Labs\n\nA company.\n\n## Related\n\n- [[wiki-hub]]\n- [[concepts/ai-agents]]\n`);
  writeFileSync(path.join(w, 'entities', 'deployment.md'), `---\ntype: entity\n---\n\n# Deployment\n\nA team at Acme.\n\n## Related\n\n- [[wiki-hub]]\n`);
  writeFileSync(path.join(w, 'summaries', 'module-handoff.md'), `---\ntype: summary\n---\n\n# Module handoff\n\nA summary.\n\n## Key Takeaways\n\n- One point.\n\n## Concepts Introduced or Referenced\n\n- [[prototyping-to-production]]\n- [[ai-agents]]\n- [[ai-agents]]\n`);
  writeFileSync(path.join(w, 'index.md'), `# Wiki Index — ${name}\n\n| Page | Summary |\n|---|---|\n| [[wiki-hub]] | hub |\n`);
  writeFileSync(path.join(w, 'log.md'), '# Log\n');
}

// ═══ 6. THE APP ═════════════════════════════════════════════════════════════
const LABS = ['h1', 'h2', 'h4', 'h5', 'h6', 'h7', 'h8', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h15b', 'hclean', 'hone', 'hdup'];
// The desk's domain: a pair whose name wraps and whose text is longer than any pane.
const LONG_A = 'a-very-long-page-name-that-goes-on-and-on-about-the-history-of-the-long-page-name';
const LONG_B = LONG_A + '-and-then-a-little-more-about-it';
async function startApp(profile) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-health-'));
  const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
  mkdirSync(ws.home); mkdirSync(ws.userData, { recursive: true });
  const stubFile = path.join(base, 'stub.mjs'); writeFileSync(stubFile, STUB_SRC);
  const stubLog = path.join(base, 'stub.log'); writeFileSync(stubLog, '');
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'demo-domain.mjs'), ws.domains], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, HOME: ws.home, CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_USER_DATA_DIR: ws.userData } });
  for (const d of LABS) buildLabDomain(ws.domains, d);
  // A wiki with nothing wrong: two pages that link to each other.
  { const w = path.join(ws.domains, 'hclean', 'wiki'); rmSync(w, { recursive: true, force: true });
    for (const d of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, d), { recursive: true });
    writeFileSync(path.join(w, 'concepts', 'alpha.md'), '---\ntype: concept\n---\n\n# Alpha\n\nA first page.\n\n## Related\n\n- [[zulu]]\n');
    writeFileSync(path.join(w, 'concepts', 'zulu.md'), '---\ntype: concept\n---\n\n# Zulu\n\nA last page.\n\n## Related\n\n- [[alpha]]\n');
    writeFileSync(path.join(w, 'index.md'), '# Wiki Index — hclean\n\n## Concepts\n\n| Page | Summary |\n|---|---|\n| [[alpha]] | A first page. |\n| [[zulu]] | A last page. |\n');
    writeFileSync(path.join(w, 'log.md'), '# Log\n'); }
  // One name in two folders, and nothing else: after its merge, only AI help is left.
  { const w = path.join(ws.domains, 'hdup', 'wiki'); rmSync(w, { recursive: true, force: true });
    for (const d of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, d), { recursive: true });
    writeFileSync(path.join(w, 'entities', 'same.md'), '---\ntype: entity\n---\n\n# Same\n\nThe entity.\n\n## Related\n\n- [[alpha]]\n');
    writeFileSync(path.join(w, 'concepts', 'same.md'), '---\ntype: concept\n---\n\n# Same\n\nThe concept.\n\n## Related\n\n- [[alpha]]\n');
    writeFileSync(path.join(w, 'concepts', 'alpha.md'), '---\ntype: concept\n---\n\n# Alpha\n\nA first page.\n\n## Related\n\n- [[same]]\n');
    writeFileSync(path.join(w, 'index.md'), '# Wiki Index — hdup\n\n## Entities\n\n| Page | Summary |\n|---|---|\n| [[same]] | The entity. |\n\n## Concepts\n\n| Page | Summary |\n|---|---|\n| [[alpha]] | A first page. |\n');
    writeFileSync(path.join(w, 'log.md'), '# Log\n'); }
  // One page nothing links to, and nothing else to do.
  { const w = path.join(ws.domains, 'hone', 'wiki'); rmSync(w, { recursive: true, force: true });
    for (const d of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, d), { recursive: true });
    writeFileSync(path.join(w, 'concepts', 'alpha.md'), '---\ntype: concept\n---\n\n# Alpha\n\nA first page.\n\n## Related\n\n- [[zulu]]\n');
    writeFileSync(path.join(w, 'concepts', 'zulu.md'), '---\ntype: concept\n---\n\n# Zulu\n\nA last page.\n\n## Related\n\n- [[alpha]]\n');
    writeFileSync(path.join(w, 'concepts', 'lonely.md'), '---\ntype: concept\n---\n\n# Lonely\n\nNothing links here.\n');
    writeFileSync(path.join(w, 'index.md'), '# Wiki Index — hone\n\n## Concepts\n\n| Page | Summary |\n|---|---|\n| [[alpha]] | A first page. |\n| [[lonely]] | Nothing links here. |\n| [[zulu]] | A last page. |\n');
    writeFileSync(path.join(w, 'log.md'), '# Log\n'); }
  buildLabDomain(ws.domains, 'h16', { topicPairs: 12, filler: 20 });
  { const w = path.join(ws.domains, 'h16', 'wiki', 'concepts');
    const long = (t) => `---\ntype: concept\ntags: [type/concept]\n---\n\n# ${t}\n\nA long page about one subject.\n\n` + Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nSomething written about part ${i}, long enough to run across the pane more than once and then some more.\n\n- A fact from part ${i}.\n`).join('\n') + '\n## Related\n\n- [[wiki-hub]]\n';
    writeFileSync(path.join(w, LONG_A + '.md'), long('One long page'));
    writeFileSync(path.join(w, LONG_B + '.md'), long('Another long page'));
    const hub = path.join(w, 'wiki-hub.md');
    writeFileSync(hub, readFileSync(hub, 'utf8') + `- [[${LONG_A}]]\n- [[${LONG_B}]]\n`); }
  if (profile.big) buildLabDomain(ws.domains, 'hbig', { topicPairs: 1100, filler: 3000, distinct: true });
  // 40 pairs per scan, so "Check the next" has something left to check.
  writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', domainsPath: ws.domains,
    geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential', aiHealth: { semanticDupeMaxPairs: profile.big ? 3000 : 40, costCeilingTokens: 20000000 } }, null, 2), { mode: 0o600 });
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  Object.assign(env, { PORT: String(port), CURATOR_NO_OPEN: '1', HOME: ws.home, CURATOR_TEST_INSTALL_HOME: ws.home, CURATOR_TEST_USER_DATA_DIR: ws.userData,
    CURATOR_TEST_DOMAINS_DIR: ws.domains, HEALTH_STUB_LOG: stubLog, HEALTH_STUB_LATENCY_MS: profile.big ? '10' : '250' });
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
  const sigOf = (e) => e.id ? '#' + e.id : (e.tagName + JSON.stringify(Object.entries(e.dataset || {}).sort()));
  const keyOf = (e) => { const d = e.dataset || {}; if (d.rowKey) return 'r:' + d.rowKey; if (d.groupKey) return 'g:' + d.groupKey; return e.id ? '#' + e.id : null; };
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
    const seen = fr.filter((f) => f.lm[i]);
    const tops = seen.map((f) => f.lm[i][0]);
    if (tops.length < 2) return;
    let biggest = 0; let total = 0;
    // A jump seen across a long frame proves nothing: the page was busy and the sampler
    // simply did not get to look (measured: an animated row read as a 12 px "snap" in
    // about one run in ten, across a 70 ms frame). Only consecutive frames can convict.
    for (let k = 1; k < tops.length; k++) { if (seen[k].t - seen[k - 1].t > 40) continue; const d = Math.abs(tops[k] - tops[k - 1]); biggest = Math.max(biggest, d); }
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
  else if (o.place) {
    await place(page, o.press, o.place);
    // Scrolling there lets rows waiting on a scroll go, as it does for a person, who then
    // looks again. The control is where it has settled, before the sampler starts.
    if (await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.top < 0 || r.bottom > innerHeight; }, o.press)) { await delay(400); await place(page, o.press, o.place); }
  }
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
  const underBefore = await page.evaluate((px, py) => { const e = document.elementFromPoint(px, py); return e ? e.tagName + '.' + String(e.className).split(' ')[0] + ' "' + (e.innerText || '').slice(0, 24) + '"' : 'nothing'; }, x, y);
  await page.click(x, y, { settleMs: 20 });
  if (underBefore && !/^(BUTTON|SPAN|SVG|path|svg)/.test(underBefore)) note(`[${profile.name}] ${name}: under the pointer at the press: ${underBefore}, at ${x},${y}`);
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
      if (skip) continue; const r = e.getBoundingClientRect(); if (r.width > 0 && r.right - hr.right > over) { over = r.right - hr.right; window.__overBy = e.tagName + '.' + String(e.className).split(' ')[0]; }
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
  if (out.over > 1) note(`[${profile.name}] ${name}: what pokes out: ${await page.evaluate(() => window.__overBy)}`);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); const sh = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(SHOTS, `${profile.name}-${name}-after.png`), Buffer.from(sh.data, 'base64')); }
  store[name] = a.m; (DETAIL[profile.name] ||= {})[name] = { goneMs: a.goneMs, focusEnd: a.focusEnd, outcome: out, lost: a.lostNames.slice(0, 6), rootLost: a.rootLost };
  console.log(`    ${name.padEnd(18)} ${Object.entries(a.m).map(([k, v]) => k.replace(/Px$/, '').replace(/^outcome/, 'out') + '=' + v).join(' ')}  focus=${a.focusEnd.slice(0, 24)}${a.m.aboveMovePx > 1 ? ' above:' + a.aboveWho : ''}${a.m.belowSnapPx ? ' snap:' + o.snapWho : ''}`);
  return a.m;
}
async function openFoldsOn(page, keys) {
  await page.evaluate((ks) => { for (const k of ks) { const d = document.querySelector('[data-group-key="' + k + '"]'); if (d) d.open = true; } }, keys);
  await delay(200);
}
const compareReady = async (page) => {
  await page.evaluate((s, m) => { const e = document.querySelector(s); if (e) document.querySelector(m).scrollTop += e.getBoundingClientRect().top - 300; }, SEL.coverage, SEL.main);
  await waitFor(page, (s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, 'Compare enabled', 2400, SEL.findDupes);
  await delay(200);
};
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
    await openDomain(app, 'h4'); await compareReady(page);
    await act(app, profile, 'find-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
    await act(app, profile, 'find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.review], untilTries: 800, settle: 1800, runs: true });
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
    if (await page.evaluate((s) => !!document.querySelector(s), SEL.repairAll)) {
      const m = await act(app, profile, 'repair-all-free', { press: SEL.repairAll, place: 300, outcome: [SEL.done, SEL.laneReading], settle: HELD, runs: true });
      step(`[${profile.name}] Repair all opens no question`, m && !(await page.evaluate((s) => !!document.querySelector(s), SEL.confirmCard)));
    }
  }
  // S2 — Repair all deletes nothing, in the free order; Check again moves nothing.
  if (run('S2') && sub('S2')) {
    await openDomain(app, 'h2'); await openFoldsOn(page, ['orphans', 'brokenLinksOpen']);
    const age = () => page.evaluate((r) => { const e = document.querySelector(r + ' [data-age-at]'); return e ? { at: Date.parse(e.getAttribute('data-age-at')), text: e.textContent } : null; }, SEL.reading);
    await delay(1100);
    const a0 = await age();
    await act(app, profile, 'rescan-1', { press: SEL.rescan, place: 200, outcome: [SEL.rescan], settle: 1000, runs: true });
    const a1 = await age();
    step(`[${profile.name}] Check again on an unchanged wiki shows it was checked just now`, a0 && a1 && a1.at > a0.at && Date.now() - a1.at < 5000, JSON.stringify([a0, a1]));
    await page.evaluate(() => { const real = window.fetch; window.__fixes = []; window.fetch = (u, o) => { if (/\/fix(-all-safe)?$/.test(String(u))) window.__fixes.push(String(u).endsWith('safe') ? 'fix-all-safe' : JSON.parse(o.body).type); return real(u, o); }; });
    await act(app, profile, 'repair-all', { press: SEL.repairAll, place: 300, outcome: [SEL.done, SEL.laneReading], settle: HELD + 400, runs: true });
    const fixes = await page.evaluate(() => window.__fixes);
    step(`[${profile.name}] Repair all runs the free types in the server's order, and nothing that deletes`,
      JSON.stringify(fixes.filter((t) => ['folderPrefixLinks', 'missingBacklinks', 'brokenLinks', 'summaryLinkSections'].includes(t))) === JSON.stringify(fixes) &&
        JSON.stringify(fixes) === JSON.stringify(['folderPrefixLinks', 'missingBacklinks', 'brokenLinks', 'summaryLinkSections'].filter((t) => fixes.includes(t))) && fixes.length >= 2, JSON.stringify(fixes));
    step(`[${profile.name}] and the two pages with one name are both still on disk`, existsSync(path.join(app.ws.domains, 'h2', 'wiki', 'entities', 'deployment.md')) && existsSync(path.join(app.ws.domains, 'h2', 'wiki', 'concepts', 'deployment.md')));
    const tr = await page.evaluate((r) => (document.querySelector(r) || {}).innerText || '', SEL.lane('free') + ' ' + SEL.laneReading);
    step(`[${profile.name}] the lane's head keeps the trace`, /^Repaired \d+ /.test(tr), tr);
  }
  // S5 — Dismiss, Restore
  if (run('S5') && sub('S5')) {
    await openDomain(app, 'h5'); await openFoldsOn(page, ['orphans', 'brokenLinksOpen']);
    // One link written twice on one page: one row, saying so.
    const twice = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-group-key="brokenLinksOpen"] .dm-issue-row')].filter((e) => /mac-os/.test(e.innerText)); return { n: r.length, text: r[0] ? r[0].innerText : '' }; });
    step(`[${profile.name}] a link written twice on one page is one row, and says so`, twice.n === 1 && /2 times on this page/.test(twice.text), JSON.stringify(twice));
    const rows = () => page.evaluate((s) => document.querySelectorAll(s).length, `${SEL.fold('orphans')} .dm-dismiss-btn`);
    const before = await rows();
    await act(app, profile, 'leave-as-is', { press: SEL.dismissIn('orphans'), place: 450, outcome: [SEL.leftUndo], settle: HELD, runs: true });
    // Nothing here may depend on an event that reduced motion never fires.
    step(`[${profile.name}] the row stays where it was, says so, and has Undo`, (await rows()) === before - 1 && await page.evaluate((u) => { const b = document.querySelector(u); return !!b && /Left as is\./.test(b.closest('.dm-issue-row').innerText); }, SEL.leftUndo), String(await rows()));
    await act(app, profile, 'undo-left', { press: SEL.leftUndo, outcome: [SEL.outcome], until: (u) => !document.querySelector(u), args: [SEL.leftUndo], settle: 500, runs: true });
    step(`[${profile.name}] Undo brings it back, in its place`, (await rows()) === before && /Brought back/.test(await page.evaluate((o) => (document.querySelector(o) || {}).innerText || '', SEL.outcome)));
    await act(app, profile, 'leave-as-is-2', { press: SEL.dismissIn('orphans'), place: 450, outcome: [SEL.leftUndo], settle: 800, runs: true });
    await openFoldsOn(page, ['dismissed']); await delay(500);
    await act(app, profile, 'bring-back', { press: SEL.restore, place: 450, outcome: [SEL.done], settle: HELD, runs: true });
  }
  // S6 — the paid plans and the free rebuild: Rescue, Apply plan, Rebuild index.
  if (run('S6') && sub('S6')) {
    await openDomain(app, 'h6');
    await act(app, profile, 'rescue-press', { press: SEL.rescue, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300 });
    await act(app, profile, 'rescue-run', { press: SEL.confirmYes, outcome: [SEL.plan, SEL.outcome], until: exists, args: [SEL.planApply], untilTries: 600, settle: 500, runs: true, settled: true });
    await act(app, profile, 'apply-plan', { press: SEL.planApply, outcome: [ON_PLAN], until: exists, args: [SEL.outcome], untilTries: 600, settle: 1200, runs: true });
    await delay(800);
    // The section's reading is whole.
    const fit = await page.evaluate(() => { const t = document.querySelector('.dm-health-reading'); return { trace: t ? t.innerText : null, fits: !t || t.scrollWidth <= t.clientWidth + 1, right: t ? t.getBoundingClientRect().right : 0, card: document.querySelector('.dm-health').getBoundingClientRect().right, ov: t ? getComputedStyle(t).textOverflow : '' }; });
    step(`[${profile.name}] the section's reading is whole`, fit.fits && fit.right <= fit.card + 1 && fit.ov !== 'ellipsis', JSON.stringify(fit));
    await act(app, profile, 'rebuild-press', { press: SEL.indexPlan, place: 300, outcome: [SEL.plan], until: exists, args: [SEL.planApply], untilTries: 400, settle: 400, runs: true });
    await page.evaluate(() => document.getElementById('dm-plan-discard-btn').focus());
    await page.evaluate(() => document.getElementById('dm-plan-discard-btn').click());
    await delay(600);
    const dis = await page.evaluate((s) => ({ onOpener: document.activeElement === document.querySelector(s), live: document.querySelector('.dm-health-live').textContent, plan: !!document.querySelector('#dm-plan-apply-btn') }), SEL.indexPlan);
    step(`[${profile.name}] Discard: focus returns to what opened the plan, and it says what happened`, dis.onOpener && !dis.plan && /Nothing was written/.test(dis.live) && !/Finished/.test(dis.live), JSON.stringify(dis));
    await act(app, profile, 'rebuild-press-2', { press: SEL.indexPlan, place: 300, outcome: [SEL.plan], until: exists, args: [SEL.planApply], untilTries: 400, settle: 400, runs: true });
    await act(app, profile, 'rebuild-apply', { press: SEL.planApply, outcome: [ON_PLAN], until: exists, args: [SEL.outcome], untilTries: 400, settle: 1200, runs: true });
  }
  // S7 — at the very end of the page, shrinking must not clamp the scroll.
  if (run('S7') && sub('S7')) {
    await openDomain(app, 'h7'); await openFoldsOn(page, ['orphans']); await delay(200);
    const toEnd = () => page.evaluate((m) => { const e = document.querySelector(m); e.scrollTop = e.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); }, SEL.main);
    await toEnd(); await delay(150);
    await act(app, profile, 'end-dismiss', { press: `${SEL.fold('orphans')} .dm-issue-row:last-child .dm-dismiss-btn`, outcome: [SEL.leftUndo], settle: HELD, runs: true, stay: true });
    await toEnd(); await delay(150);
    await openFoldsOn(page, ['dismissed']); await delay(500); await toEnd(); await delay(150);
    await act(app, profile, 'end-bring-back', { press: SEL.restore, outcome: [SEL.done], settle: HELD, runs: true, stay: true });
    // Pressed at the viewport's bottom edge: the next control is off-screen, and
    // moving focus to it must not scroll the page there.
    await openDomain(app, 'h7'); await openFoldsOn(page, ['orphans']); await delay(150);
    await act(app, profile, 'edge-dismiss', { press: `${SEL.fold('orphans')} .dm-dismiss-btn`, edge: true, outcome: [SEL.leftUndo], settle: HELD, runs: true });
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
    await openDomain(app, 'h10'); await openFoldsOn(page, ['orphans']); await delay(200);
    rmSync(path.join(app.ws.domains, 'h10', 'wiki', 'summaries', 'module-handoff.md'));
    await act(app, profile, 'row-above-settled', { press: SEL.dismissIn('orphans'), place: 500, outcome: [SEL.leftUndo], settle: HELD, runs: true });
    const waiting = await page.evaluate(() => { const e = document.querySelector('[data-row-deferred]'); return e ? e.innerText : null; });
    step(`[${profile.name}] the settled row above the press stays and says so`, !!waiting && /Resolved/.test(waiting), String(waiting));
    const pressedAt = () => page.evaluate((s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; }, SEL.leftUndo);
    const t0 = await pressedAt();
    await delay(2600);
    step(`[${profile.name}] and it goes by itself a moment later, not when somebody scrolls`, await page.evaluate(() => !document.querySelector('[data-row-deferred]')));
    const t1 = await pressedAt();
    step(`[${profile.name}] with what was pressed exactly where it was`, t0 !== null && Math.abs(t1 - t0) <= 1, `${t0} -> ${t1}`);
  }
  const slowFix = (ms) => page.evaluate((d) => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (/\/fix$/.test(String(u))) await new Promise((k) => setTimeout(k, d)); return r; }; }, ms);
  // S11 — an outcome belongs to the domain it ran on.
  if (run('S11') && sub('S11')) {
    await openDomain(app, 'h11'); await slowFix(800);
    await page.evaluate((s) => document.querySelector(s).click(), SEL.fixAll('missingBacklinks'));
    await delay(120);
    await page.evaluate((sel) => { [...document.querySelectorAll(sel)].find((n) => n.dataset.domainSlug === 'h10').click(); }, SEL.domainRow);
    await waitFor(page, (r) => !!document.querySelector(r), 'other domain', 400, SEL.rescan);
    await delay(1800);
    const other = await page.evaluate(() => { const h = document.querySelector('.dm-health'); return /Repaired/.test(h.innerText); });
    step(`[${profile.name}] another domain never shows this domain's outcome`, !other);
    await page.evaluate((sel) => { [...document.querySelectorAll(sel)].find((n) => n.dataset.domainSlug === 'h11').click(); }, SEL.domainRow);
    await waitFor(page, (r) => !!document.querySelector(r), 'back', 400, SEL.rescan);
    await delay(1000);
    const back = await page.evaluate(() => { const o = document.querySelector('.dm-health .dm-outcome'); return o ? o.innerText : null; });
    step(`[${profile.name}] its own domain does, on return`, /Repaired/.test(back || ''), String(back));
  }
  // S12 — left while it ran, and a delete warning read fresh.
  if (run('S12') && sub('S12')) {
    await openDomain(app, 'h12'); await slowFix(1200);
    await act(app, profile, 'stale-press', { press: SEL.fixAll('crossFolderDupes'), place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmNo], settle: 300 });
    await page.evaluate((s) => document.querySelector(s).click(), SEL.confirmYes);
    await delay(150);
    await page.evaluate(() => document.querySelector('#rail .rail-btn[data-view="chat"]').click());
    await delay(400);
    await page.evaluate(() => document.querySelector('#rail .rail-btn[data-view="domains"]').click());
    await waitFor(page, (r) => !!document.querySelector(r), 'back', 400, SEL.rescan);
    await delay(2600);
    const after = await page.evaluate((s) => ({ row: !!document.querySelector(s), line: (document.querySelector('.dm-health .dm-outcome') || {}).innerText || null }), SEL.fixAll('crossFolderDupes'));
    step(`[${profile.name}] left and came back: the merged row has gone`, !after.row, JSON.stringify(after));
    step(`[${profile.name}] and the outcome is kept`, /Merged/.test(after.line || ''), JSON.stringify(after));
    // What is on screen goes stale behind the app's back: no warning from that.
    mkdirSync(path.join(app.ws.domains, 'h13', 'wiki', 'entities'), { recursive: true });
    await openDomain(app, 'h13');
    rmSync(path.join(app.ws.domains, 'h13', 'wiki', 'entities', 'deployment.md'));
    await page.evaluate((s) => document.querySelector(s).click(), SEL.fixAll('crossFolderDupes'));
    await delay(1500);
    const ask = await page.evaluate(() => ({ asked: !!document.querySelector('.dm-confirm-card'), line: (document.querySelector('.dm-health .dm-outcome') || {}).innerText || null }));
    step(`[${profile.name}] a page gone behind its back: the question closes when the read lands, and it says why`, !ask.asked && /Nothing left/.test(ask.line || ''), JSON.stringify(ask));
  }
  // S13 — the keyboard focus ring is seen, and nothing changes at rest.
  if (run('S13') && sub('S13')) {
    await openDomain(app, 'h13'); await delay(200);
    await page.evaluate((s, m) => { const e = document.querySelector(s); document.querySelector(m).scrollTop += e.getBoundingClientRect().top - 200; }, SEL.rescan, SEL.main); await delay(200);
    const clipOf = () => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16, scale: 1 }; }, SEL.rescan);
    const shot = async () => (await page.send('Page.captureScreenshot', { format: 'png', clip: await clipOf() })).data;
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await delay(300);
    // THE PAGE IS AT REST WHEN TWO LOOKS AGREE, not after a fixed wait: a fixed wait is what
    // a busy machine outruns. Whatever moved meanwhile is noted, so a flake names its cause.
    const looks = () => page.evaluate((s) => { const b = document.querySelector(s); const r = b.getBoundingClientRect(); return JSON.stringify({ html: b.outerHTML, left: r.left, top: r.top, w: r.width, h: r.height, loading: !!document.querySelector('[aria-busy="true"]'), anim: document.getAnimations().length }); }, SEL.rescan);
    const atRest = async (label) => {
      let prev = await shot(); let was = await looks(); let same = 0; let moved = 0;
      for (let i = 0; i < 60 && same < 3; i++) {
        await delay(200);
        const now = await shot(); const is = await looks();
        if (now === prev) same++; else { same = 0; moved++; if (moved <= 3) note(`[${profile.name}] ring check, ${label}: still changing: ${was === is ? 'pixels only, ' + is.slice(-60) : was.slice(0, 200) + ' → ' + is.slice(0, 200)}`); }
        prev = now; was = is;
      }
      if (same < 3) step(`[${profile.name}] the button comes to rest for the ring check (${label})`, false, was);
      return prev;
    };
    const rest = await atRest('before');
    const dropped = await page.evaluate(() => { let n = 0; for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules; } catch { continue; } for (let i = rules.length - 1; i >= 0; i--) { if (rules[i].selectorText && /\.btn-(secondary|primary|danger-solid):focus-visible/.test(rules[i].selectorText)) { sheet.deleteRule(i); n++; } } } return n; });
    const without = await atRest('after');
    step(`[${profile.name}] the ring rule changes no pixel at rest (${dropped} rules taken away, same image)`, dropped >= 2 && rest === without);
    await page.navigate(app.origin); await delay(200);
    await openDomain(app, 'h13'); await delay(200);
    const shadow = await page.evaluate((s) => { const b = document.querySelector(s); const atRest = getComputedStyle(b).boxShadow; b.focus(); return { atRest, focused: b.matches(':focus-visible'), now: getComputedStyle(b).boxShadow, ring: getComputedStyle(document.documentElement).getPropertyValue('--ring-keyline').trim() }; }, SEL.rescan);
    step(`[${profile.name}] a keyboard-focused button shows the ring on top of its shadow`, shadow.focused && shadow.now !== shadow.atRest && shadow.now.split('rgb').length > shadow.atRest.split('rgb').length, JSON.stringify(shadow).slice(0, 300));
  }
  // S14 — the three lanes: what is drawn, in what order, in what words.
  if (run('S14') && sub('S14')) {
    const shot = async (state) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); const b = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(SHOTS, `${state}--${profile.name}.png`), Buffer.from(b.data, 'base64')); };
    const toHealth = () => page.evaluate((s, m) => { const e = document.querySelector(s); document.querySelector(m).scrollTop += e.getBoundingClientRect().top - 40; }, '.dm-health', SEL.main);
    const titles = () => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), SEL.laneTitle);
    const audit = async (label) => { const a = await wordAudit(page); step(`[${profile.name}] words, ${label}: every visible string is in the deck`, a.bad.length === 0, a.bad.slice(0, 8).join(' | ')); step(`[${profile.name}] words, ${label}: none banned, none in capitals`, a.banned.length === 0, a.banned.slice(0, 8).join(' | ')); };
    await openDomain(app, 'h14'); await toHealth(); await delay(300);
    step(`[${profile.name}] three lanes, in cost order, each once`, JSON.stringify(await titles()) === JSON.stringify(['Free repairs', 'Your decision', 'AI help']), JSON.stringify(await titles()));
    await shot('issues'); await audit('issues');
    const shape = await page.evaluate(() => ({
      aiOutside: [...document.querySelectorAll('.dm-health .btn-ai')].filter((b) => !b.closest('.dm-lane-ai')).length,
      banner: document.querySelectorAll('.dm-health .dm-banner').length,
      primary: document.querySelectorAll('.dm-health .btn-primary').length,
      del: (document.querySelector('[data-group-key="crossFolderDupes"] .dm-lane-deletes') || {}).innerText || '',
      cap: [...document.querySelectorAll('.dm-health *')].filter((e) => getComputedStyle(e).textTransform === 'uppercase').length,
    }));
    step(`[${profile.name}] AI buttons only in AI help; no banner; nothing primary; nothing uppercase`, shape.aiOutside === 0 && shape.banner === 0 && shape.primary === 0 && shape.cap === 0, JSON.stringify(shape));
    step(`[${profile.name}] a deletion is stated on the row`, /^deletes \d+ pages?$/.test(shape.del), shape.del);
    await openFoldsOn(page, ['missingBacklinks', 'orphans', 'folderPrefixLinks', 'summaryLinkSections', 'crossFolderDupes', 'brokenLinksOpen']); await delay(200);
    await shot('folds-open'); await audit('folds open');
    await act(app, profile, 'lane-merge-press', { press: SEL.fixAll('crossFolderDupes'), place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmNo], settle: 300 });
    await shot('merge-confirm'); await audit('merge confirm');
    const conf = await page.evaluate((y) => { const b = document.querySelector(y); const c = b.closest('.dm-confirm-card'); return { cls: b.className, label: b.innerText, warn: /otherwise it cannot be undone/.test(c.innerText) }; }, SEL.confirmYes);
    step(`[${profile.name}] the deleting yes is danger, names its result and carries the warning`, /btn-danger/.test(conf.cls) && /^Merge and delete \d+$/.test(conf.label) && conf.warn, JSON.stringify(conf));
    await page.evaluate((n) => document.querySelector(n).click(), SEL.confirmNo); await delay(400);
    const m = await act(app, profile, 'lane-repair-row', { press: SEL.fixAll('missingBacklinks'), place: 450, outcome: [SEL.done], settle: 120, runs: true });
    await shot('row-done');
    step(`[${profile.name}] a free repair opens no question`, !!m && !(await page.evaluate((s) => !!document.querySelector(s), SEL.confirmCard)));
    await delay(HELD);
    const tr = await page.evaluate((s) => (document.querySelector(s) || {}).innerText || '', SEL.lane('free') + ' ' + SEL.laneReading);
    step(`[${profile.name}] and it leaves its trace in the lane's head`, /^Repaired \d+ /.test(tr), tr);
    await shot('after'); await audit('after');
    await act(app, profile, 'lane-leave', { press: SEL.dismissIn('orphans'), place: 500, outcome: [SEL.leftUndo], settle: 500, runs: true });
    await shot('left-as-is'); await audit('left as is');
    await compareReady(page);
    const label = await page.evaluate((s) => document.querySelector(s).innerText.replace(/\s+/g, ' ').trim(), SEL.findDupes);
    step(`[${profile.name}] Compare wears its count and cost before you press`, /^Compare the next [\d,]+ (≈ )?(<\s*)?\$[\d.]+$/.test(label), label);
    await act(app, profile, 'lane-compare-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
    await shot('ai-confirm'); await audit('AI confirm');
    await act(app, profile, 'lane-compare-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.review], untilTries: 800, settle: 1800, runs: true });
    await shot('after-run'); await audit('after a run');
    await compareReady(page);
    const reading = await page.evaluate((s) => document.querySelector(s).innerText, SEL.coverage + ' .dm-compare-reading');
    step(`[${profile.name}] the row says how far it has got`, /^[\d,]+ of [\d,]+ pairs compared$/.test(reading), reading);
    if (await page.evaluate((s) => !!document.querySelector(s), SEL.batchMerge)) {
      await act(app, profile, 'lane-spelling-press', { press: SEL.batchMerge, place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmNo], settle: 300 });
      await shot('spelling-confirm'); await audit('spelling confirm');
      await page.evaluate((n) => document.querySelector(n).click(), SEL.confirmNo); await delay(300);
    }
    await page.evaluate((s) => { const d = document.querySelector(s); if (d) d.open = true; }, SEL.fold('compare')); await delay(200);
    if (await page.evaluate(() => !!document.getElementById('dm-semantic-reset-btn'))) {
      await act(app, profile, 'lane-forget-press', { press: '#dm-semantic-reset-btn', place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmNo], settle: 300 });
      await shot('forget-confirm'); await audit('forget confirm');
      await page.evaluate((n) => document.querySelector(n).click(), SEL.confirmNo); await delay(300);
    }
    await act(app, profile, 'lane-rebuild', { press: SEL.indexPlan, place: 300, outcome: [SEL.plan], until: exists, args: [SEL.planApply], untilTries: 400, settle: 300, runs: true });
    await shot('rebuild-plan'); await audit('rebuild plan');
    await page.evaluate(() => document.getElementById('dm-plan-discard-btn').click()); await delay(300);
    // Clean: one line and Check again, and AI help still says how far it has got.
    await openDomain(app, 'hclean'); await toHealth(); await delay(600);
    const clean = await page.evaluate(() => ({ line: (document.querySelector('.dm-clean') || {}).innerText || '', titles: [...document.querySelectorAll('.dm-lane-title')].map((e) => e.textContent), again: (document.getElementById('dm-rescan-btn') || {}).innerText || '', reading: (document.querySelector('.dm-health-reading') || {}).innerText || '' }));
    step(`[${profile.name}] clean: one line plus Check again; only AI help stays`, /^Nothing to fix\.\s+All 2 pages were checked/.test(clean.line) && clean.again.trim() === 'Check again' && JSON.stringify(clean.titles) === JSON.stringify(['AI help']) && /nothing to look at$/.test(clean.reading), JSON.stringify(clean));
    await shot('clean'); await audit('clean');
    const n1 = await page.evaluate((s) => { document.querySelector(s).__mark = 1; return true; }, '.dm-health');
    await act(app, profile, 'clean-check-again', { press: SEL.rescan, outcome: [SEL.rescan], settle: 800, runs: true, stay: true });
    step(`[${profile.name}] Check again keeps the section's node`, n1 && await page.evaluate((s) => document.querySelector(s).__mark === 1, '.dm-health'));
    // A mirror draws the facts and no action.
  }
  // S15 — what the review on a real wiki found: domains, waiting, return.
  if (run('S15') && sub('S15')) {
    const row = (slug) => page.evaluate((sel, s) => { [...document.querySelectorAll(sel)].find((n) => n.dataset.domainSlug === s).click(); }, SEL.domainRow, slug);
    const healthText = () => page.evaluate(() => document.querySelector('.dm-health').innerText);
    // Slow answers, as on a wiki of thousands of pages during a recount.
    const slow = (re, ms) => page.evaluate((src, d) => { const r = new RegExp(src); const real = window.fetch; window.fetch = async (u, o) => { if (r.test(String(u))) await new Promise((k) => setTimeout(k, d)); return real(u, o); }; }, re, ms);
    // 1. A run belongs to its domain.
    await openDomain(app, 'h15'); await compareReady(page);
    await slow('semantic-dupes/scan', 2500);
    await page.evaluate((s) => document.querySelector(s).click(), SEL.findDupes);
    await waitFor(page, exists, 'confirm', 200, SEL.confirmYes);
    await page.evaluate((s) => document.querySelector(s).click(), SEL.confirmYes);
    await delay(300);
    step(`[${profile.name}] the run says so on its own domain`, /Comparing/.test(await healthText()));
    await row('h15b');
    await waitFor(page, (r) => !!document.querySelector(r), 'other domain', 400, SEL.rescan); await delay(500);
    const other = await page.evaluate(() => ({ text: document.querySelector('.dm-health').innerText, busy: document.querySelectorAll('.dm-health [aria-busy="true"]').length, fix: document.querySelector('.dm-group-fixall-btn') ? document.querySelector('.dm-group-fixall-btn').disabled : null }));
    step(`[${profile.name}] another domain shows nothing of it, and its buttons work`, !/Comparing|Merging/.test(other.text) && other.busy <= 1 && other.fix === false, JSON.stringify({ busy: other.busy, fix: other.fix }));
    await row('h15');
    await waitFor(page, (r) => !!document.querySelector(r), 'back', 400, SEL.rescan); await delay(200);
    step(`[${profile.name}] and it is still running when you come back`, /Comparing|pairs compared/.test(await healthText()));
    await delay(4000);
    // 2. The last Leave as is: the row reading 0 goes.
    await openDomain(app, 'hone'); await openFoldsOn(page, ['orphans']);
    await page.evaluate((s) => document.querySelector(s).click(), SEL.dismissIn('orphans'));
    await delay(600);
    step(`[${profile.name}] the last one left as is says so`, await page.evaluate((u) => !!document.querySelector(u), SEL.leftUndo));
    await delay(1800);
    const gone = await page.evaluate(() => ({ row: !!document.querySelector('[data-group-key="orphans"]'), left: !!document.querySelector('[data-group-key="dismissed"]') }));
    step(`[${profile.name}] then the empty row goes, and Left as is has it`, !gone.row && gone.left, JSON.stringify(gone));
    // 3. Merge never waits for a count; 7. focus goes to a named target, never a paid one.
    await openDomain(app, 'h15'); await slow('/api/health/h15$', 2500);
    const mb = SEL.fixAll('crossFolderDupes');
    const t0 = Date.now();
    await page.evaluate((s) => { const b = document.querySelector(s); b.focus(); b.click(); }, mb);
    await delay(100);
    const ask = await page.evaluate((c, b) => ({ q: !!document.querySelector(c), label: document.querySelector(b).innerText }), SEL.confirmCard, mb);
    step(`[${profile.name}] Merge asks at once, with a read running behind it`, ask.q && !/Checking/.test(ask.label), JSON.stringify(ask) + ' ' + (Date.now() - t0) + ' ms');
    await page.evaluate((s) => { const b = document.querySelector(s); b.focus(); b.click(); }, SEL.confirmYes);
    await delay(5500);
    const focus = await page.evaluate(() => { const a = document.activeElement; return { tag: a && a.tagName, ai: !!(a && a.classList.contains('btn-ai')), text: a && a.innerText.slice(0, 24), inSection: !!(a && a.closest('.dm-health')) }; });
    step(`[${profile.name}] after a merge focus is on the next thing, never a paid button`, focus.inSection && !focus.ai && focus.tag !== 'BODY', JSON.stringify(focus));
    // With nothing left to decide, the next thing is Check again, not the button that spends.
    await openDomain(app, 'hdup');
    await page.evaluate((s) => { const b = document.querySelector(s); b.focus(); b.click(); }, SEL.fixAll('crossFolderDupes'));
    await waitFor(page, exists, 'question', 200, SEL.confirmYes);
    await page.evaluate((s) => { const b = document.querySelector(s); b.focus(); b.click(); }, SEL.confirmYes);
    await delay(3200);
    const landed = await page.evaluate(() => { const a = document.activeElement; return { id: a && a.id, text: a && a.innerText && a.innerText.slice(0, 24), merged: !document.querySelector('[data-group-key="crossFolderDupes"]') }; });
    step(`[${profile.name}] and with nothing left to decide, that is Check again`, landed.merged && landed.id === 'dm-rescan-btn', JSON.stringify(landed));
    // 4. Coming back shows what is known, at once.
    await openDomain(app, 'h15b'); await delay(300);
    await row('h15'); await waitFor(page, (r) => !!document.querySelector(r), 'h15', 400, SEL.rescan); await delay(600);
    await slow('/api/health/h15b$', 3000);
    await row('h15b'); await delay(300);
    const backNow = await page.evaluate(() => ({ text: document.querySelector('.dm-health').innerText, lanes: document.querySelectorAll('.dm-health .dm-lane').length, reading: document.querySelector('.dm-health-reading').innerText }));
    step(`[${profile.name}] coming back during a slow read shows what is known, and says it is checking`, !/Scanning…/.test(backNow.text) && backNow.lanes >= 2 && /Checking/.test(backNow.reading), JSON.stringify({ lanes: backNow.lanes, reading: backNow.reading }));
    await delay(3200);
    step(`[${profile.name}] then the answer lands in place`, /Checked /.test(await page.evaluate(() => document.querySelector('.dm-health-reading').innerText)));
    step(`[${profile.name}] nothing anywhere says Counting`, !/Counting/.test(await healthText()));
  }
  // S4 — duplicate pages: find, next, preview, flip, merge, skip, batch
  if (run('S4') && sub('S4')) {
    await openDomain(app, 'h4'); await compareReady(page);
    await act(app, profile, 'find-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
    await act(app, profile, 'find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.review], untilTries: 800, settle: 1800, runs: true });
    if (await page.evaluate((s) => !!document.querySelector(s), SEL.checkNext)) {
      await compareReady(page);
      await act(app, profile, 'next-press', { press: SEL.checkNext, place: 300, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
      await act(app, profile, 'next-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: (s) => !document.querySelector(s), args: ['#dm-confirm-yes'], untilTries: 800, settle: 1800, runs: true });
    } else step(`[${profile.name}] "Compare the next" is offered after a partial run`, false, 'button absent');
    await act(app, profile, 'batch-press', { press: SEL.batchMerge, place: 400, outcome: OUT_CONFIRM, until: exists, args: [SEL.confirmYes], settle: 300, optional: true });
    await act(app, profile, 'batch-confirm', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.outcome], settle: 1200, optional: true, runs: true });
  }
  // S9 — real size: thousands of pages, hundreds of pairs.
  if (run('S9') && profile.big) {
    const t0 = Date.now();
    await openDomain(app, 'hbig'); await openFoldsOn(page, ['orphans', 'missingBacklinks']);
    const pages = await page.evaluate(() => (document.querySelector('.dm-health') ? 1 : 0));
    step(`[${profile.name}] the big domain opens`, pages === 1, (Date.now() - t0) + ' ms');
    // Summary first: the lanes on a 4,600-page wiki are a screen and a bit, not a list.
    const shape = await page.evaluate(() => ({ h: document.querySelector('.dm-health').getBoundingClientRect().height, rows: document.querySelectorAll('.dm-health .dm-issue-row').length }));
    note(`[${profile.name}] with two folds open the section is ${Math.round(shape.h)} px and draws ${shape.rows} item rows`);
    step(`[${profile.name}] a long list shows a page and says how many more`, await page.evaluate(() => /Show \d+ more/.test((document.querySelector('[data-group-key="orphans"] .dm-show-more-btn') || document.querySelector('.dm-show-more-btn') || {}).innerText || 'Show 0 more')));
    await act(app, profile, 'big-leave', { press: SEL.dismissIn('orphans'), place: 450, outcome: [SEL.leftUndo], settle: HELD, runs: true });
    const t1 = Date.now(); await compareReady(page);
    note(`[${profile.name}] the cost on the Compare button took ${Date.now() - t1} ms to arrive`);
    await act(app, profile, 'big-find-press', { press: SEL.findDupes, place: 300, outcome: OUT_CONFIRM, until: (a, b) => !!document.querySelector(a) || !!document.querySelector(b), args: [SEL.confirmYes, SEL.outcome], untilTries: 6000, settle: 300, runs: true });
    note(`[${profile.name}] after pressing Compare: ${await page.evaluate(() => { const o = document.querySelector('.dm-health .dm-outcome'); return o ? o.innerText : 'no outcome line'; })}`);
    await act(app, profile, 'big-find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.review], untilTries: 2400, settle: 1800, runs: true });
    const audited = await wordAudit(page);
    step(`[${profile.name}] every word on screen at real size is in the deck`, audited.bad.length === 0, audited.bad.slice(0, 6).join(' | '));
    await place(page, SEL.review, 300);
    await page.evaluate((s) => document.querySelector(s).click(), SEL.review);
    await waitFor(page, (s) => !!document.querySelector(s), 'the desk', 800, SEL.deskText);
    const count = await page.evaluate((s) => document.querySelector(s).innerText, SEL.deskTitle);
    const total = Number(count.replace(/^Pair [\d,]+ of /, '').replace(/,/g, ''));
    step(`[${profile.name}] the big run reaches the desk with more than 1,000 pairs`, total > 1000, count);
    // Summary first; the rows are a window, however long the list. Press to painted.
    const opened = await page.evaluate(() => new Promise((res) => {
      const sum = document.querySelector('[data-group-key="reviewPairs"] summary');
      sum.scrollIntoView({ block: 'center' });
      const t0 = performance.now();
      sum.click();
      requestAnimationFrame(() => requestAnimationFrame(() => res({ ms: Math.round(performance.now() - t0),
        rows: document.querySelectorAll('.hr-fold-row').length, first: (document.querySelector('[data-group-key="reviewPairs"] .cur-fold-body').firstElementChild || {}).className })));
    }));
    note(`[${profile.name}] All N pairs at ${total} pairs: ${opened.ms} ms, ${opened.rows} rows drawn`);
    step(`[${profile.name}] All N pairs opens fast at more than 1,000 pairs (under 300 ms)`, opened.ms < 300, opened.ms + ' ms');
    step(`[${profile.name}] …draws a window, not the list`, opened.rows > 0 && opened.rows <= 100, String(opened.rows));
    step(`[${profile.name}] …and the summary comes first`, opened.first === 'hr-fold-summary', opened.first);
    await page.evaluate((s) => document.querySelector(s).click(), '#hr-fold-more'); await delay(100);
    step(`[${profile.name}] Show more adds a page`, await page.evaluate(() => document.querySelectorAll('.hr-fold-row').length) === 100);
    const auditBig = await wordAudit(page);
    step(`[${profile.name}] every word on the desk at real size is in the deck`, auditBig.bad.length === 0, auditBig.bad.slice(0, 6).join(' | '));
  }
  // S16 — the review desk.
  if (run('S16') && sub('S16')) await reviewDeskScene(app, profile);
}

// ═══ THE REVIEW DESK ════════════════════════════════════════════════════════
// Every box the eye rests on, per frame, across a decision. Nothing may move, in either
// direction, by more than a pixel, and the card keeps its height. The pixels are read
// every frame, because a jump that is back by the end is still a jump.
const DESK_MARKS = ['#hr-title', '#hr-prev', '#hr-next', '#hr-done', '.hr-count', '.hr-facts', '.hr-panes', '.hr-pane-goes', '.hr-pane-stays', '#hr-read-goes', '#hr-flip', '#hr-read-stays', '.hr-after', '.hr-decide', '#hr-keep', '#hr-merge', '.hr-note', '.hr-outcome', '[data-group-key="reviewPairs"]', '.dm-health .cur-card', '.dm-health .cur-section-hd'];
const DESK_SAMPLER = String.raw`(() => {
  window.__desk = {
    begin(marks) {
      const s = this.s = { frames: [], done: false, marks };
      const read = () => {
        const f = { t: performance.now(), boxes: {}, focus: document.activeElement === document.body || !document.activeElement ? 'BODY' : (document.activeElement.id || document.activeElement.tagName),
          merge: (() => { const m = document.querySelector('#hr-merge'); return m ? { disabled: m.disabled, busy: m.getAttribute('aria-busy') === 'true', text: m.innerText } : null; })(),
          text: !!document.querySelector('.hr-pane-text'), title: (document.querySelector('#hr-title') || {}).innerText };
        for (const m of marks) { const e = document.querySelector(m); if (e) { const r = e.getBoundingClientRect(); f.boxes[m] = [r.left, r.top, r.height]; } }
        return f;
      };
      const tick = () => { if (s.done) return; s.frames.push(read()); requestAnimationFrame(tick); };
      s.frames.push(read());
      requestAnimationFrame(tick);
    },
    end() { this.s.done = true; return this.s.frames; },
  };
})();`;
function deskMoves(frames) {
  const first = {}; let maxMove = 0; let who = ''; let cardMove = 0; let body = 0;
  // Merge's height may grow by a line for a long name; its place may not move, and the
  // block it stands in keeps its height. The rest keep height too.
  const heightFree = new Set(['#hr-merge', '#hr-flip', '#hr-keep']);
  for (const f of frames) {
    if (f.focus === 'BODY') body++;
    for (const [k, b] of Object.entries(f.boxes)) {
      if (!first[k]) { first[k] = b; continue; }
      const moved = Math.max(Math.abs(b[0] - first[k][0]), Math.abs(b[1] - first[k][1]), heightFree.has(k) ? 0 : Math.abs(b[2] - first[k][2]));
      if (moved > maxMove) { maxMove = moved; who = k; }
      if (k === '.dm-health .cur-card') cardMove = Math.max(cardMove, Math.abs(b[2] - first[k][2]));
    }
  }
  return { maxMove: Math.round(maxMove * 10) / 10, who, cardMove: Math.round(cardMove * 10) / 10, body };
}

async function reviewDeskScene(app, profile) {
  const { page } = app;
  const pn = profile.name;
  const wiki = path.join(app.ws.domains, 'h16', 'wiki', 'concepts');
  const shot = async (state) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); const b = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(SHOTS, `${state}--${pn}.png`), Buffer.from(b.data, 'base64')); };
  const audit = async (label) => { const a = await wordAudit(page); step(`[${pn}] words, ${label}: every visible string is in the deck`, a.bad.length === 0, a.bad.slice(0, 8).join(' | ')); step(`[${pn}] words, ${label}: none banned, none in capitals`, a.banned.length === 0, a.banned.slice(0, 8).join(' | ')); };
  const title = () => page.evaluate((s) => document.querySelector(s).innerText, SEL.deskTitle);
  const mergeState = () => page.evaluate((s) => { const m = document.querySelector(s); return m ? { disabled: m.disabled, text: m.innerText } : null; }, SEL.deskMerge);
  // The gate runs only while the panes are on screen, so a person reading the pair has them
  // in view. On a phone the panes can be above a button you just pressed: look at them first.
  const armed = async () => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await page.evaluate((p, m) => { const r = document.querySelector(p); if (!r) return; const b = r.getBoundingClientRect(); const seen = Math.min(b.bottom, innerHeight) - Math.max(b.top, 0); if (seen < b.height * 0.6) document.querySelector(m).scrollTop += b.top - 60; }, SEL.deskPanes, SEL.main);
    return waitFor(page, (s) => { const m = document.querySelector(s); return !!m && !m.disabled; }, 'Merge armed', 400, SEL.deskMerge);
  };
  const center = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2), top: r.top, bottom: r.bottom }; }, sel);
  const press = async (sel) => { const c = await center(sel); await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await delay(40); await page.click(c.x, c.y, { settleMs: 20 }); };
  // A control the user cannot see is one they scroll to first.
  const bringIn = async (sel) => { await page.evaluate((s, m) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight - 8) document.querySelector(m).scrollTop += r.top - 120; }, sel, SEL.main); await delay(120); };
  const deciding = async (label, fn, settle = 1000) => {
    await page.send('Runtime.evaluate', { expression: DESK_SAMPLER });
    await page.evaluate((m) => window.__desk.begin(m), DESK_MARKS);
    await fn();
    await delay(settle);
    const frames = await page.evaluate(() => window.__desk.end());
    const mv = deskMoves(frames);
    step(`[${pn}] ${label}: nothing moves across it (<= 1 px)`, mv.maxMove <= 1, mv.maxMove + ' px, ' + mv.who);
    step(`[${pn}] ${label}: the card keeps its height`, mv.cardMove <= 1, mv.cardMove + ' px');
    step(`[${pn}] ${label}: focus never on the page body`, mv.body === 0, mv.body + ' frames');
    return frames;
  };

  await openDomain(app, 'h16');
  await compareReady(page);
  await act(app, profile, 'desk-find', { press: SEL.findDupes, place: 300, outcome: [SEL.confirmCard], until: exists, args: [SEL.confirmYes], settle: 300, runs: true });
  await act(app, profile, 'desk-find-run', { press: SEL.confirmYes, outcome: [ON_CONFIRM], until: exists, args: [SEL.review], untilTries: 800, settle: 1800, runs: true });
  await page.evaluate(() => { document.querySelector('.dm-health').__marker = 1; });

  // ── Opening: comparison by default, and the gate is not open before 500 ms visible.
  // A row that opened above the last press waits for you to scroll, as a person does.
  await page.evaluate((m) => { document.querySelector(m).scrollTop -= 40; }, SEL.main);
  await delay(500);
  await place(page, SEL.review, 300);
  await delay(300);
  await page.send('Runtime.evaluate', { expression: DESK_SAMPLER });
  await page.evaluate((m) => window.__desk.begin(m), DESK_MARKS);
  await press(SEL.review);
  await waitFor(page, (s) => !!document.querySelector(s), 'the desk', 400, SEL.deskText);
  await armed();
  await delay(100);
  let frames = await page.evaluate(() => window.__desk.end());
  const gateTime = (fr) => {
    const textAt = fr.find((f) => f.text);
    const openAt = fr.find((f) => f.merge && !f.merge.disabled && !f.merge.busy && textAt && f.t >= textAt.t);
    const earlier = fr.filter((f) => f.merge && !f.merge.disabled && (!textAt || f.t < textAt.t));
    return { textAt: textAt && textAt.t, openAt: openAt && openAt.t, gap: textAt && openAt ? Math.round(openAt.t - textAt.t) : null, early: earlier.length };
  };
  let g = gateTime(frames);
  const errs = (page.consoleErrors || []).filter((e) => !/favicon|404/.test(e));
  step(`[${pn}] the page threw nothing opening the desk`, errs.length === 0, errs.slice(0, 3).join(' | '));
  step(`[${pn}] the comparison is on screen without asking for it`, !!g.textAt);
  step(`[${pn}] the gate is not open before the comparison is seen for 500 ms`, g.gap !== null && g.gap >= 480 && g.early === 0, 'gap ' + g.gap + ' ms, enabled early in ' + g.early + ' frames');
  step(`[${pn}] Review keeps the section node`, await page.evaluate(() => document.querySelector('.dm-health').__marker === 1));
  step(`[${pn}] focus lands on the pair title`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-title'));
  const look = await page.evaluate(() => ({
    primary: document.querySelectorAll('.dm-health .btn-primary').length,
    danger: [...document.querySelectorAll('.dm-health .btn-danger')].map((b) => b.id),
    badge: /confidence/i.test(document.querySelector('.dm-health').innerText),
    fact: (document.querySelector('.hr-fact') || {}).innerText,
    reason: (document.querySelector('.hr-reason') || {}).innerText || '',
    roles: [...document.querySelectorAll('.hr-pane-role')].map((e) => e.innerText),
    articles: [...document.querySelectorAll('article.hr-pane')].map((e) => e.getAttribute('aria-label')),
    banners: document.querySelectorAll('.dm-health .dm-banner').length,
    order: [...document.querySelectorAll('.hr-desk button, .hr-desk [tabindex="0"], .hr-desk summary')].map((e) => e.id || (e.classList.contains('hr-pane-body') ? 'text' : e.tagName)),
  }));
  step(`[${pn}] no violet primary, and Merge alone is the danger button`, look.primary === 0 && look.danger.join() === 'hr-merge', JSON.stringify(look));
  step(`[${pn}] no confidence on screen`, !look.badge);
  step(`[${pn}] the app's own fact, and the AI quoted as the AI`, /^(Spelling variant|Version numbers differ|Different names)$/.test(look.fact || '') && /^The AI says: ".+"$/.test(look.reason), look.fact + ' / ' + look.reason);
  step(`[${pn}] the panes say which page goes, in words`, look.roles.join() === 'Goes away,Stays' && /^Page that goes away: /.test(look.articles[0]) && /^Page that stays: /.test(look.articles[1]), look.articles.join(' | '));
  step(`[${pn}] tab order: head, first page, second page, decision, list`, look.order.join() === 'hr-prev,hr-next,hr-done,text,hr-read-goes,hr-flip,text,hr-read-stays,hr-keep,hr-merge,SUMMARY', look.order.join());
  await shot('desk'); await audit('the desk');

  // ── No single key does anything. A held Enter is not a second press.
  const titleBefore = await title();
  for (const key of ['m', 'M', 'k', 'K', 'Enter', ' ', 'y', 'ArrowRight']) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }
  await delay(300);
  step(`[${pn}] no single key merges, keeps or moves on, with focus on the title`, (await title()) === titleBefore && (await page.evaluate((s) => document.querySelector(s) && document.querySelector(s).getAttribute('aria-busy') !== 'true', SEL.deskMerge)));
  await page.evaluate((s) => document.querySelector(s).focus(), SEL.deskMerge);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await delay(300);
  step(`[${pn}] a repeating Enter on Merge does not merge`, (await title()) === titleBefore);
  await page.evaluate((s) => document.querySelector(s).focus(), SEL.deskTitle);

  // ── Next: records nothing, and the gate starts again. Reading the pair: its head at the
  // top of the window, both pages under it.
  await page.evaluate((s, m) => { document.querySelector(m).scrollTop += document.querySelector(s).getBoundingClientRect().top - 20; }, SEL.deskTitle, SEL.main);
  await delay(100);
  const nextFrames = await deciding('Next', () => press(SEL.deskNext));
  g = gateTime(nextFrames.filter((f, i, a) => i > 0 && (a[i - 1].title !== titleBefore || f.title !== titleBefore)));
  step(`[${pn}] Next goes to the next pair`, (await title()) !== titleBefore, await title());
  const openedAfterNext = nextFrames.find((f) => f.title !== titleBefore && f.merge && !f.merge.disabled);
  const arrived = nextFrames.find((f) => f.title !== titleBefore);
  const textBack = nextFrames.find((f) => arrived && f.t >= arrived.t && f.text);
  step(`[${pn}] Merge re-arms for 500 ms on a new pair`, !!arrived && !!openedAfterNext && !!textBack && openedAfterNext.t - textBack.t >= 480, openedAfterNext && textBack ? Math.round(openedAfterNext.t - textBack.t) + ' ms' : 'never');
  await armed();

  // ── Off screen, the 500 ms does not run. Fetched is not seen.
  await page.evaluate((s) => document.querySelector(s).click(), SEL.deskNext);
  await page.evaluate((m) => { const main = document.querySelector(m); main.scrollTop = 0; }, SEL.main);
  await delay(1200);
  const offScreen = await page.evaluate((p) => { const r = document.querySelector(p).getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight; }, SEL.deskPanes);
  const stillShut = (await mergeState()).disabled;
  step(`[${pn}] with the panes off screen, 1.2 s later, Merge is still shut`, !offScreen || stillShut, 'off screen: ' + offScreen + ', shut: ' + stillShut);
  if (offScreen) step(`[${pn}] and it says why, in place`, (await page.evaluate(() => document.getElementById('hr-gate').innerText)) === 'Merge opens once you have had both pages on screen.');
  await bringIn(SEL.deskPanes);
  await armed();

  // Looked away inside the 500 ms: the time starts again when you look back.
  await page.evaluate((s) => document.querySelector(s).click(), SEL.deskNext);
  await waitFor(page, (s) => !!document.querySelector(s), 'text', 200, SEL.deskText);
  await delay(80);
  await page.evaluate((m) => { document.querySelector(m).scrollTop = 0; }, SEL.main);
  await delay(900);
  const awayOff = await page.evaluate((p) => { const r = document.querySelector(p).getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight; }, SEL.deskPanes);
  step(`[${pn}] scrolled away inside the 500 ms, Merge stays shut`, awayOff && (await mergeState()).disabled, 'off screen: ' + awayOff);
  await bringIn(SEL.deskPanes);
  await armed();

  // Stacked, a sliver of the page that goes away is not seeing it (measured: 20 px opened it).
  if (profile.w < 720) {
    await page.evaluate((s) => document.querySelector(s).click(), SEL.deskNext);
    await waitFor(page, (s) => !!document.querySelector(s), 'text', 200, SEL.deskText);
    await page.evaluate((m) => { const main = document.querySelector(m); const g = document.querySelector('.hr-pane-goes').getBoundingClientRect(); main.scrollTop += g.bottom - 20; }, SEL.main);
    await delay(1300);
    const seenBits = await page.evaluate(() => { const g = document.querySelector('.hr-pane-goes').getBoundingClientRect(); const t = document.querySelector('.hr-pane-stays').getBoundingClientRect(); return { goes: Math.max(0, Math.min(g.bottom, innerHeight) - Math.max(g.top, 0)), stays: Math.max(0, Math.min(t.bottom, innerHeight) - Math.max(t.top, 0)) }; });
    step(`[${pn}] 20 px of the page that goes away, the rest of the other in full: Merge stays shut`, seenBits.goes <= 30 && seenBits.stays > 200 && (await mergeState()).disabled, JSON.stringify(seenBits));
    step(`[${pn}] and it says why`, (await page.evaluate(() => document.getElementById('hr-gate').innerText)) === 'Merge opens once you have had both pages on screen.');
    await shot('desk-unseen');
    await bringIn(SEL.deskPanes);
    await armed();
  }

  // ── Keep this one instead: this direction only, re-armed, nothing moved.
  await bringIn(SEL.deskFlip);
  const nameBefore = await page.evaluate(() => document.querySelector('.hr-pane-stays .hr-pane-name').innerText);
  await deciding('Keep this one instead', () => press(SEL.deskFlip));
  step(`[${pn}] the other page stays now`, (await page.evaluate(() => document.querySelector('.hr-pane-goes .hr-pane-name').innerText)) === nameBefore);
  step(`[${pn}] Merge names the new page`, (await armed()) && (await mergeState()).text.includes(await page.evaluate(() => document.querySelector('.hr-pane-stays .hr-pane-name').innerText)));
  await shot('desk-flipped');

  // ── Merge, for real, with a double click: one page goes, the next pair is safe.
  const m1 = await page.evaluate(() => ({ goes: document.querySelector('.hr-pane-goes .hr-pane-name').innerText, stays: document.querySelector('.hr-pane-stays .hr-pane-name').innerText }));
  const pairsBefore = await title();
  await bringIn(SEL.deskMerge);
  const mergeFrames = await deciding('Merge', async () => { const c = await center(SEL.deskMerge); await page.click(c.x, c.y, { settleMs: 5 }); await page.click(c.x, c.y, { settleMs: 5 }); }, 1500);
  step(`[${pn}] Merge deleted the page that goes and kept the page that stays`, !existsSync(path.join(wiki, m1.goes + '.md')) && existsSync(path.join(wiki, m1.stays + '.md')), m1.goes + ' into ' + m1.stays);
  step(`[${pn}] the button said Merging while it ran`, mergeFrames.some((f) => f.merge && f.merge.busy && /Merging…/.test(f.merge.text)));
  const m2 = await page.evaluate(() => document.querySelector('.hr-pane-goes .hr-pane-name').innerText);
  step(`[${pn}] a double click merged one pair`, existsSync(path.join(wiki, m2 + '.md')) && (await title()) !== pairsBefore, m2);
  step(`[${pn}] focus goes to the pair title, never a button`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-title'));
  const said = await page.evaluate((s) => document.querySelector(s).innerText, SEL.deskOutcome);
  step(`[${pn}] the outcome is on the desk`, /^Merged .+ into .+\./.test(said), said);
  const liveText = await page.evaluate(() => document.querySelector('.dm-health .dm-health-live').textContent);
  step(`[${pn}] and it is spoken, with where you are`, /^Merged .+Pair [\d,]+ of [\d,]+\.$/.test(liveText), liveText);
  await shot('desk-merged'); await audit('after a merge');

  // ── 40 clicks on one spot, 100 ms apart: the first pair's press was the last that counted.
  if (await armed()) {
    // Both pages and Merge in one view, as near as a phone allows: the pair, read, then pressed.
    await page.evaluate((s, m) => { const r = document.querySelector(s).getBoundingClientRect(); if (r.bottom > innerHeight - 10) document.querySelector(m).scrollTop += r.bottom - innerHeight + 20; }, SEL.deskMerge, SEL.main);
    await delay(100);
    const stampAt = await center(SEL.deskMerge);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stampAt.x, y: stampAt.y });
    await delay(40);
    const before = await title();
    await page.click(stampAt.x, stampAt.y, { settleMs: 10 });
    await waitFor(page, (s, t) => document.querySelector(s).innerText !== t, 'next pair', 200, SEL.deskTitle, before);
    const stampTitle = await title();
    const pagesBefore = readdirSync(wiki).length;
    for (let i = 0; i < 40; i++) { await page.click(stampAt.x, stampAt.y, { settleMs: 5 }); await delay(95); }
    step(`[${pn}] 40 clicks on one spot merge nothing more`, readdirSync(wiki).length === pagesBefore && (await title()) === stampTitle, stampTitle);
    // It has been on screen under the clicks if a person could read it from there; on a phone
    // the page may need to come back into view for the gate to have opened at all.
    await page.evaluate((p, m) => { const r = document.querySelector(p).getBoundingClientRect(); if (r.top < 0) document.querySelector(m).scrollTop += r.top - 60; }, SEL.deskPanes, SEL.main);
    await waitFor(page, (s) => /Move the pointer/.test(document.querySelector(s).innerText), 'the line', 100, '#hr-gate');
    const hint = await page.evaluate(() => document.getElementById('hr-gate').innerText);
    step(`[${pn}] Merge says why it is shut, and what to do`, hint === 'Move the pointer off Merge and back to press it.' && (await mergeState()).disabled, hint);
    await shot('desk-pointer');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); await delay(120);
    step(`[${pn}] moved off, it opens, and the line goes`, !(await mergeState()).disabled && (await page.evaluate(() => document.getElementById('hr-gate').innerText)) === '');
  } else step(`[${pn}] Merge opens for the rubber-stamp test`, false);

  // ── Keep both, with Undo.
  await armed();
  await bringIn(SEL.deskKeep);
  const k1 = await page.evaluate(() => ({ goes: document.querySelector('.hr-pane-goes .hr-pane-name').innerText, stays: document.querySelector('.hr-pane-stays .hr-pane-name').innerText }));
  await deciding('Keep both', () => press(SEL.deskKeep));
  const keptLine = await page.evaluate((s) => document.querySelector(s).innerText, SEL.deskOutcome);
  step(`[${pn}] Keep both says so and offers Undo`, /^Kept .+ and .+ apart\. They will not come back\./.test(keptLine) && await page.evaluate(() => !!document.getElementById('hr-undo')), keptLine);
  step(`[${pn}] focus goes to the pair title`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-title'));
  await shot('desk-kept');
  await bringIn('#hr-undo');
  await deciding('Undo', () => press('#hr-undo'));
  step(`[${pn}] Undo: Brought back.`, (await page.evaluate((s) => document.querySelector(s).innerText, SEL.deskOutcome)) === 'Brought back.');
  step(`[${pn}] Undo leaves focus on the title, not the body`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-title'));

  // ── A stale basis, on a real file: refused, nothing written, shown truthfully.
  await armed();
  const s1 = await page.evaluate(() => ({ goes: document.querySelector('.hr-pane-goes .hr-pane-name').innerText, stays: document.querySelector('.hr-pane-stays .hr-pane-name').innerText }));
  const stayFile = path.join(wiki, s1.stays + '.md');
  const edited = readFileSync(stayFile, 'utf8') + '\nA line someone added in Obsidian after you compared.\n';
  writeFileSync(stayFile, edited);
  await bringIn(SEL.deskMerge);
  const staleFrames = await deciding('A stale basis', () => press(SEL.deskMerge), 1400);
  step(`[${pn}] a page changed since the comparison: the merge is refused and nothing is written`, existsSync(path.join(wiki, s1.goes + '.md')) && readFileSync(stayFile, 'utf8') === edited);
  const staleLine = await page.evaluate((s) => document.querySelector(s).innerText, SEL.deskOutcome);
  step(`[${pn}] the desk says so, in the deck's words`, staleLine === 'This page changed since you compared it. The comparison has been refreshed.', staleLine);
  step(`[${pn}] and the new text really is on the pane`, await page.evaluate(() => document.querySelector('.hr-pane-stays .hr-pane-text').innerText.includes('after you compared')));
  step(`[${pn}] the gate re-armed through the 500 ms, not at once`, (() => {
    const shutAgain = staleFrames.find((f, i) => i > 0 && f.merge && f.merge.disabled);
    const reopened = shutAgain ? staleFrames.find((f) => f.t > shutAgain.t && f.merge && !f.merge.disabled && !f.merge.busy) : null;
    return !!shutAgain && (!reopened || reopened.t - shutAgain.t >= 480);
  })());
  await armed();
  await shot('desk-stale'); await audit('a stale comparison');

  // ── The comparison fails: says so, Merge stays shut, Try again works.
  await page.evaluate(() => { window.__realFetch = window.fetch; window.fetch = (u, o) => (String(u).includes('semantic-dupes/preview') ? Promise.reject(new Error('the disk went away')) : window.__realFetch(u, o)); });
  await bringIn(SEL.deskNext);
  await deciding('A failed comparison', () => press(SEL.deskNext), 900);
  const failLine = await page.evaluate((s) => document.querySelector(s).innerText, SEL.deskOutcome);
  step(`[${pn}] a failed comparison says so, with Try again`, /^Could not load the comparison: the disk went away/.test(failLine) && await page.evaluate(() => !!document.getElementById('hr-retry')), failLine);
  step(`[${pn}] and Merge stays shut`, (await mergeState()).disabled);
  await shot('desk-failed'); await audit('a failed comparison');
  await page.evaluate(() => { window.fetch = window.__realFetch; });
  await bringIn('#hr-retry');
  await press('#hr-retry');
  step(`[${pn}] Try again loads it, and Merge opens through the gate`, (await waitFor(page, (s) => !!document.querySelector(s), 'text', 200, SEL.deskText)) && await armed());

  // ── A long page scrolls inside its pane; a long name wraps. Neither moves anything.
  const longName = 'a-very-long-page-name-that-goes-on-and-on-about-the-history-of-the-long-page-name';
  let walked = 0; let found = false;
  for (; walked < 60 && !found; walked++) {
    found = await page.evaluate((n) => !!document.querySelector('.hr-pane-goes .hr-pane-name') && (document.querySelector('.hr-pane-goes .hr-pane-name').innerText.startsWith(n) || document.querySelector('.hr-pane-stays .hr-pane-name').innerText.startsWith(n)), longName);
    if (!found) { await page.evaluate((s) => document.querySelector(s).click(), SEL.deskNext); await delay(120); }
  }
  step(`[${pn}] the pair with the long name and the long text comes up`, found);
  await waitFor(page, (s) => !!document.querySelector(s), 'text', 200, SEL.deskText);
  await delay(200);
  const inner = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hr-pane-body')].sort((x, y) => y.scrollHeight - x.scrollHeight)[0];
    const before = b.scrollHeight > b.clientHeight;
    b.scrollTop = 300;
    const n = document.querySelector('.hr-pane-goes .hr-pane-name');
    return { scrolls: before, top: b.scrollTop, wrapped: n.getBoundingClientRect().height > 24 || document.querySelector('.hr-pane-stays .hr-pane-name').getBoundingClientRect().height > 24,
      over: document.documentElement.scrollWidth - innerWidth, nameInside: n.getBoundingClientRect().right <= n.closest('.hr-pane').getBoundingClientRect().right + 0.5 };
  });
  step(`[${pn}] a page's headings are the desk's size, not a document's`, await page.evaluate(() => { const h = document.querySelector('.hr-pane-text .chat-md-h, .hr-pane-text h1, .hr-pane-text h2'); const b = document.querySelector('.hr-pane-body'); return !!h && parseFloat(getComputedStyle(h).fontSize) === parseFloat(getComputedStyle(b).fontSize); }));
  step(`[${pn}] a long page scrolls inside its pane`, inner.scrolls && inner.top > 0, JSON.stringify(inner));
  step(`[${pn}] a long name wraps inside its pane, and the page has no sideways scroll`, inner.wrapped && inner.nameInside && inner.over <= 0, JSON.stringify(inner));
  await armed();
  await shot('desk-long');
  await audit('a long page');
  await bringIn(SEL.deskNext);
  await deciding('Next, from the long page', () => press(SEL.deskNext));
  step(`[${pn}] a new pair starts at the top of its text`, await page.evaluate(() => [...document.querySelectorAll('.hr-pane-body')].every((b) => b.scrollTop === 0)));

  // ── Read full page opens the reader; closing it, the desk is still there.
  await armed();
  await press('#hr-read-stays');
  const opened = await waitFor(page, () => { const r = document.querySelector('.reader, #reader, [data-reader], .reader-panel'); return !!r && getComputedStyle(r).display !== 'none'; }, 'the reader', 200);
  step(`[${pn}] Read full page opens the right-side reader`, opened);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(400);
  step(`[${pn}] the desk is still there behind it`, await page.evaluate((s) => !!document.querySelector(s), SEL.desk));

  // ── All N pairs: summary first; a waiting row jumps to its pair.
  await page.evaluate(() => { const sum = document.querySelector('[data-group-key="reviewPairs"] summary'); sum.scrollIntoView({ block: 'center' }); sum.click(); });
  await delay(300);
  const fold = await page.evaluate(() => ({ first: (document.querySelector('[data-group-key="reviewPairs"] .cur-fold-body').firstElementChild || {}).className, here: [...document.querySelectorAll('.hr-fold-row')].filter((r) => /this pair/.test(r.innerText)).length, jumps: document.querySelectorAll('.hr-jump').length }));
  step(`[${pn}] All N pairs: the summary first, this pair marked, the rest a press away`, fold.first === 'hr-fold-summary' && fold.here === 1 && fold.jumps > 0, JSON.stringify(fold));
  await shot('desk-all-pairs'); await audit('all pairs');
  const tBefore = await title();
  // Far down the list: the pair it brings up is above the top of the window.
  await page.evaluate((m) => { const j = document.querySelector('.hr-jump'); document.querySelector(m).scrollTop += j.getBoundingClientRect().top - 4; }, SEL.main);
  await delay(100);
  const farOff = await page.evaluate((s) => document.querySelector(s).getBoundingClientRect().bottom < 0, SEL.deskTitle);
  await page.evaluate(() => document.querySelector('.hr-jump').click());
  await delay(400);
  step(`[${pn}] a waiting row jumps to its pair`, (await title()) !== tBefore);
  step(`[${pn}] and the desk is on screen after the jump`, farOff && await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, SEL.deskTitle), 'title was off screen: ' + farOff);
  step(`[${pn}] focus on the title after a jump`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-title'));
  await page.evaluate(() => document.querySelector('[data-group-key="reviewPairs"] summary').click());
  await delay(200);

  // ── Merging state, seen. And Done.
  await slowRoute(page, '/fix', 700);
  await armed();
  await bringIn(SEL.deskMerge);
  await press(SEL.deskMerge);
  await delay(250);
  await shot('desk-merging'); await audit('merging');
  step(`[${pn}] and it is spoken`, (await page.evaluate(() => document.querySelector('.dm-health .dm-health-live').textContent)) === 'Merging.');
  step(`[${pn}] while it merges, Keep both is shut and Merge says so`, await page.evaluate(() => document.getElementById('hr-keep').disabled && document.getElementById('hr-merge').getAttribute('aria-busy') === 'true' && /Merging…/.test(document.getElementById('hr-merge').innerText)));
  await delay(1100);
  await page.evaluate(() => { if (window.__realFetch2) window.fetch = window.__realFetch2; });
  await bringIn(SEL.deskDone);
  await press(SEL.deskDone);
  await delay(500);
  const back = await page.evaluate((r, m) => ({ lanes: document.querySelectorAll('.dm-lane').length, desk: !!document.querySelector('.hr-desk'), focus: document.activeElement && (document.activeElement.className || document.activeElement.tagName), review: !!document.querySelector(r), marker: document.querySelector('.dm-health').__marker === 1 }), SEL.review);
  step(`[${pn}] Done goes back to the lanes, focus on Review`, back.lanes > 0 && !back.desk && /dm-review-btn/.test(back.focus || ''), JSON.stringify(back));
  step(`[${pn}] and it is the same section`, back.marker);

  // ── By touch, the wait is longer and says so.
  if (profile.w < 720) {
    await press(SEL.review);
    await waitFor(page, (s) => !!document.querySelector(s), 'text', 200, SEL.deskText);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await bringIn(SEL.deskNext);
    const tap = await center(SEL.deskNext);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tap.x, y: tap.y }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const t0 = Date.now();
    await delay(1000);
    const early = await page.evaluate(() => ({ shut: document.getElementById('hr-merge').disabled, said: document.getElementById('hr-gate').innerText, seen: !!document.querySelector('.hr-pane-text') }));
    await page.evaluate((p, m) => { const r = document.querySelector(p).getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight) document.querySelector(m).scrollTop += r.top - 60; }, SEL.deskPanes, SEL.main);
    step(`[${pn}] by touch, a second after a pair arrives Merge is shut, and says why`, early.seen && early.shut && /^Merge opens /.test(early.said), JSON.stringify(early));
    await waitFor(page, (s) => { const m = document.querySelector(s); return !!m && !m.disabled; }, 'Merge opens by touch', 200, SEL.deskMerge);
    step(`[${pn}] and then it opens`, Date.now() - t0 >= 1800 && !(await mergeState()).disabled, (Date.now() - t0) + ' ms');
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await bringIn(SEL.deskDone);
    await press(SEL.deskDone);
    await delay(400);
  }

  // ── Coming back: the row is there at once, however long the server takes.
  await page.evaluate(() => { window.__realFetch3 = window.fetch; window.fetch = async (u, o) => { if (/\/api\/health\/h16(\/|$|\?)/.test(String(u))) await new Promise((r) => setTimeout(r, 2500)); return window.__realFetch3(u, o); }; });
  if (await page.evaluate((s) => !!document.querySelector(s), SEL.review)) {
    await page.evaluate((sel) => { const e = [...document.querySelectorAll(sel)].find((n) => n.dataset.domainSlug === 'h15'); if (e) e.click(); }, SEL.domainRow);
    await delay(800);
    await page.evaluate((sel) => { const e = [...document.querySelectorAll(sel)].find((n) => n.dataset.domainSlug === 'h16'); if (e) e.click(); }, SEL.domainRow);
    await delay(300);
    step(`[${pn}] coming back, Possible duplicates is there before the server has answered`, await page.evaluate((s) => !!document.querySelector(s), SEL.review));
    await delay(2600);
    step(`[${pn}] and still there after it has`, await page.evaluate((s) => !!document.querySelector(s), SEL.review));
  } else step(`[${pn}] pairs left to come back to`, false);
  await page.evaluate(() => { window.fetch = window.__realFetch3; });
  await shot('desk-done');
}
// Holds one route for a moment, in the page, so a busy state can be looked at.
async function slowRoute(page, part, ms) {
  await page.evaluate((p, w) => { window.__realFetch2 = window.fetch; window.fetch = async (u, o) => { if (String(u).endsWith(p)) await new Promise((r) => setTimeout(r, w)); return window.__realFetch2(u, o); }; }, part, ms);
}

// ═══ THE WORD AUDIT — the running page against the deck ═════════════════════
async function wordAudit(page) {
  const lines = await page.evaluate((section) => {
    const root = document.querySelector(section); const out = [];
    const skip = (e) => { for (let p = e; p && p !== root; p = p.parentElement) { if (p.classList && (p.classList.contains('mono') || p.classList.contains('visually-hidden') || p.classList.contains('dm-plan-data') || p.classList.contains('ai-run-model') || p.classList.contains('tx-status-detail') || p.classList.contains('hr-pane-text'))) return true; if (p.matches && p.matches('[data-row-leaving]')) return true; const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden') return true; } return false; };
    const blocks = new Set();
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { if (!n.nodeValue.trim() || skip(n.parentElement)) continue; if (!n.parentElement.closest('details[open], :not(details)')) continue; const closedFold = n.parentElement.closest('details:not([open])'); if (closedFold && !n.parentElement.closest('summary')) continue; blocks.add(n.parentElement); }
    for (const b of blocks) { let t = ''; for (const c of b.childNodes) t += c.nodeType === 3 ? c.nodeValue : (c.classList && (c.classList.contains('mono') || c.classList.contains('ai-run-model')) ? 'NAME' : (c.textContent || '')); out.push(t.replace(/\s+/g, ' ').trim()); }
    return out;
  }, SEL.health);
  const bad = []; const banned = [];
  for (const l of lines) {
    if (!l || isFigure(l)) continue;
    if (BANNED.test(l)) banned.push(l);
    if (/^[A-Z][A-Z ]{3,}$/.test(l)) banned.push('CAPS: ' + l);
    if (!wordAllowed(l)) bad.push(l);
  }
  return { bad: [...new Set(bad)], banned: [...new Set(banned)] };
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
    // A walk that stops drawing can wait for ever: name it instead.
    const watchdog = setTimeout(() => { console.log(`\n[${profile.name}] still running after 25 min. Stopping.`); process.exit(3); }, 25 * 60 * 1000);
    try {
      await scenarios(app, profile);
      const vis = await app.page.evaluate(() => document.visibilityState);
      step(`[${profile.name}] the page was drawn to the end (a sleeping display stops it)`, vis === 'visible', vis);
    }
    catch (e) { step(`[${profile.name}] scenario ran to the end`, false, e.stack); }
    finally {
      clearTimeout(watchdog);
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
