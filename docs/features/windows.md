# Feature notes: Squorli Server on Windows without Docker

Part of the project description (entry point: root `AGENTS.md`, section 0). Dated entries: what was built, the user's wishes and decisions, consequences, and what was and was not checked. Standing rules live in the `AGENTS.md` of the area. Whoever changes the feature adds or updates its entry here in the same step.

The user's wish (28 September 2026): a release package that somebody downloads on an ordinary Windows PC (Windows 10 from 22H2, Windows 11, Home included) or on Windows Server 2019/2022/2025, installs with a guided setup and manages with a `squorli` command; x64 only, no Docker, nothing that only Windows Server has, scripts that run in Windows PowerShell 5.1. It is the counterpart of `deploy/install.sh` and the Compose stack. The work goes in six phases, each reported to the user and released by them; what is still to build is in `docs/PLAN-windows.md`.

Code so far: `apps/server/src/replaceFile.ts`, `apps/server/src/shutdown.ts`, `LISTEN_HOST` in `apps/server/src/config.ts`, the tests `replaceFile.test.ts`, `shutdown.test.ts`, `staticPaths.test.ts`, the job `windows` in `.github/workflows/ci.yml`; the package in `deploy/windows/` (`versions.json`, `check-versions.mjs`, `build-package.ps1`, `flatten-modules.mjs`, `templates/`; `install.ps1`, `uninstall.ps1`; rules and pitfalls in its `AGENTS.md`), `deploy/proxies/iis/`, the programs' table of `tools/licenses.mjs`.

## Phase 1, built (28 September 2026): the server's code on Windows

What the search through `apps/server/src` and `packages/` found, and what was done about it:

- **Replacing a file (`replaceFile.ts`).** The avatar of a server account (`auth/local.ts`) and the server icon (`routes/settings.ts`) are written to a temp file and renamed onto the target; these are the only two renames. Under Windows the rename fails with `EPERM` while the target is open. Measured on Windows 11 with Node 24.21: a read stream of the server itself (a download of the old picture) is enough, and so is a foreign handle without sharing (what a virus scanner or a backup tool holds). `replaceFile` tries five times with waits of 50, 100, 200 and 400 ms; after that it removes the target and renames once more, because a download can take longer than the waits and Windows lets a file be removed under a reader of the same process (the reader keeps its file). When that fails too, the temp file is removed and the error thrown; the target stays when it could not be removed. On Linux the first rename succeeds as before.
- **Stopping (`shutdown.ts`).** The server had no handler for any signal. `installShutdown` listens for `SIGINT`, `SIGTERM` and `SIGBREAK`, closes Fastify (its hooks end the timers, close the WebSockets and the database connection) and lets the process end with code 0; a close that takes longer than 10 s, a second signal and a failed close end it with code 1. It does not call `process.exit()` right after the close (the libuv assertion on Windows, root `AGENTS.md` section 7) but sets the exit code and ends the process 2 s later only if something still holds it. This changes the Docker way too, on purpose: as the first process of a container Node ignored `SIGTERM`, so `docker stop` waited its ten seconds and killed it.
- **The address the server listens on (`LISTEN_HOST`).** The server listened on `0.0.0.0`, which a container needs. Without Docker the port would hang on the Windows firewall alone, so the Windows installation sets `LISTEN_HOST=127.0.0.1` (a proxy on the same machine) or the machine's LAN/VPN address (a proxy on another one). Default unchanged; with Docker Compose the variable stays unset (`.env.example` says so, because `env_file` would hand it to the container).
- **Paths.** Every path is built with `join`; no fixed `/` path reaches the file system. The routes under `DATA_DIR` check their parameter before a path exists: `/api/avatars/:userId` a UUID, `/api/attachments/:id/:name` the signature and the database row (the name never becomes a path, and uploads replace `\`, `/` and NUL in it), `/api/previews/:file` a fixed form (`PREVIEW_FILE_RE`), `/api/reports/:id/files/:n/:name` the signature, an integer and the database row. The one place where the address reaches the file system as it is are the web client's files (`@fastify/static`), whose `@fastify/send` refuses `..` behind `/` and `\`; `staticPaths.test.ts` holds that for eight spellings.
- **Temp folders and file modes.** The server uses neither `os.tmpdir()` nor `chmod`/`chown`; nothing to change.
- **CI.** The job `windows` (`windows-latest`) runs `pnpm install`, typecheck and tests of every package but the desktop app, and the web and server build as the Dockerfile does them, with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and `core.autocrlf false` (the repository's files are LF). GitHub only; `.gitlab-ci.yml` has no Windows runner.

### Decisions

Made by the user on 28 September 2026 ("ich bin mit den Vorschlägen einverstanden", after the proposals below were laid out with their drawbacks):

- **Service wrapper: WinSW v2.12.0, the build `WinSW.NET461.exe`.** MIT, stops its child with Ctrl+C and kills it after `<stoptimeout>`, restarts on failure, rotates logs, knows service dependencies and accounts; it runs on the .NET Framework every target system brings (4.7.2 on Server 2019, 4.8 or 4.8.1 on the others). Known limits, from its documentation and source at the tag, none of them run yet: no release since January 2023 (v3 is still an alpha); it reads no env file, only `<env>` elements, so the app gets its configuration through `node --env-file` and no secret stands in the XML; only the log mode `roll-by-size` is usable (`roll-by-size-time` crashes the wrapper); under an account without administrator rights a child that ends by itself with code 0 leaves the service "Running" without a process (fixed in the source, in no release), which a stop through the service manager and an exit with another code do not trigger; a virtual account is not documented and probably needs `sc.exe config` after the installation; the binaries are not signed, and Defender has flagged `WinSW-x64.exe` in the past. LiveKit waits on the first Ctrl+C until its rooms are empty, so with members in a room it is killed when `<stoptimeout>` is over. Shawl (MIT, maintained) is the way out if WinSW fails under the real service account in phase 3; NSSM is unmaintained since 2017.
- **PostgreSQL: the binaries in the package** (EnterpriseDB's "binaries" ZIP of PostgreSQL 16, which postgresql.org names for exactly this use), not the detection of an installed PostgreSQL and not EnterpriseDB's installer. Run on Windows 11 without administrator rights with 16.15 (build 16.15-4): `initdb` with UTF8, locale `C` and `scram-sha-256`, a start on 127.0.0.1 only, role and database `chat`, `pg_dump`, a restore and the stop. `bin`, `lib` and `share` are enough (26 MB zipped without the translations and the development files, 42 MB with them). EnterpriseDB publishes no checksums and changes the build number behind a version, so the package pins its own SHA-256 of one build. Three of the libraries it needs (gettext, iconv, winpthreads) are LGPL-2.1; their texts go into the package.
- **The Microsoft Visual C++ runtime** is not in that ZIP and the binaries do not start without it: the setup looks for it in the registry and installs Microsoft's `vc_redist.x64.exe` silently when it is missing (shipping the DLLs next to the binaries needs a Visual Studio license).
- **`LISTEN_HOST`** as a new variable (above).

Made by Claude, confirmed by the user on 28 September 2026 ("alle Entscheidungen akzeptiert"):

- The waits of `replaceFile` and its last resort of removing the target; the 10 s limit of the shutdown.
- **Locale `C` for the cluster** (the brief left "C or fitting, check" open). The server sorts text in SQL only as the second key behind a position (categories, roles) and for the radio stations, and uses no `ILIKE`, `lower()`, `upper()` or collation anywhere; `C` sorts by bytes like the Alpine image of the Docker way, needs no ICU version and gives no collation warnings after an update. Under `C` the database's case functions are ASCII only on Windows; whoever adds such a query must know that.
- The CI job leaves the desktop package out of typecheck and tests too, not only out of the build.

### Checked

- Root typecheck (5/5); tests: link-preview 8, protocol 123, server 155 (21 new: `replaceFile.test.ts` 7, `shutdown.test.ts` 5, `staticPaths.test.ts` 9), web 467, desktop 82; `pnpm build`; the commands of the CI job on Windows 11 (`pnpm --filter "!@squorli/desktop" -r typecheck`, the two filtered builds).
- `replaceFile` against real files on Windows 11 (NTFS, Node 24.21): a plain rename fails with `EPERM` under a read stream of the same process and under a foreign handle without sharing; `replaceFile` got through after 780 ms when the foreign handle closed after 400 ms, got through after 774 ms under a read stream that stayed open (the removal), and gave up after 773 ms under a foreign handle held for 3 s, the target unchanged and the temp file gone.
- The built server on Windows 11, started in a console of its own with `node --env-file=<file> dist/index.js` and `LISTEN_HOST=127.0.0.1` (listening on 127.0.0.1:3001 only), stopped the way WinSW stops a child (`AttachConsole`, `GenerateConsoleCtrlEvent`): Ctrl+C arrived as `SIGINT`, Ctrl+Break as `SIGBREAK`; the process ended after 0.3 s with code 0 and nothing on stderr, also with three WebSockets open (the clients saw them closed).
- `pnpm smoke` against that server and a fresh database, without a directory: 230 green.
- `docker build --target app` green; the container answered `/api/health`, and `docker stop` ended it after 0.4 s with code 0 and the log line of the `SIGTERM` (before: killed after Docker's ten seconds).
- What the two research runs found about WinSW and PostgreSQL is listed under the decisions with what was run and what was read.

### Not checked

- The CI job on GitHub (the workflow was not pushed).
- Windows 10 and Windows Server: the removal under an open reader relies on how Windows 10 from 1809 deletes files; on an older file system or a network drive the last resort can fail, and then the upload answers 500 as before.
- A stop while an upload or a long download runs, and the 10 s limit with a connection that never answers.
- The server under WinSW and under a service account (phase 3).

## Phase 2, built (28 September 2026): the package

`deploy/windows/build-package.ps1` builds `squorli-server-<version>-windows-x64.zip` with a `.sha256` file next to it: the web client and the server as the Dockerfile builds them, the five programs of `deploy/windows/versions.json` downloaded and checked against their SHA-256, the templates, the license texts and a `manifest.json`. What the package holds and how it is built: `deploy/windows/AGENTS.md`. The setup and the `squorli` command are not in it yet (phases 3 and 4); the build warns and goes on.

### What turned out while building

- **The lockfile.** The first build used `pnpm deploy` with plain folders (`node-linker=hoisted`), because a ZIP holds no links and pnpm's `node_modules` on Windows are junctions. pnpm then ignored the lockfile and installed nine newer packages than the tested ones (`fastify` 5.12.5 instead of 5.12.4, `ws`, `livekit-server-sdk`, `@fastify/websocket` and others). The Dockerfile's deploy follows the lockfile (compared package by package: no difference). So the package takes that deploy, and `flatten-modules.mjs` writes its `node_modules` again as plain folders: 117 packages, four of them below the package that needs another version of a name, and a check that every lookup in the new tree finds the version pnpm's tree finds.
- **`pnpm deploy` copies `apps/server` as a whole,** the developer's `.env` and `data` folder too. The package takes four parts out of it, and the build stops when a `.env`, a `*.pem` or a data folder is in the package.
- **LiveKit's key** cannot come from `LIVEKIT_KEYS` as the brief had it: WinSW reads no env file, and an `<env>` element would put the secret into an XML file every user of the machine can read. LiveKit's `--key-file` refuses every file on Windows (it checks Unix file modes). So the key stands in `config\livekit.yaml` under `C:\ProgramData\Squorli`, which the setup protects with an ACL; ports and the public address stand there too, so the service's XML needs nothing but two folders filled in.
- **The app's configuration** comes from `C:\ProgramData\Squorli\.env` through `node --env-file`, `DATABASE_URL` with the database password included; nothing of it stands in the XML.
- **PostgreSQL as a service** is registered with `pg_ctl register` (what EnterpriseDB's installer does), not wrapped by WinSW; its settings are a file of its own that `postgresql.conf` includes, its log goes to the common log folder, one file per weekday.
- **Caddy's admin endpoint is off** in the Windows `Caddyfile`: on 127.0.0.1:2019 every user of a PC could change the configuration. Its certificates live under the data folder (`XDG_DATA_HOME`).
- **The service files' comments:** a place the setup fills must not stand inside an XML comment (a path with `--` made WinSW refuse the file); the build checks that.

### Decisions made by Claude, confirmed by the user on 28 September 2026 ("entscheidungen sind bestätigt")

- The key in `livekit.yaml` instead of `LIVEKIT_KEYS`, and ports and the public address in that file instead of options (above).
- `pg_ctl register` for PostgreSQL instead of WinSW; the brief had left both open.
- `admin off` for Caddy.
- The service account `LocalService` written into the three XML files; an account per service (`NT SERVICE\<name>`) would separate them better and is to be tried in phase 3.
- What is cut out of PostgreSQL: everything but `bin`, `lib` and `share`, and of those the translations (the tools then answer in English, which scripts can read), the import libraries, the languages that need Perl, Python or Tcl, and the test and development programs. Of Node only `node.exe`.
- Caddy 2.11.4 (the Docker way takes the floating image `caddy:2-alpine`).
- The package is built in CI on every push (job `windows`) and kept as an artifact for five days; the downloads are cached by the hash of `versions.json`.
- The license texts of the programs come out of the downloads and are not in the repository; the modules compiled into LiveKit and Caddy are not listed one by one (`docs/features/licenses.md`).

### Checked

- The hashes of `versions.json`: Node against `SHASUMS256.txt`, LiveKit and Caddy against the digests of their releases; PostgreSQL and WinSW are our own measurements (their publishers give none).
- `build-package.ps1` in Windows PowerShell 5.1 and in PowerShell 7.6 on Windows 11: 7840 files, 324 MB, 115 MB as a ZIP, the longest path 100 characters; the programs in the package answer with the versions of `versions.json`.
- **The package run without services and without administrator rights** (unpacked with `Expand-Archive` into a folder with a space in its name, the templates filled by hand): `initdb` (UTF8, locale `C`, SCRAM), PostgreSQL 16.15 on 127.0.0.1 with the included settings and its log in the common folder, a wrong password refused; LiveKit 1.13.7 with the filled `livekit.yaml` (signaling on 127.0.0.1 only, `/rtc/validate` 401, a token of the key accepted, the public address found through STUN); the app server with the package's `node.exe` and the command line of `SquorliServer.xml`: migrations, `/api/health`, the web client with its headers, `/api/doctor` all green; **`pnpm smoke` against it: 230 green**; `pg_dump` of the package; Ctrl+C ended LiveKit after 1 s and the app with code 0.
- WinSW read the three filled XML files (`status`: `NonExistent`), started the app through its `test` command with both paths containing spaces, and wrote the app's output into the log folder.
- `node deploy/windows/check-versions.mjs`; `node tools/licenses.mjs` (`thirdParty.ts` unchanged); root typecheck, tests and `pnpm build`.

### Not checked

- The CI job on GitHub (cache, artifact, the runner's PowerShell).
- Anything as a service: WinSW under `LocalService`, the stop with Ctrl+C under a service (WinSW's `test` command kills the child in a console), `pg_ctl register`, the ACLs. Phase 3.
- Caddy with a real domain and certificate (only `caddy validate` of the filled file and where it puts its data).
- Media through the native LiveKit (a browser in a voice channel, UDP, a second machine): the smoke test asks for tokens and the API only.
- The package on a machine without the Visual C++ runtime, on Windows 10 and on Windows Server; Windows Defender and Smart App Control while unpacking.

## Phase 6, built (28 September 2026): documentation for operators

Released by the user on 28 September 2026 ("wir können dann mit Phase 6 weiter machen"), with a wish for the website: "Ich hätte gerne die Installationsseite auf der Homepage übersichtlicher in dem Zusammenhang, vielleicht mit Tabs".

- **`README.md`:** the section "Windows without Docker" (requirements for a PC and a server, the download and the check of its hash, `install.ps1`, the `squorli` commands, a web server that is there already, what was run and what was not), Windows in "Requirements", `LISTEN_HOST` and `DOCTOR_TOKEN` in the table of variables, the update line.
- **The website** (`../squorli-website`, its `AGENTS.md`): the installation guide in both languages offers four ways as tabs (a Linux server with the installer, Windows with the package, by hand with Docker Compose, a test on one's own computer); what every way shares (first login, the directory, a reverse proxy, troubleshooting) follows below. Without JavaScript the four ways are sections one below the other. The homepage and the documentation's overview name Windows next to Linux.
- **This repository's descriptions:** `deploy/windows/AGENTS.md` got what an installation looks like (folders, services), `docs/PLAN-windows.md` shrank to what is open.

### Decisions made by Claude, confirmed by the user on 28 September 2026 ("Deine Entscheidungen sind abgenommen")

- **The four tabs and their order** (Linux server, Windows, by hand, just try it), and that the shared sections stand below them instead of inside every tab.
- **The chosen tab stands in the address** (`#windows`) and nowhere else: nothing is stored in the visitor's browser, so the privacy policy needs no change.
- **The headings of the guide lost their numbers;** the owner's warning moved from the installer's section to "First login", which both ways lead to (the administrator guide's link follows).
- **The guide says what was not run on Windows** (the bundled Caddy with a certificate, IIS, Windows 10, Windows Server), and that the programs are not signed.
- **The home setup names the package with the domain `localhost`** as the way without Docker on Windows; the Docker Desktop way stays.
- **The README and the guide call Windows' own tar by its full path** (`%SystemRoot%\System32\tar.exe`): on a machine with Git for Windows `tar` can be GNU tar, which reads no ZIP.

### Checked

- The README's commands up to the setup, with the built package in a folder of their own in Windows PowerShell 5.1: the two hashes are the same, the package unpacks, `install.ps1` is there.
- Website: `pnpm check` (0 errors), `pnpm build` (22 pages), `pnpm test` (21 routes; the new checks for the tabs, the anchors and the Windows examples; both translations with the same 20 examples and the same sections), `pnpm brand:check`.
- **The built page in a headless Chrome, both languages, 23 checks:** the tab list appears and one panel is shown; a click shows the chosen panel only and writes it into the address; arrow keys, Home and End move the choice and the focus; a link of the sidebar or of the text into another panel opens that panel and goes to its target; an address with `#windows-maintenance` opens the Windows panel at that heading; back in the history returns; at 390 px nothing is wider than the screen; with JavaScript off the list is not shown and all four panels are. Screenshots at 1400 and 390 px looked at.

### Not checked

- The page in Firefox and Safari, with a screen reader, and with a mouse by a person.
- The links to the release page against a release that carries the package (there is none yet); the page must not go live before.
- Whether a ZIP downloaded with a browser is held up by SmartScreen or Smart App Control.

## Phase 5, built (28 September 2026): release and tests; the test ran on the user's machine and on GitHub's runner, the first release and the acceptance on real machines are open

Released by the user on 28 September 2026 ("phase 5 kann gestartet werden").

- **The release:** `.github/workflows/server-release.yml` builds and tests the package of a tag `v<version>` (the new `windows-package.yml`, which `ci.yml` calls too) and attaches `squorli-server-<version>-windows-x64.zip` and its `.sha256` file to the release (job `attach`). The standing text of a release names the package and `squorli update`. The skill `server-release` knows the package (what an operator on Windows must be told, and to publish the draft only after the workflow has ended).
- **The test in CI:** `deploy/windows/test/acceptance.ps1` on `windows-latest`, after the build and before the package becomes an artifact (`deploy/windows/AGENTS.md`, "The acceptance test"). The server's smoke test runs against a second installation and does not count.
- **The checklist** for the acceptance by hand: below.

### Decisions made by Claude, confirmed by the user on 28 September 2026 ("Mit den Entscheidungen bin ich einverstanden")

- **A workflow of its own for the package** (`windows-package.yml`, called by `ci.yml` and `server-release.yml`), and `ci.yml` leaves its job `windows` out for tags, so a tag builds the package once.
- **The acceptance test is a gate:** a package that fails it becomes no artifact and is not attached to a release. The smoke test is none, because it reaches services outside (Discord, YouTube).
- **A package of a release that is published is never replaced** (installations check it against the release's hash); the package of a draft is replaced by a later run for the same tag.
- **The draft is written first, the package follows** about half an hour later; whoever publishes before that has a release without a package until the workflow ends, and `squorli update` does not see it until then.
- **A backup of a Linux installation lies in the repository** as test data (`deploy/windows/test/linux-backup/`, 45 KB), with the key of its owner: a throwaway installation, nothing in it protects anything.
- **The test removes the installation with its data** at its end and refuses to start on a machine that has one.
- **The CI opens the firewall rules** (`-Firewall yes`) to check that they are made and removed; on a developer's machine the default is no.

### Checked

- Root typecheck (5/5); tests link-preview 8, protocol 123, server 159, web 467, desktop 82 (no code of the apps changed in this phase).
- The three workflows and the new one: read by a YAML parser, `actionlint` without a finding (it runs shellcheck over the steps' scripts).
- `acceptance.ps1` parses in Windows PowerShell 5.1 and is ASCII; `data.mjs` run by the package's `node.exe` against the test frame's installation: the owner of the Linux backup signs in with the key of the repository, the message (read from `marker.txt`) and the attachment are there, a second message is written and found.

### Not checked

- **The release on GitHub:** the job `attach` of `server-release.yml` (`gh release upload`) and a published release with the package show with the first tag `v*`. The push of a branch ran ("Acceptance by the user" below).
- `squorli update` from GitHub: needs the first published release with a package.

### Checklist for the acceptance on real machines

Two machines: **a PC with Windows 11** (or 10 22H2) and **a Windows Server** (2019, 2022 or 2025). Each line is done when it was seen, with the date and the version in "Acceptance by the user" below.

Before: `deploy\windows\test\acceptance.ps1 -Package <zip>` as administrator on each machine (installation, the commands, update, removal; about ten minutes). What it cannot see is the list here.

| | PC, the bundled Caddy (a real domain, 80/443 forwarded) | Server, IIS in front (`deploy/proxies/iis/`) |
|---|---|---|
| Unpacked from the downloaded ZIP (Explorer or `tar`), `Unblock-File` or the question of Windows answered, no block by Defender or Smart App Control | | |
| `install.ps1` with questions, in German and in English; the firewall question answered with yes | | |
| The certificate is there, `https://<domain>` opens the client | | not applicable: IIS holds the certificate |
| IIS set up after the README; `/`, `/api/ws` and `/rtc` arrive | not applicable | |
| `squorli doctor`: every check ok, with a directory also the ones from outside | | |
| Verwaltung > Server > Verbindung prüfen from a browser in another network: UDP | | |
| Sign-in with a Squorli account (`@name`) and with a server account (`~name`) | | |
| A text message, an attachment (picture, a file of 20 MB), an avatar, the server icon replaced twice in a row | | |
| Voice with two people from two networks, one of them on mobile data | | |
| Camera, screen share with sound, the radio | | |
| The desktop app connected to this server | | |
| Restart of the machine: the services run before anybody signs in, clients reconnect | | |
| A PC only: the machine does not go to sleep after the time of the power plan (`-KeepAwake yes`) | | not applicable |
| `squorli backup`, then `squorli restore` of it | | |
| A backup of a Linux installation of one's own restored (`squorli restore <folder with .tar.gz>`) | | |
| `squorli update` from version N to N+1 from GitHub (the first release after the one installed) | | |
| `squorli logs -Follow` while somebody signs in; Ctrl+C ends it | | |
| `uninstall.ps1` with the data kept, a new installation on top of the kept data (asks for the old database password only without `.env`) | | |
| `uninstall.ps1` with "löschen": nothing left but the firewall of the router and the DNS record | | |

### Acceptance by the user

- **28 September 2026, the first push (commit `c049a3f`), the run of `ci.yml` on GitHub:** all four jobs green in nine minutes. The job `windows / package` on `windows-latest` (the first run of the workflow call and of everything Windows on a runner): install, typecheck and tests, the builds, the package in 45 seconds, **the acceptance test in 4 minutes 21 seconds without a failed check**, the smoke test against the second installation (its step counts as passed; whether every check of it did stands in the run's log), the artifact `squorli-server-windows-x64` with 115 MB. So the setup without questions, the services under their own accounts, the firewall rules (`-Firewall yes`), every command, the Linux backup, the update and the way back, and the removal also work on a machine that is a Windows Server image in English, set up by somebody else.
- **28 September 2026, `acceptance.ps1` as administrator on Windows 11 Pro (German), next to the development stack on ports of its own:** all 44 checks passed in its first run, in about three minutes: the package and its hash, the setup without questions, the services and their accounts, the rights of `.env`, of the backup and of the files a restore unpacked, the PATH, the setup check refused without the token, every command, the restore of the Linux backup of the repository (`tar.gz`, its owner signs in), a wrong checksum refused, the update with the same package, the update to the package that breaks and the way back, the removal with nothing left. Seen in the log: the text of a message with umlauts is shown wrong where the test prints what `node` wrote (the console's code page), the comparison itself is right.

## Phase 4, built and accepted for Windows 11 (28 September 2026): the management command

`deploy/windows/squorli.ps1` (the package's root) and `deploy/windows/squorli.cmd` (the package's folder `bin`). How the command works, its rules, the test recipe and its pitfalls: `deploy/windows/AGENTS.md`, "The command". Released by the user on 28 September 2026 ("dann weiter mit phase 4"), accepted by their runs the same day; phase 5 released with "phase 5 kann gestartet werden".

### What turned out while building

- **PowerShell finds `squorli.ps1` before `squorli.cmd`** when both lie in a folder of the PATH, and refuses the script where scripts are not allowed, which is the default of Windows 10 and 11 (tried with `-ExecutionPolicy Restricted`: "cannot be loaded because running scripts is disabled"). With the program folder in the PATH, as the setup of phase 3 entered it, `squorli` would have worked in cmd.exe and failed in PowerShell.
- **The loopback exception of `GET /api/doctor` does not hold without containers.** On Linux a request from 127.0.0.1 without a forwarding header can only come from `docker compose exec`; a proxy arrives from the Docker network. On Windows a proxy on the same machine arrives from 127.0.0.1 too, so a proxy that sends no forwarding header would have opened the report to everybody; and with a proxy on another machine the app server does not listen on 127.0.0.1 at all, so the command could not have asked.
- **The texts of the setup check name containers** ("check the livekit container", "squorli up -d"), which an installation on Windows does not have.
- **A batch file's exit code reaches cmd.exe and PowerShell differently** (`deploy/windows/AGENTS.md`, "Pitfalls of the command"), and `Get-FileHash` is missing in a Windows PowerShell started from a PowerShell 7 window.

### Decisions made by Claude, confirmed by the user on 28 September 2026 ("Die Entscheidungen passen so")

- **`squorli.cmd` lies in `bin\`, and the setup puts `bin` into the PATH, not the program folder** (the brief named both files in the program folder). `install.ps1` and `uninstall.ps1` follow: an entry of the program folder is taken out, the removal takes out both.
- **`squorli update` hands over to the setup of the new package** (`install.ps1 -Unattended -Mode update`), where the brief named four folders to replace (`app`, `node`, `livekit`, `caddy`). So an update also brings PostgreSQL's minor versions, WinSW, the templates and the service files of the new version, and there is one way of updating, the one an operator takes by hand with a downloaded package. What comes back after a failed update is the whole program folder and the filled configuration files. The price: the parameters of `install.ps1` for an update are an interface from now on.
- **A new variable `DOCTOR_TOKEN`** (`apps/server/src/config.ts`, `routes/doctor.ts`): when it is set, only a request that carries it in the header `x-squorli-doctor` reads the report without a session, from whatever address; when it is empty, the loopback rule holds as before. The setup for Windows makes one like the other secrets; Docker installations leave it empty. Nothing changes for Linux.
- **The setup check's texts have two wordings** where they name what to look at (`onPlatform` in `doctor.ts`, by `process.platform`): containers and `squorli up -d`, or services and `squorli restart`. They are the same texts Verwaltung > Server shows.
- **More commands than the brief lists:** `start [service]` (a `stop` without it would leave `restart` as the only way back), `stop [service]`, and `up`, `down`, `ps` as the words of the Linux helper. `update -Package <file or address>` takes a package that is there already (a machine without a way to GitHub, and the tests).
- **`status` ends with code 1** when a service does not run or the app server does not answer (the Linux helper hands on `docker compose ps`, which ends with 0).
- **`logs` ends after the last lines** and follows only with `-Follow` (the brief; the Linux helper always follows), reads the files itself instead of `Get-Content -Wait`, and shows WinSW's own log and stderr next to stdout.
- **All texts in both languages,** by `SQUORLI_LANG` of `.env` (the Linux helper speaks English but for `doctor`).
- **Every command but `help` needs an administrator;** the command says so instead of asking for the rights itself (a window opened by that would close with the output).
- **An update to the same version** happens only when the version or a package is named; an older version is asked about (`-Yes` answers).
- **An installation keeps the kind of account of its services** through an update (`Read-ServiceAccount` in `install.ps1`); before, a run without `-ServiceAccount` would have given an installation made with `localservice` the accounts per service.
- **`.gitattributes`** with `*.cmd text eol=crlf`, the repository's first.

### Checked (without administrator rights, in a test frame that replaces what needs them)

The services are plain processes there, found by the port they listen on; replaced are the check for rights, the access rights (the tester's own account added), what Windows says about a service, the start and stop of one service, and the call of the setup. Everything else is the script as it ships.

- Root typecheck (5/5); tests link-preview 8, protocol 123, server 159 (new: `onPlatform`, `isLoopback`, `isLocalCaller`), web 467, desktop 82; `check-versions.mjs`; the four scripts parse in Windows PowerShell 5.1; the package built with them (7849 files, 115 MB).
- **Through `bin\squorli.cmd`** with `bin` in the PATH, from cmd.exe, from Windows PowerShell 5.1 with the execution policy `Restricted` and from PowerShell 7: `squorli` is found as `squorli.cmd`, `help` ends with 0, a command without rights with the message about administrators and code 1, an unknown command with 1; a folder with spaces and `--yes` arrive.
- **`status`, `stop`, `start`, `restart`** with and without a service: `restart postgres` stops the app server first and starts it last, `stop livekit` takes the app server along, `start app` starts PostgreSQL and LiveKit first; `status` with a stopped service ends with 1; a service that is not set up (`caddy`) and an unknown one are refused with their names.
- **`logs`** of one, several and all services; `-Follow` printed the lines the app server and LiveKit wrote meanwhile with the service in front; a file renamed and started anew under the old name, and a file emptied in place, were followed without a line lost or doubled.
- **`backup` and `restore`:** a message with an attachment (a name with umlauts) written through the API, `backup`, another message, `restore` with the answer `nein` (nothing happens) and `ja`: the first message and the attachment's content are back, the second message is gone, the account signs in. The backup's folder and files are open to SYSTEM, administrators and (test frame) the tester only. Without PostgreSQL running `backup` refuses; without a folder or with a folder that holds no backup `restore` prints its usage.
- **A backup of a Linux installation restored on Windows:** the installation made by `deploy/install.sh` of this tree with the published image 0.5.3 in a `docker:27-dind` container (PostgreSQL 16.15 on Alpine, collation `en_US.utf8`), a message with an attachment, `squorli backup` there; on Windows `squorli restore <folder> --yes`: the server key and name of the Linux installation, its account signs in with its key, the message and the attachment's content are there.
- **`update`:** a wrong checksum, a missing checksum file, a missing package, `-Version 1.2` and `-Version 9.9.9` (GitHub answers 404) each end with their message and leave nothing behind; without a version GitHub's list is read (no release with a Windows package yet: said so). From a local address (`-Package http://127.0.0.1:...`) 0.5.3 became 0.5.4: hash checked, backup, the setup of the new package, `/api/health` names 0.5.4, the data is there. A package whose app server ends at its start: the setup gives up after two minutes, the program files of before come back, the services start, `/api/health` names the version of before, the text names the backup and says that migrations are not undone.
- **`doctor`:** the report with the token; without the token and with a wrong one the server answers 401. Set up for a proxy on another machine, `status` and `doctor` ask the LAN address, and the report is read from there. The texts name services.
- **`pnpm smoke` against a fresh installation from the final package: 231 green** (with `SMOKE_DOCTOR_TOKEN`; one check more than before: loopback alone is refused), then `backup`, `restore` and `doctor` on that data.
- `Get-PathWith` with six texts of a PATH (the old entry taken out, `bin` added once, upper and lower case, a closing backslash), and the removal's line with both forms.

### Not checked: everything the command does as administrator

Written before the user's runs, which answer most of it ("Acceptance by the user" below). Still not checked after them: `update` from GitHub, the rights of the files a restore unpacks (the restore worked, the rights were not looked at), WinSW's rotation of a log, the bundled mode, Windows 10 and Windows Server.

- The real services: `Get-CimInstance Win32_Service`, `Start-Service`, `Stop-Service` in the command's order, the stop of a service with services that depend on it.
- The access rights of a backup with the real accounts, `pg_dump` and `psql` from an elevated shell, the files a restore unpacks under the app server's own account (they must inherit its rights from the data folder).
- `update` with the real setup: the services stopped and started by `install.ps1`, the program files replaced while `squorli.cmd` runs, the way back after a failed start under WinSW (there the service counts as running although the app ends again and again).
- `update` from GitHub: no release carries a package yet (phase 5).
- The entry of `bin` in the machine's PATH and the command typed in a new window.
- WinSW's real rotation of a log (its files could not be renamed by the test while a process held them; the test used a file of its own).
- The bundled mode (`logs caddy`, Caddy as a service that needs the app server), Windows 10, Windows Server.

### Acceptance by the user

The user's runs, the newest first.

- **28 September 2026, the fix with the real services (a new installation of 0.5.3, then `update` to the package that breaks):** the text on screen looks as before the fix (the way back starts PostgreSQL, the other two run already), and Claude had told the user to expect three lines "gestartet", which was wrong. What happened stands in the system's event log (Service Control Manager, readable without rights): the setup closed the three services at 13:49:25.6 and opened them at 13:49:28.7, around its copy; the app server of the broken version ended at 13:49:30.3, and Windows announced its restart in 5000 ms (event 7031); the way back closed the services at 13:49:33.1, copied and opened them at 13:49:34.5; the restart by Windows came at 13:49:35.3, **after** the files were back, and brought LiveKit along, so the command found both running. `sc.exe config start= disabled` and `auto` work as written. A restart that falls into the closed time fails, and the command starts the services itself afterwards (that case did not occur).
- **28 September 2026, `uninstall.ps1` after the update tests:** services, the PATH entry (`bin`), the data folder (after "löschen") and the program folder removed; the machine's PATH holds no entry of Squorli afterwards. With this the command of phase 4 ran on a real machine from the installation to the removal, for one case: Windows 11 Pro, a proxy on this machine, `localhost`, an account per service.
- **28 September 2026, `squorli update` as administrator, to the next version and to one that breaks:** `update -Package <file>` from 0.5.3 to a package numbered 0.5.4: checksum, backup, the copy of the program files, the setup of the new package (services stopped by it, programs copied while `squorli.cmd` and `squorli.ps1` of the old version ran, services started), `/api/health` names 0.5.4. Then a package numbered 0.5.5 whose app server ends at its start: under WinSW the start of the service fails at once ("Fehler beim Starten des Diensts"; the test frame had to wait two minutes for that), the setup shows the logs and ends, the command brings the program files back, and version 0.5.4 answers again; the text names the backup and says that migrations are not undone. **Found in that run:** the way back started PostgreSQL only, LiveKit and the app server ran already. Windows had started the app server again by itself (the recovery actions of a service that ended with an error: after 5, 15 and 60 seconds), and with it the services it needs. That went well by its timing; a start in the middle of the copy would have found half of the files, or kept `node.exe` from being overwritten. **Fixed:** the way back and the setup close the services to every start before they stop them (`sc.exe config start= disabled`) and open them again when the files are in place, however the copy ended (`Set-StartMode`; `Close-Services` and `Open-Services` in `install.ps1`). The setup needs it too: a service that fails again and again counts as stopped between two tries.
- **28 September 2026, the services, the logs, the setup check and a restore as administrator (Windows 11 Pro, German):** `squorli status` lists the three real services with their state, start mode and account (`NT SERVICE\<name>`) and the health check; `squorli doctor` reads the report with the token from the app server running as a service (four checks ok, two skipped on `localhost`); `squorli logs server` shows WinSW's own log and the app server's; `squorli restart` stops server, LiveKit and PostgreSQL and starts them the other way round; `squorli stop livekit` takes the app server along, `squorli status` then shows both as stopped and that `/api/health` does not answer; `squorli start` brings both back. **`squorli restore` worked** (the user: "Wiederherstellung hat geklappt"); WinSW's log shows the two stops it made, each ended by the app with code 0 about 20 ms after Ctrl+C, and the app server's log the start on the restored database. **Seen in the log, not part of the command:** every start on a database that exists prints two notices of PostgreSQL as plain text between the JSON lines ("schema drizzle already exists, skipping": postgres-js writes notices with `console.log`), on Linux too (turned off the same day by the user's wish, "PostgreSQL Hinweise bitte abstellen": `createDb` takes a handler, the server logs them at debug level as lines of its log); and one client connected and disconnected twelve times within twelve seconds before it stayed connected (cause not known). **Still open:** `update` and the way back, the removal.
- **28 September 2026, `squorli backup` as administrator, typed in a newly opened window:** the command was found through the PATH (`bin\squorli.cmd`), `pg_dump` ran from the elevated shell, and the backup was written to `C:\ProgramData\Squorli\backups\<time>` (database and `.env`, no files yet: nobody had uploaded anything); a second backup two minutes later, after the owner had registered and written a message with an attachment, holds one file. `icacls` of the folder `backups`: administrators and SYSTEM with full access, nobody else.
- **28 September 2026, the installation without questions as administrator (Windows 11 Pro, German):** `install.ps1 -Unattended` with a parameter per answer (`-Domain localhost -Setup local -Directory none -Owner code -Firewall no -KeepAwake no` and the five ports) went through from the unpacked package to the closing text: the three services registered and started under their own accounts, `/api/health` (version 0.5.3) and `/rtc/validate` 401, the setup code printed after the log was closed, and `C:\Program Files\Squorli\bin` entered into the machine's PATH (the closing text lists the `squorli` commands, which it does only when `bin\squorli.cmd` is there). Seen from a shell without rights afterwards: the services run, the PATH holds the one entry, and `GET /api/doctor` from 127.0.0.1 without the token is refused with 401. This is the first run of `-Unattended` with administrator rights, the way `squorli update` and the CI test of phase 5 call the setup.

## Phase 3, built and accepted for Windows 11 (28 September 2026): the setup

`deploy/windows/install.ps1` and `uninstall.ps1`, in the package's root. How the setup works, its modes, parameters and pitfalls: `deploy/windows/AGENTS.md`, "The setup". The user runs it on their own machine ("Ich würde das Script für Phase 3 selbst ausführen"): the shell this was built in has no administrator rights, so nothing that needs them has run. The runs are recorded under "Acceptance by the user" below; what the list "Not checked" names was written before them and is answered there, except the bundled mode, a proxy on another machine, IIS, the firewall rules, the power settings, the installation of the Visual C++ runtime, Windows 10 and Windows Server.

### Decisions made by Claude, confirmed by the user on 28 September 2026 ("Die Entscheidungen bestätige ich")

- **Three ways of HTTPS as in `install.sh`** (bundled, a proxy on this machine, a proxy on another machine), where the brief named two (bundled, external): the third binds the app server and LiveKit's signaling to a LAN or VPN address and opens the two ports in the firewall for the proxy's address only.
- **An account per service by default** (`NT SERVICE\<name>`), `-ServiceAccount localservice` as the way out. With it `.env` is readable by the app server's service alone, `livekit.yaml` by LiveKit's, the cluster by PostgreSQL's.
- **The database's superuser is `chat`**, as in the Docker installation (there `POSTGRES_USER=chat`), so a restore can drop and create the database the same way on both.
- **The Visual C++ runtime is checked by its signature** (valid, Microsoft Corporation), not by a hash: Microsoft's address always serves the newest file.
- **All five ports are asked,** the database's too; `install.sh` asks two or four, because there the others never leave the containers.
- **On `localhost` the setup sets `LIVEKIT_PUBLIC_URL=ws://localhost:<port>`,** so a test installation without a proxy has voice in a browser of the same machine.
- **The firewall rules name the program** (`livekit-server.exe`, `caddy.exe`, `node.exe`) besides the port, and a second run replaces the whole group "Squorli".
- **The log of a run** as a transcript in the data folder; the owner's setup code is printed after it is closed.
- **The uninstaller** removes the services with `sc.exe delete`, asks once, and deletes the data folder only when "löschen" or "delete" is typed; it does not set the power settings back.
- **The IIS template** uses `{UNENCODED_URL}` (the address as the client sent it), `preserveHostHeader` and `allowDoubleEscaping`; the settings that cannot stand in a `web.config` are commands in its README.

### Checked (without administrator rights, in a test frame that replaces what needs them)

- Both scripts parse in Windows PowerShell 5.1; the build refuses a script with German texts and no byte order mark.
- **A fresh installation, an update and a reconfiguration** with `-Unattended` into folders with a space in their names: programs copied, `.env` written from the template (secrets made, `DATA_DIR` in quotes), the templates filled, `initdb` (UTF8, locale `C`), the included settings, the database created, LiveKit and the app server started with the command line of the filled `SquorliServer.xml`, `/api/health` with the domain and `/rtc/validate` 401. After the update and the reconfiguration the secrets were the same, the old `.env` kept as `.env.bak.<time>`, the database found and left alone.
- **A run with typed answers,** wrong ones included (a domain with `https://` and a path, a name with an apostrophe, port 99999, the address 300.1.1.1): each refused with its message and asked again; and a run where the parameters were the offered answers and every question was answered with Enter.
- `icacls` with the SID of an existing service (`TrustedInstaller`) and of `LocalService` on this German Windows; the refusal for a service that does not exist.

### Not checked: everything the setup does as administrator

- Registering the four services (`pg_ctl register`, WinSW `install`), their accounts (`sc.exe config obj=`), the start under those accounts, the stop (whether Ctrl+C reaches the app under WinSW as a service), the restart after a crash and after a restart of the machine.
- The access rights with the services' SIDs, and `initdb` from an elevated shell.
- The firewall rules, the power settings, the PATH, the installation of the Visual C++ runtime.
- The bundled mode (Caddy, a certificate), a proxy on another machine, IIS.
- `uninstall.ps1` as a whole.
- Windows 10, Windows Server, a machine without the runtime, the German texts in a console.

### The service's name

On Linux the Compose service follows the same name since 28 September 2026 (`server`, `app` before; the user: "am besten auch auf linux squorli server nennen", and asked about the two ways, "direkt B bitte": the service itself, not only the command's word): `deploy/AGENTS.md`, "The app server's service is `server`". The `squorli` command of both systems names the services `server`, `postgres`, `livekit` and `caddy`.

The app server's service is `SquorliServer` (user's wish, 28 September 2026: "es sollte SquorliServer heißen, SquorliApp ist missverständlich"); until then it was `SquorliApp` in the templates, the setup and these notes, which name the new one throughout. Nothing was released under the old name.

### Acceptance by the user

To be filled with the user's runs. First run: a test installation on `localhost` with ports of its own next to the development stack, then `uninstall.ps1`.

- **28 September 2026, first run as administrator (Windows 11 Pro, German, questions in German):** the questions, the German texts with their umlauts in the console, the copy of the programs, `.env`, the templates and the registration of the three services went through; `sc.exe config obj=` set the account of its own for each (`NT SERVICE\<name>`). The run stopped at the access rights with error 1332: the setup gave rights to the account of Caddy's service, which exists in the bundled mode only. Fixed (the rights for Caddy only in the bundled mode). The test frame had hidden it because it dropped every service's SID; it now refuses the SID of a service the setup did not register.
- **28 September 2026, `uninstall.ps1` (Windows 11 Pro, German, with questions):** the three services stopped and removed, no firewall rules to remove (none had been made), the PATH entry gone, the data folder deleted after "löschen" was typed, the program folder deleted although the script lies in it. Afterwards `Get-Service Squorli*` lists nothing, both folders are gone and the machine's PATH holds no entry. With this the setup of phase 3 is accepted for one case: Windows 11 Pro, a proxy on this machine, `localhost`, an account per service. Its closing note names the power settings also when the setup never changed them; the uninstaller cannot know.
- **28 September 2026, restart of the machine (Windows 11 Pro):** the three services came up by themselves before the user was signed in. The machine started at 11:44:44, `SquorliPostgres` and `SquorliLiveKit` at 11:45:08, `SquorliServer` at 11:45:11 (it depends on the two), the user's desktop at 11:45:14; `/api/health` answered, and the user signed in and joined a voice channel. The user signed in about half a minute after the start, not after the two minutes that were asked for, so the services were ahead of the sign-in by three to six seconds; nothing in their start depends on a sign-in (automatic services of the service manager).
- **28 September 2026, third run as administrator (the reconfiguration on top of the second):** the setup went through to its end. The user: "Windows der Server läuft und ich kann mich problemlos in einen Sprachkanal verbinden". So on Windows 11 Pro the three services start under their own accounts (`NT SERVICE\<name>`), the app server reads `.env` and the database, and voice runs through the native LiveKit 1.13.7 on `localhost` from a browser of the same machine. Reported afterwards: Windows lists the three services as running, automatic, each under `NT SERVICE\<its name>`; `.env` is readable by `NT SERVICE\SquorliServer` and fully open to administrators and SYSTEM only; **`Stop-Service SquorliServer` reaches the app as Ctrl+C under WinSW as a service** (the log line "Server wird beendet" with `SIGINT`, WinSW: "Process ... canceled with code 0" 22 ms after the stop began), so the question WinSW's `test` command could not answer is answered. The stop logged one warning, "presence broadcast" with `CONNECTION_ENDED`: the member list was to be sent for the member whose connection the stop had just ended, from a database that was closing. Fixed: what reacts to ending connections in the background (member list, AFK move, radio) rests once the server closes (`closing` in `index.ts`, set by a `preClose` hook in front of the WebSocket plugin's); reproduced on Windows 11 with a signed-in member connected and Ctrl+C: the build from before logs the warning, the new one only "Server wird beendet" and "ws closed". **Still open:** a restart of the machine, `uninstall.ps1`.
- **28 September 2026, second run as administrator:** the access rights with the services' SIDs, `initdb` from the elevated shell, the start of `SquorliPostgres` under its own account and the creation of the database went through. The run stopped in the firewall question: `"...$extra?"` reads a variable named `extra?`. Fixed; the test frame had replaced that function as a whole and now runs its question.
- **28 September 2026, unpacking (Windows 11 Pro, German):** `tar -xf` of the package ended with "Archive entry has empty or unreadable filename ... skipping" and an error code. One entry was skipped, test data of `@fastify/send` in a folder whose name holds a snowman; everything else was unpacked. Fixed in the build: names outside ASCII that are test data of a package are left out (7847 files), any other stops the build; `tar -xf` of the new package ends with code 0 after 3 seconds.

