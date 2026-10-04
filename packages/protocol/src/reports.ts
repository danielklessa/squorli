import { z } from "zod";
import { Iso, REPORT_TEXT_MAX, ReportReason, Uuid } from "./primitives";

/**
 * Reports on a chat server and the moderation log (docs/features/reports.md, docs/PLAN-reports.md; 26 September 2026, the
 * user's seven decisions of 25 September 2026). A member reports a message or a member to the server's moderators (permission
 * MANAGE_REPORTS); the server keeps a snapshot of the message (text, author, copies of its attachments, the previews' texts)
 * so the report stays reviewable after the author deleted the message or left. The reported person never learns who
 * reported; when a moderator removes something of theirs after a report they get a short notice without the reporter.
 * Not part of the directory's copy of the protocol; the reason list and the text limit live in primitives.ts because the
 * directory's reports (directory.ts: a direct message to the directory's operator, stage 4 of the plan) share them.
 */

export const ReportKind = z.enum(["message", "member"]);
export const ReportStatus = z.enum(["open", "actioned", "dismissed"]);
/** What a moderator did when closing a report; `delete`/`deleteRecent` the server does itself, kick and ban go through their own routes first. */
export const ReportAction = z.enum(["delete", "deleteRecent", "kick", "ban", "dismiss", "none"]);
export const REPORT_NOTE_MAX = 500;
/** A member's open reports per hour (the server's rate limit). */
export const REPORTS_PER_HOUR = 10;

export const CreateReportRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), messageId: Uuid, reason: ReportReason, text: z.string().max(REPORT_TEXT_MAX).optional() }),
  z.object({ kind: z.literal("member"), userId: Uuid, reason: ReportReason, text: z.string().max(REPORT_TEXT_MAX).optional() }),
]);

/** A copy of an attachment, served by GET /api/reports/:id/files/:n/:name with a signed link like ordinary attachments. */
export const ReportAttachment = z.object({ n: z.number().int().nonnegative(), name: z.string(), size: z.number().int().nonnegative(), mimeType: z.string(), url: z.string() });
export const ReportPreview = z.object({ url: z.string(), siteName: z.string().nullable().default(null), title: z.string().nullable().default(null), description: z.string().nullable().default(null) });
/** What the report keeps about the message or member at the moment of the report. null on a `Report` once the retention purged it. */
export const ReportSnapshot = z.object({
  /** The message's text, author and time (null for a member report). */
  content: z.string().nullable().default(null),
  messageCreatedAt: Iso.nullable().default(null),
  attachments: z.array(ReportAttachment).default([]),
  previews: z.array(ReportPreview).default([]),
  /** The reported person as they showed at that moment. */
  name: z.string(),
  handle: z.string().nullable().default(null),
  avatarUrl: z.string().nullable().default(null),
});

export const Report = z.object({
  id: Uuid,
  kind: ReportKind,
  reason: ReportReason,
  text: z.string().nullable(),
  status: ReportStatus,
  /** null once the reporter's account is gone (their reports as reporter are deleted with it; this is for the closed list). */
  reporterId: Uuid.nullable(),
  reporterName: z.string(),
  reportedUserId: Uuid.nullable(),
  reportedName: z.string(),
  channelId: Uuid.nullable(),
  channelName: z.string().nullable(),
  messageId: Uuid.nullable(),
  /** The reported message still exists on the server (a moderator sees "deleted" otherwise). */
  messageExists: z.boolean(),
  createdAt: Iso,
  closedAt: Iso.nullable(),
  closedByName: z.string().nullable(),
  action: ReportAction.nullable(),
  note: z.string().nullable(),
  snapshot: ReportSnapshot.nullable(),
  /** Earlier reports about the same person (any status), so repeats are visible without the old snapshots. */
  earlier: z.number().int().nonnegative(),
});
export const ReportsResponse = z.object({ reports: z.array(Report), open: z.number().int().nonnegative() });

/** "Delete the member's messages of the last ..." (Discord's choice): one hour, one day, seven days. */
export const DELETE_RECENT_HOURS = [1, 24, 168] as const;
export const DeleteRecentHours = z.union([z.literal(1), z.literal(24), z.literal(168)]);
export const CloseReportRequest = z.object({ action: ReportAction, hours: DeleteRecentHours.optional(), note: z.string().max(REPORT_NOTE_MAX).optional() });

/** Retention (decision 3): a closed report's snapshot goes 30 days after closing, an open one's after 90 days; the row stays. */
export const REPORT_SNAPSHOT_CLOSED_DAYS = 30;
export const REPORT_SNAPSHOT_MAX_DAYS = 90;
/**
 * Row retention (4 October 2026, the Directory's rule, after the privacy policy named what a server keeps): an open report
 * nobody judged for REPORT_OPEN_MAX_DAYS is closed by the server as dismissed, with REPORT_CLOSED_BY_SYSTEM as the closer's
 * name (its snapshot is gone since day 90, so nothing is left to judge); a closed row goes REPORT_ROW_CLOSED_DAYS after closing.
 * The closer's name is a plain string so that older clients list such a report like any other.
 */
export const REPORT_OPEN_MAX_DAYS = 180;
export const REPORT_ROW_CLOSED_DAYS = 365;
export const REPORT_CLOSED_BY_SYSTEM = "system";
/** The moderation log is kept 180 days (decision 2). */
export const MOD_LOG_DAYS = 180;

export const ModLogAction = z.enum(["message_delete", "messages_delete_recent", "kick", "ban", "unban", "channel_block", "channel_unblock", "report_closed"]);
/** One line of the moderation log: who did what to whom, when, where; never message contents. */
export const ModLogEntry = z.object({
  id: Uuid,
  at: Iso,
  actorId: Uuid.nullable(),
  actorName: z.string(),
  targetUserId: Uuid.nullable(),
  targetName: z.string().nullable(),
  action: ModLogAction,
  channelId: Uuid.nullable(),
  channelName: z.string().nullable(),
  /** Small facts about the action: `count`, `hours`, `reason`, `minutes`, `reportId`, `result`. */
  detail: z.record(z.string(), z.unknown()).default({}),
});
export const ModLogResponse = z.object({ entries: z.array(ModLogEntry), hasMore: z.boolean() });

export type ReportKind = z.infer<typeof ReportKind>;
export type ReportStatus = z.infer<typeof ReportStatus>;
export type ReportAction = z.infer<typeof ReportAction>;
export type CreateReportRequest = z.infer<typeof CreateReportRequest>;
export type ReportSnapshot = z.infer<typeof ReportSnapshot>;
export type ReportAttachment = z.infer<typeof ReportAttachment>;
export type Report = z.infer<typeof Report>;
export type ReportsResponse = z.infer<typeof ReportsResponse>;
export type DeleteRecentHours = z.infer<typeof DeleteRecentHours>;
export type CloseReportRequest = z.infer<typeof CloseReportRequest>;
export type ModLogAction = z.infer<typeof ModLogAction>;
export type ModLogEntry = z.infer<typeof ModLogEntry>;
export type ModLogResponse = z.infer<typeof ModLogResponse>;
