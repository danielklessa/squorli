import * as ed from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { createDevice, forgetDevice, loadDevice, memoryVault, parseStoredDevice, type DeviceVault } from "./deviceKey";

const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
const verifies = (publicKey: string, signature: string, message: string) => ed.verifyAsync(hex(signature), new TextEncoder().encode(message), hex(publicKey));
/** A browser without Ed25519 in WebCrypto. */
const noEd25519 = { generateKey: async () => { throw new Error("NotSupportedError"); }, exportKey: globalThis.crypto.subtle.exportKey.bind(globalThis.crypto.subtle), sign: globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle) } as unknown as SubtleCrypto;

describe("device key", () => {
  it("makes a key that cannot be read out, keeps it in the vault and signs with it", async () => {
    const vault = memoryVault();
    const { signer, stored } = await createDevice(vault, true);
    expect(stored).toEqual({ publicKey: signer.publicKey, store: "webcrypto" });
    expect(await verifies(signer.publicKey, await signer.sign("squorli-device\nx"), "squorli-device\nx")).toBe(true);
    const pair = await vault.get(signer.publicKey);
    expect(pair?.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("pkcs8", pair!.privateKey)).rejects.toThrow();
  });
  it("loads a stored device again and signs as the same device", async () => {
    const vault = memoryVault();
    const { signer, stored } = await createDevice(vault, true);
    const again = await loadDevice(vault, stored!);
    expect(again?.publicKey).toBe(signer.publicKey);
    expect(await verifies(signer.publicKey, await again!.sign("m"), "m")).toBe(true);
  });
  it("keeps nothing for a key of this page's life", async () => {
    const vault = memoryVault();
    const { signer, stored } = await createDevice(vault, false);
    expect(stored).toBeNull();
    expect(await vault.get(signer.publicKey)).toBeNull();
    expect(await verifies(signer.publicKey, await signer.sign("m"), "m")).toBe(true);
  });
  it("falls back to an ordinary key without Ed25519 in WebCrypto, without a vault, and when the vault fails", async () => {
    const broken: DeviceVault = { put: async () => { throw new Error("QuotaExceededError"); }, get: async () => null, remove: async () => {} };
    for (const made of [await createDevice(memoryVault(), true, noEd25519), await createDevice(null, true), await createDevice(broken, true)]) {
      expect(made.stored?.store).toBe("plain");
      expect(await verifies(made.signer.publicKey, await made.signer.sign("m"), "m")).toBe(true);
      const again = await loadDevice(null, made.stored!);
      expect(again?.publicKey).toBe(made.signer.publicKey);
    }
  });
  it("answers null for a device whose key pair is gone or does not fit", async () => {
    const vault = memoryVault();
    const { stored } = await createDevice(vault, true);
    await forgetDevice(vault, stored!);
    expect(await loadDevice(vault, stored!)).toBeNull();
    expect(await loadDevice(null, { publicKey: "ab".repeat(32), store: "plain", privateKey: "cd".repeat(32) })).toBeNull();
  });
  it("reads a stored entry and refuses what it does not know", () => {
    const key = "ab".repeat(32);
    expect(parseStoredDevice({ publicKey: key, store: "webcrypto" })).toEqual({ publicKey: key, store: "webcrypto" });
    expect(parseStoredDevice({ publicKey: key, store: "plain", privateKey: key, more: 1 })).toEqual({ publicKey: key, store: "plain", privateKey: key });
    for (const bad of [null, "x", {}, { publicKey: key }, { publicKey: "short", store: "webcrypto" }, { publicKey: key, store: "plain" }, { publicKey: key, store: "later" }]) expect(parseStoredDevice(bad)).toBeNull();
  });
});
