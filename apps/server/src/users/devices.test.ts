import { deviceProofMessage } from "@squorli/protocol";
import * as ed from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { deviceAllowed, deviceSignatureValid, revokeTargets, type DeviceState } from "./devices";

const key = "ab".repeat(32);
const other = "cd".repeat(32);
const directory = (over: Partial<DeviceState> = {}): DeviceState => ({ handle: "anna", localHandle: null, devicesEnforced: false, deviceKeys: null, localEnforced: false, localDevice: null, ...over });
const local = (over: Partial<DeviceState> = {}): DeviceState => ({ handle: null, localHandle: "anna", devicesEnforced: false, deviceKeys: null, localEnforced: false, localDevice: null, ...over });

describe("whether a device is let in", () => {
  it("lets a directory account that is not enforced in, with or without a device", () => {
    expect(deviceAllowed(directory(), null)).toBe(true);
    expect(deviceAllowed(directory(), key)).toBe(true);
    // Keys the directory told about an account that is not enforced do not matter.
    expect(deviceAllowed(directory({ deviceKeys: [other] }), key)).toBe(true);
  });
  it("lets only the devices the directory named into an enforced directory account", () => {
    const enforced = directory({ devicesEnforced: true, deviceKeys: [key] });
    expect(deviceAllowed(enforced, key)).toBe(true);
    expect(deviceAllowed(enforced, other)).toBe(false);
    expect(deviceAllowed(enforced, null)).toBe(false);
    expect(deviceAllowed(directory({ devicesEnforced: true, deviceKeys: [] }), key)).toBe(false);
    expect(deviceAllowed(directory({ devicesEnforced: true, deviceKeys: null }), key)).toBe(false);
  });
  it("lets a server account that is not enforced in, unless the device was signed out", () => {
    expect(deviceAllowed(local(), null)).toBe(true);
    expect(deviceAllowed(local(), key)).toBe(true);
    expect(deviceAllowed(local({ localDevice: "active" }), key)).toBe(true);
    expect(deviceAllowed(local({ localDevice: "revoked" }), key)).toBe(false);
  });
  it("lets only enrolled devices into an enforced server account", () => {
    expect(deviceAllowed(local({ localEnforced: true, localDevice: "active" }), key)).toBe(true);
    expect(deviceAllowed(local({ localEnforced: true, localDevice: null }), key)).toBe(false);
    expect(deviceAllowed(local({ localEnforced: true, localDevice: "revoked" }), key)).toBe(false);
    expect(deviceAllowed(local({ localEnforced: true }), null)).toBe(false);
  });
  it("counts a row with both kinds of account as the server's", () => {
    const both = directory({ localHandle: "anna", devicesEnforced: true, deviceKeys: [] });
    expect(deviceAllowed(both, key)).toBe(true);
    expect(deviceAllowed({ ...both, localEnforced: true }, key)).toBe(false);
    expect(deviceAllowed({ ...both, localEnforced: true, localDevice: "active" }, key)).toBe(true);
  });
  it("has nothing to say about a key without any account", () => {
    expect(deviceAllowed(directory({ handle: null, devicesEnforced: true }), null)).toBe(true);
  });
});

describe("which devices a sign-out means", () => {
  const rows = [
    { id: "a", deviceKey: key, revokedAt: null },
    { id: "b", deviceKey: other, revokedAt: null },
    { id: "c", deviceKey: "ef".repeat(32), revokedAt: new Date() },
  ];
  it("takes one or all others, never the asking device and never one that is out already", () => {
    expect(revokeTargets(rows, "b", key)).toEqual(["b"]);
    expect(revokeTargets(rows, "others", key)).toEqual(["b"]);
    expect(revokeTargets(rows, "a", key)).toEqual([]);
    expect(revokeTargets(rows, "c", key)).toEqual([]);
    expect(revokeTargets(rows, "unknown", key)).toEqual([]);
    expect(revokeTargets(rows, "others", null)).toEqual(["a", "b"]);
  });
});

describe("a device's proof", () => {
  it("is bound to the account and to the message the account's key signed", async () => {
    const seed = ed.utils.randomPrivateKey();
    const deviceKey = Buffer.from(await ed.getPublicKeyAsync(seed)).toString("hex");
    const message = "community-chat-login\nchat.example.org\nn1";
    const signature = Buffer.from(await ed.signAsync(new TextEncoder().encode(deviceProofMessage(key, message)), seed)).toString("hex");
    expect(await deviceSignatureValid(deviceKey, signature, deviceProofMessage(key, message))).toBe(true);
    expect(await deviceSignatureValid(deviceKey, signature, deviceProofMessage(other, message))).toBe(false);
    expect(await deviceSignatureValid(deviceKey, signature, deviceProofMessage(key, `${message}x`))).toBe(false);
    expect(await deviceSignatureValid(deviceKey, signature, message)).toBe(false);
    expect(await deviceSignatureValid("zz", "zz", message)).toBe(false);
  });
});
