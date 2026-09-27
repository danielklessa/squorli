# Proxy tests

The reference configurations for an existing reverse proxy (`deploy/proxies/`) tested against the real stack. Code: `deploy/proxies/test/run.sh` (the test), `deploy/proxies/test/*.yml` (overlays), `deploy/proxies/Caddyfile.external` (new), job `proxies` in `.github/workflows/ci.yml`.

## Built (27 September 2026)

The user asked for it as the first item of `docs/PLAN.md` 2.1 ("Lass uns erst Punkt 2 und 1 machen"): nginx, Traefik and Nginx Proxy Manager existed but had never run against an installation, a configuration for an external Caddy was missing, and a CI job for nginx and Traefik at least was planned.

### What the test does

`deploy/proxies/test/run.sh [nginx|traefik|caddy]...` (default all three):

1. Builds the Dockerfile's target `app` as `squorli/app:proxytest`, or tests `APP_IMAGE`.
2. Lays out an installation directory like `/opt/squorli` in a temp folder: the production `compose.yml`, `livekit.yaml`, the proxy files, a `.env` from `.env.example` with `PUBLIC_DOMAIN=chat.test`, `PROXY_MODE=external`, the media ports on 17881/17882 (so a running development LiveKit is not in the way) and no directory.
3. Makes a test CA and a certificate for `chat.test`.
4. Adapts each proxy's configuration only the way its header comment tells an operator to (domain, certificate, `127.0.0.1:3000` → `app:3000` for a proxy in a container); Traefik uses `traefik.labels.yml` unchanged apart from the host rule and the certificate (a default certificate instead of the Let's Encrypt resolver).
5. Starts stack and proxy (the proxy carries the network alias `chat.test`, so the app's own requests to its public address go through it) and a curl container as the browser, then checks through the proxy:
   - `https://chat.test/api/health` answers with `proxyMode: external`;
   - `http://` redirects to `https://` (nginx, Caddy; Traefik's redirect is the operator's entrypoint, not ours);
   - `/rtc/validate` answers 401 (LiveKit reached);
   - the WebSocket upgrade on `/api/ws` answers 101 (HTTP/1.1, as browsers do it);
   - the app sees the client container's address, not the proxy's (request log with `LOG_REQUESTS=true`; `X-Forwarded-For` from a trusted proxy);
   - an upload of `MAX_UPLOAD_MB` (25 MB) plus the multipart overhead reaches the app (401 without a session) instead of the proxy's 413;
   - the server's own setup check (`/api/doctor`, what `squorli doctor` shows) reports `self`, `websocket`, `rtc` and `livekit` as ok; the app trusts the test CA through `NODE_EXTRA_CA_CERTS`.
6. Tears everything down (`KEEP=1` leaves the stack running for debugging and prints the work directory).

### Found and fixed

- `nginx.conf` had `client_max_body_size 25m`: a 25 MB attachment (the default `MAX_UPLOAD_MB`) plus the form data around it is larger, so nginx answered 413. Now `30m`, like the Plesk directives already had.
- The Portainer stack still pulled the app image from the old GitLab registry by default (the user noticed it the same day); it now defaults to `ghcr.io/danielklessa/squorli-server:latest`.

### Caddy as an existing proxy

`deploy/proxies/Caddyfile.external`: a site block for a Caddy that already serves other sites (`reverse_proxy /rtc* 127.0.0.1:7880`, `reverse_proxy 127.0.0.1:3000`), with `nginx.ports.yml`; in a container the targets become `app`/`livekit`. Caddy brings certificate, redirect, WebSocket and `X-Forwarded-For` by itself. The installer downloads it with the other proxy files.

### Decisions made by Claude, confirmed by the user on 27 September 2026

- The proxies run in containers on the stack's network (the documented "proxy in a container" variant), not on the host with `nginx.ports.yml`: that works the same on Linux CI and Docker Desktop; the host variant differs only in the target address.
- Nginx Proxy Manager and Plesk stay out of the automated test (NPM is configured through its web interface and database, Plesk is a commercial panel); they stay documented as before.
- The CI job runs on GitHub only; the GitLab runner's docker-in-docker has no socket for Traefik's docker provider.
- Images: `nginx:1.29-alpine`, `traefik:v3.6` (Traefik before 3.6 cannot talk to Docker 29's API), `caddy:2-alpine`, `curlimages/curl:8.16.0`.

### Checked

- `run.sh nginx traefik caddy` on Windows 11 with Docker Desktop (Docker 29.7): all checks ok for all three after the nginx fix; before it, nginx failed only the upload (413).

### Not checked

- The CI job on GitHub (runs with the next push).
- Nginx Proxy Manager, Plesk, nginx on the host with `nginx.ports.yml`, a proxy on another host, real certificates (Let's Encrypt, certbot); the "stranger in 15 minutes" test (`docs/PLAN.md` 2.1) covers those on a real VPS.
- Long-lived connections through the proxies (timeouts over an hour).
