import { LogController, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Secrets that may ride in a query string and must not reach the request log (security review, 25 September 2026): the
 * status API's `key`, the signature `s` of an attachment link, the directory proof's `sig`. Their values become "***".
 */
const SECRET_PARAMS = new Set(["key", "s", "sig", "token"]);

export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const parts = url.slice(q + 1).split("&").map((part) => {
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep as is */ }
    return eq >= 0 && SECRET_PARAMS.has(decoded.toLowerCase()) ? `${name}=***` : part;
  });
  return `${url.slice(0, q)}?${parts.join("&")}`;
}

/** Fastify's request serializer with the query redacted (the fields of its default one). */
export function requestSerializer(req: FastifyRequest) {
  return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, ...(req.socket?.remotePort === undefined ? {} : { remotePort: req.socket.remotePort }) };
}

/** The same without the caller's address: what a request looks like in the log unless LOG_REQUESTS is on. */
export function requestSerializerWithoutAddress(req: FastifyRequest) {
  return { method: req.method, url: redactUrl(req.url), host: req.host };
}

/** Fastify's own "not found" line carries the raw URL; this one redacts it like the request serializer. */
class RedactingLogController extends LogController {
  routeNotFound(request: FastifyRequest) {
    if (this.isLogDisabled(request)) return;
    request.log.info(`Route ${request.raw.method}:${redactUrl(request.raw.url ?? "")} not found`);
  }
}

/**
 * Logging concept (docs/features/logging.md, 27 September 2026): by default no line per request, so the log holds no
 * address per visit; a request that ends in a server error (5xx) is still logged, without the address. LOG_REQUESTS=true
 * brings Fastify's full request log back (with addresses) for troubleshooting.
 */
class QuietLogController extends RedactingLogController {
  incomingRequest() { /* off */ }
  routeNotFound() { /* off: scanners would fill the log */ }
  requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply) {
    if (!error && reply.statusCode < 500) return;
    reply.log.warn({ req: request, res: reply, responseTime: reply.elapsedTime }, "request failed");
  }
}

/** The logger options for Fastify() from LOG_LEVEL and LOG_REQUESTS. */
export function logOptions(level: string, logRequests: boolean) {
  return {
    logger: { level, serializers: { req: logRequests ? requestSerializer : requestSerializerWithoutAddress } },
    logController: logRequests ? new RedactingLogController() : new QuietLogController(),
  };
}
