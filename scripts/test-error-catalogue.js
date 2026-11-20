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
// v3.99.2 second audit: the organisation (SSO) refusal and the redirect refusal.
for (const c of ['sync-new-token-org-blocked', 'sync-token-check-redirected']) {
  ok(CODES.includes(c) && docsCodes.includes(c) && llmCodes.includes(c), `${c}: a catalogue code, on both pages`);
}
{
  const org = SYNC.REPLACE_TOKEN_MESSAGES['sync-new-token-org-blocked']('github.com/o/r');
  ok(region(docsText).includes('Configure SSO') && region(llmText).includes('Configure SSO'), 'the SSO sentence is on both pages');
  ok(/single sign-on/.test(org) && /Configure SSO/.test(org) && !/repo scope/.test(org), 'the SSO sentence says to authorise for single sign-on, with no scope advice', org);
  ok(!/internet/i.test(SYNC.REPLACE_TOKEN_MESSAGES['sync-token-check-redirected']), 'the redirect sentence never blames the internet');
}
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

// ═══════════════════════════════════════════════════════════════════════════
section('§6 platform wordings (Windows app): every one on the page, and the page the same on any machine');
// ═══════════════════════════════════════════════════════════════════════════
{
  // sync-git-missing has a macOS, a Windows-app and a Windows-browser sentence,
  // all three from sync.js's own gitMissingMessage().
  const row = region(docsText).split('\n').find((l) => l.startsWith('| `sync-git-missing` |')) || '';
  const want3 = [
    SYNC.gitMissingMessage({ platform: 'darwin' }),
    SYNC.gitMissingMessage({ platform: 'win32', isBundle: true }),
    SYNC.gitMissingMessage({ platform: 'win32', isBundle: false }),
  ];
  ok(new Set(want3).size === 3 && want3.every((t) => row.includes(esc(t))),
    'sync-git-missing: the macOS, Windows-app and Windows browser-install sentences are all on the page, verbatim', row.slice(0, 300));
  ok(row.indexOf(esc(want3[0])) < row.indexOf('*In the Windows app:*'),
    '…the macOS sentence first and unlabelled, the Windows ones labelled');
  // Built as Windows (process.platform forced before anything is imported):
  // the same pages. Before the platform table the first sentence followed the
  // build machine, so a Windows run would have rewritten both pages.
  const asWin = spawnSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const B = await import(${JSON.stringify(path.join(ROOT, 'scripts', 'build-error-catalogue.mjs'))});
    process.stdout.write(JSON.stringify({ docs: B.renderDocsRegion(), llm: B.renderLlmRegion() }));
  `], { cwd: TMP, encoding: 'utf8', env: process.env });
  let winPages = null;
  try { winPages = JSON.parse(asWin.stdout); } catch { /* reported below */ }
  ok(winPages && winPages.docs === B.renderDocsRegion() && winPages.llm === B.renderLlmRegion(),
    'the catalogue built on Windows is byte-identical to the one built here', (asWin.stderr || '').slice(0, 300));
  // The hook the other Windows packages add to: every entry calls the app.
  ok(Object.values(B.PLATFORM_SENTENCES).every((list) => list.length > 1 && list[0].label === ''
      && list.every((v) => typeof v.text === 'function' && typeof v.text() === 'string' && v.text().length > 20)),
    'PLATFORM_SENTENCES: each code lists an unlabelled first sentence and labelled variants, each produced by a function');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the Windows app (wave 2): folder codes, files-not-allowed on Windows, the update messages');
// ═══════════════════════════════════════════════════════════════════════════
{
  const FA = await import('../src/brain/folder-access.js');
  const UEB = await import('../src/brain/user-errors.js');
  const W32 = await import('../desktop/lib/update-plan-win32.js');
  const cfgRoute = await import('../src/routes/config.js');

  // Folder codes: the app's list and the catalogue's are the same list.
  ok(JSON.stringify([...UE.FOLDER_CODES].sort()) === JSON.stringify([...FA.FOLDER_ACCESS_CODES].sort()),
    `FOLDER_CODES (the client's list) equals folder-access.js's FOLDER_ACCESS_CODES (${FA.FOLDER_ACCESS_CODES.length} codes)`);
  ok(FA.FOLDER_ACCESS_CODES.every((c) => UE.isCatalogueCode(c) && docsCodes.includes(c) && llmCodes.includes(c)),
    'every folder code is a catalogue code, on both pages (so "(code: folder-…)" under an error finds its row)');
  const device = FA.folderAccessMessage('folder-device-path', {});
  ok(docsText.includes(esc(device)), 'the placeholder-free folder sentence is on the page verbatim');
  const drive = FA.folderAccessMessage('folder-drive-root', { name: 'D:\\', drive: 'D:\\' });
  ok(docsText.includes(esc(drive)), 'the drive-root sentence, as the app says it for D:\\, is on the page');

  // files-not-allowed: the Mac sentence unchanged, a Windows one beside it.
  const MAC_SENTENCE = "This computer didn't let The Curator use a file it needs (x). Check that the folder isn't read-only and, " +
    'on a Mac, that The Curator is allowed to use it in System Settings › Privacy & Security › Files and Folders. Then try again.';
  ok(UE.USER_MESSAGES['files-not-allowed']({ name: 'x' }) === MAC_SENTENCE
      && UE.USER_MESSAGES['files-not-allowed']({ name: 'x', platform: 'darwin' }) === MAC_SENTENCE
      && UE.USER_MESSAGES['files-not-allowed']({ name: 'x', platform: 'linux' }) === MAC_SENTENCE,
    'files-not-allowed: with no platform, on macOS and on Linux, the v3.99.2 sentence byte for byte');
  const win = UE.USER_MESSAGES['files-not-allowed']({ name: 'x', platform: 'win32' });
  ok(/Controlled folder access/.test(win) && !/Mac|System Settings/.test(win) && win.includes(UE.WIN_ALLOW_CFA),
    'files-not-allowed on Windows names Controlled folder access and where to allow the app, and never a Mac or System Settings');
  ok(FA.folderAccessMessage('folder-protected-by-windows', {}).includes(UE.WIN_ALLOW_CFA),
    '…in the same words folder-access.js uses for the same place');
  ok(!/nothing was changed/i.test(win), '…and claims nothing it cannot know (a write elsewhere may have finished)');
  const row = region(docsText).split('\n').find((l) => l.startsWith('| `files-not-allowed` |')) || '';
  ok(row.includes(esc(UE.USER_MESSAGES['files-not-allowed']({ name: '[file name]', platform: 'darwin' })))
      && row.includes('*On Windows:* ' + esc(UE.USER_MESSAGES['files-not-allowed']({ name: '[file name]', platform: 'win32' }))),
    'the page lists the Mac sentence first and the Windows one labelled');
  // Through toUserError, the server's translator: the platform decides.
  const eacces = Object.assign(new Error("EACCES: permission denied, open '/k/notes/a.md'"), { code: 'EACCES', path: '/k/notes/a.md' });
  const onMac = UEB.toUserError(eacces, { platform: 'darwin' });
  const onWin = UEB.toUserError(eacces, { platform: 'win32' });
  ok(onMac && onMac.code === 'files-not-allowed' && /System Settings/.test(onMac.error), 'toUserError on macOS: the Mac sentence', onMac);
  ok(onWin && onWin.code === 'files-not-allowed' && /Controlled folder access/.test(onWin.error) && !/System Settings/.test(onWin.error),
    'toUserError on Windows: the Windows sentence, same code', onWin);
  ok(UEB.toUserError(eacces).error === (process.platform === 'win32' ? onWin.error : onMac.error),
    'toUserError with no platform uses the platform it runs on (the server runs on the person\'s machine)');

  // The Windows update messages: their own table, no code.
  const allUpd = { ...W32.WIN32_UPDATE_FAILURES, ...W32.WIN32_INSTALL_OUTCOMES };
  const missingUpd = Object.entries(allUpd).filter(([, v]) => !docsText.includes(esc(v))).map(([k]) => k);
  ok(Object.keys(allUpd).length >= 15 && missingUpd.length === 0,
    `every Windows update sentence (${Object.keys(allUpd).length}) is on docs/errors.md verbatim`, missingUpd);
  ok(region(docsText).includes('## Updating the Windows app') && /\| When \| What you see \|/.test(region(docsText)),
    '…in their own table, keyed by situation, with no code column');
  ok(Object.keys(allUpd).filter((k) => !UE.isCatalogueCode(k)).every((k) => !docsCodes.includes(k) && !llmCodes.includes(k)),
    '…and no update reason is listed as a code row');
  const copy = cfgRoute.updateFailureCopy('in-use-by-ai-app', W32.WIN32_UPDATE_FAILURES['in-use-by-ai-app']);
  ok(!('code' in copy) && copy.reason === 'in-use-by-ai-app',
    'WHY NO CODE: the update route sends a `reason`, never a `code`, so no support line can name an update message');
  ok(/#updating-the-windows-app/.test(region(llmText)), 'the assistant\'s copy answers in one paragraph and links to the full table');
  const problems = B.catalogueProblems();
  ok(problems.length === 0, 'every update sentence has a When and a What to do, and none is invented', problems);
}

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ The error catalogue is out of date'); process.exit(1); }
console.log('✅ The published error catalogue matches the app');
