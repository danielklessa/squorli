# deploy/windows – The package for Windows without Docker

Part of the project description. The entry point is the root [AGENTS.md](../../AGENTS.md) (commands, definition of done, cross-cutting conventions, the map of all documentation in its section 0). The feature's notes with the user's wishes, the decisions and what was checked: `docs/features/windows.md`; what is still open (the first run on GitHub, the first release with a package, the acceptance on real machines): `docs/PLAN-windows.md`. For operators the README's section "Windows without Docker" and the website's installation guide (its tab "Windows") describe the package; a change of the requirements, the setup's questions, the commands or of what was run on which Windows goes there too, in both languages of the website. Whoever changes the package, its templates or the pinned versions updates this file in the same step. Read `deploy/AGENTS.md` too: the Docker way is the reference this package follows.

## Structure

```
deploy/windows/versions.json        The programs that ship in the package: version, download address, SHA-256, license, source. The only place for them
deploy/windows/check-versions.mjs   Compares versions.json with .nvmrc (Node) and with the LiveKit and PostgreSQL images of compose.yml, portainer.yml and compose.dev.yml; CI job `test` (GitHub and GitLab) and the first step of build-package.ps1
deploy/windows/build-package.ps1    Builds squorli-server-<version>-windows-x64.zip and its .sha256 into dist/windows/ (ignored by git). Windows PowerShell 5.1 and PowerShell 7. Parameters: -OutDir, -CacheDir (downloads, default %LOCALAPPDATA%\squorli-build-cache), -SkipBuild (take the built web client and server as they are), -KeepStage (leave the unpacked package next to the ZIP)
deploy/windows/flatten-modules.mjs  Writes the node_modules of `pnpm deploy` (links) again as plain folders and checks that every lookup finds the same version; called by build-package.ps1
deploy/windows/templates/           What the setup fills and puts in place: SquorliServer.xml, SquorliLiveKit.xml, SquorliCaddy.xml (WinSW), livekit.yaml, Caddyfile, postgresql.squorli.conf, pg_hba.conf, env.example (the first .env of an installation)
deploy/windows/install.ps1          The setup, the counterpart of deploy/install.sh: the same questions in the same order (German or English), -Unattended with a parameter per question; goes into the package's root. Section "The setup" below
deploy/windows/uninstall.ps1        Removes services, firewall rules, the PATH entry and the program folder; the data folder only after "delete" was typed (-Unattended: -RemoveData yes)
deploy/windows/squorli.ps1          The management command, the counterpart of the helper install.sh writes: status, logs, restart, stop, start, backup, restore, update, doctor; goes into the package's root. Section "The command" below
deploy/windows/squorli.cmd          What a person types: calls squorli.ps1 with -ExecutionPolicy Bypass; goes into the package's folder bin, the only one in the PATH. CRLF line ends (.gitattributes), one line
deploy/windows/test/acceptance.ps1  Installs a built package on the machine it runs on, checks the installation and every command of squorli against the real services, updates and removes it; CI (windows-package.yml) and developers. Section "The acceptance test" below
deploy/windows/test/data.mjs        The member of that test: registers as the owner, writes and reads a message with an attachment through the API (Node's own modules only, run by the package's node.exe)
deploy/windows/test/linux-backup/   A backup of a Linux installation with the key of its owner, restored by the test (its README)
deploy/proxies/iis/                 web.config and README for an IIS in front (external mode); copied into the package's folder proxies with README.md, nginx.conf and Caddyfile.external
```

## What the package holds

```
squorli-server-<version>-windows-x64/
  app/            dist, drizzle, node_modules (plain folders), package.json, public (the web client), LICENSE, NOTICE, THIRD-PARTY-NOTICES.md
  node/node.exe   nothing else of Node's ZIP (no npm)
  pgsql/          bin, lib, share of EnterpriseDB's binaries, slimmed (Select-PostgresEntry in build-package.ps1)
  livekit/livekit-server.exe
  caddy/caddy.exe
  winsw/WinSW.exe the build WinSW.NET461.exe; the setup copies it once per service next to the filled XML
  templates/      deploy/windows/templates/ as it is
  proxies/        README.md, nginx.conf, Caddyfile.external, iis/ of deploy/proxies/
  install.ps1, uninstall.ps1, squorli.ps1
  bin/squorli.cmd the folder the setup puts into the machine's PATH
  licenses/       one folder per program with the license texts out of the downloads, README.txt with versions and sources
  manifest.json   name, version, autoUpdateFrom (from which version on an installation may update by itself), commit, time of the build, the programs' versions
  LICENSE, NOTICE, THIRD-PARTY-NOTICES.md
```

115 MB as a ZIP, 325 MB unpacked, 7849 files, the longest path 100 characters (28 September 2026).

## What an installation looks like

```
C:\Program Files\Squorli\          programs, replaced by updates; every user of the machine can read them, so no secret lies here
  node\node.exe                    Node.js in the version of .nvmrc
  app\                             dist, drizzle, node_modules, package.json, public (the web client), the license files
  livekit\livekit-server.exe
  caddy\caddy.exe                  used in the bundled mode only
  pgsql\bin, lib, share            PostgreSQL 16
  winsw\                           WinSW.exe, and per service a copy of it next to the filled <name>.xml (none for PostgreSQL)
  templates\, proxies\, licenses\
  install.ps1, uninstall.ps1, squorli.ps1, manifest.json
  bin\squorli.cmd                  the only folder in the PATH

C:\ProgramData\Squorli\            data, kept by updates; SYSTEM, administrators and the service that needs a part of it
  .env                             everything the app server reads (node --env-file), the secrets among it
  data\                            DATA_DIR: attachments, avatars, previews, reports, the server icon
  pgdata\                          the PostgreSQL cluster
  config\livekit.yaml, Caddyfile
  caddy\                           Caddy's certificates and state
  logs\                            Squorli<Name>.out.log, .err.log, .wrapper.log (WinSW), SquorliPostgres-<weekday>.log, install-<time>.log,
                                   autoupdate.log (one line per run of the automatic updates), update-<time>.log (what such a run wrote when it updated)
  backups\<time>\                  squorli-database.sql, squorli-files.zip, env
  update\                          only while squorli update works
```

| Service | Runs | Needs |
|---|---|---|
| `SquorliPostgres` | registered by `pg_ctl register`, listening on 127.0.0.1 only | |
| `SquorliLiveKit` | `livekit-server.exe --config <data>\config\livekit.yaml`; ports, public address and the key stand in that file | |
| `SquorliServer` | `node.exe --env-file=<data>\.env app\dist\index.js` | `SquorliPostgres`, `SquorliLiveKit` |
| `SquorliCaddy` | bundled mode only: `caddy.exe run --config <data>\config\Caddyfile` | `SquorliServer` |

With automatic updates switched on (`squorli autoupdate on`) the task scheduler holds the task `SquorliAutoUpdate`, run by SYSTEM.

All start automatically, are started again after a failure (after 5, 15 and 60 seconds), and run under an account of their own (`NT SERVICE\<name>`) or `LocalService`, never `LocalSystem`.

## Rules

- **Versions in one place.** A program's version, address and hash change in `versions.json` only, together: download the new file, check it against what its publisher says (Node: `SHASUMS256.txt`; LiveKit and Caddy: the release's `checksums.txt` or the digest GitHub shows), and enter the hash. EnterpriseDB and WinSW publish no checksums: the hash is our own measurement of one download. PostgreSQL's address names a build (`16.15-4`), not only a version; EnterpriseDB makes several builds of one version.
- **LiveKit is raised in four files together:** `compose.yml`, `portainer.yml`, `compose.dev.yml` and `versions.json` (`deploy/AGENTS.md`, "LiveKit is pinned"); Node in `.nvmrc` and `versions.json`. `check-versions.mjs` fails the CI when they differ.
- **`livekit.yaml` follows `deploy/livekit/livekit.yaml`** (and the `LIVEKIT_CONFIG` of `portainer.yml`): same settings, same comments where they apply. What differs on purpose: ports and the public address are places the setup fills (the Docker way passes them as options), signaling binds to one address (`bind_addresses`), and the API key stands in the file.
- **The `Caddyfile` follows `deploy/caddy/Caddyfile`**, with `127.0.0.1:<port>` instead of container names and with `admin off` (on a PC every user could reach Caddy's admin endpoint on 127.0.0.1:2019).
- **No secret in `templates/*.xml`:** the filled files stand below `C:\Program Files\Squorli`, which every user of the machine can read. The app reads `C:\ProgramData\Squorli\.env` itself (`node --env-file`), LiveKit its key from `config\livekit.yaml`; both files get an ACL from the setup.
- **A script with German texts is UTF-8 with a byte order mark** (`install.ps1`, `uninstall.ps1`): Windows PowerShell 5.1 reads a `.ps1` without the mark in the machine's ANSI code page, and every umlaut comes out wrong. An editor or tool that rewrites the file may drop the mark; the build refuses a script with characters outside ASCII and no mark, and parses every script. `build-package.ps1` itself stays ASCII. Patch these files with a script that reads and writes `utf-8-sig`.
- **Keep the paths of the package stable** once it is released, and **the parameters an update calls `install.ps1` with:** `squorli update` of an older installation unpacks the new package and runs its `install.ps1 -Unattended -Mode update -Language <de|en> -InstallDir <folder> -DataDir <folder> -ServiceAccount <virtual|localservice>`. Whoever renames one of them or makes `-Mode update` ask a question breaks the update of every installation that is out there. The package's top folder holds `install.ps1` and `manifest.json` with `name`, `platform` and `version`; the command refuses a package without them.
- **Only `bin` is in the PATH.** PowerShell looks for `squorli.ps1` before `squorli.cmd` when both lie in a folder of the PATH, and refuses the script where scripts are not allowed (the default of Windows 10 and 11); with the program folder in the PATH, `install` and `uninstall` typed anywhere would start the setup and the removal. Nothing but `squorli.cmd` goes into `bin`.

## Known pitfalls

- **`pnpm deploy` copies the whole folder `apps/server`, the developer's `.env` and `data` included.** The Dockerfile is protected by `.dockerignore`; the package takes only `dist`, `drizzle`, `package.json` and the flattened `node_modules` out of the deploy output, and the build stops when a `.env`, a `*.pem` or an `app\data` folder is in the package. Never copy the deploy output as a whole.
- **`pnpm deploy` with `--config.node-linker=hoisted` ignores the lockfile** ("The current configuration prohibits to read or write a lockfile") and installs what the version ranges allow today: nine newer packages on 28 September 2026, `fastify` and `ws` among them. The newer deploy without `--legacy` refuses with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` as long as the lockfile was not written with `injectWorkspacePackages`. Hence `flatten-modules.mjs` on top of the Dockerfile's deploy.
- **A ZIP holds no links**, and pnpm's `node_modules` on Windows consist of junctions; the build stops when one is left in the package.
- **XML comments and places:** a comment must not contain `--`, and a place like `{{DATA_DIR}}` inside a comment becomes one when the path does (a folder named `a--b`): WinSW then refuses the whole file. The build refuses a template with a place inside a comment. The setup must escape `&`, `<` and `>` of a value it fills into an XML file.
- **A file name outside ASCII breaks unpacking with `tar`:** the tar of Windows skips such an entry ("Archive entry has empty or unreadable filename ... skipping") and ends with an error code, although everything else was unpacked (the user's first run, 28 September 2026: `@fastify/send` ships test data in a folder named "snow" with a snowman). The build leaves such names out when they are test data of a package (`test`, `tests`, `__tests__`, `fixtures` below `app\node_modules`) and stops for any other.
- **WinSW 2.12 reads version 2's element names only** (`<serviceaccount><domain>`/`<user>`, `<delayedAutoStart/>`); the repository's default branch documents version 3, whose names it ignores without a word. Documentation at the tag: https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md. Log mode `roll-by-size` only; `<name>.wrapper.log` is never rotated.
- **WinSW's `test` command does not show how a service stops:** in a console WinSW cannot attach to its child's console ("Failed to attach to console") and kills the child at once. Whether Ctrl+C reaches the app under the real service is for the setup's test.
- **LiveKit on Windows:** `--key-file` refuses every file ("key file others permissions must be set to 0", the check reads Unix file modes), so the key stands in the YAML. `bind_addresses` binds the signaling port only; the media ports listen on every address. Every start logs one error with a stack trace ("CPU monitoring unsupported on current platform"), which is harmless. It needs a few seconds until it answers (it asks a STUN server for its public address first), so whoever checks it right after the start must wait and try again.
- **A program's output cut short ends it with an error code:** `& program | Select-Object -First 1` makes `$LASTEXITCODE` non-zero for some programs (`postgres --version`); read all of it and take the first line.
- **Redirected stderr of a program throws** in Windows PowerShell 5.1 with `$ErrorActionPreference = 'Stop'` (`2>&1` turns every line into an error record). `Invoke-Native` does not redirect and reads `$LASTEXITCODE`.
- **`pg_ctl start` hands its output handles to the server:** a script that captures `pg_ctl`'s output (a pipe, `Start-Process -Wait` with redirection) waits until PostgreSQL stops. Start it with `Start-Process -PassThru` and `WaitForExit`, or as a service.
- **`Expand-Archive` of Windows PowerShell 5.1 needs about 90 seconds** for the package (7840 files); `tar -xf` (part of Windows 10 and later) and the Explorer are faster. On a CI runner `tar` may be Git's GNU tar, which reads no ZIP: call `$env:SystemRoot\System32\tar.exe`.

## Test without administrator rights

The package can be run without a service and without rights (28 September 2026): unpack it into a folder with a space in its name, fill the templates, `initdb` with `--locale=C -E UTF8 --auth-host=scram-sha-256 --pwfile`, add `include = 'postgresql.squorli.conf'` to `postgresql.conf`, `pg_ctl start`, create the database, start `livekit-server.exe --config` and `node.exe --env-file=<.env> app\dist\index.js` on ports of their own (55432, 17880 to 17882, 3001), then `/api/health`, `/rtc/validate` (401), `/api/doctor` and `SMOKE_URL=http://localhost:3001 pnpm smoke`. A filled XML can be read by WinSW without rights: copy `WinSW.exe` next to it under the XML's name and run `<name>.exe status` (answers `NonExistent`).

## The setup (`install.ps1`)

Built on 28 September 2026. It follows `deploy/install.sh` question by question (language, requirements, folders and what to do with an existing installation, domain, server name, who takes care of HTTPS, the two addresses of a proxy on another machine, ports, directory, owner, public IP, summary) and adds what Windows needs: the Visual C++ runtime, the firewall, standby on a PC, the PATH. **A change of the questions, their order or defaults in `install.sh` is made here too, and the other way round**; the website's guide will describe both.

What it does after the summary, in this order (the order matters, see the pitfalls): Visual C++ runtime, close the services that get new programs to every start and stop them, copy the programs, open the services again (`robocopy /MIR` per folder; `winsw\` only gets the new `WinSW.exe`), write `.env`, fill the templates, register the services and set their accounts, set the access rights of the data folder, `initdb` and the database, firewall, start, check (`/api/health` with `domain` and `serverKey`, `/rtc/validate` 401, in bundled mode the same through `https://<domain>`), standby, PATH (the folder `bin`; an entry of the program folder itself, made by a setup before 28 September 2026, is taken out), the closing text.

- **An update replaces only what changed (28 September 2026, `docs/features/auto-update.md`).** `Read-Changes` compares the versions `manifest.json` names in the installation and in the package (`$Programs`: which folders and which entries of `components` belong to which service; `server` is the package's own version): a service none of whose programs changed keeps running, its folders are not copied, and its copy of `WinSW.exe` is left alone (it holds the file open). Everything is replaced, as before, by a first installation, by changed settings, by the same version once more (which repairs an installation), by a manifest without versions, and when the setup runs from the program folder. After the templates are filled, a service whose configuration file was written (`$S.Written`, kept by `Write-Template`) is stopped with the services that need it (`Stop-Changed`) and started with the others. Caddy needs the app server, so it restarts with every update. **Whoever adds a program to the package enters it in `$Programs` and `$PartNames`**, or it is never replaced by an update to another version.
- **Modes:** `fresh`, `update` (no questions but one: programs and templates of the package, settings from `.env`) and `reconfigure` (the questions with the installation's values as defaults). An installation is recognised by `<data folder>\.env`.
- **`.env` is data** as in `install.sh`: `Env-Get`/`Env-Set` read and change single lines, the first one comes from `templates\env.example`, values outside `[A-Za-z0-9._:/@+,=-]` are written in single quotes (node's `--env-file` reads them literally). Secrets are kept on every run; the old file is kept as `.env.bak.<time>`. It carries three lines of the setup's own: `SQUORLI_SETUP` (bundled, local, remote), `SQUORLI_LANG`, `POSTGRES_PORT`.
- **Ports:** all five are host ports here (the app server and the database too), so all five are shown and can be typed; a port another program holds is replaced by the next free one from default + 10000; the ports the installation's own services hold never count as taken. 80/443 of the bundled Caddy are fixed; when one is taken the setup says who holds it (the program's name, or IIS for the system's HTTP service) and steers to the proxy on this machine.
- **Accounts:** `-ServiceAccount virtual` (default) gives every service the account of its own (`NT SERVICE\<name>`, set with `sc.exe config obj=` after the registration), `localservice` one shared account. The files of the data folder are given to exactly the service that needs them. An installation that exists keeps the kind its services have unless the parameter is given (`Read-ServiceAccount`).
- **`DOCTOR_TOKEN`** in `.env` is made like the other secrets and kept; an installation from before it gets one with its next update. `squorli doctor` sends it (`docs/features/doctor.md`).
- **`-Unattended`:** every question takes its parameter or its default, a wrong value stops the run with a message. With questions a parameter is what the question offers. `-InstallDir`/`-DataDir` move the two folders.
- **The log** of a run is `<data folder>\logs\install-<time>.log` (a transcript); it is closed before the owner's setup code is printed.
- **Changed templates:** a filled file that differs from the one in place is kept as `<file>.bak` (the operator's own edits of `livekit.yaml`, the `Caddyfile`, a service file).

### Test of the setup without administrator rights

`install.ps1` starts only as administrator (`#Requires -RunAsAdministrator`). For a run without rights (28 September 2026): copy it into an unpacked package without that line, dot-source the copy with the parameters (the last lines run `Main` only when the script was not dot-sourced), replace what needs rights by functions of the same name (`Set-Access` with the tester's own SID added and without the services' SIDs, `Test-Service` (the service file exists), `Test-ServiceRunning` (its port listens), `Set-ServiceAccount`, `Set-StartMode`, `Invoke-ServiceStop` (ending the process that listens on the service's port), `Install-Services`, `Add-ToPath` (its logic is the function `Get-PathWith`, which can be called with any text), and `Invoke-ServiceStart` starting `pg_ctl start`, `livekit-server.exe` and the command line of the filled `SquorliServer.xml` as plain processes), then call `Main`. Which services stop and start is decided by the real functions; the ids of the processes that listen before and after a run show what kept running. Answers for a run with questions come from a file through `Start-Process -RedirectStandardInput`. Start such a run with `Start-Process -PassThru` and `WaitForExit`, its output into a file: a pipe waits for PostgreSQL to end.

### Pitfalls of the setup

- **Rights only for services of this setup:** Caddy's service exists in the bundled mode only; rights for its account in another mode stopped the user's first run (error 1332). Whoever adds a service gives its rights where it is registered.
- **The account of a service exists only while the service does:** `icacls` refuses the SID of `NT SERVICE\<name>` (error 1332) before the service is registered, although `sc.exe showsid` prints it. Hence: register, then the rights. `pg_ctl register` works before the cluster's folder is filled.
- **Names of accounts differ with the language of Windows** (`NT-AUTORITÄT\Lokaler Dienst`, `VORDEFINIERT\Administratoren`): rights are given by SID (`*S-1-5-18`, `*S-1-5-32-544`, `*S-1-5-19`), and the output of `sc.exe` and `icacls` is never read for words, only for exit codes and SIDs.
- **`initdb` gives up its administrator rights before it writes** (PostgreSQL refuses to run as administrator), so the person who runs the setup gets rights of their own on the cluster's folder and the password file for that moment; they are taken away again afterwards.
- **`"$name: text"` is a syntax error** in PowerShell (a variable with a drive in front): write `"${name}: text"`. **`"$name?"` reads a variable named `name?`** and stops at run time ("cannot be retrieved because it has not been set"), which no parser finds: write `"${name}?"`. It stopped the user's second run in the firewall question, a function the test frame had replaced; the frame now replaces only what needs rights and answers such questions with no.
- **An empty argument is lost** when Windows PowerShell 5.1 calls a program (`password= ""`): `sc.exe config` is called without a password, which the two kinds of account do not need.
- **The German texts on screen** were checked through the transcript only; how a console of Windows 10 shows them is for the acceptance.

## The command (`squorli.ps1`)

Built on 28 September 2026. It follows the helper `install.sh` writes (`write_helper`): the same commands, the same names of the services (`server`, `postgres`, `livekit`, `caddy`; `app` means `server`), the same file names of a backup, the same marks and closing line of `doctor`. **A command added or changed there is changed here too, and the other way round.** Its texts are German or English by `SQUORLI_LANG` of `.env`.

- **Where things are:** the programs where the script lies, the data folder from `<logpath>` of the filled `winsw\SquorliServer.xml` (so a moved data folder is found; `-DataDir` overrides), ports, domain and secrets from `.env`, read line by line. The app server is asked where it listens (`LISTEN_HOST`, which is a LAN address with a proxy on another machine).
- **Rights:** every command but `help` needs an administrator (`.env`, the logs and the services are closed to everybody else) and says so.
- **Services:** `$Services` holds the names in the order of a start, `$Needs` what each one needs (the `<depend>` entries of the service files). `restart` and `stop` of one service take the running services that need it along, `start` the ones it needs. `up`, `down` and `ps` are understood as `start`, `stop` and `status`.
- **`status`** ends with code 1 when a service does not run or `/api/health` does not answer.
- **`logs`** shows per service WinSW's own log (20 lines), what the program wrote to stderr and to stdout (200 lines each; LiveKit and Caddy log to stderr, the app server to stdout), for PostgreSQL the newest weekday's file. It ends there, unlike the Linux helper; `-Follow` keeps reading all of them with the service's name in front of every line. The files are read by the script itself (`Open-Log`, `Read-Tail`), not by `Get-Content -Wait`, which follows one file only and loses a file that is renamed.
- **`backup`** writes `<folder>\<time>\squorli-database.sql` (`pg_dump -f`, never through a PowerShell pipe, which would write UTF-16), `squorli-files.zip` (by .NET, forward slashes, empty folders kept, a file that goes away meanwhile left out) and `env`. The new folder is closed to SYSTEM and administrators before anything is written. A backup that fails is removed.
- **`restore`** takes `squorli-files.zip` or `squorli-files.tar.gz` (a Linux backup; unpacked by `%SystemRoot%\System32\tar.exe`), asks for `ja` or `yes` unless `-Yes`, stops the app server and what needs it, drops and creates the database, loads the dump with `ON_ERROR_STOP`, empties the data folder without removing it (it carries the access rights) and unpacks; then every service is started. `.env` is never touched.
- **`update`** works in `<data folder>\update`: the ZIP and its `.sha256` from the release on GitHub (`-Version`, or the newest release with a Windows package: the repository's releases hold the desktop app's too, so the list is read, not "latest"), or `-Package <file or address>`; the hash is checked before anything is unpacked; the package's `manifest.json` must name `squorli-server`, `windows-x64` and a version; an older version is asked about. Then `backup`, a copy of the program folder and of the filled configuration files, and the new package's `install.ps1` in update mode. When that ends with an error the copy comes back, the services are started, and the text says that migrations are not undone and names the backup.
- **`update -Check`** (`--check`) asks GitHub and changes nothing: exit 10 when a release is newer than the installation, 0 when not; it refuses `-Version` and `-Package`.
- **A version that asks for work by hand** (`autoUpdateFrom` of `manifest.json`, which the build takes from `squorli.autoUpdateFrom` of `apps/server/package.json` and refuses to build without): `Test-ByHand` decides (the installation is older than the mark and does not carry the same mark). The run of the task asks before the download, reading `apps/server/package.json` at the release's tag (`Get-ReleaseRule`), and after it, from the package; it leaves such a version alone, says so in the log and ends with code 10. A run by hand names the release notes and asks; `-Yes` answers. `deploy/AGENTS.md` says who raises the mark.
- **`update -Auto`** is the run of the scheduled task: no question, one line per run in `logs\autoupdate.log` (the file is cut to its last 2000 lines above 1 MB), set up before the rights are checked so the log also says why a run could do nothing; a run that finds a new version writes what it does into `logs\update-<time>.log` (a transcript) and names that file in the log. `Die` and the last `catch` write their text into the log too.
- **`autoupdate [on [hours] | off]`** registers the task `SquorliAutoUpdate` through `schtasks.exe /Create /XML` (the XML is written by `New-AutoTaskXml`: SYSTEM, highest rights, every day with a repetition of n hours from 00:17, or once at 04:17 for 24; a missed run is made up, a second run never starts next to the first, four hours at most), asks for the hours with a warning in front, reads the hours back from `schtasks.exe /Query /XML`, and shows the last five lines of the log. `uninstall.ps1` removes the task. The same command with the same warning exists in the helper of `deploy/install.sh`.
- **`nodeip [check | on [minutes] | off]`** (3 October 2026, `docs/features/dynamic-ip.md`): `check` finds the public IPv4 address (`Get-RouterIp`: a multicast search (SSDP) for an internet gateway device, then the usual description addresses at the default gateway or `LIVEKIT_ROUTER_IP`, the SOAP call `GetExternalIPAddress`; else `Get-WebIp` through `curl.exe -4`, the only way to ask over IPv4) and when it is new writes it into `.env` (`Env-Write`, in place) and into `config\livekit.yaml` (`Set-LiveKitNodeIp`, the line `node_ip`) and restarts LiveKit with `Stop-Services`/`Start-Services` (the app server depends on it and comes along). `-Auto` is the run of the task `SquorliNodeIp` (`New-NodeIpTaskXml`: SYSTEM, a repetition of n minutes; `logs\nodeip.log` for changes and failures, `logs\nodeip.last` for every run). The setup asks (three answers; `-NodeIp dynamic`) and runs `squorli.ps1 nodeip check` and `nodeip on 5` as a child process after the services are up (`Set-NodeIpTask`; both scripts hold their state in `$S`, so neither can dot-source the other); `uninstall.ps1` removes the task. The same command exists in the helper of `deploy/install.sh`.
- **`doctor`** lists the services, resolves `PUBLIC_DOMAIN`, asks `GET /api/doctor` with the header `x-squorli-doctor` (`DOCTOR_TOKEN`) and prints the server's texts; exit code 1 when a check failed.

### Test of the command without administrator rights

Install the package with the test frame of the setup (above), then dot-source the installed `squorli.ps1` with the command line (the last line runs `Main` only when the script was not dot-sourced), replace `Test-Admin`, `Set-Access` (the tester's own SID added), `Get-ServiceInfo` (running = the service's port listens), `Set-StartMode`, `Start-One`, `Stop-One` (Ctrl+C to the process that listens, `pg_ctl stop`), `Invoke-Setup` (the setup's test frame with `-RunMode update`), and for `autoupdate` the variable `$TaskName` (a name of the test's own) and `Get-AutoPrincipal` (the tester's SID with `InteractiveToken` and `LeastPrivilege`: such a task can be made, started with `schtasks /Run` and removed without rights), and call `Main`. Every command writes into output files of its own: the processes a command starts inherit the handles, and a file they hold cannot be read by the next one. A real Linux backup comes out of a `docker:27-dind` container started the standard way (`docker run -d --privileged`, then `docker exec` of a script that runs `install.sh`, writes data and calls `squorli backup`). Packages for the update tests are the unpacked package under another version number (`manifest.json`, `app\package.json`), one of them with an `app\dist\index.js` that ends at once.

### Pitfalls of the command

- **Windows starts a service that ended with an error again by itself** (the recovery actions the setup and WinSW set: after 5, 15 and 60 seconds), and it takes along the services that one needs. Between two tries such a service counts as stopped, so stopping what runs does not keep it down. Whoever replaces program files closes the services first (`Set-StartMode <service> disabled`) and opens them in a `finally` (`auto`): the way back of `update` does, and the setup around its copy (`Close-Services`, `Open-Services`). Found in the user's run of 28 September 2026, where the way back found the app server and LiveKit running again.
- **Under WinSW a program that ends at its start makes the start of the service fail at once;** the setup does not wait for `/api/health` then. As plain processes (the test frame) the same case takes the two minutes of the health check.
- **The exit code of a batch file:** `squorli.cmd` ends with `& call exit /b %%ERRORLEVEL%%` on the line of the program. A plain `exit /b` hands the code to cmd.exe but not to PowerShell (code 0 there); a second line would be read from a file that `squorli update` has replaced meanwhile.
- **`Get-FileHash` is missing** in a Windows PowerShell that was started from a PowerShell 7 window through cmd.exe (the module path of version 7 comes along, and the function is a script of a module): hashes are made by .NET (`Get-Sha256`), in the build too.
- **`--yes` and `-f`** are bound by PowerShell on the way through `squorli.cmd`, but not on every way in; `Main` reads them out of the words itself.
- **`Invoke-WebRequest` reads an answer without a named character set as Latin-1:** the answers are decoded from their bytes (`Get-Web`). `Invoke-RestMethod` hands a JSON list over as one object; pipe it through `ForEach-Object` before counting.
- **What the folder says about the size of a file in use lags behind:** whether a log was replaced is decided by the sizes two open handles report (`Test-Replaced`), not by `Get-ChildItem`.
- **`[IO.Path]::GetFullPath` resolves against the process's folder, not PowerShell's:** a path a person typed goes through `Resolve-Place`.
- **The machine's PATH is read and written as text by .NET**, which expands `%SystemRoot%` in the entries that are there. That was so in the setup of phase 3 already; an operator who depends on the unexpanded form has to put it back.

## The acceptance test (`test/acceptance.ps1`)

Built on 28 September 2026 for the CI and for a developer's machine: what the user did by hand for phases 3 and 4, as one script. It needs a Windows PowerShell as administrator and a machine **without** an installation: it installs into the standard folders and removes programs and data at its end, whatever happened in between, and it refuses to start when a service `Squorli*` or one of the two folders exists.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\test\acceptance.ps1 -Package dist\windows\squorli-server-<version>-windows-x64.zip
```

59 checks, about ten minutes, with quiet minutes while it makes its two packages. Whoever wants the lines in a file too adds `2>&1 | Tee-Object <file>`; sent into a file alone (`*> <file>`) the run shows nothing, and a person who ends it then leaves folders that make the next run refuse to start (`uninstall.ps1 -Unattended -RemoveData yes` removes them).

- **Since 28 September 2026 also:** the run of the task against a package with a mark of its own (99.0.0), which it has to leave alone; an update to a package it makes itself under the version 98.0.0 (`New-TestPackage`), after which the process ids of `SquorliPostgres` and `SquorliLiveKit` must be the ones from before and the one of `SquorliServer` another; `update -Check`; `autoupdate` on, off and with 25 hours; the task's XML (SYSTEM, the interval, the command line); a run of the task through `schtasks /Run`, which has to leave a line in `logs\autoupdate.log`; that the removal takes the task along. The installation carries version 98.0.0 by then, so no release is newer and the task changes nothing. GitHub limits how often a machine may ask: when `update -Check` fails for that, the check is left out, and the task's line may be the one about GitHub.
- **What it checks,** each as a line `ok` or `FAIL`: the ZIP against its `.sha256` file and `tar.exe`; `install.ps1 -Unattended`; the three services (running, automatic, `NT SERVICE\<name>`); the rights of `.env`, of a backup and of the files a restore unpacked, by SID; the PATH; the firewall rules (`-Firewall yes`, as the CI runs it); `/api/health`, `/rtc/validate`, the setup check without the token (401); `squorli status`, `doctor`, `logs`, `backup`, `restore` of its own backup and of `linux-backup\`, `stop`, `start`, `restart`; `update -Package` with a wrong checksum, with the same package, and with a package it makes itself whose app server ends at its start (version 99.0.0: the way back; `-SkipBroken` leaves it out); `uninstall.ps1` and that nothing is left.
- **Its exit code** is the number of failed checks; 2 when the machine has an installation.
- **`-Smoke`** is the other part: an installation whose first sign-in becomes the owner, `RATE_LIMIT_FACTOR` and `RADIO_IDLE_STOP_MS` added to its `.env`, then `apps/server/scripts/smoke.mjs` with `SMOKE_DOCTOR_TOKEN`. It needs the repository with its packages and a node in the PATH, and it reaches services outside (Discord's template, YouTube), so the CI runs it with `continue-on-error`.
- **Ports:** without `-AppPort` and the others the setup takes the standard ports and replaces those that are taken, so the test runs next to a development stack; it reads the ports from `.env`.
- **A change of the setup's parameters, of a command's output or exit code** shows here first: the test matches the English texts (`Backup: <folder>`, `NOT undone`, the marks of `doctor`).
- **Its helper `test/data.mjs` talks to the server like a client and has to follow the server's rules:** a key backup for `POST /api/local/register` needs at least 600,000 rounds (`backup_weak` otherwise); with 100,000 the run was red from 2 October 2026 until 0.8.4 and the first failing line was the owner's registration. A new server rule that a registration or a sign-in must meet is met here too, and `node deploy/windows/test/data.mjs seed|post|check` against a scratch server (`PORT`, `DATABASE_URL`, `OWNER_SETUP_CODE`, see the root `AGENTS.md`, section 7) shows it in a minute, without a Windows machine.
- **Not part of it:** the bundled mode (a certificate needs a real domain), a proxy in front, media, `logs -Follow`, `update` from GitHub, a run of the task by the clock.
