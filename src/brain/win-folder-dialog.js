/**
 * win-folder-dialog.js — the native folder dialog on Windows (v3.87.1).
 *
 * The repo install on Windows (the one-line installer) runs the server hidden,
 * with no window of its own, and has no `osascript`. v3.87.0 therefore refused
 * every folder picker there with 501, which left an existing user with no way
 * to point the app at the knowledge folder they already have. This module is
 * the Windows twin of `osascript … choose folder`: it shows
 * System.Windows.Forms.FolderBrowserDialog from Windows PowerShell 5.1 (on
 * every Windows 10 and 11) and reads the chosen folder back.
 *
 * ── HOW IT RUNS, and why each part is the way it is ──────────────────────
 *   • powershell.exe by ABSOLUTE path (`powershellPath()`, the rule
 *     harness-detect.js records): a bare name is resolved through the current
 *     folder and PATH, where any planted `powershell.exe` would run instead.
 *   • `execFile` with an argv array, no shell. The script is a CONSTANT in this
 *     file, sent as `-EncodedCommand` (base64 of UTF-16LE, PowerShell's own
 *     format), so no quoting rule of cmd.exe or PowerShell ever touches it.
 *     Nothing the client sends reaches the script: the dialog's description
 *     is one of the server's own literals, passed in an ENVIRONMENT VARIABLE
 *     the script reads as data, never spliced into the code.
 *   • `-STA`: WinForms dialogs need a single-threaded apartment.
 *   • THE DIALOG MUST NOT OPEN BEHIND THE BROWSER. The server has no window,
 *     so a dialog with no owner opens wherever Windows puts a background
 *     process's window — usually under the browser the person is looking at,
 *     where it reads as "the button did nothing". The dialog is given an
 *     OWNER: a 1×1, fully transparent, TopMost form centred on the screen. An
 *     owned window always sits above its owner, so the dialog lands in the
 *     topmost band too. The owner is shown, hidden and shown again before the
 *     dialog: Windows applies a parent's "start hidden" request (Node's
 *     `windowsHide`, which keeps a console window from flashing) to the FIRST
 *     window a process shows, and that first show must be spent on the
 *     invisible owner rather than on the dialog.
 *   • The answer is printed as `OK <base64 of the UTF-8 path>` or `CANCEL`:
 *     plain ASCII on stdout, so a folder under a user name such as "Žiga" or
 *     "Ana Žagar" survives any console code page. The output encoding is set
 *     to UTF-8 (no BOM) as well, for any error text.
 *   • A ten-minute timeout. A dialog left open that long is treated as a
 *     cancel, and the process is killed so it can never hold the route.
 *
 * Contract: `pickFolderWin32({prompt}, deps)` resolves to one of
 *   {kind:'picked', path}        the person chose a folder
 *   {kind:'cancelled', timedOut?} they closed the dialog (or left it open)
 *   {kind:'unavailable', message} PowerShell itself could not be started
 *   {kind:'failed', message}     PowerShell ran and reported an error
 * and never throws. `deps.execFile` is the test seam (same signature as
 * child_process.execFile); null in production.
 */
import { execFile as realExecFile } from 'node:child_process';
import { powershellPath } from './harness-detect.js';

export const WIN_PICK_TIMEOUT_MS = 10 * 60 * 1000;

/** The environment variable that carries the dialog's description (data, never code). */
export const WIN_PICK_PROMPT_ENV = 'CURATOR_PICK_PROMPT';

// A CONSTANT. Nothing outside this file is ever interpolated into it.
export const WIN_FOLDER_DIALOG_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
  '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
  '$owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.Opacity = 0',
  '$owner.Show()',
  '$owner.Hide()',
  '$owner.Show()',
  '$owner.Activate()',
  '$owner.BringToFront()',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = [string]$env:' + WIN_PICK_PROMPT_ENV,
  '$dialog.ShowNewFolderButton = $true',
  '$result = $dialog.ShowDialog($owner)',
  '$owner.Close()',
  'if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
  "  [Console]::Out.Write('OK ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))",
  '} else {',
  "  [Console]::Out.Write('CANCEL')",
  '}',
].join('\r\n');

/** PowerShell's -EncodedCommand format: base64 of the UTF-16LE script. */
export function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** The exact argv, exported so the suite can pin its shape. */
export function winFolderDialogArgs() {
  return [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShell(WIN_FOLDER_DIALOG_SCRIPT),
  ];
}

/** PURE. Read the script's stdout. Returns a path, `null` for a cancel, or `undefined` for nonsense. */
export function parseWinPickOutput(stdout) {
  const text = String(stdout == null ? '' : stdout).replace(/^﻿/, '').trim();
  if (text === 'CANCEL') return null;
  const m = /^OK ([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return undefined;
  const p = Buffer.from(m[1], 'base64').toString('utf8').trim();
  return p || null;
}

/**
 * PURE. PowerShell started with -EncodedCommand can report errors on stderr as
 * CLIXML (`#< CLIXML <Objs …><S S="Error">…</S>`). Keep only the error text.
 */
export function readableStderr(stderr) {
  const raw = String(stderr == null ? '' : stderr).trim();
  if (!raw.startsWith('#< CLIXML')) return raw;
  const parts = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  return parts.join('')
    .replace(/_x000D__x000A_/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pickFolderWin32({ prompt } = {}, deps = null) {
  const execFile = (deps && deps.execFile) || realExecFile;
  const env = { ...((deps && deps.env) || process.env), [WIN_PICK_PROMPT_ENV]: String(prompt || '') };
  const file = (deps && deps.powershellPath) || powershellPath();
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(file, winFolderDialogArgs(), {
        timeout: (deps && deps.timeoutMs) || WIN_PICK_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        env,
      }, (err, stdout, stderr) => {
        if (err) {
          // Killed by the timeout: the dialog was left open. A cancel, as the
          // osascript arm classifies a killed process.
          if (err.killed === true) return resolve({ kind: 'cancelled', timedOut: true });
          if (err.code === 'ENOENT' || err.code === 'EACCES') {
            return resolve({ kind: 'unavailable', message: 'Windows PowerShell could not be started (' + err.code + ').' });
          }
          const msg = readableStderr(stderr) || err.message || 'The folder dialog failed.';
          return resolve({ kind: 'failed', message: msg });
        }
        const parsed = parseWinPickOutput(stdout);
        if (parsed === null) return resolve({ kind: 'cancelled' });
        if (typeof parsed === 'string') return resolve({ kind: 'picked', path: parsed });
        return resolve({ kind: 'failed', message: 'The folder dialog returned an answer The Curator could not read.' });
      });
    } catch (err) {
      return resolve({ kind: 'unavailable', message: (err && err.message) || 'Windows PowerShell could not be started.' });
    }
    // execFile can also report a spawn failure as an 'error' event before the
    // callback; the callback above receives it too, so nothing else to do.
    void child;
  });
}
