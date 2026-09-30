import { describe, expect, it } from "vitest";
import { registerRetryDelayMs, registerStartDelayMs, retryAfterMs } from "./directory";

describe("the registration's own retries (docs/features/limits.md)", () => {
  it("waits longer after every failure and then repeats the longest wait", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 60].map(registerRetryDelayMs)).toEqual([5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(registerRetryDelayMs(-1)).toBe(5_000);
  });

  it("reads Retry-After as seconds or a date, at most ten minutes, null when absent or unreadable", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("3600")).toBe(600_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("")).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs("0")).toBeNull();
    const inTwoMinutes = retryAfterMs(new Date(Date.now() + 120_000).toUTCString());
    expect(inTwoMinutes).toBeGreaterThan(110_000);
    expect(inTwoMinutes).toBeLessThanOrEqual(120_000);
  });

  it("spreads the first registration over three seconds, at once for 0", () => {
    expect(registerStartDelayMs(0)).toBe(0);
    expect(registerStartDelayMs(0.5)).toBe(1500);
    expect(registerStartDelayMs(0.999)).toBe(2997);
    expect(registerStartDelayMs(7)).toBe(3000);
  });
});
