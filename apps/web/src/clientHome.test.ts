import type { AccountServer } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { chooseInitialServer, parseClientData, parseServerAddress } from "./clientHome";

const srv = (host: string, lastSeenAt: string, leaveRequestedAt: string | null = null, refused = false): AccountServer =>
  ({ host, name: host, displayName: null, lastSeenAt, verified: true, iconUpdatedAt: null, leaveRequestedAt, refused });

describe("chooseInitialServer", () => {
  const account = [srv("a.example", "2026-09-01T10:00:00.000Z"), srv("b.example", "2026-09-10T10:00:00.000Z"), srv("gone.example", "2026-09-17T10:00:00.000Z", "2026-09-17T11:00:00.000Z")];

  it("opens the server viewed last while it is still the user's", () => {
    expect(chooseInitialServer({ last: "a.example", accountServers: account, localHosts: [] })).toBe("a.example");
    expect(chooseInitialServer({ last: "local.example", accountServers: account, localHosts: ["local.example"] })).toBe("local.example");
  });

  it("falls back to the server the account was seen on most recently", () => {
    expect(chooseInitialServer({ last: null, accountServers: account, localHosts: ["local.example"] })).toBe("b.example");
    expect(chooseInitialServer({ last: "unknown.example", accountServers: account, localHosts: [] })).toBe("b.example");
  });

  it("never picks a server whose account deletion is pending", () => {
    expect(chooseInitialServer({ last: "gone.example", accountServers: account, localHosts: [] })).toBe("b.example");
    expect(chooseInitialServer({ last: null, accountServers: [account[2]!], localHosts: [] })).toBeNull();
  });

  it("starts on a server the directory refused only when there is no other", () => {
    const withRefused = [...account, srv("bad.example", "2026-09-20T10:00:00.000Z", null, true)];
    expect(chooseInitialServer({ last: "bad.example", accountServers: withRefused, localHosts: [] })).toBe("b.example");
    expect(chooseInitialServer({ last: null, accountServers: withRefused, localHosts: [] })).toBe("b.example");
    expect(chooseInitialServer({ last: null, accountServers: [withRefused[3]!], localHosts: ["local.example"] })).toBe("local.example");
    expect(chooseInitialServer({ last: null, accountServers: [withRefused[3]!], localHosts: [] })).toBe("bad.example");
  });

  it("uses an added server when the account has none, and nothing when there is nothing", () => {
    expect(chooseInitialServer({ last: null, accountServers: [], localHosts: ["local.example", "other.example"] })).toBe("local.example");
    expect(chooseInitialServer({ last: null, accountServers: null, localHosts: [] })).toBeNull();
  });

  it("keeps the remembered server when the directory did not answer", () => {
    expect(chooseInitialServer({ last: "a.example", accountServers: null, localHosts: [] })).toBe("a.example");
  });
});

describe("parseClientData", () => {
  it("reads what was stored", () => {
    expect(parseClientData(JSON.stringify({ signedIn: true, hosts: ["a.example", "localhost:3001"], lastHost: "a.example" }))).toEqual({ signedIn: true, hosts: ["a.example", "localhost:3001"], lastHost: "a.example" });
  });
  it("drops what is not a host and survives rubbish", () => {
    expect(parseClientData(JSON.stringify({ signedIn: "yes", hosts: ["a.example", "a.example", "evil.example/path", 7], lastHost: "user@evil" }))).toEqual({ signedIn: false, hosts: ["a.example"], lastHost: null });
    for (const raw of [null, "", "{", "null", "[]", "7"]) expect(parseClientData(raw)).toEqual({ signedIn: false, hosts: [], lastHost: null });
  });
});

describe("parseServerAddress", () => {
  it("reads a host, an address, an invite link and an app link", () => {
    expect(parseServerAddress(" Chat.Example.org ")).toEqual({ host: "chat.example.org", invite: null });
    expect(parseServerAddress("https://chat.example.org/")).toEqual({ host: "chat.example.org", invite: null });
    expect(parseServerAddress("https://chat.example.org/?x=1#y")).toEqual({ host: "chat.example.org", invite: null });
    expect(parseServerAddress("localhost:3001")).toEqual({ host: "localhost:3001", invite: null });
    expect(parseServerAddress("https://chat.example.org/invite/AbC_12-x")).toEqual({ host: "chat.example.org", invite: "AbC_12-x" });
    expect(parseServerAddress("squorli://invite/chat.example.org/abcdef")).toEqual({ host: "chat.example.org", invite: "abcdef" });
    expect(parseServerAddress("squorli://server/chat.example.org")).toEqual({ host: "chat.example.org", invite: null });
  });
  it("refuses everything else", () => {
    for (const raw of ["", "   ", "https://", "user@evil.example", "https://user@evil.example/", "ftp://chat.example.org", "chat example.org", "https://chat.example.org/invite/x", "squorli://open/chat.example.org", "-bad.example", "a".repeat(500)]) expect(parseServerAddress(raw), raw).toBeNull();
  });
  it("ignores a path that is no invite", () => {
    expect(parseServerAddress("https://chat.example.org/some/page")).toEqual({ host: "chat.example.org", invite: null });
  });
});
