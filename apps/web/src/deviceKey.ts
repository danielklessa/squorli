/**
 * The device key of this installation for one account (the protocol's directory.ts, "Devices"): an Ed25519 key next to the
 * account's key, enrolled where the password is proven, that signs along with everything the account's key signs.
 *
 * Where the browser can, the key is made by WebCrypto and cannot be read out: a script that gets at the page's storage
 * finds no private half, only a handle it can sign with while it runs on this origin. Such a key pair is kept in
 * IndexedDB (a `CryptoKey` survives the structured clone, its private half stays inside the browser). Where WebCrypto
 * has no Ed25519 or IndexedDB cannot be used (an older browser, a private window), the key is an ordinary one and its
 * private half is kept where the account's key is kept.
 *
 * The same file lives in both repositories: squorli-server `apps/web/src/deviceKey.ts` (the chat client) and
 * squorli-directory `apps/directory/web/deviceKey.ts` (the account page). Change both together.
 */
import * as ed from "@noble/ed25519";

export type DeviceSigner = { publicKey: string; sign(message: string): Promise<string> };
/** What is kept next to the account's key: which device key this installation has and where its private half is. */
export type StoredDevice = { publicKey: string; store: "webcrypto" } | { publicKey: string; store: "plain"; privateKey: string };
/** Where key pairs that cannot be read out are kept, by the device's public key. */
export interface DeviceVault {
  put(publicKey: string, pair: CryptoKeyPair): Promise<void>;
  get(publicKey: string): Promise<CryptoKeyPair | null>;
  remove(publicKey: string): Promise<void>;
}
type Subtle = Pick<SubtleCrypto, "generateKey" | "exportKey" | "sign">;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
const utf8 = (s: string) => new TextEncoder().encode(s);
const HEX_KEY = /^[0-9a-f]{64}$/;

/** A stored entry as it was written; null for anything else (an entry of a later version, a damaged one). */
export function parseStoredDevice(raw: unknown): StoredDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { publicKey?: unknown; store?: unknown; privateKey?: unknown };
  if (typeof d.publicKey !== "string" || !HEX_KEY.test(d.publicKey)) return null;
  if (d.store === "webcrypto") return { publicKey: d.publicKey, store: "webcrypto" };
  if (d.store === "plain" && typeof d.privateKey === "string" && HEX_KEY.test(d.privateKey)) return { publicKey: d.publicKey, store: "plain", privateKey: d.privateKey };
  return null;
}

async function pairSigner(pair: CryptoKeyPair, subtle: Subtle): Promise<DeviceSigner> {
  const publicKey = toHex(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  return { publicKey, sign: async (message) => toHex(new Uint8Array(await subtle.sign({ name: "Ed25519" }, pair.privateKey, utf8(message) as BufferSource))) };
}
async function plainSigner(privateKey: string): Promise<DeviceSigner> {
  const seed = fromHex(privateKey);
  return { publicKey: toHex(await ed.getPublicKeyAsync(seed)), sign: async (message) => toHex(await ed.signAsync(utf8(message), seed)) };
}
/** A key pair whose private half cannot be read out; null where the browser has no Ed25519 in WebCrypto. */
async function generatePair(subtle: Subtle): Promise<CryptoKeyPair | null> {
  try {
    const made = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return "privateKey" in made && "publicKey" in made ? made : null;
  } catch { return null; }
}

/**
 * A new device key. `persist` false = for this page's life only (nothing is stored, `stored` is null). With `persist` the
 * key pair goes into the vault; where that fails the key is an ordinary one whose private half the caller stores.
 */
export async function createDevice(vault: DeviceVault | null, persist: boolean, subtle: Subtle | undefined = globalThis.crypto?.subtle): Promise<{ signer: DeviceSigner; stored: StoredDevice | null }> {
  const pair = subtle ? await generatePair(subtle) : null;
  if (pair && subtle) {
    const signer = await pairSigner(pair, subtle);
    if (!persist) return { signer, stored: null };
    if (vault && await vault.put(signer.publicKey, pair).then(() => true, () => false)) return { signer, stored: { publicKey: signer.publicKey, store: "webcrypto" } };
  }
  const privateKey = toHex(ed.utils.randomSecretKey());
  const signer = await plainSigner(privateKey);
  return { signer, stored: persist ? { publicKey: signer.publicKey, store: "plain", privateKey } : null };
}

/** The signer of a stored device; null when its key pair is gone (the browser's data was cleared) or does not fit. */
export async function loadDevice(vault: DeviceVault | null, stored: StoredDevice, subtle: Subtle | undefined = globalThis.crypto?.subtle): Promise<DeviceSigner | null> {
  try {
    if (stored.store === "plain") { const s = await plainSigner(stored.privateKey); return s.publicKey === stored.publicKey ? s : null; }
    const pair = vault && subtle ? await vault.get(stored.publicKey) : null;
    if (!pair || !subtle) return null;
    const s = await pairSigner(pair, subtle);
    return s.publicKey === stored.publicKey ? s : null;
  } catch { return null; }
}

/** Remove what the vault keeps of a device; the caller removes its own entry. */
export async function forgetDevice(vault: DeviceVault | null, stored: StoredDevice): Promise<void> {
  if (stored.store === "webcrypto") await vault?.remove(stored.publicKey).catch(() => {});
}

/** A vault in memory (tests, and a Node process that drives the client). */
export function memoryVault(): DeviceVault {
  const items = new Map<string, CryptoKeyPair>();
  return {
    put: async (k, pair) => { items.set(k, pair); },
    get: async (k) => items.get(k) ?? null,
    remove: async (k) => { items.delete(k); },
  };
}

/** The browser's vault: one object store in an IndexedDB database of this origin; null where there is no IndexedDB. */
export function indexedDbVault(name: string): DeviceVault | null {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  const STORE = "devices";
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error("indexedDB"));
        tx.onabort = () => reject(tx.error ?? new Error("indexedDB"));
      });
    } finally { db.close(); }
  };
  return {
    put: async (k, pair) => { await run("readwrite", (s) => s.put(pair, k)); },
    get: async (k) => { const v = await run<unknown>("readonly", (s) => s.get(k)); return v && typeof v === "object" && "privateKey" in v && "publicKey" in v ? (v as CryptoKeyPair) : null; },
    remove: async (k) => { await run("readwrite", (s) => s.delete(k)); },
  };
}
