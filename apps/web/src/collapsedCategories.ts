import type { Channel, VoiceMember } from "@squorli/protocol";

/**
 * Collapsed categories of the sidebar (6 October 2026, user's wish): a press on a category's heading folds its channels
 * away; the heading then says how many unread messages the category holds and how many people sit in its voice
 * channels. Which categories are collapsed is this device's choice, kept per server and user in localStorage (like the
 * per-device read state, readState.ts). Pure functions plus the storage access.
 */

/** What a collapsed category's heading shows, summed over its channels. */
export type CategorySummary = {
  /** Unread messages of channels I have not muted (a muted channel marks nothing, docs/features/mentions-unread.md). */
  unread: number;
  /** Messages that mention me, muted channels included (a mention addresses the person). */
  mentions: number;
  /** People sitting in the category's voice channels; the AFK channel does not count (sitting there is no activity). */
  voice: number;
};

export type SummaryInput = {
  unread: Record<string, boolean>;
  unreadCount: Record<string, number>;
  mentions: Record<string, number>;
  muted: Record<string, boolean>;
  voice: Record<string, VoiceMember[]>;
  afkChannelId: string | null;
};

export function categorySummary(channels: readonly Channel[], s: SummaryInput): CategorySummary {
  let unread = 0, mentions = 0, voice = 0;
  for (const c of channels) {
    if (c.kind === "text") {
      // The flag decides whether anything is unread; the count may lag behind it by one against a server from before.
      if (s.unread[c.id] && !s.muted[c.id]) unread += Math.max(1, s.unreadCount[c.id] ?? 0);
      mentions += s.mentions[c.id] ?? 0;
    } else if (c.id !== s.afkChannelId) {
      voice += s.voice[c.id]?.length ?? 0;
    }
  }
  return { unread, mentions, voice };
}

/** Collapsed and expanded again: the set without `id` if it was in, with it otherwise. */
export function toggleCollapsed(collapsed: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Categories that no longer exist are dropped, so the stored list does not grow for ever; the same set when nothing changed. */
export function pruneCollapsed(collapsed: ReadonlySet<string>, categoryIds: readonly string[]): ReadonlySet<string> {
  const keep = new Set(categoryIds);
  const kept = [...collapsed].filter((id) => keep.has(id));
  return kept.length === collapsed.size ? collapsed : new Set(kept);
}

const key = (host: string, userId: string) => `chat.collapsed.v1:${host}:${userId}`;

export function loadCollapsed(host: string, userId: string): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(host, userId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch { return new Set(); }
}
export function saveCollapsed(host: string, userId: string, collapsed: ReadonlySet<string>): void {
  try { localStorage.setItem(key(host, userId), JSON.stringify([...collapsed])); } catch { /* storage full or blocked: the choice then only holds while the page is open */ }
}
