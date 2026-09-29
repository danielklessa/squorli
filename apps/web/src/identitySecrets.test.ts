import * as ed from "@noble/ed25519";
import { deviceEnrolMessage, deviceProofMessage } from "@squorli/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryVault } from "./deviceKey";
import { deviceSignerOf, dropDevice, enrolFields, forgetIdentity, loadDeviceOf, loadOrCreateIdentity, loadServerAccounts, newDevice, newIdentity, setDeviceVault, setSecretStore, signBoth, storeIdentity, storeServerAccount, storedIdentity } from "./identity";

// Node has no localStorage: a small one per test.
function fakeLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
  return m;
}
function fakeStore(works = true) {
  const m = new Map<string, string>();
  return { m, store: { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string | null) => { if (!works) return false; if (v === null) m.delete(k); else m.set(k, v); return true; } } };
}

describe("secrets in the platform's store (safeStorage)", () => {
  let ls: Map<string, string>;
  beforeEach(() => { ls = fakeLocalStorage(); setSecretStore(null); });

  it("moves an identity from localStorage into the store at the first read, and removes it there", async () => {
    ls.set("chat.identity.v1", JSON.stringify({ publicKey: "p", privateKey: "s" }));
    const { m, store } = fakeStore();
    setSecretStore(store);
    // An entry from before devices names none.
    expect(await loadOrCreateIdentity()).toEqual({ publicKey: "p", privateKey: "s", device: null });
    expect(m.get("chat.identity.v1")).toContain("\"p\"");
    expect(ls.has("chat.identity.v1")).toBe(false);
  });

  it("keeps localStorage when the store refuses to write, so nothing is lost", async () => {
    ls.set("chat.identity.v1", JSON.stringify({ publicKey: "p", privateKey: "s" }));
    const { store } = fakeStore(false);
    setSecretStore(store);
    expect((await loadOrCreateIdentity()).publicKey).toBe("p");
    expect(ls.has("chat.identity.v1")).toBe(true);
  });

  it("writes new secrets into the store only, and forgets them there", async () => {
    const { m, store } = fakeStore();
    setSecretStore(store);
    const id = await loadOrCreateIdentity();
    storeServerAccount("x.example", { ...id, localHandle: "bea", token: "t" });
    expect(m.has("chat.identity.v1") && m.has("chat.serverAccounts.v1")).toBe(true);
    expect(ls.size).toBe(0);
    expect(loadServerAccounts()["x.example"]?.token).toBe("t");
    forgetIdentity();
    expect(m.has("chat.identity.v1")).toBe(false);
  });

  it("without a store (browser) stays in localStorage", async () => {
    const id = await loadOrCreateIdentity();
    expect(JSON.parse(ls.get("chat.identity.v1")!)).toEqual(id);
  });
});

describe("the device next to the account's key (docs/features/devices.md)", () => {
  const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
  const verifies = (publicKey: string, signature: string, message: string) => ed.verifyAsync(hex(signature), new TextEncoder().encode(message), hex(publicKey));
  const login = ["community-chat-login", "chat.example.org", "n1"].join("\n");
  beforeEach(() => { fakeLocalStorage(); setSecretStore(null); setDeviceVault(memoryVault()); });

  it("is named in the identity's entry without its private half, and signs along", async () => {
    const id = { ...(await newIdentity()), device: (await newDevice()).stored };
    storeIdentity(id);
    const stored = JSON.parse(localStorage.getItem("chat.identity.v1")!) as { device: Record<string, unknown> };
    expect(stored.device).toEqual({ publicKey: id.device.publicKey, store: "webcrypto" });
    expect(storedIdentity()).toEqual(id);
    const signed = await signBoth(id, login);
    expect(signed.deviceKey).toBe(id.device.publicKey);
    expect(await verifies(id.publicKey, signed.signature, login)).toBe(true);
    expect(await verifies(id.device.publicKey, signed.deviceSignature!, deviceProofMessage(id.publicKey, login))).toBe(true);
  });

  it("signs with the account's key alone while the identity has no device", async () => {
    const id = await newIdentity();
    expect(deviceSignerOf(id)).toBeNull();
    expect(Object.keys(await signBoth(id, "m"))).toEqual(["signature"]);
  });

  it("proves at an enrolment that it holds the key it names", async () => {
    const device = await newDevice();
    const fields = await enrolFields(device, "id.example.org", "anna");
    expect(fields.deviceKey).toBe(device.stored.publicKey);
    expect(await verifies(fields.deviceKey, fields.deviceSignature, deviceEnrolMessage("id.example.org", "anna", fields.deviceKey))).toBe(true);
  });

  it("is gone for good once it is dropped", async () => {
    const device = await newDevice();
    const id = { ...(await newIdentity()), device: device.stored };
    expect(await loadDeviceOf(id)).toBe(true);
    await dropDevice(id.device);
    expect(deviceSignerOf(id)).toBeNull();
    expect(await loadDeviceOf(id)).toBe(false);
  });

  it("reads an entry whose device it cannot read as one without a device, for server accounts too", async () => {
    localStorage.setItem("chat.identity.v1", JSON.stringify({ publicKey: "p", privateKey: "s", device: { publicKey: "short", store: "later" } }));
    expect((await loadOrCreateIdentity()).device).toBeNull();
    const id = await newIdentity();
    const device = (await newDevice()).stored;
    storeServerAccount("x.example", { ...id, device, localHandle: "bea", token: null });
    expect(loadServerAccounts()["x.example"]?.device).toEqual(device);
  });
});
