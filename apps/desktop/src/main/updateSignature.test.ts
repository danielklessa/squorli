import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as openpgp from "openpgp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELEASE_KEY_FINGERPRINT, RELEASE_PUBLIC_KEY, fetchSignature, signatureUrlOf, verifyDetachedSignature } from "./updateSignature";

/**
 * The signature check of a Linux update (security audit of 5 October 2026, L-3): a key made here signs a file the way the
 * release workflow does (detached, armored), and the check takes it with that key only.
 */
const dir = mkdtempSync(join(tmpdir(), "update-sig-"));
const file = join(dir, "Squorli-9.9.9-x86_64.AppImage");
const bytes = new Uint8Array(3 * 1024 * 1024 + 17);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
let signerKey: string, signerPublic: string, otherKey: string, signature: string;

beforeAll(async () => {
  writeFileSync(file, bytes);
  const a = await openpgp.generateKey({ userIDs: [{ name: "Test Releases", email: "test@example.org" }], type: "ecc", curve: "ed25519Legacy", format: "armored" });
  const b = await openpgp.generateKey({ userIDs: [{ name: "Somebody Else" }], type: "ecc", curve: "ed25519Legacy", format: "armored" });
  signerKey = a.privateKey; signerPublic = a.publicKey; otherKey = b.publicKey;
  signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: bytes }), signingKeys: await openpgp.readPrivateKey({ armoredKey: signerKey }), detached: true, format: "armored" }) as string;
}, 30_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verifyDetachedSignature", () => {
  it("takes the key's own signature over the file's bytes", async () => {
    const r = await verifyDetachedSignature(file, signature, signerPublic);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fingerprint).toBe((await openpgp.readKey({ armoredKey: signerPublic })).getFingerprint().toLowerCase());
  });
  it("refuses another key, a changed file, a damaged signature and a missing file", async () => {
    expect((await verifyDetachedSignature(file, signature, otherKey)).ok).toBe(false);
    const changed = join(dir, "changed.AppImage");
    const other = new Uint8Array(bytes); other[1234] = (other[1234] ?? 0) ^ 1;
    writeFileSync(changed, other);
    expect((await verifyDetachedSignature(changed, signature, signerPublic)).ok).toBe(false);
    expect((await verifyDetachedSignature(file, signature.replace(/A/g, "B"), signerPublic)).ok).toBe(false);
    expect((await verifyDetachedSignature(file, "not a signature", signerPublic)).ok).toBe(false);
    expect((await verifyDetachedSignature(join(dir, "missing"), signature, signerPublic)).ok).toBe(false);
  });
  it("carries the release key of the website, with its fingerprint", async () => {
    const key = await openpgp.readKey({ armoredKey: RELEASE_PUBLIC_KEY });
    expect(key.getFingerprint().toLowerCase()).toBe(RELEASE_KEY_FINGERPRINT);
    expect(key.isPrivate()).toBe(false);
    expect(key.users[0]?.userID?.userID).toBe("Squorli Desktop Releases <signing@squorli.com>");
    // The default key is the release key: a signature of the test key is refused against it.
    expect((await verifyDetachedSignature(file, signature)).ok).toBe(false);
  });
});

describe("fetchSignature", () => {
  const url = signatureUrlOf("https://github.com/danielklessa/squorli/releases/download/desktop-v9.9.9/Squorli-9.9.9-x86_64.AppImage");
  it("names the file's address plus .asc and takes a small armored signature only", async () => {
    expect(url.endsWith(".AppImage.asc")).toBe(true);
    const fake = (body: string, status = 200, length?: number) => (async () => new Response(body, { status, headers: length === undefined ? {} : { "content-length": String(length) } })) as unknown as typeof fetch;
    expect(await fetchSignature(url, fake(signature))).toBe(signature);
    expect(await fetchSignature(url, fake("<html>not found</html>", 404))).toBeNull();
    expect(await fetchSignature(url, fake("just text"))).toBeNull();
    expect(await fetchSignature(url, fake(signature, 200, 10_000_000))).toBeNull();
    expect(await fetchSignature(url, fake("x".repeat(20_000)))).toBeNull();
    expect(await fetchSignature(url, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});
