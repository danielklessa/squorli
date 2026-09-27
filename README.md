# Squorli Server

Homepage: **https://squorli.com**

Self-hosted, open-source community chat with text, voice and video channels, similar to Discord. Every server belongs to the person who runs it. Squorli Server includes the browser client. A desktop app for Windows and Linux (the same client in its own window, `apps/desktop`) is available as an early version: https://squorli.com/en/download/.

Official repository: [Squorli Server on GitHub](https://github.com/danielklessa/squorli-server). Licensed under the [Apache License 2.0](LICENSE). A server can optionally connect to the [Squorli Directory](https://directory.squorli.com), a separately operated service that gives users a global handle, lets them find friends across servers and exchange end-to-end encrypted direct messages. Without a directory, a server works completely on its own.

This README explains how to run your own Squorli server. Working on the code: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## What you get

- Text channels with history, editing, deleting and attachments; voice channels with voice activation or push-to-talk.
- Mentions with `@name` suggestions, a highlight for messages that mention you and counters per channel and server.
- Markdown in messages (formatting, lists and task lists, tables, code blocks with a copy button) and emoji: an emoji picker, `:shortcodes:` and emoticons such as `:)`, shown in an emoji font that your own server delivers, so they look the same on every system and no font service is involved.
- Camera and screen share (screen audio in Chromium browsers), tile and speaker view.
- Web radio in voice channels: admins keep a list of stations (direct streams or `.m3u`/`.pls` playlists), members with the permission turn one on for everyone, and every listener sets their own volume or turns it off. Twitch channels and YouTube videos or live streams work as sources too, shown with the official players; YouTube videos play in step for everyone, steered by the members who may control the radio. A radio nobody listens to stops by itself after two minutes.
- Away status: after ten minutes without input and without speaking a member shows as away (in Chrome and Edge input anywhere in the system can count, if the member allows it). Admins can name an AFK channel: whoever turns away in a voice channel is moved there; microphone, audio, camera and screen share are always off in it, enforced by the media server. With a Squorli Directory, friends see the away status too.
- Categories, roles with permissions and hierarchy, invite links, kick and ban, admin panel in the browser.
- Optional connection to a Squorli Directory for global handles, friends and end-to-end encrypted direct messages.

Not yet: a desktop app for macOS, reactions, audit log. Current status of the implementation: [AGENTS.md](AGENTS.md).

Third-party software, fonts and data inside the client are listed with their licenses in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and in the client under Settings > Licenses; see also [NOTICE](NOTICE).

## Requirements

- A Linux host with Docker and Docker Compose (v2).
- A domain that points to the host, for example `chat.example.org`. Browsers only release microphone and camera over HTTPS.
- Open ports: `443/tcp` (only if the bundled Caddy terminates TLS), `7881/tcp` and `7882/udp` (media, open to everyone).
- Roughly 1 GB RAM for the app server, Postgres and LiveKit together; more with many simultaneous video streams.
- For video: upload bandwidth at the server. LiveKit forwards every camera to every viewer without transcoding, so the upload grows with cameras times viewers: a full channel of 15 cameras watched by 15 people needs roughly 60 Mbit/s upload and 20 Mbit/s download (projected from a local measurement of 4.1 Mbit/s per viewer of 15 tiles; LiveKit took about 9 % of one CPU core and 135 MB of memory for 15 cameras and one viewer). For large video channels rent a server or VPS; a home connection is usually too weak.

The stack consists of the app server (this repository, including the web client), Postgres and [LiveKit](https://livekit.io) as media server. Everything runs from `deploy/compose.yml`.

## Interactive installer

On a Linux host (x86_64) with root access, `deploy/install.sh` does the steps of the quick start below by asking questions, in German or English:

```bash
curl -fsSL https://raw.githubusercontent.com/danielklessa/squorli-server/main/deploy/install.sh -o install.sh
sudo bash install.sh
```

It asks for the domain, the server name, who terminates HTTPS (the bundled Caddy, a reverse proxy on the same host, or one on another host), the ports (it finds ports another service already uses and suggests free ones; the bundled Caddy always needs 80 and 443), the directory, the owner's public key and the public IP for media; installs Docker through get.docker.com if it is missing (after asking); downloads the deploy files into `/opt/squorli` (`SQUORLI_DIR` changes that); writes `.env` with fresh secrets (readable by root only); offers to open the ports in an active ufw or firewalld; pulls, starts and checks the stack. It also writes `/opt/squorli/squorli` (linked as `squorli` into `/usr/local/bin`), which runs Docker Compose with the right profile and overlays: `squorli update`, `squorli status`, `squorli logs app`, `squorli backup` (database dump, attachments and `.env` into `/opt/squorli/backups`), `squorli restore <folder>` (puts such a backup back: stops the app, replaces database and files, starts again; `.env` stays; to move hosts, install on the new one first, then restore), `squorli doctor` (checks what goes wrong most often: domain and certificate, the WebSocket upgrade and `/rtc` through the proxy, LiveKit's key, the TCP media port, the directory; a directory repeats the checks from outside; the same check with a real media connection from the browser is in Verwaltung > Server), and any other Compose command.

Running the installer again on an existing installation updates it (new image and deploy files; changed files are kept as `.bak`) or changes its settings; the secrets, the database and the files stay. The published image exists for x86_64 only; on ARM build from source.

## Quick start with the published image

The public image is **`ghcr.io/danielklessa/squorli-server:latest`** (tags and digests: [container package](https://github.com/danielklessa/squorli-server/pkgs/container/squorli-server)). You still need a checkout of this repository for the Compose files and the mounted LiveKit and Caddy configuration; no local build is required.

```bash
git clone https://github.com/danielklessa/squorli-server.git
cd squorli-server
cp .env.example .env
```

Fill in `.env`. Required values:

| Variable | Value |
|---|---|
| `PUBLIC_DOMAIN` | `chat.example.org`, exactly the hostname users type in the browser |
| `POSTGRES_PASSWORD` | any secret |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | key name plus a secret with 32+ characters, e.g. `openssl rand -hex 32` |
| `PROXY_MODE` | `bundled` (Caddy in the stack handles TLS on 443) or `external` (your own reverse proxy, see below) |
| `APP_IMAGE` | `ghcr.io/danielklessa/squorli-server:latest`; pin a version tag or digest for production |

Then start the stack from `deploy/`. `--env-file ../.env` is required: otherwise Compose only substitutes the placeholders in `compose.yml` from a `.env` inside `deploy/`, and password and LiveKit keys would remain empty.

```bash
cd deploy
docker compose --env-file ../.env --profile bundled pull
docker compose --env-file ../.env --profile bundled up -d --no-build
```

With `PROXY_MODE=external` use `--profile external` and the matching proxy overlay in **both** commands (see [Reverse proxy](#reverse-proxy)).

Check: `https://PUBLIC_DOMAIN/api/health` shows `domain` and `serverKey`; `https://PUBLIC_DOMAIN/rtc/validate` returns 401.

## First start

Every sign-in needs an account: a Squorli account from the directory (`@name`) or a server account that exists on this server only (`~name`, name and password, usable on any device). A server without a directory is an isolated instance whose accounts are all server accounts; a server with a directory offers them next to Squorli accounts when the admin panel allows it (Administration > Server, or `LOCAL_ACCOUNTS`). The password of a server account encrypts the account's key on the user's device; the server stores only the result and can neither read nor reset it. Server accounts have no friends and no direct messages for now. The first user who signs in with an account, or registers the first server account, becomes the owner (or the key given in `OWNER_PUBLIC_KEY`, which can only be a Squorli account's key). After that the server is closed: further users need an invite link (`/invite/<code>`), which the owner creates in the admin panel (gear icon), or the server is set to "open" there.

New members are guests (view and voice only). Admins grant the member role via the member list, which unlocks writing, files, camera and screen share.

Guests hear a voice channel but do not see what others share there: without the permission "Watch camera and screen shares" a member receives no camera, screen share or screen audio. The member role has it; to let guests watch too, tick it on the guest role (admin panel, Roles). When updating an existing server, every role except the guest role receives the permission automatically. The restriction works once everybody in the channel runs a client that knows the permission (reload the page after updating the server).

Web radio: under Administration > Radio you keep a list of stations (name plus the address of an audio stream, or of a `.m3u`/`.pls` playlist, which the server reads when the radio is started; prefer `https://` addresses). A member whose role has the permission "Start and stop web radio in voice channels" (no role has it by default, administrators always do) picks a station with the radio button at the top of a voice channel, or types in any stream address there (so grant this permission only to people you trust: whoever runs the typed address's host sees the IP addresses of the listeners), and everybody in the channel hears it until someone turns it off. The sound does not pass through your server: every listener's browser fetches the stream from the station itself, so the station sees the listener's IP address, as with any radio player. Only to show what is playing right now ("Artist - Title" in place of the station's name), the server itself reads the stream of a station while somebody is listening to it and throws the audio away; that costs about the stream's bitrate per station, not per listener. A Twitch channel (`https://www.twitch.tv/name`) works as a source too: Twitch allows no audio-only playback on foreign pages, so it appears with Twitch's official player as a tile in the voice channel (and as a small window in the corner while the listener looks at something else). That needs your server to be reached over https, and Twitch then sets its own cookies and sees the listeners' IP addresses. A YouTube video or live stream (`https://www.youtube.com/watch?v=...`, `https://youtu.be/...`) works the same way, with YouTube's player in its privacy-enhanced mode (`youtube-nocookie.com`); when one is started, your server asks YouTube once for the video's title. Videos play in step for everyone in the channel: members with the radio permission play, pause and seek in their own player and everybody else's player follows, while a live stream is everyone's own to pause. A YouTube playlist (`https://www.youtube.com/playlist?list=...`, or a video's address with `&list=`) plays its videos one after the other for everyone: the browser of the member who starts it reads the list from YouTube's player (public or unlisted playlists, at most 200 videos) and hands it to your server, which keeps the queue, moves on when a video ends and lets members with the radio permission skip back and forth. Videos whose owner forbids embedding cannot be played. Both players can be moved into a window of their own (the button in their top right corner), which is also the way to keep a Twitch stream playing while the chat's tab is in the background: Twitch pauses embedded players in hidden tabs. When a voice channel has been empty for two minutes, its radio is turned off (switch under Administration > Radio). Each listener sets their own radio volume in the same menu or turns the radio off for themselves, which also ends their connection to the station (and removes the Twitch player for them).

## Configuration

All variables are documented in [.env.example](.env.example). The most relevant optional ones:

| Variable | Purpose |
|---|---|
| `SERVER_NAME` | Initial name of the server (changeable in the admin panel) |
| `OWNER_PUBLIC_KEY` | Public key (64 hex) of a Squorli account that becomes owner on its first login; empty = the first user who signs in with an account |
| `OWNER_SETUP_CODE` | The owner as a server account (`~name`): while there is no owner, whoever registers a server account with this code becomes the owner (the form shows a field for it), also where server accounts are off. The installer makes one. Set alone, nobody becomes owner without it; with `OWNER_PUBLIC_KEY` either works |
| `MAX_UPLOAD_MB` | Upper limit for attachments, default 25 |
| `LINK_PREVIEWS` | `true` (default): links in messages get a preview (title, description, picture; YouTube videos play in the chat). The server fetches the linked pages itself, from public hosts only, and serves the pictures from its data volume, so readers never contact the linked host. `false` turns previews and these outgoing requests off |
| `LOG_LEVEL` | Log level of the app server: `fatal`, `error`, `warn`, `info` (default), `debug` |
| `LOG_REQUESTS` | `false` (default): no line per request, so the log holds no visitor addresses; only requests that end in a server error are logged, without the address. `true` logs every request with the caller's IP, for troubleshooting only. What each container logs and how long: [docs/features/logging.md](docs/features/logging.md) |
| `LIVEKIT_NODE_IP` | Public IP of the host; empty = LiveKit detects it via STUN |
| `LIVEKIT_PUBLIC_URL` | Only if clients should not reach LiveKit via `https://PUBLIC_DOMAIN/rtc` |
| `DIRECTORY_URL` | `https://directory.squorli.com` or your own directory; empty = no directory |
| `DIRECTORY_PROOF_URL` | Only if the directory cannot reach `https://PUBLIC_DOMAIN/api/health` directly |
| `LOCAL_ACCOUNTS` | Server accounts (`~name`): `true`/`false` fixes whether they may be registered, empty = admin panel decides (default off). Always on without a directory. (`REQUIRE_ACCOUNT` is gone: an account is always required.) |
| `TRUSTED_PROXIES` | External mode: IPs/CIDRs whose `X-Forwarded-*` headers are trusted (default: private ranges) |
| `PROXY_BIND_IP` | External mode with the proxy on another host: address on which 3000 and 7880 listen |
| `LIVEKIT_TCP_PORT` / `LIVEKIT_UDP_PORT` | Media ports on the host (default 7881 / 7882), when another service already uses them; LiveKit announces them to the clients, so forward the same numbers |
| `APP_PORT` / `LIVEKIT_HTTP_PORT` | External mode with a port overlay: host ports the proxy forwards to (default 3000 / 7880) |

Voice quality (Opus bitrate, stereo) is configured per voice channel in the admin panel.

### Channel permissions

Channels and categories can carry permissions per role or member (private channels, read-only channels, who may enter a voice channel), and a voice channel can hold its members until a moderator moves them. Right-click a channel in the sidebar to edit it. The status API shows only what the default role sees. Details: `docs/features/channel-permissions.md`.

### Status API

`GET https://PUBLIC_DOMAIN/api/status` returns the server name, its icon address, all categories and channels in the order the client shows them, and the members who sit in a voice channel right now with that channel, whether they are away and whether their microphone is muted, their sound is off or their camera or screen share is on, as JSON, for a widget on your website, a bot or a stream overlay. Members outside every voice channel are not listed. It is off by default (404). In the admin panel under Server you choose whether it needs the server's key (`Authorization: Bearer <key>` or `?key=<key>`; the panel shows the key and can replace it) or is public. There you also choose whose view it answers with: the default role, i.e. what an ordinary visitor sees and what private channels leave out, or another role, which then shows what a member with that role sees (a role with Administrator shows everything). Avatars are the directory account pictures (public there anyway); public keys, roles, permissions and messages are never included.

## Reverse proxy

With `PROXY_MODE=external` an existing reverse proxy terminates TLS and forwards to the app server on port 3000 and LiveKit on port 7880:

- `https://PUBLIC_DOMAIN` -> `http://<host>:3000` with WebSocket support
- `https://PUBLIC_DOMAIN/rtc` -> `http://<host>:7880` (WebSocket)

Firewall: `7881/tcp` and `7882/udp` open to everyone, `3000` and `7880` only for the proxy host. Ready-made configurations and Compose overlays for nginx, Nginx Proxy Manager, Plesk and Traefik, plus verification steps, are in [deploy/proxies/README.md](deploy/proxies/README.md).

TURN for clients in networks that block UDP and direct TCP is prepared but off by default; it needs a certificate and port `5349/tcp`, see `deploy/livekit/livekit.yaml`.

## Portainer

`deploy/portainer.yml` is a self-contained stack for Portainer (web editor or git repository, path `deploy/portainer.yml`): external mode with a reverse proxy on another host, no `env_file`, no build, no bind mounts. The LiveKit config is inlined via `LIVEKIT_CONFIG` (keep it in step with `deploy/livekit/livekit.yaml`).

1. Stacks > Add stack > paste `deploy/portainer.yml`.
2. Enter the environment variables: `PUBLIC_DOMAIN`, `POSTGRES_PASSWORD`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (required); `APP_IMAGE` optional (default `ghcr.io/danielklessa/squorli-server:latest`; pin a tag or digest for production); optionally `LIVEKIT_NODE_IP`, `DIRECTORY_URL`, `TRUSTED_PROXIES`, `PROXY_BIND_IP` (default `0.0.0.0`, then restrict via firewall), `LOCAL_ACCOUNTS`, `SERVER_NAME`, `OWNER_PUBLIC_KEY`, `MAX_UPLOAD_MB`, `LIVEKIT_PUBLIC_URL`, `DIRECTORY_PROOF_URL`, `APP_PORT`, `LIVEKIT_HTTP_PORT`, `LIVEKIT_TCP_PORT`, `LIVEKIT_UDP_PORT`. Meaning as in [Configuration](#configuration).
3. Set up the proxy and firewall as in [Reverse proxy](#reverse-proxy).
4. Check `https://PUBLIC_DOMAIN/api/health` and `https://PUBLIC_DOMAIN/rtc/validate` (401).

## Updates

1. Back up the database, attachments and configuration.
2. Review the release notes.
3. Repeat `pull` and `up -d --no-build` with the same profile and overlays (after the interactive installer: `squorli backup`, then `squorli update`).

`latest` is mutable; for reproducible deployments set `APP_IMAGE` to a version tag or `ghcr.io/danielklessa/squorli-server@sha256:<digest>` and keep the repository checkout aligned with that release. Startup runs database migrations; an image rollback does not reverse them.

## Building from source

Unset `APP_IMAGE` in `.env` and run from `deploy/`:

```bash
docker compose --env-file ../.env --profile bundled up -d --build   # or the external profile with overlays
```

## Troubleshooting

- `/` answers "Web-Client fehlt" (503) or `Route GET:/ not found`: the image is outdated or the server was started without the built web client.
- Login fails with `verify -> 401`: `PUBLIC_DOMAIN` does not match the hostname in the address bar. Signatures are bound to the domain; the error message in the client names both values.
- Microphone or camera not available: the page must be served over HTTPS (`localhost` is the only exception).
- Voice connects slowly or not at all: check that `7882/udp` and `7881/tcp` reach the host. The client's debug view (`?debug` in the URL) shows the active ICE path (`udp`, `tcp`, `relay`).
- First stop for all of the above: `squorli doctor` on the host, or Verwaltung > Server > "Verbindung prüfen" in the client (the browser's media test says whether UDP arrives, only TCP does, or nothing; `docs/features/doctor.md`).

## License

Squorli Server is licensed under the [Apache License, Version 2.0](LICENSE) (Copyright 2026 Daniel Klessa, see [NOTICE](NOTICE)). Contributions are accepted under the same license. The Squorli Directory is a separately operated service and is not part of this repository.

## Legal / Impressum

The legal notice (Impressum) and the privacy policy for this repository, its releases, the website and the Squorli Directory are published on the website: [Impressum](https://squorli.com/de/impressum/) / [Legal notice](https://squorli.com/en/impressum/) and [Datenschutzerklärung](https://squorli.com/de/datenschutz/) / [Privacy policy](https://squorli.com/en/datenschutz/). Their source is the Markdown under `legal/` in the website repository; this repository carries no copy.

If you run your own Squorli Server, you are the operator of that instance: publish your own legal notice and privacy policy for it. The privacy policy above describes what the software sends to the Directory and to squorli.com (update checks of the desktop app), which you can reuse for that.

## Production (standard: published Docker image, no Git clone)

Requirements: Docker Engine with the Compose plugin, curl and OpenSSL on a Linux host. You do not need Git, Node.js or a local application build. Point your domain to the host and open 80/tcp, 443/tcp, 7881/tcp and 7882/udp. Follow the complete guide in [English](https://squorli.com/en/docs/install/) or [German](https://squorli.com/de/docs/install/).

Create a new installation directory and download only the deployment configuration:

```bash
mkdir -p squorli/deploy/caddy squorli/deploy/livekit squorli/deploy/proxies
cd squorli
curl -fL https://raw.githubusercontent.com/danielklessa/squorli-server/main/.env.example -o .env
curl -fL https://raw.githubusercontent.com/danielklessa/squorli-server/main/deploy/compose.yml -o deploy/compose.yml
curl -fL https://raw.githubusercontent.com/danielklessa/squorli-server/main/deploy/caddy/Caddyfile -o deploy/caddy/Caddyfile
curl -fL https://raw.githubusercontent.com/danielklessa/squorli-server/main/deploy/livekit/livekit.yaml -o deploy/livekit/livekit.yaml
curl -fL https://raw.githubusercontent.com/danielklessa/squorli-server/main/deploy/proxies/nginx.ports.yml -o deploy/proxies/nginx.ports.yml
```

Run the download step only once in a fresh directory; repeating it overwrites configuration. Edit .env, replace the hostname and secrets, set PROXY_MODE=bundled and APP_IMAGE=ghcr.io/danielklessa/squorli-server:latest. Generate separate secrets with `openssl rand -hex 32`. Reserve the first login with OWNER_PUBLIC_KEY (a Squorli account's key) or sign in first yourself (without a directory: create the first server account) right after the start. The nginx overlay is only needed for an external proxy.

```bash
cd deploy
docker compose --env-file ../.env --profile bundled pull
docker compose --env-file ../.env --profile bundled up -d --no-build
```

Always pass `--env-file ../.env`. The downloaded Compose file also describes a source build; `--no-build` explicitly uses the published image and needs no Dockerfile or source checkout. Caddy, PostgreSQL and LiveKit are started alongside the app.


