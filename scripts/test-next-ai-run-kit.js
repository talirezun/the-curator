/**
 * test-next-ai-run-kit.js — OFFLINE suite for the run line (v3.67.0, package J):
 * src/public/next/shared/ai-run.js + ai-run.css.
 *
 *   §1  Every row of DESIGN-ai-jobs P4, as rendered text: priced point, range,
 *       free, unpriced, with latency, no key, after, after-approx, after-fallback,
 *       plus the group form ("each action shows its cost") and the extra line.
 *       Dollar figures are DERIVED from formatUsdHonest — the one formatter —
 *       never retyped, so a second formatter reds here.
 *   §2  Anatomy: the human label with `Provider · id` in `title`; figures in the
 *       mono span; role="note" + id; the door omitted inSettings; absent figures
 *       omitted, never "$0.00"; hostile strings escaped, hostile ids dropped.
 *   §3  aiActionDisabledAttrs: disabled + aria-describedby → the line's id.
 *   §4  wireAiRunDoors: the INJECTED door opens Providers & keys, once, idempotent.
 *   §5  The stylesheet: no tone token in any `color:`, no colour literal, mono +
 *       tabular figures; linked once from index.html.
 *   §6  The module imports nothing from app.js; its escapeHtml is app.js's, byte
 *       for byte.
 *   §7  The join: a REAL describeRun()/spentFromUsage() object renders.
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'LLM_MODEL']) delete process.env[k];
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('no network'); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'src/public/next/shared/ai-run.js');
const CSS = path.join(ROOT, 'src/public/next/shared/ai-run.css');

const { renderRunsOn, renderSpent, aiActionDisabledAttrs, wireAiRunDoors } = await import(KIT);
const { formatUsdHonest } = await import('../src/public/next/shared/format-usd.js');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
function eq(a, b, label) { ok(a === b, `${label}`, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function section(t) { console.log(`\n${t}`); }

/** The rendered line as a reader sees it: tags stripped, entities decoded. */
function text(html) {
  return String(html).replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
const $ = (n) => formatUsdHonest(n);

const GEMINI = { job: 'reading-plan', jobLabel: 'Suggest a reading plan', needsKey: false,
  provider: 'gemini', providerLabel: 'Gemini', model: 'gemini-2.5-flash-lite', modelLabel: 'Gemini 2.5 Flash Lite' };

// ═════════════════════════════════════════════════════════════════════════
section('1. Every P4 row, verbatim (dollars through formatUsdHonest)');
const priced = { ...GEMINI, inputTokens: 5600, inputTokensLow: 5600, inputTokensHigh: 5600,
  outputTokensLow: 400, outputTokensHigh: 400, usdLow: 0.0012, usdHigh: 0.0012, priceKnown: true, free: false, costNote: 'priced' };
eq(text(renderRunsOn(priced)),
  `Runs on Gemini 2.5 Flash Lite · ≈6k tokens · ≈${$(0.0012)} · Change model`, 'priced, point');

const range = { ...GEMINI, job: 'compile', inputTokens: 16000, inputTokensLow: 14000, inputTokensHigh: 18000,
  outputTokensLow: 4000, outputTokensHigh: 6000, usdLow: 0.002, usdHigh: 0.004, priceKnown: true, free: false, costNote: 'priced' };
eq(text(renderRunsOn(range)),
  `Runs on Gemini 2.5 Flash Lite · ≈18k–24k tokens · ≈${$(0.002)}–${$(0.004)} · Change model`, 'priced, range');

const free = { ...GEMINI, provider: 'openrouter', providerLabel: 'OpenRouter', model: 'deepseek/deepseek-v4-flash:free',
  modelLabel: 'DeepSeek V4 Flash', inputTokens: 6000, inputTokensLow: 5500, inputTokensHigh: 6100,
  outputTokensLow: 300, outputTokensHigh: 300, usdLow: 0, usdHigh: 0, priceKnown: true, free: true, costNote: 'free' };
eq(text(renderRunsOn(free)), 'Runs on DeepSeek V4 Flash (free) · ≈6k tokens · free · Change model', 'free');

const unpriced = { ...GEMINI, model: 'zz-model', modelLabel: 'Some Model', inputTokens: 6000, inputTokensLow: 5500,
  inputTokensHigh: 6200, outputTokensLow: 200, outputTokensHigh: 200, priceKnown: false, free: false, costNote: 'price-not-published' };
eq(text(renderRunsOn(unpriced)),
  'Runs on Some Model · ≈6k tokens · price not published: your provider bills at its rate · Change model', 'unpriced');
ok(!/\$/.test(text(renderRunsOn(unpriced))), 'unpriced: no dollar sign anywhere on the line');

const latency = { ...priced, medianLatencyMs: 48000 };
eq(text(renderRunsOn(latency)),
  `Runs on Gemini 2.5 Flash Lite · ≈6k tokens · ≈${$(0.0012)} · about 48 s · Change model`, 'with measured latency');
eq(text(renderRunsOn({ ...priced, medianLatencyMs: 382000 })).includes('about 6 min'), true, 'a long latency reads in minutes');
ok(!/about/.test(text(renderRunsOn({ ...priced, medianLatencyMs: 400 }))), 'a sub-second latency says nothing');

const noKey = { job: 'reading-plan', jobLabel: 'Suggest a reading plan', needsKey: true };
eq(text(renderRunsOn(noKey)), 'Needs an AI provider key · Add one in Providers & keys', 'no key');

const spent = { provider: 'gemini', providerLabel: 'Gemini', model: 'gemini-2.5-flash-lite', modelLabel: 'Gemini 2.5 Flash Lite',
  inputTokens: 5812, outputTokens: 640, cachedReadTokens: 0, cacheWriteTokens: 0, calls: 1, usd: 0.0008, estimated: false, fallbackFrom: null };
eq(text(renderSpent(spent)), `Ran on Gemini 2.5 Flash Lite · 5,812 in / 640 out · ${$(0.0008)}`, 'after the run');
eq(text(renderSpent({ ...spent, estimated: true })),
  `Ran on Gemini 2.5 Flash Lite · 5,812 in / 640 out · approx. ${$(0.0008)}`, 'after, estimated → "approx."');
eq(text(renderSpent({ ...spent, model: 'gemini-3.1-flash-lite', modelLabel: 'Gemini 3.1 Flash Lite', usd: 0.0021,
  fallbackFrom: 'gemini-2.5-flash-lite' })),
  `Ran on Gemini 3.1 Flash Lite (your model was unavailable) · 5,812 in / 640 out · ${$(0.0021)}`, 'after, fallback');
eq(text(renderSpent({ ...spent, inputTokens: 800, cachedReadTokens: 5000, cacheWriteTokens: 12 })).includes('5,812 in'), true,
  '"in" counts the whole prompt: uncached + cached reads + cache writes');
eq(text(renderSpent({ ...spent, usd: null })), 'Ran on Gemini 2.5 Flash Lite · 5,812 in / 640 out · price not published',
  'after, unpriced → "price not published", never $0.00');
eq(text(renderSpent({ ...spent, usd: 0 })).endsWith(' · $0.00'), true, 'after, free → the true zero');

eq(text(renderRunsOn({ ...GEMINI, priceKnown: true, free: false, costNote: 'priced' }, { figuresNote: 'each action shows its cost' })),
  'Runs on Gemini 2.5 Flash Lite · each action shows its cost · Change model', 'the group form (Quick maintenance)');
const compileLine = renderRunsOn(range, { extraLine: 'Compile uses your AI model, not the model this chat is on (Claude Sonnet 5).' });
eq(text(compileLine),
  `Runs on Gemini 2.5 Flash Lite · ≈18k–24k tokens · ≈${$(0.002)}–${$(0.004)} · Change model`
  + 'Compile uses your AI model, not the model this chat is on (Claude Sonnet 5).', 'extraLine: the run line, then the clause');
ok(/<span class="ai-run-extra">Compile uses/.test(compileLine), 'extraLine is its own block span (a second line)');

// ═════════════════════════════════════════════════════════════════════════
section('2. Anatomy');
{
  const h = renderRunsOn(priced, { id: 'rp-run' });
  ok(/<span class="ai-run-model" title="Gemini · gemini-2.5-flash-lite">Gemini 2\.5 Flash Lite<\/span>/.test(h),
    'the model is its human label; title carries "Provider · model-id"');
  ok(/^<p class="ai-run" role="note" id="rp-run">/.test(h), 'one element, role="note", carrying the id for aria-describedby');
  ok(/<span class="ai-run-fig">≈6k tokens<\/span>/.test(h), 'token figure in the mono span');
  ok(new RegExp('<span class="ai-run-fig">≈\\' + $(0.0012) + '</span>').test(h), 'dollar figure in the mono span');
  eq((h.match(/data-ai-run-door="providers"/g) || []).length, 1, 'one door');
  ok(/<button type="button" class="ai-run-door" data-ai-run-door="providers">Change model<\/button>/.test(h), 'the door is a real button');
  const s = renderRunsOn(priced, { inSettings: true });
  ok(!/data-ai-run-door/.test(s) && !/Change model/.test(s), 'inSettings: no door');
  eq(text(s), `Runs on Gemini 2.5 Flash Lite · ≈6k tokens · ≈${$(0.0012)}`, 'inSettings: the line without its door');
  const nk = renderRunsOn(noKey, { inSettings: true });
  eq(text(nk), 'Needs an AI provider key', 'inSettings, no key: no door');
  ok(!/class="[^"]*(tone|warn|danger|ok)\b/.test(h + renderRunsOn(noKey) + renderSpent(spent)),
    'no tone class anywhere on the line (a price is a fact)');
  // Absent means omitted.
  const bare = renderRunsOn({ ...GEMINI, priceKnown: true, free: false, costNote: 'priced' });
  eq(text(bare), 'Runs on Gemini 2.5 Flash Lite · Change model', 'no figures → no tokens and no cost clause');
  ok(!/\$0\.00/.test(bare), 'absent money never prints $0.00');
  ok(!/\$/.test(text(renderRunsOn({ ...priced, usdLow: undefined, usdHigh: undefined }))), 'a priced run without usd prints no dollars');
  eq(renderRunsOn(null), '', 'null runsOn → nothing');
  eq(renderRunsOn({}), '', 'a runsOn naming no model → nothing');
  eq(renderSpent(null), '', 'null spent → nothing');
  eq(renderSpent({ ...spent, model: null }), '', 'nothing ran (no model) → nothing');
  // Hostile strings.
  const XSS = '<img src=x onerror=alert(1)>"\'';
  const hx = renderRunsOn({ ...priced, modelLabel: XSS, providerLabel: XSS, model: XSS }, { extraLine: XSS, figuresNote: undefined })
    + renderSpent({ ...spent, modelLabel: XSS, model: XSS, providerLabel: XSS });
  ok(!/<img/.test(hx) && !/onerror=alert\(1\)>/.test(hx.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'labels, ids and the extra line are escaped');
  ok(!/id="/.test(renderRunsOn(priced, { id: 'x" onmouseover="alert(1)' })), 'a hostile id is dropped, not escaped into the attribute');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. aiActionDisabledAttrs — disabled, never hidden');
eq(aiActionDisabledAttrs(noKey, 'rp-run'), ' disabled aria-disabled="true" aria-describedby="rp-run"',
  'no key → disabled + aria-describedby pointing at the run line');
eq(aiActionDisabledAttrs(priced, 'rp-run'), '', 'a runnable model → no attributes');
eq(aiActionDisabledAttrs(null, 'rp-run'), '', 'no runsOn yet → no attributes (the host decides its loading state)');
eq(aiActionDisabledAttrs(noKey, 'bad" id'), ' disabled aria-disabled="true"', 'a hostile id is dropped, the button is still disabled');
{
  const id = 'hc-run';
  const btn = '<button class="btn btn-ai"' + aiActionDisabledAttrs(noKey, id) + '>✨ Suggest with AI</button>';
  const line = renderRunsOn(noKey, { id });
  ok(btn.includes('aria-describedby="' + id + '"') && line.includes('id="' + id + '"'), 'the button\'s description IS the no-key line');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. wireAiRunDoors — the door is injected, and opens Providers & keys');
{
  function fakeRoot() {
    const listeners = [];
    return { listeners, addEventListener(type, fn) { listeners.push([type, fn]); } };
  }
  const calls = [];
  const deps = { requestSettingsSection: (s) => calls.push(['section', s]), navigate: (v) => calls.push(['navigate', v]) };
  const root = fakeRoot();
  eq(wireAiRunDoors(root, deps), true, 'wired');
  eq(wireAiRunDoors(root, deps), true, 'wired again');
  eq(root.listeners.length, 1, 'idempotent: one listener after two wirings');
  let prevented = 0;
  const doorEl = { dataset: { aiRunDoor: 'providers' } };
  root.listeners[0][1]({ target: { closest: (sel) => (sel === '[data-ai-run-door]' ? doorEl : null) }, preventDefault: () => prevented++ });
  eq(JSON.stringify(calls), JSON.stringify([['section', 'providers'], ['navigate', 'settings']]),
    'a door click: requestSettingsSection("providers"), THEN navigate("settings")');
  eq(prevented, 1, 'the click is consumed');
  root.listeners[0][1]({ target: { closest: () => null }, preventDefault: () => prevented++ });
  eq(calls.length, 2, 'a click elsewhere does nothing');
  eq(wireAiRunDoors(fakeRoot(), {}), false, 'missing functions → not wired (no silent dead door)');
  eq(wireAiRunDoors(null, deps), false, 'no root → not wired');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. The stylesheet');
{
  const css = readFileSync(CSS, 'utf8');
  const BARE = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const TONE_TOKENS = ['--success-text', '--attention-text', '--danger-text', '--success', '--attention', '--danger'];
  const offenders = [];
  for (const m of BARE.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const d of m[2].split(';')) {
      const t = d.trim();
      if (!/^color\s*:/.test(t)) continue;
      if (TONE_TOKENS.some((tok) => new RegExp(tok.replace(/-/g, '\\-') + '\\b').test(t))) offenders.push(m[1].trim() + ' { ' + t + ' }');
    }
  }
  ok(offenders.length === 0, 'no `color:` names a tone token (the monitor-kit rule)', offenders.join(' | '));
  ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(BARE), 'no colour literal: tokens only');
  ok(/\.ai-run-fig\s*\{[^}]*font-family:\s*var\(--font-mono\)[^}]*font-variant-numeric:\s*var\(--numeric-tabular\)/.test(BARE),
    'figures are mono and tabular');
  ok(/\.ai-run\s*\{[^}]*color:\s*var\(--text-2\)/.test(BARE), 'the line\'s words are --text-2');
  ok(/\.ai-run-door\s*\{[^}]*color:\s*var\(--accent-text\)/.test(BARE), 'the door is the accent link');
  const html = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
  eq((html.match(/<link rel="stylesheet" href="\/next\/shared\/ai-run\.css">/g) || []).length, 1, 'index.html links ai-run.css exactly once');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. The module stands alone');
{
  const src = readFileSync(KIT, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...code.matchAll(/(?:^|\n)\s*import\b[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] || m[2]);
  eq(JSON.stringify(imports), JSON.stringify(['./format-usd.js']), 'the kit imports only the honest formatter — never app.js');
  ok(!/\bfetch\s*\(/.test(code), 'the kit never fetches');
  const fn = (s) => (s.match(/function escapeHtml\(s\) \{[\s\S]*?\n\}/) || [''])[0];
  const appSrc = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
  ok(fn(src) && fn(src) === fn(appSrc), 'escapeHtml is app.js\'s, byte for byte');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. The join: real describeRun / spentFromUsage objects render');
{
  const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
  const { describeRun, spentFromUsage } = await import('../src/brain/ai-run.js');
  const TMP = mkdtempSync(path.join(tmpdir(), 'curator-test-ai-run-kit-'));
  __setUserDataDirOverride(TMP);
  try {
    writeFileSync(path.join(TMP, '.curator-config.json'), JSON.stringify({}));
    eq(text(renderRunsOn(describeRun({ job: 'reading-plan', inputChars: 24000 }))),
      'Needs an AI provider key · Add one in Providers & keys', 'a real no-key describeRun renders the no-key line');
    writeFileSync(path.join(TMP, '.curator-config.json'), JSON.stringify({ geminiApiKey: 'zz-dummy-not-real', activeProvider: 'gemini' }));
    const r = describeRun({ job: 'reading-plan', inputChars: 24000, outputTokensLow: 400, outputTokensHigh: 900 });
    const line = text(renderRunsOn(r));
    ok(line.startsWith('Runs on ' + r.modelLabel + ' · ≈') && line.includes(' tokens · ≈$') && line.endsWith(' · Change model'),
      'a real priced describeRun renders every clause', line);
    const s = spentFromUsage({ calls: 1, inputTokens: 5812, outputTokens: 640, cachedReadTokens: 0, cacheWriteTokens: 0, provider: 'gemini', model: r.model });
    eq(text(renderSpent(s)), `Ran on ${r.modelLabel} · 5,812 in / 640 out · ${$(s.usd)}`, 'a real spentFromUsage renders the after line');
  } finally {
    __setUserDataDirOverride(null);
    rmSync(TMP, { recursive: true, force: true });
  }
}
eq(networkAttempts, 0, 'zero network');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
