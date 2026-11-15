import { describe, expect, it } from "vitest";
import { Message, PLUGIN_LIST_ITEMS_MAX, PLUGIN_NETWORK_HOSTS_MAX, PLUGIN_SOURCE_MAX_BYTES, parsePluginDate, PluginInstallRequest, PluginManifest, PluginSurface, PluginsResponse, ServerEvent, ServerState, cleanPluginText, pluginText } from "./index";

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

  it("a plugin's signature and what blocks it are optional, and one this app cannot read is none", () => {
    const info = { id: "p-one", name: { en: "P" }, description: { en: "D" }, version: "1.0.0", apiVersion: 2, language: "js", sourceHash: "00", enabled: true, state: "running", installedVia: "upload", installedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    // A server from before signatures names neither field.
    const before = PluginsResponse.parse({ plugins: [info], available: [{ id: "a-one", name: { en: "A" }, description: { en: "D" }, version: "1.0.0" }], mode: "owner", max: 20 });
    expect(before.plugins[0]).toMatchObject({ signature: null, blocked: null });
    expect(before.available[0]!.signature).toBeNull();
    const signed = PluginsResponse.parse({ plugins: [{ ...info, signature: { key: "2026-11", kind: "reviewed" }, blocked: "plugin_net_off" }], available: [], mode: "owner", max: 20 });
    expect(signed.plugins[0]).toMatchObject({ signature: { key: "2026-11", kind: "reviewed" }, blocked: "plugin_net_off" });
    // A kind of a later server is a plain string; a shape this app cannot read costs the mark, never the plugin.
    const later = PluginsResponse.parse({ plugins: [{ ...info, signature: { key: "2030-01", kind: "partner" } }, { ...info, id: "p-two", signature: "yes", blocked: 5 }], available: [], mode: "owner", max: 20 });
    expect(later.plugins.map((p) => [p.id, p.signature?.kind ?? null, p.blocked])).toEqual([["p-one", "partner", null], ["p-two", null, null]]);
  });
});

describe("a list field in a manifest (interface version 2)", () => {
  const list = (over: Record<string, unknown> = {}) => ({ key: "games", type: "list", label: "Games", fields: [{ key: "game", type: "text", label: "Game", required: true }, { key: "show", type: "select", label: "Show", default: "all", options: [{ value: "all", label: "All" }] }], ...over });
  const withSettings = (field: unknown, apiVersion = 2) => PluginManifest.safeParse({ ...base, apiVersion, settings: [field] });

  it("takes entries of one to four simple fields, in the settings of a version 2 plugin", () => {
    const m = withSettings(list({ maxItems: 50 }));
    expect(m.success).toBe(true);
    expect(m.success && m.data.settings[0]!.fields!.map((f) => [f.key, f.type, f.required])).toEqual([["game", "text", true], ["show", "select", false]]);
    expect(withSettings(list(), 1).success).toBe(false); // a server from before must say "update the server", not "unknown type"
  });

  it("refuses a list without fields, with too many, with a field that has a scope, and outside the settings", () => {
    const item = (key: string, type = "text") => ({ key, type, label: key });
    for (const bad of [
      list({ fields: undefined }), list({ fields: [] }), list({ fields: ["a", "b", "c", "d", "e"].map((k) => item(k)) }), list({ fields: [item("a"), item("a")] }),
      list({ fields: [item("r", "role")] }), list({ fields: [item("c", "channel")] }), list({ fields: [item("d", "date")] }), list({ fields: [item("l", "list")] }),
      list({ fields: [item("s", "select")] }), list({ fields: [{ ...item("t"), options: [{ value: "x", label: "X" }] }] }), list({ fields: [{ ...item("t"), maxLength: 201 }] }),
      list({ maxItems: 0 }), list({ maxItems: PLUGIN_LIST_ITEMS_MAX + 1 }), list({ fields: [{ ...item("t"), stray: 1 }] }),
    ]) expect(withSettings(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    expect(withSettings({ key: "t", type: "text", label: "T", fields: [item("a")] }).success).toBe(false);
    expect(withSettings({ key: "t", type: "text", label: "T", maxItems: 3 }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, apiVersion: 2, commands: [{ name: "x", description: "X", input: "form", fields: [list()] }] }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...base, apiVersion: 2, memberActions: [{ id: "x", label: "X", permission: "KICK_MEMBERS", fields: [list()] }] }).success).toBe(false);
  });
});

describe("the network in a manifest (interface version 2)", () => {
  const net = { ...base, apiVersion: 2, capabilities: ["net.fetch"], network: { hosts: ["api.example.org"] } };
  it("takes the capability and its hosts together, from version 2 on", () => {
    expect(PluginManifest.parse(net).network).toEqual({ hosts: ["api.example.org"] });
    expect(PluginManifest.parse({ ...base, apiVersion: 2 }).network).toBeUndefined();
    expect(PluginManifest.safeParse({ ...net, apiVersion: 1 }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...net, network: undefined }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...net, capabilities: [] }).success).toBe(false);
  });

  it("takes full host names only", () => {
    for (const host of ["*.example.org", "localhost", "10.0.0.1", "api.example.org:443", "API.example.org", "api.example.org/x", "", "a..b.org"]) expect(PluginManifest.safeParse({ ...net, network: { hosts: [host] } }).success, host).toBe(false);
    expect(PluginManifest.safeParse({ ...net, network: { hosts: Array.from({ length: PLUGIN_NETWORK_HOSTS_MAX + 1 }, (_, i) => `h${i}.example.org`) } }).success).toBe(false);
    expect(PluginManifest.safeParse({ ...net, network: { hosts: ["a.example.org", "b.example.org"], anything: 1 } }).success).toBe(false);
  });
});
