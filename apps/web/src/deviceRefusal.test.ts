import { describe, expect, it } from "vitest";
import { afterAsking, directoryWordOf, refusalStep, stillThatDevice } from "./deviceRefusal";

describe("whose word wipes a key", () => {
  it("takes the directory's word at once", () => {
    expect(refusalStep({ from: "directory" })).toBe("wipe");
  });
  it("takes a chat server's word for its own accounts only", () => {
    expect(refusalStep({ from: "server", local: true })).toBe("wipe-local");
    expect(refusalStep({ from: "server", local: false })).toBe("ask-directory");
  });
});

describe("what the directory said", () => {
  const err = (code: unknown) => Object.assign(new Error("x"), { code });
  it("reads the three refusals of a device and nothing else as one", () => {
    for (const code of ["device_revoked", "device_unknown", "device_required"]) expect(directoryWordOf(err(code))).toEqual({ kind: "refused", code });
    for (const other of ["no_account", "rate_limited", "account_suspended", "device_signature_invalid", null, undefined, 403]) expect(directoryWordOf(err(other))).toEqual({ kind: "unknown" });
    expect(directoryWordOf(new TypeError("Failed to fetch"))).toEqual({ kind: "unknown" });
    expect(directoryWordOf(null)).toEqual({ kind: "unknown" });
  });
});

describe("after the directory was asked about a chat server's refusal", () => {
  it("wipes only on the directory's own refusal", () => {
    expect(afterAsking({ kind: "refused", code: "device_revoked" }, false)).toBe("wipe");
    expect(afterAsking({ kind: "refused", code: "device_unknown" }, true)).toBe("wipe");
  });
  it("signs in again once when the directory lets the device in, then says that the server refuses", () => {
    expect(afterAsking({ kind: "ok" }, false)).toBe("sign-in-again");
    expect(afterAsking({ kind: "ok" }, true)).toBe("say-refused");
  });
  it("wipes nothing while the directory cannot be asked", () => {
    expect(afterAsking({ kind: "unknown" }, false)).toBe("say-unchecked");
    expect(afterAsking({ kind: "unknown" }, true)).toBe("say-unchecked");
  });
});

describe("which entry a refusal is about", () => {
  it("is the stored device only while that is still the one that was refused", () => {
    expect(stillThatDevice("a", "a")).toBe(true);
    expect(stillThatDevice("b", "a")).toBe(false);
    expect(stillThatDevice(null, undefined)).toBe(true);
    expect(stillThatDevice("a", null)).toBe(false);
  });
});
