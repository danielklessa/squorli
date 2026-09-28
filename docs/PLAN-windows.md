# Plan: Squorli Server as a package for Windows, without Docker

The user's brief of 28 September 2026 had six phases (the server's code on Windows, the package and its build, the setup, the `squorli` command, release and tests, documentation). All six are built, each released by the user and, accepted by their runs on Windows 11 and, for the test of phase 5, by the first run on GitHub's Windows runner; what they did, the decisions and what was checked: `docs/features/windows.md`. How the package, the setup, the command and the test work: `deploy/windows/AGENTS.md`. This file holds what is open.

Target: Windows 10 from 22H2 and Windows 11 (Home included), Windows Server 2019/2022/2025, x64 only. Nothing that only Windows Server has (IIS, server roles, the group policy editor). Every script runs in Windows PowerShell 5.1.

## Open

1. **The first tag `v*` with a package:** the job `attach` of `server-release.yml`, the published release, and `squorli update` from GitHub against it. The release notes of that version name the package for Windows, the new variables `LISTEN_HOST` and `DOCTOR_TOKEN` (both unset with Docker) and the renamed Compose service (`docs/MILESTONE-LOG.md`, 28 September 2026).
2. **The website goes live after that release** (`../squorli-website`, its `docs/PLAN.md`): the installation guide names the package as a download of the release page.
3. **The acceptance on real machines** after the checklist of the feature note (phase 5): a PC with the bundled Caddy and a real domain, a Windows Server with IIS in front (`deploy/proxies/iis/`), a proxy on another machine, Windows 10. Until then the README and the website say what was run and what was not; change both when it is.

## Not part of it, for now

- No MSI or EXE installer; a wrapper (Inno Setup, NSIS) can come later and only calls `install.ps1`.
- No ARM64.
- TURN stays off as on Linux.
- Code signing: the programs and scripts of the package are not signed (ours, WinSW's); SmartScreen and Smart App Control may ask or block. Not seen on the user's machine with a package unpacked by `tar`; open for a ZIP downloaded with a browser.

## Risks to watch

- **WinSW** has no maintained releases; Shawl is the way out. What was feared (a service that stays "running" after its program ended) did not show: a program that ends at its start makes the start of the service fail at once.
- **LiveKit on Windows** is built officially but used less than on Linux: voice ran on `localhost`; UDP media from another network and `use_external_ip` behind a router are part of the acceptance.
- **A PC as a server:** Windows Update restarts the machine, standby interrupts the service, a virus scanner of another maker can block `node.exe` or `livekit-server.exe`.
- **The update's interface:** `squorli update` of every installation out there calls the new package's `install.ps1` with fixed parameters and asks GitHub for fixed file names (`deploy/windows/AGENTS.md`, "Rules").
