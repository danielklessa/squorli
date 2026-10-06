import { Permission } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { canChangeGrant, canGrant, canSetRolesOf, canTouchRole, effectivePermissions, outranks, type Actor } from "./authz";

const owner: Actor = { userId: "o", isOwner: true, permissions: Permission.ADMINISTRATOR, roleIds: [], topPosition: 0 };
const mod: Actor = { userId: "m", isOwner: false, permissions: Permission.KICK_MEMBERS | Permission.MANAGE_ROLES, roleIds: [], topPosition: 5 };

describe("authz", () => {
  it("owner outranks everyone but themselves", () => {
    expect(outranks(owner, { userId: "x", isOwner: false, topPosition: 99 })).toBe(true);
    expect(outranks(owner, { userId: "o", isOwner: true, topPosition: 0 })).toBe(false);
  });
  it("nobody outranks the owner or themselves", () => {
    expect(outranks(mod, { userId: "o", isOwner: true, topPosition: 0 })).toBe(false);
    expect(outranks(mod, { userId: "m", isOwner: false, topPosition: 5 })).toBe(false);
  });
  it("position decides between members", () => {
    expect(outranks(mod, { userId: "a", isOwner: false, topPosition: 4 })).toBe(true);
    expect(outranks(mod, { userId: "b", isOwner: false, topPosition: 5 })).toBe(false);
  });
  it("roles below own top position are touchable", () => {
    expect(canTouchRole(mod, 4)).toBe(true);
    expect(canTouchRole(mod, 5)).toBe(false);
    expect(canTouchRole(owner, 1000)).toBe(true);
  });
  it("cannot grant more than one has", () => {
    expect(canGrant(mod, Permission.KICK_MEMBERS)).toBe(true);
    expect(canGrant(mod, Permission.BAN_MEMBERS)).toBe(false);
    expect(canGrant({ ...mod, permissions: Permission.ADMINISTRATOR }, Permission.BAN_MEMBERS)).toBe(true);
  });
  it("editing a mask: only the changed bits count, a foreign bit may stay but not go or come", () => {
    const foreign = Permission.BAN_MEMBERS | Permission.MANAGE_SERVER;
    expect(canChangeGrant(mod, foreign, foreign | Permission.KICK_MEMBERS)).toBe(true); // adds one's own
    expect(canChangeGrant(mod, foreign | Permission.KICK_MEMBERS, foreign)).toBe(true); // removes one's own
    expect(canChangeGrant(mod, foreign, foreign)).toBe(true); // nothing changed (a name edit sends the mask along)
    expect(canChangeGrant(mod, foreign, foreign & ~Permission.BAN_MEMBERS)).toBe(false); // takes a foreign one away
    expect(canChangeGrant(mod, 0, Permission.BAN_MEMBERS)).toBe(false); // adds a foreign one
    expect(canChangeGrant(owner, 0, Permission.ADMINISTRATOR)).toBe(true);
  });
  it("owner is administrator regardless of roles", () => {
    expect(effectivePermissions(true, [])).toBe(Permission.ADMINISTRATOR);
    expect(effectivePermissions(false, [1, 4])).toBe(5);
  });
});

describe("roles of owners", () => {
  const founder: Actor = { userId: "f", isOwner: true, permissions: 0, roleIds: [], topPosition: Number.MAX_SAFE_INTEGER };
  const owner2: Actor = { userId: "o2", isOwner: true, permissions: 0, roleIds: [], topPosition: Number.MAX_SAFE_INTEGER };
  const admin: Actor = { userId: "a", isOwner: false, permissions: 0, roleIds: [], topPosition: 9 };
  it("only the first owner changes another owner's roles", () => {
    expect(canSetRolesOf(founder, owner2, "f")).toBe(true);
    expect(canSetRolesOf(owner2, founder, "f")).toBe(false);
    expect(canSetRolesOf(owner2, { userId: "o3", isOwner: true, topPosition: 0 }, "f")).toBe(false);
    expect(canSetRolesOf(admin, owner2, "f")).toBe(false);
    expect(canSetRolesOf(founder, owner2, null)).toBe(false);
  });
  it("own roles only as an owner (6 October 2026), lower-ranked members by rank", () => {
    expect(canSetRolesOf(owner2, owner2, "f")).toBe(true);
    expect(canSetRolesOf(founder, founder, "f")).toBe(true);
    expect(canSetRolesOf(admin, admin, "f")).toBe(false);
    expect(canSetRolesOf(admin, { userId: "m", isOwner: false, topPosition: 5 }, "f")).toBe(true);
    expect(canSetRolesOf(admin, { userId: "x", isOwner: false, topPosition: 9 }, "f")).toBe(false);
  });
});
