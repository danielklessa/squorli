import { MarkReadRequest, MuteRequest, Permission, mentionToken, mentionedUserIds, type MuteState, type ReadStateResponse } from "@squorli/protocol";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../auth/session";
import { can } from "../authz";
import type { Db } from "../db";
import { channelMutes, channels, members, readStates } from "../db/schema";
import type { Hub } from "../hub";
import { channelActor } from "../channelGuard";
import { visibility } from "../visibility";

const Params = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

type Row = { muted: boolean; channel_id: string; last_read_seq: string | number | null; latest_seq: string | number | null; unread: string | number; mentions: string | number };
const num = (v: string | number | null) => (v === null ? null : Number(v));
/** Unread messages with my token that are looked at per request; beyond that the counter stops growing (nobody reads "500+"). */
const MAX_MENTION_CANDIDATES = 500;

/**
 * Read states: how far a member has read each text channel, kept here so unread marks and mention counters are the same
 * on all their devices. Only messages of other people count; a channel never opened counts from the day of joining.
 */
export async function registerReadStateRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  /** One query for all text channels: read state, newest message, number of unread messages (flag and count) and of those that mention me. */
  app.get("/api/read-state", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.VIEW_CHANNELS) && !visibility.visibleIds(m.userId).length) return reply.code(403).send({ error: "forbidden" });
    // Only the channels this member may see (docs/features/channel-permissions.md): counts for the others would give them away.
    await visibility.refresh(db);
    // As one array literal: the sql template would spread a JS array into a record.
    const visible = `{${visibility.visibleIds(m.userId).join(",")}}`;
    // The token as the client stores a mention. The substring test only finds candidates: a token quoted inside code is
    // no mention for the client, so the candidates are checked below with the rules of the client (mentionedUserIds).
    const token = `%${mentionToken(m.userId)}%`;
    const rows = await db.execute(sql`
      SELECT c.id AS channel_id, rs.last_read_seq,
        EXISTS (SELECT 1 FROM channel_mutes cm WHERE cm.channel_id = c.id AND cm.user_id = ${m.userId}) AS muted,
        (SELECT max(seq) FROM messages WHERE channel_id = c.id) AS latest_seq,
        agg.unread, agg.mentions
      FROM channels c
      LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ${m.userId}
      LEFT JOIN LATERAL (
        SELECT count(*) AS unread, count(*) FILTER (WHERE msg.content LIKE ${token}) AS mentions
        FROM messages msg
        WHERE msg.channel_id = c.id AND msg.author_id <> ${m.userId}
          AND CASE WHEN rs.last_read_seq IS NOT NULL THEN msg.seq > rs.last_read_seq
                   ELSE msg.created_at > (SELECT joined_at FROM members WHERE user_id = ${m.userId}) END
      ) agg ON true
      WHERE c.kind = 'text' AND c.id = ANY(${visible}::uuid[])`) as unknown as Row[];
    const mentions = new Map<string, number>();
    if (rows.some((r) => Number(r.mentions) > 0)) {
      const candidates = await db.execute(sql`
        SELECT msg.channel_id, msg.content
        FROM messages msg
        JOIN channels c ON c.id = msg.channel_id AND c.kind = 'text' AND c.id = ANY(${visible}::uuid[])
        LEFT JOIN read_states rs ON rs.channel_id = msg.channel_id AND rs.user_id = ${m.userId}
        WHERE msg.author_id <> ${m.userId} AND msg.content LIKE ${token}
          AND CASE WHEN rs.last_read_seq IS NOT NULL THEN msg.seq > rs.last_read_seq
                   ELSE msg.created_at > (SELECT joined_at FROM members WHERE user_id = ${m.userId}) END
        ORDER BY msg.seq DESC LIMIT ${MAX_MENTION_CANDIDATES}`) as unknown as { channel_id: string; content: string }[];
      for (const c of candidates) if (mentionedUserIds(c.content).includes(m.userId)) mentions.set(c.channel_id, (mentions.get(c.channel_id) ?? 0) + 1);
    }
    const [me] = await db.select({ muted: members.muted }).from(members).where(eq(members.userId, m.userId)).limit(1);
    const out: ReadStateResponse = {
      channels: rows.map((r) => ({ channelId: r.channel_id, lastReadSeq: num(r.last_read_seq), latestSeq: num(r.latest_seq), unread: Number(r.unread) > 0, unreadCount: Number(r.unread), mentions: mentions.get(r.channel_id) ?? 0, muted: r.muted === true })),
      serverMuted: me?.muted ?? false,
    };
    return out;
  });

  /** The member's mutes as a whole; after a change it goes to all their connections so every device shows the same. */
  async function muteState(userId: string): Promise<MuteState> {
    const [me] = await db.select({ muted: members.muted }).from(members).where(eq(members.userId, userId)).limit(1);
    const rows = await db.select({ channelId: channelMutes.channelId }).from(channelMutes).where(eq(channelMutes.userId, userId));
    return { serverMuted: me?.muted ?? false, channelIds: rows.map((r) => r.channelId) };
  }
  async function announce(userId: string): Promise<MuteState> {
    const state = await muteState(userId);
    hub.sendToUser(userId, { type: "mute.update", ...state });
    return state;
  }

  /** Mute or unmute one text channel for myself. Needs no permission beyond seeing channels: it only changes my own view. */
  app.put<{ Params: { id: string } }>("/api/channels/:id/mute", { schema: { params: Params } }, async (req, reply) => {
    const m = await channelActor(db, req, reply, req.params.id, "text");
    if (!m) return;
    const body = MuteRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const ch = m.channel;
    if (body.data.muted) await db.insert(channelMutes).values({ userId: m.userId, channelId: ch.id }).onConflictDoNothing();
    else await db.delete(channelMutes).where(and(eq(channelMutes.userId, m.userId), eq(channelMutes.channelId, ch.id)));
    return announce(m.userId);
  });

  /** Mute or unmute this whole server for myself (the mark on the server rail of the multi-server client). */
  app.put("/api/me/mute", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const body = MuteRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await db.update(members).set({ muted: body.data.muted }).where(eq(members.userId, m.userId));
    return announce(m.userId);
  });

  /** "I have seen this channel up to seq." Never moves backwards and never beyond the newest message of the server. */
  app.post<{ Params: { id: string } }>("/api/channels/:id/read", { schema: { params: Params } }, async (req, reply) => {
    const m = await channelActor(db, req, reply, req.params.id, "text");
    if (!m) return;
    const body = MarkReadRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const ch = m.channel;

    // A number from the future would hide messages that do not exist yet: cap it at the newest message there is.
    const seq = sql`least(${body.data.seq}::bigint, coalesce((SELECT max(seq) FROM messages), 0))`;
    const [row] = await db.insert(readStates).values({ userId: m.userId, channelId: ch.id, lastReadSeq: seq })
      .onConflictDoUpdate({
        target: [readStates.userId, readStates.channelId],
        set: { lastReadSeq: sql`greatest(${readStates.lastReadSeq}, excluded.last_read_seq)`, updatedAt: new Date() },
      }).returning({ lastReadSeq: readStates.lastReadSeq });
    const lastReadSeq = Number(row!.lastReadSeq);
    // The member's other devices drop their marks right away.
    hub.sendToUser(m.userId, { type: "read.update", channelId: ch.id, lastReadSeq });
    return { lastReadSeq };
  });
}
