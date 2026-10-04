import { createPrivateKey, createPublicKey, randomBytes, sign as nodeSign } from "node:crypto";
import { BACKUP_MIN_PASSWORD, DirectoryAction, createBackup, deriveDmKeyBits, deriveSettingsKeyBits } from "@squorli/protocol";
import { KEYED_SECRETS, type BridgeBackup } from "@squorli/web/platform/bridge";

/**
 * The key vault (4 October 2026, security audit C1, measure 3.3; docs/features/desktop.md): the seeds of the account keys
 * (the identity's, the server accounts') stay in the main process. The page names a key by its public half and gets
 * signatures over the protocol's known message formats, the derived keys of direct messages and of the sealed settings
 * (as bytes it imports into keys it cannot read out) and the password backup of the seed; it never gets a seed. A script
 * that gets into the page can use the keys while the app runs, but cannot take them along.
 *
 * Pure: no Electron import (tested). `KeyVault` keeps the seeds in whatever storage it is given (secrets.ts: one entry of
 * the encrypted store, `KEY_VAULT_ENTRY`). Ed25519 through Node's crypto (the same curve as the client's @noble/ed25519;
 * the test checks a vector of RFC 8032), the derivations are the protocol's own functions, so page and shell agree.
 */

/** The seeds by public key, as stored. */
export type VaultKeys = Record<string, string>;
export type VaultStorage = { read(): VaultKeys; write(keys: VaultKeys): boolean };

const HEX32 = /^[0-9a-f]{64}$/;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MESSAGE_MAX = 256_000;
const PASSWORD_MAX = 1024;
const CONTEXT_MAX = 253;

const privateKeyOf = (seedHex: string) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
/** The public half (hex) of a seed. */
export function publicKeyOfSeed(seedHex: string): string {
  const spki = createPublicKey(privateKeyOf(seedHex)).export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("hex");
}
/** The DER form of a public key, for `crypto.verify` in tests and checks. */
export const spkiOf = (publicKeyHex: string): Buffer => Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]);

/**
 * The first line of every message the account's key signs in the protocol: the chat login (`chatLoginMessage`,
 * `challengeMessage`), the directory's registration, backup, socket and actions, the server accounts' registration and
 * claim. What a device key signs (`squorli-device…`, the session proof) is not here: the page holds those keys itself.
 */
const SIGNABLE_FIRST_LINES = new Set<string>([
  "community-chat-login", "community-directory-register", "community-directory-backup", "community-directory-ws",
  "squorli-local-register", "squorli-local-claim",
  ...DirectoryAction.options.map((action) => `community-directory-${action}`),
]);
/** Whether the vault signs a message: one of the known formats, not too long. */
export function isSignable(message: unknown): message is string {
  if (typeof message !== "string" || message.length > MESSAGE_MAX) return false;
  const nl = message.indexOf("\n");
  return nl > 0 && SIGNABLE_FIRST_LINES.has(message.slice(0, nl));
}
const isPublicKey = (value: unknown): value is string => typeof value === "string" && HEX32.test(value);

export class KeyVault {
  private keys: VaultKeys;
  constructor(private readonly storage: VaultStorage) {
    const read = storage.read();
    this.keys = Object.fromEntries(Object.entries(read).filter(([k, v]) => HEX32.test(k) && HEX32.test(v)));
  }
  /** The public keys the vault holds. */
  list(): string[] { return Object.keys(this.keys); }
  has(publicKey: unknown): boolean { return isPublicKey(publicKey) && publicKey in this.keys; }
  private save(next: VaultKeys): boolean {
    if (!this.storage.write(next)) return false;
    this.keys = next;
    return true;
  }
  /** A fresh key; its public half, or null when the storage refused. */
  generate(): string | null { return this.import(randomBytes(32).toString("hex")); }
  /** Take a seed in (the page recovered it from a backup); its public half, or null for a seed that is no seed or a storage that refused. */
  import(seed: unknown): string | null {
    if (typeof seed !== "string" || !HEX32.test(seed)) return null;
    const publicKey = publicKeyOfSeed(seed);
    if (this.keys[publicKey] === seed) return publicKey;
    return this.save({ ...this.keys, [publicKey]: seed }) ? publicKey : null;
  }
  /** Take a seed in only when it belongs to `publicKey` (an entry of the page named both). */
  importFor(publicKey: string, seed: string): boolean {
    return HEX32.test(seed) && publicKeyOfSeed(seed) === publicKey && this.import(seed) === publicKey;
  }
  forget(publicKey: unknown): void {
    if (!this.has(publicKey)) return;
    const { [publicKey as string]: _gone, ...rest } = this.keys;
    this.save(rest);
  }
  /** Keep only the keys the page's entries name (at a start, before the page runs: a key nothing names is nobody's). */
  prune(named: Iterable<string>): string[] {
    const keep = new Set(named);
    const gone = this.list().filter((k) => !keep.has(k));
    if (gone.length) this.save(Object.fromEntries(Object.entries(this.keys).filter(([k]) => keep.has(k))));
    return gone;
  }
  /** The signature (hex) of a known message format; null for an unknown key or any other message. */
  sign(publicKey: unknown, message: unknown): string | null {
    if (!this.has(publicKey) || !isSignable(message)) return null;
    return nodeSign(null, Buffer.from(message, "utf8"), privateKeyOf(this.keys[publicKey as string]!)).toString("hex");
  }
  /** The pair key of direct messages with `peer`, as hex bytes; the page imports them. */
  async dmKey(publicKey: unknown, peer: unknown): Promise<string | null> {
    if (!this.has(publicKey) || !isPublicKey(peer)) return null;
    return Buffer.from(await deriveDmKeyBits(this.keys[publicKey as string]!, publicKey as string, peer)).toString("hex");
  }
  /** The key of the account's sealed settings, as hex bytes. */
  async settingsKey(publicKey: unknown): Promise<string | null> {
    if (!this.has(publicKey)) return null;
    return Buffer.from(await deriveSettingsKeyBits(this.keys[publicKey as string]!, publicKey as string)).toString("hex");
  }
  /** The seed encrypted with a password (the protocol's backup; `context` binds a server account's backup to its host). */
  async backup(publicKey: unknown, password: unknown, context: unknown): Promise<BridgeBackup | null> {
    if (!this.has(publicKey) || typeof password !== "string" || password.length < BACKUP_MIN_PASSWORD || password.length > PASSWORD_MAX) return null;
    if (context !== undefined && (typeof context !== "string" || context.length === 0 || context.length > CONTEXT_MAX)) return null;
    return createBackup(password, this.keys[publicKey as string]!, undefined, context);
  }
}

/**
 * An entry of the page's secrets without its seeds: the identity's `privateKey` and every server account's go into the
 * vault, the entry keeps the public halves (the client reads a missing seed as "the vault's"). An entry whose seed does not
 * belong to its public key is left as it is (the page keeps what it had); anything but the two keyed entries, or what is
 * not JSON, passes through unchanged.
 */
export function takeSeeds(vault: KeyVault, entry: string, json: string): string {
  if (!(KEYED_SECRETS as readonly string[]).includes(entry)) return json;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return json; }
  const strip = (o: unknown): boolean => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    if (typeof r.privateKey !== "string" || !isPublicKey(r.publicKey) || !vault.importFor(r.publicKey, r.privateKey)) return false;
    delete r.privateKey;
    return true;
  };
  let changed = false;
  if (entry === "chat.identity.v1") changed = strip(parsed);
  else if (parsed && typeof parsed === "object") for (const account of Object.values(parsed as Record<string, unknown>)) changed = strip(account) || changed;
  return changed ? JSON.stringify(parsed) : json;
}

/** The public keys an entry of the page names (the identity's, each server account's), for `prune`. */
export function namedKeys(entry: string, json: string | null): string[] {
  if (json === null || !(KEYED_SECRETS as readonly string[]).includes(entry)) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const keyOf = (o: unknown): string[] => (o && typeof o === "object" && isPublicKey((o as { publicKey?: unknown }).publicKey) ? [(o as { publicKey: string }).publicKey] : []);
  if (entry === "chat.identity.v1") return keyOf(parsed);
  return parsed && typeof parsed === "object" ? Object.values(parsed as Record<string, unknown>).flatMap(keyOf) : [];
}
