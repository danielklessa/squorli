import { ClientEvent, PROTOCOL_VERSION, Permission, WS_CLOSE_ACCOUNT_SUSPENDED, WS_CLOSE_SESSION_ENDED, displayNameOf, suspendedCloseReason, type GamePresence, type ServerEvent } from "@squorli/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { CLOSE_REGISTRATION_REQUIRED, hasAccount, lookUpSession, resolveSession, suspensionOf } from "../auth/session";
import { can } from "../authz";
import type { Db } from "../db";
import { channels, users } from "../db/schema";
import type { Hub } from "../hub";
import { actorOf, loadChannels, loadSettings, loadState, permissionListeners } from "../state";
import type { VoicePresence } from "../voice/presence";
import type { RadioMetadata } from "../radio/metadata";
import type { LivekitAdmin } from "../livekit/admin";
import { Liveness, PING_EVERY_MS } from "./liveness";
import { canIn, resolveChannel } from "../channelGuard";
import { visibility } from "../visibility";
import { moveGrants } from "../voice/confine";
import { holdOnJoin, refreshUserView, releaseOnLeave, stickyVerdict } from "../voice/sticky";
import { voiceStateEvent } from "../voice/voiceState";
import { voteKicks, voteOnWire } from "../voice/votekick";
import { channelBlockStore } from "../voice/channelBlocks";
import type { WindowCounter } from "../rateLimits";

/** Game display: how often one connection may change what its member plays (each change is a broadcast to everybody). */
const GAME_CHANGE_MS = 5000;

/**
 * Real-time channel for everything except media: state after the handshake, presence, channel state, messages, typing.
 * State reconciliation by sequence number after a reconnect: the client reloads /api/state and the history (M2).
 */
/** Close code for a connection that sends more events than `LIMITS.wsEvents` allows (docs/features/rate-limits.md). */
export const CLOSE_RATE_LIMITED = 4008;

export async function registerWs(app: FastifyInstance, db: Db, hub: Hub, presence: VoicePresence<WebSocket>, radioMeta: RadioMetadata, lk: LivekitAdmin, wsLimit: (() => WindowCounter) | null = null) {
  // Who sits in a voice channel goes only to those who may see the channel (docs/features/channel-permissions.md).
  const unsubscribe = presence.onChange((channelId, members) => {
    hub.broadcastToChannel(channelId, voiceStateEvent(channelId, members));
  });
  app.addHook("onClose", async () => unsubscribe());
  // Permissions changed: every occupied voice channel again, with the members' `viewVideo` as it resolves now.
  const resend = () => { for (const channelId of new Set(presence.seated().map((s) => s.channelId))) hub.broadcastToChannel(channelId, voiceStateEvent(channelId, presence.members(channelId))); };
  permissionListeners.add(resend);
  app.addHook("onClose", async () => { permissionListeners.delete(resend); });

  // Connections whose other end vanished without a close would keep their voice presence and keep their user "present"
  // for the AFK detection for ever (liveness.ts): ping them, terminate the dead, count the silent ones as idle.
  const liveness = new Liveness<WebSocket>();
  const heartbeat = setInterval(() => {
    const { dead, stale } = liveness.sweep();
    for (const ws of dead) { app.log.info("ws terminated: nothing heard"); ws.terminate(); }
    for (const ws of stale) hub.setStale(ws, true);
    for (const ws of liveness.connections()) if (ws.readyState === ws.OPEN) ws.ping();
    // Entries taken over from LiveKit (below) are a guess: gone once the participant is.
    const restored = presence.restoredEntries();
    if (restored.length) void lk.roomsByIdentity().then((rooms) => { if (rooms) for (const e of restored) if (rooms.get(e.userId) !== e.channelId && presence.channelOf(e.conn) === e.channelId) presence.leave(e.conn); });
  }, PING_EVERY_MS);
  app.addHook("onClose", async () => clearInterval(heartbeat));

  app.get("/api/ws", { websocket: true }, (socket: WebSocket, req) => {
    let userId: string | null = null;
    const send = (e: ServerEvent) => hub.send(socket, e);
    const helloTimeout = setTimeout(() => socket.close(4001, "hello timeout"), 10_000);
    let lastTyping = 0;
    let expiryTimer: NodeJS.Timeout | null = null;
    let helloSeen = false;
    const events = wsLimit?.() ?? null;
    // Game display: every change goes to all members, so a connection's reports take effect at most every GAME_CHANGE_MS;
    // what arrives in between waits, and only the last one counts.
    let lastGameAt = 0;
    let gameTimer: NodeJS.Timeout | null = null;
    let waitingGame: GamePresence | null = null;
    const applyGame = (game: GamePresence | null) => { lastGameAt = Date.now(); hub.setGame(socket, game); };
    const reportGame = (game: GamePresence | null) => {
      const wait = lastGameAt + GAME_CHANGE_MS - Date.now();
      if (wait <= 0 && !gameTimer) return applyGame(game);
      waitingGame = game;
      gameTimer ??= setTimeout(() => { gameTimer = null; applyGame(waitingGame); }, Math.max(wait, 0));
    };

    socket.on("pong", () => { liveness.heard(socket, false); });
    socket.on("message", async (raw) => {
      if (events && !events.hit("c").ok) {
        app.log.warn({ userId, ip: req.ip }, "ws: zu viele Ereignisse, Verbindung geschlossen");
        return socket.close(CLOSE_RATE_LIMITED, "rate limited");
      }
      if (liveness.heard(socket, true)) hub.setStale(socket, false);
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return send({ type: "error", code: "bad_message", message: "invalid json" }); }
      const ev = ClientEvent.safeParse(json);
      if (!ev.success) return send({ type: "error", code: "bad_message", message: "unknown event" });

      if (ev.data.type === "hello") {
        // One hello per connection (security review, 25 September 2026): a second one would add the socket for another user.
        // Marked before the first await, so two hellos sent at once cannot both pass.
        if (helloSeen) return send({ type: "error", code: "bad_message", message: "hello already done" });
        helloSeen = true;
        if (ev.data.protocolVersion !== PROTOCOL_VERSION) {
          send({ type: "error", code: "protocol_version", message: `server speaks v${PROTOCOL_VERSION}` });
          return socket.close(4002, "protocol version");
        }
        const { session, refused } = await lookUpSession(db, ev.data.sessionToken);
        // The session's device is not let in any more (docs/features/devices.md): the same close as for a socket that is open
        // when its device is signed out. `unauthorized` first, which is what a client from before devices stops on.
        if (refused) {
          send({ type: "error", code: "unauthorized", message: "device refused" });
          return socket.close(WS_CLOSE_SESSION_ENDED, "device_revoked");
        }
        const actor = session ? await actorOf(db, session.userId) : null;
        if (!session || !actor) {
          send({ type: "error", code: "unauthorized", message: session ? "not a member" : "session invalid" });
          return socket.close(4003, "unauthorized");
        }
        // A member from before server accounts without any account (docs/features/local-accounts.md): registration first.
        // Its own close code, so a current client does not drop the session (it does not open the socket before registering).
        if (!hasAccount(session)) {
          send({ type: "error", code: "unauthorized", message: "registration required" });
          return socket.close(CLOSE_REGISTRATION_REQUIRED, "registration_required");
        }
        // A directory account the directory's operator suspended (users/suspension.ts): `unauthorized` for the clients from
        // before it, the date in the message and the close code for the ones that know it.
        const suspended = await suspensionOf(db, session);
        if (suspended) {
          send({ type: "error", code: "unauthorized", message: suspendedCloseReason(suspended.toISOString()) });
          return socket.close(WS_CLOSE_ACCOUNT_SUSPENDED, "account_suspended");
        }
        userId = session.userId;
        clearTimeout(helloTimeout);
        hub.add(userId, socket, session.sessionId);
        // A kick, ban or sign-out between the lookup above and hub.add would have missed this socket: look again now that it
        // is registered (security review, 25 September 2026).
        const still = await resolveSession(db, ev.data.sessionToken);
        if (!still || !(await actorOf(db, still.userId))) {
          send({ type: "error", code: "unauthorized", message: "session invalid" });
          return socket.close(4003, "unauthorized");
        }
        // The session's end (or its deletion in the meantime) ends the socket too. A timer reaches at most ~24 days ahead:
        // when it fires early, look again and wait for the rest.
        const token = ev.data.sessionToken;
        const watchExpiry = (expiresAt: Date) => {
          expiryTimer = setTimeout(() => {
            void resolveSession(db, token).then((s) => {
              if (socket.readyState !== socket.OPEN) return;
              if (!s) socket.close(WS_CLOSE_SESSION_ENDED, "session_expired"); else watchExpiry(s.expiresAt);
            }).catch(() => watchExpiry(new Date(Date.now() + 60_000)));
          }, Math.min(Math.max(expiresAt.getTime() - Date.now() + 1000, 0), 2 ** 31 - 1));
        };
        watchExpiry(still.expiresAt);
        liveness.add(socket);
        req.log.info({ userId }, "ws connected");
        send({ type: "welcome", userId, serverTime: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, state: await loadState(db, hub, userId) });
        const visible = new Set(visibility.visibleIds(userId));
        for (const ch of await loadChannels(db)) {
          if (!visible.has(ch.id)) continue;
          if (ch.kind === "voice") send(voiceStateEvent(ch.id, presence.members(ch.id)));
          const title = radioMeta.titleOf(ch.id);
          if (title) send({ type: "radio.meta", channelId: ch.id, title });
        }
        // Voice outlives this process and every reconnect (LiveKit), the presence here does not: a member who is still
        // talking comes back into their channel's list. Clients of today say it themselves right after the welcome
        // (then there is nothing to do here); older ones (desktop app up to 0.1.2) never do.
        const rooms = await lk.roomsByIdentity();
        const room = rooms?.get(userId);
        if (room && socket.readyState === socket.OPEN && !presence.channelOfUser(userId)) {
          // Only where the member may still be: whoever lost the channel while away is dropped from the room instead
          // (a moderator's placement does not survive a restart; the moderator moves again).
          const r = await resolveChannel(db, userId, room, "voice");
          const [user] = await db.select({ publicKey: users.publicKey, displayName: users.displayName, handle: users.handle }).from(users).where(eq(users.id, userId)).limit(1);
          if (!r || !canIn(visibility.resolvedMask(userId, room), Permission.CONNECT_VOICE) || !canIn(visibility.resolvedMask(userId, room), Permission.VIEW_CHANNELS)) void lk.removeParticipant(room, userId);
          else if (user && socket.readyState === socket.OPEN && !presence.channelOfUser(userId)) { presence.join(socket, r.channel.id, { userId, displayName: displayNameOf(user), micMuted: false, deafened: false, cameraOn: false, screenOn: false }, true); await holdOnJoin(db, hub, userId, r.channel); }
        }
        return;
      }

      if (!userId) return socket.close(4003, "hello first");

      switch (ev.data.type) {
        case "ping":
          return send({ type: "pong", t: ev.data.t });
        case "voice.join": {
          // The same checks as POST /api/rtc-token (livekit/routes.ts): the channel must be visible and enterable for this
          // member, a sticky channel elsewhere must not hold them, and a full channel takes nobody (a moderator's move excepted).
          const actor = await actorOf(db, userId);
          if (!actor) return send({ type: "error", code: "forbidden", message: "no voice permission" });
          const r = await resolveChannel(db, userId, ev.data.channelId, "voice");
          if (!r) return send({ type: "error", code: "unknown_channel", message: `no such voice channel: ${ev.data.channelId}` });
          const channel = r.channel;
          if (!canIn(r.perms, Permission.CONNECT_VOICE)) return send({ type: "error", code: "forbidden", message: "no voice permission" });
          if ((await stickyVerdict(db, userId, actor, channel.id)) === "confined") return send({ type: "error", code: "forbidden", message: "confined" });
          const granted = moveGrants.grantOf(userId) === channel.id;
          // Blocked from this channel (docs/features/channel-blocks.md, a passed vote kick included): no way back until it is over or lifted.
          const blocked = granted ? null : channelBlockStore.of(channel.id, userId);
          if (blocked) return send({ type: "error", code: "forbidden", message: blocked.source === "votekick" ? "votekicked" : "channel_blocked" });
          if (channel.userLimit !== null && !granted && presence.channelOfUser(userId) !== channel.id && presence.members(channel.id).length >= channel.userLimit) return send({ type: "error", code: "forbidden", message: "channel_full" });
          const [user] = await db.select({ publicKey: users.publicKey, displayName: users.displayName, handle: users.handle }).from(users).where(eq(users.id, userId)).limit(1);
          if (!user) return socket.close(4003, "unauthorized");
          // The same account joins from another device or tab (user's wish, 22 September 2026): its voice elsewhere on this
          // server ends. That client gets voice.moved with reason "elsewhere" and hangs up; when it sits in another room,
          // LiveKit drops its participant too (a client from before does not know the reason). In the same room LiveKit
          // has already replaced it (duplicate identity), nothing is removed there: it would hit the one that just joined.
          const others = presence.othersOfUser(userId, socket);
          if (others.length) {
            const by = await loadSettings(db).then((st) => st.name).catch(() => "");
            for (const o of others) { hub.send(o.conn, { type: "voice.moved", channelId: null, by, reason: "elsewhere" }); presence.leave(o.conn); }
            for (const room of new Set(others.map((o) => o.channelId))) if (room !== channel.id) void lk.removeParticipant(room, userId);
          }
          presence.dropRestored(userId, socket);
          // A vote kick running in this channel (docs/features/votekick.md): the joining client shows it right away.
          const vote = voteKicks.running(channel.id);
          if (vote) { const mine = vote.votes.get(userId); send({ type: "votekick", channelId: channel.id, vote: voteOnWire(vote), myVote: mine === undefined ? null : mine ? "yes" : "no", canVote: vote.electorate.has(userId) && !vote.votes.has(userId) }); }
          // The mute state comes with the join (a client from before it says nothing: unmuted) and changes with voice.status.
          presence.join(socket, channel.id, { userId, displayName: displayNameOf(user), micMuted: ev.data.micMuted ?? false, deafened: ev.data.deafened ?? false, cameraOn: ev.data.cameraOn ?? false, screenOn: ev.data.screenOn ?? false }, false, granted);
          moveGrants.consume(userId, channel.id);
          await holdOnJoin(db, hub, userId, channel);
          return refreshUserView(db, hub, userId);
        }
        case "voice.leave": {
          presence.dropRestored(userId, socket);
          presence.leave(socket);
          return releaseOnLeave(db, hub, presence, userId);
        }
        case "voice.status":
          return presence.setStatus(socket, { micMuted: ev.data.micMuted, deafened: ev.data.deafened, cameraOn: ev.data.cameraOn, screenOn: ev.data.screenOn });
        case "activity":
          // AFK detection: the hub turns the connections' reports into the member's state (index.ts broadcasts and moves).
          hub.setIdle(socket, ev.data.idle);
          // Game display: left out = the client says nothing about it (one from before the feature).
          if (ev.data.game !== undefined) reportGame(ev.data.game);
          return;
        case "typing": {
          const now = Date.now();
          if (now - lastTyping < 2000) return; // Throttling: at most every 2 s
          lastTyping = now;
          if (!visibility.canSee(userId, ev.data.channelId)) return; // typing into a channel one may not see: nothing
          return hub.broadcastToChannel(ev.data.channelId, { type: "typing", channelId: ev.data.channelId, userId }, socket);
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimeout);
      if (gameTimer) clearTimeout(gameTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      liveness.remove(socket);
      hub.remove(socket);
      const seated = presence.channelOf(socket) !== undefined;
      presence.leave(socket);
      if (userId && seated) void releaseOnLeave(db, hub, presence, userId).catch((err) => req.log.warn({ err }, "release on close"));
      if (userId) req.log.info({ userId }, "ws closed");
    });
  });
}
