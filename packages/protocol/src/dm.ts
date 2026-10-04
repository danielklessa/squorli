// COPY NOTE: also exists byte-identically in the squorli-directory repo (packages/protocol/src); the source is squorli-server, copy it over after any change.
/**
 * End-to-end encryption of direct messages (M7). Isomorphic (browser, Node, account page).
 *
 * Key: the Ed25519 identity key, converted to X25519 (the same conversion as libsodium's
 * crypto_sign_ed25519_*_to_curve25519). Each side knows the friend's Ed25519 key from the directory, so no key
 * distribution is needed. Both sides (and all their devices, the seed lives in the backup) derive the same
 * pair key:
 *
 *   shared = X25519(meinX, deinX)
 *   key    = HKDF-SHA256(shared, salt = smaller Ed25519 key ‖ larger one, info "squorli-dm-v1") -> AES-256-GCM
 *
 * Message: AES-GCM(key, random 12-byte IV, JSON { text }, AAD = "v1\n<from>\n<to>\n<id>"). The AAD binds sender,
 * recipient and message id so the directory cannot swap anything around; authenticity follows from the DH (only the two
 * key holders can produce a valid tag). No forward secrecy (deliberate; directory repo, docs/features/friends-dm.md).
 *
 * Link previews (21 September 2026): the SENDER makes the preview and puts it into the plaintext (`previews`), so whoever
 * reads a message never contacts the linked host and no server learns what the preview says. The picture is too large for
 * a message: the sender encrypts it with a fresh random key (`sealDmBlob`), stores the ciphertext in the directory's blob
 * store and names blob, key and IV in the plaintext; the directory keeps and serves bytes it cannot read. A preview is
 * taken away by its author with a second message whose plaintext is a `control` (`preview.remove`); clients apply it only
 * when it comes from the author of the message it names, and show it as nothing.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, randomHex } from "./backup";

const utf8 = (s: string) => new TextEncoder().encode(s);
const subtle = () => globalThis.crypto.subtle;

export const DM_VERSION = "v1";
/** A picture in the directory's blob store, encrypted by the sender: AES-256-GCM with this key (hex) and IV (hex). */
export const DmBlobRef = z.object({ blob: z.string().regex(/^[0-9a-f]{32}$/), key: z.string().regex(/^[0-9a-f]{64}$/), iv: z.string().regex(/^[0-9a-f]{24}$/), mime: z.enum(["image/webp", "image/jpeg", "image/png"]) });
export type DmBlobRef = z.infer<typeof DmBlobRef>;
/** Preview of a link, made by the sender. The fields of the chat's `LinkPreview`, the picture as a blob reference. */
export const DmPreview = z.object({
  url: z.string().max(2100),
  kind: z.enum(["page", "youtube"]),
  siteName: z.string().max(100).nullable(),
  title: z.string().max(300).nullable(),
  description: z.string().max(500).nullable(),
  image: DmBlobRef.nullable(),
  videoId: z.string().regex(/^[\w-]{11}$/).optional(),
  start: z.number().int().nonnegative().optional(),
});
export type DmPreview = z.infer<typeof DmPreview>;
export const DM_MAX_PREVIEWS = 3;
/** A message that is an instruction, not text: the author of message `id` takes the preview of `url` away, for both sides. */
export const DmControl = z.object({ type: z.literal("preview.remove"), id: z.string().uuid(), url: z.string().max(2100) });
export type DmControl = z.infer<typeof DmControl>;
/** Plaintext of a message; deliberately an object so fields (reply-to, attachments) can be added later. */
export type DmPlaintext = { text: string; previews?: DmPreview[]; control?: DmControl };

/** X25519 counterpart of a friend's Ed25519 key (hex). */
export function dmPublicKeyOf(ed25519PublicKeyHex: string): string {
  return bytesToHex(ed25519.utils.toMontgomery(hexToBytes(ed25519PublicKeyHex)));
}

/** Additional data (AAD) of a message; the directory knows these values too but cannot change them without breaking the tag. */
export function dmAad(from: string, to: string, id: string): string {
  return `${DM_VERSION}\n${from}\n${to}\n${id}`;
}

/**
 * The pair key's bytes from my seed and the friend's Ed25519 key. Split from `deriveDmKey` on 4 October 2026 (security
 * audit C1): the desktop app's main process holds the seed and derives these for the page, which imports them with
 * `importDmKey` and never sees the seed.
 */
export async function deriveDmKeyBits(mySeedHex: string, myPublicKeyHex: string, theirPublicKeyHex: string): Promise<Uint8Array> {
  const myX = ed25519.utils.toMontgomerySecret(hexToBytes(mySeedHex));
  const shared = x25519.getSharedSecret(myX, hexToBytes(dmPublicKeyOf(theirPublicKeyHex)));
  const [lo, hi] = [myPublicKeyHex, theirPublicKeyHex].sort();
  const hk = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8(`${lo}${hi}`), info: utf8("squorli-dm-v1") }, hk, 256));
}
/** The pair key as a key that cannot be read out again. */
export function importDmKey(bits: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", bits as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** Pair key from my seed and the friend's Ed25519 key; cache it per friend in the client. */
export async function deriveDmKey(mySeedHex: string, myPublicKeyHex: string, theirPublicKeyHex: string): Promise<CryptoKey> {
  return importDmKey(await deriveDmKeyBits(mySeedHex, myPublicKeyHex, theirPublicKeyHex));
}

/** Encrypt a message: fresh IV, plaintext as JSON. */
export async function sealDm(key: CryptoKey, from: string, to: string, id: string, plaintext: DmPlaintext): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomHex(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: hexToBytes(iv), additionalData: utf8(dmAad(from, to, id)) }, key, utf8(JSON.stringify(plaintext)));
  return { iv, ciphertext: bytesToBase64(new Uint8Array(ct)) };
}

/** Decrypt a message; throws on a wrong key or modified fields (the AES-GCM tag does not match). */
export async function openDm(key: CryptoKey, m: { from: string; to: string; id: string; iv: string; ciphertext: string }): Promise<DmPlaintext> {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: hexToBytes(m.iv), additionalData: utf8(dmAad(m.from, m.to, m.id)) }, key, base64ToBytes(m.ciphertext));
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as { text?: unknown; previews?: unknown; control?: unknown };
  const out: DmPlaintext = { text: typeof parsed.text === "string" ? parsed.text : "" };
  // What the other side sent is checked field by field: a preview that does not fit is dropped, the message stays.
  if (Array.isArray(parsed.previews)) {
    const previews = parsed.previews.slice(0, DM_MAX_PREVIEWS).flatMap((p) => { const r = DmPreview.safeParse(p); return r.success ? [r.data] : []; });
    if (previews.length > 0) out.previews = previews;
  }
  const control = DmControl.safeParse(parsed.control);
  if (control.success) out.control = control.data;
  return out;
}

/** Encrypt a picture for the blob store with a key of its own; key and IV travel inside the encrypted message. */
export async function sealDmBlob(bytes: Uint8Array): Promise<{ key: string; iv: string; ciphertext: Uint8Array }> {
  const key = randomHex(32), iv = randomHex(12);
  const k = await subtle().importKey("raw", hexToBytes(key), "AES-GCM", false, ["encrypt"]);
  return { key, iv, ciphertext: new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: hexToBytes(iv) }, k, bytes as BufferSource)) };
}

/** Decrypt a picture from the blob store; throws when the bytes are not what the sender stored. */
export async function openDmBlob(ref: Pick<DmBlobRef, "key" | "iv">, ciphertext: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", hexToBytes(ref.key), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: hexToBytes(ref.iv) }, k, ciphertext as BufferSource));
}
