import { afterEach, describe, expect, it, vi } from "vitest";
import { ChallengeStore, EscalatingLimiter, RateLimiter } from "./challenges";

describe("ChallengeStore", () => {
  it("is single-use", () => {
    const s = new ChallengeStore();
    const c = s.create("aa");
    expect(s.consume(c.challengeId, "aa")).toBe(c.nonce);
    expect(s.consume(c.challengeId, "aa")).toBeNull();
  });
  it("rejects wrong key", () => {
    const s = new ChallengeStore();
    const c = s.create("aa");
    expect(s.consume(c.challengeId, "bb")).toBeNull();
  });
  it("expires", () => {
    const s = new ChallengeStore(-1);
    const c = s.create("aa");
    expect(s.consume(c.challengeId, "aa")).toBeNull();
  });
});

describe("RateLimiter attempts", () => {
  it("counts before the check completes, so parallel attempts cannot pass together; a success gives its attempt back", () => {
    const l = new RateLimiter(2);
    expect(l.attempt("ip")).toBe(true);
    expect(l.attempt("ip")).toBe(true);
    expect(l.attempt("ip")).toBe(false);
    l.refund("ip");
    expect(l.attempt("ip")).toBe(true);
    expect(l.attempt("ip")).toBe(false);
  });
});

describe("EscalatingLimiter (security audit, 2 October 2026)", () => {
  afterEach(() => vi.useRealTimers());
  const MIN = 60_000;
  const fail = (l: EscalatingLimiter, key: string, n: number) => { for (let i = 0; i < n; i++) l.attempt(key); };

  it("blocks for 5, then 15 minutes, then an hour at most, and starts over after a quiet day", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const l = new EscalatingLimiter(10);
    fail(l, "@a", 10);
    expect(l.attempt("@a")).toBe(false);          // the 11th request starts the first block
    expect(l.retryAfter("@a")).toBe(300);
    vi.setSystemTime(4 * MIN); expect(l.attempt("@a")).toBe(false);
    vi.setSystemTime(5 * MIN + 1); expect(l.attempt("@a")).toBe(true);  // free again, and counting
    fail(l, "@a", 9);
    expect(l.attempt("@a")).toBe(false);          // ten more wrong ones: the second block
    expect(l.retryAfter("@a")).toBe(900);
    vi.setSystemTime(5 * MIN + 1 + 15 * MIN + 1);
    fail(l, "@a", 10); expect(l.attempt("@a")).toBe(false);
    expect(l.retryAfter("@a")).toBe(3600);
    vi.setSystemTime(10 * 3600_000);
    fail(l, "@a", 10); expect(l.attempt("@a")).toBe(false);
    expect(l.retryAfter("@a")).toBe(3600);        // never longer than an hour
    vi.setSystemTime(10 * 3600_000 + 25 * 3600_000);
    fail(l, "@a", 10); expect(l.attempt("@a")).toBe(false);
    expect(l.retryAfter("@a")).toBe(300);         // a quiet day: back to the first step
  });
  it("keeps keys apart and lets a right password give its attempt back", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const l = new EscalatingLimiter(3);
    fail(l, "@a", 3); expect(l.attempt("@a")).toBe(false);
    expect(l.attempt("@b")).toBe(true);
    l.refund("@b");                                  // a right password: the attempt does not count
    fail(l, "@b", 2); expect(l.attempt("@b")).toBe(true);  // 2 wrong + 1 more = the limit of 3, the refunded one is gone
    expect(l.attempt("@b")).toBe(false);
    expect(l.retryAfter("@c")).toBe(0);
  });
  it("counts before anything is awaited: parallel attempts cannot all pass", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const l = new EscalatingLimiter(10);
    const results = Array.from({ length: 25 }, () => l.attempt("@p"));
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});
