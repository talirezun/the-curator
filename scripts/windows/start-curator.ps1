# start-curator.ps1 - "The Curator" desktop icon (Windows).
#
# Starts The Curator's server with no console window and opens it in the
# default browser. If it is already running, it only opens the browser.
#
# The shortcut runs:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<checkout>\scripts\windows\start-curator.ps1"
#
# It lives in the repo, so an update refreshes it. It uses the private runtime
# that install.ps1 puts in %LOCALAPPDATA%\TheCurator\runtime (node + git), and
# never the system PATH's node. Exit code: 0 = running, 1 = it could not start.
#
# CURATOR_WIN_NONINTERACTIVE=1 (CI): no message boxes and no browser; the
# messages go to the console instead.
#
# ASCII only (see curator-common.ps1). Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'curator-common.ps1')

$checkout = Get-CuratorCheckout -ScriptDir $PSScriptRoot
$runtime = Get-CuratorRuntime
$logPath = Get-CuratorLogPath
$port = Get-CuratorPort -Checkout $checkout
$url = "http://localhost:$port"

function Open-CuratorBrowser {
  if ($script:CuratorNonInteractive) { Write-Host "The Curator is running at $url"; return }
  try { Start-Process $url } catch {
    Show-CuratorMessage -Kind 'info' -Text ("The Curator is running, but your web browser could not be opened automatically.`n`nOpen your browser and go to:  $url")
  }
}

function Stop-WithMessage {
  param([string]$Text)
  Show-CuratorMessage -Kind 'error' -Title 'The Curator could not start' -Text $Text
  exit 1
}

$repairLine = "To repair it, open PowerShell (Start menu, type PowerShell) and paste this line, then press Enter:`n`n    $($script:CuratorOneLiner)`n`nYour notes and settings are kept."

# 1. Already running? Then just open the browser.
if ((Test-CuratorAnswering -Port $port) -eq 'curator') {
  Open-CuratorBrowser
  exit 0
}

# 2. The files it needs.
if (-not (Test-Path -LiteralPath $runtime.NodeExe -PathType Leaf)) {
  Stop-WithMessage ("The Curator cannot start because its copy of Node.js is missing:`n$($runtime.NodeExe)`n`nThis happens when the folder was deleted or antivirus software removed the file.`n`n$repairLine")
}
$serverJs = Join-Path $checkout 'src\server.js'
if (-not (Test-Path -LiteralPath $serverJs -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $checkout 'node_modules\express\package.json') -PathType Leaf)) {
  Stop-WithMessage ("The Curator cannot start because some of its files are missing in:`n$checkout`n`n$repairLine")
}

# 3. Start it, unless one is already starting (a double double-click).
$existing = Get-CuratorServerProcesses -Checkout $checkout
$wrapper = $null
if ($existing.Count -eq 0) {
  $owners = Get-PortOwners -Port $port
  # Only a program we can SEE listening counts here. A port that is merely
  # not bindable for a moment (a just-stopped server) is left to the server's
  # own bind retry, and the log explains any failure below.
  if ($owners.Count -gt 0) {
    $names = (($owners | ForEach-Object { "$($_.Name) (process $($_.Id))" }) -join ', ')
    Stop-WithMessage ("Port $port is already used by another program: $names.`n`nThe Curator needs that port. Close that program and double-click The Curator again.`n`nOr give The Curator a different port: open this file in Notepad`n    $checkout\.env`nadd a line such as`n    PORT=3334`nsave it, and double-click The Curator again.")
  }

  # Keep the previous log as server.log.1.
  try {
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
      Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
    }
  } catch { }
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    [System.IO.File]::AppendAllText($logPath, "---- The Curator starting $stamp (port $port) ----`r`n", (New-Object System.Text.UTF8Encoding($false)))
  } catch { }

  # PATH: the private node and git first, then the user's own PATH, without
  # duplicates. It is set on THIS process, which the server inherits. Windows
  # environment names are case-insensitive (PATH is usually spelled `Path`),
  # so this updates the one existing entry rather than adding a second.
  $current = $env:PATH
  $mine = @($runtime.NodeDir, $runtime.GitCmd)
  $rest = @()
  if ($current) {
    foreach ($part in $current.Split(';')) {
      if (-not $part) { continue }
      $skip = $false
      foreach ($m in $mine) { if ($part.TrimEnd('\') -ieq $m.TrimEnd('\')) { $skip = $true } }
      if (-not $skip) { $rest += $part }
    }
  }
  $env:PATH = (($mine + $rest) -join ';')
  $env:CURATOR_NO_OPEN = '1'

  # node.exe is started through a hidden cmd.exe only so that its output goes
  # straight into the log file: this script exits right away, so it cannot
  # pump the output itself.
  #
  # UseShellExecute = TRUE is load-bearing. A CreateProcess-style start
  # (UseShellExecute = false) lets the server inherit this script's handles,
  # and whoever runs this script with captured output (the installer, a CI
  # step) would then wait until the SERVER exits. ShellExecute passes no
  # handles, only this process's environment, which is why PATH is set above.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  # The three paths go to cmd.exe as VARIABLES, never as text: cmd expands
  # %NAME% even inside quotes, so a folder called "a %TEMP% b" typed into the
  # command line would be rewritten. cmd expands each variable once and never
  # re-expands the result, so the paths reach node exactly as they are.
  $env:CURATOR_NODE_EXE = $runtime.NodeExe
  $env:CURATOR_SERVER_JS = $serverJs
  $env:CURATOR_LOG = $logPath
  $psi.Arguments = '/d /s /c ""%CURATOR_NODE_EXE%" "%CURATOR_SERVER_JS%" >> "%CURATOR_LOG%" 2>&1"'
  $psi.WorkingDirectory = $checkout
  $psi.UseShellExecute = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  try {
    $wrapper = [System.Diagnostics.Process]::Start($psi)
  } catch {
    $err = $_.Exception
    while ($err.InnerException) { $err = $err.InnerException }
    Stop-WithMessage ("Windows did not let The Curator start.`n`n$($err.Message)`n`nIf your antivirus shows a warning about node.exe, allow it, then try again.`n`nLog file: $logPath")
  }
}

# 4. Wait until it answers (the first start after an install can be slow while
#    Windows Defender scans the new files).
$deadline = (Get-Date).AddSeconds(45)
$ok = $false
while ((Get-Date) -lt $deadline) {
  if ((Test-CuratorAnswering -Port $port -TimeoutMs 1500) -eq 'curator') { $ok = $true; break }
  if ($wrapper -and $wrapper.HasExited) {
    Start-Sleep -Milliseconds 300
    if ((Test-CuratorAnswering -Port $port -TimeoutMs 1500) -eq 'curator') { $ok = $true }
    break
  }
  Start-Sleep -Milliseconds 500
}

if ($ok) {
  Open-CuratorBrowser
  exit 0
}

# 5. It did not start: say why, in words.
$tail = Get-LogTail -Path $logPath
$stillRunning = (Get-CuratorServerProcesses -Checkout $checkout).Count -gt 0
if (-not (Test-Path -LiteralPath $runtime.NodeExe -PathType Leaf)) {
  Stop-WithMessage ("The Curator could not start: its copy of Node.js disappeared while starting. Antivirus software often does this.`n`nIn your antivirus (for example Windows Security, Virus and threat protection, Protection history), allow or restore node.exe, then:`n$repairLine`n`nLog file: $logPath")
}
if ($tail -match 'virus|potentially unwanted|Operation did not complete successfully|Access is denied') {
  Stop-WithMessage ("The Curator could not start: Windows or your antivirus blocked it.`n`nOpen Windows Security, Virus and threat protection, Protection history, allow node.exe, then double-click The Curator again.`n`nLog file: $logPath")
}
if ($tail -match 'Failed to bind port [0-9]+: EACCES|listen EACCES') {
  Stop-WithMessage ("Windows does not allow The Curator to use port $port. Windows sometimes reserves a block of ports for Hyper-V, WSL or Docker, and $port is in it.`n`nGive The Curator a different port: open`n    $checkout\.env`nin Notepad, add a line such as  PORT=3456 , save it, and double-click The Curator again.`n`nLog file: $logPath")
}
if ($tail -match 'EADDRINUSE|Failed to bind port|busy, retrying') {
  Stop-WithMessage ("Port $port is already used by another program, so The Curator could not start.`n`nClose that program and try again, or give The Curator a different port: open`n    $checkout\.env`nin Notepad, add a line such as  PORT=3334 , save it, and double-click The Curator again.`n`nLog file: $logPath")
}
if ($tail -match 'Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND') {
  Stop-WithMessage ("The Curator could not start because some of its files are missing or damaged.`n`n$repairLine`n`nLog file: $logPath")
}
if ($stillRunning) {
  Stop-WithMessage ("The Curator is taking longer than usual to start. Wait a minute, then double-click The Curator again.`n`nIf it still does not open, restart your PC and try once more.`n`nLog file: $logPath")
}
Stop-WithMessage ("The Curator could not start.`n`nTry double-clicking The Curator again. If that does not help:`n$repairLine`n`nIf it still fails, send this log file to whoever helps you with The Curator:`n$logPath")
