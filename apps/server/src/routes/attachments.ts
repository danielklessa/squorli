import { Permission, type Attachment } from "@squorli/protocol";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { requireMember } from "../auth/session";
import { can } from "../authz";
import type { Config } from "../config";
import type { StorageMeter } from "../limits";
import type { Db } from "../db";
import { attachments } from "../db/schema";
import { visibility } from "../visibility";
import { attachmentUrl } from "./messages";
import { verifyAttachment } from "../attachmentLinks";

/**
 * Attachments: upload the file first (it gets an id), then attach it to a message via attachmentIds.
 * Storage: DATA_DIR/attachments/<id>, metadata in the DB. Download needs no token so that <img src> works, but a signed,
 * expiring link (attachmentLinks.ts, since 25 September 2026; like Discord's CDN links since 2024). Orphaned uploads
 * (never attached to a message) are deleted after an hour.
 */
/** Types a browser may show in place: raster pictures, video, audio, plain text, PDF. */
export const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|text\/plain|application\/pdf)$/;

export async function registerAttachmentRoutes(app: FastifyInstance, db: Db, config: Config, meter: StorageMeter) {
  const dir = join(config.DATA_DIR, "attachments");
  await mkdir(dir, { recursive: true });
  // @fastify/multipart is registered in index.ts (the server icon upload in settings.ts uses it too).

  app.post("/api/attachments", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    // Server-wide, or in any channel the member may see (an overwrite may be the only place they have it); the real gate
    // is the message that attaches the file (routes/messages.ts, in that channel).
    await visibility.refresh(db);
    if (!can(m.actor, Permission.ATTACH_FILES) && ![...visibility.masksOf(m.userId).values()].some((p) => can({ ...m.actor, permissions: p }, Permission.ATTACH_FILES))) return reply.code(403).send({ error: "forbidden" });
    // The storage quota (docs/features/limits.md): nothing is written once it is reached, and a file that would cross it
    // is thrown away after the upload (its size is only known then); 413 storage_full either way.
    if (!(await meter.room())) return reply.code(413).send({ error: "storage_full", quotaMb: config.STORAGE_QUOTA_MB });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: "no_file" });
    const name = (part.filename || "datei").replace(/[\\/\0]/g, "_").slice(0, 200);
    const [row] = await db.insert(attachments).values({ uploaderId: m.userId, name, size: 0, mimeType: part.mimetype || "application/octet-stream" }).returning();
    const path = join(dir, row!.id);
    try {
      await pipeline(part.file, createWriteStream(path));
      if (part.file.truncated) throw new Error("too_large");
    } catch (err) {
      await rm(path, { force: true });
      await db.delete(attachments).where(eq(attachments.id, row!.id));
      const tooLarge = err instanceof Error && (err.message === "too_large" || (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE");
      return reply.code(tooLarge ? 413 : 500).send({ error: tooLarge ? "too_large" : "upload_failed", maxMb: config.MAX_UPLOAD_MB });
    }
    const size = (await stat(path)).size;
    if (!(await meter.room(size))) {
      await rm(path, { force: true });
      await db.delete(attachments).where(eq(attachments.id, row!.id));
      return reply.code(413).send({ error: "storage_full", quotaMb: config.STORAGE_QUOTA_MB });
    }
    await db.update(attachments).set({ size }).where(eq(attachments.id, row!.id));
    meter.invalidate();
    const out: Attachment = { id: row!.id, name, size, mimeType: row!.mimeType, url: attachmentUrl({ id: row!.id, name }) };
    return out;
  });

  app.get<{ Params: { id: string; name: string }; Querystring: { e?: string; s?: string } }>("/api/attachments/:id/:name", async (req, reply) => {
    // An unsigned, foreign or expired link looks like a missing file: nothing tells whether the id exists.
    if (!verifyAttachment(req.params.id, req.query.e, req.query.s)) return reply.code(404).send({ error: "not_found" });
    const [row] = await db.select().from(attachments).where(eq(attachments.id, req.params.id)).limit(1);
    const path = row ? join(dir, row.id) : null;
    if (!row || !path || !existsSync(path)) return reply.code(404).send({ error: "not_found" });
    // The type is what the uploader's browser said. Shown in the browser only where that is harmless (security review of
    // 25 September 2026: an SVG opened on this origin ran its script and could read the key in localStorage); anything
    // else, SVG and HTML included, is a download. The sandbox keeps a document opened here from running script at all;
    // Chrome's PDF viewer does not work under it and runs its own script apart from this origin anyway.
    const inline = INLINE_TYPES.test(row.mimeType);
    if (row.mimeType !== "application/pdf") reply.header("content-security-policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply
      .type(row.mimeType)
      .header("content-length", row.size)
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(path));
  });

  // Cleanup: orphaned uploads and files of deleted messages.
  async function sweep() {
    const orphanBefore = new Date(Date.now() - 3_600_000);
    const orphans = await db.delete(attachments)
      .where(and(isNull(attachments.messageId), lt(attachments.createdAt, orphanBefore)))
      .returning({ id: attachments.id });
    for (const o of orphans) await rm(join(dir, o.id), { force: true });
  }
  const timer = setInterval(() => { void sweep().catch((err) => app.log.warn({ err }, "attachment sweep")); }, 15 * 60_000);
  app.addHook("onClose", async () => clearInterval(timer));

  app.decorate("attachmentsDir", dir);
  /** Called by messages.ts after a deletion so files do not linger. */
  app.decorate("removeAttachmentFiles", async (ids: string[]) => {
    for (const id of ids) await rm(join(dir, id), { force: true });
    if (ids.length) meter.invalidate();
  });
}

declare module "fastify" {
  interface FastifyInstance {
    removeAttachmentFiles: (ids: string[]) => Promise<void>;
    /** DATA_DIR/attachments (the reports copy files out of it, reports.ts). */
    attachmentsDir: string;
  }
}
