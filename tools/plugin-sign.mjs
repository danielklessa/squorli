#!/usr/bin/env node
/**
 * Signs a plugin file with Squorli's plugin key, or checks a signed one (docs/features/plugins.md).
 *
 *   node tools/plugin-sign.mjs sign <file> --key <private.pem> --key-id <id> --kind official|reviewed [--out <file>]
 *   node tools/plugin-sign.mjs verify <file> --pub <public.pem>
 *   node tools/plugin-sign.mjs hash <file>
 *
 * `sign` writes the file with the signature comment as its last line (a signature that is there already is replaced);
 * `verify` ends with exit code 0 or 1 and prints the kind and the hash; `hash` prints what a revocation names.
 *
 * Only Node's own modules, so the signing workflow of the repository squorli-plugins runs it without an install. It is the
 * writing half of `apps/server/src/plugins/signature.ts`: the form the file is hashed in and the signed text are the same
 * there, and `signature.test.ts` of the server signs with this file and verifies with that one.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SIGNATURE_MARK = "/* squorli-signature ";
const PREFIX = "squorli-plugin-signature-v1";
const KINDS = ["official", "reviewed"];
const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 13;

/** The file without a signature comment at its end. */
export function bodyOf(source) {
  const at = source.lastIndexOf(SIGNATURE_MARK);
  if (at < 0) return source;
  let end = source.length;
  while (end > at && isSpace(source.charCodeAt(end - 1))) end--;
  const tail = source.slice(at, end);
  const close = tail.indexOf("*/");
  return close >= 0 && close + 2 === tail.length ? source.slice(0, at) : source;
}

export function canonicalBody(body) {
  let text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  text = text.replaceAll("\r\n", "\n");
  let end = text.length;
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

export const bodyHash = (body) => createHash("sha256").update(canonicalBody(body), "utf8").digest("hex");
const message = (kind, hash) => Buffer.from(`${PREFIX}\n${kind}\n${hash}`, "utf8");

/** The signed file: the canonical body, a blank line, the signature comment. `privateKey` = PEM text or a KeyObject. */
export function signSource(source, privateKey, keyId, kind) {
  if (!KINDS.includes(kind)) throw new Error(`kind is one of ${KINDS.join(", ")}`);
  if (!/^[a-z0-9-]{1,32}$/.test(keyId)) throw new Error("a key id has 1 to 32 characters of a-z, 0-9 and -");
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the plugin key is an Ed25519 key");
  const body = canonicalBody(bodyOf(source));
  const sig = sign(null, message(kind, bodyHash(body)), key).toString("base64");
  return `${body}\n\n${SIGNATURE_MARK}${JSON.stringify({ v: 1, key: keyId, kind, sig })} */\n`;
}

/** `{ ok, kind?, keyId?, hash, reason? }` for a signed file and a public key (PEM text or a KeyObject). */
export function verifySource(source, publicKey) {
  const body = bodyOf(source);
  const hash = bodyHash(body);
  if (body === source) return { ok: false, hash, reason: "the file carries no signature" };
  let parsed;
  try { parsed = JSON.parse(source.slice(body.length + SIGNATURE_MARK.length, source.lastIndexOf("*/"))); } catch { return { ok: false, hash, reason: "the signature comment cannot be read" }; }
  if (!parsed || parsed.v !== 1 || !KINDS.includes(parsed.kind) || typeof parsed.sig !== "string" || typeof parsed.key !== "string") return { ok: false, hash, reason: "the signature comment cannot be read" };
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  const ok = verify(null, message(parsed.kind, hash), key, Buffer.from(parsed.sig, "base64"));
  return ok ? { ok: true, hash, kind: parsed.kind, keyId: parsed.key } : { ok: false, hash, reason: "the signature does not fit the file" };
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(argv) {
  const [command, file, ...rest] = argv;
  if (!file || !["sign", "verify", "hash"].includes(command)) {
    console.error("usage: plugin-sign.mjs sign <file> --key <private.pem> --key-id <id> --kind official|reviewed [--out <file>]\n       plugin-sign.mjs verify <file> --pub <public.pem>\n       plugin-sign.mjs hash <file>");
    return 2;
  }
  const source = readFileSync(file, "utf8");
  if (command === "hash") { console.log(bodyHash(bodyOf(source))); return 0; }
  if (command === "sign") {
    const keyFile = option(rest, "--key"), keyId = option(rest, "--key-id"), kind = option(rest, "--kind");
    if (!keyFile || !keyId || !kind) { console.error("sign needs --key, --key-id and --kind"); return 2; }
    const signed = signSource(source, readFileSync(keyFile, "utf8"), keyId, kind);
    writeFileSync(option(rest, "--out") ?? file, signed);
    console.log(`signed as ${kind} with key ${keyId}, sha256 ${bodyHash(bodyOf(signed))}`);
    return 0;
  }
  const pub = option(rest, "--pub");
  if (!pub) { console.error("verify needs --pub"); return 2; }
  const r = verifySource(source, readFileSync(pub, "utf8"));
  if (r.ok) { console.log(`valid: ${r.kind}, key ${r.keyId}, sha256 ${r.hash}`); return 0; }
  console.error(`NOT valid: ${r.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
