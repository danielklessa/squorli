/**
 * The client's secrets in a browser without a platform store (security audit of 5 October 2026, M-2). The desktop app
 * keeps the account keys' seeds in its main process and the sessions encrypted by the system; a browser page had only
 * localStorage, where the seed (the key to every direct message, the settings and the backups) and the session tokens
 * lay in plain text, readable by anything that gets at the profile folder or at this origin's storage.
 *
 * Here they are sealed before they reach localStorage: AES-GCM with a key the browser made and keeps in IndexedDB as a
 * `CryptoKey` that cannot be exported (the structured clone keeps the key material inside the browser). Every entry is
 * stored as `chat.sealed.v1:<key>` = base64 of iv + ciphertext, bound to its name (the name is the associated data, so
 * an entry cannot be moved under another name). What this gives: a copy of the profile folder or of localStorage alone
 * holds nothing readable, and the key leaves the browser never. What it does not give: a script running on this origin
 * (XSS) can still ask the browser to decrypt, exactly as the page does; the CSP is what keeps such a script out.
 *
 * The store is read at start (`openBrowserSecretStore`): the key is loaded or made, every known entry decrypted into
 * memory, and a plain entry from before (an app of an earlier version) is sealed and then removed, all awaited before the
 * client runs. From then on `get` answers from memory, synchronously as identity.ts needs it; `set` keeps the value in
 * memory and seals it in the background (a failure there writes the plain value, as before, rather than losing it).
 * Another tab's write arrives as a `storage` event and is decrypted into memory (`refresh`). Where WebCrypto or
 * IndexedDB is missing (a plain-http address that is not localhost, a private window of some browsers), the store is not
 * opened and the client keeps localStorage as before; the privacy policy and the login's hint say so.
 */
export const SEALED_PREFIX = "chat.sealed.v1:";
export const sealedKeyOf = (key: string) => `${SEALED_PREFIX}${key}`;

export type BrowserSecretStore = {
  get(key: string): string | null;
  set(key: string, value: string | null): boolean;
  /** Reads the sealed entry of `key` again (another tab wrote it); resolves once memory is current. */
  refresh(key: string): Promise<void>;
};

/** Where the wrapping key is kept: IndexedDB in a browser, memory in a test. */
export interface KeyHolder {
  load(): Promise<CryptoKey | null>;
  save(key: CryptoKey): Promise<void>;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type BrowserSecretDeps = {
  storage: StorageLike;
  keys: KeyHolder;
  subtle: SubtleCrypto;
  randomBytes: (n: number) => Uint8Array;
  /** Where `storage` events arrive (window); none = no following of other tabs. */
  events?: { addEventListener(type: "storage", listener: (e: StorageEvent) => void): void } | undefined;
  warn?: ((message: string) => void) | undefined;
};

const DB_NAME = "squorli-secrets";
const DB_STORE = "keys";
const KEY_ID = "wrap";
const IV_BYTES = 12;

/** The wrapping key in IndexedDB; null where there is no IndexedDB. */
export function indexedDbKeyHolder(dbName = DB_NAME): KeyHolder | null {
  const idb = globalThis.indexedDB;
  if (!idb) return null;
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(dbName, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
  const run = <T,>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) => open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = work(tx.objectStore(DB_STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("indexedDB")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("indexedDB aborted")); };
  }));
  return {
    load: () => run<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID)).then((k) => k ?? null),
    save: (key) => run("readwrite", (s) => s.put(key, KEY_ID)).then(() => undefined),
  };
}

export function memoryKeyHolder(): KeyHolder {
  let key: CryptoKey | null = null;
  return { load: async () => key, save: async (k) => { key = k; } };
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const toBase64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function seal(subtle: SubtleCrypto, key: CryptoKey, name: string, value: string, randomBytes: (n: number) => Uint8Array): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8(name) as BufferSource }, key, utf8(value) as BufferSource));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return toBase64(out);
}

async function unseal(subtle: SubtleCrypto, key: CryptoKey, name: string, sealed: string): Promise<string> {
  const bytes = fromBase64(sealed);
  if (bytes.length <= IV_BYTES) throw new Error("sealed entry too short");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) as BufferSource, additionalData: utf8(name) as BufferSource }, key, bytes.subarray(IV_BYTES) as BufferSource);
  return new TextDecoder().decode(plain);
}

/** The browser's own pieces; null where one is missing (then the client keeps localStorage). */
export function browserDeps(): BrowserSecretDeps | null {
  const subtle = globalThis.crypto?.subtle;
  const keys = indexedDbKeyHolder();
  if (!subtle || !keys || typeof localStorage === "undefined") return null;
  return { storage: localStorage, keys, subtle, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)), events: window, warn: (m) => console.warn(m) };
}

/**
 * Opens the store for the named secrets: loads or makes the key, decrypts what is sealed, seals what is still plain.
 * null = this browser cannot seal (no WebCrypto, no IndexedDB) or the key could not be kept; the caller then stays with
 * localStorage. Never throws.
 */
export async function openBrowserSecretStore(names: readonly string[], deps: BrowserSecretDeps | null = browserDeps()): Promise<BrowserSecretStore | null> {
  if (!deps) return null;
  const { storage, subtle, randomBytes } = deps;
  const warn = deps.warn ?? (() => {});
  let key: CryptoKey;
  try {
    const loaded = await deps.keys.load();
    if (loaded) key = loaded;
    else {
      key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await deps.keys.save(key);
      // Read back: a browser that cannot keep the key (storage refused) must not seal anything with it.
      if (!(await deps.keys.load())) return null;
    }
  } catch (err) {
    warn(`secrets: the browser cannot keep a key, secrets stay in plain storage (${String(err)})`);
    return null;
  }
  const memory = new Map<string, string>();

  const load = async (name: string): Promise<void> => {
    const sealed = storage.getItem(sealedKeyOf(name));
    if (sealed === null) { memory.delete(name); return; }
    try { memory.set(name, await unseal(subtle, key, name, sealed)); } catch {
      // Sealed with a key this browser no longer has (its IndexedDB was cleared): nothing anybody can read; it goes.
      warn(`secrets: the sealed entry ${name} cannot be opened and is dropped`);
      storage.removeItem(sealedKeyOf(name));
      memory.delete(name);
    }
  };
  for (const name of names) {
    await load(name);
    const plain = storage.getItem(name);
    if (plain === null) continue;
    // From before: sealed, read back, and only then removed in the plain form.
    try {
      storage.setItem(sealedKeyOf(name), await seal(subtle, key, name, plain, randomBytes));
      if ((await unseal(subtle, key, name, storage.getItem(sealedKeyOf(name)) ?? "")) !== plain) throw new Error("read back differs");
      memory.set(name, plain);
      storage.removeItem(name);
    } catch (err) {
      warn(`secrets: ${name} could not be sealed and stays plain (${String(err)})`);
      storage.removeItem(sealedKeyOf(name));
      memory.set(name, plain);
    }
  }

  const store: BrowserSecretStore = {
    get: (name) => memory.get(name) ?? null,
    set: (name, value) => {
      if (value === null) { memory.delete(name); storage.removeItem(sealedKeyOf(name)); return true; }
      memory.set(name, value);
      void seal(subtle, key, name, value, randomBytes).then((sealed) => {
        // Only if this is still the value to keep: a later set or a removal wins.
        if (memory.get(name) === value) storage.setItem(sealedKeyOf(name), sealed);
      }).catch((err) => {
        warn(`secrets: ${name} could not be sealed, written plain (${String(err)})`);
        if (memory.get(name) === value) { try { storage.setItem(name, value); } catch { /* no storage at all: the value lasts this page */ } }
      });
      return true;
    },
    refresh: (name) => load(name),
  };
  deps.events?.addEventListener("storage", (e) => {
    if (e.key === null) { for (const name of [...memory.keys(), ...names]) void load(name); return; }
    if (e.key.startsWith(SEALED_PREFIX)) void load(e.key.slice(SEALED_PREFIX.length));
  });
  return store;
}
