# Running behind an existing reverse proxy (PROXY_MODE=external)

Your proxy must:

1. forward `https://chat.example.org/rtc*` (incl. WebSocket) to LiveKit (`livekit:7880`)
2. forward everything else under `https://chat.example.org` (incl. WebSocket `/api/ws`) to the app server (`server:3000`)
3. set `X-Forwarded-For` and `X-Forwarded-Proto` and pass the WebSocket upgrade through

In addition, the following must be reachable **directly** (not via the proxy): `7882/udp` and `7881/tcp` on the host.

All four numbers are defaults. When another service on the host already uses one, set `APP_PORT` and `LIVEKIT_HTTP_PORT` (host ports the overlays publish for the proxy) or `LIVEKIT_TCP_PORT` and `LIVEKIT_UDP_PORT` (media, same number inside and outside) in `.env`; the interactive installer `deploy/install.sh` does that for you. Wherever this guide says 3000, 7880, 7881 or 7882, use your numbers.
Once TURN is active (see `../livekit/livekit.yaml`), also `5349/tcp`.

Only subdomains are supported, no sub-path like `example.org/chat`.

**Tested:** `test/run.sh` starts the production `compose.yml` in external mode behind a real nginx, Traefik and Caddy (containers, a test certificate for `chat.test`) and checks through each: `/api/health`, the redirect to HTTPS, `/rtc` reaching LiveKit, the WebSocket upgrade on `/api/ws`, that the app sees the client's address (not the proxy's), an upload of `MAX_UPLOAD_MB`, and the server's own setup check (`squorli doctor`). It runs in CI on every push. Not covered: Nginx Proxy Manager, Plesk, a proxy on another host, real certificates.

## How the proxy reaches the containers

In external mode `compose.yml` publishes **no** HTTP ports; `server` and `livekit` are only attached to the network `squorli_internal`. The app server's service was named `app` until 28 September 2026; a proxy in a container that still points to `app:3000` keeps working, because the container answers to both names.

| Proxy runs ... | Solution |
|---|---|
| on the host (nginx, Apache, Caddy as a package) | Start with the overlay `nginx.ports.yml`: publishes `127.0.0.1:3000` and `127.0.0.1:7880` |
| as a container on the same host (Traefik, Nginx Proxy Manager, Caddy) | Attach the proxy container to the network `squorli_internal` or `server`/`livekit` to the proxy network (`npm.network.yml`, `traefik.labels.yml`) and use the container names `server` and `livekit` as targets |
| on another host | Overlay `remote-proxy.ports.yml`: publishes 3000 and 7880 on `PROXY_BIND_IP` (required, this host's LAN/VPN address); the target in the proxy is the IP/hostname of the chat host. See section "Proxy on another host" |

## Proxy on another host

Applies to Nginx Proxy Manager, nginx, Traefik etc. on a second machine. What changes:

1. **Open the ports:** In `.env` set `PROXY_BIND_IP` to the LAN/VPN address of the chat host (the overlay refuses to start without it; until 5 October 2026 it fell back to all interfaces, which Docker opens past ufw/firewalld) and start with
   ```bash
   cd deploy && docker compose --env-file ../.env -f compose.yml -f proxies/remote-proxy.ports.yml --profile external up -d
   ```
   Then, via the firewall on the chat host, allow `3000/tcp` and `7880/tcp` **only** for the IP of the proxy host. Both ports speak unencrypted HTTP; there should be a private network or VPN between the hosts.
2. **Target in the proxy:** instead of `server`/`livekit`, the IP or the internal hostname of the chat host, ports 3000 and 7880.
3. **Media does not go through the proxy host.** Browsers connect directly to the **chat host** for audio: `7882/udp` and `7881/tcp` must be reachable there from the internet (public IP or port forwarding on the router). LiveKit must know this public address: the default is automatic detection (`use_external_ip`); with NAT or multiple addresses set `LIVEKIT_NODE_IP=<public IP of the chat host>` in `.env`. A chat host without its own public reachability does not work, no matter how the proxy is set up.
4. **`TRUSTED_PROXIES`:** The app server sees the proxy host as the sender, and the default `auto` covers only the stack's own Docker network: add the proxy host's IP in `.env`, `TRUSTED_PROXIES=auto,<IP of the proxy host>` (the installer does that in its "proxy on another host" setup). Without it every member shares the proxy's address in the rate limits and the log; `squorli doctor` says so. (Under Docker Desktop the sender appears as the Docker gateway `172.x`, which `auto` covers.)


## nginx

1. `.env`: `PROXY_MODE=external`. `TRUSTED_PROXIES` can stay at the default `auto` (the stack's own Docker network + loopback); the app server sees nginx as a sender from that network's gateway.
2. Start: `cd deploy && docker compose --env-file ../.env -f compose.yml -f proxies/nginx.ports.yml --profile external up -d`
3. Adopt `nginx.conf` as a server block (`/etc/nginx/sites-available/chat.conf` or similar), adjust `chat.example.org` and the certificate paths, `nginx -t && systemctl reload nginx`.
4. Firewall: open `443/tcp`, `80/tcp` (redirect), `7881/tcp`, `7882/udp`.

Check:

```bash
curl -s https://chat.example.org/api/health          # {"ok":true,"proxyMode":"external",...}
curl -s -o /dev/null -w "%{http_code}\n" https://chat.example.org/rtc/validate   # 401 = request reached LiveKit (expected without a token)
```

Then log in in the browser, join the lobby and check in the debug view (`?debug`) that packets arrive. If the WebSocket at `/api/ws` does not open, `proxy_set_header Upgrade`/`Connection` is usually missing; if `/rtc` connects but no audio comes through, `7882/udp`/`7881/tcp` are not open or LiveKit does not know its public IP (set `LIVEKIT_NODE_IP` in `.env`).

## Directory service

The directory service (handles, key backup, authenticator) is a separate, unpublished repo (`squorli-directory`) and runs on its own host with its own domain (e.g. `id.example.org`); in the proxy it is a normal host without a path prefix. The chat server only needs `DIRECTORY_URL=https://id.example.org` in `.env`. Nothing in this repo publishes or proxies the service.

## Nginx Proxy Manager (NPM)

NPM on the **same** host: NPM runs as a container and must reach `server` and `livekit` in the Docker network. For that, start with the overlay `npm.network.yml`
(adjust the network name). NPM on **another** host: follow the section above and in the table below enter the IP of the chat host as Forward Hostname instead of `server`/`livekit`.

```bash
cd deploy && docker compose --env-file ../.env -f compose.yml -f proxies/npm.network.yml --profile external up -d
```

Alternatively without overlay: `docker network connect squorli_internal <npm-container>`.

Create a **Proxy Host** in the NPM interface:

| Tab | Field | Value |
|---|---|---|
| Details | Domain Names | `chat.example.org` |
| Details | Scheme / Forward Hostname / Port | `http` / `server` / `3000` |
| Details | Websockets Support | **on** (required, otherwise no `/api/ws`) |
| Details | Cache Assets | off |
| Details | Block Common Exploits | optional |
| Custom Locations | location `/rtc` | Scheme `http`, Forward Hostname `livekit`, Port `7880` |
| Custom Locations | gear icon at `/rtc` (Advanced) | `proxy_read_timeout 3600s;` and `proxy_send_timeout 3600s;` |
| SSL | Certificate | Request Let's Encrypt |
| SSL | Force SSL, HTTP/2 Support | on |

Mind the order: `/rtc` is a Custom Location of the Proxy Host for `chat.example.org`, not a separate host.
In older NPM versions Custom Locations do not get the WebSocket upgrade automatically; if joining fails with a
WebSocket error to `/rtc`, add in the Advanced field of the location:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

(Add `proxy_http_version 1.1;` only if NPM does not already set it there, otherwise nginx reports a duplicate directive and the host goes offline.)

Firewall as with nginx: `443/tcp`, `80/tcp`, `7881/tcp`, `7882/udp` directly to the host; the media ports do not go through NPM.
`TRUSTED_PROXIES` in `.env` can stay at the default `auto` (NPM comes from a Docker network the server is attached to). Check as above with `/api/health` and `/rtc/validate`.

## Plesk (nginx of the Plesk host in front of the containers)

Works with the Portainer stack (`deploy/portainer.yml`) or the Docker extension on the same host. Do **not** use Plesk's
"Docker Proxy Rules": the generated locations carry no `Upgrade`/`Connection` headers, so `/api/ws` and `/rtc` (WebSockets) fail.

1. Stack: `PROXY_BIND_IP` at its default `127.0.0.1` (3000 and 7880 only reachable by the host's nginx), `TRUSTED_PROXIES` at its
   default `auto` (the container sees nginx as the Docker gateway, `172.x`), `LIVEKIT_NODE_IP` = public IP of the Plesk host.
2. Plesk > domain > Hosting & DNS > Apache & nginx Settings > "Additional nginx directives" (regex locations, so that they
   do not collide with Plesk's own `location /`; order matters, first match wins):

```nginx
location ~ ^/rtc {
  proxy_pass http://127.0.0.1:7880;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 3600s;
}
location ~ ^/api/ws {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 3600s;
}
location ~ ^/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 30m;   # >= MAX_UPLOAD_MB plus the form data around the file
}
```

3. Certificate: Let's Encrypt for the domain in Plesk (SSL/TLS Certificates), "Permanent SEO-safe 301 redirect from HTTP to HTTPS" on.
4. Plesk Firewall: allow inbound `7881/tcp` and `7882/udp` (media goes directly to LiveKit); 80/443 as usual. 3000/7880 stay closed.
5. Check: `https://<domain>/api/health` returns JSON with `domain` = the Plesk domain, `https://<domain>/rtc/validate` returns 401,
   and in the browser the debug view (`?debug`) shows the ICE path after joining a voice channel.

## Traefik

`traefik.labels.yml` as overlay: `docker compose --env-file ../.env -f compose.yml -f proxies/traefik.labels.yml --profile external up -d`. Adjust the network name and certresolver.

The overlay expects Traefik on a Docker network named `proxy` with the entrypoint `websecure` and a certificate resolver `letsencrypt`; rename them to yours, the network in `traefik.docker.network` too (app and LiveKit sit in two networks, and without that label Traefik may pick the internal one it cannot reach: 502/504 or requests that hang for 30 seconds). Traefik passes WebSockets and sets `X-Forwarded-For` by itself and has no body size limit by default. `TRUSTED_PROXIES` can stay at the default (Traefik comes from a Docker network).

## IIS (Windows Server)

For an installation made with the package for Windows on a server whose IIS holds 80 and 443: [iis/README.md](iis/README.md) with [iis/web.config](iis/web.config) (URL Rewrite and Application Request Routing, WebSocket for `/api/ws` and `/rtc`). Not tested against a real IIS yet.

## Caddy

For a Caddy you already run for other sites (without one, use `PROXY_MODE=bundled`: the stack brings its own Caddy). Start with `nginx.ports.yml` like nginx on the host, copy the site block of `Caddyfile.external` into your Caddyfile, replace `chat.example.org`, `caddy reload`. Caddy in a container: attach it to `squorli_internal` and use `server:3000` and `livekit:7880` as targets. Caddy gets the certificate, redirects HTTP to HTTPS, passes WebSockets and sets `X-Forwarded-For` by itself. Firewall and checks as with nginx.
