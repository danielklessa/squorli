import { CloseReportRequest, CreateReportRequest, Permission, displayNameOf, type ReportsResponse } from "@squorli/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { requireMember } from "../auth/session";
import { can, outranks } from "../authz";
import { canIn, resolveChannel } from "../channelGuard";
import type { Db } from "../db";
import { localAccounts, members, messages, users } from "../db/schema";
import { actorOf } from "../state";
import type { Hub } from "../hub";
import { listModLog, recordModLog } from "../modLog";
import { avatarOf, localJoin, nameColumns } from "../names";
import { channelNameOf, type ReportsService } from "../reports";
import { INLINE_TYPES } from "./attachments";

const Params = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

/**
 * Reports (docs/features/reports.md): every member may report a message they can see (not their own) or a member; whoever has
 * MANAGE_REPORTS reads the queue, closes reports and reads the moderation log. The reported message's attachment copies are
 * served with signed links like ordinary attachments, the same inline rule and sandbox.
 */
export async function registerReportRoutes(app: FastifyInstance, db: Db, hub: Hub, service: ReportsService) {
  const userOf = async (userId: string) => {
    const [u] = await db.select({ userId: users.id, ...nameColumns, avatarUrl: users.avatarUrl, localAvatarAt: localAccounts.avatarUpdatedAt }).from(users).leftJoin(localAccounts, localJoin).where(eq(users.id, userId)).limit(1);
    return u ? { userId: u.userId, name: displayNameOf(u), handle: u.handle ?? (u.localHandle ? `~${u.localHandle}` : null), avatarUrl: avatarOf(u) } : null;
  };

  app.post("/api/reports", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    const body = CreateReportRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const reporter = { userId: m.userId, name: displayNameOf(m) };
    const text = body.data.text?.trim() || null;
    if (body.data.kind === "message") {
      const [row] = await db.select().from(messages).where(eq(messages.id, body.data.messageId)).limit(1);
      // An invisible channel's message does not exist for this member (the standing 404 rule).
      const r = row ? await resolveChannel(db, m.userId, row.channelId) : null;
      if (!row || !r) return reply.code(404).send({ error: "not_found" });
      if (row.authorId === m.userId) return reply.code(400).send({ error: "own_message" });
      if (await service.alreadyOpen(m.userId, row.id)) return reply.code(409).send({ error: "already_reported" });
      const author = (await userOf(row.authorId)) ?? { userId: row.authorId, name: "?", handle: null, avatarUrl: null };
      const id = await service.createForMessage(reporter, row, (await channelNameOf(db, row.channelId)) ?? r.channel.name, author, body.data.reason, text);
      req.log.info({ by: m.userId, reportId: id, kind: "message" }, "Meldung eingegangen");
      return { id };
    }
    if (body.data.userId === m.userId) return reply.code(400).send({ error: "self" });
    const [member] = await db.select({ userId: members.userId }).from(members).where(eq(members.userId, body.data.userId)).limit(1);
    const target = member ? await userOf(member.userId) : null;
    if (!target) return reply.code(404).send({ error: "not_found" });
    const id = await service.createForMember(reporter, target, body.data.reason, text);
    req.log.info({ by: m.userId, reportId: id, kind: "member" }, "Meldung eingegangen");
    return { id };
  });

  app.get<{ Querystring: { status?: string } }>("/api/reports", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_REPORTS)) return reply.code(403).send({ error: "forbidden" });
    const status = req.query.status === "closed" ? "closed" : "open";
    const res: ReportsResponse = { reports: await service.list(status), open: await service.openCount() };
    return res;
  });

  app.post<{ Params: { id: string } }>("/api/reports/:id/close", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_REPORTS)) return reply.code(403).send({ error: "forbidden" });
    const body = CloseReportRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const row = await service.get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    // Deleting through a report needs what deleting needs anywhere else (security audit, 2 October 2026, S3): the message
    // itself MANAGE_MESSAGES in its channel, like DELETE /api/messages/:id; the person's recent messages MANAGE_MESSAGES and a
    // rank above them, like the ban's delete choice. MANAGE_REPORTS alone let a moderator wipe an owner's week.
    if (body.data.action === "delete" && row.messageId && row.status === "open") {
      const [msg] = await db.select({ channelId: messages.channelId, authorId: messages.authorId }).from(messages).where(eq(messages.id, row.messageId)).limit(1);
      const inChannel = msg ? await resolveChannel(db, m.userId, msg.channelId) : null;
      if (msg && msg.authorId !== m.userId && !(inChannel && canIn(inChannel.perms, Permission.MANAGE_MESSAGES))) return reply.code(403).send({ error: "forbidden" });
    }
    if (body.data.action === "deleteRecent" && row.reportedUserId && row.status === "open") {
      if (!can(m.actor, Permission.MANAGE_MESSAGES)) return reply.code(403).send({ error: "forbidden" });
      const target = await actorOf(db, row.reportedUserId);
      if (target && !outranks(m.actor, target)) return reply.code(403).send({ error: "target_above_you" });
    }
    const closer = { userId: m.userId, name: displayNameOf(m) };
    const r = await service.close(row, closer, body.data.action, body.data.hours, body.data.note?.trim() || null);
    if (!r.ok) return reply.code(r.error === "already_closed" ? 409 : 400).send({ error: r.error });
    await recordModLog(db, {
      actorId: m.userId, actorName: closer.name, targetUserId: row.reportedUserId, targetName: row.reportedName, action: "report_closed",
      channelId: row.channelId, channelName: row.channelName, detail: { reportId: row.id, result: body.data.action, deleted: r.deleted, ...(body.data.hours ? { hours: body.data.hours } : {}) },
    }, req.log);
    req.log.info({ by: m.userId, reportId: row.id, action: body.data.action, deleted: r.deleted }, "Meldung geschlossen");
    return { ok: true, deleted: r.deleted };
  });

  /** A copy of a reported attachment: the signed link only (nothing tells whether a report exists without it). */
  app.get<{ Params: { id: string; n: string; name: string }; Querystring: { e?: string; s?: string } }>("/api/reports/:id/files/:n/:name", async (req, reply) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || !service.verifyFile(req.params.id, n, req.query.e, req.query.s)) return reply.code(404).send({ error: "not_found" });
    const row = await service.get(req.params.id);
    const meta = row?.snapshot?.attachments.find((a) => a.n === n);
    const path = meta ? service.filePath(req.params.id, n) : null;
    if (!meta || !path) return reply.code(404).send({ error: "not_found" });
    const inline = INLINE_TYPES.test(meta.mimeType);
    if (meta.mimeType !== "application/pdf") reply.header("content-security-policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.type(meta.mimeType).header("content-length", meta.size)
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`)
      .header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(path));
  });

  app.get<{ Querystring: { before?: string } }>("/api/mod-log", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_REPORTS)) return reply.code(403).send({ error: "forbidden" });
    const before = req.query.before ? new Date(req.query.before) : null;
    return listModLog(db, before && !Number.isNaN(before.getTime()) ? before : null);
  });
}
