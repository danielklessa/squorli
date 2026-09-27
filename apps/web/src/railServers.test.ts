import type { AccountServer } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { buildRailServers, voiceActivity } from "./railServers";

const srv = (host: string, lastSeenAt: string, displayName: string | null = null): AccountServer =>
  ({ host, name: `Name of ${host}`, displayName, lastSeenAt, verified: true, iconUpdatedAt: null, leaveRequestedAt: null, refused: false });
const base = { keyOf: (h: string) => h.toLowerCase(), iconOf: (s: AccountServer) => `icon:${s.host}`, subOf: (n: string) => `as ${n}`, order: [] as string[] };

describe("buildRailServers", () => {
  it("puts the home server first and does not repeat it", () => {
    const home = { key: "localhost:5173", host: "home.example", name: "Home", sub: null, iconUrl: null };
    const list = buildRailServers({ ...base, home, accountServers: [srv("home.example", "2026-09-10T00:00:00.000Z"), srv("b.example", "2026-09-01T00:00:00.000Z")], localHosts: [], keyOf: (h) => (h === "home.example" ? "localhost:5173" : h) });
    expect(list.map((s) => s.key)).toEqual(["localhost:5173", "b.example"]);
  });

  it("orders the account's servers by when they were seen last and names the display name", () => {
    const list = buildRailServers({ ...base, home: null, accountServers: [srv("old.example", "2026-09-01T00:00:00.000Z"), srv("new.example", "2026-09-10T00:00:00.000Z", "Dana")], localHosts: [] });
    expect(list).toEqual([
      { key: "new.example", host: "new.example", name: "Name of new.example", sub: "as Dana", iconUrl: "icon:new.example" },
      { key: "old.example", host: "old.example", name: "Name of old.example", sub: null, iconUrl: "icon:old.example" },
    ]);
  });

  it("appends added servers the account's list lacks, without an icon", () => {
    const list = buildRailServers({ ...base, home: null, accountServers: [srv("a.example", "2026-09-01T00:00:00.000Z")], localHosts: [{ host: "a.example", name: "A" }, { host: "local.example", name: null }, { host: "named.example", name: "Named" }] });
    expect(list.map((s) => [s.key, s.name, s.iconUrl])).toEqual([["a.example", "Name of a.example", "icon:a.example"], ["local.example", "local.example", null], ["named.example", "Named", null]]);
  });

  it("puts the servers the user arranged first, the home server among them, and the rest in the default order", () => {
    const home = { key: "localhost:5173", host: "home.example", name: "Home", sub: null, iconUrl: null };
    const list = buildRailServers({ ...base, home, order: ["old.example", "home.example"], accountServers: [srv("old.example", "2026-09-01T00:00:00.000Z"), srv("new.example", "2026-09-10T00:00:00.000Z")], localHosts: [{ host: "added.example", name: null }] });
    expect(list.map((s) => s.host)).toEqual(["old.example", "home.example", "new.example", "added.example"]);
  });
});

describe("voiceActivity", () => {
  const m = (userId: string) => ({ userId, displayName: userId, micMuted: false, deafened: false, cameraOn: false, screenOn: false });
  it("counts every member once across channels", () => {
    expect(voiceActivity({ a: [m("u1"), m("u2")], b: [m("u3"), m("u1")], c: [] }, null)).toBe(3);
  });
  it("leaves the AFK channel out", () => {
    expect(voiceActivity({ a: [m("u1")], afk: [m("u2"), m("u3")] }, "afk")).toBe(1);
    expect(voiceActivity({ afk: [m("u2")] }, "afk")).toBe(0);
  });
  it("is zero without a roster", () => { expect(voiceActivity({}, null)).toBe(0); });
});
