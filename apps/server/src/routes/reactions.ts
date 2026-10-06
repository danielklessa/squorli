import { Permission, REACTION_ROLE_EXCERPT_MAX, REACTION_USERS_PAGE, ReactRequest, ReactionEmoji, SetReactionRoleRequest, emojiKey, hasPermission, type MessageReactions, type ReactionRole, type ReactionRoleOverviewEntry, type ReactionUsersResponse } from "@squorli/protocol";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireMember } from "../auth/session";
import { can, canGrant, canTouchRole } from "../authz";
import { canIn, resolveChannel } from "../channelGuard";
import type { Db } from "../db";
import { channels, messageReactions, messages, reactionRoles, roles } from "../db/schema";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import { applyReactionRole, broadcastReactions, pruneForeignReactions, reactionsOf, roomForKey, ruleKeysOf } from "../reactions";
import { visibility } from "../visibility";
import type { VoicePresence } from "../voice/presence";

const Params = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

/**
 * Emoji reactions and reaction roles (docs/features/reactions.md, 6 October 2026). Every route is about a message, so it goes
 * by the member's permissions in the message's channel (channelGuard.ts): an invisible channel, like a missing message, is a
 * 404. Emoji travel in the body or the query string, never in the path (a percent-encoded family is longer than Fastify's
 * parameter length). Adding needs ADD_REACTIONS in the channel unless the emoji is a configured reaction role there (that is
 * how a guest accepts the rules); removing one's own reaction never needs a right. A message with rules takes only the
 * configured emoji (409 `reaction_roles_only`; the user's decision of 6 October 2026), and `pruneForeignReactions` removes the
 * others when a rule is made or one of several goes. The rules need MANAGE_ROLES, and the role must be one the actor may
 * give (`canTouchRole`, `canGrant`, as PUT /api/members/:id/roles checks), never the default role.
 */
export async function registerReactionRoutes(app: FastifyInstance, db: Db, hub: Hub, presence: VoicePresence, lk: LivekitAdmin) {
  const deps = { db, hub, presence, lk };
  const rowOf = (r: typeof reactionRoles.$inferSelect): ReactionRole => ({ id: r.id, messageId: r.messageId, channelId: r.channelId, emoji: r.emoji, roleId: r.roleId, removeOnUnreact: r.removeOnUnreact, createdAt: r.createdAt.toISOString() });

  /** The member, the message and their permissions in its channel; 404 `not_found` when the message or the channel is not theirs to see. */
  async function messageActor(req: FastifyRequest, reply: FastifyReply, messageId: string) {
    const m = await requireMember(db, req, reply);
    if (!m) return null;
    const [row] = await db.select({ id: messages.id, channelId: messages.channelId }).from(messages).where(eq(messages.id, messageId)).limit(1);
    const r = row ? await resolveChannel(db, m.userId, row.channelId, "text") : null;
    if (!row || !r) { await reply.code(404).send({ error: "not_found" }); return null; }
    return { m, row, perms: r.perms, channel: r.channel };
  }
  const ruleOf = async (messageId: string, key: string) => (await db.select().from(reactionRoles).where(and(eq(reactionRoles.messageId, messageId), eq(reactionRoles.emojiKey, key))).limit(1))[0] ?? null;
  const answer = async (row: { id: string; channelId: string }, userId: string): Promise<MessageReactions> =>
    ({ messageId: row.id, channelId: row.channelId, reactions: (await reactionsOf(db, [row.id], userId)).get(row.id) ?? [] });

  /** Put an emoji on a message. Idempotent: the same emoji twice is one reaction. */
  app.put<{ Params: { id: string } }>("/api/messages/:id/reactions", { schema: { params: Params } }, async (req, reply) => {
    const c = await messageActor(req, reply, req.params.id);
    if (!c) return;
    const body = ReactRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const emoji = body.data.emoji, key = emojiKey(emoji);
    const rule = await ruleOf(c.row.id, key);
    // A message with reaction roles takes only the configured emoji (the user's decision of 6 October 2026), whatever the right.
    if (!rule && (await ruleKeysOf(db, c.row.id)).size > 0) return reply.code(409).send({ error: "reaction_roles_only" });
    if (!rule && !canIn(c.perms, Permission.ADD_REACTIONS)) return reply.code(403).send({ error: "forbidden" });
    if (!(await roomForKey(db, c.row.id, key))) return reply.code(409).send({ error: "too_many_reactions" });
    const inserted = await db.insert(messageReactions).values({ messageId: c.row.id, userId: c.m.userId, emojiKey: key, emoji }).onConflictDoNothing().returning({ emojiKey: messageReactions.emojiKey });
    if (inserted.length > 0) {
      if (rule) await applyReactionRole(deps, rule, c.m.userId, true, req.log);
      await broadcastReactions(db, hub, c.row, c.m.userId, emoji, true);
    }
    return answer(c.row, c.m.userId);
  });

  /** Take one's own reaction away. Always allowed; 200 when there was none. */
  app.post<{ Params: { id: string } }>("/api/messages/:id/reactions/remove", { schema: { params: Params } }, async (req, reply) => {
    const c = await messageActor(req, reply, req.params.id);
    if (!c) return;
    const body = ReactRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const key = emojiKey(body.data.emoji);
    const removed = await db.delete(messageReactions).where(and(eq(messageReactions.messageId, c.row.id), eq(messageReactions.userId, c.m.userId), eq(messageReactions.emojiKey, key))).returning({ emojiKey: messageReactions.emojiKey });
    if (removed.length > 0) {
      const rule = await ruleOf(c.row.id, key);
      if (rule?.removeOnUnreact) await applyReactionRole(deps, rule, c.m.userId, false, req.log);
      await broadcastReactions(db, hub, c.row, c.m.userId, body.data.emoji, false);
    }
    return answer(c.row, c.m.userId);
  });

  /** Who reacted with one emoji, oldest first. */
  app.get<{ Params: { id: string }; Querystring: { emoji?: string; limit?: string } }>("/api/messages/:id/reactions/users", { schema: { params: Params } }, async (req, reply) => {
    const c = await messageActor(req, reply, req.params.id);
    if (!c) return;
    const emoji = ReactionEmoji.safeParse(req.query.emoji);
    if (!emoji.success) return reply.code(400).send({ error: "bad_request" });
    const key = emojiKey(emoji.data);
    const limit = Math.min(REACTION_USERS_PAGE, Math.max(1, Number(req.query.limit) || REACTION_USERS_PAGE));
    const where = and(eq(messageReactions.messageId, c.row.id), eq(messageReactions.emojiKey, key));
    const [rows, [total]] = await Promise.all([
      db.select({ userId: messageReactions.userId }).from(messageReactions).where(where).orderBy(asc(messageReactions.createdAt)).limit(limit),
      db.select({ n: sql<number>`count(*)::int` }).from(messageReactions).where(where),
    ]);
    const out: ReactionUsersResponse = { userIds: rows.map((r) => r.userId), total: total?.n ?? 0 };
    return out;
  });

  // ---------- Reaction roles (MANAGE_ROLES, server-wide: the bit is not overridable)

  app.get<{ Params: { id: string } }>("/api/messages/:id/reaction-roles", { schema: { params: Params } }, async (req, reply) => {
    const c = await messageActor(req, reply, req.params.id);
    if (!c) return;
    if (!can(c.m.actor, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const rows = await db.select().from(reactionRoles).where(eq(reactionRoles.messageId, c.row.id)).orderBy(asc(reactionRoles.createdAt));
    return { rules: rows.map(rowOf) };
  });

  /** Add or change the rule of one emoji on one message; the count-0 chip goes out to everybody at once. */
  app.put<{ Params: { id: string } }>("/api/messages/:id/reaction-roles", { schema: { params: Params } }, async (req, reply) => {
    const c = await messageActor(req, reply, req.params.id);
    if (!c) return;
    if (!can(c.m.actor, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const body = SetReactionRoleRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [role] = await db.select().from(roles).where(eq(roles.id, body.data.roleId)).limit(1);
    if (!role) return reply.code(400).send({ error: "unknown_role" });
    if (role.isDefault) return reply.code(400).send({ error: "default_role" });
    if (!canTouchRole(c.m.actor, role.position)) return reply.code(403).send({ error: "role_above_you" });
    // Only a role whose permissions one holds oneself (security audit S2, as PUT /api/members/:id/roles): a rule is a way to hand the role out.
    if (!canGrant(c.m.actor, role.permissions)) return reply.code(403).send({ error: "cannot_grant" });
    const key = emojiKey(body.data.emoji);
    if (!(await roomForKey(db, c.row.id, key))) return reply.code(409).send({ error: "too_many_reactions" });
    await db.insert(reactionRoles).values({ messageId: c.row.id, channelId: c.row.channelId, emojiKey: key, emoji: body.data.emoji, roleId: role.id, removeOnUnreact: body.data.removeOnUnreact, createdBy: c.m.userId })
      .onConflictDoUpdate({ target: [reactionRoles.messageId, reactionRoles.emojiKey], set: { roleId: role.id, removeOnUnreact: body.data.removeOnUnreact, emoji: body.data.emoji } });
    req.log.info({ by: c.m.userId, messageId: c.row.id, roleId: role.id, removeOnUnreact: body.data.removeOnUnreact }, "Reaktionsrolle eingerichtet");
    await pruneForeignReactions(db, c.row.id); // only the configured emoji stay on a message with rules
    // `added: false` with the actor as `by`: nobody's own flag changes, the chip simply appears (or carries its role now).
    await broadcastReactions(db, hub, c.row, c.m.userId, body.data.emoji, false);
    const rows = await db.select().from(reactionRoles).where(eq(reactionRoles.messageId, c.row.id)).orderBy(asc(reactionRoles.createdAt));
    return { rules: rows.map(rowOf) };
  });

  /** Remove a rule; the reactions people made stay. */
  app.delete<{ Params: { id: string } }>("/api/reaction-roles/:id", { schema: { params: Params } }, async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const [rule] = await db.select().from(reactionRoles).where(eq(reactionRoles.id, req.params.id)).limit(1);
    if (!rule || !(await resolveChannel(db, m.userId, rule.channelId))) return reply.code(404).send({ error: "not_found" });
    await db.delete(reactionRoles).where(eq(reactionRoles.id, rule.id));
    await pruneForeignReactions(db, rule.messageId); // while other rules remain, the reactions of this emoji go too; the last rule frees the message
    req.log.info({ by: m.userId, messageId: rule.messageId, roleId: rule.roleId }, "Reaktionsrolle entfernt");
    await broadcastReactions(db, hub, { id: rule.messageId, channelId: rule.channelId }, m.userId, rule.emoji, false);
    return { ok: true };
  });

  /** Verwaltung > Reaktionsrollen: every rule in a channel the actor sees, newest first. */
  app.get("/api/reaction-roles", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    await visibility.refresh(db);
    const masks = visibility.masksOf(m.userId);
    const rows = await db.select({ rule: reactionRoles, channelName: channels.name, content: messages.content, authorId: messages.authorId })
      .from(reactionRoles).innerJoin(channels, eq(channels.id, reactionRoles.channelId)).innerJoin(messages, eq(messages.id, reactionRoles.messageId))
      .orderBy(desc(reactionRoles.createdAt));
    const rules: ReactionRoleOverviewEntry[] = rows
      .filter((r) => hasPermission(masks.get(r.rule.channelId) ?? 0, Permission.VIEW_CHANNELS))
      .map((r) => ({ ...rowOf(r.rule), channelName: r.channelName, excerpt: r.content.slice(0, REACTION_ROLE_EXCERPT_MAX), authorId: r.authorId }));
    return { rules };
  });
}

/** The rules a role carries, for `DELETE /api/roles/:id`: their messages lose the count-0 chip live once the role is gone. */
export async function messagesWithRulesOf(db: Db, roleId: string): Promise<{ id: string; channelId: string }[]> {
  const rows = await db.selectDistinct({ id: reactionRoles.messageId, channelId: reactionRoles.channelId }).from(reactionRoles).where(eq(reactionRoles.roleId, roleId));
  return rows;
}
