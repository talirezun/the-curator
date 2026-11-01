# stop-curator.ps1 - "Stop The Curator" desktop icon (Windows).
#
# Stops every node.exe whose command line names THIS checkout's
# src\server.js (Win32_Process.CommandLine, case-insensitive). That includes a
# server re-spawned by the in-app Restart, so no PID file is needed. No other
# node program is ever touched.
#
# The shortcut runs:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<checkout>\scripts\windows\stop-curator.ps1"
#
# -Quiet: no message box (the installer uses it). CURATOR_WIN_NONINTERACTIVE=1
# (CI) also suppresses message boxes. Exit code: 0 = stopped or was not
# running, 1 = it is still running.
#
# ASCII only (see curator-common.ps1). Windows PowerShell 5.1 and PowerShell 7.

param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'curator-common.ps1')
if ($Quiet) { $script:CuratorNonInteractive = $true }

$checkout = Get-CuratorCheckout -ScriptDir $PSScriptRoot
$port = Get-CuratorPort -Checkout $checkout

$procs = Get-CuratorServerProcesses -Checkout $checkout
if ($procs.Count -eq 0) {
  if ((Test-CuratorAnswering -Port $port) -eq 'curator') {
    # Something answers as The Curator, but it was not started from this
    # folder (for example an older copy installed by hand, or a terminal).
    Show-CuratorMessage -Kind 'warning' -Text ("A copy of The Curator is running on port $port, but it was not started from`n$checkout`n`nThis icon only stops that copy. Close the other one where it was started (for example its terminal window), or restart your PC.")
    exit 0
  }
  Show-CuratorMessage -Text 'The Curator was not running.'
  exit 0
}

# A few rounds: an in-app Restart that is under way spawns its replacement
# just before the old process exits, so look again after each round.
for ($round = 0; $round -lt 5; $round++) {
  $procs = Get-CuratorServerProcesses -Checkout $checkout
  if ($procs.Count -eq 0) { break }
  foreach ($p in $procs) {
    try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop } catch { }
  }
  $until = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $until) {
    $alive = $false
    foreach ($p in $procs) {
      if (Get-Process -Id ([int]$p.ProcessId) -ErrorAction SilentlyContinue) { $alive = $true }
    }
    if (-not $alive) { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 700
}

$left = Get-CuratorServerProcesses -Checkout $checkout
if ($left.Count -gt 0) {
  $ids = (($left | ForEach-Object { $_.ProcessId }) -join ', ')
  Show-CuratorMessage -Kind 'error' -Title 'The Curator' -Text ("The Curator could not be stopped (process $ids).`n`nRestart your PC to stop it.")
  exit 1
}

# Wait briefly until the port is released, so an immediate restart works.
$until = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $until) {
  if ((Test-CuratorAnswering -Port $port -TimeoutMs 500) -ne 'curator') { break }
  Start-Sleep -Milliseconds 200
}

Show-CuratorMessage -Text 'The Curator has stopped.'
exit 0
