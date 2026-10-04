import { verify } from "node:crypto";
import { deriveBackupKeys, deriveDmKeyBits, deriveSettingsKeyBits, directoryActionMessage, openBackup } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { KeyVault, isSignable, namedKeys, publicKeyOfSeed, spkiOf, takeSeeds, type VaultKeys } from "./keyVaultLogic";

// RFC 8032, section 7.1, test 1.
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const SEED2 = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const LOGIN = "community-chat-login\nchat.example.org\nnonce1";

function memory(works = true) {
  const box: { keys: VaultKeys; writes: number } = { keys: {}, writes: 0 };
  const vault = new KeyVault({ read: () => box.keys, write: (keys) => { if (!works) return false; box.keys = keys; box.writes++; return true; } });
  return { vault, box };
}
const verifies = (publicKey: string, message: string, signature: string) => verify(null, Buffer.from(message, "utf8"), { key: spkiOf(publicKey), format: "der", type: "spki" }, Buffer.from(signature, "hex"));

describe("the key vault", () => {
  it("derives the public half as the client's library does (RFC 8032)", () => {
    expect(publicKeyOfSeed(SEED)).toBe(PUBLIC);
  });

  it("generates and imports keys, lists their public halves and signs the known messages", () => {
    const { vault, box } = memory();
    const made = vault.generate()!;
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.import(SEED)).toBe(PUBLIC);
    expect(vault.list().sort()).toEqual([made, PUBLIC].sort());
    expect(box.keys[PUBLIC]).toBe(SEED);
    expect(verifies(PUBLIC, LOGIN, vault.sign(PUBLIC, LOGIN)!)).toBe(true);
    expect(verifies(made, LOGIN, vault.sign(made, LOGIN)!)).toBe(true);
    // Importing the same seed again writes nothing.
    const writes = box.writes;
    expect(vault.import(SEED)).toBe(PUBLIC);
    expect(box.writes).toBe(writes);
  });

  it("answers null for a key it does not hold, a seed that is no seed, and a storage that refuses", () => {
    const { vault } = memory();
    expect(vault.sign(PUBLIC, LOGIN)).toBeNull();
    expect(vault.import("nope")).toBeNull();
    expect(vault.import(SEED.toUpperCase())).toBeNull();
    expect(vault.import(42)).toBeNull();
    const refusing = memory(false).vault;
    expect(refusing.generate()).toBeNull();
    expect(refusing.import(SEED)).toBeNull();
    expect(refusing.list()).toEqual([]);
  });

  it("signs only the protocol's known message formats", () => {
    const { vault } = memory();
    vault.import(SEED);
    for (const ok of [LOGIN, "community-directory-register\nid.example\nanna\nn", "community-directory-backup\nh\nn\nct", "community-directory-ws\nh\nn",
      "squorli-local-register\nd\nn\nanna\nct", "squorli-local-claim\nd\nn\nanna\npk\nct", directoryActionMessage("h", "settings-sealed", "n", "payload\nwith\nlines"), directoryActionMessage("h", "device-revoke", "n", "self")]) {
      expect(isSignable(ok), ok).toBe(true);
      expect(vault.sign(PUBLIC, ok), ok).toMatch(/^[0-9a-f]{128}$/);
    }
    for (const bad of ["", "community-chat-login", "\ncommunity-chat-login\nx", "squorli-device\npk\nm", "community-chat-session\nd\n1\nGET\n/x", "community-directory-nonsense\nh\nn\n",
      "anything", `community-chat-login\n${"x".repeat(300_000)}`, 42, null]) {
      expect(isSignable(bad), String(bad)).toBe(false);
      expect(vault.sign(PUBLIC, bad), String(bad)).toBeNull();
    }
  });

  it("derives the direct message and settings keys the page's functions derive, and only for keys it holds", async () => {
    const { vault } = memory();
    vault.import(SEED);
    const peer = publicKeyOfSeed(SEED2);
    expect(await vault.dmKey(PUBLIC, peer)).toBe(Buffer.from(await deriveDmKeyBits(SEED, PUBLIC, peer)).toString("hex"));
    // The friend derives the same pair key from their side.
    expect(await vault.dmKey(PUBLIC, peer)).toBe(Buffer.from(await deriveDmKeyBits(SEED2, peer, PUBLIC)).toString("hex"));
    expect(await vault.settingsKey(PUBLIC)).toBe(Buffer.from(await deriveSettingsKeyBits(SEED, PUBLIC)).toString("hex"));
    expect(await vault.dmKey(PUBLIC, "short")).toBeNull();
    expect(await vault.dmKey(peer, PUBLIC)).toBeNull();
    expect(await vault.settingsKey(peer)).toBeNull();
  });

  it("makes a password backup the protocol opens, bound to a context where one is given", async () => {
    const { vault } = memory();
    vault.import(SEED);
    const plain = (await vault.backup(PUBLIC, "hunter2hunter2", undefined))!;
    expect(plain.params.bound).toBeUndefined();
    expect(await openBackup(await deriveBackupKeys("hunter2hunter2", plain.params.salt, plain.params.iterations), plain.params.iv, plain.ciphertext)).toBe(SEED);
    const bound = (await vault.backup(PUBLIC, "hunter2hunter2", "chat.example.org"))!;
    expect(bound.params.bound).toBe(true);
    expect(await openBackup(await deriveBackupKeys("hunter2hunter2", bound.params.salt, bound.params.iterations, "chat.example.org"), bound.params.iv, bound.ciphertext)).toBe(SEED);
    expect(bound.authKey).not.toBe(plain.authKey);
    expect(await vault.backup(PUBLIC, "short", undefined)).toBeNull();
    expect(await vault.backup(PUBLIC, "hunter2hunter2", "")).toBeNull();
    expect(await vault.backup(publicKeyOfSeed(SEED2), "hunter2hunter2", undefined)).toBeNull();
  });

  it("forgets a key, and prunes the ones nobody names", () => {
    const { vault, box } = memory();
    vault.import(SEED);
    const other = vault.generate()!;
    vault.forget(PUBLIC);
    expect(vault.list()).toEqual([other]);
    expect(box.keys).toEqual({ [other]: box.keys[other] });
    vault.forget(PUBLIC);
    vault.forget("nonsense");
    vault.import(SEED);
    expect(vault.prune([other])).toEqual([PUBLIC]);
    expect(vault.list()).toEqual([other]);
    expect(vault.prune([other])).toEqual([]);
  });

  it("reads only well-formed seeds from its storage", () => {
    const vault = new KeyVault({ read: () => ({ [PUBLIC]: SEED, bad: "x", [publicKeyOfSeed(SEED2)]: "not hex" }), write: () => true });
    expect(vault.list()).toEqual([PUBLIC]);
  });
});

describe("the seeds of the page's entries move into the vault", () => {
  it("takes the identity's seed and leaves the rest of the entry", () => {
    const { vault } = memory();
    const entry = JSON.stringify({ publicKey: PUBLIC, privateKey: SEED, device: { publicKey: "d", store: "webcrypto" } });
    const stripped = takeSeeds(vault, "chat.identity.v1", entry);
    expect(JSON.parse(stripped)).toEqual({ publicKey: PUBLIC, device: { publicKey: "d", store: "webcrypto" } });
    expect(vault.list()).toEqual([PUBLIC]);
    expect(namedKeys("chat.identity.v1", stripped)).toEqual([PUBLIC]);
    // Without a seed (the vault's already, or the page's null) nothing changes.
    expect(takeSeeds(vault, "chat.identity.v1", stripped)).toBe(stripped);
    const withNull = JSON.stringify({ publicKey: PUBLIC, privateKey: null, device: null });
    expect(takeSeeds(vault, "chat.identity.v1", withNull)).toBe(withNull);
  });

  it("takes every server account's seed", () => {
    const { vault } = memory();
    const peer = publicKeyOfSeed(SEED2);
    const entry = JSON.stringify({ "a.example": { publicKey: PUBLIC, privateKey: SEED, localHandle: "anna", token: "t", device: null }, "b.example": { publicKey: peer, privateKey: SEED2, localHandle: "bea", token: null } });
    const stripped = takeSeeds(vault, "chat.serverAccounts.v1", entry);
    expect(JSON.parse(stripped)).toEqual({ "a.example": { publicKey: PUBLIC, localHandle: "anna", token: "t", device: null }, "b.example": { publicKey: peer, localHandle: "bea", token: null } });
    expect(vault.list().sort()).toEqual([PUBLIC, peer].sort());
    expect(namedKeys("chat.serverAccounts.v1", stripped).sort()).toEqual([PUBLIC, peer].sort());
  });

  it("leaves a seed that does not belong to its public key, other entries, and what is not JSON", () => {
    const { vault } = memory();
    const wrong = JSON.stringify({ publicKey: publicKeyOfSeed(SEED2), privateKey: SEED });
    expect(takeSeeds(vault, "chat.identity.v1", wrong)).toBe(wrong);
    expect(vault.list()).toEqual([]);
    const sessions = JSON.stringify({ publicKey: PUBLIC, privateKey: SEED });
    expect(takeSeeds(vault, "chat.sessions.v2", sessions)).toBe(sessions);
    expect(takeSeeds(vault, "chat.identity.v1", "{not json")).toBe("{not json");
    expect(takeSeeds(vault, "chat.identity.v1", "null")).toBe("null");
    expect(vault.list()).toEqual([]);
    expect(namedKeys("chat.identity.v1", null)).toEqual([]);
    expect(namedKeys("chat.identity.v1", "{bad")).toEqual([]);
    expect(namedKeys("chat.sessions.v2", sessions)).toEqual([]);
  });

  it("keeps the seed in the entry when the vault's storage refuses", () => {
    const { vault } = memory(false);
    const entry = JSON.stringify({ publicKey: PUBLIC, privateKey: SEED });
    expect(takeSeeds(vault, "chat.identity.v1", entry)).toBe(entry);
  });
});
