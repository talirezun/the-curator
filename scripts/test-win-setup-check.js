#!/usr/bin/env node
/**
 * test-win-setup-check.js — the Setup check on Windows (v4.1.2, audit W1, W2,
 * W9, W10, W12). Windows is SIMULATED on this machine with the Setup check's
 * platform seam (`__setSetupPlatform('win32')`) over a POSIX scratch home, the
 * same way the installer suites simulate it. What only a real PC can show
 * (real %APPDATA% values, a real Claude Desktop install, NTFS) is not here.
 *
 *   W1  Claude Desktop's Windows config (%APPDATA%\Claude\…, and every other
 *       candidate the one-click installer reads) is read; it was never read,
 *       so step 5 said "no config file found" beside a working entry.
 *       macOS reads exactly what it read before.
 *   W12 a knowledge-folder path that differs only in case or separator is
 *       the same folder on Windows; on macOS the strict compare is kept.
 *   W10 a Windows entry's `…\mcp\server.js` is recognised as our server, and
 *       the Windows app's user data folder (%LOCALAPPDATA%\TheCurator\App)
 *       is one of this computer's installs.
 *   W2  GET /api/setup/skills/<name>.zip answers a real zip off macOS (it
 *       answered 501 while every view drew the link).
 *   W9  Reveal is macOS only: the route refuses it elsewhere and step 5
 *       draws no Reveal button and no "Finder" sentence there.
 *
 * Offline; isolated (CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a
 * fake HOME, CURATOR_NO_OPEN); nothing outside the scratch folder is read.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (d !== undefined ? '\n      ' + JSON.stringify(d).slice(0, 600) : '')); } };
const section = (t) => console.log('\n' + t);

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-win-setup-'));
const HOME = path.join(TMP, 'Users', 'Jane Doe');
const DOMAINS = path.join(TMP, 'domains');
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_SETUP_HOME = HOME;
process.env.CURATOR_NO_OPEN = '1';
process.env.HOME = HOME;
for (const d of [process.env.CURATOR_TEST_USER_DATA_DIR, DOMAINS, HOME]) mkdirSync(d, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
const w = (f, t) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); };

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const SC = await import('../src/brain/setup-check.js');
SC.__setLaunchExists(() => true);

const WIN_EXE = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\The Curator\\The Curator.exe';
const WIN_SCRIPT = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\The Curator\\resources\\app\\mcp\\server.js';
const entry = (extraArgs = []) => JSON.stringify({ mcpServers: { 'my-curator': { command: WIN_EXE, args: [WIN_SCRIPT, ...extraArgs], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2);
const ROAMING_CFG = path.join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
const MSIX_CFG = path.join(HOME, 'AppData', 'Local', 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json');
const MAC_CFG = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const cd = (platform) => {
  SC.__setSetupPlatform(platform);
  const rows = SC.collectMachineSetup({ home: HOME, repo: '', skillsDir: null, domainsDir: DOMAINS, hookSummary: {} });
  return rows.find((r) => r.id === 'claude-desktop');
};

section('W1. Claude Desktop\'s Windows config is read');
{
  w(ROAMING_CFG, entry());
  const r = cd('win32');
  ok(r && r.bridge.state === 'ok' && r.bridge.word === 'configured', 'win32: an entry in %APPDATA%\\Claude\\claude_desktop_config.json reads "configured"', r && r.bridge);
  const f = r.files.find((x) => x.file === ROAMING_CFG);
  ok(f && f.named && f.present && f.display === '%APPDATA%\\Claude\\claude_desktop_config.json', 'its file row is present, names my-curator, and is shown as %APPDATA%\\…', f);
  ok(!r.files.some((x) => /Library/.test(x.file)), 'win32: no ~/Library path is listed for Claude Desktop', r.files.map((x) => x.display));
  ok(r.files.length === 7, 'win32: every installer candidate is read (7)', r.files.length);
  const cc = SC.collectMachineSetup({ home: HOME, repo: '', skillsDir: null, domainsDir: DOMAINS, hookSummary: {} }).find((x) => x.id === 'claude-code');
  ok(cc && !cc.files.some((x) => /Library/.test(x.file)), 'win32: Claude Code\'s macOS-only readAlso (~/Library/…) is not listed', cc && cc.files.map((x) => x.display));

  rmSync(ROAMING_CFG); w(MSIX_CFG, entry());
  const m = cd('win32');
  ok(m.bridge.state === 'ok', 'win32: the MSIX location (%LOCALAPPDATA%\\Claude-Data\\claude_pzs8sxrjxfjjc\\…) is read too', m.bridge);
  ok(m.files.find((x) => x.file === MSIX_CFG)?.display === '%LOCALAPPDATA%\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json', '…shown as %LOCALAPPDATA%\\…');
  rmSync(MSIX_CFG);

  const none = cd('win32');
  ok(none.bridge.state === 'none' && none.bridge.word === 'no config file found', 'win32: no file anywhere → "no config file found" (CONTROL)', none.bridge);

  // macOS unchanged: the same Windows-located file is NOT read; the Mac file is.
  w(ROAMING_CFG, entry());
  const mac = cd('darwin');
  ok(mac.files.map((x) => x.file).join('|') === [MAC_CFG, path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json')].join('|'), 'darwin: exactly the two paths it always read', mac.files.map((x) => x.file));
  ok(mac.bridge.word === 'no config file found', 'darwin: a file under AppData is not read (unchanged)', mac.bridge);
  w(MAC_CFG, entry());
  const mac2 = cd('darwin');
  ok(mac2.bridge.state === 'ok' && mac2.files[0].display === '~/Library/Application Support/Claude/claude_desktop_config.json', 'darwin: the Mac file reads configured, shown as ~/… (unchanged)', mac2.files[0]);
  rmSync(MAC_CFG);

  // Production roots come from the environment; a test never reads them.
  ok(SC.setupWinRoots('C:\\Users\\X', { LOCALAPPDATA: 'D:\\LA', APPDATA: 'D:\\RA' })?.appData === 'D:\\RA', 'production: %APPDATA% is read from the environment');
  ok(SC.setupWinRoots('C:\\Users\\X', { CURATOR_TEST_SETUP_HOME: 'x', LOCALAPPDATA: 'D:\\LA', APPDATA: 'D:\\RA' })?.appData === 'C:\\Users\\X\\AppData\\Roaming', 'test: derived from the home, never the runner\'s real one');
  ok(SC.setupWinRoots('C:\\Users\\X', {}) === null, 'no AppData known → null (nothing guessed)');
}

section('W12. Case-insensitive path compares on Windows');
{
  const lower = DOMAINS.toUpperCase();
  w(ROAMING_CFG, entry(['--domains-path', lower]));
  const r = cd('win32');
  ok(r.bridge.state === 'ok' && !r.files.find((x) => x.file === ROAMING_CFG).otherFolder, 'win32: --domains-path differing only in case is the same folder', r.bridge);
  const r2 = cd('win32');
  w(ROAMING_CFG, entry(['--domains-path', path.join(TMP, 'elsewhere')]));
  const r3 = cd('win32');
  ok(r2 && r3.bridge.state === 'fix' && /different knowledge folder/.test(r3.bridge.word), 'win32 CONTROL: a really different folder is still flagged', r3.bridge);
  w(MAC_CFG, entry(['--domains-path', lower]));
  const mac = cd('darwin');
  ok(mac.bridge.state === 'fix' && /different knowledge folder/.test(mac.bridge.word), 'darwin: the strict compare is kept (unchanged)', mac.bridge);
  rmSync(MAC_CFG); rmSync(ROAMING_CFG);
  ok(SC.samePath('C:\\A\\b', 'c:/a/B\\', 'win32') && !SC.samePath('C:\\A\\b', 'C:\\A\\c', 'win32'), 'samePath: win32 folds case and separators, nothing more');
  ok(!SC.samePath('/a/B', '/a/b', 'darwin') && SC.samePath('/a/b', '/a/b', 'darwin'), 'samePath: darwin is strict');
  ok(SC.isInsideDir('C:\\Repo\\x\\.agents\\m.json', 'c:\\repo\\X', 'win32') && !SC.isInsideDir('C:\\Repo2\\m.json', 'C:\\Repo', 'win32'), 'isInsideDir: win32 case-insensitive, no prefix false positive');
}

section('W10. A Windows entry is recognised as our server, and the Windows app is an install here');
{
  w(ROAMING_CFG, entry());
  const r = cd('win32');
  const f = r.files.find((x) => x.file === ROAMING_CFG);
  ok(f.serverScript === WIN_SCRIPT, 'win32: serverScript is the `…\\mcp\\server.js` argument', f.serverScript);
  rmSync(ROAMING_CFG);
}

// ── Routes ──────────────────────────────────────────────────────────────
const express = (await import('express')).default;
const R = await import('../src/routes/setup.js');
const revealed = [];
R.__setRevealer((t, cb) => { revealed.push(t); cb(null); });
const app = express(); app.use(express.json()); app.use('/api/setup', R.default);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
async function call(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, body: json || {}, buf, type: res.headers.get('content-type') || '' };
}

section('W10 (route). The Windows app\'s user data is one of this computer\'s installs');
{
  SC.__setSetupPlatform('win32');
  const appData = path.join(HOME, 'AppData', 'Local', 'TheCurator', 'App');
  w(path.join(appData, '.curator-machine-id'), 'win-pc-1234\n');
  w(ROAMING_CFG, entry());
  const m = await call('GET', '/api/setup/machine');
  ok(m.status === 200 && (m.body.machine?.ids || []).includes('win-pc-1234'), 'win32: %LOCALAPPDATA%\\TheCurator\\App\'s machine id is read', m.body.machine);
  const row = (m.body.harnesses || []).find((h) => h.id === 'claude-desktop');
  ok(row && row.bridge.state === 'ok' && row.files.find((x) => x.file === ROAMING_CFG)?.display === '%APPDATA%\\Claude\\claude_desktop_config.json', 'win32: GET /machine shows Claude Desktop configured, at %APPDATA%\\…', row && row.files);
  SC.__setSetupPlatform('darwin');
  const m2 = await call('GET', '/api/setup/machine');
  ok(!(m2.body.machine?.ids || []).includes('win-pc-1234'), 'darwin CONTROL: the Windows folder is not an install on a Mac');
  rmSync(ROAMING_CFG);
}

section('W2. The skill zip off macOS');
{
  SC.__setSetupPlatform('win32');
  const z = await call('GET', '/api/setup/skills/my-curator.zip');
  ok(z.status === 200 && /zip/.test(z.type) && z.buf.slice(0, 4).toString('hex') === '504b0304', 'win32: my-curator.zip is 200 and a zip (was 501)', z.status);
  const out = path.join(TMP, 'unzip'); mkdirSync(out, { recursive: true });
  const zf = path.join(TMP, 'my-curator.zip'); writeFileSync(zf, z.buf);
  let tested = '';
  try { tested = execFileSync('unzip', ['-t', zf], { encoding: 'utf8' }); } catch (e) { tested = String(e.stdout || e.message); }
  ok(/No errors detected/.test(tested), 'unzip -t: no errors', tested.slice(-200));
  try { execFileSync('unzip', ['-q', zf, '-d', out]); } catch { /* checked below */ }
  const src = path.join(ROOT, 'skills', 'my-curator');
  const list = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? list(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]).sort();
  const want = list(src);
  const got = list(path.join(out, 'my-curator'));
  ok(want.length > 0 && JSON.stringify(got) === JSON.stringify(want), 'the zip holds my-curator/ with exactly the skill folder\'s files', { want, got });
  ok(want.every((f) => readFileSync(path.join(src, f)).equals(readFileSync(path.join(out, 'my-curator', f)))), 'every file is byte-identical to the skill folder');
  const c = await call('GET', '/api/setup/skills/curator-continuity.zip');
  ok(c.status === 200 && c.buf.slice(0, 2).toString() === 'PK', 'win32: curator-continuity.zip too');
  ok((await call('GET', '/api/setup/skills/evil.zip')).status === 404, 'CONTROL: an unknown skill is still 404');
  SC.__setSetupPlatform('linux');
  ok((await call('GET', '/api/setup/skills/my-curator.zip')).status === 200, 'linux: 200 as well');
  if (process.platform === 'darwin') {
    SC.__setSetupPlatform('darwin');
    const d = await call('GET', '/api/setup/skills/my-curator.zip');
    ok(d.status === 200 && d.buf.slice(0, 2).toString() === 'PK', 'darwin: still ditto\'s zip (unchanged path)');
  }
  // THE SEAM (integration, v4.1.2): every link the views draw for an out-of-date
  // skill must be one this route serves on THAT platform. A stale my-curator in
  // Claude Code's folder; GET /machine reads it; the MCP bridge view and Setup's
  // step 5 render their download links; each href is fetched on the same platform.
  {
    const V = await import('../src/public/next/views/mcp-install.js');
    const S = await import('../src/public/next/views/setup-step.js');
    const stale = path.join(HOME, '.claude', 'skills', 'my-curator');
    for (const f of list(src)) w(path.join(stale, f), readFileSync(path.join(src, f)));
    w(path.join(stale, 'SKILL.md'), '---\nname: my-curator\n---\nan older copy\n');
    for (const plat of ['win32', 'linux', 'darwin']) {
      if (plat === 'darwin' && process.platform !== 'darwin') continue; // ditto only on a Mac
      SC.__setSetupPlatform(plat);
      const m = await call('GET', '/api/setup/machine');
      const cc = (m.body.harnesses || []).find((x) => x.id === 'claude-code');
      ok(cc && cc.skills && cc.skills.state === 'fix', `${plat}: the stale skill reads as a fix`, cc && cc.skills);
      const ww = cc ? V.machineWarnings(cc, { platform: plat }) : [];
      const skillWarn = ww.find((x) => x.kind === 'skill');
      const hrefs = [...String(skillWarn ? skillWarn.acts.join('') : '').matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
      ok(hrefs.length === 1 && hrefs[0] === '/api/setup/skills/my-curator.zip', `${plat}: the MCP bridge view draws the my-curator.zip link`, { ww });
      ok(skillWarn && /^Download it/.test(skillWarn.strong), `${plat}: …and its words say Download`, skillWarn);
      const stepHtml = S.fixButtons({ tool: 'claude-code', fixes: [{ kind: 'download-skill', skill: 'my-curator', href: '/api/setup/skills/my-curator.zip', label: 'Download my-curator.zip' }] }, null);
      ok(/href="\/api\/setup\/skills\/my-curator\.zip"/.test(stepHtml), `${plat}: Setup step 5 draws the same link`, stepHtml);
      for (const h of hrefs) {
        const got = await call('GET', h);
        ok(got.status === 200 && got.buf.slice(0, 2).toString() === 'PK', `${plat}: the drawn link ${h} is served (200, a zip)`, got.status);
      }
    }
    rmSync(path.join(HOME, '.claude', 'skills'), { recursive: true, force: true });
    SC.__setSetupPlatform('win32');
  }
  const { crc32 } = await import('../src/brain/setup-skill-zip.js');
  ok(crc32(Buffer.from('123456789')) === 0xcbf43926, 'crc32 check value (IEEE) is right');
}

section('W9. Reveal is macOS only');
{
  SC.__setSetupPlatform('win32');
  w(ROAMING_CFG, entry());
  await call('GET', '/api/setup/machine'); // lists the file → revealable
  const before = revealed.length;
  const r = await call('POST', '/api/setup/reveal', { path: ROAMING_CFG });
  ok(r.status === 501 && r.body.reason === 'unsupported' && revealed.length === before, 'win32: a listed file is NOT revealed (501), nothing run', r);
  SC.__setSetupPlatform('darwin');
  w(MAC_CFG, entry());
  await call('GET', '/api/setup/machine');
  const m = await call('POST', '/api/setup/reveal', { path: MAC_CFG });
  ok(m.status === 200 && revealed.at(-1) === MAC_CFG, 'darwin CONTROL: a listed file is revealed', m);
  rmSync(MAC_CFG); rmSync(ROAMING_CFG);

  const P = await import('../src/public/next/shared/platform.js');
  const S = await import('../src/public/next/views/setup-step.js');
  const f = { tool: 'claude-desktop', fixes: [{ kind: 'copy-snippet' }, { kind: 'reveal', path: '/x/claude_desktop_config.json' }] };
  P.setPlatform('win32');
  const winBtns = String(S.fixButtons(f, null));
  ok(!/data-setup-act="reveal"/.test(winBtns) && /copy-snippet/.test(winBtns), 'win32: step 5 draws no Reveal button (copy stays)', winBtns);
  const err = S.fileReaderContent({ domain: 'd', project: 'p', repo: { path: '/r' } }, '.curator-project', { ok: false, error: 'Could not read it.' });
  ok(!/Finder/.test(JSON.stringify(err)), 'win32: the reader error names no Finder');
  P.setPlatform('darwin');
  const macBtns = String(S.fixButtons(f, null));
  ok(/data-setup-act="reveal"/.test(macBtns), 'darwin CONTROL: the Reveal button is drawn');
  const errMac = S.fileReaderContent({ domain: 'd', project: 'p', repo: { path: '/r' } }, '.curator-project', { ok: false, error: 'Could not read it.' });
  ok(/Reveal it to open it in Finder/.test(JSON.stringify(errMac)), 'darwin CONTROL: the Finder sentence is kept');
  P.setPlatform(null);
}

server.close();
console.log(`\ntest-win-setup-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
