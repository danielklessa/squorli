import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import * as openpgp from "openpgp";

/**
 * The signature check of a downloaded Linux update (5 October 2026, security audit L-3; docs/features/desktop.md).
 * Windows installers are code-signed and electron-updater checks the signature before it installs; the AppImage had only
 * the sha512 of the manifest at squorli.com, so whoever controlled the feed could hand every Linux app a manipulated
 * file. The release workflow attaches a detached GPG signature (`<file>.asc`) to every Linux file, made by the key
 * "Squorli Desktop Releases" whose public half is published at https://squorli.com/squorli-desktop.asc and baked in
 * here: the app fetches the signature next to the file it downloaded and installs only when the signature is the key's
 * and covers the file's bytes. The check is pure Node (openpgp.js): no gpg on the user's machine.
 */
export const RELEASE_KEY_FINGERPRINT = "e62d34cbf8840496931fb534580d37895466fc24";
export const RELEASE_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEasJLMRYJKwYBBAHaRw8BAQdA06VHXg6UQGAKkfEIYPCBnMmtz4CGaDlz8+hI
s1MkFw+0LlNxdW9ybGkgRGVza3RvcCBSZWxlYXNlcyA8c2lnbmluZ0BzcXVvcmxp
LmNvbT6IkwQTFgoAOxYhBOYtNMv4hASWkx+1NFgNN4lUZvwkBQJqwksxAhsDBQsJ
CAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJEFgNN4lUZvwkPm4A/1OxIBlwCX++
cmzfP+gUenNQ40ZIQaHYDqIuMwiRhe+yAP9vzLSwicXuix3REYHgtwQmWgURFoSO
ePqSXVyaqexIAA==
=0kv6
-----END PGP PUBLIC KEY BLOCK-----
`;
/** A detached signature is a few hundred bytes; anything bigger is not one. */
const SIGNATURE_MAX_BYTES = 16 * 1024;
const SIGNATURE_TIMEOUT_MS = 20_000;

export type SignatureCheck = { ok: true; fingerprint: string } | { ok: false; reason: string };

/** The address of a release file's detached signature: the file's address plus `.asc`, as the release workflow attaches it. */
export const signatureUrlOf = (fileUrl: string): string => `${fileUrl}.asc`;

/**
 * Verifies the detached, armored signature over the file's bytes against the release key (streamed: an AppImage is
 * well over 100 MB). `ok` only when the signature is good AND made by the baked-in key. Never throws.
 */
export async function verifyDetachedSignature(filePath: string, armoredSignature: string, armoredKey = RELEASE_PUBLIC_KEY): Promise<SignatureCheck> {
  try {
    const key = await openpgp.readKey({ armoredKey });
    const signature = await openpgp.readSignature({ armoredSignature });
    const message = await openpgp.createMessage({ binary: Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array> });
    const result = await openpgp.verify({ message, signature, verificationKeys: key, format: "binary" });
    // Streamed input: the verdict is only in once the data has been read to its end.
    const reader = (result.data as ReadableStream<Uint8Array>).getReader();
    while (!(await reader.read()).done) { /* drain */ }
    const first = result.signatures[0];
    if (!first) return { ok: false, reason: "no signature in the file" };
    await first.verified; // rejects when the signature does not match the bytes or the key
    const fingerprint = key.getFingerprint().toLowerCase();
    const signer = first.keyID.toHex().toLowerCase();
    if (!fingerprint.endsWith(signer)) return { ok: false, reason: `signed by another key (${signer})` };
    return { ok: true, fingerprint };
  } catch (err) {
    return { ok: false, reason: String((err as { message?: unknown })?.message ?? err).slice(0, 300) };
  }
}

/** Fetches a detached signature (small armored text); null when it cannot be had, is too big or is no signature. */
export async function fetchSignature(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(SIGNATURE_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > SIGNATURE_MAX_BYTES) return null;
    const text = await res.text();
    if (text.length > SIGNATURE_MAX_BYTES || !text.includes("-----BEGIN PGP SIGNATURE-----")) return null;
    return text;
  } catch {
    return null;
  }
}
