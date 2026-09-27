/**
 * Blocked people (docs/features/reports.md, stage 3, 27 September 2026): a list of public keys per identity. Blocking is a
 * view of this user's client alone: the person's messages are folded, their voice is silent here, their mentions do not
 * count, and (for a directory account) their friend requests are refused by the directory. No server learns the list. For
 * the directory account it travels inside the sealed settings (`SealedSettingsContent.blockedUsers`) and so follows the
 * user to every device; a server account (`~name`) keeps its list on this device only, under its own key. The device keeps
 * every list in `chat.blocked.v1` (identity's public key -> keys) and the names it saw at the time in `chat.blockedNames.v1`,
 * so the settings can name a blocked person who is on no open server right now. Pure functions plus the storage access.
 */
import { BLOCKED_USERS_MAX, PublicKey } from "@squorli/protocol";

const KEY = "chat.blocked.v1";
const NAMES_KEY = "chat.blockedNames.v1";
const NAME_MAX = 64;

export type BlockedLists = Record<string, string[]>;

/** What the member menus, the chat and the report dialog need (App.tsx builds it per server): is this key blocked, block after a confirmation, unblock. `directory` = the person has a directory account. */
export type BlockControls = { has: (publicKey: string) => boolean; onBlock: (publicKey: string, name: string, directory: boolean) => void; onUnblock: (publicKey: string) => void };

/** A stored or received list made valid: lower-case keys of the right form, no repeats, at most `BLOCKED_USERS_MAX`. */
export function normalizeBlocked(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const key = v.trim().toLowerCase();
    if (!PublicKey.safeParse(key).success || out.includes(key)) continue;
    out.push(key);
    if (out.length >= BLOCKED_USERS_MAX) break;
  }
  return out;
}

/** Same set of blocked keys? The order plays no part, and no list counts as an empty one. */
export function sameBlocked(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const left = new Set(a ?? []); const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((k) => right.has(k));
}

/** The list with `publicKey` blocked or not; the same array when nothing changes. A full list takes no more entries. */
export function withBlocked(list: readonly string[], publicKey: string, blocked: boolean): string[] {
  const key = publicKey.toLowerCase();
  const has = list.includes(key);
  if (blocked === has) return [...list];
  if (!blocked) return list.filter((k) => k !== key);
  if (list.length >= BLOCKED_USERS_MAX) return [...list];
  return [...list, key];
}

/** Stored JSON -> lists per identity; broken or foreign data yields nothing. */
export function parseBlockedLists(raw: string | null): BlockedLists {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: BlockedLists = {};
    for (const [owner, list] of Object.entries(data)) {
      if (!PublicKey.safeParse(owner).success) continue;
      const clean = normalizeBlocked(list);
      if (clean.length > 0) out[owner] = clean;
    }
    return out;
  } catch { return {}; }
}

export function loadBlockedLists(): BlockedLists {
  try { return parseBlockedLists(localStorage.getItem(KEY)); } catch { return {}; }
}

export function saveBlockedLists(all: BlockedLists): void {
  const kept = Object.fromEntries(Object.entries(all).filter(([, list]) => list.length > 0));
  try { if (Object.keys(kept).length > 0) localStorage.setItem(KEY, JSON.stringify(kept)); else localStorage.removeItem(KEY); } catch { /* storage full or blocked: the block still applies for this session */ }
}

/** The names blocked people had when they were blocked (this device only, for the settings' list). */
export function parseBlockedNames(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [key, name] of Object.entries(data)) if (PublicKey.safeParse(key).success && typeof name === "string" && name.trim()) out[key] = name.trim().slice(0, NAME_MAX);
    return out;
  } catch { return {}; }
}

export function loadBlockedNames(): Record<string, string> {
  try { return parseBlockedNames(localStorage.getItem(NAMES_KEY)); } catch { return {}; }
}

/** Remember a name for the settings' list; keys that no list names any more are dropped so the store does not grow for ever. */
export function saveBlockedName(publicKey: string, name: string, lists: BlockedLists): void {
  const still = new Set(Object.values(lists).flat());
  const names = loadBlockedNames();
  if (name.trim()) names[publicKey.toLowerCase()] = name.trim().slice(0, NAME_MAX);
  const kept = Object.fromEntries(Object.entries(names).filter(([key]) => still.has(key)));
  try { if (Object.keys(kept).length > 0) localStorage.setItem(NAMES_KEY, JSON.stringify(kept)); else localStorage.removeItem(NAMES_KEY); } catch { /* as above */ }
}
