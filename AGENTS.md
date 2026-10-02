# AGENTS.md – Working guide for AI agents and new developers

This file is the entry point of the project description for all coding agents (Claude Code, Codex, Cursor, etc.). `CLAUDE.md` includes it and only adds Claude-specific rules.
It holds only what every task needs. Everything else lives next to the code it describes or under `docs/`, so that it costs context only when it is needed (split on 17 September 2026, user's wish; until then this was one file of 500 lines).

**Mandatory:** Whoever changes the structure, commands, configuration, protocol or milestone state updates the documentation in the same step, in the place section 0 names: the area's `AGENTS.md` (structure, conventions, pitfalls), the feature's notes (dated entry with the user's wishes, the decisions, and what was and was not checked), `docs/VERIFIED-STATE.md` and `docs/MILESTONE-LOG.md`. **This file only changes when something changes that every task needs. Never add feature entries here:** a new feature gets a file under `docs/features/` and a row in section 0; a new area gets its own `AGENTS.md` plus a `CLAUDE.md` next to it that contains only `@AGENTS.md`.

Last check of the complete workflow: 14 September 2026 (all green, see `docs/VERIFIED-STATE.md`).

## 0. Where the documentation lives

Read the file of every area a task touches before changing it. Agents that load nested `AGENTS.md` files by themselves get them when they work in that folder (Claude Code through the `CLAUDE.md` next to each); a task that spans areas reads each area's file.

| Area | File | Holds |
|---|---|---|
| App server `apps/server/` | `apps/server/AGENTS.md` | files, routes, schema, server conventions (permissions, owners, only with account, directory client, sessions, account deletion, database), server pitfalls |
| Desktop app `apps/desktop/` (Electron shell around the web client's build) | `apps/desktop/AGENTS.md` | files, security baseline, the fixed origin `app://squorli`, pitfalls (ELECTRON_RUN_AS_NODE, Electron's binary, embedded players, driving the app from a script) |
| Web client `apps/web/` | `apps/web/AGENTS.md` | files, UI conventions (i18n, icons, modals, no browser dialogs, settings, multi-server client), which feature notes belong to which file |
| Voice, camera, screen share `apps/web/src/voice/` and the media components | `apps/web/src/voice/AGENTS.md` | mute/deafen, codec, audio unlock, speech gate, `VIEW_VIDEO`, video, browser pitfalls |
| Link lookup `packages/link-preview/` (node only; also copied to the directory repo) | `packages/link-preview/AGENTS.md` | the address rules against requests to private networks, the guarded GET, reading a page's head, YouTube's oEmbed; security rules for changes |
| Protocol `packages/protocol/` | `packages/protocol/AGENTS.md` | files, `PROTOCOL_VERSION` rule, adding and ordering permissions, key backup |
| `deploy/`, `Dockerfile`, `.dockerignore`, CI | `deploy/AGENTS.md` | Compose files, published image, standard installation, image/Compose pitfalls, LiveKit connectivity |
| The package for Windows without Docker `deploy/windows/` | `deploy/windows/AGENTS.md` | the pinned programs (`versions.json`), the package build, the templates of the services and configurations, what the package holds, pitfalls (pnpm deploy, WinSW, LiveKit on Windows, PowerShell 5.1) |
| `tools/` | `tools/AGENTS.md` | dev wrapper, generators, load-test bots |
| Brand and design | `docs/brand/AGENTS.md` | binding design rules (mirrored to the sibling repos, section 1) |

Feature notes (dated entries: wishes, decisions, consequences, what was checked). Read before changing the feature, update in the same step:

| Feature | File |
|---|---|
| Web radio in voice channels: stations, typed addresses, playlists, Twitch and YouTube players, playing in step, idle stop, now playing | `docs/features/radio.md` |
| Voice, camera, screen share, stage: per-person volume, `VIEW_VIDEO`, cues, pop-outs and fullscreen, voice card, voice channel moderation | `docs/features/voice-video.md` |
| AFK detection (absent after 10 minutes without input or speaking, one fixed time for every server, system-wide with the Idle Detection API; in the desktop app controller input counts and a playing video holds it off for at most 4 hours), AFK channel, AFK in the friends list | `docs/features/afk.md` |
| Game detection in the desktop app (which games the launchers installed, which one is in front; local only so far), later the game display for friends and server members | `docs/features/games.md` |
| Mentions, unread marks, read states on the server, mutes, rail marks for every server (unread, mentions, how many sit in voice) | `docs/features/mentions-unread.md` |
| Markdown in messages, growing message input, focus after sending | `docs/features/markdown-input.md` |
| Link previews in channel messages (the server fetches title, description and picture and serves the picture itself; the author removes a preview with its x) and in direct messages (the sender's client makes them and sends them encrypted; the picture is an encrypted blob at the directory), YouTube videos that play in the chat after a press on play, their sound on the screen share device in the desktop app | `docs/features/link-previews.md` |
| Emoji: font, conversion, picker | `docs/features/emoji.md` |
| Settings dialog, mini profile, settings in the directory account | `docs/features/settings.md` |
| Admin panel (role and channel ordering), context menus, UI refresh | `docs/features/ui-admin.md` |
| Third-party licenses | `docs/features/licenses.md` |
| The web client on a phone's home screen: Squorli icons, the manifest route with "Squorli - <server name>", Apple tags | `docs/features/home-screen.md` |
| Directory integration: M6 phases, second factor, e-mail, account page | `docs/features/directory.md` |
| Desktop app (M4): decisions, phases, platform interface (`apps/web/src/platform/`), client without a home server, the Electron shell `apps/desktop/` | `docs/features/desktop.md` |
| Server accounts (25 September 2026): accounts of a server's own (`~name`) next to the directory's (`@name`), no temporary users any more (every sign-in needs an account, the owner too), the key encrypted with the password in the client and kept by the server, members from before register afterwards, the client's one key per server account next to the directory account, the account's avatar kept by the server, no direct messages between server accounts for now, `LOCAL_ACCOUNTS`; the privacy policy's sentence under the forms that create an account (2 October 2026: the directory's for `@name`, the server's own link `privacyPolicyUrl` for `~name`) | `docs/features/local-accounts.md` |
| Import of a server structure from a Discord server template (Verwaltung > Import: the template link, a plan of categories, channels and roles, only adding, Discord's public template endpoint without any token) | `docs/features/import.md` |
| Global hotkeys of the desktop app (mute, deafen; `globalShortcut`), the push-to-talk key across the system (the system watch helper watches that one key with Raw Input, Windows), control from outside for a Stream Deck or G Hub (`squorli://control/<action>`, `--control=<action>`), Einstellungen > Tastenkürzel | `docs/features/hotkeys.md` |
| Channel and category permissions (23 September 2026): overwrites per channel and category for roles and members (allow/deny/neutral, Discord's order, live inheritance), private channels that never reach a client who may not see them (per-user `structure`, channel-aware fan-out, 404 never 403), the channel dialog (right-click in the sidebar), sticky voice channels (`MOVE_MEMBERS`, `BYPASS_STICKY`, hold per channel with persistence and hiding), user limit, slowmode, read-only, notification suggestion, the Discord import's overwrites | `docs/features/channel-permissions.md` |
| Vote kick in voice channels (23 September 2026): where at least three members sit and nobody present may remove anybody (`MOVE_MEMBERS` in the channel, `KICK_MEMBERS`), the members vote somebody out for 15 minutes; one minute, the starter counts as a yes, the member it is about does not vote, a tie leaves them in, at least half of the channel has to vote; per-channel switch `allowVoteKick`, the box at the top of the member list | `docs/features/votekick.md` |
| Channel blocks and the member menu's moderation (24 September 2026): remove somebody from a voice channel and block them from it for 5, 15, 30, 60 minutes or for good (`MOVE_MEMBERS` in the channel), lift blocks from the member menu or the channel dialog's "Sperren", the vote kick's block is one too; table `channel_blocks`; kick/ban as server actions, no volume slider in the member list's menu | `docs/features/channel-blocks.md` |
| Status API (`GET /api/status`: name, icon, channels in order, the members sitting in a voice channel with their channel and mute state, nobody else; off by default, with the server's key or public, Verwaltung > Server) and the mute/sound-off display for the whole server (`voice.join`/`voice.status`, `VoiceMember.micMuted`/`deafened`) | `docs/features/status-api.md` |
| Reports (26 September 2026, stages 1 and 2 of `docs/PLAN-reports.md`): a member reports a message or a member to the server's moderators (`MANAGE_REPORTS`, granted to every role with `MANAGE_MESSAGES` by migration 0036), the report keeps a snapshot with copies of the attachments, Verwaltung > Meldungen closes it (delete, delete recent messages, kick, ban, dismiss), the reported person gets a notice without the reporter, the count on the rail; the moderation log without contents (180 days); a ban may delete the member's messages of the last hour, day or week (`message.bulkDelete`); blocking members; reports to the directory's operator (a direct message, a directory account, a chat server, a channel message passed on), a directory account the directory suspended (refused by chat servers unless switched off, `ServerSettings.refuseSuspended`; the notices in the client), chat servers the directory refused (the client does not connect to them) | `docs/features/reports.md` |
| Setup self-diagnosis (26 September 2026): `GET /api/doctor` (MANAGE_SERVER, or from the machine itself) checks the server's own address (DNS, certificate, WebSocket upgrade, `/rtc`), LiveKit's key, the TCP media port and the directory, a registered directory repeats the address checks from outside (`POST /api/servers/probe`), the browser makes a real media connection (UDP or TCP only, the announced address); texts in both languages from the server; `squorli doctor` in the installer's wrapper, "Verbindung prüfen" in Verwaltung > Server | `docs/features/doctor.md` |
| Notifications of the operating system (27 September 2026): direct messages and mentions when the sound plays, the desktop app through its shell (Electron `Notification`, a click opens the conversation), a browser through the Notification API as an opt-in; Einstellungen > Töne, a choice per device | `docs/features/notifications.md` |
| Proxy tests (27 September 2026): `deploy/proxies/test/run.sh` starts the production stack behind a real nginx, Traefik and Caddy and checks health, redirect, `/rtc`, the WebSocket upgrade, the client's address, an upload of `MAX_UPLOAD_MB` and `squorli doctor` through each; CI job `proxies`; `Caddyfile.external` for an existing Caddy | `docs/features/proxy-tests.md` |
| Logging (27 September 2026): what each container logs, no request log and no addresses by default (`LOG_REQUESTS` for troubleshooting, `LOG_LEVEL`), the three security lines with an IP, LiveKit at `warn`, Docker log rotation 3 × 10 MB per container (`x-logging`), journald for a time limit | `docs/features/logging.md` |
| Rate limits (25 September 2026): one `onRequest` hook counts per IP and per session token before any route (sign-in, WebSocket, invites, status API, the directory's pushes, writes, messages, uploads), 429 `rate_limited` with `Retry-After`, events per WebSocket (close 4008), `RATE_LIMIT_FACTOR` | `docs/features/rate-limits.md` |
| Updates and automatic updates (28 September 2026): `squorli update` restarts only what changed and backs up first on both systems (Linux: the containers with a new image; Windows: the services whose programs have another version), `squorli update --check` (exit code 10), `squorli autoupdate on|off` with an interval of 1 to 24 hours and a warning (systemd timer or `/etc/cron.d`, a task of SYSTEM on Windows), the logs of the runs, the decisions and what was checked | `docs/features/auto-update.md` |
| The server on Windows without Docker (28 September 2026, in phases; open ones in `docs/PLAN-windows.md`): what the server's code needed (replacing a file that is being read, stopping on a signal, `LISTEN_HOST`, the path check of the static files, the CI job `windows`), the package and its build (`deploy/windows/`), the setup and the `squorli` command, the decisions about the service wrapper (WinSW), PostgreSQL in the package, the cluster's locale, the PATH and the update | `docs/features/windows.md` |
| Devices (29 September 2026): every installation has a device key per account next to the account's key, enrolled with the password, signing along with every request; signing a device out holds (the directory decides for `@name`, the chat server for `~name`), the device loses the account's key and gets back in only with name, password and second factor; at most 10 devices with a choice at the eleventh, 90 days unused, keys that cannot be read out (WebCrypto, IndexedDB), Einstellungen > Geräte, `pnpm smoke:devices` | `docs/features/devices.md` |
| A signed-in server that does not answer (26 September 2026): only a refusal (4xx) of the stored session leads to the login; a server that does not answer shows a notice with retries (15 s, then 30 s for the 2nd to 5th try, then a minute each, ten in all, then a pause until the user presses, then five a minute apart, at once when online again or on "Erneut versuchen"), the own server as `ServerOffline`, a foreign one in `ServerStatus` without the join view; `/api/health` and `/api/me` give up after 10 s / 15 s; `ServerConnState.waiting`, `serverRetry.ts` | `docs/features/offline.md` |
| Operator limits (30 September 2026): `STORAGE_QUOTA_MB` (every file the server keeps, 413 `storage_full`), `VOICE_SEATS_MAX` (409 `voice_seats_full`), `MEMBER_MAX` (403 `server_full`), `DB_POOL_MAX`, each off when unset; `GET /api/ready` (200 only while the database answers); the directory registration that tries again by itself; the setup check probing the media node's address (`LIVEKIT_NODE_IP`); Verwaltung > Server > Grenzen with `GET /api/settings/limits`; the server accounts' per-address limits follow `RATE_LIMIT_FACTOR` | `docs/features/limits.md` |

History: `docs/VERIFIED-STATE.md` (what was run and checked per change, newest first; add an entry after every complete test run) and `docs/MILESTONE-LOG.md` (one row per change, newest first). Product plan: `docs/PLAN.md`. Developer guide: `docs/DEVELOPMENT.md`.

## 1. What the project is

**Squorli**: self-hosted community chat with voice and video channels (modeled on Discord, but every server belongs to its operator).
Solo development, TypeScript/Node, shipped as Docker containers. The name Squorli applies since 14 September 2026 (user's decision) in the code, in package names (`@squorli/*`), Compose projects, image tags and in the user interface.

**Brand and design: all questions about logo, colors, typography, spacing and tone of voice are governed by [docs/brand/AGENTS.md](docs/brand/AGENTS.md)** (brand package version 2 with assets, `squorli-tokens.css`, `palette.json`, `brand-guide.html`). Read it before any design change; the tokens have been adopted as `--sq-*` in `apps/web/src/styles.css` and `apps/directory/web/static/style.css`, the SVGs exist as copies under `apps/web/public/brand/` and `apps/directory/web/static/brand/` (the source remains `docs/brand/`; on changes, update both copies).
Guidelines and the ranked open work: [docs/PLAN.md](docs/PLAN.md). Read it before building larger features.

**Public source address:** Always use https://github.com/danielklessa/squorli for the open-source server in documentation, website links and clone examples. Internal development remotes and container registry settings are separate; this rule does not change them.

**Website and brand update (15 September 2026):** Squorli Server is the open-source project (Apache License 2.0, see `LICENSE`); Squorli Directory is not open source and is operated at https://directory.squorli.com. The sibling `../squorli-website` uses Astro/Vite for the German/English website at https://squorli.com and German/English technical guides. Read `docs/brand/PRODUCT.md` for shared product wording. Canonical `docs/brand/` must now be mirrored to **both** siblings and all three runtime brand folders. From the website run `pnpm brand:sync`, then `pnpm brand:check`. Update affected README/plan/public-copy descriptions together. Website-only documentation changes do not imply backend or protocol changes.

**Current state: M3 (video and screen share) implemented in the browser; webcam and screen share transmission tested successfully with real devices (15 September 2026). Remaining acceptance (15 real cameras, tab audio from Chrome for everyone, the screen share audio matrix in `docs/features/voice-video.md`) pending. M6a-M6d done (directory: handles, password backup, authenticator, devices, server registration and server directory). M7 friends and end-to-end encrypted direct messages via the directory done (14 September 2026; decisions in `../squorli-directory/docs/features/friends-dm.md`).** Available: everything from M2 (login with membership, categories/channels, roles, kick/ban, text chat with attachments, admin panel) plus camera with simulcast, stage with tile and speaker view, screen share with audio as a separate audio track (only Chromium delivers audio, other browsers get a notice), video bitrates in the debug view, test page `/test/screenshare.html` for the browser matrix, video bots. Voice as in M1 (LiveKit, VAD/PTT, device selection). Remaining M1 acceptance (restrictive network, TURN) deferred, see `docs/VERIFIED-STATE.md`.
**Directory service (M6 brought forward, user's decision, 14 September 2026; M7 friends and direct messages):** lives in its own, unpublished repo `../squorli-directory`, operated on a dedicated host with its own subdomain; this repo only knows `DIRECTORY_URL`. Sync rules for the shared protocol part and the brand package: section 2a. Phases M6a-M6d, second factor, e-mail and the account page: `docs/features/directory.md`.
**Voice channel moderation** (permission `MODERATE_VOICE`, 13 September 2026; moving is `MOVE_MEMBERS` since 23 September 2026): `docs/features/voice-video.md`, `docs/features/channel-permissions.md`.
**Roles (user's decision, 13 September 2026):** the default role is "Gast" (guest) and may only see channels and join voice channels. "Mitglied" (member: write, attach, invite, camera/screen) is assigned manually by admins; migration 0004 automatically turned existing members into "Mitglied".
Decisions for M2 (preliminary, made by Claude on 13 September 2026, not confirmed by the user): text chat = channel messages with edit/delete, no reactions/threads (direct messages came with M7 on 14 September 2026, user's decision: 1:1 only, between friends, end-to-end encrypted via the directory); moderation = role permissions + kick/ban, no audit log, no report function; permissions applied server-wide until 23 September 2026; since then channels and categories carry overwrites (`docs/features/channel-permissions.md`). Desktop client (M4): released as unsigned installers for Windows (NSIS) and Linux (AppImage, deb), built by the workflow `.github/workflows/desktop-release.yml`, with auto-update (`docs/features/desktop.md`). Not available: TURN acceptance.

## 2. Repository structure

Top level only; the files of each area are listed in its `AGENTS.md` (section 0).

```
apps/server/           App server: Fastify 5, Drizzle ORM + postgres-js, LiveKit server SDK. Serves the built web client. -> apps/server/AGENTS.md
apps/web/              Web client: Vite 5 + React 18 + livekit-client. Its build is also what the desktop app shows. -> apps/web/AGENTS.md
apps/desktop/          Desktop app (M4): Electron shell that serves apps/web/dist from app://squorli; no renderer code of its own. -> apps/desktop/AGENTS.md
packages/link-preview/ @squorli/link-preview: looking a link up on behalf of a user (SSRF rules, guarded fetch, page head parser). Used by the server, the desktop app and, as a copy, the directory. -> packages/link-preview/AGENTS.md
packages/protocol/     @squorli/protocol: zod schemas for REST and WebSocket, PROTOCOL_VERSION. Single source of truth for the client/server contract. -> packages/protocol/AGENTS.md
deploy/                Compose files (prod, dev, Portainer), Caddy, LiveKit config, proxy overlays. -> deploy/AGENTS.md
deploy/windows/        The package for Windows without Docker: pinned programs, package build, templates. -> deploy/windows/AGENTS.md
tools/                 Dev start with cleanup, generators (icons, emoji, licenses), copy-web, load-test bots. -> tools/AGENTS.md
docs/PLAN.md           Project plan (guidelines, risks, ranked open work, test campaign, open decisions)
docs/DEVELOPMENT.md    Developer guide (setup, simulating restrictive networks)
docs/features/         Feature notes, one file per feature (section 0)
docs/VERIFIED-STATE.md What was run and checked per change; docs/MILESTONE-LOG.md = one row per change
docs/brand/            Squorli brand package (version 2): AGENTS.md = binding design rules, README, BRAND_ORIGIN.md (name origin and brand concept), brand-guide.html, palette.json, squorli-tokens.css, SVG logos/icon marks, previews. Single source for brand and design; copies of the assets live in both apps
Dockerfile             Multi-stage build, target `app` (web + server); `pnpm deploy --legacy` (pnpm 10 requires the flag), runtime image only dist + drizzle + node_modules + public
.dockerignore          keeps node_modules, dist, .env, public out of the build context
.gitlab-ci.yml         GitLab CI: `test` (typecheck, vitest, build; every push/MR/tag), `build` (image target `app` into the project registry on the default branch: `<branch-slug>`, `<short-sha>`, `latest`), `build-tag` (on git tags: `<tag>`, `latest`). Modelled on `../squorli-directory/.gitlab-ci.yml`, keep both in step. Servers use the image via `APP_IMAGE` in `.env` (compose.yml: `${APP_IMAGE:-squorli/app:local}`)
.env.example           Template for production (.env in the repo root, read by compose.yml)
.env.development       Template for local development (copy to apps/server/.env)
```

Workspace: pnpm 10 (`packageManager` in package.json, `corepack enable`), Node >= 24 (LTS, tested with Node 24.21.0).
Package names: `@squorli/server`, `@squorli/web`, `@squorli/desktop`, `@squorli/protocol` (the directory service `@squorli/directory` lives in `../squorli-directory`). The protocol package is consumed as TypeScript source (no build step). `packages/protocol/src/permissions.ts` = permission bitmask (append new bits at the end) and `PERMISSION_GROUPS` = display order and grouping in the role editor (sort every new permission in by meaning and re-check the arrangement, `packages/protocol/AGENTS.md`).

## 2a. Sibling repo `../squorli-directory` (not published) and synchronized copies

The directory service (handles, key backup, authenticator) is the separate, **unpublished** repo `squorli-directory` next to this one (same parent folder). It has its own `AGENTS.md`, dev stack (Postgres on :5433, service on :3100), Dockerfile and `deploy/`. This repo never imports from it; the chat server talks to it only over HTTP (`DIRECTORY_URL`), the web client directly (URL from `/api/health`).

Three things exist in both repos and **must stay byte-identical**. Whoever changes one side syncs the other in the same work step (this is mandatory for every agent) and mentions it in the final report. Check with `diff -r` before finishing.

Agents working in either repo may edit the other `../squorli-*` repo when a change needs it (user's decision, 14 September 2026): protocol source here, service/account page there, chat server and client here. Run the other repo's typecheck/test (and smoke test for server changes), update its `AGENTS.md`, and list the touched files of both repos in the final report.

| What | Source (edit here) | Copy in `../squorli-directory` |
|---|---|---|
| Directory contract of the protocol: `packages/protocol/src/{primitives,directory,backup,useragent,friends,dm}.ts` and their `*.test.ts` | this repo | `packages/protocol/src/` (its `index.ts` only re-exports these six; the chat part of the protocol is not copied) |
| The whole package `packages/link-preview/` (looking a link up: address rules, guarded GET, page head parser, oEmbed) | this repo | `packages/link-preview/` there, checked with `diff -r` (the directory looks links up for senders of direct messages who use a browser) |
| Brand package `docs/brand/` (assets, tokens, `AGENTS.md` with the design rules) | this repo | `docs/brand/` and the asset copy `apps/directory/web/static/brand/` (same files as `apps/web/public/brand/` here) |

A fourth pair is kept the same by hand: `apps/web/src/deviceKey.ts` and its test here, `apps/directory/web/deviceKey.ts` and its test there (the device key of the chat client and of the account page, `docs/features/devices.md`); check with `cmp`.

Rules: new or changed directory schemas are defined here first (the web client parses the responses), then copied over and `pnpm typecheck && pnpm test` run in both repos; a brand change here is copied to `docs/brand/` there and to both asset folders (`apps/web/public/brand/` here, `apps/directory/web/static/brand/` there). If `../squorli-directory` is not checked out, say so in the report instead of guessing.

## 3. Commands

All from the repo root:

| Command | Purpose |
|---|---|
| `pnpm install` | Dependencies (the lockfile is binding, `--frozen-lockfile` in the Docker build) |
| `cp .env.development apps/server/.env` | Provide the dev configuration (once) |
| `pnpm dev` | **Normal development start** (`tools/dev.mjs`): starts Postgres + LiveKit via Compose, then the server (`tsx watch`, :3000) and the web client (Vite, :5173, proxies `/api` including WS to :3000). The directory service is started in `../squorli-directory` (`pnpm dev` there, :3100). On exit (Ctrl+C, crash of an app) the containers are stopped automatically (`compose stop`, data is kept). Options: `--no-docker` (leave the containers alone), `--down` (`compose down` on exit). |
| `pnpm dev:apps` | Only server + web client in parallel, without container management |
| `pnpm dev:desktop` | The desktop app against the Vite server (:5173), which it starts itself when nothing answers there (and stops with the app); own user data folder (`Squorli-dev`). `pnpm --filter @squorli/desktop start` shows the built client (`pnpm build` first) from `app://squorli` |
| `pnpm docker:dev` / `pnpm docker:dev:down` | Start / remove Postgres (5432) + LiveKit in dev mode (7880/7881/7882) manually |
| `pnpm typecheck` | `tsc --noEmit` in all packages |
| `pnpm test` | Vitest in all packages (`--passWithNoTests`) |
| `pnpm icons` | Regenerate the icon subset from Lucide (also runs in `pnpm build`); run once after every new `<Icon name>`, otherwise the glyph is missing in the dev server |
| `pnpm emoji` | Regenerate the emoji font (download of the current Noto Color Emoji slices, needs internet; `node tools/emoji.mjs --no-font` = data only), shortcodes and picker data (`apps/web/src/emoji/`), e.g. after updating `emojibase-data`; run `pnpm licenses` afterwards (font version) and commit the result |
| `pnpm run licenses` | (not `pnpm licenses`: pnpm's built-in command of that name hides the script) Regenerate the third-party notices (`apps/web/src/licenses/thirdParty.ts`, `THIRD-PARTY-NOTICES.md`) after any change of the client's dependencies (also runs in `pnpm build`); commit the result |
| `pnpm build` | Generate icons and third-party notices, web client (`tsc` + `vite build` to `apps/web/dist`), server (`tsup` to `apps/server/dist/index.js`), then `tools/copy-web.mjs` copies the client to `apps/server/public` |
| `pnpm smoke` | Smoke test (auth, owner, roles "Gast"/"Mitglied", invites, sessions/devices with remote logout, structure, permissions, messages, attachments, WS, RTC token grants, voice channel moderation, kick/ban, voice profile per channel, appoint/revoke owner, server icon, only-with-account, server directory listing, directory handle and display names and account deletion through the directory if `DIRECTORY_URL` is set; 230 checks without a directory, counted on 26 September 2026 (17 of them the section "Reports and the moderation log", 7 the setup check; 204 on 25 September 2026 with the server accounts (18 of them the section "Server accounts"; the script's `login()` registers a server account `~s<key>` for every new test key, since a bare key no longer gets in; 20 of them the section "Channel permissions": private channels, the write rules, slowmode, user limit, sticky, moves, eviction; 14 of them the section "Vote kick"; 8 of them the section "Channel blocks") (159 when server and script run with `LINK_PREVIEW_TEST_ORIGIN=http://127.0.0.1:3198`: the script then plays a linked website and the server may fetch from that one local address), the game display, read states, mutes, the mention rules, the web radio (4 of them the YouTube playlist queue, which like the YouTube video check ask YouTube's oEmbed), the AFK detection and `inviteRequired` in `/api/health` (one of them, the idle stop's timing, only when server and script run with `RADIO_IDLE_STOP_MS=2000`); refuses to run when the server names a directory that is not on localhost; the run with a directory adds its own: 221 checks on 25 September 2026, 5 of them the avatar of the directory account; it switches server accounts on at the start, they are off by default with a directory), **needs a running server on :3000** (`SMOKE_URL` for others). Remembers the owner key in `apps/server/scripts/.smoke-owner.json`. **Best against a separate test DB** (see pitfalls), because the first login becomes the owner. |
| `pnpm smoke:devices` | Smoke test of the devices (30 checks, `apps/server/scripts/smoke-devices.mjs`, docs/features/devices.md): the script plays the directory on 127.0.0.1:3196, so the server under test is started with `DIRECTORY_URL=http://127.0.0.1:3196` on a scratch database (`SMOKE_URL`, default :3001), one run per database |
| `pnpm smoke:suspended` | Smoke test of suspended directory accounts and a refused registration (24 checks, `apps/server/scripts/smoke-suspended.mjs`): the script plays the directory on 127.0.0.1:3197, so the server under test is started with `DIRECTORY_URL=http://127.0.0.1:3197` on a scratch database (`SMOKE_URL`, default :3001); it refuses a server that names another directory |
| `pnpm bots [--audio 15] [--video 0] [--resolution high] [--duration 60s] [--subscribers 0] [--room lobby]` | Put load-test bots into the voice channel; needs the running dev LiveKit. Visible and audible in the web client as "(extern)" (external). `--video 15 --audio 0 --subscribers 1` = bandwidth measurement as in `deploy/AGENTS.md` (room = channel UUID so they appear in the client) |
| `pnpm db:generate` | Generate a Drizzle migration from a schema change |
| Client URL `?debug` / `?ice=relay` | Show the debug view / force the browser onto TURN (`docs/DEVELOPMENT.md` "Simulating restrictive networks") |
| Client URL `/test/screenshare.html` | Screen share audio matrix (`docs/features/voice-video.md`, "Screen share audio: browser and system matrix"): does this browser deliver an audio track for tab/window/screen? Enter the result in the table there |
| `docker build --target app -t squorli/app:local .` | Build the production image |

Individual packages: `pnpm --filter @squorli/server <script>`; inside the package folder `pnpm dev`, `pnpm build`, `pnpm start` also work directly.

Start the built server locally: `node apps/server/dist/index.js` (reads `apps/server/.env`, serves `apps/server/public`); `STATIC_DIR` overrides the path. If `index.html` is missing there, `/` responds with 503 and an explanation and the startup log warns.

## 4. Definition of Done for every change

1. `pnpm typecheck` and `pnpm test` green.
2. For changes to the server, protocol or auth: start the server and `pnpm --filter @squorli/server smoke` green.
3. For changes to the Dockerfile, compose, configuration: `docker build` runs through.
4. Affected documentation updated: the `AGENTS.md` of the area and the feature's notes (section 0), `README.md` (operators) or `docs/DEVELOPMENT.md` (developers), if applicable `docs/PLAN.md` and `.env.example`.
5. New environment variables: in `apps/server/src/config.ts` **and** `.env.example` **and** `.env.development` **and** if applicable `deploy/compose.yml`.
6. For changes to the directory contract or the brand package: copies in `../squorli-directory` synchronized (section 2a), typecheck/test there green.
7. **The user's dev server must serve the newest version after every change (user's requirement, 17 September 2026):** the user tests on their running dev stack right after a change. For every web client change run `pnpm build` (root) so `apps/server/public` holds the current client (the server on :3000 serves that copy; only Vite on :5173 picks up source changes by itself), and after `pnpm build` tell the user to reload the page. After a new `<Icon name>` run `pnpm icons`. For server changes check that `tsx watch` restarted (after a schema change trigger a second restart, `apps/server/AGENTS.md` pitfalls). Never stop or restart the user's dev server yourself; if it has to be restarted by hand, say so in the final report.

## 5. Conventions

Only what applies everywhere. Area conventions: `apps/server/AGENTS.md`, `apps/web/AGENTS.md`, `apps/web/src/voice/AGENTS.md`, `packages/protocol/AGENTS.md`.

- **Language:** Documentation, READMEs and AI instructions (AGENTS.md, CLAUDE.md, docs/, deploy READMEs, comments in env templates and deploy configs) are always in English (decision of the user, 14 September 2026). Code comments are English. **UI texts are bilingual German/English** and come from the catalogs in `apps/web/src/i18n/`, never as a literal sentence in the code: `apps/web/AGENTS.md`.
- **Formatting:** `.editorconfig` (2 spaces, LF, UTF-8, newline at end of file). No linter/formatter configured; keep the existing style (compact one-liners are common).
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESM everywhere (`"type": "module"`). Imports without file extension.
- **Validation:** All inputs (HTTP bodies, WS messages, env) go through zod schemas. Define new REST/WS types first in `packages/protocol/src/index.ts`, derive the types from there, never declare them twice.
- **Protocol version, new server events, new permissions:** read `packages/protocol/AGENTS.md` first (a `PROTOCOL_VERSION` bump is costly; permissions are sorted by meaning and need a migration).
- **Configuration:** Exclusively via environment variables, validated in `config.ts`. The server loads `apps/server/.env` via `process.loadEnvFile` (built into Node, no dotenv dependency); variables already set take precedence. In the container there is no .env file, everything comes via compose.
- **No new dependencies** without need; if necessary, pin the version as before (caret ranges) and commit the lockfile.
- **Security:** Do not weaken the auth path (single-use challenge, domain binding of the signature, session TTL). LiveKit secret at least 16 characters (schema), 32+ in production; a template's placeholder as the secret (`placeholderSecretProblems` in `config.ts`) stops a production start, a short one only warns (security audit, 2 October 2026). `TRUSTED_PROXIES` only relevant in external mode.
- **Tests:** Vitest, files `*.test.ts` next to the code. Pure logic (stores, schemas) via unit test; flows via `scripts/smoke.mjs`.

## 6. Architecture in brief

- One process: Fastify serves the API, the WebSocket (`/api/ws`) and the static web client (SPA fallback to `index.html`, unknown `/api/*` -> 404 JSON).
- Identity = Ed25519 public key; the first login creates the user (`onConflictDoUpdate`). What is signed is `community-chat-login\n<domain>\n<nonce>`, so `PUBLIC_DOMAIN` must match the hostname the client sees (dev: `localhost`).
- Media never passes through the app server: the client fetches `/api/rtc-token` and connects directly to LiveKit (`wss://<PUBLIC_DOMAIN>/rtc`, the proxy forwards `/rtc*` to `livekit:7880`). UDP 7882 / TCP 7881 must be reachable directly.
- Operating modes: `PROXY_MODE=bundled` (bundled Caddy with Let's Encrypt on 443) or `external` (own proxy, see `deploy/proxies/README.md`, status untested).
- The challenge store is in-memory (single node). Multi-node later via Redis.

## 7. Known pitfalls

Development environment and smoke test. Others: server `apps/server/AGENTS.md`, image/Compose/LiveKit connectivity `deploy/AGENTS.md`, browser media `apps/web/src/voice/AGENTS.md`, dev wrapper and bots `tools/AGENTS.md`.

- **Smoke test against a test DB:** `docker exec squorli-dev-postgres-1 psql -U chat -d chat -c "CREATE DATABASE chat_smoke"`, then `RATE_LIMIT_FACTOR=5 DIRECTORY_URL= RADIO_IDLE_STOP_MS=2000 PORT=3001 PUBLIC_DOMAIN=localhost DATABASE_URL=postgres://chat:chat@localhost:5432/chat_smoke npx tsx src/index.ts` in `apps/server` (`RADIO_IDLE_STOP_MS` shortens the radio's two minutes of idle time so the smoke test can watch it; give the same value to `pnpm smoke`) (**`DIRECTORY_URL=` is not optional:** the server loads `apps/server/.env`, and when that names a real directory the smoke test would register accounts there; an empty value counts as unset and wins over the file; check `directoryUrl: null` in `/api/health` before running) (**`RATE_LIMIT_FACTOR=5`**: the script sets a whole server up within seconds and exceeds the write limit at factor 1, `docs/features/rate-limits.md`) and `SMOKE_URL=http://localhost:3001 RADIO_IDLE_STOP_MS=2000 pnpm smoke`. This way the owner of the dev DB remains your own browser key.
- **Windows:** `process.exit()` while WebSockets are still closing triggers a libuv assertion; the smoke test therefore waits for `close`. Follow the same pattern in future scripts.
- **Background processes on Windows:** `tsx watch` and Vite survive a hard kill of the parent shell. `pnpm dev` (wrapper) cleans up via `taskkill /T`; anyone using `pnpm dev:apps` directly checks `netstat -ano | grep ":3000 "` and `taskkill //F //T //PID <pid>` before restarting. **Beware German Windows:** `netstat` prints `ABHÖREN` instead of `LISTEN`; filter with `grep -E "ABH|LISTEN"`, otherwise the cleanup finds nothing and an old test server (with an old protocol) stays on the port while the new one cannot bind.
- **"Batchvorgang abbrechen (J/N)?" on Ctrl+C** ("Terminate batch job (Y/N)?") comes from the cmd.exe shells that pnpm opens for `tsx watch` and `vite`. Cosmetic; the wrapper terminates them immediately. Do not answer with J/N.
- **Port 3000/5173/5432/7880-7882 in use:** dev compose and the Vite proxy are hard-wired to these ports.
- **Directory service in dev:** `pnpm dev` in `../squorli-directory` (own Postgres on :5433, service on :3100); the chat server needs `DIRECTORY_URL=http://localhost:3100` in `apps/server/.env`. Chat smoke test with directory: start the chat server with `DIRECTORY_URL=http://localhost:3101` against a smoke instance there (see its AGENTS.md). Until 14 September 2026 the dev database `directory` lived in `squorli-dev-postgres-1`; the README there has the `pg_dump | psql` line for taking the data over.
- **`DIRECTORY_URL` missing in `apps/server/.env` after the update:** `.env.development` has it, an existing `.env` gets it by hand (`DIRECTORY_URL=http://localhost:3100`); without it the login shows "Dieser Server nutzt kein Verzeichnis" (this server does not use a directory).
- **`apps/server/public/` and `apps/server/.env` are gitignored**; never commit them. New variables in `.env.development` must be copied by hand into the existing `apps/server/.env` (e.g. `LIVEKIT_PUBLIC_URL`).
