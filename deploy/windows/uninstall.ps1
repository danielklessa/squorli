#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Squorli Server: removes the installation made by install.ps1.

.DESCRIPTION
  Stops and removes the services (SquorliCaddy, SquorliServer, SquorliLiveKit, SquorliPostgres), the firewall rules of the
  group "Squorli", the entry in the machine's PATH and the program folder. The data folder (database, files, secrets,
  backups) stays unless the question about it is answered with yes.

    powershell -ExecutionPolicy Bypass -File "C:\Program Files\Squorli\uninstall.ps1"

  Without questions: -Unattended; the data folder then goes only with -RemoveData yes.

  This file is UTF-8 with a byte order mark: Windows PowerShell 5.1 reads the German texts wrong without it.
#>
[CmdletBinding()]
param(
  [switch]$Unattended,
  [ValidateSet('de', 'en')][string]$Language,
  [string]$InstallDir,
  [string]$DataDir,
  [ValidateSet('yes', 'no')][string]$RemoveData = 'no'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Utf8 = New-Object Text.UTF8Encoding $false
$ServiceNames = @('SquorliCaddy', 'SquorliServer', 'SquorliLiveKit', 'SquorliPostgres')
$Lang = 'en'

function T([string]$de, [string]$en) { if ($Lang -eq 'de') { $de } else { $en } }
function Step([string]$text) { Write-Host ''; Write-Host '---- ' -ForegroundColor Blue -NoNewline; Write-Host $text -ForegroundColor White }
function Ok([string]$text) { Write-Host '  ok ' -ForegroundColor Green -NoNewline; Write-Host $text }
function Warn([string]$text) { Write-Host "  !  $text" -ForegroundColor Yellow }
function Note([string]$text) { Write-Host "     $text" -ForegroundColor DarkGray }
function Ask([string]$question) {
  Write-Host ''
  Write-Host '? ' -ForegroundColor Blue -NoNewline
  Write-Host $question -ForegroundColor White -NoNewline
  return (Read-Host ' ').Trim()
}
function Invoke-Program([string]$file, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $file @arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  if ($code -ne 0) { foreach ($line in $lines) { if ($line.Trim()) { Note $line } } }
  return $code
}

if (-not $InstallDir) { $InstallDir = $PSScriptRoot }
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (-not $DataDir) { $DataDir = Join-Path $env:ProgramData 'Squorli' }
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$envFile = Join-Path $DataDir '.env'

if ($Language) { $Lang = $Language }
else {
  $stored = ''
  if (Test-Path -LiteralPath $envFile) { foreach ($line in [IO.File]::ReadAllLines($envFile, $Utf8)) { if ($line.StartsWith('SQUORLI_LANG=')) { $stored = $line.Substring(13).Trim() } } }
  if ($stored -eq 'de' -or $stored -eq 'en') { $Lang = $stored } elseif ((Get-UICulture).TwoLetterISOLanguageName -eq 'de') { $Lang = 'de' }
}

Step (T 'Squorli Server entfernen' 'Removing Squorli Server')
Note "$(T 'Programme' 'Programs'): $InstallDir"
Note "$(T 'Daten' 'Data'):      $DataDir"
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'manifest.json'))) {
  Write-Host "x $(T "In $InstallDir liegt keine Squorli-Installation (manifest.json fehlt)." "$InstallDir holds no Squorli installation (manifest.json is missing).")" -ForegroundColor Red
  exit 1
}
if (-not $Unattended) {
  $a = (Ask (T 'Dienste, Firewall-Regeln und Programme entfernen? (j/N)' 'Remove services, firewall rules and programs? (y/N)')).ToLowerInvariant()
  if (@('y', 'yes', 'j', 'ja') -notcontains $a) { Write-Host (T 'Abgebrochen.' 'Cancelled.'); exit 0 }
}

Step (T 'Dienste' 'Services')
foreach ($name in $ServiceNames) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service) { continue }
  if ($service.Status -ne 'Stopped') {
    try { Stop-Service -Name $name -Force -ErrorAction Stop; (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
    catch { Warn (T "$name lässt sich nicht anhalten: $($_.Exception.Message)" "$name cannot be stopped: $($_.Exception.Message)") }
  }
  $code = Invoke-Program 'sc.exe' @('delete', $name)
  if ($code -eq 0) { Ok (T "$name entfernt" "$name removed") } else { Warn (T "$name ließ sich nicht entfernen (sc.exe delete: $code)" "$name could not be removed (sc.exe delete: $code)") }
}
# A service whose window is open in the service manager stays "marked for deletion" until that window closes.
Start-Sleep -Seconds 2
foreach ($name in $ServiceNames) {
  if (Get-Service -Name $name -ErrorAction SilentlyContinue) { Warn (T "$name ist noch zum Löschen vorgemerkt: die Dienste-Verwaltung schließen oder den Rechner neu starten." "$name is still marked for deletion: close the service manager or restart the machine.") }
}

Step 'Firewall'
$rules = @(Get-NetFirewallRule -Group 'Squorli' -ErrorAction SilentlyContinue)
if ($rules.Count -gt 0) { $rules | Remove-NetFirewallRule; Ok (T "$($rules.Count) Regeln der Gruppe `"Squorli`" entfernt" "$($rules.Count) rules of the group `"Squorli`" removed") } else { Note (T 'keine Regeln' 'no rules') }

$current = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$parts = @($current.Split(';') | Where-Object { $_ })
$kept = @($parts | Where-Object { $_.TrimEnd('\') -ine $InstallDir -and $_.TrimEnd('\') -ine (Join-Path $InstallDir 'bin') })
if ($kept.Count -ne $parts.Count) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'Machine'); Ok (T 'PATH-Eintrag entfernt' 'PATH entry removed') }

Step (T 'Daten' 'Data')
$remove = $false
if (Test-Path -LiteralPath $DataDir) {
  Note (T "$DataDir enthält die Datenbank, alle Dateien (Anhänge, Avatare), die Geheimnisse (.env) und die Sicherungen." "$DataDir holds the database, all files (attachments, avatars), the secrets (.env) and the backups.")
  if ($Unattended) { $remove = ($RemoveData -eq 'yes') }
  else {
    $a = Ask (T 'Auch diese Daten unwiderruflich löschen? Dann "löschen" eintippen (leer = behalten)' 'Delete this data too, for good? Then type "delete" (empty = keep)')
    $remove = (@('löschen', 'loeschen', 'delete') -contains $a.ToLowerInvariant())
  }
  if ($remove) {
    try { Remove-Item -LiteralPath $DataDir -Recurse -Force; Ok (T "$DataDir gelöscht" "$DataDir deleted") }
    catch { Warn (T "$DataDir ließ sich nicht ganz löschen: $($_.Exception.Message)" "$DataDir could not be deleted completely: $($_.Exception.Message)") }
  } else { Ok (T "$DataDir bleibt. Eine neue Installation mit demselben Datenordner übernimmt Datenbank, Dateien und Geheimnisse." "$DataDir stays. A new installation with the same data folder takes over database, files and secrets.") }
}

Step (T 'Programme' 'Programs')
# This script lies in the folder it removes: PowerShell has read it as a whole, the folder only must not be the current one.
Set-Location -LiteralPath $env:SystemRoot
try { Remove-Item -LiteralPath $InstallDir -Recurse -Force; Ok (T "$InstallDir gelöscht" "$InstallDir deleted") }
catch { Warn (T "$InstallDir ließ sich nicht ganz löschen (noch geöffnete Dateien?): $($_.Exception.Message)" "$InstallDir could not be deleted completely (files still open?): $($_.Exception.Message)") }

Write-Host ''
Write-Host (T 'Squorli Server ist entfernt.' 'Squorli Server is removed.') -ForegroundColor White
Note (T 'Nicht zurückgesetzt: die Energieeinstellungen (Standby im Netzbetrieb) und die Microsoft Visual C++ Runtime.' 'Not set back: the power settings (standby on mains power) and the Microsoft Visual C++ runtime.')
Note (T 'Am Router eingerichtete Portweiterleitungen und der DNS-Eintrag der Domain bleiben, bis du sie entfernst.' 'Port forwardings set up at the router and the domain''s DNS record stay until you remove them.')
