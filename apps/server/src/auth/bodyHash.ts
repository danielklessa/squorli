import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";

declare module "fastify" {
  interface FastifyRequest {
    /** The SHA-256 (hex) of a JSON body's bytes as received; undefined without one (bodyHash.ts). */
    bodyHash?: string;
  }
}

/**
 * Hashes every JSON body as it arrives, before anything parses it (5 October 2026, security audit L-6): a bound
 * session's proof of version 2 signs this hash (`auth/session.ts` `sessionProofProblem`), so a captured proof fits no
 * other body. Only `application/json`: a multipart body's bytes are shaped by the sender's boundary, which the client
 * cannot hash before it sends, so uploads sign method and path alone (the hash is "" on both sides). A request without a
 * body never reaches the hook. Fastify asks for `receivedEncodedLength` on the stream a preParsing hook hands back, to
 * match it against Content-Length as it would the original.
 */
export function registerBodyHash(app: FastifyInstance): void {
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return payload;
    const hash = createHash("sha256");
    let received = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        received += chunk.length;
        (tap as { receivedEncodedLength?: number }).receivedEncodedLength = received;
        done(null, chunk);
      },
      flush(done) {
        req.bodyHash = hash.digest("hex");
        done();
      },
    });
    (tap as { receivedEncodedLength?: number }).receivedEncodedLength = 0;
    payload.on("error", (err) => tap.destroy(err));
    return payload.pipe(tap);
  });
}
