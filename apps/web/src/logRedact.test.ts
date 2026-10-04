import { describe, expect, it } from "vitest";
import { redactForLog } from "./logRedact";

describe("redactForLog", () => {
  it("masks the session token of the hello and keeps the rest readable", () => {
    const out = redactForLog(JSON.stringify({ type: "hello", sessionToken: "abc123_-XYZ", protocolVersion: 4 }));
    expect(out).toBe('{"type":"hello","sessionToken":"•••","protocolVersion":4}');
    expect(out).not.toContain("abc123");
  });
  it("masks other secret fields, also with escaped quotes inside the value", () => {
    const out = redactForLog(JSON.stringify({ token: 'a"b', authKey: "deadbeef", x: "keep", password: "p w" }));
    expect(out).toBe('{"token":"•••","authKey":"•••","x":"keep","password":"•••"}');
  });
  it("masks the device proof's signature of the hello", () => {
    const out = redactForLog(JSON.stringify({ type: "hello", sessionToken: "t", protocolVersion: 4, deviceProof: { domain: "chat.example", at: 1, signature: "ab".repeat(64) } }));
    expect(out).toBe('{"type":"hello","sessionToken":"•••","protocolVersion":4,"deviceProof":{"domain":"chat.example","at":1,"signature":"•••"}}');
  });
  it("leaves a message without a secret as it is", () => {
    const s = JSON.stringify({ type: "voice.join", channelId: "c1", micMuted: false });
    expect(redactForLog(s)).toBe(s);
  });
});
