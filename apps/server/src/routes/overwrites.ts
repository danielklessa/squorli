import { CHANNEL_OVERRIDABLE, Permission, SetOverwritesRequest, hasPermission, type OverwritesResponse, type PermissionOverwrite } from "@squorli/protocol";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../auth/session";
import { canGrant, canTouchRole, outranks, type Actor } from "../authz";
import { channelActor } from "../channelGuard";
import { channelPermissions } from "../channelPermissions";
import type { Db } from "../db";
import { categories, categoryOverwrites, channelOverwrites, members, roles } from "../db/schema";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import { syncVoiceAccessOf } from "../livekit/sync";
import { broadcastStructure, actorOf } from "../state";
import { visibility } from "../visibility";
import type { VoicePresence } from "../voice/presence";

const Params = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

/**
 * Permission overwrites of channels and categories (docs/features/channel-permissions.md). GET reads them, PUT replaces
 * the whole list (like PUT /api/members/:id/roles: the dialog edits a table and saves it). Rules, in order: allow and deny
 * never share a bit; only CHANNEL_OVERRIDABLE bits (a server-wide right is refused, not silently dropped); targets must
 * exist; one may only hand out what one holds in that channel (canGrant over the channel-resolved mask); a role only below
 * one's own rank; a deny for a member only when one outranks them; and never a list that would take one's own view or
 * management of the channel away (owners and administrators cannot lock themselves out anyway). The rank rules, like
 * canGrant, apply to the entries the list changes only (8 October 2026): an entry for a role at or above the editor's rank
 * that stays as stored is passed through, so the rest of the list can still be edited (until then an imported entry for
 * the editor's own role made the whole channel uneditable for them, user's report).
 */
export async function registerOverwriteRoutes(app: FastifyInstance, db: Db, hub: Hub, presence: VoicePresence, lk: LivekitAdmin) {
  type Row = { roleId: string | null; userId: string | null; allow: number; deny: number };
  const toWire = (rows: Row[]): PermissionOverwrite[] => rows.map((r) => ({ targetType: r.roleId ? "role" : "member", targetId: r.roleId ?? r.userId!, allow: r.allow, deny: r.deny }));

  /**
   * null = accepted; otherwise the error the client gets. `before` = the rows the list replaces: only the bits an entry
   * changes against its row need canGrant (6 October 2026, as for editing a role), so an entry that holds a right the editor
   * lacks here may stay in the list untouched; a dropped entry counts as changed in every bit it had. The same goes for the
   * rank rules (8 October 2026): an unchanged entry is nobody's doing, so neither its role's rank nor its member's is asked.
   */
  async function check(actor: Actor, perms: number, list: PermissionOverwrite[], before: Row[], scope: { id: string; kind: "channel" | "category"; categoryId: string | null }): Promise<{ code: number; error: string } | null> {
    const ids = { role: list.filter((o) => o.targetType === "role").map((o) => o.targetId), member: list.filter((o) => o.targetType === "member").map((o) => o.targetId) };
    const keyOf = (o: { targetType: "role" | "member"; targetId: string }) => `${o.targetType}:${o.targetId}`;
    const old = new Map(toWire(before).map((o) => [keyOf(o), o]));
    if (new Set(list.map((o) => `${o.targetType}:${o.targetId}`)).size !== list.length) return { code: 400, error: "bad_request" };
    for (const o of list) {
      if ((o.allow & o.deny) !== 0) return { code: 400, error: "bad_request" };
      if (((o.allow | o.deny) & ~CHANNEL_OVERRIDABLE) !== 0) return { code: 400, error: "not_channel_permission" };
    }
    const roleRows = ids.role.length ? await db.select({ id: roles.id, position: roles.position }).from(roles).where(inArray(roles.id, ids.role)) : [];
    const memberRows = ids.member.length ? await db.select({ userId: members.userId }).from(members).where(inArray(members.userId, ids.member)) : [];
    if (roleRows.length !== ids.role.length || memberRows.length !== ids.member.length) return { code: 400, error: "unknown_target" };
    const actorIn: Actor = { ...actor, permissions: perms };
    /** The rank rules for an entry the list changes: a role only below one's own rank, a deny for a member only when one outranks them. */
    const rankCheck = async (o: { targetType: "role" | "member"; targetId: string; deny: number }, position: number | undefined): Promise<{ code: number; error: string } | null> => {
      if (o.targetType === "role") return canTouchRole(actor, position!) ? null : { code: 403, error: "role_above_you" };
      if (o.deny === 0 || o.targetId === actor.userId) return null;
      const target = await actorOf(db, o.targetId);
      return target && outranks(actor, target) ? null : { code: 403, error: "target_above_you" };
    };
    for (const o of list) {
      const was = old.get(keyOf(o)) ?? { allow: 0, deny: 0 };
      const changed = (o.allow ^ was.allow) | (o.deny ^ was.deny);
      if (changed === 0) continue;
      if (!canGrant(actorIn, changed)) return { code: 403, error: "cannot_grant" };
      const refused = await rankCheck(o, roleRows.find((r) => r.id === o.targetId)?.position);
      if (refused) return refused;
    }
    const kept = new Set(list.map(keyOf));
    for (const [key, o] of old) {
      if (kept.has(key)) continue;
      if (!canGrant(actorIn, o.allow | o.deny)) return { code: 403, error: "cannot_grant" };
      // A dropped entry's role is not in `roleRows` (those are the list's targets); its position is read here.
      const position = o.targetType === "role" ? (await db.select({ position: roles.position }).from(roles).where(eq(roles.id, o.targetId)).limit(1))[0]?.position ?? 0 : undefined;
      const refused = await rankCheck(o, position);
      if (refused) return refused;
    }
    // The lock-out guard: what would the actor resolve to with this list in place?
    if (!actor.isOwner && !hasPermission(actor.permissions, Permission.ADMINISTRATOR)) {
      const ctx = await visibility.refresh(db);
      const rows: Row[] = list.map((o) => ({ roleId: o.targetType === "role" ? o.targetId : null, userId: o.targetType === "member" ? o.targetId : null, allow: o.allow, deny: o.deny }));
      const after = scope.kind === "channel"
        ? channelPermissions({ base: actor.permissions, isOwner: false, userId: actor.userId, roleIds: actor.roleIds, defaultRoleId: ctx.defaultRoleId, categoryOverwrites: scope.categoryId ? ctx.byCategory.get(scope.categoryId) ?? [] : [], channelOverwrites: rows })
        : channelPermissions({ base: actor.permissions, isOwner: false, userId: actor.userId, roleIds: actor.roleIds, defaultRoleId: ctx.defaultRoleId, categoryOverwrites: rows, channelOverwrites: [] });
      if (!hasPermission(after, Permission.VIEW_CHANNELS) || !hasPermission(after, Permission.MANAGE_CHANNELS)) return { code: 409, error: "would_lock_out" };
    }
    return null;
  }

  // ---- Channels
  app.get<{ Params: { id: string } }>("/api/channels/:id/overwrites", { schema: { params: Params } }, async (req, reply) => {
    const c = await channelActor(db, req, reply, req.params.id);
    if (!c) return;
    if (!hasPermission(c.perms, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: "forbidden" });
    const rows = await db.select().from(channelOverwrites).where(eq(channelOverwrites.channelId, c.channel.id));
    const res: OverwritesResponse = { overwrites: toWire(rows) };
    return res;
  });

  app.put<{ Params: { id: string } }>("/api/channels/:id/overwrites", { schema: { params: Params } }, async (req, reply) => {
    const c = await channelActor(db, req, reply, req.params.id);
    if (!c) return;
    if (!hasPermission(c.perms, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: "forbidden" });
    const body = SetOverwritesRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const before = await db.select().from(channelOverwrites).where(eq(channelOverwrites.channelId, c.channel.id));
    const refused = await check(c.actor, c.perms, body.data.overwrites, before, { id: c.channel.id, kind: "channel", categoryId: c.channel.categoryId });
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    await db.transaction(async (tx) => {
      await tx.delete(channelOverwrites).where(eq(channelOverwrites.channelId, c.channel.id));
      if (body.data.overwrites.length) await tx.insert(channelOverwrites).values(body.data.overwrites.map((o) => ({ channelId: c.channel.id, roleId: o.targetType === "role" ? o.targetId : null, userId: o.targetType === "member" ? o.targetId : null, allow: o.allow, deny: o.deny })));
    });
    visibility.invalidate();
    await syncVoiceAccessOf(db, hub, presence, lk, { channelIds: [c.channel.id] });
    await broadcastStructure(db, hub, ["overwrites"]);
    req.log.info({ by: c.userId, channel: c.channel.id, entries: body.data.overwrites.length }, "Kanalrechte gesetzt");
    const res: OverwritesResponse = { overwrites: body.data.overwrites };
    return res;
  });

  // ---- Categories: visible to the actor and MANAGE_CHANNELS on the category itself.
  async function categoryActor(req: Parameters<typeof requireMember>[1], reply: Parameters<typeof requireMember>[2], id: string) {
    const m = await requireMember(db, req, reply);
    if (!m) return null;
    const [cat] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).limit(1);
    await visibility.refresh(db);
    const perms = cat ? visibility.masksOf(m.userId).get(cat.id) ?? 0 : 0;
    if (!cat || !hasPermission(perms, Permission.VIEW_CHANNELS)) { await reply.code(404).send({ error: "not_found" }); return null; }
    if (!hasPermission(perms, Permission.MANAGE_CHANNELS)) { await reply.code(403).send({ error: "forbidden" }); return null; }
    return { ...m, category: cat, perms };
  }

  app.get<{ Params: { id: string } }>("/api/categories/:id/overwrites", { schema: { params: Params } }, async (req, reply) => {
    const c = await categoryActor(req, reply, req.params.id);
    if (!c) return;
    const rows = await db.select().from(categoryOverwrites).where(eq(categoryOverwrites.categoryId, c.category.id));
    const res: OverwritesResponse = { overwrites: toWire(rows) };
    return res;
  });

  app.put<{ Params: { id: string } }>("/api/categories/:id/overwrites", { schema: { params: Params } }, async (req, reply) => {
    const c = await categoryActor(req, reply, req.params.id);
    if (!c) return;
    const body = SetOverwritesRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const before = await db.select().from(categoryOverwrites).where(eq(categoryOverwrites.categoryId, c.category.id));
    const refused = await check(c.actor, c.perms, body.data.overwrites, before, { id: c.category.id, kind: "category", categoryId: null });
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    await db.transaction(async (tx) => {
      await tx.delete(categoryOverwrites).where(eq(categoryOverwrites.categoryId, c.category.id));
      if (body.data.overwrites.length) await tx.insert(categoryOverwrites).values(body.data.overwrites.map((o) => ({ categoryId: c.category.id, roleId: o.targetType === "role" ? o.targetId : null, userId: o.targetType === "member" ? o.targetId : null, allow: o.allow, deny: o.deny })));
    });
    visibility.invalidate();
    const ctx = await visibility.refresh(db);
    await syncVoiceAccessOf(db, hub, presence, lk, { channelIds: ctx.channels.filter((ch) => ch.categoryId === c.category.id).map((ch) => ch.id) });
    await broadcastStructure(db, hub, ["overwrites"]);
    req.log.info({ by: c.userId, category: c.category.id, entries: body.data.overwrites.length }, "Kategorierechte gesetzt");
    const res: OverwritesResponse = { overwrites: body.data.overwrites };
    return res;
  });
}
