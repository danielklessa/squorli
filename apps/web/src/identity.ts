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
 */
import * as ed from "@noble/ed25519";
import { deviceEnrolMessage, deviceProofMessage } from "@squorli/protocol";
import { createDevice, forgetDevice, loadDevice, parseStoredDevice, type DeviceSigner, type DeviceVault, type StoredDevice } from "./deviceKey";

const KEY = "chat.identity.v1";
/** The storage key of the main identity: tabs of one browser share it (store.ts follows a change made in another tab). */
export const IDENTITY_STORAGE_KEY = KEY;

type SecretStore = { get(key: string): string | null; set(key: string, value: string | null): boolean };
let secretStore: SecretStore | null = null;
/** Where the platform keeps secrets encrypted (platform.secretStore); null = localStorage. Set once at start (main.tsx). */
export function setSecretStore(store: SecretStore | null) { secretStore = store; }

/**
 * Read a secret. With a secret store, a value still in localStorage (an app from before, or the browser storage of this
 * origin) is moved over: written there, read back, and only then removed from localStorage.
 */
function readSecret(key: string): string | null {
  if (!secretStore) return localStorage.getItem(key);
  const stored = secretStore.get(key);
  if (stored !== null) return stored;
  const legacy = localStorage.getItem(key);
  if (legacy !== null && secretStore.set(key, legacy) && secretStore.get(key) === legacy) localStorage.removeItem(key);
  return legacy;
}
function writeSecret(key: string, value: string | null) {
  if (secretStore && secretStore.set(key, value)) { localStorage.removeItem(key); return; }
  if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
}

/** `device`: this installation's device key for the account (deviceKey.ts); missing on an entry from before devices. */
export type Identity = { publicKey: string; privateKey: string; device?: StoredDevice | null };

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
/** An entry as it was stored: the two keys, and the device if the entry names one this version can read. */
const readIdentity = (raw: { publicKey: string; privateKey: string; device?: unknown }): Identity => ({ publicKey: raw.publicKey, privateKey: raw.privateKey, device: parseStoredDevice(raw.device) });

export async function loadOrCreateIdentity(): Promise<Identity> {
  const raw = readSecret(KEY);
  if (raw) return readIdentity(JSON.parse(raw) as Identity);
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const id: Identity = { publicKey: toHex(pub), privateKey: toHex(priv), device: null };
  writeSecret(KEY, JSON.stringify(id));
  return id;
}
/** The main identity as it is stored right now (another tab may have replaced or removed it); null = none. */
export function storedIdentity(): Identity | null {
  try { const raw = readSecret(KEY); return raw ? readIdentity(JSON.parse(raw) as Identity) : null; } catch { return null; }
}

export function forgetIdentity() {
  writeSecret(KEY, null);
}

/** M6b: identity from a recovered seed (sign-in with handle + password). */
export async function identityFromPrivateKey(privateKeyHex: string): Promise<Identity> {
  const pub = await ed.getPublicKeyAsync(fromHex(privateKeyHex));
  return { publicKey: toHex(pub), privateKey: privateKeyHex, device: null };
}

/** Replace the device key (after a recovery). */
export function storeIdentity(id: Identity) {
  writeSecret(KEY, JSON.stringify(id));
}

export async function sign(id: Identity, message: string): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(message), fromHex(id.privateKey));
  return toHex(sig);
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
const SERVER_ACCOUNTS = "chat.serverAccounts.v1";

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
export function forgetServerAccount(host: string) { const all = loadServerAccounts(); delete all[host]; saveServerAccounts(all); }

/** A fresh key pair that is not stored anywhere yet (a new server account). */
export async function newIdentity(): Promise<Identity> {
  const priv = ed.utils.randomPrivateKey();
  return { publicKey: toHex(await ed.getPublicKeyAsync(priv)), privateKey: toHex(priv), device: null };
}
