<#
.SYNOPSIS
  Builds the Squorli Server package for Windows (x64): squorli-server-<version>-windows-x64.zip and its .sha256 file.

.DESCRIPTION
  Builds the web client and the server like the Dockerfile does, downloads the programs named in versions.json (Node.js,
  PostgreSQL, LiveKit, Caddy, WinSW), checks every download against its SHA-256 and lays out the package.
  Runs in Windows PowerShell 5.1 and in PowerShell 7, in CI (windows-latest) and locally. Needs Node, pnpm and an
  installed workspace (pnpm install). Details and pitfalls: deploy/windows/AGENTS.md.

  Keep this file ASCII only: Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page.

.PARAMETER OutDir
  Where the ZIP goes. Default: <repo>\dist\windows (ignored by git).

.PARAMETER CacheDir
  Where downloads are kept between runs. Default: %LOCALAPPDATA%\squorli-build-cache.

.PARAMETER SkipBuild
  Take apps\web\dist and apps\server\dist as they are instead of building them (CI has built them in the step before).

.PARAMETER KeepStage
  Leave the unpacked package next to the ZIP (<OutDir>\<name>) for a look or a test.
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [string]$CacheDir,
  [switch]$SkipBuild,
  [switch]$KeepStage
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower in Windows PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $repo 'dist\windows' }
if (-not $CacheDir) { $CacheDir = Join-Path $env:LOCALAPPDATA 'squorli-build-cache' }
$versions = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'versions.json') | ConvertFrom-Json
$serverPackage = Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'apps\server\package.json') | ConvertFrom-Json
$serverVersion = $serverPackage.version
# From which version on an installation may update to this one by itself (docs/features/auto-update.md)
$autoUpdateFrom = ''
if ($serverPackage.PSObject.Properties.Name -contains 'squorli' -and $serverPackage.squorli.PSObject.Properties.Name -contains 'autoUpdateFrom') { $autoUpdateFrom = "$($serverPackage.squorli.autoUpdateFrom)" }
if ($autoUpdateFrom -notmatch '^\d+\.\d+\.\d+$') { throw "apps/server/package.json: squorli.autoUpdateFrom must name a version (1.2.3), it says '$autoUpdateFrom'" }
$name = "squorli-server-$serverVersion-windows-x64"

function Step([string]$text) { Write-Host ''; Write-Host "==== $text" -ForegroundColor Cyan }

# Runs a program and stops on an exit code other than 0. stderr is not redirected: with $ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 turns every redirected stderr line of a program into an error.
function Invoke-Native([string]$file, [string[]]$arguments, [string]$workingDirectory = $repo) {
  Push-Location $workingDirectory
  try {
    & $file @arguments
    if ($LASTEXITCODE -ne 0) { throw "$file $($arguments -join ' ') ended with code $LASTEXITCODE" }
  } finally { Pop-Location }
}

# By .NET: Windows PowerShell started from a PowerShell 7 window does not always find Get-FileHash.
function Get-Sha256([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($path)
  try { return (-join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })) } finally { $stream.Dispose(); $sha.Dispose() }
}

# Downloads a file into the cache unless it is there with the right hash, and returns its path. A wrong hash stops the build.
function Get-Pinned([string]$url, [string]$sha256, [string]$fileName) {
  $path = Join-Path $CacheDir $fileName
  if ((Test-Path -LiteralPath $path) -and ((Get-Sha256 $path) -eq $sha256)) { Write-Host "  cached   $fileName"; return $path }
  Write-Host "  download $url"
  $part = "$path.part"
  Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing
  $got = Get-Sha256 $part
  if ($got -ne $sha256) {
    Remove-Item -LiteralPath $part -Force
    throw "SHA-256 of $fileName is $got, versions.json expects $sha256. Not used."
  }
  Move-Item -LiteralPath $part -Destination $path -Force
  return $path
}

# Unpacks the entries of a ZIP for which $map returns a path (relative to $destination); $map gets the entry's name with
# forward slashes and returns $null for an entry that stays out.
function Expand-Entries([string]$zip, [string]$destination, [scriptblock]$map) {
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  $count = 0
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith('/')) { continue }
      $relative = & $map ($entry.FullName.Replace('\', '/'))
      if (-not $relative) { continue }
      if ($relative -match '(^|[\\/])\.\.([\\/]|$)') { throw "Entry $($entry.FullName) of $zip leaves the folder" }
      $target = Join-Path $destination $relative
      $folder = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $count++
    }
  } finally { $archive.Dispose() }
  if ($count -eq 0) { throw "Nothing unpacked from $zip" }
  return $count
}

# robocopy: copies folders with long paths, which Copy-Item of Windows PowerShell 5.1 does not. Exit codes below 8 are success.
function Copy-Tree([string]$from, [string]$to) {
  if (-not (Test-Path -LiteralPath $from)) { throw "Missing: $from" }
  & robocopy.exe $from $to /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to ended with code $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}

# Which files of EnterpriseDB's ZIP go into the package: bin, lib and share without pgAdmin, StackBuilder, documentation,
# headers, import libraries, the translations (the tools then speak English, which scripts can read), the languages that
# need Perl, Python or Tcl, and the test and development programs.
$pgDropBin = @(
  'stackbuilder.exe', 'ecpg.exe', 'isolationtester.exe', 'libpq_pipeline.exe', 'libpq_testclient.exe', 'libpq_uri_regress.exe',
  'pg_isolation_regress.exe', 'pg_regress.exe', 'pg_regress_ecpg.exe', 'test_cloexec.exe', 'testplug.dll', 'libcurl.lib',
  'libcurl.dll', 'libecpg.dll', 'libecpg_compat.dll', 'libpgtypes.dll', 'pgbench.exe', 'pg_test_fsync.exe', 'pg_test_timing.exe',
  'zic.exe', 'oid2name.exe', 'vacuumlo.exe', 'icuio67.dll', 'icutu67.dll'
)
function Select-PostgresEntry([string]$entry) {
  if (-not $entry.StartsWith('pgsql/')) { return $null }
  $relative = $entry.Substring(6)
  $parts = $relative.Split('/')
  $file = $parts[$parts.Length - 1].ToLowerInvariant()
  if ($parts.Length -eq 1) { return $null }   # the license files are taken separately
  switch ($parts[0]) {
    'bin' { if (($pgDropBin -contains $file) -or $file.StartsWith('wx')) { return $null } }
    'lib' { if ($file.EndsWith('.lib') -or ($parts[1] -eq 'pkgconfig') -or ($file -match 'plperl|plpython|pltcl')) { return $null } }
    'share' { if ($parts[1] -eq 'locale') { return $null } }
    default { return $null }
  }
  return $relative.Replace('/', '\')
}

# ---------------------------------------------------------------------------------------------------------------------

Step "Squorli Server $serverVersion for Windows x64"
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This script runs on Windows only.' }
Invoke-Native 'node' @((Join-Path $PSScriptRoot 'check-versions.mjs'))

New-Item -ItemType Directory -Force -Path $OutDir, $CacheDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$CacheDir = (Resolve-Path $CacheDir).Path
$stage = Join-Path $OutDir $name
$work = Join-Path $OutDir '_work'
foreach ($folder in @($stage, $work)) { if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force } }
New-Item -ItemType Directory -Force -Path $stage, $work | Out-Null

Step 'Web client and server'
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
if (-not $SkipBuild) {
  Invoke-Native 'pnpm' @('--filter', '@squorli/web', 'build')
  Invoke-Native 'pnpm' @('--filter', '@squorli/server', 'build')
}
foreach ($needed in @('apps\web\dist\index.html', 'apps\server\dist\index.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repo $needed))) { throw "Missing $needed. Build first, or run without -SkipBuild." }
}
# The server's production dependencies, the way the Dockerfile gets them (this follows the lockfile; with
# node-linker=hoisted pnpm deploy does not). Its node_modules consist of links, which no ZIP can hold, so
# flatten-modules.mjs writes them again as plain folders and checks that every lookup finds the same version.
$deploy = Join-Path $work 'deploy'
Invoke-Native 'pnpm' @('--filter', '@squorli/server', '--prod', 'deploy', '--legacy', $deploy)
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
Invoke-Native 'node' @((Join-Path $PSScriptRoot 'flatten-modules.mjs'), $deploy, (Join-Path $app 'node_modules'))
$links = @(Get-ChildItem -LiteralPath (Join-Path $app 'node_modules') -Recurse -Force -Attributes ReparsePoint)
if ($links.Count -gt 0) { throw "node_modules contains $($links.Count) links (first: $($links[0].FullName)); the package needs plain folders." }

# Only these parts: pnpm deploy copies the whole package folder, the developer's .env and data folder included.
foreach ($folder in @('dist', 'drizzle')) { Copy-Tree (Join-Path $deploy $folder) (Join-Path $app $folder) }
Copy-Item -LiteralPath (Join-Path $deploy 'package.json') -Destination $app
Copy-Tree (Join-Path $repo 'apps\web\dist') (Join-Path $app 'public')
foreach ($file in @('LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $app
  Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $stage
}

Step 'Programs (versions.json)'
$licenses = Join-Path $stage 'licenses'
New-Item -ItemType Directory -Force -Path $licenses | Out-Null

$zip = Get-Pinned $versions.node.url $versions.node.sha256 "node-v$($versions.node.version)-win-x64.zip"
$n = Expand-Entries $zip $stage {
  param($e)
  if ($e -match '^[^/]+/node\.exe$') { return 'node\node.exe' }
  if ($e -match '^[^/]+/LICENSE$') { return 'licenses\node\LICENSE' }
  return $null
}
if ($n -ne 2) { throw "Node.js: expected node.exe and LICENSE, found $n files" }

$zip = Get-Pinned $versions.postgresql.url $versions.postgresql.sha256 "postgresql-$($versions.postgresql.build)-windows-x64-binaries.zip"
$n = Expand-Entries $zip (Join-Path $stage 'pgsql') { param($e) Select-PostgresEntry $e }
Write-Host "  PostgreSQL: $n files"
$n = Expand-Entries $zip $licenses {
  param($e)
  if ($e -eq 'pgsql/server_license.txt') { return 'postgresql\server_license.txt' }
  if ($e -eq 'pgsql/commandlinetools_3rd_party_licenses.txt') { return 'postgresql\commandlinetools_3rd_party_licenses.txt' }
  return $null
}
if ($n -ne 2) { throw "PostgreSQL: expected two license files, found $n" }

$zip = Get-Pinned $versions.livekit.url $versions.livekit.sha256 "livekit_$($versions.livekit.version)_windows_amd64.zip"
$n = Expand-Entries $zip $stage {
  param($e)
  if ($e -eq 'livekit-server.exe') { return 'livekit\livekit-server.exe' }
  if ($e -eq 'LICENSE') { return 'licenses\livekit\LICENSE' }
  return $null
}
if ($n -ne 2) { throw "LiveKit: expected livekit-server.exe and LICENSE, found $n files" }

$zip = Get-Pinned $versions.caddy.url $versions.caddy.sha256 "caddy_$($versions.caddy.version)_windows_amd64.zip"
$n = Expand-Entries $zip $stage {
  param($e)
  if ($e -eq 'caddy.exe') { return 'caddy\caddy.exe' }
  if ($e -eq 'LICENSE') { return 'licenses\caddy\LICENSE' }
  return $null
}
if ($n -ne 2) { throw "Caddy: expected caddy.exe and LICENSE, found $n files" }

$winsw = Join-Path $stage 'winsw'
New-Item -ItemType Directory -Force -Path $winsw, (Join-Path $licenses 'winsw') | Out-Null
Copy-Item -LiteralPath (Get-Pinned $versions.winsw.url $versions.winsw.sha256 "WinSW.NET461-$($versions.winsw.version).exe") -Destination (Join-Path $winsw 'WinSW.exe')
Copy-Item -LiteralPath (Get-Pinned $versions.winsw.licenseUrl $versions.winsw.licenseSha256 "WinSW-$($versions.winsw.version)-LICENSE.txt") -Destination (Join-Path $licenses 'winsw\LICENSE.txt')

# What the programs print must be what versions.json says (a ZIP under a right name with another program inside).
$checks = @(
  @{ File = 'node\node.exe'; Arguments = @('--version'); Expect = "v$($versions.node.version)" },
  @{ File = 'livekit\livekit-server.exe'; Arguments = @('--version'); Expect = $versions.livekit.version },
  @{ File = 'caddy\caddy.exe'; Arguments = @('version'); Expect = "v$($versions.caddy.version)" },
  @{ File = 'pgsql\bin\postgres.exe'; Arguments = @('--version'); Expect = $versions.postgresql.version },
  @{ File = 'pgsql\bin\pg_dump.exe'; Arguments = @('--version'); Expect = $versions.postgresql.version }
)
foreach ($check in $checks) {
  $file = Join-Path $stage $check.File
  $arguments = $check.Arguments
  $lines = @(& $file @arguments)   # all of it: cutting the output short ends the program with an error code
  $said = "$($lines[0])"
  if (($LASTEXITCODE -ne 0) -or (-not $said.Contains($check.Expect))) { throw "$($check.File) says '$said', expected $($check.Expect)" }
  Write-Host "  $($check.File): $said"
}

Step 'Templates, scripts, manifest'
# The service files must be XML WinSW can read, also after the setup filled its places: no place inside a comment (a path
# with two hyphens in a row ends a comment too early), and no comment with two hyphens of its own.
foreach ($template in (Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'templates') -Filter '*.xml')) {
  $text = [IO.File]::ReadAllText($template.FullName)
  $null = [xml]$text
  foreach ($comment in [regex]::Matches($text, '(?s)<!--(.*?)-->')) {
    if ($comment.Groups[1].Value.Contains('{{')) { throw "$($template.Name): a place in double braces inside a comment" }
  }
  foreach ($element in @('id', 'name', 'description', 'executable', 'logpath')) {
    if ($text -notmatch "<$element>") { throw "$($template.Name): <$element> is missing" }
  }
}
Copy-Tree (Join-Path $PSScriptRoot 'templates') (Join-Path $stage 'templates')
# The setup and the management command (install.ps1, uninstall.ps1, squorli.ps1, squorli.cmd) live next to this script.
# squorli.cmd goes into the folder bin, the only one the setup puts into the PATH.
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'bin') | Out-Null
foreach ($script in @('install.ps1', 'uninstall.ps1', 'squorli.ps1', 'squorli.cmd')) {
  $source = Join-Path $PSScriptRoot $script
  if (-not (Test-Path -LiteralPath $source)) { throw "$script is missing in $PSScriptRoot" }
  # Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page: the German texts need the mark.
  # The scripts must also be valid for that version, whatever runs this build.
  $bytes = [IO.File]::ReadAllBytes($source)
  if ($script.EndsWith('.ps1')) {
    $marked = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $plain = @($bytes | Where-Object { $_ -gt 127 }).Count -eq 0
    if (-not $marked -and -not $plain) { throw "$script has characters outside ASCII but no byte order mark (save it as UTF-8 with BOM)" }
    $tokens = $null; $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "${script}: line $($parseErrors[0].Extent.StartLineNumber): $($parseErrors[0].Message)" }
  }
  if ($script -eq 'squorli.cmd') {
    # cmd.exe reads a batch file in the console's code page and stumbles over bare line feeds.
    if (@($bytes | Where-Object { $_ -gt 127 }).Count -gt 0) { throw "$script has characters outside ASCII" }
    if ([Text.Encoding]::ASCII.GetString($bytes).Replace("`r`n", '').Contains("`n")) { throw "$script needs CRLF line ends" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'bin')
    continue
  }
  Copy-Item -LiteralPath $source -Destination $stage
}
# What an operator with a reverse proxy of their own needs (external mode); the Compose overlays stay out.
$proxies = Join-Path $stage 'proxies'
New-Item -ItemType Directory -Force -Path $proxies | Out-Null
foreach ($file in @('README.md', 'nginx.conf', 'Caddyfile.external')) { Copy-Item -LiteralPath (Join-Path $repo "deploy\proxies\$file") -Destination $proxies }
Copy-Tree (Join-Path $repo 'deploy\proxies\iis') (Join-Path $proxies 'iis')
$null = [xml][IO.File]::ReadAllText((Join-Path $repo 'deploy\proxies\iis\web.config'))
$commit = ''
try { $commit = (& git -C $repo rev-parse --short HEAD) } catch { $commit = '' }
$global:LASTEXITCODE = 0
$components = [ordered]@{}
foreach ($p in $versions.PSObject.Properties) {
  $v = $p.Value.version
  if ($p.Value.PSObject.Properties.Name -contains 'build') { $v = $p.Value.build }
  $components[$p.Name] = $v
}
$manifest = [ordered]@{ name = 'squorli-server'; version = $serverVersion; autoUpdateFrom = $autoUpdateFrom; platform = 'windows-x64'; commit = "$commit"; builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); components = $components }
[IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), (($manifest | ConvertTo-Json -Depth 4) + "`n"), (New-Object Text.UTF8Encoding $false))

$readme = @(
  'License texts of the programs that ship in this package, one folder per program.',
  'Squorli Server itself: LICENSE, NOTICE and THIRD-PARTY-NOTICES.md in the folder above.',
  'The packages of the app server keep their license files in app\node_modules.',
  ''
)
foreach ($p in $versions.PSObject.Properties) {
  $line = "$($p.Name): $($p.Value.name) $($components[$p.Name]), $($p.Value.license), $($p.Value.source)"
  if ($p.Value.PSObject.Properties.Name -contains 'includes') { $line += "`r`n    includes: $($p.Value.includes)" }
  $readme += $line
}
[IO.File]::WriteAllLines((Join-Path $licenses 'README.txt'), $readme, (New-Object Text.UTF8Encoding $false))

Step 'Checks'
# Secrets and data of a developer machine must never travel: nothing but the four parts of the deploy output went in.
$forbidden = @(Get-ChildItem -LiteralPath $stage -Recurse -Force -File | Where-Object { $_.Name -eq '.env' -or $_.Name -like '*.pem' -or $_.FullName -like '*\app\data\*' })
if ($forbidden.Count -gt 0) { throw "The package contains files that must not ship: $(($forbidden | ForEach-Object { $_.FullName }) -join ', ')" }
# Names outside ASCII: the tar of Windows skips such an entry with an error ("Archive entry has empty or unreadable
# filename") and ends with an error code although everything else was unpacked. Packages carry them in their test data
# (@fastify/send: "snow" with a snowman); those are left out, anything else stops the build.
$odd = @(Get-ChildItem -LiteralPath $stage -Recurse -Force | Where-Object { $_.Name -match '[^\x20-\x7E]' } | Sort-Object { $_.FullName.Length })
foreach ($item in $odd) {
  if (-not (Test-Path -LiteralPath $item.FullName)) { continue }
  $relative = $item.FullName.Substring($stage.Length + 1)
  if ($relative -notmatch '^app\\node_modules\\.+\\(test|tests|__tests__|fixtures)\\') { throw "A name outside ASCII that is no test data of a package: $relative" }
  Remove-Item -LiteralPath $item.FullName -Recurse -Force
  Write-Host "  left out (name outside ASCII): $relative"
}
$all = @(Get-ChildItem -LiteralPath $stage -Recurse -Force -File)
$longest = ($all | ForEach-Object { $_.FullName.Length - $stage.Length - 1 } | Measure-Object -Maximum).Maximum
# Unpacked below C:\Program Files\Squorli (26 characters with the separator) a path must stay under Windows' 260.
if ($longest -gt 200) { throw "The longest path inside the package has $longest characters; with the installation folder in front it would pass 260." }
$size = ($all | Measure-Object -Property Length -Sum).Sum
Write-Host ("  {0} files, {1:N0} MB unpacked, longest path {2} characters" -f $all.Count, ($size / 1MB), $longest)

Step 'ZIP'
$zipPath = Join-Path $OutDir "$name.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$out = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in ($all | Sort-Object FullName)) {
    # Forward slashes and one top folder named like the ZIP, so unpacking anywhere gives one folder.
    $entryName = "$name/" + $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($out, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $out.Dispose() }
$hash = Get-Sha256 $zipPath
# The form sha256sum reads: hash, two spaces, file name, a line feed.
[IO.File]::WriteAllText("$zipPath.sha256", "$hash  $name.zip`n", (New-Object Text.ASCIIEncoding))

Remove-Item -LiteralPath $work -Recurse -Force
if (-not $KeepStage) { Remove-Item -LiteralPath $stage -Recurse -Force }
Write-Host ''
Write-Host ("{0}  ({1:N0} MB)" -f $zipPath, ((Get-Item -LiteralPath $zipPath).Length / 1MB)) -ForegroundColor Green
Write-Host "SHA-256 $hash"
