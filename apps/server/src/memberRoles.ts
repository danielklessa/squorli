import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { memberRoles, roles } from "./db/schema";
import { serverEvents, type Origin } from "./events";
import type { Hub } from "./hub";
import type { LivekitAdmin } from "./livekit/admin";
import { syncVoiceAccessOf } from "./livekit/sync";
import { broadcastStructure } from "./state";
import type { VoicePresence } from "./voice/presence";

/**
 * The one path that changes a member's roles (15 November 2026, docs/features/plugins.md): `PUT /api/members/:id/roles`, a
 * reaction role and a plugin all end here. The steps never differ: the rows, the LiveKit grants of a member sitting in a voice
 * channel (livekit/sync.ts), the structure broadcast (which also sends the member their new channel list), and the event
 * `member.roles` with the difference. **Who may do it is not asked here**: the route checks its actor, a reaction rule and a
 * plugin's scope were authorized when they were saved.
 */

export type RoleDeps = { db: Db; hub: Hub; presence: VoicePresence; lk: LivekitAdmin };

/** What changed between two sets of role ids (pure, tested). */
export function roleDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const was = new Set(before), is = new Set(after);
  return { added: [...is].filter((id) => !was.has(id)), removed: [...was].filter((id) => !is.has(id)) };
}

/**
 * Replace a member's roles by `roleIds` (the default role is never a row; the caller left it out). Broadcasts also when
 * nothing changed, as the route always did; the event is told only for a real difference.
 */
export async function setMemberRoles({ db, hub, presence, lk }: RoleDeps, userId: string, roleIds: readonly string[], origin: Origin): Promise<{ added: string[]; removed: string[] }> {
  const before = (await db.select({ roleId: memberRoles.roleId }).from(memberRoles).where(eq(memberRoles.userId, userId))).map((r) => r.roleId);
  const wanted = [...new Set(roleIds)];
  await db.delete(memberRoles).where(eq(memberRoles.userId, userId));
  if (wanted.length) await db.insert(memberRoles).values(wanted.map((roleId) => ({ userId, roleId })));
  await syncVoiceAccessOf(db, hub, presence, lk, { userIds: [userId] });
  await broadcastStructure(db, hub, ["members"]);
  const diff = roleDiff(before, wanted);
  if (diff.added.length || diff.removed.length) serverEvents.emit("member.roles", { userId, ...diff }, origin);
  return diff;
}

/**
 * Give (`give` true) or take one role. Returns whether anything changed: a role the member has already, or does not have,
 * changes nothing and tells nobody. Never the default role, never a role that is gone.
 */
export async function changeMemberRole({ db, hub, presence, lk }: RoleDeps, userId: string, roleId: string, give: boolean, origin: Origin): Promise<boolean> {
  const [role] = await db.select({ id: roles.id, isDefault: roles.isDefault }).from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role || role.isDefault) return false;
  const changed = give
    ? await db.insert(memberRoles).values({ userId, roleId: role.id }).onConflictDoNothing().returning({ roleId: memberRoles.roleId })
    : await db.delete(memberRoles).where(and(eq(memberRoles.userId, userId), eq(memberRoles.roleId, role.id))).returning({ roleId: memberRoles.roleId });
  if (changed.length === 0) return false;
  await syncVoiceAccessOf(db, hub, presence, lk, { userIds: [userId] });
  await broadcastStructure(db, hub, ["members"]);
  serverEvents.emit("member.roles", { userId, added: give ? [role.id] : [], removed: give ? [] : [role.id] }, origin);
  return true;
}
