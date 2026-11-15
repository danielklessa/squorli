import { Permission } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { isOperator } from "../routes/plugins";
import { HOST_FUNCTIONS, PLUGIN_EVENTS, preludeSource } from "./prelude";
import { retryDelay } from "./scheduler";
import { actionResult, isPluginUserKey, roleInScope } from "./service";

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
