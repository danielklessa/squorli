import { and, eq, gt, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db";
import { attachments, messages } from "./db/schema";
import { serverEvents } from "./events";
import type { Hub } from "./hub";

/**
 * "Delete the member's messages of the last ..." (docs/features/reports.md; a ban with that choice, a report closed that way):
 * every message of the author newer than `sinceMs` ago, in every channel, with their attachment files, and one
 * `message.bulkDelete` per channel instead of hundreds of single events. Returns how many went, per channel.
 */
export async function deleteRecentMessagesOf(app: FastifyInstance, db: Db, hub: Hub, authorId: string, sinceMs: number): Promise<{ count: number; channels: string[] }> {
  const since = new Date(Date.now() - sinceMs);
  const rows = await db.select({ id: messages.id, channelId: messages.channelId }).from(messages).where(and(eq(messages.authorId, authorId), gt(messages.createdAt, since)));
  if (!rows.length) return { count: 0, channels: [] };
  const ids = rows.map((r) => r.id);
  const files = await db.select({ id: attachments.id }).from(attachments).where(inArray(attachments.messageId, ids));
  await db.delete(messages).where(inArray(messages.id, ids));
  await app.removeAttachmentFiles(files.map((f) => f.id));
  const byChannel = new Map<string, string[]>();
  for (const r of rows) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r.id]);
  for (const [channelId, list] of byChannel) {
    hub.broadcastToChannel(channelId, { type: "message.bulkDelete", channelId, ids: list });
    serverEvents.emit("message.delete", { channelId, messageIds: list }, { kind: "system" });
  }
  return { count: ids.length, channels: [...byChannel.keys()] };
}
