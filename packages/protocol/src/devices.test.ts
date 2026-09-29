import { describe, expect, it } from "vitest";
import { DEVICE_REFUSED, SESSION_END_REASONS, VerifyRequest, WS_CLOSE_SESSION_ENDED, sessionEndReasonOf } from "./index";
import { DevicesResponse, LocalAccountErrorCode, LocalBackupFetchRequest, LocalClaimRequest, LocalDeviceRevokeRequest, LocalRegisterRequest } from "./localAccounts";

// The chat server's part of the devices (directory.ts "Devices" has the shared part, tested in directory.test.ts).
const id = "00000000-0000-4000-8000-000000000000";
const key = "ab".repeat(32);
const proof = { deviceKey: "cd".repeat(32), deviceSignature: "ef".repeat(64) };
const backup = { ciphertext: "Y3Q=", params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: "00".repeat(16), iv: "00".repeat(12) }, authKey: "ef".repeat(32) };

describe("devices on a chat server", () => {
  it("carries the device's proof with the sign-in and stays valid without it", () => {
    const verify = { challengeId: id, publicKey: key, signature: "cd".repeat(64) };
    expect(VerifyRequest.parse(verify).deviceKey).toBeUndefined();
    expect(VerifyRequest.parse({ ...verify, ...proof })).toMatchObject(proof);
  });
  it("carries it with a server account's registration, claim and key fetch", () => {
    expect(LocalRegisterRequest.parse({ challengeId: id, publicKey: key, signature: "cd".repeat(64), handle: "anna", backup, ...proof }).deviceKey).toBe(proof.deviceKey);
    expect(LocalClaimRequest.parse({ handle: "anna", backup, challengeId: id, newPublicKey: key, signature: "cd".repeat(64), newSignature: "cd".repeat(64), ...proof }).deviceKey).toBe(proof.deviceKey);
    expect(LocalBackupFetchRequest.parse({ handle: "anna", authKey: backup.authKey }).deviceKey).toBeUndefined();
    expect(LocalBackupFetchRequest.parse({ handle: "anna", authKey: backup.authKey, ...proof, replaceDevice: id }).replaceDevice).toBe(id);
  });
  it("signs other devices out with the password and lists them", () => {
    expect(LocalDeviceRevokeRequest.safeParse({ authKey: backup.authKey }).success).toBe(true);
    expect(LocalDeviceRevokeRequest.safeParse({}).success).toBe(false);
    const list = DevicesResponse.parse([{ id, label: null, createdAt: "2026-09-29T10:00:00.000Z", lastSeenAt: null, current: true }]);
    expect(list[0]).toMatchObject({ kind: "client", origin: null, current: true });
    for (const code of [DEVICE_REFUSED, "too_many_devices"]) expect(LocalAccountErrorCode.safeParse(code).success).toBe(true);
  });
  it("reads why a session ended, and an unknown reason as a revoked session", () => {
    expect(WS_CLOSE_SESSION_ENDED).toBe(4011);
    for (const r of SESSION_END_REASONS) expect(sessionEndReasonOf(r)).toBe(r);
    expect([sessionEndReasonOf(""), sessionEndReasonOf(undefined), sessionEndReasonOf("later")]).toEqual(["session_revoked", "session_revoked", "session_revoked"]);
  });
});
