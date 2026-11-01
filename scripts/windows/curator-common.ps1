# curator-common.ps1 - shared by start-curator.ps1 and stop-curator.ps1 (Windows).
#
# Dot-sourced, never run on its own. ASCII only, on purpose: Windows PowerShell
# 5.1 reads a BOM-less file in the system's ANSI code page, so any non-ASCII
# character here would be mangled on some PCs.
#
# Must run on Windows PowerShell 5.1 AND PowerShell 7: no `??`, no ternary, no
# `-Parallel`, no Join-Path with more than two parts.
#
# Paths are always handled with -LiteralPath or .NET calls, because a user
# name may contain spaces, brackets or non-ASCII letters.

$script:CuratorNonInteractive = ($env:CURATOR_WIN_NONINTERACTIVE -eq '1')
$script:CuratorOneLiner = 'irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 | iex'

function Get-CuratorCheckout {
  param([string]$ScriptDir)
  # scripts\windows\ -> the checkout is two folders up.
  $full = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $ScriptDir '..') '..'))
  return $full.TrimEnd('\')
}

function Get-CuratorDataRoot {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = [Environment]::GetFolderPath('LocalApplicationData') }
  return (Join-Path $base 'TheCurator')
}

function Get-CuratorRuntime {
  $root = Join-Path (Get-CuratorDataRoot) 'runtime'
  $nodeDir = Join-Path $root 'node'
  $gitDir = Join-Path $root 'git'
  return New-Object PSObject -Property @{
    Root    = $root
    NodeDir = $nodeDir
    NodeExe = (Join-Path $nodeDir 'node.exe')
    GitCmd  = (Join-Path $gitDir 'cmd')
    GitExe  = (Join-Path (Join-Path $gitDir 'cmd') 'git.exe')
  }
}

function Get-CuratorLogPath {
  $dir = Join-Path (Get-CuratorDataRoot) 'logs'
  [void][System.IO.Directory]::CreateDirectory($dir)
  return (Join-Path $dir 'server.log')
}

# The port, read the way src/server.js reads it: `dotenv/config` loads the
# checkout's .env but NEVER overrides a variable that is already set, so a PORT
# in the user's environment wins over .env, and 3333 is the default.
function Get-CuratorPort {
  param([string]$Checkout)
  $raw = $env:PORT
  if (-not $raw) {
    $envFile = Join-Path $Checkout '.env'
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
      try {
        $lines = [System.IO.File]::ReadAllLines($envFile)
        foreach ($line in $lines) {
          # dotenv: optional `export `, KEY = value; the LAST occurrence wins.
          $m = [regex]::Match($line, '^\s*(?:export\s+)?PORT\s*=\s*(.*)$')
          if (-not $m.Success) { continue }
          $v = $m.Groups[1].Value.Trim()
          $q = [regex]::Match($v, '^([''"`])(.*?)\1')
          if ($q.Success) {
            $v = $q.Groups[2].Value
          } else {
            $hash = $v.IndexOf('#')
            if ($hash -ge 0) { $v = $v.Substring(0, $hash) }
          }
          $raw = $v.Trim()
        }
      } catch { }
    }
  }
  $n = 0
  if ($raw -and [int]::TryParse($raw, [ref]$n) -and $n -ge 1 -and $n -le 65535) { return $n }
  return 3333
}

# Every node.exe whose command line names THIS checkout's src\server.js. That
# covers a server started by the desktop icon and one re-spawned by the
# in-app Restart (it runs `<node> <checkout>\src\server.js`), and never matches
# any other node program. Case-insensitive; forward slashes are normalised.
function Get-CuratorServerProcesses {
  param([string]$Checkout)
  $needle = (Join-Path $Checkout 'src\server.js').ToLowerInvariant()
  $procs = @()
  try {
    $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  } catch {
    try { $procs = @(Get-WmiObject -Class Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop) } catch { $procs = @() }
  }
  $found = @()
  foreach ($p in $procs) {
    $cl = $p.CommandLine
    if (-not $cl) { continue }
    if ($cl.Replace('/', '\').ToLowerInvariant().Contains($needle)) { $found += $p }
  }
  return ,$found
}

# 'curator' when The Curator answers /api/version on this port, 'other' when
# something else answers, 'none' when nothing is listening. 127.0.0.1 is used
# because the server's Host-header guard accepts it, and the system proxy is
# switched off for this loopback call.
function Test-CuratorAnswering {
  param([int]$Port, [int]$TimeoutMs = 2000)
  $resp = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/version")
    $req.Proxy = $null
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.KeepAlive = $false
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    try {
      $json = $body | ConvertFrom-Json
      if ($json -and $json.version) { return 'curator' }
    } catch { }
    return 'other'
  } catch {
    # A .NET method's exception arrives wrapped (MethodInvocationException):
    # walk down to the WebException, if there is one.
    $we = $_.Exception
    while ($we -and -not ($we -is [System.Net.WebException])) { $we = $we.InnerException }
    if ($we) {
      if ($we.Response) { try { $we.Response.Close() } catch { }; return 'other' }
      if ($we.Status -eq [System.Net.WebExceptionStatus]::Timeout) { return 'other' }
    }
    return 'none'
  } finally {
    if ($resp) { try { $resp.Close() } catch { } }
  }
}

# The programs listening on a TCP port (any address), as PSObjects with Id and
# Name. Empty when nothing listens or the check is not possible.
function Get-PortOwners {
  param([int]$Port)
  $ids = @()
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    foreach ($c in $conns) { if ($ids -notcontains [int]$c.OwningProcess) { $ids += [int]$c.OwningProcess } }
  } catch {
    try {
      $lines = & netstat.exe -ano -p TCP 2>$null
      foreach ($l in $lines) {
        $m = [regex]::Match($l, '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)')
        if ($m.Success -and [int]$m.Groups[1].Value -eq $Port) {
          $id = [int]$m.Groups[2].Value
          if ($ids -notcontains $id) { $ids += $id }
        }
      }
    } catch { }
  }
  $owners = @()
  foreach ($id in $ids) {
    if ($id -le 0) { continue }
    $name = 'an unknown program'
    try { $name = (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch { }
    $owners += New-Object PSObject -Property @{ Id = $id; Name = $name }
  }
  return ,$owners
}

function Test-PortFree {
  param([int]$Port)
  $l = $null
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $l.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($l) { try { $l.Stop() } catch { } }
  }
}

# A message box that stays on top (the scripts run with no console window), or
# plain text when CURATOR_WIN_NONINTERACTIVE=1 (CI) so nothing waits for a click.
function Show-CuratorMessage {
  param([string]$Text, [string]$Title = 'The Curator', [ValidateSet('info', 'error', 'warning')][string]$Kind = 'info')
  try { Write-Host $Text } catch { }
  if ($script:CuratorNonInteractive) { return }
  $icon = 0x40
  if ($Kind -eq 'error') { $icon = 0x10 }
  if ($Kind -eq 'warning') { $icon = 0x30 }
  try {
    $sh = New-Object -ComObject WScript.Shell
    # 0x1000 = system modal: the box appears in front of other windows.
    [void]$sh.Popup($Text, 0, $Title, $icon + 0x1000)
    return
  } catch { }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $mbIcon = [System.Windows.Forms.MessageBoxIcon]::Information
    if ($Kind -eq 'error') { $mbIcon = [System.Windows.Forms.MessageBoxIcon]::Error }
    if ($Kind -eq 'warning') { $mbIcon = [System.Windows.Forms.MessageBoxIcon]::Warning }
    [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $mbIcon)
  } catch { }
}

function Get-LogTail {
  param([string]$Path, [int]$Lines = 60)
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $sr = New-Object System.IO.StreamReader($fs)
      $all = $sr.ReadToEnd()
    } finally { $fs.Close() }
    $parts = $all -split "`r?`n"
    if ($parts.Count -gt $Lines) { $parts = $parts[($parts.Count - $Lines)..($parts.Count - 1)] }
    return ($parts -join "`n")
  } catch { return '' }
}
