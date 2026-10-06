import { CreateMessageRequest, Permission, RemovePreviewRequest, SetNoticeRequest, UpdateMessageRequest, type Attachment, type Message, type MessagePage } from "@squorli/protocol";
import { signAttachment } from "../attachmentLinks";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../auth/session";
import { canIn, channelActor, resolveChannel } from "../channelGuard";
import type { Db } from "../db";
import { attachments, channels, messages } from "../db/schema";
import type { Hub } from "../hub";
import { visiblePreviews, type LinkPreviews } from "../previews/service";
import { recordModLog, userNameOf } from "../modLog";
import { reactionsOf } from "../reactions";
import { displayNameOf } from "@squorli/protocol";

const PAGE = 50;
const Params = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

/** Signed and expiring (attachmentLinks.ts): whoever sees the message gets a link that works for at least a week. */
export function attachmentUrl(a: { id: string; name: string }): string {
  return `/api/attachments/${a.id}/${encodeURIComponent(a.name)}?${signAttachment(a.id)}`;
}

/**
 * `withPreviews` false = link previews are turned off: the field is left out, which is what tells clients so. `viewerId` =
 * whom the reactions' `me` is for (the history's reader); null for a broadcast, where the client keeps its own flag.
 */
export async function loadMessages(db: Db, rows: (typeof messages.$inferSelect)[], withPreviews = true, viewerId: string | null = null): Promise<Message[]> {
  const ids = rows.map((r) => r.id);
  const [atts, reactions] = await Promise.all([
    ids.length ? db.select().from(attachments).where(inArray(attachments.messageId, ids)) : [],
    reactionsOf(db, ids, viewerId),
  ]);
  const byMsg = new Map<string, Attachment[]>();
  for (const a of atts) {
    const list = byMsg.get(a.messageId!) ?? [];
    list.push({ id: a.id, name: a.name, size: a.size, mimeType: a.mimeType, url: attachmentUrl(a) });
    byMsg.set(a.messageId!, list);
  }
  return rows.map((r) => ({
    id: r.id, seq: r.seq, channelId: r.channelId, authorId: r.authorId, content: r.content,
    attachments: byMsg.get(r.id) ?? [], ...(withPreviews ? { previews: visiblePreviews(r.previews) } : {}),
    reactions: reactions.get(r.id) ?? [], notice: r.notice,
    createdAt: r.createdAt.toISOString(), editedAt: r.editedAt?.toISOString() ?? null,
  }));
}

export async function registerMessageRoutes(app: FastifyInstance, db: Db, hub: Hub, previews: LinkPreviews) {
  const load = (rows: (typeof messages.$inferSelect)[], viewerId: string | null = null) => loadMessages(db, rows, previews.enabled, viewerId);
  /** Every route here goes by the member's permissions in the channel (channelGuard.ts): an invisible channel is a 404. */

  /** History, loaded newest-first and returned oldest-first. ?before=<seq> pages backwards. */
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/channels/:id/messages", { schema: { params: Params } }, async (req, reply) => {
      const c = await channelActor(db, req, reply, req.params.id, "text");
      if (!c) return;
      const ch = c.channel;
      const before = req.query.before ? Number(req.query.before) : null;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || PAGE));
      const rows = await db.select().from(messages)
        .where(before !== null && Number.isFinite(before) ? and(eq(messages.channelId, ch.id), lt(messages.seq, before)) : eq(messages.channelId, ch.id))
        .orderBy(desc(messages.seq)).limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = await load(rows.slice(0, limit).reverse(), c.userId);
      const out: MessagePage = { messages: page, hasMore };
      return out;
    });

  app.post<{ Params: { id: string } }>("/api/channels/:id/messages", { schema: { params: Params } }, async (req, reply) => {
    const c = await channelActor(db, req, reply, req.params.id, "text");
    if (!c) return;
    const m = c, ch = c.channel;
    if (!canIn(c.perms, Permission.SEND_MESSAGES)) return reply.code(403).send({ error: "forbidden" });
    const body = CreateMessageRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Slowmode: one message per `slowmodeSeconds` and member; whoever manages messages in the channel is exempt.
    if (ch.slowmodeSeconds > 0 && !canIn(c.perms, Permission.MANAGE_MESSAGES)) {
      const [last] = await db.select({ at: messages.createdAt }).from(messages).where(and(eq(messages.channelId, ch.id), eq(messages.authorId, m.userId))).orderBy(desc(messages.seq)).limit(1);
      const wait = last ? last.at.getTime() + ch.slowmodeSeconds * 1000 - Date.now() : 0;
      if (wait > 0) return reply.code(429).send({ error: "slowmode", retryAfter: Math.ceil(wait / 1000) });
    }

    const attIds = body.data.attachmentIds ?? [];
    if (attIds.length) {
      if (!canIn(c.perms, Permission.ATTACH_FILES)) return reply.code(403).send({ error: "forbidden" });
      // Only your own uploads that are not linked yet.
      const mine = await db.select({ id: attachments.id }).from(attachments)
        .where(and(inArray(attachments.id, attIds), eq(attachments.uploaderId, m.userId), isNull(attachments.messageId)));
      if (mine.length !== new Set(attIds).size) return reply.code(400).send({ error: "unknown_attachment" });
    }

    const [row] = await db.insert(messages).values({ channelId: ch.id, authorId: m.userId, content: body.data.content }).returning();
    if (attIds.length) await db.update(attachments).set({ messageId: row!.id }).where(inArray(attachments.id, attIds));
    const [msg] = await load([row!]);
    hub.broadcastToChannel(ch.id, { type: "message.create", message: msg! });
    // The links are looked up afterwards; the previews follow as a `message.update`.
    previews.schedule(row!.id);
    return msg;
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const body = UpdateMessageRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [row] = await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1);
    if (!row || !(await resolveChannel(db, m.userId, row.channelId))) return reply.code(404).send({ error: "not_found" });
    if (row.authorId !== m.userId) return reply.code(403).send({ error: "forbidden" }); // Only the author may edit
    const [updated] = await db.update(messages).set({ content: body.data.content, editedAt: new Date() }).where(eq(messages.id, row.id)).returning();
    const [msg] = await load([updated!]);
    hub.broadcastToChannel(row.channelId, { type: "message.update", message: msg! });
    previews.schedule(row.id);
    return msg;
  });

  /**
   * Notices (docs/features/notices.md): show a message without its author, or as a normal message again. MANAGE_NOTICES in
   * the channel; the author's own rights do not matter. The whole channel sees the change as a `message.update`.
   */
  app.put<{ Params: { id: string } }>("/api/messages/:id/notice", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const body = SetNoticeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [row] = await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1);
    const r = row ? await resolveChannel(db, m.userId, row.channelId) : null;
    if (!row || !r) return reply.code(404).send({ error: "not_found" });
    if (!canIn(r.perms, Permission.MANAGE_NOTICES)) return reply.code(403).send({ error: "forbidden" });
    if (row.notice === body.data.notice) return (await load([row]))[0];
    const [updated] = await db.update(messages).set({ notice: body.data.notice }).where(eq(messages.id, row.id)).returning();
    const [msg] = await load([updated!]);
    hub.broadcastToChannel(row.channelId, { type: "message.update", message: msg! });
    return msg;
  });

  /** The author takes one preview of their message away (the x next to it); nobody else may, a moderator deletes the message. */
  app.post<{ Params: { id: string } }>("/api/messages/:id/previews/remove", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const body = RemovePreviewRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [row] = await db.select({ authorId: messages.authorId, channelId: messages.channelId }).from(messages).where(eq(messages.id, req.params.id)).limit(1);
    if (!row || !(await resolveChannel(db, m.userId, row.channelId))) return reply.code(404).send({ error: "not_found" });
    if (row.authorId !== m.userId) return reply.code(403).send({ error: "forbidden" });
    if (!(await previews.remove(req.params.id, body.data.url))) return reply.code(404).send({ error: "unknown_preview" });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const [row] = await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1);
    const r = row ? await resolveChannel(db, m.userId, row.channelId) : null;
    if (!row || !r) return reply.code(404).send({ error: "not_found" });
    if (row.authorId !== m.userId && !canIn(r.perms, Permission.MANAGE_MESSAGES)) return reply.code(403).send({ error: "forbidden" });
    const files = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.messageId, row.id));
    await db.delete(messages).where(eq(messages.id, row.id)); // Attachments cascade in the DB
    await app.removeAttachmentFiles(files.map((f) => f.id));
    hub.broadcastToChannel(row.channelId, { type: "message.delete", channelId: row.channelId, id: row.id });
    // Somebody else's message: a moderation action, into the log (docs/features/reports.md); one's own is nobody's business.
    if (row.authorId !== m.userId) await recordModLog(db, { actorId: m.userId, actorName: displayNameOf(m), targetUserId: row.authorId, targetName: await userNameOf(db, row.authorId), action: "message_delete", channelId: row.channelId, channelName: r.channel.name, detail: { attachments: files.length } }, req.log);
    return { ok: true };
  });
}
