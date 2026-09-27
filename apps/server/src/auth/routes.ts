import { ChallengeRequest, VerifyRequest, challengeMessage, labelFromUserAgent, type VerifyResponse } from "@squorli/protocol";
import * as ed from "@noble/ed25519";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config";
import type { Db } from "../db";
import { bans, invites, localAccounts, memberRoles, members, roles, serverSettings, sessions, users } from "../db/schema";
import type { Hub } from "../hub";
import { SETTINGS_ID, broadcastStructure, loadSettings, refusesSuspended } from "../state";
import { refusedUntil, suspendedBody } from "../users/suspension";
import type { DirectoryClient, LoginProof } from "../directory";
import type { VoicePresence } from "../voice/presence";
import { ChallengeStore } from "./challenges";
import { tokenHash } from "./session";
import { registerLocalAccountRoutes } from "./local";

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** Check a signature over a message built from the consumed challenge's nonce; returns that nonce, or sends 401 itself and returns null. */
export async function checkChallenge(challenges: ChallengeStore, config: Config, reply: FastifyReply, challengeId: string, publicKey: string, signature: string, message: (domain: string, nonce: string) => string): Promise<string | null> {
  const nonce = challenges.consume(challengeId, publicKey);
  if (!nonce) { await reply.code(401).send({ error: "challenge_invalid" }); return null; }
  const msg = new TextEncoder().encode(message(config.PUBLIC_DOMAIN, nonce));
  const ok = await ed.verifyAsync(hexToBytes(signature), msg, hexToBytes(publicKey)).catch(() => false);
  if (!ok) { await reply.code(401).send({ error: "signature_invalid" }); return null; }
  return nonce;
}

/** Whether `signature` is `publicKey`'s over `message` (both hex); never throws. */
export async function signatureValid(publicKey: string, signature: string, message: string): Promise<boolean> {
  return ed.verifyAsync(hexToBytes(signature), new TextEncoder().encode(message), hexToBytes(publicKey)).catch(() => false);
}

/** Whether `code` is the server's owner setup code (OWNER_SETUP_CODE); compared in constant time. */
export function ownerCodeMatches(config: Config, code: string | undefined): boolean {
  if (config.OWNER_SETUP_CODE === undefined || code === undefined) return false;
  const digest = (s: string) => createHash("sha256").update(s.trim()).digest();
  return timingSafeEqual(digest(code), digest(config.OWNER_SETUP_CODE));
}

/**
 * The first sign-in with an account becomes the owner, while none exists. OWNER_PUBLIC_KEY and OWNER_SETUP_CODE narrow who:
 * the named key, or a server account's registration with the code (either, when both are set).
 */
export async function isFirstEver(db: Db, config: Config, publicKey: string, ownerCode?: string): Promise<boolean> {
  const settings = await loadSettings(db);
  if (settings.ownerId !== null) return false;
  if (config.OWNER_PUBLIC_KEY === undefined && config.OWNER_SETUP_CODE === undefined) return true;
  return config.OWNER_PUBLIC_KEY === publicKey || ownerCodeMatches(config, ownerCode);
}

/**
 * Admit a user who has an account (directory handle or server account) and proved their key: ban check, membership (existing
 * member, open server, invite, or the first owner), owner, session. Sends the error itself and returns null on a refusal.
 */
export async function admit(
  db: Db, config: Config, hub: Hub, directory: DirectoryClient, req: FastifyRequest, reply: FastifyReply,
  user: { id: string; publicKey: string; displayName: string | null }, invite: string | undefined, registrationRequired = false,
  proof: LoginProof | null = null, ownerCode?: string,
): Promise<VerifyResponse | null> {
  const [ban] = await db.select().from(bans).where(eq(bans.userId, user.id)).limit(1);
  if (ban) { await reply.code(403).send({ error: "banned", reason: ban.reason }); return null; }
  const [member] = await db.select().from(members).where(eq(members.userId, user.id)).limit(1);
  const settings = await loadSettings(db);
  // The owner is claimed with one conditional update before anything else: of two first sign-ins at the same moment only
  // one gets it, the other is handled as an ordinary sign-in (invite, open server; security review, 25 September 2026).
  let firstEver = await isFirstEver(db, config, user.publicKey, ownerCode);
  if (firstEver) {
    const claimed = await db.update(serverSettings).set({ ownerId: user.id })
      .where(and(eq(serverSettings.id, SETTINGS_ID), isNull(serverSettings.ownerId))).returning({ id: serverSettings.id });
    firstEver = claimed.length > 0;
  }

  // Membership: existing member, open server, or a valid invite.
  if (!member) {
    if (!settings.openJoin && !firstEver) {
      if (!invite) { await reply.code(403).send({ error: "invite_required" }); return null; }
      const used = await consumeInvite(db, invite);
      if (!used) { await reply.code(403).send({ error: "invite_invalid" }); return null; }
    }
    await db.insert(members).values({ userId: user.id }).onConflictDoNothing();
    req.log.info({ userId: user.id, via: invite ? "invite" : firstEver ? "owner" : "open" }, "neues Mitglied");
    // Now a member: the directory may list this server for the account.
    void directory.refresh(user, true, proof);
  }

  // The owner (claimed above): the first sign-in with an account while none exists.
  if (firstEver) {
    await db.update(members).set({ isOwner: true }).where(eq(members.userId, user.id));
    const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Admin")).limit(1);
    if (admin) await db.insert(memberRoles).values({ userId: user.id, roleId: admin.id }).onConflictDoNothing();
    req.log.warn({ userId: user.id, publicKey: user.publicKey.slice(0, 8) }, "Eigentuemer festgelegt");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
  // Device label for the session list (M6c); the client cannot set it, only the browser reveals it.
  await db.insert(sessions).values({ token: tokenHash(token), userId: user.id, expiresAt, label: labelFromUserAgent(req.headers["user-agent"]), lastUsedAt: new Date() });

  if (!member) await broadcastStructure(db, hub, ["members", "settings"]);
  return { sessionToken: token, userId: user.id, expiresAt: expiresAt.toISOString(), registrationRequired };
}

export async function registerAuthRoutes(app: FastifyInstance, db: Db, config: Config, hub: Hub, directory: DirectoryClient, presence: VoicePresence) {
  const challenges = new ChallengeStore();
  const sweeper = setInterval(() => challenges.sweep(), 30_000);
  app.addHook("onClose", async () => clearInterval(sweeper));

  app.post("/api/auth/challenge", async (req, reply) => {
    const body = ChallengeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return challenges.create(body.data.publicKey);
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const body = VerifyRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { challengeId, publicKey, signature, invite } = body.data;
    const nonce = await checkChallenge(challenges, config, reply, challengeId, publicKey, signature, challengeMessage);
    if (!nonce) return;
    // The directory records this server for the account only with this proof (the user's own signature for our domain).
    const proof: LoginProof = { nonce, signature };

    // No temporary users (docs/features/local-accounts.md): a key needs a directory handle or a server account here. A key
    // this server has never seen gets a row only while the directory is asked, and loses it again when it has no account.
    const [known] = await db.select({ id: users.id }).from(users).where(eq(users.publicKey, publicKey)).limit(1);
    const [user] = await db.insert(users).values({ publicKey }).onConflictDoUpdate({ target: users.publicKey, set: { lastSeenAt: new Date() } }).returning();
    if (!user) return reply.code(500).send({ error: "user_upsert_failed" });
    const [member] = await db.select({ userId: members.userId }).from(members).where(eq(members.userId, user.id)).limit(1);
    // Look up the verified handle and display name from the directory (M6); an outage of the service is not a sign-in error
    // (the last cached handle counts). Only a member's lookup counts as a sign-in there.
    const profile = await directory.refresh({ id: user.id, publicKey, displayName: user.displayName }, !!member, proof);
    const handle = profile ? profile.handle : user.handle;
    const [local] = await db.select({ handle: localAccounts.handle }).from(localAccounts).where(eq(localAccounts.userId, user.id)).limit(1);
    if (!handle && !local) {
      // A member from before server accounts keeps their key, messages and roles: they sign in, but must register first.
      if (member) {
        const res = await admit(db, config, hub, directory, req, reply, user, invite, true, proof);
        if (res) req.log.info({ userId: user.id }, "Mitglied ohne Konto: Registrierung verlangt");
        return res ?? undefined;
      }
      if (!known) await db.delete(users).where(eq(users.id, user.id));
      const settings = await loadSettings(db);
      return reply.code(403).send({ error: "registration_required", localAccounts: settings.localAccounts === true });
    }
    // A directory account the directory's operator suspended gets no session here while the suspension lasts, unless this
    // server's operator switched that off (users/suspension.ts). The cached date counts while the directory is unreachable.
    const until = refusedUntil({ handle, localHandle: local?.handle ?? null, suspendedUntil: profile ? profile.suspendedUntil : user.suspendedUntil }, await refusesSuspended(db));
    if (until) {
      if (!known) await db.delete(users).where(eq(users.id, user.id));
      req.log.info({ publicKey: publicKey.slice(0, 8), until: until.toISOString() }, "Anmeldung abgewiesen: Verzeichniskonto gesperrt");
      return reply.code(403).send(suspendedBody(until));
    }
    const res = await admit(db, config, hub, directory, req, reply, { id: user.id, publicKey, displayName: profile?.displayName ?? user.displayName }, invite, false, proof);
    return res ?? undefined;
  });

  await registerLocalAccountRoutes(app, db, config, hub, directory, presence, challenges);
}

/** Check and consume an invite (atomically). true = valid and counted. */
export async function consumeInvite(db: Db, code: string): Promise<boolean> {
  const updated = await db
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(and(
      eq(invites.code, code),
      isNull(invites.revokedAt),
      sql`(${invites.expiresAt} is null or ${invites.expiresAt} > now())`,
      sql`(${invites.maxUses} is null or ${invites.uses} < ${invites.maxUses})`,
    ))
    .returning({ code: invites.code });
  return updated.length > 0;
}

export { resolveSession } from "./session";
