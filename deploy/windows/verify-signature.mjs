// Checks the Ed25519 signature of a file of the release (the .sha256 file of the package for Windows) against the public
// key that ships in the package: node verify-signature.mjs <public key .pem> <file> <signature file>. Exit code 0 when
// the signature is the key's, 1 when not or when a file cannot be read; one line says which. Run by squorli.ps1
// (`squorli update`) with the package's own node.exe, and by the acceptance test. Node's own modules only.
// Made in CI with: openssl pkeyutl -sign -inkey <private key> -rawin -in <file> -out <file>.sig (deploy/AGENTS.md).
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";

const [keyPath, filePath, signaturePath] = process.argv.slice(2);
if (!keyPath || !filePath || !signaturePath) {
  console.error("usage: node verify-signature.mjs <public key .pem> <file> <signature file>");
  process.exit(1);
}
let ok = false;
let why = "";
try {
  const key = createPublicKey(readFileSync(keyPath, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") why = `the key in ${keyPath} is ${key.asymmetricKeyType}, not ed25519`;
  else {
    const signature = readFileSync(signaturePath);
    if (signature.length !== 64) why = `${signaturePath} holds ${signature.length} bytes, an Ed25519 signature has 64`;
    else {
      ok = verify(null, readFileSync(filePath), key, signature);
      if (!ok) why = "the signature does not match the file and the key";
    }
  }
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
if (ok) console.log("signature ok");
else console.error(`signature invalid: ${why}`);
process.exit(ok ? 0 : 1);
