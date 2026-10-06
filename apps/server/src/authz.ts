import { Permission, hasPermission } from "@squorli/protocol";

/**
 * Pure permission logic without a database, so it stays testable.
 * Hierarchy: the owner outranks everything. Otherwise the highest role position counts;
 * you may only act on roles and members below your own highest position.
 */
export type Actor = {
  userId: string; isOwner: boolean; permissions: number; topPosition: number;
  /** Every role the member holds, the default role included (channelPermissions.ts resolves overwrites by them). */
  roleIds: readonly string[];
};
export type Target = { userId: string; isOwner: boolean; topPosition: number };

export const can = (a: Actor, perm: number) => hasPermission(a.permissions, perm);

/** May actor act on target (kick, ban, set roles)? Nobody acts on themselves or on the owner. */
export function outranks(a: Actor, t: Target): boolean {
  if (a.userId === t.userId || t.isOwner) return false;
  return a.isOwner || a.topPosition > t.topPosition;
}

/**
 * May actor change target's roles? Your own only as an owner (user's decision, 6 October 2026: a member sees their roles in the
 * menu but cannot change them, somebody above them does; an owner gives themselves what they like, it only colours their name;
 * until then everybody could change their own roles within the role check). An owner's roles only by the first owner
 * (`founderId` = server_settings.owner_id; user's decision, 19 September 2026: the main owner can give other owners roles, nobody
 * else can). Everyone else by rank, like kick and ban. The client mirrors this in `apps/web/src/memberRank.ts`.
 */
export function canSetRolesOf(a: Actor, t: Target, founderId: string | null): boolean {
  if (a.userId === t.userId) return a.isOwner;
  if (t.isOwner) return a.userId === founderId;
  return outranks(a, t);
}

/** May actor edit, delete or assign a role at this position? */
export function canTouchRole(a: Actor, rolePosition: number): boolean {
  return a.isOwner || rolePosition < a.topPosition;
}

/** You may only grant permissions you hold yourself (administrator: everything). */
export function canGrant(a: Actor, permissions: number): boolean {
  if (a.isOwner || hasPermission(a.permissions, Permission.ADMINISTRATOR)) return true;
  return (permissions & ~a.permissions) === 0;
}

/**
 * May actor turn a mask `before` into `after`? Only the bits that change count (Discord's rule): a bit one does not hold
 * stays as it is, whichever way, and the rest of the mask may be edited. Until 6 October 2026 the routes checked the whole
 * new mask, so a role or overwrite that held one bit the editor lacked could not be touched at all, not even its name.
 */
export function canChangeGrant(a: Actor, before: number, after: number): boolean {
  return canGrant(a, before ^ after);
}

/** Effective permissions from roles; an owner is always an administrator. */
export function effectivePermissions(isOwner: boolean, roleMasks: number[]): number {
  if (isOwner) return Permission.ADMINISTRATOR;
  return roleMasks.reduce((m, r) => m | r, 0);
}
