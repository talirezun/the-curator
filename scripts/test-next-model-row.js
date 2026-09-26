/**
 * test-next-model-row.js — OFFLINE suite for shared/model-row.js + .css
 * (v3.72.0, P4: the model picker redesign).
 *
 * The composer's Model menu and the browse dialog render one BODY from one
 * builder. This suite imports that builder directly (it is DOM-free and
 * import-free by design) and drives it against the REAL catalogue served by
 * src/brain/llm.js — no hand-typed model list — plus the stylesheet rules
 * that make the row readable on the selected accent pill.
 *
 *   §1  formatters: exact prices, the three price states, context words,
 *       the promotion line derived from llm.js's own fields.
 *   §2  the row: name / price / meta / promo, in that order; the id at rest
 *       only in the browse surface and the accessible name; provider as a
 *       WORD; "default" only when told; no ingest verdict in either surface;
 *       the browse note LABELLED "For building the wiki:".
 *   §3  escaping — every interpolated field, with a positive control.
 *   §4  the stylesheet: every text class the builder emits takes
 *       `currentColor` on the selected pill (M-b: --text-2 on violet was
 *       2.31:1); no --text-3 (a disabled rung) and no --prov-* hue (M-c);
 *       chat.css keeps no `.chat-mm-*` rule.
 *   §5  the delegation: chat.js imports the builder and emits no row markup
 *       of its own; the composer strip's one-row rule exists and is keyed to
 *       the ROW's width (a container query), not the viewport.
 *   §6  F4: a measured speed names the call it timed.
 *
 * NOT ENFORCED here, stated: the measured contrast of the selected row
 * (4.53:1 dark / 6.57:1 light) and the one-row fit at 1400px are browser
 * measurements, recorded in the P4 report with the screenshots.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOfferableModels } from '../src/brain/llm.js';
import {
  PROVIDER_WORDS, providerWord, formatPricePerM, priceFact, formatIsoDay,
  promotionText, contextWords, metaParts, ingestNoteText, modelRowBodyHtml,
  modelMenuFootHtml, syncedDay,
} from '../src/public/next/shared/model-row.js';
import { formatModelSummary } from '../src/public/next/shared/model-summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEXT = path.join(__dirname, '../src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const PROVIDERS = ['gemini', 'anthropic', 'openrouter'];
const REAL = Object.fromEntries(PROVIDERS.map((p) => [p, listOfferableModels(p)]));
const ALL = PROVIDERS.flatMap((p) => REAL[p].map((e) => ({ p, e })));

// ═════════════════════════════════════════════════════════════════════════
section('§1  Formatters — every figure from the catalogue, none rounded away');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(ALL.length >= 15, `corpus: ${ALL.length} real catalogue entries across ${PROVIDERS.length} providers`);
  // Exact prices — the old composer printed $0.075 as "$0.08".
  const cases = [[0.075, '$0.075'], [0.017, '$0.017'], [0.1, '$0.10'], [2, '$2.00'], [10, '$10.00'], [0.0001, '$0.0001'], [0, '$0.00']];
  for (const [n, want] of cases) ok(formatPricePerM(n) === want, `formatPricePerM(${n}) === "${want}" (got "${formatPricePerM(n)}")`);
  for (const bad of [null, undefined, NaN, Infinity, -1, '1']) ok(formatPricePerM(bad) === null, `formatPricePerM(${String(bad)}) refuses — never a placeholder`);
  for (const { e } of ALL) {
    const f = priceFact(e);
    if (e.free === true) ok(f.kind === 'free' && f.text === 'free', `${e.id}: free by the catalogue's FLAG`);
    else if (typeof e.input === 'number' && typeof e.output === 'number') {
      ok(f.kind === 'paid', `${e.id}: priced`);
      const [a, b] = f.text.split(' / ').map((s) => Number(s.slice(1)));
      ok(Math.abs(a - e.input) < 1e-12 && Math.abs(b - e.output) < 1e-12,
        `${e.id}: "${f.text}" parses back EXACTLY to the live ${e.input} / ${e.output}`);
    } else ok(f.kind === 'unknown', `${e.id}: unpriced reads "price unavailable"`);
  }
  ok(priceFact({ input: 0, output: 0 }).kind === 'paid', 'a $0/$0 entry WITHOUT the free flag is not called free');
  ok(priceFact({ free: false }).text === 'price unavailable', 'free:false with no price is UNKNOWN, not free');
  // Context words in the vendor's units.
  const ctx = [[1048576, '1M'], [524288, '512K'], [262144, '256K'], [200000, '200K'], [131000, '131K'], [1000000, '1M'], [0, ''], [null, ''], [1.5, '']];
  for (const [n, want] of ctx) ok(contextWords(n) === want, `contextWords(${n}) === "${want}" (got "${contextWords(n)}")`);
  // The promotion, from llm.js's own fields on every promoted entry.
  const promoted = ALL.filter(({ e }) => e.promotionUntilIso && e.input !== e.standardInput);
  ok(promoted.length >= 1, `corpus: ${promoted.length} entries are on a live promotion today`);
  for (const { e } of promoted) {
    const t = promotionText(e);
    ok(t.startsWith('until ' + formatIsoDay(e.promotionUntilIso) + ', then '), `${e.id}: "${t}" starts from the promotion's last day`);
    ok(t.includes(formatPricePerM(e.standardInput) + ' / ' + formatPricePerM(e.standardOutput)),
      `${e.id}: and names the standard price ${e.standardInput} / ${e.standardOutput}`);
    ok(!/\d{4}-\d{2}-\d{2}/.test(t), `${e.id}: no raw ISO date`);
  }
  for (const { e } of ALL.filter(({ e }) => !e.promotionUntilIso)) {
    ok(promotionText(e) === '', `${e.id}: no promotion, no line`);
  }
  ok(promotionText({ promotionUntilIso: '2026-12-31', input: 1.5, output: 7.5, standardInput: 1.5, standardOutput: 7.5 }) === '',
    'an EXPIRED promotion (live == standard) claims no rise');
  ok(promotionText({ promotionUntilIso: '2026-12-31' }) === 'until 31 Dec 2026, then the price rises',
    'unknown standard prices still warn (fail-safe on money)');
  ok(syncedDay('2026-08-30T10:00:00.000Z') === '30 Aug 2026' && syncedDay('nope') === '' && syncedDay(null) === '',
    'syncedDay: a real instant becomes a day; anything else becomes nothing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  The row — name, price, meta, promo; chat facts only');
// ═════════════════════════════════════════════════════════════════════════
{
  const order = (html, classes) => {
    const at = classes.map((c) => html.indexOf('class="' + c));
    return at.every((v) => v >= 0) && at.every((v, i) => i === 0 || v > at[i - 1]);
  };
  for (const { p, e } of ALL) {
    const menu = modelRowBodyHtml(p, e);
    const browse = modelRowBodyHtml(p, e, { surface: 'browse', summary: formatModelSummary(e, { compact: true }) });
    ok(order(menu, ['mr-title', 'mr-price', 'mr-meta']), `${e.id}: menu reads name → price → meta`);
    ok(order(browse, ['mr-title', 'mr-price', 'mr-id', 'mr-meta']), `${e.id}: browse reads name → price → id → meta`);
    ok(menu.includes('<span class="mr-meta">' + providerWord(p)), `${e.id}: meta leads with the provider WORD`);
    ok(!/dot|--prov-|style=/.test(menu + browse), `${e.id}: no provider dot, no inline style`);
    ok(!menu.includes('mr-id') && browse.includes('>' + e.id + '<'), `${e.id}: id at rest only in browse`);
    ok(!/\bdefault\b/.test(menu), `${e.id}: "default" is not claimed unless the caller says so`);
    ok(modelRowBodyHtml(p, e, { isDefault: true }).includes('</span>default'), `${e.id}: …and is shown when it does`);
    ok(menu.includes('thinks') === (e.thinks === true), `${e.id}: "thinks" exactly when the catalogue says so`);
    for (const html of [menu, browse]) {
      ok(!/>\s*(caution|out-performed|dominated|chat[ -]only)\s*</.test(html), `${e.id}: no ingest-verdict badge`);
    }
    ok(!/ingest|pages per source/.test(menu), `${e.id}: the menu row states no ingest measurement`);
    const note = /<span class="mr-note">([^<]*)<\/span>/.exec(browse);
    const summary = formatModelSummary(e, { compact: true });
    if (summary) ok(!!note && note[1].startsWith('For building the wiki: '), `${e.id}: browse labels the ingest facts "For building the wiki:"`);
    else ok(!note, `${e.id}: nothing measured → no note element`);
  }
  // Every provider word is the one Settings uses for the key that pays.
  const settings = read('views/settings.js');
  for (const p of PROVIDERS) {
    ok(new RegExp(`id: '${p}',\\s*name: '${PROVIDER_WORDS[p]}'`).test(settings),
      `${p}: "${PROVIDER_WORDS[p]}" is Settings' own name for this provider`);
  }
  ok(ingestNoteText('') === '' && ingestNoteText('  ') === '', 'no summary → no note');
  const foot = modelMenuFootHtml({ syncedAt: '2026-08-30T10:00:00.000Z' });
  ok(/Prices per 1M tokens, input \/ output/.test(foot) && /remembered on this computer across chats/.test(foot)
    && /OpenRouter catalogue synced 30 Aug 2026/.test(foot), 'the foot: unit, where the choice lives, the catalogue\'s own sync day');
  ok(!/synced/.test(modelMenuFootHtml({})), 'no date when none is known');
  ok(metaParts('gemini', { thinks: true, contextLength: 1048576 }, { detailed: true }).join(' · ') ===
    'Gemini · thinks — reasoning billed as output · 1,048,576-token context', 'the browse meta spells out thinking and the exact context');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Escaping');
// ═════════════════════════════════════════════════════════════════════════
{
  const X = '"><img src=x onerror=alert(1)>';
  const hostile = { id: X, label: X, input: 1, output: 2, promotionUntilIso: X, standardInput: 3, standardOutput: 4, contextLength: 1000 };
  const out = modelRowBodyHtml(X, hostile, { surface: 'browse', summary: X }) + modelRowBodyHtml(X, hostile);
  ok(!out.includes('<img'), 'no raw tag from label, id, provider, promotion or summary');
  ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'positive control: the hostile text IS present, escaped');
  ok(providerWord('__proto__') === '__proto__', '__proto__ is an unknown provider, shown as itself');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  The stylesheet — the selected pill, no disabled rung, no page-type hue');
// ═════════════════════════════════════════════════════════════════════════
{
  const css = stripComments(read('shared/model-row.css'));
  const js = read('shared/model-row.js');
  const emitted = [...new Set([...js.matchAll(/class="(mr-[a-z-]+)/g)].map((m) => m[1]))];
  const TEXT = emitted.filter((c) => !['mr-body', 'mr-badge', 'mr-foot'].includes(c));
  ok(TEXT.length >= 6, `the builder emits ${TEXT.length} text classes (${TEXT.join(', ')})`);
  const sel = /((?:\.lb-opt\.is-selected \.mr-[a-z-]+,\s*)*\.lb-opt\.is-selected \.mr-[a-z-]+)\s*\{\s*color:\s*currentColor;\s*\}/.exec(css);
  const covered = new Set(sel ? [...sel[1].matchAll(/\.mr-([a-z-]+)/g)].map((m) => 'mr-' + m[1]) : []);
  for (const c of TEXT) ok(covered.has(c), `.${c} takes currentColor on the selected accent pill`);
  ok(/\.lb-opt\.is-selected \.mr-badge\s*\{[^}]*border-color:\s*currentColor/.test(css), 'badges on the pill keep an edge in the pill\'s own colour');
  ok(!/--text-3\b/.test(css), 'no --text-3 anywhere in the row (a disabled rung, under AA)');
  ok(!/--prov-/.test(css), 'no --prov-* hue (the page-type colours, DESIGN.md M-c)');
  ok(!/font-size:\s*\d/.test(css), 'every size is a ramp token, none a literal');
  const chatCss = stripComments(read('views/chat.css'));
  ok(!/\.chat-mm-|\.chat-dd-opt/.test(chatCss), 'chat.css keeps no .chat-mm-* / .chat-dd-opt rule');
  ok(/href="\/next\/shared\/model-row\.css"/.test(read('index.html')), 'index.html links model-row.css');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Delegation and the composer row');
// ═════════════════════════════════════════════════════════════════════════
{
  const chat = read('views/chat.js');
  ok(/import \{[^}]*modelRowBodyHtml[^}]*\} from '\.\.\/shared\/model-row\.js'/.test(chat), 'chat.js imports the ONE row builder');
  ok(!/chat-mm-|chat-dd-opt/.test(chat.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'chat.js emits no old row class');
  ok(!/function (formatPricePerM|formatLivePrice|formatPromotionRise|formatIsoDay)\b/.test(chat), 'no price/date formatter left in chat.js — one copy, in model-row.js');
  ok(!/SUITABILITY_LABELS\s*=/.test(chat), 'the chat-side suitability badge table is gone');
  ok(chat.includes("ariaLabel: 'Model for your next question'"), 'the menu is named for the NEXT question (per browser, not per chat)');
  ok(!/Model for this chat|changes the model for this chat/.test(chat), 'no copy claims a per-conversation model');
  const chatCss = stripComments(read('views/chat.css'));
  ok(/\.chat-composer-controls\s*\{[^}]*container-type:\s*inline-size/.test(chatCss), 'the control row is a size container');
  const cq = /@container chatctl \(min-width: (\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(chatCss);
  // v3.77.0: the v3.72.0 one-row rule (nowrap + flex-shrink weights) clipped
  // "Early Computi…" at 1280px by 0.22px. The pills now never shrink and the
  // strip wraps; the BEHAVIOUR is measured in a real browser by
  // test-chat-composer-pills.js (LIVE_LOCAL). This pins the source shape.
  ok(!!cq && !/nowrap/.test(cq[2]), 'the wide-row block no longer forces one line');
  ok(!/flex-shrink:\s*(?!0\s*[;}])[\d.]+/.test(chatCss.slice(chatCss.indexOf('.chat-composer-pickers {'), chatCss.indexOf('/* ── ASK AGAIN'))),
    'no composer pill is given a flex-shrink weight above 0');
  ok(/\.chat-composer-pickers > \.lb,\s*\.chat-composer-pickers > \.chat-project-host\s*\{\s*flex:\s*0 0 auto/.test(chatCss),
    'each pill keeps its natural width (flex: 0 0 auto)');
  ok(/\.chat-composer-pickers\s*\{[^}]*flex-wrap:\s*wrap/.test(chatCss), 'the strip wraps instead');
  ok(!!cq && /\.chat-model-lb-root \.chat-pill-k\s*\{\s*display:\s*none/.test(cq[2]) && !/chat-(domain|length)-lb-root \.chat-pill-k|chat-project-host \.chat-pill-k/.test(cq[2]),
    'on a wide row only the Model pill drops its leading word; Domain, Project and Length keep theirs');
  ok(!!cq && !/font-size/.test(cq[2]), 'no type is shrunk to make it fit');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  F4 — a measured speed names the call it timed');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = formatModelSummary({ medianLatencyMs: 48000 }, { compact: true });
  ok(s === 'about 48s per ingest call in our testing', `speed clause: "${s}"`);
  ok(formatModelSummary({ medianLatencyMs: 500 }, { compact: true }) === '', 'under a second: no clause (never "0s")');
  const measured = ALL.filter(({ e }) => Number.isFinite(e.medianLatencyMs) && e.medianLatencyMs >= 1000);
  ok(measured.length >= 1, `corpus: ${measured.length} real entries carry a latency`);
  for (const { e } of measured) ok(/per ingest call in our testing/.test(formatModelSummary(e)), `${e.id}: its speed says INGEST`);
}

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ model-row assertions FAILED'); process.exit(1); }
console.log('✅ All model-row assertions green');
