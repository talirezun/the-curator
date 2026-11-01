/**
 * test-win-folder-picker.js — OFFLINE (v3.87.1). "Use existing folder" on Windows.
 *
 * v3.87.0 made both folder pickers answer 501 on Windows, so a repo install
 * there had no way to point the app at an existing knowledge folder. v3.87.1
 * shows Windows' own FolderBrowserDialog through PowerShell, and adds a typed
 * path beside every picker refusal. This suite pins:
 *
 *   §1  the dialog's process: powershell.exe by ABSOLUTE path, -STA, the argv
 *       shape, no shell, hidden, a ten-minute timeout, the prompt as an
 *       environment variable (never code), a TopMost owner in the script;
 *   §2  reading the answer: a chosen folder (non-ASCII), cancel, a BOM,
 *       garbage, a CLIXML error, PowerShell missing — and a REAL timeout kill
 *       of a real child process;
 *   §3  the two routes on win32 (pick-folder applies through the same
 *       post-pick rules as macOS; pick-path only reports), and darwin unchanged;
 *   §4  the typed-path route's validation (relative, missing, a file, a
 *       traversal, the app's own folders, quotes, Windows drive rules);
 *   §5  the frontend fallback: Domains and Settings render the field after a
 *       picker refusal, and send the typed path to the validated route.
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR / _DOMAINS_DIR / _LOG_DIR point at a
 * fresh tempdir before any app module loads. No dialog opens anywhere: §2's
 * real child is a tiny Node script standing in for powershell.exe.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-winpick-')));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(tmp, 'user');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(tmp, 'domains');
process.env.CURATOR_TEST_LOG_DIR = path.join(tmp, 'logs');
for (const d of ['user', 'domains', 'logs']) fs.mkdirSync(path.join(tmp, d), { recursive: true });

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
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const wfd = await import(path.join(ROOT, 'src/brain/win-folder-dialog.js'));
const kfp = await import(path.join(ROOT, 'src/brain/knowledge-folder-path.js'));
const configRoute = await import(path.join(ROOT, 'src/routes/config.js'));
const { APP_ROOT } = await import(path.join(ROOT, 'src/brain/paths.js'));

// A fake execFile that records the call and answers as told.
function fakeExecFile(answer) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    setImmediate(() => cb(answer.err || null, answer.stdout || '', answer.stderr || ''));
    return {};
  };
  fn.calls = calls;
  return fn;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The dialog process: absolute powershell.exe, -STA, argv, no shell');
// ═══════════════════════════════════════════════════════════════════════════
{
  const savedRoot = process.env.SystemRoot;
  delete process.env.SystemRoot;
  const ex = fakeExecFile({ stdout: 'CANCEL' });
  await wfd.pickFolderWin32({ prompt: 'Select your Knowledge Base folder:' }, { execFile: ex });
  if (savedRoot !== undefined) process.env.SystemRoot = savedRoot;
  const c = ex.calls[0] || {};
  eq(ex.calls.length, 1, 'one process per dialog');
  eq(c.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'powershell.exe by ABSOLUTE path under %SystemRoot% (C:\\Windows when unset) — never a bare name');
  eq((c.args || []).slice(0, 6), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'],
    'argv: -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand');
  eq((c.args || []).length, 7, 'argv: exactly seven elements (the last is the encoded script)');
  const decoded = Buffer.from((c.args || [])[6] || '', 'base64').toString('utf16le');
  eq(decoded, wfd.WIN_FOLDER_DIALOG_SCRIPT, 'the encoded command decodes (UTF-16LE) to the constant script, byte for byte');
  ok(!c.opts || !c.opts.shell, 'no shell: execFile with an argv array');
  eq([c.opts && c.opts.windowsHide, c.opts && c.opts.timeout], [true, 10 * 60 * 1000],
    'hidden console, and a ten-minute timeout');
  eq(c.opts && c.opts.env && c.opts.env[wfd.WIN_PICK_PROMPT_ENV], 'Select your Knowledge Base folder:',
    'the dialog\'s description travels as an ENVIRONMENT VARIABLE');
  ok(!decoded.includes('Select your Knowledge Base folder') && !(c.args || []).join(' ').includes('Select your'),
    '…and never as code: the prompt text is in neither the script nor the argv');
  const S = wfd.WIN_FOLDER_DIALOG_SCRIPT;
  ok(/FolderBrowserDialog/.test(S) && /\$owner\.TopMost = \$true/.test(S) && /ShowDialog\(\$owner\)/.test(S),
    'the script shows a FolderBrowserDialog OWNED by a TopMost form, so it is not hidden behind the browser');
  ok(/\$owner\.Opacity = 0/.test(S) && /CenterScreen/.test(S),
    'the owner is invisible (Opacity 0) and centred on the screen — not off-screen, which would carry the dialog off-screen too');
  ok(S.indexOf('$owner.Show()') < S.indexOf('$owner.Hide()') && S.lastIndexOf('$owner.Show()') > S.indexOf('$owner.Hide()'),
    'the owner is shown, hidden and shown again BEFORE the dialog (spends the "start hidden" first show on the owner)');
  ok(/UTF8Encoding\(\$false\)/.test(S) && /ToBase64String/.test(S),
    'the answer is UTF-8 base64 on stdout (and the output encoding UTF-8 without a BOM)');
  ok(!/\$\{|\+\s*prompt/.test(S), 'CONTROL: the script is a fixed literal, not built from a variable');

  process.env.SystemRoot = 'D:\\Win';
  const ex2 = fakeExecFile({ stdout: 'CANCEL' });
  await wfd.pickFolderWin32({ prompt: 'x' }, { execFile: ex2 });
  if (savedRoot !== undefined) process.env.SystemRoot = savedRoot; else delete process.env.SystemRoot;
  eq(ex2.calls[0].file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '%SystemRoot% is honoured');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  Reading the answer');
// ═══════════════════════════════════════════════════════════════════════════
{
  const ZIGA = 'C:\\Users\\Žiga Novak\\Znanje — wiki';
  const run = (answer) => wfd.pickFolderWin32({ prompt: 'p' }, { execFile: fakeExecFile(answer) });
  eq(await run({ stdout: 'OK ' + b64(ZIGA) }), { kind: 'picked', path: ZIGA },
    'a chosen folder under a non-ASCII user name comes back exactly');
  eq(await run({ stdout: '\uFEFFOK ' + b64(ZIGA) + '\r\n' }), { kind: 'picked', path: ZIGA },
    'a BOM and a trailing CRLF are tolerated');
  eq(await run({ stdout: 'CANCEL' }), { kind: 'cancelled' }, 'CANCEL is a cancel');
  eq((await run({ stdout: 'C:\\plain\\path' })).kind, 'failed', 'an unreadable answer is a failure, never a path');
  const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' });
  eq(await run({ err: killed }), { kind: 'cancelled', timedOut: true }, 'a killed process (timeout) is a cancel');
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  eq((await run({ err: enoent })).kind, 'unavailable', 'PowerShell that cannot start is `unavailable`');
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Add-Type : Could not load_x000D__x000A_</S><S S="Error">System.Windows.Forms</S></Objs>';
  const f = await run({ err: Object.assign(new Error('Command failed'), { code: 1 }), stderr: clixml });
  eq(f.kind, 'failed', 'exit 1 is `failed`');
  eq(f.message, 'Add-Type : Could not load System.Windows.Forms', '…carrying the CLIXML error as plain text');

  // A REAL timeout kill, of a real child, standing in for powershell.exe.
  if (process.platform !== 'win32') {
    const stub = path.join(tmp, 'slow-powershell');
    fs.writeFileSync(stub, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
    const t0 = Date.now();
    const got = await wfd.pickFolderWin32({ prompt: 'p' }, { powershellPath: stub, timeoutMs: 300 });
    const took = Date.now() - t0;
    eq(got, { kind: 'cancelled', timedOut: true }, 'REAL: a dialog left open past the timeout is killed and read as a cancel');
    ok(took < 5000, `REAL: …promptly (${took} ms for a 300 ms timeout)`);
    const missing = await wfd.pickFolderWin32({ prompt: 'p' }, { powershellPath: path.join(tmp, 'no-such-powershell.exe') });
    eq(missing.kind, 'unavailable', 'REAL: a missing powershell.exe is `unavailable`, not a throw');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The routes on win32 (and darwin unchanged)');
// ═══════════════════════════════════════════════════════════════════════════
async function pick(handler, platform, win, extra = {}, body = {}) {
  const log = { exec: 0, set: [], win: [] };
  const res = fakeRes();
  const deps = {
    caps: { folderPickerStyle: 'osascript' },
    execAsync: async () => { log.exec++; return { stdout: '/Users/x/kb\n', stderr: '' }; },
    existsSync: () => true,
    hasActiveWrites: () => false,
    setDomainsDir: (p) => { log.set.push(p); },
    pickFolderHook: null,
    platform,
    ...extra,
  };
  if (win !== undefined) deps.pickFolderWin32 = async (o) => { log.win.push(o); return win; };
  await handler({ body }, res, deps);
  return { res, log };
}
{
  const P = 'C:\\Users\\Ana Žagar\\my wiki';
  const a = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'picked', path: P + '  ' });
  eq([a.res.statusCode, a.res.body, a.log.set, a.log.exec], [200, { ok: true, path: P }, [P], 0],
    'pick-folder win32: a chosen folder is applied and reported — the same {ok, path} shape as macOS');
  eq(a.log.win[0] && a.log.win[0].prompt, 'Select your Knowledge Base folder:', 'pick-folder win32: the server\'s own prompt');
  const c = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'cancelled' });
  eq([c.res.statusCode, c.res.body, c.log.set.length], [200, { cancelled: true }, 0], 'pick-folder win32: cancel → {cancelled:true}, nothing applied');
  const t = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'cancelled', timedOut: true });
  eq([t.res.body, t.log.set.length], [{ cancelled: true }, 0], 'pick-folder win32: a timeout is a cancel');
  const gone = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'picked', path: P }, { existsSync: () => false });
  eq([gone.res.statusCode, gone.log.set.length], [400, 0], 'pick-folder win32: the SAME post-pick existence check as macOS');
  const busy = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'picked', path: P }, { hasActiveWrites: () => true });
  eq([busy.res.statusCode, busy.log.set.length], [409, 0], 'pick-folder win32: the SAME concurrency re-check as macOS');
  const un = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'unavailable', message: 'Windows PowerShell could not be started (ENOENT).' });
  eq([un.res.statusCode, un.res.body.reason, un.log.set.length], [501, 'no-dialog', 0], 'pick-folder win32: no PowerShell → 501 no-dialog');
  ok(/full path/.test(un.res.body.hint || '') && !('cancelled' in un.res.body), '…with a hint naming the typed path, and no `cancelled` field');
  const fl = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'failed', message: 'boom' });
  eq([fl.res.statusCode, fl.res.body.error, fl.log.set.length], [500, 'boom', 0], 'pick-folder win32: a failure → 500 with its message');
  // The production default is wired: no injected dialog → the real module,
  // whose powershell.exe does not exist on this host → `unavailable`.
  if (process.platform !== 'win32') {
    const real = await pick(configRoute.pickFolderHandler, 'win32', undefined);
    eq([real.res.statusCode, real.res.body.reason, real.log.exec, /PowerShell could not be started \(ENOENT\)/.test(real.res.body.error)], [501, 'no-dialog', 0, true],
      'pick-folder win32 with NO seam: the real Windows dialog module runs (here: no powershell.exe → no-dialog)');
  }

  const pp = await pick(configRoute.pickPathHandler, 'win32', { kind: 'picked', path: P }, {}, { prompt: 'foundations' });
  eq([pp.res.statusCode, pp.res.body, pp.log.set.length], [200, { ok: true, path: P }, 0], 'pick-path win32: reports the folder, applies nothing');
  eq(pp.log.win[0].prompt, 'Choose the folder that holds this project’s documents:', 'pick-path win32: the prompt is the server\'s literal for the key');
  const ppEvil = await pick(configRoute.pickPathHandler, 'win32', { kind: 'cancelled' }, {}, { prompt: '"; Remove-Item C:\\ -Recurse #' });
  eq([ppEvil.res.body, ppEvil.log.win[0].prompt], [{ ok: false, reason: 'cancelled' }, 'Choose a folder:'],
    'pick-path win32: client text never reaches the dialog (an unknown key takes the default); cancel → reason cancelled');
  const ppUn = await pick(configRoute.pickPathHandler, 'win32', { kind: 'unavailable', message: 'x.' });
  eq([ppUn.res.statusCode, ppUn.res.body.reason], [501, 'no-dialog'], 'pick-path win32: no PowerShell → the no-dialog fact (the UI shows the typed field)');
  const ppF = await pick(configRoute.pickPathHandler, 'win32', { kind: 'failed', message: 'bad' });
  eq([ppF.res.statusCode, ppF.res.body.reason, ppF.res.body.message], [500, 'failed', 'bad'], 'pick-path win32: failure → failed');

  const d = await pick(configRoute.pickFolderHandler, 'darwin', { kind: 'picked', path: 'NEVER' });
  eq([d.res.statusCode, d.res.body, d.log.exec, d.log.win.length], [200, { ok: true, path: '/Users/x/kb' }, 1, 0],
    'pick-folder darwin CONTROL: osascript, unchanged; the Windows dialog is never called');
  const dp = await pick(configRoute.pickPathHandler, 'darwin', { kind: 'picked', path: 'NEVER' }, {}, { prompt: 'foundations' });
  eq([dp.res.body, dp.log.exec, dp.log.win.length], [{ ok: true, path: '/Users/x/kb' }, 1, 0], 'pick-path darwin CONTROL: unchanged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The typed-path route: POST /api/config/domains-path validates');
// ═══════════════════════════════════════════════════════════════════════════
{
  const KB = path.join(tmp, 'My Wiki Žiga');
  fs.mkdirSync(path.join(KB, 'articles'), { recursive: true });
  const FILE = path.join(tmp, 'notes.txt');
  fs.writeFileSync(FILE, 'x');
  const FAKE_APP = path.join(tmp, 'the-curator');
  for (const d of ['src', 'domains/articles', 'node_modules']) fs.mkdirSync(path.join(FAKE_APP, d), { recursive: true });

  async function post(p, validate = {}) {
    const set = [];
    const res = fakeRes();
    configRoute.domainsPathHandler({ body: { path: p } }, res, { setDomainsDir: (x) => set.push(x), validate: { appRoot: FAKE_APP, ...validate } });
    return { res, set };
  }
  const good = await post(KB);
  eq([good.res.statusCode, good.res.body, good.set], [200, { ok: true, domainsPath: KB }, [KB]], 'an existing, readable folder is applied and reported');
  const quoted = await post('  "' + KB + '"  ');
  eq([quoted.res.statusCode, quoted.set], [200, [KB]], 'File Explorer\'s "Copy as path" quotes are removed');
  const trav = await post(KB + '/articles/..');   // NOT path.join, which would normalise it first
  eq([trav.res.statusCode, trav.set], [200, [KB]], 'a `..` is resolved, and the NORMALISED path is what is applied');
  const cases = [
    ['', 400, undefined, 'an empty path'],
    ['relative/wiki', 400, 'not-absolute', 'a relative path'],
    [path.join(tmp, 'nope'), 400, 'missing', 'a folder that does not exist'],
    [FILE, 400, 'not-a-folder', 'a file, not a folder'],
    [KB + '/../notes.txt', 400, 'not-a-folder', 'a traversal that lands on a file'],
    [FAKE_APP, 400, 'inside-app', 'the app checkout itself'],
    [path.join(FAKE_APP, 'src'), 400, 'inside-app', 'the app\'s code folder'],
    [FAKE_APP + '/domains/../node_modules', 400, 'inside-app', 'a traversal from domains/ into the app\'s own files'],
    [KB + '\0x', 400, 'invalid', 'a NUL byte'],
  ];
  for (const [p, status, reason, label] of cases) {
    const r = await post(p);
    eq([r.res.statusCode, r.res.body.reason, r.set.length], [status, reason, 0], `refused: ${label}`);
    ok(typeof r.res.body.error === 'string' && r.res.body.error.length > 0, `…with an \`error\` sentence (${label})`);
  }
  const missingMsg = (await post(path.join(tmp, 'nope'))).res.body.error;
  eq(missingMsg, 'Folder does not exist: ' + path.join(tmp, 'nope'), 'the existing route\'s "Folder does not exist" sentence is kept');
  const inDomains = await post(path.join(FAKE_APP, 'domains'));
  eq([inDomains.res.statusCode, inDomains.set], [200, [path.join(FAKE_APP, 'domains')]], 'the checkout\'s OWN domains folder (the repo default) is allowed');
  const link = path.join(tmp, 'sneaky-link');
  fs.symlinkSync(path.join(FAKE_APP, 'src'), link);
  eq((await post(link)).res.body.reason, 'inside-app', 'a symlink INTO the app\'s code is judged by its real path');
  const unreadable = await post(KB, { readdirSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } });
  eq(unreadable.res.body.reason, 'unreadable', 'a folder that cannot be listed is refused');
  // The real APP_ROOT is the default containment root.
  eq(kfp.validateKnowledgeFolderPath(path.join(APP_ROOT, 'src')).reason, 'inside-app', 'DEFAULT root: the real checkout\'s src/ is refused');

  // Windows rules, through injected fs fakes (a Windows path on any host).
  const winFs = {
    platform: 'win32', appRoot: 'C:\\Users\\Ana\\the-curator',
    existsSync: () => true, statSync: () => ({ isDirectory: () => true }), readdirSync: () => [], realpathSync: (p) => p,
  };
  const v = (p) => kfp.validateKnowledgeFolderPath(p, winFs);
  eq(v('C:\\Users\\Žiga\\Znanje'), { ok: true, path: 'C:\\Users\\Žiga\\Znanje' }, 'win32: a drive path is accepted');
  eq(v('"C:\\Users\\Žiga\\Znanje"').path, 'C:\\Users\\Žiga\\Znanje', 'win32: "Copy as path" quotes removed');
  eq(v('\\\\nas\\share\\wiki').ok, true, 'win32: a UNC path is accepted');
  eq(v('\\Users\\x').reason, 'not-absolute', 'win32: a drive-less "\\folder" is refused (it means "the current drive")');
  eq(v('wiki\\x').reason, 'not-absolute', 'win32: a relative path is refused');
  eq(v('C:\\Users\\ana\\THE-CURATOR\\src').reason, 'inside-app', 'win32: the app\'s code is refused case-insensitively');
  eq(v('C:\\Users\\Ana\\the-curator\\domains').ok, true, 'win32: the checkout\'s domains folder is allowed');
  eq(v('C:\\Users\\Ana\\the-curator\\domains\\..\\scripts').reason, 'inside-app', 'win32: a traversal out of domains\\ is refused');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The frontend fallback (Domains and Settings)');
// ═══════════════════════════════════════════════════════════════════════════
function extractFunction(source, name) {
  const m = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`).exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start), depth = 0;
  for (; p < source.length; p++) { if (source[p] === '(') depth++; else if (source[p] === ')') { depth--; if (depth === 0) { p++; break; } } }
  let i = source.indexOf('{', p); depth = 0;
  for (; i < source.length; i++) { if (source[i] === '{') depth++; else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return source.slice(start, i);
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const renderStatus = (o) => `<div class="tx-status tx-status-${o.state}"><b>${escapeHtml(o.title)}</b>${escapeHtml(o.detail || '')}</div>`;
{
  const src = fs.readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
  const names = ['classifyPickResponse', 'renderKnowledgeNotice', 'renderTypedKnowledgePath', 'onChooseKnowledgeFolder', 'onTypedKnowledgeFolder'];
  const renderDescription = (t) => '<p class="tx-desc">' + escapeHtml(t) + '</p>';
  const make = new Function('escapeHtml', 'renderStatus', 'renderDescription', `
    let state = {}; const calls = { fetch: [], render: 0, applied: [] }; let queue = [];
    const shell = { isAnyWriteBusy: () => false };
    function render() { calls.render++; }
    function isCurrentMount() { return true; }
    async function applySwitchedFolder(p, prev) { calls.applied.push([p, prev]); }
    async function fetch(url, opts) {
      calls.fetch.push({ url, method: opts && opts.method, body: opts && opts.body });
      const n = queue.shift(); return { ok: n.status < 400, status: n.status, json: async () => n.body };
    }
    ${names.map((n) => extractFunction(src, n)).join('\n')}
    return { ${names.join(', ')}, setState: (s) => { state = s; }, getState: () => state, calls, q: (r) => queue.push(r) };`);
  const D = make(escapeHtml, renderStatus, renderDescription);
  const base = () => ({ kb: { domainsPath: 'C:\\the-curator\\domains' }, kbBusy: false, kbNotice: null, kbTypedError: null, kbTypedValue: '' });

  // A picker refusal (501) → the typed field appears in the notice.
  D.setState(base());
  D.q({ status: 501, body: { ok: false, reason: 'no-dialog', error: 'Windows PowerShell could not be started (ENOENT).', hint: 'Paste the folder\'s full path instead.' } });
  await D.onChooseKnowledgeFolder(1);
  const html = D.renderKnowledgeNotice();
  ok(D.getState().kbNotice.typedPath === true, 'Domains: a 501 refusal offers the typed path');
  ok(/id="dm-kb-typed-input"/.test(html) && /id="dm-kb-typed-btn"[^>]*>Use this folder</.test(html),
    'Domains: the notice renders the field and a "Use this folder" button');
  ok(/class="dm-lc-input mono"/.test(html) && /class="btn btn-primary"/.test(html) && /class="tx-desc"/.test(html),
    'Domains: built only from existing parts (.dm-lc-input, .btn, renderDescription)');
  ok(/address bar/.test(html), 'Domains: one line says where the full path is shown');
  // A 500 failure too; a 409 (a write in progress) does not.
  D.setState(base()); D.q({ status: 500, body: { error: 'boom' } }); await D.onChooseKnowledgeFolder(1);
  ok(D.getState().kbNotice.typedPath === true, 'Domains: a 500 failure also offers the typed path');
  D.setState(base()); D.q({ status: 409, body: { error: 'An ingest is running.' } }); await D.onChooseKnowledgeFolder(1);
  ok(!D.getState().kbNotice.typedPath && !/dm-kb-typed-input/.test(D.renderKnowledgeNotice()),
    'Domains: a 409 (a write is running) does NOT offer it — the typed route would refuse for the same reason');
  D.setState(base()); D.q({ status: 200, body: { cancelled: true } }); await D.onChooseKnowledgeFolder(1);
  ok(D.getState().kbNotice === null, 'Domains: a cancel says nothing');

  // Submitting the typed path.
  D.setState({ ...base(), kbNotice: { state: 'danger', title: 't', detail: 'd', typedPath: true } });
  D.calls.fetch.length = 0;
  D.q({ status: 400, body: { ok: false, reason: 'not-a-folder', error: 'That is a file, not a folder: C:\\x.txt.' } });
  await D.onTypedKnowledgeFolder('C:\\x.txt', 1);
  eq([D.calls.fetch[0].url, D.calls.fetch[0].method, JSON.parse(D.calls.fetch[0].body)], ['/api/config/domains-path', 'POST', { path: 'C:\\x.txt' }],
    'Domains: the typed path goes to the EXISTING validated route, as typed');
  ok(/That is a file, not a folder/.test(D.renderKnowledgeNotice()) && D.getState().kbTypedValue === 'C:\\x.txt',
    'Domains: the server\'s refusal is shown beside the field, and what was typed is kept');
  D.q({ status: 200, body: { ok: true, domainsPath: 'C:\\Users\\Žiga\\Znanje' } });
  await D.onTypedKnowledgeFolder('"C:\\Users\\Žiga\\Znanje"', 1);
  eq(D.calls.applied.at(-1), ['C:\\Users\\Žiga\\Znanje', 'C:\\the-curator\\domains'],
    'Domains: on success the SERVER\'s normalised path is applied through applySwitchedFolder, with the way back');
  const before = D.calls.fetch.length;
  await D.onTypedKnowledgeFolder('   ', 1);
  ok(D.calls.fetch.length === before && /first/.test(D.getState().kbTypedError), 'Domains: an empty field sends nothing and says so');
  ok(!/cannot open a folder picker on Windows yet/.test(src), 'Domains: no v3.87.0 refusal text left in the view');

  // Settings.
  const ssrc = fs.readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
  const S = new Function('escapeHtml', `
    let state = {}; const calls = { fetch: [], loadConfig: 0 }; let queue = [];
    function render() {} function isCurrentMount() { return true; } function crossWriteBusy() { return false; }
    async function loadConfig() { calls.loadConfig++; }
    async function fetch(url, opts) { calls.fetch.push({ url, body: opts && opts.body });
      const n = queue.shift(); return { ok: n.status < 400, status: n.status, json: async () => n.body }; }
    ${['renderTypedFolderFallback', 'onChooseFolder', 'onUseTypedFolder'].map((n) => extractFunction(ssrc, n)).join('\n')}
    return { renderTypedFolderFallback, onChooseFolder, onUseTypedFolder, setState: (s) => { state = s; }, getState: () => state, calls, q: (r) => queue.push(r) };`)(escapeHtml);
  S.setState({ config: { domainsPath: 'C:\\a' }, pickingFolder: false });
  ok(S.renderTypedFolderFallback() === '', 'Settings: nothing extra before any picker failure');
  S.q({ status: 501, body: { ok: false, reason: 'no-dialog', error: 'No PowerShell.', hint: 'Paste the path.' } });
  await S.onChooseFolder(1);
  const sh = S.renderTypedFolderFallback();
  ok(!S.getState().configError && /No PowerShell\. Paste the path\./.test(sh),
    'Settings: a picker failure is shown INLINE (the block and its path row stay), never through configError');
  ok(/id="typed-folder-input"/.test(sh) && /id="typed-folder-use"[^>]*>Use this folder</.test(sh) && /provider-replace-row/.test(sh),
    'Settings: the typed field reuses the provider replace row, with "Use this folder"');
  S.q({ status: 200, body: { ok: true, domainsPath: 'C:\\b' } });
  await S.onUseTypedFolder('C:\\b', 1);
  eq([S.calls.fetch.at(-1).url, S.calls.loadConfig, S.getState().folderPickError], ['/api/config/domains-path', 1, null],
    'Settings: the typed path goes to domains-path, the config is re-read, the fallback closes');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
