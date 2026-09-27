import { UpdateMeRequest, Uuid, type Me, type SessionInfo } from "@squorli/protocol";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hasAccount, requireMember, requireSession } from "../auth/session";
import { avatarOf } from "../names";
import type { Db } from "../db";
import { directoryStale, type DirectoryClient } from "../directory";
import { members, sessions, users } from "../db/schema";
import type { Hub } from "../hub";
import { broadcastStructure, refusesSuspended } from "../state";
import { refusedUntil, suspendedBody } from "./suspension";
import type { VoicePresence } from "../voice/presence";

/** Profile of the signed-in user (M2: display name) and their sessions (M6c: device management). Works without a membership too. */
export async function registerUserRoutes(app: FastifyInstance, db: Db, directory: DirectoryClient, hub: Hub, presence: VoicePresence) {
  app.get("/api/me", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    let { displayName, handle, avatarUrl } = s;
    // Adopt the display name from the directory (global or for this server) without a new sign-in: the client calls /api/me on open.
    if (directory.enabled && directoryStale(s.handleCheckedAt)) {
      // A session without a membership (kicked): the lookup must not count as a sign-in on this server at the directory.
      const [member] = await db.select({ userId: members.userId }).from(members).where(eq(members.userId, s.userId)).limit(1);
      const fresh = await directory.refresh({ id: s.userId, publicKey: s.publicKey, displayName: s.displayName }, !!member);
      // The lookup just told of a suspension: the same answer as for every request from now on.
      const until = fresh ? refusedUntil({ handle: fresh.handle, localHandle: s.localHandle, suspendedUntil: fresh.suspendedUntil }, await refusesSuspended(db)) : null;
      if (until) return reply.code(403).send(suspendedBody(until));
      if (fresh && (fresh.displayName !== s.displayName || fresh.handle !== s.handle || fresh.avatarUrl !== s.avatarUrl)) {
        ({ displayName, handle, avatarUrl } = fresh);
        presence.rename(s.userId, { displayName, publicKey: s.publicKey, handle, localHandle: s.localHandle });
        await broadcastStructure(db, hub, ["members"]);
      }
    }
    const me: Me = { userId: s.userId, publicKey: s.publicKey, displayName, handle, avatarUrl: avatarOf({ ...s, handle, avatarUrl }), localHandle: s.localHandle, registrationRequired: !hasAccount({ handle, localHandle: s.localHandle }) };
    return me;
  });

  // Members only (security review, 25 September 2026): a kicked or banned user's session must not rename them here.
  app.patch("/api/me", async (req, reply) => {
    const s = await requireMember(db, req, reply);
    if (!s) return;
    const body = UpdateMeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    await db.update(users).set({ displayName: body.data.displayName }).where(eq(users.id, s.userId));
    // Anyone currently sitting in a voice channel should appear there with the new name immediately.
    presence.rename(s.userId, { displayName: body.data.displayName, publicKey: s.publicKey, handle: s.handle, localHandle: s.localHandle });
    await broadcastStructure(db, hub, ["members"]);

    const me: Me = { userId: s.userId, publicKey: s.publicKey, displayName: body.data.displayName, handle: s.handle, avatarUrl: avatarOf(s), localHandle: s.localHandle, registrationRequired: !hasAccount(s) };
    return me;
  });

  // ---- M6c: sessions (devices). The token is never returned, only the identifier `id`.
  app.get("/api/me/sessions", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    // Clean up expired sessions opportunistically; resolveSession rejects them anyway.
    await db.delete(sessions).where(and(eq(sessions.userId, s.userId), lt(sessions.expiresAt, new Date())));
    const rows = await db
      .select({ id: sessions.id, label: sessions.label, createdAt: sessions.createdAt, lastUsedAt: sessions.lastUsedAt, expiresAt: sessions.expiresAt })
      .from(sessions).where(eq(sessions.userId, s.userId))
      .orderBy(sql`${sessions.lastUsedAt} desc nulls last`, desc(sessions.createdAt));
    const list: SessionInfo[] = rows.map((r) => ({
      id: r.id, label: r.label, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(), current: r.id === s.sessionId,
    }));
    return list;
  });

  /** Sign out all other devices; their WebSockets are closed with 4011. */
  app.delete("/api/me/sessions/others", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    const gone = await db.delete(sessions).where(and(eq(sessions.userId, s.userId), ne(sessions.id, s.sessionId))).returning({ id: sessions.id });
    for (const g of gone) hub.disconnectSession(g.id);
    req.log.info({ userId: s.userId, revoked: gone.length }, "andere Sitzungen abgemeldet");
    return { ok: true, revoked: gone.length };
  });

  /** End your own session server-side (signing out in the client). */
  app.delete("/api/me/sessions/current", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    await db.delete(sessions).where(eq(sessions.id, s.sessionId));
    // Its WebSockets too (security review, 25 September 2026): before, they stayed open until the client closed them.
    hub.disconnectSession(s.sessionId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/me/sessions/:id", async (req, reply) => {
    const s = await requireSession(db, req, reply);
    if (!s) return;
    const id = Uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: "bad_request" });
    // Only your own sessions; other people's identifiers look like unknown ones.
    const gone = await db.delete(sessions).where(and(eq(sessions.id, id.data), eq(sessions.userId, s.userId))).returning({ id: sessions.id });
    if (gone.length === 0) return reply.code(404).send({ error: "not_found" });
    hub.disconnectSession(id.data);
    req.log.info({ userId: s.userId, sessionId: id.data }, "Sitzung abgemeldet");
    return { ok: true };
  });
}
