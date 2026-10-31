#!/usr/bin/env node
/**
 * test-mcp-install-windows.js — OFFLINE. v3.86.0: one-click install of the
 * `my-curator` entry into CLAUDE DESKTOP ON WINDOWS (src/brain/mcp-install.js
 * `resolveWinClaude` + the win32 executor, src/brain/harness-detect.js's
 * PowerShell probes, src/routes/mcp-install.js on win32).
 *
 * RUNS ON macOS AND ON A REAL WINDOWS RUNNER (the CI `windows` job). Every
 * scenario runs against TWO worlds:
 *   mem   an in-memory filesystem keyed by real Windows paths
 *         (`C:\Users\Tester Name\AppData\Local\…`, path.win32 semantics) —
 *         backslashes, drive letters and case-insensitive containment are
 *         exercised on a Mac exactly as on Windows;
 *   disk  the REAL filesystem in a scratch folder (a POSIX home on a Mac; a
 *         real `C:\…` home on Windows): real rename, real temp files, real
 *         read-only bits, real BOM/CRLF bytes.
 * Only %LOCALAPPDATA% / %APPDATA% are simulated (derived from the fake home);
 * the process's real ones are never read — a decoy proves it.
 *
 * What it proves, each with the arm that fails without the rule:
 *   §1 which file: exactly one LIVE candidate is the target; two → manual
 *      config_ambiguous; a `.user-data-left.*` marker or a `~copying.*`
 *      sibling makes a candidate NOT live; the Store candidate (#2) and the
 *      read-only extras are never written (config_unverified); none → only a
 *      confirmed legacy .exe install may create %APPDATA%\Claude\…; a lone
 *      %APPDATA% file beside an MSIX install is not trusted; a redirected
 *      AppData outside the user folder is refused;
 *   §2 the write: BOM + CRLF survive byte-exact through install → remove;
 *      other servers kept; idempotent; read-only refused (at plan AND when it
 *      turns read-only after the plan); rename retried on EBUSY/EPERM/EACCES
 *      with the compare-and-swap re-checked before EVERY attempt, then
 *      file_locked, temp file removed; a path with spaces and backslashes
 *      round-trips through JSON; other tools refused on Windows;
 *   §3 detection: Claude Desktop's executable by PATH (never the CLI's
 *      claude.exe), unreadable path → checked:false, Appx families exact;
 *      under CURATOR_TEST_INSTALL_HOME no ps / shell / PowerShell is spawned;
 *   §4 the routes in-process on win32: status → plan → apply → connected →
 *      remove, ambiguity reported with candidates, nothing written on refusal;
 *   §5 macOS: a Mac file with a BOM and CRLF round-trips too (POSIX hosts).
 * The REAL config files (and, on Windows, the real Claude Desktop candidates)
 * are fingerprinted before and after.
 */
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const eq = (label, a, b) => ok(label, Object.is(a, b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log('\n' + t);

const IS_WIN = process.platform === 'win32';
const REAL_BEFORE = fingerprintReal();
const realpath = realpathSync.native || realpathSync;
const TMP = realpath(mkdtempSync(path.join(tmpdir(), 'curator-mcpinst-win-')));
const UD = path.join(TMP, 'ud');
const DOM = path.join(TMP, 'domains');
for (const d of [UD, DOM]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = UD;
process.env.CURATOR_TEST_DOMAINS_DIR = DOM;
process.env.CURATOR_TEST_LOG_DIR = path.join(UD, 'logs');
// The suite's own fake home is the process's home for anything that asks the
// OS (Node reads USERPROFILE on Windows, HOME elsewhere).
const DISK_HOME = path.join(TMP, 'home');
mkdirSync(DISK_HOME, { recursive: true });
const SAVED_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.CURATOR_TEST_INSTALL_HOME = DISK_HOME;
process.env.HOME = DISK_HOME;
process.env.USERPROFILE = DISK_HOME;

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOM);
const M = await import('../src/brain/mcp-install.js');
const A = await import('../src/brain/harness-adapters.js');
const D = await import('../src/brain/harness-detect.js');
const R = await import('../src/routes/mcp-install.js');
const express = (await import('express')).default;

const OTHER = { command: 'npx', args: ['-y', 'other'], env: { API_KEY: 'sk-PLANTED-WIN' } };
const FAMS = A.adapterFor('claude-desktop').mcpConfig.platforms.win32.appxFamilies;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// ─────────────────────────────────────────────────────────────────────────
// Two worlds behind one interface
// ─────────────────────────────────────────────────────────────────────────

let clock = Date.parse('2026-10-31T10:00:00Z');
const tick = () => new Date((clock += 1000));

function memWorld() {
  const P = path.win32;
  const home = 'C:\\Users\\Tester Name';
  const fs = new Map();
  const err = (code) => Object.assign(new Error(code), { code });
  const addDirs = (p) => { let d = p; while (d && !fs.has(d)) { fs.set(d, { type: 'dir' }); const up = P.dirname(d); if (up === d) break; d = up; } };
  const w = {
    kind: 'mem', P, home, sleeps: [], posixWrites: 0, renameHook: null, renames: 0,
    put(p, data, mode = 0o666) { addDirs(P.dirname(p)); fs.set(p, { type: 'file', bytes: Buffer.from(data), mode }); },
    mkdir(p) { addDirs(p); },
    read(p) { const e = fs.get(p); return e && e.type === 'file' ? Buffer.from(e.bytes) : null; },
    exists(p) { return fs.has(p); },
    setMode(p, mode) { fs.get(p).mode = mode; },
    list(p) { return [...fs.keys()].filter((k) => P.dirname(k) === p && k !== p).map((k) => P.basename(k)); },
    cleanup() {},
  };
  w.io = {
    lstat(p) {
      const e = fs.get(p); if (!e) throw err('ENOENT');
      return { mode: (e.mode || 0o777) | (e.type === 'file' ? 0o100000 : 0o40000), size: e.bytes ? e.bytes.length : 0,
        isFile: () => e.type === 'file', isSymbolicLink: () => false, isDirectory: () => e.type === 'dir' };
    },
    readFile(p) { const e = fs.get(p); if (!e || e.type !== 'file') throw err('ENOENT'); return Buffer.from(e.bytes); },
    exists: (p) => fs.has(p),
    mkdirp: (p) => addDirs(p),
    readdir(p) { if (w.unlistable && w.unlistable.has(p)) throw err('EACCES'); const e = fs.get(p); if (!e) throw err('ENOENT'); if (e.type !== 'dir') throw err('ENOTDIR'); return w.list(p); },
    writeExclusive(p, buf, mode) { if (fs.has(p)) throw err('EEXIST'); if (!fs.has(P.dirname(p))) throw err('ENOENT'); fs.set(p, { type: 'file', bytes: Buffer.from(buf), mode: 0o666 }); },
    writeAtomic(p, text) { if (!p.startsWith(UD)) w.posixWrites++; addDirs(P.dirname(p)); fs.set(p, { type: 'file', bytes: Buffer.from(text), mode: 0o666 }); },
    writeTemp(target, data) {
      const tmp = P.join(P.dirname(target), `.tmp-${P.basename(target)}-1-${fs.size}`);
      if (!fs.has(P.dirname(target))) throw err('ENOENT');
      fs.set(tmp, { type: 'file', bytes: Buffer.from(data), mode: 0o666 }); return tmp;
    },
    rename(a, b) {
      w.renames++;
      if (w.renameHook) w.renameHook(a, b);
      const e = fs.get(a); if (!e) throw err('ENOENT');
      fs.set(b, e); fs.delete(a);
    },
    unlink(p) { if (!fs.delete(p)) throw err('ENOENT'); },
    sleep: (ms) => { w.sleeps.push(ms); },
    now: tick,
  };
  return w;
}

let diskN = 0;
function diskWorld() {
  const P = path;
  const root = path.join(TMP, `disk-${++diskN}`);
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const base = M.defaultIO();
  const readOnly = new Set();
  const w = {
    kind: 'disk', P, home, sleeps: [], posixWrites: 0, renameHook: null, renames: 0,
    put(p, data, mode) { mkdirSync(path.dirname(p), { recursive: true }); if (existsSync(p)) chmodSync(p, 0o666); writeFileSync(p, data); if (mode !== undefined) w.setMode(p, mode); },
    mkdir(p) { mkdirSync(p, { recursive: true }); },
    read(p) { try { return readFileSync(p); } catch { return null; } },
    exists: (p) => existsSync(p),
    setMode(p, mode) { chmodSync(p, mode); if ((mode & 0o222) === 0) readOnly.add(p); else readOnly.delete(p); },
    list(p) { try { return readdirSync(p); } catch { return []; } },
    cleanup() { for (const p of readOnly) { try { chmodSync(p, 0o666); } catch { /* gone */ } } },
  };
  w.io = {
    ...base,
    // The manifest (The Curator's OWN file, in user data) is written this way on
    // every platform; only a write to a TOOL's file counts here.
    writeAtomic: (...a) => { if (!String(a[0]).startsWith(UD)) w.posixWrites++; return base.writeAtomic(...a); },
    rename: (a, b) => { w.renames++; if (w.renameHook) w.renameHook(a, b); return base.rename(a, b); },
    sleep: (ms) => { w.sleeps.push(ms); },
    now: tick,
  };
  return w;
}

/** `%LOCALAPPDATA%` + the world's separator + parts. */
const localDisp = (w, ...parts) => ['%LOCALAPPDATA%', ...parts].join(w.P.sep);
const CD1 = ['Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json'];

/** Roots and candidate paths of a world, as the module resolves them under a test home. */
function layout(w) {
  const roots = M.winRoots(w.home);
  const c = {};
  for (const x of M.winCandidates(w.home, roots)) c[x.n] = x.file;
  return { roots, c, claudeData: w.P.join(roots.localAppData, 'Claude-Data'), pkg: w.P.join(roots.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc'), updater: w.P.join(roots.localAppData, 'AnthropicClaude', 'Update.exe') };
}

const REPO_WIN = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\Tester Name\\My Curator\\mcp\\server.js', '--domains-path', 'C:\\Users\\Tester Name\\My Curator\\domains'] };
const ctxFor = (w, extra = {}) => ({ home: w.home, launch: REPO_WIN, launcherState: { required: false, present: true }, detected: false, manifestRows: M.readManifest(w.io).rows, io: w.io, platform: 'win32', ...extra });
const decide = (w, appx) => M.resolveWinClaude({ home: w.home, roots: M.winRoots(w.home), io: w.io, appx });
const plan = (w, action, extra = {}) => M.planTool('claude-desktop', action, ctxFor(w, extra));
const run = (w, it) => M.executeItem(it, { home: w.home, io: w.io, platform: 'win32' });
const doc = (o, eol = '\n', bom = false) => `${bom ? '\uFEFF' : ''}${JSON.stringify(o, null, 2).replace(/\n/g, eol)}${eol}`;

const worlds = [];
try {
  section('§0 — data, roots, isolation');
  {
    const row = A.adapterFor('claude-desktop').mcpConfig.platforms?.win32;
    ok('the claude-desktop row carries platforms.win32 as DATA', !!row && Array.isArray(row.candidates) && row.candidates.length >= 4);
    const byN = Object.fromEntries(row.candidates.map((c) => [c.n, c]));
    ok('candidates 1, 3 and 4 may be written', byN[1].write && byN[3].write && byN[4].write);
    ok('candidate 2 (Store, inferred name) is READ-ONLY and labelled unverified', byN[2].write === false && byN[2].source === 'unverified');
    ok('every write:false candidate is unverified, every write:true one is not', row.candidates.every((c) => (c.write ? c.source !== 'unverified' : c.source === 'unverified')));
    ok('the provenance labels come from the table\'s own vocabulary', row.candidates.every((c) => A.FACT_SOURCES.includes(c.source)));
    ok('only claude-desktop is install-capable on win32', M.INSTALL_IDS.filter((id) => M.isInstallCapableOn(id, 'win32')).join() === 'claude-desktop');
    ok('…all three on darwin, none on linux', M.INSTALL_IDS.every((id) => M.isInstallCapableOn(id, 'darwin')) && M.INSTALL_IDS.every((id) => !M.isInstallCapableOn(id, 'linux')));

    // The process's REAL %LOCALAPPDATA% / %APPDATA% are never read under a test home.
    const decoy = path.join(TMP, 'decoy');
    const saved = { la: process.env.LOCALAPPDATA, ad: process.env.APPDATA };
    process.env.LOCALAPPDATA = path.join(decoy, 'Local');
    process.env.APPDATA = path.join(decoy, 'Roaming');
    const mw = memWorld();
    const r = M.winRoots(mw.home);
    eq('a test home derives %LOCALAPPDATA% from itself', r.localAppData, 'C:\\Users\\Tester Name\\AppData\\Local');
    eq('…and %APPDATA%', r.appData, 'C:\\Users\\Tester Name\\AppData\\Roaming');
    ok('…never from the process env (decoy ignored)', !JSON.stringify(r).includes('decoy'));
    process.env.CURATOR_TEST_INSTALL_LOCALAPPDATA = 'D:\\Elsewhere\\Local';
    eq('CURATOR_TEST_INSTALL_LOCALAPPDATA is honoured when named', M.winRoots(mw.home).localAppData, 'D:\\Elsewhere\\Local');
    delete process.env.CURATOR_TEST_INSTALL_LOCALAPPDATA;
    if (saved.la === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.la;
    if (saved.ad === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.ad;

    const cands = M.winCandidates(mw.home, r);
    ok('every resolved win32 candidate is under the fake home (mem)', cands.length >= 4 && cands.every((c) => M.isUnderHome(mw.home, c.file, 'win32')), cands.map((c) => c.file).join(' | '));
    eq('candidate 1 resolves with backslashes', cands.find((c) => c.n === 1).file, 'C:\\Users\\Tester Name\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json');
    eq('display uses %LOCALAPPDATA%', M.displayFor(mw.home, cands[0].file, 'win32', r), '%LOCALAPPDATA%\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json');
    eq('display uses %APPDATA% for the legacy file', M.displayFor(mw.home, cands.find((c) => c.n === 4).file, 'win32', r), '%APPDATA%\\Claude\\claude_desktop_config.json');
    const dw = diskWorld(); worlds.push(dw);
    const dc = M.winCandidates(dw.home, M.winRoots(dw.home));
    ok('every resolved win32 candidate is under the fake home (disk)', dc.length >= 4 && dc.every((c) => M.isUnderHome(dw.home, c.file, 'win32') && c.file.startsWith(TMP)));
    ok('the process cannot reach a real home: user data isolated, no fake home → no home', (() => { const h = process.env.CURATOR_TEST_INSTALL_HOME; delete process.env.CURATOR_TEST_INSTALL_HOME; const v = M.installHome(); process.env.CURATOR_TEST_INSTALL_HOME = h; return v === null; })());
  }

  section('§0b — containment on win32 is case-insensitive and Windows-shaped');
  {
    const H = 'C:\\Users\\Ana';
    ok('a lower-cased path under home is under home', M.isUnderHome(H, 'c:\\users\\ana\\AppData\\Local\\x.json', 'win32'));
    ok('forward slashes are the same path', M.isUnderHome(H, 'C:/Users/Ana/AppData/x.json', 'win32'));
    ok('a sibling profile with a shared prefix is NOT under home', !M.isUnderHome(H, 'C:\\Users\\Ana2\\x.json', 'win32'));
    ok('a UNC share (redirected AppData) is NOT under home', !M.isUnderHome(H, '\\\\server\\share\\Ana\\AppData\\Roaming\\Claude\\x.json', 'win32'));
    ok('another drive is NOT under home', !M.isUnderHome(H, 'D:\\Users\\Ana\\x.json', 'win32'));
    ok('a traversal out of home is NOT under home', !M.isUnderHome(H, 'C:\\Users\\Ana\\..\\Bob\\x.json', 'win32'));
    ok('home itself is not "under" home', !M.isUnderHome(H, 'C:\\Users\\ana', 'win32'));
    ok('a DRIVE-ROOT home contains nothing (refused)', !M.isUnderHome('C:\\', 'C:\\Users\\x.json', 'win32') && !M.isUnderHome('c:/', 'c:\\x.json', 'win32'));
    ok('…nor a share-root home', !M.isUnderHome('\\\\server\\share\\', '\\\\server\\share\\x.json', 'win32'));
    {
      const mw = memWorld();
      mw.home = 'C:\\';
      const roots = { localAppData: 'C:\\AppData\\Local', appData: 'C:\\AppData\\Roaming' };
      mw.put('C:\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json', '{}');
      const r = M.resolveWinClaude({ home: mw.home, roots, io: mw.io });
      ok('a live file under a drive-root home → manual outside_home', !r.decision.ok && r.decision.reason === 'outside_home');
      ok('…said as "outside your user folder", with no guess about why', /is outside your user folder, so/.test(r.decision.message) && !/redirect/i.test(r.decision.message));
    }
    ok('"unopenable" is said without naming macOS (it shows on Windows too)', !/macOS/.test(M.reasonText('unopenable')));
    ok('CONTROL: macOS containment stays case-SENSITIVE', !M.isUnderHome('/Users/ana', '/users/ana/x.json', 'darwin') && M.isUnderHome('/Users/ana', '/Users/ana/x.json', 'darwin'));
  }

  for (const make of [memWorld, diskWorld]) {
    const probe = make();
    worlds.push(probe);
    const K = probe.kind;
    section(`§1 [${K}] — which file`);
    {
      const w = make(); worlds.push(w);
      const L = layout(w);
      let r = decide(w);
      ok(`[${K}] nothing on disk → manual config_not_found`, !r.decision.ok && r.decision.reason === 'config_not_found');
      ok(`[${K}] …and the message names where it looked`, r.decision.message.includes('%LOCALAPPDATA%') || r.decision.message.includes('Claude-Data'));
      eq(`[${K}] …not installed`, r.installed, null);

      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }));
      r = decide(w);
      ok(`[${K}] one live file (#1) → it is the target`, r.decision.ok && r.decision.file === L.c[1] && r.decision.createAllowed === false);
      ok(`[${K}] …installed: its MSIX data folder is evidence of the app`, r.installed && r.installed.by === 'app' && r.msix === true);

      w.put(L.c[4], doc({ mcpServers: {} }));
      r = decide(w);
      ok(`[${K}] #1 AND #4 live → manual config_ambiguous`, !r.decision.ok && r.decision.reason === 'config_ambiguous');
      ok(`[${K}] …naming both`, r.decision.message.includes('Claude-Data') && r.decision.message.includes('%APPDATA%') || (r.decision.message.includes(L.c[1]) && r.decision.message.includes(L.c[4])), r.decision.message);
      ok(`[${K}] …and listing both as live candidates`, r.live.map((c) => c.n).sort().join() === '1,4');

      // A `.user-data-left.*` marker in #4's folder: that copy was left behind.
      w.put(w.P.join(w.P.dirname(L.c[4]), '.user-data-left.claude_pzs8sxrjxfjjc'), '');
      r = decide(w);
      ok(`[${K}] a .user-data-left.* marker in #4's folder → #4 is not live → #1 is the target`, r.decision.ok && r.decision.file === L.c[1]);
      ok(`[${K}] …the stale candidate says why`, r.candidates.find((c) => c.n === 4).stale === 'marker');

      // #3 (LocalCache) live with no marker → ambiguous again.
      w.put(L.c[3], doc({}));
      r = decide(w);
      ok(`[${K}] #1 + #3 live → ambiguous`, !r.decision.ok && r.decision.reason === 'config_ambiguous');
      w.put(w.P.join(w.P.dirname(L.c[3]), '.user-data-left.claude_pzs8sxrjxfjjc'), '');
      r = decide(w);
      ok(`[${K}] marker in #3's folder (the #378 layout) → #1 again`, r.decision.ok && r.decision.file === L.c[1]);

      // Claude-Data exists but cannot be listed (fix 5): nothing is decided.
      if (w.kind === 'mem') {
        w.unlistable = new Set([L.claudeData]);
        const u = decide(w);
        ok(`[${K}] Claude-Data cannot be listed → manual config_moving, never a write`, !u.decision.ok && u.decision.reason === 'config_moving' && /could not look inside/.test(u.decision.message));
        w.unlistable = null;
      }
      // A move in progress.
      w.mkdir(w.P.join(L.claudeData, '~copying.claude_pzs8sxrjxfjjc'));
      r = decide(w);
      ok(`[${K}] a ~copying.* folder in Claude-Data → manual config_moving`, !r.decision.ok && r.decision.reason === 'config_moving');
    }
    {
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[2], doc({ mcpServers: {} }));
      let r = decide(w);
      ok(`[${K}] ONLY #2 (Store, unverified) live → manual config_unverified, never a target`, !r.decision.ok && r.decision.reason === 'config_unverified');
      const items = plan(w, 'install');
      ok(`[${K}] …and the plan refuses it with that reason, nothing to write`, items.length === 1 && items[0].refused && items[0].refused.reason === 'config_unverified' && !items[0]._nextText);
      w.put(L.c[1], doc({}));
      r = decide(w);
      ok(`[${K}] #2 + #1 → ambiguous (an unverified file still counts as evidence)`, !r.decision.ok && r.decision.reason === 'config_ambiguous');
    }
    {
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[7], doc({}));
      let r = decide(w);
      ok(`[${K}] only a read-only extra (#7, Claude-3p) live → config_unverified`, !r.decision.ok && r.decision.reason === 'config_unverified');
      w.put(L.c[1], doc({}));
      r = decide(w);
      ok(`[${K}] #7 + #1 → ambiguous`, !r.decision.ok && r.decision.reason === 'config_ambiguous');
    }
    {
      // Legacy .exe: create only when it is confirmed.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.updater, 'exe');
      let r = decide(w);
      ok(`[${K}] updater present but Appx NOT checked → config_not_found (no create)`, !r.decision.ok && r.decision.reason === 'config_not_found' && r.msix === null);
      r = decide(w, { checked: true, families: [] });
      ok(`[${K}] updater + Appx checked and absent → create %APPDATA%\\Claude\\… allowed`, r.decision.ok && r.decision.file === L.c[4] && r.decision.createAllowed === true);
      r = decide(w, { checked: true, families: ['Claude_pzs8sxrjxfjjc'] });
      ok(`[${K}] updater + an MSIX package → no create`, !r.decision.ok && r.decision.reason === 'config_not_found');
      w.mkdir(L.pkg);
      r = decide(w, { checked: true, families: [] });
      ok(`[${K}] updater + an MSIX package FOLDER → no create`, !r.decision.ok);
    }
    {
      // A lone %APPDATA%\Claude file.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[4], doc({ mcpServers: {} }));
      let r = decide(w, { checked: true, families: [] });
      ok(`[${K}] lone #4, Appx checked and absent, no MSIX folders → #4 is the target`, r.decision.ok && r.decision.file === L.c[4]);
      r = decide(w);
      ok(`[${K}] lone #4, Appx NOT checked → manual config_unconfirmed`, !r.decision.ok && r.decision.reason === 'config_unconfirmed');
      w.mkdir(L.pkg);
      r = decide(w, { checked: true, families: [] });
      ok(`[${K}] lone #4 beside an MSIX package folder → config_unconfirmed`, !r.decision.ok && r.decision.reason === 'config_unconfirmed');
    }
    {
      // Redirected AppData (a network share) — outside the user folder.
      const w = make(); worlds.push(w);
      const outside = w.kind === 'mem' ? '\\\\server\\profiles\\Tester\\AppData\\Roaming' : path.join(TMP, `redirected-${K}`, 'Roaming');
      process.env.CURATOR_TEST_INSTALL_APPDATA = outside;
      const L = layout(w);
      w.put(L.c[4], doc({}));
      const r = decide(w, { checked: true, families: [] });
      ok(`[${K}] the only live file is outside the user folder → manual outside_home`, !r.decision.ok && r.decision.reason === 'outside_home', JSON.stringify(r.decision));
      delete process.env.CURATOR_TEST_INSTALL_APPDATA;
    }

    section(`§2 [${K}] — the write`);
    {
      const w = make(); worlds.push(w);
      const L = layout(w);
      const ORIG = doc({ preferences: { x: 1 }, mcpServers: { other: OTHER } }, '\r\n', true);
      w.put(L.c[1], ORIG);
      const before = w.read(L.c[1]);
      let items = plan(w, 'install');
      const it = items[0];
      ok(`[${K}] plan: add into #1, other servers named, values not echoed`, items.length === 1 && it.action === 'add' && it.preserved.join() === 'other' && !JSON.stringify(M.publicItem(it)).includes('sk-PLANTED'));
      eq(`[${K}] plan display`, it.display, localDisp(w, ...CD1));
      ok(`[${K}] the entry is command = node.exe + args, NO env (repo mode needs none)`, JSON.stringify(JSON.parse(it.entryText)) === JSON.stringify({ command: REPO_WIN.command, args: REPO_WIN.args }));
      const res = run(w, it);
      eq(`[${K}] apply → written`, res.outcome, 'written');
      const after = w.read(L.c[1]);
      const text = after.toString('utf8');
      ok(`[${K}] the BOM is kept`, M.hasUtf8Bom(after));
      ok(`[${K}] every line ends CRLF (no bare LF)`, /\r\n$/.test(text) && !/[^\r]\n/.test(text));
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      ok(`[${K}] the other server and the app's preferences are unchanged`, JSON.stringify(parsed.mcpServers.other) === JSON.stringify(OTHER) && parsed.preferences.x === 1);
      ok(`[${K}] backslashes and spaces round-trip through JSON`, parsed.mcpServers['my-curator'].command === REPO_WIN.command && parsed.mcpServers['my-curator'].args[0] === REPO_WIN.args[0] && text.includes('C:\\\\Program Files\\\\nodejs\\\\node.exe'));
      ok(`[${K}] the backup holds the ORIGINAL bytes (BOM and CRLF)`, (() => { const b = w.list(w.P.dirname(L.c[1])).find((n) => n.includes('.curator-backup-')); return b && Buffer.compare(w.read(w.P.join(w.P.dirname(L.c[1]), b)), before) === 0; })());
      ok(`[${K}] no temp file left behind`, !w.list(w.P.dirname(L.c[1])).some((n) => n.startsWith('.tmp-')));
      eq(`[${K}] the POSIX writeAtomic path was never used on win32`, w.posixWrites, 0);
      const again = plan(w, 'install');
      ok(`[${K}] a second install plans nothing (idempotent)`, again.length === 1 && again[0].action === 'none' && run(w, again[0]).outcome === 'unchanged');
      items = plan(w, 'remove');
      eq(`[${K}] remove → written`, run(w, items[0]).outcome, 'written');
      ok(`[${K}] install → remove gives back the ORIGINAL bytes exactly (BOM + CRLF)`, Buffer.compare(w.read(L.c[1]), before) === 0);
      ok(`[${K}] the manifest recorded both writes`, M.readManifest(w.io).rows.filter((r) => r.file === L.c[1]).map((r) => r.action).join() === 'install,remove');
    }
    {
      // Fix 1 (audit): Claude Desktop RUNNING on Windows → every write refused.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({ mcpServers: { other: OTHER, 'my-curator': { command: 'old' } } }));
      for (const action of ['install', 'remove']) {
        const its = plan(w, action, { running: { checked: true, running: true } });
        ok(`[${K}] ${action} while Claude Desktop runs → refused app_running, in words`, its.length === 1 && its[0].refused && its[0].refused.reason === 'app_running'
          && its[0].refused.message === 'Quit Claude Desktop fully (system tray → Quit), then press Install for me' && its[0]._nextText === undefined);
        ok(`[${K}] …and the executor writes nothing for it`, run(w, its[0]).reason === 'app_running');
      }
      ok(`[${K}] a running probe that could NOT look (checked:false) does not block`, plan(w, 'install', { running: { checked: false, running: false } })[0].action === 'update');
      ok(`[${K}] not running → planned as usual`, plan(w, 'install', { running: { checked: true, running: false } })[0].action === 'update');
    }
    {
      // Fix 3b (audit): a target that became UNREADABLE reports its own reason.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }));
      let it = plan(w, 'install')[0];
      w.put(L.c[1], '{ "mcpServers": ');
      let r = run(w, it);
      ok(`[${K}] corrupted between plan and apply → refused "corrupt", not config_changed`, r.outcome === 'refused' && r.reason === 'corrupt' && /not valid JSON/.test(r.message), JSON.stringify(r));
      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }));
      it = plan(w, 'install')[0];
      let first = true;
      w.renameHook = (a, b) => { if (b === L.c[1] && first) { first = false; w.put(L.c[1], 'not json'); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
      r = run(w, it);
      w.renameHook = null;
      ok(`[${K}] corrupted during a lock wait → refused "corrupt" on the retry`, r.outcome === 'refused' && r.reason === 'corrupt', JSON.stringify(r));
      ok(`[${K}] …temp file removed, the corrupt bytes left alone`, !w.list(w.P.dirname(L.c[1])).some((n) => n.startsWith('.tmp-')) && w.read(L.c[1]).toString() === 'not json');
      ok(`[${K}] CONTROL: a READABLE change is still config_changed`, (() => { w.put(L.c[1], doc({})); const i2 = plan(w, 'install')[0]; w.put(L.c[1], doc({ a: 1 })); return run(w, i2).reason === 'config_changed'; })());
    }
    {
      // Read-only target: refused at plan time …
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }), 0o444);
      const b0 = w.read(L.c[1]);
      const items = plan(w, 'install');
      ok(`[${K}] a read-only file → plan refused read_only`, items[0].refused && items[0].refused.reason === 'read_only');
      ok(`[${K}] …unchanged`, Buffer.compare(w.read(L.c[1]), b0) === 0);
      // … and when it turns read-only after the plan.
      w.setMode(L.c[1], 0o666);
      const p2 = plan(w, 'install');
      w.setMode(L.c[1], 0o444);
      const r = run(w, p2[0]);
      ok(`[${K}] turned read-only after the plan → refused read_only, nothing written`, r.outcome === 'refused' && r.reason === 'read_only' && Buffer.compare(w.read(L.c[1]), b0) === 0);
      ok(`[${K}] …and no backup taken`, !w.list(w.P.dirname(L.c[1])).some((n) => n.includes('.curator-backup-')));
      w.setMode(L.c[1], 0o666);
    }
    {
      // The rename is retried on lock errors, then succeeds.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }));
      const it = plan(w, 'install')[0];
      let fails = 2;
      w.renameHook = (a, b) => { if (b === L.c[1] && fails-- > 0) throw Object.assign(new Error('busy'), { code: fails === 1 ? 'EBUSY' : 'EPERM' }); };
      const r = run(w, it);
      w.renameHook = null;
      ok(`[${K}] EBUSY then EPERM, then free → written`, r.outcome === 'written', JSON.stringify(r));
      eq(`[${K}] …after waiting the first two backoff steps`, w.sleeps.join(), `${M.WIN_RENAME_BACKOFF_MS[0]},${M.WIN_RENAME_BACKOFF_MS[1]}`);
      ok(`[${K}] …and the entry is there`, !!JSON.parse(w.read(L.c[1]).toString('utf8')).mcpServers['my-curator']);
    }
    {
      // Locked for good → file_locked, temp file removed, original intact.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }));
      const b0 = w.read(L.c[1]);
      const it = plan(w, 'install')[0];
      w.renameHook = (a, b) => { if (b === L.c[1]) throw Object.assign(new Error('locked'), { code: 'EACCES' }); };
      const r = run(w, it);
      w.renameHook = null;
      ok(`[${K}] locked for good → refused file_locked`, r.outcome === 'refused' && r.reason === 'file_locked' && /quit Claude Desktop/i.test(r.message));
      ok(`[${K}] …the message says a leftover .tmp-… file may remain and is safe to delete`, /\.tmp-/.test(r.message) && /safe to delete/.test(r.message));
      eq(`[${K}] …after ${M.WIN_RENAME_BACKOFF_MS.length + 1} attempts`, w.renames, M.WIN_RENAME_BACKOFF_MS.length + 1);
      ok(`[${K}] …waiting at most ~3 s in all`, sum(w.sleeps) <= 3000 && sum(w.sleeps) === sum(M.WIN_RENAME_BACKOFF_MS));
      ok(`[${K}] …original byte-identical, temp file removed`, Buffer.compare(w.read(L.c[1]), b0) === 0 && !w.list(w.P.dirname(L.c[1])).some((n) => n.startsWith('.tmp-')));
    }
    {
      // THE CAS IS RE-CHECKED BEFORE EVERY RETRY: Claude Desktop rewrites its
      // file while our rename is blocked → the retry must NOT clobber it.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }));
      const it = plan(w, 'install')[0];
      const APP = doc({ preferences: { rewrittenByTheApp: true } });
      let first = true;
      w.renameHook = (a, b) => {
        if (b === L.c[1] && first) { first = false; w.put(L.c[1], APP); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
      };
      const r = run(w, it);
      w.renameHook = null;
      ok(`[${K}] the file changed during a lock wait → refused config_changed on the retry`, r.outcome === 'refused' && r.reason === 'config_changed', JSON.stringify(r));
      eq(`[${K}] …the app's own rewrite survives byte-exact`, w.read(L.c[1]).toString('utf8'), APP);
      eq(`[${K}] …exactly one rename was attempted`, w.renames, 1);
      ok(`[${K}] …temp file removed`, !w.list(w.P.dirname(L.c[1])).some((n) => n.startsWith('.tmp-')));
    }
    {
      // A non-lock error is not retried.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.c[1], doc({}));
      const it = plan(w, 'install')[0];
      w.renameHook = () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); };
      const r = run(w, it);
      w.renameHook = null;
      ok(`[${K}] ENOSPC → write_failed at once, no wait`, r.outcome === 'refused' && r.reason === 'write_failed' && w.sleeps.length === 0 && w.renames === 1);
    }
    {
      // Legacy create, and a change between plan and apply.
      const w = make(); worlds.push(w);
      const L = layout(w);
      w.put(L.updater, 'exe');
      const items = plan(w, 'install', { appx: { checked: true, families: [] } });
      ok(`[${K}] legacy confirmed → plan creates %APPDATA%\\Claude\\…`, items[0].action === 'add' && items[0].file === L.c[4] && items[0].basis === 'absent');
      const r = run(w, items[0]);
      ok(`[${K}] …created, parsed back with our entry only`, r.outcome === 'created' && Object.keys(JSON.parse(w.read(L.c[4]).toString('utf8')).mcpServers).join() === 'my-curator');
      const p2 = plan(w, 'remove', { appx: { checked: true, families: [] } });
      w.put(L.c[4], doc({ mcpServers: { 'my-curator': { command: 'x' }, other: OTHER } }));
      const r2 = run(w, p2[0]);
      ok(`[${K}] edited between plan and apply → config_changed`, r2.outcome === 'refused' && r2.reason === 'config_changed');
    }
    {
      // Other tools on Windows.
      const w = make(); worlds.push(w);
      for (const id of ['cursor', 'antigravity']) {
        const items = M.planTool(id, 'install', { ...ctxFor(w), detected: true });
        ok(`[${K}] ${id} on win32 → refused platform_unsupported, no file`, items.length === 1 && items[0].refused.reason === 'platform_unsupported' && items[0].file === null);
        eq(`[${K}] …targetsFor(${id}) is empty on win32`, M.targetsFor(id, w.home, w.io, { platform: 'win32' }).length, 0);
      }
    }
  }

  section('§3 — detection probes');
  {
    const yes = [
      'C:\\Program Files\\WindowsApps\\Claude_1.3.4.0_x64__pzs8sxrjxfjjc\\app\\claude.exe',
      'D:\\WindowsApps\\AnthropicPBC.Claude_3.1623.0.0_arm64__fnn82j28hfe8t\\app\\Claude.exe',
      'C:\\Users\\Ana\\AppData\\Local\\AnthropicClaude\\app-0.9.3\\claude.exe',
    ];
    const no = [
      'C:\\Users\\Ana\\.local\\bin\\claude.exe',
      'C:\\Users\\Ana\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode\\claude.exe',
      'C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\claude.exe',
      'C:\\Users\\Ana\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude-code\\2.1\\claude.exe',
      'C:\\Users\\Ana\\AppData\\Local\\Microsoft\\WindowsApps\\Claude.exe',
      '',
    ];
    ok('Claude Desktop\'s three install locations match', yes.every(D.isClaudeDesktopExe));
    ok('the CLI, WinGet, npm, the bundled Code binary and the alias do NOT', no.every((p) => !D.isClaudeDesktopExe(p)), no.filter(D.isClaudeDesktopExe).join());
    const lines = (ps) => ps.map((p) => `P|${p}`).join('\r\n');
    let r = await D.detectWinClaudeRunning({ runWinProcs: async () => lines([no[0], yes[0]]) });
    ok('running when the app\'s exe is among the claude.exe processes', r.checked && r.running);
    r = await D.detectWinClaudeRunning({ runWinProcs: async () => lines([no[0], no[1]]) });
    ok('only the CLI running → checked, not running', r.checked && !r.running);
    r = await D.detectWinClaudeRunning({ runWinProcs: async () => lines([no[0], '']) });
    ok('a claude.exe whose path could not be read → checked:false (never "not running")', r.checked === false);
    r = await D.detectWinClaudeRunning({ runWinProcs: async () => '' });
    ok('no claude.exe at all → checked, not running', r.checked && !r.running);
    r = await D.detectWinClaudeRunning({ runWinProcs: async () => { throw new Error('timeout'); } });
    ok('a failed probe → checked:false', r.checked === false);
    let a = await D.detectWinAppx(FAMS, { runAppx: async () => 'claude_PZS8SXRJXFJJC\r\nSomething.Else_123\r\n' });
    ok('Appx families matched exactly, case-insensitive, canonical spelling back', a.checked && a.families.join() === 'Claude_pzs8sxrjxfjjc');
    a = await D.detectWinAppx(FAMS, { runAppx: async () => 'Claude_pzs8sxrjxfjjcX\r\n' });
    ok('…a near-miss family is not a match', a.checked && a.families.length === 0);
    a = await D.detectWinAppx(FAMS, { runAppx: async () => { throw new Error('no powershell'); } });
    ok('a failed Appx probe → checked:false', a.checked === false);

    // No real probe under CURATOR_TEST_INSTALL_HOME — whatever is injected.
    const spawned = [];
    D.__setSpawnObserver((cmd) => spawned.push(cmd));
    ok('CURATOR_TEST_INSTALL_HOME is set for this suite', !!process.env.CURATOR_TEST_INSTALL_HOME && D.probesDisabled());
    const res = await Promise.all([D.detectWinAppx(FAMS), D.detectWinClaudeRunning(), D.detectRunning(), D.detectClis(['claude'])]);
    ok('default PowerShell / ps / login-shell runners all report checked:false under a test home', res.every((x) => x.checked === false));
    eq('…and NOT ONE process was spawned', spawned.length, 0);
    if (!IS_WIN) {
      // CONTROL (POSIX hosts only: no powershell.exe exists, so the spawn fails
      // at once and nothing on the machine is touched): the observer DOES see a
      // spawn when the guard is off — so "0 spawned" above means something.
      const h = process.env.CURATOR_TEST_INSTALL_HOME;
      delete process.env.CURATOR_TEST_INSTALL_HOME;
      const c = await D.detectWinAppx(FAMS);
      process.env.CURATOR_TEST_INSTALL_HOME = h;
      ok('CONTROL: with the guard off the observer sees the spawn — by ABSOLUTE path, never bare `powershell.exe`', spawned.join() === D.powershellPath() && typeof c.checked === 'boolean', spawned.join());
    }
    D.__setSpawnObserver(null);

    // Fix 2 (audit): PowerShell by absolute path.
    const savedRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'D:\\Win';
    eq('powershellPath() follows %SystemRoot%', D.powershellPath(), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    process.env.SystemRoot = 'relative\\Windows';
    eq('…a non-absolute %SystemRoot% falls back to C:\\Windows', D.powershellPath(), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    delete process.env.SystemRoot;
    ok('…and with none it is still an absolute Windows path', path.win32.isAbsolute(D.powershellPath()) && D.powershellPath() !== 'powershell.exe');
    if (savedRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = savedRoot;
  }

  section('§4 — the routes, in-process, on win32');
  for (const make of [memWorld, diskWorld]) {
    const w = make(); worlds.push(w);
    const K = w.kind;
    const L = layout(w);
    M.__setHomeOverride(w.home);
    M.__setPlatformOverride('win32');
    R.__setInstallIO(w.io);
    let procs = '';
    let appxOut = '';
    R.__setDetectDeps({
      appsDirs: [], runShell: async () => { throw new Error('none'); }, runPs: async () => { throw new Error('none'); },
      runAppx: async () => appxOut, runWinProcs: async () => procs,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/mcp/install', R.default);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const PORT = server.address().port;
    const call = async (method, url, body, origin = `http://127.0.0.1:${PORT}`) => {
      const headers = { 'content-type': 'application/json' };
      if (origin) headers.Origin = origin;
      const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let json = null; try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, body: json || {} };
    };
    const cdOf = (s) => s.body.tools.find((t) => t.id === 'claude-desktop');
    try {
      let s = await call('GET', '/api/mcp/install/status', undefined, null);
      ok(`[${K}] status: nothing on disk → Claude Desktop in notFound`, s.status === 200 && s.body.platform === 'win32' && s.body.notFound.some((n) => n.id === 'claude-desktop'));
      appxOut = 'Claude_pzs8sxrjxfjjc\r\n';
      s = await call('GET', '/api/mcp/install/status');
      let pre = cdOf(s);
      ok(`[${K}] an MSIX package that was never opened → shown, manual config_not_found ("Open Claude Desktop once")`, pre && pre.status === 'manual' && pre.reason.code === 'config_not_found' && /Open Claude Desktop once/.test(pre.reason.message) && pre.detected.by === 'app');
      ok(`[${K}] …with every writable candidate named, and Copy still offered`, pre.candidates.filter((c) => c.write).length === 3 && typeof s.body.manualSnippets['claude-desktop'] === 'string');
      appxOut = '';
      w.mkdir(L.pkg);
      s = await call('GET', '/api/mcp/install/status');
      pre = cdOf(s);
      ok(`[${K}] the MSIX package FOLDER alone also counts as installed`, pre && pre.reason.code === 'config_not_found' && pre.detected.by === 'app');

      w.put(L.c[1], doc({ mcpServers: { other: OTHER } }, '\r\n', true));
      const b0 = w.read(L.c[1]);
      procs = 'P|C:\\Program Files\\WindowsApps\\Claude_1.3.4.0_x64__pzs8sxrjxfjjc\\app\\claude.exe\r\n';
      s = await call('GET', '/api/mcp/install/status');
      let cd = cdOf(s);
      ok(`[${K}] status: writable on win32`, s.body.writable === true);
      ok(`[${K}] Claude Desktop row: not-installed, installer file, detected`, cd && cd.status === 'not-installed' && cd.installer === 'file' && cd.detected.by === 'app', JSON.stringify(cd && { status: cd.status, reason: cd.reason }));
      ok(`[${K}] …one file: the live candidate, displayed as %LOCALAPPDATA%\\…`, cd.files.length === 1 && cd.files[0].file === L.c[1] && cd.files[0].display === localDisp(w, ...CD1));
      ok(`[${K}] …candidates listed with exists/live/write`, Array.isArray(cd.candidates) && cd.candidates.find((c) => c.n === 1).live === true && cd.candidates.find((c) => c.n === 2).write === false);
      ok(`[${K}] …running, by the MSIX executable path`, cd.running.checked && cd.running.running);
      ok(`[${K}] …the Windows restart line`, /system tray → Quit/.test(cd.restartHint) && /Check again/.test(cd.restartHint));
      ok(`[${K}] no other server's value leaves the status`, !JSON.stringify(s.body).includes('sk-PLANTED'));
      ok(`[${K}] status wrote nothing`, Buffer.compare(w.read(L.c[1]), b0) === 0);

      const blocked = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['claude-desktop'] });
      ok(`[${K}] Claude Desktop RUNNING → plan refuses app_running in words`, blocked.status === 200 && blocked.body.items[0].refused && blocked.body.items[0].refused.reason === 'app_running' && /system tray → Quit/.test(blocked.body.items[0].refused.message));
      const ba = await call('POST', '/api/mcp/install/apply', { token: blocked.body.token });
      ok(`[${K}] …apply writes nothing`, ba.body.results[0].outcome === 'refused' && ba.body.results[0].reason === 'app_running' && Buffer.compare(w.read(L.c[1]), b0) === 0);
      procs = '';
      const late = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['claude-desktop'] });
      procs = 'P|C:\\Program Files\\WindowsApps\\Claude_1.3.4.0_x64__pzs8sxrjxfjjc\\app\\claude.exe\r\n';
      const la = await call('POST', '/api/mcp/install/apply', { token: late.body.token });
      ok(`[${K}] Claude Desktop started between plan and apply → app_running (not plan_changed), nothing written`, la.body.results[0].reason === 'app_running' && Buffer.compare(w.read(L.c[1]), b0) === 0, JSON.stringify(la.body.results[0]));
      procs = '';
      const p = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['claude-desktop', 'cursor'] });
      eq(`[${K}] plan 200 on win32`, p.status, 200);
      const ci = p.body.items.find((i) => i.id === 'claude-desktop');
      const cu = p.body.items.find((i) => i.id === 'cursor');
      ok(`[${K}] claude-desktop item: add, %LOCALAPPDATA% display, basis`, ci && ci.action === 'add' && ci.file.startsWith(localDisp(w, '')) && /^[0-9a-f]{64}$/.test(ci.basis));
      ok(`[${K}] cursor item refused platform_unsupported`, cu && cu.refused && cu.refused.reason === 'platform_unsupported');
      const ap = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
      const rc = ap.body.results.find((x) => x.id === 'claude-desktop');
      ok(`[${K}] apply: written, original kept, the Windows restart line`, rc && rc.outcome === 'written' && /original kept/.test(rc.message) && /system tray/.test(rc.restart), JSON.stringify(rc));
      ok(`[${K}] …the backup display is %LOCALAPPDATA%\\…`, typeof rc.backup === 'string' && rc.backup.startsWith(localDisp(w, '')));
      s = await call('GET', '/api/mcp/install/status');
      cd = cdOf(s);
      eq(`[${K}] Check again → connected`, cd.status, 'connected');
      ok(`[${K}] …restorable`, cd.restorable === true);

      const pr = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['claude-desktop'] });
      const ar = await call('POST', '/api/mcp/install/apply', { token: pr.body.token });
      ok(`[${K}] remove → written`, ar.body.results[0].outcome === 'written');
      ok(`[${K}] …file back to its original bytes (BOM + CRLF)`, Buffer.compare(w.read(L.c[1]), b0) === 0);

      // A second live file appears → manual, candidates named, nothing written.
      w.put(L.c[4], doc({ mcpServers: {} }));
      const b4 = w.read(L.c[4]);
      s = await call('GET', '/api/mcp/install/status');
      cd = cdOf(s);
      ok(`[${K}] two live files → manual config_ambiguous, no files, both candidates live`, cd.status === 'manual' && cd.reason.code === 'config_ambiguous' && cd.files.length === 0 && cd.candidates.filter((c) => c.live).length === 2);
      const pa = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['claude-desktop'] });
      ok(`[${K}] …plan refuses with the same reason`, pa.body.items[0].refused && pa.body.items[0].refused.reason === 'config_ambiguous');
      const aa = await call('POST', '/api/mcp/install/apply', { token: pa.body.token });
      ok(`[${K}] …apply writes nothing`, aa.body.results[0].outcome === 'refused' && Buffer.compare(w.read(L.c[1]), b0) === 0 && Buffer.compare(w.read(L.c[4]), b4) === 0);

      // Fix 4 (audit): AppData unknown → a ROW with its reason, never notFound.
      process.env.CURATOR_TEST_INSTALL_LOCALAPPDATA = 'not\\absolute';
      s = await call('GET', '/api/mcp/install/status');
      cd = cdOf(s);
      ok(`[${K}] AppData folders unknown → Claude Desktop is a manual ROW (appdata_unknown), not in notFound`, cd && cd.status === 'manual' && cd.reason.code === 'appdata_unknown' && !s.body.notFound.some((n) => n.id === 'claude-desktop'));
      delete process.env.CURATOR_TEST_INSTALL_LOCALAPPDATA;

      M.__setPlatformOverride('linux');
      const lin = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['claude-desktop'] });
      ok(`[${K}] CONTROL: linux is still 409 platform_unsupported`, lin.status === 409 && lin.body.reason === 'platform_unsupported');
      const miss = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['claude-desktop'] }, null);
      ok(`[${K}] the Origin gate still applies (missing → 403)`, miss.status === 403);
    } finally {
      server.close();
      M.__setPlatformOverride(null);
      M.__setHomeOverride(null);
      R.__setInstallIO(null);
      R.__setDetectDeps(null);
    }
  }

  if (!IS_WIN) {
    section('§5 — macOS: a BOM + CRLF file round-trips byte-exact too');
    const w = diskWorld(); worlds.push(w);
    const CD = path.join(w.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const ORIG = doc({ mcpServers: { other: OTHER } }, '\r\n', true);
    w.put(CD, ORIG, 0o644);
    const b0 = w.read(CD);
    const REPO = { command: '/usr/local/bin/node', args: ['/app/mcp/server.js', '--domains-path', DOM] };
    const base = { home: w.home, launch: REPO, launcherState: { required: false, present: true }, detected: true, io: w.io, platform: 'darwin' };
    const st0 = M.readTarget(CD, 'mcpServers', w.io);
    ok('a BOM file is READ (it used to be "not valid JSON")', st0.state === 'ok' && st0.fmt.bom === true);
    const it = M.planTool('claude-desktop', 'install', { ...base, manifestRows: M.readManifest(w.io).rows })[0];
    eq('darwin install → written', M.executeItem(it, { home: w.home, io: w.io, platform: 'darwin' }).outcome, 'written');
    const t = w.read(CD);
    ok('…BOM kept, CRLF kept', M.hasUtf8Bom(t) && !/[^\r]\n/.test(t.toString('utf8')));
    eq('…via the macOS writeAtomic path (unchanged), not the Windows replace', w.posixWrites, 1);
    const rm = M.planTool('claude-desktop', 'remove', { ...base, manifestRows: M.readManifest(w.io).rows })[0];
    M.executeItem(rm, { home: w.home, io: w.io, platform: 'darwin' });
    ok('install → remove on macOS gives back the original bytes', Buffer.compare(w.read(CD), b0) === 0);
  }
} finally {
  for (const w of worlds) w.cleanup();
  if (SAVED_ENV.HOME === undefined) delete process.env.HOME; else process.env.HOME = SAVED_ENV.HOME;
  if (SAVED_ENV.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = SAVED_ENV.USERPROFILE;
  const changed = changedSince(REAL_BEFORE);
  ok('the REAL config files were not written by this suite', changed.length === 0, changed.join(', '));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
