import type { FastifyInstance } from "fastify";

/**
 * GET /api/ready (docs/features/limits.md, 30 September 2026): 200 only while the database answers, else 503. What a
 * scheduler or a proxy asks before it routes anything here; `/api/health` keeps answering `ok: true` on a database error
 * on purpose (the login page reads name, icon and version from it and must not vanish with the database). `ping` is
 * one round trip to the database; it counts as down when it throws or takes longer than `timeoutMs`.
 */
export function registerReadyRoute(app: FastifyInstance, ping: () => Promise<unknown>, timeoutMs = 3000): void {
  app.get("/api/ready", async (_req, reply) => {
    const started = Date.now();
    try {
      await Promise.race([ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.())]);
      return { ok: true, database: "up", ms: Date.now() - started };
    } catch (err) {
      return reply.code(503).header("cache-control", "no-store").send({ ok: false, database: "down", error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  });
}
