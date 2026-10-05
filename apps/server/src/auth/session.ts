import { DEVICE_PROOF_REQUIRED, DEVICE_REFUSED, SESSION_PROOF_HEADER, SESSION_PROOF_MAX_SKEW_MS, deviceProofMessage, parseSessionProofHeader, sessionProofMessage, type SessionProof } from "@squorli/protocol";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "../authz";
import type { Db } from "../db";
import { localAccounts, localDevices, sessions, users } from "../db/schema";
import { actorOf, refusesSuspended } from "../state";
import { deviceAllowed } from "../users/devices";
import { isSuspendedNow, refusedUntil, suspendedBody } from "../users/suspension";

/**
 * `deviceKey`: the key of the device that signed in (docs/features/devices.md), null for a session without one. `deviceBound`:
 * the session works only with that device's fresh proof on every request and hello (`sessionProofProblem`, 4 October 2026).
 */
export type SessionUser = { userId: string; sessionId: string; publicKey: string; displayName: string | null; handle: string | null; handleCheckedAt: Date | null; avatarUrl: string | null; localHandle: string | null; localAvatarAt: Date | null; expiresAt: Date; suspendedUntil: Date | null; deviceKey: string | null; deviceBound: boolean };

/** Write last_used_at at most every 5 minutes (device list, M6c); not on every request. The socket's pings touch it the same way. */
export const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * The session policy (4 October 2026, security audit S10, measure 3.4), set once at the start from the configuration:
 * `idleMs` = a session that was not used for this long is over before its TTL (SESSION_IDLE_DAYS, 0 = off); `domain` =
 * PUBLIC_DOMAIN without a port, one of the two hosts a session proof may name (the other is the request's own host).
 */
let policy: { idleMs: number; domain: string | null } = { idleMs: 14 * 86_400_000, domain: null };
const hostOnly = (host: string): string => host.toLowerCase().replace(/:\d+$/, "");
export function setSessionPolicy(p: { idleDays: number; domain: string }): void {
  policy = { idleMs: p.idleDays * 86_400_000, domain: hostOnly(p.domain) };
}
/** Whether a session with these marks is over for want of use (pure). */
export const sessionIdle = (lastUsedAt: Date | null, createdAt: Date, now: number, idleMs = policy.idleMs): boolean => idleMs > 0 && now - (lastUsedAt ?? createdAt).getTime() > idleMs;

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32 bytes follow it. Node's own verify: a check per request must be cheap. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function deviceSignatureOk(deviceKey: string, signature: string, message: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(deviceKey, "hex")]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
/**
 * What is wrong with a bound session's proof, or null when it is good: `missing`, `stale` (the client's clock is more than
 * SESSION_PROOF_MAX_SKEW_MS off, or the proof is old), `domain` (neither PUBLIC_DOMAIN nor the host this request came in
 * on), `signature`. `method`/`path`: of this request (`WS`, `/api/ws` for the hello), the path without its query.
 * `bodyHash`: the SHA-256 (hex) of this request's JSON body as received (`bodyHash.ts`), "" without one; a version 2
 * proof (`proof.v2`, 5 October 2026, security audit L-6) signs it, a version 1 proof is checked as before.
 */
export function sessionProofProblem(proof: SessionProof | null, session: { publicKey: string; deviceKey: string | null }, method: string, path: string, requestHost: string, now = Date.now(), bodyHash = ""): string | null {
  if (!proof) return "missing";
  if (!session.deviceKey) return "signature";
  if (Math.abs(now - proof.at) > SESSION_PROOF_MAX_SKEW_MS) return "stale";
  const domain = proof.domain.toLowerCase();
  if (domain !== policy.domain && domain !== hostOnly(requestHost)) return "domain";
  const message = deviceProofMessage(session.publicKey, proof.v2 ? sessionProofMessage(domain, proof.at, method, path, bodyHash) : sessionProofMessage(domain, proof.at, method, path));
  return deviceSignatureOk(session.deviceKey, proof.signature, message) ? null : "signature";
}
const pathOf = (url: string): string => url.split("?")[0] ?? url;

/**
 * What the database keeps of a session token: its SHA-256 (hex), never the token (security review, 25 September 2026,
 * migration 0034). The token is 32 random bytes, so a plain hash is enough; reading the table gives no usable session.
 */
export const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/**
 * The user behind a session token, or why there is none. `refused`: the session exists, but its device is not let in any
 * more (docs/features/devices.md: it was signed out, or the account lets only enrolled devices in and this session has
 * none); its row is removed here. Every way in passes this lookup, so a session of a device that was signed out is worth
 * nothing from the moment this server knows of it, whatever else still has to be closed.
 */
export async function lookUpSession(db: Db, rawToken: string): Promise<{ session: SessionUser | null; refused: boolean }> {
  const token = tokenHash(rawToken);
  const [row] = await db
    .select({
      userId: sessions.userId, sessionId: sessions.id, expiresAt: sessions.expiresAt, lastUsedAt: sessions.lastUsedAt, createdAt: sessions.createdAt, deviceKey: sessions.deviceKey, deviceBound: sessions.deviceBound,
      publicKey: users.publicKey, displayName: users.displayName, handle: users.handle, handleCheckedAt: users.handleCheckedAt, avatarUrl: users.avatarUrl, suspendedUntil: users.suspendedUntil,
      devicesEnforced: users.devicesEnforced, deviceKeys: users.deviceKeys,
      localHandle: localAccounts.handle, localAvatarAt: localAccounts.avatarUpdatedAt, localEnforcedAt: localAccounts.devicesEnforcedAt,
      localDeviceId: localDevices.id, localDeviceRevokedAt: localDevices.revokedAt, localDeviceSeenAt: localDevices.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(localAccounts, eq(localAccounts.userId, sessions.userId))
    .leftJoin(localDevices, and(eq(localDevices.userId, sessions.userId), eq(localDevices.deviceKey, sessions.deviceKey)))
    .where(eq(sessions.token, token))
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) return { session: null, refused: false };
  // Not used for SESSION_IDLE_DAYS (security audit S10): over, like one past its TTL; the row goes.
  if (sessionIdle(row.lastUsedAt, row.createdAt, Date.now())) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return { session: null, refused: false };
  }
  const allowed = deviceAllowed({
    handle: row.handle, localHandle: row.localHandle, devicesEnforced: row.devicesEnforced, deviceKeys: row.deviceKeys,
    localEnforced: row.localEnforcedAt !== null, localDevice: row.localDeviceId === null ? null : row.localDeviceRevokedAt === null ? "active" : "revoked",
  }, row.deviceKey);
  if (!allowed) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return { session: null, refused: true };
  }
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    void db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.token, token)).catch(() => { /* display only, no reason to abort */ });
    // The device of a server account counts as used with its session (the sweep signs out what was not used for 90 days).
    if (row.localDeviceId) void db.update(localDevices).set({ lastSeenAt: new Date() }).where(eq(localDevices.id, row.localDeviceId)).catch(() => { /* display only */ });
  }
  return { refused: false, session: { userId: row.userId, sessionId: row.sessionId, publicKey: row.publicKey, displayName: row.displayName, handle: row.handle, handleCheckedAt: row.handleCheckedAt, avatarUrl: row.avatarUrl, localHandle: row.localHandle, localAvatarAt: row.localAvatarAt, expiresAt: row.expiresAt, suspendedUntil: row.suspendedUntil, deviceKey: row.deviceKey, deviceBound: row.deviceBound } };
}
/** A session counts as used (the socket's pings, at most every TOUCH_INTERVAL_MS by the caller). */
export async function touchSession(db: Db, sessionId: string): Promise<void> {
  await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, sessionId));
}
/** Rows past their TTL or idle for longer than the policy allows go (hourly and at start); answers how many. */
export async function sweepSessions(db: Db, now = new Date()): Promise<number> {
  // The cutoff as text with a cast: a Date bound against an expression (not a column) is not mapped by the driver.
  const idle = policy.idleMs > 0 ? sql`coalesce(${sessions.lastUsedAt}, ${sessions.createdAt}) < ${new Date(now.getTime() - policy.idleMs).toISOString()}::timestamptz` : undefined;
  const gone = await db.delete(sessions).where(or(lt(sessions.expiresAt, now), idle)).returning({ id: sessions.id });
  return gone.length;
}
/** Used by the WS handshake and by protected routes. Returns the user behind a session token. */
export async function resolveSession(db: Db, rawToken: string): Promise<SessionUser | null> {
  return (await lookUpSession(db, rawToken)).session;
}

/**
 * The end of the suspension this session's user is refused for, or null (users/suspension.ts). The switch is only read
 * for a user whose suspension lies ahead, so an ordinary request costs nothing more.
 */
export async function suspensionOf(db: Db, s: SessionUser): Promise<Date | null> {
  if (!isSuspendedNow(s.suspendedUntil)) return null;
  return refusedUntil(s, await refusesSuspended(db));
}

function bearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

/**
 * Bearer token from the Authorization header; sends a 401 itself if nothing valid is present, and 403 `account_suspended`
 * with the date for a directory account the directory's operator suspended (the session stays: it works again afterwards).
 * A session whose device is not let in any more answers 401 `device_refused` (once: its row is gone afterwards). A bound
 * session without the device's proof over this request answers 401 `device_proof_required` (`why`, `serverTime`).
 */
export async function requireSession(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  const token = bearer(req);
  const { session, refused } = token ? await lookUpSession(db, token) : { session: null, refused: false };
  if (!session) {
    await reply.code(401).send({ error: refused ? DEVICE_REFUSED : "unauthorized" });
    return null;
  }
  // A bound session (security audit S10): the device's fresh proof over this very request, or 401 with the reason and our clock.
  if (session.deviceBound) {
    const why = sessionProofProblem(parseSessionProofHeader(req.headers[SESSION_PROOF_HEADER]), session, req.method, pathOf(req.url), req.hostname, Date.now(), req.bodyHash ?? "");
    if (why) {
      await reply.code(401).send({ error: DEVICE_PROOF_REQUIRED, why, serverTime: new Date().toISOString() });
      return null;
    }
  }
  const until = await suspensionOf(db, session);
  if (until) {
    await reply.code(403).send(suspendedBody(until));
    return null;
  }
  return session;
}

export type MemberContext = SessionUser & { actor: Actor };

/** WebSocket close code for a member who must register before connecting (docs/features/local-accounts.md). */
export const CLOSE_REGISTRATION_REQUIRED = 4013;

/** No temporary users (docs/features/local-accounts.md): a key needs a directory handle or a server account. */
export const hasAccount = (u: { handle: string | null; localHandle: string | null }) => !!u.handle || !!u.localHandle;

/**
 * Like requireSession, plus membership and permissions. 403 not_member if kicked/banned, 403 registration_required for a member
 * from before server accounts who has no account yet (only GET /api/me and POST /api/local/claim work for them).
 */
export async function requireMember(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<MemberContext | null> {
  const s = await requireSession(db, req, reply);
  if (!s) return null;
  if (!hasAccount(s)) {
    await reply.code(403).send({ error: "registration_required" });
    return null;
  }
  const actor = await actorOf(db, s.userId);
  if (!actor) {
    await reply.code(403).send({ error: "not_member" });
    return null;
  }
  return { ...s, actor };
}
