#Requires -Version 5.1
<#
.SYNOPSIS
  Squorli Server: the management command of an installation on Windows. The counterpart of the helper "squorli" that
  deploy/install.sh writes on Linux.

.DESCRIPTION
  Called as "squorli" through bin\squorli.cmd, which the setup puts into the PATH, in a window opened as administrator:

    squorli status                     the services, and whether the app server answers
    squorli logs [service] [-Follow]   the last 200 lines of the logs; -Follow keeps reading
    squorli restart [service]          everything, or one service with the services that need it
    squorli stop [service]
    squorli start [service]
    squorli backup [folder]            database, files and .env into <folder>\<time> (default: the data folder's backups)
    squorli restore <folder> [-Yes]    replaces database and files by a backup, also by one made on Linux
    squorli update [-Version x.y.z]    the newest release from GitHub; -Package <file or address> takes that ZIP
    squorli update -Check              only looks for a newer release: exit code 10 when there is one, 0 when not
    squorli autoupdate [on|off]        a task that looks for a new version every 1 to 24 hours and installs it
    squorli doctor                     the setup check (docs/features/doctor.md)

  Services: server, postgres, livekit, caddy ("app" means server).
  Details: deploy/windows/AGENTS.md, docs/features/windows.md.

  This file is UTF-8 with a byte order mark: Windows PowerShell 5.1 reads the German texts wrong without it.
#>
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Target = '',
  [Alias('f')][switch]$Follow,
  [Alias('y')][switch]$Yes,
  [string]$Version = '',
  # update: a package's ZIP (a file or an address) in place of the release on GitHub; its .sha256 file lies next to it.
  [string]$Package = '',
  # update: look for a newer release and change nothing.
  [switch]$Check,
  # update: the run of the scheduled task (no question, one line per run in logs\autoupdate.log).
  [switch]$Auto,
  # autoupdate on: the hours between two runs, 1 to 24.
  [int]$Hours = 0,
  # Only for an installation whose data folder cannot be read from its service file.
  [string]$DataDir = '',
  [Alias('h')][switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repository = 'danielklessa/squorli-server'
# The task of Windows' scheduler that runs the automatic updates
$TaskName = 'SquorliAutoUpdate'
$Utf8 = New-Object Text.UTF8Encoding $false
# The command's names and the Windows services, in the order they start; they stop the other way round.
$Services = [ordered]@{ postgres = 'SquorliPostgres'; livekit = 'SquorliLiveKit'; server = 'SquorliServer'; caddy = 'SquorliCaddy' }
# What a service needs running (the <depend> entries of the service files).
$Needs = @{ postgres = @(); livekit = @(); server = @('postgres', 'livekit'); caddy = @('server') }
$SidSystem = 'S-1-5-18'; $SidAdministrators = 'S-1-5-32-544'
$S = @{ Lang = 'en'; EnvLines = @() }

# ---- Output
function T([string]$de, [string]$en) { if ($S.Lang -eq 'de') { $de } else { $en } }
function Step([string]$text) { Write-Host ''; Write-Host '---- ' -ForegroundColor Blue -NoNewline; Write-Host $text -ForegroundColor White }
function Ok([string]$text) { Write-Host '  ok ' -ForegroundColor Green -NoNewline; Write-Host $text }
function Warn([string]$text) { Write-Host "  !  $text" -ForegroundColor Yellow }
function Bad([string]$text) { Write-Host "  x  $text" -ForegroundColor Red }
function Note([string]$text) { Write-Host "     $text" -ForegroundColor DarkGray }
function Die([string]$text) { Write-Host ''; Write-Host "x $text" -ForegroundColor Red; Write-AutoLog "x $text"; exit 1 }
# The log of the automatic updates: one line per run and result. Only the run of the scheduled task writes it.
function Write-AutoLog([string]$text) {
  if (-not $S.ContainsKey('AutoLog')) { return }
  try { [IO.File]::AppendAllText($S.AutoLog, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text`r`n", $Utf8) } catch { }
}

# ---- Programs. stderr never stops the script by itself (Windows PowerShell 5.1 turns a redirected stderr line into an
# error), the exit code decides.
function Invoke-Program([string]$file, [string[]]$arguments, [int[]]$ok = @(0), [switch]$Quiet) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $file @arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  $failed = ($ok -notcontains $code)
  if ($failed -or -not $Quiet) { foreach ($line in $lines) { if ($line.Trim()) { Note $line } } }
  if ($failed) { throw "$([IO.Path]::GetFileName($file)) -> $code" }
  return $lines
}

# ---- The installation
function Test-Admin {
  $me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
  return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# .env is data: single lines are read, the file is never run.
function Env-Get([string]$key) {
  $value = ''
  foreach ($line in $S.EnvLines) { if ($line.StartsWith("$key=")) { $value = $line.Substring($key.Length + 1) } }
  $value = $value.Trim()
  if ($value.Length -ge 2 -and (($value[0] -eq "'" -and $value[-1] -eq "'") -or ($value[0] -eq '"' -and $value[-1] -eq '"'))) { $value = $value.Substring(1, $value.Length - 2) }
  return $value
}
function Env-Port([string]$key, [int]$default) {
  $value = Env-Get $key
  if ($value -match '^\d+$') { return [int]$value }
  return $default
}

# Where the programs and the data are. The data folder is the one the app server's service writes its log into.
function Find-Installation {
  $S.InstallDir = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
  $S.DataDir = Join-Path $env:ProgramData 'Squorli'
  if ($DataDir) { $S.DataDir = $DataDir }
  else {
    $file = Join-Path $S.InstallDir 'winsw\SquorliServer.xml'
    if (Test-Path -LiteralPath $file) {
      try {
        $logs = "$(([xml][IO.File]::ReadAllText($file, $Utf8)).service.logpath)".Trim()
        if ($logs) { $S.DataDir = Split-Path -Parent $logs }
      } catch { }
    }
  }
  $S.DataDir = [IO.Path]::GetFullPath($S.DataDir).TrimEnd('\')
  $S.EnvFile = Join-Path $S.DataDir '.env'
  $S.Logs = Join-Path $S.DataDir 'logs'
  if ((Get-UICulture).TwoLetterISOLanguageName -eq 'de') { $S.Lang = 'de' }
  try {
    $S.EnvLines = [IO.File]::ReadAllLines($S.EnvFile, $Utf8)
    $stored = Env-Get 'SQUORLI_LANG'
    if ($stored -eq 'de' -or $stored -eq 'en') { $S.Lang = $stored }
  } catch { $S.EnvLines = @() }
}

# Every command but help: an installation, and the rights to read its files and control its services.
function Assert-Installation {
  if (-not (Test-Path -LiteralPath (Join-Path $S.InstallDir 'manifest.json'))) {
    Die (T "In $($S.InstallDir) liegt keine Squorli-Installation (manifest.json fehlt)." "$($S.InstallDir) holds no Squorli installation (manifest.json is missing).")
  }
  if (-not (Test-Admin)) {
    Die (T 'Dieser Befehl braucht Administratorrechte: die Einstellungen, Logs und Dienste sind nur für Administratoren zugänglich. Bitte ein Fenster als Administrator öffnen (Rechtsklick auf Start > Terminal (Administrator)).' 'This command needs administrator rights: the settings, logs and services are open to administrators only. Please open a window as administrator (right-click Start > Terminal (Admin)).')
  }
  if ($S.EnvLines.Count -eq 0) {
    Die (T "$($S.EnvFile) fehlt oder ist leer: in $($S.DataDir) gibt es keine Installation. Liegen die Daten woanders: squorli <Befehl> -DataDir <Ordner>" "$($S.EnvFile) is missing or empty: $($S.DataDir) holds no installation. If the data is elsewhere: squorli <command> -DataDir <folder>")
  }
  $S.Setup = Env-Get 'SQUORLI_SETUP'
  $S.Domain = Env-Get 'PUBLIC_DOMAIN'
  $S.AppPort = Env-Port 'APP_PORT' 3000
  $S.PostgresPort = Env-Port 'POSTGRES_PORT' 5432
  $S.LiveKitHttpPort = Env-Port 'LIVEKIT_HTTP_PORT' 7880
  # With a proxy on another machine the app server listens on this machine's LAN address only
  $S.Host = Env-Get 'LISTEN_HOST'
  if (-not $S.Host -or $S.Host -eq '0.0.0.0') { $S.Host = '127.0.0.1' }
  $S.Data = Env-Get 'DATA_DIR'
  if (-not $S.Data -or -not [IO.Path]::IsPathRooted($S.Data)) { $S.Data = Join-Path $S.DataDir 'data' }
  $S.Bin = Join-Path $S.InstallDir 'pgsql\bin'
}

# A folder or file the person named, seen from where they stand.
function Resolve-Place([string]$path) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path).TrimEnd('\') }

# Access for SYSTEM and administrators only; a folder hands it down.
function Set-Access([string]$path) {
  if (Test-Path -LiteralPath $path -PathType Container) { $down = '(OI)(CI)' } else { $down = '' }
  $null = Invoke-Program 'icacls.exe' @($path, '/inheritance:r', '/grant:r', "*${SidSystem}:${down}F", '/grant:r', "*${SidAdministrators}:${down}F", '/Q') -Quiet
}

function Copy-Folder([string]$from, [string]$to) {
  $null = Invoke-Program 'robocopy.exe' @($from, $to, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:3', '/W:2') -ok @(0, 1, 2, 3, 4, 5, 6, 7) -Quiet
}

# By .NET: Get-FileHash is a script function of a module, and Windows PowerShell does not find it when it was started
# from a PowerShell 7 window (that one's module path comes along).
function Get-Sha256([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($path)
  try { return (-join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })) } finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-Manifest([string]$folder) {
  $file = Join-Path $folder 'manifest.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return ([IO.File]::ReadAllText($file, $Utf8) | ConvertFrom-Json) } catch { return $null }
}

# ---- Services
function Resolve-Key([string]$word) {
  $w = $word.ToLowerInvariant()
  # The app server's service was named "app" on Linux until 28 September 2026
  if ($w -eq 'app') { $w = 'server' }
  foreach ($key in $Services.Keys) { if ($w -eq $key -or $w -eq $Services[$key].ToLowerInvariant()) { return $key } }
  Die (T "Den Dienst '$word' gibt es nicht. Dienste: $($Services.Keys -join ', ')" "There is no service '$word'. Services: $($Services.Keys -join ', ')")
}
# What Windows knows about a service: Name, State, StartMode, StartName; nothing when it is not registered.
function Get-ServiceInfo([string]$key) {
  return (Get-CimInstance -ClassName Win32_Service -Filter "Name='$($Services[$key])'" -ErrorAction SilentlyContinue | Select-Object -First 1)
}
function Test-Running([string]$key) {
  $info = Get-ServiceInfo $key
  return ($null -ne $info -and $info.State -eq 'Running')
}
function Get-Present { return @($Services.Keys | Where-Object { $null -ne (Get-ServiceInfo $_) }) }
# The given names in the order of a start, or of a stop.
function Get-Ordered([string[]]$keys, [switch]$Reverse) {
  $list = @($Services.Keys | Where-Object { $keys -contains $_ })
  if ($Reverse) { [array]::Reverse($list) }
  return $list
}
# The services that need this one, directly or through another.
function Get-Dependents([string]$key) {
  $found = @()
  foreach ($other in $Services.Keys) { if ($Needs[$other] -contains $key) { $found += $other; $found += @(Get-Dependents $other) } }
  return @($found | Select-Object -Unique)
}
# The services this one needs, directly or through another.
function Get-Requirements([string]$key) {
  $found = @()
  foreach ($other in $Needs[$key]) { $found += $other; $found += @(Get-Requirements $other) }
  return @($found | Select-Object -Unique)
}

function Show-LogTail([string]$key, [int]$lines = 15) {
  foreach ($file in @(Get-ChildItem -LiteralPath $S.Logs -Filter "$($Services[$key])*" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
    Write-Host "  $($file.FullName):" -ForegroundColor DarkGray
    Get-Content -LiteralPath $file.FullName -Tail $lines -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Note $_ }
  }
}

function Start-One([string]$key) {
  $name = $Services[$key]
  try {
    Start-Service -Name $name -ErrorAction Stop
    (Get-Service -Name $name).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
  } catch { Show-LogTail $key; throw (T "$key ($name) startet nicht: $($_.Exception.Message)" "$key ($name) does not start: $($_.Exception.Message)") }
  Ok (T "$key gestartet" "$key started")
}
function Stop-One([string]$key) {
  $name = $Services[$key]
  try {
    Stop-Service -Name $name -Force -ErrorAction Stop
    (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  } catch { throw (T "$key ($name) lässt sich nicht anhalten: $($_.Exception.Message)" "$key ($name) cannot be stopped: $($_.Exception.Message)") }
  Ok (T "$key angehalten" "$key stopped")
}

# The words of a command line as services: none = every service of this installation.
function Get-Named([string[]]$words) {
  $present = Get-Present
  if ($words.Count -eq 0) { return $present }
  $keys = @()
  foreach ($word in $words) {
    $key = Resolve-Key $word
    if ($present -notcontains $key) { Die (T "Der Dienst $key ($($Services[$key])) ist in dieser Installation nicht eingerichtet." "The service $key ($($Services[$key])) is not set up in this installation.") }
    $keys += $key
  }
  return $keys
}

function Stop-Services([string[]]$keys) {
  $all = @($keys)
  foreach ($key in $keys) { $all += @(Get-Dependents $key) }
  $stopped = @()
  foreach ($key in (Get-Ordered $all -Reverse)) {
    $info = Get-ServiceInfo $key
    if ($null -eq $info -or $info.State -eq 'Stopped') { continue }
    Stop-One $key
    $stopped += $key
  }
  return $stopped
}
function Start-Services([string[]]$keys) {
  $all = @($keys)
  foreach ($key in $keys) { $all += @(Get-Requirements $key) }
  $present = Get-Present
  foreach ($key in (Get-Ordered $all)) {
    if ($present -notcontains $key -or (Test-Running $key)) { continue }
    Start-One $key
  }
}

# ---- The app server's answers
function Get-Web([string]$url, [hashtable]$headers = @{}, [int]$timeout = 10) {
  try {
    $r = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec $timeout
    # The bytes, not .Content: Windows PowerShell 5.1 reads an answer without a named character set as Latin-1
    return @{ Status = [int]$r.StatusCode; Text = $Utf8.GetString($r.RawContentStream.ToArray()); Error = '' }
  } catch {
    $response = $null
    if ($_.Exception -is [Net.WebException]) { $response = $_.Exception.Response }
    if ($response) { return @{ Status = [int]$response.StatusCode; Text = ''; Error = "HTTP $([int]$response.StatusCode)" } }
    return @{ Status = 0; Text = ''; Error = $_.Exception.Message }
  }
}
function Get-HealthUrl { return "http://$($S.Host):$($S.AppPort)/api/health" }
# What /api/health says, or nothing after the given number of tries (two seconds apart).
function Get-Health([int]$tries = 1) {
  foreach ($i in 1..$tries) {
    $r = Get-Web (Get-HealthUrl) @{} 5
    if ($r.Status -eq 200) { try { return ($r.Text | ConvertFrom-Json) } catch { } }
    if ($i -lt $tries) { Start-Sleep -Seconds 2 }
  }
  return $null
}
function Show-Health([int]$tries = 1) {
  $info = Get-Health $tries
  if ($null -eq $info) {
    Bad (T "$(Get-HealthUrl) antwortet nicht (squorli logs server)" "$(Get-HealthUrl) does not answer (squorli logs server)")
    return $false
  }
  Ok "$(Get-HealthUrl) (domain $($info.domain), version $($info.version))"
  return $true
}

function Show-Services {
  $good = $true
  Write-Host ("  {0,-9} {1,-16} {2,-12} {3,-9} {4}" -f (T 'Dienst' 'Service'), 'Windows', (T 'Zustand' 'State'), 'Start', (T 'Konto' 'Account')) -ForegroundColor DarkGray
  foreach ($key in $Services.Keys) {
    $info = Get-ServiceInfo $key
    if ($null -eq $info) {
      # Caddy belongs to the bundled mode only
      if ($key -eq 'caddy' -and $S.Setup -ne 'bundled') { continue }
      Write-Host ("  {0,-9} {1,-16} " -f $key, $Services[$key]) -NoNewline
      Write-Host (T 'fehlt' 'missing') -ForegroundColor Red
      $good = $false
      continue
    }
    switch ($info.State) {
      'Running' { $state = T 'läuft' 'running' }
      'Stopped' { $state = T 'angehalten' 'stopped' }
      'Start Pending' { $state = T 'startet' 'starting' }
      'Stop Pending' { $state = T 'hält an' 'stopping' }
      default { $state = "$($info.State)" }
    }
    if ($info.State -eq 'Running') { $color = 'Green' } else { $color = 'Red'; $good = $false }
    Write-Host ("  {0,-9} {1,-16} " -f $key, $info.Name) -NoNewline
    Write-Host ("{0,-12} " -f $state) -ForegroundColor $color -NoNewline
    Write-Host ("{0,-9} {1}" -f $info.StartMode, $info.StartName)
  }
  return $good
}

# ---- Commands
function Invoke-Status {
  $services = Show-Services
  Write-Host ''
  $health = Show-Health
  if (-not $services -or -not $health) { exit 1 }
}

# The log files of a service, the quiet ones first. WinSW writes <name>.out.log, <name>.err.log and its own
# <name>.wrapper.log, PostgreSQL one file per weekday. Which of out and err a program fills differs, so both count.
function Get-LogSources([string]$key) {
  $name = $Services[$key]
  if ($key -eq 'postgres') { return @(@{ Label = $key; Pattern = "$name-*.log"; Lines = 200; Main = $true }) }
  return @(
    @{ Label = "$key, WinSW"; Pattern = "$name.wrapper.log"; Lines = 20; Main = $false },
    @{ Label = "$key, stderr"; Pattern = "$name.err.log"; Lines = 200; Main = $false },
    @{ Label = $key; Pattern = "$name.out.log"; Lines = 200; Main = $true })
}
# The newest file of a source (PostgreSQL starts another one at midnight), or nothing.
function Find-LogFile([hashtable]$source) {
  return (Get-ChildItem -LiteralPath $S.Logs -Filter $source.Pattern -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}
# Opens a file a service is writing, without standing in its way (WinSW renames a full file).
function Open-Log([string]$path) {
  return New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]'ReadWrite, Delete'))
}
# The last whole lines of an open file; leaves the stream behind the last line feed, where reading on starts.
function Read-Tail([IO.FileStream]$stream, [int]$count) {
  $start = [Math]::Max([long]0, $stream.Length - 1MB)
  $null = $stream.Seek($start, [IO.SeekOrigin]::Begin)
  $buffer = New-Object byte[] ([int]($stream.Length - $start))
  $read = 0
  while ($read -lt $buffer.Length) {
    $n = $stream.Read($buffer, $read, $buffer.Length - $read)
    if ($n -le 0) { break }
    $read += $n
  }
  $end = -1
  if ($read -gt 0) { $end = [Array]::LastIndexOf($buffer, [byte]10, $read - 1) }
  if ($end -lt 0) { $null = $stream.Seek($start, [IO.SeekOrigin]::Begin); return @() }
  $null = $stream.Seek($start + $end + 1, [IO.SeekOrigin]::Begin)
  $lines = @($Utf8.GetString($buffer, 0, $end).Split("`n") | ForEach-Object { $_.TrimEnd("`r") })
  # The first one is cut when the file is longer than what was read
  if ($start -gt 0 -and $lines.Count -gt 1) { $lines = @($lines[1..($lines.Count - 1)]) }
  if ($lines.Count -gt $count) { $lines = @($lines[($lines.Count - $count)..($lines.Count - 1)]) }
  return $lines
}
function Write-LogLine([string]$prefix, [string]$line) {
  if ($prefix) { Write-Host "$prefix | " -ForegroundColor DarkCyan -NoNewline }
  Write-Host $line
}

# Is the file under this path another one than the open one? WinSW renames a full file and starts a new one under the
# old name. The sizes are read from the open files: what the folder says about a file in use lags behind.
function Test-Replaced([IO.FileStream]$stream, [string]$path) {
  try { $probe = Open-Log $path } catch { return $false }
  try {
    $before = $stream.Length
    $other = $probe.Length
    return ($before -eq $stream.Length -and $other -ne $before)
  } finally { $probe.Dispose() }
}

function Invoke-Logs([string[]]$words) {
  $sources = @()
  foreach ($key in (Get-Named $words)) { $sources += @(Get-LogSources $key) }
  $width = ($sources | ForEach-Object { $_.Label.Length } | Measure-Object -Maximum).Maximum
  foreach ($source in $sources) {
    $source.Path = ''; $source.Stream = $null; $source.Reader = $null; $source.Prefix = ''
    if ($sources.Count -gt 1) { $source.Prefix = $source.Label.PadRight($width) }
    $file = Find-LogFile $source
    if ($null -ne $file) {
      try { $source.Stream = Open-Log $file.FullName; $source.Path = $file.FullName } catch { Warn "$($file.FullName): $($_.Exception.Message)" }
    }
    if ($null -ne $source.Stream -and ($source.Main -or $source.Stream.Length -gt 0)) {
      Write-Host "==> $($source.Label): $($source.Path)" -ForegroundColor DarkGray
      foreach ($line in (Read-Tail $source.Stream $source.Lines)) { Write-Host $line }
    } elseif ($null -eq $file -and $source.Main) {
      Write-Host "==> $($source.Label): $(T 'noch kein Log in' 'no log yet in') $($S.Logs)" -ForegroundColor DarkGray
    }
  }
  if (-not $Follow) {
    foreach ($source in $sources) { if ($null -ne $source.Stream) { $source.Stream.Dispose() } }
    return
  }

  Write-Host "==> $(T 'Warte auf neue Zeilen, Ende mit Strg+C' 'Waiting for new lines, Ctrl+C ends')" -ForegroundColor DarkGray
  foreach ($source in $sources) { if ($null -ne $source.Stream) { $source.Reader = New-Object IO.StreamReader($source.Stream, $Utf8) } }
  $round = 0
  while ($true) {
    foreach ($source in $sources) {
      if ($null -ne $source.Reader) {
        # Emptied in place (PostgreSQL does that with last week's file): from its start
        if ($source.Stream.Length -lt $source.Stream.Position) {
          $null = $source.Stream.Seek(0, [IO.SeekOrigin]::Begin)
          $source.Reader.DiscardBufferedData()
        }
        while ($null -ne ($line = $source.Reader.ReadLine())) { Write-LogLine $source.Prefix $line }
      }
      # Every two seconds: another file under this name (the first start, a full file replaced, a new weekday)?
      if ($round % 4 -ne 0) { continue }
      $file = Find-LogFile $source
      if ($null -eq $file) { continue }
      if ($file.FullName -eq $source.Path -and -not (Test-Replaced $source.Stream $source.Path)) { continue }
      if ($null -ne $source.Reader) {
        while ($null -ne ($line = $source.Reader.ReadLine())) { Write-LogLine $source.Prefix $line }
        $source.Reader.Dispose()
      }
      $source.Reader = $null; $source.Stream = $null; $source.Path = ''
      try {
        $source.Stream = Open-Log $file.FullName
        $source.Reader = New-Object IO.StreamReader($source.Stream, $Utf8)
        $source.Path = $file.FullName
      } catch { }
    }
    $round++
    Start-Sleep -Milliseconds 500
  }
}

function Invoke-Restart([string[]]$words) {
  $keys = Get-Named $words
  $stopped = @(Stop-Services $keys)
  Start-Services (@($keys) + $stopped)
  if ((@($keys) + $stopped) -contains 'server') { if (-not (Show-Health 30)) { exit 1 } }
}
function Invoke-Stop([string[]]$words) { $null = Stop-Services (Get-Named $words) }
function Invoke-Start([string[]]$words) {
  $keys = Get-Named $words
  Start-Services $keys
  if ($keys -contains 'server') { if (-not (Show-Health 30)) { exit 1 } }
}

# ---- Backup and restore. The names and the structure of the Linux helper: squorli-database.sql, the files, env.
function Invoke-Postgres([string]$program, [string[]]$arguments) {
  $env:PGPASSWORD = Env-Get 'POSTGRES_PASSWORD'
  try { return (Invoke-Program (Join-Path $S.Bin $program) (@('-h', '127.0.0.1', '-p', "$($S.PostgresPort)", '-U', 'chat', '-w') + $arguments) -Quiet) }
  finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}
function Test-Postgres([int]$tries = 1) {
  foreach ($i in 1..$tries) {
    try { $null = Invoke-Program (Join-Path $S.Bin 'pg_isready.exe') @('-h', '127.0.0.1', '-p', "$($S.PostgresPort)", '-q') -Quiet; return $true } catch { }
    if ($i -lt $tries) { Start-Sleep -Seconds 1 }
  }
  return $false
}

# Writes the files below a folder into a ZIP with forward slashes, as every other system reads it. A file that goes away
# meanwhile (an upload's temporary file) is left out; one the server holds open is read all the same.
function Write-Zip([string]$folder, [string]$zipPath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $base = $folder.TrimEnd('\') + '\'
  $count = 0
  $out = New-Object IO.FileStream($zipPath, [IO.FileMode]::CreateNew)
  try {
    $zip = New-Object IO.Compression.ZipArchive($out, [IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($directory in [IO.Directory]::GetDirectories($folder, '*', [IO.SearchOption]::AllDirectories)) {
        $null = $zip.CreateEntry($directory.Substring($base.Length).Replace('\', '/') + '/')
      }
      foreach ($file in [IO.Directory]::GetFiles($folder, '*', [IO.SearchOption]::AllDirectories)) {
        try { $in = New-Object IO.FileStream($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]'ReadWrite, Delete')) }
        catch [IO.FileNotFoundException] { continue }
        catch [IO.DirectoryNotFoundException] { continue }
        try {
          # Attachments are pictures and videos for the most part: they do not get smaller, so speed counts
          $entry = $zip.CreateEntry($file.Substring($base.Length).Replace('\', '/'), [IO.Compression.CompressionLevel]::Fastest)
          $entry.LastWriteTime = [IO.File]::GetLastWriteTime($file)
          $to = $entry.Open()
          try { $in.CopyTo($to) } finally { $to.Dispose() }
        } finally { $in.Dispose() }
        $count++
      }
    } finally { $zip.Dispose() }
  } finally { $out.Dispose() }
  return $count
}
# Unpacks a ZIP into a folder; an entry that would land outside stops it.
function Read-Zip([string]$zipPath, [string]$folder) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $base = [IO.Path]::GetFullPath($folder).TrimEnd('\') + '\'
  $count = 0
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('/', '\')
      $target = [IO.Path]::GetFullPath((Join-Path $base $name))
      if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw (T "Die Sicherung enthält einen Pfad außerhalb des Zielordners: $($entry.FullName)" "The backup holds a path outside the target folder: $($entry.FullName)") }
      if ($name.EndsWith('\')) { $null = [IO.Directory]::CreateDirectory($target); continue }
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $count++
    }
  } finally { $zip.Dispose() }
  return $count
}

# Returns the folder of the new backup.
function New-Backup([string]$root) {
  if ($root) { $root = Resolve-Place $root } else { $root = Join-Path $S.DataDir 'backups' }
  if (-not (Test-Postgres)) { Die (T "PostgreSQL antwortet nicht auf 127.0.0.1:$($S.PostgresPort). Läuft der Dienst? (squorli status, squorli start postgres)" "PostgreSQL does not answer on 127.0.0.1:$($S.PostgresPort). Is the service running? (squorli status, squorli start postgres)") }
  $dest = Join-Path $root (Get-Date -Format 'yyyyMMdd-HHmmss')
  $null = New-Item -ItemType Directory -Force -Path $dest
  try {
    # Closed before anything is written: the backup holds every secret of the installation
    Set-Access $dest
    $null = Invoke-Postgres 'pg_dump.exe' @('-d', 'chat', '-f', (Join-Path $dest 'squorli-database.sql'))
    $files = Write-Zip $S.Data (Join-Path $dest 'squorli-files.zip')
    Copy-Item -LiteralPath $S.EnvFile -Destination (Join-Path $dest 'env')
  } catch {
    # Half a backup must not look like a whole one
    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    Die (T "Die Sicherung ist fehlgeschlagen: $($_.Exception.Message)" "The backup failed: $($_.Exception.Message)")
  }
  $size = (Get-ChildItem -LiteralPath $dest -File | Measure-Object -Property Length -Sum).Sum
  Note (T "Datenbank, Dateien ($files) und .env, zusammen $([Math]::Ceiling($size / 1MB)) MB; nur für Administratoren lesbar" "database, files ($files) and .env, $([Math]::Ceiling($size / 1MB)) MB together; readable by administrators only")
  return $dest
}
function Invoke-Backup([string]$root) {
  $dest = New-Backup $root
  Write-Host "$(T 'Sicherung' 'Backup'): $dest"
}

function Invoke-Restore([string]$folder) {
  $usage = T 'squorli restore <Ordner> [-Yes]   (ein Ordner, den squorli backup geschrieben hat, auch von einer Linux-Installation)' 'squorli restore <folder> [-Yes]   (a folder written by squorli backup, also by an installation on Linux)'
  if (-not $folder) { Write-Host $usage; exit 1 }
  $src = Resolve-Place $folder
  $sql = Join-Path $src 'squorli-database.sql'
  # Windows writes a ZIP, Linux a tar.gz
  $archive = Join-Path $src 'squorli-files.zip'
  if (-not (Test-Path -LiteralPath $archive)) { $archive = Join-Path $src 'squorli-files.tar.gz' }
  if (-not (Test-Path -LiteralPath $sql) -or -not (Test-Path -LiteralPath $archive)) { Write-Host $usage; exit 1 }

  Write-Host (T "Das ersetzt die Datenbank und alle Dateien dieser Installation durch die Sicherung in $src." "This replaces the database and all files of this installation with the backup in $src.")
  if (-not $Yes) {
    $answer = (Read-Host (T 'Zum Fortfahren ja eingeben' 'Type yes to continue')).Trim().ToLowerInvariant()
    if (@('yes', 'ja') -notcontains $answer) { Write-Host (T 'Abgebrochen.' 'Cancelled.'); exit 1 }
  }

  $null = Stop-Services @('server')
  Start-Services @('postgres')
  if (-not (Test-Postgres 30)) { Die (T "PostgreSQL antwortet nicht auf 127.0.0.1:$($S.PostgresPort) (squorli logs postgres)." "PostgreSQL does not answer on 127.0.0.1:$($S.PostgresPort) (squorli logs postgres).") }
  try {
    $null = Invoke-Postgres 'psql.exe' @('-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE IF EXISTS chat WITH (FORCE)', '-c', 'CREATE DATABASE chat OWNER chat')
    $null = Invoke-Postgres 'psql.exe' @('-d', 'chat', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', $sql)
  } catch {
    Die (T "Die Datenbank ließ sich nicht zurückspielen ($($_.Exception.Message)). Der App-Server bleibt angehalten, die Dateien sind unverändert; nach der Korrektur squorli restore noch einmal ausführen." "The database could not be restored ($($_.Exception.Message)). The app server stays stopped, the files are unchanged; run squorli restore again after the fix.")
  }
  Ok (T 'Datenbank zurückgespielt' 'Database restored')

  # The folder itself stays: it carries the access rights of the app server's service, and what is unpacked inherits them
  $null = New-Item -ItemType Directory -Force -Path $S.Data
  Get-ChildItem -LiteralPath $S.Data -Force | Remove-Item -Recurse -Force
  if ($archive.EndsWith('.zip')) { $null = Read-Zip $archive $S.Data }
  else { $null = Invoke-Program (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xzf', $archive, '-C', $S.Data) -Quiet }
  $count = @(Get-ChildItem -LiteralPath $S.Data -Recurse -File -Force).Count
  Ok (T "Dateien zurückgespielt ($count)" "Files restored ($count)")

  Start-Services (Get-Present)
  $up = Show-Health 30
  Write-Host ''
  Write-Host (T "Zurückgespielt aus $src. Die .env blieb, wie sie ist; die Kopie der Sicherung ist $src\env (PUBLIC_DOMAIN, OWNER_PUBLIC_KEY und DIRECTORY_URL sollten zu ihr passen)." "Restored from $src. The .env was left as it is; the backup's copy is $src\env (PUBLIC_DOMAIN, OWNER_PUBLIC_KEY and DIRECTORY_URL should match it).")
  if (-not $up) { exit 1 }
}

# ---- Update
# The newest published release of the server that carries a package for Windows. The repository holds the desktop app's
# releases too (tags desktop-v*), so "the latest release" is not asked for.
function Find-Release {
  $url = "https://api.github.com/repos/$Repository/releases?per_page=50"
  try { $answer = Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'squorli'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 30 }
  catch { Die (T "GitHub antwortet nicht ($url): $($_.Exception.Message)" "GitHub does not answer ($url): $($_.Exception.Message)") }
  $best = ''
  foreach ($release in @($answer | ForEach-Object { $_ })) {
    if ($release.draft -or $release.prerelease -or "$($release.tag_name)" -notmatch '^v(\d+\.\d+\.\d+)$') { continue }
    $found = $Matches[1]
    if (@($release.assets | Where-Object { $_.name -eq "squorli-server-$found-windows-x64.zip" }).Count -eq 0) { continue }
    if (-not $best -or [version]$found -gt [version]$best) { $best = $found }
  }
  if (-not $best) { Die (T "Unter https://github.com/$Repository/releases gibt es noch keine Version mit einem Paket für Windows." "There is no release with a package for Windows at https://github.com/$Repository/releases yet.") }
  return $best
}
# What a release says about updating by itself: the version from which on an installation may, read from
# apps/server/package.json at the release's tag (squorli.autoUpdateFrom). Empty: it says nothing (a release from before
# the mark). Nothing at all: the file could not be read.
function Get-ReleaseRule([string]$version) {
  $r = Get-Web "https://raw.githubusercontent.com/$Repository/v$version/apps/server/package.json" @{ 'User-Agent' = 'squorli' } 30
  if ($r.Status -ne 200) { return $null }
  try { $package = $r.Text | ConvertFrom-Json } catch { return $null }
  return (Get-Rule $package.PSObject.Properties 'squorli')
}
# The mark out of a manifest.json (autoUpdateFrom) or a package.json (squorli.autoUpdateFrom); empty when there is none.
function Get-Rule($properties, [string]$inside = '') {
  $found = @($properties | Where-Object { $_.Name -eq $inside -or (-not $inside -and $_.Name -eq 'autoUpdateFrom') })
  if ($found.Count -eq 0 -or $null -eq $found[0].Value) { return '' }
  if ($inside) { return (Get-Rule $found[0].Value.PSObject.Properties) }
  return "$($found[0].Value)"
}
# Does the step from the installed version to one with this mark ask for a person? It does when the installation is
# older than the mark says and does not carry the same mark itself.
function Test-ByHand([string]$have, [string]$haveRule, [string]$rule) {
  if ($rule -notmatch '^\d+\.\d+\.\d+$' -or $rule -eq $haveRule) { return $false }
  return ([version]$have -lt [version]$rule)
}
function Get-NotesUrl([string]$version) { return "https://github.com/$Repository/releases/tag/v$version" }

function Get-File([string]$url, [string]$path) {
  Note $url
  try { Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing -Headers @{ 'User-Agent' = 'squorli' } }
  catch { Die (T "Der Download ist fehlgeschlagen: $url ($($_.Exception.Message))" "The download failed: $url ($($_.Exception.Message))") }
}

# Hands over to the setup of the new package: programs, templates and service files of that version, the settings and
# secrets of this installation. Returns its exit code.
function Invoke-Setup([string]$package, [string]$account) {
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $package 'install.ps1'), '-Unattended', '-Mode', 'update',
    '-Language', $S.Lang, '-InstallDir', $S.InstallDir, '-DataDir', $S.DataDir, '-ServiceAccount', $account)
  $line = ($arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $line -NoNewWindow -PassThru
  # Without this the exit code of a process started this way stays empty
  $null = $p.Handle
  $p.WaitForExit()
  return $p.ExitCode
}

# The program files and filled templates as they were before the update.
function Save-Previous([string]$previous) {
  Copy-Folder $S.InstallDir (Join-Path $previous 'programs')
  Copy-Folder (Join-Path $S.DataDir 'config') (Join-Path $previous 'config')
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $previous 'pgdata')
  foreach ($file in @('postgresql.squorli.conf', 'pg_hba.conf')) {
    $path = Join-Path $S.DataDir "pgdata\$file"
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $previous "pgdata\$file") -Force }
  }
}
# Whether Windows may start a service. "disabled" also keeps its recovery actions from starting it.
function Set-StartMode([string]$key, [string]$mode) {
  $null = Invoke-Program 'sc.exe' @('config', $Services[$key], 'start=', $mode) -Quiet
}
function Restore-Previous([string]$previous) {
  $present = Get-Present
  # A service that ended with an error is started again by Windows after 5, 15 and 60 seconds (its recovery actions),
  # and it takes the services it needs along: that would happen in the middle of the copy (the user's run of
  # 28 September 2026). So no service can start until the files are back.
  try {
    foreach ($key in $present) { try { Set-StartMode $key 'disabled' } catch { Warn "$($_.Exception.Message)" } }
    foreach ($key in (Get-Ordered $present -Reverse)) {
      $info = Get-ServiceInfo $key
      if ($null -ne $info -and $info.State -ne 'Stopped') { try { Stop-One $key } catch { Warn "$($_.Exception.Message)" } }
    }
    Copy-Folder (Join-Path $previous 'programs') $S.InstallDir
    # File by file over what is there: a file that is overwritten keeps its access rights
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $previous 'config') -File)) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $S.DataDir "config\$($file.Name)") -Force }
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $previous 'pgdata') -File)) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $S.DataDir "pgdata\$($file.Name)") -Force }
  } finally {
    foreach ($key in $present) { try { Set-StartMode $key 'auto' } catch { Warn "$($_.Exception.Message)" } }
  }
  $started = $true
  foreach ($key in (Get-Ordered (Get-Present))) {
    if (Test-Running $key) { continue }
    try { Start-One $key } catch { Warn "$($_.Exception.Message)"; $started = $false }
  }
  return ($started -and (Show-Health 30))
}

# The folder the update works in goes away however it ends, unless the old program files in it are still needed.
function Invoke-Update {
  $work = Join-Path $S.DataDir 'update'
  $S.KeepWork = $false
  try { Invoke-UpdateSteps $work }
  finally {
    if (-not $S.KeepWork -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    if ($S.ContainsKey('Transcript')) { try { Stop-Transcript | Out-Null } catch { }; $S.Remove('Transcript') }
  }
}

# The run of the task found a version that asks for a person: it says so and changes nothing. Exit code 10, as for
# "there is something new".
function Stop-ByHand([string]$have, [string]$next) {
  $text = T "Version $next ist da (installiert: $have), verlangt aber vorher Handarbeit und wird nicht automatisch eingespielt. Versionshinweise lesen ($(Get-NotesUrl $next)), dann: squorli update" "Version $next is there (installed: $have), but it asks for work by hand first and is not installed automatically. Read the release notes ($(Get-NotesUrl $next)), then: squorli update"
  Write-Host ''
  Warn $text
  Write-AutoLog "!  $text"
  exit 10
}

# An automatic run that found something to do: what it writes goes into a file of its own, the log names it.
function Start-AutoRun([string]$have, [string]$next) {
  if (-not $S.ContainsKey('AutoLog')) { return }
  $file = Join-Path $S.Logs "update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
  try { Start-Transcript -Path $file | Out-Null; $S.Transcript = $file } catch { }
  Write-AutoLog (T "Update von $have auf $next beginnt; Einzelheiten: $file" "Update from $have to $next begins; details: $file")
}

function Invoke-UpdateSteps([string]$work) {
  $installed = Get-Manifest $S.InstallDir
  if ($null -eq $installed -or "$($installed.version)" -notmatch '^\d+\.\d+\.\d+$') { Die (T "$($S.InstallDir)\manifest.json nennt keine Version." "$($S.InstallDir)\manifest.json names no version.") }
  $have = "$($installed.version)"
  $haveRule = Get-Rule $installed.PSObject.Properties
  Step (T "Neue Version suchen (installiert: $have)" "Looking for the new version (installed: $have)")

  if ($Check) {
    if ($Package -or $Version) { Die (T '-Check fragt GitHub nach der neuesten Version und verträgt sich nicht mit -Version oder -Package.' '-Check asks GitHub for the newest release and does not go with -Version or -Package.') }
    $want = Find-Release
    if ([version]$want -gt [version]$have) {
      Write-Host (T "Version $want ist da (installiert: $have). Einspielen mit: squorli update" "Version $want is available (installed: $have). Install it with: squorli update")
      $rule = Get-ReleaseRule $want
      if ($null -ne $rule -and (Test-ByHand $have $haveRule $rule)) {
        Warn (T "Sie verlangt vorher Handarbeit und wird nicht automatisch eingespielt. Versionshinweise: $(Get-NotesUrl $want)" "It asks for work by hand first and is not installed automatically. Release notes: $(Get-NotesUrl $want)")
      }
      exit 10
    }
    Ok (T "Version $have ist die neueste." "Version $have is the newest.")
    return
  }

  $zipUrl = ''; $zipFile = ''; $want = ''
  if ($Package) {
    if ($Package -match '^https?://') { $zipUrl = $Package } else {
      $zipFile = Resolve-Place $Package
      if (-not (Test-Path -LiteralPath $zipFile -PathType Leaf)) { Die (T "$zipFile gibt es nicht." "$zipFile does not exist.") }
    }
  } else {
    $want = $Version.TrimStart('v')
    if ($want) {
      if ($want -notmatch '^\d+\.\d+\.\d+$') { Die (T "'$Version' ist keine Version (erwartet: 1.2.3)." "'$Version' is no version (expected: 1.2.3).") }
    } else {
      $want = Find-Release
      if ($want -eq $have) { Ok (T "Version $have ist die neueste." "Version $have is the newest."); Write-AutoLog (T "Version $have ist die neueste." "Version $have is the newest."); return }
      if ([version]$want -lt [version]$have) {
        Ok (T "Installiert ist $have, die neueste veröffentlichte Version ist ${want}: nichts zu tun." "Installed is $have, the newest published version is ${want}: nothing to do.")
        Write-AutoLog (T "Installiert ist $have, veröffentlicht ist ${want}: nichts zu tun." "Installed is $have, published is ${want}: nothing to do.")
        return
      }
    }
    $zipUrl = "https://github.com/$Repository/releases/download/v$want/squorli-server-$want-windows-x64.zip"
    # Before 115 MB are fetched every so many hours: may this installation take that version by itself?
    if ($Auto) {
      $rule = Get-ReleaseRule $want
      if ($null -eq $rule) { Die (T "Version $want ist da, aber was sie über das Update sagt, ließ sich nicht lesen (raw.githubusercontent.com). Nichts wurde verändert." "Version $want is there, but what it says about the update could not be read (raw.githubusercontent.com). Nothing was changed.") }
      if (Test-ByHand $have $haveRule $rule) { Stop-ByHand $have $want }
    }
  }
  if ($want) { Start-AutoRun $have $want } else { Start-AutoRun $have $Package }

  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($S.DataDir))
  if ($drive.AvailableFreeSpace -lt 2GB) { Die (T "Auf $($drive.Name) sind nur $([int]($drive.AvailableFreeSpace / 1MB)) MB frei; das Update braucht 2 GB für Paket, Sicherung und die alten Programmdateien." "Only $([int]($drive.AvailableFreeSpace / 1MB)) MB are free on $($drive.Name); the update needs 2 GB for the package, the backup and the old program files.") }
  # Inside the data folder, which only administrators reach: nobody else can change the package between check and use
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  $null = New-Item -ItemType Directory -Force -Path $work
  Set-Access $work
  if ($zipUrl) {
    $zipFile = Join-Path $work 'package.zip'
    Get-File $zipUrl $zipFile
    Get-File "$zipUrl.sha256" "$zipFile.sha256"
  }
  if (-not (Test-Path -LiteralPath "$zipFile.sha256")) { Die (T "Neben dem Paket fehlt die Datei mit der Prüfsumme: $zipFile.sha256" "The file with the checksum is missing next to the package: $zipFile.sha256") }
  $expected = "$(([IO.File]::ReadAllText("$zipFile.sha256")).Trim().Split(' ')[0])".ToLowerInvariant()
  $actual = Get-Sha256 $zipFile
  if ($expected -notmatch '^[0-9a-f]{64}$' -or $expected -ne $actual) {
    Die (T "Die Prüfsumme des Pakets stimmt nicht (erwartet $expected, gelesen $actual). Nichts wurde verändert." "The package's checksum does not match (expected $expected, read $actual). Nothing was changed.")
  }
  Ok "SHA-256 $actual"

  $unpacked = Join-Path $work 'new'
  $null = New-Item -ItemType Directory -Force -Path $unpacked
  try { $null = Invoke-Program (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf', $zipFile, '-C', $unpacked) -Quiet }
  catch { Die (T "Das Paket ließ sich nicht entpacken: $($_.Exception.Message)" "The package could not be unpacked: $($_.Exception.Message)") }
  $package = @(Get-ChildItem -LiteralPath $unpacked -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'install.ps1') } | Select-Object -First 1 | ForEach-Object { $_.FullName })
  if ($package.Count -ne 1) { Die (T 'Das Paket enthält kein install.ps1.' 'The package holds no install.ps1.') }
  $package = $package[0]
  $new = Get-Manifest $package
  if ($null -eq $new -or $new.name -ne 'squorli-server' -or $new.platform -ne 'windows-x64' -or "$($new.version)" -notmatch '^\d+\.\d+\.\d+$') { Die (T 'Das ist kein Paket von Squorli Server für Windows (manifest.json).' 'This is no package of Squorli Server for Windows (manifest.json).') }
  $next = "$($new.version)"
  if ([version]$next -lt [version]$have) {
    Warn (T "Version $next ist älter als die installierte ($have). Eine ältere Version liest die Datenbank einer neueren nicht unbedingt: Migrationen lassen sich nicht rückgängig machen." "Version $next is older than the installed one ($have). An older version does not necessarily read a newer one's database: migrations cannot be undone.")
    if (-not $Yes) {
      $answer = (Read-Host (T 'Trotzdem installieren? Dann ja eingeben' 'Install it anyway? Then type yes')).Trim().ToLowerInvariant()
      if (@('yes', 'ja') -notcontains $answer) { Write-Host (T 'Abgebrochen.' 'Cancelled.'); exit 1 }
    }
  }
  Ok "Squorli Server $next"
  # What the package itself says counts: its checksum was checked
  if (Test-ByHand $have $haveRule (Get-Rule $new.PSObject.Properties)) {
    if ($Auto) { Stop-ByHand $have $next }
    Warn (T "Version $next verlangt vor dem Update Handarbeit, wenn die Installation älter ist als $(Get-Rule $new.PSObject.Properties). Versionshinweise, Abschnitt `"Before you update`": $(Get-NotesUrl $next)" "Version $next asks for work by hand before the update when the installation is older than $(Get-Rule $new.PSObject.Properties). Release notes, section `"Before you update`": $(Get-NotesUrl $next)")
    if (-not $Yes) {
      $answer = (Read-Host (T 'Gelesen und erledigt? Dann ja eingeben' 'Read and done? Then type yes')).Trim().ToLowerInvariant()
      if (@('yes', 'ja') -notcontains $answer) { Write-Host (T 'Abgebrochen.' 'Cancelled.'); exit 1 }
    }
  }

  Step (T 'Sichern' 'Backing up')
  $backup = New-Backup ''
  Ok $backup
  $previous = Join-Path $work 'previous'
  Save-Previous $previous
  Ok (T 'Bisherige Programmdateien aufgehoben' 'Previous program files kept')
  $info = Get-ServiceInfo 'server'
  if ($null -ne $info -and "$($info.StartName)" -notlike 'NT SERVICE\*') { $account = 'localservice' } else { $account = 'virtual' }

  Step (T "Setup der Version $next ausführen" "Running the setup of version $next")
  $code = Invoke-Setup $package $account
  if ($code -ne 0) {
    Step (T 'Das Update ist fehlgeschlagen: alte Programmdateien zurückholen' 'The update failed: bringing the old program files back')
    $back = Restore-Previous $previous
    Write-Host ''
    if ($back) {
      Write-Host (T "Version $have läuft wieder." "Version $have is running again.") -ForegroundColor Yellow
      Write-AutoLog (T "x Das Update auf $next ist fehlgeschlagen, Version $have läuft wieder. Sicherung von vorher: $backup" "x The update to $next failed, version $have is running again. Backup from before: $backup")
    } else {
      Write-Host (T "Die Programmdateien von Version $have sind zurück, aber der Server antwortet nicht (squorli status, squorli logs server)." "The program files of version $have are back, but the server does not answer (squorli status, squorli logs server).") -ForegroundColor Red
      Write-AutoLog (T "x Das Update auf $next ist fehlgeschlagen, und der Server antwortet nicht. Sicherung von vorher: $backup" "x The update to $next failed, and the server does not answer. Backup from before: $backup")
    }
    Write-Host (T "Migrationen der Datenbank, die Version $next schon ausgeführt hat, sind damit NICHT rückgängig gemacht. Kommt Version $have mit der Datenbank nicht zurecht, die Sicherung von vor dem Update zurückspielen:" "Migrations of the database that version $next has run already are NOT undone by this. If version $have cannot work with the database, restore the backup from before the update:") -ForegroundColor Yellow
    Write-Host "  squorli restore `"$backup`""
    Note (T "Das Protokoll des Setups liegt in $($S.Logs) (install-<Zeit>.log)." "The setup's log is in $($S.Logs) (install-<time>.log).")
    if (-not $back) {
      Note (T "Die alten Programmdateien liegen noch in $previous." "The old program files are still in $previous.")
      $S.KeepWork = $true
    }
    exit 1
  }

  Step (T 'Fertig' 'Done')
  $up = Show-Health 5
  Write-Host (T "Squorli Server $have -> $next. Sicherung von vorher: $backup" "Squorli Server $have -> $next. Backup from before: $backup")
  if (-not $up) {
    Write-AutoLog (T "x Squorli Server $have -> ${next}, aber der Server antwortet nicht. Sicherung von vorher: $backup" "x Squorli Server $have -> ${next}, but the server does not answer. Backup from before: $backup")
    exit 1
  }
  Write-AutoLog (T "Squorli Server $have -> $next. Sicherung von vorher: $backup" "Squorli Server $have -> $next. Backup from before: $backup")
}

# ---- Automatic updates: a task of Windows' scheduler runs "squorli update -Auto" as SYSTEM, at minute 17 so it does
# not meet everything that starts on the hour. Every 24 hours means at 04:17, every n hours means counted from 00:17.
function Get-AutoTimes([int]$hours) {
  if ($hours -ge 24) { return @('04:17') }
  $times = @()
  for ($h = 0; $h -lt 24; $h += $hours) { $times += ('{0:00}:17' -f $h) }
  return $times
}
function Get-AutoWords([int]$hours) {
  if ($hours -ge 24) { return (T 'einmal täglich um 04:17 Uhr' 'once a day at 04:17') }
  if ($hours -eq 1) { return (T 'jede Stunde (zur Minute 17)' 'every hour (at minute 17)') }
  return (T "alle $hours Stunden ($((Get-AutoTimes $hours) -join ', '))" "every $hours hours ($((Get-AutoTimes $hours) -join ', '))")
}
# Who runs the task: SYSTEM, with every right.
function Get-AutoPrincipal { return '<Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>' }
function New-AutoTaskXml([int]$hours) {
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $S.InstallDir 'squorli.ps1')`" update -Auto"
  if ($DataDir) { $arguments += " -DataDir `"$($S.DataDir)`"" }
  $command = [Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  $arguments = [Security.SecurityElement]::Escape($arguments)
  if ($hours -ge 24) { $start = '2026-01-01T04:17:00'; $repeat = '' }
  else { $start = '2026-01-01T00:17:00'; $repeat = "<Repetition><Interval>PT${hours}H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>" }
  # A run that was missed (the machine was off) is made up for; a run is never ended by the clock before four hours
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Squorli Server: looks for a new version and installs it (squorli autoupdate). Interval in hours: $hours</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
      $repeat
    </CalendarTrigger>
  </Triggers>
  <Principals>$(Get-AutoPrincipal)</Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$command</Command>
      <Arguments>$arguments</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}
# A program's exit code and what it wrote, without a word on the screen (schtasks answers in the language of Windows).
function Invoke-Tool([string]$file, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $file @arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  return @{ Code = $code; Text = ($lines -join "`n") }
}
# The hours of the task that is registered; nothing when there is none.
function Get-AutoTask {
  $r = Invoke-Tool 'schtasks.exe' @('/Query', '/TN', $TaskName, '/XML')
  if ($r.Code -ne 0 -or $r.Text -notmatch '<Task') { return $null }
  if ($r.Text -match '<Interval>PT(\d+)H</Interval>') { return @{ Hours = [int]$Matches[1] } }
  return @{ Hours = 24 }
}
function Register-AutoTask([int]$hours) {
  # In the data folder, which only administrators reach: nobody else can change the file before it is read
  $file = Join-Path $S.DataDir 'autoupdate-task.xml'
  [IO.File]::WriteAllText($file, (New-AutoTaskXml $hours), [Text.Encoding]::Unicode)
  try {
    $r = Invoke-Tool 'schtasks.exe' @('/Create', '/TN', $TaskName, '/XML', $file, '/F')
    if ($r.Code -ne 0) { Die (T "Die Aufgabe ließ sich nicht anlegen (schtasks: $($r.Code)): $($r.Text)" "The task could not be created (schtasks: $($r.Code)): $($r.Text)") }
  } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
function Show-AutoState {
  $task = Get-AutoTask
  if ($null -eq $task) {
    Write-Host (T 'Automatische Updates: aus' 'Automatic updates: off')
    Note (T 'Einschalten: squorli autoupdate on' 'Switch on: squorli autoupdate on')
  } else {
    Write-Host (T "Automatische Updates: an, $(Get-AutoWords $task.Hours)" "Automatic updates: on, $(Get-AutoWords $task.Hours)")
    Note (T "Aufgabe `"$TaskName`" der Aufgabenplanung; ausschalten: squorli autoupdate off" "Task `"$TaskName`" of the task scheduler; switch off: squorli autoupdate off")
  }
  $log = Join-Path $S.Logs 'autoupdate.log'
  if (Test-Path -LiteralPath $log) {
    Write-Host ''
    Write-Host "$(T 'Die letzten Läufe' 'The last runs') ($log):" -ForegroundColor DarkGray
    Get-Content -LiteralPath $log -Tail 5 -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
  }
}
function Show-AutoWarning {
  Write-Host ''
  Write-Host (T 'Automatische Updates: bitte vorher lesen' 'Automatic updates: please read this first') -ForegroundColor Yellow
  Warn (T 'Ein Update startet den App-Server neu, wann immer eine neue Version erscheint: wer gerade schreibt oder spricht, wird kurz getrennt.' 'An update restarts the app server whenever a new version appears: whoever is writing or talking is cut off for a moment.')
  Warn (T 'Eine Version, die vorher Handarbeit verlangt, wird nicht automatisch eingespielt: Sie steht dann im Log und wartet auf squorli update.' 'A version that asks for work by hand first is not installed automatically: it stands in the log then and waits for squorli update.')
  Warn (T "Vor jedem Update wird gesichert. Die Sicherungen bleiben liegen und brauchen Platz: $(Join-Path $S.DataDir 'backups')" "Every update makes a backup first. The backups stay and take space: $(Join-Path $S.DataDir 'backups')")
  Note (T "Schlägt ein Update fehl, kommen die alten Programmdateien zurück. Was geschah, steht in $(Join-Path $S.Logs 'autoupdate.log')." "When an update fails the old program files come back. What happened is in $(Join-Path $S.Logs 'autoupdate.log').")
  Note (T 'Empfohlen sind 24 Stunden: dann läuft die Suche einmal täglich um 04:17 Uhr.' 'Recommended are 24 hours: the search then runs once a day at 04:17.')
}
function Read-Hours([string]$given) {
  $n = 0
  if ($given) {
    if (-not [int]::TryParse($given, [ref]$n) -or $n -lt 1 -or $n -gt 24) { Die (T "'$given' ist kein Abstand in Stunden: eine ganze Zahl von 1 bis 24." "'$given' is no interval in hours: a whole number from 1 to 24.") }
    return $n
  }
  while ($true) {
    Write-Host ''
    Write-Host '? ' -ForegroundColor Blue -NoNewline
    Write-Host (T 'Alle wie viele Stunden nach einer neuen Version suchen (1-24)?' 'Look for a new version every how many hours (1-24)?') -ForegroundColor White -NoNewline
    Write-Host ' [24]' -ForegroundColor DarkGray -NoNewline
    $answer = (Read-Host ' ').Trim()
    if (-not $answer) { return 24 }
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le 24) { return $n }
    Warn (T 'Bitte eine ganze Zahl von 1 bis 24.' 'Please a whole number from 1 to 24.')
  }
}
function Invoke-AutoUpdate([string[]]$words) {
  $what = 'status'
  if ($words.Count -gt 0) { $what = $words[0].ToLowerInvariant() }
  switch ($what) {
    'status' { Show-AutoState }
    'on' {
      $given = ''
      if ($Hours -ne 0) { $given = "$Hours" } elseif ($words.Count -gt 1) { $given = $words[1] }
      Show-AutoWarning
      $n = Read-Hours $given
      Register-AutoTask $n
      Write-Host ''
      Ok (T "Automatische Updates sind an: $(Get-AutoWords $n)." "Automatic updates are on: $(Get-AutoWords $n).")
      Note (T 'Ausschalten: squorli autoupdate off   Stand und letzte Läufe: squorli autoupdate' 'Switch off: squorli autoupdate off   State and last runs: squorli autoupdate')
    }
    'off' {
      if ($null -eq (Get-AutoTask)) { Ok (T 'Automatische Updates waren schon aus.' 'Automatic updates were off already.'); return }
      $r = Invoke-Tool 'schtasks.exe' @('/Delete', '/TN', $TaskName, '/F')
      if ($r.Code -ne 0) { Die (T "Die Aufgabe ließ sich nicht entfernen (schtasks: $($r.Code)): $($r.Text)" "The task could not be removed (schtasks: $($r.Code)): $($r.Text)") }
      Ok (T 'Automatische Updates sind aus.' 'Automatic updates are off.')
    }
    default {
      Write-Host (T "squorli autoupdate [on [Stunden] | off]   (Stunden: 1 bis 24; ohne Wort: der Stand)" "squorli autoupdate [on [hours] | off]   (hours: 1 to 24; without a word: the state)")
      exit 1
    }
  }
}

# ---- The setup check (docs/features/doctor.md): the services, DNS from this machine, then the app server's own report (it
# reaches its public address, LiveKit and the directory; a directory repeats the address checks from outside).
function Invoke-Doctor {
  Write-Host (T 'Dienste:' 'Services:')
  $null = Show-Services
  if ($S.Domain -and $S.Domain -ne 'localhost') {
    $found = @()
    try { $found = @(Resolve-DnsName -Name $S.Domain -ErrorAction Stop | Where-Object { $_.PSObject.Properties.Name -contains 'IPAddress' } | ForEach-Object { $_.IPAddress } | Select-Object -Unique) } catch { $found = @() }
    Write-Host ''
    if ($found.Count -gt 0) { Write-Host "DNS: $($S.Domain) -> $($found -join ' ')" }
    else { Write-Host (T "DNS: $($S.Domain) löst auf diesem Rechner nicht auf." "DNS: $($S.Domain) does not resolve on this machine.") }
  }
  Write-Host ''
  Write-Host (T 'Prüfungen des App-Servers (von diesem Rechner aus; ein Verzeichnis prüft zusätzlich von außen):' 'Checks of the app server (from this machine; a directory also checks from outside):')
  $marks = @{ ok = '  ok  '; warn = '  !   '; fail = '  x   '; skip = '  -   ' }
  $colors = @{ ok = 'Green'; warn = 'Yellow'; fail = 'Red'; skip = 'DarkGray' }
  $failed = $false
  $headers = @{}
  # The app server takes this in place of a session (DOCTOR_TOKEN); an installation from before it asks from loopback
  $token = Env-Get 'DOCTOR_TOKEN'
  if ($token) { $headers['x-squorli-doctor'] = $token }
  $r = Get-Web "http://$($S.Host):$($S.AppPort)/api/doctor" $headers 120
  if ($r.Status -ne 200) {
    if ($r.Status -gt 0) { $why = "/api/doctor -> HTTP $($r.Status)" } else { $why = $r.Error }
    Write-Host "  x   $why" -ForegroundColor Red
    if ($r.Status -eq 401) { Note (T 'Der App-Server kennt das DOCTOR_TOKEN aus der .env nicht: squorli restart server' 'The app server does not know the DOCTOR_TOKEN of .env: squorli restart server') }
    $failed = $true
  } else {
    $report = $r.Text | ConvertFrom-Json
    foreach ($check in $report.checks) {
      $status = "$($check.status)"
      if (-not $marks.ContainsKey($status)) { $status = 'warn' }
      if ($S.Lang -eq 'de') { $text = "$($check.text.de)" } else { $text = "$($check.text.en)" }
      if ($check.detail) { $text += "  ($($check.detail))" }
      Write-Host $marks[$status] -ForegroundColor $colors[$status] -NoNewline
      Write-Host $text
      if ($status -eq 'fail') { $failed = $true }
    }
  }
  Write-Host ''
  Write-Host (T 'Ob Sprache und Video (UDP) ankommen, prüft nur ein Browser: Verwaltung > Server > Verbindung prüfen.' 'Whether voice and video (UDP) arrive can only be checked from a browser: Verwaltung > Server > Check the connection.')
  if ($failed) { exit 1 }
}

function Show-Help {
  Write-Host 'squorli status | logs [service] [-Follow] | restart [service] | stop [service] | start [service] | backup [dir] | restore <dir> [-Yes] | update [-Version x.y.z] [-Check] | autoupdate [on [hours] | off] | doctor'
  Write-Host 'services: server, postgres, livekit, caddy'
}

function Main {
  Find-Installation
  $name = $Command.ToLowerInvariant().TrimStart('-').TrimStart('/')
  if ($Help -or @('help', 'h', '?') -contains $name) { Show-Help; return }
  # Everything after the command that is no option: the names of services, or the folder
  $words = @()
  if ($Target) { $words += $Target }
  if ($Rest) { $words += @($Rest | Where-Object { $_ }) }
  # The options as the Linux helper spells them (--yes, -f): PowerShell binds them itself on most ways in, not on all
  foreach ($word in @($words | Where-Object { $_ -match '^--?[A-Za-z]+$' })) {
    switch ($word.TrimStart('-').ToLowerInvariant()) {
      { @('yes', 'y') -contains $_ } { $script:Yes = $true }
      { @('follow', 'f') -contains $_ } { $script:Follow = $true }
      'check' { $script:Check = $true }
      'auto' { $script:Auto = $true }
      default { Write-Host (T "Die Option '$word' gibt es nicht." "There is no option '$word'.") -ForegroundColor Red; Show-Help; exit 1 }
    }
  }
  $words = @($words | Where-Object { $_ -notmatch '^--?[A-Za-z]+$' })
  $first = ''
  if ($words.Count -gt 0) { $first = $words[0] }
  $known = @('status', 'ps', 'logs', 'restart', 'stop', 'down', 'start', 'up', 'backup', 'restore', 'update', 'autoupdate', 'doctor')
  if ($known -notcontains $name) {
    Write-Host (T "Den Befehl '$Command' gibt es nicht." "There is no command '$Command'.") -ForegroundColor Red
    Show-Help
    exit 1
  }
  if ($Auto -and $name -eq 'update') {
    # Before anything can fail: the log says why a run did nothing
    $script:Yes = $true
    $S.AutoLog = Join-Path $S.Logs 'autoupdate.log'
    try {
      $null = New-Item -ItemType Directory -Force -Path $S.Logs
      if ((Test-Path -LiteralPath $S.AutoLog) -and (Get-Item -LiteralPath $S.AutoLog).Length -gt 1MB) {
        $kept = @(Get-Content -LiteralPath $S.AutoLog -Tail 2000 -Encoding UTF8)
        [IO.File]::WriteAllText($S.AutoLog, (($kept -join "`r`n") + "`r`n"), $Utf8)
      }
    } catch { }
  }
  Assert-Installation
  try {
    switch ($name) {
      'status' { Invoke-Status }
      'ps' { Invoke-Status }
      'logs' { Invoke-Logs $words }
      'restart' { Invoke-Restart $words }
      'stop' { Invoke-Stop $words }
      'down' { Invoke-Stop @() }
      'start' { Invoke-Start $words }
      'up' { Invoke-Start @() }
      'backup' { Invoke-Backup $first }
      'restore' { Invoke-Restore $first }
      'update' { Invoke-Update }
      'autoupdate' { Invoke-AutoUpdate $words }
      'doctor' { Invoke-Doctor }
    }
  } catch {
    Write-Host ''
    Write-Host "x $($_.Exception.Message)" -ForegroundColor Red
    Note "$(T 'Zeile' 'line') $($_.InvocationInfo.ScriptLineNumber)"
    Write-AutoLog "x $($_.Exception.Message)"
    exit 1
  }
}

# Dot-sourced (tests): the functions only.
if ($MyInvocation.InvocationName -ne '.') { Main }
