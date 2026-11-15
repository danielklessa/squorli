import { describe, expect, it } from "vitest";
import { Message, PLUGIN_SOURCE_MAX_BYTES, parsePluginDate, PluginInstallRequest, PluginManifest, PluginSurface, PluginsResponse, ServerEvent, ServerState, cleanPluginText, pluginText } from "./index";

const base = { id: "timed-roles", name: "Timed roles", description: "Gives a role for a time.", version: "1.0.0", apiVersion: 1 };

describe("PluginManifest (strict)", () => {
  it("takes a minimal manifest and fills the defaults", () => {
    const m = PluginManifest.parse(base);
    expect(m.name).toEqual({ en: "Timed roles" });
    expect(m.capabilities).toEqual([]);
    expect(m.settings).toEqual([]);
  });

  it("takes texts in two languages", () => {
    const m = PluginManifest.parse({ ...base, name: { en: "Timed roles", de: "Zeitrollen" } });
    expect(pluginText(m.name, "de")).toBe("Zeitrollen");
    expect(pluginText(m.name, "en")).toBe("Timed roles");
    expect(pluginText({ en: "only" }, "de")).toBe("only");
  });

  it("refuses what this server does not know", () => {
    expect(PluginManifest.safeParse({ ...base, surprise: 1 }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, capabilities: ["network"] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "a", type: "color", label: "A" }] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, id: "X" }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, version: "1.0" }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, homepage: "http://example.org" }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, memberActions: [{ id: "a", label: "A", permission: "FLY" }] }).success).toBe(false);
  });

  it("refuses control characters and direction marks in every text a person reads", () => {
    const esc = String.fromCharCode(27), rlo = String.fromCharCode(0x202e);
    expect(PluginManifest.safeParse({ ...base, name: `Nice${esc}[2J` }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, name: { en: "Nice", de: `Zeile\nzwei` } }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, description: `gpj.${rlo}exe` }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, author: `me${esc}` }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "a", type: "text", label: `A${esc}` }] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, name: "Zeitrollen äöü ✓" }).success).toBe(true);
    expect(cleanPluginText(`a${esc}[31mb\nc${rlo}d`)).toBe("a[31mb\ncd");
  });

  it("reads a date with and without its year", () => {
    expect(parsePluginDate("1990-12-24")).toEqual({ year: 1990, month: 12, day: 24 });
    expect(parsePluginDate("--12-24", true)).toEqual({ year: null, month: 12, day: 24 });
    expect(parsePluginDate("--12-24")).toBeNull();
    expect(parsePluginDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parsePluginDate("2023-02-29")).toBeNull();
    expect(parsePluginDate("--02-29", true)).toEqual({ year: null, month: 2, day: 29 });
    expect(parsePluginDate("--02-30", true)).toBeNull();
    expect(parsePluginDate("0050-01-01")).toEqual({ year: 50, month: 1, day: 1 });
    for (const bad of ["", "24.12.1990", "1990-13-01", "1990-00-10", "1990-04-31", "1990-4-1", "0000-01-01", "1990-12-24T00:00", " 1990-12-24"]) expect(parsePluginDate(bad, true), bad).toBeNull();
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "d", type: "date", label: "D", yearOptional: true }] }).success).toBe(true);
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "d", type: "text", label: "D", yearOptional: true }] }).success).toBe(false);
  });

  it("checks the fields against each other", () => {
    const settings = [{ key: "roles", type: "roles", label: "Roles" }, { key: "room", type: "channel", label: "Channel" }];
    const action = (fields: unknown[]) => ({ ...base, settings, memberActions: [{ id: "give", label: "Give", permission: "MANAGE_ROLES", fields }] });
    expect(PluginManifest.safeParse(action([{ key: "role", type: "role", label: "Role", from: "roles" }])).success).toBe(true);
    expect(PluginManifest.safeParse(action([{ key: "role", type: "role", label: "Role", from: "room" }])).success).toBe(false);
    expect(PluginManifest.safeParse(action([{ key: "role", type: "role", label: "Role", from: "nothing" }])).success).toBe(false);
    expect(PluginManifest.safeParse(action([{ key: "a", type: "text", label: "A" }, { key: "a", type: "text", label: "B" }])).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "a", type: "select", label: "A" }] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "a", type: "number", label: "A", min: 5, max: 1 }] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, commands: [{ name: "hi", description: "Hi", input: "form" }] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, commands: [{ name: "hi", description: "Hi" }, { name: "hi", description: "Again" }] }).success).toBe(false);
    // A settings field never has `from`.
    expect(PluginManifest.safeParse({ ...base, settings: [{ key: "a", type: "role", label: "A", from: "a" }] }).success).toBe(false);
  });
});

describe("what clients get (lenient)", () => {
  const command = { plugin: "p-one", pluginName: { en: "P" }, name: "hi", description: { en: "Hi" }, permission: "SEND_MESSAGES", input: "none" };

  it("drops the entry it cannot read and keeps the rest", () => {
    const s = PluginSurface.parse({ commands: [command, { nonsense: true }, 7], memberActions: "what" === "what" ? [null] : [] });
    expect(s.commands.map((c) => c.name)).toEqual(["hi"]);
    expect(s.memberActions).toEqual([]);
  });

  it("keeps a field type and a permission of a later version as they are", () => {
    const s = PluginSurface.parse({ commands: [{ ...command, permission: "FLY", input: "voice", fields: [{ key: "c", type: "color", label: { en: "Color" } }] }], memberActions: [] });
    expect(s.commands[0]!.fields[0]!.type).toBe("color");
    expect(s.commands[0]!.permission).toBe("FLY");
  });

  it("never costs a client its welcome or a structure event", () => {
    const state = { settings: { name: "S", ownerId: null, openJoin: false, iconUrl: null }, categories: [], channels: [], roles: [], members: [], myPermissions: 0 };
    const parsed = ServerState.safeParse({ ...state, plugins: "broken" });
    // Whatever else the settings need, a broken `plugins` must not be among the issues.
    if (!parsed.success) expect(parsed.error.issues.some((i) => i.path[0] === "plugins")).toBe(false);
    else expect(parsed.data.plugins).toBeUndefined();
    const ev = ServerEvent.safeParse({ type: "structure", plugins: { commands: [command], memberActions: [] } });
    expect(ev.success).toBe(true);
    const broken = ServerEvent.safeParse({ type: "structure", plugins: 5 });
    expect(broken.success).toBe(true);
  });

  it("a message by a plugin parses, and a broken plugin field is left out", () => {
    const msg = { id: "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a11", seq: 1, channelId: "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a12", authorId: "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a13", content: "hi", attachments: [], notice: true, createdAt: new Date(0).toISOString(), editedAt: null };
    expect(Message.parse({ ...msg, plugin: { id: "p-one", name: { en: "P" } } }).plugin?.id).toBe("p-one");
    expect(Message.parse({ ...msg, plugin: { nope: 1 } }).plugin).toBeUndefined();
    expect(Message.parse(msg).plugin).toBeUndefined();
  });

  it("lets a file that is too large through to the answer that says so", () => {
    expect(PluginInstallRequest.safeParse({ source: "x".repeat(PLUGIN_SOURCE_MAX_BYTES + 1), fileName: "big.js" }).success).toBe(true);
    expect(PluginInstallRequest.safeParse({ source: "x".repeat(PLUGIN_SOURCE_MAX_BYTES * 3 + 1), fileName: "big.js" }).success).toBe(false);
  });

  it("the admin list drops a plugin it cannot read", () => {
    const r = PluginsResponse.parse({ plugins: [{ id: "x" }], available: [], mode: "owner", max: 20 });
    expect(r.plugins).toEqual([]);
  });
});
