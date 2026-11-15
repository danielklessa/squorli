# Plan: a bot API that is compatible with Discord's

Part of the project description (entry point: root `AGENTS.md`, section 0; open work `docs/PLAN.md` section 4). Written on 15 November 2026 after the user's request "als nächstes lass uns eine Bot API planen, sie soll 100% kompatibel zu der Bot API von Discord sein. So, dass ein Bot der für Discord entwickelt wurde auch mit Squorli funktioniert und umgekehrt."

**State: planned and kept for later (the user, 15 November 2026: "speichere den Plan im Repository, so dass wir später darauf zurück kommen können"). Nothing is built, nothing is approved for building.** The four decisions in section 7.1 are the user's. Everything in section 7.2 is a proposal by Claude that nobody has confirmed. The facts about Discord and its libraries in section 8 were checked on 15 November 2026 and have to be checked again before the build starts: both move.

Until the first stage is released, the public texts stay as they are: the website's plugin guide says "Squorli offers no bot interface" and `README.md` says a plugin "is not a bot".

---

## 1. What exists

There is no bot interface. Until 15 November 2026 `docs/PLAN.md` 1.3 listed a bot API as not planned. The plugin interface of the same day (`docs/features/plugins.md`) is something else and stays: a plugin is one file the server runs in a sandbox, without a token, a network endpoint or a process of its own. A bot is a foreign process that signs in over the network with a token. The bot API comes next to the plugins, not in their place.

What the server has today and what that means for Discord's model:

| Area | Squorli today | Discord's bot API |
|---|---|---|
| Ids | UUIDv4 everywhere (`apps/server/src/db/schema.ts`); messages also have a global `seq` (bigserial) | 64-bit snowflakes as decimal strings; libraries read the time out of them and sort by them |
| REST | flat `/api/...` without a version, bearer session tokens (`auth/session.ts`), errors `{ error: "snake_code" }`, own limiter (`rateLimits.ts`, 429 `{ error, retryAfter }`) | `/api/v10/...`, `Authorization: Bot <token>`, errors `{ code, message, errors }`, `X-RateLimit-*` headers, 429 `{ message, retry_after, global }` |
| Realtime | `GET /api/ws`: flat JSON events with `type`, whole states (`structure`, `voice.state`), no sequence numbers, no resume (`packages/protocol/AGENTS.md`) | Gateway with opcodes, intents, sequence numbers, resume, deltas |
| Guild | one process is one community (`server_settings` has one row) | a bot sees a list of guilds; here always exactly one |
| Channels | `text` and `voice`; categories are a table of their own | categories are channels of type 4; plus threads, forums, stages |
| Permissions | 21 bits in a 32-bit integer (`packages/protocol/src/permissions.ts`); overwrites per channel and category, resolved in Discord's order, the category's inherited live (`channelPermissions.ts`) | about 50 bits as a decimal string; a channel carries its own copy of the category's overwrites |
| Messages | 1 to 4000 characters, own Markdown subset (`apps/web/src/markdown.ts`), mentions only as `<@uuid>` (`packages/protocol/src/mentions.ts`), attachments uploaded first and named by id, link previews made by the server | 2000 characters, embeds, components, replies, `<@id>`, `<@&id>`, `<#id>`, `<t:...>`, multipart upload with the message |
| Missing | replies, pins, embeds, custom emoji, stickers, timeouts, a nickname per server, webhooks, threads | all present |
| Slash commands | the plugins' (`POST /api/channels/:id/commands`, input `none`, `text` or `form`, answered to the caller only) | application commands with typed options, autocomplete, components, modals |
| Events inside the process | `serverEvents` (`apps/server/src/events.ts`): `member.join`, `member.leave`, `member.roles`, `role.delete`, `message.create`, `message.update`, `message.delete`, each with an `Origin` | |
| Non-human authors | a plugin's `users` row with the key `plugin:<id>`: no member, never told to the directory, cannot be banned (`plugins/service.ts`, `isPluginUserKey`) | a bot is a member with roles |
| Voice | LiveKit rooms named by the channel's UUID, tokens from `POST /api/rtc-token`, who sits where in memory (`voice/presence.ts`) | Discord's own voice gateway, UDP, RTP, its own encryption |
| Direct messages | end-to-end encrypted, between friends only, through the directory; chat servers are not involved (`../squorli-directory/docs/features/friends-dm.md`) | a bot opens a DM channel and writes |

Reusable as it is: the map from Discord's permission bits to Squorli's (`PERMISSION_MAP`, `mapDiscordPermissions` in `apps/server/src/import/discord.ts`), `visibility.canSee`, `channelActor`/`canIn` (`channelGuard.ts`), `authz.ts` (`outranks`, `canGrant`, `canChangeGrant`), `memberRoles.ts` (the one path that changes a member's roles), `recordModLog`, `broadcastStructure()` in `state.ts`, `tokenHash` in `auth/session.ts`, the guarded fetch of `@squorli/link-preview`, the plugins' form dialogs in the web client.

## 2. What "compatible" means

Literally 100 % is not reachable in one step: Squorli lacks features Discord has, and the libraries have `discord.com` built in. The goal is put as three rules.

1. **A subset, nothing of our own.** Paths, fields, opcodes, error codes and rate-limit headers have Discord's form. Nothing Squorli-specific is added to the compatible interface, or a bot developed against Squorli would not run on Discord (the "und umgekehrt" of the request).
2. **Honest gaps.** A route for something Squorli does not have answers with an error Discord itself could give (50013 Missing Permissions, 50001 Missing Access, 10003 Unknown Channel and the like) or with an empty list. Never 501, never an invented code: bots already handle Discord's errors. The permission bits of such features are never reported as granted, so a bot that checks first steps aside by itself.
3. **Measured, not claimed.** Compatible is what the conformance suite passes with real libraries (section 5). The public guide carries a table "supported / answered with an error".

**What has to change in a bot** (checked at the libraries' sources on 15 November 2026). The bot's own code stays the same; the address is a setting of the library:

| Library | Setting | Note |
|---|---|---|
| discord.js | `rest: { api, cdn }` | takes the gateway's address from the server |
| hikari | `rest_url` | takes the gateway's address from the server; reads the bot's id out of the token |
| discord.py | `Route.BASE`, `DiscordWebSocket.DEFAULT_GATEWAY`, `Asset.BASE` | three lines, no official option |
| JDA | `RestConfig#setBaseUrl` and a `SessionController` of one's own | |
| serenity | `HttpBuilder::proxy(url)` | asks `GET /gateway`, not `/gateway/bot` |
| twilight | `ClientBuilder::proxy`, `ConfigBuilder::proxy_url` | |
| discordgo | the package's `Endpoint*` variables | speaks version 9: `/api/v9` and `GET /gateway` must answer |
| Discord.Net | no public option for REST | only through a `RestClientProvider` of one's own, not tried |

So "only the address and the token" holds for discord.js and hikari; the others need two or three lines, Discord.Net a detour.

## 3. Design

### 3.1 Where the code lives

All of it in this repository, in a new folder `apps/server/src/botapi/`. The server's own protocol (`/api/...`, `/api/ws`, `PROTOCOL_VERSION` 4) stays as it is; the translation happens only at this boundary.

| File | Holds |
|---|---|
| `snowflake.ts` | UUID to snowflake and back |
| `permissions.ts` | Squorli's 21 bits to Discord's bits as a decimal string and back; takes over `PERMISSION_MAP` from `import/discord.ts` |
| `auth.ts` | `Authorization: Bot <token>`; only the token's SHA-256 is stored |
| `scope.ts` | a Fastify scope of its own for `/api/v10/*` and `/api/v9/*`: Discord's error body, a limiter of its own with Discord's headers and 429 body, a JSON parser that accepts an empty body, up to 10 files per request |
| `serialize/` | guild, channel, role, member, user, message, embed, interaction in Discord's form |
| `content.ts` | mentions (`<@uuid>` to `<@snowflake>`, `<#...>`, `<@&...>`), timestamps, emoji |
| `rest/` | the routes |
| `gateway/` | the second WebSocket: hello, identify, heartbeat, resume, intents, opcode 8, `zlib-stream` and `zstd-stream` |
| `view.ts` | a bot's view of the server and the comparison of two views (3.5) |
| `interactions.ts` | the command registry (global and per guild, kept apart), interaction tokens, answers, follow-ups |
| `cdn.ts` | avatars, the server's icon and the default avatars under Discord's CDN paths |

**Work this plan needs first:** sending, editing, deleting, reacting, kick, ban and channel changes live inside the routes today (`routes/messages.ts`, `routes/reactions.ts`, `routes/members.ts`, `routes/channels.ts`). They become services that take the actor, as `memberRoles.ts` already is for roles. Otherwise the bot routes would be the third copy of "insert, broadcast, emit" next to the routes and the plugins. `Origin` in `events.ts` gets the kind `bot`.

Types: `discord-api-types` (MIT) as a development dependency, so the compiler checks the form of every answer; Discord's OpenAPI description (`discord/discord-api-spec`, MIT) pinned to one commit as the measure for the suite. No text is copied from Discord's documentation (`discord/discord-api-docs`, CC BY-SA 4.0: the share-alike clause does not fit an Apache 2.0 repository).

### 3.2 Ids and the token

- Every table a bot can see gets a column `snowflake bigint unique` (users, channels, categories, roles, messages, attachments; later emojis and webhooks) with an SQL function as its default: the milliseconds since Discord's epoch (1420070400000) shifted by 22, the low bits from one shared sequence. A default covers every path that inserts (messages are inserted by `routes/messages.ts` and by `plugins/service.ts`) and is unique across tables.
- Backfill from `created_at`. `roles` and `categories` have none; they get the server's time of creation. Never backfill small numbers: the libraries' patterns for mentions expect 17 to 20 digits.
- The server gets a guild id. The default role "Gast" carries the same id: on Discord `@everyone` is the guild's id and the libraries rely on it.
- UUIDs stay the internal keys. A bot pages the history by snowflake (`before`, `after`, `around`), not by `seq`. In the code snowflakes are `bigint` or strings from end to end (`seq` runs as a `number`, that would lose digits).
- The token has Discord's form, `base64(bot id).<6 characters>.<38 characters>`: hikari and Discord.Net read the id out of it. The application's id is the bot user's id.

### 3.3 The bot is a member

A bot is a `users` row with the key `bot:<id>` and, unlike a plugin's row, **a member**: it has roles, stands in the member list with a "BOT" mark, is subject to the channels' visibility and can be removed or banned. Such rows are left out wherever a plugin's row is left out: the directory's reconciliation, `MEMBER_MAX`, the member count told to the directory, devices, suspensions, `hasAccount`. A plugin's messages reach a bot with `author.bot: true`, so the usual check keeps a bot and a plugin from answering each other forever.

Verwaltung > Bots (owners only): create a bot, its name and picture, its roles, its intents, show the token once and replace it, remove the bot. One bot belongs to one server; a bot that serves three servers holds three connections with three tokens.

### 3.4 Permissions

- On the wire Discord's bits. A Discord bit without a counterpart here is reported as granted where the behaviour is in fact allowed (reading the history with seeing the channel, embedding links with writing, using commands always), in every mask, the overwrites' `allow` and `deny` included: the libraries compute permissions themselves and must come to the server's result.
- A bot that writes a role must not clear Squorli's own bits (`CONTROL_RADIO`, `BYPASS_STICKY`, `MANAGE_REPORTS` and the like): what is written is `(old & squorliOnly) | map(new)`.
- Several of Discord's bits fall onto one of Squorli's (mute and deafen are both `MODERATE_VOICE`). So that a read returns what was written, the Discord mask a bot wrote is kept next to the Squorli mask and returned as written for as long as the Squorli mask is unchanged; after a change by a person it is computed afresh.
- **Categories, the largest difference in this plan:** Squorli inherits a category's overwrites live, Discord copies them into the channel. Bots compute with the channel's list alone, so the server serves the merged list. When a bot writes a channel's overwrites, the channel stops following its category (a new mark per channel, Discord's "not synced"). That touches `channelPermissions.ts` and its mirror in the client (`channelPerms.ts`).

### 3.5 Gateway

A path under `/api/`, named by `GET /api/v10/gateway/bot` and `GET /gateway` (the proxies' rules already pass it through; it answers with and without a trailing slash and with `v=9`). One shard; an identify with `shard: [id, n]` is answered by Discord's formula, not refused.

- **Events about the state** (channels, roles, members, the server itself) come from comparing each connected bot's view at `broadcastStructure()`. Every change has to pass that function anyway, so no route can forget to tell, and a channel that turns invisible is a `CHANNEL_DELETE` for the bot (the rule "404, never 403" holds).
- **Everything else** (messages, reactions, typing, bans, voice states, a preview that arrives) comes from `serverEvents`, which gets the missing events next to the routes' broadcasts.
- Filtered per bot by its intents and by what it may see. The privileged intents are real switches per bot (close code 4014 without them; without the message content intent the text arrives empty, as on Discord).
- Resume from a bounded buffer per session, in memory. Past its bound: "Invalid Session" and a fresh identify.
- Discord's limits hold here too (4096 bytes per incoming frame, 120 frames a minute), so a bot that works here works there.
- Both transport compressions are required (section 8). ETF is refused with close code 4012.

### 3.6 Content

- Mentions are translated in both directions; role and channel mentions, Discord's timestamps and spoilers are new in the client's Markdown.
- What a bot **sends** is held to Discord's limits (2000 characters, 10 embeds, 6000 characters of embeds, 5 rows of components, 10 files), also where Squorli would allow more. A member's message reaches the bot at its full length (up to 4000).
- `allowed_mentions` needs a stored list per message: mentions are counted from the text today.
- Pictures in embeds are fetched by the server through the guarded fetch and served by it, with the link previews' quotas, so no member's client asks a foreign host.

### 3.7 Interactions and the client

A bot's commands go into the same registry in the client as the plugins' commands. New in the web client and with it in the desktop and the mobile app: typed command options with autocomplete, embeds, buttons and select menus under a message, dialogs (modals), answers only the caller sees, "the bot is thinking", replies to messages, the "BOT" mark, Verwaltung > Bots. New fields on `Message` are optional, `ServerState.bots` is the feature flag: **no `PROTOCOL_VERSION` bump**. An app from before shows a message that consists of an embed alone as empty, so the server's and the app's versions are released together.

### 3.8 What is answered with an error

Threads and forums (the user, 7.1), direct messages (7.2, P3), and until their stage is built: pins, custom emoji, stickers, timeouts, nicknames, the audit log, webhooks, joining a voice channel. Out of the plan altogether: section 7.2, P6.

## 4. Stages

Effort in weeks for one developer working with a coding agent, rough.

| Stage | What | Weeks |
|---|---|---|
| 0 | The conformance suite first (`pnpm smoke:bots`); snowflakes; the bot account, the token, Verwaltung > Bots; the compatible scope (errors, limiter, parsers); the services taken out of the routes | 2.5 |
| 1a | The gateway with both compressions, `READY` and `GUILD_CREATE`, opcode 8, the comparison of views, permissions and content translated | 3 |
| 1b | REST: messages with files, embeds with the picture fetch, replies, reactions, roles, members, bans, channels, overwrites | 3 |
| 1c | Commands and interactions, components, dialogs, the client's part | 3.5 |
| | **First release** (server and apps together), the guide on the website in both languages, the sentences named at the top of this file changed | |
| 2 | Incoming webhooks per channel | 1 |
| 3 | Pins, custom emoji, stickers | 3 |
| 4 | Timeouts, a nickname per server, the audit log from `mod_log` | 2.5 |
| 5 | The voice bridge: voice gateway version 8, UDP, the sound into the LiveKit room (sending first, receiving second) | 5 to 8 |

About twelve weeks to the first release, about half of them in the client.

## 5. How it is checked

- `pnpm typecheck`, `pnpm test`: snowflakes, permissions in both directions, the content translation, the intent filter, the comparison of views, the resume buffer.
- `pnpm smoke:bots` against a scratch server on :3001 with a database of its own (the recipe of `smoke:plugins`): test bots written with discord.js, discord.py and one strictly typed library (JDA or twilight) sign in, send, edit, react, give roles, register a command, answer an interaction, disconnect and resume. Every answer is held against the pinned OpenAPI description.
- **The proof of "und umgekehrt":** the same test bots run unchanged against Discord, with a test token from the user. Without a token that part is skipped and the report says so.
- `pnpm smoke` stays green: the server's own protocol does not change.
- The client's part: a look in headless Chrome, the start check of the built desktop bundle before a tag.
- The suite runs regularly against the libraries' newest releases, not only on a change here.

## 6. Risks

| Risk | Handling |
|---|---|
| The libraries are strict: one missing field crashes a typed library at sign-in, and there are very many fields | Stage 0 is the suite, before the first route |
| Quiet differences: permissions that do not round-trip, the categories' inheritance, mentions. They corrupt state without an error | The pure functions are tested in both directions; the design of 3.4 |
| Security: a bot's token lasts long and is bound to no device; it reads whatever the bot's roles see. The picture fetch for embeds, the memory of the resume buffers, floods of opcode 8 | Only the hash stored, replaceable in Verwaltung > Bots, `BOTS=off`, the limits of 3.5, the guarded fetch with quotas |
| Privacy: whoever creates a bot hands channel contents to a foreign process | Said in the guide and in Verwaltung > Bots; the user's privacy documents need a paragraph |
| The voice bridge: Discord itself supports only end-to-end encrypted calls (DAVE) since 1 March 2026. The server chooses the version; discord.js and discord.py send transport-encrypted sound at version 0, so a bridge is possible today | If the libraries drop that path, the bridge has to speak DAVE itself (libdave, MIT). It also needs one more open UDP port at the operator |
| A moving target and the scope: Discord and the libraries change all the time; "scope creep towards Discord's feature list" is a named risk of `docs/PLAN.md` 1.4 | The suite against the newest releases; section 3.8 and P6 say what stays out |
| Law | Not assessed. Rebuilding an interface from its public description and the descriptive sentence "compatible with Discord's bot API" are common practice; the user gets an assessment before the release |

## 7. Decisions

### 7.1 Made by the user on 15 November 2026

1. The first released stage is "text bots complete": REST version 10, the gateway, slash commands, buttons, select menus, dialogs, embeds. What Squorli does not have is answered with the error Discord would give.
2. Stages of their own for the missing features: the messages' surroundings (replies, pins, custom emoji, stickers), moderation (timeouts, a nickname per server, the audit log), webhooks. **Threads and forums stay out.**
3. Voice bots: a bridge from Discord's voice protocol into the LiveKit room, as a late stage after every text stage. Until then a bot sees who sits in which voice channel and may move members, but cannot join.
4. A bot is created per server (Verwaltung > Bots, a token of its own). No central register, the directory takes no part.

### 7.2 To decide (proposals by Claude, not confirmed)

- **P1** Replies move into the first release. `message.reply()` is in nearly every bot; without replies the first version would look broken. Pins, emoji and stickers stay a later stage. (This changes the order of decision 2.)
- **P2** Webhooks come right after the first release, before emoji and moderation: the answers to interactions run through webhook addresses anyway, the rest is about a week.
- **P3** Direct messages: `POST /users/@me/channels` succeeds, sending answers 403 with code 50007, as for a Discord user who closed their direct messages. Later, if wanted: conversations with a bot kept by the server, not encrypted, as on Discord.
- **P4** Nothing of Squorli's own in the compatible interface: the web radio, sticky channels, the vote kick and notices are invisible to bots (rule 1 of section 2).
- **P5** Discord's limits for what a bot sends (3.6).
- **P6** Out of the plan: polls, scheduled events, AutoMod, stage channels, the soundboard, monetisation, OAuth2 for other websites, interactions over an HTTP endpoint, apps installed by a user, the gateway's ETF encoding. "Components V2": decide after the first release.
- **P7** `BOTS=owner|off` like `PLUGINS`, default `owner`; the privileged intents as switches per bot.
- **P8** Pictures in embeds through the server's guarded fetch (3.6).

## 8. Checked and not checked

Checked on 15 November 2026 against Discord's documentation (`docs.discord.com/developers`) and the default branches of the libraries. Check again before building.

**Gateway transport.** Every library sends `v` and `encoding=json` (discordgo `v=9`). `zlib-stream` is asked for by default by JDA, Discord.Net and discord.py; `zstd-stream` by discord.py (with `zstandard` installed or from Python 3.14), hikari (from Python 3.14) and twilight. Both are therefore required; Node 26 has both in `node:zlib`, one context per connection. No library asks for ETF by default. `compress: true` in the identify may be ignored.

**What libraries call at the start without being asked.** `GET /users/@me`; `GET /oauth2/applications/@me` and `GET /applications/@me` (discord.py reads `id`, `name`, `description`, `icon`, `bot_public`, `bot_require_code_grant`, `owner`, `verify_key` from it without defaults); `GET /gateway/bot` with `session_start_limit { total, remaining, reset_after, max_concurrency }` (discord.js does not connect when `remaining` is below the number of shards); `GET /gateway` (serenity, discordgo). Cheap stubs: `GET /sticker-packs`, `GET /voice/regions`, `GET /applications/{id}/emojis` with `{ items: [] }`, `GET /guilds/{id}/emojis` and `/stickers` with `[]`, the CDN's `/embed/avatars/{0-5}.png`.

**`READY` and `GUILD_CREATE`.** `READY` carries `v`, `user`, `guilds` (as unavailable), `session_id`, `resume_gateway_url`, `application { id, flags }` (discord.py reads `flags` without a default). `GUILD_CREATE` carries every documented field with a neutral value (`threads`, `stage_instances`, `guild_scheduled_events`, `emojis`, `stickers`, `soundboard_sounds` as `[]`) and `member_count`. Permissions are decimal strings, ids are strings, a snowflake's time is `(id >> 22) + 1420070400000`.

**REST.** The 429 body needs `retry_after`: discord.py reads it without a default, and the server's own form `{ error, retryAfter }` would crash the bot. Headers `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-After`, `-Bucket`, `-Scope`, `-Global` and `Retry-After`. Files as `payload_json` plus `files[n]`. `X-Audit-Log-Reason` arrives URL-encoded. Webhook addresses carry no version (`/api/webhooks/...`): keep that path free.

**Interactions.** `POST /interactions/{id}/{token}/callback`; `POST /webhooks/{app}/{token}`; `GET|PATCH|DELETE /webhooks/{app}/{token}/messages/{id}` and `.../@original`. The first answer within 3 seconds, the token lasts 15 minutes. discord.py always sends `?with_response=1` and builds its result from `interaction` in the answer: **200 with the answer object, never a bare 204**. The command routes exist globally and per guild, six each (list, create, get, edit, delete, `PUT` for all); both sets must answer and stay apart, because `tree.sync()` and `application.commands.set()` use the global ones and most deploy scripts the guild's. Autocomplete: interaction type 4, answer type 8.

**The least a command and moderation bot needs.** From the bot: opcodes 1, 2, 3, 4 (accepted, without effect until the bridge), 6, 8. To the bot: opcodes 10, 11, 1, 7, 9 and `READY`, `RESUMED`, `GUILD_CREATE/UPDATE/DELETE`, `GUILD_ROLE_*`, `CHANNEL_*`, `GUILD_MEMBER_ADD/UPDATE/REMOVE`, `GUILD_MEMBERS_CHUNK` (with `nonce`, `chunk_index`, `chunk_count`), `GUILD_BAN_ADD/REMOVE`, `MESSAGE_CREATE/UPDATE/DELETE/DELETE_BULK`, `MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL/REMOVE_EMOJI`, `TYPING_START`, `PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`, `INTERACTION_CREATE`. REST: the guild with its channels and roles; members (one, the list, the search); users; messages (send as JSON and multipart, the history, get, edit, delete, bulk delete, typing); reactions (own, another member's, all of one emoji, all); a member's roles, kick, ban and the ban list; roles and channels (create, edit, delete, positions); a channel's overwrites; the twelve command routes; the interaction routes above; `POST /users/@me/channels`.

**Voice.** Voice gateway version 8; `aead_xchacha20_poly1305_rtpsize` required, `aead_aes256_gcm_rtpsize` preferred. DAVE as in section 6.

**Traps in this repository.** `rateLimits.ts` answers every `/api/*` in the server's own form, reads `Bearer` tokens only, and its rules are keyed on route patterns that do not match `/api/v10/...`; `@fastify/multipart` is registered with `files: 1` (`index.ts`); Fastify refuses an empty body sent with `Content-Type: application/json`; the CDN's base address can be set only in discord.js and discord.py, so addresses under `cdn.discordapp.com` that name a local id have to be rewritten when a bot sends them.

**Sources.** Discord's documentation: events/gateway, events/gateway-events, reference, topics/permissions, topics/rate-limits, topics/voice-connections, topics/opcodes-and-status-codes, interactions/receiving-and-responding, interactions/application-commands. The libraries: discordjs/discord.js (`packages/rest`, `packages/ws`, `packages/voice`, `Client.js`, `InteractionResponses.js`), Rapptz/discord.py (`http.py`, `gateway.py`, `shard.py`, `state.py`, `voice_state.py`, `webhook/async_.py`, `interactions.py`), discord-jda/JDA (`RestConfig`, `SessionController`), serenity-rs/serenity (`http/client.rs`, `utils/token.rs`), bwmarrin/discordgo (`endpoints.go`, `restapi.go`), discord-net/Discord.Net (`DiscordConfig.cs`, `TokenUtils.cs`, `DiscordSocketApiClient.cs`), hikari-py/hikari (`impl/gateway_bot.py`, `impl/shard.py`, `applications.py`), twilight-rs/twilight (`twilight-gateway`). Licenses: discordjs/discord-api-types (MIT), discord/discord-api-spec (MIT), discord/discord-api-docs (CC BY-SA 4.0).

**Not checked:** Discord.Net without a fork; whether discord.js asks for compression when `zlib-sync` is installed; what JDA, serenity (songbird) and Discord.Net do at DAVE version 0; the form of Discord's error body (from memory); the law (section 6). Nothing of this plan was tried in code.
