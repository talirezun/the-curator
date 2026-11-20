/**
 * test-win-folder-access.js — OFFLINE (the Windows app, 2026-11-20). Every place
 * a person picks, types or creates a folder, on Windows, with macOS and Linux
 * proven unchanged.
 *
 *   §1  src/brain/folder-access.js — path shapes (device paths, UNC, a whole
 *       drive, reserved names and trailing dots/spaces, the same folder in
 *       another case, the program folder), where a path sits (OneDrive,
 *       Controlled folder access), and the fs-error classifier — which answers
 *       null off Windows for every error;
 *   §2  the knowledge-folder validation on win32 (typed path, and on Windows
 *       also a picked one): spaces and é/č/ž/ü, \\?\ and \\.\, D:\, another
 *       drive, UNC online/offline, > 260 refused, long accepted with a warning,
 *       the folder applied under its REAL on-disk case (and a mapped drive kept
 *       as typed), the write probe (Controlled folder access, OneDrive busy,
 *       read-only), the Windows APP's whole program folder refused, the
 *       browser install's domains\ exception kept;
 *   §3  macOS and Linux BYTE-IDENTICAL: the validation, the slug and the route
 *       answers against golden values, and (when the base commit is in this
 *       clone) against the base revision's own code on the same inputs;
 *   §4  the two routes on win32 — pick-folder (both the browser install's
 *       PowerShell arm and the app's native-dialog arm) applies the Windows
 *       rules to a picked folder; domains-path carries `code`/`warnings`;
 *   §5  a new domain's folder name: "CON" → con-2 on Windows, "Notes" when
 *       notes exists (case-insensitive disk) → notes-2, accents folded;
 *   §6  POST/PUT /api/domains over a real socket: a real EACCES from a real
 *       read-only folder becomes the Controlled-folder-access sentence when the
 *       host is Windows, and stays the old raw answer when it is not;
 *   §7  desktop/lib/folder-dialog.js — macOS exactly the old inline hook;
 *       Windows: one dialog at a time, no parent when the window is gone, one
 *       absolute Windows path or null, a throw passed through to the route;
 *   §8  REAL Windows only (windows-latest; skipped elsewhere): NTFS case
 *       folding, a real reserved-name folder, a real > 260 path, the probe
 *       leaving nothing behind, the drive root.
 *
 * The AgentLink lessons this follows: a simulated platform uses ITS OWN path
 * shape, never the runner's temp folder (7c432bb60/6e576827f); an existing
 * folder in another case is used under its real name (7a0258fc8); a folder
 * dialog answers one path, one dialog at a time (18b26c5d8).
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR / _DOMAINS_DIR / _LOG_DIR point at a
 * fresh tempdir before any app module loads. No dialog opens; nothing is
 * written outside the tempdir (checked at the end: no write-check file in cwd).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-winaccess-')));
// The domains folder sits under a "Documents" folder of a fake profile, so §6
// can ask the classifier about Controlled folder access with real errors.
const PROFILE = path.join(tmp, 'profile');
const DOMAINS = path.join(PROFILE, 'Documents', 'kb');
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(tmp, 'user');
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_LOG_DIR = path.join(tmp, 'logs');
process.env.CURATOR_NO_OPEN = '1';
for (const d of ['user', 'logs']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
fs.mkdirSync(DOMAINS, { recursive: true });
const cwdBefore = new Set(fs.readdirSync(process.cwd()));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, same ? label : `${label}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n${t}`); }
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const errno = (code) => Object.assign(new Error(`${code}: simulated`), { code });

const FA = await import(path.join(ROOT, 'src/brain/folder-access.js'));
const kfp = await import(path.join(ROOT, 'src/brain/knowledge-folder-path.js'));
const files = await import(path.join(ROOT, 'src/brain/files.js'));
const configRoute = await import(path.join(ROOT, 'src/routes/config.js'));
const domainsRoute = await import(path.join(ROOT, 'src/routes/domains.js'));
const UE = await import(path.join(ROOT, 'src/public/next/shared/user-errors.js'));
const FD = await import(path.join(ROOT, 'desktop/lib/folder-dialog.js'));
const host = await import(path.join(ROOT, 'src/brain/desktop-host.js'));

// A Windows profile, in Windows' own path shape.
const WENV = {
  USERPROFILE: 'C:\\Users\\Ana Žagar',
  OneDrive: 'C:\\Users\\Ana Žagar\\OneDrive',
  OneDriveCommercial: 'C:\\Users\\Ana Žagar\\OneDrive - Contoso d.o.o',
};

// ═══════════════════════════════════════════════════════════════════════════
section('§1  folder-access.js: path shapes, where a path sits, the classifier');
// ═══════════════════════════════════════════════════════════════════════════
{
  for (const p of ['\\\\?\\C:\\wiki', '\\\\.\\COM1', '//?/C:/wiki', '\\\\.\\pipe\\x']) ok(FA.isWindowsDevicePath(p), `device path: ${p}`);
  for (const p of ['C:\\wiki', '\\\\nas\\share', 'D:/x']) ok(!FA.isWindowsDevicePath(p), `not a device path: ${p}`);
  ok(FA.isUncPath('\\\\nas\\share\\wiki') && FA.isUncPath('//nas/share') && !FA.isUncPath('\\\\?\\C:\\x') && !FA.isUncPath('C:\\x'),
    'UNC: \\\\server\\share (either slash), never a device path or a drive path');
  for (const p of ['C:\\', 'd:', 'E:/']) ok(FA.isDriveRoot(p), `a whole drive: ${p}`);
  for (const p of ['C:\\x', '\\\\nas\\share', '/']) ok(!FA.isDriveRoot(p), `not a drive root: ${p}`);

  const bad = [
    ['C:\\Users\\Ana\\con', 'con'], ['C:\\Users\\Ana\\NUL.txt', 'NUL.txt'], ['D:\\COM1\\wiki', 'COM1'],
    ['C:\\x\\lpt9', 'lpt9'], ['C:\\x\\Aux', 'Aux'], ['C:\\x\\com¹', 'com¹'], ['C:\\x\\wiki.', 'wiki.'],
    ['C:\\x\\wiki \\y', 'wiki '], ['C:\\x\\CONIN$', 'CONIN$'],
  ];
  for (const [p, seg] of bad) eq(FA.windowsBadSegment(p), seg, `bad segment found: ${JSON.stringify(seg)} in ${p}`);
  for (const p of ['C:\\Users\\Ana\\console', 'C:\\x\\com10', 'C:\\x\\..\\y', 'C:\\x\\.\\y', 'C:\\x\\notes', '\\\\con\\share\\wiki', 'C:\\x\\.hidden'])
    eq(FA.windowsBadSegment(p), null, `no bad segment: ${p}`);

  ok(FA.sameLocationIgnoringCase('C:\\Users\\Ana\\Wiki', 'c:\\users\\ana\\wiki'), 'same place in another case');
  ok(!FA.sameLocationIgnoringCase('\\\\nas\\share\\wiki', 'Z:\\wiki'), 'a mapped drive and its share are NOT the same text');
  ok(!FA.sameLocationIgnoringCase('C:\\Users\\Ana\\Wiki\\x', 'C:\\Users\\Ana\\Wiki'), 'a deeper path is not the same place');
  ok(!FA.sameLocationIgnoringCase('D:\\Users\\Ana\\Wiki', 'C:\\Users\\Ana\\Wiki'), 'another drive is not the same place');
  ok(!FA.sameLocationIgnoringCase('C:\\Users\\Ana\\Other', 'C:\\Users\\Ana\\Wiki'), 'another folder is not the same place');

  const appRoot = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\The Curator\\resources\\app';
  eq(FA.windowsProgramFolder({ platform: 'win32', bundle: true, appRoot }), 'C:\\Users\\Ana\\AppData\\Local\\Programs\\The Curator',
    'the Windows app\'s program folder is two levels above resources\\app');
  eq([FA.windowsProgramFolder({ platform: 'win32', bundle: false, appRoot }), FA.windowsProgramFolder({ platform: 'darwin', bundle: true, appRoot: '/Applications/The Curator.app/Contents/Resources/app' })],
    [null, null], 'no program-folder rule for the browser install or for macOS');
  ok(FA.isInsideWindows('c:\\users\\ana\\appdata\\local\\programs\\the curator\\locales', 'C:\\Users\\Ana\\AppData\\Local\\Programs\\The Curator'),
    'inside, case-insensitively');
  ok(!FA.isInsideWindows('C:\\Users\\Ana\\AppData\\Local\\Programs\\The Curator 2', 'C:\\Users\\Ana\\AppData\\Local\\Programs\\The Curator'),
    'a sibling whose name starts the same is outside');

  ok(FA.isInOneDrive('C:\\Users\\Ana Žagar\\OneDrive\\Notes', WENV), 'OneDrive (personal) by its env');
  ok(FA.isInOneDrive('c:\\users\\ana žagar\\onedrive - contoso d.o.o\\kb', WENV), 'OneDrive (work) by its env, any case');
  ok(FA.isInOneDrive('C:\\Users\\Ana Žagar\\OneDrive - Other\\kb', { USERPROFILE: WENV.USERPROFILE }), 'a "OneDrive …" folder in the profile, with no OneDrive env');
  ok(!FA.isInOneDrive('C:\\Users\\Ana Žagar\\Curator', WENV) && !FA.isInOneDrive('D:\\OneDrive-backup', WENV), 'not OneDrive');
  for (const p of ['C:\\Users\\Ana Žagar\\Documents\\kb', 'C:\\Users\\Ana Žagar\\Desktop\\kb', 'C:\\Users\\Ana Žagar\\Pictures',
    'C:\\Users\\Ana Žagar\\OneDrive\\Documents\\kb', 'C:\\Users\\Ana Žagar\\OneDrive - Contoso d.o.o\\Desktop\\kb'])
    ok(FA.isInControlledFolder(p, WENV), `protected by Controlled folder access: ${p}`);
  ok(FA.isInControlledFolder('C:\\Users\\Ana Žagar\\OneDrive - X\\Documents\\kb', { USERPROFILE: WENV.USERPROFILE }),
    'a OneDrive-redirected Documents with no OneDrive env');
  for (const p of ['C:\\Users\\Ana Žagar\\Curator', 'C:\\Users\\Ana Žagar\\OneDrive\\Curator', 'D:\\Documents\\kb', 'C:\\Users\\Ana Žagar\\Downloads'])
    ok(!FA.isInControlledFolder(p, WENV), `not protected by default: ${p}`);

  const cls = (code, folder) => (FA.classifyFolderError(errno(code), { platform: 'win32', folder, env: WENV }) || {}).code || null;
  eq(cls('EPERM', 'C:\\Users\\Ana Žagar\\Documents\\kb'), 'folder-protected-by-windows', 'EPERM under Documents → Controlled folder access');
  eq(cls('EACCES', 'C:\\Users\\Ana Žagar\\OneDrive\\Desktop\\kb'), 'folder-protected-by-windows', 'EACCES under OneDrive\\Desktop → Controlled folder access');
  eq(cls('EPERM', 'C:\\Users\\Ana Žagar\\OneDrive\\Curator'), 'folder-cloud-busy', 'EPERM elsewhere in OneDrive → OneDrive busy');
  eq(cls('EACCES', 'D:\\Shared\\kb'), 'folder-not-writable', 'EACCES elsewhere → not writable');
  eq(cls('EROFS', 'E:\\kb'), 'folder-not-writable', 'EROFS → not writable');
  eq(cls('EBUSY', 'C:\\Users\\Ana Žagar\\OneDrive\\Curator'), 'folder-cloud-busy', 'EBUSY in OneDrive → OneDrive busy');
  eq(cls('EBUSY', 'D:\\kb'), 'folder-busy', 'EBUSY elsewhere → another program');
  eq(cls('UNKNOWN', 'C:\\Users\\Ana Žagar\\OneDrive\\Curator'), 'folder-cloud-unavailable', 'a cloud-file error (UNKNOWN) in OneDrive → OneDrive not running');
  eq(cls('EIO', 'C:\\Users\\Ana Žagar\\OneDrive - Contoso d.o.o\\kb'), 'folder-cloud-unavailable', 'EIO in OneDrive → OneDrive not running');
  eq(cls('ENOENT', '\\\\nas\\share\\kb'), 'folder-network-unreachable', 'ENOENT on a share → unreachable');
  eq(cls('ETIMEDOUT', '\\\\nas\\share\\kb'), 'folder-network-unreachable', 'ETIMEDOUT on a share → unreachable');
  eq(cls('ENAMETOOLONG', 'C:\\' + 'x'.repeat(300)), 'folder-path-too-long', 'ENAMETOOLONG → too long');
  eq(cls('ENOENT', 'C:\\kb'), null, 'ENOENT on a drive path is left to the caller');
  eq(cls('EEXIST', 'C:\\kb'), null, 'an error with no Windows meaning is left to the caller');
  let offWin = 0;
  for (const platform of ['darwin', 'linux']) for (const c of ['EPERM', 'EACCES', 'EBUSY', 'ENAMETOOLONG', 'EROFS', 'UNKNOWN', 'EIO', 'ENOENT'])
    if (FA.classifyFolderError(errno(c), { platform, folder: 'C:\\Users\\Ana Žagar\\Documents\\kb', env: WENV }) !== null) offWin++;
  eq(offWin, 0, 'off Windows the classifier answers null for EVERY error (macOS and Linux keep their own answers)');

  // The sentences: plain, say nothing changed, never errno text, and left
  // alone by the v3.99.2 catalogue's raw-text classifier.
  const ctx = { name: 'C:\\Users\\Ana Žagar\\Documents\\kb', segment: 'con', length: 140, drive: 'D:\\' };
  for (const code of FA.FOLDER_ACCESS_CODES) {
    const m = FA.folderAccessMessage(code, ctx);
    ok(typeof m === 'string' && m.length > 40 && !/\bE[A-Z]{3,}\b|undefined|null/.test(m), `sentence for ${code} is plain words`);
    eq(UE.classifyErrorText(m), null, `the catalogue leaves ${code}'s sentence as written`);
    if (code !== 'folder-path-long') ok(/nothing was changed/.test(m), `${code} says nothing was changed`);
  }
  ok(/Controlled folder access/.test(FA.folderAccessMessage('folder-protected-by-windows', ctx)) &&
    /Allow an app through Controlled folder access/.test(FA.folderAccessMessage('folder-protected-by-windows', ctx)),
  'the Controlled-folder-access sentence names the setting and the exact place to allow the app');
  ok(/Always keep on this device/.test(FA.folderAccessMessage('folder-cloud-unavailable', ctx)), 'the OneDrive sentence names "Always keep on this device"');
  eq(FA.folderAccessMessage('no-such-code', ctx), null, 'an unknown code has no sentence');
  eq(FA.folderAccessMessage('__proto__', ctx), null, '__proto__ is not a code');

  // The probe: one file, `wx`, in the folder asked about, removed after.
  const log = [];
  const pr = FA.probeWritable('C:\\kb', { writeFileSync: (f, d, o) => log.push(['w', f, o.flag]), unlinkSync: (f) => log.push(['u', f]), id: 't1' });
  eq([pr, log], [{ ok: true }, [['w', 'C:\\kb\\.curator-write-check-t1', 'wx'], ['u', 'C:\\kb\\.curator-write-check-t1']]],
    'the probe writes ONE named file with flag wx in that folder, and removes it');
  const pr2 = FA.probeWritable('C:\\kb', { writeFileSync: () => {}, unlinkSync: () => { throw errno('EBUSY'); } });
  eq(pr2, { ok: true }, 'a remove that fails (OneDrive grabbed it) still means the folder takes a file');
  const pr3 = FA.probeWritable('C:\\kb', { writeFileSync: () => { throw errno('EPERM'); }, unlinkSync: () => {} });
  eq([pr3.ok, pr3.err.code], [false, 'EPERM'], 'a refused write is reported with its error');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  The knowledge folder on win32 (typed, and picked)');
// ═══════════════════════════════════════════════════════════════════════════
// A fake Windows disk: `dirs` are the folders that exist (keys lower-cased,
// values the on-disk spelling), `fail` maps a folder to the error a write in
// it throws.
function winDisk({ dirs = [], fail = {}, statFail = {}, readFail = {}, bundle = false, appRoot = 'C:\\Users\\Ana Žagar\\the-curator', env = WENV, native } = {}) {
  const byLower = new Map(dirs.map((d) => [d.toLowerCase(), d]));
  const writes = [];
  return {
    writes,
    deps: {
      platform: 'win32', appRoot, bundle, env,
      existsSync: (p) => byLower.has(p.toLowerCase()),
      statSync: (p) => { if (statFail[p]) throw errno(statFail[p]); return { isDirectory: () => true }; },
      readdirSync: (p) => { if (readFail[p]) throw errno(readFail[p]); return []; },
      realpathSync: (p) => p,
      realpathNative: native || ((p) => { const d = byLower.get(p.toLowerCase()); if (!d) throw errno('ENOENT'); return d; }),
      writeFileSync: (f) => { const dir = path.win32.dirname(f); writes.push(f); const code = fail[dir.toLowerCase()]; if (code) throw errno(code); },
      unlinkSync: () => {},
      probeId: 'p',
    },
  };
}
{
  const NONASCII = 'C:\\Users\\Ana Žagar\\Znanje é č ž ü';
  let d = winDisk({ dirs: [NONASCII] });
  eq(kfp.validateKnowledgeFolderPath(NONASCII, d.deps), { ok: true, path: NONASCII }, 'spaces and é/č/ž/ü in the path and the user name are accepted as they are');
  eq(d.writes, [NONASCII + '\\.curator-write-check-p'], '…after ONE write check inside that folder');

  d = winDisk({ dirs: ['D:\\Curator'] });
  eq(kfp.validateKnowledgeFolderPath('D:\\Curator', d.deps), { ok: true, path: 'D:\\Curator' }, 'a folder on another drive (D:\\) is accepted');
  d = winDisk({ dirs: ['\\\\nas\\share\\kb'] });
  eq(kfp.validateKnowledgeFolderPath('\\\\nas\\share\\kb', d.deps), { ok: true, path: '\\\\nas\\share\\kb' }, 'a reachable network share (UNC) is accepted');
  const off = kfp.validateKnowledgeFolderPath('\\\\nas\\share\\kb', winDisk({}).deps);
  eq([off.ok, off.reason, off.code], [false, 'missing', 'folder-network-unreachable'], 'an unreachable share says it cannot be reached (not "does not exist")');
  const miss = kfp.validateKnowledgeFolderPath('C:\\nope', winDisk({}).deps);
  eq([miss.reason, miss.error, miss.code], ['missing', 'Folder does not exist: C:\\nope', undefined], 'a missing drive folder keeps the existing sentence');

  for (const p of ['\\\\?\\C:\\Users\\Ana\\kb', '\\\\.\\COM1', '//./PhysicalDrive0']) {
    const r = kfp.validateKnowledgeFolderPath(p, winDisk({ dirs: [p] }).deps);
    eq([r.ok, r.reason, r.code], [false, 'invalid', 'folder-device-path'], `a device path is refused: ${p}`);
  }
  for (const p of ['C:\\', 'D:/', 'e:\\']) {
    const r = kfp.validateKnowledgeFolderPath(p, winDisk({ dirs: [p] }).deps);
    eq([r.ok, r.reason, r.code], [false, 'drive-root', 'folder-drive-root'], `a whole drive is refused: ${p}`);
  }
  eq(kfp.validateKnowledgeFolderPath('D:', winDisk({ dirs: ['D:'] }).deps).reason, 'not-absolute', '"D:" alone (the current folder on D) is not a full path');
  ok(/for example D:\\Curator/.test(kfp.validateKnowledgeFolderPath('d:\\', winDisk({ dirs: ['d:\\'] }).deps).error), '…and the sentence suggests a folder on THAT drive');
  for (const [p, seg] of [['C:\\Users\\Ana\\con', 'con'], ['C:\\Users\\Ana\\NUL\\kb', 'NUL'], ['C:\\kb\\COM3', 'COM3'], ['C:\\kb.\\x', 'kb.'], ['C:\\kb \\x', 'kb ']]) {
    const r = kfp.validateKnowledgeFolderPath(p, winDisk({ dirs: [p] }).deps);
    eq([r.ok, r.reason, r.code], [false, 'reserved-name', 'folder-reserved-name'], `a reserved or trailing-dot/space name is refused: ${JSON.stringify(seg)}`);
    ok(String(r.error).includes(`"${seg}"`), '…naming the segment');
  }

  const atMax = 'C:\\' + 'Lang ä č '.repeat(40).slice(0, FA.WIN_FOLDER_MAX_CHARS - 4) + 'x';
  eq(atMax.length, FA.WIN_FOLDER_MAX_CHARS, 'PRECONDITION: a path at exactly the limit');
  const atLimit = kfp.validateKnowledgeFolderPath(atMax, winDisk({ dirs: [atMax] }).deps);
  eq([atLimit.ok, atLimit.warnings && atLimit.warnings[0].code], [true, 'folder-path-long'], 'a path at the limit is accepted, with the long-path warning');
  const over = 'C:\\' + 'x'.repeat(FA.WIN_FOLDER_MAX_CHARS);
  const tooLong = kfp.validateKnowledgeFolderPath(over, winDisk({ dirs: [over] }).deps);
  eq([tooLong.ok, tooLong.reason, tooLong.code], [false, 'too-long', 'folder-path-too-long'], 'over the limit (and over 260) is refused');
  const p120 = 'C:\\' + 'k'.repeat(FA.WIN_FOLDER_WARN_CHARS - 3);
  eq(kfp.validateKnowledgeFolderPath(p120, winDisk({ dirs: [p120] }).deps), { ok: true, path: p120 }, 'at the warning length exactly: no warning');
  const p122 = p120 + 'k';
  const w = kfp.validateKnowledgeFolderPath(p122, winDisk({ dirs: [p122] }).deps);
  ok(w.ok && w.warnings.length === 1 && /121 characters/.test(w.warnings[0].message), 'one character more: accepted with a warning that says its length');

  // The REAL name when typed in another case (AgentLink W1).
  const real = 'C:\\Users\\Ana Žagar\\Znanje';
  d = winDisk({ dirs: [real] });
  eq(kfp.validateKnowledgeFolderPath('c:\\users\\ana žagar\\ZNANJE', d.deps), { ok: true, path: real }, 'an existing folder typed in another case is applied under its real name');
  d = winDisk({ dirs: ['Z:\\wiki'], native: () => '\\\\nas\\share\\wiki' });
  eq(kfp.validateKnowledgeFolderPath('Z:\\wiki', d.deps).path, 'Z:\\wiki', 'a mapped drive stays as typed (its realpath is the share, not the same text)');
  d = winDisk({ dirs: ['C:\\kb'], native: () => { throw errno('EPERM'); } });
  eq(kfp.validateKnowledgeFolderPath('C:\\KB', d.deps).path, 'C:\\KB', 'realpath.native failing keeps what was typed');

  // The write probe.
  const docs = 'C:\\Users\\Ana Žagar\\Documents\\Curator';
  let r = kfp.validateKnowledgeFolderPath(docs, winDisk({ dirs: [docs], fail: { [docs.toLowerCase()]: 'EPERM' } }).deps);
  eq([r.ok, r.reason, r.code], [false, 'not-writable', 'folder-protected-by-windows'], 'Controlled folder access blocking Documents → refused in plain words');
  const odDocs = 'C:\\Users\\Ana Žagar\\OneDrive\\Documents\\Curator';
  r = kfp.validateKnowledgeFolderPath(odDocs, winDisk({ dirs: [odDocs], fail: { [odDocs.toLowerCase()]: 'EACCES' } }).deps);
  ok(r.code === 'folder-protected-by-windows' && /OneDrive/.test(r.error), 'OneDrive-redirected Documents: Controlled folder access, and the OneDrive line');
  const od = 'C:\\Users\\Ana Žagar\\OneDrive\\Curator';
  r = kfp.validateKnowledgeFolderPath(od, winDisk({ dirs: [od], fail: { [od.toLowerCase()]: 'EBUSY' } }).deps);
  eq([r.reason, r.code], ['not-writable', 'folder-cloud-busy'], 'OneDrive busy syncing (EBUSY) → the OneDrive sentence');
  const ro = 'D:\\ReadOnly';
  r = kfp.validateKnowledgeFolderPath(ro, winDisk({ dirs: [ro], fail: { [ro.toLowerCase()]: 'EACCES' } }).deps);
  eq([r.reason, r.code], ['not-writable', 'folder-not-writable'], 'a read-only folder (lists, but takes no file) → refused');
  r = kfp.validateKnowledgeFolderPath(ro, winDisk({ dirs: [ro], fail: { [ro.toLowerCase()]: 'EWEIRD' } }).deps);
  eq([r.reason, r.code], ['not-writable', 'folder-not-writable'], 'an unrecognised write error is still "cannot save here", never a raw errno');
  r = kfp.validateKnowledgeFolderPath(od, winDisk({ dirs: [od], statFail: { [od]: 'UNKNOWN' } }).deps);
  eq([r.reason, r.code], ['unreadable', 'folder-cloud-unavailable'], 'Files On-Demand with OneDrive not running (cloud error on stat) → the OneDrive sentence');
  r = kfp.validateKnowledgeFolderPath('D:\\x', winDisk({ dirs: ['D:\\x'], readFail: { 'D:\\x': 'ENOTSUP' } }).deps);
  eq([r.reason, r.code, /ENOTSUP/.test(r.error)], ['unreadable', undefined, true], 'an unreadable folder with no Windows meaning keeps the existing sentence');

  // Simulated win32 with no writer seam is refused loudly, and nothing lands in the cwd.
  const loud = kfp.validateKnowledgeFolderPath('C:\\kb', { ...winDisk({ dirs: ['C:\\kb'] }).deps, writeFileSync: undefined, unlinkSync: undefined });
  eq([loud.ok, loud.reason], [false, 'not-writable'], 'simulated win32 on a non-Windows host without a writer seam: refused, never a real write');

  // The program folder.
  const appRoot = 'C:\\Users\\Ana Žagar\\AppData\\Local\\Programs\\The Curator\\resources\\app';
  const prog = 'C:\\Users\\Ana Žagar\\AppData\\Local\\Programs\\The Curator';
  for (const p of [prog, prog + '\\locales', appRoot, appRoot + '\\domains', 'c:\\users\\ana žagar\\appdata\\local\\programs\\THE CURATOR\\kb']) {
    r = kfp.validateKnowledgeFolderPath(p, winDisk({ dirs: [p], bundle: true, appRoot }).deps);
    eq([r.ok, r.reason, r.code], [false, 'inside-app', 'folder-inside-app'], `the Windows app: inside the program folder is refused: ${p.slice(prog.length - 11)}`);
  }
  ok(/uninstall/.test(r.error), '…saying an update replaces it and an uninstall deletes it');
  const data = 'C:\\Users\\Ana Žagar\\AppData\\Local\\TheCurator\\App\\domains';
  eq(kfp.validateKnowledgeFolderPath(data, winDisk({ dirs: [data], bundle: true, appRoot }).deps), { ok: true, path: data },
    'the Windows app: its own user-data domains folder is accepted');
  const sib = 'C:\\Users\\Ana Žagar\\AppData\\Local\\Programs\\The Curator notes';
  eq(kfp.validateKnowledgeFolderPath(sib, winDisk({ dirs: [sib], bundle: true, appRoot }).deps).ok, true, 'a sibling folder whose name starts the same is accepted');
  const repoRoot = 'C:\\Users\\Ana Žagar\\the-curator';
  eq(kfp.validateKnowledgeFolderPath(repoRoot + '\\domains', winDisk({ dirs: [repoRoot + '\\domains'], appRoot: repoRoot }).deps).ok, true,
    'the browser install keeps its domains\\ exception (repo mode)');
  eq(kfp.validateKnowledgeFolderPath(repoRoot + '\\src', winDisk({ dirs: [repoRoot + '\\src'], appRoot: repoRoot }).deps).reason, 'inside-app',
    'the browser install: its code folder is still refused');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  macOS and Linux: byte-identical');
// ═══════════════════════════════════════════════════════════════════════════
const KB = path.join(tmp, 'My Wiki Žiga é');
fs.mkdirSync(KB, { recursive: true });
fs.mkdirSync(path.join(tmp, 'con'), { recursive: true });          // a reserved name means nothing here
fs.mkdirSync(path.join(tmp, 'Mixed Case'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'file.txt'), 'x');
const FAKE_APP = path.join(tmp, 'the-curator');
for (const dd of ['src', 'domains']) fs.mkdirSync(path.join(FAKE_APP, dd), { recursive: true });
const POSIX_INPUTS = [
  KB, '"' + KB + '"', path.join(tmp, 'con'), path.join(tmp, 'mixed case'), path.join(tmp, 'nope'), path.join(tmp, 'file.txt'),
  FAKE_APP, path.join(FAKE_APP, 'src'), path.join(FAKE_APP, 'domains'), '/', 'relative/x', '', 'C:\\Users\\x', '\\\\nas\\share',
  '/' + 'x'.repeat(300), KB + '\0',
];
function runValidate(fn, platform) {
  return POSIX_INPUTS.map((p) => fn(p, { platform, appRoot: FAKE_APP }));
}
{
  // Golden: what these answers have always been (no `code`, no `warnings`, no write check).
  for (const platform of ['darwin', 'linux']) {
    const out = runValidate(kfp.validateKnowledgeFolderPath, platform);
    ok(out.every((o) => !('code' in o) && !('warnings' in o)), `${platform}: no answer carries the Windows-only fields`);
    eq(out[0], { ok: true, path: KB }, `${platform}: a non-ASCII folder is applied as typed`);
    eq(out[2], { ok: true, path: path.join(tmp, 'con') }, `${platform}: a folder named "con" is fine here`);
    eq(out[9].ok, true, `${platform}: "/" is accepted as it always was (no drive-root rule)`);
    eq(out[10].reason, 'not-absolute', `${platform}: relative refused`);
  }
  eq(runValidate(kfp.validateKnowledgeFolderPath, 'darwin')[3].path, path.join(tmp, 'mixed case'), 'darwin: a folder typed in another case is applied AS TYPED (unchanged)');
  ok(!fs.readdirSync(KB).some((n) => n.startsWith('.curator-write-check')), 'darwin/linux: no write check ran in the folder');

  // Against the BASE revision's own code, on the same inputs (local proof;
  // a shallow CI clone has no base, which is said, not hidden).
  const BASE = process.env.CURATOR_FA_BASE || '85f2041';
  let baseSrc = null;
  try { baseSrc = execFileSync('git', ['show', `${BASE}:src/brain/knowledge-folder-path.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* shallow clone */ }
  if (baseSrc) {
    const f = path.join(tmp, 'kfp-base.mjs');
    fs.writeFileSync(f, baseSrc.replace("from './paths.js'", `from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/brain/paths.js')).href)}`));
    const baseMod = await import(pathToFileURL(f).href);
    for (const platform of ['darwin', 'linux']) {
      eq(runValidate(kfp.validateKnowledgeFolderPath, platform), runValidate(baseMod.validateKnowledgeFolderPath, platform),
        `${platform}: validateKnowledgeFolderPath answers EXACTLY as the base revision on ${POSIX_INPUTS.length} inputs`);
    }
    const winNow = JSON.stringify(kfp.validateKnowledgeFolderPath('C:\\', winDisk({ dirs: ['C:\\'] }).deps));
    const winBase = JSON.stringify(baseMod.validateKnowledgeFolderPath('C:\\', winDisk({ dirs: ['C:\\'] }).deps));
    ok(winNow !== winBase, 'CONTROL: on win32 the two DO differ (so the agreement above is not vacuous)');
  } else {
    console.log(`  · base revision ${BASE} not in this clone — the golden checks above stand alone`);
  }

  // The slug, off Windows: unchanged.
  const s = async (name, platform, existing = []) => files.generateUniqueSlug(name, null, { platform, existsSync: (p) => existing.includes(path.basename(p)) });
  eq([await s('CON', 'darwin'), await s('nul', 'linux'), await s('COM1', 'darwin')], ['con', 'nul', 'com1'], 'darwin/linux: a reserved device name is a folder name as before');
  eq(await s('Notes', 'linux', ['Notes']), 'notes', 'linux (case-sensitive): "notes" beside "Notes" is a different folder, as before');
  eq(await s('Café Über Čšž', 'darwin'), 'cafe-uber-csz', 'darwin: accents folded as before');
  eq(await files.generateUniqueSlug('Plain name'), 'plain-name', 'the two-argument call (production) is unchanged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The routes on win32: pick-folder applies the Windows rules');
// ═══════════════════════════════════════════════════════════════════════════
async function pickWith({ platform, caps, hook, win, disk }) {
  const log = { set: [] };
  const res = fakeRes();
  await configRoute.pickFolderHandler({}, res, {
    caps: { folderPickerStyle: caps },
    platform,
    existsSync: disk ? disk.deps.existsSync : () => true,
    hasActiveWrites: () => false,
    setDomainsDir: (p) => log.set.push(p),
    pickFolderHook: hook || null,
    pickFolderWin32: win ? async () => win : undefined,
    execAsync: async () => ({ stdout: '/Users/x/kb\n' }),
    validate: disk ? disk.deps : undefined,
  });
  return { res, log };
}
{
  const appRoot = 'C:\\Users\\Ana Žagar\\AppData\\Local\\Programs\\The Curator\\resources\\app';
  const prog = 'C:\\Users\\Ana Žagar\\AppData\\Local\\Programs\\The Curator';
  // The Windows APP: Electron's dialog through the native-dialog arm.
  let t = await pickWith({ platform: 'win32', caps: 'native-dialog', hook: async () => prog, disk: winDisk({ dirs: [prog], bundle: true, appRoot }) });
  eq([t.res.statusCode, t.res.body.reason, t.res.body.code, t.log.set.length, 'cancelled' in t.res.body], [400, 'inside-app', 'folder-inside-app', 0, false],
    'app: picking the program folder is refused, nothing applied, no `cancelled`');
  t = await pickWith({ platform: 'win32', caps: 'native-dialog', hook: async () => 'D:\\', disk: winDisk({ dirs: ['D:\\'], bundle: true, appRoot }) });
  eq([t.res.statusCode, t.res.body.reason, t.log.set.length], [400, 'drive-root', 0], 'app: picking a whole drive is refused');
  const real = 'C:\\Users\\Ana Žagar\\Znanje';
  t = await pickWith({ platform: 'win32', caps: 'native-dialog', hook: async () => 'c:\\users\\ana žagar\\znanje', disk: winDisk({ dirs: [real], bundle: true, appRoot }) });
  eq([t.res.statusCode, t.res.body, t.log.set], [200, { ok: true, path: real }, [real]], 'app: a picked folder is applied under its real on-disk name');
  const docs = 'C:\\Users\\Ana Žagar\\Documents\\Curator';
  t = await pickWith({ platform: 'win32', caps: 'native-dialog', hook: async () => docs, disk: winDisk({ dirs: [docs], fail: { [docs.toLowerCase()]: 'EPERM' }, bundle: true, appRoot }) });
  eq([t.res.statusCode, t.res.body.code, t.log.set.length], [400, 'folder-protected-by-windows', 0], 'app: a folder Controlled folder access blocks is refused before it is applied');
  const longP = 'C:\\' + 'k'.repeat(150);
  t = await pickWith({ platform: 'win32', caps: 'native-dialog', hook: async () => longP, disk: winDisk({ dirs: [longP], bundle: true, appRoot }) });
  ok(t.res.statusCode === 200 && t.res.body.ok && t.res.body.warnings[0].code === 'folder-path-long', 'app: a long path is applied and the reply carries the warning');
  // The browser install: the PowerShell dialog arm, same rules.
  t = await pickWith({ platform: 'win32', caps: 'osascript', win: { kind: 'picked', path: 'C:\\x\\con' }, disk: winDisk({ dirs: ['C:\\x\\con'] }) });
  eq([t.res.statusCode, t.res.body.reason, t.log.set.length], [400, 'reserved-name', 0], 'browser install: a picked reserved-name folder is refused');
  // macOS, the native-dialog arm (the Mac app): no Windows rule, unchanged.
  t = await pickWith({ platform: 'darwin', caps: 'native-dialog', hook: async () => '/Users/x/con' });
  eq([t.res.statusCode, t.res.body, t.log.set], [200, { ok: true, path: '/Users/x/con' }, ['/Users/x/con']], 'Mac app: the picked folder is applied exactly as before');
  t = await pickWith({ platform: 'darwin', caps: 'native-dialog', hook: async () => 'C:\\' });
  eq(t.res.body, { ok: true, path: 'C:\\' }, 'Mac app: no Windows validation runs on darwin');

  // domains-path: `code` and `warnings` ride the reply on Windows only.
  const post = (p, validate) => { const res = fakeRes(); const set = []; configRoute.domainsPathHandler({ body: { path: p } }, res, { setDomainsDir: (x) => set.push(x), validate }); return { res, set }; };
  let r = post('C:\\', winDisk({ dirs: ['C:\\'] }).deps);
  eq([r.res.statusCode, r.res.body.reason, r.res.body.code, r.set.length], [400, 'drive-root', 'folder-drive-root', 0], 'domains-path win32: the code rides the refusal');
  r = post(longP, winDisk({ dirs: [longP] }).deps);
  eq([r.res.body.ok, r.res.body.domainsPath, r.res.body.warnings[0].code], [true, longP, 'folder-path-long'], 'domains-path win32: the warning rides the success');
  r = post(path.join(tmp, 'nope'), { platform: 'darwin', appRoot: FAKE_APP });
  eq(Object.keys(r.res.body), ['ok', 'reason', 'error'], 'domains-path darwin: the refusal keeps its three fields');
  r = post(KB, { platform: 'darwin', appRoot: FAKE_APP });
  eq(r.res.body, { ok: true, domainsPath: KB }, 'domains-path darwin: the success keeps its two fields');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  A new domain\'s folder name on Windows');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A case-INSENSITIVE fake disk, like NTFS: "notes" exists when "Notes" does.
  const ci = (existing) => (p) => existing.some((e) => e.toLowerCase() === path.basename(p).toLowerCase());
  const s = (name, existing = [], exclude = null) => files.generateUniqueSlug(name, exclude, { platform: 'win32', existsSync: ci(existing) });
  for (const [name, slug] of [['CON', 'con-2'], ['nul', 'nul-2'], ['Aux', 'aux-2'], ['PRN', 'prn-2'], ['COM1', 'com1-2'], ['lpt9', 'lpt9-2'], ['Con.', 'con-2'], ['NUL ', 'nul-2']]) {
    eq(await s(name), slug, `win32: "${name}" becomes ${slug} (a reserved name is never a folder)`);
  }
  eq(await s('CON', ['con-2']), 'con-3', 'win32: …and the next free one when that is taken');
  eq(await s('Console'), 'console', 'win32: a longer name that starts like one is fine');
  eq(await s('Notes', ['Notes']), 'notes-2', 'win32: a new "Notes" beside an existing "Notes" folder → notes-2, never into it');
  eq(await s('notes', ['NOTES']), 'notes-2', 'win32: …in any case');
  eq(await s('Žiga\'s Café — Über Ünïcode čšž'), 'ziga-s-cafe-uber-unicode-csz', 'win32: accents folded to a plain ASCII folder name');
  eq(await s('Notes', [], 'notes'), 'notes', 'win32: a rename to the same name keeps its slug');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  POST/PUT /api/domains over a real socket, with a real read-only folder');
// ═══════════════════════════════════════════════════════════════════════════
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
if (process.platform === 'win32' || isRoot) {
  console.log('  · skipped here (chmod does not make a folder read-only on Windows or for root); §8 covers Windows');
} else {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/domains', domainsRoute.default);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || 'null') }));
    });
    req.on('error', reject); req.end(data);
  });
  try {
    const made = await call('POST', '/api/domains', { displayName: 'Rename me' });
    eq(made.status, 201, 'PRECONDITION: a domain is created while the folder is writable');
    fs.chmodSync(DOMAINS, 0o555);
    // macOS/Linux: the old answer, unchanged.
    let r = await call('POST', '/api/domains', { displayName: 'Blocked' });
    ok(r.status === 500 && /EACCES/.test(r.body.error) && !('code' in r.body), 'darwin/linux host: the existing raw answer, unchanged (no `code`)');
    r = await call('PUT', '/api/domains/rename-me', { displayName: 'Renamed' });
    ok(r.status === 500 && /EACCES/.test(r.body.error) && !('code' in r.body), 'darwin/linux host: rename keeps its existing answer');
    // The same real error, with the host simulated as Windows and this
    // folder inside the profile's Documents.
    domainsRoute.__setFolderHostForTest({ platform: 'win32', env: { USERPROFILE: PROFILE } });
    r = await call('POST', '/api/domains', { displayName: 'Blocked' });
    eq([r.status, r.body.code], [500, 'folder-protected-by-windows'], 'win32: a real EACCES under Documents → the Controlled-folder-access code');
    ok(/Controlled folder access/.test(r.body.error) && !/EACCES/.test(r.body.error), '…in plain words, no errno');
    r = await call('PUT', '/api/domains/rename-me', { displayName: 'Renamed' });
    eq([r.status, r.body.code], [500, 'folder-protected-by-windows'], 'win32: a refused rename gets the same sentence');
    domainsRoute.__setFolderHostForTest({ platform: 'win32', env: {} });
    r = await call('POST', '/api/domains', { displayName: 'Blocked' });
    eq(r.body.code, 'folder-not-writable', 'win32: the same error outside a protected folder → "not allowed to save here"');
    fs.chmodSync(DOMAINS, 0o755);
    domainsRoute.__setFolderHostForTest(null);
    r = await call('POST', '/api/domains', { displayName: 'CON' });
    eq([r.status, r.body.slug], [201, 'con'], 'darwin/linux host: creating "CON" makes con, as before (§5 and §8 prove con-2 on Windows)');
  } finally {
    domainsRoute.__setFolderHostForTest(null);
    try { fs.chmodSync(DOMAINS, 0o755); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  desktop/lib/folder-dialog.js');
// ═══════════════════════════════════════════════════════════════════════════
function fakeDialog(answers) {
  const calls = [];
  const queue = answers.slice();
  return {
    calls,
    showOpenDialog: async (...args) => {
      calls.push(args);
      const a = queue.length ? queue.shift() : { canceled: true, filePaths: [] };
      if (a instanceof Error) throw a;
      if (a && a.wait) await a.wait;
      return a.result || a;
    },
  };
}
{
  // macOS: the inline hook main.js had, byte for byte.
  const OLD = async (dialog, mainWindow, { prompt }) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: prompt, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  };
  const answers = [
    { canceled: false, filePaths: ['/Users/x/kb'] }, { canceled: true, filePaths: [] }, { canceled: false, filePaths: [] },
    { canceled: false, filePaths: ['/a', '/b'] }, { canceled: true, filePaths: ['/x'] }, { canceled: false, filePaths: ['relative'] },
    { canceled: false, filePaths: ['/Users/x/\u202Eevil'] },
  ];
  const WIN = { id: 'main' };
  const oldOut = []; const newOut = [];
  const dOld = fakeDialog(answers); const dNew = fakeDialog(answers);
  const hook = FD.createPickFolder({ dialog: dNew, getWindow: () => WIN, platform: 'darwin' });
  for (let i = 0; i < answers.length; i++) { oldOut.push(await OLD(dOld, WIN, { prompt: 'P' })); newOut.push(await hook({ prompt: 'P' })); }
  eq(newOut, oldOut, `darwin: the same answer as the old inline hook on all ${answers.length} dialog results`);
  eq(JSON.stringify(dNew.calls), JSON.stringify(dOld.calls), 'darwin: the same showOpenDialog arguments (window, title, properties)');
  const nullWin = fakeDialog([{ canceled: true, filePaths: [] }]);
  await FD.createPickFolder({ dialog: nullWin, getWindow: () => null, platform: 'darwin' })({ prompt: 'P' });
  eq(nullWin.calls[0].length, 2, 'darwin: the window argument is passed through as before, even when null');

  // Windows.
  const dw = fakeDialog([{ canceled: false, filePaths: ['C:\\Users\\Ana Žagar\\Znanje é'] }]);
  const wh = FD.createPickFolder({ dialog: dw, getWindow: () => ({ isDestroyed: () => false }), platform: 'win32' });
  eq(await wh({ prompt: 'Select your Knowledge Base folder:' }), 'C:\\Users\\Ana Žagar\\Znanje é', 'win32: one chosen folder (spaces, non-ASCII) is answered as is');
  eq(dw.calls[0][1], { title: 'Select your Knowledge Base folder:', properties: ['openDirectory', 'dontAddToRecent'] },
    'win32: Explorer options (no macOS-only createDirectory, no defaultPath, not added to Recent)');
  const gone = fakeDialog([{ canceled: true, filePaths: [] }, { canceled: true, filePaths: [] }]);
  await FD.createPickFolder({ dialog: gone, getWindow: () => ({ isDestroyed: () => true }), platform: 'win32' })({ prompt: 'P' });
  await FD.createPickFolder({ dialog: gone, getWindow: () => null, platform: 'win32' })({ prompt: 'P' });
  eq([gone.calls[0].length, gone.calls[1].length], [1, 1], 'win32: a destroyed or missing window → the dialog opens unparented, never throws on it');

  // One at a time.
  let release;
  const wait = new Promise((r) => { release = r; });
  const one = fakeDialog([{ wait, result: { canceled: false, filePaths: ['D:\\kb'] } }]);
  const oh = FD.createPickFolder({ dialog: one, getWindow: () => null, platform: 'win32' });
  const first = oh({ prompt: 'P' });
  const second = await oh({ prompt: 'P' });
  release();
  eq([second, await first, one.calls.length], [null, 'D:\\kb', 1], 'win32: a second request while a dialog is open answers null; ONE dialog was shown');
  const after = fakeDialog([new Error('dialog broke'), { canceled: false, filePaths: ['D:\\again'] }]);
  const ah = FD.createPickFolder({ dialog: after, getWindow: () => null, platform: 'win32' });
  let threw = null;
  try { await ah({ prompt: 'P' }); } catch (e) { threw = e.message; }
  eq([threw, await ah({ prompt: 'P' })], ['dialog broke', 'D:\\again'], 'win32: a throwing dialog is passed to the route (500, never a silent cancel), and the next request still opens');

  const pick = (filePaths, canceled = false) => FD.pickedFolderPath({ canceled, filePaths }, 'win32');
  eq([pick(['C:/Users/x/kb']), pick(['\\\\nas\\share\\kb']), pick(['D:\\'])], ['C:\\Users\\x\\kb', '\\\\nas\\share\\kb', 'D:\\'],
    'win32: drive paths (normalised), a share and a drive root are answered (the route decides about the root)');
  for (const [fp, label] of [[['C:\\a', 'C:\\b'], 'two folders'], [[], 'none'], [['relative\\x'], 'a relative path'], [['\\x'], 'a drive-less path'],
    [['\\\\?\\C:\\x'], 'a \\\\?\\ device path'], [['\\\\.\\COM1'], 'a \\\\.\\ device path'], [['C:\\x\u0007'], 'a control character'],
    [['C:\\x\u202Eexe'], 'a bidi override'], [['C:\\' + 'x'.repeat(5000)], 'over 4096 characters'], [[42], 'not a string'], [['\\\\nas'], 'a server with no share']]) {
    eq(pick(fp), null, `win32: ${label} → null`);
  }
  eq(pick(['C:\\x'], true), null, 'win32: cancelled → null');
  eq(FD.pickedFolderPath(undefined, 'win32'), null, 'win32: no result → null');
  ok((() => { try { FD.createPickFolder({ dialog: {}, getWindow: () => null }); return false; } catch { return true; } })(), 'a missing dialog is refused when the hook is built');

  // Through the real registry and the real route (the Windows app's path).
  host.__resetDesktopHost();
  const appRoot = 'C:\\Users\\Ana Žagar\\AppData\\Local\\Programs\\The Curator\\resources\\app';
  const chosen = 'C:\\Users\\Ana Žagar\\Znanje';
  host.registerDesktopHost({ pickFolder: FD.createPickFolder({ dialog: fakeDialog([{ canceled: false, filePaths: [chosen] }]), getWindow: () => null, platform: 'win32' }) });
  const res = fakeRes(); const set = [];
  const disk = winDisk({ dirs: [chosen], bundle: true, appRoot });
  await configRoute.pickFolderHandler({}, res, { caps: { folderPickerStyle: 'native-dialog' }, platform: 'win32', hasActiveWrites: () => false, setDomainsDir: (p) => set.push(p), existsSync: disk.deps.existsSync, validate: disk.deps });
  eq([res.statusCode, res.body, set], [200, { ok: true, path: chosen }, [chosen]], 'the Windows app end to end: Electron dialog (fake) → registry → pick-folder → applied');
  host.__resetDesktopHost();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  Real Windows (windows-latest)');
// ═══════════════════════════════════════════════════════════════════════════
if (process.platform !== 'win32') {
  console.log('  · skipped: not Windows (this section runs on the windows-latest job)');
} else {
  // The NATIVE realpath: windows-latest's temp folder is reached through an
  // 8.3 short name (RUNNER~1), which realpath.native expands — a typed path
  // that differs by more than case is (rightly) kept as typed (AgentLink 98c5b08cd).
  const base = path.join(fs.realpathSync.native(tmp), 'Real Ž é');
  fs.mkdirSync(path.join(base, 'Notes'), { recursive: true });
  eq(fs.existsSync(path.join(base, 'notes')), true, 'NTFS: "notes" answers for "Notes"');
  const v = kfp.validateKnowledgeFolderPath(path.join(base, 'NOTES'), { bundle: false });
  eq([v.ok, v.path], [true, path.join(base, 'Notes')], 'real: an existing folder typed in another case is applied under its real name');
  ok(!fs.readdirSync(path.join(base, 'Notes')).some((n) => n.startsWith('.curator-write-check')), 'real: the write check left nothing behind');
  const dev = '\\\\?\\' + path.join(base, 'con');
  fs.mkdirSync(dev);                              // Node's own \\?\ makes this possible
  eq(kfp.validateKnowledgeFolderPath(path.join(base, 'con'), { bundle: false }).reason, 'reserved-name', 'real: a folder named con (made through \\\\?\\) is refused');
  fs.rmdirSync(dev);
  let deep = base;
  while (deep.length < 270) deep = path.join(deep, 'segment-ž-' + deep.length);
  fs.mkdirSync(deep, { recursive: true });          // Node handles > 260
  eq(kfp.validateKnowledgeFolderPath(deep, { bundle: false }).reason, 'too-long', 'real: a > 260-character folder is refused');
  eq(kfp.validateKnowledgeFolderPath(path.parse(tmp).root, { bundle: false }).reason, 'drive-root', 'real: the drive root is refused');
  eq(await files.generateUniqueSlug('Notes', null, { existsSync: (p) => fs.existsSync(path.join(base, path.basename(p))) }), 'notes-2',
    'real: a new "Notes" beside a real "Notes" folder → notes-2');
}

// ── Nothing escaped the tempdir ──────────────────────────────────────────────
const stray = fs.readdirSync(process.cwd()).filter((n) => !cwdBefore.has(n));
eq(stray, [], 'nothing was written to the current directory (no simulated Windows path became a real file)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
