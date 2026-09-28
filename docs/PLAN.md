# Squorli Server: guidelines and open work

Rewritten on 25 September 2026 in a plan cleanup with the user: what is built and documented left this file (architecture in `AGENTS.md` and the area `AGENTS.md` files, features in `docs/features/`, history in `docs/MILESTONE-LOG.md` and `docs/VERIFIED-STATE.md`); what remains is the product's guidelines and the open work, **ranked by relevance** (the ranking is Claude's, the user asked for it; move items when priorities change). Detail plans: `docs/PLAN-reports.md`, `docs/PLAN-mobile.md`, `docs/PLAN-share-adaptation.md`. The directory's open work lives in its own repository (`../squorli-directory/docs/PLAN.md`), the website's in `../squorli-website/docs/PLAN.md`.

**Keep it clean:** when an item is built, document it where section 0 of `AGENTS.md` says and delete it here (no "done" rows). A new large feature gets a `docs/PLAN-<name>.md` while it is being planned and loses it once it is built and documented.

Squorli is public: the website, the repository and the image are announced and used by other operators (user, 25 September 2026). That is why security and operation come first.

---

## 1. Guidelines

### 1.1 Fixed constraints

| Item | Decision |
|---|---|
| Model | Discord (server → channels → roles), but every server self-hosted |
| Video | Up to 15 simultaneous cameras per channel (target; accepted once measured on a real server, see 3.2) |
| Clients | Web (browser) and desktop (Windows and Linux built; macOS open, see 3.3); a native Android app is planned (`docs/PLAN-mobile.md`) |
| Identity | One account for all servers through the directory (`@name`); a server's own accounts (`~name`) next to it |
| Development | One person, TypeScript/Node, delivered as Docker containers |
| License | Apache 2.0. **No code from Stoat or other AGPL projects**, they may only serve as reference |
| Speaking | Push-to-talk and voice activation, the user chooses per device |
| Screen share with audio | Part of the product in browser and desktop, within the browsers' limits (`docs/features/voice-video.md`, "Screen share audio: browser and system matrix") |
| Operation | Standalone with the bundled Caddy **or** behind an existing reverse proxy; subdomain only, no sub-path |

### 1.2 Positioning

The closest competitor is Stoat (formerly Revolt): Discord-like, self-hostable, AGPL-3, weak in voice and video. So Squorli is **not "yet another Discord clone", but the self-hosted server where voice and video work as well as on commercial services, and which runs in ten minutes.** Consequences:

1. Media quality (latency, stability, echo and noise suppression, screen share with audio) comes before feature breadth (emoji, threads, bots).
2. The setup is a product feature: one command, one domain, done. Everything an operator has to do on top costs users.
3. Check every new feature against this before building it (the risk "scope creep" below).

### 1.3 Not planned for now

Recording, end-to-end encryption of media, a bot API, threads, federation between servers. (Mobile clients left this list on 25 September 2026: `docs/PLAN-mobile.md`.)

### 1.4 Risks

| Risk | Handling | State |
|---|---|---|
| NAT/TURN does not work for some operators or users | Self-diagnosis (`squorli doctor`, Verwaltung > Server; `docs/features/doctor.md`), TCP fallback 7881, docs on what a host must offer | TCP fallback and self-diagnosis built (26 September 2026); TURN off |
| Key loss | Password-encrypted key backup at the directory and on the server (server accounts), authenticator, recovery codes | built; the mnemonic recovery code was dropped by the user on 25 September 2026 |
| Audio quality below Discord level | Browser echo/noise suppression, speech gate, per-device settings | built; real-world measurement with users ongoing |
| The operator's proxy breaks WebSockets or headers | Reference configurations, self-diagnosis naming the proxy fault (`docs/features/doctor.md`), subdomain only | self-diagnosis built; configs exist, untested against real installations (2.1) |
| Screen share audio outside Chromium/Windows | Matrix, notices in the UI, the desktop app as the way out | matrix rows open (3.2) |
| LiveKit dependency (Go, third party) | **Pinned version** (`livekit/livekit-server:v1.13.7` since 25 September 2026, `deploy/AGENTS.md`), raise it on purpose with a server release; keep the server's LiveKit layer thin | pinned; no upgrade test in CI |
| Scope creep towards Discord's feature list | Section 1.2, section 1.3 | ongoing |
| Bus factor 1 | Docs next to the code, public repository | ongoing |

---

## 2. Priority 1: security and operation

### 2.1 Operator path

- **Nginx Proxy Manager and Plesk against a real installation:** nginx, Traefik and Caddy are tested in CI since 27 September 2026 (`docs/features/proxy-tests.md`); NPM (web interface) and Plesk stay manual, together with the next item.
- **A package for Windows without Docker** (user, 28 September 2026): built, released with Squorli Server 0.6.0 and documented (`docs/features/windows.md`, `deploy/windows/AGENTS.md`); run by the user on Windows 11 with the bundled Caddy and with a proxy on the same machine. Open (`docs/PLAN-windows.md`): what the user has no machine for (a Windows Server with IIS in front, Windows 10).
- **Automatic updates** (user, 28 September 2026; built, `docs/features/auto-update.md`). `deploy/windows/test/acceptance.ps1` passed on the user's machine with these changes. Released as Squorli Server 0.6.1 on 28 September 2026, the website's guide is live. Open: an update of a real installation to 0.6.1 and `squorli autoupdate on` there (Windows and Linux); a run of `stable-image.yml` by hand for `v0.6.1` once its change (`--prefer-index=false`) is pushed. The mark for a version that asks for work by hand is built (`squorli.autoUpdateFrom`), and the image tag `stable` (`stable-image.yml`, which ran with the publication of 0.6.1). **Open:** whether the install script enters `stable` instead of `latest` (and README, website and `portainer.yml` show it); undecided.
- **The "stranger in 15 minutes" test:** somebody who has never seen Squorli installs it from the website on a fresh VPS, standalone and behind an existing proxy (test campaign T6); `squorli doctor` and the admin panel's check against that real installation and a real proxy (`docs/features/doctor.md`, "Not checked").

---

## 3. Priority 2: product

### 3.1 Reporting, blocking, deleting with evidence

All seven decisions made by the user on 25 September 2026 (as proposed): `docs/PLAN-reports.md`. Stages 1 (server reports) and 2 (delete on ban, the moderation log) are built (26 September 2026, `docs/features/reports.md`). Stage 4's direct messages are built too (26 September 2026: the flag on a friend's message, the plain text inside the signed report, the directory's queue). Stage 3 (blocking members, in the sealed settings) is built too (27 September 2026, same note; released with server 0.5.0 and desktop app 0.8.0, its decisions confirmed by the user the same day). The rest of stage 4 is built too (27 September 2026, same note: reports of accounts and chat servers to the directory with the receiver's choice, chat servers refusing suspended directory accounts, clients refusing refused servers, the notices in the client); it needs a server release and a desktop app release after the directory's deploy, and its decisions of mine wait for the user (the session that stays, the sentence added to the notice). Open: stage 5 (push while offline), and on the website the page with the rules of use and the guides for the new parts. The mobile app's store submission needs 4. Also open from stage 1: the notice to the reported person only while they are online. The website's guides describe reports since 26 September 2026 and go live with the release.

### 3.2 Acceptance of the media promise

- **15 real cameras on a target server** over the internet: bandwidth in and out (`docker stats` on the host), CPU, the tile view; replaces the projection in `deploy/AGENTS.md`.
- **A restrictive network** (mobile hotspot, a company Wi-Fi): does 7881/tcp carry it; TURN only if somebody needs it (user, 25 September 2026: "erst wenn sich jemand beschwert", then TURN over 443 by SNI passthrough).
- **The screen share audio matrix:** fill the "verify" rows (`docs/features/voice-video.md`, test page `/test/screenshare.html`); open decision 6.1.

### 3.3 Clients

- **macOS desktop app** (user: medium): a mac build target and signing in CI, system audio through ScreenCaptureKit or a documented limitation (open decision 6.1).

### 3.4 A screen share that adapts by itself (user: medium)

`docs/PLAN-share-adaptation.md`: stage 1 (the sender's rows in the statistics), stage 2 (the governor), then stage 3 once decisions 1 and 2 there are made.

### 3.5 Native Android app (user: medium)

`docs/PLAN-mobile.md`, all six decisions made on 25 September 2026: Capacitor, Android first without screen share, push only as a wake-up through the directory, no push for server accounts. Needs 3.1 first (stores).

---

## 4. Priority 3: later

- **Games** (`docs/features/games.md`): detection on Linux, more launchers (Ubisoft, EA, Battle.net, Riot), a rule list for games behind another executable (Minecraft Java = `javaw.exe`), larger icons.
- **Linux desktop:** system-wide push-to-talk and hotkeys on Wayland (X11 only today), window audio (Windows only; also macOS).
- **Push-to-talk:** mouse buttons as the key, a short tone when it opens, offering push-to-talk on the first join (`docs/features/hotkeys.md`).
- **Link previews:** an "embed links" permission, an admin setting instead of `LINK_PREVIEWS`, smaller copies of large pictures, Twitch clips and Vimeo (`docs/features/link-previews.md`).
- **Server accounts:** second factor and e-mail, friends and direct messages, an admin view of them (`docs/features/local-accounts.md`).
- **Mentions:** `@everyone`/`@here`/role mentions, mentions in direct messages; unread marks do not read `defaultNotify` yet; two same-name members picked from the list in one message both point to the last one picked (bug) (`docs/features/mentions-unread.md`).
- **Voice:** H.264 hardware encoding (LiveKit negotiates only the constrained baseline profile), AV1 for the screen share (decision 7, deferred), the quiet microphone on iPhone and in Firefox/Safari, "voices get quieter while watching a share" (not reproduced) (`docs/features/voice-video.md`).
- **Radio:** re-reading a YouTube playlist that changed, the queue limit of 200 (`docs/features/radio.md`).
- **Status API:** an env variable that pins the mode, the mobile join sheet's mute icons (`docs/features/status-api.md`).
- **UI:** settings search and collapsible advanced sections; kick/ban still shown to members who do not outrank (the server refuses) (`docs/features/ui-admin.md`).
- **Import:** the bot path for community templates (`docs/features/import.md`).
- **Protocol:** reconnect with sequence numbers instead of the full state in the welcome (user, 25 September 2026: low).
- **Delivery:** a Redis profile (only for several LiveKit nodes), S3-compatible storage for attachments, a beta channel for the desktop app, GitHub Actions off Node 20.
- **Development:** a dev profile with a proxy in front, mkcert for LAN tests, a fake-media launch script, a seed script, Playwright end-to-end tests, a lint step (`docs/DEVELOPMENT.md`); drop the old `directory` dev database in this repo's Postgres (`apps/server/AGENTS.md`).

---

## 5. Test campaign

Most features were checked with typecheck, unit tests, smoke tests and headless browsers; what needs real people, devices or hosts is collected here by setup. The details stay in each feature note's "Not checked" line; tick a setup off by recording the run in `docs/VERIFIED-STATE.md` and clearing those lines.

| # | Setup | Covers |
|---|---|---|
| T1 | **Two real clients over the internet** (different networks, one old and one new version) | voice, camera, screen share incl. a real game with H.265 and the viewer statistics, vote kick, channel blocks and removal, game display end to end, link and DM previews, the AFK video rule (10 min hands off, then the 4 h cap), mentions and rail marks, radio in step, channel permissions side by side |
| T2 | **A real phone** (Android and iPhone, browser and home screen) | push-to-talk button, microphone level, rear camera, background audio, touch menus, modals and narrow layout, the on-screen keyboard |
| T3 | **Firefox and Safari** | emoji font, camera and pop-out, viewing H.264/H.265 shares, WebP-to-JPEG fallback, the settings dialogs |
| T4 | **The packaged desktop app on Windows** | update at start end to end, tray, deep links from a browser, hotkeys with a Stream Deck or G Hub, window audio heard by a listener, AMD and Intel graphics |
| T5 | **The desktop app on Linux** (AppImage, deb) | install, update, tray, hotkeys on X11 |
| T6 | **Operators** | the installer's bundled mode up to a real certificate, nginx/Traefik/NPM in front, restore on a new host, a fresh VPS by a stranger (2.1) |

---

## 6. Open decisions

1. **macOS system audio in the desktop app:** a requirement or a documented limitation (after the matrix rows of 3.2).
2. **The screen share's adaptation:** stage 3 (a) simulcast or (b) the viewers' quality reports, and whether the governor may go below the quality the user picked without asking (`docs/PLAN-share-adaptation.md`, section 4; the user skipped both on 25 September 2026).
3. **AV1 for the screen share** (deferred by the user on 18 September 2026; `docs/features/voice-video.md`, "Screen share codec").
