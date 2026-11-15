import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * The signature of a plugin file (docs/features/plugins.md, 15 November 2026); pure and tested.
 *
 * A signed plugin ends with one more block comment:
 *
 *     /* squorli-signature {"v":1,"key":"2026-11","kind":"reviewed","sig":"<base64>"} *\/
 *
 * It stays one file that way (the upload, `squorli plugin add`). What is signed is the text
 * `squorli-plugin-signature-v1\n<kind>\n<sha256 of the file without that comment>`, with Ed25519 and Squorli's plugin key
 * (signingKeys.ts; never the release key). The file is brought into one form before it is hashed (`canonicalBody`), so a
 * checkout or an editor that turns line ends around does not break a signature. The manifest stands in the file, so its
 * capabilities, hosts, author and version are signed with it: every new version needs a new signature.
 *
 * `kind` says whose code it is: `official` = Squorli's own plugin, `reviewed` = somebody else's that Squorli read
 * (the repository squorli-plugins). `tools/plugin-sign.mjs` writes signatures; a test holds the two against each other.
 */

export const SIGNATURE_MARK = "/* squorli-signature ";
export const SIGNATURE_PREFIX = "squorli-plugin-signature-v1";
export const SIGNATURE_KINDS = ["official", "reviewed"] as const;
export type SignatureKind = (typeof SIGNATURE_KINDS)[number];
/** A key the server trusts: a short name and the raw 32 bytes of the Ed25519 public key, base64. */
export type SigningKey = { id: string; publicKey: string };
export type PluginSignature = { key: string; kind: SignatureKind; sig: string };

export type SignatureCheck =
  /** `hash` = the SHA-256 of the canonical body (what a revocation names). */
  | { status: "none"; hash: string }
  | { status: "valid"; hash: string; keyId: string; kind: SignatureKind }
  | { status: "invalid"; hash: string; reason: string }
  | { status: "revoked"; hash: string; keyId: string; kind: SignatureKind };

const SIGNATURE_LINE_MAX = 400;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;

/**
 * The file without its signature comment, and what that comment holds. `malformed` = the file ends with a comment that
 * starts like a signature and is none (no JSON, a missing part, an unknown kind): such a file is refused, never read as
 * unsigned. The mark anywhere but in the last comment of the file is ordinary text.
 */
export function splitSignature(source: string): { body: string; signature: PluginSignature | null; malformed: boolean } {
  const at = source.lastIndexOf(SIGNATURE_MARK);
  if (at < 0) return { body: source, signature: null, malformed: false };
  let end = source.length;
  while (end > at && isSpace(source.charCodeAt(end - 1))) end--;
  const tail = source.slice(at, end);
  const close = tail.indexOf("*/");
  // Something follows the comment, or it never closes: the mark stands in the plugin's own text.
  if (close < 0 || close + 2 !== tail.length) return { body: source, signature: null, malformed: false };
  const body = source.slice(0, at);
  if (tail.length > SIGNATURE_LINE_MAX) return { body, signature: null, malformed: true };
  let json: unknown;
  try { json = JSON.parse(tail.slice(SIGNATURE_MARK.length, close)); } catch { return { body, signature: null, malformed: true }; }
  const s = json as { v?: unknown; key?: unknown; kind?: unknown; sig?: unknown } | null;
  if (!s || typeof s !== "object" || s.v !== 1 || typeof s.key !== "string" || !/^[a-z0-9-]{1,32}$/.test(s.key) || typeof s.sig !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(s.sig)
    || typeof s.kind !== "string" || !(SIGNATURE_KINDS as readonly string[]).includes(s.kind)) return { body, signature: null, malformed: true };
  return { body, signature: { key: s.key, kind: s.kind as SignatureKind, sig: s.sig }, malformed: false };
}

/** The one form a plugin's text is hashed in: no byte order mark, line ends as `\n`, nothing blank at the end. */
export function canonicalBody(body: string): string {
  let text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  text = text.replaceAll("\r\n", "\n");
  let end = text.length;
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(canonicalBody(body), "utf8").digest("hex");
}

export function signedMessage(kind: SignatureKind, hash: string): string {
  return `${SIGNATURE_PREFIX}\n${kind}\n${hash}`;
}

/**
 * Whose signature does this file carry? `none` = no signature comment; `invalid` = one that does not hold (changed file,
 * a key this server does not trust, a comment that is no signature); `revoked` = a valid one Squorli took back.
 */
export function verifyPluginSignature(source: string, keys: readonly SigningKey[], revoked: readonly string[] = []): SignatureCheck {
  const { body, signature, malformed } = splitSignature(source);
  const hash = bodyHash(body);
  if (malformed) return { status: "invalid", hash, reason: "the signature comment at the end of the file cannot be read" };
  if (!signature) return { status: "none", hash };
  const key = keys.find((k) => k.id === signature.key);
  if (!key) return { status: "invalid", hash, reason: `this server does not know the signing key "${signature.key}"` };
  let ok = false;
  try {
    const raw = Buffer.from(key.publicKey, "base64");
    if (raw.length === 32) ok = verify(null, Buffer.from(signedMessage(signature.kind, hash), "utf8"), createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" }), Buffer.from(signature.sig, "base64"));
  } catch { ok = false; }
  if (!ok) return { status: "invalid", hash, reason: "the signature does not fit the file: it was changed after it was signed" };
  if (revoked.includes(hash)) return { status: "revoked", hash, keyId: key.id, kind: signature.kind };
  return { status: "valid", hash, keyId: key.id, kind: signature.kind };
}

/** A trusted key from its PEM file (`-----BEGIN PUBLIC KEY-----`), for tests and the check that the repository's file is the constant. */
export function signingKeyFromPem(id: string, pem: string): SigningKey {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("a plugin signing key is an Ed25519 key");
  return { id, publicKey: (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64") };
}
