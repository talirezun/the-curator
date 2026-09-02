/**
 * test-next-ui-polish.js — OFFLINE suite for two Settings-view UI fixes
 * reported directly from the running Mac app (src/public/next/views/settings.js
 * + views/settings.css).
 *
 * No network, no API key, no server, no browser. Both fixes are exercised by
 * extracting the real, live source (brace-matched, `new Function`) — the same
 * technique scripts/test-next-provider-rows.js and scripts/test-next-mcp-wizard.js
 * already use for this exact view.
 *
 * ── FIX 1 — the ACTIVE provider is visually distinct again ───────────────
 * `/old` (src/public/app.js, the frozen legacy bundle) rendered a single
 * global "Active: <Provider> — <model>" badge with a `.provider-dot` that
 * carried `background: var(--success)` — the browser app's colour signal.
 * `/next` replaced that with a PER-ROW state word ("active" / "configured" /
 * "not set") and — until this fix — NO colour at all: `.provider-state-active`
 * was `color: var(--text)`, identical in weight to `.provider-state-muted`'s
 * `--text-2` except for which rung of the neutral ramp it sat on.
 *
 * Painting the WORD itself in `--success-text` was tried once already and is
 * why it was reverted — settings.css's own file-header contrast table (this
 * file, measured live in both themes) records `--success-text 3.79-4.05
 * light`, under the 4.5:1 WCAG TEXT floor, while it clears the 3:1 NON-TEXT
 * floor at the same values. So the fix is an ICON next to the word — the
 * same icon+word split this file already uses at .settings-saved-note — never
 * the word's own colour. This suite pins that shape: the icon carries the
 * `--success-text` token, the word stays on `--text`, and — the accessibility
 * requirement — the word "active" is never removed, so colour is
 * reinforcement, never the only signal.
 *
 * ── FIX 2 — the MCP badge and the self-test result stop contradicting ────
 * Settings → MCP bridge could show "Needs re-connect" directly above a green
 * "✓ Bridge responds" self-test result, with nothing on screen explaining
 * why both were true at once. Investigation (src/routes/mcp.js) found this
 * is NOT a detection bug: `stale` (GET /api/mcp/config) compares Claude
 * Desktop's SAVED launch command against what The Curator would generate
 * TODAY, while the self-test (POST /api/mcp/self-test) always spawns the
 * freshly-computed CORRECT command and never reads the saved file at all
 * (deliberately, since v3.6.1 — see that handler's own comment). The two
 * facts are independently true and answer different questions. The fix adds
 * an explanatory note, gated on exactly the combination that reads as a
 * contradiction, rather than changing either detection.
 *
 * ── ENFORCED ──────────────────────────────────────────────────────────────
 *   - renderProviderRow(): the active row's `.provider-state` carries a
 *     `.provider-state-icon` (checkAlt) BEFORE the word "active"; a
 *     configured/not-set row carries neither the icon nor the class.
 *   - The word "active" is present as literal text in the active row's
 *     markup — colour is additive, not a replacement.
 *   - settings.css: `.provider-state-active` still resolves to `--text`
 *     (never `--success-text`/`--success` — the historical, reverted
 *     regression) and `.provider-state-icon` resolves to `--success-text`.
 *   - deriveMcpStatus() / shouldShowMcpStaleNote(): pure, extracted, driven
 *     against every combination of {parseError, installed, stale, selfTest}
 *     that matters, including the exact contradiction report (installed +
 *     stale + a successful self-test) and every neighbour that must NOT
 *     show the note (not stale, self-test absent, self-test failed,
 *     self-test present with no explicit `ok:true`, unreadable config).
 *   - renderMcp() is actually WIRED to shouldShowMcpStaleNote()'s verdict —
 *     a source-level guard, since the function itself is not independently
 *     extractable without the full render/state stack (same limitation
 *     test-next-provider-rows.js documents for renderProviders()).
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *   - Real contrast measurement. The figures cited above are this file's
 *     OWN existing header comment, taken in a real browser; this suite
 *     checks the TOKEN NAMES used, not pixels — a regression that swaps in
 *     a different, equally-non-compliant token would not be caught by
 *     contrast math here.
 *   - Anything about mcp-wizard.js's `interpretMcpConfig` — untouched by
 *     this change and already covered by test-next-mcp-wizard.js.
 *   - Full renderMcp() rendering (DOM, state transitions, click wiring) —
 *     out of reach from Node without the whole app.js closure stack; see
 *     the wiring guard note above for what stands in for it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SETTINGS_JS_PATH = path.join(ROOT, 'src/public/next/views/settings.js');
const SETTINGS_CSS_PATH = path.join(ROOT, 'src/public/next/views/settings.css');
const settingsJs = readFileSync(SETTINGS_JS_PATH, 'utf8');
const settingsCss = readFileSync(SETTINGS_CSS_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Brace-matched extraction — copied verbatim from
// scripts/test-next-provider-rows.js (own-your-own-test-file convention: no
// cross-file import between test scripts in this project). ────────────────
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  const extracted = m[0].trim().replace(/^export\s+/, '');
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced`);
  }
  return extracted;
}

/**
 * Find `<span ...>` starting at `openTagRegex` and return its INNER html,
 * matching nested `<span>...</span>` pairs by depth rather than stopping at
 * the first `</span>` — the naive non-greedy `([\s\S]*?)<\/span>` regex
 * closes on the FIRST nested span's own end tag (verified: it returned the
 * icon's closing tag and nothing of the word beside it), which would make
 * "the word is still there" pass vacuously on an empty capture rather than
 * genuinely check anything.
 */
function extractBalancedSpanInner(html, openTagRegex) {
  const m = openTagRegex.exec(html);
  if (!m) return null;
  const contentStart = m.index + m[0].length;
  const tagRe = /<span\b[^>]*>|<\/span>/g;
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    if (t[0] === '</span>') {
      depth--;
      if (depth === 0) return html.slice(contentStart, t.index);
    } else {
      depth++;
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// FIX 1 — provider row active-state icon
// ══════════════════════════════════════════════════════════════════════════

section('§1  Extraction sanity — renderProviderRow, infoMark, PROVIDER_ROWS, TX_INFO_GLYPH');

function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Real enough for substring assertions: echoes back the requested icon name
// and size so a test can tell WHICH icon rendered, mirroring escapeHtmlStub's
// own "real enough to prove branching, not an escaping quirk" standard.
function iconStub(name, size) {
  return `<svg data-icon="${name}" data-size="${size}"></svg>`;
}
const stubState = { replacing: null, keysBusy: null };

let renderProviderRow;
try {
  const body =
    extractConst(settingsJs, 'PROVIDER_ROWS') + '\n' +
    extractConst(settingsJs, 'TX_INFO_GLYPH') + '\n' +
    extractFunction(settingsJs, 'infoMark') + '\n' +
    extractFunction(settingsJs, 'renderProviderRow') + '\n' +
    'return { renderProviderRow, PROVIDER_ROWS };';
  const factory = new Function(
    'escapeHtml', 'crossWriteTitle', 'state', 'icon', 'providerConnected',
    body,
  );
  const built = factory(
    escapeHtmlStub,
    (msg) => 'cross-write: ' + msg,
    stubState,
    iconStub,
    // v3.45.0. The real `providerConnected` reads the route's `connected` map
    // where the route sends one and degrades to the saved-key test where it
    // does not. This suite's subject is the ICON, not the resolution, and its
    // fixtures speak the saved-key dialect — so the degraded arm is reproduced
    // here rather than extracted, and the resolution itself is driven for real
    // in scripts/test-next-provider-rows.js, which extracts both functions.
    (prov, k) => !!(k && k['has' + prov.id.charAt(0).toUpperCase() + prov.id.slice(1) + 'Key']),
  );
  renderProviderRow = built.renderProviderRow;
  ok(typeof renderProviderRow === 'function', 'renderProviderRow extracted as a function');
  ok(Array.isArray(built.PROVIDER_ROWS) && built.PROVIDER_ROWS.length >= 1, 'PROVIDER_ROWS extracted as a non-empty array');
} catch (err) {
  ok(false, `extraction did not throw (got: ${err.message})`);
  process.exit(1);
}

section('§2  A CONNECTED row carries the icon; a not-connected row does not');

const geminiRow = { id: 'gemini', name: 'Gemini', available: true, dot: '#000' };
const baseKeys = (overrides) => Object.assign({
  geminiApiKey: 'AIza-fixture-9f3a', hasGeminiKey: true,
  anthropicApiKey: null, hasAnthropicKey: false,
  openrouterApiKey: null, hasOpenrouterKey: false,
  models: { gemini: 'gemini-2.5-flash-lite' },
  activeProvider: 'gemini',
}, overrides);

// ── UPDATED DELIBERATELY (v3.45.0) ─────────────────────────────────
// The row's status was one of THREE monospace words — `active` / `configured` /
// `not set` — and the icon marked the first. Only one of the three was ever
// about the credential: `active` meant "this provider builds your wiki", which
// is now stated once, in block 2, with the price and the provenance beside it.
// A credential row answers one question and now says so in two plain words:
// Connected / Not connected, in the text face.
//
// THE PROPERTY THIS SECTION EXISTS FOR IS UNCHANGED and is what is asserted
// below: the check mark is REINFORCEMENT, never a replacement for the word; it
// comes FIRST, so the row reads "tick Connected" and not "Connected tick"; and
// the negative state carries no glyph at all.
{
  const connectedHtml = renderProviderRow(geminiRow, baseKeys({}), false);
  ok(/provider-state-icon/.test(connectedHtml), 'connected row: .provider-state-icon is present');
  ok(/data-icon="checkAlt"/.test(connectedHtml), 'connected row: the icon is checkAlt, not a placeholder or a different glyph');
  ok(/provider-pill-on/.test(connectedHtml), 'connected row: carries the affirmative pill class');
  // Structural, not a loose "both substrings present" check, so a regression
  // that moves the icon after the word is still caught.
  const stateSpanInner = extractBalancedSpanInner(connectedHtml, /<span class="provider-pill [^"]*">/);
  ok(stateSpanInner !== null, 'connected row: the pill span itself is findable, nested spans and all');
  ok(!!stateSpanInner && /^<span class="provider-state-icon"/.test(stateSpanInner), 'connected row: the icon is the FIRST child of the pill, ahead of the word');
  const stateSpanText = (stateSpanInner || '').replace(/<[^>]+>/g, '').trim();
  ok(stateSpanText === 'Connected',
    `connected row: the word "Connected" is present as real text (got "${stateSpanText}") — colour and glyph are reinforcement, not a replacement (accessibility requirement)`);
  // And the retired vocabulary is GONE rather than merely unused: a row still
  // saying "configured" beside a pill saying "Connected" would be the
  // two-words-for-one-fact defect this change removes, wearing a new class.
  ok(!/>configured<|>not set<|>active</.test(connectedHtml),
    'connected row: none of the three retired monospace words survives anywhere on it');
}

{
  // No key at all -> "Not connected", no icon. The provider that BUILDS the
  // wiki is deliberately irrelevant here now, so this fixture no longer names
  // one — that separation is the thing being asserted.
  const notSetHtml = renderProviderRow(geminiRow, baseKeys({ hasGeminiKey: false, geminiApiKey: null }), false);
  ok(!/provider-state-icon/.test(notSetHtml), 'not-connected row: NO icon');
  ok(/provider-pill-off/.test(notSetHtml), 'not-connected row: carries the negative pill class');
  ok(/>Not connected</.test(notSetHtml), 'not-connected row: the words themselves read "Not connected"');
}

{
  // A CONNECTED provider that is NOT the one building the wiki still reads
  // "Connected": the row no longer holds an opinion about the build lane,
  // which is the whole point of moving that decision into block 2.
  const otherKeys = baseKeys({ activeProvider: 'anthropic', hasAnthropicKey: true, anthropicApiKey: 'sk-ant-fixture' });
  ok(/>Connected</.test(renderProviderRow(geminiRow, otherKeys, false)),
    'a connected provider that is not the build provider still reads "Connected"');
  ok(!/data-set-active=/.test(renderProviderRow(geminiRow, otherKeys, false, { allowSetActive: false })),
    'and with allowSetActive:false — how the page renders it — it offers no build-lane control at all');
  ok(/data-set-active=/.test(renderProviderRow(geminiRow, otherKeys, false)),
    'CONTROL: the default is still to OFFER it, so the degraded escape hatch is never lost by omission');
}

section('§3  settings.css — the WORD stays on the neutral ramp; the ICON alone carries the status colour');

// This is the regression this suite exists to prevent: --success-text was
// already tried as the WORD's colour once (this file's own file-header
// contrast table: 3.79-4.05 light, under the 4.5 TEXT floor) and reverted.
// A future edit re-introducing it on .provider-state-active would fail WCAG
// exactly as before.
{
  // UPDATED (v3.45.0): `.provider-state-active` retired with the word it
  // styled. The regression it guards against is REAL and unchanged —
  // `--success-text` was tried as the WORD's colour once (3.79–4.05:1 in light,
  // under the 4.5 TEXT floor) and reverted — so the guard follows the word to
  // its new class rather than being deleted with the old one.
  const activeRule = /\.provider-pill-on\s*\{([^}]*)\}/.exec(settingsCss);
  ok(!!activeRule, '.provider-pill-on rule exists');
  const activeBody = activeRule ? activeRule[1] : '';
  ok(!/--success-text/.test(activeBody),
    '.provider-pill-on: the WORD does not take --success-text — the reverted contrast regression stays reverted');
  // The retired class is gone from the stylesheet — and the scan is on
  // SELECTORS, not on the raw text, because the prose above .provider-pill-on
  // legitimately explains which rule it inherited its contrast constraint from
  // and a comment naming a dead class is not a dead rule.
  const cssNoComments = settingsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/\.provider-state-active/.test(cssNoComments),
    'and the retired class is gone from the stylesheet, not left behind to be re-adopted');
  ok(/\.provider-pill-on/.test(cssNoComments),
    'CONTROL: the comment-stripped stylesheet still contains the class that replaced it — the strip is not eating the file');
}
{
  const iconRule = /\.provider-state-icon\s*\{([^}]*)\}/.exec(settingsCss);
  ok(!!iconRule, '.provider-state-icon rule exists');
  const iconBody = iconRule ? iconRule[1] : '';
  ok(/color:\s*var\(--success-text\)/.test(iconBody), '.provider-state-icon: color is var(--success-text) — clears the 3:1 non-text floor per this file\'s own measured table');
}

// ══════════════════════════════════════════════════════════════════════════
// FIX 2 — MCP badge / self-test reconciliation note
// ══════════════════════════════════════════════════════════════════════════

section('§4  Extraction sanity — deriveMcpStatus, shouldShowMcpStaleNote');

let deriveMcpStatus, shouldShowMcpStaleNote;
try {
  const body =
    extractFunction(settingsJs, 'deriveMcpStatus') + '\n' +
    extractFunction(settingsJs, 'shouldShowMcpStaleNote') + '\n' +
    'return { deriveMcpStatus, shouldShowMcpStaleNote };';
  const factory = new Function(body);
  const built = factory();
  deriveMcpStatus = built.deriveMcpStatus;
  shouldShowMcpStaleNote = built.shouldShowMcpStaleNote;
  ok(typeof deriveMcpStatus === 'function', 'deriveMcpStatus extracted as a function');
  ok(typeof shouldShowMcpStaleNote === 'function', 'shouldShowMcpStaleNote extracted as a function');
} catch (err) {
  ok(false, `extraction did not throw (got: ${err.message})`);
  process.exit(1);
}

section('§5  deriveMcpStatus() — the pill, unchanged in behaviour by this fix');

{
  const s = deriveMcpStatus({ installed: true, stale: false, claude_config_parse_error: false });
  ok(s.connected === true, 'installed + not stale -> connected');
  ok(s.pillLabel === 'Connected', 'pillLabel "Connected"');
  ok(s.wizardLabel === 'Re-run setup', 'wizardLabel "Re-run setup"');
}
{
  const s = deriveMcpStatus({ installed: true, stale: true, claude_config_parse_error: false });
  ok(s.connected === false, 'installed + stale -> NOT connected');
  ok(s.pillLabel === 'Needs re-connect', 'pillLabel "Needs re-connect" — the exact text the maintainer reported');
  ok(s.wizardLabel === 'Re-connect', 'wizardLabel "Re-connect"');
}
{
  const s = deriveMcpStatus({ installed: false, stale: false, claude_config_parse_error: false });
  ok(s.connected === false, 'not installed -> not connected');
  ok(s.pillLabel === 'Not connected', 'pillLabel "Not connected"');
  ok(s.wizardLabel === 'Set up Claude Desktop', 'wizardLabel "Set up Claude Desktop"');
}
{
  const s = deriveMcpStatus({ installed: false, stale: false, claude_config_parse_error: true });
  ok(s.unreadable === true, 'a parse error is reported as unreadable');
  ok(s.connected === false, 'a parse error is never reported as connected');
  ok(s.pillLabel === 'Config unreadable', 'pillLabel "Config unreadable" — not "Not connected", which would assert something unknown');
}

section('§6  shouldShowMcpStaleNote() — the note appears ONLY for the exact contradiction, never its neighbours');

const okSelfTest = { ok: true, tool_count: 20 };
const failedSelfTest = { ok: false, error: 'boom' };

{
  const status = deriveMcpStatus({ installed: true, stale: true, claude_config_parse_error: false });
  ok(shouldShowMcpStaleNote(status, { installed: true, stale: true }, okSelfTest) === true,
    'THE reported contradiction: installed + stale + a successful self-test -> note shown');
}
{
  const status = deriveMcpStatus({ installed: true, stale: false, claude_config_parse_error: false });
  ok(shouldShowMcpStaleNote(status, { installed: true, stale: false }, okSelfTest) === false,
    'connected (not stale) + successful self-test -> no note (nothing to reconcile)');
}
{
  const status = deriveMcpStatus({ installed: true, stale: true, claude_config_parse_error: false });
  ok(shouldShowMcpStaleNote(status, { installed: true, stale: true }, null) === false,
    'stale, but self-test has not been run yet -> no note (nothing to contradict the pill yet)');
}
{
  const status = deriveMcpStatus({ installed: true, stale: true, claude_config_parse_error: false });
  ok(shouldShowMcpStaleNote(status, { installed: true, stale: true }, failedSelfTest) === false,
    'stale + a FAILED self-test -> no note (the two already agree: something needs attention)');
}
{
  const status = deriveMcpStatus({ installed: true, stale: true, claude_config_parse_error: false });
  ok(shouldShowMcpStaleNote(status, { installed: true, stale: true }, { tool_count: 20 }) === false,
    'stale + a self-test result with no explicit `ok:true` -> no note (never infer success)');
}
{
  const status = deriveMcpStatus({ installed: false, stale: false, claude_config_parse_error: false });
  ok(shouldShowMcpStaleNote(status, { installed: false, stale: false }, okSelfTest) === false,
    'never installed at all -> no note (a different, already-clear state)');
}
{
  // Defense in depth: the route only computes installed/stale inside its
  // !parseError branch, so this combination should not occur in practice —
  // but the note must not fire on it regardless, since "unreadable" is its
  // own distinct, already-explained state.
  const status = deriveMcpStatus({ installed: true, stale: true, claude_config_parse_error: true });
  ok(shouldShowMcpStaleNote(status, { installed: true, stale: true }, okSelfTest) === false,
    'an unreadable config never shows the reconciliation note, even if installed/stale were somehow both true');
}

section('§7  Wiring — renderMcp() actually consults shouldShowMcpStaleNote(), not a hardcoded value');

// The DOM-touching renderMcp() cannot be extracted standalone (see the file
// header's NOT ENFORCED note) so this is a source-level guard, same
// limitation and same remedy test-next-provider-rows.js documents for
// renderProviders(). It still catches the two obvious ways to silently
// disconnect the fix: never calling the decision function, or calling it
// but ignoring the result.
{
  const renderMcpBody = extractFunction(settingsJs, 'renderMcp');
  ok(/shouldShowMcpStaleNote\s*\(/.test(renderMcpBody), 'renderMcp() calls shouldShowMcpStaleNote()');
  ok(/staleNoteHtml\s*=\s*shouldShowMcpStaleNote/.test(renderMcpBody), 'renderMcp() assigns staleNoteHtml FROM shouldShowMcpStaleNote()\'s result, not independently of it');
  ok(/\+\s*staleNoteHtml\s*\+/.test(renderMcpBody) || /staleNoteHtml\s*\+/.test(renderMcpBody),
    'renderMcp() actually concatenates staleNoteHtml into its returned markup');
}
{
  ok(/\.settings-mcp-stale-note/.test(settingsCss), 'settings.css defines .settings-mcp-stale-note');
  const ruleMatch = /\.settings-mcp-stale-note\s*\{([^}]*)\}/.exec(settingsCss);
  const ruleBody = ruleMatch ? ruleMatch[1] : '';
  ok(/border:[^;]*var\(--attention-text\)/.test(ruleBody) && /background:[^;]*var\(--attention-tint\)/.test(ruleBody),
    '.settings-mcp-stale-note: border + tint carry the ATTENTION tone (same pattern as .settings-write-busy-note / .settings-activation-note)');
  // Checked SEPARATELY from the div's own border above — a mutation that
  // strips ONLY the svg rule's colour (leaving the div's border untouched)
  // was verified, by mutation, to slip past a combined "div-or-svg" check:
  // the div's own border still matches, so the combined regex stayed green
  // while the icon silently lost its colour. Each carrier is now its own
  // named assertion.
  const svgRuleMatch = /\.settings-mcp-stale-note svg\s*\{([^}]*)\}/.exec(settingsCss);
  const svgRuleBody = svgRuleMatch ? svgRuleMatch[1] : '';
  ok(/color:\s*var\(--attention-text\)/.test(svgRuleBody),
    '.settings-mcp-stale-note svg: the icon ITSELF carries --attention-text (checked independently of the div\'s border)');
}

console.log(`\n────────────────────────────────────────────────────────────`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ /next UI-polish assertions FAILED');
  process.exit(1);
} else {
  console.log('✅ All /next UI-polish assertions green');
}
