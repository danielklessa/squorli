// COPY NOTE: also exists byte-identically in the squorli-directory repo (packages/protocol/src); the source is squorli-server, copy it over after any change.
/**
 * Key backup (M6b): the private key (32-byte seed of the Ed25519 pair) is encrypted in the client with a password.
 * The directory service only sees ciphertext and an auth key that grants retrieval
 * (stored there as SHA-256 only). Isomorphic: WebCrypto in browser and Node, plus hash-wasm for Argon2id (loaded only
 * when a key is derived, so a service that merely checks parameters never loads it).
 *
 * Derivation: Argon2id(password, salt, memoryKib, iterations, parallelism) -> master (32 bytes)   (backups since 5 October 2026)
 *             PBKDF2-SHA256(password, salt, iterations)                      -> master (32 bytes)   (backups from before, still opened)
 *             HKDF-SHA256(master, info "community-backup-enc") -> AES-256-GCM key (never leaves the client)
 *             HKDF-SHA256(master, info "community-backup-auth")-> auth key (hex, sent to the service)
 * Whoever has the service's database still has to guess the password through the KDF; whoever intercepts the auth key
 * only gets the ciphertext. Argon2id (security audit of 5 October 2026, L-1): PBKDF2 is cheap on GPUs and ASICs, so a
 * weak password of a stolen database fell quickly; Argon2id needs 64 MiB of memory per guess (ARGON2_MEMORY_KIB,
 * ARGON2_ITERATIONS, ARGON2_PARALLELISM), which makes such hardware slow. A client that opens a PBKDF2 backup with the
 * password stores it anew with Argon2id where it can (the chat client after a sign-in, the account page the same).
 *
 * `context` (server accounts since 25 September 2026, security review): both infos end in "\n<context>", the host the client
 * connects to. Without it a server account's auth key equalled the directory's for the same password and salt, so a
 * malicious chat server could serve the directory's parameters for a handle and get the directory's auth key from a user
 * who reuses the password. `params.bound` records it; the client supplies the host itself, never the server.
 */
import type { BackupKdf, BackupParams } from "./directory";

/** PBKDF2 rounds of the backups from before Argon2id; the floor a service takes for a new PBKDF2 backup. */
export const BACKUP_ITERATIONS = 600_000;
/** Argon2id of a new backup: 64 MiB, 3 passes, one lane; also the floor a service takes for a new Argon2id backup. */
export const ARGON2_MEMORY_KIB = 65_536;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 1;
/** A password that signs in (the passwords from before 5 October 2026 may be this short). */
export const BACKUP_MIN_PASSWORD = 8;
/** A new or changed password (security audit of 5 October 2026, L-1): the KDF slows guessing, the length is what keeps it out of reach. */
export const BACKUP_NEW_MIN_PASSWORD = 12;

const utf8 = (s: string) => new TextEncoder().encode(s);
const subtle = () => globalThis.crypto.subtle;

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// Return type deliberately not annotated: new Uint8Array(n) is Uint8Array<ArrayBuffer>, which is what WebCrypto (BufferSource) requires.
export const hexToBytes = (h: string) => {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const base64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const randomHex = (bytes: number): string => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

export type BackupKeys = { encKey: CryptoKey; authKey: string };

/**
 * A backup a service refuses to store (400 `backup_weak`): PBKDF2 below the clients' rounds, Argon2id below the clients'
 * memory or passes. Reading an old backup is not affected: the schemas accept less, so what was stored can be opened.
 */
export function backupWeak(p: BackupKdf): boolean {
  if (p.kdf === "pbkdf2-sha256") return p.iterations < BACKUP_ITERATIONS;
  return p.memoryKib < ARGON2_MEMORY_KIB || p.iterations < ARGON2_ITERATIONS;
}

/** What the parameter routes answer: everything but the iv (which is in the blob only); `bound` goes along when set. */
export function backupParamsResponseOf(p: BackupParams): BackupKdf {
  const bound = p.bound ? { bound: true as const } : {};
  if (p.kdf === "pbkdf2-sha256") return { kdf: p.kdf, iterations: p.iterations, salt: p.salt, ...bound };
  return { kdf: p.kdf, memoryKib: p.memoryKib, iterations: p.iterations, parallelism: p.parallelism, salt: p.salt, ...bound };
}

/** The master secret of a password under the backup's KDF (32 bytes). */
async function masterOf(password: string, p: BackupKdf): Promise<Uint8Array<ArrayBuffer>> {
  const normalized = password.normalize("NFKC");
  if (p.kdf === "pbkdf2-sha256") {
    const s = subtle();
    const base = await s.importKey("raw", utf8(normalized), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await s.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(p.salt), iterations: p.iterations }, base, 256));
  }
  // Loaded on first use: the WASM is only needed where a password is turned into keys (clients), never in a service.
  const { argon2id } = await import("hash-wasm");
  const out = await argon2id({ password: utf8(normalized), salt: hexToBytes(p.salt), memorySize: p.memoryKib, iterations: p.iterations, parallelism: p.parallelism, hashLength: 32, outputType: "binary" });
  return new Uint8Array(out);
}

/** Derive both keys from the password and the backup's parameters (deliberately takes a moment: that is the KDF). */
export async function deriveBackupKeys(password: string, p: BackupKdf, context?: string): Promise<BackupKeys> {
  const s = subtle();
  const master = await masterOf(password, p);
  const hk = await s.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const suffix = context === undefined ? "" : `\n${context}`;
  const hkdf = (info: string) => s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info + suffix) }, hk, 256);
  const encKey = await s.importKey("raw", await hkdf("community-backup-enc"), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { encKey, authKey: bytesToHex(new Uint8Array(await hkdf("community-backup-auth"))) };
}

export type BackupKdfName = BackupKdf["kdf"];
/**
 * How a new backup derives its keys; the defaults are what every client sends (Argon2id, ARGON2_*). `kdf: "pbkdf2-sha256"`
 * is for a service from before Argon2id, which refuses the new parameters (`backupArgon2` in the health answers of the
 * chat server and the directory says which); tests pass smaller values.
 */
export type BackupKdfOptions = { kdf?: BackupKdfName; memoryKib?: number; iterations?: number; parallelism?: number };

/** New backup: fresh salt and IV, encrypt the seed with AES-GCM. */
export async function createBackup(password: string, privateKeyHex: string, options: BackupKdfOptions = {}, context?: string): Promise<{ params: BackupParams; ciphertext: string; authKey: string }> {
  const bound = context === undefined ? {} : { bound: true as const };
  const params: BackupParams = options.kdf === "pbkdf2-sha256"
    ? { kdf: "pbkdf2-sha256", iterations: options.iterations ?? BACKUP_ITERATIONS, salt: randomHex(16), iv: randomHex(12), ...bound }
    : { kdf: "argon2id", memoryKib: options.memoryKib ?? ARGON2_MEMORY_KIB, iterations: options.iterations ?? ARGON2_ITERATIONS, parallelism: options.parallelism ?? ARGON2_PARALLELISM, salt: randomHex(16), iv: randomHex(12), ...bound };
  const keys = await deriveBackupKeys(password, params, context);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: hexToBytes(params.iv) }, keys.encKey, hexToBytes(privateKeyHex));
  return { params, ciphertext: bytesToBase64(new Uint8Array(ct)), authKey: keys.authKey };
}

/** Open a backup; throws on a wrong key (the AES-GCM tag does not match). Returns the seed as hex. */
export async function openBackup(keys: BackupKeys, ivHex: string, ciphertext: string): Promise<string> {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: hexToBytes(ivHex) }, keys.encKey, base64ToBytes(ciphertext));
  return bytesToHex(new Uint8Array(pt));
}
