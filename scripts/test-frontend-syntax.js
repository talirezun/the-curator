#!/usr/bin/env node
/**
 * test-frontend-syntax.js — every shipped frontend .js file must PARSE.
 *
 * ── Why this suite exists ────────────────────────────────────────────────
 * v3.17.0 shipped an unescaped apostrophe into a single-quoted string in
 * `src/public/next/views/settings.js`:
 *
 *     'and five that write to it (… saving an agent's working state, …) ' +
 *                                                     ^ SyntaxError
 *
 * `src/public/next/app.js` imports that module STATICALLY at top level, so a
 * parse error there means the whole module graph never evaluates, nothing
 * binds, `window.__curatorBooted` is never set, and the v3.0.15 boot guard
 * paints the recovery panel. `/next` has been served at `/` since v3.9.0, so
 * that is a BLANK APP for every user on the next auto-update — with no
 * staging and no rollback.
 *
 * ── Why nothing caught it ───────────────────────────────────────────────
 * EIGHT existing suites read `views/settings.js` — the model picker (1542
 * assertions), openrouter-qualify (197), onboarding (195), mcp-wizard (182),
 * provider-rows (162), confirm-dialog (155), loading-gate (219) and
 * model-fallback (82). Roughly 2,700 assertions. Every one of them reads the
 * file as TEXT — brace-matched function extraction, regex source guards —
 * and none of them ever asks Node whether the bytes are still JavaScript.
 * `npm test` was 87 suites / 87 passed over a file that could not load.
 *
 * A text-only reader is structurally incapable of seeing a parse error. That
 * is the class this suite closes, and it is the THIRD time this repo has
 * shipped a whole-class blind spot in a frontend guard (v3.1.0's null-safety
 * scanner desynced twice on its own lexer; v3.14.0's FN_NAMES list went
 * blind on a new helper).
 *
 * ── ENFORCED ────────────────────────────────────────────────────────────
 *   - Every `.js` under `src/public/**` parses, ENUMERATED FROM DISK.
 *     Never a hardcoded list: a hardcoded list cannot see a NEW file, which
 *     is exactly how the FN_NAMES guard went blind.
 *   - The detector is proven non-vacuous by a positive control — a planted
 *     broken file MUST be caught, or this suite is decoration.
 *   - The frozen /old shell is covered too: `app.js` there has ~79 top-level
 *     element lookups and one parse error blanks it identically.
 *
 * ── NOT ENFORCED, stated rather than implied ────────────────────────────
 *   - Parsing is not loading. These modules reference `document`/`window` at
 *     module scope, so importing them in Node throws ReferenceError by
 *     design; only a browser can prove they EVALUATE. This suite proves the
 *     bytes are JavaScript, which is the failure that actually shipped.
 *   - A runtime TypeError inside a handler is invisible here.
 *   - CSS and HTML are covered by test-css-tokens.js / test-next-asset-paths.js.
 */

import { readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src/public');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

/** node --check <file> → true if it parses. */
function parses(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Every .js under a dir, recursively, enumerated from disk. */
function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

section('1. Positive control — the detector must be able to FAIL');
{
  // If this does not fire, every assertion below is vacuous and the suite is
  // decoration. Prove the detector detects BEFORE trusting a single green.
  const tmp = path.join(os.tmpdir(), `curator-syntax-control-${process.pid}.js`);
  try {
    writeFileSync(tmp, "const s = 'an agent's state';\n", 'utf8');
    ok(parses(tmp) === false,
      'a planted unescaped-apostrophe file is REPORTED BROKEN (this is the exact v3.17.0 defect)');
    writeFileSync(tmp, "export const s = 'fine';\n", 'utf8');
    ok(parses(tmp) === true, 'a valid file is reported as parsing (no false positives)');
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

section('2. Every shipped frontend .js parses');
{
  const files = walkJs(PUBLIC);
  ok(files.length >= 15,
    `enumerated from disk, not a hardcoded list (found ${files.length} files)`);

  // The two shells must both be represented, or the walk is reaching only part
  // of what ships: /next is served at / since v3.9.0, /old is the escape hatch.
  const rel = files.map((f) => path.relative(ROOT, f));
  ok(rel.some((f) => f.startsWith('src/public/next/')), 'the /next shell is covered');
  ok(rel.some((f) => f === 'src/public/app.js'), 'the frozen /old shell is covered');

  // The specific file that shipped broken, named so a regression is unmissable.
  ok(rel.includes('src/public/next/views/settings.js'),
    'src/public/next/views/settings.js is in the sweep (the v3.17.0 blocker)');

  for (const f of files) {
    ok(parses(f), `parses: ${path.relative(ROOT, f)}`);
  }
}

section('3. Statically-imported modules are the ones that brick the app');
{
  // A parse error only blanks the shell if something imports it at load time.
  // app.js's top-level imports are the blast radius; assert we cover them all.
  const appJs = path.join(PUBLIC, 'next/app.js');
  const src = execFileSync('cat', [appJs], { encoding: 'utf8' });
  const imports = [...src.matchAll(/^\s*import\s+(?:[^'"]*from\s+)?['"](\.[^'"]+)['"]/gm)]
    .map((m) => m[1]);
  ok(imports.length > 0, `/next/app.js has top-level imports (${imports.length})`);

  let missing = 0;
  for (const spec of imports) {
    const resolved = path.resolve(path.dirname(appJs), spec);
    if (!parses(resolved)) missing++;
  }
  ok(missing === 0,
    `every module /next/app.js imports at top level parses (${imports.length} checked)`);
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ FAILURES — a frontend file does not parse. This blanks the app for every user.');
  process.exit(1);
}
console.log('✅ Every shipped frontend .js parses');
process.exit(0);
