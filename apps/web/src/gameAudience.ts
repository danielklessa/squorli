/**
 * Who may see my game (14 November 2026, docs/features/games.md), the client's pure part: the setting's edits and comparison,
 * the people a list can be filled from, and the names remembered on this device so that the settings can name somebody who is
 * on no open server right now. The rule itself is the protocol's (`GameAudienceSetting`, `gameAudienceOf`); the relays enforce it.
 */
import { GAME_AUDIENCE_MAX, PublicKey, cleanGameAudienceSetting, type GameAudienceSetting } from "@squorli/protocol";
import { rankMatch } from "./pickerEntries";

export const DEFAULT_GAME_AUDIENCE: GameAudienceSetting = { mode: "all", only: [], except: [] };
export const normalizeGameAudience = (value: unknown): GameAudienceSetting => cleanGameAudienceSetting(value);

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => { const set = new Set(a); return a.length === b.length && b.every((k) => set.has(k)); };
/** Same setting? The order inside a list plays no part. */
export function sameAudienceSetting(a: GameAudienceSetting, b: GameAudienceSetting): boolean {
  return a.mode === b.mode && sameKeys(a.only, b.only) && sameKeys(a.except, b.except);
}

/** A person put on a list or taken off it; a key that does not fit or a full list changes nothing. */
export function withAudiencePerson(setting: GameAudienceSetting, list: "only" | "except", publicKey: string, on: boolean): GameAudienceSetting {
  const key = publicKey.toLowerCase();
  if (!PublicKey.safeParse(key).success) return setting;
  const current = setting[list];
  if (on) return current.includes(key) || current.length >= GAME_AUDIENCE_MAX ? setting : { ...setting, [list]: [...current, key] };
  return current.includes(key) ? { ...setting, [list]: current.filter((k) => k !== key) } : setting;
}

/**
 * What a person's menu offers (the member list, the friends list): hide my game from them or show it again, by the mode in
 * force. With "everybody" the entry hides, which switches to "all but the listed" (the list kept from before counts again).
 */
export type AudienceMenuAction = { kind: "hide" | "unhide" | "show" | "unshow"; next: GameAudienceSetting };
export function audienceMenuAction(setting: GameAudienceSetting, publicKey: string): AudienceMenuAction | null {
  const key = publicKey.toLowerCase();
  if (!PublicKey.safeParse(key).success) return null;
  if (setting.mode === "only") {
    return setting.only.includes(key) ? { kind: "unshow", next: withAudiencePerson(setting, "only", key, false) } : { kind: "show", next: withAudiencePerson(setting, "only", key, true) };
  }
  if (setting.mode === "except" && setting.except.includes(key)) return { kind: "unhide", next: withAudiencePerson(setting, "except", key, false) };
  return { kind: "hide", next: { ...withAudiencePerson(setting, "except", key, true), mode: "except" } };
}

/** Somebody a list can name: a friend or a member of a server this client is connected to. */
export type AudiencePerson = { publicKey: string; name: string; handle: string | null };

/** The people a query matches (name or handle, ranked like the mention list), without those already listed. */
export function suggestAudiencePeople(people: readonly AudiencePerson[], query: string, exclude: ReadonlySet<string>, limit = 8): AudiencePerson[] {
  const q = query.trim().replace(/^[@~]/, "");
  return people
    .filter((p) => !exclude.has(p.publicKey))
    .map((p) => ({ p, r: rankMatch(p.name, p.handle, q) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((x) => x.p);
}

// ---- The names seen when somebody was put on a list (this device only, like the blocked people's names).
const NAMES_KEY = "chat.gameAudienceNames.v1";
const NAME_MAX = 64;

export function parseAudienceNames(raw: string | null): Record<string, string> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, name] of Object.entries(parsed as Record<string, unknown>)) if (PublicKey.safeParse(key).success && typeof name === "string" && name.trim()) out[key] = name.trim().slice(0, NAME_MAX);
    return out;
  } catch { return {}; }
}
export function loadAudienceNames(): Record<string, string> {
  try { return parseAudienceNames(localStorage.getItem(NAMES_KEY)); } catch { return {}; }
}
/** Remember a name; names of keys on neither list are dropped so the entry does not grow for ever. */
export function saveAudienceName(publicKey: string, name: string, setting: GameAudienceSetting): void {
  const still = new Set([...setting.only, ...setting.except]);
  const names = loadAudienceNames();
  if (name.trim()) names[publicKey.toLowerCase()] = name.trim().slice(0, NAME_MAX);
  const kept = Object.fromEntries(Object.entries(names).filter(([key]) => still.has(key)));
  try { if (Object.keys(kept).length > 0) localStorage.setItem(NAMES_KEY, JSON.stringify(kept)); else localStorage.removeItem(NAMES_KEY); } catch { /* private mode: then simply not */ }
}
