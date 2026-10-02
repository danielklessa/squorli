import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * The key an address counts under: an IPv4 address as it is, an IPv6 address by its /64 (one connection usually gets a whole
 * /64 and can rotate through it; security review, 25 September 2026). IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const bare = ip.split("%", 1)[0]!;
  if (!isIPv6(bare)) return ip;
  const [head = "", tail = ""] = bare.toLowerCase().split("::", 2);
  const h = head ? head.split(":") : [];
  const t = bare.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = bare.includes("::") ? [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Rate limits on every public path (25 September 2026, docs/PLAN.md 2.1; docs/features/rate-limits.md). One `onRequest` hook
 * counts before any route runs, so a refused request costs no database work: fixed windows per client IP (`ipKey`, behind
 * `TRUSTED_PROXIES`, `req.ip` is the real client) and per session token (hashed, never kept as is). The limits are generous
 * for a person and tight for a script; `RATE_LIMIT_FACTOR` scales all of them (0 switches them off, e.g. for load tests).
 * The routes of server accounts keep their own, stricter limits (auth/local.ts); slowmode stays per channel (messages.ts).
 */

/** Counting window per key: `limit` hits per `windowMs`, O(1) per hit. */
export class WindowCounter {
  private readonly windows = new Map<string, { start: number; n: number }>();
  constructor(readonly limit: number, readonly windowMs = 60_000) {}

  /** Count a hit; false (and the seconds until the window ends) once the limit is reached. */
  hit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, n: 0 };
      this.windows.set(key, w);
    }
    if (w.n >= this.limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) };
    w.n++;
    return { ok: true };
  }
  sweep(now = Date.now()) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
  get size() { return this.windows.size; }
}

type Rule = { name: string; counter: WindowCounter; by: "ip" | "token"; applies: (method: string, path: string) => boolean };

/** The limits at factor 1: hits per window. */
export const LIMITS = {
  /** Everything under /api per IP: many people behind one address (a household, a company, carrier NAT) share it. */
  ipAll: { limit: 1200, windowMs: 60_000 },
  /** Challenge + verify per IP: a sign-in costs two, so 30 sign-ins a minute; every fresh key asks the directory. */
  ipAuth: { limit: 60, windowMs: 60_000 },
  /** Opening the WebSocket per IP (each reconnect is one). */
  ipWs: { limit: 60, windowMs: 60_000 },
  /** The public invite preview per IP. */
  ipInvite: { limit: 30, windowMs: 60_000 },
  /** The status API per IP (it caches for a second anyway). */
  ipStatus: { limit: 60, windowMs: 60_000 },
  /** The setup check per IP (GET /api/doctor): every run opens connections to the server's own address and the directory. */
  ipDoctor: { limit: 10, windowMs: 60_000 },
  /** The directory's pushes (notify, leave) per IP: they carry no proof and each one makes this server ask the directory. */
  ipDirectoryPush: { limit: 120, windowMs: 60_000 },
  /** Every writing request per session. */
  tokenWrite: { limit: 180, windowMs: 60_000 },
  /** Messages per session, over all channels. */
  tokenMessages: { limit: 15, windowMs: 10_000 },
  /** Reports per session (docs/features/reports.md): a person reports a few things, a script would flood the queue. */
  tokenReports: { limit: 10, windowMs: 3_600_000 },
  /** Uploads per session (attachments and the server account's avatar). */
  tokenUploads: { limit: 30, windowMs: 60_000 },
  /** Events on one WebSocket (typing, activity, voice state, ping). */
  wsEvents: { limit: 60, windowMs: 10_000 },
} as const;

const scaled = (l: { limit: number; windowMs: number }, factor: number) => new WindowCounter(Math.max(1, Math.round(l.limit * factor)), l.windowMs);
const isWrite = (m: string) => m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";

/** The session token of a request, hashed (the key must not be the secret itself). */
function tokenKey(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return createHash("sha256").update(h.slice(7)).digest("base64url").slice(0, 22);
}

export function buildRules(factor: number): Rule[] {
  const r = (name: keyof typeof LIMITS, by: Rule["by"], applies: Rule["applies"]): Rule => ({ name, counter: scaled(LIMITS[name], factor), by, applies });
  return [
    r("ipAll", "ip", () => true),
    r("ipAuth", "ip", (m, p) => m === "POST" && (p === "/api/auth/challenge" || p === "/api/auth/verify")),
    r("ipWs", "ip", (m, p) => m === "GET" && p === "/api/ws"),
    r("ipInvite", "ip", (m, p) => m === "GET" && p.startsWith("/api/invites/")),
    r("ipStatus", "ip", (m, p) => m === "GET" && p === "/api/status"),
    r("ipDoctor", "ip", (m, p) => m === "GET" && p === "/api/doctor"),
    r("ipDirectoryPush", "ip", (m, p) => m === "POST" && (p === "/api/directory/notify" || p === "/api/directory/leave")),
    r("tokenWrite", "token", (m) => isWrite(m)),
    r("tokenMessages", "token", (m, p) => m === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(p)),
    r("tokenReports", "token", (m, p) => m === "POST" && p === "/api/reports"),
    r("tokenUploads", "token", (m, p) => (m === "POST" && p === "/api/attachments") || (m === "PUT" && p === "/api/me/avatar")),
  ];
}

/**
 * The path the rules compare: the pattern of the route the router matched (`/api/channels/:id/messages`), else the decoded
 * path. Never the raw URL: the router decodes `%61` to `a` before it matches, so `/%61pi/auth/verify` reached the route
 * while the raw path did not start with `/api/`, and no limit counted it (security audit, 2 October 2026, S1). The pattern
 * also covers whatever else the router forgives on the way (a trailing slash, an encoded letter in the middle).
 */
export function limitPath(route: string | undefined, url: string): string {
  if (route?.startsWith("/api/")) return route;
  const raw = url.split("?", 1)[0] ?? "";
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Register the hook. Returns a counter for WebSocket events, or null when the limits are off. */
export function registerRateLimits(app: FastifyInstance, factor: number): (() => WindowCounter) | null {
  if (!(factor > 0)) {
    app.log.warn("RATE_LIMIT_FACTOR=0: keine Rate-Limits");
    return null;
  }
  const rules = buildRules(factor);
  const sweeper = setInterval(() => { for (const rule of rules) rule.counter.sweep(); }, 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));
  app.addHook("onRequest", async (req, reply) => {
    const path = limitPath(req.routeOptions.url, req.url);
    if (!path.startsWith("/api/")) return;
    let token: string | null | undefined;
    for (const rule of rules) {
      if (!rule.applies(req.method, path)) continue;
      let key: string;
      if (rule.by === "ip") key = ipKey(req.ip);
      else {
        if (token === undefined) token = tokenKey(req);
        if (!token) continue; // without a token the route refuses anyway; the IP rules still count it
        key = token;
      }
      const res = rule.counter.hit(key);
      if (!res.ok) {
        req.log.warn({ rule: rule.name, ip: req.ip, path }, "Rate-Limit erreicht");
        return reply.code(429).header("retry-after", String(res.retryAfter)).send({ error: "rate_limited", retryAfter: res.retryAfter });
      }
    }
  });
  const ws = LIMITS.wsEvents;
  return () => scaled(ws, factor);
}
