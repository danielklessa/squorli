import { BanRequest, MoveMemberRequest, Permission, SetMemberRolesRequest, SetOwnerRequest, SetStreamBlockedRequest, StopStreamRequest, displayNameOf, hasPermission, type Ban } from "@squorli/protocol";
import { desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../auth/session";
import { can, canGrant, canSetRolesOf, canTouchRole, outranks, type Actor } from "../authz";
import type { Db } from "../db";
import { bans, categoryOverwrites, channelOverwrites, channels, localAccounts, memberRoles, members, roles, sessions, users } from "../db/schema";
import { localJoin, nameColumns } from "../names";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import { syncVoiceAccessOf } from "../livekit/sync";
import { actorOf, broadcastStructure, loadSettings, sendStructureTo } from "../state";
import { visibility } from "../visibility";
import { moveGrants } from "../voice/confine";
import { voteKicks } from "../voice/votekick";
import { channelBlockStore } from "../voice/channelBlocks";
import type { VoicePresence } from "../voice/presence";
import { setHold } from "../voice/sticky";
import { recordModLog, userNameOf } from "../modLog";
import { deleteRecentMessagesOf } from "../moderation";

const Params = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

export async function registerMemberRoutes(app: FastifyInstance, db: Db, hub: Hub, presence: VoicePresence, lk: LivekitAdmin) {
  async function targetOf(userId: string): Promise<Actor | null> {
    return actorOf(db, userId);
  }

  async function removeMember(userId: string, reason: "kicked" | "banned", message: string | null) {
    // Voice is a connection of its own: without this a modified client stayed in the LiveKit room after a kick or ban, hearing
    // and speaking (security audit, 2 October 2026, S4). Taken before the presence forgets the seat.
    const seat = presence.channelOfUser(userId);
    await db.delete(memberRoles).where(eq(memberRoles.userId, userId));
    // Their channel overwrites too: the users row stays (a kicked member may come back), so no cascade does it.
    await db.delete(channelOverwrites).where(eq(channelOverwrites.userId, userId));
    await db.delete(categoryOverwrites).where(eq(categoryOverwrites.userId, userId));
    await db.delete(members).where(eq(members.userId, userId));
    presence.leaveUser(userId);
    moveGrants.clear(userId);
    voteKicks.clearUser(userId);
    await channelBlockStore.clearUser(userId);
    visibility.dropUser(userId);
    hub.disconnectUser(userId, { type: "removed", reason, message });
    if (seat) lk.removeParticipant(seat, userId).catch(() => {});
  }

  // Owners (several possible): only owners may appoint or revoke; not on yourself; the first owner
  // (server_settings.owner_id) always stays. Owners have every permission and outrank every role (outranks).
  app.put<{ Params: { id: string } }>("/api/members/:id/owner", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!m.actor.isOwner) return reply.code(403).send({ error: "owner_only" });
    const body = SetOwnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (req.params.id === m.userId) return reply.code(400).send({ error: "self" });
    const [target] = await db.select({ userId: members.userId }).from(members).where(eq(members.userId, req.params.id)).limit(1);
    if (!target) return reply.code(404).send({ error: "not_found" });
    const settings = await loadSettings(db);
    if (!body.data.owner && settings.ownerId === target.userId) return reply.code(403).send({ error: "founder" });
    await db.update(members).set({ isOwner: body.data.owner }).where(eq(members.userId, target.userId));
    req.log.info({ by: m.userId, target: target.userId, owner: body.data.owner }, "Eigentuemerstatus geaendert");
    await syncVoiceAccessOf(db, hub, presence, lk, { userIds: [target.userId] });
    await broadcastStructure(db, hub, ["members"]);
    return { ok: true };
  });

  // Set a member's roles
  app.put<{ Params: { id: string } }>("/api/members/:id/roles", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const body = SetMemberRolesRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const target = await targetOf(req.params.id);
    if (!target) return reply.code(404).send({ error: "not_found" });
    // An owner's roles: only the first owner may change them (authz.ts); everyone else by rank.
    if (!canSetRolesOf(m.actor, target, (await loadSettings(db)).ownerId)) return reply.code(403).send({ error: "target_above_you" });

    const wanted = body.data.roleIds.length ? await db.select().from(roles).where(inArray(roles.id, body.data.roleIds)) : [];
    if (wanted.length !== new Set(body.data.roleIds).size) return reply.code(400).send({ error: "unknown_role" });
    const current = (await db.select().from(memberRoles).where(eq(memberRoles.userId, target.userId))).map((r) => r.roleId);
    const currentRoles = current.length ? await db.select().from(roles).where(inArray(roles.id, current)) : [];
    // Only roles below your own position may be added or removed.
    const changed = [...wanted.filter((r) => !current.includes(r.id)), ...currentRoles.filter((r) => !body.data.roleIds.includes(r.id))];
    if (changed.some((r) => r.isDefault || !canTouchRole(m.actor, r.position))) return reply.code(403).send({ error: "role_above_you" });
    // And only roles whose permissions one holds oneself, as when editing a role (security audit, 2 October 2026, S2): by
    // position alone a helper with MANAGE_ROLES gave themselves any role below their own, ADMINISTRATOR included.
    if (changed.some((r) => !canGrant(m.actor, r.permissions))) return reply.code(403).send({ error: "cannot_grant" });

    await db.delete(memberRoles).where(eq(memberRoles.userId, target.userId));
    const toInsert = wanted.filter((r) => !r.isDefault).map((r) => ({ userId: target.userId, roleId: r.id }));
    if (toInsert.length) await db.insert(memberRoles).values(toInsert);
    // A member sitting in a voice channel: their LiveKit grants follow the new roles (camera/screen), see livekit/sync.ts.
    await syncVoiceAccessOf(db, hub, presence, lk, { userIds: [target.userId] });
    await broadcastStructure(db, hub, ["members"]);
    return { ok: true };
  });

  // ---------- Voice channel moderation (M3): move (MOVE_MEMBERS since 23 September 2026), stop camera/screen, block
  // streaming (MODERATE_VOICE). The right counts server-wide or in the channel the target sits in (an overwrite may give it
  // there only), plus a rank above the target. LiveKit enforces muting/publish permissions; the WS event lets the client
  // update its interface (and join the new room when being moved).
  async function moderationTarget(req: Parameters<typeof requireMember>[1], reply: Parameters<typeof requireMember>[2], targetId: string, perm: number) {
    const m = await requireMember(db, req, reply);
    if (!m) return null;
    const target = await targetOf(targetId);
    if (!target) { reply.code(404).send({ error: "not_found" }); return null; }
    const room = presence.channelOfUser(target.userId);
    await visibility.refresh(db);
    if (!can(m.actor, perm) && !(room !== undefined && hasPermission(visibility.masksOf(m.userId).get(room) ?? 0, perm))) { reply.code(403).send({ error: "forbidden" }); return null; }
    if (target.userId === m.userId) { reply.code(400).send({ error: "self" }); return null; }
    if (!outranks(m.actor, target)) { reply.code(403).send({ error: "target_above_you" }); return null; }
    const [me] = await db.select(nameColumns).from(users).leftJoin(localAccounts, localJoin).where(eq(users.id, m.userId)).limit(1);
    return { m, target, by: me ? displayNameOf(me) : "Moderator" };
  }

  /**
   * Move a member (docs/features/channel-permissions.md). The mover needs MOVE_MEMBERS resolved in the destination (an
   * overwrite may give or take it there), but neither VIEW_CHANNELS nor CONNECT_VOICE there; the moved member's own
   * rights at the destination are not asked at all (user's decision: one may be pushed into a channel one may neither see
   * nor enter). The move is advisory (the client joins by itself), so a grant lets that join through and the member's
   * channel list gets the destination first (the client cannot join an id it does not know). A hold by a sticky channel
   * ends with the move; the destination holds again if it is sticky (voice/sticky.ts at the join).
   */
  app.post<{ Params: { id: string } }>("/api/members/:id/move", { schema: { params: Params } }, async (req, reply) => {
    const ctx = await moderationTarget(req, reply, req.params.id, Permission.MOVE_MEMBERS);
    if (!ctx) return;
    const body = MoveMemberRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!presence.channelOfUser(ctx.target.userId)) return reply.code(409).send({ error: "not_in_voice" });
    if (body.data.channelId) {
      const [ch] = await db.select({ id: channels.id, kind: channels.kind }).from(channels).where(eq(channels.id, body.data.channelId)).limit(1);
      if (!ch || ch.kind !== "voice") return reply.code(404).send({ error: "unknown_channel" });
      if (!hasPermission(visibility.masksOf(ctx.m.userId).get(ch.id) ?? 0, Permission.MOVE_MEMBERS)) return reply.code(403).send({ error: "forbidden" });
      moveGrants.grant(ctx.target.userId, ch.id);
    } else moveGrants.clear(ctx.target.userId);
    const held = (await visibility.refresh(db)).members.get(ctx.target.userId)?.confinedChannelId;
    if (held) await setHold(db, hub, ctx.target.userId, null); else await sendStructureTo(db, hub, ctx.target.userId, true);
    hub.sendToUser(ctx.target.userId, { type: "voice.moved", channelId: body.data.channelId, by: ctx.by });
    req.log.info({ by: ctx.m.userId, target: ctx.target.userId, to: body.data.channelId }, "Mitglied verschoben");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/members/:id/stream/stop", { schema: { params: Params } }, async (req, reply) => {
    const ctx = await moderationTarget(req, reply, req.params.id, Permission.MODERATE_VOICE);
    if (!ctx) return;
    const body = StopStreamRequest.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const room = presence.channelOfUser(ctx.target.userId);
    if (room) await lk.stopStreams(room, ctx.target.userId, body.data);
    hub.sendToUser(ctx.target.userId, { type: "voice.stop", camera: body.data.camera, screen: body.data.screen, by: ctx.by });
    req.log.info({ by: ctx.m.userId, target: ctx.target.userId, ...body.data }, "Kamera/Bildschirm beendet");
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/members/:id/stream", { schema: { params: Params } }, async (req, reply) => {
    const ctx = await moderationTarget(req, reply, req.params.id, Permission.MODERATE_VOICE);
    if (!ctx) return;
    const body = SetStreamBlockedRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await db.update(members).set({ streamBlocked: body.data.blocked }).where(eq(members.userId, ctx.target.userId));
    const room = presence.channelOfUser(ctx.target.userId);
    if (room) {
      await syncVoiceAccessOf(db, hub, presence, lk, { userIds: [ctx.target.userId] });
      if (body.data.blocked) hub.sendToUser(ctx.target.userId, { type: "voice.stop", camera: true, screen: true, by: ctx.by });
    }
    await broadcastStructure(db, hub, ["members"]); // also sends the target its new permissions ("me")
    req.log.info({ by: ctx.m.userId, target: ctx.target.userId, blocked: body.data.blocked }, "Streamen-Sperre gesetzt");
    return { ok: true };
  });

  // Kick
  app.delete<{ Params: { id: string } }>("/api/members/:id", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.KICK_MEMBERS)) return reply.code(403).send({ error: "forbidden" });
    const target = await targetOf(req.params.id);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!outranks(m.actor, target)) return reply.code(403).send({ error: "target_above_you" });
    const kickedName = await userNameOf(db, target.userId);
    await removeMember(target.userId, "kicked", null);
    req.log.info({ by: m.userId, target: target.userId }, "Mitglied gekickt");
    await recordModLog(db, { actorId: m.userId, actorName: displayNameOf(m), targetUserId: target.userId, targetName: kickedName, action: "kick" }, req.log);
    await broadcastStructure(db, hub, ["members"]);
    return { ok: true };
  });

  // Bans
  app.get("/api/bans", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.BAN_MEMBERS)) return reply.code(403).send({ error: "forbidden" });
    const rows = await db
      .select({ userId: bans.userId, reason: bans.reason, bannedBy: bans.bannedBy, createdAt: bans.createdAt, ...nameColumns })
      .from(bans).innerJoin(users, eq(users.id, bans.userId)).leftJoin(localAccounts, localJoin).orderBy(desc(bans.createdAt));
    const out: Ban[] = rows.map((r) => ({ userId: r.userId, displayName: displayNameOf(r), reason: r.reason, bannedBy: r.bannedBy, createdAt: r.createdAt.toISOString() }));
    return out;
  });

  app.post("/api/bans", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.BAN_MEMBERS)) return reply.code(403).send({ error: "forbidden" });
    const body = BanRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.data.userId)).limit(1);
    if (!user) return reply.code(404).send({ error: "not_found" });
    if (user.id === m.userId) return reply.code(400).send({ error: "cannot_ban_self" });
    const target = await targetOf(user.id);
    // Non-members (already kicked) may be banned afterwards; members only below your own position.
    if (target && !outranks(m.actor, target)) return reply.code(403).send({ error: "target_above_you" });
    const bannedName = await userNameOf(db, user.id);
    await db.insert(bans).values({ userId: user.id, bannedBy: m.userId, reason: body.data.reason ?? null }).onConflictDoNothing();
    await removeMember(user.id, "banned", body.data.reason ?? null);
    // "Delete messages of the last ..." (docs/features/reports.md): their messages of that window in every channel, one bulk event per channel.
    const wiped = body.data.deleteMessagesHours ? await deleteRecentMessagesOf(app, db, hub, user.id, body.data.deleteMessagesHours * 3_600_000) : null;
    // A ban ends every session here (security review, 25 September 2026); a kicked member keeps theirs to come back with an invite.
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    req.log.info({ by: m.userId, target: user.id, deleted: wiped?.count ?? 0 }, "Mitglied gebannt");
    await recordModLog(db, { actorId: m.userId, actorName: displayNameOf(m), targetUserId: user.id, targetName: bannedName, action: "ban", detail: { ...(body.data.reason ? { reason: body.data.reason } : {}), ...(body.data.deleteMessagesHours ? { hours: body.data.deleteMessagesHours, deleted: wiped?.count ?? 0 } : {}) } }, req.log);
    await broadcastStructure(db, hub, ["members"]);
    return { ok: true, deleted: wiped?.count ?? 0 };
  });

  app.delete<{ Params: { id: string } }>("/api/bans/:id", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.BAN_MEMBERS)) return reply.code(403).send({ error: "forbidden" });
    const gone = await db.delete(bans).where(eq(bans.userId, req.params.id)).returning({ userId: bans.userId });
    if (!gone.length) return reply.code(404).send({ error: "not_found" });
    await recordModLog(db, { actorId: m.userId, actorName: displayNameOf(m), targetUserId: req.params.id, targetName: await userNameOf(db, req.params.id), action: "unban" }, req.log);
    return { ok: true };
  });
}
