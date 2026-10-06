import type { Message } from "@squorli/protocol";
import { mentionsUser } from "./mentions";

/**
 * What has been read, per channel, so unread marks and mention counters also hold after a reload and for messages that
 * arrived while the client was away. The server keeps no read state: the client remembers the `seq` of the newest message
 * it has shown per channel (per device, per server and user) and compares it with the newest page of every text channel
 * after connecting. Pure functions plus the storage access.
 */
export type ReadState = Record<string, number>;

export type CatchUp = { unread: boolean; count: number; mentions: number; latest: number | null };

/**
 * State of one channel from its newest messages. `lastRead` undefined = this device has never seen the channel: nothing
 * counts as unread then (a new member or a new browser must not find every channel marked), the newest message becomes
 * the starting point. Own messages never count, nor those of `ignoreAuthors` (blocked people, docs/features/reports.md stage 3).
 */
export function catchUp(messages: readonly Message[], lastRead: number | undefined, myUserId: string, ignoreAuthors?: ReadonlySet<string>): CatchUp {
  const latest = messages.reduce<number | null>((max, m) => (max === null || m.seq > max ? m.seq : max), null);
  if (lastRead === undefined) return { unread: false, count: 0, mentions: 0, latest };
  const fresh = messages.filter((m) => m.seq > lastRead && m.authorId !== myUserId && !ignoreAuthors?.has(m.authorId));
  return { unread: fresh.length > 0, count: fresh.length, mentions: fresh.filter((m) => mentionsUser(m.content, myUserId)).length, latest };
}

/** Read state after showing `messages` of a channel; unchanged (same object) when nothing newer was shown. */
export function markRead(state: ReadState, channelId: string, messages: readonly Message[]): ReadState {
  const latest = messages.reduce((max, m) => Math.max(max, m.seq), state[channelId] ?? -1);
  return latest < 0 || latest === state[channelId] ? state : { ...state, [channelId]: latest };
}

/** Channels that no longer exist are dropped, so the stored object does not grow for ever. */
export function pruneReadState(state: ReadState, channelIds: readonly string[]): ReadState {
  const keep = new Set(channelIds);
  const entries = Object.entries(state).filter(([id]) => keep.has(id));
  return entries.length === Object.keys(state).length ? state : Object.fromEntries(entries);
}

const key = (host: string, userId: string) => `chat.read.v1:${host}:${userId}`;

export function loadReadState(host: string, userId: string): ReadState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(host, userId)) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  } catch { return {}; }
}
export function saveReadState(host: string, userId: string, state: ReadState): void {
  try { localStorage.setItem(key(host, userId), JSON.stringify(state)); } catch { /* storage full or blocked: the marks then only hold while the page is open */ }
}
