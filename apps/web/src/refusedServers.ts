import { refusedHostHash } from "@squorli/protocol";

/**
 * Chat servers the directory's operator refused (docs/features/reports.md, 27 September 2026; the user's decision 10 of
 * docs/PLAN-reports.md): the client refuses them too, also when one is opened by its address. So that the directory does
 * not learn which servers this client opens, the client fetches the whole list (the SHA-256 of every refused host) with
 * the directory's health, keeps it for an hour and checks each host here.
 * Rules: a list that could not be fetched refuses nothing new, and the list from before stays in force (kept on this
 * device); the list belongs to one directory and says nothing under another. The server that serves a browser's client
 * (the home server) is never checked: a refused operator serves that page anyway (store.ts).
 * The account's own servers among them come with the account's status (`AccountStatus.refusedServers`): the rail keeps
 * showing those, marked, so that a member learns why a server is gone. "Aus der Liste entfernen" hides such an entry:
 * the list of hidden hosts is kept on this device (`chat.refusedDismissed.v1`) and follows the account inside the
 * sealed settings (`SealedSettingsContent.hiddenServers`, store.ts; the user's wish of 27 September 2026), so the
 * entry is gone on every device. The account's entry at the directory stays, so a server that is allowed again is
 * back in the rail by itself.
 * Pure apart from the storage, tested.
 */
export const REFUSED_LIST_MAX_AGE_MS = 3_600_000;
const KEY = "chat.refusedServers.v1";
const DISMISSED_KEY = "chat.refusedDismissed.v1";
const DISMISSED_MAX = 200;

export type RefusedList = { directory: string; fetchedAt: number; hashes: string[] };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const clean = (url: string): string => url.replace(/\/+$/, "").toLowerCase();

export function loadRefusedList(storage: Storage | null = safeStorage()): RefusedList | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RefusedList>;
    if (typeof v.directory !== "string" || typeof v.fetchedAt !== "number" || !Array.isArray(v.hashes)) return null;
    return { directory: v.directory, fetchedAt: v.fetchedAt, hashes: v.hashes.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) };
  } catch { return null; }
}

export function saveRefusedList(list: RefusedList, storage: Storage | null = safeStorage()): void {
  try { storage?.setItem(KEY, JSON.stringify(list)); } catch { /* the list then lives until the page is closed */ }
}

function safeStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The list as fetched just now. */
export const refusedList = (directory: string, hashes: readonly string[], now: number): RefusedList => ({ directory: clean(directory), fetchedAt: now, hashes: [...new Set(hashes)] });

/** Whether the list has to be fetched: none for this directory yet, or the one at hand is older than an hour. */
export function refusedListDue(list: RefusedList | null, directory: string, now: number): boolean {
  return !list || list.directory !== clean(directory) || now - list.fetchedAt >= REFUSED_LIST_MAX_AGE_MS;
}

/** Whether `host` (a chat server's host, with its port if it has one) is on the list of `directory`. However old the list is: an older one stays in force. */
export async function hostRefused(list: RefusedList | null, directory: string | null, host: string): Promise<boolean> {
  if (!list || !directory || list.directory !== clean(directory) || list.hashes.length === 0) return false;
  return list.hashes.includes(await refusedHostHash(host));
}

/** Whether two lists of hidden hosts name the same hosts (the order says nothing). */
export function sameHidden(a: readonly string[], b: readonly string[] | null): boolean {
  const other = b ?? [];
  return a.length === other.length && a.every((h) => other.includes(h));
}

/** The refused servers of the account's list the user removed from the rail, as this device has them (store keys). */
export function loadDismissedRefused(storage: Storage | null = safeStorage()): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((h): h is string => typeof h === "string" && h.length > 0 && h.length <= 300))].slice(0, DISMISSED_MAX) : [];
  } catch { return []; }
}

export function saveDismissedRefused(hosts: readonly string[], storage: Storage | null = safeStorage()): void {
  try { storage?.setItem(DISMISSED_KEY, JSON.stringify(hosts.slice(0, DISMISSED_MAX))); } catch { /* the entry then comes back with the next start */ }
}

/**
 * The account's refused servers the rail shows, and the removals that still count: one for a server that is not refused
 * any more is dropped, so that server shows again once it is allowed. `keyOf` maps a directory host onto the store's key.
 */
export function shownRefused<T extends { host: string }>(refused: readonly T[], dismissed: readonly string[], keyOf: (host: string) => string): { shown: T[]; dismissed: string[] } {
  const keys = new Set(refused.map((s) => keyOf(s.host)));
  const kept = dismissed.filter((h) => keys.has(h));
  return { shown: refused.filter((s) => !kept.includes(keyOf(s.host))), dismissed: kept };
}
