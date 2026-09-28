import { Permission, displayNameOf, type RtcTokenResponse } from "@squorli/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { requireMember } from "../auth/session";
import { can } from "../authz";
import type { Config } from "../config";
import type { Db } from "../db";
import type { Doctor, RequestView } from "../doctor";
import { DOCTOR_ROOM_PREFIX } from "../livekit/admin";

/**
 * Setup self-diagnosis (docs/features/doctor.md): GET /api/doctor runs the server's checks and answers the report with texts in
 * both languages. Two callers: a member with MANAGE_SERVER (Verwaltung > Server, "Verbindung prüfen"), and `squorli doctor`,
 * which asks from inside the server container over the loopback address without a session. The loopback exception holds only
 * when the request comes from 127.0.0.1/::1 and carries no forwarding header at all (a proxy on the same machine forwards from
 * the Docker network, never from loopback; the dev Vite proxy is loopback, which is the developer's own machine).
 * An installation without containers (deploy/windows/) has its proxy on loopback, and with a proxy on another machine the
 * server does not listen on loopback at all: it sets DOCTOR_TOKEN, and `squorli doctor` sends that value instead
 * (`isLocalCaller`).
 * POST /api/doctor/rtc-token issues a token for the browser's media test (room `doctor-<userId>`, no channel).
 */
export async function registerDoctorRoutes(app: FastifyInstance, db: Db, config: Config, doctor: Doctor) {
  app.get("/api/doctor", async (req, reply) => {
    if (!req.headers.authorization && isLocalCaller(req, config.DOCTOR_TOKEN)) return doctor.run(null);
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const xff = req.headers["x-forwarded-for"];
    const view: RequestView = {
      hostname: req.hostname, protocol: req.protocol, ip: req.ip, remoteAddress: req.socket.remoteAddress ?? null,
      forwardedFor: Array.isArray(xff) ? xff.join(", ") : typeof xff === "string" ? xff : null,
    };
    return doctor.run(view);
  });

  /** A LiveKit token for the media test from the browser: its own room, microphone grant only (nothing is published), two minutes. */
  app.post("/api/doctor/rtc-token", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { identity: m.userId, name: displayNameOf(m), ttl: "2m" });
    at.addGrant({ roomJoin: true, room: `${DOCTOR_ROOM_PREFIX}${m.userId}`, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
    const res: RtcTokenResponse = { url: config.livekitPublicUrl, token: await at.toJwt() };
    return res;
  });
}

/**
 * `squorli doctor`, the caller without a session (tested). With a token configured only the token counts, from whatever
 * address; without one, loopback.
 */
export function isLocalCaller(req: Pick<FastifyRequest, "headers"> & { socket: { remoteAddress?: string | undefined } }, token: string | undefined): boolean {
  if (!token) return isLoopback(req);
  const given = req.headers["x-squorli-doctor"];
  if (typeof given !== "string" || !given) return false;
  // Hashes of the same length, so the comparison takes the same time whatever was sent.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

/** From this machine itself, not through any proxy (tested, and through the smoke test, which runs on localhost). */
export function isLoopback(req: Pick<FastifyRequest, "headers"> & { socket: { remoteAddress?: string | undefined } }): boolean {
  const remote = req.socket.remoteAddress;
  if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
  return !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-proto"] && !req.headers["x-real-ip"] && !req.headers.forwarded;
}
