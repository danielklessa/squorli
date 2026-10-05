# Squorli Server: development guide

This document is for people who work on the code. Operators who only want to run a server should read the [README](../README.md). Conventions and pitfalls for developers and AI agents start in [AGENTS.md](../AGENTS.md), which maps the `AGENTS.md` of each area and the feature notes under [features/](features/); the current test status is in [VERIFIED-STATE.md](VERIFIED-STATE.md); plan and architecture in [PLAN.md](PLAN.md).

**Status: M3 (video and screen share) implemented in the browser, acceptance pending.** Multiple text and voice channels in categories, roles with permissions and hierarchy, invite links, kick and ban, text chat with history, editing, deleting and attachments, admin interface, member list with online status. Voice with voice activation/push-to-talk and device selection; camera with simulcast, stage with tile and speaker view, screen share with audio (Chromium) as a separate audio track, bandwidth in the debug view. New members are "Gast" (guest: view and voice only), admins grant "Mitglied" (member). Friends and end-to-end encrypted direct messages between friends are implemented via the optional Directory (M7). Desktop client (Electron) with installers for Windows (NSIS) and Linux (AppImage, deb) from the workflow `desktop-release` ([features/desktop.md](features/desktop.md)). Not yet: reactions, audit log.

## Client UI and avatar integration

The client maps the canonical version 2 brand tokens in `apps/web/src/styles.css`. Reuse `Avatar.tsx` for user identity rather than creating new initials or image implementations. Its `name`, optional `src`, `size` and optional `online` props cover messages, lists, profiles and voice tiles. Names appear beside the decorative image; presence has a translated accessible label. Failed images fall back to initials. The profile preview follows the edited display name.

Avatar uploads and storage are future work: there is no avatar field in the current server or Directory contract. When implementing them, define validated protocol fields and storage first, resolve server-relative URLs through the appropriate `ServerApi`, and pass the resulting URL to the component. Do not load arbitrary third-party avatar services by default.

Responsive review should cover desktop with/without Directory, mobile navigation expanded/collapsed, long names, grouped messages, profile dialogs, and voice tiles. Browser review of the 15 September 2026 refresh remains pending (no browser connected in the editing environment). Typecheck, 50 existing tests and production build passed.

The voice dock presents connection/channel identity, a channel-view shortcut, unblock notices and microphone feedback separately. Muted microphones display a muted label and an empty meter; mute, deafen and camera controls expose `aria-pressed`. Mobile navigation scrolls so all voice controls remain reachable. The underlying voice state and media operations are unchanged.

## Video windows and fullscreen

Each camera/screen tile offers a pop-out and fullscreen action. `useVideoWindows` is owned by App so switching to text chat does not close the window. A pop-out has no frame or permanent app header/footer. Fullscreen and per-feed volume controls float over the video on hover or keyboard focus, and stay visible on touch devices. Double-click or F/Enter toggles fullscreen. The main tile shows a placeholder and a restore button instead of a second video. Closing the pop-out also restores the main view.

The window opens synchronously from a user click and receives a React portal with the existing styles. `VoiceClient.setVideoAudioHost` moves the existing audio element into the pop-out rather than creating another playback instance. A camera pop-out receives that participant's microphone; a screen pop-out receives screen audio. Local video never plays the local microphone back. The same LiveKit track/element retains volume and sink settings; deafen updates all registered elements across documents. New audio subscriptions use the current destination. Cleanup returns audio to the main host; disconnect clears all destinations. If playback is blocked, a temporary unblock button appears on the video.

Windows close when the video track disappears or the main page closes. Reopening an existing track focuses its window. Browsers may open a tab instead of a window, retain native window chrome or lack fullscreen support. Reference: [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).

Typecheck and 65 unit tests pass, including separate camera/screen routing, restoring the same audio element, deafen across windows and stale cleanup. Browser acceptance remains pending: two remote camera/screen streams, grid/focus/text switching, resize/fullscreen, autoplay blocking, audio-device changes, track replacement/end, and closing either window. No browser is connected in the editing environment.

## Member context menus

`ContextMenu.tsx` renders member actions through a portal into `document.body`, outside the member list scroll area. Right-click opens at the pointer; click or keyboard activation anchors to the member button. Roles and move destinations use `ContextSubmenu` with hover, click and ArrowRight support, viewport-edge flipping, and ArrowLeft/Escape to return. Up/Down and Home/End navigate menu items. Outside pointer/focus, outer scrolling and resize dismiss the menu. Destructive actions keep the existing confirmation dialogs and API permission checks.

Placement is covered by six unit tests in `menuPosition.test.ts`. Interactive browser acceptance remains pending because the editing environment has no connected browser.

## Structure

```
apps/server      App server (Fastify, Drizzle/Postgres, LiveKit tokens). Also serves the built web client.
apps/web         Web client (Vite + React). Later the basis for the Electron shell.
packages/protocol Shared schemas (zod) for REST and WebSocket.
deploy/          compose.yml (prod, two profiles), compose.dev.yml, Caddy, LiveKit, proxy examples
docs/PLAN.md     Project plan
```

## Development

Prerequisites: Node 24 (LTS), pnpm (`corepack enable`), Docker.

```bash
pnpm install
cp .env.development apps/server/.env   # or export the variables
pnpm dev                   # starts Postgres + LiveKit in containers, then the app server on :3000 and the web client on :5173 (proxies /api to :3000)
                           # Ctrl+C stops everything, the containers are stopped automatically (data is kept)
```

Variants: `pnpm dev --no-docker` (manage the containers yourself), `pnpm dev --down` (remove the containers on exit),
`pnpm dev:apps` (apps only), `pnpm docker:dev` / `pnpm docker:dev:down` (containers manually).

Then open http://localhost:5173: a key is generated. With a running directory service (separate repo `squorli-directory`, `pnpm dev` there; `DIRECTORY_URL` in `apps/server/.env`) you can give the key a handle like `@daniel` once; it is shown on all servers that use this directory. "Anmelden und verbinden" (log in and connect) makes you the owner (first user). Channels on the left (#allgemein, Lobby), members on the right, gear icon = admin panel.
Second participant = second browser profile or incognito window (own key); it needs an invite link from the admin panel and is then "Gast" (guest: sees channels, may join voice channels). Writing, files, camera and screen only come with the role "Mitglied" (member): click the name in the member list and set the role. Join a voice channel by clicking it; mute, leave and settings at the bottom left.
Moderation (permission "Sprachkanaele moderieren" (moderate voice channels), admins have it): click the name in the member list, then move, remove from the voice channel, stop camera/screen or block camera/screen for this member (🚫 in the list). The affected member sees a notice saying who did it.
Camera: with several cameras the client always asks with a preview when switching on. Background blur (settings or 🌫️ on the stage) is computed in the browser and loads the model from the network the first time; Firefox/Safari cannot do this. The audio of shared screens can be routed in the settings to a different output device than voice (Chromium only).
Voice quality: configurable per voice channel in the admin panel (channels), Opus bitrate 24 to 256 kbit/s (default 64) and stereo for music. Connected clients switch over immediately; the stage header shows the active profile.
On joining, the stage opens in the main area: tiles per participant, buttons for microphone, camera, screen and leave; "Sprecher"/"Kacheln" (speaker/tiles) switches the view, double-click pins a tile. Clicking a text channel shows the chat again (voice and camera keep running), "Ansicht" (view) at the bottom left brings the stage back.
Screen share with audio: only in Chrome/Edge/Brave, and there only with "Tab" (tab audio) or on Windows "entire screen" with system audio. Firefox and Safari only share the picture; the stage says so then. Which combination delivers audio on your machine is checked by http://localhost:5173/test/screenshare.html (the result belongs in `docs/features/voice-video.md`, "Screen share audio: browser and system matrix").
Default is voice activation (threshold via slider); push-to-talk works in the browser only while the tab has focus.
Debug view (WebSocket events, packet loss, jitter): "Debug" button or http://localhost:5173/?debug.
Without a camera and without permission dialogs: start Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (a launch script for it is open work in `docs/PLAN.md`).

Desktop app (`apps/desktop`, Electron): `pnpm dev:desktop` shows the Vite client inside the shell and starts that Vite server itself when `pnpm dev` is not running (a stopped chat server only makes that server unreachable in the rail) (user data in `%APPDATA%/Squorli-dev`); `pnpm build && pnpm --filter @squorli/desktop start` shows the built client from `app://squorli`, as a packaged app does. Add `-- --directory-url=http://localhost:3100` for the local directory. If Electron's binary is missing after `pnpm install`: `node node_modules/electron/install.js` in `apps/desktop`. Installer: `pnpm build && pnpm --filter @squorli/desktop dist` (output in `apps/desktop/release/`); releases come from the tag `desktop-v<version>` through `.github/workflows/desktop-release.yml` (draft release). Details and pitfalls: `apps/desktop/AGENTS.md`.

The client as the desktop app runs it (no home server: own login, servers by address, server viewed last; `docs/features/desktop.md`): `VITE_HOMELESS=1 pnpm --filter @squorli/web dev` (directory `http://localhost:3100`, another one with `VITE_DIRECTORY_URL`). It reaches chat servers by their address, e.g. `localhost:3000`; for a server the directory lists, `PUBLIC_DOMAIN` must be an address the browser can reach (`localhost:3000` together with `DIRECTORY_PROOF_URL=http://localhost:3000/api/health`).

Load test: `pnpm bots` puts 15 audio bots into the lobby for 60 s (`--audio 30 --duration 5m --subscribers 1` etc.). They appear in the client as "(extern)". Video: `pnpm bots --video 15 --audio 0 --subscribers 1 --room <channel UUID>` publishes 15 test cameras with simulcast; the `lk` table at the end shows bitrate and packet loss at the listener, the debug view in the client your own receive rates per tile.

Second device in the LAN: enter `LIVEKIT_DEV_NODE_IP=<LAN IP of the machine>` in `apps/server/.env` (or as an environment variable), `pnpm dev`, then open `http://<LAN-IP>:5173` from the other device. Testing from outside through the router: enter the public IP there and forward 7882/udp + 7881/tcp. Caution: without HTTPS the browser will not release the microphone there (`localhost` is the exception); HTTPS for LAN tests (mkcert certificates) is open work in `docs/PLAN.md`.

Running without Docker: `pnpm build` builds the protocol, web client and server and copies the client to `apps/server/public`; then `node apps/server/dist/index.js` (reads `apps/server/.env`).
If `/` answers with "Web-Client fehlt" (503) or `Route GET:/ not found`, the server was started without this step or the Docker image is outdated.
If login fails with `verify -> 401`, `PUBLIC_DOMAIN` does not match the hostname in the address bar (signatures are bound to the domain); the error message in the client names both values.

Migrations: change the schema in `apps/server/src/db/schema.ts`, then `pnpm db:generate`. They are applied automatically at server start.

Directory service (M6, brought forward): lives in the separate, unpublished repo `squorli-directory` (next to this one; own database, own deployment on its own host with its own domain, see its README), chat servers get `DIRECTORY_URL=https://id.example.org`. Create an account (handle + password) directly on the service's account page (`https://id.example.org/`); afterwards log in on any chat server with handle and password. The private key is stored at the service only password-encrypted (Argon2id since 5 October 2026, PBKDF2 before, then AES-GCM, all in the browser). It maps handles to public keys; the chat server queries it at login and shows verified handles. Each chat server registers itself there with its own key (host proof: the directory fetches the server's `/api/health`, `DIRECTORY_PROOF_URL` if that differs from `https://PUBLIC_DOMAIN/api/health`) and then reads its members' display names (global or per server, set on the account page or in the profile dialog); other servers cannot read them. If it goes down, chat keeps running without handles. On the account page (after logging in with handle + password): change password, set up an authenticator (TOTP) as a second factor for key retrieval (needs `DIRECTORY_SECRET_KEY` at the service), recovery codes, list of key retrievals. In the chat client under Einstellungen > Sitzungen (settings > sessions, the gear next to your name): see the logged-in sessions of this server and log them out remotely. E-mail via SMTP later. The directory part of the protocol package (`packages/protocol/src/{primitives,directory,backup,useragent}.ts`) is copied into that repo and must stay identical; the same applies to the brand package `docs/brand/`.

## Simulating restrictive networks

The M1 acceptance requires a peer in a network that blocks UDP. Without such a network this can be reproduced; the debug view (`?debug`) shows under "ICE-Weg" (ICE path) which path is actually used (`udp`, `tcp`, `relay`).

| Scenario | Reproduce | Expectation |
|---|---|---|
| Normal | nothing | `udp srflx->host` (behind NAT) or `udp host->host` |
| UDP blocked | Remove the forwarding `7882/udp` on the router (or block it inbound in the Windows firewall), join again | Connecting takes a few seconds longer, ICE path `tcp ...` via 7881 |
| UDP and direct TCP connection blocked | Open the page with `?ice=relay` and join: the browser may then only use TURN | Without active TURN: joining fails (CONNECTION_TIMEOUT). With TURN: ICE path `relay (TURN ueber tls)` |

Enabling TURN: `deploy/livekit/livekit.yaml` (certificate required, port 5349/tcp to the chat host).

## Smoke test

With the server running (`pnpm dev` or `node dist/index.js`), `pnpm smoke` checks the complete flow:
challenge, signature, replay protection, profile, LiveKit token, WebSocket handshake, voice channel presence, protocol version.

## Continuous integration

`.github/workflows/ci.yml` (GitHub) and `.gitlab-ci.yml` (GitLab) run `pnpm typecheck`, `pnpm test` and `pnpm build` on every push and pull/merge request. On the default branch and on git tags they additionally build the production image (Dockerfile target `app`) and push it to the registry: `ghcr.io/danielklessa/squorli-server` on GitHub, the project registry on GitLab. Keep both pipelines in step.

## Dependencies

`pnpm audit --prod` lists known vulnerabilities in what the server and the client ship; both CIs run it as a job that is shown and never blocking (`audit`), and the updates come as merge requests of Renovate, which runs in the GitLab instance (first run on 3 October 2026; the GitHub repository is a one-way mirror of GitLab, so GitHub's Dependabot is not used: its pull requests would never reach the origin). Renovate puts the minor and patch updates of the npm packages into one merge request per week and the images and CI files into another, proposes a known vulnerability at once, and proposes a major version only when it is ticked in the Dependency Dashboard (an issue of the project); nothing is merged by itself. **After merging an update of a client dependency run `pnpm build` and commit the files it regenerates** (`THIRD-PARTY-NOTICES.md`, `apps/web/src/licenses/thirdParty.ts`, `apps/web/src/icons/`): the merge request changes only the manifests and the lock file. Read a red `audit` job and update the package named in it. **Majors of the packages the server's behaviour hangs on are updated by hand and checked with `pnpm smoke` against a fresh scratch database** (migrations run through drizzle's migrator): fastify, `@fastify/static` (its `setHeaders` callback got the Fastify reply instead of the raw response in version 10), drizzle-orm, livekit-server-sdk, electron. A vulnerable package that only a dependency of a dependency asks for is patched with an entry under `overrides:` in `pnpm-workspace.yaml` inside its major version (the file says why; remove the entry when the parent asks for the fixed version itself).

## Website and shared brand

The sibling `../squorli-website` project provides the German/English public website for https://squorli.com and German/English installation documentation. The guide source is `../squorli-website/src/pages/[lang]/docs/install.astro`; the planned public path is `/en/docs/install/`.

This repository's `docs/brand/` remains canonical. Keep it byte-identical in both sibling projects, and synchronize the runtime assets. From `../squorli-website`, run `pnpm brand:sync` after a canonical brand change, then `pnpm brand:check`. Product descriptions and the website's two languages must also be updated together. See [brand/PRODUCT.md](brand/PRODUCT.md).
