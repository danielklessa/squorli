#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Squorli Server: setup for Windows without Docker. The counterpart of deploy/install.sh.

.DESCRIPTION
  Run from the unpacked package (squorli-server-<version>-windows-x64) in a PowerShell started as administrator:

    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Asks for domain, the way of HTTPS, ports, directory and owner (German or English), copies the programs to
  C:\Program Files\Squorli, writes C:\ProgramData\Squorli\.env with fresh secrets, creates the PostgreSQL cluster,
  registers the services SquorliPostgres, SquorliLiveKit, SquorliServer and (bundled mode) SquorliCaddy, opens the
  firewall after asking, starts and checks everything. Running it again on an existing installation updates it or
  changes its settings; secrets and data are kept.

  Without questions: -Unattended takes every answer from its parameter or the default.
  Details: deploy/windows/AGENTS.md, docs/features/windows.md.

  This file is UTF-8 with a byte order mark: Windows PowerShell 5.1 reads the German texts wrong without it.
#>
[CmdletBinding()]
param(
  [switch]$Unattended,
  [ValidateSet('de', 'en')][string]$Language,
  [string]$InstallDir,
  [string]$DataDir,
  # On an existing installation: update (programs and templates, settings stay) or reconfigure (ask again).
  [ValidateSet('update', 'reconfigure')][string]$Mode,
  [string]$Domain,
  [string]$ServerName,
  # Who takes care of HTTPS: bundled (Caddy), local (a proxy on this machine), remote (a proxy on another machine).
  [ValidateSet('bundled', 'local', 'remote')][string]$Setup,
  [string]$BindIp,
  [string]$ProxyIp,
  [int]$AppPort,
  [int]$LiveKitHttpPort,
  [int]$LiveKitTcpPort,
  [int]$LiveKitUdpPort,
  [int]$PostgresPort,
  # Address of the directory, or "none".
  [string]$Directory,
  [ValidateSet('key', 'code', 'first')][string]$Owner,
  [string]$OwnerPublicKey,
  # The public IP for voice and video: an IPv4 address, "dynamic" (a task keeps it current: a home connection), empty = LiveKit finds it.
  [string]$NodeIp,
  [ValidateSet('yes', 'no')][string]$Firewall,
  [ValidateSet('yes', 'no')][string]$KeepAwake,
  [ValidateSet('yes', 'no')][string]$VcRuntime,
  # The account of the services: one of its own per service (NT SERVICE\<name>) or LocalService for all.
  [ValidateSet('virtual', 'localservice')][string]$ServiceAccount = 'virtual'
)
# Asked for, or only the default: an existing installation keeps the account its services have.
$ServiceAccountGiven = $PSBoundParameters.ContainsKey('ServiceAccount')

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$DefaultDirectory = 'https://directory.squorli.com'
$Utf8 = New-Object Text.UTF8Encoding $false
# In the order they start; they stop the other way round.
$ServiceNames = @('SquorliPostgres', 'SquorliLiveKit', 'SquorliServer', 'SquorliCaddy')
$WrappedServices = @('SquorliLiveKit', 'SquorliServer', 'SquorliCaddy')
# What each service runs: the package's folders, and the programs whose versions manifest.json names ("server" is the
# package's own version). WinSW runs every service but PostgreSQL.
$Programs = [ordered]@{
  SquorliPostgres = @{ Folders = @('pgsql'); Parts = @('postgresql') }
  SquorliLiveKit = @{ Folders = @('livekit'); Parts = @('livekit', 'winsw') }
  SquorliServer = @{ Folders = @('app', 'node'); Parts = @('server', 'node', 'winsw') }
  SquorliCaddy = @{ Folders = @('caddy'); Parts = @('caddy', 'winsw') }
}
$PartNames = @{ server = 'Squorli Server'; node = 'Node.js'; postgresql = 'PostgreSQL'; livekit = 'LiveKit'; caddy = 'Caddy'; winsw = 'WinSW' }
# What a service needs running (the <depend> entries of the service files).
$ServiceNeeds = @{ SquorliPostgres = @(); SquorliLiveKit = @(); SquorliServer = @('SquorliPostgres', 'SquorliLiveKit'); SquorliCaddy = @('SquorliServer') }
$FirewallGroup = 'Squorli'
# Well-known accounts by their SID: their names differ with the language of Windows.
$SidSystem = 'S-1-5-18'; $SidAdministrators = 'S-1-5-32-544'; $SidLocalService = 'S-1-5-19'
# What the questions fill; read by every step.
# Replace: the services that get new programs. Written: the files Write-Template wrote. Restart: the services whose
# configuration changed while they ran.
$S = @{ Lang = 'en'; Changes = New-Object Collections.Generic.List[string]; Closed = @(); Replace = @($ServiceNames)
  Written = New-Object Collections.Generic.List[string]; Restart = New-Object Collections.Generic.List[string] }

# ---- Output
function T([string]$de, [string]$en) { if ($S.Lang -eq 'de') { $de } else { $en } }
function Step([string]$text) { Write-Host ''; Write-Host ''; Write-Host '---- ' -ForegroundColor Blue -NoNewline; Write-Host $text -ForegroundColor White }
function Ok([string]$text) { Write-Host '  ok ' -ForegroundColor Green -NoNewline; Write-Host $text }
function Warn([string]$text) { Write-Host "  !  $text" -ForegroundColor Yellow }
function Note([string]$text) { Write-Host "     $text" -ForegroundColor DarkGray }
function Die([string]$text) { Write-Host ''; Write-Host "x $text" -ForegroundColor Red; Stop-Log; exit 1 }
function Stop-Log { if ($S.ContainsKey('Log')) { try { Stop-Transcript | Out-Null } catch { } ; $S.Remove('Log') } }

# ---- Input. With -Unattended every question takes what its parameter says, else its default; with questions a
# parameter is what the question offers.
function Ask([string]$question, [string]$default = '', [string]$given = '') {
  if ($Unattended) { if ($given) { return $given } else { return $default } }
  if ($given) { $default = $given }
  Write-Host ''
  Write-Host '? ' -ForegroundColor Blue -NoNewline
  Write-Host $question -ForegroundColor White -NoNewline
  if ($default) { Write-Host " [$default]" -ForegroundColor DarkGray -NoNewline }
  $answer = (Read-Host ' ').Trim()
  if ($answer) { return $answer } else { return $default }
}
function Confirm([string]$question, [bool]$default, [string]$given = '') {
  if ($Unattended) { if ($given) { return ($given -eq 'yes') } else { return $default } }
  if ($given) { $default = ($given -eq 'yes') }
  if ($default) { $hint = T 'J/n' 'Y/n' } else { $hint = T 'j/N' 'y/N' }
  while ($true) {
    $a = (Ask "$question ($hint)").ToLowerInvariant()
    if (-not $a) { return $default }
    if (@('y', 'yes', 'j', 'ja') -contains $a) { return $true }
    if (@('n', 'no', 'nein') -contains $a) { return $false }
  }
}
# Returns the number of the chosen option (1..n).
function Choose([string]$question, [int]$default, [string[]]$options, [int]$given = 0) {
  if ($Unattended) { if ($given -ge 1) { return $given } else { return $default } }
  if ($given -ge 1) { $default = $given }
  Write-Host ''
  Write-Host '? ' -ForegroundColor Blue -NoNewline
  Write-Host $question -ForegroundColor White
  for ($i = 0; $i -lt $options.Length; $i++) { Write-Host "  $($i + 1)) " -ForegroundColor Blue -NoNewline; Write-Host $options[$i] }
  while ($true) {
    Write-Host '  > ' -ForegroundColor Blue -NoNewline
    Write-Host (T 'Auswahl' 'Choice') -ForegroundColor White -NoNewline
    Write-Host " [$default]" -ForegroundColor DarkGray -NoNewline
    $a = (Read-Host ' ').Trim()
    if (-not $a) { return $default }
    $n = 0
    if ([int]::TryParse($a, [ref]$n) -and $n -ge 1 -and $n -le $options.Length) { return $n }
  }
}

# ---- Programs. Output goes to the screen and the log; stderr never stops the script by itself (Windows PowerShell 5.1
# turns a redirected stderr line into an error), the exit code decides.
function Invoke-Program([string]$file, [string[]]$arguments, [int[]]$ok = @(0), [switch]$Quiet) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $file @arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  $failed = ($ok -notcontains $code)
  if ($failed -or -not $Quiet) { foreach ($line in $lines) { if ($line.Trim()) { Note $line } } }
  if ($failed) { throw "$file $($arguments -join ' ') -> $code" }
  return $lines
}

# ---- .env helpers (the file is data: single lines are read and changed, the rest stays as it is)
function Env-Get([string]$file, [string]$key) {
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines($file, $Utf8)) { if ($line.StartsWith("$key=")) { $value = $line.Substring($key.Length + 1) } }
  $value = $value.Trim()
  if ($value.Length -ge 2 -and (($value[0] -eq "'" -and $value[-1] -eq "'") -or ($value[0] -eq '"' -and $value[-1] -eq '"'))) { $value = $value.Substring(1, $value.Length - 2) }
  return $value
}
# Replaces the first active KEY= line (drops further ones), else the first "#KEY=" line, else appends. Values outside a
# safe character set are single-quoted, which node reads literally.
function Env-Set([string]$file, [string]$key, [string]$value) {
  if ($value -notmatch '^[A-Za-z0-9._:/@+,=-]*$') { $value = "'$value'" }
  $lines = [IO.File]::ReadAllLines($file, $Utf8)
  $active = @($lines | Where-Object { $_.StartsWith("$key=") }).Count -gt 0
  $out = New-Object Collections.Generic.List[string]
  $done = $false
  foreach ($line in $lines) {
    if ($line.StartsWith("$key=")) { if (-not $done) { $out.Add("$key=$value"); $done = $true }; continue }
    if (-not $active -and -not $done -and ($line.StartsWith("#$key=") -or $line.StartsWith("# $key="))) { $out.Add("$key=$value"); $done = $true; continue }
    $out.Add($line)
  }
  if (-not $done) { $out.Add("$key=$value") }
  [IO.File]::WriteAllText($file, (($out -join "`n") + "`n"), $Utf8)
}

function New-Secret([int]$bytes = 32) {
  $buffer = New-Object byte[] $bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}
# 80 % of the free space of the drive that holds $folder, in MB; $null when the drive cannot be asked (security audit S13, 4 October 2026).
function Get-DefaultQuotaMb([string]$folder) {
  try {
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($folder))
    if (-not $root) { return $null }
    $free = ([IO.DriveInfo]::new($root)).AvailableFreeSpace
    return [long][Math]::Floor($free * 0.8 / 1MB)
  } catch { return $null }
}
function Test-IPv4([string]$value) {
  if ($value -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') { return $false }
  foreach ($part in $value.Split('.')) { if ([int]$part -gt 255) { return $false } }
  return $true
}
function Test-Service([string]$name) { return $null -ne (Get-Service -Name $name -ErrorAction SilentlyContinue) }
function Test-ServiceRunning([string]$name) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  return ($null -ne $service -and $service.Status -ne 'Stopped')
}
# The services that need this one, directly or through another.
function Get-Dependents([string]$name) {
  $found = @()
  foreach ($other in $ServiceNames) { if ($ServiceNeeds[$other] -contains $name) { $found += $other; $found += @(Get-Dependents $other) } }
  return @($found | Select-Object -Unique)
}
# The given services and the ones that need them, in the order of a start.
function Get-WithDependents([string[]]$names) {
  $all = @($names)
  foreach ($name in $names) { $all += @(Get-Dependents $name) }
  return @($ServiceNames | Where-Object { $all -contains $_ })
}
function Get-Manifest([string]$folder) {
  $file = Join-Path $folder 'manifest.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return ([IO.File]::ReadAllText($file, $Utf8) | ConvertFrom-Json) } catch { return $null }
}
# The version a manifest names for a program; empty when it names none.
function Get-PartVersion($manifest, [string]$part) {
  if ($null -eq $manifest) { return '' }
  $names = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
  if ($part -eq 'server') { if ($names -contains 'version') { return "$($manifest.version)" } else { return '' } }
  if ($names -notcontains 'components' -or $null -eq $manifest.components) { return '' }
  if (@($manifest.components.PSObject.Properties | ForEach-Object { $_.Name }) -notcontains $part) { return '' }
  return "$($manifest.components.$part)"
}
# The SID of a service's own account (NT SERVICE\<name>); it follows from the name, the service need not exist.
function Get-ServiceSid([string]$name) {
  $text = (Invoke-Program 'sc.exe' @('showsid', $name) -Quiet) -join ' '
  if ($text -notmatch 'S-1-5-80-[0-9-]+') { throw "sc.exe showsid $name" }
  return $Matches[0]
}
# The SID a service's files are given to.
function Get-AccountSid([string]$service) { if ($ServiceAccount -eq 'localservice') { return $SidLocalService } else { return (Get-ServiceSid $service) } }

# Access to a file or folder: inherited rights removed, full access for SYSTEM and administrators, plus the given
# grants (SID -> icacls rights like "R", "M" or "F"). Folders hand their rights down.
function Set-Access([string]$path, [hashtable]$grants = @{}) {
  $folder = Test-Path -LiteralPath $path -PathType Container
  if ($folder) { $down = '(OI)(CI)' } else { $down = '' }
  $arguments = @($path, '/inheritance:r', '/grant:r', "*${SidSystem}:${down}F", '/grant:r', "*${SidAdministrators}:${down}F")
  foreach ($sid in $grants.Keys) { $arguments += @('/grant:r', "*${sid}:${down}$($grants[$sid])") }
  $null = Invoke-Program 'icacls.exe' ($arguments + @('/Q')) -Quiet
}

# ---- Ports
function Test-PortBusy([string]$protocol, [int]$port) {
  if ($protocol -eq 'udp') { return $null -ne (Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue) }
  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}
# Who holds a TCP port, in words: the program's name, or IIS for the system's own HTTP service.
function Get-PortHolder([int]$port) {
  $names = @()
  foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
    if ($c.OwningProcess -eq 4) {
      $iis = Get-Service -Name 'W3SVC' -ErrorAction SilentlyContinue
      if ($iis -and $iis.Status -eq 'Running') { $names += 'IIS (W3SVC)' } else { $names += (T 'der HTTP-Dienst von Windows (http.sys)' "Windows' HTTP service (http.sys)") }
    } else {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($p) { $names += "$($p.ProcessName) (PID $($p.Id))" } else { $names += "PID $($c.OwningProcess)" }
    }
  }
  return (@($names | Select-Object -Unique) -join ', ')
}
$PortInfo = [ordered]@{
  AppPort = @{ Protocol = 'tcp'; Default = 3000; Env = 'APP_PORT' }
  LiveKitHttpPort = @{ Protocol = 'tcp'; Default = 7880; Env = 'LIVEKIT_HTTP_PORT' }
  LiveKitTcpPort = @{ Protocol = 'tcp'; Default = 7881; Env = 'LIVEKIT_TCP_PORT' }
  LiveKitUdpPort = @{ Protocol = 'udp'; Default = 7882; Env = 'LIVEKIT_UDP_PORT' }
  PostgresPort = @{ Protocol = 'tcp'; Default = 5432; Env = 'POSTGRES_PORT' }
}
function Get-PortLabel([string]$name) {
  switch ($name) {
    'AppPort' { return (T 'App-Server (Ziel des Proxys)' 'app server (proxy target)') }
    'LiveKitHttpPort' { return (T 'LiveKit-Signalisierung (Ziel des Proxys für /rtc)' 'LiveKit signaling (proxy target for /rtc)') }
    'LiveKitTcpPort' { return (T 'Sprache und Video über TCP (offen für alle)' 'voice and video over TCP (open to everyone)') }
    'LiveKitUdpPort' { return (T 'Sprache und Video über UDP (offen für alle)' 'voice and video over UDP (open to everyone)') }
    'PostgresPort' { return (T 'Datenbank (nur dieser Rechner)' 'database (this machine only)') }
  }
}
# Why a port cannot be used for $name; empty when it can. The ports this installation holds already never count as taken.
function Get-PortProblem([string]$name, [int]$port) {
  $protocol = $PortInfo[$name].Protocol
  if ($port -lt 1 -or $port -gt 65535) { return (T 'keine Portnummer (1-65535)' 'not a port number (1-65535)') }
  if ($protocol -eq 'tcp' -and $S.Setup -eq 'bundled' -and ($port -eq 80 -or $port -eq 443)) { return (T 'gehört dem mitgelieferten Caddy' 'belongs to the bundled Caddy') }
  foreach ($other in $PortInfo.Keys) {
    if ($other -ne $name -and $PortInfo[$other].Protocol -eq $protocol -and $S.Ports[$other] -eq $port) { return (T "schon für $(Get-PortLabel $other) gewählt" "already chosen for $(Get-PortLabel $other)") }
  }
  if ($S.OldPorts.ContainsKey($name) -and $S.OldPorts[$name] -eq $port) { return '' }
  if (Test-PortBusy $protocol $port) { return (T 'belegt' 'in use') }
  return ''
}

# ---- Steps
function Show-Banner {
  $art = @'
          .##:.::##########:
          .##################:
          ####################::.
         #####################:###:
        ###################### :####:
       :#####.      .:######.  .######
       :##:                    .#######:.
       .#######:               ###########
      .##########.           .##########.
      ###########:        .:###########.
      ############       #############:
      .###########.     :#############
       .###########.    :############
         ############:.. :#########:
          .#################:###:.
            .#############:.
             ###:......
'@
  Write-Host ''
  Write-Host $art -ForegroundColor Blue
  Write-Host ''
  Write-Host '      Squorli Server' -ForegroundColor White -NoNewline
  Write-Host '   Installer - Windows' -ForegroundColor DarkGray
}

function Choose-Language {
  if ($Language) { $S.Lang = $Language; return }
  if ((Get-UICulture).TwoLetterISOLanguageName -eq 'de') { $default = 'de' } else { $default = 'en' }
  if ($Unattended) { $S.Lang = $default; return }
  while ($true) {
    $a = (Ask 'Sprache / Language (de/en)' $default).ToLowerInvariant()
    if (@('de', 'd') -contains $a) { $S.Lang = 'de'; return }
    if (@('en', 'e') -contains $a) { $S.Lang = 'en'; return }
  }
}

function Test-Requirements {
  Step (T 'Voraussetzungen' 'Requirements')
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  # ProductType 1 = a PC (Windows 10/11), 2 and 3 = Windows Server
  $S.IsServer = ([int]$os.ProductType -ne 1)
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or -not [Environment]::Is64BitProcess) {
    Die (T "Das Paket gibt es nur für x64, dieser Rechner oder diese PowerShell ist $($env:PROCESSOR_ARCHITECTURE). Bitte die 64-Bit-PowerShell auf einem x64-Windows verwenden." "The package exists for x64 only, this machine or this PowerShell is $($env:PROCESSOR_ARCHITECTURE). Please use the 64-bit PowerShell on an x64 Windows.")
  }
  if ($build -lt 17763) { Die (T "$($os.Caption) (Build $build) ist zu alt: nötig sind Windows 10 22H2, Windows 11 oder Windows Server 2019 und neuer." "$($os.Caption) (build $build) is too old: Windows 10 22H2, Windows 11 or Windows Server 2019 and later are required.") }
  if (-not $S.IsServer -and $build -lt 19045) { Warn (T "Windows 10 vor 22H2 (Build $build) ist nicht getestet und bekommt keine Sicherheitsupdates mehr." "Windows 10 before 22H2 (build $build) is untested and gets no security updates any more.") }
  foreach ($needed in @('app\dist\index.js', 'app\node_modules', 'app\public\index.html', 'node\node.exe', 'pgsql\bin\postgres.exe', 'pgsql\bin\initdb.exe', 'livekit\livekit-server.exe', 'caddy\caddy.exe', 'winsw\WinSW.exe', 'templates\env.example', 'templates\SquorliServer.xml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $needed))) { Die (T "Im Paket fehlt $needed. Bitte das ZIP vollständig entpacken und install.ps1 aus dem entpackten Ordner starten." "The package lacks $needed. Please unpack the whole ZIP and start install.ps1 from the unpacked folder.") }
  }
  if ($S.IsServer) { $kind = 'Windows Server' } else { $kind = T 'PC' 'PC' }
  Ok "$($os.Caption), Build $build, x64 ($kind); PowerShell $($PSVersionTable.PSVersion)"
  if (-not $S.IsServer) {
    Note (T 'Ein PC als Server: Windows Update startet ihn neu, im Standby ist der Server nicht erreichbar, und der Upload' 'A PC as a server: Windows Update restarts it, in standby the server is unreachable, and the upload of a')
    Note (T 'eines Heimanschlusses reicht für große Videokanäle meist nicht (README, "Requirements").' 'home connection is usually too small for big video channels (README, "Requirements").')
  }
}

# Sets InstallDir, DataDir, Mode (fresh|update|reconfigure), OldSetup and starts the log.
function Choose-Folders {
  Step (T 'Ordner' 'Folders')
  if ($InstallDir) { $S.InstallDir = $InstallDir } else { $S.InstallDir = Join-Path $env:ProgramFiles 'Squorli' }
  if ($DataDir) { $S.DataDir = $DataDir } else { $S.DataDir = Join-Path $env:ProgramData 'Squorli' }
  foreach ($key in @('InstallDir', 'DataDir')) {
    $S[$key] = [IO.Path]::GetFullPath($S[$key]).TrimEnd('\')
    if ($S[$key] -match '["<>|*?%]') { Die (T "Der Pfad $($S[$key]) enthält Zeichen, die hier nicht gehen." "The path $($S[$key]) contains characters that do not work here.") }
  }
  $S.EnvFile = Join-Path $S.DataDir '.env'
  Note "$(T 'Programme' 'Programs'): $($S.InstallDir)"
  Note "$(T 'Daten' 'Data'):      $($S.DataDir)"
  foreach ($drive in @($S.InstallDir, $S.DataDir | ForEach-Object { [IO.Path]::GetPathRoot($_) } | Select-Object -Unique)) {
    $free = (New-Object IO.DriveInfo $drive).AvailableFreeSpace
    if ($free -lt 2GB) { Die (T "Auf $drive sind nur $([int]($free / 1MB)) MB frei; nötig sind mindestens 2 GB." "Only $([int]($free / 1MB)) MB are free on $drive; at least 2 GB are needed.") }
  }

  $S.OldSetup = ''
  if (Test-Path -LiteralPath $S.EnvFile) {
    $S.OldSetup = Env-Get $S.EnvFile 'SQUORLI_SETUP'
    if (-not $S.OldSetup) { if ((Env-Get $S.EnvFile 'PROXY_MODE') -eq 'bundled') { $S.OldSetup = 'bundled' } else { $S.OldSetup = 'local' } }
    if ($Mode -eq 'reconfigure') { $given = 2 } elseif ($Mode -eq 'update') { $given = 1 } else { $given = 0 }
    $c = Choose (T "In $($S.DataDir) gibt es schon eine Installation. Was soll passieren?" "$($S.DataDir) already holds an installation. What should happen?") 1 @(
      (T 'Aktualisieren (Programme und Vorlagen aus diesem Paket, Einstellungen bleiben)' 'Update (programs and templates of this package, settings stay)'),
      (T 'Einstellungen ändern (Geheimnisse und Daten bleiben)' 'Change settings (secrets and data stay)'),
      (T 'Abbrechen' 'Abort')) $given
    if ($c -eq 1) { $S.Mode = 'update' } elseif ($c -eq 2) { $S.Mode = 'reconfigure' } else { exit 0 }
  } else {
    $S.Mode = 'fresh'
  }

  # The log, in a folder only administrators read (it names the configuration, never a secret).
  $logs = Join-Path $S.DataDir 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $S.Log = Join-Path $logs "install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
  try { Start-Transcript -Path $S.Log | Out-Null } catch { $S.Remove('Log') }
}

# An installation that exists keeps the kind of account its services run under, unless -ServiceAccount asks for another.
function Read-ServiceAccount {
  if ($ServiceAccountGiven -or $S.Mode -eq 'fresh') { return }
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='SquorliServer'" -ErrorAction SilentlyContinue
  if (-not $service -or -not $service.StartName) { return }
  if ($service.StartName -like 'NT SERVICE\*') { $script:ServiceAccount = 'virtual' } else { $script:ServiceAccount = 'localservice' }
}

function Read-Ports {
  $S.Ports = @{}
  foreach ($name in $PortInfo.Keys) {
    $value = Env-Get $S.EnvFile $PortInfo[$name].Env
    if ($value -match '^\d+$') { $S.Ports[$name] = [int]$value } else { $S.Ports[$name] = $PortInfo[$name].Default }
  }
  # What this installation holds already (only while its services exist)
  $S.OldPorts = @{}
  if ($S.OldSetup -and (Test-Service 'SquorliServer')) { foreach ($name in $PortInfo.Keys) { $S.OldPorts[$name] = $S.Ports[$name] } }
}

function Test-Dns {
  if ($S.Domain -eq 'localhost') { return }
  $found = @()
  try { $found = @(Resolve-DnsName -Name $S.Domain -ErrorAction Stop | Where-Object { $_.PSObject.Properties.Name -contains 'IPAddress' } | ForEach-Object { $_.IPAddress }) } catch { $found = @() }
  if ($found.Count -eq 0) {
    Warn (T "$($S.Domain) löst (noch) nicht auf. Der DNS-Eintrag muss auf diesen Rechner zeigen (bei einem Heimanschluss auf die öffentliche Adresse des Routers), bevor ein Zertifikat ausgestellt werden kann." "$($S.Domain) does not resolve (yet). The DNS record has to point to this machine (with a home connection to the router's public address) before a certificate can be issued.")
  } else { Ok "$($S.Domain) -> $($found -join ' ')" }
}

function Choose-Ports {
  Step 'Ports'
  if ($S.Setup -eq 'bundled') { Note (T '80/tcp und 443/tcp für Caddy sind fest: Let''s Encrypt prüft die Domain über diese Ports.' '80/tcp and 443/tcp for Caddy are fixed: Let''s Encrypt checks the domain over these ports.') }
  $given = @{ AppPort = $AppPort; LiveKitHttpPort = $LiveKitHttpPort; LiveKitTcpPort = $LiveKitTcpPort; LiveKitUdpPort = $LiveKitUdpPort; PostgresPort = $PostgresPort }
  foreach ($name in $PortInfo.Keys) { if ($given[$name] -gt 0) { $S.Ports[$name] = $given[$name] } }
  # Replace ports another program holds by the next free one from default + 10000 on
  $changed = $false
  foreach ($name in $PortInfo.Keys) {
    $why = Get-PortProblem $name $S.Ports[$name]
    if ($why) {
      $holder = ''
      if ($PortInfo[$name].Protocol -eq 'tcp') { $holder = Get-PortHolder $S.Ports[$name] }
      if ($holder) { $holder = " ($holder)" }
      Warn "$($S.Ports[$name])/$($PortInfo[$name].Protocol) $(T 'ist' 'is') $why$holder"
      if ($Unattended -and $given[$name] -gt 0) { Die (T "Der angegebene Port $($S.Ports[$name]) kann nicht verwendet werden." "The given port $($S.Ports[$name]) cannot be used.") }
      $port = $S.Ports[$name] + 10000
      if ($port -gt 65535) { $port = 20000 }
      $S.Ports[$name] = 0
      while ($port -le 65535 -and (Get-PortProblem $name $port)) { $port++ }
      $S.Ports[$name] = $port
      $changed = $true
    }
  }
  foreach ($name in $PortInfo.Keys) { Write-Host ("  {0,6}/{1}  {2}" -f $S.Ports[$name], $PortInfo[$name].Protocol, (Get-PortLabel $name)) }
  if ($changed) { Note (T 'Belegte Ports sind durch freie ersetzt.' 'Ports in use were replaced by free ones.') }
  if (Confirm (T 'Diese Ports verwenden?' 'Use these ports?') $true) { return }
  foreach ($name in $PortInfo.Keys) {
    while ($true) {
      $a = Ask "$(Get-PortLabel $name), $($PortInfo[$name].Protocol)" "$($S.Ports[$name])"
      $n = 0
      if (-not [int]::TryParse($a, [ref]$n)) { $n = 0 }
      $old = $S.Ports[$name]; $S.Ports[$name] = 0
      $why = Get-PortProblem $name $n
      if (-not $why) { $S.Ports[$name] = $n; break }
      $S.Ports[$name] = $old
      Warn "$a/$($PortInfo[$name].Protocol): $why"
    }
  }
}

function Read-Settings {
  Step (T 'Einstellungen' 'Settings')
  $envFile = $S.EnvFile
  $dDomain = Env-Get $envFile 'PUBLIC_DOMAIN'; if ($dDomain -eq 'chat.example.org') { $dDomain = '' }
  $dName = Env-Get $envFile 'SERVER_NAME'; if (-not $dName) { $dName = 'Community' }
  $dDirectory = $DefaultDirectory; if ($S.Mode -eq 'reconfigure') { $dDirectory = Env-Get $envFile 'DIRECTORY_URL' }
  $dOwner = Env-Get $envFile 'OWNER_PUBLIC_KEY'
  $dCode = Env-Get $envFile 'OWNER_SETUP_CODE'
  $dNode = Env-Get $envFile 'LIVEKIT_NODE_IP'
  $dDyn = (Env-Get $envFile 'LIVEKIT_DYNAMIC_IP') -eq 'true'

  while ($true) {
    $d = (Ask (T 'Domain, unter der der Server erreichbar ist (z. B. chat.example.org)' 'Domain the server is reached under (e.g. chat.example.org)') $dDomain $Domain).ToLowerInvariant()
    $d = ($d -replace '^https?://', '') -replace '/.*$', ''
    if ($d -eq 'localhost' -or $d -match '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$') { $S.Domain = $d; break }
    if ($Unattended) { Die (T "'$d' ist kein gültiger Hostname (-Domain)." "'$d' is not a valid hostname (-Domain).") }
    Warn (T 'Das ist kein gültiger Hostname.' 'That is not a valid hostname.')
  }
  Test-Dns

  # SERVER_NAME only names a new database; afterwards the name lives in the admin panel
  $S.ServerName = $dName
  if ($S.Mode -eq 'fresh') {
    while ($true) {
      $n = Ask (T 'Name des Servers (später im Adminbereich änderbar)' 'Name of the server (can be changed later in the admin panel)') $dName $ServerName
      if ($n.Length -ge 1 -and $n.Length -le 64 -and $n -notmatch "'") { $S.ServerName = $n; break }
      if ($Unattended) { Die (T 'Servername: höchstens 64 Zeichen, kein Apostroph.' 'Server name: at most 64 characters, no apostrophe.') }
      Warn (T 'Höchstens 64 Zeichen, kein Apostroph.' 'At most 64 characters, no apostrophe.')
    }
  }

  $dSetup = 1
  if ($S.OldSetup -eq 'local') { $dSetup = 2 } elseif ($S.OldSetup -eq 'remote') { $dSetup = 3 }
  if ($S.Domain -eq 'localhost' -and -not $S.OldSetup) { $dSetup = 2 }
  $givenSetup = 0
  if ($Setup) { $givenSetup = [array]::IndexOf(@('bundled', 'local', 'remote'), $Setup) + 1 }
  if ($S.IsServer) { $here = T 'IIS, nginx ...' 'IIS, nginx ...' } else { $here = T 'nginx, Caddy ...' 'nginx, Caddy ...' }
  $insist = $false
  while ($true) {
    $c = Choose (T 'Wer kümmert sich um HTTPS?' 'Who takes care of HTTPS?') $dSetup @(
      (T 'Squorli selbst: mitgelieferter Caddy mit Let''s-Encrypt-Zertifikat (braucht Port 80 und 443)' 'Squorli itself: bundled Caddy with a Let''s Encrypt certificate (needs ports 80 and 443)'),
      (T "Ein Reverse Proxy auf diesem Rechner ($here): App und LiveKit nur auf 127.0.0.1" "A reverse proxy on this machine ($here): app and LiveKit on 127.0.0.1 only"),
      (T 'Ein Reverse Proxy auf einem anderen Rechner: App und LiveKit im LAN/VPN' 'A reverse proxy on another machine: app and LiveKit in the LAN/VPN')) $givenSetup
    $S.Setup = @('bundled', 'local', 'remote')[$c - 1]
    if ($S.Setup -ne 'bundled') { break }
    if ($S.Domain -eq 'localhost') {
      if ($Unattended) { Die (T 'Für localhost gibt es kein Let''s-Encrypt-Zertifikat (-Setup local wählen).' 'Let''s Encrypt issues no certificate for localhost (choose -Setup local).') }
      Warn (T 'Für localhost gibt es kein Let''s-Encrypt-Zertifikat; bitte einen Reverse Proxy wählen.' 'Let''s Encrypt issues no certificate for localhost; please choose a reverse proxy.')
      $dSetup = 2; continue
    }
    # Let's Encrypt checks the domain on 80 and serves on 443, so the bundled Caddy cannot move to other ports
    $busy = @(80, 443 | Where-Object { Test-PortBusy 'tcp' $_ })
    if ($S.OldSetup -ne 'bundled' -and -not $insist -and $busy.Count -gt 0) {
      foreach ($p in $busy) { Warn (T "Port $p ist schon belegt von: $(Get-PortHolder $p)" "Port $p is already in use by: $(Get-PortHolder $p)") }
      Note (T 'Caddy braucht 80 und 443 für das Let''s-Encrypt-Zertifikat.' 'Caddy needs 80 and 443 for the Let''s Encrypt certificate.')
      if ($Unattended) { Die (T 'Port 80 oder 443 ist belegt (-Setup local wählen oder den anderen Dienst beenden).' 'Port 80 or 443 is in use (choose -Setup local or stop the other service).') }
      Note (T 'Wähle 2: Dein Webserver leitet dann an Squorli weiter (Vorlagen im Ordner proxies, für IIS proxies\iis). Nochmal 1 = trotzdem Caddy.' 'Choose 2: your web server then forwards to Squorli (templates in the folder proxies, for IIS proxies\iis). 1 again = Caddy anyway.')
      $dSetup = 2; $insist = $true; continue
    }
    break
  }

  $S.BindIp = ''; $S.ProxyIp = ''
  if ($S.Setup -eq 'remote') {
    $dBind = Env-Get $envFile 'PROXY_BIND_IP'
    if (-not $dBind) { $dBind = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.)' } | ForEach-Object { $_.IPAddress }) | Select-Object -First 1 }
    Warn (T 'App und LiveKit sprechen unverschlüsseltes HTTP: zwischen den Rechnern sollte ein privates Netz oder VPN liegen.' 'The app and LiveKit speak unencrypted HTTP: there should be a private network or VPN between the machines.')
    while ($true) {
      $S.BindIp = Ask (T 'Adresse dieses Rechners, auf der App und LiveKit für den Proxy lauschen' 'Address of this machine on which the app and LiveKit listen for the proxy') "$dBind" $BindIp
      if (Test-IPv4 $S.BindIp) { break }
      if ($Unattended) { Die (T '-BindIp fehlt oder ist keine IPv4-Adresse.' '-BindIp is missing or no IPv4 address.') }
      Warn (T 'Bitte eine IPv4-Adresse angeben.' 'Please give an IPv4 address.')
    }
    while ($true) {
      $S.ProxyIp = Ask (T 'IP-Adresse des Proxy-Rechners (für TRUSTED_PROXIES und die Firewall)' 'IP address of the proxy machine (for TRUSTED_PROXIES and the firewall)') '' $ProxyIp
      if (Test-IPv4 $S.ProxyIp) { break }
      if ($Unattended) { Die (T '-ProxyIp fehlt oder ist keine IPv4-Adresse.' '-ProxyIp is missing or no IPv4 address.') }
      Warn (T 'Bitte eine IPv4-Adresse angeben.' 'Please give an IPv4 address.')
    }
  }

  Choose-Ports

  $dd = 1
  if ($S.Mode -eq 'reconfigure') { if (-not $dDirectory) { $dd = 2 } elseif ($dDirectory -ne $DefaultDirectory) { $dd = 3 } }
  $givenDirectory = 0
  if ($Directory -eq 'none') { $givenDirectory = 2 } elseif ($Directory -eq $DefaultDirectory) { $givenDirectory = 1 } elseif ($Directory) { $givenDirectory = 3 }
  $c = Choose (T 'Squorli Directory (globale Handles, Freunde, verschlüsselte Direktnachrichten)?' 'Squorli Directory (global handles, friends, encrypted direct messages)?') $dd @(
    (T "Ja, $DefaultDirectory" "Yes, $DefaultDirectory"),
    (T 'Nein, der Server arbeitet für sich allein (eigene Konten: ~name)' 'No, the server works on its own (its own accounts: ~name)'),
    (T 'Ein anderes Directory' 'Another directory')) $givenDirectory
  if ($c -eq 1) { $S.Directory = $DefaultDirectory } elseif ($c -eq 2) { $S.Directory = '' } else {
    if ($dd -eq 3) { $dOther = $dDirectory } else { $dOther = '' }
    while ($true) {
      $a = Ask (T 'Adresse des Directory' 'Address of the directory') $dOther $Directory
      if ($a -match '^https?://[^\s''"]+$') { $S.Directory = $a.TrimEnd('/'); break }
      if ($Unattended) { Die (T '-Directory ist keine Adresse mit https://.' '-Directory is no address with https://.') }
      Warn (T 'Bitte eine Adresse mit https:// angeben.' 'Please give an address with https://.')
    }
  }
  if ($S.Directory -and $S.Domain -eq 'localhost') { Warn (T 'Ein Server auf localhost kann sich beim Directory nicht ausweisen; die Anmeldung mit Handle klappt dann nicht.' 'A server on localhost cannot prove its host to the directory; signing in with a handle will not work.') }

  # Who becomes the owner (docs/features/local-accounts.md)
  Write-Host ''
  Note (T 'Jede Anmeldung braucht ein Konto: ein Squorli-Konto (@name) oder ein Serverkonto dieses Servers (~name).' 'Every sign-in needs an account: a Squorli account (@name) or a server account of this server (~name).')
  Note (T 'Den Besitzer legst du hier fest: dein Squorli-Konto über seinen Schlüssel, oder ein Serverkonto, das sich mit einem' 'You choose the owner here: your Squorli account by its key, or a server account that registers with a setup code this')
  Note (T 'Einrichtungscode aus diesem Skript registriert. Ohne beides wird Besitzer, wer sich zuerst anmeldet.' 'script makes. Without either, whoever signs in first becomes the owner.')
  # Default (user, 5 October 2026): with a directory the Squorli account, unless the .env already holds a setup code and
  # no key; without a directory the server account with a code; a reconfiguration that had neither keeps "whoever first".
  $owDefault = 2
  if ($S.Directory -and ($dOwner -or -not $dCode)) { $owDefault = 1 }
  if ($S.Mode -eq 'reconfigure' -and -not $dOwner -and -not $dCode) { $owDefault = 3 }
  $givenOwner = 0
  if ($Owner) { $givenOwner = [array]::IndexOf(@('key', 'code', 'first'), $Owner) + 1 }
  if ($S.Directory) {
    $ow = Choose (T 'Wer wird Besitzer?' 'Who becomes the owner?') $owDefault @(
      (T 'Mein Squorli-Konto (@name): ich gebe seinen öffentlichen Schlüssel ein' 'My Squorli account (@name): I enter its public key'),
      (T 'Ein Serverkonto (~name): ich registriere es mit einem Einrichtungscode, den dieses Skript erzeugt' 'A server account (~name): I register it with a setup code this script makes'),
      (T 'Wer sich zuerst mit Konto anmeldet (dann gleich nach dem Start selbst anmelden)' 'Whoever signs in first with an account (then sign in yourself right after the start)')) $givenOwner
  } else {
    if ($owDefault -eq 1) { $owDefault = 2 }
    if ($givenOwner -eq 1) { Die (T '-Owner key geht nur mit einem Directory.' '-Owner key needs a directory.') }
    if ($givenOwner -gt 0) { $givenOwner-- }
    $ow = 1 + (Choose (T 'Wer wird Besitzer?' 'Who becomes the owner?') ($owDefault - 1) @(
        (T 'Ein Serverkonto (~name): ich registriere es mit einem Einrichtungscode, den dieses Skript erzeugt' 'A server account (~name): I register it with a setup code this script makes'),
        (T 'Wer als Erster ein Serverkonto erstellt (dann gleich nach dem Start selbst registrieren)' 'Whoever creates the first server account (then register yourself right after the start)')) $givenOwner)
  }
  $S.Owner = ''; $S.OwnerCode = ''
  if ($ow -eq 1) {
    while ($true) {
      $k = (Ask (T 'Öffentlicher Schlüssel deines Squorli-Kontos (64 Hex-Zeichen, im Client unter Einstellungen > Konto)' 'Public key of your Squorli account (64 hex characters, in the client under Settings > Account)') $dOwner $OwnerPublicKey).ToLowerInvariant()
      if ($k -match '^[0-9a-f]{64}$') { $S.Owner = $k; break }
      if ($Unattended) { Die (T '-OwnerPublicKey: genau 64 Zeichen 0-9 und a-f.' '-OwnerPublicKey: exactly 64 characters 0-9 and a-f.') }
      Warn (T 'Genau 64 Zeichen 0-9 und a-f.' 'Exactly 64 characters 0-9 and a-f.')
    }
  } elseif ($ow -eq 2) {
    if ($dCode) { $S.OwnerCode = $dCode } else { $S.OwnerCode = New-Secret 12 }
  }

  # The address LiveKit announces for media (docs/features/dynamic-ip.md): a server with an address of its own finds it
  # itself; behind a home router the address changes, and a task of "squorli nodeip" keeps it current; or a fixed one.
  $naDefault = 1; $naGiven = 0
  if ($dNode) { $naDefault = 3 }
  if ($dDyn) { $naDefault = 2 }
  if ($NodeIp -eq 'dynamic') { $naGiven = 2 } elseif ($NodeIp) { $naGiven = 3 }
  if (-not $S.IsServer -and -not $Unattended) {
    Write-Host ''
    Note (T 'Hinter einem Router wechselt die öffentliche Adresse meist: die Domain braucht dann DynDNS, und Sprache und Video brauchen die Aufgabe (Antwort 2).' 'Behind a router the public address usually changes: the domain needs dynamic DNS then, and voice and video need the task (answer 2).')
  }
  $na = Choose (T 'Öffentliche IP-Adresse für Sprache und Video?' 'Public IP address for voice and video?') $naDefault @(
    (T 'LiveKit ermittelt sie selbst (ein Server mit eigener öffentlicher Adresse)' 'LiveKit detects it itself (a server with a public address of its own)'),
    (T 'Sie wechselt (Heimanschluss hinter einem Router): eine Aufgabe prüft sie alle 5 Minuten und passt LiveKit an' 'It changes (a home connection behind a router): a task checks it every 5 minutes and adjusts LiveKit'),
    (T 'Ich gebe eine feste Adresse ein' 'I enter a fixed address')) $naGiven
  $S.NodeDyn = $false
  switch ($na) {
    1 { $S.NodeIp = '' }
    2 { $S.NodeDyn = $true; $S.NodeIp = $dNode }
    3 {
      while ($true) {
        $ip = Ask (T 'Öffentliche IPv4-Adresse' 'Public IPv4 address') $dNode $NodeIp
        if (Test-IPv4 $ip) { $S.NodeIp = $ip; break }
        if ($Unattended) { Die (T '-NodeIp ist keine IPv4-Adresse.' '-NodeIp is no IPv4 address.') }
        Warn (T 'Bitte eine IPv4-Adresse angeben.' 'Please give an IPv4 address.')
      }
    }
  }
}

# The settings of an existing installation, for an update without questions.
function Read-Existing {
  $envFile = $S.EnvFile
  $S.Setup = $S.OldSetup
  $S.Domain = Env-Get $envFile 'PUBLIC_DOMAIN'
  $S.ServerName = Env-Get $envFile 'SERVER_NAME'; if (-not $S.ServerName) { $S.ServerName = 'Community' }
  $S.BindIp = Env-Get $envFile 'PROXY_BIND_IP'
  $S.ProxyIp = ''
  $S.Directory = Env-Get $envFile 'DIRECTORY_URL'
  $S.Owner = Env-Get $envFile 'OWNER_PUBLIC_KEY'
  $S.OwnerCode = ''
  $S.NodeIp = Env-Get $envFile 'LIVEKIT_NODE_IP'
  $S.NodeDyn = (Env-Get $envFile 'LIVEKIT_DYNAMIC_IP') -eq 'true'
  if (-not $Language) { $l = Env-Get $envFile 'SQUORLI_LANG'; if ($l -eq 'de' -or $l -eq 'en') { $S.Lang = $l } }
}

function Get-OpenPorts {
  $open = @()
  if ($S.Setup -eq 'bundled') { $open += @('80/tcp', '443/tcp') }
  $open += @("$($S.Ports.LiveKitTcpPort)/tcp", "$($S.Ports.LiveKitUdpPort)/udp")
  return $open
}

function Show-Summary {
  Step (T 'Zusammenfassung' 'Summary')
  switch ($S.Setup) {
    'bundled' { $how = T 'mitgelieferter Caddy (Let''s Encrypt)' 'bundled Caddy (Let''s Encrypt)' }
    'local' { $how = T "eigener Proxy auf diesem Rechner -> 127.0.0.1:$($S.Ports.AppPort) und 127.0.0.1:$($S.Ports.LiveKitHttpPort)" "own proxy on this machine -> 127.0.0.1:$($S.Ports.AppPort) and 127.0.0.1:$($S.Ports.LiveKitHttpPort)" }
    'remote' { $how = T "Proxy $($S.ProxyIp) -> $($S.BindIp):$($S.Ports.AppPort) und $($S.BindIp):$($S.Ports.LiveKitHttpPort)" "proxy $($S.ProxyIp) -> $($S.BindIp):$($S.Ports.AppPort) and $($S.BindIp):$($S.Ports.LiveKitHttpPort)" }
  }
  if ($S.Owner) { $owner = $S.Owner } elseif ($S.OwnerCode) { $owner = T 'Serverkonto mit Einrichtungscode' 'server account with setup code' } else { $owner = T 'wer sich zuerst anmeldet' 'whoever signs in first' }
  if ($S.Directory) { $directory = $S.Directory } else { $directory = T 'keins' 'none' }
  if ($S.NodeDyn) { $node = T 'wechselnd (Aufgabe prüft alle 5 Minuten)' 'changing (a task checks every 5 minutes)' } elseif ($S.NodeIp) { $node = $S.NodeIp } else { $node = T 'automatisch' 'automatic' }
  if ($ServiceAccount -eq 'virtual') { $account = T 'je Dienst ein eigenes (NT SERVICE\<Name>)' 'one of its own per service (NT SERVICE\<name>)' } else { $account = 'LocalService' }
  $rows = [ordered]@{}
  $rows[(T 'Programme' 'Programs')] = $S.InstallDir
  $rows[(T 'Daten' 'Data')] = $S.DataDir
  $rows['Domain'] = $S.Domain
  $rows[(T 'Servername' 'Server name')] = $S.ServerName
  $rows['HTTPS'] = $how
  $rows['Directory'] = $directory
  $rows[(T 'Besitzer' 'Owner')] = $owner
  $rows['LiveKit IP'] = $node
  $rows[(T 'Speicher für Dateien' 'Storage for files')] = $S.QuotaText
  $rows[(T 'Dienstkonto' 'Service account')] = $account
  $rows[(T 'Offene Ports' 'Open ports')] = (Get-OpenPorts) -join ' '
  foreach ($key in $rows.Keys) { Write-Host ("  {0,-18} {1}" -f $key, $rows[$key]) }
  if (-not (Confirm (T 'So installieren?' 'Install like this?') $true)) { Stop-Log; exit 0 }
}

# PostgreSQL, Node's and LiveKit's companions need Microsoft's Visual C++ runtime; the package may not ship it.
function Install-VcRuntime {
  $key = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
  if ($key -and $key.Installed -eq 1) { Ok "Microsoft Visual C++ Runtime $($key.Version)"; return }
  Step 'Microsoft Visual C++ Runtime'
  Warn (T 'Die Laufzeit von Microsoft Visual C++ fehlt; PostgreSQL startet ohne sie nicht.' 'The Microsoft Visual C++ runtime is missing; PostgreSQL does not start without it.')
  if (-not (Confirm (T 'Jetzt von Microsoft laden und installieren (aka.ms/vc14/vc_redist.x64.exe)?' 'Download it from Microsoft and install it now (aka.ms/vc14/vc_redist.x64.exe)?') $true $VcRuntime)) {
    Die (T 'Ohne die Laufzeit geht es nicht: https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist' 'The runtime is required: https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist')
  }
  $file = Join-Path $env:TEMP 'squorli-vc_redist.x64.exe'
  Invoke-WebRequest -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $file -UseBasicParsing
  # Microsoft publishes no hash for this address (it always serves the newest), so the signature decides.
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    Remove-Item -LiteralPath $file -Force
    Die (T 'Die geladene Datei ist nicht gültig von Microsoft signiert; nicht installiert.' 'The downloaded file carries no valid signature of Microsoft; not installed.')
  }
  $p = Start-Process -FilePath $file -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  if (@(0, 1638, 3010) -notcontains $p.ExitCode) { Die (T "Die Installation der Laufzeit endete mit Code $($p.ExitCode)." "The runtime's installation ended with code $($p.ExitCode).") }
  if ($p.ExitCode -eq 3010) { Warn (T 'Die Laufzeit verlangt einen Neustart des Rechners, bevor alles läuft.' 'The runtime asks for a restart of the machine before everything works.') }
  $S.Changes.Add((T 'Microsoft Visual C++ Runtime installiert' 'Microsoft Visual C++ runtime installed'))
  Ok 'Microsoft Visual C++ Runtime'
}

# Whether Windows may start a service. "disabled" also keeps its recovery actions from starting it.
function Set-StartMode([string]$name, [string]$mode) {
  $null = Invoke-Program 'sc.exe' @('config', $name, 'start=', $mode) -Quiet
}
# A service that ended with an error is started again by Windows after 5, 15 and 60 seconds (its recovery actions), and it
# takes the services it needs along. That must not happen while the programs are replaced: a program that runs cannot
# be overwritten, and one that is half copied must not start. Open-Services lets them start again, however the copy ended.
function Close-Services {
  $S.Closed = @(Get-WithDependents $S.Replace | Where-Object { Test-Service $_ })
  foreach ($name in $S.Closed) { Set-StartMode $name 'disabled' }
}
function Open-Services {
  foreach ($name in $S.Closed) { if (Test-Service $name) { Set-StartMode $name 'auto' } }
  $S.Closed = @()
}

# Which services get new programs. An update to another version replaces the programs whose version changed and
# leaves the other services running; everything else replaces all of them: a first installation, changed settings, the
# same version once more (which repairs an installation), a manifest that names no versions.
function Read-Changes {
  $S.Replace = @($ServiceNames)
  if ($S.Mode -ne 'update' -or $PSScriptRoot.TrimEnd('\') -eq $S.InstallDir) { return }
  $old = Get-Manifest $S.InstallDir
  $new = Get-Manifest $PSScriptRoot
  $have = Get-PartVersion $old 'server'
  $next = Get-PartVersion $new 'server'
  if (-not $have -or -not $next -or $have -eq $next) { return }
  Step (T 'Was sich ändert' 'What changes')
  # Caddy's service exists in the bundled mode only
  $mine = @($ServiceNames | Where-Object { $_ -ne 'SquorliCaddy' -or $S.Setup -eq 'bundled' })
  $changed = @()
  foreach ($part in @('server', 'node', 'postgresql', 'livekit', 'caddy', 'winsw')) {
    if (@($mine | Where-Object { $Programs[$_].Parts -contains $part }).Count -eq 0) { continue }
    $a = Get-PartVersion $old $part
    $b = Get-PartVersion $new $part
    if ($a -and $b -and $a -eq $b) { Note "$($PartNames[$part]) $a $(T '(unverändert)' '(unchanged)')"; continue }
    $changed += $part
    if (-not $a) { $a = '?' }
    Ok "$($PartNames[$part]) $a -> $b"
  }
  # A service this installation does not have runs nothing: its programs are replaced in any case
  $S.Replace = @($ServiceNames | Where-Object { $name = $_; $mine -notcontains $name -or @($Programs[$name].Parts | Where-Object { $changed -contains $_ }).Count -gt 0 })
  $stop = @(Get-WithDependents $S.Replace | Where-Object { $mine -contains $_ })
  $keep = @($mine | Where-Object { $stop -notcontains $_ -and (Test-ServiceRunning $_) })
  if ($keep.Count -gt 0) { Note (T "Laufen weiter: $($keep -join ', ')" "Keep running: $($keep -join ', ')") }
  Note (T "Werden angehalten und neu gestartet: $($stop -join ', ')" "Are stopped and started again: $($stop -join ', ')")
}

function Invoke-ServiceStop([string]$name) {
  Stop-Service -Name $name -Force -ErrorAction Stop
  (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
}
# Stops the given services and the ones that need them, in the order of a stop; the ones that do not run are left out.
function Stop-Running([string[]]$names) {
  $running = @(Get-WithDependents $names | Where-Object { Test-ServiceRunning $_ })
  [array]::Reverse($running)
  foreach ($name in $running) {
    try { Invoke-ServiceStop $name; Ok $name }
    catch { Die (T "$name lässt sich nicht anhalten: $($_.Exception.Message)" "$name cannot be stopped: $($_.Exception.Message)") }
  }
}
function Stop-Services {
  if (@(Get-WithDependents $S.Replace | Where-Object { Test-ServiceRunning $_ }).Count -eq 0) { return }
  Step (T 'Dienste anhalten' 'Stopping services')
  Stop-Running $S.Replace
}
# A service reads its configuration at its start: one whose files changed while it ran is stopped here, with the
# services that need it, and started again with the others.
function Stop-Changed {
  $names = @($S.Restart | Select-Object -Unique)
  $S.Restart.Clear()
  $running = @(Get-WithDependents $names | Where-Object { Test-ServiceRunning $_ })
  if ($running.Count -eq 0) { return }
  Note (T "Konfiguration geändert, Neustart: $($running -join ', ')" "Configuration changed, restarting: $($running -join ', ')")
  Stop-Running $names
}

function Copy-Folder([string]$from, [string]$to) {
  $null = Invoke-Program 'robocopy.exe' @($from, $to, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:3', '/W:2') -ok @(0, 1, 2, 3, 4, 5, 6, 7) -Quiet
}

function Copy-Programs {
  Step (T 'Programme kopieren' 'Copying programs')
  $source = $PSScriptRoot.TrimEnd('\')
  if ($source -eq $S.InstallDir) { Ok (T 'Das Skript läuft aus dem Installationsordner, nichts zu kopieren.' 'The script runs from the installation folder, nothing to copy.'); return }
  $marker = Join-Path $S.InstallDir 'manifest.json'
  if ((Test-Path -LiteralPath $S.InstallDir) -and @(Get-ChildItem -LiteralPath $S.InstallDir -Force).Count -gt 0 -and -not (Test-Path -LiteralPath $marker)) {
    Die (T "$($S.InstallDir) enthält schon etwas anderes. Bitte einen leeren Ordner wählen (-InstallDir)." "$($S.InstallDir) already holds something else. Please choose an empty folder (-InstallDir).")
  }
  # The cluster was made by one major version of PostgreSQL and is read by that one only.
  $versionFile = Join-Path $S.DataDir 'pgdata\PG_VERSION'
  if (Test-Path -LiteralPath $versionFile) {
    $have = ([IO.File]::ReadAllText($versionFile)).Trim()
    $said = (Invoke-Program (Join-Path $source 'pgsql\bin\postgres.exe') @('--version') -Quiet) -join ' '
    if ($said -notmatch "\) $([regex]::Escape($have))\.") { Die (T "Die Datenbank stammt von PostgreSQL $have, das Paket bringt '$said'. Ein Wechsel der Hauptversion braucht eine Sicherung und ein Zurückspielen (squorli backup, squorli restore)." "The database was made by PostgreSQL $have, the package brings '$said'. A change of the major version needs a backup and a restore (squorli backup, squorli restore).") }
  }
  New-Item -ItemType Directory -Force -Path $S.InstallDir | Out-Null
  # The programs of a service that keeps running stay as they are: they are in use, and the package brings the same
  $kept = @()
  foreach ($name in $ServiceNames) { if ($S.Replace -notcontains $name) { $kept += $Programs[$name].Folders } }
  foreach ($folder in @('app', 'node', 'livekit', 'caddy', 'pgsql', 'templates', 'licenses', 'proxies', 'bin')) {
    if ($kept -contains $folder) { continue }
    if (Test-Path -LiteralPath (Join-Path $source $folder)) { Copy-Folder (Join-Path $source $folder) (Join-Path $S.InstallDir $folder) }
  }
  # winsw holds the filled service files of this installation next to the program: only the program is replaced.
  New-Item -ItemType Directory -Force -Path (Join-Path $S.InstallDir 'winsw') | Out-Null
  Copy-Item -LiteralPath (Join-Path $source 'winsw\WinSW.exe') -Destination (Join-Path $S.InstallDir 'winsw\WinSW.exe') -Force
  foreach ($file in @(Get-ChildItem -LiteralPath $source -File)) { Copy-Item -LiteralPath $file.FullName -Destination $S.InstallDir -Force }
  # Files out of a downloaded ZIP carry the mark "from the internet", which makes PowerShell refuse or ask.
  Get-ChildItem -LiteralPath $S.InstallDir -Recurse -File -Include '*.ps1', '*.cmd', '*.exe', '*.dll' | Unblock-File -ErrorAction SilentlyContinue
  if ($kept.Count -gt 0) { Ok "$($S.InstallDir) ($(T 'unverändert' 'unchanged'): $($kept -join ', '))" } else { Ok $S.InstallDir }
}

function Write-Env {
  Step (T '.env schreiben' 'Writing .env')
  $envFile = $S.EnvFile
  New-Item -ItemType Directory -Force -Path $S.DataDir | Out-Null
  if (-not (Test-Path -LiteralPath $envFile)) {
    # The file is made empty and closed to others first, then filled.
    [IO.File]::WriteAllText($envFile, '', $Utf8)
    Set-Access $envFile
    [IO.File]::WriteAllText($envFile, ([IO.File]::ReadAllText((Join-Path $S.InstallDir 'templates\env.example'), $Utf8)).Replace("`r`n", "`n"), $Utf8)
  } else {
    $backup = "$envFile.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $envFile -Destination $backup
    Set-Access $backup
  }
  if ($S.Setup -eq 'bundled') { $proxyMode = 'bundled' } else { $proxyMode = 'external' }
  if ($S.Setup -eq 'remote') { $listen = $S.BindIp } else { $listen = '127.0.0.1' }
  Env-Set $envFile 'NODE_ENV' 'production'
  Env-Set $envFile 'PUBLIC_DOMAIN' $S.Domain
  Env-Set $envFile 'SERVER_NAME' $S.ServerName
  Env-Set $envFile 'PROXY_MODE' $proxyMode
  Env-Set $envFile 'SQUORLI_SETUP' $S.Setup
  Env-Set $envFile 'SQUORLI_LANG' $S.Lang
  Env-Set $envFile 'LISTEN_HOST' $listen
  Env-Set $envFile 'DATA_DIR' (Join-Path $S.DataDir 'data')
  Env-Set $envFile 'DIRECTORY_URL' $S.Directory
  Env-Set $envFile 'OWNER_PUBLIC_KEY' $S.Owner
  if ($S.Mode -ne 'update') { Env-Set $envFile 'OWNER_SETUP_CODE' $S.OwnerCode }
  Env-Set $envFile 'LIVEKIT_NODE_IP' $S.NodeIp
  if ($S.NodeDyn) { Env-Set $envFile 'LIVEKIT_DYNAMIC_IP' 'true' } else { Env-Set $envFile 'LIVEKIT_DYNAMIC_IP' '' }
  Env-Set $envFile 'PORT' "$($S.Ports.AppPort)"
  foreach ($name in $PortInfo.Keys) { Env-Set $envFile $PortInfo[$name].Env "$($S.Ports[$name])" }
  Env-Set $envFile 'LIVEKIT_URL' "http://127.0.0.1:$($S.Ports.LiveKitHttpPort)"
  # On localhost there is no proxy with a certificate in front: the browser talks to LiveKit directly.
  $public = Env-Get $envFile 'LIVEKIT_PUBLIC_URL'
  if ($S.Domain -eq 'localhost') { Env-Set $envFile 'LIVEKIT_PUBLIC_URL' "ws://localhost:$($S.Ports.LiveKitHttpPort)" }
  elseif ($public -match '^ws://localhost:') { Env-Set $envFile 'LIVEKIT_PUBLIC_URL' '' }

  # Secrets: kept when present, generated when missing or still the template's placeholder
  $password = Env-Get $envFile 'POSTGRES_PASSWORD'
  if ($S.ContainsKey('OldDbPassword')) { $password = $S.OldDbPassword }
  if (-not $password -or $password -eq 'change-me') { $password = New-Secret }
  Env-Set $envFile 'POSTGRES_PASSWORD' $password
  Env-Set $envFile 'DATABASE_URL' "postgres://chat:$password@127.0.0.1:$($S.Ports.PostgresPort)/chat"
  $key = Env-Get $envFile 'LIVEKIT_API_KEY'
  if (-not $key -or $key -eq 'devkey') { Env-Set $envFile 'LIVEKIT_API_KEY' 'squorli' }
  $secret = Env-Get $envFile 'LIVEKIT_API_SECRET'
  if ($secret.Length -lt 32 -or $secret -eq 'change-me-to-at-least-32-random-characters') { Env-Set $envFile 'LIVEKIT_API_SECRET' (New-Secret) }
  # Storage quota (docs/features/limits.md; security audit S13, 4 October 2026): a fresh installation gets 80 % of the free space
  # of the data folder's drive; a value the operator set stays.
  if (-not (Env-Get $envFile 'STORAGE_QUOTA_MB') -and $S.QuotaMb) { Env-Set $envFile 'STORAGE_QUOTA_MB' "$($S.QuotaMb)" }
  # What squorli doctor shows the app server instead of a session (a proxy on this machine arrives from 127.0.0.1 too)
  if ((Env-Get $envFile 'DOCTOR_TOKEN').Length -lt 32) { Env-Set $envFile 'DOCTOR_TOKEN' (New-Secret) }

  $trusted = Env-Get $envFile 'TRUSTED_PROXIES'
  if (-not $trusted) { $trusted = '127.0.0.1' }
  if ($S.Setup -eq 'remote') {
    Env-Set $envFile 'PROXY_BIND_IP' $S.BindIp
    if ($S.ProxyIp -and (",$trusted," -notlike "*,$($S.ProxyIp),*")) { $trusted = "$trusted,$($S.ProxyIp)" }
  }
  Env-Set $envFile 'TRUSTED_PROXIES' $trusted
  Ok "$envFile ($(T 'nur für Administratoren und den Dienst lesbar' 'readable by administrators and the service only'))"
}

# Fills the {{...}} places of a template and writes the result; an existing file that differs is kept as .bak.
function Write-Template([string]$template, [string]$target, [hashtable]$values, [switch]$Xml) {
  $text = [IO.File]::ReadAllText((Join-Path $S.InstallDir "templates\$template"), $Utf8).Replace("`r`n", "`n")
  foreach ($key in $values.Keys) {
    $value = [string]$values[$key]
    if ($Xml) { $value = [Security.SecurityElement]::Escape($value) }
    $text = $text.Replace("{{$key}}", $value)
  }
  if ($text -match '\{\{[A-Z_]+\}\}') { throw "${template}: $($Matches[0])" }
  if (Test-Path -LiteralPath $target) {
    $old = [IO.File]::ReadAllText($target, $Utf8)
    if ($old -eq $text) { return }
    if ($old.Trim()) {
      Copy-Item -LiteralPath $target -Destination "$target.bak" -Force
      Warn (T "$target geändert, alte Fassung: $target.bak" "$target changed, old version: $target.bak")
    }
  }
  [IO.File]::WriteAllText($target, $text, $Utf8)
  $S.Written.Add($target)
}

function Write-Configuration {
  Step (T 'Konfiguration schreiben' 'Writing the configuration')
  $config = Join-Path $S.DataDir 'config'
  foreach ($folder in @('config', 'data', 'logs', 'caddy', 'backups', 'pgdata')) { New-Item -ItemType Directory -Force -Path (Join-Path $S.DataDir $folder) | Out-Null }
  if ($S.Setup -eq 'remote') { $bind = "`"127.0.0.1`", `"$($S.BindIp)`"" } else { $bind = '"127.0.0.1"' }
  $values = @{
    INSTALL_DIR = $S.InstallDir; DATA_DIR = $S.DataDir; DATA_DIR_SLASHES = $S.DataDir.Replace('\', '/'); PUBLIC_DOMAIN = $S.Domain
    APP_PORT = $S.Ports.AppPort; LIVEKIT_HTTP_PORT = $S.Ports.LiveKitHttpPort; LIVEKIT_TCP_PORT = $S.Ports.LiveKitTcpPort
    LIVEKIT_UDP_PORT = $S.Ports.LiveKitUdpPort; POSTGRES_PORT = $S.Ports.PostgresPort; LIVEKIT_BIND = $bind; LIVEKIT_NODE_IP = $S.NodeIp
    LIVEKIT_API_KEY = (Env-Get $S.EnvFile 'LIVEKIT_API_KEY'); LIVEKIT_API_SECRET = (Env-Get $S.EnvFile 'LIVEKIT_API_SECRET')
  }
  $S.Values = $values
  # Closed to others before the key is written into it
  $yaml = Join-Path $config 'livekit.yaml'
  if (-not (Test-Path -LiteralPath $yaml)) { [IO.File]::WriteAllText($yaml, '', $Utf8); Set-Access $yaml }
  Write-Template 'livekit.yaml' $yaml $values
  if ($S.Written -contains $yaml) { $S.Restart.Add('SquorliLiveKit') }
  if ($S.Setup -eq 'bundled') {
    Write-Template 'Caddyfile' (Join-Path $config 'Caddyfile') $values
    if ($S.Written -contains (Join-Path $config 'Caddyfile')) { $S.Restart.Add('SquorliCaddy') }
  }
  foreach ($name in $WrappedServices) {
    if ($name -eq 'SquorliCaddy' -and $S.Setup -ne 'bundled') { continue }
    $xml = Join-Path $S.InstallDir "winsw\$name.xml"
    Write-Template "$name.xml" $xml $values -Xml
    if ($S.Written -contains $xml) { $S.Restart.Add($name) }
    # A service that kept running holds its copy of WinSW open; it is the same version, or the service would be stopped
    $exe = Join-Path $S.InstallDir "winsw\$name.exe"
    if ((Test-Path -LiteralPath $exe) -and (Test-ServiceRunning $name)) { continue }
    Copy-Item -LiteralPath (Join-Path $S.InstallDir 'winsw\WinSW.exe') -Destination $exe -Force
  }
  Ok $config
}

# Who may read and write what under the data folder. Comes after the services are registered: Windows knows the account
# of a service (NT SERVICE\<name>) only while the service exists, and icacls refuses a SID it cannot name.
function Set-DataAccess {
  $app = Get-AccountSid 'SquorliServer'; $livekit = Get-AccountSid 'SquorliLiveKit'; $postgres = Get-AccountSid 'SquorliPostgres'
  # Caddy's service exists in the bundled mode only; without it its account cannot be named, and its files stay closed.
  $caddyGrant = @{}
  $caddyRead = @{}
  $accounts = @($app, $livekit, $postgres)
  if ($S.Setup -eq 'bundled') { $caddy = Get-AccountSid 'SquorliCaddy'; $caddyGrant[$caddy] = 'M'; $caddyRead[$caddy] = 'R'; $accounts += $caddy }
  Set-Access $S.DataDir
  Set-Access $S.EnvFile @{ $app = 'R' }
  Set-Access (Join-Path $S.DataDir 'config')
  Set-Access (Join-Path $S.DataDir 'config\livekit.yaml') @{ $livekit = 'R' }
  if (Test-Path -LiteralPath (Join-Path $S.DataDir 'config\Caddyfile')) { Set-Access (Join-Path $S.DataDir 'config\Caddyfile') $caddyRead }
  Set-Access (Join-Path $S.DataDir 'data') @{ $app = 'M' }
  Set-Access (Join-Path $S.DataDir 'caddy') $caddyGrant
  Set-Access (Join-Path $S.DataDir 'backups')
  $logs = @{}
  foreach ($sid in @($accounts | Select-Object -Unique)) { $logs[$sid] = 'M' }
  Set-Access (Join-Path $S.DataDir 'logs') $logs
  Set-Access (Join-Path $S.DataDir 'pgdata') @{ $postgres = 'F' }
  Ok (T 'Zugriffsrechte gesetzt (nur SYSTEM, Administratoren und der jeweilige Dienst)' 'Access rights set (SYSTEM, administrators and the service concerned only)')
}

function Invoke-Psql([string]$database, [string]$sql) {
  $env:PGPASSWORD = Env-Get $S.EnvFile 'POSTGRES_PASSWORD'
  try { return (Invoke-Program (Join-Path $S.InstallDir 'pgsql\bin\psql.exe') @('-h', '127.0.0.1', '-p', "$($S.Ports.PostgresPort)", '-U', 'chat', '-d', $database, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-c', $sql) -Quiet) }
  finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}

function Set-ServiceAccount([string]$name) {
  if ($ServiceAccount -eq 'virtual') { $account = "NT SERVICE\$name" } else { $account = 'NT AUTHORITY\LocalService' }
  try { $null = Invoke-Program 'sc.exe' @('config', $name, 'obj=', $account) -Quiet }
  catch { Die (T "Das Konto $account lässt sich für $name nicht setzen. Mit einem gemeinsamen Konto noch einmal versuchen: install.ps1 -ServiceAccount localservice" "The account $account cannot be set for $name. Try again with one shared account: install.ps1 -ServiceAccount localservice") }
  $null = Invoke-Program 'sc.exe' @('failure', $name, 'reset=', '3600', 'actions=', 'restart/5000/restart/15000/restart/60000') -Quiet
}

function Wait-Service([string]$name, [string]$status, [int]$seconds = 60) {
  try { (Get-Service -Name $name).WaitForStatus($status, [TimeSpan]::FromSeconds($seconds)); return $true } catch { return $false }
}

function Show-ServiceLog([string]$name) {
  $logs = Join-Path $S.DataDir 'logs'
  foreach ($file in @(Get-ChildItem -LiteralPath $logs -Filter "$name*" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
    Write-Host "  $($file.FullName):" -ForegroundColor DarkGray
    Get-Content -LiteralPath $file.FullName -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Note $_ }
  }
}

function Invoke-ServiceStart([string]$name) {
  try { Start-Service -Name $name -ErrorAction Stop } catch { Show-ServiceLog $name; Die (T "$name startet nicht: $($_.Exception.Message)" "$name does not start: $($_.Exception.Message)") }
  if (-not (Wait-Service $name 'Running')) { Show-ServiceLog $name; Die (T "$name läuft nach 60 Sekunden nicht." "$name is not running after 60 seconds.") }
}
function Start-SquorliService([string]$name) {
  if (Test-ServiceRunning $name) { Ok "$name $(T '(lief weiter)' '(kept running)')"; return }
  Invoke-ServiceStart $name
  Ok $name
}

function Install-Postgres {
  Step 'PostgreSQL'
  $bin = Join-Path $S.InstallDir 'pgsql\bin'
  $pgdata = Join-Path $S.DataDir 'pgdata'
  $fresh = -not (Test-Path -LiteralPath (Join-Path $pgdata 'PG_VERSION'))
  if ($fresh) {
    # initdb gives up its administrator rights before it writes, so the person who runs this needs rights of their own
    # on the folder for that moment; everything it creates inherits the service's rights.
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $null = Invoke-Program 'icacls.exe' @($pgdata, '/grant', "*${me}:(OI)(CI)F", '/Q') -Quiet
    $pwFile = Join-Path $S.DataDir 'pgdata.pw'
    [IO.File]::WriteAllText($pwFile, '', $Utf8); Set-Access $pwFile @{ $me = 'R' }
    [IO.File]::WriteAllText($pwFile, (Env-Get $S.EnvFile 'POSTGRES_PASSWORD'), (New-Object Text.ASCIIEncoding))
    try {
      # Locale C: text sorts by bytes like in the Docker installation's database, and nothing depends on Windows' locales.
      $null = Invoke-Program (Join-Path $bin 'initdb.exe') @('-D', $pgdata, '-U', 'chat', '-E', 'UTF8', '--locale=C', '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', "--pwfile=$pwFile") -Quiet
    } finally { Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue }
    $null = Invoke-Program 'icacls.exe' @($pgdata, '/remove:g', "*$me", '/T', '/C', '/Q') -Quiet
    Set-Access $pgdata @{ (Get-AccountSid 'SquorliPostgres') = 'F' }
    # initdb's own rules of access are replaced as a whole; no copy of them is kept
    Remove-Item -LiteralPath (Join-Path $pgdata 'pg_hba.conf') -Force
    Ok (T 'Datenbank-Cluster angelegt (UTF8, Locale C)' 'Database cluster created (UTF8, locale C)')
  }
  Write-Template 'postgresql.squorli.conf' (Join-Path $pgdata 'postgresql.squorli.conf') $S.Values
  Write-Template 'pg_hba.conf' (Join-Path $pgdata 'pg_hba.conf') $S.Values
  if (@($S.Written | Where-Object { $_ -like (Join-Path $pgdata '*') }).Count -gt 0) { $S.Restart.Add('SquorliPostgres') }
  $conf = Join-Path $pgdata 'postgresql.conf'
  if (([IO.File]::ReadAllText($conf)) -notmatch "(?m)^include = 'postgresql\.squorli\.conf'") { [IO.File]::AppendAllText($conf, "`ninclude = 'postgresql.squorli.conf'`n"); $S.Restart.Add('SquorliPostgres') }
  Stop-Changed

  Start-SquorliService 'SquorliPostgres'
  $ready = $false
  foreach ($i in 1..30) {
    try { $null = Invoke-Program (Join-Path $bin 'pg_isready.exe') @('-h', '127.0.0.1', '-p', "$($S.Ports.PostgresPort)", '-q') -Quiet; $ready = $true; break } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { Show-ServiceLog 'SquorliPostgres'; Die (T 'PostgreSQL nimmt keine Verbindungen an.' 'PostgreSQL accepts no connections.') }
  try {
    $exists = (Invoke-Psql 'postgres' "select 1 from pg_database where datname = 'chat'") -join ''
  } catch {
    Die (T 'Die Anmeldung an der Datenbank ist fehlgeschlagen: das POSTGRES_PASSWORD in .env passt nicht zur vorhandenen Datenbank.' 'Signing in to the database failed: POSTGRES_PASSWORD in .env does not match the existing database.')
  }
  if ($exists.Trim() -ne '1') { $null = Invoke-Psql 'postgres' 'CREATE DATABASE chat OWNER chat'; Ok (T 'Datenbank chat angelegt' 'Database chat created') } else { Ok (T 'Datenbank chat vorhanden' 'Database chat is there') }
}

function Install-Services {
  Step (T 'Dienste registrieren' 'Registering services')
  # Leaving the bundled mode: Caddy would keep holding 80/443
  if ($S.Setup -ne 'bundled' -and (Test-Service 'SquorliCaddy')) {
    $null = Invoke-Program (Join-Path $S.InstallDir 'winsw\SquorliCaddy.exe') @('uninstall') -Quiet
    $S.Changes.Add((T 'Dienst SquorliCaddy entfernt' 'Service SquorliCaddy removed'))
  }
  if (-not (Test-Service 'SquorliPostgres')) {
    # The cluster's folder need not be filled yet: the service is only entered here and started after initdb.
    $null = Invoke-Program (Join-Path $S.InstallDir 'pgsql\bin\pg_ctl.exe') @('register', '-N', 'SquorliPostgres', '-D', (Join-Path $S.DataDir 'pgdata'), '-S', 'auto', '-w') -Quiet
    $null = Invoke-Program 'sc.exe' @('description', 'SquorliPostgres', 'Squorli: database (PostgreSQL), on 127.0.0.1 only.') -Quiet
    $S.Changes.Add((T 'Dienst SquorliPostgres registriert' 'Service SquorliPostgres registered'))
  }
  Set-ServiceAccount 'SquorliPostgres'
  Ok 'SquorliPostgres'
  foreach ($name in @('SquorliLiveKit', 'SquorliServer', 'SquorliCaddy')) {
    if ($name -eq 'SquorliCaddy' -and $S.Setup -ne 'bundled') { continue }
    if (-not (Test-Service $name)) {
      $null = Invoke-Program (Join-Path $S.InstallDir "winsw\$name.exe") @('install') -Quiet
      $S.Changes.Add((T "Dienst $name registriert" "Service $name registered"))
    }
    Set-ServiceAccount $name
    Ok $name
  }
}

function Set-Firewall {
  $enabled = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.Enabled })
  if ($enabled.Count -eq 0) { return }
  Step 'Firewall'
  $open = Get-OpenPorts
  $extra = ''
  if ($S.Setup -eq 'remote') { $extra = T ", dazu $($S.Ports.AppPort)/tcp und $($S.Ports.LiveKitHttpPort)/tcp nur für $($S.ProxyIp)" ", and $($S.Ports.AppPort)/tcp and $($S.Ports.LiveKitHttpPort)/tcp for $($S.ProxyIp) only" }
  if (Confirm (T "Die Windows-Firewall ist aktiv. $($open -join ' ') für alle freigeben${extra}?" "The Windows firewall is active. Open $($open -join ' ') to everyone${extra}?") $true $Firewall) {
    Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $livekit = Join-Path $S.InstallDir 'livekit\livekit-server.exe'
    $null = New-NetFirewallRule -DisplayName 'Squorli LiveKit media (TCP)' -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $S.Ports.LiveKitTcpPort -Program $livekit
    $null = New-NetFirewallRule -DisplayName 'Squorli LiveKit media (UDP)' -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol UDP -LocalPort $S.Ports.LiveKitUdpPort -Program $livekit
    if ($S.Setup -eq 'bundled') {
      $null = New-NetFirewallRule -DisplayName 'Squorli Caddy (HTTP, HTTPS)' -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80, 443 -Program (Join-Path $S.InstallDir 'caddy\caddy.exe')
    }
    if ($S.Setup -eq 'remote') {
      $null = New-NetFirewallRule -DisplayName 'Squorli app server (proxy only)' -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $S.Ports.AppPort -RemoteAddress $S.ProxyIp -Program (Join-Path $S.InstallDir 'node\node.exe')
      $null = New-NetFirewallRule -DisplayName 'Squorli LiveKit signaling (proxy only)' -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $S.Ports.LiveKitHttpPort -RemoteAddress $S.ProxyIp -Program $livekit
    }
    $S.Changes.Add((T "Firewall-Regeln der Gruppe `"$FirewallGroup`": $($open -join ' ')$extra" "Firewall rules of the group `"$FirewallGroup`": $($open -join ' ')$extra"))
    Ok "$($open -join ' ')"
  }
  Write-Host ''
  if ($S.IsServer) {
    Note (T 'Eine Firewall beim Hoster muss dieselben Ports durchlassen.' 'A firewall at the hosting provider has to let the same ports through.')
  } else {
    Note (T "Am Router weiterleiten (auf dieselbe Nummer, an diesen Rechner): $($open -join ' ')." "Forward at the router (to the same number, to this machine): $($open -join ' ').")
    Note (T 'Wechselt die öffentliche Adresse des Anschlusses, braucht die Domain DynDNS.' 'If the connection''s public address changes, the domain needs dynamic DNS.')
  }
}

# Waits until the address answers with the status; returns the answer's text, or $null after the time.
function Wait-Http([string]$url, [int]$status, [int]$tries = 30, [int]$pause = 2) {
  foreach ($i in 1..$tries) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ([int]$r.StatusCode -eq $status) { return "$($r.Content)" }
    } catch {
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -eq $status) { return '' }
    }
    Start-Sleep -Seconds $pause
  }
  return $null
}

function Start-All {
  Step (T 'Dienste starten' 'Starting services')
  Stop-Changed
  Start-SquorliService 'SquorliLiveKit'
  Start-SquorliService 'SquorliServer'
  if ($S.Setup -eq 'bundled') { Start-SquorliService 'SquorliCaddy' }
}

function Test-Installation {
  Step (T 'Prüfen' 'Checking')
  if ($S.Setup -eq 'remote') { $hostName = $S.BindIp } else { $hostName = '127.0.0.1' }
  $health = Wait-Http "http://${hostName}:$($S.Ports.AppPort)/api/health" 200 60 2
  if ($null -eq $health) { Show-ServiceLog 'SquorliServer'; Die (T 'Der App-Server antwortet nicht.' 'The app server does not answer.') }
  $info = $health | ConvertFrom-Json
  if ($info.domain -ne $S.Domain -or -not $info.serverKey) { Warn (T "/api/health nennt domain=$($info.domain), serverKey=$([bool]$info.serverKey)" "/api/health says domain=$($info.domain), serverKey=$([bool]$info.serverKey)") }
  else { Ok "http://${hostName}:$($S.Ports.AppPort)/api/health (domain $($info.domain), version $($info.version))" }
  # LiveKit asks a STUN server for its public address before it answers: a few seconds
  if ($null -ne (Wait-Http "http://127.0.0.1:$($S.Ports.LiveKitHttpPort)/rtc/validate" 401 30 2)) { Ok "http://127.0.0.1:$($S.Ports.LiveKitHttpPort)/rtc/validate -> 401" }
  else { Show-ServiceLog 'SquorliLiveKit'; Warn (T "LiveKit antwortet nicht auf 127.0.0.1:$($S.Ports.LiveKitHttpPort)." "LiveKit does not answer on 127.0.0.1:$($S.Ports.LiveKitHttpPort).") }
  if ($S.Setup -eq 'bundled') {
    if ($null -ne (Wait-Http "https://$($S.Domain)/api/health" 200 12 5)) {
      Ok "https://$($S.Domain)/api/health"
      if ($null -ne (Wait-Http "https://$($S.Domain)/rtc/validate" 401 3 2)) { Ok "https://$($S.Domain)/rtc/validate -> 401" } else { Warn "https://$($S.Domain)/rtc/validate: $(T 'erwartet 401' 'expected 401')" }
    } else {
      Show-ServiceLog 'SquorliCaddy'
      Warn (T "https://$($S.Domain) antwortet noch nicht. Meist fehlt der DNS-Eintrag, oder Port 80/443 ist von außen nicht erreichbar (Router, Firewall); Caddy versucht es weiter." "https://$($S.Domain) does not answer yet. Usually the DNS record is missing, or port 80/443 is not reachable from outside (router, firewall); Caddy keeps trying.")
    }
  }
}

# A changing public address (docs/features/dynamic-ip.md): the command finds it now and registers its task; an update keeps
# what is there, and whoever chose another answer loses the task.
function Set-NodeIpTask {
  if ($S.Mode -eq 'update') { return }
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $S.InstallDir 'squorli.ps1'
  $common = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script)
  if ($S.NodeDyn) {
    Step (T 'Öffentliche Adresse für Sprache und Video' 'Public address for voice and video')
    $null = Invoke-Program $ps ($common + @('nodeip', 'check', '-DataDir', $S.DataDir)) @(0, 1)
    $null = Invoke-Program $ps ($common + @('nodeip', 'on', '5', '-DataDir', $S.DataDir)) @(0, 1)
    $S.Changes.Add((T "Aufgabe `"SquorliNodeIp`" der Aufgabenplanung (alle 5 Minuten; squorli nodeip off entfernt sie)" "Task `"SquorliNodeIp`" of the task scheduler (every 5 minutes; squorli nodeip off removes it)"))
  } else {
    # Another answer than "it changes": a task from before goes (Invoke-Program throws when schtasks finds none)
    $exists = $true
    try { $null = Invoke-Program 'schtasks.exe' @('/Query', '/TN', 'SquorliNodeIp') -Quiet } catch { $exists = $false }
    if ($exists) { $null = Invoke-Program $ps ($common + @('nodeip', 'off', '-DataDir', $S.DataDir)) @(0, 1) -Quiet }
  }
}

# A PC goes to sleep by itself, and a sleeping server answers nobody.
function Set-KeepAwake {
  if ($S.IsServer) { return }
  Step (T 'Energiesparen' 'Power saving')
  Note (T 'Im Standby ist der Server nicht erreichbar. Das betrifft nur den Netzbetrieb; der Bildschirm darf weiter ausgehen.' 'In standby the server is unreachable. This concerns mains power only; the screen may still turn off.')
  if (Confirm (T 'Standby und Ruhezustand im Netzbetrieb abschalten?' 'Switch off standby and hibernation on mains power?') $true $KeepAwake) {
    $null = Invoke-Program 'powercfg.exe' @('/change', 'standby-timeout-ac', '0') -Quiet
    $null = Invoke-Program 'powercfg.exe' @('/change', 'hibernate-timeout-ac', '0') -Quiet
    $S.Changes.Add((T 'Standby und Ruhezustand im Netzbetrieb abgeschaltet (zurück: Einstellungen > System > Netzbetrieb und Energiesparen)' 'Standby and hibernation on mains power switched off (back: Settings > System > Power & sleep)'))
    Ok (T 'abgeschaltet' 'switched off')
  }
}

# The PATH gets the folder bin, which holds squorli.cmd and nothing else: with the program folder itself in the PATH,
# PowerShell finds squorli.ps1 before squorli.cmd and refuses it where scripts are not allowed (the default of a PC), and
# "install" or "uninstall" typed anywhere would start these scripts.
# The PATH with the folder bin in it and without the program folder itself (an entry of a setup before 28 September 2026).
function Get-PathWith([string]$current, [string]$installDir) {
  $bin = Join-Path $installDir 'bin'
  $parts = @("$current".Split(';') | Where-Object { $_ })
  $kept = @($parts | Where-Object { $_.TrimEnd('\') -ine $installDir })
  if (@($kept | Where-Object { $_.TrimEnd('\') -ieq $bin }).Count -eq 0) { $kept += $bin }
  return ($kept -join ';')
}
function Add-ToPath {
  $bin = Join-Path $S.InstallDir 'bin'
  if (-not (Test-Path -LiteralPath (Join-Path $bin 'squorli.cmd'))) { return }
  $current = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $next = Get-PathWith $current $S.InstallDir
  if ($next -eq (@("$current".Split(';') | Where-Object { $_ }) -join ';')) { return }
  [Environment]::SetEnvironmentVariable('Path', $next, 'Machine')
  $S.Changes.Add((T "$bin in den PATH des Rechners eingetragen (gilt in neu geöffneten Fenstern)" "$bin added to the machine's PATH (applies to newly opened windows)"))
}

function Show-Finish {
  Step (T 'Fertig' 'Done')
  if ($S.Setup -ne 'bundled') {
    if ($S.Setup -eq 'remote') { $hostName = $S.BindIp } else { $hostName = '127.0.0.1' }
    Write-Host (T "Jetzt den Reverse Proxy einrichten (TLS für $($S.Domain), WebSockets an):" "Now set up the reverse proxy (TLS for $($S.Domain), WebSockets on):")
    Write-Host "  https://$($S.Domain)/      -> http://${hostName}:$($S.Ports.AppPort)"
    Write-Host "  https://$($S.Domain)/rtc*  -> http://${hostName}:$($S.Ports.LiveKitHttpPort)"
    if (Test-Path -LiteralPath (Join-Path $S.InstallDir 'proxies')) { Write-Host (T "Vorlagen und Anleitung: $($S.InstallDir)\proxies (README.md; für IIS der Ordner iis)" "Templates and guide: $($S.InstallDir)\proxies (README.md; for IIS the folder iis)") }
    Write-Host ''
  }
  if ($S.Ports.LiveKitTcpPort -ne 7881 -or $S.Ports.LiveKitUdpPort -ne 7882) {
    Write-Host (T "Sprache und Video laufen über $($S.Ports.LiveKitTcpPort)/tcp und $($S.Ports.LiveKitUdpPort)/udp: diese Nummern in Firewall und Router freigeben bzw. weiterleiten (auf dieselbe Nummer)." "Voice and video use $($S.Ports.LiveKitTcpPort)/tcp and $($S.Ports.LiveKitUdpPort)/udp: open or forward these numbers in firewall and router (to the same number).")
    Write-Host ''
  }
  if ($S.Changes.Count -gt 0) {
    Write-Host (T 'Am Rechner geändert:' 'Changed on this machine:')
    foreach ($change in $S.Changes) { Write-Host "  - $change" }
    Write-Host ''
  }
  if ($S.Domain -eq 'localhost') { $address = "http://localhost:$($S.Ports.AppPort)" } else { $address = "https://$($S.Domain)" }
  Write-Host "$(T 'Adresse:' 'Address:') " -NoNewline; Write-Host $address -ForegroundColor White
  if ($S.ContainsKey('Log')) { $log = $S.Log; Stop-Log; Write-Host "$(T 'Protokoll dieses Laufs:' 'Log of this run:') $log" -ForegroundColor DarkGray }
  # After the log is closed: the code is a secret until somebody used it.
  if ($S.OwnerCode) {
    Write-Host (T "Besitzer werden: auf $address ein Serverkonto (~name) registrieren und dabei diesen Einrichtungscode eingeben:" "To become the owner: register a server account (~name) on $address and enter this setup code:") -ForegroundColor Yellow
    Write-Host "  $($S.OwnerCode)" -ForegroundColor White
    Write-Host (T "Der Code steht auch in $($S.EnvFile) (OWNER_SETUP_CODE); sobald es einen Besitzer gibt, wirkt er nicht mehr." "The code is also in $($S.EnvFile) (OWNER_SETUP_CODE); once there is an owner it has no effect any more.")
  } elseif (-not $S.Owner -and $S.Mode -eq 'fresh') {
    if ($S.Directory) { Write-Host (T 'Wer sich als Erster mit Konto anmeldet, wird Besitzer: jetzt gleich selbst anmelden (mit @name).' 'Whoever signs in first with an account becomes the owner: sign in yourself right now (with @name).') -ForegroundColor Yellow }
    else { Write-Host (T 'Wer als Erster ein Serverkonto erstellt, wird Besitzer: jetzt gleich selbst registrieren (~name und Passwort).' 'Whoever creates the first server account becomes the owner: register yourself right now (~name and password).') -ForegroundColor Yellow }
  }
  Write-Host ''
  if (Test-Path -LiteralPath (Join-Path $S.InstallDir 'bin\squorli.cmd')) {
    Write-Host (T 'Verwalten (in einem neu geöffneten Fenster, als Administrator):' 'Manage (in a newly opened window, as administrator):')
    Write-Host "  squorli status      $(T 'Dienste und Erreichbarkeit anzeigen' 'show the services and whether the server answers')"
    Write-Host "  squorli logs server $(T 'Logs ansehen' 'read the logs')"
    Write-Host "  squorli update      $(T 'neue Version holen und neu starten (sichert vorher)' 'fetch the new version and restart (backs up first)')"
    Write-Host "  squorli backup      $(T "Datenbank, Dateien und .env nach $($S.DataDir)\backups sichern" "back up database, files and .env to $($S.DataDir)\backups")"
    Write-Host "  squorli restore <$(T 'Ordner' 'dir')>  $(T 'eine Sicherung zurückspielen (ersetzt Datenbank und Dateien)' 'restore a backup (replaces database and files)')"
    Write-Host "  squorli doctor      $(T 'prüfen, was bei der Einrichtung am häufigsten schiefgeht' 'check what goes wrong most often in a setup')"
    Write-Host "  squorli autoupdate  $(T 'automatische Updates ein- und ausschalten (on, off)' 'switch automatic updates on and off (on, off)')"
    Write-Host "  squorli nodeip      $(T 'die öffentliche Adresse für Sprache und Video: Stand, check, on, off' 'the public address for voice and video: state, check, on, off')"
  } else {
    Write-Host (T 'Dienste ansehen: Get-Service Squorli*   Logs: ' 'Show the services: Get-Service Squorli*   Logs: ') -NoNewline; Write-Host (Join-Path $S.DataDir 'logs')
  }
  Write-Host (T "Einstellungen ändern: $($S.InstallDir)\install.ps1 erneut ausführen. Entfernen: $($S.InstallDir)\uninstall.ps1" "Change settings: run $($S.InstallDir)\install.ps1 again. Remove: $($S.InstallDir)\uninstall.ps1")
}

function Main {
  Show-Banner
  Choose-Language
  Test-Requirements
  Choose-Folders
  Read-ServiceAccount
  Read-Ports
  if ($S.Mode -eq 'update') {
    Read-Existing
    Read-Changes
    Note (T 'Vorher sichern: squorli backup' 'Back up first: squorli backup')
    if (-not (Confirm (T 'Jetzt aktualisieren?' 'Update now?') $true)) { Stop-Log; exit 0 }
  } else {
    Read-Settings
    # A database without its .env (a data folder that was kept): it keeps its old password
    if ($S.Mode -eq 'fresh' -and (Test-Path -LiteralPath (Join-Path $S.DataDir 'pgdata\PG_VERSION'))) {
      Warn (T 'Es gibt schon eine Squorli-Datenbank in diesem Datenordner. Sie behält ihr altes Passwort.' 'A Squorli database already exists in this data folder. It keeps its old password.')
      if ($Unattended) { Die (T 'Ohne die alte .env geht das nur im Dialog.' 'Without the old .env this works only with questions.') }
      $old = Ask (T 'Bisheriges POSTGRES_PASSWORD (leer = abbrechen)' 'Previous POSTGRES_PASSWORD (empty = abort)')
      if (-not $old) { Stop-Log; exit 1 }
      $S.OldDbPassword = $old
    }
    # The storage quota (security audit S13, 4 October 2026): kept when the .env already has one, else 80 % of the free space
    # of the data folder's drive (Write-Env sets it); never touched by an update.
    $S.QuotaMb = Env-Get $S.EnvFile 'STORAGE_QUOTA_MB'
    if ($S.QuotaMb) { $S.QuotaText = "$($S.QuotaMb) MB $(T '(aus der .env)' '(from .env)')" }
    else {
      $S.QuotaMb = Get-DefaultQuotaMb $S.DataDir
      if ($S.QuotaMb) { $S.QuotaText = "$($S.QuotaMb) MB " } else { $S.QuotaText = '' }
      $S.QuotaText += T '(80 % des freien Platzes; STORAGE_QUOTA_MB in der .env)' '(80 % of the free space; STORAGE_QUOTA_MB in .env)'
    }
    Show-Summary
  }
  Install-VcRuntime
  try { Close-Services; Stop-Services; Copy-Programs } finally { Open-Services }
  Write-Env
  Write-Configuration
  Install-Services
  Set-DataAccess
  Install-Postgres
  if ($S.Mode -ne 'update') { Set-Firewall }
  Start-All
  Test-Installation
  Set-NodeIpTask
  if ($S.Mode -ne 'update') { Set-KeepAwake }
  Add-ToPath
  Show-Finish
}

# Dot-sourced (tests): the functions only.
if ($MyInvocation.InvocationName -ne '.') {
  try { Main }
  catch {
    Write-Host ''
    Write-Host "x $(T 'Abgebrochen' 'Aborted') ($(T 'Zeile' 'line') $($_.InvocationInfo.ScriptLineNumber)): $($_.Exception.Message)" -ForegroundColor Red
    Stop-Log
    exit 1
  }
}
