import { describe, expect, it } from "vitest";
import { isLocalCaller, isLoopback } from "./doctor";

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("isLoopback", () => {
  it("takes the machine itself and nothing a proxy forwarded", () => {
    expect(isLoopback(req("127.0.0.1"))).toBe(true);
    expect(isLoopback(req("::1"))).toBe(true);
    expect(isLoopback(req("::ffff:127.0.0.1"))).toBe(true);
    expect(isLoopback(req("172.18.0.3"))).toBe(false);
    expect(isLoopback(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }))).toBe(false);
    expect(isLoopback(req("127.0.0.1", { "x-forwarded-proto": "https" }))).toBe(false);
    expect(isLoopback(req("127.0.0.1", { "x-real-ip": "203.0.113.5" }))).toBe(false);
    expect(isLoopback(req("127.0.0.1", { forwarded: "for=203.0.113.5" }))).toBe(false);
  });
});

describe("isLocalCaller", () => {
  it("without a token: loopback as before", () => {
    expect(isLocalCaller(req("127.0.0.1"), undefined)).toBe(true);
    expect(isLocalCaller(req("192.168.1.10"), undefined)).toBe(false);
    expect(isLocalCaller(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }), undefined)).toBe(false);
    // A header nobody asked for opens nothing
    expect(isLocalCaller(req("192.168.1.10", { "x-squorli-doctor": TOKEN }), undefined)).toBe(false);
  });

  it("with a token: only the token counts, loopback alone does not (a proxy on the same machine arrives from there)", () => {
    expect(isLocalCaller(req("127.0.0.1"), TOKEN)).toBe(false);
    expect(isLocalCaller(req("127.0.0.1", { "x-squorli-doctor": "" }), TOKEN)).toBe(false);
    expect(isLocalCaller(req("127.0.0.1", { "x-squorli-doctor": TOKEN.slice(0, -1) }), TOKEN)).toBe(false);
    expect(isLocalCaller(req("127.0.0.1", { "x-squorli-doctor": `${TOKEN}0` }), TOKEN)).toBe(false);
    expect(isLocalCaller(req("127.0.0.1", { "x-squorli-doctor": TOKEN }), TOKEN)).toBe(true);
    // A proxy on another machine: the server listens on its LAN address, the command asks there
    expect(isLocalCaller(req("192.168.1.10", { "x-squorli-doctor": TOKEN }), TOKEN)).toBe(true);
  });
});
