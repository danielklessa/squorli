import type { FastifyError, FastifyInstance } from "fastify";
import { HSTS, wantsHsts } from "./webHeaders";

/**
 * Two things every answer of the server gets (security audit, 2 October 2026, S11):
 * - HSTS when the request arrived over https and the host is not `localhost` (`wantsHsts`), nosniff where a route does not
 *   name it itself (the attachments do);
 * - a server error (5xx) answers `{ "error": "internal" }` and nothing of the error: Fastify's default sends the message,
 *   which for a database error names tables and columns. The error goes to the log. Client errors (4xx: a body that does
 *   not parse, a file that is too large) keep Fastify's own answer.
 */
export function registerHardening(app: FastifyInstance, publicDomain: string): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (wantsHsts(publicDomain, req.protocol) && !reply.hasHeader("strict-transport-security")) reply.header("strict-transport-security", HSTS);
    if (!reply.hasHeader("x-content-type-options")) reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, "Fehler bei der Anfrage");
      return reply.code(status).send({ error: "internal" });
    }
    return reply.send(err);
  });
}
