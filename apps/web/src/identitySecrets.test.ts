import * as ed from "@noble/ed25519";
import { AccountSettings, bytesToHex, createBackup, deriveBackupKeys, deriveDmKey, deriveDmKeyBits, deriveSettingsKey, deriveSettingsKeyBits, deviceEnrolMessage, deviceProofMessage, openBackup, openDm, openSettings, sealDm, sealSettings } from "@squorli/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryVault } from "./deviceKey";
import { backupOf, deviceSignerOf, dmKeyOf, dropDevice, enrolFields, forgetIdentity, forgetServerAccount, identityFromPrivateKey, loadDeviceOf, loadOrCreateIdentity, loadServerAccounts, newDevice, newIdentity, setDeviceVault, setKeyVault, setSecretStore, settingsKeyOf, sign, signBoth, storeIdentity, storeServerAccount, storedIdentity, type KeyVault } from "./identity";

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

// The platform's key vault (4 October 2026, security audit C1): the page never holds a seed; the test plays the shell with the
// client's own libraries, so what the page seals the browser side opens and the other way round.
describe("the account key in the platform's vault", () => {
  const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
  const verifies = (publicKey: string, signature: string, message: string) => ed.verifyAsync(hex(signature), new TextEncoder().encode(message), hex(publicKey));
  const login = ["community-chat-login", "chat.example.org", "n1"].join("\n");
  function fakeVault(): { vault: KeyVault; seeds: Map<string, string>; forgotten: string[] } {
    const seeds = new Map<string, string>();
    const forgotten: string[] = [];
    const take = async (seed: string) => { const pk = bytesToHex(await ed.getPublicKeyAsync(hex(seed))); seeds.set(pk, seed); return pk; };
    const vault: KeyVault = {
      sign: async (pk, m) => (seeds.has(pk) && m.startsWith("community-chat-login\n") ? bytesToHex(await ed.signAsync(new TextEncoder().encode(m), hex(seeds.get(pk)!))) : null),
      dmKey: async (pk, peer) => (seeds.has(pk) ? bytesToHex(await deriveDmKeyBits(seeds.get(pk)!, pk, peer)) : null),
      settingsKey: async (pk) => (seeds.has(pk) ? bytesToHex(await deriveSettingsKeyBits(seeds.get(pk)!, pk)) : null),
      backup: async (pk, password, context) => (seeds.has(pk) ? createBackup(password, seeds.get(pk)!, 1000, context) : null),
      generate: () => take(bytesToHex(ed.utils.randomPrivateKey())),
      import: take,
      forget: async (pk) => { seeds.delete(pk); forgotten.push(pk); },
    };
    return { vault, seeds, forgotten };
  }
  /** A store that takes the seeds out of an entry as the shell's secrets.ts does (into the vault's map, at once). */
  function strippingStore(seeds: Map<string, string>) {
    const m = new Map<string, string>();
    const strip = (key: string, value: string) => {
      if (key !== "chat.identity.v1") return value;
      const o = JSON.parse(value) as { publicKey: string; privateKey?: unknown };
      if (typeof o.privateKey === "string") { seeds.set(o.publicKey, o.privateKey); delete o.privateKey; }
      return JSON.stringify(o);
    };
    return { m, store: { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string | null) => { if (v === null) m.delete(k); else m.set(k, strip(k, v)); return true; } } };
  }
  let ls: Map<string, string>;
  beforeEach(() => { ls = fakeLocalStorage(); setDeviceVault(memoryVault()); setKeyVault(null); });

  it("makes the first identity in the vault, stores no seed, and signs through it", async () => {
    const { vault, seeds } = fakeVault();
    const { m, store } = fakeStore();
    setSecretStore(store); setKeyVault(vault);
    const id = await loadOrCreateIdentity();
    expect(id.privateKey).toBeNull();
    expect(seeds.has(id.publicKey)).toBe(true);
    expect(JSON.parse(m.get("chat.identity.v1")!)).toEqual({ publicKey: id.publicKey, privateKey: null, device: null });
    expect(await verifies(id.publicKey, await sign(id, login), login)).toBe(true);
    const withDevice = { ...id, device: (await newDevice()).stored };
    const signed = await signBoth(withDevice, login);
    expect(await verifies(id.publicKey, signed.signature, login)).toBe(true);
    expect(signed.deviceKey).toBe(withDevice.device.publicKey);
    expect(storedIdentity()).toEqual(id);
  });

  it("imports a recovered seed and makes new keys there, and lets them go with the entries", async () => {
    const { vault, seeds, forgotten } = fakeVault();
    const { store } = fakeStore();
    setSecretStore(store); setKeyVault(vault);
    const seed = bytesToHex(ed.utils.randomPrivateKey());
    const id = await identityFromPrivateKey(seed);
    expect(id).toEqual({ publicKey: bytesToHex(await ed.getPublicKeyAsync(hex(seed))), privateKey: null, device: null });
    expect(seeds.get(id.publicKey)).toBe(seed);
    storeIdentity(id);
    const fresh = await newIdentity();
    expect(fresh.privateKey).toBeNull();
    storeServerAccount("x.example", { ...fresh, localHandle: "bea", token: null });
    forgetServerAccount("x.example");
    forgetIdentity();
    expect(forgotten.sort()).toEqual([fresh.publicKey, id.publicKey].sort());
    expect(seeds.size).toBe(0);
  });

  it("derives the direct message and settings keys through the vault, and the browser side agrees", async () => {
    const { vault } = fakeVault();
    setSecretStore(fakeStore().store); setKeyVault(vault);
    const me = await newIdentity();
    const friendSeed = bytesToHex(ed.utils.randomPrivateKey());
    const friend = bytesToHex(await ed.getPublicKeyAsync(hex(friendSeed)));
    const sealed = await sealDm(await dmKeyOf(me, friend), me.publicKey, friend, "00000000-0000-4000-8000-000000000001", { text: "hi" });
    expect(await openDm(await deriveDmKey(friendSeed, friend, me.publicKey), { from: me.publicKey, to: friend, id: "00000000-0000-4000-8000-000000000001", ...sealed })).toEqual({ text: "hi" });
    const blob = await sealSettings(await settingsKeyOf(me), me.publicKey, { settings: AccountSettings.parse({}), blockedUsers: [] });
    // The same key from the seed itself, as a browser derives it.
    const backup = await backupOf(me, "hunter2hunter2");
    const seed = await openBackup(await deriveBackupKeys("hunter2hunter2", backup.params.salt, backup.params.iterations), backup.params.iv, backup.ciphertext);
    expect((await openSettings(await deriveSettingsKey(seed, me.publicKey), me.publicKey, blob))?.blockedUsers).toEqual([]);
  });

  it("moves a seed left in localStorage by an older app into the vault through the store, and keeps none in the page", async () => {
    const { vault, seeds } = fakeVault();
    const seed = bytesToHex(ed.utils.randomPrivateKey());
    const pk = bytesToHex(await ed.getPublicKeyAsync(hex(seed)));
    ls.set("chat.identity.v1", JSON.stringify({ publicKey: pk, privateKey: seed }));
    const { m, store } = strippingStore(seeds);
    setSecretStore(store); setKeyVault(vault);
    const id = await loadOrCreateIdentity();
    expect(id).toEqual({ publicKey: pk, privateKey: null, device: null });
    expect(ls.has("chat.identity.v1")).toBe(false);
    expect(m.get("chat.identity.v1")).not.toContain(seed);
    expect(seeds.get(pk)).toBe(seed);
    expect(await verifies(pk, await sign(id, login), login)).toBe(true);
  });

  it("says that the key is gone when the vault does not answer for it", async () => {
    const { vault } = fakeVault();
    setSecretStore(fakeStore().store); setKeyVault(vault);
    const gone = { publicKey: "ab".repeat(32), privateKey: null, device: null };
    await expect(sign(gone, login)).rejects.toThrow("Schlüssel");
    await expect(dmKeyOf(gone, "cd".repeat(32))).rejects.toThrow("Schlüssel");
    await expect(settingsKeyOf(gone)).rejects.toThrow("Schlüssel");
    await expect(backupOf(gone, "hunter2hunter2")).rejects.toThrow("Schlüssel");
    // A message the vault does not sign is the same to the page.
    const id = await newIdentity();
    await expect(sign(id, "squorli-device\nx\ny")).rejects.toThrow("Schlüssel");
    setKeyVault(null);
  });
});
