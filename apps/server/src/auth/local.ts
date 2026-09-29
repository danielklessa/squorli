import {
  AVATAR_MAX_BYTES, BackupParams, LocalAvatarRequest, LocalBackupFetchRequest, LocalClaimRequest, LocalDeleteRequest, LocalHandle,
  LocalPasswordChangeRequest, LocalRegisterRequest, Uuid, localRegisterMessage, sniffAvatarMime, type LocalBackup, type LocalBackupBlob,
  localClaimMessage,
  LocalDeviceRevokeRequest, deviceEnrolMessage, labelFromUserAgent, type DevicesResponse, type TooManyDevicesResponse,
} from "@squorli/protocol";
import { eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import type { Db } from "../db";
import { localAccounts, members, sessions, users } from "../db/schema";
import type { DirectoryClient } from "../directory";
import type { Hub } from "../hub";
import { broadcastStructure, loadSettings } from "../state";
import { deleteUserAccount } from "../users/deleteUser";
import type { VoicePresence } from "../voice/presence";
import { ipKey } from "../rateLimits";
import { replaceFile } from "../replaceFile";
import { ChallengeStore, RateLimiter } from "./challenges";
import { deviceSignatureValid, type Devices } from "../users/devices";
import { admit, checkChallenge, checkDeviceProof, isFirstEver, originOf, ownerCodeMatches, signatureValid } from "./routes";
import { hasAccount, requireMember, requireSession } from "./session";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Postgres unique violation (the handle was taken between the check and the insert). */
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "23505";

/** What gets stored of a client-made backup: the password never arrives, only the SHA-256 of the auth key. */
const stored = (b: LocalBackup) => ({ backupParams: b.params, ciphertext: b.ciphertext, authHash: sha256(b.authKey), updatedAt: new Date() });

/**
 * Server accounts (`~name`, docs/features/local-accounts.md, 25 September 2026): registration, the key backup for signing in on
 * other devices, password change, deletion and the account's avatar. Modelled on the directory's backup routes.
 */
export async function registerLocalAccountRoutes(
  app: FastifyInstance, db: Db, config: Config, hub: Hub, directory: DirectoryClient, presence: VoicePresence, challenges: ChallengeStore, devices: Devices,
) {
  const registerByIp = new RateLimiter(20);
  const paramsByIp = new RateLimiter(30);
  const fetchByIp = new RateLimiter(10);
  const fetchByHandle = new RateLimiter(10);
  // Password checks behind a session (change, deletion): per account as well, over an hour, so a stolen session guesses
  // slowly from any number of addresses.
  const passwordByUser = new RateLimiter(10, 60 * 60_000);
  const sweeper = setInterval(() => { for (const l of [registerByIp, paramsByIp, fetchByIp, fetchByHandle, passwordByUser]) l.sweep(); }, 60_000);
  app.addHook("onClose", async () => clearInterval(sweeper));
  const avatarDir = join(config.DATA_DIR, "avatars");
  const avatarPath = (userId: string) => join(avatarDir, userId);
  const allowed = async () => (await loadSettings(db)).localAccounts === true;
  // An avatar whose file is gone (the data folder emptied) must not leave a broken image: forget it, like the server icon.
  for (const r of await db.select({ userId: localAccounts.userId }).from(localAccounts).where(isNotNull(localAccounts.avatarMime))) {
    if (!existsSync(avatarPath(r.userId))) await db.update(localAccounts).set({ avatarMime: null, avatarUpdatedAt: null }).where(eq(localAccounts.userId, r.userId));
  }
  const handleFree = async (handle: string) => !(await db.select({ u: localAccounts.userId }).from(localAccounts).where(eq(localAccounts.handle, handle)).limit(1))[0];

  /**
   * Count a password attempt before anything is awaited (parallel requests must not all pass one check); false = refused.
   * The caller gives the attempt back with `refundPassword` when the password was right.
   */
  const attemptPassword = (ip: string, account: { handle?: string; userId?: string }) => {
    if (!fetchByIp.attempt(ipKey(ip))) return false;
    if (account.handle !== undefined ? fetchByHandle.attempt(account.handle) : passwordByUser.attempt(account.userId!)) return true;
    fetchByIp.refund(ipKey(ip));
    return false;
  };
  const refundPassword = (ip: string, account: { handle?: string; userId?: string }) => {
    fetchByIp.refund(ipKey(ip));
    if (account.handle !== undefined) fetchByHandle.refund(account.handle); else passwordByUser.refund(account.userId!);
  };

  app.get<{ Params: { handle: string } }>("/api/local/handles/:handle", async (req, reply) => {
    if (!paramsByIp.allow(ipKey(req.ip))) return reply.code(429).send({ error: "rate_limited" });
    const h = LocalHandle.safeParse(req.params.handle.replace(/^~/, ""));
    if (!h.success) return reply.code(400).send({ error: "bad_handle" });
    return { available: await handleFree(h.data) };
  });

  // A key registers a server account and signs in with it (the answer is the one of /api/auth/verify). The client makes a fresh
  // key per server account; a member from before without any account may register the key they had as well.
  app.post("/api/local/register", async (req, reply) => {
    if (!registerByIp.allow(ipKey(req.ip))) return reply.code(429).send({ error: "rate_limited" });
    const body = LocalRegisterRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", detail: body.error.issues[0]?.message ?? null });
    const { challengeId, publicKey, signature, handle, backup, invite, ownerCode } = body.data;
    // The owner's setup code (OWNER_SETUP_CODE): a wrong one, or one after the owner exists, is said as such; the right one
    // opens the registration even where server accounts are off, until the owner exists.
    if (ownerCode !== undefined && (!ownerCodeMatches(config, ownerCode) || !(await isFirstEver(db, config, publicKey, ownerCode)))) return reply.code(403).send({ error: "owner_code_invalid" });
    if (ownerCode === undefined && !(await allowed())) return reply.code(403).send({ error: "local_accounts_off" });
    const nonce = await checkChallenge(challenges, config, reply, challengeId, publicKey, signature, (domain, n) => localRegisterMessage(domain, n, handle, backup.ciphertext));
    if (!nonce) return;
    // The account's first device (docs/features/devices.md) proves itself over the same message.
    const deviceKey = await checkDeviceProof(reply, publicKey, body.data, localRegisterMessage(config.PUBLIC_DOMAIN, nonce, handle, backup.ciphertext));
    if (deviceKey === false) return;

    const [existing] = await db.select({ id: users.id, handle: users.handle, localHandle: localAccounts.handle }).from(users)
      .leftJoin(localAccounts, eq(localAccounts.userId, users.id)).where(eq(users.publicKey, publicKey)).limit(1);
    if (existing && hasAccount(existing)) return reply.code(409).send({ error: "has_account" });
    if (!(await handleFree(handle))) return reply.code(409).send({ error: "handle_taken" });
    const [user] = await db.insert(users).values({ publicKey }).onConflictDoUpdate({ target: users.publicKey, set: { lastSeenAt: new Date() } }).returning();
    if (!user) return reply.code(500).send({ error: "user_upsert_failed" });
    try {
      await db.insert(localAccounts).values({ userId: user.id, handle, ...stored(backup) });
    } catch (err) {
      if (!existing) await db.delete(users).where(eq(users.id, user.id));
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "handle_taken" });
      throw err;
    }
    const res = await admit(db, config, hub, directory, req, reply, user, invite, false, null, ownerCode, deviceKey);
    if (!res) {
      // Refused (invite, ban): no account stays behind that would hold the handle.
      await db.delete(localAccounts).where(eq(localAccounts.userId, user.id));
      if (!existing) await db.delete(users).where(eq(users.id, user.id));
      return;
    }
    if (deviceKey) await devices.enrolLocal(user.id, { deviceKey, label: labelFromUserAgent(req.headers["user-agent"]), origin: originOf(req), by: "register" }, { strict: false, reactivate: true });
    req.log.info({ userId: user.id, handle, device: deviceKey !== null }, "Serverkonto registriert");
    await broadcastStructure(db, hub, ["members"]);
    return res;
  });

  // A member from before server accounts (signed in, `registrationRequired`) registers a server account on a fresh key, and
  // the membership moves to it (docs/features/local-accounts.md, "Claim on a fresh key"): both keys sign, the old one through
  // a challenge requested for it. The old key (often the main identity) never reaches this server.
  app.post("/api/local/claim", async (req, reply) => {
    if (!registerByIp.allow(ipKey(req.ip))) return reply.code(429).send({ error: "rate_limited" });
    const s = await requireSession(db, req, reply);
    if (!s) return;
    const body = LocalClaimRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", detail: body.error.issues[0]?.message ?? null });
    if (hasAccount(s)) return reply.code(409).send({ error: "has_account" });
    const [member] = await db.select({ userId: members.userId }).from(members).where(eq(members.userId, s.userId)).limit(1);
    if (!member) return reply.code(403).send({ error: "not_member" });
    if (!(await allowed())) return reply.code(403).send({ error: "local_accounts_off" });
    const { handle, backup, challengeId, newPublicKey, signature, newSignature } = body.data;
    const message = (domain: string, nonce: string) => localClaimMessage(domain, nonce, handle, newPublicKey, backup.ciphertext);
    const nonce = await checkChallenge(challenges, config, reply, challengeId, s.publicKey, signature, message);
    if (!nonce) return;
    if (!(await signatureValid(newPublicKey, newSignature, message(config.PUBLIC_DOMAIN, nonce)))) return reply.code(401).send({ error: "signature_invalid" });
    // The new account's first device (docs/features/devices.md): its proof is bound to the NEW key.
    const deviceKey = await checkDeviceProof(reply, newPublicKey, body.data, message(config.PUBLIC_DOMAIN, nonce));
    if (deviceKey === false) return;
    if (!(await handleFree(handle))) return reply.code(409).send({ error: "handle_taken" });
    try {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ publicKey: newPublicKey, handle: null, handleCheckedAt: null }).where(eq(users.id, s.userId));
        await tx.insert(localAccounts).values({ userId: s.userId, handle, ...stored(backup) });
      });
    } catch (err) {
      // The handle, or the new key already belongs to somebody here.
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "handle_taken" });
      throw err;
    }
    // The session that stays is that device's from now on.
    if (deviceKey) {
      await devices.enrolLocal(s.userId, { deviceKey, label: labelFromUserAgent(req.headers["user-agent"]), origin: originOf(req), by: "claim" }, { strict: false, reactivate: true });
      await db.update(sessions).set({ deviceKey }).where(eq(sessions.id, s.sessionId));
    }
    presence.rename(s.userId, { displayName: s.displayName, publicKey: newPublicKey, handle: null, localHandle: handle });
    await broadcastStructure(db, hub, ["members"]);
    req.log.info({ userId: s.userId, handle }, "Serverkonto nachregistriert, auf einen neuen Schluessel umgezogen");
    return { ok: true, localHandle: handle };
  });

  // Signing in on another device, step 1: salt and iterations (without the iv) so the client can derive the auth key.
  app.get<{ Params: { handle: string } }>("/api/local/backup/:handle/params", async (req, reply) => {
    if (!paramsByIp.allow(ipKey(req.ip))) return reply.code(429).send({ error: "rate_limited" });
    const h = LocalHandle.safeParse(req.params.handle.replace(/^~/, ""));
    if (!h.success) return reply.code(400).send({ error: "bad_handle" });
    const [row] = await db.select({ params: localAccounts.backupParams }).from(localAccounts).where(eq(localAccounts.handle, h.data)).limit(1);
    if (!row) return reply.code(404).send({ error: "unknown_account" });
    const p = BackupParams.parse(row.params);
    // `bound` goes along (29 September 2026): without it a client derives the keys of a backup that is bound to this server's
    // host as if it were not, and the right password reads as a wrong one on every other device (found with two browsers,
    // docs/features/devices.md; every server account made since 25 September 2026 has a bound backup).
    return { kdf: p.kdf, iterations: p.iterations, salt: p.salt, ...(p.bound ? { bound: true as const } : {}) };
  });

  // Step 2: the ciphertext for the auth key. A wrong key = a wrong password; failures count per IP and per handle.
  app.post("/api/local/backup/fetch", async (req, reply) => {
    const body = LocalBackupFetchRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const account = { handle: body.data.handle };
    if (!attemptPassword(req.ip, account)) return reply.code(429).send({ error: "rate_limited" });
    const [row] = await db.select({ la: localAccounts, publicKey: users.publicKey }).from(localAccounts)
      .innerJoin(users, eq(users.id, localAccounts.userId)).where(eq(localAccounts.handle, body.data.handle)).limit(1);
    if (!row) return reply.code(404).send({ error: "unknown_account" });
    if (!sameHash(sha256(body.data.authKey), row.la.authHash)) {
      req.log.warn({ handle: row.la.handle, ip: req.ip }, "Serverkonto: Abruf mit falschem Passwort");
      return reply.code(401).send({ error: "auth_invalid" });
    }
    refundPassword(req.ip, account);
    // The password is proven: the asking device is enrolled (docs/features/devices.md). It proves that it holds the key
    // it names; at the limit the answer is the list of devices and no key, and the request comes again with the one that
    // makes way.
    const { deviceKey, deviceSignature } = body.data;
    if (deviceKey !== undefined) {
      if (deviceSignature === undefined || !(await deviceSignatureValid(deviceKey, deviceSignature, deviceEnrolMessage(config.PUBLIC_DOMAIN, row.la.handle, deviceKey)))) return reply.code(401).send({ error: "device_signature_invalid" });
      const r = await devices.enrolLocal(row.la.userId, { deviceKey, label: labelFromUserAgent(req.headers["user-agent"]), origin: originOf(req), by: "password" }, { strict: true, replace: body.data.replaceDevice, reactivate: true });
      if (r && !r.ok) {
        const full: TooManyDevicesResponse = { error: "too_many_devices", devices: r.devices, ticket: null };
        return reply.code(409).send(full);
      }
    }
    const blob: LocalBackupBlob = { handle: row.la.handle, publicKey: row.publicKey, ciphertext: row.la.ciphertext, params: BackupParams.parse(row.la.backupParams), updatedAt: row.la.updatedAt.toISOString() };
    return blob;
  });

  // Change the password: a new backup of the same seed, proved by the old password's auth key (a stolen session alone is not enough).
  app.put("/api/local/backup", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    const body = LocalPasswordChangeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const account = { userId: s.userId };
    if (!attemptPassword(req.ip, account)) return reply.code(429).send({ error: "rate_limited" });
    const [row] = await db.select({ authHash: localAccounts.authHash }).from(localAccounts).where(eq(localAccounts.userId, s.userId)).limit(1);
    if (!row) return reply.code(404).send({ error: "unknown_account" });
    if (!sameHash(sha256(body.data.oldAuthKey), row.authHash)) return reply.code(401).send({ error: "auth_invalid" });
    refundPassword(req.ip, account);
    await db.update(localAccounts).set(stored(body.data.backup)).where(eq(localAccounts.userId, s.userId));
    req.log.info({ userId: s.userId }, "Serverkonto: Passwort geaendert");
    return { ok: true };
  });

  // ---- Devices of a server account (docs/features/devices.md): the list, and signing devices out. Another device or all
  // others only with the password (the first such sign-out makes the account enforced) and only from a session that has
  // an enrolled device itself; the asking device signs itself out without one (the client's own "Abmelden").
  app.get("/api/me/devices", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    if (!s.localHandle) return reply.code(409).send({ error: "use_directory" });
    const list: DevicesResponse = await devices.listLocal(s.userId, s.deviceKey);
    return list;
  });
  app.delete("/api/me/devices/current", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    if (!s.localHandle) return reply.code(409).send({ error: "use_directory" });
    // A session without a device (a client from before devices) ends like a sign-out of before.
    const revoked = s.deviceKey ? await devices.revokeSelf(s.userId, s.deviceKey) : 0;
    await db.delete(sessions).where(eq(sessions.id, s.sessionId));
    hub.disconnectSession(s.sessionId);
    req.log.info({ userId: s.userId, device: revoked > 0 }, "Serverkonto: Geraet hat sich abgemeldet");
    return { ok: true, revoked };
  });
  const revokeOther = async (req: Parameters<typeof requireSession>[1], reply: Parameters<typeof requireSession>[2], target: string) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    if (!s.localHandle) return reply.code(409).send({ error: "use_directory" });
    const body = LocalDeviceRevokeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!s.deviceKey || !(await devices.findLocal(s.userId, s.deviceKey))) return reply.code(400).send({ error: "no_device" });
    const account = { userId: s.userId };
    if (!attemptPassword(req.ip, account)) return reply.code(429).send({ error: "rate_limited" });
    const [row] = await db.select({ authHash: localAccounts.authHash }).from(localAccounts).where(eq(localAccounts.userId, s.userId)).limit(1);
    if (!row) return reply.code(404).send({ error: "unknown_account" });
    if (!sameHash(sha256(body.data.authKey), row.authHash)) {
      req.log.warn({ userId: s.userId, ip: req.ip }, "Serverkonto: Geraete abmelden mit falschem Passwort");
      return reply.code(401).send({ error: "auth_invalid" });
    }
    refundPassword(req.ip, account);
    const gone = await devices.revokeLocal(s.userId, target, s.deviceKey);
    if (gone.length === 0 && target !== "others") return reply.code(404).send({ error: "not_found" });
    req.log.info({ userId: s.userId, revoked: gone.length }, "Serverkonto: Geraete abgemeldet");
    return { ok: true, revoked: gone.length, devices: await devices.listLocal(s.userId, s.deviceKey) };
  };
  app.delete("/api/me/devices/others", async (req, reply) => revokeOther(req, reply, "others"));
  app.delete<{ Params: { id: string } }>("/api/me/devices/:id", async (req, reply) => {
    const id = Uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: "bad_request" });
    return revokeOther(req, reply, id.data);
  });

  // Delete a server account (a directory account is deleted through the directory, as before). The first owner cannot go.
  app.delete("/api/me", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    const body = LocalDeleteRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const account = { userId: s.userId };
    if (!attemptPassword(req.ip, account)) return reply.code(429).send({ error: "rate_limited" });
    const [row] = await db.select({ authHash: localAccounts.authHash }).from(localAccounts).where(eq(localAccounts.userId, s.userId)).limit(1);
    if (!row || s.handle) { refundPassword(req.ip, account); return reply.code(409).send({ error: "use_directory" }); }
    if (!sameHash(sha256(body.data.authKey), row.authHash)) return reply.code(401).send({ error: "auth_invalid" });
    refundPassword(req.ip, account);
    const result = await deleteUserAccount(app, db, hub, presence, s.publicKey, async () => "confirmed");
    if (result === "founder") return reply.code(409).send({ error: "founder" });
    await rm(avatarPath(s.userId), { force: true });
    return { ok: true };
  });

  // ---- The avatar of a server account (a directory account's picture lives at the directory). The client crops and scales
  // it like for the directory; the server checks type and size. File DATA_DIR/avatars/<userId>, public like the server icon.
  // Members only (security review, 25 September 2026): a kicked or banned user keeps a session, but no say in what shows here.
  app.put("/api/me/avatar", { bodyLimit: Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4096 }, async (req, reply) => {
    const s = await requireMember(db, req, reply);
    if (!s) return;
    if (s.handle || !s.localHandle) return reply.code(409).send({ error: "use_directory" });
    const body = LocalAvatarRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const bytes = Buffer.from(body.data.data, "base64");
    if (bytes.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: "too_large" });
    if (sniffAvatarMime(bytes) !== body.data.mime) return reply.code(400).send({ error: "bad_type" });
    await mkdir(avatarDir, { recursive: true });
    const tmp = `${avatarPath(s.userId)}.tmp`;
    await writeFile(tmp, bytes);
    await replaceFile(tmp, avatarPath(s.userId));
    const now = new Date();
    await db.update(localAccounts).set({ avatarMime: body.data.mime, avatarUpdatedAt: now }).where(eq(localAccounts.userId, s.userId));
    await broadcastStructure(db, hub, ["members"]);
    return { ok: true, avatarUpdatedAt: now.toISOString() };
  });

  app.delete("/api/me/avatar", async (req, reply) => {
    const s = await requireMember(db, req, reply);
    if (!s) return;
    if (s.handle || !s.localHandle) return reply.code(409).send({ error: "use_directory" });
    await rm(avatarPath(s.userId), { force: true });
    await db.update(localAccounts).set({ avatarMime: null, avatarUpdatedAt: null }).where(eq(localAccounts.userId, s.userId));
    await broadcastStructure(db, hub, ["members"]);
    return { ok: true, avatarUpdatedAt: null };
  });

  /** Public like the directory's avatars (the address carries a version parameter, so it is cached for a long time). */
  app.get<{ Params: { userId: string } }>("/api/avatars/:userId", async (req, reply) => {
    const id = Uuid.safeParse(req.params.userId);
    if (!id.success) return reply.code(404).send({ error: "not_found" });
    const [row] = await db.select({ mime: localAccounts.avatarMime }).from(localAccounts).where(eq(localAccounts.userId, id.data)).limit(1);
    if (!row?.mime || !existsSync(avatarPath(id.data))) return reply.code(404).send({ error: "not_found" });
    return reply
      .type(row.mime)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(createReadStream(avatarPath(id.data)));
  });
}
