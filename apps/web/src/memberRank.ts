import { Permission, hasPermission, type Member, type Role } from "@squorli/protocol";

/**
 * The server's rank rules (`apps/server/src/authz.ts`, `actorOf` in `state.ts`) for the member menu, so that it only offers what the
 * server would accept (user's rule, 19 September 2026: what you cannot assign is not shown). Pure, tested. The server stays the
 * authority; this only decides what is drawn.
 */

/**
 * Roles in the order the server's owner arranged them (Verwaltung > Rollen: the highest position on top). Every list of roles
 * the user sees takes this order (user's rule, 24 September 2026); the server sends them in no promised order.
 */
export function rolesByRank<R extends Pick<Role, "position">>(roles: readonly R[]): R[] {
  return [...roles].sort((a, b) => b.position - a.position);
}

/**
 * The member's highest role, for the colour of their name and the grouping of the member list; the default role is not one
 * of `roleIds`, so it never colours anybody. undefined = only the default role.
 */
export function topRoleOf(m: Pick<Member, "roleIds">, roles: readonly Role[]): Role | undefined {
  return m.roleIds.map((id) => roles.find((r) => r.id === id)).filter((r): r is Role => !!r).sort((a, b) => b.position - a.position)[0];
}

/** Highest role position of a member, the default role included; owners stand above every role. */
export function topPositionOf(m: Pick<Member, "roleIds" | "isOwner">, roles: readonly Role[]): number {
  if (m.isOwner) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, ...roles.filter((r) => r.isDefault || m.roleIds.includes(r.id)).map((r) => r.position));
}

/**
 * May `me` change the roles of `target` at all? One's own only as an owner (user's decision, 6 October 2026: the menu shows
 * one's own roles, somebody above changes them); an owner's roles only by the first owner (`ownerId`); otherwise by an owner or
 * by someone whose highest role stands above the target's. The permission MANAGE_ROLES is checked by the caller.
 */
export function canSetRolesOf(me: Pick<Member, "userId" | "roleIds" | "isOwner">, target: Pick<Member, "userId" | "roleIds" | "isOwner">, roles: readonly Role[], ownerId: string | null): boolean {
  if (target.userId === me.userId) return me.isOwner;
  if (target.isOwner) return me.userId === ownerId;
  return me.isOwner || topPositionOf(me, roles) > topPositionOf(target, roles);
}

/** The server-wide permissions of a member from their roles, the default role included (the server's `actorOf`). */
export function permissionsOf(m: Pick<Member, "roleIds" | "isOwner">, roles: readonly Role[]): number {
  if (m.isOwner) return Permission.ADMINISTRATOR;
  return roles.filter((r) => r.isDefault || m.roleIds.includes(r.id)).reduce((mask, r) => mask | r.permissions, 0);
}

/**
 * The roles `me` may give or take: never the default role, only roles below the own highest one (owners: all), and only roles
 * whose permissions `me` holds (the server's `canGrant`, since 2 October 2026); in the owner's order.
 */
export function assignableRoles(me: Pick<Member, "roleIds" | "isOwner">, roles: readonly Role[]): Role[] {
  const top = topPositionOf(me, roles);
  const mine = permissionsOf(me, roles);
  const grantable = (r: Role) => hasPermission(mine, Permission.ADMINISTRATOR) || (r.permissions & ~mine) === 0;
  return rolesByRank(roles).filter((r) => !r.isDefault && (me.isOwner || r.position < top) && grantable(r));
}
