import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { DM_MAX_CIPHERTEXT_CHARS, DM_PAD_BYTES, DM_PAD_MAX_BYTES, DirectoryClientEvent, DirectoryServerEvent, DmSend, base64ToBytes, bytesToHex, deriveDmKey, dmPad, dmPublicKeyOf, openDm, openDmBlob, sealDm, sealDmBlob, type DmPlaintext } from "./index";

const seedA = "0a".repeat(32); const seedB = "0b".repeat(32); const seedC = "0c".repeat(32);
const pubOf = (seed: string) => bytesToHex(ed25519.getPublicKey(Buffer.from(seed, "hex")));
const [pubA, pubB, pubC] = [pubOf(seedA), pubOf(seedB), pubOf(seedC)];
const ID = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";

describe("dm (M7): E2E-Verschluesselung", () => {
  it("both sides derive the same pair key and can read each other", async () => {
    const kA = await deriveDmKey(seedA, pubA, pubB);
    const kB = await deriveDmKey(seedB, pubB, pubA);
    const sealed = await sealDm(kA, pubA, pubB, ID, { text: "Hallo Bö" });
    expect(await openDm(kB, { ...sealed, from: pubA, to: pubB, id: ID })).toEqual({ text: "Hallo Bö" });
    // The sender reads their own message (history on all devices).
    expect(await openDm(kA, { ...sealed, from: pubA, to: pubB, id: ID })).toEqual({ text: "Hallo Bö" });
  });
  it("rejects a third party and any swapped field (AAD)", async () => {
    const kA = await deriveDmKey(seedA, pubA, pubB);
    const kC = await deriveDmKey(seedC, pubC, pubA);
    const sealed = await sealDm(kA, pubA, pubB, ID, { text: "geheim" });
    await expect(openDm(kC, { ...sealed, from: pubA, to: pubB, id: ID })).rejects.toBeDefined();
    const kB = await deriveDmKey(seedB, pubB, pubA);
    await expect(openDm(kB, { ...sealed, from: pubB, to: pubA, id: ID })).rejects.toBeDefined();
    await expect(openDm(kB, { ...sealed, from: pubA, to: pubB, id: ID.replace("6f", "7f") })).rejects.toBeDefined();
  });
  it("uses a fresh iv per message and the schema accepts the result", async () => {
    const kA = await deriveDmKey(seedA, pubA, pubB);
    const a = await sealDm(kA, pubA, pubB, ID, { text: "x" });
    const b = await sealDm(kA, pubA, pubB, ID, { text: "x" });
    expect(a.iv).not.toBe(b.iv);
    expect(DmSend.safeParse({ type: "dm.send", to: pubB, id: ID, ...a, sentAt: new Date().toISOString() }).success).toBe(true);
  });
  it("converts secret and public key consistently (X25519 pub of the converted seed = converted Ed25519 pub)", () => {
    const xPriv = ed25519.utils.toMontgomerySecret(Buffer.from(seedA, "hex"));
    expect(bytesToHex(x25519.getPublicKey(xPriv))).toBe(dmPublicKeyOf(pubA));
  });
  it("event unions parse friend actions and reject unknown types", () => {
    expect(DirectoryClientEvent.safeParse({ type: "friends.accept", publicKey: pubA }).success).toBe(true);
    expect(DirectoryClientEvent.safeParse({ type: "friends.nope", publicKey: pubA }).success).toBe(false);
    expect(DirectoryServerEvent.safeParse({ type: "friends.update", publicKey: pubA, friend: null }).success).toBe(true);
  });
});

describe("dm: link previews inside the plaintext", () => {
  const image = { blob: "ab".repeat(16), key: "cd".repeat(32), iv: "ef".repeat(12), mime: "image/webp" as const };
  const preview = { url: "https://example.org/a", kind: "page" as const, siteName: "Beispiel", title: "Titel", description: null, image };

  it("carries previews and a control message, and drops what does not fit without losing the text", async () => {
    const k = await deriveDmKey(seedA, pubA, pubB);
    const open = async (plaintext: unknown) => openDm(k, { ...(await sealDm(k, pubA, pubB, ID, plaintext as DmPlaintext)), from: pubA, to: pubB, id: ID });
    expect(await open({ text: "schau https://example.org/a", previews: [preview] })).toEqual({ text: "schau https://example.org/a", previews: [preview] });
    expect(await open({ text: "x", previews: [preview, { url: 5 }, { ...preview, image: { ...image, key: "kurz" } }, "quatsch"] })).toEqual({ text: "x", previews: [preview] });
    expect(await open({ text: "x", previews: "nein" })).toEqual({ text: "x" });
    expect((await open({ text: "x", previews: Array.from({ length: 9 }, () => preview) })).previews).toHaveLength(3);
    const control = { type: "preview.remove" as const, id: ID, url: "https://example.org/a" };
    expect(await open({ text: "", control })).toEqual({ text: "", control });
    expect(await open({ text: "", control: { type: "message.delete", id: ID } })).toEqual({ text: "" });
    // A reaction (6 October 2026): the emoji is normalized and must be exactly one; anything else drops the control, not the message.
    const reaction = { type: "reaction" as const, id: ID, emoji: "👍🏽", on: true };
    expect(await open({ text: "", control: reaction })).toEqual({ text: "", control: reaction });
    expect(await open({ text: "", control: { ...reaction, on: false } })).toEqual({ text: "", control: { ...reaction, on: false } });
    expect(await open({ text: "", control: { ...reaction, emoji: "ab" } })).toEqual({ text: "" });
    expect(await open({ text: "", control: { ...reaction, emoji: "😀😀" } })).toEqual({ text: "" });
  });

  it("a picture for the blob store opens only with its key and unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
    const sealed = await sealDmBlob(bytes);
    expect(sealed.key).toMatch(/^[0-9a-f]{64}$/); expect(sealed.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(sealed.ciphertext.length).toBe(bytes.length + 16);
    expect([...(await openDmBlob(sealed, sealed.ciphertext))]).toEqual([...bytes]);
    await expect(openDmBlob({ key: "00".repeat(32), iv: sealed.iv }, sealed.ciphertext)).rejects.toThrow();
    const broken = sealed.ciphertext.slice(); broken[0] = broken[0]! ^ 1;
    await expect(openDmBlob(sealed, broken)).rejects.toThrow();
    // A fresh key every time: the same picture sent twice looks different to the store.
    expect((await sealDmBlob(bytes)).key).not.toBe(sealed.key);
  });
});

describe("dm: padding (security audit D10, measure 3.8)", () => {
  it("brings the plaintext to 1 KB steps so the directory cannot read the length, and a reader still opens it", async () => {
    const k = await deriveDmKey(seedA, pubA, pubB);
    const plainSize = (s: { ciphertext: string }) => base64ToBytes(s.ciphertext).length - 16;
    const short = await sealDm(k, pubA, pubB, ID, { text: "x" });
    const longer = await sealDm(k, pubA, pubB, ID, { text: "y".repeat(900) });
    expect(plainSize(short)).toBe(DM_PAD_BYTES);
    expect(plainSize(longer)).toBe(DM_PAD_BYTES);
    expect(plainSize(await sealDm(k, pubA, pubB, ID, { text: "z".repeat(1100) }))).toBe(2 * DM_PAD_BYTES);
    expect(await openDm(k, { ...longer, from: pubA, to: pubB, id: ID })).toEqual({ text: "y".repeat(900) });
    // A control message is padded like text: the directory cannot tell them apart by size.
    expect(plainSize(await sealDm(k, pubA, pubB, ID, { text: "", control: { type: "preview.remove", id: ID, url: "https://example.org/a" } }))).toBe(DM_PAD_BYTES);
  });
  it("adds nothing from the last step on, and the largest padded message fits the directory's limit", async () => {
    const k = await deriveDmKey(seedA, pubA, pubB);
    const plainSize = (s: { ciphertext: string }) => base64ToBytes(s.ciphertext).length - 16;
    const over = { text: "w".repeat(DM_PAD_MAX_BYTES) };
    expect(plainSize(await sealDm(k, pubA, pubB, ID, over))).toBe(JSON.stringify(over).length);
    expect(dmPad(new Uint8Array(DM_PAD_MAX_BYTES)).length).toBe(DM_PAD_MAX_BYTES);
    expect(dmPad(new Uint8Array(DM_PAD_MAX_BYTES - 1)).length).toBe(DM_PAD_MAX_BYTES);
    const largest = await sealDm(k, pubA, pubB, ID, { text: "v".repeat(DM_PAD_MAX_BYTES - 20) });
    expect(plainSize(largest)).toBe(DM_PAD_MAX_BYTES);
    expect(largest.ciphertext.length).toBeLessThanOrEqual(DM_MAX_CIPHERTEXT_CHARS);
  });
});
