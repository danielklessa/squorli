# Logging

What the server's containers write to their logs, how long it stays, and what an operator can change. Code: `apps/server/src/logRedact.ts` (the serializers and the log controller), `apps/server/src/config.ts` (`LOG_LEVEL`, `LOG_REQUESTS`), `deploy/compose.yml` and `deploy/portainer.yml` (`x-logging`), `deploy/livekit/livekit.yaml` (`logging.level`).

## Built (27 September 2026): the logging concept

The user asked for it as the second item of `docs/PLAN.md` 2.1 ("Lass uns erst Punkt 2 und 1 machen"). Before this, Fastify wrote two lines per HTTP request with the caller's IP address at `info` (the production level), LiveKit wrote every participant who joined with the user id and all IP addresses of their device (ICE candidates, public, private and IPv6) at `info`, and Docker kept all of it unrotated for the life of the container.

### What each container logs now

| Container | Level | Holds | IP addresses |
|---|---|---|---|
| `server` | `info` (`LOG_LEVEL`) | start and configuration warnings, directory registration and sync, sign-ups of members and server accounts (user id, handle), moderation actions (who did what to whom: kick, ban, move, channel blocks, vote kicks, owner changes, reports opened and closed, the status API switched; ids, no message text), WebSocket connect/close per user id, periodic sweeps, requests that end in a server error (method, URL with secrets redacted, status, time) | only three security lines: a rate limit reached (`Rate-Limit erreicht`: rule, IP, path), a wrong password for a server account's key backup (handle, IP), a WebSocket closed for flooding (user id, IP) |
| `server` with `LOG_REQUESTS=true` | as above | additionally Fastify's request log: one line when a request comes in, one when it is answered, "not found" lines | every request with the caller's IP and port |
| `livekit` | `warn` | configuration problems, failures | none of the members' (its own public IP in a start warning) |
| `caddy` (bundled mode) | Caddy's default | certificate management, errors; **no access log** (the Caddyfile has no `log` directive) | an error line about a request can carry the caller's address |
| `postgres` | the image's default | start, checkpoints, errors; no connection log | none |

Query secrets never reach the log in either mode (`redactUrl`: `key`, `s`, `sig`, `token`); since this change that holds for the "Route … not found" line too, which Fastify wrote with the raw URL before.

### Retention

`compose.yml` and `portainer.yml` give every service `logging: *logging`: Docker's `json-file` driver with at most 3 files of 10 MB per container. The oldest lines go by size, not by date: on a quiet server 30 MB can hold weeks. An operator who wants a time limit switches the anchor to journald and sets the retention there (as the directory does, `../squorli-directory/deploy/README.md`, "Logs"):

```yaml
x-logging: &logging
  driver: journald
```

and in `/etc/systemd/journald.conf`: `MaxRetentionSec=14day`, then `systemctl restart systemd-journald`. `docker compose logs` and `squorli logs` keep working with journald.

### Troubleshooting

- A proxy or client problem that needs every request: `LOG_REQUESTS=true` in `.env`, `squorli restart server`, reproduce, set it back and restart again. The lines with addresses stay in the log until rotation pushes them out.
- A media connection problem: `level: info` in `deploy/livekit/livekit.yaml`, `squorli restart livekit`; the lines "participant active" and "ice reconnected or switched pair" show the chosen candidate pair. Set it back to `warn` afterwards. `squorli doctor` and Verwaltung > Server > "Verbindung prüfen" answer most of these questions without logs (`docs/features/doctor.md`).
- `LOG_LEVEL=debug` adds the LiveKit admin client's failures (`livekit/admin.ts`) and nothing personal beyond ids.

### Existing installations

`squorli update` pulls images only; it does not replace the files under `deploy/`. The app's quiet request log comes with the image. The rotation and LiveKit's `warn` come with the new `compose.yml` and `livekit.yaml`: run the installer again (it replaces the deploy files and keeps a `.bak` of changed ones, `.env` stays) or copy the `x-logging` block and the `logging:` lines by hand. Portainer stacks take the new `portainer.yml`. The server release notes must say so.

### Decisions made by Claude, confirmed by the user on 27 September 2026

- No request log by default, not a request log without addresses: nothing in the running server needs it, and the rate limits and `squorli doctor` cover what it was used for.
- The three security lines keep the IP (a legitimate interest in defending the server, and without it a rate limit hit cannot be traced to an attacker); they are rare.
- Requests ending in 5xx are still logged (as `warn`, "request failed"), without the address; a thrown error additionally produces Fastify's own error line with the stack.
- Rotation by size (3 × 10 MB, `json-file`) in the Compose files instead of journald: it works on every Docker host without touching the host's configuration; a per-service `logging` overrides a daemon-wide driver an operator may have set, so such an operator edits the anchor.
- LiveKit at `warn` in production; the development stack (`compose.dev.yml`) keeps `--dev` and its own level.

### Checked

- `logRedact.test.ts`: by default no "incoming request"/"request completed" line, no line for a 200 or a 404, the test address `203.0.113.7` nowhere in the log, "request failed" for a thrown error and for a 502, the status key redacted; with `LOG_REQUESTS` four "incoming request" lines with the address and still no key.
- `docker compose config` for `compose.yml` (bundled, external with `nginx.ports.yml`) and `portainer.yml`: every service carries the rotation.
- LiveKit v1.13.7 with the new `livekit.yaml` started (config via `LIVEKIT_CONFIG`): at `warn` only two warnings (the external IP check, the UDP buffer), at `info` the start lines as before. The dev LiveKit's own log showed the `info` lines with members' addresses that `warn` now drops ("participant active" with the candidates, "ice reconnected or switched pair", "starting RTC session").

### Not checked

- A real installation over days (rotation reached, `squorli logs` after a rotation), journald on a real host.
- The website's privacy guidance for operators does not mention the logs yet.

## PostgreSQL's notices (28 September 2026, user's wish: "PostgreSQL Hinweise bitte abstellen")

Every start on a database that exists made PostgreSQL say twice that something "already exists, skipping" (the migrator creates its schema and its table with `IF NOT EXISTS`). postgres-js prints a notice with `console.log`, as an object over several lines, so the app server's log, JSON line by line otherwise, held blocks of plain text (seen in the log of a Windows installation; a container's log had them too). `createDb(url, onNotice)` in `apps/server/src/db/index.ts` hands the notices to a handler and drops them without one; the server logs each as one line at debug level (`"msg":"PostgreSQL: ..."` with `code` and `severity`), so the default level `info` shows none. Tested (`db/index.test.ts`).
