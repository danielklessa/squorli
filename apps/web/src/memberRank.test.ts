import { Permission, type Role } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { assignableRoles, canSetRolesOf, permissionsOf, rolesByRank, topPositionOf } from "./memberRank";

const role = (id: string, position: number, isDefault = false): Role => ({ id, name: id, color: null, permissions: 0, position, isDefault });
const roles = [role("guest", 0, true), role("member", 1), role("mod", 5), role("admin", 9)];
const m = (userId: string, roleIds: string[], isOwner = false) => ({ userId, roleIds, isOwner });
const founder = m("founder", [], true); const owner2 = m("owner2", ["member"], true);
const admin = m("admin", ["admin"]); const mod = m("mod", ["mod", "member"]); const guest = m("guest", []);

describe("member rank", () => {
  it("takes the highest role, the default role included, and puts owners above everything", () => {
    expect(topPositionOf(guest, roles)).toBe(0);
    expect(topPositionOf(mod, roles)).toBe(5);
    expect(topPositionOf(owner2, roles)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("lets only the first owner change another owner's roles", () => {
    expect(canSetRolesOf(founder, owner2, roles, "founder")).toBe(true);
    expect(canSetRolesOf(owner2, founder, roles, "founder")).toBe(false);
    expect(canSetRolesOf(owner2, m("owner3", [], true), roles, "founder")).toBe(false);
    expect(canSetRolesOf(admin, owner2, roles, "founder")).toBe(false);
  });
  it("one's own roles only as an owner (6 October 2026)", () => {
    expect(canSetRolesOf(founder, founder, roles, "founder")).toBe(true);
    expect(canSetRolesOf(owner2, owner2, roles, "founder")).toBe(true);
    expect(canSetRolesOf(admin, admin, roles, "founder")).toBe(false);
  });
  it("otherwise needs an owner or a higher role than the target's", () => {
    expect(canSetRolesOf(owner2, admin, roles, "founder")).toBe(true);
    expect(canSetRolesOf(admin, mod, roles, "founder")).toBe(true);
    expect(canSetRolesOf(mod, admin, roles, "founder")).toBe(false);
    expect(canSetRolesOf(mod, m("mod2", ["mod"]), roles, "founder")).toBe(false);
    expect(canSetRolesOf(mod, guest, roles, "founder")).toBe(true);
  });
  it("offers only roles below the own highest one, never the default role, highest first", () => {
    expect(assignableRoles(mod, roles).map((r) => r.id)).toEqual(["member"]);
    expect(assignableRoles(admin, roles).map((r) => r.id)).toEqual(["mod", "member"]);
    expect(assignableRoles(founder, [...roles].reverse()).map((r) => r.id)).toEqual(["admin", "mod", "member"]);
    expect(assignableRoles(guest, roles)).toEqual([]);
  });
  it("offers only roles whose permissions one holds oneself (security audit, 2 October 2026)", () => {
    const P = Permission;
    const r2 = [
      { ...role("guest", 0, true), permissions: P.VIEW_CHANNELS },
      { ...role("helper", 6), permissions: P.MANAGE_ROLES | P.KICK_MEMBERS },
      { ...role("mod", 3), permissions: P.KICK_MEMBERS | P.BAN_MEMBERS },
      { ...role("boss", 2), permissions: P.ADMINISTRATOR },
      { ...role("kicker", 1), permissions: P.KICK_MEMBERS },
      { ...role("admin", 9), permissions: P.ADMINISTRATOR },
    ];
    expect(assignableRoles(m("h", ["helper"]), r2).map((r) => r.id)).toEqual(["kicker"]);
    expect(assignableRoles(m("a", ["admin"]), r2).map((r) => r.id)).toEqual(["helper", "mod", "boss", "kicker"]);
    expect(permissionsOf(m("h", ["helper"]), r2)).toBe(P.VIEW_CHANNELS | P.MANAGE_ROLES | P.KICK_MEMBERS);
  });
  it("lists roles in the owner's order whatever order they arrive in", () => {
    expect(rolesByRank([roles[2]!, roles[0]!, roles[3]!, roles[1]!]).map((r) => r.id)).toEqual(["admin", "mod", "member", "guest"]);
  });
});
