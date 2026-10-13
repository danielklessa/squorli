import type { DirectoryServer } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { filterServers, typedAddress } from "./serverSearch";

const srv = (host: string, name: string | null, description: string | null = null): DirectoryServer =>
  ({ host, name, description, openJoin: true, memberCount: 3, iconUpdatedAt: null, registeredAt: "2026-09-01T10:00:00.000Z" });

describe("typedAddress", () => {
  it("takes addresses, invite links and squorli links", () => {
    expect(typedAddress("chat.example.org")).toEqual({ host: "chat.example.org", invite: null });
    expect(typedAddress("  https://Chat.Example.org/ ")).toEqual({ host: "chat.example.org", invite: null });
    expect(typedAddress("localhost:3001")).toEqual({ host: "localhost:3001", invite: null });
    expect(typedAddress("localhost")).toEqual({ host: "localhost", invite: null });
    expect(typedAddress("squorli://server/chat.example.org")).toEqual({ host: "chat.example.org", invite: null });
    expect(typedAddress("squorli://invite/chat.example.org/abcdef")).toEqual({ host: "chat.example.org", invite: "abcdef" });
    expect(typedAddress("https://chat.example.org/invite/Abc123_x")).toEqual({ host: "chat.example.org", invite: "Abc123_x" });
    expect(typedAddress("https://chat.example.org/invite/abc")).toBe(null); // no valid invite code: refused as before
  });

  it("leaves bare words and sentences to the search", () => {
    expect(typedAddress("gaming")).toBe(null);
    expect(typedAddress("https://gaming")).toEqual({ host: "gaming", invite: null }); // a scheme makes it an address
    expect(typedAddress("retro games")).toBe(null);
    expect(typedAddress("")).toBe(null);
  });
});

describe("filterServers", () => {
  const list = [srv("retro.example", "Retro Games", "Alte Konsolen und Spiele"), srv("chat.example.org", "Plauderecke"), srv("noname.example", null, "Ohne Namen")];

  it("keeps everything for an empty field", () => {
    expect(filterServers(list, "  ")).toEqual(list);
  });

  it("matches every word in name, host or description, ignoring case", () => {
    expect(filterServers(list, "retro").map((s) => s.host)).toEqual(["retro.example"]);
    expect(filterServers(list, "KONSOLEN spiele").map((s) => s.host)).toEqual(["retro.example"]);
    expect(filterServers(list, "example").map((s) => s.host)).toEqual(["retro.example", "chat.example.org", "noname.example"]);
    expect(filterServers(list, "namen").map((s) => s.host)).toEqual(["noname.example"]);
    expect(filterServers(list, "retro plauder")).toEqual([]);
  });

  it("matches a typed address or link by its host", () => {
    expect(filterServers(list, "https://chat.example.org/").map((s) => s.host)).toEqual(["chat.example.org"]);
    expect(filterServers(list, "other.example")).toEqual([]);
  });
});
