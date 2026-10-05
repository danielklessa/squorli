import { describe, expect, it } from "vitest";
import { configWarnings, loadConfig, placeholderSecretProblems, rateLimitProblems, resolveTrustedProxies } from "./config";

const base = {
  PUBLIC_DOMAIN: "chat.example.org", DATABASE_URL: "postgres://chat:abc123@postgres:5432/chat", LIVEKIT_URL: "http://livekit:7880",
  LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "a".repeat(64),
};

describe("placeholder secrets (security audit, 2 October 2026)", () => {
  it("refuses the templates' LiveKit secrets in production", () => {
    for (const secret of ["change-me-to-at-least-32-random-characters", "secret-secret-secret-secret-secret", "CHANGE-ME-please-change-me-now", "your-livekit-secret-here"]) {
      expect(placeholderSecretProblems({ NODE_ENV: "production", LIVEKIT_API_SECRET: secret }).length, secret).toBe(1);
      expect(() => loadConfig({ ...base, NODE_ENV: "production", LIVEKIT_API_SECRET: secret })).toThrow(/Platzhalter/);
    }
  });
  it("lets development and test keep them, and production keep a real one", () => {
    expect(placeholderSecretProblems({ NODE_ENV: "development", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" })).toEqual([]);
    expect(() => loadConfig({ ...base, NODE_ENV: "development", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" })).not.toThrow();
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).not.toThrow();
    // A short but private secret still starts (an update must not stop an installation that has one); it gets a warning.
    expect(() => loadConfig({ ...base, NODE_ENV: "production", LIVEKIT_API_SECRET: "x7Kq9mPz2LwRtY4v" })).not.toThrow();
  });
  it("warns about a short secret and the database's template password, in production only", () => {
    expect(configWarnings({ NODE_ENV: "production", LIVEKIT_API_SECRET: "x7Kq9mPz2LwRtY4v", DATABASE_URL: base.DATABASE_URL })).toHaveLength(1);
    expect(configWarnings({ NODE_ENV: "production", LIVEKIT_API_SECRET: base.LIVEKIT_API_SECRET, DATABASE_URL: "postgres://chat:change-me@postgres:5432/chat" })).toHaveLength(1);
    expect(configWarnings({ NODE_ENV: "production", LIVEKIT_API_SECRET: base.LIVEKIT_API_SECRET, DATABASE_URL: base.DATABASE_URL })).toEqual([]);
    expect(configWarnings({ NODE_ENV: "development", LIVEKIT_API_SECRET: "short-secret-123456", DATABASE_URL: "postgres://chat:chat@localhost/chat" })).toEqual([]);
  });
});

describe("rate limits off (security audit of 5 October 2026, L-17)", () => {
  it("refuses RATE_LIMIT_FACTOR=0 in production and nowhere else", () => {
    expect(rateLimitProblems({ NODE_ENV: "production", RATE_LIMIT_FACTOR: 0 })).toHaveLength(1);
    expect(rateLimitProblems({ NODE_ENV: "production", RATE_LIMIT_FACTOR: 0.5 })).toEqual([]);
    expect(rateLimitProblems({ NODE_ENV: "development", RATE_LIMIT_FACTOR: 0 })).toEqual([]);
    expect(rateLimitProblems({ NODE_ENV: "test", RATE_LIMIT_FACTOR: 0 })).toEqual([]);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", RATE_LIMIT_FACTOR: "0" })).toThrow(/RATE_LIMIT_FACTOR=0/);
    expect(loadConfig({ ...base, NODE_ENV: "production", RATE_LIMIT_FACTOR: "2" }).RATE_LIMIT_FACTOR).toBe(2);
    expect(loadConfig({ ...base, NODE_ENV: "development", RATE_LIMIT_FACTOR: "0" }).RATE_LIMIT_FACTOR).toBe(0);
  });
});

describe("TRUSTED_PROXIES=auto (security audit of 5 October 2026, L-2)", () => {
  const interfaces = () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
    eth0: [
      { address: "172.18.0.5", netmask: "255.255.0.0", family: "IPv4" as const, mac: "02:42:ac:12:00:05", internal: false, cidr: "172.18.0.5/16" },
      { address: "fe80::42:acff:fe12:5", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" as const, mac: "02:42:ac:12:00:05", internal: false, cidr: "fe80::42:acff:fe12:5/64", scopeid: 2 },
    ],
    eth1: [{ address: "10.89.0.3", netmask: "255.255.255.0", family: "IPv4" as const, mac: "02:42:0a:59:00:03", internal: false, cidr: null }],
  });
  it("stands for the process's own networks and loopback, next to whatever else is named", () => {
    expect(resolveTrustedProxies("auto", interfaces)).toEqual(["loopback", "172.18.0.5/16", "fe80::42:acff:fe12:5/64"]);
    expect(resolveTrustedProxies(" AUTO , 203.0.113.9 ", interfaces)).toEqual(["loopback", "172.18.0.5/16", "fe80::42:acff:fe12:5/64", "203.0.113.9"]);
    expect(resolveTrustedProxies("172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.1", interfaces)).toEqual(["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16", "127.0.0.1"]);
    expect(resolveTrustedProxies("auto,auto", interfaces)).toEqual(["loopback", "172.18.0.5/16", "fe80::42:acff:fe12:5/64"]);
    expect(loadConfig({ ...base, TRUSTED_PROXIES: "auto" }).trustedProxies[0]).toBe("loopback");
    // The code's own default stays the proxy on this machine; the templates write auto.
    expect(loadConfig(base).trustedProxies).toEqual(["127.0.0.1"]);
  });
});
