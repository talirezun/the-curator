/**
 * test-next-provider-colors-and-badge.js — OFFLINE suite.
 *
 * Two findings from the v3.24.2 design-system conformance audit, both named
 * verbatim in CLAUDE.md's KNOWN AND UNFIXED block:
 *
 * ── FINDING 1: ONE PROVIDER, TWO COLOURS ──────────────────────────────────
 * views/settings.js's PROVIDER_ROWS table hand-picked `dot: 'var(--type-
 * summary)'` for Anthropic — the amber "human attention required" status
 * colour — while views/chat.css's model picker used `var(--concept-400)`
 * green for the identical provider. Same provider, two colours, on a screen
 * a user visits back-to-back (Settings -> Chat model picker). Confirmed
 * against tokens/color.css's own header comment, which reserves the type
 * triad (cyan/green/amber = entity/concept/summary) and the status palette
 * (amber = "attention") for exactly those two jobs and states plainly they
 * are "never used to mean a data type" outside them — a provider identity
 * marker is neither, so Settings' choice of the attention/summary amber was
 * the one that had drifted onto a token whose meaning elsewhere on the same
 * screen is "act on this", not "identify this". chat.css's own choice (green
 * via --concept-400) was ALREADY the deliberate, reasoned one — its own
 * comment names refusing amber for a provider chip for exactly this reason.
 *
 * Fixed (v3.24.3) by moving the three --prov-* custom properties out of
 * chat.css (which had said "if a second view ever groups by provider they
 * should move" — Settings became that second view) into shell.css, the file
 * both views already load unconditionally, and pointing PROVIDER_ROWS at the
 * SAME tokens. CSS custom properties are the unification point across the
 * JS/CSS language boundary: the JS array never needs to know a hex value,
 * only the token's name, so a `style="background:var(--prov-anthropic)"`
 * string and a `.chat-mm-prov-dot { background: var(--prov-anthropic) }`
 * rule share one definition rather than two hand-maintained copies.
 *
 * ── FINDING 2: THE SYNC RAIL BADGE WAS HARDCODED TO DARK-THEME AMBER ──────
 * shell.css's `.rail-badge` painted two raw hex values (#E0A33A / #150A31)
 * with no light-theme variant, `999px` instead of `--radius-full`, and a
 * `9px` font-size below the type ramp's own floor (`--text-2xs` = 10px) and
 * outside `--font-scale`. THIS IS A THEME-PARITY / TOKEN-CONFORMANCE issue,
 * NOT an accessibility one — contrast measured 8.46:1 well before the fix,
 * so no assertion below claims otherwise; it only asserts the raw hex is
 * gone, `--radius-full` is used, and the font-size is on the ramp.
 *
 * ── WHAT THIS SUITE ENFORCES ──────────────────────────────────────────────
 *  §1  ONE SOURCE: the three --prov-* tokens are defined exactly once (dark)
 *      and once (light) each, and ONLY in shell.css — chat.css must not
 *      redefine them (that is exactly how the two sites diverged before).
 *  §2  PROVIDER_ROWS in settings.js (enumerated from its own source, not a
 *      hardcoded id list) points every ACTIVE provider's `dot` at the
 *      matching --prov-* token — so the JS side and the CSS side cannot
 *      silently re-diverge into two colours for one provider again.
 *  §3  No raw hex colour value reappears in a CSS declaration in shell.css
 *      or chat.css (the two files this pass touched) — comments stripped
 *      first, with an explicit positive control proving the strip is
 *      load-bearing (the exact false-negative shape CLAUDE.md's v3.24.2 row
 *      records: a prose comment satisfying a naive scan).
 *  §4  .rail-badge specifically: no `999px`/`9px` literals, `--radius-full`
 *      present, `--attention`/`--violet-950` present, `--font-scale` reached
 *      transitively through `--text-2xs`.
 *
 * ── WHAT THIS SUITE DOES NOT ENFORCE ──────────────────────────────────────
 * §3's hex scan is a TEXT SCAN OVER TWO NAMED FILES (shell.css, chat.css —
 * the files this pass owns), not a repo-wide sweep: a raw hex value in any
 * OTHER /next stylesheet (views/domains.js's DOMAIN_DOT_PALETTE is a KNOWN,
 * already-recorded instance, owned by a different pass) is invisible to it
 * by design, not by oversight. It also proves a declaration EXISTS with the
 * right token, never that it WINS the cascade — "some rule sets
 * `background: var(--attention)`" is weaker than "that declaration is what
 * paints the pixel", the same gap CLAUDE.md's v3.24.2 row names for its own
 * button-border guard. §2 trusts PROVIDER_ROWS as the single source feeding
 * every render site in settings.js (verified by inspection: all four
 * `.provider-dot` render sites read `p.dot`/`providerDot` derived from this
 * one table — see the module's own comment) rather than re-deriving that
 * from every call site itself. Actual computed-colour contrast is a browser
 * concern (this pass's own report states the measured figures and control
 * results); no offline suite in this repo measures rendering.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NEXT = path.join(ROOT, 'src/public/next');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Filesystem helpers — enumerated, nothing hardcoded beyond the extension.
// ─────────────────────────────────────────────────────────────────────────

function walk(dir, ext, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/**
 * Strip /* … *\/ comments before any scan below runs.
 *
 * LOAD-BEARING, not hygiene — CLAUDE.md's v3.24.2 row records this project's
 * own scanner hiding three of five button-chrome bugs because a prose
 * comment naming a class sat directly above a real rule and the naive
 * selector/body split treated the comment as part of the selector. §3's own
 * control below proves this strip is doing real work rather than being
 * vestigial.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const CSS_FILES = walk(path.join(NEXT), '.css').sort();
const SHELL_CSS_PATH = path.join(NEXT, 'shell.css');
const CHAT_CSS_PATH = path.join(NEXT, 'views/chat.css');
const SETTINGS_JS_PATH = path.join(NEXT, 'views/settings.js');

const shellCssRaw = readFileSync(SHELL_CSS_PATH, 'utf8');
const chatCssRaw = readFileSync(CHAT_CSS_PATH, 'utf8');
const settingsJsRaw = readFileSync(SETTINGS_JS_PATH, 'utf8');

const shellCss = stripComments(shellCssRaw);
const chatCss = stripComments(chatCssRaw);

// ═════════════════════════════════════════════════════════════════════════
// §1 — ONE SOURCE for the three provider-family tokens
// ═════════════════════════════════════════════════════════════════════════
section('§1 — provider-family tokens have exactly one source (shell.css)');

const PROV_IDS = ['gemini', 'anthropic', 'openrouter'];

for (const id of PROV_IDS) {
  const darkRe = new RegExp(`:root\\s*\\{[^}]*--prov-${id}\\s*:`, 's');
  const lightRe = new RegExp(`\\[data-theme=["']light["']\\]\\s*\\{[^}]*--prov-${id}\\s*:`, 's');
  ok(darkRe.test(shellCss), `shell.css defines --prov-${id} under :root`);
  ok(lightRe.test(shellCss), `shell.css defines --prov-${id} under [data-theme="light"]`);

  // Count ALL occurrences of a `--prov-<id>:` DEFINITION (not a `var(...)`
  // read) across every /next stylesheet — must be exactly 2 (one per theme),
  // and both must be in shell.css. This is what "one source" means
  // mechanically: a definition reappearing in a second file is exactly how
  // chat.css and settings.js diverged before this fix.
  const defRe = new RegExp(`--prov-${id}\\s*:`, 'g');
  let totalDefs = 0;
  let shellDefs = 0;
  for (const file of CSS_FILES) {
    const rel = path.relative(NEXT, file);
    const text = stripComments(readFileSync(file, 'utf8'));
    const matches = text.match(defRe);
    const count = matches ? matches.length : 0;
    totalDefs += count;
    if (rel === 'shell.css') shellDefs = count;
  }
  ok(totalDefs === 2, `--prov-${id} is DEFINED exactly twice across all /next CSS (found ${totalDefs})`);
  ok(shellDefs === 2, `both --prov-${id} definitions are in shell.css (found ${shellDefs} there)`);
}

// chat.css must still READ the tokens (it did not lose its provider-dot
// rules), just never DEFINE them again.
for (const id of PROV_IDS) {
  const readRe = new RegExp(`var\\(--prov-${id}\\)`);
  ok(readRe.test(chatCss), `chat.css still reads var(--prov-${id}) (did not lose its dot rule)`);
  const defRe = new RegExp(`--prov-${id}\\s*:`);
  ok(!defRe.test(chatCss), `chat.css does not (re)define --prov-${id}`);
}

// ═════════════════════════════════════════════════════════════════════════
// §2 — settings.js PROVIDER_ROWS points every active provider at the shared
// token, enumerated from the array itself (not a hardcoded id list).
// ═════════════════════════════════════════════════════════════════════════
section('§2 — settings.js PROVIDER_ROWS reads the shared --prov-* tokens');

const providerRowsMatch = settingsJsRaw.match(
  /const PROVIDER_ROWS = \[([\s\S]*?)\n\];/
);
ok(!!providerRowsMatch, 'PROVIDER_ROWS array found in settings.js source');

const rowText = providerRowsMatch ? providerRowsMatch[1] : '';
// One entry per `{ id: '...', ..., dot: '...', ..., available: ... }` line.
const rowRe = /\{\s*id:\s*'([^']+)'[^}]*?dot:\s*'([^']+)'[^}]*?available:\s*(true|false)\s*\}/g;
const rows = [];
let m;
while ((m = rowRe.exec(rowText))) {
  rows.push({ id: m[1], dot: m[2], available: m[3] === 'true' });
}
ok(rows.length >= 4, `PROVIDER_ROWS parsed with its expected rows (found ${rows.length})`);

const activeRows = rows.filter((r) => r.available);
ok(activeRows.length === 3, `exactly 3 rows are marked available (found ${activeRows.length})`);

for (const row of activeRows) {
  if (!PROV_IDS.includes(row.id)) {
    ok(false, `unexpected active provider id "${row.id}" — update PROV_IDS if a provider was added`);
    continue;
  }
  ok(row.dot === `var(--prov-${row.id})`,
    `PROVIDER_ROWS['${row.id}'].dot === 'var(--prov-${row.id})' (found '${row.dot}')`);
  // The specific regression this finding reported: Anthropic's dot must NOT
  // be the amber status/summary token, under any of its aliases.
  ok(!/--type-summary|--attention|--summary-/.test(row.dot),
    `PROVIDER_ROWS['${row.id}'].dot is not an amber/attention/summary token`);
}

// The unavailable row ('local') is deliberately NOT part of the provider-
// family palette (see the comment above PROVIDER_ROWS) — it must stay a
// neutral token, not a --prov-* one.
const localRow = rows.find((r) => r.id === 'local');
ok(!!localRow && localRow.dot === 'var(--text-faint)',
  `the unavailable 'local' row keeps its neutral var(--text-faint) dot`);

// ═════════════════════════════════════════════════════════════════════════
// §3 — no raw hex colour value in a CSS declaration in shell.css / chat.css
// ═════════════════════════════════════════════════════════════════════════
section('§3 — no raw hex colour survives in shell.css / chat.css declarations');

// Matches a hex colour used AS A DECLARATION VALUE: preceded by `:` (the
// property/value separator) and optional whitespace, so an id-like selector
// (`#abc123 {`) — which is never preceded by a colon — cannot false-positive.
const HEX_VALUE_RE = /:\s*#[0-9A-Fa-f]{3,8}\b/g;

function hexHits(strippedText) {
  const hits = strippedText.match(HEX_VALUE_RE) || [];
  return hits;
}

const shellHits = hexHits(shellCss);
const chatHits = hexHits(chatCss);
ok(shellHits.length === 0,
  `shell.css has 0 raw hex colour declarations (found ${shellHits.length}${shellHits.length ? ': ' + shellHits.join(', ') : ''})`);
ok(chatHits.length === 0,
  `chat.css has 0 raw hex colour declarations (found ${chatHits.length}${chatHits.length ? ': ' + chatHits.join(', ') : ''})`);

// THE COMMENT-SATISFIES-A-SCAN CONTROL, mirrored from test-next-button-
// chrome.js §4 for this file's own hex scan. Proves the comment strip is
// load-bearing rather than vestigial: the same raw hex, once inside a
// comment and once as a real declaration.
{
  const fixture = `
    /* a stray note: background: #ABCDEF was the old value, now tokenised */
    .zzz-real-rule { color: #123456; }
  `;
  const strippedHits = hexHits(stripComments(fixture));
  ok(strippedHits.length === 1 && strippedHits[0].includes('#123456'),
    'control: comment-only hex is NOT flagged; the real declaration IS (strip is load-bearing)');

  const unstrippedHits = hexHits(fixture);
  ok(unstrippedHits.length === 2,
    'control: WITHOUT stripping, the same fixture reports 2 hits — proves stripping changes the outcome, not just tidies it');
}

// ═════════════════════════════════════════════════════════════════════════
// §4 — .rail-badge specifically: tokens present, literals gone
// ═════════════════════════════════════════════════════════════════════════
section('§4 — .rail-badge is tokenised (theme parity + type-ramp conformance)');

const railBadgeMatch = shellCssRaw.match(/\.rail-badge\s*\{([\s\S]*?)\}/);
ok(!!railBadgeMatch, '.rail-badge rule found in shell.css');
const railBody = railBadgeMatch ? stripComments(railBadgeMatch[1]) : '';

ok(!/#[0-9A-Fa-f]{3,8}\b/.test(railBody), '.rail-badge body contains no raw hex literal');
ok(!/\b999px\b/.test(railBody), '.rail-badge does not hardcode 999px (uses --radius-full instead)');
ok(/--radius-full/.test(railBody), '.rail-badge uses var(--radius-full)');
ok(!/\b9px\b/.test(railBody), '.rail-badge does not hardcode the below-ramp 9px literal');
ok(/--text-2xs/.test(railBody), '.rail-badge font-size is on the ramp (--text-2xs)');
ok(/--attention\b/.test(railBody), '.rail-badge background reads the themed --attention token');
ok(/--violet-950/.test(railBody), '.rail-badge text colour reads --violet-950 (stable across themes)');
ok(/height:\s*15px/.test(railBody) && /15px\s*var\(--font-mono\)/.test(railBody),
  '.rail-badge keeps a fixed 15px box height paired with a 15px line-height (vertical centring at any --font-scale)');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All provider-colour / rail-badge assertions green');
