import { Permission, RtcTokenRequest, displayNameOf, type RtcTokenResponse } from "@squorli/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { requireMember } from "../auth/session";
import { canIn, resolveChannel } from "../channelGuard";
import type { Config } from "../config";
import { seatsFull, seatsTaken } from "../limits";
import type { LivekitAdmin } from "./admin";
import type { Db } from "../db";
import { loadSettings } from "../state";
import { visibility } from "../visibility";
import { moveGrants } from "../voice/confine";
import type { VoicePresence } from "../voice/presence";
import { stickyVerdict } from "../voice/sticky";
import { channelBlockStore } from "../voice/channelBlocks";

/**
 * The app server decides who may enter which room and issues a
 * short-lived LiveKit token for it. Media then flows directly client <-> LiveKit.
 * Room name = channel id. Permission: member with CONNECT_VOICE and VIEW_CHANNELS.
 * Camera and screen (including screen audio as its own track, docs/features/voice-video.md) only with STREAM_VIDEO;
 * LiveKit enforces this via canPublishSources, not just the client.
 * The AFK channel (server setting) gets a token without publish and subscribe grants: nobody sends or hears anything
 * in it, whatever the client does; participants still see who is there.
 */
export async function registerLivekitRoutes(app: FastifyInstance, db: Db, config: Config, presence: VoicePresence, lk: LivekitAdmin) {
  app.post("/api/rtc-token", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const body = RtcTokenRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Since channel permissions (docs/features/channel-permissions.md): the channel must be visible and enterable for this
    // member (404 for an invisible one), a sticky channel elsewhere must not hold them, and a full channel takes nobody
    // more; a moderator's move (voice/confine.ts) passes all three. The same checks run again at voice.join (ws/handler.ts).
    const r = await resolveChannel(db, m.userId, body.data.channelId, "voice");
    if (!r) return reply.code(404).send({ error: "unknown_channel" });
    const channel = r.channel;
    if (!canIn(r.perms, Permission.CONNECT_VOICE)) return reply.code(403).send({ error: "forbidden" });
    if ((await stickyVerdict(db, m.userId, m.actor, channel.id)) === "confined") return reply.code(403).send({ error: "confined", lock: visibility.voiceLockOf(m.userId) });
    const granted = moveGrants.grantOf(m.userId) === channel.id;
    // Blocked from this channel (docs/features/channel-blocks.md; a passed vote kick is one too): no token until the block
    // is over or lifted; a moderator's move wins. `until` null = permanent.
    const blocked = granted ? null : channelBlockStore.of(channel.id, m.userId);
    if (blocked) return reply.code(403).send({ error: blocked.source === "votekick" ? "votekicked" : "channel_blocked", until: blocked.until === null ? null : new Date(blocked.until).toISOString() });
    if (channel.userLimit !== null && !granted && presence.channelOfUser(m.userId) !== channel.id && presence.members(channel.id).length >= channel.userLimit) return reply.code(409).send({ error: "channel_full" });
    // VOICE_SEATS_MAX (docs/features/limits.md): the seats of the whole server; a member already seated keeps theirs (a channel switch).
    if (config.VOICE_SEATS_MAX !== undefined && seatsFull(seatsTaken(presence.seated(), await lk.roomsByIdentity(), m.userId), config.VOICE_SEATS_MAX)) return reply.code(409).send({ error: "voice_seats_full", max: config.VOICE_SEATS_MAX });

    const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
      identity: m.userId,
      name: displayNameOf(m),
      ttl: "10m",
    });
    const sources = [TrackSource.MICROPHONE];
    if (canIn(r.perms, Permission.STREAM_VIDEO) && channel.allowVideo) sources.push(TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    const afk = (await loadSettings(db)).afkChannelId === channel.id;
    // canUpdateOwnMetadata: the client reports "audio off" as a participant attribute so others can see it.
    at.addGrant(afk
      ? { roomJoin: true, room: channel.id, canPublish: false, canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: true }
      : { roomJoin: true, room: channel.id, canPublish: true, canPublishSources: sources, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: true });

    const res: RtcTokenResponse = { url: config.livekitPublicUrl, token: await at.toJwt() };
    return res;
  });
}
