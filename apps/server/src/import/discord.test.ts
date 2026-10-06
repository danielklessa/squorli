import { Permission } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import type { Actor } from "../authz";
import { DiscordTemplate, mapBitrate, mapColor, mapDiscordPermissions, mapOverwrites, planDiscordImport, type ExistingStructure } from "./discord";

const owner: Actor = { userId: "o", isOwner: true, permissions: Permission.ADMINISTRATOR, roleIds: [], topPosition: 0 };
const mod: Actor = { userId: "m", isOwner: false, permissions: Permission.MANAGE_CHANNELS | Permission.MANAGE_ROLES | Permission.KICK_MEMBERS, roleIds: [], topPosition: 5 };
const empty: ExistingStructure = { categories: [], channels: [], roles: [{ name: "Gast", isDefault: true }, { name: "Admin", isDefault: false }], afkChannelId: null };

/** Roughly what Discord serves for a small template (ids are placeholders, permissions decimal strings). */
const template = DiscordTemplate.parse({
  code: "2TffvPucqHkN", name: "Gilde", description: " Unsere Vorlage ",
  serialized_source_guild: {
    name: "Gilde", afk_channel_id: 9,
    roles: [
      { id: 0, name: "@everyone", color: 0, permissions: "1071698660929" },
      { id: 1, name: "Mod", color: 16711680, permissions: String((1n << 1n) | (1n << 2n) | (1n << 24n) | (1n << 10n)) },
      { id: 2, name: "Admin", color: 0, permissions: "8" },
      { id: 3, name: "  ", color: 0, permissions: "0" },
    ],
    channels: [
      { id: 4, type: 4, name: "Allgemein", position: 1 },
      { id: 5, type: 4, name: "Spiele", position: 0, permission_overwrites: [{ id: 0, type: 0, allow: "0", deny: "1024" }, { id: 2, type: 0, allow: "1024", deny: "0" }] },
      { id: 6, type: 0, name: "regeln", position: 0, parent_id: null, topic: "Lies das", permission_overwrites: [{ id: 0, type: 0, allow: "0", deny: "2048" }, { id: 1, type: 0, allow: "2048", deny: "0" }, { id: 77, type: 1, allow: "1024", deny: "0" }] },
      { id: 7, type: 2, name: "Lobby", position: 0, parent_id: 4, bitrate: 96000 },
      { id: 8, type: 0, name: "chat", position: 5, parent_id: 4 },
      { id: 9, type: 2, name: "AFK", position: 1, parent_id: 4, bitrate: 8000 },
      { id: 10, type: 15, name: "forum", position: 0, parent_id: 5 },
      { id: 11, type: 13, name: "Bühne", position: 0, parent_id: 5, bitrate: 384000 },
      { id: 12, type: 14, name: "verzeichnis", position: 1, parent_id: 5 },
      { id: 13, type: 0, name: "verwaist", position: 0, parent_id: 99 },
    ],
  },
});

describe("Discord permission mapping", () => {
  it("maps the bits that have a counterpart and drops the rest", () => {
    expect(mapDiscordPermissions("8")).toBe(Permission.ADMINISTRATOR);
    expect(mapDiscordPermissions(String((1n << 20n) | (1n << 9n)))).toBe(Permission.CONNECT_VOICE | Permission.VIEW_VIDEO | Permission.STREAM_VIDEO);
    expect(mapDiscordPermissions(String((1n << 22n) | (1n << 23n)))).toBe(Permission.MODERATE_VOICE);
    expect(mapDiscordPermissions(String(1n << 24n))).toBe(Permission.MOVE_MEMBERS);
    expect(mapDiscordPermissions(String((1n << 16n) | (1n << 34n)))).toBe(0); // history, threads
    expect(mapDiscordPermissions(String(1n << 6n))).toBe(Permission.ADD_REACTIONS); // reactions, since 6 October 2026
    expect(mapDiscordPermissions(String((1n << 5n) | (1n << 0n) | (1n << 15n)))).toBe(Permission.MANAGE_SERVER | Permission.CREATE_INVITES | Permission.ATTACH_FILES);
    expect(mapDiscordPermissions("nonsense")).toBe(0);
    expect(mapDiscordPermissions("-1")).toBe(0);
    expect(mapDiscordPermissions(1 << 11)).toBe(Permission.SEND_MESSAGES);
  });

  it("rounds bitrates to the client's steps and turns colors into hex", () => {
    expect(mapBitrate(64000)).toBe(64);
    expect(mapBitrate(96000)).toBe(96);
    expect(mapBitrate(8000)).toBe(24);
    expect(mapBitrate(384000)).toBe(256);
    expect(mapBitrate(undefined)).toBe(64);
    expect(mapColor(0)).toBeNull();
    expect(mapColor(16711680)).toBe("#ff0000");
    expect(mapColor(255)).toBe("#0000ff");
  });
});

describe("planDiscordImport", () => {
  it("orders categories and channels like Discord, maps kinds, keeps topic and bitrate, counts overwrites", () => {
    const plan = planDiscordImport(template, empty, owner);
    expect(plan.source).toEqual({ code: "2TffvPucqHkN", name: "Gilde", description: "Unsere Vorlage" });
    expect(plan.categories.map((c) => c.name)).toEqual(["Spiele", "Allgemein"]);
    expect(plan.channels.map((c) => [c.name, c.kind, c.categoryKey])).toEqual([
      ["regeln", "text", null], ["verwaist", "text", null],
      ["forum", "text", "5"], ["Bühne", "voice", "5"],
      ["chat", "text", "4"], ["Lobby", "voice", "4"], ["AFK", "voice", "4"],
    ]);
    const regeln = plan.channels.find((c) => c.name === "regeln")!;
    expect(regeln.topic).toBe("Lies das");
    // Discord's SEND_MESSAGES (bit 11 = 2048) denied for @everyone and allowed for "Mod"; the member overwrite is counted and dropped.
    expect(regeln.overwrites).toEqual([{ roleKey: "everyone", allow: 0, deny: Permission.SEND_MESSAGES }, { roleKey: "1", allow: Permission.SEND_MESSAGES, deny: 0 }]);
    expect(regeln.memberOverwrites).toBe(1);
    expect(regeln.private).toBe(false);
    // A private category (VIEW_CHANNEL = bit 10 denied for @everyone, allowed for "Admin"): its channels count as private.
    const spiele = plan.categories.find((c) => c.name === "Spiele")!;
    expect(spiele.overwrites).toEqual([{ roleKey: "everyone", allow: 0, deny: Permission.VIEW_CHANNELS }, { roleKey: "2", allow: Permission.VIEW_CHANNELS, deny: 0 }]);
    expect(plan.channels.find((c) => c.name === "forum")!.private).toBe(true);
    expect(plan.channels.find((c) => c.name === "chat")!.private).toBe(false);
    expect(plan.channels.find((c) => c.name === "Lobby")!.audioBitrate).toBe(96);
    expect(plan.channels.find((c) => c.name === "Bühne")!.audioBitrate).toBe(256);
    expect(plan.dropped).toContainEqual({ name: "verzeichnis", kind: "channel", reason: "unsupported" });
    expect(plan.afkChannelKey).toBe("9");
  });

  it("orders roles most powerful first, drops @everyone and blank names, marks duplicates", () => {
    const plan = planDiscordImport(template, empty, owner);
    expect(plan.roles.map((r) => [r.name, r.exists, r.blocked])).toEqual([["Admin", true, null], ["Mod", false, null]]);
    expect(plan.roles[1]).toMatchObject({ color: "#ff0000", permissions: Permission.KICK_MEMBERS | Permission.BAN_MEMBERS | Permission.MOVE_MEMBERS | Permission.VIEW_CHANNELS });
    expect(plan.dropped).toContainEqual({ name: "@everyone", kind: "role", reason: "default_role" });
  });

  it("blocks roles whose permissions the actor may not grant", () => {
    const plan = planDiscordImport(template, empty, mod);
    expect(plan.roles.find((r) => r.name === "Mod")!.blocked).toBe("cannot_grant"); // BAN_MEMBERS and MOVE_MEMBERS are not the mod's
    expect(plan.roles.find((r) => r.name === "Admin")!.blocked).toBe("cannot_grant");
  });

  it("reuses an existing category by name and skips a channel that already sits in it; no AFK offer once one is set", () => {
    const existing: ExistingStructure = {
      categories: [{ id: "cat-a", name: "allgemein" }],
      channels: [{ name: "CHAT", kind: "text", categoryId: "cat-a" }, { name: "chat", kind: "voice", categoryId: "cat-a" }, { name: "regeln", kind: "text", categoryId: "cat-a" }],
      roles: [], afkChannelId: "some-channel",
    };
    const plan = planDiscordImport(template, existing, owner);
    expect(plan.categories.find((c) => c.name === "Allgemein")!.existingId).toBe("cat-a");
    expect(plan.channels.find((c) => c.name === "chat")!.exists).toBe(true);
    expect(plan.channels.find((c) => c.name === "Lobby")!.exists).toBe(false);
    expect(plan.channels.find((c) => c.name === "regeln")!.exists).toBe(false); // top level, not in the category
    expect(plan.afkChannelKey).toBeNull();
  });

  it("does not offer the AFK channel when it exists already or is not a voice channel", () => {
    const t = DiscordTemplate.parse({ ...template, serialized_source_guild: { ...template.serialized_source_guild, afk_channel_id: 8 } });
    expect(planDiscordImport(t, empty, owner).afkChannelKey).toBeNull();
  });
});

describe("mapOverwrites", () => {
  it("keeps only channel-overridable bits, drops empty and member entries, names @everyone", () => {
    const everyone = new Set(["0"]);
    // Discord's MANAGE_ROLES (bit 28) is not a channel right here; VIEW_CHANNEL (bit 10) is.
    const r = mapOverwrites([
      { id: "0", type: 0, allow: "0", deny: String(1n << 10n) },
      { id: "5", type: 0, allow: String((1n << 28n) | (1n << 10n)), deny: "0" },
      { id: "6", type: 0, allow: String(1n << 28n), deny: "0" },
      { id: "9", type: 1, allow: String(1n << 10n), deny: "0" },
    ], everyone);
    expect(r.overwrites).toEqual([{ roleKey: "everyone", allow: 0, deny: Permission.VIEW_CHANNELS }, { roleKey: "5", allow: Permission.VIEW_CHANNELS, deny: 0 }]);
    expect(r.memberOverwrites).toBe(1);
  });
});
