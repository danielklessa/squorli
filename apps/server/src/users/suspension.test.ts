import { describe, expect, it } from "vitest";
import { isSuspendedNow, refusedUntil, suspendedBody } from "./suspension";

const NOW = 1_800_000_000_000;
const ahead = new Date(NOW + 86_400_000);
const past = new Date(NOW - 1);

describe("suspended directory accounts", () => {
  it("counts only a date that lies ahead", () => {
    expect(isSuspendedNow(null, NOW)).toBe(false);
    expect(isSuspendedNow(undefined, NOW)).toBe(false);
    expect(isSuspendedNow(past, NOW)).toBe(false);
    expect(isSuspendedNow(ahead, NOW)).toBe(true);
  });

  it("refuses a suspended directory account while the switch is on", () => {
    expect(refusedUntil({ handle: "daniel", localHandle: null, suspendedUntil: ahead }, true, NOW)).toBe(ahead);
    expect(refusedUntil({ handle: "daniel", localHandle: null, suspendedUntil: ahead }, false, NOW)).toBeNull();
    expect(refusedUntil({ handle: "daniel", localHandle: null, suspendedUntil: past }, true, NOW)).toBeNull();
    expect(refusedUntil({ handle: "daniel", localHandle: null, suspendedUntil: null }, true, NOW)).toBeNull();
  });

  it("never concerns a server account or a key without a directory account", () => {
    expect(refusedUntil({ handle: null, localHandle: "daniel", suspendedUntil: ahead }, true, NOW)).toBeNull();
    expect(refusedUntil({ handle: "daniel", localHandle: "daniel", suspendedUntil: ahead }, true, NOW)).toBeNull();
    expect(refusedUntil({ handle: null, localHandle: null, suspendedUntil: ahead }, true, NOW)).toBeNull();
  });

  it("answers with the code and the end of the suspension", () => {
    expect(suspendedBody(ahead)).toEqual({ error: "account_suspended", until: ahead.toISOString() });
  });
});
