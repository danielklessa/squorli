/**
 * Identity = Ed25519 key pair, generated in the browser. Stored in localStorage (browser) or, in the desktop app, encrypted
 * by the operating system (`safeStorage`, 25 September 2026: `setSecretStore`, moved over from localStorage at the first
 * read). A browser page has no such store: there the key stays unencrypted in localStorage. No mnemonic recovery code (user's decision,
 * 25 September 2026): the password-encrypted key backup at the directory and
 * server accounts replace it.
 *
 * Devices (29 September 2026, docs/features/devices.md): next to the account's key every installation has a device key of
 * its own per account (deviceKey.ts). The identity's entry names it (`device`) and says where its private half is kept;
 * whatever the account's key signs, the device signs too (`signBoth`), and the directory or the chat server lets only
 * devices in that were enrolled with the password. A device that was signed out loses the account's key (store.ts).
 *
 * The seed out of the page's reach (4 October 2026, security audit C1, docs/features/desktop.md): where the platform has a
 * key vault (the desktop app's main process), the page never holds a seed. An identity with `privateKey` null names a key
 * the vault holds; signing, the pair keys of direct messages, the settings key and the password backup go through it
 * (`sign`, `dmKeyOf`, `settingsKeyOf`, `backupOf`). A script that gets into the page can still use the key while the app
 * runs, but cannot take it along. In a browser `privateKey` is the seed as before.
 */
import * as ed from "@noble/ed25519";
import { createBackup, deriveDmKey, deriveSettingsKey, deviceEnrolMessage, deviceProofMessage, hexToBytes, importDmKey, importSettingsKey, type BackupKdfName, type BackupParams } from "@squorli/protocol";
import { createDevice, forgetDevice, loadDevice, parseStoredDevice, type DeviceSigner, type DeviceVault, type StoredDevice } from "./deviceKey";
import { t } from "./i18n";
import type { BridgeKeys } from "./platform/bridge";

const KEY = "chat.identity.v1";
/** The storage key of the main identity: tabs of one browser share it (store.ts follows a change made in another tab). */
export const IDENTITY_STORAGE_KEY = KEY;

/** The sessions per server (store.ts) and the server accounts (below): the secrets besides the identity, named here so that a browser's store seals all of them at start. */
export const SESSIONS_STORAGE_KEY = "chat.sessions.v2";
const SERVER_ACCOUNTS = "chat.serverAccounts.v1";
export const SECRET_STORAGE_KEYS: readonly string[] = [KEY, SESSIONS_STORAGE_KEY, SERVER_ACCOUNTS];

/**
 * `refresh`: a store that keeps its values in memory (the browser's sealed store, browserSecrets.ts) reads the entry again
 * after another tab wrote it; the platform's store (desktop app) has none, its reads are always current.
 */
type SecretStore = { get(key: string): string | null; set(key: string, value: string | null): boolean; refresh?(key: string): Promise<void> };
let secretStore: SecretStore | null = null;
/** Where the platform keeps secrets encrypted (platform.secretStore) or the browser seals them; null = localStorage. Set once at start (main.tsx). */
export function setSecretStore(store: SecretStore | null) { secretStore = store; }
/** Before a read that must see another tab's write (store.ts follows a sign-out or a new sign-in made elsewhere). */
export async function refreshSecret(key: string): Promise<void> { await secretStore?.refresh?.(key); }

/** The platform's key vault (platform.keyVault); null = the page holds its seeds. Set once at start (main.tsx). */
export type KeyVault = BridgeKeys;
let keyVault: KeyVault | null = null;
export function setKeyVault(vault: KeyVault | null) { keyVault = vault; }
/** A key the vault no longer answers for: the user signs in anew. */
const keyGone = () => new Error(t("err.keyGone"));

/**
 * Read a secret. With a secret store, a value still in localStorage (an app from before, or the browser storage of this
 * origin) is moved over: written there, read back, and only then removed from localStorage. What comes back is what the
 * store holds now: a store with a key vault takes the seeds out of an entry on the way (the desktop shell's secrets.ts).
 */
export function readSecret(key: string): string | null {
  if (!secretStore) return localStorage.getItem(key);
  const stored = secretStore.get(key);
  if (stored !== null) return stored;
  const legacy = localStorage.getItem(key);
  if (legacy === null || !secretStore.set(key, legacy)) return legacy;
  const moved = secretStore.get(key);
  if (moved === null) return legacy;
  localStorage.removeItem(key);
  return moved;
}
export function writeSecret(key: string, value: string | null) {
  if (secretStore && secretStore.set(key, value)) { localStorage.removeItem(key); return; }
  if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
}

/**
 * `privateKey`: the seed (hex), or null where the platform's key vault holds it (then the entry never carried one).
 * `device`: this installation's device key for the account (deviceKey.ts); missing on an entry from before devices.
 */
export type Identity = { publicKey: string; privateKey: string | null; device?: StoredDevice | null };

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
/** An entry as it was stored: the public key, the seed where the page holds it, and the device if the entry names one this version can read. */
const readIdentity = (raw: { publicKey: string; privateKey?: unknown; device?: unknown }): Identity => ({ publicKey: raw.publicKey, privateKey: typeof raw.privateKey === "string" ? raw.privateKey : null, device: parseStoredDevice(raw.device) });

export async function loadOrCreateIdentity(): Promise<Identity> {
  const raw = readSecret(KEY);
  if (raw) return readIdentity(JSON.parse(raw) as Identity);
  const id: Identity = { ...(await newIdentity()), device: null };
  writeSecret(KEY, JSON.stringify(id));
  return id;
}
/** The main identity as it is stored right now (another tab may have replaced or removed it); null = none. */
export function storedIdentity(): Identity | null {
  try { const raw = readSecret(KEY); return raw ? readIdentity(JSON.parse(raw) as Identity) : null; } catch { return null; }
}

/** Forget the main identity, and its seed where the vault holds it. */
export function forgetIdentity() {
  forgetKey(storedIdentity());
  writeSecret(KEY, null);
}
/** The vault lets a key go (a sign-out, a replaced identity, a server account that was dropped). Nothing where the page holds the seed. */
export function forgetKey(id: Identity | null | undefined) {
  if (id && id.privateKey === null && keyVault) void keyVault.forget(id.publicKey).catch(() => {});
}

/** M6b: identity from a recovered seed (sign-in with handle + password). With a vault the seed goes there and the page keeps only the public half. */
export async function identityFromPrivateKey(privateKeyHex: string): Promise<Identity> {
  if (keyVault) {
    const publicKey = await keyVault.import(privateKeyHex);
    if (!publicKey) throw keyGone();
    return { publicKey, privateKey: null, device: null };
  }
  const pub = await ed.getPublicKeyAsync(fromHex(privateKeyHex));
  return { publicKey: toHex(pub), privateKey: privateKeyHex, device: null };
}

/** Replace the device key (after a recovery). */
export function storeIdentity(id: Identity) {
  writeSecret(KEY, JSON.stringify(id));
}

export async function sign(id: Identity, message: string): Promise<string> {
  if (id.privateKey === null) {
    const signature = keyVault ? await keyVault.sign(id.publicKey, message) : null;
    if (!signature) throw keyGone();
    return signature;
  }
  const sig = await ed.signAsync(new TextEncoder().encode(message), fromHex(id.privateKey));
  return toHex(sig);
}
/** The pair key of direct messages with `peer` (the protocol's dm.ts); from the vault where it holds the seed. */
export async function dmKeyOf(id: Identity, peer: string): Promise<CryptoKey> {
  if (id.privateKey !== null) return deriveDmKey(id.privateKey, id.publicKey, peer);
  const bits = keyVault ? await keyVault.dmKey(id.publicKey, peer) : null;
  if (!bits) throw keyGone();
  return importDmKey(hexToBytes(bits));
}
/** The key of the account's sealed settings (the protocol's directory.ts); from the vault where it holds the seed. */
export async function settingsKeyOf(id: Identity): Promise<CryptoKey> {
  if (id.privateKey !== null) return deriveSettingsKey(id.privateKey, id.publicKey);
  const bits = keyVault ? await keyVault.settingsKey(id.publicKey) : null;
  if (!bits) throw keyGone();
  return importSettingsKey(hexToBytes(bits));
}
/**
 * The seed encrypted with a password (the protocol's backup.ts; `context` binds a server account's backup to its host);
 * made by the vault where it holds the seed. `kdf`: Argon2id, or PBKDF2 for a server or directory from before 5 October
 * 2026, which would refuse the new parameters (`ServerApi.backupKdf`, the directory's `features.backupArgon2`).
 */
export async function backupOf(id: Identity, password: string, context?: string, kdf: BackupKdfName = "argon2id"): Promise<{ params: BackupParams; ciphertext: string; authKey: string }> {
  if (id.privateKey !== null) return createBackup(password, id.privateKey, { kdf }, context);
  const backup = keyVault ? await keyVault.backup(id.publicKey, password, context, kdf) : null;
  if (!backup) throw keyGone();
  return backup;
}

// ---------- Devices (docs/features/devices.md): the signers of the device keys this installation holds, by the device's
// public key. A stored device is loaded once at start (`loadDeviceOf`); a new one is made where a device is enrolled.
let vault: DeviceVault | null = null;
/** Where key pairs that cannot be read out are kept (IndexedDB in a browser and in the desktop app; main.tsx). null = nowhere: ordinary keys. */
export function setDeviceVault(v: DeviceVault | null) { vault = v; }
const signers = new Map<string, DeviceSigner>();
/** A device that is not enrolled yet, made for one attempt to sign in. */
export type NewDevice = { stored: StoredDevice; signer: DeviceSigner };

/** The signer of the identity's device; null when it has none, or its key pair is gone (the browser's data was cleared). */
export const deviceSignerOf = (id: Identity): DeviceSigner | null => (id.device ? signers.get(id.device.publicKey) ?? null : null);
/** Bring a stored device's signer into memory (once at start, for the main identity and every server account). */
export async function loadDeviceOf(id: Identity): Promise<boolean> {
  if (!id.device) return false;
  if (signers.has(id.device.publicKey)) return true;
  const signer = await loadDevice(vault, id.device);
  if (signer) signers.set(signer.publicKey, signer);
  return !!signer;
}
/** A new device key, kept on this installation; the caller enrols it and stores it with the identity (`device: made.stored`). */
export async function newDevice(): Promise<NewDevice> {
  const made = await createDevice(vault, true);
  signers.set(made.signer.publicKey, made.signer);
  // `persist` always answers a stored form.
  return { stored: made.stored!, signer: made.signer };
}
/** Forget a device on this installation: its signer and, where it lies in the vault, its key pair. */
export async function dropDevice(device: StoredDevice | null | undefined): Promise<void> {
  if (!device) return;
  signers.delete(device.publicKey);
  await forgetDevice(vault, device);
}
/**
 * What a signed request carries: the account's signature over `message` and the device's proof over the same message
 * (`deviceProofMessage`). Without a device (an entry from before devices whose device could not be made, or whose key
 * pair is gone) only the signature: an account that lets only enrolled devices in then refuses, and the user signs in anew.
 */
export async function signBoth(id: Identity, message: string): Promise<{ signature: string; deviceKey?: string; deviceSignature?: string }> {
  const signature = await sign(id, message);
  const signer = deviceSignerOf(id);
  return signer ? { signature, deviceKey: signer.publicKey, deviceSignature: await signer.sign(deviceProofMessage(id.publicKey, message)) } : { signature };
}
/** What enrols `device` where the password is proven (a key fetch has no challenge): the device proves that it holds its key. */
export async function enrolFields(device: NewDevice, host: string, handle: string): Promise<{ deviceKey: string; deviceSignature: string }> {
  return { deviceKey: device.signer.publicKey, deviceSignature: await device.signer.sign(deviceEnrolMessage(host, handle, device.signer.publicKey)) };
}

// ---------- Server accounts (`~name`, docs/features/local-accounts.md): one key of its own per server, next to the main identity
// above (the directory account's key, or this device's). The session token of such a server lives here too, so switching the
// main identity (another directory account) never touches them.

export type ServerAccount = Identity & { localHandle: string; token: string | null };

export function loadServerAccounts(): Record<string, ServerAccount> {
  try {
    const raw = readSecret(SERVER_ACCOUNTS);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, ServerAccount>;
    return Object.fromEntries(Object.entries(all).map(([host, a]) => [host, { ...a, device: parseStoredDevice(a.device) }]));
  } catch { return {}; }
}
function saveServerAccounts(all: Record<string, ServerAccount>) {
  try { writeSecret(SERVER_ACCOUNTS, JSON.stringify(all)); } catch { /* no storage: the account lasts this page */ }
}
export function storeServerAccount(host: string, account: ServerAccount) { saveServerAccounts({ ...loadServerAccounts(), [host]: account }); }
/** Forget a server account, and its seed where the vault holds it. */
export function forgetServerAccount(host: string) { const all = loadServerAccounts(); forgetKey(all[host]); delete all[host]; saveServerAccounts(all); }

/** A fresh key pair that is not stored anywhere yet (a new server account, the first identity); made by the vault where there is one. */
export async function newIdentity(): Promise<Identity> {
  if (keyVault) {
    const publicKey = await keyVault.generate();
    if (!publicKey) throw keyGone();
    return { publicKey, privateKey: null, device: null };
  }
  const priv = ed.utils.randomSecretKey();
  return { publicKey: toHex(await ed.getPublicKeyAsync(priv)), privateKey: toHex(priv), device: null };
}
