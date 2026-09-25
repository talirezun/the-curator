#!/usr/bin/env node
/**
 * test-next-settings-truth.js — OFFLINE suite for v3.72.1's Settings "true
 * numbers" fixes (truth audit part-settings F3, F4, F6–F14 and part-tray-copy
 * F3, F4, F6), driven through the REAL functions lifted out of
 * src/public/next/views/settings.js and views/mcp-wizard.js.
 *
 *   §1  F6 / tray F3 — the input-price bands are CONTIGUOUS: a grid of prices
 *       across every edge lands in exactly one priced band, $1–$3 included,
 *       and the group says what it measures.
 *   §2  F3 / F4 — a hand-priced row says when its price was checked and when it
 *       was measured, and says so on the row when OpenRouter's live list
 *       disagrees (worded by direction; silent when not compared).
 *   §3  F7 / tray F4 — the scan-limits block carries no second copy of the
 *       default and no one-model dollar figure, and its lede names the one scan
 *       the ceiling governs.
 *   §4  F8 — the Verify confirm re-reads which model it runs on every time, and
 *       System check results say when they were taken and that a provider /
 *       key / model change has made them stale.
 *   §5  F9 / F10 / tray F6 — Across projects states the windows the route
 *       sent, discloses a store younger than the pulse window, and is re-read
 *       on the 30 s tick when the save stamp moved.
 *   §6  F11 — a refused default-domain save keeps the old value and says why.
 *   §7  F12 / F13 / F14 — the wizard counts working-state writers as writers,
 *       the MCP pill says "Configured", and no "local" provider is advertised.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
const wizard = readFileSync(path.join(ROOT, 'src/public/next/views/mcp-wizard.js'), 'utf8');
const { formatPricePerM } = await import('../src/public/next/shared/model-row.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  const same = Object.is(a, b);
  ok(same, same ? label : `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Brace-matched extraction (the house extractor, copied: no cross-imports
// between test scripts in this project). ──────────────────────────────────
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" did not end at a top-level brace`);
  return out;
}
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  const out = m[0].trim().replace(/^export\s+/, '');
  if (/\bfunction\s/.test(out)) throw new Error(`extractConst: "${name}" swallowed a function`);
  return out;
}
const escapeHtml = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// One sandbox over the real settings.js functions this suite drives.
const FNS = ['browseBandPass', 'formatIsoDay', 'formatSyncedAt', 'formatModelPrice', 'providerLabel',
  'priceAsOfText', 'livePriceText', 'renderQuickSummary', 'markSystemCheckStale', 'setLiveRunsOn',
  'openLiveConfirm', 'windowDaysWords', 'renderAcrossProjectsBody', 'acrossProjectsStamp',
  'refreshMcpUsage', 'onSaveDefaultDomain', 'scanCeilingHint', 'formatTokenCount', 'renderHealthLimits',
  'deriveMcpStatus'];
const CONSTS = ['MODEL_PRICE_BANDS', 'SETTINGS_SECTIONS', 'ACROSS_PROJECTS_MAX_ROWS',
  'SCAN_LIMIT_REFUSAL', 'MCP_DOMAIN_CONSEQUENCE'];
const state = {};
const H = { fetches: [], renders: 0, acrossLoads: [], fetchImpl: null };
const INJECT = {
  escapeHtml, state, formatPricePerM,
  formatUsdHonest: (await import('../src/public/next/shared/format-usd.js')).formatUsdHonest,
  icon: (n) => `<i data-icon="${n}"></i>`,
  render: () => { H.renders++; },
  isCurrentMount: () => true,
  fetch: (url, init) => { H.fetches.push(url); return H.fetchImpl(url, init); },
  renderRunsOn: (ro) => `<runs model="${ro.model}"></runs>`,
  aiActionDisabledAttrs: () => '',
  identityDotClass: (i) => 'id-' + i,
  renderMonitor: (o) => `<monitor label="${escapeHtml(o.label)}">` +
    o.lines.map((l) => `<line key="${escapeHtml(l.key)}" value="${escapeHtml(String(l.value))}" sub="${escapeHtml(l.sub || '')}"></line>`).join('') +
    `<note>${escapeHtml(o.note || '')}</note></monitor>`,
  gatedLoader: () => '<LOADER/>', loadGate: null,
  settingsBlock: (num, id, title, lede, body) => `<block id="${id}"><lede>${lede}</lede>${body}</block>`,
  fetchMcpUsage: async () => H.usageVerdict,
  usageSignature: (d) => JSON.stringify(d),
  applyUsageVerdict: (v) => { state.mcpUsage = v.data; state.mcpUsageSig = JSON.stringify(v.data); },
  loadAcrossProjects: async (token, opts) => { H.acrossLoads.push(opts || null); },
  renderToolMapBody: () => '', wireExerciseControl: () => {},
  TOOL_MAP_BODY_SEL: '#none', ACROSS_PROJECTS_BODY_SEL: '#none',
  document: undefined,
};
const names = Object.keys(INJECT);
const body = CONSTS.map((c) => extractConst(settings, c)).join('\n') + '\n' +
  FNS.map((f) => extractFunction(settings, f)).join('\n') + '\n' +
  'return {' + FNS.concat(CONSTS).join(', ') + '};';
const S = new Function(...names, body)(...names.map((n) => INJECT[n]));

// ─────────────────────────────────────────────────────────────────────────
section('§1. The price bands are contiguous and say what they measure [F6, tray F3]');
{
  const priced = S.MODEL_PRICE_BANDS.filter(([id, , pred]) => pred && id !== 'free');
  const grid = [0.001, 0.017, 0.1999, 0.2, 0.5, 0.9999, 1, 1.5, 2, 2.9999, 3, 5, 15];
  const misses = [], doubles = [];
  for (const input of grid) {
    const hits = priced.filter(([id]) => S.browseBandPass({ input, free: false }, id)).map(([id]) => id);
    if (hits.length === 0) misses.push(input);
    if (hits.length > 1) doubles.push(input + '→' + hits.join('+'));
  }
  ok(misses.length === 0, '★ every positive input price lands in a band — $1.50 and $2 included [the "$0.20–$1 · $3 and up" hole reds here]' +
    (misses.length ? ` — IN NO BAND: ${misses.join(', ')}` : ''));
  ok(doubles.length === 0, '…and in exactly ONE, so the band counts add up to the total' +
    (doubles.length ? ` — IN TWO: ${doubles.join(', ')}` : ''));
  ok(S.MODEL_PRICE_BANDS.some(([id, label]) => id === 'upper' && label === '$1–$3'), 'a "$1–$3" band exists');
  ok(S.browseBandPass({ input: 2, free: false }, 'upper') && !S.browseBandPass({ input: 2, free: false }, 'high'),
    'claude-sonnet-5 ($2) is in $1–$3, not in "$3 and up"');
  ok(/aria-label="Input price per 1M tokens"/.test(settings) && /browse-seg-caption">Input price per 1M tokens</.test(settings),
    'the band group is labelled "Input price per 1M tokens", visibly and for a screen reader');
}

// ─────────────────────────────────────────────────────────────────────────
section('§2. A hand-priced row is dated, and says when OpenRouter\'s list disagrees [F3, F4]');
{
  const base = { id: 'upstage/solar-pro4', provider: 'openrouter', input: 0.09, output: 0.36,
    standardInput: 0.09, standardOutput: 0.36, priceAsOf: '2026-09-25', measuredOn: '2026-08-27' };
  eq(S.priceAsOfText(base), 'price checked 25 Sep 2026 · measured 27 Aug 2026',
    '★ the row states the day the price was checked and the day the model was measured [F4]');
  eq(S.priceAsOfText({ id: 'x', free: true, priceAsOf: '2026-09-25', measuredOn: '' }), '',
    'a free row claims no price date');
  eq(S.priceAsOfText({ id: 'fetched/x' }), '', 'a fetched row (no dates) states none');

  eq(S.livePriceText(Object.assign({}, base, { livePriceDiffers: null, livePrice: null })), '',
    '★ NOT COMPARED says nothing — never "matches"');
  eq(S.livePriceText(Object.assign({}, base, { livePriceDiffers: false,
    livePrice: { input: 0.09, output: 0.36, listedAt: '2026-09-25T09:00:00Z' } })), '', 'a matching list says nothing');
  const upText = S.livePriceText(Object.assign({}, base, { livePriceDiffers: true,
    livePrice: { input: 0.27, output: 1.08, listedAt: '2026-09-25T09:00:00Z' } }));
  ok(upText.startsWith('OpenRouter now lists $0.27 in · $1.08 out'), `★ an upward repricing is stated with the live figure — "${upText.slice(0, 60)}…" [F3]`);
  ok(/estimates use the higher of each/.test(upText), '…and says estimates now use it');
  const downText = S.livePriceText(Object.assign({}, base, { id: 'z-ai/glm-5.3-flash', input: 0.045, output: 0.14,
    standardInput: 0.045, standardOutput: 0.14, livePriceDiffers: true,
    livePrice: { input: 0.03, output: 0.1, listedAt: '2026-09-25T09:00:00Z' } }));
  ok(/below the checked price/.test(downText) && /until a bill confirms/.test(downText),
    'a downward headline is stated too, and says it is not used until a bill confirms it');
  ok(S.formatModelPrice(0.075, 0.25) === '$0.075 in · $0.25 out',
    '★ Settings prints a rate EXACTLY, with the formatter Chat uses — $0.075, not "$0.08"');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3. The scan-limits hint states the default and its price from the route [F7, tray F4]');
{
  // The route's real payload: config.js's DEFAULT_AI_HEALTH, priced by the
  // scan's own describeHealthRun on the model in force (a fixture of that
  // shape here; test-model-price-truth.js is the brain half).
  const { DEFAULT_AI_HEALTH } = await import('../src/brain/config.js');
  const ro = { needsKey: false, modelLabel: 'Flash Lite 2.5', free: false, usdHigh: 0.044 };
  Object.assign(state, { aiHealthError: null,
    aiHealth: { costCeilingTokens: 300000, semanticDupeMaxPairs: 500, defaults: { ...DEFAULT_AI_HEALTH }, defaultRunsOn: ro },
    costCeilingInput: '300000', maxPairsInput: '500', scanLimitsValidationError: null,
    aiHealthSaving: false, aiHealthSaved: false });
  const html = S.renderHealthLimits();
  const grouped = String(DEFAULT_AI_HEALTH.costCeilingTokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  ok(html.includes('Default ' + grouped),
    `★ the default shown IS config.js's DEFAULT_AI_HEALTH (${grouped}) — no second copy [F7: a typed "50,000" reds here]`);
  ok(!/50,000/.test(html) || DEFAULT_AI_HEALTH.costCeilingTokens === 50000, 'no stale 50,000 survives beside a different constant');
  ok(html.includes('≈ $0.04 on Flash Lite 2.5, the model that builds your wiki'),
    '★ the dollar figure is the route\'s price for the model in force, marked ≈ — never "$0.01 on Gemini Flash Lite"');
  ok(!/Gemini Flash Lite/.test(html), 'the one-model literal is gone');
  ok(html.includes('Default ' + DEFAULT_AI_HEALTH.semanticDupeMaxPairs + '.'), 'the pair cap\'s default comes off the same payload');
  ok(/AI duplicate scan/.test(html) && !/Ask AI scans/.test(html),
    '★ the lede names the ONE scan the ceiling governs, not every Ask AI scan');
  ok(/value="300000"/.test(html), 'CONTROL: the value in force (the user\'s own 300,000) is in the input');
  eq(S.scanCeilingHint({ defaults: DEFAULT_AI_HEALTH, defaultRunsOn: { needsKey: true } }),
    'Estimated input and output tokens together. Default ' + grouped + '.', 'with no key, the default and no price');
  ok(/free on X/.test(S.scanCeilingHint({ defaults: DEFAULT_AI_HEALTH, defaultRunsOn: { modelLabel: 'X', free: true } })),
    'a free build model says free, never $0.00');
  eq(S.scanCeilingHint({}), 'Estimated input and output tokens together.', 'an older server (no defaults) drops the clause — never guessed');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4. The Verify confirm re-reads its model; old check results say they are stale [F8]');
{
  H.fetches.length = 0;
  let model = 'gemini-2.5-flash-lite';
  H.fetchImpl = async () => ({ ok: true, json: async () => ({ liveCheck: { runsOn: { model } } }) });
  Object.assign(state, { liveRunsOn: undefined });
  await S.openLiveConfirm(1);
  eq(state.liveRunsOn && state.liveRunsOn.model, 'gemini-2.5-flash-lite', 'fixture: the first open reads the run line');
  model = 'claude-haiku-4-5'; // the user switched build model in Providers
  await S.openLiveConfirm(1);
  eq(H.fetches.filter((u) => u === '/api/diagnostics/quick').length, 2,
    '★ a SECOND open reads again — the line is not cached for the life of the mount [F8: the old early-return reds here]');
  eq(state.liveRunsOn && state.liveRunsOn.model, 'claude-haiku-4-5', '★ …so the confirm names the model in force now');

  state.quick = { checks: [{ status: 'ok', label: 'AI provider key', detail: 'Configured: gemini' }],
    summary: { ok: 1 }, checkedAtMs: new Date(2026, 8, 25, 14, 5).getTime(), stale: false };
  const fresh = S.renderQuickSummary(state.quick);
  ok(/checked 14:05/.test(fresh), 'check results say when they were taken');
  ok(!/Checked before your last/.test(fresh), 'CONTROL: fresh results carry no stale note');
  S.markSystemCheckStale();
  eq(state.liveRunsOn, undefined, 'a provider mutation forgets the run line');
  const stale = S.renderQuickSummary(state.quick);
  ok(/Checked before your last provider, key or model change/.test(stale),
    '★ after a key / provider / model change the old rows SAY they predate it');
  for (const fn of ['onSaveKey', 'onDisconnect', 'onSetActive', 'onPickBuildModel']) {
    ok(/markSystemCheckStale\(\)/.test(extractFunction(settings, fn)), `${fn} marks the check stale on success`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('§5. Across projects states the windows it was sent, and moves with the saves [F9, F10, tray F6]');
{
  const mk = (windowDays, pulse) => ({
    byProject: [{ domain: 'projects', project: 'curator', sessions: 3, sessionsSaved: 2 },
      { domain: 'projects', project: 'idle', sessions: 0, sessionsSaved: 0 }],
    window: { windowDays, logPresent: true, busiestSaved: 2 },
    savePulse: pulse,
  });
  Object.assign(state, { defaultDomainInfo: { domains: ['projects'] }, mcpProjectsError: null });
  state.mcpProjects = mk(14, { events: 3, windowSeconds: 3 * 86400, lowerBound: false, coversWholeWindow: true, oldestEventAt: null });
  const a = S.renderAcrossProjectsBody();
  ok(/label="Sessions that saved, per project, last 14 days"/.test(a),
    '★ the window is the one the ROUTE sent (14 here), not a typed 30 [F10]');
  ok(/sub="no session, last 14 days"/.test(a), '…in the idle row too');
  ok(/key="saves, last 3 days"/.test(a), '★ …and the pulse window from `windowSeconds` (3 days here), not a typed 7');
  ok(!/30 days|7 days/.test(a), 'no typed 30 or 7 survives in the body');
  state.mcpProjects = mk(30, { events: 2, windowSeconds: 604800, lowerBound: true, coversWholeWindow: false,
    oldestEventAt: '2026-09-22T10:00:00.000Z' });
  const b = S.renderAcrossProjectsBody();
  ok(/key="saves, last 7 days \(records begin [^"]*2026[^"]*\)"/.test(b),
    '★ a store younger than the window says where its record begins, rather than claiming a whole observed week');
  ok(/value="at least 2"/.test(b), 'CONTROL: the lower-bound disclosure is unchanged');
  eq(S.windowDaysWords(undefined), '', 'an absent window drops the clause — never invented');

  // F9: the 30 s tick re-reads block ④ when the save stamp moved, not otherwise.
  H.acrossLoads.length = 0;
  state.section = 'mcp';
  state.mcpUsage = { sessions: { lastSaveAt: '2026-09-25T09:00:00Z', lastBootstrapAt: 'b1' }, tools: [] };
  state.mcpUsageSig = 'old';
  H.usageVerdict = { ok: true, data: { sessions: { lastSaveAt: '2026-09-25T09:00:00Z', lastBootstrapAt: 'b1' }, tools: [1] } };
  await S.refreshMcpUsage(1);
  eq(H.acrossLoads.length, 0, 'a tick where only a tool count moved does not re-read Across projects');
  H.usageVerdict = { ok: true, data: { sessions: { lastSaveAt: '2026-09-25T09:05:00Z', lastBootstrapAt: 'b1' }, tools: [1] } };
  await S.refreshMcpUsage(1);
  eq(H.acrossLoads.length, 1, '★ a tick where an agent SAVED re-reads Across projects on the same tick [F9]');
  ok(H.acrossLoads[0] && H.acrossLoads[0].bodyOnly === true, '…repainting its body only, like block ③');
  ok(!/last 30 days/.test(extractFunction(settings, 'renderAcrossProjects')), 'the lede carries no typed window');

  // The ⓘ is static prose (shared/explainers.js, not this package's file), so
  // its two windows are PINNED to the constants the route counts with: a
  // change to either window turns this red until the prose moves with it.
  const { TRAY_CAPTURE_WINDOW_DAYS, PULSE_WINDOW_SECONDS } = await import('../src/brain/tray-summary.js');
  const { EXPLAINERS } = await import('../src/public/next/shared/explainers.js');
  const xp = JSON.stringify(EXPLAINERS['settings.mcp-across'] || {});
  ok(xp.includes('last ' + TRAY_CAPTURE_WINDOW_DAYS + ' days'),
    `the Across projects ⓘ states the capture window the route uses (${TRAY_CAPTURE_WINDOW_DAYS} days) [tray F6]`);
  ok(xp.includes('last ' + (PULSE_WINDOW_SECONDS / 86400) + ' days'),
    `…and the save-pulse window (${PULSE_WINDOW_SECONDS / 86400} days)`);
}

// ─────────────────────────────────────────────────────────────────────────
section('§6. A refused default-domain save keeps the old value and says why [F11]');
{
  H.fetches.length = 0;
  state.defaultDomainInfo = { defaultDomain: 'articles', domains: ['articles', 'gone'] };
  state.defaultDomainError = null;
  H.fetchImpl = async (url, init) => (init && init.method === 'POST')
    ? { ok: false, status: 400, json: async () => ({ error: 'Unknown domain: gone' }) }
    : { ok: true, json: async () => ({ defaultDomain: 'articles', domains: ['articles'] }) };
  await S.onSaveDefaultDomain('gone', 1);
  eq(state.defaultDomainInfo.defaultDomain, 'articles',
    '★ the selector keeps the value the SERVER kept — not undefined, which read as "unset" [F11]');
  eq(state.defaultDomainError, 'Unknown domain: gone', '★ …and the refusal is shown');
  eq(state.defaultDomainInfo.domains.join(','), 'articles', '…and the domain list is re-read (the likely cause is a rename or delete)');
  ok(state.mcpError === undefined, 'the section-wide error is untouched — one refused save does not blank the MCP page');
  H.fetchImpl = async () => ({ ok: true, json: async () => ({ defaultDomain: 'projects', domains: ['projects'] }) });
  await S.onSaveDefaultDomain('projects', 1);
  eq(state.defaultDomainInfo.defaultDomain, 'projects', 'CONTROL: a successful save lands');
  eq(state.defaultDomainError, null, '…and clears the refusal');
}

// ─────────────────────────────────────────────────────────────────────────
section('§7. The wizard, the MCP pill and the providers subtitle say what is true [F12, F13, F14]');
{
  const W = new Function('icon', extractConst(wizard, 'TOOL_TOTAL') + '\n' + extractConst(wizard, 'TOOL_WRITE') + '\n' +
    extractConst(wizard, 'TOOL_READ') + '\n' + extractFunction(wizard, 'panelStep3') + '\nreturn { panelStep3 };')((n) => `<i ${n}></i>`);
  const p3 = W.panelStep3();
  ok(/17 that read, 7 that write: to your wiki, and to your projects’ working state/.test(p3),
    '★ the seven writers are not all called wiki writers — three write working state [F12]');
  ok(/Write working state:/.test(p3) && /handoff, its brief and its documents/.test(p3), '…and the working-state writes are named');
  ok(/Counted from mcp\/tools\/index\.js: 24 tools, of which 7 mutate/.test(wizard), 'the header record says 24 tools, 7 mutating (it said 22 and 6)');

  const s = S.deriveMcpStatus({ installed: true, stale: false, claude_config_parse_error: false });
  eq(s.pillLabel, 'Configured', '★ a current saved config reads "Configured", not "Connected" — no client was observed [F13]');

  const prov = S.SETTINGS_SECTIONS.find(([id]) => id === 'providers');
  ok(prov && !/local/i.test(prov[2]), '★ the Providers subtitle advertises no "local" provider — none exists [F14]');
}

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ settings truth assertions FAILED'); process.exit(1); }
console.log('✅ All settings truth assertions green');
