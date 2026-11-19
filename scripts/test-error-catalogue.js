#!/usr/bin/env node
/**
 * scripts/test-error-catalogue.js — v3.99.2. The published error catalogue
 * (docs/errors.md, and the assistant's copy llm-docs/curator-errors.md) says
 * what the app says.
 *
 * A person searches that page for the code under their error, or for the words
 * they see. A page that lists a code the app no longer has, misses one it does
 * have, or quotes a sentence the app no longer shows sends them looking for an
 * answer that is not there. So:
 *   §1 Each page's generated region is byte-identical to what
 *      scripts/build-error-catalogue.mjs renders NOW from the app's own
 *      sentence functions (USER_MESSAGES, SURFACE_MESSAGES, describeSyncError,
 *      REPLACE_TOKEN_MESSAGES). A sentence changed in the code and not rebuilt
 *      → red.
 *   §2 Every catalogue code (CATALOGUE_CODES, the list isCatalogueCode reads)
 *      appears exactly once in each page's table, and no other code does.
 *   §3 DUMB CROSS-CHECK, independent of the renderer: every sentence with no
 *      placeholder is found verbatim on the page, taken straight from the
 *      app's functions; the incident's real git text maps to a sentence that is
 *      on the page.
 *   §4 Controls: the §2 checker catches a missing, a doubled and an invented
 *      code, and the §1 comparison catches a one-character change.
 *   §5 `node scripts/build-error-catalogue.mjs --check` exits 0.
 */

import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function section(t) { console.log(`\n${t}`); }
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? `  [${typeof extra === 'string' ? extra : JSON.stringify(extra)}]` : ''}`); }
}

// Isolation BEFORE sync.js is imported (it reads no user data, but a suite
// never points a brain module at the real folders).
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-error-catalogue-'));
mkdirSync(path.join(TMP, 'domains'), { recursive: true });
mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
process.env.CURATOR_NO_OPEN = '1';

const B = await import('./build-error-catalogue.mjs');
const UE = await import('../src/public/next/shared/user-errors.js');
const SYNC = await import('../src/brain/sync.js');

const docsText = readFileSync(B.DOCS_PAGE, 'utf8');
const llmText = readFileSync(B.LLM_PAGE, 'utf8');

function region(text) {
  const b = text.indexOf(B.BEGIN);
  const e = text.indexOf(B.END);
  return b >= 0 && e > b ? text.slice(b, e + B.END.length) : '';
}

/** The codes in a region's table rows (first cell), in order. */
function tableCodes(reg, backticked) {
  const re = backticked ? /^\| `([a-z0-9-]+)` \|/gm : /^\| ([a-z0-9-]+) \|/gm;
  return [...reg.matchAll(re)].map((m) => m[1]).filter((c) => c !== 'Code');
}

/** Problems with a page's code list against `codes`: missing, doubled, invented. */
function codeProblems(found, codes) {
  const out = [];
  const counts = new Map();
  for (const c of found) counts.set(c, (counts.get(c) || 0) + 1);
  for (const c of codes) {
    const n = counts.get(c) || 0;
    if (n === 0) out.push(`missing ${c}`);
    if (n > 1) out.push(`${c} listed ${n} times`);
  }
  for (const c of counts.keys()) if (!codes.includes(c)) out.push(`not an app code: ${c}`);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 each page is what the build renders from the app now');
// ═══════════════════════════════════════════════════════════════════════════
ok(B.catalogueProblems().length === 0, 'every catalogue code has a written meaning and step, and none is invented', B.catalogueProblems());
let want = { docs: null, llm: null };
try { want = B.expectedPages(); } catch (err) { ok(false, 'the build renders the pages', err.message); }
ok(docsText === want.docs, 'docs/errors.md is up to date (run node scripts/build-error-catalogue.mjs)');
ok(llmText === want.llm, 'llm-docs/curator-errors.md is up to date (run node scripts/build-error-catalogue.mjs)');
ok(region(docsText).length > 1000 && region(llmText).length > 1000, 'both pages carry a filled region between the markers');

// ═══════════════════════════════════════════════════════════════════════════
section('§2 every catalogue code exactly once, and no other');
// ═══════════════════════════════════════════════════════════════════════════
const CODES = [...UE.CATALOGUE_CODES];
ok(CODES.length >= 50, `control: the app's catalogue is read (${CODES.length} codes)`);
ok(CODES.every((c) => UE.isCatalogueCode(c)), 'control: isCatalogueCode accepts every listed code');
const docsCodes = tableCodes(region(docsText), true);
const llmCodes = tableCodes(region(llmText), false);
ok(codeProblems(docsCodes, CODES).length === 0, `docs/errors.md lists each of the ${CODES.length} codes once (${docsCodes.length} rows)`, codeProblems(docsCodes, CODES));
ok(codeProblems(llmCodes, CODES).length === 0, `llm-docs/curator-errors.md lists each code once (${llmCodes.length} rows)`, codeProblems(llmCodes, CODES));
// Outside the region the docs page may name a code in prose (the example line),
// but only one the app has.
const proseCodes = [...docsText.replace(region(docsText), '').matchAll(/code: ([a-z0-9-]+)/g)].map((m) => m[1]);
ok(proseCodes.every((c) => UE.isCatalogueCode(c)), 'every code named in the page\'s own prose is a catalogue code', proseCodes);

// ═══════════════════════════════════════════════════════════════════════════
section('§3 dumb cross-check: the app\'s own sentences are on the page verbatim');
// ═══════════════════════════════════════════════════════════════════════════
const esc = (s) => s.replace(/\|/g, '\\|');
const fixed = Object.keys(UE.USER_MESSAGES).filter((k) => UE.USER_MESSAGES[k]() === UE.USER_MESSAGES[k]({ provider: 'X', name: 'Y', service: 'Z' }));
ok(fixed.length >= 10, `control: sentences with no placeholder found (${fixed.length})`);
const missingFixed = fixed.filter((k) => !docsText.includes(esc(UE.USER_MESSAGES[k]())));
ok(missingFixed.length === 0, 'every placeholder-free catalogue sentence is on docs/errors.md verbatim', missingFixed);
const rtm = Object.entries(SYNC.REPLACE_TOKEN_MESSAGES).filter(([, v]) => typeof v === 'string');
ok(rtm.length >= 8, `control: Replace token sentences read from sync.js (${rtm.length})`);
const missingRtm = rtm.filter(([, v]) => !docsText.includes(esc(v))).map(([k]) => k);
ok(missingRtm.length === 0, 'every Replace token refusal sentence is on the page verbatim', missingRtm);
// The incident (2026-11-19): the exact git text a user saw.
const INCIDENT = 'Command failed: git --git-dir="~/the-curator/.knowledge-git" pull --no-rebase -X theirs origin main ' +
  "fatal: could not read Password for 'https://***@github.com': Device not configured";
const inc = SYNC.describeSyncError(new Error(INCIDENT));
ok(inc.code === 'sync-token-rejected' && docsText.includes(esc(inc.error)), 'the incident\'s git text → sync-token-rejected, and its sentence is on the page', inc);
const conn = SYNC.describeSyncError(new Error(INCIDENT), { context: 'connect' });
ok(docsText.includes(esc(conn.error)), 'the Connect form\'s wording of the same code is on the page too');
// v3.99.2 audit: the off-page wording, the read-only and rate-limit refusals,
// the failed-undo refusal, and a generic sentence that claims nothing.
const elsewhere = SYNC.describeSyncError(new Error(INCIDENT), { context: 'elsewhere' });
ok(docsText.includes(esc(elsewhere.error)) && /open Sync and use Replace token/.test(elsewhere.error), 'the off-page wording of sync-token-rejected is on the page', elsewhere.error);
for (const c of ['sync-new-token-read-only', 'sync-token-check-rate-limited', 'sync-token-save-partial']) {
  ok(CODES.includes(c) && docsCodes.includes(c) && llmCodes.includes(c), `${c}: a catalogue code, on both pages`);
}
ok(!/nothing was changed/i.test(SYNC.REPLACE_TOKEN_MESSAGES['sync-token-save-partial']), 'the failed-undo sentence does not claim nothing was changed');
const generic = SYNC.describeSyncError(new Error('an error text The Curator does not recognise'));
ok(generic.code === 'sync-failed' && !/Nothing was lost/.test(generic.error) && docsText.includes(esc(generic.error)), 'the generic Sync sentence claims nothing it cannot know, and is the one on the page', generic.error);
const admin = UE.SURFACE_MESSAGES.sharedbrain.admin['github-token-rejected']();
ok(docsText.includes(esc(admin)), 'the admin wording of github-token-rejected is on the page');
ok(!/\/Users\/|\/home\/|C:\\Users/.test(region(docsText) + region(llmText)), 'no home path in either generated region');

// ═══════════════════════════════════════════════════════════════════════════
section('§4 controls: the checks can fail');
// ═══════════════════════════════════════════════════════════════════════════
const dropped = docsCodes.filter((c) => c !== 'ai-key-rejected');
ok(codeProblems(dropped, CODES).some((p) => p === 'missing ai-key-rejected'), 'a page missing a code is caught');
ok(codeProblems([...docsCodes, 'files-missing'], CODES).some((p) => /files-missing listed 2 times/.test(p)), 'a doubled code is caught');
ok(codeProblems([...docsCodes, 'zz-not-an-app-code'], CODES).some((p) => p === 'not an app code: zz-not-an-app-code'), 'an invented code is caught');
ok(tableCodes('| `x-y` | a | b | c |\n', true).join() === 'x-y' && tableCodes('| x-y | a | b |\n', false).join() === 'x-y', 'the row reader reads both table shapes');
const oneChar = docsText.replace('Free some space, then try again.', 'Free some space, then try again!');
ok(oneChar !== docsText && oneChar !== want.docs, 'a one-character change to a sentence makes the page differ from the build');

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the build\'s --check');
// ═══════════════════════════════════════════════════════════════════════════
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-error-catalogue.mjs'), '--check'], {
  cwd: ROOT, encoding: 'utf8', env: process.env,
});
ok(r.status === 0, 'node scripts/build-error-catalogue.mjs --check exits 0', (r.stdout || '') + (r.stderr || ''));

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ The error catalogue is out of date'); process.exit(1); }
console.log('✅ The published error catalogue matches the app');
