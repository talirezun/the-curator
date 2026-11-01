# -----------------------------------------------------------------------------
# The Curator - Windows installer
#
# Paste this ONE line into PowerShell (not the old "Command Prompt") and press Enter:
#
#   irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 | iex
#
# What it does (about 2 to 5 minutes, no administrator rights needed):
#   1. checks the PC (Windows 10 1809+ or 11, 64-bit, disk space)
#   2. downloads a PRIVATE copy of Node.js and Git into
#      %LOCALAPPDATA%\TheCurator\runtime (pinned versions, SHA-256 checked;
#      nothing is added to the system, and the PATH is not changed)
#   3. downloads The Curator into %USERPROFILE%\the-curator
#   4. installs its components (npm, using the private Node.js)
#   5. adds "The Curator" and "Stop The Curator" to the Desktop and Start menu
#   6. starts The Curator and opens it in the web browser
#
# Running it again is safe: it repairs a missing or damaged part, updates a
# clean copy, and recreates the icons. It never deletes or changes your notes
# (the-curator\domains), your keys (.env) or your settings (.curator-config.json).
#
# Test a branch (maintainers and CI):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/talirezun/the-curator/<branch>/install.ps1))) -Branch <branch>
# CI-only parameters: -NoStart, -InstallDir <folder>, -RepoUrl <git url or local path>.
#
# Rules for editing this file (it runs through `irm | iex`):
#   - ASCII only. Windows PowerShell 5.1 decodes a downloaded script without a
#     charset guess, so a non-ASCII character can turn into garbage.
#   - Runs on Windows PowerShell 5.1 AND PowerShell 7: no `??`, no ternary,
#     no `-Parallel`, Join-Path with two parts only.
#   - NEVER `exit`: under `iex` it would close the user's PowerShell window.
#     Errors are thrown and caught by the one try/catch in Install-TheCurator;
#     the outcome is reported through $LASTEXITCODE (0 ok, 1 failed).
#   - Everything lives inside Install-TheCurator so nothing leaks into the
#     user's session; PATH and other changed settings are restored in `finally`.
# -----------------------------------------------------------------------------

param(
  [string]$Branch = 'main',
  [switch]$NoStart,
  [string]$InstallDir = '',
  [string]$RepoUrl = ''
)

function Install-TheCurator {
  param(
    [string]$Branch,
    [switch]$NoStart,
    [string]$InstallDir,
    [string]$RepoUrl
  )

  # ---- Pinned downloads. Update all four hashes together with the versions. --
  # Node.js LTS: https://nodejs.org/dist/index.json and
  #              https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
  $NodeVersion = '24.22.2'
  $NodeSha256X64 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
  $NodeSha256Arm64 = 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468'
  # MinGit: https://api.github.com/repos/git-for-windows/git/releases/tags/v2.56.0.windows.4
  $MinGitTag = 'v2.56.0.windows.4'
  $MinGitVersion = '2.56.0.4'
  $MinGitSha256X64 = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'
  $MinGitSha256Arm64 = '70f7649f78088c1db1d2f3571ca46a04d5bef06e4e9d56d8ed7f9829e8c6c4db'

  $OfficialRepo = 'https://github.com/talirezun/the-curator.git'
  $OneLiner = 'irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 | iex'
  $NeedMB = 500

  # ---- 0. Locked-down PowerShell: say so before anything else can fail. ------
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Write-Host ''
    Write-Host '  The Curator cannot be installed on this PC.' -ForegroundColor Red
    Write-Host '  PowerShell is locked down here ("Constrained Language Mode"). This is set by an'
    Write-Host '  organisation (work or school IT) and blocks installers like this one.'
    Write-Host '  Please ask your IT department to install The Curator, or use a personal PC.'
    Write-Host ''
    $global:LASTEXITCODE = 1
    return
  }

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $state = @{
    Step       = 'Starting'
    Log        = $null
    Arch       = 'unknown'
    StoppedApp = $false
    Proxy      = $null
    Commit     = ''
  }
  $savedEnv = @{}
  foreach ($k in @('PATH', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'NODE_OPTIONS', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_update_notifier', 'npm_config_fund', 'npm_config_audit')) {
    $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
  }
  $savedTls = $null

  # ---------------------------------------------------------------- helpers --
  function Say {
    param([string]$Text, [string]$Color = '')
    if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
    Write-Log $Text
  }

  function Write-Log {
    param([string]$Text)
    if (-not $state.Log) { return }
    try {
      [System.IO.File]::AppendAllText($state.Log, $Text + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
  }

  function Start-Step {
    param([int]$N, [string]$Text)
    $state.Step = $Text
    Write-Host ''
    Write-Host ("  [$N/7] " + $Text) -ForegroundColor Cyan
    Write-Log ("==== [$N/7] $Text  " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
  }

  # A stop with a plain-words reason and what to do next.
  function Stop-Install {
    param([string]$What, [string]$Todo)
    $e = New-Object System.Exception($What)
    $e.Data['CuratorTodo'] = $Todo
    throw $e
  }

  # Run a program, capture everything it prints into the log, never let its
  # stderr (git prints progress there) become a PowerShell error.
  function Invoke-Tool {
    param([string]$Exe, [string[]]$ArgList, [string]$Cwd = '')
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Write-Log ("> `"$Exe`" " + ($ArgList -join ' '))
    $pushed = $false
    $lines = @()
    $code = -1
    try {
      if ($Cwd) { Push-Location -LiteralPath $Cwd; $pushed = $true }
      $lines = @(& $Exe @ArgList 2>&1 | ForEach-Object { "$_" })
      $code = $LASTEXITCODE
    } catch {
      $lines += $_.Exception.Message
      $code = -1
    } finally {
      if ($pushed) { Pop-Location }
      $ErrorActionPreference = $oldEap
    }
    $text = ($lines -join "`n")
    if ($text) { Write-Log $text }
    Write-Log "  (exit code $code)"
    # Last: the last non-empty line, for one-value commands (rev-parse, config)
    # whose stderr warnings are merged into the same stream.
    $last = ''
    foreach ($l in $lines) { if (("" + $l).Trim()) { $last = ("" + $l).Trim() } }
    return New-Object PSObject -Property @{ Code = $code; Text = $text; Last = $last }
  }

  function Remove-Dir {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    for ($i = 0; $i -lt 5; $i++) {
      try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; return $true } catch { Start-Sleep -Seconds 1 }
    }
    return (-not (Test-Path -LiteralPath $Path))
  }

  # Folder renames right after many files were written can fail for a moment
  # while antivirus or the search indexer still has a file open: retry.
  function Move-Dir {
    param([string]$From, [string]$To)
    $last = $null
    for ($i = 0; $i -lt 15; $i++) {
      try { [System.IO.Directory]::Move($From, $To); return } catch { $last = $_; Start-Sleep -Seconds 1 }
    }
    throw $last
  }

  function Get-NativeArch {
    $a = ''
    try {
      # The NATIVE architecture, also correct inside an emulated x64 PowerShell on ARM.
      $a = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE
    } catch { }
    if (-not $a) { $a = $env:PROCESSOR_ARCHITEW6432 }
    if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
    switch -regex ($a) {
      '^(?i)AMD64$' { return 'x64' }
      '^(?i)ARM64$' { return 'arm64' }
    }
    return ("" + $a)
  }

  function Get-System32 {
    # A 32-bit PowerShell on 64-bit Windows sees SysWOW64 as System32.
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
      return (Join-Path $env:SystemRoot 'Sysnative')
    }
    return (Join-Path $env:SystemRoot 'System32')
  }

  function Get-SystemProxy {
    param([string]$ForUrl)
    try {
      $sys = [System.Net.WebRequest]::GetSystemWebProxy()
      $u = New-Object System.Uri($ForUrl)
      $p = $sys.GetProxy($u)
      if ($p -and ($p.AbsoluteUri.TrimEnd('/') -ne $u.AbsoluteUri.TrimEnd('/'))) { return $p.AbsoluteUri.TrimEnd('/') }
    } catch { }
    return $null
  }

  # One download attempt with the .NET client: it uses the Windows (system)
  # proxy with the signed-in user's credentials, and prints progress.
  function Receive-WithDotNet {
    param([string]$Url, [string]$Dest, [string]$Label)
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = 'TheCurator-Installer/1 (Windows PowerShell)'
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 120000
    $req.AllowAutoRedirect = $true
    $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
    $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
    $req.Proxy = $proxy
    $resp = $req.GetResponse()
    $in = $null
    $out = $null
    try {
      $total = $resp.ContentLength
      $in = $resp.GetResponseStream()
      $out = [System.IO.File]::Create($Dest)
      $buf = New-Object byte[] 262144
      $done = [long]0
      $lastPct = -10
      while ($true) {
        $n = $in.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $done += $n
        if ($total -gt 0) {
          $pct = [int](($done * 100) / $total)
          if ($pct -ge $lastPct + 10) {
            $lastPct = $pct
            Write-Host ("        {0}: {1}% ({2} of {3} MB)" -f $Label, $pct, [int]($done / 1MB), [int]($total / 1MB))
          }
        }
      }
      if ($total -gt 0 -and $done -ne $total) { throw "the download stopped early ($done of $total bytes)" }
    } finally {
      if ($out) { $out.Close() }
      if ($in) { $in.Close() }
      $resp.Close()
    }
  }

  # The built-in curl.exe as a second route (attempt 3).
  function Receive-WithCurl {
    param([string]$Url, [string]$Dest)
    $curl = Join-Path (Get-System32) 'curl.exe'
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'curl.exe is not available' }
    $a = @('--fail', '--location', '--silent', '--show-error', '--retry', '2', '--output', $Dest)
    if ($state.Proxy) { $a += @('--proxy', $state.Proxy, '--proxy-anyauth', '--proxy-user', ':') }
    $a += $Url
    $r = Invoke-Tool -Exe $curl -ArgList $a
    if ($r.Code -ne 0) { throw ("curl.exe failed: " + $r.Text) }
  }

  # Download, check the SHA-256, retry up to 3 times. A file that is already
  # in the download folder with the right hash is reused (a re-run after a
  # failure does not download it again).
  function Get-VerifiedFile {
    param([string]$Url, [string]$Dest, [string]$Sha256, [string]$Label)
    if (Test-Path -LiteralPath $Dest -PathType Leaf) {
      $h = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($h -eq $Sha256) { Say "        $Label is already downloaded."; return }
      Remove-Item -LiteralPath $Dest -Force
    }
    $part = $Dest + '.part'
    $mismatch = $false
    $lastErr = ''
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        Write-Log "download attempt $attempt : $Url"
        if ($attempt -lt 3) { Receive-WithDotNet -Url $Url -Dest $part -Label $Label } else { Receive-WithCurl -Url $Url -Dest $part }
        $h = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($h -ne $Sha256) {
          $mismatch = $true
          Write-Log "SHA-256 mismatch: expected $Sha256, got $h"
          throw 'the downloaded file is not the expected one'
        }
        Move-Item -LiteralPath $part -Destination $Dest -Force
        return
      } catch {
        $err = $_.Exception
        while ($err.InnerException) { $err = $err.InnerException }
        $lastErr = $err.Message
        Write-Log "download attempt $attempt failed: $lastErr"
        if ($attempt -lt 3) {
          Say "        The download did not work ($lastErr). Trying again..." 'Yellow'
          Start-Sleep -Seconds (3 * $attempt)
        }
      }
    }
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue }
    if ($mismatch) {
      Stop-Install ("The download of $Label did not match its expected fingerprint (SHA-256), so it was not used. Nothing was installed from it.") `
        'This usually means a network filter or proxy changed the file. Try again later, or on a different network (for example a phone hotspot). If it keeps happening, send the log to support.'
    }
    Stop-Install ("$Label could not be downloaded: $lastErr") `
      'Check that this PC is online and try again. On a work or school network a firewall or proxy may block downloads from nodejs.org or github.com; try a different network (for example a phone hotspot).'
  }

  # Unzip with Windows' own tar.exe (much faster than Expand-Archive while
  # Defender scans every file); fall back to .NET's ZipFile.
  function Expand-ZipFile {
    param([string]$Zip, [string]$Dest)
    [void][System.IO.Directory]::CreateDirectory($Dest)
    $tar = Join-Path (Get-System32) 'tar.exe'
    # tar.exe is not trusted with non-ASCII paths (a user name like "Ziga" with
    # a caron): those go straight to .NET, which is Unicode throughout.
    $ascii = (($Zip + $Dest) -notmatch '[^\x20-\x7E]')
    if ($ascii -and (Test-Path -LiteralPath $tar -PathType Leaf)) {
      $r = Invoke-Tool -Exe $tar -ArgList @('-xf', $Zip, '-C', $Dest)
      if ($r.Code -eq 0 -and @(Get-ChildItem -LiteralPath $Dest -Force).Count -gt 0) { return }
      Write-Log 'tar.exe failed; trying .NET ZipFile'
      [void](Remove-Dir $Dest)
      [void][System.IO.Directory]::CreateDirectory($Dest)
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
  }

  function Test-Exe {
    param([string]$Exe, [string]$Expect)
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $false }
    for ($i = 0; $i -lt 3; $i++) {
      $r = Invoke-Tool -Exe $Exe -ArgList @('--version')
      if ($r.Code -eq 0 -and $r.Text.Contains($Expect)) { return $true }
      Start-Sleep -Seconds 2
    }
    return $false
  }

  function Get-RuntimeUsers {
    param([string]$Dir)
    $names = @()
    try {
      $needle = $Dir.TrimEnd('\').ToLowerInvariant() + '\'
      foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
        if ($p.ExecutablePath -and $p.ExecutablePath.ToLowerInvariant().StartsWith($needle)) {
          $names += ("" + $p.Name + " (process " + $p.ProcessId + ")")
        }
      }
    } catch { }
    return ,$names
  }

  # Install one private runtime (node or git) into runtime\<Name>, atomically:
  # unpack to <Name>.new, test it, then swap. A marker file records what is
  # installed, so a re-run with the same pins only re-tests the program.
  #
  # Two phases, so a failed download never stops a running Curator: without
  # -Commit it downloads, verifies and tests into <Name>.new (nothing in use is
  # touched); with -Commit it swaps a prepared <Name>.new into place.
  function Install-Runtime {
    param([string]$Name, [string]$Label, [string]$Url, [string]$Sha256, [string]$ExeRel, [string]$Expect, [bool]$HasTopFolder, [switch]$Commit)
    $root = Join-Path $dataRoot 'runtime'
    $target = Join-Path $root $Name
    $marker = Join-Path $target '.curator-runtime.txt'
    $want = "$Name $Expect $Sha256"
    $exe = Join-Path $target $ExeRel
    $stage = Join-Path $root ($Name + '.new')
    $dlDir = Join-Path $dataRoot 'downloads'
    $zip = Join-Path $dlDir ([System.IO.Path]::GetFileName(([System.Uri]$Url).AbsolutePath))
    if ($Commit) {
      if (-not (Test-Path -LiteralPath $stage -PathType Container)) { return }
      if (Test-Path -LiteralPath $target) {
        # A unique name: an older leftover that is still locked cannot block this.
        $old = Join-Path $root ($Name + '.old-' + [DateTime]::UtcNow.Ticks)
        try {
          Move-Dir -From $target -To $old
        } catch {
          $users = Get-RuntimeUsers -Dir $target
          $who = ''
          if ($users.Count -gt 0) { $who = ' It is in use by: ' + ($users -join ', ') + '.' }
          Stop-Install ("The old copy of $Label in $target could not be replaced because a program is still using it.$who") `
            'Quit the programs that use The Curator (for example Claude Desktop: right-click its icon near the clock and choose Quit), then run the installer again.'
        }
        [void](Remove-Dir $old)
      }
      Move-Dir -From $stage -To $target
      [System.IO.File]::WriteAllText($marker, $want, (New-Object System.Text.UTF8Encoding($false)))
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      Say "        $Label $Expect is ready."
      return
    }
    if ((Test-Path -LiteralPath $marker -PathType Leaf) -and (([System.IO.File]::ReadAllText($marker)).Trim() -eq $want)) {
      if (Test-Exe -Exe $exe -Expect $Expect) {
        Say "        $Label $Expect is already installed and works."
        return
      }
      Say "        $Label is damaged or incomplete; repairing it." 'Yellow'
    }
    [void][System.IO.Directory]::CreateDirectory($dlDir)
    Get-VerifiedFile -Url $Url -Dest $zip -Sha256 $Sha256 -Label "$Label $Expect"

    Say "        Unpacking $Label..."
    $extract = Join-Path $root ($Name + '.extract')
    if (-not (Remove-Dir $stage) -or -not (Remove-Dir $extract)) {
      Stop-Install "An old temporary folder in $root could not be removed." 'Restart your PC and run the installer again.'
    }
    if ($HasTopFolder) {
      Expand-ZipFile -Zip $zip -Dest $extract
      $inner = @(Get-ChildItem -LiteralPath $extract -Directory)
      if ($inner.Count -ne 1) { Stop-Install "The $Label download did not have the expected contents." 'Run the installer again. If it keeps happening, send the log to support.' }
      Move-Dir -From $inner[0].FullName -To $stage
      [void](Remove-Dir $extract)
    } else {
      Expand-ZipFile -Zip $zip -Dest $stage
    }
    if (-not (Test-Exe -Exe (Join-Path $stage $ExeRel) -Expect $Expect)) {
      Stop-Install "$Label was downloaded but does not run on this PC." 'Windows Security or your antivirus may be blocking it: open Windows Security > Virus and threat protection > Protection history, allow the item, and run the installer again.'
    }
    Say "        $Label $Expect is downloaded and checked."
  }

  # Our git's own system config (MinGit reads <git>\etc\gitconfig): trust the
  # checkout even if an elevated run created it (git's "dubious ownership"
  # refusal would otherwise break the in-app updater), and use Windows'
  # certificate store, which knows a company's own certificates.
  function Set-RuntimeGitConfig {
    param([string]$Checkout)
    $cfg = Join-Path (Join-Path (Join-Path $dataRoot 'runtime') 'git') 'etc\gitconfig'
    $text = ''
    if (Test-Path -LiteralPath $cfg -PathType Leaf) { $text = [System.IO.File]::ReadAllText($cfg) }
    $begin = '# >>> The Curator (written by install.ps1)'
    $end = '# <<< The Curator'
    $i = $text.IndexOf($begin)
    if ($i -ge 0) {
      $j = $text.IndexOf($end, $i)
      if ($j -ge 0) { $text = $text.Substring(0, $i) + $text.Substring($j + $end.Length) }
    }
    $text = $text.TrimEnd() + "`n"
    $block = "$begin`n[safe]`n`tdirectory = " + $Checkout.Replace('\', '/') + "`n[http]`n`tsslBackend = schannel`n$end`n"
    [System.IO.File]::WriteAllText($cfg, $text + $block, (New-Object System.Text.UTF8Encoding($false)))
  }

  function Get-GitArgs {
    param([string[]]$More)
    $a = @('-c', ('safe.directory=' + $targetDirFwd))
    if ($state.Proxy) { $a += @('-c', ('http.proxy=' + $state.Proxy)) }
    return ($a + $More)
  }

  function Get-NetworkAdvice {
    param([string]$Text)
    if ($Text -match '(?i)SELF_SIGNED|UNABLE_TO_GET_ISSUER|unable to verify|certificate|SEC_E_|CRYPT_E_') {
      return 'Your network checks secure connections (common at work or school), and the check failed. Try a different network (for example a phone hotspot), or ask your IT department.'
    }
    if ($Text -match '(?i)\b407\b|Proxy Authentication') {
      return 'Your network uses a proxy that needs a sign-in. Try a different network (for example a phone hotspot), or ask your IT department.'
    }
    if ($Text -match '(?i)ENOSPC|No space left|not enough space') {
      return 'The disk is full. Free some space (empty the Recycle Bin, delete large downloads) and run the installer again.'
    }
    if ($Text -match '(?i)EPERM|EBUSY|EACCES|Access is denied|being used by another process|Permission denied') {
      return 'A file was locked by another program. Quit The Curator and the tools that use it (for example Claude Desktop), wait a minute (antivirus may still be scanning), and run the installer again.'
    }
    if ($Text -match '(?i)ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Could not resolve host|Failed to connect|timed out|network') {
      return 'This PC could not reach the internet. Check the connection and run the installer again. On a work or school network a firewall may block github.com or registry.npmjs.org; try a different network.'
    }
    return ''
  }

  function Get-CuratorServerProcs {
    param([string]$Checkout)
    $needle = (Join-Path $Checkout 'src\server.js').ToLowerInvariant()
    $found = @()
    try {
      foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)) {
        if ($p.CommandLine -and $p.CommandLine.Replace('/', '\').ToLowerInvariant().Contains($needle)) { $found += $p }
      }
    } catch { }
    return ,$found
  }

  function New-Shortcut {
    param([string]$Path, [string]$Script, [string]$Icon, [string]$Description)
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($Path)
    $lnk.TargetPath = $ps
    $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Script + '"'
    $lnk.WorkingDirectory = $targetDir
    $lnk.Description = $Description
    # 7 = start minimised: keeps the brief PowerShell flash out of the way.
    $lnk.WindowStyle = 7
    if ($Icon -and (Test-Path -LiteralPath $Icon -PathType Leaf)) { $lnk.IconLocation = $Icon + ',0' }
    $lnk.Save()
  }

  # =============================================================== main body ==
  $dataRoot = $null
  $targetDir = $null
  $targetDirFwd = $null
  try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
      Stop-Install 'This PowerShell is too old (version 5.1 or newer is needed).' 'Run Windows Update, then try again.'
    }

    $dataRoot = $env:LOCALAPPDATA
    if (-not $dataRoot) { $dataRoot = [Environment]::GetFolderPath('LocalApplicationData') }
    if (-not $dataRoot) { Stop-Install 'Windows did not say where this account keeps its app data (LOCALAPPDATA).' 'Sign out of Windows and back in, then run the installer again.' }
    $dataRoot = Join-Path $dataRoot 'TheCurator'
    $logDir = Join-Path $dataRoot 'logs'
    [void][System.IO.Directory]::CreateDirectory($logDir)
    $state.Log = Join-Path $logDir 'install.log'
    try { if (Test-Path -LiteralPath $state.Log) { Move-Item -LiteralPath $state.Log -Destination ($state.Log + '.1') -Force } } catch { }

    if (-not $InstallDir) {
      if (-not $env:USERPROFILE) { Stop-Install 'Windows did not say where your user folder is (USERPROFILE).' 'Sign out of Windows and back in, then run the installer again.' }
      $InstallDir = Join-Path $env:USERPROFILE 'the-curator'
    }
    $targetDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    if ($targetDir.Length -le 3) { Stop-Install "The install folder cannot be the root of a drive ($targetDir)." 'Leave out -InstallDir to use the normal folder.' }
    $targetDirFwd = $targetDir.Replace('\', '/')
    $cloneUrl = $OfficialRepo
    if ($RepoUrl) { $cloneUrl = $RepoUrl }

    Write-Host ''
    Write-Host '  ===========================================================' -ForegroundColor Cyan
    Write-Host '    The Curator - installer for Windows' -ForegroundColor Cyan
    Write-Host '  ===========================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  This will:'
    Write-Host '    - download a private copy of Node.js and Git, used only by The Curator'
    Write-Host '      (nothing else on your PC changes)'
    Write-Host "    - put The Curator in  $targetDir"
    Write-Host "    - add 'The Curator' and 'Stop The Curator' to your desktop and Start menu"
    Write-Host '    - open The Curator in your web browser'
    Write-Host ''
    Write-Host '  It takes about 2 to 5 minutes. Please keep this window open until it says Done.'
    Write-Log ("The Curator installer started " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " branch=$Branch dir=$targetDir repo=$cloneUrl")

    # ------------------------------------------------------------- 1. checks --
    Start-Step 1 'Checking your PC'
    $os = [Environment]::OSVersion.Version
    Write-Log ("Windows " + $os.ToString() + ", PowerShell " + $PSVersionTable.PSVersion.ToString() + " " + $PSVersionTable.PSEdition)
    if ($os.Major -lt 10 -or ($os.Major -eq 10 -and $os.Build -lt 17763)) {
      Stop-Install ("This version of Windows is too old for The Curator (found " + $os.ToString() + ').') 'The Curator needs Windows 10 (version 1809 or newer) or Windows 11. Run Windows Update, then try again.'
    }
    $state.Arch = Get-NativeArch
    if ($state.Arch -ne 'x64' -and $state.Arch -ne 'arm64') {
      Stop-Install ("The Curator needs 64-bit Windows; this PC reports '" + $state.Arch + "'.") 'The Curator cannot run on this PC.'
    }
    Say ("        Windows " + $os.ToString() + ', ' + $state.Arch + ', PowerShell ' + $PSVersionTable.PSVersion.ToString())

    if ($PSVersionTable.PSEdition -ne 'Core') {
      # Windows PowerShell 5.1 may still default to old TLS versions.
      $savedTls = [System.Net.ServicePointManager]::SecurityProtocol
      [System.Net.ServicePointManager]::SecurityProtocol = $savedTls -bor 3072
    }

    foreach ($scope in @('MachinePolicy', 'UserPolicy')) {
      $pol = 'Undefined'
      try { $pol = [string](Get-ExecutionPolicy -Scope $scope) } catch { }
      if ($pol -eq 'AllSigned' -or $pol -eq 'Restricted') {
        Stop-Install ("Your organisation's settings block PowerShell scripts on this PC (policy: $pol), so The Curator's desktop icons could not start it.") 'Ask your IT department to allow it, or use a personal PC.'
      }
    }

    # Elevated as a DIFFERENT account than the one signed in? Then the icons and
    # the app would land in that other account. Simple case only.
    try {
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
      $isAdmin = (New-Object System.Security.Principal.WindowsPrincipal($me)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
      if ($isAdmin) {
        $owners = @()
        foreach ($ex in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'explorer.exe'" -ErrorAction Stop)) {
          $o = Invoke-CimMethod -InputObject $ex -MethodName GetOwner -ErrorAction SilentlyContinue
          if ($o -and $o.User) { $owners += ("" + $o.Domain + '\' + $o.User) }
        }
        if ($owners.Count -gt 0 -and ($owners -notcontains $me.Name)) {
          Stop-Install ("This PowerShell runs as " + $me.Name + ", but " + ($owners[0]) + " is signed in to Windows. The Curator would be installed for the wrong account.") 'Close this window, open PowerShell normally (not "Run as administrator"), and paste the install command again.'
        }
        Say '        PowerShell runs as administrator. That is fine; The Curator is installed for your own account only.' 'Yellow'
      }
    } catch {
      if ($_.Exception.Data['CuratorTodo']) { throw }
      Write-Log ("account check skipped: " + $_.Exception.Message)
    }

    $tar = Join-Path (Get-System32) 'tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { Write-Log 'tar.exe not found; will use .NET ZipFile' }

    $drives = @{}
    foreach ($p in @($dataRoot, $targetDir)) {
      try { $drives[[System.IO.Path]::GetPathRoot($p).ToUpperInvariant()] = $true } catch { }
    }
    foreach ($d in $drives.Keys) {
      try {
        $di = New-Object System.IO.DriveInfo($d)
        $freeMB = [int]($di.AvailableFreeSpace / 1MB)
        Write-Log "free space on $d : $freeMB MB"
        if ($freeMB -lt $NeedMB) {
          Stop-Install ("There is not enough free disk space on drive $d (" + $freeMB + " MB free, about $NeedMB MB needed).") 'Free some space (empty the Recycle Bin, delete large downloads), then run the installer again.'
        }
      } catch {
        if ($_.Exception.Data['CuratorTodo']) { throw }
        Write-Log ("disk check skipped for $d : " + $_.Exception.Message)
      }
    }

    $state.Proxy = Get-SystemProxy 'https://github.com'
    if ($state.Proxy) { Say ("        Using this PC's proxy: " + $state.Proxy) }

    # Leftovers of an interrupted earlier run.
    $rtRoot = Join-Path $dataRoot 'runtime'
    if (Test-Path -LiteralPath $rtRoot -PathType Container) {
      foreach ($leftover in @(Get-ChildItem -LiteralPath $rtRoot -Directory -Force | Where-Object { $_.Name -match '^(node|git)\.(new|extract|old-\d+)$' })) {
        [void](Remove-Dir $leftover.FullName)
      }
    }
    Say '        Your PC is ready.'

    # -------------------------------------------------------------- 2. node --
    Start-Step 2 'Getting Node.js (a private copy for The Curator)'
    if ($state.Arch -eq 'arm64') { $nodeSha = $NodeSha256Arm64 } else { $nodeSha = $NodeSha256X64 }
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-" + $state.Arch + '.zip'
    Install-Runtime -Name 'node' -Label 'Node.js' -Url $nodeUrl -Sha256 $nodeSha -ExeRel 'node.exe' -Expect ('v' + $NodeVersion) -HasTopFolder $true

    # --------------------------------------------------------------- 3. git --
    Start-Step 3 'Getting Git (a private copy for The Curator)'
    if ($state.Arch -eq 'arm64') { $gitSha = $MinGitSha256Arm64; $gitAsset = "MinGit-$MinGitVersion-arm64.zip" } else { $gitSha = $MinGitSha256X64; $gitAsset = "MinGit-$MinGitVersion-64-bit.zip" }
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/$MinGitTag/$gitAsset"
    $gitExpect = $MinGitTag.TrimStart('v')
    Install-Runtime -Name 'git' -Label 'Git' -Url $gitUrl -Sha256 $gitSha -ExeRel 'cmd\git.exe' -Expect $gitExpect -HasTopFolder $false

    # Both downloads are verified; only now stop a running Curator, so a
    # failed download leaves it running. It must not run while its files change.
    $running = Get-CuratorServerProcs -Checkout $targetDir
    if ($running.Count -gt 0) {
      Say '        The Curator is running; stopping it for the update (it starts again at the end).' 'Yellow'
      foreach ($p in $running) { try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop } catch { } }
      Start-Sleep -Seconds 2
      $state.StoppedApp = $true
    }

    Install-Runtime -Name 'node' -Label 'Node.js' -Url $nodeUrl -Sha256 $nodeSha -ExeRel 'node.exe' -Expect ('v' + $NodeVersion) -HasTopFolder $true -Commit
    Install-Runtime -Name 'git' -Label 'Git' -Url $gitUrl -Sha256 $gitSha -ExeRel 'cmd\git.exe' -Expect $gitExpect -HasTopFolder $false -Commit
    Set-RuntimeGitConfig -Checkout $targetDir

    $nodeDir = Join-Path (Join-Path $dataRoot 'runtime') 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    $gitCmdDir = Join-Path (Join-Path (Join-Path $dataRoot 'runtime') 'git') 'cmd'
    $git = Join-Path $gitCmdDir 'git.exe'
    $env:PATH = $nodeDir + ';' + $gitCmdDir + ';' + $savedEnv['PATH']
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'

    # ---------------------------------------------------------- 4. checkout --
    Start-Step 4 'Getting The Curator'
    $kind = 'absent'
    if (Test-Path -LiteralPath $targetDir -PathType Leaf) {
      $kind = 'foreign'
    } elseif (Test-Path -LiteralPath $targetDir -PathType Container) {
      if (@(Get-ChildItem -LiteralPath $targetDir -Force).Count -eq 0) {
        $kind = 'empty'
      } elseif (-not (Test-Path -LiteralPath (Join-Path $targetDir '.git'))) {
        $kind = 'foreign'
      } else {
        $r = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'config', '--get', 'remote.origin.url'))
        $origin = $r.Last
        $norm = { param($u) ("" + $u).Trim().Replace('\', '/').TrimEnd('/') -replace '(?i)\.git$', '' }
        if ($r.Code -eq 0 -and ($origin -match '(?i)github\.com[:/]+talirezun/(the-curator|second-brain)(\.git)?/?$')) {
          $kind = 'ours'
        } elseif ($r.Code -eq 0 -and $RepoUrl -and ((& $norm $origin) -ieq (& $norm $RepoUrl))) {
          $kind = 'ours'
        } elseif ($r.Code -eq 0 -and $origin -match '(?i)github\.com[:/]+[^/]+/the-curator(\.git)?/?$') {
          $kind = 'fork'
        } else {
          $kind = 'foreign'
        }
      }
    }
    Write-Log "checkout state: $kind"

    if ($kind -eq 'fork') {
      Stop-Install ("The folder $targetDir already holds a copy of The Curator from a different GitHub account ($origin), so the installer did not touch it.") `
        "If that is what you want, keep using it as it is. To install the official version, rename or move that folder (for example to 'the-curator-old'; your notes are in its domains folder), then run the installer again."
    }
    if ($kind -eq 'foreign') {
      Stop-Install ("The folder $targetDir already exists and holds something other than The Curator's official copy, so the installer did not touch it.") `
        "Rename or move that folder (for example to 'the-curator-old'), then run the installer again."
    }

    if ($kind -eq 'absent' -or $kind -eq 'empty') {
      $parent = Split-Path -Parent $targetDir
      [void][System.IO.Directory]::CreateDirectory($parent)
      $stage = Join-Path $parent '.the-curator-download'
      if (-not (Remove-Dir $stage)) { Stop-Install "A temporary folder from an earlier attempt could not be removed: $stage" 'Restart your PC and run the installer again.' }
      Say "        Downloading The Curator ($Branch)..."
      $r = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-c', 'core.autocrlf=false', 'clone', '--quiet', '--depth', '1', '--branch', $Branch, '--config', 'core.autocrlf=false', $cloneUrl, $stage))
      if ($r.Code -ne 0) {
        [void](Remove-Dir $stage)
        $advice = Get-NetworkAdvice $r.Text
        if (-not $advice) { $advice = 'Check that this PC is online and run the installer again.' }
        Stop-Install ("The Curator could not be downloaded from GitHub.") $advice
      }
      if ($kind -eq 'empty') { [void](Remove-Dir $targetDir) }
      try { Move-Dir -From $stage -To $targetDir } catch {
        Stop-Install ("The download finished but could not be moved into $targetDir.") 'Close any window showing that folder, wait a minute (antivirus may still be scanning), and run the installer again.'
      }
      Say "        The Curator is in $targetDir"
    } else {
      Say "        The Curator is already in $targetDir; checking it..."
      $r = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'status', '--porcelain=v1', '--untracked-files=no'))
      if ($r.Code -ne 0) {
        Stop-Install ("The copy of The Curator in $targetDir is damaged (git cannot read it).") `
          "Your notes are in $targetDir\domains. Rename the folder (for example to 'the-curator-old'), run the installer again, then copy the old 'domains' folder into the new one. Ask support if you are unsure."
      }
      # Only real status lines ("XY path"); git warnings share the stream.
      $changes = @($r.Text -split "`n" | Where-Object { $_ -match '^[ MADRCUT?!]{2} \S' })
      $restorable = $true
      foreach ($c in $changes) {
        $xy = $c.Substring(0, [Math]::Min(2, $c.Length))
        $p = ''
        if ($c.Length -gt 3) { $p = $c.Substring(3).Trim('"') }
        # Deleted files and an npm-rewritten package-lock.json are repairs, not edits.
        $ok = ($xy -eq ' D') -or ($xy -eq ' M' -and $p -eq 'package-lock.json')
        if (-not $ok) { $restorable = $false }
      }
      $clean = ($changes.Count -eq 0)
      if (-not $clean -and $restorable) {
        Say '        Restoring missing or regenerated files...'
        $r2 = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'checkout', '--', '.'))
        if ($r2.Code -eq 0) { $clean = $true }
      }
      if (-not $clean) {
        Say ("        Some of The Curator's own files in $targetDir were changed on this PC, so they were left exactly as they are and The Curator was not updated.") 'Yellow'
        Write-Log ("changed files:`n" + ($changes -join "`n"))
      } else {
        $r = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'fetch', '--quiet', 'origin', ("+refs/heads/" + $Branch + ":refs/remotes/origin/" + $Branch)))
        if ($r.Code -ne 0) {
          Say '        Could not check GitHub for a newer version; keeping the version you have.' 'Yellow'
        } else {
          $before = (Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'rev-parse', '--short', 'HEAD'))).Last
          $cur = (Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'))).Last
          if ($cur -eq $Branch) {
            $r = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'merge', '--ff-only', '--quiet', ("origin/" + $Branch)))
          } else {
            Say "        Switching from '$cur' to '$Branch'."
            $r = Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'checkout', '--quiet', '-B', $Branch, ("origin/" + $Branch)))
          }
          $after = (Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'rev-parse', '--short', 'HEAD'))).Last
          if ($r.Code -ne 0) {
            Say '        This copy could not be updated automatically; keeping the version you have. Use Settings > Check for updates inside The Curator.' 'Yellow'
          } elseif ($before -eq $after) {
            Say '        Already up to date.'
          } else {
            Say "        Updated ($before -> $after)."
          }
        }
      }
    }
    $state.Commit = (Invoke-Tool -Exe $git -ArgList (Get-GitArgs @('-C', $targetDir, 'rev-parse', '--short', 'HEAD'))).Last

    # The app reads .env; create an empty one, never overwrite.
    $envFile = Join-Path $targetDir '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { [System.IO.File]::WriteAllText($envFile, '', (New-Object System.Text.UTF8Encoding($false))) }

    # -------------------------------------------------------------- 5. npm --
    Start-Step 5 "Installing The Curator's components"
    # npm through node.exe + npm-cli.js by absolute path: no bare `npm`, no
    # npm.ps1 (execution policy), no npm.cmd (cmd.exe mis-parses &, ^ and %
    # in a user name).
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { Stop-Install 'The private Node.js is missing its npm tool.' 'Run the installer again.' }
    $lock = Join-Path $targetDir 'package-lock.json'
    $lockHash = 'none'
    if (Test-Path -LiteralPath $lock -PathType Leaf) { $lockHash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash.ToLowerInvariant() }
    $nmMarker = Join-Path $targetDir 'node_modules\.curator-installed.txt'
    $nmWant = "node=$NodeVersion lock=$lockHash"
    $nmOk = (Test-Path -LiteralPath $nmMarker -PathType Leaf) -and (([System.IO.File]::ReadAllText($nmMarker)).Trim() -eq $nmWant) -and (Test-Path -LiteralPath (Join-Path $targetDir 'node_modules\express\package.json') -PathType Leaf)
    if ($nmOk) {
      Say '        Components are already installed.'
    } else {
      $env:npm_config_update_notifier = 'false'
      $env:npm_config_fund = 'false'
      $env:npm_config_audit = 'false'
      if ($state.Proxy -and -not $savedEnv['npm_config_https_proxy'] -and -not $env:HTTPS_PROXY) {
        $env:npm_config_proxy = $state.Proxy
        $env:npm_config_https_proxy = $state.Proxy
      }
      $base = @($npmCli)
      $first = 'ci'
      if ($lockHash -eq 'none') { $first = 'install' }
      Say '        This can take a minute or two...'
      $r = Invoke-Tool -Exe $nodeExe -ArgList ($base + @($first, '--no-audit', '--no-fund', '--loglevel=error')) -Cwd $targetDir
      if ($r.Code -ne 0) {
        Write-Log 'npm failed once; retrying'
        if ($r.Text -match '(?i)SELF_SIGNED|UNABLE_TO_GET_ISSUER|unable to verify|CERT_') {
          # Trust the certificates Windows trusts (a company's own, for example).
          $env:NODE_OPTIONS = '--use-system-ca'
        }
        if ($r.Text -match '(?i)EINTEGRITY') {
          [void](Invoke-Tool -Exe $nodeExe -ArgList ($base + @('cache', 'clean', '--force')) -Cwd $targetDir)
        }
        if ($r.Text -match '(?i)EPERM|EBUSY') { Start-Sleep -Seconds 5 }
        $r = Invoke-Tool -Exe $nodeExe -ArgList ($base + @('install', '--no-audit', '--no-fund', '--loglevel=error')) -Cwd $targetDir
      }
      if ($r.Code -ne 0) {
        $advice = Get-NetworkAdvice $r.Text
        if (-not $advice) { $advice = 'Run the installer again. If it fails the same way, send the log to support.' }
        Stop-Install "The Curator's components could not be installed (npm failed)." $advice
      }
      [System.IO.File]::WriteAllText($nmMarker, $nmWant, (New-Object System.Text.UTF8Encoding($false)))
      Say '        Components installed.'
    }

    # --------------------------------------------------------- 6. shortcuts --
    Start-Step 6 'Adding icons to your desktop and Start menu'
    $startPs1 = Join-Path $targetDir 'scripts\windows\start-curator.ps1'
    $stopPs1 = Join-Path $targetDir 'scripts\windows\stop-curator.ps1'
    if (-not (Test-Path -LiteralPath $startPs1 -PathType Leaf) -or -not (Test-Path -LiteralPath $stopPs1 -PathType Leaf)) {
      Stop-Install ("The start and stop scripts are missing from $targetDir\scripts\windows.") 'Run the installer again. If your copy was changed on this PC, rename the folder first (your notes are in its domains folder).'
    }
    $startIco = Join-Path $targetDir 'scripts\windows\assets\curator-start.ico'
    $stopIco = Join-Path $targetDir 'scripts\windows\assets\curator-stop.ico'
    $places = @()
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) {
      $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop, [Environment+SpecialFolderOption]::DoNotVerify)
      if ($desktop) { try { [void][System.IO.Directory]::CreateDirectory($desktop) } catch { $desktop = '' } }
    }
    if ($desktop) { $places += $desktop }
    $programs = [Environment]::GetFolderPath('Programs')
    if ($programs) {
      $menu = Join-Path $programs 'The Curator'
      try { [void][System.IO.Directory]::CreateDirectory($menu); $places += $menu } catch { Write-Log ("Start menu folder failed: " + $_.Exception.Message) }
    }
    $made = 0
    foreach ($place in $places) {
      try {
        New-Shortcut -Path (Join-Path $place 'The Curator.lnk') -Script $startPs1 -Icon $startIco -Description 'Start The Curator and open it in your browser'
        New-Shortcut -Path (Join-Path $place 'Stop The Curator.lnk') -Script $stopPs1 -Icon $stopIco -Description 'Stop The Curator'
        $made++
        Say "        Added to $place"
      } catch {
        # Controlled folder access (ransomware protection) can block the Desktop.
        Say ("        Could not add icons to $place (" + $_.Exception.Message + ').') 'Yellow'
      }
    }
    if ($made -eq 0) {
      Say ("        No icons could be added. You can start The Curator by double-clicking  $startPs1  with the right mouse button > Run with PowerShell.") 'Yellow'
    }

    # ------------------------------------------------------------- 7. start --
    if ($NoStart) {
      Start-Step 7 'Starting The Curator (skipped: -NoStart)'
      if ($state.StoppedApp) { Say "        The Curator was stopped for the update. Double-click 'The Curator' to start it again." }
    } else {
      Start-Step 7 'Starting The Curator'
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      # NOT through Invoke-Tool: its output goes straight to this window. The
      # start script launches the server with ShellExecute, so the server
      # holds none of our handles and this call returns once it is up.
      Write-Log ("> `"$ps`" -File `"$startPs1`"")
      $oldEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & $ps -NoProfile -ExecutionPolicy Bypass -File $startPs1
      $startCode = $LASTEXITCODE
      $ErrorActionPreference = $oldEap
      Write-Log "  (exit code $startCode)"
      if ($startCode -ne 0) {
        Stop-Install 'The Curator was installed, but it did not start.' "The message above (and the log file) says why. After fixing it, double-click 'The Curator' on your desktop."
      }
    }

    Write-Host ''
    Write-Host '  ===========================================================' -ForegroundColor Green
    Write-Host '    Done. The Curator is installed.' -ForegroundColor Green
    Write-Host '  ===========================================================' -ForegroundColor Green
    Write-Host ''
    if (-not $NoStart) { Write-Host '  The Curator is running and opens in your web browser.' }
    Write-Host "  Next time, double-click 'The Curator' on your desktop."
    Write-Host "  To stop it, double-click 'Stop The Curator'."
    Write-Host ''
    Write-Host "  Your notes are kept in:  $targetDir\domains"
    Write-Host '  Running this installer again is safe: it repairs and updates, and keeps your notes.'
    Write-Host ''
    Write-Log 'install finished OK'
    $global:LASTEXITCODE = 0
  } catch {
    $ex = $_.Exception
    $todo = ''
    if ($ex.Data -and $ex.Data['CuratorTodo']) { $todo = [string]$ex.Data['CuratorTodo'] }
    $inner = $ex
    while ($inner.InnerException) { $inner = $inner.InnerException }
    $msg = $inner.Message
    if ($todo) { $msg = $ex.Message }
    Write-Log ("FAILED at '" + $state.Step + "': " + $msg)
    try { Write-Log ($_.ScriptStackTrace) } catch { }
    Write-Host ''
    Write-Host '  ===========================================================' -ForegroundColor Red
    Write-Host '    The installation stopped.' -ForegroundColor Red
    Write-Host '  ===========================================================' -ForegroundColor Red
    Write-Host ''
    Write-Host ("  What happened: " + $msg)
    if ($todo) { Write-Host ("  What to do:    " + $todo) } else { Write-Host '  What to do:    Run the installer again. If it stops at the same place, send the text below to whoever helps you with The Curator.' }
    Write-Host '  Nothing you had before was deleted. Running the installer again is safe.'
    if ($state.StoppedApp) { Write-Host "  The Curator was stopped for the update; double-click 'The Curator' to start it again." }
    Write-Host ''
    Write-Host '  ----- copy from here -----'
    Write-Host '  The Curator Windows installer'
    Write-Host ("  Step:     " + $state.Step)
    Write-Host ("  Error:    " + $msg)
    Write-Host ("  Branch:   " + $Branch + '   Commit: ' + $state.Commit)
    Write-Host ("  Windows:  " + [Environment]::OSVersion.Version.ToString() + ' ' + $state.Arch + '   PowerShell ' + $PSVersionTable.PSVersion.ToString())
    if ($state.Log) { Write-Host ("  Log file: " + $state.Log) }
    Write-Host '  ----- copy to here -----'
    Write-Host ''
    $global:LASTEXITCODE = 1
  } finally {
    foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
    if ($null -ne $savedTls) { try { [System.Net.ServicePointManager]::SecurityProtocol = $savedTls } catch { } }
  }
}

Install-TheCurator -Branch $Branch -NoStart:$NoStart -InstallDir $InstallDir -RepoUrl $RepoUrl
# Under `irm | iex` the function and the four parameters land in the user's
# own session: tidy them away ($LASTEXITCODE is global and stays).
Remove-Item -Path 'Function:\Install-TheCurator' -ErrorAction SilentlyContinue
Remove-Variable -Name 'Branch', 'NoStart', 'InstallDir', 'RepoUrl' -ErrorAction SilentlyContinue
