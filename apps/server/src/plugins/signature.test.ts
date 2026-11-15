import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SIGNATURE_MARK, bodyHash, canonicalBody, signingKeyFromPem, splitSignature, verifyPluginSignature, type SigningKey } from "./signature";
import { PLUGIN_SIGNING_KEYS, REVOKED_PLUGIN_HASHES } from "./signingKeys";

/**
 * The server's reading of a plugin's signature against the tool that writes one (`tools/plugin-sign.mjs`, plain JavaScript
 * for the signing workflow): the two share no code, so every test here signs with the tool and verifies with the server.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
type Tool = {
  signSource(source: string, privateKey: string, keyId: string, kind: string): string;
  verifySource(source: string, publicKey: string): { ok: boolean; hash: string; kind?: string; keyId?: string; reason?: string };
  bodyHash(body: string): string;
  bodyOf(source: string): string;
};
const tool = (await import(pathToFileURL(join(root, "tools", "plugin-sign.mjs")).href)) as Tool;

function keyPair(id: string): { privatePem: string; publicPem: string; key: SigningKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
  return { privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) as string, publicPem, key: signingKeyFromPem(id, publicPem) };
}

const PLUGIN = `/* squorli-plugin\n{ "id": "probe", "name": "Probe", "description": "A probe.", "version": "1.0.0", "apiVersion": 1 }\n*/\nsquorli.on("enable", () => {});\n`;
const a = keyPair("test-a"), b = keyPair("test-b");

describe("a plugin's signature", () => {
  it("is valid as the tool wrote it, with the kind it was signed as", () => {
    for (const kind of ["official", "reviewed"] as const) {
      const signed = tool.signSource(PLUGIN, a.privatePem, "test-a", kind);
      const check = verifyPluginSignature(signed, [a.key]);
      expect(check).toMatchObject({ status: "valid", keyId: "test-a", kind });
      expect(check.hash).toBe(bodyHash(PLUGIN));
      expect(tool.verifySource(signed, a.publicPem)).toMatchObject({ ok: true, kind, hash: check.hash });
    }
  });

  it("is none for a file without the comment, and the mark inside the text is no signature", () => {
    expect(verifyPluginSignature(PLUGIN, [a.key]).status).toBe("none");
    const inside = `${PLUGIN}const note = "${SIGNATURE_MARK}{} */";\nsquorli.on("disable", () => {});\n`;
    expect(splitSignature(inside)).toMatchObject({ signature: null, malformed: false, body: inside });
    expect(verifyPluginSignature(inside, [a.key]).status).toBe("none");
  });

  it("does not hold for a file changed after it was signed", () => {
    const signed = tool.signSource(PLUGIN, a.privatePem, "test-a", "reviewed");
    const changed = signed.replace("A probe.", "A probe!");
    expect(changed).not.toBe(signed);
    expect(verifyPluginSignature(changed, [a.key]).status).toBe("invalid");
    // One more capability in the manifest is a changed file like any other.
    expect(verifyPluginSignature(signed.replace('"apiVersion": 1', '"apiVersion": 1, "capabilities": ["members.read"]'), [a.key]).status).toBe("invalid");
  });

  it("does not hold when the kind in the comment was rewritten", () => {
    const signed = tool.signSource(PLUGIN, a.privatePem, "test-a", "reviewed");
    expect(verifyPluginSignature(signed.replace('"kind":"reviewed"', '"kind":"official"'), [a.key]).status).toBe("invalid");
  });

  it("does not hold for a key this server does not trust, or the wrong key under a trusted name", () => {
    const signed = tool.signSource(PLUGIN, b.privatePem, "test-b", "official");
    expect(verifyPluginSignature(signed, [a.key])).toMatchObject({ status: "invalid" });
    expect(verifyPluginSignature(signed, [])).toMatchObject({ status: "invalid" });
    const posing = tool.signSource(PLUGIN, b.privatePem, "test-a", "official");
    expect(verifyPluginSignature(posing, [a.key]).status).toBe("invalid");
    expect(verifyPluginSignature(signed, [a.key, b.key]).status).toBe("valid");
  });

  it("survives line ends turned around, a byte order mark and blank lines at the end", () => {
    const signed = tool.signSource(PLUGIN, a.privatePem, "test-a", "official");
    expect(verifyPluginSignature(signed.replaceAll("\n", "\r\n"), [a.key]).status).toBe("valid");
    expect(verifyPluginSignature(`﻿${signed}`, [a.key]).status).toBe("valid");
    expect(verifyPluginSignature(`${signed}\n\n  \n`, [a.key]).status).toBe("valid");
    expect(canonicalBody("﻿a\r\nb\r\n\r\n")).toBe("a\nb");
    // Signing a file that came with Windows line ends gives the same signature as signing it with Unix ones.
    expect(tool.signSource(PLUGIN.replaceAll("\n", "\r\n"), a.privatePem, "test-a", "official")).toBe(signed);
  });

  it("is replaced, not doubled, when a signed file is signed again", () => {
    const once = tool.signSource(PLUGIN, a.privatePem, "test-a", "reviewed");
    const twice = tool.signSource(once, b.privatePem, "test-b", "official");
    expect(twice.split(SIGNATURE_MARK).length).toBe(2);
    expect(verifyPluginSignature(twice, [a.key, b.key])).toMatchObject({ status: "valid", keyId: "test-b", kind: "official" });
  });

  it("refuses a comment at the end that starts like a signature and is none", () => {
    for (const tail of ["{", '{"v":1}', '{"v":2,"key":"test-a","kind":"official","sig":"x"}', '{"v":1,"key":"test-a","kind":"mine","sig":"' + "A".repeat(86) + '=="}', `{"pad":"${"x".repeat(500)}"}`]) {
      const check = verifyPluginSignature(`${PLUGIN}\n${SIGNATURE_MARK}${tail} */\n`, [a.key]);
      expect(check.status, tail.slice(0, 40)).toBe("invalid");
    }
  });

  it("is revoked when its hash stands in the list, and only then", () => {
    const signed = tool.signSource(PLUGIN, a.privatePem, "test-a", "reviewed");
    const hash = bodyHash(PLUGIN);
    expect(tool.bodyHash(tool.bodyOf(signed))).toBe(hash);
    expect(verifyPluginSignature(signed, [a.key], [hash])).toMatchObject({ status: "revoked", keyId: "test-a" });
    expect(verifyPluginSignature(signed, [a.key], ["0".repeat(64)]).status).toBe("valid");
    // An unsigned copy of a revoked file is just an unsigned file.
    expect(verifyPluginSignature(PLUGIN, [a.key], [hash]).status).toBe("none");
  });

  it("reads a large file in linear time", () => {
    const big = `${PLUGIN}${`// ${SIGNATURE_MARK}\n`.repeat(8000)}`;
    const t0 = performance.now();
    expect(verifyPluginSignature(big, [a.key]).status).toBe("none");
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("the keys this server trusts", () => {
  it("are 32 bytes each under distinct names, and the newest is the PEM file of the repository", () => {
    expect(new Set(PLUGIN_SIGNING_KEYS.map((k) => k.id)).size).toBe(PLUGIN_SIGNING_KEYS.length);
    for (const k of PLUGIN_SIGNING_KEYS) {
      expect(k.id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(Buffer.from(k.publicKey, "base64").length).toBe(32);
    }
    const pemFile = join(root, "tools", "squorli-plugins.pub");
    expect(existsSync(pemFile)).toBe(PLUGIN_SIGNING_KEYS.length > 0);
    if (PLUGIN_SIGNING_KEYS.length > 0) expect(signingKeyFromPem("x", readFileSync(pemFile, "utf8")).publicKey).toBe(PLUGIN_SIGNING_KEYS.at(-1)!.publicKey);
  });

  it("revocations are SHA-256 values in lower-case hex", () => {
    for (const h of REVOKED_PLUGIN_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
