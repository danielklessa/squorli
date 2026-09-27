import type { BridgeNotification } from "@squorli/web/platform/bridge";

/**
 * Notifications of the operating system for direct messages and mentions (docs/features/notifications.md). The client
 * decides when and what (apps/web/src/notifications.ts); the shell only checks what arrives: strings, cut to what a
 * notification shows, a tag the client recognises again. Pure part, tested.
 */
const TITLE_MAX = 120;
const BODY_MAX = 300;
const TAG_MAX = 300;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** What the client sent, or null when it is not a notification. */
export function readNotification(value: unknown): BridgeNotification | null {
  if (typeof value !== "object" || value === null) return null;
  const { title, body, tag } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string" || typeof tag !== "string") return null;
  if (!title.trim() || !tag || tag.length > TAG_MAX) return null;
  return { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), tag };
}
