#!/usr/bin/env node
// test-windows-installer-static.js — offline, static checks of the Windows
// one-line installer (install.ps1) and the two desktop-icon scripts.
//
// The real proof is the "Windows one-line install" CI job (it installs,
// starts, stops and repairs on windows-latest). This suite catches, on any
// OS and in `npm test`, the mistakes that job would only find after a push:
//   - a pinned download whose hash is not 64 hex characters, or a version
//     that does not match the URL it is built into;
//   - a plain-http URL;
//   - a bare `npm` call (npm.ps1 trips the execution policy; npm.cmd goes
//     through cmd.exe), or an `exit` in install.ps1 (under `irm | iex` it
//     would close the user's PowerShell window);
//   - non-ASCII text (Windows PowerShell 5.1 reads BOM-less scripts in the
//     ANSI code page) and PowerShell-7-only syntax (`??`, `?.`, -Parallel);
//   - the icon and script names the shortcuts and the docs depend on;
//   - the CI job losing its place in the release gate.
// Each check is a behavioural fact about what a user's PC would run, not the
// presence of a comment.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

const FILES = ['install.ps1', 'scripts/windows/start-curator.ps1', 'scripts/windows/stop-curator.ps1', 'scripts/windows/curator-common.ps1'];
const src = {};
for (const f of FILES) {
  const p = path.join(ROOT, f);
  check(existsSync(p), `${f} exists`);
  src[f] = existsSync(p) ? readFileSync(p) : Buffer.alloc(0);
}
const text = (f) => src[f].toString('utf8');

// Strip comments and string literals well enough to look at CODE only.
// Handles '...' (with ''), "..." (with backtick escapes), here-strings,
// # line comments and <# #> block comments.
function codeOnly(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<' && s[i + 1] === '#') { const j = s.indexOf('#>', i + 2); i = j < 0 ? s.length : j + 2; continue; }
    if (c === '#') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue; }
    if (c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && s[i + 2] === '\n') {
      const end = '\n' + s[i + 1] + '@';
      const j = s.indexOf(end, i + 3); out += ' S '; i = j < 0 ? s.length : j + 3; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += ' S '; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { if (s[j] === '`') j++; j++; }
      out += ' S '; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

// 1. Encoding and syntax that Windows PowerShell 5.1 cannot run.
for (const f of FILES) {
  const buf = src[f];
  const nonAscii = [...buf].some((b) => b > 127);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  check(!nonAscii || bom, `${f}: ASCII only (or UTF-8 with a BOM)`);
  const code = codeOnly(text(f));
  check(!/\?\?/.test(code), `${f}: no ?? (PowerShell 7 only)`);
  check(!/\?\.[A-Za-z]/.test(code), `${f}: no ?. (PowerShell 7 only)`);
  check(!/-Parallel\b/i.test(code), `${f}: no -Parallel (PowerShell 7 only)`);
  check(!/\bJoin-Path\b[^\n|;]*-AdditionalChildPath/i.test(code), `${f}: no Join-Path -AdditionalChildPath`);
  // Balanced brackets in code (a cheap stand-in for the parser CI runs).
  const counts = { '(': 0, '{': 0, '[': 0 };
  const pairs = { ')': '(', '}': '{', ']': '[' };
  let negative = false;
  for (const ch of code) {
    if (counts[ch] !== undefined) counts[ch]++;
    else if (pairs[ch]) { counts[pairs[ch]]--; if (counts[pairs[ch]] < 0) negative = true; }
  }
  check(!negative && counts['('] === 0 && counts['{'] === 0 && counts['['] === 0,
    `${f}: brackets balance outside strings and comments (${JSON.stringify(counts)})`);
}

// 2. install.ps1 under `irm | iex`.
const install = text('install.ps1');
const installCode = codeOnly(install);
check(!/\bexit\b/i.test(installCode), 'install.ps1: never calls exit (it would close the user\'s window under iex)');
check(/^param\(/m.test(install), 'install.ps1: has a top-level param() block (-Branch, -NoStart, -InstallDir)');
for (const p of ['Branch', 'NoStart', 'InstallDir', 'RepoUrl']) check(new RegExp(`\\$${p}\\b`).test(install), `install.ps1: parameter -${p}`);
check(/\[string\]\$Branch = 'main'/.test(install), "install.ps1: -Branch defaults to 'main'");
check(/\$global:LASTEXITCODE = 1/.test(install) && /\$global:LASTEXITCODE = 0/.test(install), 'install.ps1: reports success and failure through $LASTEXITCODE');

// 3. Pinned downloads.
const pin = (name) => { const m = install.match(new RegExp(`\\$${name} = '([^']*)'`)); return m ? m[1] : null; };
const hex64 = /^[0-9a-f]{64}$/;
for (const n of ['NodeSha256X64', 'NodeSha256Arm64', 'MinGitSha256X64', 'MinGitSha256Arm64']) {
  check(hex64.test(pin(n) || ''), `install.ps1: $${n} is a 64-hex SHA-256`);
}
check(new Set(['NodeSha256X64', 'NodeSha256Arm64', 'MinGitSha256X64', 'MinGitSha256Arm64'].map(pin)).size === 4, 'install.ps1: the four hashes are distinct');
const nodeVersion = pin('NodeVersion');
check(/^\d+\.\d+\.\d+$/.test(nodeVersion || ''), 'install.ps1: $NodeVersion is a plain x.y.z');
check(Number((nodeVersion || '0').split('.')[0]) % 2 === 0, 'install.ps1: the pinned Node major is even (an LTS line)');
const mgTag = pin('MinGitTag');
const mgVer = pin('MinGitVersion');
const tm = (mgTag || '').match(/^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/);
check(!!tm, 'install.ps1: $MinGitTag looks like vX.Y.Z.windows.N');
check(!!tm && mgVer === `${tm[1]}.${tm[2]}`, 'install.ps1: $MinGitVersion matches $MinGitTag (asset names are built from it)');
check(install.includes('"https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-"'), 'install.ps1: the Node URL is built from $NodeVersion on nodejs.org/dist');
check(install.includes('"https://github.com/git-for-windows/git/releases/download/$MinGitTag/$gitAsset"'), 'install.ps1: the MinGit URL is built from $MinGitTag');
check(install.includes('"MinGit-$MinGitVersion-64-bit.zip"') && install.includes('"MinGit-$MinGitVersion-arm64.zip"'), 'install.ps1: MinGit x64 and arm64 asset names');
check(/Get-FileHash[^\n]*-Algorithm SHA256/.test(install) && /\$h -ne \$Sha256/.test(install), 'install.ps1: every download is hash-checked before use');

// 4. URLs: https only (loopback http in the icon scripts is the app itself).
for (const f of FILES) {
  const urls = text(f).match(/https?:\/\/[^\s'"`)]+/g) || [];
  const bad = urls.filter((u) => u.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u));
  check(bad.length === 0, `${f}: no plain-http URL${bad.length ? ' (' + bad.join(', ') + ')' : ''}`);
}

// 5. No bare npm, no bare node/git: always the private runtime by absolute path.
for (const f of FILES) {
  const code = codeOnly(text(f));
  check(!/(^|[\s;&(|])(npm|npm\.cmd|npx)(\s|$)/m.test(code), `${f}: never runs a bare npm / npx`);
  check(!/(^|[\s;&(|])&\s*(node|git)(\.exe)?\s/m.test(code), `${f}: never runs a bare node / git`);
}
check(install.includes("'node_modules\\npm\\bin\\npm-cli.js'"), 'install.ps1: npm runs as <private node> npm-cli.js');

// 6. Names the shortcuts, the docs and the icons agent depend on.
check(install.includes("'The Curator.lnk'") && install.includes("'Stop The Curator.lnk'"), 'install.ps1: shortcut names');
check(install.includes("'scripts\\windows\\assets\\curator-start.ico'") && install.includes("'scripts\\windows\\assets\\curator-stop.ico'"), 'install.ps1: icon paths');
check(install.includes("'System32\\WindowsPowerShell\\v1.0\\powershell.exe'"), 'install.ps1: shortcuts target Windows PowerShell by absolute path');
check(install.includes("'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"'"), 'install.ps1: shortcut arguments');
check(/GetFolderPath\('Desktop'\)/.test(install) && /GetFolderPath\('Programs'\)/.test(install), 'install.ps1: Desktop (OneDrive-aware) and Start menu folders');
const oneLiner = 'irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 | iex';
check(install.includes(oneLiner) && text('scripts/windows/curator-common.ps1').includes(oneLiner), 'the one-liner is spelled the same in install.ps1 and the repair message');

// 7. The icon scripts.
const startS = text('scripts/windows/start-curator.ps1');
const common = text('scripts/windows/curator-common.ps1');
check(/\$psi\.UseShellExecute = \$true/.test(startS), 'start-curator.ps1: ShellExecute start (the server inherits no handles, so a captured caller never hangs)');
check(/\$env:CURATOR_NO_OPEN = '1'/.test(startS), 'start-curator.ps1: CURATOR_NO_OPEN=1 for the server');
check(/Join-Path \$checkout 'src\\server\.js'/.test(startS), 'start-curator.ps1: launches the ABSOLUTE <checkout>\\src\\server.js (what Stop matches)');
check(/127\.0\.0\.1:\$Port\/api\/version/.test(common), 'curator-common.ps1: polls 127.0.0.1 (allowed by the Host-header guard)');
check(/Join-Path \$Checkout 'src\\server\.js'\)\.ToLowerInvariant\(\)/.test(common), 'curator-common.ps1: Stop matches the checkout\'s own server.js, case-insensitively');
check(/CURATOR_WIN_NONINTERACTIVE/.test(common), 'curator-common.ps1: message boxes can be suppressed for CI');

// 8. CI: the job exists, has no if:, and is not advisory.
const wf = readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
const jobStart = wf.indexOf('\n  windows-install:\n');
check(jobStart >= 0, 'test.yml: the windows-install job exists');
const jobBody = jobStart >= 0 ? wf.slice(jobStart + 1).split(/\n  [a-z][a-z-]*:\n/)[0] : '';
check(/name: Windows one-line install\n/.test(jobBody), 'test.yml: job name "Windows one-line install"');
check(/runs-on: windows-latest/.test(jobBody), 'test.yml: runs on windows-latest');
check(!/^    if:/m.test(jobBody), 'test.yml: the job has no if: (a skipped job does not gate a release)');
check(!/continue-on-error/.test(jobBody), 'test.yml: no continue-on-error in the job');
const release = readFileSync(path.join(ROOT, 'scripts/release.js'), 'utf8');
const adv = release.match(/ADVISORY_JOBS = Object\.freeze\(\[([^\]]*)\]\)/);
check(!!adv && !adv[1].includes('Windows one-line install'), 'release.js: the job is not advisory, so it gates the release');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
