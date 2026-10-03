#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Acceptance test of the package for Windows: installs it, runs every command of "squorli" against the real services,
  updates it, and removes it again. For the CI job on windows-latest and for a developer's machine.

.DESCRIPTION
  Run in a Windows PowerShell started as administrator, on a machine WITHOUT a Squorli installation (the test installs
  into C:\Program Files\Squorli and C:\ProgramData\Squorli and removes both at its end, data included; it refuses to
  start when one of them or a service Squorli* exists):

    powershell -ExecutionPolicy Bypass -File deploy\windows\test\acceptance.ps1 -Package dist\windows\squorli-server-<version>-windows-x64.zip

  What it checks: the ZIP against its .sha256 file, install.ps1 -Unattended, the services (running, automatic, an account
  of their own), the access rights of .env and of a backup, the PATH, /api/health and /rtc/validate, squorli status,
  doctor, logs, backup, restore (its own backup and the one of a Linux installation in linux-backup\), stop, start,
  restart, update -Package (the same package; the next version, which leaves PostgreSQL and LiveKit running; one that
  asks for work by hand, which the run of the task leaves alone; one whose app server ends at its start: the way back),
  update -Check, autoupdate (the task runs as SYSTEM), nodeip (the task, a check that finds an address or says it found
  none), uninstall.ps1.

  -Smoke runs the other part instead: an installation whose first sign-in becomes the owner, and the server's smoke test
  (apps/server/scripts/smoke.mjs) against it. It needs the repository with its packages installed and a node in the PATH,
  and it talks to services outside (Discord, YouTube), so the CI does not count its failure.

  Ports: the setup takes the standard ones and replaces those another program holds; give them to choose others.
  Exit code: the number of failed checks (0 = all passed), 2 = the machine has an installation already.
  Details: deploy/windows/AGENTS.md, "The acceptance test".
#>
param(
  [Parameter(Mandatory = $true)][string]$Package,
  # Where the package is unpacked; with a space in its name on purpose.
  [string]$WorkDir = '',
  [switch]$Smoke,
  # Leave out the update to a package that breaks (it builds another ZIP: about three minutes).
  [switch]$SkipBroken,
  [ValidateSet('yes', 'no')][string]$Firewall = 'no',
  [int]$AppPort = 0,
  [int]$LiveKitHttpPort = 0,
  [int]$LiveKitTcpPort = 0,
  [int]$LiveKitUdpPort = 0,
  [int]$PostgresPort = 0
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = Join-Path $env:ProgramFiles 'Squorli'
$DataDir = Join-Path $env:ProgramData 'Squorli'
$ServiceNames = @('SquorliPostgres', 'SquorliLiveKit', 'SquorliServer')
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$Utf8 = New-Object Text.UTF8Encoding $false
$script:Failures = 0

function Step([string]$text) { Write-Host ''; Write-Host "==== $text" -ForegroundColor Cyan }
function Check([string]$label, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "  ok    $label" -ForegroundColor Green }
  else { Write-Host "  FAIL  $label  $detail" -ForegroundColor Red; $script:Failures++ }
}
# Runs a program and returns its exit code and what it wrote. stderr never stops this script by itself.
function Invoke-Captured([string]$file, [string[]]$arguments, [switch]$Quiet) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $file @arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  if (-not $Quiet) { foreach ($line in $lines) { Write-Host "        $line" } }
  return @{ Code = $code; Text = ($lines -join "`n") }
}
function Invoke-Squorli([string[]]$arguments, [switch]$Quiet) {
  Write-Host "      > squorli $($arguments -join ' ')" -ForegroundColor DarkGray
  return (Invoke-Captured (Join-Path $InstallDir 'bin\squorli.cmd') $arguments -Quiet:$Quiet)
}
function Invoke-Script([string]$path, [string[]]$arguments) {
  Write-Host "      > $([IO.Path]::GetFileName($path)) $($arguments -join ' ')" -ForegroundColor DarkGray
  return (Invoke-Captured $PowerShellExe (@('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path) + $arguments))
}
function Get-Sha256([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($path)
  try { return (-join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })) } finally { $stream.Dispose(); $sha.Dispose() }
}
function Env-Get([string]$key) {
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $DataDir '.env'), $Utf8)) { if ($line.StartsWith("$key=")) { $value = $line.Substring($key.Length + 1).Trim() } }
  return $value.Trim("'").Trim('"')
}
# Who has rights on a file or folder, as SIDs (the names differ with the language of Windows).
function Get-Sids([string]$path) {
  return @((Get-Acl -LiteralPath $path).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
}
function Get-ServiceSid([string]$name) {
  $r = Invoke-Captured 'sc.exe' @('showsid', $name) -Quiet
  if ($r.Text -match 'S-1-5-80-[0-9-]+') { return $Matches[0] }
  return ''
}
function Get-Web([string]$url, [hashtable]$headers = @{}) {
  try {
    $r = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 20
    return @{ Status = [int]$r.StatusCode; Text = $Utf8.GetString($r.RawContentStream.ToArray()) }
  } catch {
    $response = $null
    if ($_.Exception -is [Net.WebException]) { $response = $_.Exception.Response }
    if ($response) { return @{ Status = [int]$response.StatusCode; Text = '' } }
    return @{ Status = 0; Text = $_.Exception.Message }
  }
}
function Get-Health([int]$tries = 30) {
  foreach ($i in 1..$tries) {
    $r = Get-Web "$script:Base/api/health"
    if ($r.Status -eq 200) { return ($r.Text | ConvertFrom-Json) }
    Start-Sleep -Seconds 2
  }
  return $null
}
function Get-Services { return @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'Squorli%'") }
function Test-ServicesUp([string]$when) {
  # A service that failed is started again by Windows some seconds later: give it that time
  $services = @()
  foreach ($i in 1..30) {
    $services = Get-Services
    if (@($services | Where-Object { $_.State -ne 'Running' }).Count -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  $said = ($services | ForEach-Object { "$($_.Name) $($_.State) $($_.StartMode) $($_.StartName)" }) -join '; '
  Check "${when}: three services, running, automatic, each under its own account" (
    $services.Count -eq 3 -and @($services | Where-Object { $_.State -ne 'Running' -or $_.StartMode -ne 'Auto' -or $_.StartName -ne "NT SERVICE\$($_.Name)" }).Count -eq 0) $said
}
function Get-MachinePath { return @([Environment]::GetEnvironmentVariable('Path', 'Machine').Split(';') | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }) }
function Invoke-Node([string[]]$arguments) { return (Invoke-Captured (Join-Path $InstallDir 'node\node.exe') $arguments) }

function Assert-CleanMachine {
  $found = @()
  if (@(Get-Services).Count -gt 0) { $found += 'services Squorli*' }
  foreach ($folder in @($InstallDir, $DataDir)) { if (Test-Path -LiteralPath $folder) { $found += $folder } }
  if ($found.Count -gt 0) {
    Write-Host "This machine has a Squorli installation ($($found -join ', ')). The test installs one and removes it with its data; remove the existing one first (uninstall.ps1), or run the test on another machine." -ForegroundColor Red
    exit 2
  }
}

function Expand-Package {
  Step 'Package'
  $zip = (Resolve-Path -LiteralPath $Package).Path
  $sumFile = "$zip.sha256"
  $expected = ''
  if (Test-Path -LiteralPath $sumFile) { $expected = ([IO.File]::ReadAllText($sumFile)).Trim().Split(' ')[0] }
  Check "the ZIP has the hash its .sha256 file names" ($expected -ne '' -and $expected -eq (Get-Sha256 $zip)) $sumFile
  if (Test-Path -LiteralPath $script:Work) { Remove-Item -LiteralPath $script:Work -Recurse -Force }
  $null = New-Item -ItemType Directory -Force -Path $script:Work
  $r = Invoke-Captured $Tar @('-xf', $zip, '-C', $script:Work)
  $top = @(Get-ChildItem -LiteralPath $script:Work -Directory)
  Check 'tar.exe unpacks it without an error into one folder' ($r.Code -eq 0 -and $top.Count -eq 1) "exit $($r.Code)"
  $script:Zip = $zip
  $script:Unpacked = $top[0].FullName
  $script:Version = ([IO.File]::ReadAllText((Join-Path $script:Unpacked 'manifest.json'), $Utf8) | ConvertFrom-Json).version
  Write-Host "        version $($script:Version), unpacked to $($script:Unpacked)"
}

function Install-Package([string]$owner) {
  Step "install.ps1 -Unattended (owner: $owner)"
  $arguments = @('-Unattended', '-Language', 'en', '-Domain', 'localhost', '-Setup', 'local', '-Directory', 'none', '-Owner', $owner,
    '-Firewall', $Firewall, '-KeepAwake', 'no', '-VcRuntime', 'yes')
  foreach ($port in @('AppPort', 'LiveKitHttpPort', 'LiveKitTcpPort', 'LiveKitUdpPort', 'PostgresPort')) {
    $value = (Get-Variable -Name $port -Scope Script).Value
    if ($value -gt 0) { $arguments += @("-$port", "$value") }
  }
  $r = Invoke-Script (Join-Path $script:Unpacked 'install.ps1') $arguments
  Check 'the setup ends with code 0' ($r.Code -eq 0) "exit $($r.Code)"
  if ($r.Code -ne 0) { throw 'The setup failed; nothing else can be checked.' }
  $script:Base = "http://127.0.0.1:$(Env-Get 'APP_PORT')"
}

function Test-Installation {
  Step 'The installation'
  Test-ServicesUp 'after the setup'
  $health = Get-Health
  Check "/api/health: domain localhost, version $($script:Version)" ($null -ne $health -and $health.domain -eq 'localhost' -and $health.version -eq $script:Version) "$($health | ConvertTo-Json -Compress)"
  $rtc = Get-Web "http://127.0.0.1:$(Env-Get 'LIVEKIT_HTTP_PORT')/rtc/validate"
  Check 'LiveKit answers /rtc/validate with 401' ($rtc.Status -eq 401) "HTTP $($rtc.Status)"
  $expected = @('S-1-5-18', 'S-1-5-32-544', (Get-ServiceSid 'SquorliServer')) | Sort-Object
  $sids = Get-Sids (Join-Path $DataDir '.env')
  Check '.env is open to SYSTEM, administrators and the app server''s service only' (($sids -join ' ') -eq ($expected -join ' ')) ($sids -join ' ')
  $path = Get-MachinePath
  Check 'the PATH of the machine holds the folder bin, not the program folder' (($path -contains (Join-Path $InstallDir 'bin')) -and ($path -notcontains $InstallDir))
  $rules = @(Get-NetFirewallRule -Group 'Squorli' -ErrorAction SilentlyContinue)
  if ($Firewall -eq 'yes') { Check 'two firewall rules of the group Squorli (media over TCP and UDP)' ($rules.Count -eq 2) "$($rules.Count)" }
  else { Check 'no firewall rules (not asked for)' ($rules.Count -eq 0) "$($rules.Count)" }
  $bare = Get-Web "$script:Base/api/doctor"
  Check 'the setup check without the token is refused (401)' ($bare.Status -eq 401) "HTTP $($bare.Status)"
}

function Test-Commands {
  Step 'status, doctor, logs'
  $r = Invoke-Squorli @('help') -Quiet
  Check 'squorli help' ($r.Code -eq 0 -and $r.Text -match 'services: server, postgres, livekit, caddy')
  $r = Invoke-Squorli @('status')
  Check 'squorli status: code 0, the health check answers' ($r.Code -eq 0 -and $r.Text -match '/api/health \(domain localhost') "exit $($r.Code)"
  $r = Invoke-Squorli @('doctor')
  Check 'squorli doctor: code 0, the server reaches itself and LiveKit' ($r.Code -eq 0 -and @([regex]::Matches($r.Text, '(?m)^  ok  ')).Count -ge 4 -and $r.Text -notmatch '(?m)^  x   ') "exit $($r.Code)"
  $r = Invoke-Squorli @('logs', 'server') -Quiet
  Check 'squorli logs server shows the start of the app server' ($r.Code -eq 0 -and $r.Text -match 'app-server up') "exit $($r.Code)"
  $r = Invoke-Squorli @('logs') -Quiet
  Check 'squorli logs shows PostgreSQL, LiveKit and the app server' ($r.Code -eq 0 -and $r.Text -match '==> postgres' -and $r.Text -match '==> livekit' -and $r.Text -match '==> server') "exit $($r.Code)"
  $r = Invoke-Squorli @('logs', 'caddy') -Quiet
  Check 'a service that is not set up is refused' ($r.Code -eq 1) "exit $($r.Code)"
}

function Test-BackupAndRestore {
  Step 'backup and restore'
  $data = Join-Path $PSScriptRoot 'data.mjs'
  $key = Join-Path $script:Work 'owner.key.json'
  $r = Invoke-Node @($data, 'seed', $script:Base, $key, 'before the backup', (Env-Get 'OWNER_SETUP_CODE'))
  Check 'the owner registers with the setup code and writes a message with an attachment' ($r.Code -eq 0)
  $r = Invoke-Squorli @('backup')
  $folder = ''
  if ($r.Text -match '(?m)^Backup: (.+)$') { $folder = $Matches[1].Trim() }
  $files = @('squorli-database.sql', 'squorli-files.zip', 'env')
  Check 'squorli backup writes the database, the files and env' ($r.Code -eq 0 -and $folder -and @($files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $folder $_)) }).Count -eq 0) $folder
  if ($folder) {
    $sids = Get-Sids $folder
    Check 'the backup is open to SYSTEM and administrators only' (($sids -join ' ') -eq 'S-1-5-18 S-1-5-32-544') ($sids -join ' ')
  }
  $r = Invoke-Node @($data, 'post', $script:Base, $key, 'after the backup')
  Check 'another message after the backup' ($r.Code -eq 0)
  $r = Invoke-Squorli @('restore', $folder, '-Yes')
  Check 'squorli restore: code 0' ($r.Code -eq 0) "exit $($r.Code)"
  $r = Invoke-Node @($data, 'check', $script:Base, $key, 'before the backup', 'after the backup')
  Check 'after the restore: the first message and its attachment are there, the second message is gone' ($r.Code -eq 0)
  $restored = @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'data\attachments') -File -ErrorAction SilentlyContinue)
  $server = Get-ServiceSid 'SquorliServer'
  Check 'the unpacked files carry the rights of the app server''s service' ($restored.Count -ge 1 -and (Get-Sids $restored[0].FullName) -contains $server) "$($restored.Count) files"
  $r = Invoke-Squorli @('restore', (Join-Path $script:Work 'nothing here'), '-Yes') -Quiet
  Check 'a folder without a backup is refused' ($r.Code -eq 1) "exit $($r.Code)"

  Step 'restore of a backup made on Linux'
  $fixture = Join-Path $PSScriptRoot 'linux-backup'
  $r = Invoke-Squorli @('restore', $fixture, '--yes')
  Check 'squorli restore of the Linux backup (tar.gz): code 0' ($r.Code -eq 0) "exit $($r.Code)"
  # The key file is copied: data.mjs would write one where none is, never into the repository
  $linuxKey = Join-Path $script:Work 'linux-owner.key.json'
  Copy-Item -LiteralPath (Join-Path $fixture 'owner.key.json') -Destination $linuxKey -Force
  $r = Invoke-Node @($data, 'check', $script:Base, $linuxKey, "@$(Join-Path $fixture 'marker.txt')")
  Check 'the Linux installation''s owner signs in, its message and attachment are there' ($r.Code -eq 0)
}

function Test-ServiceControl {
  Step 'stop, start, restart'
  $r = Invoke-Squorli @('stop', 'livekit')
  $states = @{}
  foreach ($service in (Get-Services)) { $states[$service.Name] = $service.State }
  Check 'squorli stop livekit stops LiveKit and the app server, PostgreSQL runs on' ($r.Code -eq 0 -and $states['SquorliLiveKit'] -eq 'Stopped' -and $states['SquorliServer'] -eq 'Stopped' -and $states['SquorliPostgres'] -eq 'Running') (($states.Keys | ForEach-Object { "$_ $($states[$_])" }) -join '; ')
  $r = Invoke-Squorli @('status') -Quiet
  Check 'squorli status ends with code 1 while services are stopped' ($r.Code -eq 1) "exit $($r.Code)"
  $r = Invoke-Squorli @('start')
  Check 'squorli start: code 0' ($r.Code -eq 0) "exit $($r.Code)"
  $r = Invoke-Squorli @('restart')
  Check 'squorli restart: code 0' ($r.Code -eq 0) "exit $($r.Code)"
  Test-ServicesUp 'after the restart'
}

# The unpacked package under another version number; -Broken: with an app server that ends at its start; -From: the
# version from which on an installation may update to it by itself (manifest.json, autoUpdateFrom).
function New-TestPackage([string]$version, [switch]$Broken, [string]$From = '') {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $name = "squorli-server-$version-windows-x64"
  $stage = Join-Path $script:Work "made\$name"
  $null = Invoke-Captured 'robocopy.exe' @($script:Unpacked, $stage, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -Quiet
  foreach ($file in @('manifest.json', 'app\package.json')) {
    $path = Join-Path $stage $file
    $text = [regex]::Replace([IO.File]::ReadAllText($path, $Utf8), '("version":\s*")[^"]+(")', "`${1}$version`${2}", 1)
    [IO.File]::WriteAllText($path, $text, $Utf8)
  }
  if ($From) {
    $path = Join-Path $stage 'manifest.json'
    $text = [regex]::Replace([IO.File]::ReadAllText($path, $Utf8), '\s*"autoUpdateFrom":\s*"[^"]*",', '')
    $text = [regex]::Replace($text, '("version":\s*"[^"]+",)', "`${1}`n    `"autoUpdateFrom`":  `"$From`",", 1)
    [IO.File]::WriteAllText($path, $text, $Utf8)
  }
  if ($Broken) { [IO.File]::WriteAllText((Join-Path $stage 'app\dist\index.js'), "console.error('broken on purpose (acceptance test)'); process.exit(1);`n", $Utf8) }
  $zipPath = Join-Path $script:Work "$name.zip"
  $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -Force -File)) {
      $entry = "$name/" + $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Fastest) | Out-Null
    }
  } finally { $zip.Dispose() }
  [IO.File]::WriteAllText("$zipPath.sha256", "$(Get-Sha256 $zipPath)  $name.zip`n", (New-Object Text.ASCIIEncoding))
  return $zipPath
}

function Test-Update {
  Step 'update'
  $wrong = Join-Path $script:Work 'wrong-sum.zip'
  [IO.File]::WriteAllText($wrong, 'not a package')
  [IO.File]::WriteAllText("$wrong.sha256", ('0' * 64) + "  wrong-sum.zip`n")
  $r = Invoke-Squorli @('update', '-Package', $wrong) -Quiet
  Check 'a package with a wrong checksum is refused, the working folder is gone' ($r.Code -eq 1 -and -not (Test-Path -LiteralPath (Join-Path $DataDir 'update'))) "exit $($r.Code)"
  $before = @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'backups') -Directory).Count
  $r = Invoke-Squorli @('update', '-Package', $script:Zip)
  $health = Get-Health
  Check "squorli update -Package (the same package): code 0, version $($script:Version) answers" ($r.Code -eq 0 -and $null -ne $health -and $health.version -eq $script:Version) "exit $($r.Code)"
  Check 'the update made a backup first' (@(Get-ChildItem -LiteralPath (Join-Path $DataDir 'backups') -Directory).Count -eq $before + 1)
  Test-ServicesUp 'after the update'

  Step 'update to the next version: only what changed is stopped'
  $next = New-TestPackage '98.0.0'
  $before = @{}
  foreach ($service in (Get-Services)) { $before[$service.Name] = $service.ProcessId }
  $r = Invoke-Squorli @('update', '-Package', $next)
  $health = Get-Health
  Check 'squorli update -Package (version 98.0.0): code 0, version 98.0.0 answers' ($r.Code -eq 0 -and $null -ne $health -and $health.version -eq '98.0.0') "exit $($r.Code)"
  $after = @{}
  foreach ($service in (Get-Services)) { $after[$service.Name] = $service.ProcessId }
  $said = ($ServiceNames | ForEach-Object { "$_ $($before[$_]) -> $($after[$_])" }) -join '; '
  Check 'PostgreSQL and LiveKit kept running (the same processes), the app server is a new one' (
    $after['SquorliPostgres'] -gt 0 -and $after['SquorliPostgres'] -eq $before['SquorliPostgres'] -and $after['SquorliLiveKit'] -eq $before['SquorliLiveKit'] -and
    $after['SquorliServer'] -gt 0 -and $after['SquorliServer'] -ne $before['SquorliServer']) $said
  Check 'the setup named what keeps running' ($r.Text -match 'Keep running: SquorliPostgres, SquorliLiveKit') ''
  Test-ServicesUp 'after the update to the next version'
  $script:Version = '98.0.0'
  if ($SkipBroken) { return }

  Step 'a version that asks for work by hand: not by itself'
  $broken = New-TestPackage '99.0.0' -Broken -From '99.0.0'
  $r = Invoke-Squorli @('update', '-Auto', '-Package', $broken)
  $health = Get-Health
  Check 'the run of the task leaves it alone (code 10) and says why' ($r.Code -eq 10 -and $r.Text -match 'asks for work by hand first' -and $null -ne $health -and $health.version -eq $script:Version) "exit $($r.Code)"
  Check 'the working folder is gone' (-not (Test-Path -LiteralPath (Join-Path $DataDir 'update')))

  Step 'update to a version that breaks, and the way back'
  $r = Invoke-Squorli @('update', '-Package', $broken, '-Yes')
  Check 'the update ends with code 1 and says that migrations are not undone' ($r.Code -eq 1 -and $r.Text -match 'NOT undone' -and $r.Text -match 'squorli restore') "exit $($r.Code)"
  $health = Get-Health
  Check "version $($script:Version) answers again" ($null -ne $health -and $health.version -eq $script:Version) "$($health | ConvertTo-Json -Compress)"
  Test-ServicesUp 'after the way back'
  $r = Invoke-Squorli @('status') -Quiet
  Check 'squorli status: code 0' ($r.Code -eq 0) "exit $($r.Code)"
}

# The installation carries the test's version 98.0.0 here, so no release can be newer and no run changes it.
function Test-AutoUpdate {
  Step 'update -Check, autoupdate'
  $r = Invoke-Squorli @('update', '-Check')
  if ($r.Code -eq 1 -and $r.Text -match 'GitHub') { Write-Host '  skip  squorli update -Check: GitHub did not answer (it limits how often a machine may ask)' -ForegroundColor Yellow }
  else { Check 'squorli update -Check: code 0, no release is newer' ($r.Code -eq 0) "exit $($r.Code)" }
  $r = Invoke-Squorli @('autoupdate') -Quiet
  Check 'squorli autoupdate: off' ($r.Code -eq 0 -and $r.Text -match 'Automatic updates: off') "exit $($r.Code)"
  $r = Invoke-Squorli @('autoupdate', 'on', '25') -Quiet
  $task = Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliAutoUpdate', '/XML') -Quiet
  Check 'an interval of 25 hours is refused, no task is made' ($r.Code -eq 1 -and $task.Code -ne 0) "exit $($r.Code)"
  $r = Invoke-Squorli @('autoupdate', 'on', '6')
  $task = Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliAutoUpdate', '/XML') -Quiet
  Check 'squorli autoupdate on 6: a task of SYSTEM, every 6 hours, that calls squorli.ps1 update -Auto' (
    $r.Code -eq 0 -and $task.Code -eq 0 -and $task.Text -match '<UserId>S-1-5-18</UserId>' -and $task.Text -match '<Interval>PT6H</Interval>' -and
    $task.Text -match 'squorli\.ps1(&quot;|") update -Auto') "exit $($r.Code)"
  $r = Invoke-Squorli @('autoupdate') -Quiet
  Check 'squorli autoupdate: on, every 6 hours' ($r.Code -eq 0 -and $r.Text -match 'Automatic updates: on, every 6 hours') "exit $($r.Code)"

  $log = Join-Path $DataDir 'logs\autoupdate.log'
  # The log may hold lines of the update tests already
  $before = 0
  if (Test-Path -LiteralPath $log) { $before = @(Get-Content -LiteralPath $log -Encoding UTF8).Count }
  $null = Invoke-Captured 'schtasks.exe' @('/Run', '/TN', 'SquorliAutoUpdate') -Quiet
  $lines = @()
  foreach ($i in 1..60) {
    if (Test-Path -LiteralPath $log) { $lines = @(Get-Content -LiteralPath $log -Encoding UTF8) }
    if ($lines.Count -gt $before) { break }
    Start-Sleep -Seconds 2
  }
  foreach ($line in $lines) { Write-Host "        $line" }
  Check 'the task ran as SYSTEM and wrote what it found into logs\autoupdate.log' ($lines.Count -gt $before -and "$($lines[-1])" -match 'nothing to do|is the newest|GitHub') "$($lines.Count) lines, $before before"
  Test-ServicesUp 'after the task'
  $health = Get-Health
  Check "version $($script:Version) still answers" ($null -ne $health -and $health.version -eq $script:Version) "$($health | ConvertTo-Json -Compress)"

  $r = Invoke-Squorli @('autoupdate', 'off') -Quiet
  $task = Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliAutoUpdate') -Quiet
  Check 'squorli autoupdate off removes the task' ($r.Code -eq 0 -and $task.Code -ne 0) "exit $($r.Code)"
  # Left on: the removal has to take the task along
}

function Test-NodeIp {
  Step 'nodeip'
  $r = Invoke-Squorli @('nodeip') -Quiet
  Check 'squorli nodeip: off' ($r.Code -eq 0 -and $r.Text -match 'Changing address \(task\): off') "exit $($r.Code)"
  $r = Invoke-Squorli @('nodeip', 'on', '61') -Quiet
  $task = Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliNodeIp', '/XML') -Quiet
  Check 'an interval of 61 minutes is refused, no task is made' ($r.Code -eq 1 -and $task.Code -ne 0) "exit $($r.Code)"
  $r = Invoke-Squorli @('nodeip', 'on', '7')
  $task = Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliNodeIp', '/XML') -Quiet
  Check 'squorli nodeip on 7: a task of SYSTEM, every 7 minutes, that calls squorli.ps1 nodeip check -Auto' (
    $r.Code -eq 0 -and $task.Code -eq 0 -and $task.Text -match '<UserId>S-1-5-18</UserId>' -and $task.Text -match '<Interval>PT7M</Interval>' -and
    $task.Text -match 'squorli\.ps1(&quot;|") nodeip check -Auto') "exit $($r.Code)"
  $env = Get-Content -LiteralPath (Join-Path $DataDir '.env') -Encoding UTF8
  Check '.env says LIVEKIT_DYNAMIC_IP=true' (@($env | Where-Object { $_ -eq 'LIVEKIT_DYNAMIC_IP=true' }).Count -eq 1) ''
  $r = Invoke-Squorli @('nodeip') -Quiet
  Check 'squorli nodeip: on, every 7 minutes' ($r.Code -eq 0 -and $r.Text -match 'Changing address \(task\): on, every 7 minutes') "exit $($r.Code)"
  # The machine may stand behind a router that answers by UPnP, or reach a directory, or neither: the check says which
  $r = Invoke-Squorli @('nodeip', 'check')
  Check 'squorli nodeip check: finds a public address or says it found none' (($r.Code -eq 0 -and $r.Text -match 'Public address') -or ($r.Code -eq 1 -and $r.Text -match 'No public IPv4 address')) "exit $($r.Code)"
  Test-ServicesUp 'after the check'
  $r = Invoke-Squorli @('nodeip', 'off') -Quiet
  $task = Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliNodeIp') -Quiet
  $env = Get-Content -LiteralPath (Join-Path $DataDir '.env') -Encoding UTF8
  Check 'squorli nodeip off removes the task and empties LIVEKIT_DYNAMIC_IP' ($r.Code -eq 0 -and $task.Code -ne 0 -and @($env | Where-Object { $_ -eq 'LIVEKIT_DYNAMIC_IP=' }).Count -eq 1) "exit $($r.Code)"
  $r = Invoke-Squorli @('nodeip', 'on', '5') -Quiet
  Check 'left on for the removal' ($r.Code -eq 0) "exit $($r.Code)"
  $r = Invoke-Squorli @('autoupdate', 'on', '24') -Quiet
  Check 'squorli autoupdate on 24' ($r.Code -eq 0 -and $r.Text -match 'once a day at 04:17') "exit $($r.Code)"
}

function Uninstall-Package {
  Step 'uninstall.ps1'
  $path = Join-Path $InstallDir 'uninstall.ps1'
  if (-not (Test-Path -LiteralPath $path)) { $path = Join-Path $script:Unpacked 'uninstall.ps1' }
  $r = Invoke-Script $path @('-Unattended', '-Language', 'en', '-RemoveData', 'yes')
  Check 'the removal ends with code 0' ($r.Code -eq 0) "exit $($r.Code)"
  Start-Sleep -Seconds 2
  Check 'no service Squorli* is left' (@(Get-Services).Count -eq 0)
  Check 'the program folder and the data folder are gone' (-not (Test-Path -LiteralPath $InstallDir) -and -not (Test-Path -LiteralPath $DataDir))
  Check 'the PATH of the machine holds no entry of Squorli' (@(Get-MachinePath | Where-Object { $_ -like "$InstallDir*" }).Count -eq 0)
  Check 'no firewall rule of the group Squorli is left' (@(Get-NetFirewallRule -Group 'Squorli' -ErrorAction SilentlyContinue).Count -eq 0)
  Check 'no task SquorliAutoUpdate is left' ((Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliAutoUpdate') -Quiet).Code -ne 0)
  Check 'no task SquorliNodeIp is left' ((Invoke-Captured 'schtasks.exe' @('/Query', '/TN', 'SquorliNodeIp') -Quiet).Code -ne 0)
}

function Test-Smoke {
  Step 'The server''s smoke test against the installation'
  # What the smoke test needs of a test server (apps/server/AGENTS.md)
  [IO.File]::AppendAllText((Join-Path $DataDir '.env'), "RATE_LIMIT_FACTOR=5`nRADIO_IDLE_STOP_MS=2000`n")
  $r = Invoke-Squorli @('restart', 'server')
  Check 'squorli restart server' ($r.Code -eq 0) "exit $($r.Code)"
  $env:SMOKE_URL = "http://localhost:$(Env-Get 'APP_PORT')"
  $env:SMOKE_DOCTOR_TOKEN = Env-Get 'DOCTOR_TOKEN'
  $env:RADIO_IDLE_STOP_MS = '2000'
  Push-Location (Join-Path $Repo 'apps\server')
  try { $r = Invoke-Captured 'node.exe' @('scripts\smoke.mjs') -Quiet } finally { Pop-Location }
  foreach ($line in ($r.Text -split "`n" | Where-Object { $_ -notmatch '^ok ' })) { Write-Host "        $line" }
  Check "smoke test: $(@([regex]::Matches($r.Text, '(?m)^ok ')).Count) checks ok, none failed" ($r.Code -eq 0) "exit $($r.Code)"
}

# ---- The run
if ($WorkDir) { $script:Work = [IO.Path]::GetFullPath($WorkDir) } else { $script:Work = Join-Path $env:SystemDrive 'squorli acceptance' }
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "$($os.Caption), build $($os.BuildNumber); PowerShell $($PSVersionTable.PSVersion)"
Assert-CleanMachine
try {
  Expand-Package
  if ($Smoke) {
    Install-Package 'first'
    Test-ServicesUp 'after the setup'
    Test-Smoke
  } else {
    Install-Package 'code'
    Test-Installation
    Test-Commands
    Test-BackupAndRestore
    Test-ServiceControl
    Test-Update
    Test-AutoUpdate
    Test-NodeIp
  }
} catch {
  Write-Host ''
  Write-Host "x line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)" -ForegroundColor Red
  $script:Failures++
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'logs') -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 4)) {
    Write-Host "  $($file.FullName):" -ForegroundColor DarkGray
    Get-Content -LiteralPath $file.FullName -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "        $_" }
  }
} finally {
  # Whatever happened: the machine is left without the installation
  if (@(Get-Services).Count -gt 0 -or (Test-Path -LiteralPath $InstallDir) -or (Test-Path -LiteralPath $DataDir)) {
    try { Uninstall-Package } catch { Write-Host "x uninstall: $($_.Exception.Message)" -ForegroundColor Red; $script:Failures++ }
  }
  Set-Location -LiteralPath $env:SystemRoot
  Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:Failures -eq 0) { Write-Host 'All checks passed.' -ForegroundColor Green } else { Write-Host "$($script:Failures) check(s) failed." -ForegroundColor Red }
exit $script:Failures
