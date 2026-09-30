import { Permission, type LimitsReport } from "@squorli/protocol";
import { count } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../auth/session";
import { can } from "../authz";
import type { Config } from "../config";
import type { Db } from "../db";
import { members } from "../db/schema";
import { seatsTaken, type StorageMeter } from "../limits";
import type { LivekitAdmin } from "../livekit/admin";
import type { VoicePresence } from "../voice/presence";

/**
 * GET /api/settings/limits (MANAGE_SERVER; docs/features/limits.md): the operator limits and what is in use against them,
 * for Verwaltung > Server. Fetched only there, never part of the settings every member gets: the storage total walks the
 * data folder (StorageMeter caches it for a moment).
 */
export async function registerLimitsRoutes(app: FastifyInstance, db: Db, config: Config, meter: StorageMeter, presence: VoicePresence<unknown>, lk: LivekitAdmin) {
  app.get("/api/settings/limits", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const [usedBytes, rooms, [mc]] = await Promise.all([meter.used(), lk.roomsByIdentity(), db.select({ n: count() }).from(members)]);
    const report: LimitsReport = {
      storage: { usedBytes, quotaMb: config.STORAGE_QUOTA_MB ?? null },
      voiceSeats: { used: seatsTaken(presence.seated(), rooms), max: config.VOICE_SEATS_MAX ?? null },
      members: { count: mc?.n ?? 0, max: config.MEMBER_MAX ?? null },
      maxUploadMb: config.MAX_UPLOAD_MB,
      dbPoolMax: config.DB_POOL_MAX,
    };
    return report;
  });
}
