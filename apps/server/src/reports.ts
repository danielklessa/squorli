import { Permission, REPORT_CLOSED_BY_SYSTEM, REPORT_OPEN_MAX_DAYS, REPORT_ROW_CLOSED_DAYS, REPORT_SNAPSHOT_CLOSED_DAYS, REPORT_SNAPSHOT_MAX_DAYS, hasPermission, type Report, type ReportAction, type ReportSnapshot } from "@squorli/protocol";
import { and, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { signAttachment, verifyAttachment } from "./attachmentLinks";
import type { Config } from "./config";
import type { StorageMeter } from "./limits";
import type { Db } from "./db";
import { attachments, channels, messages, reports } from "./db/schema";
import type { Hub } from "./hub";
import { deleteRecentMessagesOf } from "./moderation";
import { visibility } from "./visibility";

/**
 * Reports on this server (docs/features/reports.md, docs/PLAN-reports.md stage 1; the user's decisions of 25 September 2026).
 * A report holds a snapshot of what was reported, so it stays reviewable after the message is gone: the text, the author, copies
 * of the attachment files under DATA_DIR/reports/<reportId>/<n> (apart from ordinary attachments, reachable only through the
 * report's own signed links), the previews' texts. The reported person never learns who reported; when a moderator removes
 * their message through the queue they get a `moderation.notice` without the reporter (decision 4). Moderators (MANAGE_REPORTS)
 * get `reports.count` on every change (a count only, decision 5: nothing while offline, the count at the next sign-in).
 * Retention (decision 3): the snapshot goes 30 days after closing, 90 days after the report at the latest; the row stays so
 * repeats about the same person can be counted, and goes a year after closing (4 October 2026, the Directory's rule); an
 * open report nobody judged for 180 days is closed by the sweep as dismissed, closer "system".
 */
type SnapshotRow = NonNullable<typeof reports.$inferSelect["snapshot"]>;
type Closer = { userId: string; name: string };

export class ReportsService {
  private readonly dir: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly app: FastifyInstance, private readonly db: Db, private readonly hub: Hub, config: Config, private readonly log: FastifyBaseLogger, private readonly meter: StorageMeter | null = null) {
    this.dir = join(config.DATA_DIR, "reports");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.timer = setInterval(() => { void this.sweep().catch((err) => this.log.warn({ err }, "report sweep")); }, 60 * 60_000);
    this.timer.unref();
    void this.sweep().catch((err) => this.log.warn({ err }, "report sweep"));
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); }

  async openCount(): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(reports).where(eq(reports.status, "open"));
    return r?.n ?? 0;
  }

  /** The count to every online member with MANAGE_REPORTS (the visibility snapshot knows everybody's permissions). */
  async broadcastCount(): Promise<void> {
    const open = await this.openCount();
    await visibility.refresh(this.db);
    for (const userId of this.hub.onlineUserIds()) {
      const a = visibility.actorOf(userId);
      if (a && hasPermission(a.permissions, Permission.MANAGE_REPORTS)) this.hub.sendToUser(userId, { type: "reports.count", open });
    }
  }

  /** A report of a message: the snapshot copies the attachment files, so the evidence survives the message. */
  async createForMessage(reporter: { userId: string; name: string }, row: typeof messages.$inferSelect, channelName: string, author: { userId: string | null; name: string; handle: string | null; avatarUrl: string | null }, reason: string, text: string | null): Promise<string> {
    const files = await this.db.select().from(attachments).where(eq(attachments.messageId, row.id));
    const [inserted] = await this.db.insert(reports).values({
      kind: "message", reason, text, reporterId: reporter.userId, reporterName: reporter.name,
      reportedUserId: author.userId, reportedName: author.name, channelId: row.channelId, channelName, messageId: row.id,
      snapshot: {
        content: row.content, messageCreatedAt: row.createdAt.toISOString(),
        attachments: files.map((f, n) => ({ n, name: f.name, size: f.size, mimeType: f.mimeType })),
        previews: (row.previews ?? []).filter((p) => !p.removed).map((p) => ({ url: p.url, siteName: p.siteName, title: p.title, description: p.description })),
        name: author.name, handle: author.handle, avatarUrl: author.avatarUrl,
      },
    }).returning({ id: reports.id });
    const id = inserted!.id;
    // The storage quota (docs/features/limits.md): copies that do not fit are left out, the report keeps its snapshot.
    if (files.length && (this.meter === null || await this.meter.room(files.reduce((a, f) => a + f.size, 0)))) {
      const dir = join(this.dir, id);
      await mkdir(dir, { recursive: true });
      for (const [n, f] of files.entries()) {
        await copyFile(join(this.app.attachmentsDir, f.id), join(dir, String(n))).catch((err) => this.log.warn({ err, reportId: id, attachment: f.id }, "Anhang nicht in die Meldung kopiert"));
      }
      this.meter?.invalidate();
    } else if (files.length) {
      this.log.warn({ reportId: id, files: files.length }, "Speicherkontingent voll (STORAGE_QUOTA_MB): die Anhaenge wurden nicht in die Meldung kopiert");
    }
    await this.broadcastCount();
    return id;
  }

  async createForMember(reporter: { userId: string; name: string }, target: { userId: string; name: string; handle: string | null; avatarUrl: string | null }, reason: string, text: string | null): Promise<string> {
    const [inserted] = await this.db.insert(reports).values({
      kind: "member", reason, text, reporterId: reporter.userId, reporterName: reporter.name, reportedUserId: target.userId, reportedName: target.name,
      snapshot: { content: null, messageCreatedAt: null, attachments: [], previews: [], name: target.name, handle: target.handle, avatarUrl: target.avatarUrl },
    }).returning({ id: reports.id });
    await this.broadcastCount();
    return inserted!.id;
  }

  /** An open report of this reporter about this message already exists (one per member and message). */
  async alreadyOpen(reporterId: string, messageId: string): Promise<boolean> {
    const [r] = await this.db.select({ id: reports.id }).from(reports).where(and(eq(reports.reporterId, reporterId), eq(reports.messageId, messageId), eq(reports.status, "open"))).limit(1);
    return !!r;
  }

  /** The queue: open reports newest first, or the closed ones (the last 200). */
  async list(status: "open" | "closed"): Promise<Report[]> {
    const rows = await this.db.select().from(reports)
      .where(status === "open" ? eq(reports.status, "open") : inArray(reports.status, ["actioned", "dismissed"]))
      .orderBy(desc(reports.createdAt)).limit(200);
    const messageIds = rows.map((r) => r.messageId).filter((x): x is string => !!x);
    const existing = new Set(messageIds.length ? (await this.db.select({ id: messages.id }).from(messages).where(inArray(messages.id, messageIds))).map((m) => m.id) : []);
    const reported = [...new Set(rows.map((r) => r.reportedUserId).filter((x): x is string => !!x))];
    const earlier = new Map<string, number>();
    if (reported.length) {
      const counts = await this.db.select({ userId: reports.reportedUserId, n: sql<number>`count(*)::int` }).from(reports).where(inArray(reports.reportedUserId, reported)).groupBy(reports.reportedUserId);
      for (const c of counts) if (c.userId) earlier.set(c.userId, c.n);
    }
    return rows.map((r) => this.toWire(r, existing, earlier));
  }

  async get(id: string): Promise<typeof reports.$inferSelect | null> {
    const [r] = await this.db.select().from(reports).where(eq(reports.id, id)).limit(1);
    return r ?? null;
  }

  /**
   * Close a report with what was done. `delete` removes the reported message (the queue's own doing, MANAGE_REPORTS suffices
   * for a reported message), `deleteRecent` the reported person's messages of the last `hours`; kick and ban happened through
   * their own routes before, here they are only recorded. The reported person gets the notice of decision 4 when something
   * of theirs went. Returns what happened, or a reason it could not.
   */
  async close(row: typeof reports.$inferSelect, closer: Closer, action: ReportAction, hours: number | undefined, note: string | null): Promise<{ ok: true; deleted: number } | { ok: false; error: "already_closed" | "no_message" | "no_member" }> {
    if (row.status !== "open") return { ok: false, error: "already_closed" };
    let deleted = 0;
    if (action === "delete") {
      if (!row.messageId) return { ok: false, error: "no_message" };
      const [msg] = await this.db.select().from(messages).where(eq(messages.id, row.messageId)).limit(1);
      if (msg) {
        const files = await this.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.messageId, msg.id));
        await this.db.delete(messages).where(eq(messages.id, msg.id));
        await this.app.removeAttachmentFiles(files.map((f) => f.id));
        this.hub.broadcastToChannel(msg.channelId, { type: "message.delete", channelId: msg.channelId, id: msg.id });
        this.hub.sendToUser(msg.authorId, { type: "moderation.notice", kind: "message_removed", channelName: row.channelName, count: 1 });
        deleted = 1;
      }
    } else if (action === "deleteRecent") {
      if (!row.reportedUserId) return { ok: false, error: "no_member" };
      const r = await deleteRecentMessagesOf(this.app, this.db, this.hub, row.reportedUserId, (hours ?? 24) * 3_600_000);
      deleted = r.count;
      if (r.count) this.hub.sendToUser(row.reportedUserId, { type: "moderation.notice", kind: "messages_removed", channelName: null, count: r.count });
    }
    const status = action === "dismiss" || action === "none" ? "dismissed" : "actioned";
    await this.db.update(reports).set({ status, closedAt: new Date(), closedBy: closer.userId, closedByName: closer.name, action, note }).where(eq(reports.id, row.id));
    // Every other open report about the same message is answered by the same deletion.
    if (action === "delete" && row.messageId) {
      await this.db.update(reports).set({ status: "actioned", closedAt: new Date(), closedBy: closer.userId, closedByName: closer.name, action, note })
        .where(and(eq(reports.messageId, row.messageId), eq(reports.status, "open")));
    }
    await this.broadcastCount();
    return { ok: true, deleted };
  }

  /** The signed link of one attachment copy (like ordinary attachments: `e` and `s`, valid for a week). */
  fileUrl(reportId: string, n: number, name: string): string {
    return `/api/reports/${reportId}/files/${n}/${encodeURIComponent(name)}?${signAttachment(`report/${reportId}/${n}`)}`;
  }
  verifyFile(reportId: string, n: number, e: unknown, s: unknown): boolean {
    return verifyAttachment(`report/${reportId}/${n}`, e, s);
  }
  filePath(reportId: string, n: number): string | null {
    const p = join(this.dir, reportId, String(n));
    return existsSync(p) ? p : null;
  }

  /**
   * Retention, hourly: an open report nobody judged for REPORT_OPEN_MAX_DAYS is closed as dismissed by "system" (its
   * snapshot is gone since day 90, nothing is left to judge); the snapshots that are due go (files and the JSON) while the
   * row stays; a closed row goes REPORT_ROW_CLOSED_DAYS after closing, with whatever files were left. Returns what went.
   */
  async sweep(): Promise<{ expired: number; purged: number; rows: number }> {
    const now = Date.now();
    const expired = await this.db.update(reports)
      .set({ status: "dismissed", closedAt: new Date(now), closedBy: null, closedByName: REPORT_CLOSED_BY_SYSTEM, action: "dismiss", note: null })
      .where(and(eq(reports.status, "open"), lt(reports.createdAt, new Date(now - REPORT_OPEN_MAX_DAYS * 86_400_000)))).returning({ id: reports.id });
    const due = await this.db.select({ id: reports.id }).from(reports).where(and(isNotNull(reports.snapshot), or(
      lt(reports.createdAt, new Date(now - REPORT_SNAPSHOT_MAX_DAYS * 86_400_000)),
      and(isNotNull(reports.closedAt), lt(reports.closedAt, new Date(now - REPORT_SNAPSHOT_CLOSED_DAYS * 86_400_000))),
    )));
    for (const r of due) {
      await rm(join(this.dir, r.id), { recursive: true, force: true });
      await this.db.update(reports).set({ snapshot: null }).where(eq(reports.id, r.id));
    }
    const rows = await this.db.delete(reports)
      .where(and(ne(reports.status, "open"), isNotNull(reports.closedAt), lt(reports.closedAt, new Date(now - REPORT_ROW_CLOSED_DAYS * 86_400_000)))).returning({ id: reports.id });
    for (const r of rows) await rm(join(this.dir, r.id), { recursive: true, force: true });
    if (expired.length) {
      this.log.info({ expired: expired.length }, "Meldungen: offene nach 180 Tagen geschlossen");
      await this.broadcastCount();
    }
    if (due.length) this.log.info({ purged: due.length }, "Meldungen: Momentaufnahmen nach Ablauf entfernt");
    if (rows.length) this.log.info({ rows: rows.length }, "Meldungen: Eintraege ein Jahr nach Abschluss entfernt");
    return { expired: expired.length, purged: due.length, rows: rows.length };
  }

  private toWire(r: typeof reports.$inferSelect, existing: Set<string>, earlier: Map<string, number>): Report {
    const snap = r.snapshot as SnapshotRow | null;
    const snapshot: ReportSnapshot | null = snap ? { ...snap, attachments: snap.attachments.map((a) => ({ ...a, url: this.fileUrl(r.id, a.n, a.name) })) } : null;
    return {
      id: r.id, kind: r.kind, reason: r.reason as Report["reason"], text: r.text, status: r.status,
      reporterId: r.reporterId, reporterName: r.reporterName, reportedUserId: r.reportedUserId, reportedName: r.reportedName,
      channelId: r.channelId, channelName: r.channelName, messageId: r.messageId, messageExists: !!r.messageId && existing.has(r.messageId),
      createdAt: r.createdAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null, closedByName: r.closedByName,
      action: (r.action as Report["action"]) ?? null, note: r.note, snapshot,
      earlier: Math.max(0, (r.reportedUserId ? earlier.get(r.reportedUserId) ?? 1 : 1) - 1),
    };
  }
}

/** The name of a channel for a report's line (the channel may be gone later; the report keeps the name). */
export async function channelNameOf(db: Db, channelId: string): Promise<string | null> {
  const [c] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, channelId)).limit(1);
  return c?.name ?? null;
}
