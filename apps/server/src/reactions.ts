import { REACTIONS_PER_MESSAGE_MAX, type ReactionChip } from "@squorli/protocol";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db";
import { memberRoles, messageReactions, reactionRoles, roles } from "./db/schema";
import type { Hub } from "./hub";
import type { LivekitAdmin } from "./livekit/admin";
import { syncVoiceAccessOf } from "./livekit/sync";
import { broadcastStructure } from "./state";
import type { VoicePresence } from "./voice/presence";

/**
 * Emoji reactions and reaction roles (docs/features/reactions.md, 6 October 2026): what the routes (routes/reactions.ts) and
 * the message loader (routes/messages.ts) share. The chips of a message are read in one grouped query per page of messages;
 * a reaction role fires here, on the same path `PUT /api/members/:id/roles` takes (the row, the LiveKit grants, the
 * structure broadcast), without an actor check: the rule was authorized when it was saved.
 */

/** One emoji of one message as the database groups it: how many, whether the viewer is among them, and when it started. */
export type ReactionGroup = { messageId: string; emojiKey: string; emoji: string; count: number; mine: boolean; firstAt: number };
/** A rule as the merge needs it. */
export type ReactionRuleRow = { messageId: string; emojiKey: string; emoji: string; roleId: string; createdAt: number };

/**
 * The chips of one message (pure, tested): the configured emoji first in the order the rules were made (they stand for
 * "click here", so they never jump), then the others in the order of their first reaction. A configured emoji nobody used
 * yet is a chip with count 0; one that was used carries both the count and the role.
 */
export function mergeChips(groups: readonly ReactionGroup[], rules: readonly ReactionRuleRow[]): ReactionChip[] {
  const byKey = new Map(groups.map((g) => [g.emojiKey, g]));
  const out: ReactionChip[] = [];
  const done = new Set<string>();
  for (const r of [...rules].sort((a, b) => a.createdAt - b.createdAt)) {
    const g = byKey.get(r.emojiKey);
    out.push({ emoji: g?.emoji ?? r.emoji, count: g?.count ?? 0, me: g?.mine ?? false, roleId: r.roleId });
    done.add(r.emojiKey);
  }
  for (const g of [...groups].sort((a, b) => a.firstAt - b.firstAt)) if (!done.has(g.emojiKey)) out.push({ emoji: g.emoji, count: g.count, me: g.mine });
  return out;
}

/** The chips of every given message, `me` for `viewerId` (null = a broadcast, nobody's). A message without any gets `[]`. */
export async function reactionsOf(db: Db, messageIds: readonly string[], viewerId: string | null): Promise<Map<string, ReactionChip[]>> {
  const out = new Map<string, ReactionChip[]>(messageIds.map((id) => [id, []]));
  if (messageIds.length === 0) return out;
  const ids = [...messageIds];
  const [groups, rules] = await Promise.all([
    db.select({
      messageId: messageReactions.messageId,
      emojiKey: messageReactions.emojiKey,
      // The display form of whoever reacted first: "❤" and "❤️" are one key, the chip shows the form the first one typed.
      emoji: sql<string>`(array_agg(${messageReactions.emoji} ORDER BY ${messageReactions.createdAt}))[1]`,
      count: sql<number>`count(*)::int`,
      mine: viewerId ? sql<boolean>`bool_or(${messageReactions.userId} = ${viewerId}::uuid)` : sql<boolean>`false`,
      firstAt: sql<string>`min(${messageReactions.createdAt})`,
    }).from(messageReactions).where(inArray(messageReactions.messageId, ids)).groupBy(messageReactions.messageId, messageReactions.emojiKey),
    db.select({ messageId: reactionRoles.messageId, emojiKey: reactionRoles.emojiKey, emoji: reactionRoles.emoji, roleId: reactionRoles.roleId, createdAt: reactionRoles.createdAt })
      .from(reactionRoles).where(inArray(reactionRoles.messageId, ids)),
  ]);
  const groupsOf = new Map<string, ReactionGroup[]>(), rulesOf = new Map<string, ReactionRuleRow[]>();
  for (const g of groups) (groupsOf.get(g.messageId) ?? groupsOf.set(g.messageId, []).get(g.messageId)!).push({ ...g, mine: !!g.mine, firstAt: new Date(g.firstAt).getTime() });
  for (const r of rules) (rulesOf.get(r.messageId) ?? rulesOf.set(r.messageId, []).get(r.messageId)!).push({ ...r, createdAt: r.createdAt.getTime() });
  for (const id of ids) {
    const g = groupsOf.get(id), r = rulesOf.get(id);
    if (g || r) out.set(id, mergeChips(g ?? [], r ?? []));
  }
  return out;
}

/** The distinct emoji a message carries, reactions and configured ones together (the cap `REACTIONS_PER_MESSAGE_MAX`). */
export async function distinctKeysOf(db: Db, messageId: string): Promise<Set<string>> {
  const [a, b] = await Promise.all([
    db.selectDistinct({ key: messageReactions.emojiKey }).from(messageReactions).where(eq(messageReactions.messageId, messageId)),
    db.select({ key: reactionRoles.emojiKey }).from(reactionRoles).where(eq(reactionRoles.messageId, messageId)),
  ]);
  return new Set([...a, ...b].map((r) => r.key));
}

/** Would one more distinct emoji on this message pass the cap? (An emoji already there always may.) */
export async function roomForKey(db: Db, messageId: string, emojiKey: string): Promise<boolean> {
  const keys = await distinctKeysOf(db, messageId);
  return keys.has(emojiKey) || keys.size < REACTIONS_PER_MESSAGE_MAX;
}

/** The emoji keys a message's rules name; empty = the message takes any emoji. */
export async function ruleKeysOf(db: Db, messageId: string): Promise<Set<string>> {
  return new Set((await db.select({ key: reactionRoles.emojiKey }).from(reactionRoles).where(eq(reactionRoles.messageId, messageId))).map((r) => r.key));
}

/**
 * A message with reaction roles takes only the configured emoji (the user's decision of 6 October 2026): whatever other
 * reactions it carries go when a rule is made, and the reactions of an emoji whose rule went go too while other rules
 * remain. Returns whether anything was removed. A message without rules is left alone.
 */
export async function pruneForeignReactions(db: Db, messageId: string): Promise<boolean> {
  const keys = await ruleKeysOf(db, messageId);
  if (keys.size === 0) return false;
  const gone = await db.delete(messageReactions).where(and(eq(messageReactions.messageId, messageId), notInArray(messageReactions.emojiKey, [...keys]))).returning({ key: messageReactions.emojiKey });
  return gone.length > 0;
}

export type RoleDeps = { db: Db; hub: Hub; presence: VoicePresence; lk: LivekitAdmin };

/**
 * A reaction role fires: give (`give` true) or take away (false, only with the rule's `removeOnUnreact`, the caller decides)
 * the role. The same steps as `PUT /api/members/:id/roles`: the row, the LiveKit grants of a seated member, the structure
 * broadcast (which also sends the member their new channel list). No moderation-log entry: it is the member's own action.
 * Returns whether anything changed. Never the default role (a rule cannot name it; guarded anyway).
 */
export async function applyReactionRole({ db, hub, presence, lk }: RoleDeps, rule: { roleId: string; messageId: string }, userId: string, give: boolean, log?: FastifyBaseLogger): Promise<boolean> {
  const [role] = await db.select({ id: roles.id, isDefault: roles.isDefault }).from(roles).where(eq(roles.id, rule.roleId)).limit(1);
  if (!role || role.isDefault) return false;
  const changed = give
    ? await db.insert(memberRoles).values({ userId, roleId: role.id }).onConflictDoNothing().returning({ roleId: memberRoles.roleId })
    : await db.delete(memberRoles).where(and(eq(memberRoles.userId, userId), eq(memberRoles.roleId, role.id))).returning({ roleId: memberRoles.roleId });
  if (changed.length === 0) return false;
  log?.info({ userId, roleId: role.id, messageId: rule.messageId, give }, give ? "Reaktionsrolle vergeben" : "Reaktionsrolle entzogen");
  await syncVoiceAccessOf(db, hub, presence, lk, { userIds: [userId] });
  await broadcastStructure(db, hub, ["members"]);
  return true;
}

/** Tell everybody who sees the channel what the message's reactions are now (the whole list, nobody's `me`). */
export async function broadcastReactions(db: Db, hub: Hub, message: { id: string; channelId: string }, by: string, emoji: string, added: boolean): Promise<void> {
  const chips = (await reactionsOf(db, [message.id], null)).get(message.id) ?? [];
  hub.broadcastToChannel(message.channelId, { type: "message.reactions", channelId: message.channelId, messageId: message.id, reactions: chips.map(({ me: _me, ...c }) => c), by, emoji, added });
}
