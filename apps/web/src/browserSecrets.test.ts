import { describe, expect, it } from "vitest";
import { memoryKeyHolder, openBrowserSecretStore, SEALED_PREFIX, sealedKeyOf, type BrowserSecretDeps } from "./browserSecrets";

/** A localStorage and a window for one test: the secrets never touch the real ones. */
function fakeStorage() {
  const m = new Map<string, string>();
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } } };
}
function fakeEvents() {
  const listeners: ((e: StorageEvent) => void)[] = [];
  return { events: { addEventListener: (_t: "storage", l: (e: StorageEvent) => void) => { listeners.push(l); } }, fire: (key: string | null) => listeners.forEach((l) => l({ key } as StorageEvent)) };
}
const subtle = globalThis.crypto.subtle;
const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const deps = (over: Partial<BrowserSecretDeps> = {}): BrowserSecretDeps => ({ storage: fakeStorage().storage, keys: memoryKeyHolder(), subtle, randomBytes, warn: () => {}, ...over });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("secrets sealed in the browser (security audit of 5 October 2026, M-2)", () => {
  it("seals a plain entry from before at start, keeps it readable and removes the plain form", async () => {
    const { m, storage } = fakeStorage();
    m.set("chat.identity.v1", '{"publicKey":"ab","privateKey":"cd"}');
    const store = await openBrowserSecretStore(["chat.identity.v1", "chat.sessions.v2"], deps({ storage }));
    expect(store).not.toBeNull();
    expect(store!.get("chat.identity.v1")).toBe('{"publicKey":"ab","privateKey":"cd"}');
    expect(m.has("chat.identity.v1")).toBe(false);
    const sealed = m.get(sealedKeyOf("chat.identity.v1"))!;
    expect(sealed).toBeTruthy();
    expect(sealed).not.toContain("privateKey");
    expect(store!.get("chat.sessions.v2")).toBeNull();
  });

  it("a value set is in memory at once, sealed shortly after, and gone with null; the same key opens it in a second store", async () => {
    const keys = memoryKeyHolder();
    const { m, storage } = fakeStorage();
    const a = (await openBrowserSecretStore(["k"], deps({ storage, keys })))!;
    expect(a.set("k", "geheim")).toBe(true);
    expect(a.get("k")).toBe("geheim");
    await tick();
    expect(m.get(sealedKeyOf("k"))).toBeTruthy();
    expect(m.has("k")).toBe(false);
    const b = (await openBrowserSecretStore(["k"], deps({ storage, keys })))!;
    expect(b.get("k")).toBe("geheim");
    expect(a.set("k", null)).toBe(true);
    expect(a.get("k")).toBeNull();
    expect(m.has(sealedKeyOf("k"))).toBe(false);
  });

  it("an entry sealed with a key this browser no longer has is dropped, not kept as garbage", async () => {
    const { m, storage } = fakeStorage();
    const a = (await openBrowserSecretStore(["k"], deps({ storage, keys: memoryKeyHolder() })))!;
    a.set("k", "alt");
    await tick();
    const warnings: string[] = [];
    const b = (await openBrowserSecretStore(["k"], deps({ storage, keys: memoryKeyHolder(), warn: (w) => warnings.push(w) })))!;
    expect(b.get("k")).toBeNull();
    expect(m.has(sealedKeyOf("k"))).toBe(false);
    expect(warnings.some((w) => w.includes("cannot be opened"))).toBe(true);
  });

  it("an entry cannot be moved under another name", async () => {
    const keys = memoryKeyHolder();
    const { m, storage } = fakeStorage();
    const a = (await openBrowserSecretStore(["a", "b"], deps({ storage, keys })))!;
    a.set("a", "fuer a");
    await tick();
    m.set(sealedKeyOf("b"), m.get(sealedKeyOf("a"))!);
    const b = (await openBrowserSecretStore(["a", "b"], deps({ storage, keys, warn: () => {} })))!;
    expect(b.get("a")).toBe("fuer a");
    expect(b.get("b")).toBeNull();
  });

  it("follows another tab's write through the storage event and refresh", async () => {
    const keys = memoryKeyHolder();
    const { storage } = fakeStorage();
    const { events, fire } = fakeEvents();
    const tabA = (await openBrowserSecretStore(["k"], deps({ storage, keys })))!;
    const tabB = (await openBrowserSecretStore(["k"], deps({ storage, keys, events })))!;
    tabA.set("k", "von a");
    await tick();
    expect(tabB.get("k")).toBeNull();
    fire(sealedKeyOf("k"));
    await tabB.refresh("k");
    expect(tabB.get("k")).toBe("von a");
    tabA.set("k", null);
    fire(sealedKeyOf("k"));
    await tabB.refresh("k");
    expect(tabB.get("k")).toBeNull();
    expect(SEALED_PREFIX).toBe("chat.sealed.v1:");
  });

  it("without the browser's pieces there is no store, and a key that cannot be kept opens none", async () => {
    expect(await openBrowserSecretStore(["k"], null)).toBeNull();
    const broken = { load: async () => null, save: async () => {} };
    expect(await openBrowserSecretStore(["k"], deps({ keys: broken }))).toBeNull();
  });
});
