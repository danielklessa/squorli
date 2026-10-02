import { describe, expect, it } from "vitest";
import { configWarnings, loadConfig, placeholderSecretProblems } from "./config";

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
