import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildRules, ipKey, limitPath, LIMITS, registerRateLimits, WindowCounter } from "./rateLimits";

describe("WindowCounter", () => {
  it("allows the limit per window, then refuses with the seconds left", () => {
    const c = new WindowCounter(2, 10_000);
    expect(c.hit("a", 0).ok).toBe(true);
    expect(c.hit("a", 1000).ok).toBe(true);
    expect(c.hit("a", 2000)).toEqual({ ok: false, retryAfter: 8 });
    expect(c.hit("b", 2000).ok).toBe(true);
    expect(c.hit("a", 10_000).ok).toBe(true);
  });
  it("sweeps ended windows", () => {
    const c = new WindowCounter(1, 1000);
    c.hit("a", 0); c.hit("b", 500);
    c.sweep(1200);
    expect(c.size).toBe(1);
  });
});

describe("rules", () => {
  it("scale with the factor and match their paths", () => {
    const rules = buildRules(2);
    const msg = rules.find((r) => r.name === "tokenMessages")!;
    expect(msg.counter.limit).toBe(LIMITS.tokenMessages.limit * 2);
    expect(msg.applies("POST", "/api/channels/abc/messages")).toBe(true);
    expect(msg.applies("GET", "/api/channels/abc/messages")).toBe(false);
    expect(rules.find((r) => r.name === "ipAuth")!.applies("POST", "/api/auth/verify")).toBe(true);
  });
});

describe("hook", () => {
  const app = async (factor: number) => {
    const a = Fastify();
    registerRateLimits(a, factor);
    a.post("/api/auth/challenge", async () => ({ ok: true }));
    a.post("/api/channels/:id/messages", async () => ({ ok: true }));
    a.get("/health", async () => ({ ok: true }));
    await a.ready();
    return a;
  };
  it("refuses sign-in floods per IP with 429 and retry-after", async () => {
    const a = await app(1);
    let last = 0;
    for (let i = 0; i <= LIMITS.ipAuth.limit; i++) last = (await a.inject({ method: "POST", url: "/api/auth/challenge" })).statusCode;
    const res = await a.inject({ method: "POST", url: "/api/auth/challenge" });
    expect(last).toBe(429);
    expect(res.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await a.close();
  });
  it("counts messages per session token, not per IP", async () => {
    const a = await app(1);
    const send = (tok: string) => a.inject({ method: "POST", url: "/api/channels/x/messages", headers: { authorization: `Bearer ${tok}` } });
    for (let i = 0; i < LIMITS.tokenMessages.limit; i++) expect((await send("one")).statusCode).toBe(200);
    expect((await send("one")).statusCode).toBe(429);
    expect((await send("two")).statusCode).toBe(200);
    await a.close();
  });
  it("counts an encoded path like the route it reaches (security audit, 2 October 2026)", async () => {
    const a = await app(1);
    // The router decodes %61 to "a": every spelling below reaches the same two routes and shares their counters.
    const urls = ["/api/auth/challenge", "/%61pi/auth/challenge", "/api/%61uth/challenge", "/%61%70%69/auth/challenge"];
    const codes: number[] = [];
    for (let i = 0; i <= LIMITS.ipAuth.limit; i++) codes.push((await a.inject({ method: "POST", url: urls[i % urls.length]! })).statusCode);
    expect(codes.slice(0, LIMITS.ipAuth.limit).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    for (const url of urls) expect((await a.inject({ method: "POST", url })).statusCode).toBe(429);
    const send = (url: string) => a.inject({ method: "POST", url, headers: { authorization: "Bearer one" } });
    for (let i = 0; i < LIMITS.tokenMessages.limit; i++) expect((await send(i % 2 ? "/api/channels/x/m%65ssages" : "/api/channels/x/messages")).statusCode).toBe(200);
    expect((await send("/api/channels/x/m%65ssages")).statusCode).toBe(429);
    await a.close();
  });
  it("leaves paths outside /api alone and does nothing at factor 0", async () => {
    const a = await app(0);
    for (let i = 0; i <= LIMITS.ipAuth.limit; i++) expect((await a.inject({ method: "POST", url: "/api/auth/challenge" })).statusCode).toBe(200);
    await a.close();
    const b = await app(1);
    expect((await b.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await b.close();
  });
});

describe("limitPath", () => {
  it("takes the route's pattern, else the decoded path", () => {
    expect(limitPath("/api/channels/:id/messages", "/api/channels/x/m%65ssages")).toBe("/api/channels/:id/messages");
    expect(limitPath(undefined, "/%61pi/nothing?x=1")).toBe("/api/nothing");
    expect(limitPath("/*", "/%61pi/nothing")).toBe("/api/nothing");
    expect(limitPath(undefined, "/api/%E0%A4%A")).toBe("/api/%E0%A4%A");
  });
});

describe("ipKey", () => {
  it("keeps IPv4, counts IPv6 by its /64", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});
