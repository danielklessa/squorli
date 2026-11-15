import { Permission } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { isOperator } from "../routes/plugins";
import { HOST_FUNCTIONS, PLUGIN_EVENTS, preludeSource } from "./prelude";
import { retryDelay } from "./scheduler";
import type { ManifestField } from "@squorli/protocol";
import { GATE_TEXT, actionResult, gateCode, isPluginUserKey, netAllowed, roleInScope, settingsCheckAnswer } from "./service";

describe("roleInScope", () => {
  const scope = { roles: { r1: Permission.SEND_MESSAGES }, channels: [] };
  const role = (over: Partial<{ id: string; isDefault: boolean; permissions: number }>) => ({ id: "r1", isDefault: false, permissions: Permission.SEND_MESSAGES, ...over });

  it("lets a plugin touch a role of its scope that is as it was saved", () => {
    expect(roleInScope(scope, role({}))).toBe("ok");
    // Fewer permissions than at the time of saving are fine.
    expect(roleInScope(scope, role({ permissions: 0 }))).toBe("ok");
  });

  it("refuses everything else", () => {
    expect(roleInScope(scope, role({ id: "other" }))).toBe("not_in_scope");
    expect(roleInScope(scope, role({ isDefault: true }))).toBe("default_role");
    expect(roleInScope(scope, role({ permissions: Permission.SEND_MESSAGES | Permission.KICK_MEMBERS }))).toBe("role_changed");
    // An administrator role is refused whatever the snapshot says.
    expect(roleInScope({ roles: { r1: Permission.ADMINISTRATOR }, channels: [] }, role({ permissions: Permission.ADMINISTRATOR }))).toBe("administrator");
  });
});

describe("actionResult", () => {
  it("reads whatever a handler returned as an answer for the client", () => {
    expect(actionResult(undefined)).toEqual({ ok: true });
    expect(actionResult("done")).toEqual({ ok: true, message: { en: "done" } });
    expect(actionResult({ message: { en: "Done", de: "Erledigt" } })).toEqual({ ok: true, message: { en: "Done", de: "Erledigt" } });
    expect(actionResult({ ok: false, message: "no" })).toEqual({ ok: false, message: { en: "no" } });
    expect(actionResult(42)).toEqual({ ok: true });
  });

  it("turns field errors into a refusal and cuts what is too long", () => {
    expect(actionResult({ fieldErrors: { role: "not this one", n: { de: "nein" } } })).toEqual({ ok: false, fieldErrors: { role: { en: "not this one" }, n: { en: "nein", de: "nein" } } });
    expect(actionResult("x".repeat(900)).message!.en.length).toBe(500);
    expect(actionResult({ message: { en: 5 } })).toEqual({ ok: true });
    // What a plugin answers is shown to a person: no escape sequences, no reversed text; a line break may stay.
    expect(actionResult(`a${String.fromCharCode(27)}[2Jb\nc${String.fromCharCode(0x202e)}`)).toEqual({ ok: true, message: { en: "a[2Jb\nc" } });
  });
});

describe("the operator's token", () => {
  const token = "t".repeat(43);
  it("opens the routes only for the exact token, and never together with a session", () => {
    expect(isOperator({ headers: { "x-squorli-operator": token } }, token)).toBe(true);
    expect(isOperator({ headers: { "x-squorli-operator": `${token}x` } }, token)).toBe(false);
    expect(isOperator({ headers: { "x-squorli-operator": "" } }, token)).toBe(false);
    expect(isOperator({ headers: {} }, token)).toBe(false);
    expect(isOperator({ headers: { "x-squorli-operator": token, authorization: "Bearer abc" } }, token)).toBe(false);
    expect(isOperator({ headers: { "x-squorli-operator": [token, token] as unknown as string } }, token)).toBe(false);
  });
});

describe("what a plugin answers before its settings are saved", () => {
  const f = (key: string, type: string, more: Record<string, unknown> = {}) => ({ key, type, label: { en: key }, required: false, ...more }) as unknown as ManifestField;
  const fields = [f("games", "list", { fields: [{ key: "game", type: "text", label: { en: "Game" }, required: true }] }), f("note", "text", { maxLength: 10 }), f("room", "channel"), f("role", "role")];
  const values = { games: [{ game: "730" }], note: "hi", room: "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a01" };

  it("lets the save pass when it says nothing, or nothing this server reads", () => {
    for (const answer of [undefined, null, "fine", 5, [], {}, { values: 5 }, { fieldErrors: [] }, { fieldErrors: {} }]) expect(settingsCheckAnswer(fields, values, answer)).toEqual({ ok: true, values: {} });
  });

  it("refuses the save with the plugin's sentence at a field of its own, cleaned and cut", () => {
    expect(settingsCheckAnswer(fields, values, { fieldErrors: { games: { en: "Several games fit.", de: "Mehrere Spiele passen." }, nope: "x" } }))
      .toEqual({ ok: false, fieldErrors: { games: { en: "Several games fit.", de: "Mehrere Spiele passen." } } });
    const long = settingsCheckAnswer(fields, values, { fieldErrors: { note: `a${String.fromCharCode(27)}[2J${"x".repeat(900)}` }, values: { note: "ignored" } });
    expect(long.ok).toBe(false);
    expect(!long.ok && long.fieldErrors.note!.en.length).toBe(500);
    expect(!long.ok && long.fieldErrors.note!.en.startsWith("a[2Jx")).toBe(true);
    // An error for a field the manifest does not have refuses nothing.
    expect(settingsCheckAnswer(fields, values, { fieldErrors: { nope: "x" } })).toEqual({ ok: true, values: {} });
  });

  it("takes values the plugin hands back for its plain fields, checked like an admin's", () => {
    expect(settingsCheckAnswer(fields, values, { values: { games: [{ game: "Counter-Strike 2 (730)", stray: 1 }], note: "  ok " } }))
      .toEqual({ ok: true, values: { games: [{ game: "Counter-Strike 2 (730)" }], note: "ok" } });
    // Only the fields it names are touched.
    expect(settingsCheckAnswer(fields, values, { values: { note: "x" } })).toEqual({ ok: true, values: { note: "x" } });
  });

  it("never lets a plugin change a field of its scope, and keeps the admin's values when the plugin's do not fit", () => {
    expect(settingsCheckAnswer(fields, values, { values: { room: "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a99", role: "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a98", unknown: 1 } })).toEqual({ ok: true, values: {} });
    expect(settingsCheckAnswer(fields, values, { values: { note: "far too long for this field", games: [{ game: "A (1)" }] } })).toEqual({ ok: true, values: {} });
  });
});

describe("the network of a plugin", () => {
  const net = { capabilities: ["messages.write", "net.fetch"] as const }, plain = { capabilities: ["messages.write"] as const };
  it("needs Squorli's signature and the operator's switch; other plugins are not concerned", () => {
    expect(gateCode(net, "valid", true)).toBeNull();
    expect(gateCode(net, "none", true)).toBe("plugin_signature_required");
    expect(gateCode(net, "invalid", true)).toBe("plugin_signature_required");
    expect(gateCode(net, "valid", false)).toBe("plugin_net_off");
    expect(gateCode(plain, "none", true)).toBeNull();
    expect(gateCode(plain, "none", false)).toBeNull();
    expect(gateCode(plain, "valid", false)).toBeNull();
    // A signature Squorli took back stops the plugin whatever it asks for.
    expect(gateCode(net, "revoked", true)).toBe("plugin_signature_revoked");
    expect(gateCode(plain, "revoked", true)).toBe("plugin_signature_revoked");
    for (const code of ["plugin_signature_required", "plugin_net_off", "plugin_signature_revoked"] as const) expect(GATE_TEXT[code].length).toBeGreaterThan(20);
  });

  it("reaches the manifest's hosts over https and nothing else", () => {
    const hosts = ["api.example.org", "www.example.net"];
    const ok = (address: string, testOrigin?: string) => netAllowed(new URL(address), hosts, testOrigin);
    expect(ok("https://api.example.org/v1/news?appid=730")).toBe(true);
    expect(ok("https://API.Example.org/x")).toBe(true); // a URL's host is lower case once parsed
    expect(ok("https://www.example.net:443/")).toBe(true); // the default port is no port
    for (const address of [
      "http://api.example.org/", "https://api.example.org:8443/", "https://example.org/", "https://evil.api.example.org/", "https://api.example.org.evil.test/",
      "https://api.example.org@evil.test/", "https://user:pw@api.example.org/", "https://api.example.org./", "ftp://api.example.org/", "https://127.0.0.1/", "https://[::1]/", "file:///etc/passwd",
    ]) expect(ok(address), address).toBe(false);
    // The tests' one origin, and only that origin.
    expect(ok("http://127.0.0.1:3198/feed", "http://127.0.0.1:3198")).toBe(true);
    expect(ok("http://127.0.0.1:3199/feed", "http://127.0.0.1:3198")).toBe(false);
    expect(ok("http://user@127.0.0.1:3198/feed", "http://127.0.0.1:3198")).toBe(false);
  });
});

describe("small rules", () => {
  it("tries a failed job again after 2 minutes, 10 minutes and an hour, then gives up", () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([120, 600, 3600, null]);
  });

  it("knows a plugin's own user by its key", () => {
    expect(isPluginUserKey("plugin:timed-roles")).toBe(true);
    expect(isPluginUserKey("ab".repeat(32))).toBe(false);
  });

  it("the prelude calls only functions the host has a name for, and knows every event", () => {
    const source = preludeSource(1);
    const called = new Set([...source.matchAll(/call\("([a-z.]+)"/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual([...HOST_FUNCTIONS].sort());
    for (const e of PLUGIN_EVENTS) expect(source).toContain(JSON.stringify(e));
    expect(source).toContain("apiVersion: 1");
  });
});
