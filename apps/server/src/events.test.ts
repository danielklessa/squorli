import { describe, expect, it } from "vitest";
import { ServerEventBus, depthOf } from "./events";
import { roleDiff } from "./memberRoles";

describe("ServerEventBus", () => {
  it("hands every listener the event with its origin and depth", () => {
    const bus = new ServerEventBus();
    const seen: unknown[] = [];
    bus.listen((e) => seen.push(e));
    bus.emit("member.join", { userId: "u1" }, { kind: "user", userId: "u1" });
    bus.emit("member.roles", { userId: "u1", added: ["r"], removed: [] }, { kind: "plugin", pluginId: "p", depth: 1 });
    expect(seen).toEqual([
      { name: "member.join", payload: { userId: "u1" }, origin: { kind: "user", userId: "u1" }, depth: 0 },
      { name: "member.roles", payload: { userId: "u1", added: ["r"], removed: [] }, origin: { kind: "plugin", pluginId: "p", depth: 1 }, depth: 2 },
    ]);
  });

  it("a listener that throws fails neither the caller nor the next listener", () => {
    const bus = new ServerEventBus();
    const errors: string[] = [];
    bus.onError = (_err, name) => errors.push(name);
    let reached = false;
    bus.listen(() => { throw new Error("boom"); });
    bus.listen(() => { reached = true; });
    expect(() => bus.emit("role.delete", { roleId: "r", name: "x" }, { kind: "system" })).not.toThrow();
    expect(reached).toBe(true);
    expect(errors).toEqual(["role.delete"]);
  });

  it("stops telling a listener that was removed", () => {
    const bus = new ServerEventBus();
    let n = 0;
    const off = bus.listen(() => { n++; });
    bus.emit("member.join", { userId: "a" }, { kind: "system" });
    off();
    bus.emit("member.join", { userId: "b" }, { kind: "system" });
    expect(n).toBe(1);
  });

  it("counts the depth only along plugins", () => {
    expect(depthOf({ kind: "user", userId: "u" })).toBe(0);
    expect(depthOf({ kind: "reaction", userId: "u" })).toBe(0);
    expect(depthOf({ kind: "system" })).toBe(0);
    expect(depthOf({ kind: "plugin", pluginId: "p", depth: 0 })).toBe(1);
  });
});

describe("roleDiff", () => {
  it("names what was added and what went", () => {
    expect(roleDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(roleDiff([], [])).toEqual({ added: [], removed: [] });
    expect(roleDiff(["a"], ["a"])).toEqual({ added: [], removed: [] });
  });
});
