# Plan: operator limits

Written on 30 September 2026. Generic settings for any operator who runs a server for other people and wants to bound what it uses. Every limit is off (unlimited) when its variable is unset, so nothing changes for existing installations.

## What to build

| Setting | Meaning | Where |
|---|---|---|
| `STORAGE_QUOTA_MB` | total bytes of all stored files: attachments, link preview pictures, report evidence, avatars, the server icon | `apps/server/src/config.ts`; checked before every upload in `apps/server/src/routes/attachments.ts` and the four other stores; 413 with a clear code when exceeded |
| `VOICE_SEATS_MAX` | how many people may be in voice channels at the same time, counted against LiveKit's participants, not only the presence list | `apps/server/src/livekit/routes.ts` |
| `MEMBER_MAX` | how many members the server admits | `admit()` in `apps/server/src/auth/routes.ts` |
| `DB_POOL_MAX` | the Postgres pool size (fixed `max: 10` today in `apps/server/src/db/index.ts`) | `config.ts`, `db/index.ts` |
| `GET /api/ready` | answers 200 only when the database answers; `/api/health` keeps answering `ok: true` even on a database error, which a scheduler cannot use | `apps/server/src/index.ts` |

Also: `.env.example`, `.env.development`, `deploy/compose.yml` and the Windows package's `.env` template list the variables; `apps/server/src/directory.ts` waits a random moment before the first registration, backs off on 429 (many servers starting at once behind one address) and **retries a failed registration by itself** (today `register()` runs once after listen and then only on the next lookup; behind a proxy that routes only to a ready instance the first attempt gets `proof_unreachable` and the server stays unregistered until somebody signs in, seen 30 September 2026); `apps/server/src/doctor.ts` checks media against the media node's address instead of `PUBLIC_DOMAIN` when they differ.

## Admin panel

`apps/web/src/AdminPanel.tsx` and the i18n files show the usage against each limit; a limit set by the environment is shown locked. The pattern exists: `localAccountsLocked` in `state.ts`, 409 `locked_by_config` in `routes/settings.ts`. The protocol package gets optional fields only, no new `PROTOCOL_VERSION`.

## Checked by

`pnpm typecheck`, `pnpm test` (a test per limit and for `/api/ready` with the database down), a "Limits" section in the smoke test, `docker build`. Needs a server release and, because of the admin panel, a desktop app release. Documented afterwards in a new `docs/features/limits.md`; then this file goes.
